import type {Connection} from "@/types/context";
import {AsyncLocalStorage} from "node:async_hooks";

/** Ambient storage for the current transaction connection. */
const storage: AsyncLocalStorage<Connection> = new AsyncLocalStorage<Connection>();

/**
 * Runs a callback inside an ambient transaction context so any
 * QueryBuilder / Grammar / Model operation created within it joins
 * the active transaction connection.
 *
 * @param {Connection} connection - The scoped transaction connection.
 * @param {(connection: Connection) => T | Promise<T>} fn - Callback to run inside the context.
 * @returns {Promise<T>} The callback result.
 */
export async function withinTransaction<T>(
    connection: Connection,
    fn: (connection: Connection) => T | Promise<T>
): Promise<T> {
    return storage.run(connection, async () => fn(connection));
}

/**
 * Returns the ambient transaction connection, if the caller is inside
 * a `DB.transaction` callback.
 *
 * @returns {Connection | undefined} The scoped connection or undefined.
 */
export function currentTransaction(): Connection | undefined {
    return storage.getStore();
}
