import type {Database} from "bun:sqlite";
import type {EagerLoadSpec} from "@/types/model";
import type {CompiledQuery, HavingClause, JoinClause, OrderClause, UnionClause, WhereClause} from "@/types/query";
import Grammar from "@/builders/Grammar";
import DatabaseDriverEnum from "@/enums/DatabaseDriverEnum";
import DB from "@/facades/DB";

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

        const keep: boolean = (connection !== undefined && connection !== null && (connection as any)?.unsafe !== undefined) || connection instanceof Database || ((connection as any)?.options !== undefined && !(connection as any)?.unsafe);
        const resolved: any = keep ? connection : (DB.connection?.() ?? connection);

        this.grammar = new Grammar(resolved);
    }

    public fromSub(query: QueryBuilder | ((builder: QueryBuilder) => QueryBuilder), alias: string): QueryBuilder {
        const sub: QueryBuilder = query instanceof QueryBuilder
            ? query
            : (() => {
                const q: QueryBuilder = new QueryBuilder(undefined, {
                    grammar: this.grammar
                });

                query(q);

                return q;
            })();

        const compiled: CompiledQuery = sub.com
    }

    public from(table: string | QueryBuilder | ((builder: QueryBuilder) => QueryBuilder), alias?: string): QueryBuilder {
        if (typeof table === "function") return
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
            ...(where.nested ? {
                nested: where.nested.clone()
            } : {})
        }));
        copy.joins = this.joins.map((join: JoinClause) => ({
            ...join,
            bindings: [...(join.bindings || [])]
        }));
        copy.groups = [...this.groups];
        copy._groupBindings = [...this._groupBindings];
        copy.havings = this.havings.map((having: HavingClause) => ({
            ...having,
            bindings: [...having.bindings || []]
        }));
        copy.orders = this.orders.map((order: OrderClause) => ({
            ...order,
            bindings: [...order.bindings || []]
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

        if (/^(count|sum|min|max|avg|exists|coalesce|concat|rand|random|date|year|month|day|time)\(/i.test(column)) return column;

        if (/[()\s]/.test(column) && !/``|""/.test(column)) return column.replace(/\b(\w+)\b/g, (word: string) => g.quote(word)).replace(/["'`]/g, "");

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

    protected compileWheres(): CompiledQuery {
        if (this.wheres.length === 0) return {
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
                    const operator: string = where.operator === "ILIKE" && g.driverName() !== DatabaseDriverEnum.Pg ? "LIKE" : where.operator!;

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
        const columns: string = this.columns.length > 0 ? this.columns.map((column: string) => this.wrapColumn(column)).join(", ") : "*";
        const fromSql: string = this.fromTable ? this.fromTable.includes("(") ? this.fromTable! : g.quote(this.fromTable!) : "";
        const select: string = `${this.distinct ? "SELECT DISTINCT" : "SELECT"} ${columns}${this.fromTable ? ` FROM ${fromSql}` : ""}`;
        const joins: string = this.joins.map((join: JoinClause) => {
            if (join.type === "raw") return join.second;

            if (join.type === "cross") return `CROSS JOIN ${g.quote(join.table)}`;

            const type: string = join.type === "left" ? "LEFT JOIN" : join.type === "right" ? "RIGHT JOIN" : "INNER JOIN";

            return `${type} ${join.table.includes("(") ? join.table : g.quote(join.table)} ON ${join.first} ${join.operator} ${join.second || ""}`;
        }).join(" ");
        const wherePart: CompiledQuery = this.compileWheres();
    }
}