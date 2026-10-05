import type {Database} from "bun:sqlite";

export type Connection = Bun.SQL | Database;