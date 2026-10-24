export interface TransactionOptions {
    signal?: AbortSignal;
    timeout?: number;
}

export interface ManualTransaction {
    readonly active: boolean;
    commit: () => Promise<void>;
    rollback: () => Promise<void>;
    abort: () => Promise<void>;
}

export interface ManualWaiter {
    cancelled: boolean;
    run: () => void;
    fail: (error: Error) => void;
}

export interface ManualHold {
    held: boolean;
    ownerId?: symbol;
    manual?: boolean;
    waiters: Array<ManualWaiter>;
}