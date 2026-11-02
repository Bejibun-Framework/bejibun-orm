import type {Database} from "bun:sqlite";

/** A native connection: Bun SQL pool (pg/mysql) or SQLite database. */
export type Connection = Bun.SQL | Database;
