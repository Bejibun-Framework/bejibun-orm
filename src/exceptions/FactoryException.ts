import Logger from "@bejibun/logger";
import {defineValue} from "@bejibun/utils";

export default class FactoryException extends Error {
    /** Numeric status code for the exception. */
    public code: number;

    public constructor(message?: string, code?: number) {
        super(message);
        this.name = "FactoryException";
        this.code = defineValue(code, 500);

        Logger.setContext(this.name).error(this.message).trace(this.stack);

        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, FactoryException);
        }
    }
}
