import type {Database} from "bun:sqlite";
import type {EagerLoadSpec} from "@/types/model";
import type {
    AggregateType,
    BooleanOperator,
    CompiledQuery,
    CursorPaginationResult,
    HavingClause,
    JoinClause,
    JoinType,
    OrderClause,
    OrderDirection,
    PaginationResult,
    QueryBuilderCallback,
    SimplePaginationResult,
    UnionClause,
    WhereClause,
    WhereInValues
} from "@/types/query";
import Logger from "@bejibun/logger";
import {isNotEmpty} from "@bejibun/utils/utils/utils";
import Collection from "@/bases/Collection";
import Grammar from "@/builders/Grammar";
import Raw from "@/builders/Raw";
import {currentTransaction} from "@/contexts/TransactionContext";
import DatabaseDriverEnum from "@/enums/DatabaseDriverEnum";
import QueryException from "@/exceptions/QueryException";
import RecordNotFoundException from "@/exceptions/RecordNotFoundException";
import RelationException from "@/exceptions/RelationException";
import DB from "@/facades/DB";

/**
 * Fluent SQL query builder backed by Bun's native database drivers.
 *
 * Builds a parameterized statement incrementally (columns, wheres,
 * joins, groups, havings, orders, limits) and executes lazily against
 * the current connection pool. Writes return driver-appropriate
 * metadata (insert id / row counts), reads return plain rows.
 */
export default class QueryBuilder {
    /** The connection grammar / driver used for this builder. */
    public readonly grammar: Grammar;

    /** The model class whose rows this builder materializes (set by Model). */
    public _modelClass?: any;

    /** The table being queried. */
    protected fromTable: string | null = null;

    /** Selected columns; empty means `*`. */
    protected columns: Array<string> = [];

    /** Distinct flag. */
    protected distinct: boolean = false;

    /** Accumulated WHERE clauses. */
    protected wheres: Array<WhereClause> = [];

    /** Accumulated JOIN clauses. */
    protected joins: Array<JoinClause> = [];

    /** GROUP BY columns. */
    protected groups: Array<string> = [];

    /** Bindings for raw GROUP BY fragments. */
    protected _groupBindings: Array<any> = [];

    /** HAVING statements. */
    protected havings: Array<HavingClause> = [];

    /** ORDER BY definitions. */
    protected orders: Array<OrderClause> = [];

    /** LIMIT value. */
    protected limitCount: number | null = null;

    /** OFFSET value. */
    protected offsetCount: number | null = null;

    /** Row lock mode: `true`/`false` or a raw SQL keyword. */
    protected lockMode: boolean | string | null = null;

    /** UNION / UNION ALL subqueries. */
    protected _unions: Array<UnionClause> = [];

    /** Resolves a relation name to a Relation instance (set by Model.query()). */
    protected _relationResolver?: (name: string) => any;

    /** Pending eager loads registered via `with(...)`. */
    protected _eagerLoads: Array<EagerLoadSpec> = [];

    /** Bindings for a subquery FROM clause. */
    protected _fromBindings: Array<any> = [];

    /** Bindings for raw SELECT expressions. */
    protected _selectBindings: Array<any> = [];

    /** Aliases of correlated aggregate subqueries added via addAggregate. */
    protected _withAggregateAliases: Array<string> = [];

    /** Memoized SELECT compilation, keyed by a structural signature. */
    private _compileCache?: {
        signature: string;
        result: CompiledQuery;
    };

    /**
     * Creates a new query builder bound to a table and connection.
     *
     * @param {string} table - The table to query (optional, settable later via `from`).
     * @param {any} connection - The database connection (or an object carrying a grammar).
     */
    public constructor(table?: string, connection?: any) {
        // Subquery call-sites (fromSubquery:292, selectSub/a:390, whereIn:561/565,
        // countSub/b:789/1076/1619/1754 - carrier `{ grammar: this.grammar }`)
        // pass a LIVE-CAPABILITY-LESS `{ grammar }` carrier as `connection`, so
        // `new Grammar(connection)` could never read a mysql WeakMap stamp and
        // fell back to the pg default ("users" double-quote + $1 placeholders +
        // `connection.unsafe is not a function`). A live facade connection
        // (`.unsafe` exists) is stamped mysql -> `new Grammar(connection)` is the
        // exact MigrationRunner-green path. So: live -> new Grammar(stamp), bare
        // `{ grammar }` carrier (no `.unsafe`) -> re-use `connection.grammar`,
        // which IS this facade's already-correct mysql grammar. One line unifies
        // the green MigrationRunner pattern with every subquery carrier site.
        // (Resolve live-capability up front so the ternary below is deterministic.)

        // Future deferral marker (kept in sync with MigrationRunner:39 lazy-facade)

        this.fromTable = table || null;

        // Skip a possibly-cached `.grammar` on the connection/facade object:
        // the lazy-facade call-sites (Model/MigrationRunner) deliberately pass
        // a facade connection whose WeakMap stamp carries the ACTIVE driver
        // Always build the Grammar fresh so `detectDriver` re-reads the
        // driver stamp (mysql -> backtick/`?`/AUTO_INCREMENT) instead of
        // trusting a stale pg-cached grammar -- the exact pattern that keeps
        // MigrationRunner emitting correct mysql SQL & the single reason Model
        // inserts were still `RETURNING "$1"` on a live mysql facade.
        //
        // Dialect mocks (`{ options: { url } }`, e.g. parity/grammar tests)
        // or real native handles (live pools with `.unsafe`, `bun:sqlite`
        // `Database`) carry their own driver signal and are kept verbatim.
        // Only an undefined/unrecognized connection resolves against the live
        // facade so a stale pg-default never reaches the grammar.
        const keep: boolean =
            (connection !== undefined &&
                connection !== null &&
                (connection as any)?.unsafe !== undefined) ||
            connection instanceof Database ||
            ((connection as any)?.options !== undefined && !(connection as any)?.unsafe);
        const resolved: any = keep ? connection : (DB.connection?.() ?? connection);

        this.grammar = new Grammar(resolved);
    }

    /**
     * Sets the FROM clause to a subquery.
     *
     * @param {QueryBuilder | QueryBuilderCallback} query - A QueryBuilder or a closure building one.
     * @param {string} alias - The subquery alias.
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public fromSub(query: QueryBuilder | QueryBuilderCallback, alias: string): QueryBuilder {
        const sub: QueryBuilder =
            query instanceof QueryBuilder
                ? query
                : (() => {
                      const q: QueryBuilder = new QueryBuilder(undefined, {
                          grammar: this.grammar
                      });

                      query(q);

                      return q;
                  })();

        const compiled: CompiledQuery = sub.compileSelect();

        this.fromTable = `(${compiled.sql}) AS ${this.grammar.quote(alias)}`;
        this._fromBindings = compiled.bindings;

        return this;
    }

    /**
     * Sets the table this builder queries. Accepts a table name, a
     * subquery closure (`from(closure, alias)`), or a `QueryBuilder`.
     *
     * @param {string | QueryBuilder | QueryBuilderCallback} table - Table name or subquery closure.
     * @param {string} [alias] - Alias when a subquery is provided.
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public from(table: string | QueryBuilder | QueryBuilderCallback, alias?: string): QueryBuilder {
        if (typeof table === "function" || table instanceof QueryBuilder)
            return this.fromSub(table, alias || "sub");

        this.fromTable = table;
        this._fromBindings = [];

        this.invalidateCompileCache();

        return this;
    }

    /**
     * Alias of `from()`.
     *
     * @param {string} table - The table name.
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public table(table: string): QueryBuilder {
        return this.from(table);
    }

    /**
     * Sets the columns to select. Accepts variadic columns, an array, or
     * `Raw` expressions.
     *
     * @param {Array<string | Array<string> | Raw>} columns - Columns or raw expressions.
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public select(...columns: Array<string | Array<string> | Raw>): QueryBuilder {
        this.columns = [];
        this._selectBindings = [];

        for (const column of columns.flat() as Array<string | Raw>) {
            if (column instanceof Raw) {
                this.columns.push(column.sql);
                this._selectBindings.push(...column.bindings);
            } else {
                this.columns.push(column);
            }
        }

        return this;
    }

    /**
     * Adds more columns without replacing the current selection.
     *
     * @param {Array<string | Array<string> | Raw>} columns - Columns to append.
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public addSelect(...columns: Array<string | Array<string> | Raw>): QueryBuilder {
        for (const column of columns.flat() as Array<string | Raw>) {
            if (column instanceof Raw) {
                this.columns.push(column.sql);
                this._selectBindings.push(...column.bindings);
            } else {
                this.columns.push(column);
            }
        }

        return this;
    }

    /**
     * Adds a raw SQL expression to the selected columns.
     *
     * @param {string} expression - The raw expression, e.g. `COUNT(*) as cnt`.
     * @param {Array<any>} [bindings] - Bound values.
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public selectRaw(expression: string, bindings: Array<any> = []): QueryBuilder {
        this.columns.push(expression);
        this._selectBindings.push(...bindings);

        return this;
    }

    /**
     * Selects a subquery as a column.
     *
     * @param {QueryBuilder} query - The subquery.
     * @param {string} as - The alias.
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public selectSub(query: QueryBuilder, as: string): QueryBuilder {
        const compiled: CompiledQuery = query.compileSelect();
        const sql: string = `(${compiled.sql}) AS ${this.grammar.quote(as)}`;

        this.columns.push(sql);
        this._selectBindings.push(...compiled.bindings);

        return this;
    }

    /**
     * Marks the query as distinct.
     *
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public distinctQuery(): QueryBuilder {
        this.distinct = true;

        return this;
    }

    /**
     * Adds a WHERE NULL clause.
     *
     * @param {string | Array<string>} columns - Column(s) to test.
     * @param {BooleanOperator} [boolean] - `and` or `or`.
     * @param {boolean} [not] - Whether it's NOT NULL.
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public whereNull(
        columns: string | Array<string>,
        boolean: BooleanOperator = "and",
        not: boolean = false
    ): QueryBuilder {
        const list: Array<string> = Array.isArray(columns) ? columns : [columns];

        for (const column of list) {
            this.wheres.push({
                type: not ? "not-null" : "null",
                column,
                boolean
            });
        }

        return this;
    }

    /**
     * Adds a WHERE NOT NULL clause.
     *
     * @param {string | Array<string>} columns - Column(s) to test.
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public whereNotNull(columns: string | Array<string>): QueryBuilder {
        return this.whereNull(columns, "and", true);
    }

    /**
     * Adds a WHERE ... OR IS NULL clause.
     *
     * @param {string | Array<string>} columns - Column(s) to test.
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public orWhereNull(columns: string | Array<string>): QueryBuilder {
        return this.whereNull(columns, "or");
    }

    /**
     * Adds a WHERE ... OR IS NOT NULL clause.
     *
     * @param {string | Array<string>} columns - Column(s) to test.
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public orWhereNotNull(columns: string | Array<string>): QueryBuilder {
        return this.whereNull(columns, "or", true);
    }

    /**
     * Adds a `WHERE column IN (subquery)` clause.
     *
     * @param {string} column - The column.
     * @param {QueryBuilder | Raw | QueryBuilderCallback} query - A QueryBuilder, Raw expression, or closure.
     * @param {BooleanOperator} [boolean] - `and` or `or`.
     * @param {boolean} [not] - Whether it's `NOT IN`.
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public whereSub(
        column: string,
        query: QueryBuilder | Raw | QueryBuilderCallback,
        boolean: BooleanOperator = "and",
        not: boolean = false
    ): QueryBuilder {
        let sub: QueryBuilder;

        if (query instanceof QueryBuilder) {
            sub = query;
        } else if (query instanceof Raw) {
            sub = new QueryBuilder(undefined, {
                grammar: this.grammar
            });
            sub.fromTable = query.sql;
            sub._fromBindings = query.bindings;
        } else {
            sub = new QueryBuilder(undefined, {
                grammar: this.grammar
            });
            query(sub);
        }

        this.wheres.push({
            type: "sub",
            column,
            nested: sub,
            boolean,
            not
        });

        return this;
    }

    /**
     * Adds a `WHERE column NOT IN (subquery)` clause.
     *
     * @param {string} column - The column.
     * @param {QueryBuilder | Raw | QueryBuilderCallback} query - A QueryBuilder, Raw expression, or closure.
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public whereNotSub(
        column: string,
        query: QueryBuilder | Raw | QueryBuilderCallback
    ): QueryBuilder {
        return this.whereSub(column, query, "and", true);
    }

    /**
     * Adds a raw WHERE segment with optional bindings.
     *
     * @param {string} sql - The raw SQL fragment.
     * @param {Array<any>} [bindings] - Bound values.
     * @param {BooleanOperator} [boolean] - `and` or `or`.
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public whereRaw(
        sql: string,
        bindings: Array<any> = [],
        boolean: BooleanOperator = "and"
    ): QueryBuilder {
        this.wheres.push({
            type: "raw",
            sql,
            bindings,
            boolean
        });

        return this;
    }

    /**
     * Adds a raw WHERE ... OR segment with optional bindings.
     *
     * @param {string} sql - The raw SQL fragment.
     * @param {Array<any>} [bindings] - Bound values.
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public orWhereRaw(sql: string, bindings: Array<any> = []): QueryBuilder {
        return this.whereRaw(sql, bindings, "or");
    }

    /**
     * Adds a WHERE IN clause.
     *
     * @param {string} column - The column.
     * @param {WhereInValues} values - The allowed values; a `QueryBuilder`, `Raw`, or closure
     *   (subquery) is also accepted. Empty arrays compile to `0 = 1`
     *   (`NOT IN` → `1 = 1`).
     * @param {BooleanOperator} [boolean] - `and` or `or`.
     * @param {boolean} [not] - Whether it's NOT IN.
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public whereIn(
        column: string,
        values: WhereInValues,
        boolean: BooleanOperator = "and",
        not: boolean = false
    ): QueryBuilder {
        if (values instanceof QueryBuilder || values instanceof Raw || typeof values === "function")
            return this.whereSub(column, values as any, boolean, not);

        if ((values as Array<any>).length === 0)
            return this.whereRaw(not ? "1 = 1" : "0 = 1", [], boolean);

        this.wheres.push({
            type: "in",
            column,
            values: values || [],
            boolean,
            not
        });

        return this;
    }

    /**
     * Adds a WHERE NOT IN clause.
     *
     * @param {string} column - The column.
     * @param {WhereInValues} values - The forbidden values.
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public whereNotIn(column: string, values: WhereInValues): QueryBuilder {
        return this.whereIn(column, values, "and", true);
    }

    /**
     * Adds a WHERE ... OR IN clause.
     *
     * @param {string} column - The column.
     * @param {WhereInValues} values - The allowed values.
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public orWhereIn(column: string, values: WhereInValues): QueryBuilder {
        return this.whereIn(column, values, "or");
    }

    /**
     * Adds a WHERE ... OR NOT IN clause.
     *
     * @param {string} column - The column.
     * @param {WhereInValues} values - The forbidden values.
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public orWhereNotIn(column: string, values: WhereInValues): QueryBuilder {
        return this.whereIn(column, values, "or", true);
    }

    /**
     * Adds a basic WHERE clause.
     *
     * Supports `where("col", value)`, `where("col", ">", value)`,
     * `where({col: value})`, and `where(closure)` for nested groups.
     *
     * @param {any} column - Column name, operator/value pair, object, or callback.
     * @param {any} [operator] - Comparison operator or value.
     * @param {any} [value] - The comparison value.
     * @param {BooleanOperator} [boolean] - `and` or `or`.
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public where(
        column: any,
        operator?: any,
        value?: any,
        boolean: BooleanOperator = "and"
    ): QueryBuilder {
        if (typeof column === "function") return this.whereNested(column, boolean);

        if (
            typeof column === "object" &&
            column !== null &&
            !(column instanceof Raw) &&
            !(column instanceof QueryBuilder)
        ) {
            for (const [key, val] of Object.entries(column)) this.where(key, "=", val, boolean);

            return this;
        }

        if (arguments.length === 2) {
            value = operator;
            operator = "=";
        }

        if (value === null) {
            if (operator === "=" || operator === "==") return this.whereNull(column, boolean);

            if (operator === "!=" || operator === "<>")
                return this.whereNull(column, boolean, true);
        }

        if (value instanceof QueryBuilder) return this.whereSub(column, value, boolean);

        if (value instanceof Raw)
            return this.whereRaw(
                `${this.grammar.quote(column)} ${operator} ${value.sql}`,
                value.bindings,
                boolean
            );

        if (typeof operator === "string" && /^\s*(not\s+)?in\s*$/i.test(operator))
            return this.whereIn(
                column,
                Array.isArray(value) ? value : [value],
                boolean,
                /^not/i.test(operator)
            );

        this.wheres.push({
            type: "basic",
            column,
            operator,
            value,
            boolean
        });

        return this;
    }

    /**
     * Adds a WHERE ... OR clause.
     *
     * @param {any} column - Column, object, or callback.
     * @param {any} [operator] - Operator or value.
     * @param {any} [value] - The value.
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public orWhere(column: any, operator?: any, value?: any): QueryBuilder {
        if (value === undefined && operator !== undefined) {
            value = operator;
            operator = "=";
        }

        return this.where(column, operator, value, "or");
    }

    /**
     * Adds a WHERE BETWEEN clause.
     *
     * @param {string} column - The column.
     * @param {any} min - Lower bound.
     * @param {any} max - Upper bound.
     * @param {BooleanOperator} [boolean] - `and` or `or`.
     * @param {boolean} [not] - Whether it's NOT BETWEEN.
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public whereBetween(
        column: string,
        min: any,
        max: any,
        boolean: BooleanOperator = "and",
        not: boolean = false
    ): QueryBuilder {
        this.wheres.push({
            type: "between",
            column,
            values: [min, max],
            boolean,
            not
        });

        return this;
    }

    /**
     * Adds a WHERE NOT BETWEEN clause.
     *
     * @param {string} column - The column.
     * @param {any} min - Lower bound.
     * @param {any} max - Upper bound.
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public whereNotBetween(column: string, min: any, max: any): QueryBuilder {
        return this.whereBetween(column, min, max, "and", true);
    }

    /**
     * Adds a WHERE ... OR BETWEEN clause.
     *
     * @param {string} column - The column.
     * @param {any} min - Lower bound.
     * @param {any} max - Upper bound.
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public orWhereBetween(column: string, min: any, max: any): QueryBuilder {
        return this.whereBetween(column, min, max, "or");
    }

    /**
     * Adds a WHERE ... OR NOT BETWEEN clause.
     *
     * @param {string} column - The column.
     * @param {any} min - Lower bound.
     * @param {any} max - Upper bound.
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public orWhereNotBetween(column: string, min: any, max: any): QueryBuilder {
        return this.whereBetween(column, min, max, "or", true);
    }

    /**
     * Compares two columns.
     *
     * @param {string} first - The first column.
     * @param {string} [operator] - Comparison operator.
     * @param {string} [second] - The second column.
     * @param {BooleanOperator} [boolean] - `and` or `or`.
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public whereColumn(
        first: string,
        operator?: string,
        second?: string,
        boolean: BooleanOperator = "and"
    ): QueryBuilder {
        if (arguments.length === 2) {
            second = operator;
            operator = "=";
        }

        this.wheres.push({
            type: "column",
            column: first,
            operator,
            second,
            boolean
        });

        return this;
    }

    /**
     * Adds a WHERE ... OR COLUMN clause.
     *
     * @param {string} first - The first column.
     * @param {string} [operator] - Comparison operator.
     * @param {string} [second] - The second column.
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public orWhereColumn(first: string, operator?: string, second?: string): QueryBuilder {
        return this.whereColumn(first, operator, second, "or");
    }

    /**
     * Filters by the DATE portion of a column.
     *
     * @param {string} column - The column.
     * @param {any} operator - Operator or value.
     * @param {any} [value] - The value.
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public whereDate(column: string, operator: any, value?: any): QueryBuilder {
        return this.whereDatePart(column, "DATE", operator, value);
    }

    /**
     * Adds a DATE-portion clause (OR variant).
     *
     * @param {string} column - The column.
     * @param {any} operator - Operator or value.
     * @param {any} [value] - The value.
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public orWhereDate(column: string, operator: any, value?: any): QueryBuilder {
        return this.whereDatePart(column, "DATE", operator, value, "or");
    }

    /**
     * Filters by the DAY portion of a column.
     *
     * @param {string} column - The column.
     * @param {any} operator - Operator or value.
     * @param {any} [value] - The value.
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public whereDay(column: string, operator: any, value?: any): QueryBuilder {
        return this.whereDatePart(column, "DAY", operator, value);
    }

    /**
     * Adds a DAY-portion clause (OR variant).
     *
     * @param {string} column - The column.
     * @param {any} operator - Operator or value.
     * @param {any} [value] - The value.
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public orWhereDay(column: string, operator: any, value?: any): QueryBuilder {
        return this.whereDatePart(column, "DAY", operator, value, "or");
    }

    /**
     * Filters by the MONTH portion of a column.
     *
     * @param {string} column - The column.
     * @param {any} operator - Operator or value.
     * @param {any} [value] - The value.
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public whereMonth(column: string, operator: any, value?: any): QueryBuilder {
        return this.whereDatePart(column, "MONTH", operator, value);
    }

    /**
     * Adds a MONTH-portion clause (OR variant).
     *
     * @param {string} column - The column.
     * @param {any} operator - Operator or value.
     * @param {any} [value] - The value.
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public orWhereMonth(column: string, operator: any, value?: any): QueryBuilder {
        return this.whereDatePart(column, "MONTH", operator, value, "or");
    }

    /**
     * Filters by the YEAR portion of a column.
     *
     * @param {string} column - The column.
     * @param {any} operator - Operator or value.
     * @param {any} [value] - The value.
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public whereYear(column: string, operator: any, value?: any): QueryBuilder {
        return this.whereDatePart(column, "YEAR", operator, value);
    }

    /**
     * Adds a YEAR-portion clause (OR variant).
     *
     * @param {string} column - The column.
     * @param {any} operator - Operator or value.
     * @param {any} [value] - The value.
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public orWhereYear(column: string, operator: any, value?: any): QueryBuilder {
        return this.whereDatePart(column, "YEAR", operator, value, "or");
    }

    /**
     * Filters by the TIME portion of a column.
     *
     * @param {string} column - The column.
     * @param {any} operator - Operator or value.
     * @param {any} [value] - The value.
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public whereTime(column: string, operator: any, value?: any): QueryBuilder {
        return this.whereDatePart(column, "TIME", operator, value);
    }

    /**
     * Adds a TIME-portion clause (OR variant).
     *
     * @param {string} column - The column.
     * @param {any} operator - Operator or value.
     * @param {any} [value] - The value.
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public orWhereTime(column: string, operator: any, value?: any): QueryBuilder {
        return this.whereDatePart(column, "TIME", operator, value, "or");
    }

    /**
     * Adds a WHERE EXISTS subquery clause.
     *
     * @param {QueryBuilderCallback} callback - Receives a child builder to build the subquery.
     * @param {boolean} [not] - Whether it's WHERE NOT EXISTS.
     * @param {BooleanOperator} [boolean] - `and` or `or`.
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public whereExists(
        callback: QueryBuilderCallback,
        not: boolean = false,
        boolean: BooleanOperator = "and"
    ): QueryBuilder {
        const child: QueryBuilder = new QueryBuilder(undefined, {
            grammar: this.grammar
        });

        callback(child);

        this.wheres.push({
            type: "exists",
            nested: child,
            not,
            boolean
        });

        return this;
    }

    /**
     * Adds a WHERE NOT EXISTS subquery clause.
     *
     * @param {QueryBuilderCallback} callback - Receives a child builder.
     * @param {BooleanOperator} [boolean] - `and` or `or`.
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public whereNotExists(
        callback: QueryBuilderCallback,
        boolean: BooleanOperator = "and"
    ): QueryBuilder {
        return this.whereExists(callback, true, boolean);
    }

    /**
     * Applies a callback conditionally.
     *
     * @param {any} condition - The condition to evaluate.
     * @param {QueryBuilderCallback} callback - Applied when condition is truthy.
     * @param {QueryBuilderCallback} [fallback] - Applied when condition is falsy.
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public when(
        condition: any,
        callback: QueryBuilderCallback,
        fallback?: QueryBuilderCallback
    ): QueryBuilder {
        if (condition) return callback(this);

        if (fallback) return fallback(this);

        return this;
    }

    /**
     * Applies a callback unless condition is truthy.
     *
     * @param {any} condition - The condition to evaluate.
     * @param {QueryBuilderCallback} callback - Applied when condition is falsy.
     * @param {QueryBuilderCallback} [fallback] - Applied when condition is truthy.
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public unless(
        condition: any,
        callback: QueryBuilderCallback,
        fallback?: QueryBuilderCallback
    ): QueryBuilder {
        if (!condition) return callback(this);

        if (fallback) return fallback(this);

        return this;
    }

    /**
     * Sets the relation resolver used by the `has`/`whereHas` family.
     *
     * @param {(name: string) => any} resolver - A function mapping a relation name to a Relation.
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public setRelationResolver(resolver: (name: string) => any): QueryBuilder {
        this._relationResolver = resolver;

        return this;
    }

    /**
     * Adds a WHERE EXISTS subquery asserting the relation has ≥1 matching row.
     * The `operator`/`count` threshold applies to has-many/through/morph
     * relations; for `belongsTo` the count constraint is skipped and the
     * clause degrades to a plain EXISTS.
     *
     * @param {string} relation - Relation name.
     * @param {string} [operator] - Comparison operator (`>=`).
     * @param {number} [count] - Threshold count (`1`).
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public has(relation: string, operator: string = ">=", count: number = 1): QueryBuilder {
        this.relationExists(relation, false, "and", undefined, operator, count);

        return this;
    }

    /**
     * Adds a WHERE ... OR EXISTS relation clause.
     *
     * @param {string} relation - Relation name.
     * @param {string} [operator] - Comparison operator (`>=`).
     * @param {number} [count] - Threshold count (`1`).
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public orHas(relation: string, operator: string = ">=", count: number = 1): QueryBuilder {
        this.relationExists(relation, false, "or", undefined, operator, count);

        return this;
    }

    /**
     * Adds a WHERE EXISTS subquery for a relation with optional extra
     * constraints applied to the relation's query.
     *
     * @param {string} relation - Relation name.
     * @param {QueryBuilderCallback} [callback] - Receives the relation sub-query builder.
     * @param {string} [operator] - Comparison operator (`>=`).
     * @param {number} [count] - Threshold count (`1`).
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public whereHas(
        relation: string,
        callback?: QueryBuilderCallback,
        operator: string = ">=",
        count: number = 1
    ): QueryBuilder {
        this.relationExists(relation, false, "and", callback, operator, count);

        return this;
    }

    /**
     * Adds a WHERE ... OR EXISTS subquery for a relation with optional
     * constraints.
     *
     * @param {string} relation - Relation name.
     * @param {QueryBuilderCallback} [callback] - Receives the relation sub-query builder.
     * @param {string} [operator] - Comparison operator (`>=`).
     * @param {number} [count] - Threshold count (`1`).
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public orWhereHas(
        relation: string,
        callback?: QueryBuilderCallback,
        operator: string = ">=",
        count: number = 1
    ): QueryBuilder {
        this.relationExists(relation, false, "or", callback, operator, count);

        return this;
    }

    /**
     * Adds a WHERE NOT EXISTS subquery asserting the relation has NO
     * matching rows.
     *
     * @param {string} relation - Relation name.
     * @param {string} [operator] - Comparison operator (`>=`).
     * @param {number} [count] - Threshold count (`1`).
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public doesntHave(relation: string, operator: string = ">=", count: number = 1): QueryBuilder {
        this.relationExists(relation, true, "and", undefined, operator, count);

        return this;
    }

    /**
     * Adds a WHERE ... OR NOT EXISTS relation clause.
     *
     * @param {string} relation - Relation name.
     * @param {string} [operator] - Comparison operator (`>=`).
     * @param {number} [count] - Threshold count (`1`).
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public orDoesntHave(
        relation: string,
        operator: string = ">=",
        count: number = 1
    ): QueryBuilder {
        this.relationExists(relation, true, "or", undefined, operator, count);

        return this;
    }

    /**
     * Adds a WHERE NOT EXISTS subquery for a relation with optional
     * constraints.
     *
     * @param {string} relation - Relation name.
     * @param {QueryBuilderCallback} [callback] - Receives the relation sub-query builder.
     * @param {string} [operator] - Comparison operator (`>=`).
     * @param {number} [count] - Threshold count (`1`).
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public whereDoesntHave(
        relation: string,
        callback?: QueryBuilderCallback,
        operator: string = ">=",
        count: number = 1
    ): QueryBuilder {
        this.relationExists(relation, true, "and", callback, operator, count);

        return this;
    }

    /**
     * Adds a WHERE ... OR NOT EXISTS subquery for a relation with optional
     * constraints.
     *
     * @param {string} relation - Relation name.
     * @param {QueryBuilderCallback} [callback] - Receives the relation sub-query builder.
     * @param {string} [operator] - Comparison operator (`>=`).
     * @param {number} [count] - Threshold count (`1`).
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public orWhereDoesntHave(
        relation: string,
        callback?: QueryBuilderCallback,
        operator: string = ">=",
        count: number = 1
    ): QueryBuilder {
        this.relationExists(relation, true, "or", callback, operator, count);

        return this;
    }

    /**
     * Adds a WHERE constraint on a column inside a relation's table.
     *
     * @param {string} relation - Relation name.
     * @param {string} column - Column in the relation's table.
     * @param {any} [operator] - Comparison operator (or value when `value` omitted).
     * @param {any} [value] - The value.
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public whereRelation(
        relation: string,
        column: string,
        operator?: any,
        value?: any
    ): QueryBuilder {
        return this.whereHas(relation, (builder: QueryBuilder) => {
            if (value === undefined && operator !== undefined)
                return builder.where(column, "=", operator);

            if (operator !== undefined) return builder.where(column, operator, value);

            return builder;
        });
    }

    /**
     * Adds a WHERE ... OR constraint on a column inside a relation's table.
     *
     * @param {string} relation - Relation name.
     * @param {string} column - Column in the relation's table.
     * @param {any} [operator] - Comparison operator (or value when `value` omitted).
     * @param {any} [value] - The value.
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public orWhereRelation(
        relation: string,
        column: string,
        operator?: any,
        value?: any
    ): QueryBuilder {
        return this.orWhereHas(relation, (builder: QueryBuilder) => {
            if (value === undefined && operator !== undefined)
                return builder.where(column, "=", operator);

            if (operator !== undefined) return builder.where(column, operator, value);

            return builder;
        });
    }

    /**
     * Adds a WHERE LIKE clause. Case sensitivity follows the column collation
     * and driver: SQLite matches ASCII case-insensitively and MySQL's default
     * collations are case-insensitive.
     *
     * @param {string} column - The column.
     * @param {string} value - The pattern.
     * @param {BooleanOperator} [boolean] - `and` or `or`.
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public whereLike(
        column: string,
        value: string,
        boolean: BooleanOperator = "and"
    ): QueryBuilder {
        this.wheres.push({
            type: "like",
            column,
            operator: "LIKE",
            value,
            boolean
        });

        return this;
    }

    /**
     * Adds a WHERE ILIKE clause (case-insensitive, PostgreSQL). On MySQL and
     * SQLite the operator silently falls back to plain `LIKE`, making this
     * identical to `whereLike()` there.
     *
     * @param {string} column - The column.
     * @param {string} value - The pattern.
     * @param {BooleanOperator} [boolean] - `and` or `or`.
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public whereILike(
        column: string,
        value: string,
        boolean: BooleanOperator = "and"
    ): QueryBuilder {
        this.wheres.push({
            type: "like",
            column,
            operator: "ILIKE",
            value,
            boolean
        });

        return this;
    }

    /**
     * Adds a JSON containment clause.
     *
     * - object with a single key → path comparison (`{"grade": "A"}`).
     * - array/scalar → containment (`{"tags": ["a"]}` matches a row whose
     *   `tags` array contains `"a"`).
     *
     * Driver-aware: `@>` on PostgreSQL, `JSON_CONTAINS` on MySQL, and
     * `json_each` / `json_extract` on SQLite.
     *
     * @param {string} column - The JSON column.
     * @param {any} value - The value(s) to look for.
     * @param {BooleanOperator} [boolean] - `and` or `or`.
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public whereJsonContains(
        column: string,
        value: any,
        boolean: BooleanOperator = "and"
    ): QueryBuilder {
        const compiled: CompiledQuery = this.compileJsonContains(column, value);

        this.wheres.push({
            type: "json",
            sql: compiled.sql,
            bindings: compiled.bindings,
            boolean
        });

        return this;
    }

    /**
     * Adds a JSON containment clause (OR variant).
     *
     * @param {string} column - The JSON column.
     * @param {any} value - The value(s) to look for.
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public orWhereJsonContains(column: string, value: any): QueryBuilder {
        return this.whereJsonContains(column, value, "or");
    }

    /**
     * Adds a JSON array-length clause, e.g. `whereJsonLength("tags", ">", 2)`.
     *
     * @param {string} column - The JSON column.
     * @param {any} operator - The comparison operator.
     * @param {any} value - The length to compare against.
     * @param {BooleanOperator} [boolean] - `and` or `or`.
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public whereJsonLength(
        column: string,
        operator: any,
        value: any,
        boolean: BooleanOperator = "and"
    ): QueryBuilder {
        const g: Grammar = this.grammar;
        const columnSql: string =
            g.driverName() === DatabaseDriverEnum.Pg
                ? `(${g.quote(column)})::jsonb`
                : g.quote(column);
        const fn: string =
            g.driverName() === DatabaseDriverEnum.Mysql
                ? "JSON_LENGTH"
                : g.driverName() === DatabaseDriverEnum.Pg
                  ? "JSONB_ARRAY_LENGTH"
                  : "JSON_ARRAY_LENGTH";

        this.wheres.push({
            type: "json",
            sql: `${fn}(${columnSql}) ${operator} ?`,
            bindings: [value],
            boolean
        });

        return this;
    }

    /**
     * Adds a JSON array-length clause (OR variant).
     *
     * @param {string} column - The JSON column.
     * @param {any} operator - The comparison operator.
     * @param {any} value - The length to compare against.
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public orWhereJsonLength(column: string, operator: any, value: any): QueryBuilder {
        return this.whereJsonLength(column, operator, value, "or");
    }

    /**
     * Adds a JOIN clause.
     *
     * @param {string} table - The table to join.
     * @param {string} first - The first column.
     * @param {string} [operator] - Comparison operator.
     * @param {any} [second] - The second column.
     * @param {JoinType} [type] - Join type (`left`, `right`, `inner`).
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public join(
        table: string,
        first: string,
        operator?: string,
        second?: any,
        type: JoinType = "inner"
    ): QueryBuilder {
        if (typeof operator === "undefined") operator = "=";

        this.joins.push({
            type,
            table,
            first,
            operator,
            second
        });

        return this;
    }

    /**
     * Adds a LEFT JOIN clause.
     *
     * @param {string} table - The table to join.
     * @param {string} first - The first column.
     * @param {string} [operator] - Comparison operator.
     * @param {any} [second] - The second column.
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public leftJoin(table: string, first: string, operator?: string, second?: any): QueryBuilder {
        return this.join(table, first, operator, second, "left");
    }

    /**
     * Adds a RIGHT JOIN clause.
     *
     * @param {string} table - The table to join.
     * @param {string} first - The first column.
     * @param {string} [operator] - Comparison operator.
     * @param {any} [second] - The second column.
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public rightJoin(table: string, first: string, operator?: string, second?: any): QueryBuilder {
        return this.join(table, first, operator, second, "right");
    }

    /**
     * Adds a CROSS JOIN clause.
     *
     * @param {string} table - The table to cross join.
     * @param {string} [first] - The first column (optional for cross join).
     * @param {string} [operator] - Comparison operator.
     * @param {any} [second] - The second column.
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public crossJoin(table: string, first?: string, operator?: string, second?: any): QueryBuilder {
        if (first) return this.join(table, first, operator, second, "cross");

        this.joins.push({
            type: "cross",
            table,
            first: "",
            operator: "",
            second: ""
        });

        return this;
    }

    /**
     * Joins a subquery.
     *
     * @param {QueryBuilder | QueryBuilderCallback} query - The subquery (QueryBuilder or callback).
     * @param {string} as - The alias for the subquery.
     * @param {string} first - The first column.
     * @param {string} [operator] - Comparison operator.
     * @param {any} [second] - The second column.
     * @param {JoinType} [type] - Join type.
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public joinSub(
        query: QueryBuilder | QueryBuilderCallback,
        as: string,
        first: string,
        operator: string = "=",
        second?: any,
        type: JoinType = "inner"
    ): QueryBuilder {
        const subQuery: QueryBuilder =
            typeof query === "function"
                ? (() => {
                      const q: QueryBuilder = new QueryBuilder(undefined, {
                          grammar: this.grammar
                      });

                      query(q);

                      return q;
                  })()
                : query;

        const compiled: CompiledQuery = subQuery.compileSelect();

        this.joins.push({
            type,
            table: `(${compiled.sql}) AS ${this.grammar.quote(as)}`,
            first: this.grammar.quote(first),
            operator,
            second: second ? this.grammar.quote(second) : undefined,
            bindings: [...compiled.bindings]
        });

        return this;
    }

    /**
     * Adds a raw JOIN clause.
     *
     * @param {string} sql - The raw JOIN expression.
     * @param {Array<any>} [bindings] - Bound values.
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public joinRaw(sql: string, bindings: Array<any> = []): QueryBuilder {
        this.joins.push({
            type: "raw",
            table: "",
            first: "",
            operator: "",
            second: sql,
            bindings
        });

        return this;
    }

    /**
     * Adds GROUP BY columns.
     *
     * @param {Array<string | Array<string>>} columns - Columns to group by.
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public groupBy(...columns: Array<string | Array<string>>): QueryBuilder {
        this.groups.push(...(columns.flat() as Array<string>));

        return this;
    }

    /**
     * Adds a raw GROUP BY clause.
     *
     * @param {string} sql - The raw SQL fragment.
     * @param {Array<any>} [bindings] - Bound values.
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public groupByRaw(sql: string, bindings: Array<any> = []): QueryBuilder {
        this.groups.push(sql);
        this._groupBindings.push(...bindings);

        return this;
    }

    /**
     * Adds a HAVING clause.
     *
     * @param {string} column - The column.
     * @param {any} [operator] - Comparison operator.
     * @param {any} [value] - The value.
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public having(column: string, operator?: any, value?: any): QueryBuilder {
        if (arguments.length === 2) {
            value = operator;
            operator = "=";
        }

        this.havings.push({
            sql: `${this.grammar.quote(column)} ${operator} ?`,
            bindings: [value]
        });

        return this;
    }

    /**
     * Adds a raw HAVING clause.
     *
     * @param {string} sql - The raw SQL fragment.
     * @param {Array<any>} [bindings] - Bound values.
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public havingRaw(sql: string, bindings: Array<any> = []): QueryBuilder {
        this.havings.push({
            sql,
            bindings
        });

        return this;
    }

    /**
     * Adds an ORDER BY clause.
     *
     * @param {string} column - The column.
     * @param {OrderDirection} [direction] - `asc` or `desc`.
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public orderBy(column: string, direction: OrderDirection = "asc"): QueryBuilder {
        this.orders.push({
            column,
            direction
        });

        return this;
    }

    /**
     * Adds a DESCENDING ORDER BY clause.
     *
     * @param {string} column - The column.
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public orderByDesc(column: string): QueryBuilder {
        return this.orderBy(column, "desc");
    }

    /**
     * Orders by a column in ascending order (default `created_at`).
     *
     * @param {string} [column] - The column to order by.
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public oldest(column: string = "created_at"): QueryBuilder {
        return this.orderBy(column, "asc");
    }

    /**
     * Orders by a column in descending order (default `created_at`).
     *
     * @param {string} [column] - The column to order by.
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public latest(column: string = "created_at"): QueryBuilder {
        return this.orderByDesc(column);
    }

    /**
     * Adds a raw ORDER BY clause. The raw fragment is always emitted with a
     * forced `ASC` direction (e.g. `ORDER BY <sql> ASC`), so it cannot produce
     * `DESC` and is not suitable for CASE/expression fragments.
     *
     * @param {string} sql - The raw SQL fragment.
     * @param {Array<any>} [bindings] - Bound values.
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public orderByRaw(sql: string, bindings: Array<any> = []): QueryBuilder {
        this.orders.push({
            column: sql,
            direction: "asc",
            bindings
        });

        return this;
    }

    /**
     * Orders by a random value.
     *
     * @param {string} [seed] - Seed for reproducibility; only honored on MySQL
     *   (`RAND(seed)`). PostgreSQL and SQLite emit `RANDOM()` and drop it.
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public inRandomOrder(seed?: string): QueryBuilder {
        const driver: string = this.grammar.driverName();
        const column: string =
            driver === DatabaseDriverEnum.Mysql ? (seed ? `RAND(${seed})` : "RAND()") : "RANDOM()";

        this.orders.push({
            column,
            direction: "asc"
        });

        return this;
    }

    /**
     * Sets or removes the ORDER BY clause.
     *
     * @param {string} [column] - The column to order by (removes all if omitted).
     * @param {OrderDirection} [direction] - `asc` or `desc`.
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public reorder(column?: string, direction: OrderDirection = "asc"): QueryBuilder {
        this.orders = [];

        if (column) this.orderBy(column, direction);

        return this;
    }

    /**
     * Sets the LIMIT.
     *
     * @param {number} limit - Row limit.
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public limit(limit: number): QueryBuilder {
        this.limitCount = limit;

        return this;
    }

    /**
     * Alias for `limit()`.
     *
     * @param {number} n - Row limit.
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public take(n: number): QueryBuilder {
        return this.limit(n);
    }

    /**
     * Sets the OFFSET.
     *
     * @param {number} offset - Row offset.
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public offset(offset: number): QueryBuilder {
        this.offsetCount = offset;

        return this;
    }

    /**
     * Alias for `offset()`.
     *
     * @param {number} n - Row offset.
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public skip(n: number): QueryBuilder {
        return this.offset(n);
    }

    /**
     * Combines results of this query with another using UNION.
     *
     * @param {QueryBuilder} query - The other query.
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public union(query: QueryBuilder): QueryBuilder {
        this._unions = this._unions || [];
        this._unions.push({
            query,
            all: false
        });

        return this;
    }

    /**
     * Combines results of this query with another using UNION ALL.
     *
     * @param {QueryBuilder} query - The other query.
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public unionAll(query: QueryBuilder): QueryBuilder {
        this._unions = this._unions || [];
        this._unions.push({
            query,
            all: true
        });

        return this;
    }

    /**
     * Registers eager loads to run when the query executes. On a builder that
     * materializes models (`Model.query()`), `get()` (and pagination/chunking,
     * which route through it) hydrate the rows and batch-load every relation --
     * one query per relation, no N+1. Without a model context the specs are
     * kept but have no effect on `get()`'s raw rows.
     *
     * Accepts relation names (dotted paths like `"posts.comments"`), arrays,
     * constraint callbacks -- `with("posts", (q) => q.where(...))` or the map
     * form `with({ posts: (q) => q.where(...) })`.
     *
     * @param {Array<any>} args - Relation name(s), or `(name, constraints)` pairs, or arrays.
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public with(...args: Array<any>): QueryBuilder {
        const specs: Array<EagerLoadSpec> = [];

        let pending: string | undefined;

        const flush = (): void => {
            if (pending) {
                specs.push({
                    relation: pending
                });

                pending = undefined;
            }
        };

        for (const arg of args) {
            if (typeof arg === "function") {
                if (!pending)
                    throw new RelationException(
                        "with() constraint callback must follow a relation name."
                    );

                specs.push({
                    relation: pending,
                    constraints: arg
                });

                pending = undefined;

                continue;
            }

            if (typeof arg === "string") {
                flush();

                pending = arg;

                continue;
            }

            if (Array.isArray(arg)) {
                flush();

                for (const item of arg) {
                    if (typeof item === "string") specs.push({relation: item});
                    else specs.push(item);
                }

                continue;
            }

            if (arg && typeof arg === "object") {
                flush();

                for (const key of Object.keys(arg)) {
                    const value: any = arg[key];

                    specs.push(
                        typeof value === "function"
                            ? {relation: key, constraints: value}
                            : {relation: key}
                    );
                }
            }
        }

        flush();

        this._eagerLoads.push(...specs);

        return this;
    }

    /**
     * Adds correlated COUNT subqueries for the given relations.
     *
     * Accepts relation names, or a `{name: {column, query, table,
     * foreignKey, localKey}}` map of options.
     *
     * @param {Array<string> | Record<string, any>} relations - Relation names or options map.
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public withCount(relations: Array<string> | Record<string, any>): QueryBuilder {
        return this.addAggregate("count", relations);
    }

    /**
     * Adds correlated SUM subqueries, e.g. `withSum(["posts"], "votes")`
     * selects `posts_sum_votes`. Accepts a map form for relation options.
     *
     * @param {Array<string> | Record<string, any>} relations - Relation name(s) or options map.
     * @param {string} [column] - Column to sum (used with the array form).
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public withSum(relations: Array<string> | Record<string, any>, column?: string): QueryBuilder {
        return this.addAggregate("sum", relations, column);
    }

    /**
     * Adds correlated MAX subqueries, e.g. `withMax(["posts"], "views")`
     * selects `posts_max_views`.
     *
     * @param {Array<string> | Record<string, any>} relations - Relation name(s) or options map.
     * @param {string} [column] - Column to aggregate (used with the array form).
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public withMax(relations: Array<string> | Record<string, any>, column?: string): QueryBuilder {
        return this.addAggregate("max", relations, column);
    }

    /**
     * Adds correlated MIN subqueries, e.g. `withMin(["posts"], "views")`
     * selects `posts_min_views`.
     *
     * @param {Array<string> | Record<string, any>} relations - Relation name(s) or options map.
     * @param {string} [column] - Column to aggregate (used with the array form).
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public withMin(relations: Array<string> | Record<string, any>, column?: string): QueryBuilder {
        return this.addAggregate("min", relations, column);
    }

    /**
     * Adds correlated AVG subqueries, e.g. `withAvg(["posts"], "rating")`
     * selects `posts_avg_rating`.
     *
     * @param {Array<string> | Record<string, any>} relations - Relation name(s) or options map.
     * @param {string} [column] - Column to aggregate (used with the array form).
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public withAvg(relations: Array<string> | Record<string, any>, column?: string): QueryBuilder {
        return this.addAggregate("avg", relations, column);
    }

    /**
     * Adds correlated EXISTS subqueries, selecting `posts_exists` as `1`/`0`
     * (drivers return booleans that are coerced to a number by `fetch()`).
     *
     * @param {Array<string> | Record<string, any>} relations - Relation name(s) or options map.
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public withExists(relations: Array<string> | Record<string, any>): QueryBuilder {
        return this.addAggregate("exists", relations);
    }

    /**
     * Executes the query and returns all matching rows.
     *
     * @returns {Promise<Array<T>>} The result rows.
     */
    public async get<T = Record<string, any>>(): Promise<Array<T>> {
        const rows: Array<Record<string, any>> = await this.fetch<Record<string, any>>();

        if (this._modelClass) {
            const models: Array<any> = await this._modelClass.hydrate(rows);

            if (this._eagerLoads.length > 0)
                await this._modelClass.eagerLoad(models, ...this._eagerLoads);

            return models as Array<T>;
        }

        return rows as Array<T>;
    }

    /**
     * Executes the compiled SELECT and returns raw rows, bypassing model
     * hydration. Useful for column/aggregate terminals and for callers that
     * hydrate themselves (`Relation` eager loading).
     *
     * @returns {Promise<Array<T>>} The raw rows.
     */
    public async getRaw<T = Record<string, any>>(): Promise<Array<T>> {
        return this.fetch<T>();
    }

    /**
     * Executes the query and returns the first row (or undefined).
     *
     * @returns {Promise<T | undefined>} The first row.
     */
    public async first<T = Record<string, any>>(): Promise<T | undefined> {
        const rows: Array<T> = await this.clone().limit(1).get<T>();

        return rows[0];
    }

    /**
     * Executes the query and returns the first row, throwing if none match.
     *
     * @param {any} error - Error (or factory) to throw; an `[Ctor, ...args]` tuple
     *   is constructed with the trailing arguments.
     * @returns {Promise<T>} The first row.
     */
    public async firstOrFail<T = Record<string, any>>(error?: any): Promise<T> {
        const row: T | undefined = await this.first<T>();

        if (!row) {
            if (typeof error === "function") throw error();

            if (Array.isArray(error)) throw new error[0](...error.slice(1));

            if (error) throw error;

            throw new RecordNotFoundException("No result was found for the query.");
        }

        return row;
    }

    /**
     * Finds a row by the model's primary key, or `id` for a plain query.
     *
     * @param {any} id - The primary key value to match.
     * @param {Array<string>} [columns] - Columns to select.
     * @returns {Promise<T | undefined>} The matching row.
     */
    public async find<T = Record<string, any>>(
        id: any,
        columns: Array<string> = ["*"]
    ): Promise<T | undefined> {
        return this.clone()
            .select(...columns)
            .where(this._modelClass?.idColumn ?? "id", "=", id)
            .first<T>();
    }

    /**
     * Finds a row by its primary key, throwing when no row matches.
     *
     * @param {any} id - The primary key value to match.
     * @param {Array<string>} [columns] - Columns to select.
     * @param {any} [error] - Custom error, factory, or constructor tuple.
     * @returns {Promise<T>} The matching row.
     * @throws {RecordNotFoundException} When no row matches and no custom error is supplied.
     */
    public async findOrFail<T = Record<string, any>>(
        id: any,
        columns: Array<string> = ["*"],
        error?: any
    ): Promise<T> {
        const row: T | undefined = await this.find<T>(id, columns);

        if (row !== undefined) return row;

        if (typeof error === "function") throw error();

        if (Array.isArray(error)) throw new error[0](...error.slice(1));

        if (error) throw error;

        throw new RecordNotFoundException(
            this._modelClass
                ? `No result for model [${this._modelClass.tableName}] with id [${id}].`
                : `No result for query [${this.fromTable}] with id [${id}].`
        );
    }

    /**
     * Executes the query and returns the matching rows wrapped in a
     * `Collection` instance.
     *
     * @returns {Promise<Collection<T>>} The result collection.
     */
    public async col<T = Record<string, any>>(): Promise<Collection<T>> {
        return new Collection<T>(await this.get<T>());
    }

    /**
     * Returns a single column value from the first row.
     *
     * @param {string} column - The column to pluck.
     * @returns {Promise<any>} The column value.
     */
    public async value(column: string): Promise<any> {
        const rows: Array<Record<string, any>> = await this.clone()
            .select(column)
            .limit(1)
            .fetch<Record<string, any>>();

        const row: Record<string, any> | undefined = rows[0];

        return row ? row[column] : undefined;
    }

    /**
     * Returns an array of a single column's values.
     *
     * @param {string} column - The column to pluck.
     * @param {string} [key] - Optional column used as keys.
     * @returns {Promise<Array<any> | Record<string, any>>} The column values (object if `key` given).
     */
    public async pluck(column: string, key?: string): Promise<Array<any> | Record<string, any>> {
        const cols: Array<string> = key ? [column, key] : [column];
        const rows: Array<Record<string, any>> = await this.clone()
            .select(...cols)
            .fetch<Record<string, any>>();

        if (!key) return rows.map((row: Record<string, any>) => row[column]);

        const result: Record<string, any> = Object.create(null) as Record<string, any>;

        for (const row of rows) {
            result[row[key]] = row[column];
        }

        return result;
    }

    /**
     * Returns an ascending array of a single column's values.
     *
     * @param {string} column - The column to pluck.
     * @returns {Promise<Array<any>>} The column values.
     */
    public async pluckSorted(column: string): Promise<Array<any>> {
        const rows: Array<Record<string, any>> = await this.clone()
            .select(column)
            .orderBy(column)
            .fetch<Record<string, any>>();

        return rows.map((row: Record<string, any>) => row[column]);
    }

    /**
     * Counts matching rows, or non-null values in the requested column.
     *
     * @param {string} [column] - Column to count; `*` counts all rows in the result.
     * @returns {Promise<number>} The count.
     */
    public async count(column: string = "*"): Promise<number> {
        const sub: QueryBuilder = this.clone();

        sub.limitCount = null;
        sub.offsetCount = null;
        sub.orders = [];
        sub.lockMode = null;

        let expression: string = "*";

        if (column !== "*") {
            // Project a stable alias so qualified columns remain addressable from
            // the outer count, even when the original projection omitted them.
            expression = this.grammar.quote("bejibun_count_value");
            sub.select(`${this.grammar.quote(column)} AS ${expression}`);
        }

        const inner: CompiledQuery = sub.compileSelect();
        const rows: Array<Record<string, any>> = await this.grammar.run(
            `SELECT COUNT(${expression}) AS aggregate FROM (${inner.sql}) AS ${this.grammar.quote("bejibun_count")}`,
            inner.bindings
        );

        return this.normalizeCount(rows[0]?.aggregate);
    }

    /**
     * Checks whether any rows match.
     *
     * @returns {Promise<boolean>} True when at least one row matches.
     */
    public async exists(): Promise<boolean> {
        return (await this.count()) > 0;
    }

    /**
     * Returns the maximum value of a column.
     *
     * @param {string} column - The column.
     * @returns {Promise<any>} The maximum value.
     */
    public async max(column: string): Promise<any> {
        return this.aggregate("MAX", column);
    }

    /**
     * Returns the minimum value of a column.
     *
     * @param {string} column - The column.
     * @returns {Promise<any>} The minimum value.
     */
    public async min(column: string): Promise<any> {
        return this.aggregate("MIN", column);
    }

    /**
     * Returns the sum of a column.
     *
     * @param {string} column - The column.
     * @returns {Promise<any>} The sum.
     */
    public async sum(column: string): Promise<any> {
        return this.aggregate("SUM", column);
    }

    /**
     * Returns the average of a column.
     *
     * @param {string} column - The column.
     * @returns {Promise<any>} The average.
     */
    public async avg(column: string): Promise<any> {
        return this.aggregate("AVG", column);
    }

    /**
     * Inserts one or more rows.
     *
     * @param {Record<string, any> | Array<Record<string, any>>} payload - Row(s) to insert.
     * @returns {Promise<any>} Statement result (insert id where available).
     */
    public async insert(payload: Record<string, any> | Array<Record<string, any>>): Promise<any> {
        const rows: Array<Record<string, any>> = Array.isArray(payload) ? payload : [payload];

        if (rows.length === 0) return 0;

        const columns: Array<string> = Object.keys(rows[0]);
        const sql: Array<string> = rows.map(() => `(${columns.map(() => "?").join(", ")})`);
        const bindings: Array<any> = rows.flatMap((row: Record<string, any>) =>
            columns.map((column: string) => row[column])
        );
        const statement: string = `INSERT INTO ${this.grammar.quote(this.fromTable!)} (${columns.map((column: string) => this.grammar.quote(column)).join(", ")}) VALUES ${sql.join(", ")}`;

        return this.grammar.run(statement, bindings);
    }

    /**
     * Inserts a row and returns its primary key where the driver
     * supports `RETURNING` (PostgreSQL/SQLite).
     *
     * @param {Record<string, any>} payload - The row to insert.
     * @param {string} [key] - Column to return (`id` by default).
     * @returns {Promise<any>} The generated key.
     */
    public async insertGetId(payload: Record<string, any>, key: string = "id"): Promise<any> {
        if (this.grammar.driverName() === DatabaseDriverEnum.Mysql)
            return this.mysqlPinned(async () => {
                const result: any = await this.insert(payload);

                // Bun's MySQL driver returns the raw `[...rows]` for INSERT. On Bun
                // < 1.5 that is an empty array (no ResultSetHeader), so no insertId is
                // exposed and the header fallbacks below come up undefined. LAST
                // INSERT_ID is per-session, so read it on the SAME connection via an
                // extra query instead of trusting version-dependent headers.
                const header: any = Array.isArray(result) ? result[0] : result;
                const direct: any = header?.insertId ?? header?.lastInsertId;

                if (direct !== undefined && direct !== null) return direct;

                // Bun's MySQL driver returns an empty `[...rows]` (no ResultSetHeader)
                // for INSERT, so no insertId reaches us above. LAST_INSERT_ID() is
                // per-session -- read it on this same connection via `grammar.run`, which
                // re-resolves `currentTransaction() ?? this.connection`, NOT a fresh
                // pooled handle (that could be a different session on a pool > 1).
                const rows: Array<any> = await this.grammar.run("SELECT LAST_INSERT_ID() AS id");

                return Array.isArray(rows) ? rows?.[0]?.id : undefined;
            });

        const columns: Array<string> = Object.keys(payload);
        const bindings: Array<any> = columns.map((column: string) => payload[column]);
        const statement: string = `INSERT INTO ${this.grammar.quote(this.fromTable!)} (${columns.map((column: string) => this.grammar.quote(column)).join(", ")}) VALUES (${columns.map(() => "?").join(", ")}) RETURNING ${this.grammar.quote(key)}`;
        const rows: Array<Record<string, any>> = await this.grammar.run(statement, bindings);
        const insertedId: any = rows[0]?.[key] ?? rows[0]?.id;

        if (this.grammar.returnsBigIntAsNumber()) {
            const numeric: number = Number(insertedId);

            if (typeof insertedId === "string" && Number.isSafeInteger(numeric)) return numeric;
        }

        return insertedId;
    }

    /**
     * Inserts a row, ignoring duplicate key errors.
     *
     * @param {Record<string, any> | Array<Record<string, any>>} payload - Row(s) to insert.
     * @returns {Promise<any>} Statement result.
     */
    public async insertOrIgnore(
        payload: Record<string, any> | Array<Record<string, any>>
    ): Promise<any> {
        const rows: Array<Record<string, any>> = Array.isArray(payload) ? payload : [payload];

        if (rows.length === 0) return 0;

        const g: Grammar = this.grammar;
        const columns: Array<string> = Object.keys(rows[0]);
        const placeholders: Array<string> = rows.map(
            () => `(${columns.map(() => "?").join(", ")})`
        );
        const bindings: Array<any> = rows.flatMap((row: Record<string, any>) =>
            columns.map((column: string) => row[column])
        );
        const driver: string = g.driverName();

        let statement: string;

        switch (driver) {
            case DatabaseDriverEnum.Mysql:
                statement = `INSERT IGNORE INTO ${g.quote(this.fromTable!)} (${columns.map((column: string) => g.quote(column)).join(", ")}) VALUES ${placeholders.join(", ")}`;

                break;
            default:
                statement = `INSERT INTO ${g.quote(this.fromTable!)} (${columns.map((column: string) => g.quote(column)).join(", ")}) VALUES ${placeholders.join(", ")} ON CONFLICT DO NOTHING`;

                break;
        }

        return this.grammar.run(statement, bindings);
    }

    /**
     * Updates matching rows.
     *
     * @param {Record<string, any>} values - The columns to set.
     * @returns {Promise<number>} The number of affected rows.
     */
    public async update(values: Record<string, any>): Promise<number> {
        return this.mysqlPinned(async () => {
            const compiled: CompiledQuery = this.compileUpdate(values);
            const result: Array<any> = await this.grammar.run(compiled.sql, compiled.bindings);

            return this.resolveAffectedRows(result);
        });
    }

    /**
     * Updates the first row matching `attributes`, or inserts a new row with
     * both `attributes` and `values` when none matches.
     *
     * @param {Record<string, any>} attributes - Column/value pairs to match on (and seed an insert).
     * @param {Record<string, any>} [values] - Extra columns to set on update/insert.
     * @returns {Promise<boolean>} Always `true` on success; a DB error is thrown instead of
     *   returning `false`. Insert vs. update is not distinguishable.
     */
    public async updateOrInsert(
        attributes: Record<string, any>,
        values: Record<string, any> = {}
    ): Promise<boolean> {
        const probe: QueryBuilder = this.clone();

        for (const [key, value] of Object.entries(attributes)) {
            probe.where(key, "=", value);
        }

        const existing: Record<string, any> | undefined = (
            await probe.fetch<Record<string, any>>()
        )[0];

        if (existing) {
            if (Object.keys(values).length === 0) return true;

            const updater: QueryBuilder = this.clone();

            for (const [key, value] of Object.entries(attributes)) {
                updater.where(key, "=", value);
            }

            await updater.update(values);

            return true;
        }

        await this.clone().insert({...attributes, ...values});

        return true;
    }

    /**
     * Deletes matching rows.
     *
     * @returns {Promise<number>} The number of affected rows.
     */
    public async delete(): Promise<number> {
        return this.mysqlPinned(async () => {
            const compiled: CompiledQuery = this.compileDelete();
            const result: Array<any> = await this.grammar.run(compiled.sql, compiled.bindings);

            return this.resolveAffectedRows(result);
        });
    }

    /**
     * Increments a numeric column.
     *
     * @param {string} column - The column.
     * @param {number} [amount] - Increment amount (`1` by default).
     * @param {Record<string, any>} [extra] - Extra columns to set.
     * @returns {Promise<number>} The number of affected rows.
     */
    public async increment(
        column: string,
        amount: number = 1,
        extra: Record<string, any> = {}
    ): Promise<number> {
        return this.update({
            ...extra,
            [column]: {
                raw: `${this.grammar.quote(column)} + ${amount}`
            }
        });
    }

    /**
     * Decrements a numeric column.
     *
     * @param {string} column - The column.
     * @param {number} [amount] - Decrement amount (`1` by default).
     * @param {Record<string, any>} [extra] - Extra columns to set.
     * @returns {Promise<number>} The number of affected rows.
     */
    public async decrement(
        column: string,
        amount: number = 1,
        extra: Record<string, any> = {}
    ): Promise<number> {
        return this.update({
            ...extra,
            [column]: {
                raw: `${this.grammar.quote(column)} - ${amount}`
            }
        });
    }

    /**
     * Inserts or updates rows in bulk.
     *
     * @param {Array<Record<string, any>>} values - Rows to upsert.
     * @param {Array<string>} uniqueKeys - Conflict/unique columns; honored on PostgreSQL and
     *   SQLite (`ON CONFLICT (...)`). MySQL uses `ON DUPLICATE KEY UPDATE` and
     *   ignores this list (the row's own unique/PK keys apply).
     * @param {Array<string>} [updateKeys] - Columns to update on conflict (all if omitted).
     * @returns {Promise<any>} Statement result.
     */
    public async upsert(
        values: Array<Record<string, any>>,
        uniqueKeys: Array<string>,
        updateKeys?: Array<string>
    ): Promise<any> {
        if (values.length === 0) return 0;

        const allColumns: Array<string> = [
            ...new Set(values.flatMap((value: Record<string, any>) => Object.keys(value)))
        ];
        const bindings: Array<any> = values.flatMap((row: Record<string, any>) =>
            allColumns.map((column: string) => row[column])
        );
        const placeholders: Array<string> = values.map(
            () => `(${allColumns.map(() => "?").join(", ")})`
        );
        const g: Grammar = this.grammar;
        const driver: string = g.driverName();
        const cols: string = allColumns.map((column: string) => g.quote(column)).join(", ");
        const conflictCols: string = uniqueKeys.map((column: string) => g.quote(column)).join(", ");
        const updateCols: Array<string> = updateKeys || allColumns;

        let statement: string;

        switch (driver) {
            case DatabaseDriverEnum.Mysql: {
                const updateSet: string = updateCols
                    .map((column: string) => `${g.quote(column)} = VALUES(${g.quote(column)})`)
                    .join(", ");

                statement = `INSERT INTO ${g.quote(this.fromTable!)} (${cols}) VALUES ${placeholders.join(", ")} ON DUPLICATE KEY UPDATE ${updateSet}`;

                break;
            }
            default: {
                const updateSet: string = updateCols
                    .map((column: string) => `${g.quote(column)} = EXCLUDED.${g.quote(column)}`)
                    .join(", ");

                statement = `INSERT INTO ${g.quote(this.fromTable!)} (${cols}) VALUES ${placeholders.join(", ")} ON CONFLICT (${conflictCols}) DO UPDATE SET ${updateSet}`;

                break;
            }
        }

        return g.run(statement, bindings);
    }

    /**
     * Returns the first row or throws if none found or more than one found.
     *
     * @param {Array<string>} [columns] - Columns to select.
     * @returns {Promise<T>} The single matching row.
     */
    public async sole<T = Record<string, any>>(columns: Array<string> = ["*"]): Promise<T> {
        const result: Array<T> = await this.clone()
            .select(...columns)
            .limit(2)
            .get<T>();

        if (result.length === 0)
            throw new RecordNotFoundException("No result was found for the query.");

        if (result.length > 1)
            throw new QueryException(
                "Multiple results were found for the query (expected exactly one)."
            );

        return result[0];
    }

    /**
     * Runs `EXPLAIN` for the current SELECT and returns the driver's plan
     * rows. Useful for inspecting indexes/scan behavior.
     *
     * @returns {Promise<Array<Record<string, any>>>} The plan rows.
     */
    public async explain(): Promise<Array<Record<string, any>>> {
        const {sql, bindings} = this.toSql();

        return this.grammar.run<Record<string, any>>(`EXPLAIN ${sql}`, bindings);
    }

    /**
     * Chunks results into batches and passes each batch to a callback. Any
     * `limit`/`offset` already set on the builder is overridden by this
     * method's paging.
     *
     * @param {number} size - The batch size.
     * @param {(rows: Array<Record<string, any>>) => boolean | void | Promise<boolean | void>} callback - Receives a batch of rows. Return `false` to stop.
     * @returns {Promise<boolean>} True if all chunks processed.
     */
    public async chunk(
        size: number,
        callback: (rows: Array<Record<string, any>>) => boolean | void | Promise<boolean | void>
    ): Promise<boolean> {
        if (size <= 0) throw new QueryException("Chunk size must be greater than zero.");

        let page: number = 1;

        while (true) {
            const rows: Array<Record<string, any>> = await this.clone()
                .limit(size)
                .offset((page - 1) * size)
                .get();

            if (rows.length === 0) break;

            const result: boolean | void = await callback(rows);

            if (result === false) return false;

            if (rows.length < size) break;

            page++;
        }

        return true;
    }

    /**
     * Iterates over each row in batch, passing each row and its index to a
     * callback.
     *
     * @param {number} size - The batch size.
     * @param {(row: Record<string, any>, index: number) => boolean | Promise<boolean>} callback - Receives each row and its zero-based index. Return
     *   `false` synchronously to stop early (a returned promise is never
     *   awaited for the stop check).
     * @returns {Promise<void>} Resolves when done.
     */
    public async each(
        size: number,
        callback: (row: Record<string, any>, index: number) => boolean | Promise<boolean>
    ): Promise<void> {
        let index: number = 0;

        await this.chunk(size, async (rows: Array<Record<string, any>>) => {
            for (const row of rows) {
                const result: boolean | Promise<boolean> = callback(row, index++);

                if (result === false) return false;
            }

            return true;
        });
    }

    /**
     * Paginates results.
     *
     * @param {number} [page=1] - The page number.
     * @param {number} [perPage=15] - Results per page.
     * @returns {Promise<PaginationResult>} Paginated results.
     */
    public async paginate(page: number = 1, perPage: number = 15): Promise<PaginationResult> {
        // Count and page data are independent reads on cloned builders -- run
        // them concurrently instead of serializing (count, then page).
        const offset: number = (page - 1) * perPage;
        const [total, data]: [number, Array<Record<string, any>>] = await Promise.all([
            this.clone().count(),
            this.clone().limit(perPage).offset(offset).get()
        ]);
        const lastPage: number = total > 0 ? Math.ceil(total / perPage) : 0;

        return {
            data,
            total,
            perPage,
            currentPage: page,
            lastPage,
            from: data.length > 0 ? offset + 1 : null,
            to: data.length > 0 ? offset + data.length : null
        };
    }

    /**
     * Simple pagination. Skips the total-count query, so it is faster but
     * `lastPage` is only a guess (`page + 1` when a next page exists), never
     * an exact total.
     *
     * @param {number} [page=1] - The page number.
     * @param {number} [perPage=15] - Results per page.
     * @returns {Promise<SimplePaginationResult>} Paginated results.
     */
    public async simplePaginate(
        page: number = 1,
        perPage: number = 15
    ): Promise<SimplePaginationResult> {
        const offset: number = (page - 1) * perPage;
        const data: Array<Record<string, any>> = await this.clone()
            .limit(perPage + 1)
            .offset(offset)
            .get();
        const hasMore: boolean = data.length > perPage;

        if (hasMore) data.pop();

        return {
            data,
            perPage,
            currentPage: page,
            lastPage: hasMore ? page + 1 : page,
            from: data.length > 0 ? offset + 1 : null,
            to: data.length > 0 ? offset + data.length : null,
            hasMore
        };
    }

    /**
     * Returns a lazy cursor for iterating over results. The builder's `limit`
     * (or a default of 1000) is used as the per-page size, not a total cap,
     * so `limit(5).cursor()` still yields every matching row.
     *
     * @yields {Record<string, any>} Each row.
     */
    public async *cursor(): AsyncGenerator<Record<string, any>> {
        const source: QueryBuilder = this.clone();
        const limit: number = source.limitCount || 1000;
        let offset: number = 0;

        while (true) {
            const rows: Array<Record<string, any>> = await source.limit(limit).offset(offset).get();

            if (rows.length === 0) break;

            for (const row of rows) yield row;

            offset += rows.length;

            if (rows.length < limit) break;
        }
    }

    /**
     * Cursor-based pagination.
     *
     * @param {number} [perPage=15] - Results per page.
     * @param {any} [cursor] - The cursor value (last row's ordering column value).
     * @param {string} [cursorColumn="id"] - The column used as cursor.
     * @returns {Promise<CursorPaginationResult>} Paginated results.
     */
    public async cursorPaginate(
        perPage: number = 15,
        cursor?: any,
        cursorColumn: string = "id"
    ): Promise<CursorPaginationResult> {
        const builder: QueryBuilder = this.clone();
        const existing: Array<OrderClause> = builder.orders;
        const cursorOrder: any = existing.find(
            (order: OrderClause) => String(order.column) === cursorColumn
        );
        const descending: boolean = cursorOrder
            ? String(cursorOrder.direction).toLowerCase() === "desc"
            : false;

        // Keyset pagination needs a stable primary order on the cursor column;
        // prepend it and drop duplicate cursor entries so pages never drift.
        builder.reorder();
        builder.orderBy(cursorColumn, descending ? "desc" : "asc");

        if (cursor !== undefined) builder.where(cursorColumn, descending ? "<" : ">", cursor);

        const data: Array<Record<string, any>> = await builder.limit(perPage + 1).get();
        const hasMore: boolean = data.length > perPage;

        if (hasMore) data.pop();

        const nextCursor: any =
            hasMore && data.length > 0 ? data[data.length - 1]?.[cursorColumn] : null;

        return {
            data,
            perPage,
            nextCursor,
            hasMore
        };
    }

    /**
     * Sets the row lock: `true` → `FOR UPDATE`, `false` → `FOR SHARE`,
     * or a raw keyword when a custom lock is needed.
     *
     * @param {boolean | string} lock - `true`, `false`, or a custom lock SQL keyword.
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public lock(lock: boolean | string = true): QueryBuilder {
        this.lockMode = lock;

        return this;
    }

    /**
     * Locks selected rows for the rest of the current transaction
     * (`FOR UPDATE`). No-op on SQLite.
     *
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public lockForUpdate(): QueryBuilder {
        return this.lock(true);
    }

    /**
     * Applies a shared lock (`FOR SHARE`). No-op on SQLite.
     *
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public sharedLock(): QueryBuilder {
        return this.lock(false);
    }

    /**
     * Compiles the full SELECT statement with its bindings. The returned `sql`
     * keeps `?` placeholders; run it through the driver's binding style (via
     * `grammar.run()` or `compilePlaceholders()`) before sending to PostgreSQL.
     *
     * @returns {CompiledQuery} The compiled query.
     */
    public toSql(): CompiledQuery {
        // Custom builders must opt into caching with a signature that includes
        // their extra state; the base signature only describes base query state.
        const customCompiler: boolean =
            this.constructor !== QueryBuilder ||
            this.compileSelect !== QueryBuilder.prototype.compileSelect;
        const signature: string | null =
            customCompiler && this.compileSignature === QueryBuilder.prototype.compileSignature
                ? null
                : this.compileSignature();

        if (signature !== null && this._compileCache && this._compileCache.signature === signature)
            return this._compileCache.result;

        const result: CompiledQuery = this.compileSelect();

        if (signature !== null)
            this._compileCache = {
                signature,
                result
            };

        return result;
    }

    /**
     * Compiles the full query as a raw SQL string (with values interpolated
     * for debugging -- NOT safe for execution).
     *
     * @returns {string} The raw SQL string.
     */
    public toRawSql(): string {
        const {sql, bindings} = this.toSql();

        let raw: string = "";
        let bindingIndex: number = 0;
        const n: number = sql.length;

        for (let index: number = 0; index < n; index++) {
            const char: string = sql.charAt(index);

            if (char === "'" || char === '"') {
                const quoteChar: string = char;

                raw += char;
                index++;

                while (index < n) {
                    raw += sql.charAt(index);

                    if (sql.charAt(index) === quoteChar) {
                        if (sql.charAt(index + 1) === quoteChar) {
                            raw += quoteChar;
                            index++;
                        } else {
                            break;
                        }
                    }

                    index++;
                }

                continue;
            }

            if (char !== "?") {
                raw += char;

                continue;
            }

            if (sql.charAt(index + 1) === "?") {
                raw += "?";
                index++;

                continue;
            }

            const binding: any = bindings[bindingIndex++];

            raw +=
                typeof binding === "string" ? `'${binding.replace(/'/g, "''")}'` : String(binding);
        }

        return raw;
    }

    /**
     * Alias of `toRawSql()`: returns the query with bindings interpolated.
     *
     * @returns {string} The human-readable SQL.
     */
    public dumpRawSql(): string {
        return this.toRawSql();
    }

    /**
     * Logs the interpolated SQL of the query being built and returns the
     * builder, so it can be dropped into a chain without changing results.
     *
     * @param {string} [label] - Optional label printed before the SQL.
     * @returns {QueryBuilder} This builder, for chaining.
     */
    public dump(label?: string): QueryBuilder {
        Logger.setContext("ORM").info(`${label ? `${label}: ` : ""}${this.toRawSql()}`);

        return this;
    }

    /**
     * Returns a copy of the builder's current state (nested where/join/order
     * builders are deep-copied), so terminal methods (`first`, `count`, `pluck`,
     * `paginate`, ...) can apply their own LIMIT/columns/order without mutating
     * the caller's builder.
     *
     * @returns {QueryBuilder} A cloned builder.
     */
    protected clone(): QueryBuilder {
        // Preserve subclass hooks and own state without assuming its constructor
        // signature or running constructor side effects for every terminal call.
        const copy: QueryBuilder = Object.create(
            Object.getPrototypeOf(this),
            Object.getOwnPropertyDescriptors(this)
        );

        copy._modelClass = this._modelClass;
        copy._relationResolver = this._relationResolver;
        copy.columns = [...this.columns];
        copy.distinct = this.distinct;
        copy.wheres = this.wheres.map((where: WhereClause) => ({
            ...where,
            ...(where.nested ? {nested: where.nested.clone()} : {})
        }));
        copy.joins = this.joins.map((join: JoinClause) => ({
            ...join,
            bindings: [...(join.bindings || [])]
        }));
        copy.groups = [...this.groups];
        copy._groupBindings = [...this._groupBindings];
        copy.havings = this.havings.map((having: HavingClause) => ({
            ...having,
            bindings: [...(having.bindings || [])]
        }));
        copy.orders = this.orders.map((order: OrderClause) => ({
            ...order,
            bindings: [...(order.bindings || [])]
        }));
        copy.limitCount = this.limitCount;
        copy.offsetCount = this.offsetCount;
        copy.lockMode = this.lockMode;
        copy._fromBindings = [...this._fromBindings];
        copy._selectBindings = [...this._selectBindings];
        copy._withAggregateAliases = [...this._withAggregateAliases];
        copy._unions = this._unions.map((union: UnionClause) => ({
            ...union,
            query: union.query.clone()
        }));
        copy._eagerLoads = [...this._eagerLoads];

        copy.invalidateCompileCache();

        return copy;
    }

    /**
     * Wraps a column expression, passing function/expression forms and
     * subselects through unquoted.
     *
     * @param {string} column - The column expression.
     * @returns {string} The wrapped expression.
     */
    protected wrapColumn(column: string): string {
        const g: Grammar = this.grammar;

        if (/\s+as\s+/i.test(column)) {
            const [expression, alias] = column.split(/\s+as\s+/i);

            return `${this.wrapColumn(expression)} AS ${g.quote(alias)}`;
        }

        if (column === "*") return "*";

        if (/^\(select\b/i.test(column)) return column;

        if (
            /^(count|sum|min|max|avg|exists|coalesce|concat|rand|random|date|year|month|day|time)\(/i.test(
                column
            )
        )
            return column;

        if (/[()\s]/.test(column) && !/``|""/.test(column))
            return column
                .replace(/\b(\w+)\b/g, (word: string) => g.quote(word))
                .replace(/["'`]/g, "");

        return g.quote(column);
    }

    /**
     * Compiles a date-part function around a column, mapping to
     * `strftime` on SQLite (which has no `YEAR`/`MONTH`/`DAY` functions).
     *
     * @param {string} fn - The logical function (`DATE`, `DAY`, `MONTH`, `YEAR`, `TIME`).
     * @param {string} column - The column.
     * @returns {string} The function SQL.
     */
    protected dateFunctionSql(fn: string, column: string): string {
        const driver: string = this.grammar.driverName();
        const quoted: string = this.grammar.quote(column);

        if (driver === DatabaseDriverEnum.Pg) {
            // PostgreSQL has no YEAR()/MONTH()/DAY()/TIME() scalar functions --
            // it uses EXTRACT()/::date/::time casting instead.
            switch (fn) {
                case "DAY":
                case "MONTH":
                case "YEAR":
                    return `EXTRACT(${fn} FROM ${quoted})`;
                case "TIME":
                    return `(${quoted})::time`;
                default:
                    return `(${quoted})::date`;
            }
        }

        if (driver === DatabaseDriverEnum.Sqlite || driver === DatabaseDriverEnum.Sqlite3) {
            switch (fn) {
                case "DAY":
                    return `STRFTIME('%d', ${quoted})`;
                case "MONTH":
                    return `STRFTIME('%m', ${quoted})`;
                case "YEAR":
                    return `STRFTIME('%Y', ${quoted})`;
                case "TIME":
                    return `STRFTIME('%H:%M:%S', ${quoted})`;
                default:
                    return `DATE(${quoted})`;
            }
        }

        return `${fn}(${quoted})`;
    }

    /**
     * Compiles the `FOR UPDATE`/`FOR SHARE` tail for drivers that support
     * row locking (PostgreSQL/MySQL). Returns an empty string otherwise.
     *
     * @returns {string} The lock clause, or an empty string.
     */
    protected lockSql(): string {
        if (this.lockMode === null || this.lockMode === undefined) return "";

        const driver: string = this.grammar.driverName();

        if (driver === DatabaseDriverEnum.Sqlite || driver === DatabaseDriverEnum.Sqlite3)
            return "";

        const keyword: string =
            this.lockMode === true
                ? "FOR UPDATE"
                : this.lockMode === false
                  ? "FOR SHARE"
                  : String(this.lockMode);

        return ` ${keyword}`;
    }

    /**
     * Compiles the accumulated WHERE clauses into a single fragment.
     *
     * @returns {CompiledQuery} The compiled WHERE.
     */
    protected compileWheres(): CompiledQuery {
        if (this.wheres.length === 0)
            return {
                sql: "",
                bindings: []
            };

        const g: Grammar = this.grammar;

        const segments: Array<string> = this.wheres.map((where: WhereClause, index: number) => {
            const glue: string = index === 0 ? "WHERE" : where.boolean === "or" ? "OR" : "AND";

            switch (where.type) {
                case "basic":
                    return `${glue} ${g.quote(where.column!)} ${where.operator} ?`;
                case "in": {
                    const placeholders: string = (where.values || []).map(() => "?").join(", ");

                    return `${glue} ${g.quote(where.column!)} ${where.not ? "NOT IN" : "IN"} (${placeholders})`;
                }
                case "null":
                    return `${glue} ${g.quote(where.column!)} IS NULL`;
                case "not-null":
                    return `${glue} ${g.quote(where.column!)} IS NOT NULL`;
                case "between":
                    return `${glue} ${g.quote(where.column!)} ${where.not ? "NOT BETWEEN" : "BETWEEN"} ? AND ?`;
                case "nested": {
                    const nested: CompiledQuery = where.nested!.compileWheres();
                    const inner: string = nested.sql.replace(/^\s*WHERE\s*/i, "");

                    if (inner.trim() === "") return "";

                    return `${glue} (${inner})`;
                }
                case "raw":
                    return `${glue} ${where.sql}`;
                case "column":
                    return `${glue} ${g.quote(where.column!)} ${where.operator} ${g.quote(where.second!)}`;
                case "exists": {
                    const existsSql: string = where.nested!.compileSelect().sql;

                    return `${glue} ${where.not ? "NOT " : ""}EXISTS (${existsSql})`;
                }
                case "sub": {
                    const subSql: string = where.nested!.compileSelect().sql;

                    return `${glue} ${g.quote(where.column!)} ${where.not ? "NOT IN" : "IN"} (${subSql})`;
                }
                case "date-part":
                    return `${glue} ${this.dateFunctionSql(where.dateFunction!, where.column!)} ${where.operator} ?`;
                case "like": {
                    const operator: string =
                        where.operator === "ILIKE" && g.driverName() !== DatabaseDriverEnum.Pg
                            ? "LIKE"
                            : where.operator!;

                    return `${glue} ${g.quote(where.column!)} ${operator} ?`;
                }
                case "json":
                    return `${glue} ${where.sql}`;
                default:
                    return "";
            }
        });

        const bindings: Array<any> = this.wheres.flatMap((where: WhereClause) => {
            switch (where.type) {
                case "basic":
                case "date-part":
                case "like":
                    return [where.value];
                case "in":
                case "between":
                    return where.values || [];
                case "nested":
                    return where.nested!.compileWheres().bindings;
                case "raw":
                case "json":
                    return where.bindings || [];
                case "exists":
                case "sub":
                    return where.nested!.compileSelect().bindings;
                case "null":
                case "not-null":
                case "column":
                default:
                    return [];
            }
        });

        return {
            sql: ` ${segments.join(" ")}`,
            bindings
        };
    }

    /**
     * Compiles the SELECT statement.
     *
     * @returns {CompiledQuery} The compiled query.
     */
    protected compileSelect(): CompiledQuery {
        const g: Grammar = this.grammar;
        const columns: string =
            this.columns.length > 0
                ? this.columns.map((column: string) => this.wrapColumn(column)).join(", ")
                : "*";
        const fromSql: string = this.fromTable
            ? this.fromTable.includes("(")
                ? this.fromTable!
                : g.quote(this.fromTable!)
            : "";
        const select: string = `${this.distinct ? "SELECT DISTINCT" : "SELECT"} ${columns}${this.fromTable ? ` FROM ${fromSql}` : ""}`;
        const joins: string = this.joins
            .map((join: JoinClause) => {
                if (join.type === "raw") return join.second;

                if (join.type === "cross") return `CROSS JOIN ${g.quote(join.table)}`;

                const type: string =
                    join.type === "left"
                        ? "LEFT JOIN"
                        : join.type === "right"
                          ? "RIGHT JOIN"
                          : "INNER JOIN";

                return `${type} ${join.table.includes("(") ? join.table : g.quote(join.table)} ON ${join.first} ${join.operator} ${join.second || ""}`;
            })
            .join(" ");
        const wherePart: CompiledQuery = this.compileWheres();
        const groups: string =
            this.groups.length > 0
                ? ` GROUP BY ${this.groups.map((column: string) => g.quote(column)).join(", ")}`
                : "";
        const havings: string =
            this.havings.length > 0
                ? ` HAVING ${this.havings.map((having: HavingClause) => having.sql).join(" AND ")}`
                : "";
        const orders: string =
            this.orders.length > 0
                ? ` ORDER BY ${this.orders
                      .map((order: OrderClause) => {
                          const column: string =
                              order.column.includes("(") ||
                              order.column.includes("RANDOM") ||
                              order.column.includes("RAND(")
                                  ? order.column
                                  : g.quote(columns);

                          return `${column} ${order.direction.toUpperCase()}`;
                      })
                      .join(", ")}`
                : "";
        const limit: string = this.limitCount !== null ? " LIMIT ?" : "";
        const offset: string = this.offsetCount !== null ? " OFFSET ?" : "";
        const core: string = [select, joins, wherePart.sql, groups, havings]
            .filter((part: string) => part.length > 0)
            .map((part: string) => part.trim())
            .join(" ");
        const tailBindings: Array<any> = [
            ...this.orders.flatMap((order: OrderClause) => order.bindings || []),
            ...(this.limitCount !== null ? [this.limitCount] : []),
            ...(this.offsetCount !== null ? [this.offsetCount] : [])
        ];

        if (this._unions.length > 0) {
            const unions: Array<string> = [];
            const unionBindings: Array<any> = [];

            for (const union of this._unions) {
                const sub: CompiledQuery = union.query.compileSelect();

                unions.push(`UNION ${union.all ? "ALL " : ""}${sub.sql}`);
                unionBindings.push(...sub.bindings);
            }

            const combined: string = `${core} ${unions.join(" ")}`;
            const appended: string = [orders, limit, offset, this.lockSql().trim()]
                .filter((part: string) => part.length > 0)
                .map((part: string) => part.trim())
                .join(" ");

            if (appended.length > 0)
                return {
                    sql: `SELECT * FROM (${combined}) AS ${g.quote("bejibun_union")}${appended.length > 0 ? ` ${appended}` : ""}`,
                    bindings: [
                        ...this._selectBindings,
                        ...this._fromBindings,
                        ...this.joins.flatMap((join: JoinClause) => join.bindings || []),
                        ...wherePart.bindings,
                        ...this._groupBindings,
                        ...this.havings.flatMap((having: HavingClause) => having.bindings),
                        ...unionBindings,
                        ...tailBindings
                    ]
                };

            return {
                sql: combined,
                bindings: [
                    ...this._selectBindings,
                    ...this._fromBindings,
                    ...this.joins.flatMap((join: JoinClause) => join.bindings || []),
                    ...wherePart.bindings,
                    ...this._groupBindings,
                    ...this.havings.flatMap((having: HavingClause) => having.bindings),
                    ...unionBindings
                ]
            };
        }

        return {
            sql: [core, orders, limit, offset, this.lockSql().trim()]
                .filter((part: string) => part.length > 0)
                .map((part: string) => part.trim())
                .join(" "),
            bindings: [
                ...this._selectBindings,
                ...this._fromBindings,
                ...this.joins.flatMap((join: JoinClause) => join.bindings || []),
                ...wherePart.bindings,
                ...this._groupBindings,
                ...this.havings.flatMap((having: HavingClause) => having.bindings),
                ...tailBindings
            ]
        };
    }

    /**
     * Compiles a driver-specific JSON containment expression.
     *
     * @param {string} column - The JSON column.
     * @param {any} value - The value(s) to look for.
     * @returns {CompiledQuery} The compiled expression and its bindings.
     */
    protected compileJsonContains(column: string, value: any): CompiledQuery {
        const g: Grammar = this.grammar;
        const driver: string = g.driverName();
        const columnSql: string = g.quote(column);
        const singleObject: boolean =
            value !== null &&
            typeof value === "object" &&
            !Array.isArray(value) &&
            Object.keys(value).length === 1;

        // Path form: single-key object → match the nested value.
        if (singleObject) {
            const [key, nestedValue]: [string, any] = Object.entries(value)[0];

            switch (driver) {
                case DatabaseDriverEnum.Pg:
                    return {
                        sql: `(${columnSql} #>> '{${key}}') = ?::text`,
                        bindings: [nestedValue]
                    };
                case DatabaseDriverEnum.Mysql:
                    return {
                        sql: `JSON_CONTAINS(${columnSql}, ?, '$.${key}')`,
                        bindings: [JSON.stringify(nestedValue)]
                    };
                default:
                    return {
                        sql: `JSON_EXTRACT(${columnSql}, ?) = ?`,
                        bindings: [`$.${key}`, nestedValue]
                    };
            }
        }

        switch (driver) {
            case DatabaseDriverEnum.Pg:
                if (Array.isArray(value) || (value !== null && typeof value === "object"))
                    return {
                        sql: `(${columnSql}::jsonb @> ?::jsonb)`,
                        bindings: [JSON.stringify(value)]
                    };

                return {
                    sql: `EXISTS (SELECT 1 FROM JSONB_ARRAY_ELEMENTS(${columnSql}::jsonb) e WHERE e.value::text = ?::text)`,
                    bindings: [JSON.stringify(value)]
                };
            case DatabaseDriverEnum.Mysql:
                return {
                    sql: `JSON_CONTAINS(${columnSql}, ?)`,
                    bindings: [JSON.stringify(value)]
                };
            default: {
                // SQLite: array → every element must exist; scalar → any match.
                if (Array.isArray(value)) {
                    const checks: Array<string> = [];
                    const bindings: Array<any> = [];

                    for (const item of value) {
                        checks.push(
                            `EXISTS (SELECT 1 FROM JSON_EACH(${columnSql}) WHERE json_each.value = ?)`
                        );
                        bindings.push(
                            item !== null && typeof item === "object" ? JSON.stringify(item) : item
                        );
                    }

                    return {
                        sql: `(${checks.join(" AND ")})`,
                        bindings
                    };
                }

                return {
                    sql: `EXISTS (SELECT 1 FROM JSON_EACH(${columnSql}) WHERE json_each.value = ?)`,
                    bindings: [value]
                };
            }
        }
    }

    /**
     * Compiles an UPDATE statement.
     *
     * @param {Record<string, any>} values - The columns to set.
     * @returns {CompiledQuery} The compiled update.
     */
    protected compileUpdate(values: Record<string, any>): CompiledQuery {
        const g: Grammar = this.grammar;
        const sets: Array<string> = [];
        const setBindings: Array<any> = [];

        for (const [column, value] of Object.entries(values)) {
            if (isNotEmpty(value) && typeof value === "object" && "raw" in value) {
                sets.push(`${g.quote(column)} = ${this.literal(value)}`);
            } else {
                sets.push(`${g.quote(column)} = ?`);
                setBindings.push(value);
            }
        }

        const wherePart: CompiledQuery = this.compileWheres();

        return {
            sql: `UPDATE ${g.quote(this.fromTable!)} SET ${sets.join(", ")}${wherePart.sql}`.replace(
                /\s+/g,
                " "
            ),
            bindings: [...setBindings, ...wherePart.bindings]
        };
    }

    /**
     * Compiles a DELETE statement.
     *
     * @returns {CompiledQuery} The compiled delete.
     */
    protected compileDelete(): CompiledQuery {
        const wherePart: CompiledQuery = this.compileWheres();

        return {
            sql: `DELETE FROM ${this.grammar.quote(this.fromTable!)}${wherePart.sql}`.replace(
                /\s+/g,
                " "
            ),
            bindings: wherePart.bindings
        };
    }

    /**
     * Builds a structural signature for the builder's SELECT state, used to
     * memoize compilation. Returns `null` for states that embed other builders
     * or raw expressions (nested/sub/exists wheres, raw values, unions,
     * subquery joins), which are recompiled every time to stay correct.
     * Subclasses can extend this signature with their own state, preserving
     * `null` when the base query is not cacheable, or return `null` to opt out.
     *
     * @returns {string | null} The signature, or `null` when the state is not cacheable.
     */
    protected compileSignature(): string | null {
        if (this._unions.length > 0) return null;

        for (const where of this.wheres) {
            if (where.type === "nested" || where.type === "exists" || where.type === "sub")
                return null;

            if (where.value instanceof Raw) return null;
        }

        for (const join of this.joins) {
            if (typeof join.second === "object" && join.second !== null) return null;
        }

        const valueText = (value: any): string => {
            try {
                return JSON.stringify(value);
            } catch {
                return String(value);
            }
        };

        const whereText: string = this.wheres
            .map(
                (where: WhereClause) =>
                    `${where.type}:${where.column ?? ""}:${where.operator ?? ""}:${valueText(where.value ?? where.sql ?? where.values ?? null)}`
            )
            .join("|");
        const joinText: string = this.joins
            .map(
                (join: JoinClause) =>
                    `${join.type}:${join.table}:${join.first ?? ""}:${join.operator ?? ""}:${join.second ?? ""}:${Array.isArray(join.bindings) ? valueText(join.bindings) : ""}`
            )
            .join("|");
        const orderText: string = this.orders
            .map((order: OrderClause) => `${order.column ?? ""}:${order.direction ?? ""}`)
            .join("|");
        const havingText: string = this.havings
            .map(
                (having: HavingClause | any) =>
                    `${having.type ?? ""}:${having.column ?? ""}:${having.operator ?? ""}:${valueText(having.value ?? having.sql ?? null)}`
            )
            .join("|");

        return [
            this.fromTable,
            this.columns.join(","),
            this.distinct,
            this.limitCount,
            this.offsetCount,
            this.lockMode,
            this.wheres.length,
            whereText,
            JSON.stringify(this._fromBindings),
            JSON.stringify(this._selectBindings),
            JSON.stringify(this._groupBindings),
            this.joins.length,
            joinText,
            orderText,
            this.groups.join("|"),
            this.havings.length,
            havingText
        ].join("\u0000");
    }

    /** Clears memoized compilation after a subclass changes untracked state. */
    protected invalidateCompileCache(): void {
        this._compileCache = undefined;
    }

    /**
     * Executes the compiled SELECT and returns raw rows, bypassing model
     * hydration. Used by column/aggregate terminals (`value`, `pluck`,
     * `count`, ...) that must read plain columns even on a model query.
     *
     * @returns {Promise<Array<T>>} The raw rows.
     */
    protected async fetch<T = Record<string, any>>(): Promise<Array<T>> {
        const compiled: CompiledQuery = this.toSql();
        const rows: Array<Record<string, any>> = await this.grammar.run<Array<Record<string, any>>>(
            compiled.sql,
            compiled.bindings
        );

        // MySQL/PostgreSQL return correlated aggregate aliases (withSum,
        // withCount, ...) as DECIMAL/NUMERIC strings while SQLite returns
        // numbers -- normalize numeric-shaped values so all drivers agree.
        if (this._withAggregateAliases.length > 0) {
            for (const row of rows) {
                for (const alias of this._withAggregateAliases) {
                    const raw: any = row[alias];

                    if (typeof raw === "string" && /^-?\d+(\.\d+)?$/.test(raw)) {
                        row[alias] = Number(raw);
                    } else if (typeof raw === "boolean") {
                        // EXISTS aliases come back as booleans on pg, 1/0 on mysql/sqlite.
                        row[alias] = raw ? 1 : 0;
                    }
                }
            }
        }

        // Opt-in PG bigint normalization (connection `options.bigIntAsNumber`):
        // Bun returns INT8/BIGINT as text; convert integer-shaped strings that
        // fit in the safe-integer range so ids/counts are numbers. Values beyond
        // Number.MAX_SAFE_INTEGER (and non-integer numerics) stay untouched -- the
        // driver has already rounded them.
        if (this.grammar.returnsBigIntAsNumber()) {
            for (const row of rows) {
                for (const key of Object.keys(row)) {
                    const raw: any = row[key];

                    if (
                        typeof raw === "string" &&
                        /^-?\d+$/.test(raw) &&
                        0 <= raw.length &&
                        raw.length <= 17
                    ) {
                        const numeric: number = Number(raw);

                        if (Number.isSafeInteger(numeric)) row[key] = numeric;
                    }
                }
            }
        }

        return rows as Array<T>;
    }

    /**
     * Runs a raw aggregate and returns its value.
     *
     * @param {Uppercase<Exclude<AggregateType, "exists">>} fn - The aggregate function name.
     * @param {string} column - The column.
     * @returns {Promise<any>} The aggregate value.
     */
    private async aggregate(
        fn: Uppercase<Exclude<AggregateType, "exists">>,
        column: string
    ): Promise<any> {
        const rows: Array<Record<string, any>> = await this.clone()
            .select(`${fn}(${this.grammar.quote(column)}) AS aggregate`)
            .fetch<Record<string, any>>();
        const value: any = rows[0]?.aggregate;

        // MySQL and PostgreSQL return arithmetic aggregates as DECIMAL/NUMERIC
        // strings (sum, avg, and max/min over bigint columns), while SQLite
        // returns real numbers. Normalize numeric-shaped strings so callers get
        // a consistent number across drivers without corrupting string max()es.
        if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value)) return Number(value);

        return value;
    }

    /**
     * Wraps a MySQL write+read in a session-pinned transaction.
     *
     * LAST_INSERT_ID() / ROW_COUNT() are session-local, and Bun's SQL pool
     * routes each statement to an arbitrary pooled client. Stepping outside a
     * transaction would read another connection's value (we measured 5
     * distinct ids for 50 concurrent inserts, and ROW_COUNT() coming back 0).
     * Running the pair inside a transaction pins one session for the duration.
     *
     * @param {() => Promise<T>} task - The write+read pair.
     * @returns {Promise<T>} The task result.
     */
    private async mysqlPinned<T>(task: () => Promise<T>): Promise<T> {
        if (this.grammar.driverName() !== DatabaseDriverEnum.Mysql || currentTransaction())
            return task();

        return DB.transaction<T>(task);
    }

    /**
     * Adds a nested WHERE group from a callback.
     *
     * @param {any} callback - Receives a child builder.
     * @param {BooleanOperator} [boolean] - `and` or `or`.
     * @returns {QueryBuilder} This builder, for chaining.
     */
    private whereNested(callback: any, boolean: BooleanOperator = "and"): QueryBuilder {
        const child: QueryBuilder = new QueryBuilder(undefined, {
            grammar: this.grammar
        });

        callback(child);

        this.wheres.push({
            type: "nested",
            nested: child,
            boolean
        });

        return this;
    }

    /**
     * Filters by a date-part function (DATE, DAY, MONTH, YEAR, TIME).
     *
     * @param {string} column - The column.
     * @param {string} fn - The date function (DATE, DAY, MONTH, YEAR, TIME).
     * @param {any} operator - Operator or value.
     * @param {any} [value] - The value.
     * @param {BooleanOperator} [boolean] - `and` or `or`.
     * @returns {QueryBuilder} This builder, for chaining.
     */
    private whereDatePart(
        column: string,
        fn: string,
        operator: any,
        value?: any,
        boolean: BooleanOperator = "and"
    ): QueryBuilder {
        if (value === undefined && operator !== undefined) {
            value = operator;
            operator = "=";
        }

        this.wheres.push({
            type: "date-part",
            column,
            operator,
            value,
            boolean,
            dateFunction: fn
        });

        return this;
    }

    /**
     * Internal helper that resolves a relation and pushes an EXISTS/NOT
     * EXISTS clause onto this builder.
     *
     * @param {string} relation - Relation name.
     * @param {boolean} not - Whether it is NOT EXISTS.
     * @param {BooleanOperator} boolean - `and` or `or`.
     * @param {QueryBuilderCallback} [callback] - Optional constraints on the relation query.
     * @param {string} operator - Comparison operator for the count form.
     * @param {number} count - Threshold count for the count form.
     */
    private relationExists(
        relation: string,
        not: boolean,
        boolean: BooleanOperator,
        callback?: QueryBuilderCallback,
        operator: string = ">=",
        count: number = 1
    ): void {
        if (!this._relationResolver)
            throw new RelationException(
                `Relation queries require a relation resolver -- use Model.query() / Model.${relation}().`
            );

        const rel: any = this._relationResolver(relation);
        const parentTable: string = this.fromTable!;

        this.whereExists(
            (sub: QueryBuilder) => {
                rel.applyExistenceQuery(sub, parentTable, operator, count);

                if (callback) callback(sub);

                return sub;
            },
            not,
            boolean
        );
    }

    /**
     * Appends a correlated aggregate subquery to the selected columns.
     *
     * @param {AggregateType} aggregate - The aggregate function (`count`, `sum`, `max`,
     * `min`, `avg`, or `exists`).
     * @param {Array<string> | Record<string, any>} relations - Relation name(s) or `{name: opts}` map.
     * @param {string} [column] - Column to aggregate (array form).
     * @returns {QueryBuilder} This builder, for chaining.
     */
    private addAggregate(
        aggregate: AggregateType,
        relations: Array<string> | Record<string, any>,
        column?: string
    ): QueryBuilder {
        const entries: Array<[string, any]> = Array.isArray(relations)
            ? relations.map((name: string) => [name, {}])
            : Object.entries(relations);

        for (const [name, opts] of entries) {
            const g: Grammar = this.grammar;
            const alias: string =
                aggregate === "exists"
                    ? `${name}_exists`
                    : aggregate === "count"
                      ? `${name}_count`
                      : `${name}_${aggregate}_${opts.column || column || "id"}`;

            this._withAggregateAliases.push(alias);

            if (opts.query) {
                this.columns.push(`${opts.query} AS ${g.quote(alias)}`);

                continue;
            }

            const aggColumn: string = opts.column || column || "id";
            const table: string = opts.table || name;
            const foreignKey: string = opts.foreignKey || "parent_id";
            const localKey: string = opts.localKey || "id";
            const quotedTable: string = g.quote(table);
            const owner: string = `${g.quote(this.fromTable!)}.${g.quote(localKey)}`;
            const joinOn: string = `${quotedTable}.${g.quote(foreignKey)} = ${owner}`;

            let expression: string;

            switch (aggregate) {
                case "exists":
                    expression = `EXISTS (SELECT 1 FROM ${quotedTable} WHERE ${joinOn})`;
                    break;
                case "count":
                    expression = `(SELECT COUNT(*) FROM ${quotedTable} WHERE ${joinOn})`;
                    break;
                default:
                    expression = `(SELECT COALESCE(${aggregate.toUpperCase()}(${g.quote(aggColumn)}), 0) FROM ${quotedTable} WHERE ${joinOn})`;
                    break;
            }

            this.columns.push(`${expression} AS ${g.quote(alias)}`);
        }

        return this;
    }

    /**
     * Normalizes a driver-returned count (string/number) into a number.
     *
     * @param {any} value - The raw count value.
     * @returns {number} The normalized count.
     */
    private normalizeCount(value: any): number {
        if (typeof value === "number") return value;

        if (typeof value === "string") {
            const parsed: number = parseInt(value, 10);

            return Number.isNaN(parsed) ? 0 : parsed;
        }

        return Number(value) || 0;
    }

    /**
     * Renders a single value into a SQL literal or `?` placeholder.
     *
     * @param {any} value - The value.
     * @returns {string} The literal/placeholder.
     */
    private literal(value: any): string {
        if (isNotEmpty(value) && typeof value === "object" && "raw" in value)
            return value.raw as string;

        return "?";
    }

    /**
     * Extracts an affected-row count from a driver statement result.
     *
     * @param {Array<any>} result - The raw driver result.
     * @returns {number} The affected rows.
     */
    private affectedRows(result: Array<any>): number {
        const first: any = result?.[0];

        if (result && typeof (result as any).length !== "number" && !Array.isArray(result)) {
            const anyResult: any = result;

            return (
                Number(anyResult.affectedRows) ||
                Number(anyResult.changes) ||
                Number(anyResult.meta?.affectedRows) ||
                Number(anyResult.count) ||
                0
            );
        }

        if (typeof first === "object" && first !== null)
            return (
                Number(first.affectedRows) ||
                Number(first.changes) ||
                Number(first.meta?.affectedRows) ||
                (result && Number((result as any).count)) ||
                (Array.isArray(result) && result.length) ||
                0
            );

        const count: number = result && Number((result as any).count);

        return Array.isArray(result) ? count || result.length : 0;
    }

    /**
     * Resolves the affected-row count, recovering missing MySQL metadata via
     * session-local ROW_COUNT(). Call inside mysqlPinned() so the write and
     * fallback query use the same connection.
     *
     * @param {Array<any>} result - The raw driver result.
     * @returns {Promise<number>} The affected rows.
     */
    private async resolveAffectedRows(result: Array<any>): Promise<number> {
        const count: number = this.affectedRows(result);

        if (this.grammar.driverName() !== DatabaseDriverEnum.Mysql || count !== 0) return count;

        const rows: Array<any> = await this.grammar.run("SELECT ROW_COUNT() AS cnt");

        return Number(rows?.[0]?.cnt) || 0;
    }
}
