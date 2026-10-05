import type {Connection} from "@/types/context";
import {AsyncLocalStorage} from "node:async_hooks";

const storage: AsyncLocalStorage<Connection> = new AsyncLocalStorage<Connection>();

export async function withinTransaction<T>(connection: Connection, fn: (connection: Connection) => T | Promise<T>): Promise<T> {
    return storage.run(connection, async => () => fn(connection));
}

export function currentTransaction: Connection | undefined {
    return storage.getStore();
}