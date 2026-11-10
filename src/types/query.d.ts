import QueryBuilder from "@/builders/QueryBuilder";
import Raw from "@/builders/Raw";

/** Logical connector between SQL conditions. */
export type BooleanOperator = "and" | "or";

/** Supported JOIN clause types. */
export type JoinType = "inner" | "left" | "right" | "cross" | "raw";

/** Supported ORDER BY directions. */
export type OrderDirection = "asc" | "desc";

/** Supported aggregate operations, including correlated existence checks. */
export type AggregateType = "count" | "sum" | "max" | "min" | "avg" | "exists";

/** A single WHERE clause operand. */
export interface WhereClause {
    type:
        | "basic"
        | "in"
        | "null"
        | "not-null"
        | "between"
        | "nested"
        | "raw"
        | "column"
        | "exists"
        | "date-part"
        | "like"
        | "sub"
        | "json";
    column?: string;
    operator?: string;
    value?: any;
    boolean?: BooleanOperator;
    not?: boolean;
    columns?: Array<string>;
    values?: Array<any>;
    nested?: QueryBuilder;
    sql?: string;
    bindings?: Array<any>;
    second?: string;
    dateFunction?: string;
}

/** A JOIN definition. */
export interface JoinClause {
    type: JoinType;
    table: string;
    first: string;
    operator?: string;
    second?: any;
    boolean?: BooleanOperator;
    bindings?: Array<any>;
}

/** A flattened ORDER BY entry. */
export interface OrderClause {
    column: string;
    direction: OrderDirection;
    bindings?: Array<any>;
}

/** A HAVING clause fragment. */
export interface HavingClause {
    sql: string;
    bindings: Array<any>;
}

/** A UNION / UNION ALL clause. */
export interface UnionClause {
    query: QueryBuilder;
    all: boolean;
}

/** A compiled SQL fragment and its associated bindings. */
export interface CompiledQuery {
    sql: string;
    bindings: Array<any>;
}

/** Standard pagination result. */
export interface PaginationResult {
    data: Array<Record<string, any>>;
    total: number;
    perPage: number;
    currentPage: number;
    lastPage: number;
    from: number | null;
    to: number | null;
}

/** Simple pagination result (no total query). */
export interface SimplePaginationResult {
    data: Array<Record<string, any>>;
    perPage: number;
    currentPage: number;
    lastPage: number;
    from: number | null;
    to: number | null;
    hasMore: boolean;
}

/** Cursor-based pagination result. */
export interface CursorPaginationResult {
    data: Array<Record<string, any>>;
    perPage: number;
    nextCursor: any;
    hasMore: boolean;
}

/** A single executed query. */
export interface QueryLogEntry {
    /** The executed SQL statement. */
    sql: string;

    /** The bound parameter values. */
    bindings: Array<any>;

    /** The driver the statement ran against (`pg`, `mysql`, `sqlite`). */
    driver: string;

    /** Execution duration in milliseconds. */
    duration: number;

    /** The error when the statement threw. */
    error?: any;
}

/** Listener invoked after every executed statement. */
export type QueryListener = (entry: QueryLogEntry) => void;

/** Callback that configures and returns a query builder. */
export type QueryBuilderCallback = (builder: QueryBuilder) => QueryBuilder;

/** Accepted values and subqueries for IN and NOT IN clauses. */
export type WhereInValues = Array<any> | QueryBuilder | QueryBuilderCallback | Raw;
