import Logger from "@bejibun/logger";
import QueryException from "@/exceptions/QueryException";

export default class UniqueConstraintViolationException extends QueryException {
    public constructor(message: string, sql?: string, bindings?: Array<any>) {
        super(message, sql, bindings);
        this.name = "UniqueConstraintViolationException";

        Logger.setContext(this.name).error(this.message).trace(this.stack);

        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, UniqueConstraintViolationException);
        }
    }
}
