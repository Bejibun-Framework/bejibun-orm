/**
 * Module-level query listener registry.
 *
 * Kept dependency-free so both the DB facade and the grammar can import
 * it without creating an import cycle. `DB.listen()` and the query-log
 * helpers delegate to this module.
 */
import type {QueryListener, QueryLogEntry} from "@/types/query";

/** Registered global listeners. */
const listeners: Array<QueryListener> = [];

/** Whether query logging is enabled. */
let logging: boolean = false;

/** Accumulated query log while logging is enabled. */
let log: Array<QueryLogEntry> = [];

/**
 * Registers a global query listener.
 *
 * @param {QueryListener} listener - The listener.
 * @returns {() => void} An unsubscribe function.
 */
export const onQuery = (listener: QueryListener): (() => void) => {
    listeners.push(listener);

    return () => {
        const index: number = listeners.indexOf(listener);

        if (index !== -1) listeners.splice(index, 1);
    };
};

/**
 * Removes a previously registered query listener.
 *
 * @param {QueryListener} listener - The listener to remove.
 */
export const offQuery = (listener: QueryListener): void => {
    const index: number = listeners.indexOf(listener);

    if (index !== -1) listeners.splice(index, 1);
};

/**
 * Whether recording is active: query logging is enabled or at least one
 * listener is registered. Callers use this to skip building an entry
 * (and timing) entirely when nothing will observe it.
 *
 * @returns {boolean} True when a query should be recorded.
 */
export const shouldRecord = (): boolean => {
    return logging || listeners.length > 0;
};

/**
 * Records a completed query: accumulates it into the log when enabled
 * and notifies every registered listener.
 *
 * @param {QueryLogEntry} entry - The completed query.
 */
export const record = (entry: QueryLogEntry): void => {
    if (!shouldRecord()) return;

    if (logging) log.push(entry);

    for (const listener of [...listeners]) {
        try {
            listener(entry);
        } catch {
            // Listeners must not break query execution.
        }
    }
};

/**
 * Starts accumulating queries into the query log.
 */
export const enableQueryLog = (): void => {
    logging = true;
};

/**
 * Stops accumulating queries into the query log.
 */
export const disableQueryLog = (): void => {
    logging = false;
};

/**
 * Returns the accumulated query log.
 *
 * @returns {Array<QueryLogEntry>} The logged queries.
 */
export const getQueryLog = (): Array<QueryLogEntry> => {
    return [...log];
};

/**
 * Clears the accumulated query log.
 */
export const flushQueryLog = (): void => {
    log = [];
};
