/**
 * Re-exports the orm exception classes.
 */
export {default as ConnectionException} from "@/exceptions/ConnectionException";

export {default as OptimisticLockException} from "@/exceptions/OptimisticLockException";

export {default as QueryException} from "@/exceptions/QueryException";

export {default as RecordNotFoundException} from "@/exceptions/RecordNotFoundException";

export {default as UniqueConstraintViolationException} from "@/exceptions/UniqueConstraintViolationException";

export {translateQueryError} from "@/exceptions/translateQueryError";
