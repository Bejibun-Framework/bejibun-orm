import Logger from "@bejibun/logger";

export default class QueryException extends Error {
    public code: number;
    public sql?: string;
    public bindings?: Array<any>;

    public constructor(message: string, sql?: string, bindings?: Array<any>) {
        super(message);
        this.name = "QueryException";
        this.code = 500;
        this.sql = sql;
        this.bindings = bindings;

        Logger.setContext(this.name).error(this.message).trace(this.stack);

        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, QueryException);
        }
    }
}
