import type {Database} from "bun:sqlite";
import type {Connection} from "@/types/context";
import type {PreparedStatement} from "@/types/grammar";
import ConnectionBuilder, {DRIVER_TAG, readStampedDriver, trackPooledStatement} from "@/builders/ConnectionBuilder";
import {currentTransaction} from "@/contexts/TransactionContext";
import DatabaseDriverEnum from "@/enums/DatabaseDriverEnum";
import {translateQueryError} from "@/exceptions/translateQueryError";
import DB from "@/facades/DB";
import {record, shouldRecord} from "@/utils/QueryListener";

const QUOTE_CACHE_MAX: number = 20_000;
const STATEMENT_CACHE_MAX: number = 2_000;
const driverCache: WeakMap<Connection, string> = new WeakMap<Connection, string>();
const statementCache: WeakMap<Database, Map<string, PreparedStatement>> = new WeakMap<Database, Map<string, PreparedStatement>>();
const quoteCache: Map<string, Map<string, string>> = new Map<string, Map<string, string>>();

const detectDriver = (connection: Connection): string => {
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
        const stamped: symbol | undefined = (connection as any)[DRIVER_TAG];

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
};

const containsKeywordOutsideQuotes = (sql: string, keyword: string): boolean => {
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

        if (!/[A-Za-z]/.test(char)) continue;

        let end: number = i;

        while (end < n && /[A-Za-z0-9_$]/.test(sql.charAt(end))) end++;

        if (sql.slice(i, end).toLowerCase() === target) return true;

        i = end - 1;
    }

    return false;
};

const isReadQuery = (sql: string): boolean => {
    const trimmed: string = sql.trimStart();

    if (/^(select|pragma|with|explain)\b/i.test(trimmed)) return true;

    return containsKeywordOutsideQuotes(sql, "returning");
}

export default class Grammar {
    protected driver: string;
    protected connection: Connection;

    public constructor(connection?: Connection) {
        this.connection = connection || currentTransaction() || new ConnectionBuilder().connection();
        this.driver = detectDriver(this.connection);
    }

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

    public compilePlaceholders(sql: string): string {
        const pg: boolean = this.driver === DatabaseDriverEnum.Pg;

        let pgIndex: number = 0;
        let out: string = "";

        const n: number = sql.length;

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

    public async run<T = any>(sql: string, bindings: Array<any> = []): Promise<Array<T>> {
        const observe: boolean = shouldRecord();
        const started: number = observe ? performance.now() : 0;

        try {
            const active: Connection = currentTransaction() ?? this.connection;
            const result: any = active instanceof Database ? this.runSqlite<T>(active, sql, bindings) : await this.runPooled(sql, bindings, active);

            if (observe) record({
                sql,
                bindings,
                driver: this.driver,
                duration: performance.now() - started
            });

            return result as Array<T>;
        } catch (error: any) {
            if (observe) record({
                sql,
                bindings,
                driver: this.driver,
                duration: performance.now() - started,
                error
            });

            throw translateQueryError(error, sql, bindings);
        }
    }

    public driverName(): string {
        return this.driver;
    }

    protected quotePart(part: string): string {
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(part)) {
            if (this.driver === DatabaseDriverEnum.Mysql) return `\`${part}\``;

            return `"${part}"`;
        }

        return part;
    }

    protected prepare(db: Database, sql: string): PreparedStatement {
        let map: Map<string, PreparedStatement> | undefined = statementCache.get(db);

        if (!map) {
            map = new Map<string, PreparedStatement>();
            statementCache.set(db, map);
        }

        let prepared: PreparedStatement | undefined = map.get(sql);

        if (!prepared) {
            prepared = {
                statement: db.query(sql),
                read: isReadQuery(sql)
            };

            if (map.size >= STATEMENT_CACHE_MAX) map.clear();

            map.set(sql, prepared);
        }

        return prepared;
    }

    protected runSqlite<T = any>(db: Database, sql: string, bindings: Array<any>): Array<T> {
        const prepared: PreparedStatement = this.prepare(db, sql);

        if (prepared.read) return prepared.statement.all(...bindings) as Array<T>;

        return prepared.statement.run(...bindings) as any;
    }

    protected async runPooled<T = any>(sql: string, bindings: Array<any>, connection: Connection): Promise<Array<T>> {
        const target: any = (connection as any)?.unsafe ? connection : (DB.connection?.() ?? connection);
        const promise: Promise<any> = target.unsafe(this.compilePlaceholders(sql), bindings);

        trackPooledStatement(promise);

        return (await promise) as Array<T>;
    }
}