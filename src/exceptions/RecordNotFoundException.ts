import Logger from "@bejibun/logger";
import {defineValue} from "@bejibun/utils";
import QueryException from "./QueryException";

/** Error thrown for orm configuration and runtime failures. */
export default class RecordNotFoundException extends QueryException {
    /** Numeric status code for the exception. */
    public code: number;

    /**
     * Creates a orm exception.
     *
     * @param {string} message - Error message.
     * @param {number} code - Status code, defaults to 503.
     */
    public constructor(message?: string, code?: number) {
        super(message);
        this.name = "RecordNotFoundException";
        this.code = defineValue(code, 404);

        Logger.setContext(this.name).error(this.message).trace(this.stack);

        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, RecordNotFoundException);
        }
    }
}
