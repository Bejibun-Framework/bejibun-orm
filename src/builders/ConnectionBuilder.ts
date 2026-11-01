import type {Database} from "bun:sqlite";
import type {ConnectionMetrics} from "@/types/connection";
import type {Connection} from "@/types/context";
import App from "@bejibun/app";
import {defineValue} from "@bejibun/utils/utils/utils";
import {AsyncLocalStorage} from "node:async_hooks";
import ConnectionException from "@/exceptions/ConnectionException";
import DatabaseDriverEnum from "@/enums/DatabaseDriverEnum";

/**
 * Property tag stamped on every built connection so `Grammar.detectDriver`
 * can read the driver reliably. Bun does not expose the original URL on its
 * SQL instance across versions (`SQL.options.url` arrived in 1.5, absent in
 * 1.4), so guessing from runtime internals is unreliable -- stamp instead.
 *
 * @internal
 */

/**
 * Cache of the resolved database config, shared across instances.
 */
let cachedConfig: Record<string, any> | null = null;

/**
 * Optional cleanup hook invoked for every connection just before an isolation
 * scope closes it (registered by the DB facade so per-database transaction
 * slots/counters stay honest when a scope dies mid-transaction).
 */
let scopeConnectionClosedHook: ((connection: Connection) => void) | undefined;

/**
 * Number of open connection handles owned by live isolation scopes.
 * Incremented when a scope builds a new handle, decremented when a scope
 * closes all of its handles.
 */
let openScopedConnections: number = 0;

/** Number of currently active `isolated()` scopes. */
let activeIsolationScopes: number = 0;

/**
 * Cache of live Bun `SQL` connections, keyed by connection name,
 * shared across every builder instance until `reset()` is called.
 */
const connections: Map<string, Connection> = new Map<string, Connection>();

/**
 * Per-context connection overrides. Inside `ConnectionBuilder.isolated()`
 * every connection lookup returns an independent handle per connection
 * name. Keeping this storage in the connection builder also scopes default
 * connection lookups made by `Grammar` and `QueryBuilder`.
 */
const connectionScopes: AsyncLocalStorage<Map<string, Connection> | undefined> =
    new AsyncLocalStorage<Map<string, Connection> | undefined>();

/**
 * Driver stamps that SURVIVE Bun's per-version SQL host internals. Bun can
 * drop arbitrary symbol properties added to `new SQL(...)` (proven on
 * 1.4.2: `sql.options.url` absent across ALL versions), so a WeakMap keyed
 * on the host object is the only guarantee detectDriver reads the same
 * driver the builder stamped -- including across connections created by
 * pooled/transaction paths that rebuild options.
 *
 * @internal
 */
const driverStamps: WeakMap<object, string> = new WeakMap<object, string>();

/**
 * WeakMap of connections that opted into bigint-as-number normalization.
 *
 * @internal
 */
const bigIntAsNumberStamps: WeakMap<object, boolean> = new WeakMap<object, boolean>();

/**
 * Pooled (pg/mysql) statements that are still in flight. `trackPooledStatement`
 * publishes each one and `waitForPooledIdle` lets `reset()` drain ordinary
 * queries before a pool is closed, so a running callback never reads a closed
 * handle. Transactions already carry their own drain fence; this covers the
 * plain, non-transactional path.
 */
const inFlightPooled: Set<Promise<void>> = new Set<Promise<void>>();

/**
 * Driver stamp: `detectDriver` cannot rely on `SQL.options.url` -- Bun
 * 1.4.x keeps no `url` field there while 1.5.x does, so driver guessing
 * is version-dependent. We instead stamp the resolved driver onto every
 * connection instance right where it is built, and `Grammar` reads this
 * symbol first before falling back to any runtime-internal heuristics.
 *
 * @internal
 */
export const DRIVER_TAG: symbol = Symbol.for("bejibun-orm.driver");

/**
 * Stamps a driver name onto a connection instance (WeakMap-backed).
 *
 * @param {object} connection - The connection to stamp.
 * @param {string} driver - The resolved driver name.
 * @internal
 */
export const stampDriver = (connection: object, driver: string): void => {
    driverStamps.set(connection, driver);
};

/**
 * Returns a driver previously stamped via {@link stampDriver}, or undefined.
 *
 * @param {object} connection - The connection to inspect.
 * @returns {string | undefined} The stamped driver name, if available.
 * @internal
 */
export const readStampedDriver = (connection: object): string | undefined => {
    return driverStamps.get(connection);
};

/**
 * Records whether a connection should normalize PG bigint/decimal strings
 * to JS numbers at the result edge.
 *
 * @param {object} connection - The built connection.
 * @param {boolean} enabled - Truthy when the connection opted in.
 * @internal
 */
export const stampBigIntAsNumber = (connection: object, enabled: boolean): void => {
    bigIntAsNumberStamps.set(connection, enabled);
};

/**
 * Returns whether the connection normalizes PG bigint strings to numbers.
 *
 * @param {object} connection - The built connection.
 * @returns {boolean} True when normalization is enabled for the connection.
 * @internal
 */
export const readBigIntAsNumber = (connection: object): boolean => {
    return bigIntAsNumberStamps.get(connection) === true;
};

/**
 * Registers a in-flight pooled statement so global resets can wait for it.
 *
 * @param {Promise<unknown>} promise - The pending pooled query promise.
 */
export const trackPooledStatement = (promise: Promise<unknown>): void => {
    const drain: Promise<void> = new Promise<void>((resolve: any) => {
        void Promise.resolve(promise).then(
            () => resolve(),
            () => resolve()
        );
    });

    inFlightPooled.add(drain);

    void drain.finally(() => inFlightPooled.delete(drain));
};

/**
 * Builds and caches native Bun `SQL` connection pools from the
 * database config. Provides `default`/named connection lookup, pool
 * teardown, and a raw query escape hatch.
 */
export default class ConnectionBuilder {
    /**
     * Registers the scope-close cleanup hook (called right before an isolated
     * scope closes each of its connections). The DB facade uses it to release
     * any transaction slot still held on a dying scope's SQLite handle.
     *
     * @param {(connection: Connection) => void} hook - The cleanup callback.
     * @internal
     */
    public static setScopeConnectionClosedHook(hook: (connection: Connection) => void): void {
        scopeConnectionClosedHook = hook;
    }

    /**
     * Returns the default transaction wait deadline (ms) from the resolved
     * config's top-level `transactionTimeout`, or `0` (wait forever) when
     * unset.
     *
     * @returns {number} The configured timeout.
     */
    public static getTransactionTimeout(): number {
        const config: Record<string, any> = this.resolveConfig;

        return config.transactionTimeout ?? 0;
    }

    /**
     * Overrides the cached config with one provided at bootstrap (e.g.
     * from the app's container). Subsequent `connection()`/`raw()`
     * calls pick it up.
     *
     * @param {Record<string, any>} config - The config to force.
     * @returns {Promise<void>} Resolves once the config is applied.
     */
    public async configure(config: Record<string, any>): Promise<void> {
        cachedConfig = config;

        for (const connection of connections.values()) {
            try {
                await connection.close();
            } catch {
                // Ignore close errors for already-closed or failed handles.
            }
        }

        connections.clear();
    }

    /**
     * Closes and clears every cached connection pool, waiting for any
     * in-flight pooled statements first.
     *
     * @returns {Promise<void>} Resolves once every pool is closed.
     */
    public async reset(): Promise<void> {
        await ConnectionBuilder.waitForPooledIdle();

        for (const connection of connections.values()) {
            try {
                await connection.close();
            } catch {
                // Ignore close errors.
            }
        }

        connections.clear();

        cachedConfig = null;
    }

    /**
     * Returns the active connection pool.
     *
     * Inside an `isolated()` scope a fresh, context-owned connection is
     * returned for the name; outside it the shared (cached) pool is used.
     *
     * @param {string} [name] - Connection name, defaults to config's `default`.
     * @returns {Connection} The cached Bun SQL connection pool.
     */
    public connection(name?: string): Connection {
        const scope: Map<string, Connection> | undefined = connectionScopes.getStore();

        if (scope) {
            const key: string = name || this.defaultName();
            let connection: Connection | undefined = scope.get(key);

            if (!connection) {
                connection = this.connectionScoped(key);
                scope.set(key, connection);
                openScopedConnections++;
            }

            return connection;
        }

        const key: string = name || this.defaultName();

        if (connections.has(key)) return connections.get(key)!;

        const connection: Connection = this.buildConnection(key);

        connections.set(key, connection);

        return connection;
    }

    /**
     * Runs a callback inside an isolated connection scope. Every
     * `connection()` lookup inside (from the DB facade, builders, grammars,
     * or models) returns an independent per-context database/pool, so
     * concurrent contexts do not share a SQLite handle or a transaction
     * queue. Requires file-backed SQLite databases (see
     * `connectionScoped()`).
     *
     * @param {() => T} callback - Work that runs with its own connections.
     * @returns {T} The callback result.
     */
    public isolated<T>(callback: () => T): T {
        const scope: Map<string, Connection> = new Map<string, Connection>();

        const closeScope = (): void => {
            for (const connection of scope.values()) {
                scopeConnectionClosedHook?.(connection);

                try {
                    connection.close();
                } catch {
                    // Ignore close errors (already-closed or failed handles).
                }
            }

            openScopedConnections -= scope.size;
            scope.clear();
            activeIsolationScopes--;
        };

        activeIsolationScopes++;

        try {
            const result: T = connectionScopes.run(scope, callback);

            // Class-async callbacks: close every scoped connection once the
            // promise settles -- on both success and abort (thrown error), so an
            // interrupted request can never leak an open manual transaction or a
            // file write-lock. Closing an SQLite handle implicitly rolls back any
            // still-open transaction on it.
            if (result instanceof Promise) {
                const promise: Promise<unknown> = result as unknown as Promise<unknown>;

                return promise.then(
                    (value): T => {
                        closeScope();

                        return value as T;
                    },
                    (error): never => {
                        closeScope();

                        throw error;
                    }
                ) as unknown as T;
            }

            closeScope();

            return result;
        } catch (error: any) {
            closeScope();

            throw error;
        }
    }

    /**
     * Connection-resource metrics (leak diagnostics): how many shared pools,
     * active `isolated()` scopes, and open scope-owned handles exist right
     * now.
     *
     * @returns {ConnectionMetrics} The connection metrics.
     */
    public metrics(): ConnectionMetrics {
        return {
            scopes: activeIsolationScopes,
            scopedConnections: openScopedConnections,
            sharedConnections: connections.size
        };
    }

    /**
     * Builds the native connection for a connection name without caching.
     *
     * @param {string} key - The connection name.
     * @returns {Connection} The native Bun SQL/SQLite connection.
     */
    protected buildConnection(key: string): Connection {
        const config: Record<string, any> = ConnectionBuilder.resolveConfig;
        const driverConfig: Record<string, any> = config.connections[key];

        if (!driverConfig)
            throw new ConnectionException(`Database connection [${key}] not configured.`);

        const driver: string = driverConfig.driver || DatabaseDriverEnum.Pg;

        if (this.isSqliteDriver(driver)) {
            const filename: string =
                driverConfig.filename || driverConfig.database || driverConfig.name || ":memory:";

            const database: Database = new Database(filename);

            // WAL lets concurrent handles read the same file; busy_timeout makes
            // short writer contention wait instead of failing with SQLITE_BUSY.
            // Keep it small: SQLite calls are synchronous, so a long busy-wait
            // would stall the event loop (a writer must not be awaited by the
            // holder of the write lock -- that deadlocks a single thread).
            try {
                database.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1000;");
            } catch {
                // In-memory databases ignore WAL; other pragma errors are harmless.
            }

            return database;
        }

        const sql: Bun.SQL = new Bun.SQL(this.optionsFor(driverConfig));

        // Bun ≥1.5 keeps the resolved connection URL at `SQL.Options.url`, but
        // older Bun (1.4.x, the version some distro/npm installs pin) exposes no
        // stable URL field -- `detectDriver` would then silently fall back to
        // Postgres quoting. Stamp the driver name directly on the instance so
        // Grammar can trust it across Bun versions instead of guessing from
        // runtime internals.
        stampDriver(sql, driver);

        // Opt-in bigint normalization: Bun's PG driver returns INT8/BIGINT (and
        // NUMERIC/DECIMAL) values as text. When `options.bigIntAsNumber` is set
        // on the connection, safe integer-shaped values are converted to numbers
        // at the result edge (see Grammar.returnsBigIntAsNumber).
        stampBigIntAsNumber(
            sql,
            driver === DatabaseDriverEnum.Pg && driverConfig.options?.bigIntAsNumber === true
        );

        return sql;
    }

    /**
     * Resolves the database config, loading it from the application's
     * `config/database.ts` exactly once. Falls back to this package's
     * bundled default config when the app hasn't published its own.
     *
     * Expects a `{ default, connections }` configuration object.
     *
     * @returns {Record<string, any>} The normalized database config.
     */
    private static get resolveConfig(): Record<string, any> {
        if (cachedConfig) return cachedConfig;

        try {
            cachedConfig = require(App.Path.configPath("database.ts")).default;
        } catch {
            cachedConfig = require("@/config/database").default;
        }

        return cachedConfig;
    }

    /**
     * Resolves once every registered pooled statement has settled. New
     * statements may be published while draining; the loop re-checks so reset
     * cannot close a pool behind a query that started mid-wait.
     *
     * @returns {Promise<void>} Resolves when all in-flight pooled queries have finished.
     */
    private static async waitForPooledIdle(): Promise<void> {
        while (inFlightPooled.size > 0) {
            await Promise.allSettled([...inFlightPooled]);
        }
    }

    /**
     * Returns the default/named connection name from the resolved config.
     *
     * @returns {string} The default connection name.
     */
    private defaultName(): string {
        const config: Record<string, any> = ConnectionBuilder.resolveConfig;

        return config.default || "primary";
    }

    /**
     * Maps a normalized connection config to native `Bun.sql` options.
     *
     * @param {Record<string, any>} config - The connection config.
     * @returns {SQL.Options} The Bun SQL connection options.
     */
    private optionsFor(config: Record<string, any>): Bun.SQL.Options {
        const driver: string = config.driver || DatabaseDriverEnum.Pg;
        const pool: Record<string, any> = config.pool || {};
        const top: Record<string, any> = ConnectionBuilder.resolveConfig;

        const base: Record<string, any> = {
            max: pool.max || config.max || top.max || 10,
            idleTimeout: defineValue(
                pool.idleTimeout,
                defineValue(config.idleTimeout, defineValue(top.idleTimeout, 30))
            )
        };

        const url: string = defineValue(config.url, this.buildUrl(driver, config));

        // MySQL 8 `caching_sha2_password` over a non-TLS connection needs
        // `allowPublicKeyRetrieval: true` for the RSA handshake. Bun only reads
        // that from the `SQL.Options` object (URL query params are ignored), so
        // forward any driver-level `options` past the plain URL.
        const driverOptions: Record<string, any> = (config.options || config.mysql || {}) as Record<
            string,
            any
        >;

        return {
            ...base,
            url,
            ...driverOptions
        } as Bun.SQL.Options;
    }

    /**
     * Builds a connection URL from discrete connection fields when no
     * `url` is provided.
     *
     * @param {string} driver - One of `pg`/`mysql`.
     * @param {Record<string, any>} config - Connection fields.
     * @returns {string} The connection URL.
     */
    private buildUrl(driver: string, config: Record<string, any>): string {
        const scheme: string =
            driver === DatabaseDriverEnum.Mysql ? DatabaseDriverEnum.Mysql : "postgres";
        let host: string = config.host || "127.0.0.1";
        const port: string | number =
            config.port || (driver === DatabaseDriverEnum.Mysql ? 3306 : 5432);
        const user: string = config.user || config.username || "postgres";
        const password: string = config.password || "";
        const database: string = config.database || config.name || "bejibun";

        // IPv6 literals need brackets in a URL authority; user info and the
        // database name are escaped so special characters cannot corrupt the URI.
        if (host.includes(":")) host = `[${host}]`;

        return `${scheme}://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(database)}`;
    }

    /**
     * Builds a fresh, uncached connection for the given name. Callers own
     * the handle: it is never pooled or shared, so concurrent async
     * contexts each get an independent connection (per-context isolation).
     *
     * Requires a file-backed SQLite database; a `:memory:` SQLite database
     * cannot be split across contexts (each handle would be an empty file).
     *
     * @param {string} [name] - Connection name, defaults to config's `default`.
     * @returns {Connection} A fresh Bun SQL connection pool.
     */
    private connectionScoped(name?: string): Connection {
        const config: Record<string, any> = ConnectionBuilder.resolveConfig;
        const key: string = name || config.default || "primary";
        const driverConfig: Record<string, any> = config.connections[key];

        if (!driverConfig)
            throw new ConnectionException(`Database connection [${key}] not configured.`);

        const driver: string = driverConfig.driver || DatabaseDriverEnum.Pg;

        if (
            this.isSqliteDriver(driver) &&
            (driverConfig.filename || driverConfig.database || driverConfig.name) === ":memory:"
        )
            throw new ConnectionException(
                `Database connection [${key}] uses SQLite in-memory (:memory); per-context connections require a file-backed database.`
            );

        return this.buildConnection(key);
    }

    /**
     * Whether a driver name refers to SQLite.
     *
     * @param {string} driver - The driver name to inspect.
     * @returns {boolean} Whether the driver is SQLite.
     */
    private isSqliteDriver(driver: string): boolean {
        return (
            driver === DatabaseDriverEnum.Sqlite ||
            driver === DatabaseDriverEnum.Sqlite3 ||
            driver === "bun:sqlite" ||
            driver === "bun-sqlite"
        );
    }
}
