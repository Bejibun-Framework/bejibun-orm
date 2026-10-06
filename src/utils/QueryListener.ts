import type {QueryListener, QueryLogEntry} from "@/types/query";

const listeners: Array<QueryListener> = [];

let logging: boolean = false;
let log: Array<QueryLogEntry> = [];

export const onQuery = (listener: QueryListener): () => void => {
    listeners.push(listener);

    return () => {
        const index: number = listeners.indexOf(listener);

        if (index !== -1) listeners.splice(index, 1);
    };
};

export const offQuery = (listener: QueryListener): void => {
    const index: number = listeners.indexOf(listener);

    if (index !== -1) listeners.splice(index, 1);
};

export const shouldRecord = (): boolean => {
    return logging || listeners.length > 0;
};

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

export const enableQueryLog = (): void => {
    logging = true;
};

export const disableQueryLog = (): void => {
    logging = false;
};

export const getQueryLog = (): Array<QueryLogEntry> => {
    return [...log];
};

export const flushQueryLog = (): void => {
    log = [];
};