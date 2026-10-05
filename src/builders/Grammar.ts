import type {Database} from "bun:sqlite";
import type {Connection} from "@/types/context";
import ConnectionBuilder, {DRIVER_TAG, readStampedDriver} from "@/builders/ConnectionBuilder";
import {currentTransaction} from "@/contexts/TransactionContext";

const QUOTE_CACHE_MAX: number = 20_000;
const STATEMENT_CACHE_MAX: number = 2_000;
const driverCache: WeakMap<Connection, string> = new WeakMap<Connection, string>();
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
        driver = tagged;
    } else if (connection instanceof Database) {
        driver = "sqlite";
    } else {
        const stamped: symbol | undefined = (connection as any)[DRIVER_TAG];

        if (stamped) {
            driver = stamped;
        } else {
            driver = (connection as any).options?.url?.startsWith("mysql")
                ? "mysql"
                : (connection as any).options?.filename
                    ? "sqlite"
                    : "pg";
        }
    }

    driverCache.set(connection, driver);

    return driver;
};

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
        const pg: boolean = this.driver === "pg";

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
            }

            if (char === "?") {
                if (sql.charAt(i + 1) === "?") {
                    out += "?";
                    i++;
                }

                out += pg ? `$${++pgIndex}` : "?";
            }

            out += char;
        }

        return out;
    }

    protected quotePart(part: string): string {
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(part)) {
            if (this.driver === "mysql") return `\`${part}\``;

            return `"${part}"`;
        }

        return part;
    }
}