import type {Database} from "bun:sqlite";
import type {Connection} from "@/types/context";
import App from "@bejibun/app";
import {defineValue} from "@bejibun/utils";
import {AsyncLocalStorage} from "node:async_hooks";
import {ConnectionException} from "@/exceptions";
import DatabaseDriverEnum from "@/enums/DatabaseDriverEnum";

let cachedConfig: Record<string, any> | null = null;
let scopeConnectionClosedHook: ((connection: Connection) => void) | undefined;
let openScopedConnections: number = 0;
let activeIsolationScope: number = 0;

const connections: Map<string, Connection> = new Map<string, Connection>();
const connectionScopes: AsyncLocalStorage<Map<string, Connection> | undefined> = new AsyncLocalStorage<Map<string, Connection> | undefined>();
const driverStamps: WeakMap<object, string> = new WeakMap<object, string>();
const bigIntAsNumberStamps: WeakMap<object, boolean> = new WeakMap<object, boolean>();
const inFlightPooled: Set<Promise<void>> = new Set<Promise<void>>();

export const DRIVER_TAG: symbol = Symbol.for("bejibun-orm.driver");

export const stampDriver = (connection: object, driver: string): void => {
    driverStamps.set(connection, driver);
};

export const readStampedDriver = (connection: object): string | undefined => {
    return driverStamps.get(connection);
};

export const stampBigIntAsNumber = (connection: object, enabled: boolean): void => {
    bigIntAsNumberStamps.set(connection, enabled);
};

export const trackPooledStatement = (promise: Promise<unknown>): void => {
    const drain: Promise<void> = new Promise<void>((resolve: any) => {
        void Promise.resolve(promise).then(() => resolve(), () => resolve());
    });

    inFlightPooled.add(drain);

    void drain.finally(() => inFlightPooled.delete(drain));
};

const resolveConfig = (): Record<string, any> => {
    if (cachedConfig) return cachedConfig;

    try {
        cachedConfig = require(App.Path.configPath("cache.ts")).default;
    } catch {
        cachedConfig = require("@/config/cache").default;
    }

    return cachedConfig;
};

const isSqliteDriver = (driver: string): boolean => {
    return (
        driver === DatabaseDriverEnum.Sqlite ||
        driver === DatabaseDriverEnum.Sqlite3 ||
        driver === "bun:sqlite" ||
        driver === "bun-sqlite"
    );
};

export default class ConnectionBuilder {
    public static setScopeConnectionClosedHook(hook: (connection: Connection) => void): void {
        scopeConnectionClosedHook = hook;
    }

    public static getTransactionTimeout(): number {
        const config: Record<string, any> = resolveConfig();

        return config.transactionTimeout ?? 0;
    }

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

    public isolated<T>(callback: () => T): T {
        const scope: Map<string, Connection> = new Map<string, Connection>();

        const closeScope = (): void {
            for (const connection of scope.values()) {
                scopeConnectionClosedHook?.(connection);

                try {
                    connection.close();
                } catch {
                    // Ignore close errors for already-closed or failed handles.
                }
            }

            openScopedConnections -= scope.size;
            scope.clear();
            activeIsolationScope--;
        };

        activeIsolationScope++;

        try {
            const result: T = connectionScopes.run(scope, callback);

            if (result instanceof Promise) {
                const promise: Promise<unknown> = result as unknown as Promise<unknown>;

                return promise.then((value): T => {
                    closeScope();

                    return value as T;
                }, (error): never => {
                    closeScope();

                    throw error;
                }) as unknown as T;
            }

            closeScope();

            return result;
        } catch (error: any) {
            closeScope();

            throw error;
        }
    }

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

    protected defaultName(): string {
        const config: Record<string, any> = resolveConfig();

        return config.default || "primary";
    }

    protected connectionScoped(name?: string): Connection {
        const config: Record<string, any> = resolveConfig();
        const key: string = name || config.default || "primary";
        const driverConfig: Record<string, any> = config.connections[key];

        if (!driverConfig) throw new ConnectionException(`Database connection [${key}] not configured.`);

        const driver: string = driverConfig.driver || DatabaseDriverEnum.Pg;

        if (
            isSqliteDriver(driver) &&
            (
                driverConfig.filename ||
                driverConfig.database ||
                driverConfig.name
            ) === ":memory"
        ) throw new ConnectionException(`Database connection [${key}] uses SQLite in-memory (:memory); per-context connections require a file-backed database.`);

        return this.buildConnection(key);
    }

    protected buildConnection(key: string): Connection {
        const config: Record<string, any> = resolveConfig();
        const driverConfig: Record<string, any> = config.connections[key];

        if (!driverConfig) throw new ConnectionException(`Database connection [${key}] not configured.`);

        const driver: string = driverConfig.driver || DatabaseDriverEnum.Pg;

        if (isSqliteDriver(driver)) {
            const filename: string = driverConfig.filename || driverConfig.database || driverConfig.name || ":memory:";

            const database: Database = new Database(filename);

            try {
                database.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1000;");
            } catch {
                // In-memory databases ignore WAL; other pragma errors are harmless.
            }

            return database;
        }

        const sql: Bun.SQL = new Bun.SQL(this.optionsFor(driverConfig));

        stampDriver(sql, driver);

        stampBigIntAsNumber(sql, driver === DatabaseDriverEnum.Pg && driverConfig.options?.bigIntAsNumber === true);

        return sql;
    }

    protected optionsFor(config: Record<string, any>): Bun.SQL.Options {
        const driver: string = config.driver || DatabaseDriverEnum.Pg;
        const pool: Record<string, any> = config.pool || {};
        const top: Record<string, any> = resolveConfig();

        const base: Record<string, any> = {
            max: pool.max || config.max || top.max || 10,
            idleTimeout: defineValue(
                pool.idleTimeout,
                defineValue(
                    config.idleTimeout,
                    defineValue(
                        top.idleTimeout,
                        30
                    )
                )
            )
        };

        const url: string = defineValue(config.url, this.buildUrl(driver, config));

        const driverOptions: Record<string, any> = (config.options || config.mysql || {}) as Record<string, any>;

        return {
            ...base,
            url,
            ...driverOptions
        } as Bun.SQL.Options;
    }

    protected buildUrl(driver: string, config: Record<string, any>): string {
        const scheme: string = driver === DatabaseDriverEnum.Mysql ? DatabaseDriverEnum.Mysql : "postgres";
        let host: string = config.host || "127.0.0.1";
        const port: string | number = config.port || (driver === DatabaseDriverEnum.Mysql ? 3306 : 5432);
        const user: string = config.user || config.username || "postgres";
        const password: string = config.password || "";
        const database: string = config.database || config.name || "bejibun";

        if (host.includes(":")) host = `[${host}]`;

        return `${scheme}://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(database)}`;
    }
}