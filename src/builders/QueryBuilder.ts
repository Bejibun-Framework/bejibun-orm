import type {Database} from "bun:sqlite";
import type {EagerLoadSpec} from "@/types/model";
import type {
    AggregateType,
    BooleanOperator,
    CompiledQuery,
    HavingClause,
    JoinClause, JoinType,
    OrderClause, OrderDirection,
    QueryBuilderCallback,
    UnionClause,
    WhereClause,
    WhereInValues
} from "@/types/query";
import Grammar from "@/builders/Grammar";
import DatabaseDriverEnum from "@/enums/DatabaseDriverEnum";
import DB from "@/facades/DB";
import Raw from "@/builders/Raw";
import RecordNotFoundException from "@/exceptions/RecordNotFoundException";
import RelationException from "@/exceptions/RelationException";
import Collection from "@/bases/Collection";

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

    public has(relation: string, operator: string = ">=", count: number = 1): QueryBuilder {
        this.relationExists(relation, false, "and", undefined, operator, count);

        return this;
    }

    public orHas(relation: string, operator: string = ">=", count: number = 1): QueryBuilder {
        this.relationExists(relation, false, "or", undefined, operator, count);

        return this;
    }

    public whereHas(relation: string, callback?: QueryBuilderCallback, operator: string = ">=", count: number = 1): QueryBuilder {
        this.relationExists(relation, false, "and", callback, operator, count);

        return this;
    }

    public orWhereHas(relation: string, callback?: QueryBuilderCallback, operator: string = ">=", count: number = 1): QueryBuilder {
        this.relationExists(relation, false, "or", callback, operator, count);

        return this;
    }

    public doesntHave(relation: string, operator: string = ">=", count: number = 1): QueryBuilder {
        this.relationExists(relation, true, "and", undefined, operator, count);

        return this;
    }

    public orDoesntHave(relation: string, operator: string = ">=", count: number = 1): QueryBuilder {
        this.relationExists(relation, true, "or", undefined, operator, count);

        return this;
    }

    public whereDoesntHave(relation: string, callback?: QueryBuilderCallback, operator: string = ">=", count: number = 1): QueryBuilder {
        this.relationExists(relation, true, "and", callback, operator, count);

        return this;
    }

    public orWhereDoesntHave(relation: string, callback?: QueryBuilderCallback, operator: string = ">=", count: number = 1): QueryBuilder {
        this.relationExists(relation, true, "or", callback, operator, count);

        return this;
    }

    public whereRelation(relation: string, column: string, operator?: any, value?: any): QueryBuilder {
        return this.whereHas(relation, (builder: QueryBuilder) => {
            if (value === undefined && operator !== undefined) return builder.where(column, "=", operator);

            if (operator !== undefined) return builder.where(column, operator, value);

            return builder;
        });
    }

    public orWhereRelation(relation: string, column: string, operator?: any, value?: any): QueryBuilder {
        return this.orWhereHas(relation, (builder: QueryBuilder) => {
            if (value === undefined && operator !== undefined) return builder.where(column, "=", operator);

            if (operator !== undefined) return builder.where(column, operator, value);

            return builder;
        });
    }

    public whereLike(column: string, value: string, boolean: BooleanOperator = "and"): QueryBuilder {
        this.wheres.push({
            type: "like",
            column,
            operator: "LIKE",
            value,
            boolean
        });

        return this;
    }

    public whereILike(column: string, value: string, boolean: BooleanOperator = "and"): QueryBuilder {
        this.wheres.push({
            type: "like",
            column,
            operator: "ILIKE",
            value,
            boolean
        });

        return this;
    }

    public whereJsonContains(column: string, value: any, boolean: BooleanOperator = "and"): QueryBuilder {
        const compiled: CompiledQuery = this.compileJsonContains(column, value);

        this.wheres.push({
            type: "json",
            sql: compiled.sql,
            bindings: compiled.bindings,
            boolean
        });

        return this;
    }

    public orWhereJsonContains(column: string, value: any): QueryBuilder {
        return this.whereJsonContains(column, value, "or");
    }

    public whereJsonLength(column: string, operator: any, value: any, boolean: BooleanOperator = "and"): QueryBuilder {
        const g: Grammar = this.grammar;
        const columnSql: string = g.driverName() === DatabaseDriverEnum.Pg ? `(${g.quote(column)})::jsonb` : g.quote(column);
        const fn: string = g.driverName() === DatabaseDriverEnum.Mysql ? "JSON_LENGTH" : g.driverName() === DatabaseDriverEnum.Pg ? "JSONB_ARRAY_LENGTH" : "JSON_ARRAY_LENGTH";

        this.wheres.push({
            type: "json",
            sql: `${fn}(${columnSql}) ${operator} ?`,
            bindings: [value],
            boolean
        });

        return this;
    }

    public orWhereJsonLength(column: string, operator: any, value: any): QueryBuilder {
        return this.whereJsonLength(column, operator, value, "or");
    }

    public join(table: string, first: string, operator?: string, second?: any, type: JoinType = "inner"): QueryBuilder {
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

    public leftJoin(table: string, first: string, operator?: string, second?: any): QueryBuilder {
        return this.join(table, first, operator, second, "left");
    }

    public rightJoin(table: string, first: string, operator?: string, second?: any): QueryBuilder {
        return this.join(table, first, operator, second, "right");
    }

    public crossJoin(table: string, first: string, operator?: string, second?: any): QueryBuilder {
        if (first) return this.join(table, first, operator, second, "cross");

        this.joins.push({
            type: "cross",
            table,
            first: "",
            operator: "",
            second: ""
        });

        return this
    }

    public joinSub(query: QueryBuilder | QueryBuilderCallback, as: string, first: string, operator: string = "=", second?: any, type: JoinType = "inner"): QueryBuilder {
        const subQuery: QueryBuilder = typeof query === "function" ? (() => {
            const q: QueryBuilder = new QueryBuilder(undefined, {
                grammar: this.grammar
            });

            query(q);

            return q;
        })() : query;

        const compiled: CompiledQuery = subQuery.compileSelect();

        this.joins.push({
            type,
            table: `(${compiled.sql}) AS ${this.grammar.quote(as)}`,
            first: this.grammar.quote(first),
            operator,
            second: second ? this.grammar.quote(second) : undefined,
            bindings: [...compiled.bindings];
        });

        return this;
    }

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

    public groupBy(...columns: Array<string | Array<string>>): QueryBuilder {
        this.groups.push(...(columns.flat() as Array<string>));

        return this;
    }

    public groupByRaw(sql: string, bindings: Array<any> = []): QueryBuilder {
        this.groups.push(sql);
        this._groupBindings.push(...bindings);

        return this;
    }

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

    public havingRaw(sql: string, bindings: Array<any> = []): QueryBuilder {
        this.havings.push({
            sql,
            bindings
        });

        return this;
    }

    public orderBy(column: string, direction: OrderDirection = "asc"): QueryBuilder {
        this.orders.push({
            column,
            direction
        });

        return this;
    }

    public orderByDesc(column: string): QueryBuilder {
        return this.orderBy(column, "desc");
    }

    public oldest(column: string = "created_at"): QueryBuilder {
        return this.orderBy(column);
    }

    public latest(column: string = "created_at"): QueryBuilder {
        return this.orderByDesc(column);
    }

    public orderByRaw(sql: string, bindings: Array<any> = []): QueryBuilder {
        this.orders.push({
            column: sql,
            direction: "asc",
            bindings
        });

        return this;
    }

    public inRandomOrder(seed?: string): QueryBuilder {
        const driver: string = this.grammar.driverName();
        const column: string = driver === DatabaseDriverEnum.Pg ? (seed ? `RAND(${seed})` : "RAND()") : "RANDOM()";

        this.orders.push({
            column,
            direction: "asc"
        });

        return this;
    }

    public reorder(column?: string, direction: OrderDirection = "asc"): QueryBuilder {
        this.orders = [];

        if (column) this.orderBy(column, direction);

        return this;
    }

    public limit(limit: number): QueryBuilder {
        this.limitCount = limit;

        return this;
    }

    public take(n: number): QueryBuilder {
        return this.limit(n);
    }

    public offset(offset: number): QueryBuilder {
        this.offsetCount = offset;

        return this;
    }

    public skip(n: number): QueryBuilder {
        return this.offset(n);
    }

    public async get<T = Record<string, any>>(): Promise<Array<T>> {
        const rows: Array<Record<string, any>> = await this.fetch<Record<string, any>>();

        if (this._modelClass) {
            const models: Array<any> = await this._modelClass.hydrate(rows);

            if (this._eagerLoads.length > 0) await this._modelClass.eagerLoad(models, ...this._eagerLoads);

            return models as Array<T>;
        }

        return rows as Array<T>;
    }

    public async getRaw<T = Record<string, any>>(): Promise<Array<T>> {
        return this.fetch<T>();
    }

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
                if (!pending) throw new RelationException("with() constraint callback must follow a relation name.");

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
                    if (typeof item === "string") specs.push({
                        relation: item
                    });
                    else specs.push(item);
                }

                continue;
            }

            if (arg && typeof arg === "object") {
                flush();

                for (const key of Object.keys(arg)) {
                    const value: any = arg[key];

                    specs.push(typeof value === "function" ? {
                        relation: key,
                        constraints: value
                    } : {
                        relation: key
                    });
                }
            }
        }

        flush();

        this._eagerLoads.push(...specs);

        return this;
    }

    public withCount(relations: Array<string> | Record<string, any>): QueryBuilder {
        return this.addAggregate("count", relations);
    }

    public withSum(relations: Array<string> | Record<string, any>, column?: string): QueryBuilder {
        return this.addAggregate("sum", relations, column);
    }

    public withMax(relations: Array<string> | Record<string, any>, column?: string): QueryBuilder {
        return this.addAggregate("max", relations, column);
    }

    public withMin(relations: Array<string> | Record<string, any>, column?: string): QueryBuilder {
        return this.addAggregate("min", relations, column);
    }

    public withAvg(relations: Array<string> | Record<string, any>, column?: string): QueryBuilder {
        return this.addAggregate("avg", relations, column);
    }

    public withExists(relations: Array<string> | Record<string, any>): QueryBuilder {
        return this.addAggregate("exists", relations);
    }

    public async first<T = Record<string, any>>(): Promise<T | undefined> {
        const rows: Array<T> = await this.clone().limit(1).get<T>();

        return rows[0];
    }

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

    public async find<T = Record<string, any>>(id: any, columns: Array<string> = ["*"]): Promise<T | undefined> {
        return this.clone()
            .select(...columns)
            .where(this._modelClass?.idColumn ?? "id", "=", id)
            .first<T>();
    }

    public async findOrFail<T = Record<string, any>>(id: any, columns: Array<string> = ["*"], error?: any): Promise<T> {
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

    public async col<T = Record<string, any>>(): Promise<Collection<T>> {
        return new Collection<T>(await this.get<T>());
    }

    public async value(column: string): Promise<any> {
        const rows: Array<Record<string, any>> = await this.clone()
            .select(column)
            .limit(1)
            .fetch<Record<string, any>>();

        const row: Record<string, any> | undefined = rows[0];

        return row ? row[column] : undefined;
    }

    public async pluck(column: string, key?: string): Promise<Array<any> | Record<string, any>> {
        const cols: Array<string> = key ? [column, key] : [column];
        const rows: Array<Record<string, any>> = await this.clone().select(...cols).fetch<Record<string, any>>();

        if (!key) return rows.map((row: Record<string, any>) => row[column]);

        const result: Record<string, any> = Object.create(null) as Record<string, any>;

        for (const row of rows) {
            result[row[key]] = row[column];
        }

        return result;
    }

    public async pluckSorted(column: string): Promise<Array<any>> {
        const rows: Array<Record<string, any>> = await this.clone()
            .select(column)
            .orderBy(column)
            .fetch<Record<string, any>>();

        return rows.map((row: Record<string, any>) => row[column]);
    }

    public async count(column: any = "*"): Promise<number> {
        const sub: QueryBuilder = this.clone();

        sub.limitCount = null;
        sub.offsetCount = null;
        sub.orders = [];
        sub.lockMode = null;

        const inner: CompiledQuery = sub.compileSelect();
        const rows: Array<Record<string, any>> = await this.grammar.run(`SELECT COUNT(*) AS aggregate FROM (${inner.sql}) AS ${this.grammar.quote("bejibun_count")}`, inner.bindings);

        return this.normalizeCount(rows[0]?.aggregate);
    }

    public async exists(): Promise<boolean> {
        return (await this.count()) > 0;
    }

    public lock(lock: boolean | string = true): QueryBuilder {
        this.lockMode = lock;

        return this;
    }

    public lockForUpdate(): QueryBuilder {
        return this.lock();
    }

    public sharedLock(): QueryBuilder {
        return this.lock(false);
    }

    public toSql(): CompiledQuery {
        const signature: string | null = this.compileSignature();

        if (signature !== null && this._compileCache && this._compileCache.signature === signature) return this._compileCache.result;

        const result: CompiledQuery = this.compileSelect();

        if (signature !== null) this._compileCache = {
            signature,
            result
        };

        return result;
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

    protected compileJsonContains(column: string, value: any): CompiledQuery {
        const g: Grammar = this.grammar;
        const driver: string = g.driverName();
        const columnSql: string = g.quote(column);
        const singleObject: boolean = value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 1;

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
                if (Array.isArray(value) || (value !== null && typeof value === "object")) return {
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
            default:
                if (Array.isArray(value)) {
                    const checks: Array<string> = [];
                    const bindings: Array<any> = [];

                    for (const item of value) {
                        checks.push(`EXISTS (SELECT 1 FROM JSON_EACH(${columnSql}) WHERE json_each.value = ?)`);
                        bindings.push(item !== null && typeof item === "object" ? JSON.stringify(item) : item);
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

    protected compileSignature(): string | null {
        if (this._unions.length > 0) return null;

        for (const where of this.wheres) {
            if (where.type === "nested" || where.type === "exists" || where.type === "sub") return null;

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

        const whereText: string = this.wheres.map((where: WhereClause) => `${where.type}:${where.column ?? ""}:${where.operator ?? ""}:${valueText(where.value ?? where.sql ?? where.values ?? null)}`).join("|");
        const joinText: string = this.joins.map((join: JoinClause) => `${join.type}:${join.table}:${join.first ?? ""}:${join.operator ?? ""}:${join.second ?? ""}:${Array.isArray(join.bindings) ? valueText(join.bindings) : ""}`).join("|");
        const orderText: string = this.orders.map((order: OrderClause) => `${order.column ?? ""}:${order.direction ?? ""}`).join("|");
        const havingText: string = this.havings.map((having: HavingClause | any) => `${having.type ?? ""}:${having.column ?? ""}:${having.operator ?? ""}:${valueText(having.value ?? having.sql ?? null)}`).join("|");

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

    protected relationExists(relation: string, not: boolean, boolean: BooleanOperator, callback?: QueryBuilderCallback, operator: string = ">=", count: number = 1): void {
        if (!this._relationResolver) throw new RelationException(`Relation queries require a relation resolver -- use Model.query() / Model.${relation}().`);

        const rel: any = this._relationResolver(relation);
        const parentTable: string = this.fromTable!;

        this.whereExists((sub: QueryBuilder) => {
            rel.applyExistenceQuery(sub, parentTable, operator, count);

            if (callback) callback(sub);

            return sub;
        }, not, boolean);
    }

    protected async fetch<T = Record<string, any>>(): Promise<Array<T>> {
        const compiled: CompiledQuery = this.toSql();
        const rows: Array<Record<string, any>> = await this.grammar.run<Array<Record<string, any>>>(compiled.sql, compiled.bindings);

        if (this._withAggregateAliases.length > 0) {
            for (const row of rows) {
                for (const alias of this._withAggregateAliases) {
                    const raw: any = row[alias];

                    if (typeof raw === "string" && /^-?\d+(\.\d+)?$/.test(raw)) row[alias] = Number(raw);
                    else if (typeof raw === "boolean") row[alias] = raw ? 1 : 0;
                }
            }
        }

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

    protected addAggregate(aggregate: AggregateType, relations: Array<string> | Record<string, any>, column?: string): QueryBuilder {
        const entries: Array<[string, any]> = Array.isArray(relations) ? relations.map((name: string) => [name, {}]) : Object.entries(relations);

        for (const [name, opts] of entries) {
            const g: Grammar = this.grammar;
            const alias: string = aggregate === "exists" ? `${name}_exists` : aggregate === "count" ? `${name}_count` : `${name}_${aggregate}_${opts.column || column || "id"}`;

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
                    expression = `(SELECT COUNT(*) FROM  ${quotedTable} WHERE ${joinOn})`;
                    break;
                default:
                    expression = `(SELECT COALESCE(${aggregate.toUpperCase()}(${g.quote(aggColumn)}), 0) FROM ${quotedTable} WHERE ${joinOn})`;
                    break;
            }

            this.columns.push(`${expression} AS ${g.quote(alias)}`);
        }

        return this;
    }

    protected normalizeCount(value: any): number {
        if (typeof value === "number") return value;

        if (typeof value === "string") {
            const parsed: number = parseInt(value, 10);

            return Number.isNaN(parsed) ? 0 : parsed;
        }

        return Number(value) || 0;
    }
}
