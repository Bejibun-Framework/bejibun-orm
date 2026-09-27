import Logger from "@bejibun/logger";
import {defineValue} from "@bejibun/utils";

/** Error thrown for orm configuration and runtime failures. */
export default class OptimisticLockException extends Error {
    /** Numeric status code for the exception. */
    public code: number;

    public constructor(model: string, id: any) {
        const message = `Model [${model}] (id ${String(id)}) was updated by someone else since it was loaded -- reload the row and retry.`;

        super(message);
        this.name = "OptimisticLockException";
        this.code = defineValue(code, 409);

        Logger.setContext(this.name).error(this.message).trace(this.stack);

        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, OptimisticLockException);
        }
    }
}
