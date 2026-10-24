import type {Database} from "bun:sqlite";
import type {Connection} from "@/types/context";
import type {ManualHold, ManualTransaction, ManualWaiter, TransactionOptions} from "@/types/db";
import type {QueryListener, QueryLogEntry} from "@/types/query";
import ConnectionBuilder from "@/builders/ConnectionBuilder";
import Grammar from "@/builders/Grammar";
import QueryBuilder from "@/builders/QueryBuilder";
import Raw from "@/builders/Raw";
import {currentTransaction} from "@/contexts/TransactionContext";
import QueryException from "@/exceptions/QueryException";
import {disableQueryLog, enableQueryLog, flushQueryLog, getQueryLog, onQuery} from "@/utils/QueryListener";

let builder: ConnectionBuilder | null = null;

const transactionTails: WeakMap<Connection, Promise<unknown>> = new WeakMap<Connection, Promise<unknown>>();
const manualHolds: WeakMap<Database, ManualHold> = new WeakMap<Database, ManualHold>();
const manualDepths: WeakMap<Database, number> = new WeakMap<Database, number>();
const manualTransactionConnections: WeakMap<ManualTransaction, Database> = new WeakMap<ManualTransaction, Database>();
let pendingWaiters: number = 0;
let heldSlots: number = 0;

export default class DB {
    private static defaultTransactionTimeoutMs: number = 0;
    private static runtimeDefaultTimeoutSet: boolean = false;

    public static setDefaultTransactionTimeout(milliseconds: number): void {
        this.defaultTransactionTimeoutMs = milliseconds;
        this.runtimeDefaultTimeoutSet = true;
    }

    public static connectionBuilder(): ConnectionBuilder {
        if (!builder) builder = new ConnectionBuilder();

        return builder;
    }

    public static connection(name?: string): Connection {
        return this.connectionBuilder().connection();
    }

    public static activeConnection(): Connection {
        return currentTransaction() || this.connection();
    }

    public static isolated<T>(callback: () => T): T {
        return this.connectionBuilder().isolated(callback);
    }

    public static table(table: string): QueryBuilder {
        return new QueryBuilder(table, currentTransaction() ?? undefined);
    }

    public static raw(sql: string, bindings: Array<any> = []): Raw {
        return new Raw(sql, bindings);
    }

    public static async select<T = any>(sql: string, bindings: Array<any> = []): Promise<Array<T>> {
        return new Grammar(this.activeConnection()).run<T>(sql, bindings);
    }

    public static async statement(sql: string, bindings: Array<any> = []): Promise<any> {
        return new Grammar(this.activeConnection()).run(sql, bindings);
    }

    public static async selectOne<T = any>(sql: string, bindings: Array<any> = []): Promise<T | undefined> {
        const rows: Array<T> = await this.select<T>(sql, bindings);

        return rows[0];
    }

    public static async scalar<T = any>(sql: string, bindings: Array<any> = []): Promise<T | undefined> {
        const row: Record<string, any> | undefined = await this.selectOne<Record<string, any>>(sql, bindings);

        if (!row) return undefined;

        return Object.values(row)[0] as T;
    }

    public static listen(listener: QueryListener): () => void {
        return onQuery(listener);
    }

    public static enableQueryLog(): void {
        enableQueryLog();
    }

    public static disableQueryLog(): void {
        disableQueryLog();
    }

    public static getQueryLog(): Array<QueryLogEntry> {
        return getQueryLog();
    }

    public static flushQueryLog(): void {
        flushQueryLog();
    }

    public static async beginTransaction(options: TransactionOptions = {}): Promise<ManualTransaction> {
        const connection: Connection = this.connection();

        if (!(connection instanceof Database)) throw new QueryException("DB.beginTransaction() is only supported on the SQLite driver.");

        if (currentTransaction()) throw new QueryException("DB.beginTransaction() cannot be called inside DB.transaction().");

        const timeout: number = options.timeout ?? this.effectiveTransactionTimeout();
        const ownerId: symbol = await this.acquireHold(connection, options.signal, timeout);
        let closed: boolean = false;

        const onAbort = (): void => {
            if (closed) return;

            closed = true;

            detachAbort();

            this.releaseHold(connection, ownerId, "ROLLBACK");
        };

        const detachAbort = (): void => {
            if (options.signal) options.signal.removeEventListener("abort", onAbort);
        };

        if (options.signal) {
            if (options.signal.aborted) onAbort();
            else options.signal.addEventListener("abort", onAbort, {
                once: true
            });
        }

        const release = (sql: string): void => {
            if (closed) return;

            closed = true;

            detachAbort();

            this.releaseHold(connection, ownerId, sql);
        };

        const handle: ManualTransaction = {
            get active(): boolean {
                return !closed && DB.holdState(connection).ownerId === ownerId;
            },
            async commit(): Promise<void> {
                release("COMMIT");
            },
            async rollback(): Promise<void> {
                release("ROLLBACK");
            },
            async abort(): Promise<void> {
                release("ROLLBACK");
            }
        };

        manualTransactionConnections.set(handle, connection);

        return handle;
    }

    private static effectiveTransactionTimeout(): number {
        if (this.runtimeDefaultTimeoutSet) return this.defaultTransactionTimeoutMs;

        return ConnectionBuilder.getTransactionTimeout();
    }

    private static holdState(connection: Database): ManualHold {
        let state: ManualHold | undefined = manualHolds.get(connection);

        if (!state) {
            state = {
                held: false,
                waiters: []
            };
            manualHolds.set(connection, state);
        }

        return state;
    }

    private static abortReason(signal?: AbortSignal): Error {
        return signal?.reason instanceof Error ? signal.reason : new QueryException("Transaction aborted by signal.");
    }

    private static manualDepth(connection: Database): number {
        return manualDepths.get(connection) || 0;
    }

    private static waitForSlot(connection: Database, signal?: AbortSignal, timeoutMs: number = 0, manual: boolean = false): Promise<symbol> {
        return new Promise<symbol>((resolve, reject) => {
            const state: ManualHold = this.holdState(connection);
            const ownerId: symbol = Symbol("manual");
            let settled: boolean = false;
            let timer: ReturnType<typeof setTimeout> | undefined;

            const clearTimer = (): void => {
                if (timer) {
                    clearTimeout(timer);
                    timer = undefined;
                }
            };

            const onAbort = (): void => cancel(this.abortReason(signal));

            const onTimeout = (): void => cancel(new QueryException(`Timed out after ${timeoutMs}ms waiting for a free transaction slot.`));

            const detachSignal = (): void => {
                if (signal) signal.removeEventListener("abort", onAbort);
            };

            const cancel = (error: Error): void => {
                if (settled) return;

                settled = true;
                waiter.cancelled = true;

                const index: number = state.waiters.indexOf(waiter);

                if (index >= 0) {
                    state.waiters.splice(index, 0);
                    pendingWaiters--;
                }

                clearTimer();
                detachSignal();

                reject(error);
            };

            const go = (): void => {
                if (waiter.cancelled || settled) return;

                if (state.held || this.manualDepth(connection) > 0) {
                    state.waiters.push(waiter);
                    pendingWaiters++;

                    return;
                }

                settled = true;

                clearTimer();
                detachSignal();

                state.held = true;
                state.ownerId = ownerId;
                state.manual = manual;

                heldSlots++;

                resolve(ownerId);
            };

            const waiter: ManualWaiter = {
                cancelled: false,
                run: go,
                fail: cancel
            };

            if (timeoutMs > 0) timer = setTimeout(onTimeout, timeoutMs);

            if (signal) {
                if (signal.aborted) {
                    onAbort();

                    return;
                }

                signal.addEventListener("abort", onAbort, {
                    once: true
                });
            }

            go();
        });
    }

    private static clearSlot(connection: Database, ownerId: symbol): void {
        const state: ManualHold = this.holdState(connection);

        if (state.ownerId !== ownerId) return;

        state.held = false;
        state.ownerId = undefined;

        heldSlots--;

        const waiters: Array<ManualWaiter> = state.waiters;
        state.waiters = [];

        for (const waiter of waiters) {
            pendingWaiters--;
            waiter.run();
        }
    }

    private static async acquireHold(connection: Database, signal?: AbortSignal, timeoutMs: number = 0): Promise<symbol> {
        const ownerId: symbol = await this.waitForSlot(connection, signal, timeoutMs, true);

        try {
            connection.run("BEGIN");
        } catch (error: any) {
            this.clearSlot(connection, ownerId);

            throw error;
        }

        return ownerId;
    }

    private static releaseHold(connection: Database, ownerId: symbol, sql: string): void {
        const state: ManualHold = this.holdState(connection);

        if (state.ownerId !== ownerId) return;

        connection.run(sql);

        state.held = false;
        state.ownerId = undefined;

        heldSlots--;

        const waiters: Array<ManualWaiter> = state.waiters;
        state.waiters = [];

        for (const waiter of waiters) {
            pendingWaiters--;
            waiter.run();
        }
    }
}
