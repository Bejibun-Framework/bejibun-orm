import type {Database} from "bun:sqlite";
import type {ConnectionMetrics} from "@/types/connection";
import type {Connection} from "@/types/context";
import type {
    AbortTrack,
    DBMetrics,
    ManualHold,
    ManualTransaction,
    ManualWaiter,
    TransactionOptions
} from "@/types/db";
import type {QueryListener, QueryLogEntry} from "@/types/query";
import ConnectionBuilder, {
    readBigIntAsNumber,
    readStampedDriver,
    stampBigIntAsNumber,
    stampDriver
} from "@/builders/ConnectionBuilder";
import Grammar from "@/builders/Grammar";
import QueryBuilder from "@/builders/QueryBuilder";
import Raw from "@/builders/Raw";
import {currentTransaction, withinTransaction} from "@/contexts/TransactionContext";
import QueryException from "@/exceptions/QueryException";
import {translateQueryError} from "@/exceptions/translateQueryError";
import {
    disableQueryLog,
    enableQueryLog,
    flushQueryLog,
    getQueryLog,
    onQuery
} from "@/utils/QueryListener";

let builder: ConnectionBuilder | null = null;

const transactionTails: WeakMap<Connection, Promise<unknown>> = new WeakMap<
    Connection,
    Promise<unknown>
>();
const manualHolds: WeakMap<Database, ManualHold> = new WeakMap<Database, ManualHold>();
const manualDepths: WeakMap<Database, number> = new WeakMap<Database, number>();
const manualTransactionConnections: WeakMap<ManualTransaction, Database> = new WeakMap<
    ManualTransaction,
    Database
>();
const savepointTailsByDepth: WeakMap<Connection, Map<number, Promise<unknown>>> = new WeakMap<
    Connection,
    Map<number, Promise<unknown>>
>();
const transactionDrains: Set<Promise<void>> = new Set<Promise<void>>();
let inFlightTransactionTasks: number = 0;
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
        return this.connectionBuilder().connection(name);
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

    public static async selectOne<T = any>(
        sql: string,
        bindings: Array<any> = []
    ): Promise<T | undefined> {
        const rows: Array<T> = await this.select<T>(sql, bindings);

        return rows[0];
    }

    public static async scalar<T = any>(
        sql: string,
        bindings: Array<any> = []
    ): Promise<T | undefined> {
        const row: Record<string, any> | undefined = await this.selectOne<Record<string, any>>(
            sql,
            bindings
        );

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

    public static async beginTransaction(
        options: TransactionOptions = {}
    ): Promise<ManualTransaction> {
        const connection: Connection = this.connection();

        if (!(connection instanceof Database))
            throw new QueryException(
                "DB.beginTransaction() is only supported on the SQLite driver."
            );

        if (currentTransaction())
            throw new QueryException(
                "DB.beginTransaction() cannot be called inside DB.transaction()."
            );

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
            else
                options.signal.addEventListener("abort", onAbort, {
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

    public static inTransaction(): boolean {
        const connection: Connection = this.connection();

        if (currentTransaction() !== undefined) return true;

        return connection instanceof Database && this.holdState(connection).held;
    }

    public static metrics(): DBMetrics {
        const pooled: ConnectionMetrics = this.connectionBuilder().metrics();

        return {
            transactionTasks: inFlightTransactionTasks,
            heldSlots,
            pendingWaiters,
            scopes: pooled.scopes,
            scopedConnections: pooled.scopedConnections,
            sharedConnections: pooled.sharedConnections
        };
    }

    public static isSettled(): boolean {
        const metrics: DBMetrics = this.metrics();

        return (
            metrics.transactionTasks === 0 &&
            metrics.heldSlots === 0 &&
            metrics.pendingWaiters === 0 &&
            metrics.scopes === 0 &&
            metrics.scopedConnections === 0
        );
    }

    public static assertSettled(label?: string): void {
        if (this.isSettled()) return;

        throw new QueryException(
            `${label ? `${label}: ` : ""}database resources did not settle: ${JSON.stringify(this.metrics())}`
        );
    }

    public static async transaction<T = any>(
        callback: any,
        manualOrOptions?: ManualTransaction | TransactionOptions
    ): Promise<T> {
        inFlightTransactionTasks++;

        try {
            const connection: Connection = this.connection();
            const handle: ManualTransaction | undefined =
                manualOrOptions && "active" in manualOrOptions
                    ? (manualOrOptions as ManualTransaction)
                    : undefined;
            const signal: AbortSignal | undefined =
                manualOrOptions && "signal" in manualOrOptions
                    ? (manualOrOptions as TransactionOptions).signal
                    : undefined;
            const assignedTimeout: number | undefined =
                manualOrOptions && "timeout" in manualOrOptions
                    ? (manualOrOptions as TransactionOptions).timeout
                    : undefined;
            const waitDeadline: number =
                assignedTimeout === undefined
                    ? this.effectiveTransactionTimeout()
                    : assignedTimeout;
            const deadlineAt: number = waitDeadline > 0 ? Date.now() + waitDeadline : 0;

            if (connection instanceof Database) {
                if (handle?.active) {
                    const handleConnection = manualTransactionConnections.get(handle);

                    if (handleConnection !== connection)
                        throw new QueryException(
                            "A manual transaction handle can only be used on its own connection."
                        );

                    return await this.enqueueSavepoint(
                        connection,
                        this.savepointDepthFor(connection),
                        () => this.sqliteSavepoint(connection, callback, signal)
                    );
                }

                if (currentTransaction() === connection)
                    return await this.enqueueSavepoint(
                        connection,
                        this.savepointDepthFor(connection),
                        () => this.sqliteSavepoint(connection, callback, signal)
                    );

                return await this.enqueueTransaction(connection, async () => {
                    const remaining: number =
                        deadlineAt > 0 ? Math.max(0, deadlineAt - Date.now()) : 0;

                    if (deadlineAt > 0 && remaining === 0)
                        throw new QueryException(
                            `Timed out after ${waitDeadline}ms waiting for a free transaction slot.`
                        );

                    const slotOwner: symbol = await this.waitForSlot(
                        connection,
                        signal,
                        remaining,
                        false
                    );

                    try {
                        return await this.sqliteTransaction(connection, callback, signal);
                    } finally {
                        this.clearSlot(connection, slotOwner);
                    }
                });
            }

            if (signal?.aborted) throw this.abortReason(signal);

            const ambient: Connection | undefined = currentTransaction();

            if (
                ambient !== undefined &&
                !(ambient instanceof Database) &&
                ambient.options?.url === connection.options?.url
            ) {
                const task = (): Promise<T> =>
                    signal ? this.raceAbort(() => callback(), signal) : callback();

                try {
                    return await (ambient as Bun.TransactionSQL).savepoint(async () =>
                        withinTransaction(ambient, () => task())
                    );
                } catch (error: any) {
                    throw translateQueryError(error, "SAVEPOINT", []);
                }
            }

            const draining: Promise<T> = connection.begin(async (sql: any) => {
                const stamp: string | undefined = readStampedDriver(connection);

                if (stamp) stampDriver(sql, stamp);

                stampBigIntAsNumber(sql, readBigIntAsNumber(connection));

                return withinTransaction(sql, () =>
                    signal ? this.raceAbort(() => callback(), signal) : callback()
                );
            });

            this.trackDrain(draining);

            return await draining;
        } finally {
            inFlightTransactionTasks--;
        }
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
        return signal?.reason instanceof Error
            ? signal.reason
            : new QueryException("Transaction aborted by signal.");
    }

    private static manualDepth(connection: Database): number {
        return manualDepths.get(connection) || 0;
    }

    private static waitForSlot(
        connection: Database,
        signal?: AbortSignal,
        timeoutMs: number = 0,
        manual: boolean = false
    ): Promise<symbol> {
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

            const onTimeout = (): void =>
                cancel(
                    new QueryException(
                        `Timed out after ${timeoutMs}ms waiting for a free transaction slot.`
                    )
                );

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

    private static async acquireHold(
        connection: Database,
        signal?: AbortSignal,
        timeoutMs: number = 0
    ): Promise<symbol> {
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

    private static trackDrain(current: Promise<unknown>): void {
        const drain: Promise<void> = new Promise<void>((resolve: any) => {
            void current.then(
                () => resolve(),
                () => resolve()
            );
        });

        transactionDrains.add(drain);

        void drain.finally(() => transactionDrains.delete(drain));
    }

    private static enqueueSavepoint<T>(
        connection: Connection,
        depth: number,
        task: () => Promise<T>
    ): Promise<T> {
        let byDepth: Map<number, Promise<unknown>> | undefined =
            savepointTailsByDepth.get(connection);

        if (!byDepth) {
            byDepth = new Map<number, Promise<unknown>>();
            savepointTailsByDepth.set(connection, byDepth);
        }

        const previous: Promise<unknown> = byDepth.get(depth) || Promise.resolve();
        const current: Promise<unknown> = previous
            .then(() => task())
            .finally(() => {
                if (byDepth!.get(depth) === current) byDepth!.delete(depth);

                if (byDepth!.size === 0) savepointTailsByDepth.delete(connection);
            });

        byDepth.set(depth, current);

        this.trackDrain(current);

        return current;
    }

    private static enqueueSerialized<T>(
        connection: Connection,
        tails: WeakMap<Connection, Promise<unknown>>,
        task: () => Promise<T>
    ): Promise<T> {
        const previous: Promise<unknown> = tails.get(connection) || Promise.resolve();
        const current: Promise<unknown> = previous
            .then(() => task())
            .finally(() => {
                if (tails.get(connection) === current) tails.delete(connection);
            });

        tails.set(connection, current);

        this.trackDrain(current);

        return current;
    }

    private static enqueueTransaction<T>(
        connection: Connection,
        task: () => Promise<T>
    ): Promise<T> {
        return this.enqueueSerialized(connection, transactionTails, task);
    }

    private static savepointDepthFor(connection: Database): number {
        return this.manualDepth(connection) + 1;
    }

    private static bumpManualDepth(connection: Database, delta: number): void {
        const next: number = this.manualDepth(connection) + delta;

        if (next <= 0) manualDepths.delete(connection);
        else manualDepths.set(connection, next);
    }

    private static trackAbort(signal?: AbortSignal): AbortTrack {
        if (!signal)
            return {
                aborted: false,
                reason: this.abortReason(signal),
                detach: () => undefined
            };

        if (signal.aborted)
            return {
                aborted: true,
                reason: this.abortReason(signal),
                detach: () => undefined
            };

        let aborted: boolean = false;
        let reason: Error = this.abortReason(signal);

        const onAbort = (): void => {
            aborted = true;
            reason = this.abortReason(signal);
        };

        signal.addEventListener("abort", onAbort, {
            once: true
        });

        return {
            get aborted(): boolean {
                return aborted;
            },
            get reason(): Error {
                return reason;
            },
            detach: (): void => signal.removeEventListener("abort", onAbort)
        };
    }

    private static async sqliteSavepoint<T>(
        connection: Database,
        callback: () => Promise<T>,
        signal?: AbortSignal
    ): Promise<T> {
        const level: number = this.savepointDepthFor(connection);
        const savepoint: string = `trans${level}`;

        this.bumpManualDepth(connection, 1);

        try {
            connection.run(`SAVEPOINT ${savepoint}`);
        } catch (error: any) {
            this.bumpManualDepth(connection, -1);

            throw error;
        }

        const abort: AbortTrack = this.trackAbort(signal);

        try {
            const result: T = await withinTransaction(connection, () => callback());

            if (abort.aborted) throw abort.reason;

            connection.run(`RELEASE SAVEPOINT ${savepoint}`);

            return result;
        } catch (error: any) {
            try {
                connection.run(`ROLLBACK TO SAVEPOINT ${savepoint}`);
            } catch {
                // Savepoint may already be gone (whole transaction failed); ignore.
            }

            try {
                connection.run(`RELEASE SAVEPOINT ${savepoint}`);
            } catch {
                // Ignore release failures after  a rolled-back savepoint.
            }

            throw error;
        } finally {
            abort.detach();

            this.bumpManualDepth(connection, -1);
        }
    }

    private static async sqliteTransaction<T>(
        connection: Database,
        callback: () => Promise<T>,
        signal?: AbortSignal
    ): Promise<T> {
        this.bumpManualDepth(connection, 1);

        try {
            connection.run("BEGIN");
        } catch (error: any) {
            this.bumpManualDepth(connection, -1);

            throw error;
        }

        const abort: AbortTrack = this.trackAbort(signal);

        try {
            const result: T = await withinTransaction(connection, () => callback());

            if (abort.aborted) throw abort.reason;

            connection.run("COMMIT");

            return result;
        } catch (error: any) {
            try {
                connection.run("ROLLBACK");
            } catch {
                // Transaction may already have failed at the driver level; ignore.
            }

            throw error;
        } finally {
            abort.detach();

            this.bumpManualDepth(connection, -1);
        }
    }

    private static raceAbort<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
        return new Promise<T>((resolve: any, reject: any) => {
            let aborted: boolean = false;
            let reason: Error = this.abortReason(signal);

            const onAbort = (): void => {
                aborted = true;
                reason = this.abortReason(signal);
            };

            if (signal.aborted) aborted = true;
            else
                signal.addEventListener("abort", onAbort, {
                    once: true
                });

            Promise.resolve()
                .then(work)
                .then(
                    (value: T): void => {
                        if (!aborted) resolve(value);
                        else reject(reason);
                    },
                    (error: any): void => {
                        if (!aborted) reject(error);
                        else reject(reason);
                    }
                )
                .finally(() => signal.removeEventListener("abort", onAbort));
        });
    }
}
