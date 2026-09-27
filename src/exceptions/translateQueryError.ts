import QueryException from "@/exceptions/QueryException";
import UniqueConstraintViolationException from "@/exceptions/UniqueConstraintViolationException";

const UniquePatterns: Array<RegExp> = [
    /UNIQUE constraint failed/i,
    /duplicate key value violates unique constraint/i,
    /duplicate entry/i,
    /unique.*already exists/i
];

const UniqueCodes: Set<string> = new Set<string>(["23505", "1062", "1555", "2067"]);

const isUniqueViolation = (error: any): boolean => {
    if (typeof error?.code === "string" && UniqueCodes.has(error.code)) return true;

    const message: string = error?.message || String(error);

    return UniquePatterns.some((pattern: RegExp) => pattern.test(message));
};

export const translateQueryError = (error: any, sql?: string, bindings?: Array<any>): QueryException => {
    if (error instanceof QueryException) return error;

    const message: string = error?.message || String(error);

    if (isUniqueViolation(error)) {
        const exception: QueryException = new UniqueConstraintViolationException(message, sql, bindings);

        (exception as any).cause = error;

        return exception;
    }

    const exception: QueryException = new QueryException(message, sql, bindings);

    (exception as any).cause = error;

    return exception;
}