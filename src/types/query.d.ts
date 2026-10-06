import QueryBuilder from "@/builders/QueryBuilder";

export interface WhereClause {
    type: "basic" | "in" | "null" | "not-null" | "between" | "nested" | "raw" | "column" | "exists" | "date-part" | "like" | "sub" | "json";
    column?: string;
    operator?: string;
    value?: any;
    boolean?: "and" | "or";
    not?: boolean;
    columns?: Array<string>;
    values?: Array<any>;
    nested?: QueryBuilder;
    sql?: string;
    bindings?: Array<any>;
    second?: string;
    dateFunction?: string;
}

export interface JoinClause {
    type: string;
    table: string;
    first: string;
    operator?: string;
    second?: any;
    boolean?: "and" | "or";
    bindings?: Array<any>;
}

export interface OrderClause {
    column: string;
    direction: "asc" | "desc";
    bindings?: Array<any>;
}

export interface HavingClause {
    sql: string;
    bindings: Array<any>;
}

export interface UnionClause {
    query: QueryBuilder;
    all: boolean;
}

export interface CompiledQuery {
    sql: string;
    bindings: Array<any>;
}

export interface PaginationResult {
    data: Array<Record<string, any>>;
    total: number;
    perPage: number;
    currentPage: number;
    lastPage: number;
    from: number | null;
    to: number | null;
}

export interface SimplePaginationResult {
    data: Array<Record<string, any>>;
    perPage: number;
    currentPage: number;
    lastPage: number;
    from: number | null;
    to: number | null;
    hasMore: boolean;
}

export interface CursorPaginationResult {
    data: Array<Record<string, any>>;
    perPage: number;
    nextCursor: any;
    hasMore: boolean;
}

export interface QueryLogEntry {
    sql: string;
    bindings: Array<any>;
    driver: string;
    duration: number;
    error?: any;
}

export type QueryListener = (entry: QueryLogEntry) => void;