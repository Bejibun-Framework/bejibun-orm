import type {Database} from "bun:sqlite";
import type {Connection} from "@/types/context";
import type {PreparedStatement} from "@/types/grammar";
import ConnectionBuilder, {
    DRIVER_TAG,
    readBigIntAsNumber,
    readStampedDriver,
    trackPooledStatement
} from "@/builders/ConnectionBuilder";
import {currentTransaction} from "@/contexts/TransactionContext";
import DatabaseDriverEnum from "@/enums/DatabaseDriverEnum";
import {translateQueryError} from "@/exceptions/translateQueryError";
import DB from "@/facades/DB";
import {record, shouldRecord} from "@/utils/QueryListener";

/** Cap on the quote cache before it is flushed. */
const QUOTE_CACHE_MAX: number = 20_000;

/** Cap on per-database prepared-statement caches. */
const STATEMENT_CACHE_MAX: number = 2_000;

/** Caches driver detection per connection (immutable). */
const driverCache: WeakMap<Connection, string> = new WeakMap<Connection, string>();

/** Prepared-statement caches per SQLite database. */
const statementCache: WeakMap<Database, Map<string, PreparedStatement>> = new WeakMap<
    Database,
    Map<string, PreparedStatement>
>();

/** Module-level identifier quoting cache, nested per driver. */
const quoteCache: Map<string, Map<string, string>> = new Map<string, Map<string, string>>();

/**
 * Compiles parameterized SQL fragments into driver-specific syntax
 * (placeholder style, identifier quoting) and executes them against
 * a native Bun `SQL` pool.
 *
 * Internal SQL is always built with `?` placeholders. The grammar
 * rewrites them to the driver's own style (`$1` for PostgreSQL,
 * `?` for MySQL/SQLite) right before execution.
 */
export default class Grammar {
    /** The target SQL driver. */
    private readonly driver: string;

    /** The connection pool queries run against. */
    private readonly connection: Connection;

    /**
     * Creates a grammar bound to a connection, using the ambient
     * transaction connection or the default connection when none is given.
     *
     * @param {Connection} [connection] - The target connection pool.
     */
    public constructor(connection?: Connection) {
        this.connection =
            connection || currentTransaction() || new ConnectionBuilder().connection();
        this.driver = this.detectDriver(this.connection);
    }

    /**
     * Executes a parameterized query.
     *
     * @param {string} sql - SQL with `?` placeholders.
     * @param {Array<any>} bindings - Bound parameter values.
     * @returns {Promise<Array<T>>} The result rows (or statement info for writes).
     */
    public async run<T = any>(sql: string, bindings: Array<any> = []): Promise<Array<T>> {
        const observe: boolean = shouldRecord();
        const started: number = observe ? performance.now() : 0;

        try {
            // A grammar built with an explicit connection (facade/`Schema`),
            // possibly BEFORE any transaction opened, must still join a
            // transaction/isolation scope active at execution time: the ambient
            // `currentTransaction()` client is re-resolved on every run so writes
            // from pool-built grammars ride the SAME transactional client (the
            // MySQL abort-rollback test depends on this -- pool-autocommit would
            // otherwise commit writes even after the enclosing tx aborts).
            const active: Connection = currentTransaction() ?? this.connection;
            const result: any =
                active instanceof Database
                    ? this.runSqlite<T>(active, sql, bindings)
                    : await this.runPooled(sql, bindings, active);

            if (observe)
                record({
                    sql,
                    bindings,
                    driver: this.driver,
                    duration: performance.now() - started
                });

            return result as Array<T>;
        } catch (error: any) {
            if (observe)
                record({
                    sql,
                    bindings,
                    driver: this.driver,
                    duration: performance.now() - started,
                    error
                });

            throw translateQueryError(error, sql, bindings);
        }
    }

    /**
     * Quotes a single identifier for the active driver. Results are
     * memoized globally since identifier quoting is deterministic.
     *
     * @param {string} identifier - Column/table name.
     * @returns {string} The quoted identifier.
     */
    public quote(identifier: string): string {
        let byDriver: Map<string, string> | undefined = quoteCache.get(this.driver);

        if (!byDriver) {
            byDriver = new Map<string, string>();

            quoteCache.set(this.driver, byDriver);
        }

        const cached: string | undefined = byDriver.get(identifier);

        if (cached !== undefined) return cached;

        const parts: Array<string> = identifier.split(".");
        const quoted: string = parts.map((part: string) => this.quotePart(part)).join(".");

        if (byDriver.size >= QUOTE_CACHE_MAX) byDriver.clear();

        byDriver.set(identifier, quoted);

        return quoted;
    }

    /**
     * Rewrites `?` placeholders to the driver's binding style.
     *
     * @param {string} sql - SQL with `?` placeholders.
     * @returns {string} Driver-specific SQL.
     */
    public compilePlaceholders(sql: string): string {
        const pg: boolean = this.driver === DatabaseDriverEnum.Pg;
        const n: number = sql.length;
        let pgIndex: number = 0;
        let out: string = "";

        for (let i: number = 0; i < n; i++) {
            const char: string = sql.charAt(i);

            if (char === "'") {
                out += char;
                i++;

                while (i < n) {
                    out += sql.charAt(i);

                    if (sql.charAt(i) === "'") {
                        if (sql.charAt(i + 1) === "'") {
                            out += "'";
                            i++;
                        } else {
                            break;
                        }
                    }

                    i++;
                }

                continue;
            }

            if (char === '"') {
                out += char;
                i++;

                while (i < n) {
                    out += sql.charAt(i);

                    if (sql.charAt(i) === '"') {
                        if (sql.charAt(i + 1) === '"') {
                            out += '"';
                            i++;
                        } else {
                            break;
                        }
                    }

                    i++;
                }

                continue;
            }

            if (pg && char === "$" && sql.charAt(i + 1) === "$") {
                out += "$$";
                i += 2;

                while (i < n) {
                    out += sql.charAt(i);

                    if (sql.charAt(i) === "$" && sql.charAt(i + 1) === "$") {
                        out += "$";
                        i += 2;
                        break;
                    }

                    i++;
                }

                continue;
            }

            if (char === "?") {
                if (sql.charAt(i + 1) === "?") {
                    out += "?";
                    i++;

                    continue;
                }

                out += pg ? `$${++pgIndex}` : "?";

                continue;
            }

            out += char;
        }

        return out;
    }

    /**
     * Returns the current driver name.
     *
     * @returns {string} The driver name.
     */
    public driverName(): string {
        return this.driver;
    }

    /**
     * Returns whether the active connection normalizes PG bigint strings to
     * JS numbers (set via connection `options.bigIntAsNumber`).
     *
     * @returns {boolean} True when bigint normalization is enabled.
     */
    public returnsBigIntAsNumber(): boolean {
        const active: Connection = currentTransaction() ?? this.connection;

        return readBigIntAsNumber(active as object);
    }

    /**
     * Executes a pooled (pg/mysql) query, publishing the in-flight promise to
     * `ConnectionBuilder` so `reset()` can drain ordinary queries before
     * closing the pool (transactions already carry their own drain fence).
     *
     * @param {string} sql - SQL with `?` placeholders.
     * @param {Array<any>} bindings - Bound values.
     * @param {Connection} connection - The active pooled connection/client.
     * @returns {Promise<Array<T>>} Rows (reads) or statement info (writes).
     */
    private async runPooled<T = any>(
        sql: string,
        bindings: Array<any>,
        connection: Connection
    ): Promise<Array<T>> {
        // Subquery-count call-sites (fromSubquery/selectSub/fromSub) build the
        // count as a bare `{ grammar }` carrier -- no live `.unsafe`. Re-resolve
        // the facade's stamped `.unsafe` lazily (exact proven-green pattern
        // that MigrationRunner already uses to emit mysql SQL); a bare carrier
        // carries only the grammar that already read the mysql WeakMap stamp,
        // so re-reading `.unsafe` off the live facade keeps backtick + ?
        // bindings while never trusting a possibly-pg `.grammar` property.
        const target: any = (connection as any)?.unsafe
            ? connection
            : (DB.connection?.() ?? connection);
        const promise: Promise<any> = target.unsafe(this.compilePlaceholders(sql), bindings);

        trackPooledStatement(promise);

        return (await promise) as Array<T>;
    }

    /**
     * Executes a query on a SQLite connection using cached prepared
     * statements (much faster than re-parsing via `unsafe`).
     *
     * @param {Database} db - The SQLite database to use.
     * @param {string} sql - SQL with `?` placeholders.
     * @param {Array<any>} bindings - Bound values.
     * @returns {Array<T>} Rows (reads) or `{ changes, lastInsertRowid }` (writes).
     */
    private runSqlite<T = any>(db: Database, sql: string, bindings: Array<any>): Array<T> {
        const prepared: PreparedStatement = this.prepare(db, sql);

        if (prepared.read) return prepared.statement.all(...bindings) as Array<T>;

        return prepared.statement.run(...bindings) as any;
    }

    /**
     * Quotes a single, dot-free identifier part.
     *
     * @param {string} part - The identifier.
     * @returns {string} The quoted identifier.
     */
    private quotePart(part: string): string {
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(part)) {
            if (this.driver === DatabaseDriverEnum.Mysql) return `\`${part}\``;

            return `"${part}"`;
        }

        return part;
    }

    /**
     * Detects the driver name for a connection once, caching the result.
     *
     * @param {Connection} connection - The Bun SQL connection.
     * @returns {string} `mysql`, `sqlite`, or `pg`.
     */
    private detectDriver(connection: Connection): string {
        const cached: string | undefined = driverCache.get(connection);

        if (cached) return cached;

        let driver: string;

        const tagged: string | undefined =
            readStampedDriver(connection as any) ??
            (connection as any)?.[DRIVER_TAG] ??
            (connection as any)?.options?.[DRIVER_TAG];

        if (tagged) {
            switch (tagged) {
                case DatabaseDriverEnum.Sqlite:
                case DatabaseDriverEnum.Sqlite3:
                    driver = DatabaseDriverEnum.Sqlite;
                    break;
                case DatabaseDriverEnum.Mysql:
                    driver = DatabaseDriverEnum.Mysql;
                    break;
                case DatabaseDriverEnum.Pg:
                    driver = DatabaseDriverEnum.Pg;
                    break;
                default:
                    driver = tagged as string;
                    break;
            }
        } else if (connection instanceof Database) {
            driver = DatabaseDriverEnum.Sqlite;
        } else {
            const stamped: string | undefined = (connection as any)[DRIVER_TAG];

            if (stamped) {
                switch (stamped) {
                    case DatabaseDriverEnum.Sqlite:
                    case DatabaseDriverEnum.Sqlite3:
                        driver = DatabaseDriverEnum.Sqlite;
                        break;
                    case DatabaseDriverEnum.Mysql:
                        driver = DatabaseDriverEnum.Mysql;
                        break;
                    case DatabaseDriverEnum.Pg:
                        driver = DatabaseDriverEnum.Pg;
                        break;
                    default:
                        driver = stamped as string;
                        break;
                }
            } else {
                driver = (connection as any).options?.url?.startsWith(DatabaseDriverEnum.Mysql)
                    ? DatabaseDriverEnum.Mysql
                    : (connection as any).options?.filename
                        ? DatabaseDriverEnum.Sqlite
                        : DatabaseDriverEnum.Pg;
            }
        }

        driverCache.set(connection, driver);

        return driver;
    }

    /**
     * Returns whether a whole word appears in the SQL while ignoring
     * single-quoted string literals (so `RETURNING` inside a quoted value,
     * e.g. `WHERE note = 'returning'`, is not mistaken for a real clause).
     *
     * @param {string} sql - The SQL to scan.
     * @param {string} keyword - The keyword to look for.
     * @returns {boolean} True when the keyword appears outside string literals.
     */
    private containsKeywordOutsideQuotes(sql: string, keyword: string): boolean {
        const target: string = keyword.toLowerCase();
        const n: number = sql.length;
        let inString: boolean = false;

        for (let i: number = 0; i < n; i++) {
            const char: string = sql.charAt(i);

            if (char === "'") {
                if (sql.charAt(i + 1) === "'") {
                    i++;

                    continue;
                }

                inString = !inString;

                continue;
            }

            if (inString) continue;

            if (!/[A-Za-z_]/.test(char)) continue;

            let end: number = i;

            while (end < n && /[A-Za-z0-9_$]/.test(sql.charAt(end))) end++;

            if (sql.slice(i, end).toLowerCase() === target) return true;

            i = end - 1;
        }

        return false;
    }

    /**
     * Returns whether a statement is a read (row-returning) query. SQLite's
     * `Statement.all()` returns rows while `Statement.run()` returns change
     * counts, so reads must be routed to `.all()`.
     *
     * @param {string} sql - The SQL to classify.
     * @returns {boolean} True when the statement returns rows.
     */
    private isReadQuery(sql: string): boolean {
        const trimmed: string = sql.trimStart();

        if (/^(select|pragma|with|explain)\b/i.test(trimmed)) return true;

        return this.containsKeywordOutsideQuotes(sql, "returning");
    }

    /**
     * Returns (and caches) the prepared statement and its read/write
     * classification for a SQL string, so neither re-parsing nor the
     * classification regex runs again on repeat queries.
     *
     * @param {Database} db - The SQLite database.
     * @param {string} sql - The SQL string.
     * @returns {PreparedStatement} The prepared statement and its read flag.
     */
    private prepare(db: Database, sql: string): PreparedStatement {
        let map: Map<string, PreparedStatement> | undefined = statementCache.get(db);

        if (!map) {
            map = new Map<string, PreparedStatement>();
            statementCache.set(db, map);
        }

        let prepared: PreparedStatement | undefined = map.get(sql);

        if (!prepared) {
            prepared = {
                statement: db.query(sql),
                read: this.isReadQuery(sql)
            };

            if (map.size >= STATEMENT_CACHE_MAX) map.clear();

            map.set(sql, prepared);
        }

        return prepared;
    }
}
