import type {Connection} from "@/types/context";
import ConnectionBuilder from "@/builders/ConnectionBuilder";
import {currentTransaction} from "@/contexts/TransactionContext";

let builder: ConnectionBuilder | null = null;

const transactionTails: WeakMap<Connection, Promise<unknown>> = new WeakMap<
    Connection,
    Promise<unknown>
>();

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

    private static effectiveTransactionTimeout(): number {
        if (this.runtimeDefaultTimeoutSet) return this.defaultTransactionTimeoutMs;

        return ConnectionBuilder.getTransactionTimeout();
    }
}
