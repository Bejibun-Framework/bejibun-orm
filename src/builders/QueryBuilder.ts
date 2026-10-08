import type {Database} from "bun:sqlite";
import type {EagerLoadSpec} from "@/types/model";
import type {
    BooleanOperator,
    CompiledQuery,
    HavingClause,
    JoinClause,
    OrderClause,
    QueryBuilderCallback,
    UnionClause,
    WhereClause,
    WhereInValues
} from "@/types/query";
import Grammar from "@/builders/Grammar";
import DatabaseDriverEnum from "@/enums/DatabaseDriverEnum";
import DB from "@/facades/DB";
import Raw from "@/builders/Raw";

export default class QueryBuilder {
    public readonly grammar: Grammar;

    public _modelClass?: any;

    protected fromTable: string | null = null;
    protected columns: Array<string> = [];
    protected distinct: boolean = false;
    protected wheres: Array<WhereClause> = [];
    protected joins: Array<JoinClause> = [];
    protected groups: Array<string> = [];
    protected _groupBindings: Array<any> = [];
    protected havings: Array<HavingClause> = [];
    protected orders: Array<OrderClause> = [];
    protected limitCount: number | null = null;
    protected offsetCount: number | null = null;
    protected lockMode: boolean | string | null = null;
    protected _unions: Array<UnionClause> = [];
    protected _relationResolver?: (name: string) => any;
    protected _eagerLoads: Array<EagerLoadSpec> = [];
    protected _compileCache?: {
        signature: string;
        result: CompiledQuery;
    };
    protected _fromBindings: Array<any> = [];
    protected _selectBindings: Array<any> = [];
    protected _withAggregateAliases: Array<string> = [];

    public constructor(table?: string, connection?: any) {
        this.fromTable = table || null;

        const keep: boolean =
            (connection !== undefined &&
                connection !== null &&
                (connection as any)?.unsafe !== undefined) ||
            connection instanceof Database ||
            ((connection as any)?.options !== undefined && !(connection as any)?.unsafe);
        const resolved: any = keep ? connection : (DB.connection?.() ?? connection);

        this.grammar = new Grammar(resolved);
    }

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

    public from(table: string | QueryBuilder | QueryBuilderCallback, alias?: string): QueryBuilder {
        if (typeof table === "function" || table instanceof QueryBuilder)
            return this.fromSub(table, alias || "sub");

        this.fromTable = table;
        this._fromBindings = [];
        this._compileCache = undefined;

        return this;
    }

    public table(table: string): QueryBuilder {
        return this.from(table);
    }

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

    public selectRaw(expression: string, bindings: Array<any> = []): QueryBuilder {
        this.columns.push(expression);
        this._selectBindings.push(...bindings);

        return this;
    }

    public selectSub(query: QueryBuilder, as: string): QueryBuilder {
        const compiled: CompiledQuery = query.compileSelect();
        const sql: string = `(${compiled.sql}) AS ${this.grammar.quote(as)}`;

        this.columns.push(sql);
        this._selectBindings.push(...compiled.bindings);

        return this;
    }

    public distinctQuery(): QueryBuilder {
        this.distinct = true;

        return this;
    }

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

    public whereNotNull(columns: string | Array<string>): QueryBuilder {
        return this.whereNull(columns, "and", true);
    }

    public orWhereNull(columns: string | Array<string>): QueryBuilder {
        return this.whereNull(columns, "or");
    }

    public orWhereNotNull(columns: string | Array<string>): QueryBuilder {
        return this.whereNull(columns, "or", true);
    }

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

    public whereNotSub(
        column: string,
        query: QueryBuilder | Raw | QueryBuilderCallback
    ): QueryBuilder {
        return this.whereSub(column, query, "and", true);
    }

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

    public orWhereRaw(sql: string, bindings: Array<any> = []): QueryBuilder {
        return this.whereRaw(sql, bindings, "or");
    }

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

    public whereNotIn(column: string, values: WhereInValues): QueryBuilder {
        return this.whereIn(column, values, "and", true);
    }

    public orWhereIn(column: string, values: WhereInValues): QueryBuilder {
        return this.whereIn(column, values, "or");
    }

    public orWhereNotIn(column: string, values: WhereInValues): QueryBuilder {
        return this.whereIn(column, values, "or", true);
    }

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

    public orWhere(column: any, operator?: any, value?: any): QueryBuilder {
        if (value === undefined && operator !== undefined) {
            value = operator;
            operator = "=";
        }

        return this.where(column, operator, value, "or");
    }

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

    public whereNotBetween(column: string, min: any, max: any): QueryBuilder {
        return this.whereBetween(column, min, max, "and", true);
    }

    public orWhereBetween(column: string, min: any, max: any): QueryBuilder {
        return this.whereBetween(column, min, max, "or");
    }

    public orWhereNotBetween(column: string, min: any, max: any): QueryBuilder {
        return this.whereBetween(column, min, max, "or", true);
    }

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

    public orWhereColumn(first: string, operator?: string, second?: string): QueryBuilder {
        return this.whereColumn(first, operator, second, "or");
    }

    public whereDate(column: string, operator: any, value?: any): QueryBuilder {
        return this.whereDatePart(column, "DATE", operator, value);
    }

    public orWhereDate(column: string, operator: any, value?: any): QueryBuilder {
        return this.whereDatePart(column, "DATE", operator, value, "or");
    }

    public whereDay(column: string, operator: any, value?: any): QueryBuilder {
        return this.whereDatePart(column, "DAY", operator, value);
    }

    public orWhereDay(column: string, operator: any, value?: any): QueryBuilder {
        return this.whereDatePart(column, "DAY", operator, value, "or");
    }

    public whereMonth(column: string, operator: any, value?: any): QueryBuilder {
        return this.whereDatePart(column, "MONTH", operator, value);
    }

    public orWhereMonth(column: string, operator: any, value?: any): QueryBuilder {
        return this.whereDatePart(column, "MONTH", operator, value, "or");
    }

    public whereYear(column: string, operator: any, value?: any): QueryBuilder {
        return this.whereDatePart(column, "YEAR", operator, value);
    }

    public orWhereYear(column: string, operator: any, value?: any): QueryBuilder {
        return this.whereDatePart(column, "YEAR", operator, value, "or");
    }

    public whereTime(column: string, operator: any, value?: any): QueryBuilder {
        return this.whereDatePart(column, "TIME", operator, value);
    }

    public orWhereTime(column: string, operator: any, value?: any): QueryBuilder {
        return this.whereDatePart(column, "TIME", operator, value, "or");
    }

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

    public whereNotExists(
        callback: QueryBuilderCallback,
        boolean: BooleanOperator = "and"
    ): QueryBuilder {
        return this.whereExists(callback, true, boolean);
    }

    public when(
        condition: any,
        callback: QueryBuilderCallback,
        fallback: QueryBuilderCallback
    ): QueryBuilder {
        if (condition) return callback(this);

        if (fallback) return fallback(this);

        return this;
    }

    public unless(
        condition: any,
        callback: QueryBuilderCallback,
        fallback: QueryBuilderCallback
    ): QueryBuilder {
        if (!condition) return callback(this);

        if (fallback) return fallback(this);

        return this;
    }

    public setRelationResolver(resolver: (name: string) => any): QueryBuilder {
        this._relationResolver = resolver;

        return this;
    }

    protected clone(): QueryBuilder {
        const copy: QueryBuilder = new QueryBuilder(this.fromTable ?? undefined, {
            grammar: this.grammar
        });

        copy._modelClass = this._modelClass;
        copy._relationResolver = this._relationResolver;
        copy.columns = [...this.columns];
        copy.distinct = this.distinct;
        copy.wheres = this.wheres.map((where: WhereClause) => ({
            ...where,
            ...(where.nested
                ? {
                      nested: where.nested.clone()
                  }
                : {})
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
        copy._compileCache = undefined;

        return copy;
    }

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

    protected dateFunctionSql(fn: string, column: string): string {
        const driver: string = this.grammar.driverName();
        const quoted: string = this.grammar.quote(column);

        if (driver === DatabaseDriverEnum.Pg) {
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
                    return `strftime('%d', ${quoted})`;
                case "MONTH":
                    return `strftime('%m', ${quoted})`;
                case "YEAR":
                    return `strftime('%Y', ${quoted})`;
                case "TIME":
                    return `strftime('%H:%M:%S', ${quoted})`;
                default:
                    return `date(${quoted})`;
            }
        }

        return `${fn}(${quoted})`;
    }

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
                case "in":
                    const placeholders: string = (where.values || []).map(() => "?").join(", ");

                    return `${glue} ${g.quote(where.column!)} ${where.not ? "NOT IN" : "IN"} (${placeholders})`;
                case "null":
                    return `${glue} ${g.quote(where.column!)} IS NULL`;
                case "not-null":
                    return `${glue} ${g.quote(where.column!)} IS NOT NULL`;
                case "between":
                    return `${glue} ${g.quote(where.column!)} ${where.not ? "NOT BETWEEN" : "BETWEEN"} ? AND ?`;
                case "nested":
                    const nested: CompiledQuery = where.nested!.compileWheres();
                    const inner: string = nested.sql.replace(/^\s*WHERE\s*/i, "");

                    if (inner.trim() === "") return "";

                    return `${glue} (${inner})`;
                case "raw":
                    return `${glue} ${where.sql}`;
                case "column":
                    return `${glue} ${g.quote(where.column!)} ${where.operator} ${g.quote(where.second!)}`;
                case "exists":
                    const existsSql: string = where.nested!.compileSelect().sql;

                    return `${glue} ${where.not ? "NOT " : ""}EXISTS (${existsSql})`;
                case "sub":
                    const subSql: string = where.nested!.compileSelect().sql;

                    return `${glue} ${g.quote(where.column!)} ${where.not ? "NOT IN" : "IN"} (${subSql})`;
                case "date-part":
                    return `${glue} ${this.dateFunctionSql(where.dateFunction!, where.column!)} ${where.operator} ?`;
                case "like":
                    const operator: string =
                        where.operator === "ILIKE" && g.driverName() !== DatabaseDriverEnum.Pg
                            ? "LIKE"
                            : where.operator!;

                    return `${glue} ${g.quote(where.column!)} ${operator} ?`;
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

    protected whereNested(callback: any, boolean: BooleanOperator = "and"): QueryBuilder {
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

    protected whereDatePart(
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
}
