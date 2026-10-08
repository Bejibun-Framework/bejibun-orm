import type {EagerLoadRelation, EagerLoadSpec, ModelEventCallback} from "@/types/model";
import Logger from "@bejibun/logger";
import Luxon from "@bejibun/utils/facades/Luxon";
import Relation from "@/bases/Relation";
import QueryBuilder from "@/builders/QueryBuilder";
import RelationException from "@/exceptions/RelationException";

const MODEL_PROXY_HANDLERS: ProxyHandler<Model<any>> = {
    get: (target: Model<any>, prop: PropertyKey, receiver: any): any => {
        if (typeof prop === "symbol") return Reflect.get(target, prop, receiver);

        const key: string = prop as string;

        if (key.startsWith("_")) return Reflect.get(target, key, receiver);

        if (Object.prototype.hasOwnProperty.call((target as any)._relations, key)) {
            const cached: any = (target as any)._relations[key];

            if (Array.isArray(cached)) return (target as any).call;
        }
    }
};

export default class Model<T = Record<string, any>> {
    public static tableName: string;
    public static idColumn: string = "id";
    public static createdColumn: string | null = "created_at";
    public static updatedColumn: string | null = "updated_at";
    public static lockVersionColumn: string | null = null;
    public static connectionName?: string;
    public static casts: Record<string, string> = {};
    public static hidden: Array<string> = [];
    public static fillable: Array<string> = [];
    public static guarded: Array<string> = [];
    public static visible: Array<string> = [];
    public static appends: Array<string> = [];
    public static dateFormat: string = "yyyy-MM-dd HH:mm:ss.SSS";
    public static timestampsEnabled: boolean = true;
    public static touches: Array<string> = [];
    public static lazyLoadingPreventionEnabled: boolean = false;

    protected static __events: Record<string, Array<ModelEventCallback>> = {};
    protected static __globalScopes: Array<{
        name?: string;
        scope: (builder: QueryBuilder) => QueryBuilder;
    }> = [];

    protected _attributes: Record<string, any> = {};
    protected _original: Record<string, any> = {};
    protected _exists: boolean = false;
    protected _saveChain?: Promise<void>;
    protected _relations?: Record<string, any> = {};
    protected _changes?: Record<string, any> = {};

    declare protected _privateHidden?: Array<string>;
    declare protected _privateAppends?: Array<string>;

    public constructor(attributes: Record<string, any> = {}) {
        this.fill(attributes);

        return new Proxy(this);
    }

    public setAttribute(key: string, value: any): void {
        this._attributes[key] = this.castIncoming(key, value);
    }

    public fill(attributes: Record<string, any>): this {
        const allowed: Array<string> = (this.constructor as any).fillable;
        const guarded: Array<string> = (this.constructor as any).guarded || [];

        for (const [key, value] of Object.entries(attributes)) {
            if (allowed.length > 0) {
                if (!allowed.includes(key)) continue;
            } else if (guarded.length > 0) {
                if (guarded.includes("*") || guarded.includes(key)) continue;
            }

            this.setAttribute(key, value);
        }

        return this;
    }

    protected proxyHandlers(): ProxyHandler<Model<any>> {
        return;
    }

    protected castIncoming(key: string, value: any): any {
        const cast: string | undefined = (this.constructor as any).casts?.[key];

        if (!cast || value === null || value === undefined) return value;

        switch (cast) {
            case "int":
            case "integer":
                return parseInt(value, 10);
            case "float":
            case "double":
            case "decimal":
                return parseFloat(value);
            case "bool":
            case "boolean":
                return value === true || value === 1 || value === "1" || value === "true";
            case "json":
            case "array":
            case "object":
                return typeof value === "string" ? JSON.parse(value) : value;
            case "datetime":
            case "timestamp":
                return typeof value === "string" || typeof value === "number"
                    ? Luxon.DateTime.fromJSDate(new Date(value))
                    : value;
            default:
                return value;
        }
    }

    protected relationAccessor(target: any, key: string): any {
        const method: any = (target.constructor?.prototype || {})[key];

        const accessor: any = (...args: Array<any>) => {
            const relation: any = Reflect.apply(method, target, args);

            if (relation instanceof Relation) relation.name = key;

            return relation;
        };

        accessor.__isRelation = (): boolean => {
            return method instanceof Relation;
        };

        accessor.then = (resolve: any, reject: any): Promise<any> => {
            const modelClass: any = (target as any).constructor;

            if (modelClass?.lazyLoadingPreventionEnabled === true) {
                const error: Error = new RelationException(
                    `Attempted to lazy load relation [${key}] on [${modelClass.name}] but lazy loading has been prevented.`
                );

                reject(error);

                return Promise.resolve();
            }

            const relation: any = Reflect.apply(method, target, []);

            relation.name = key;

            return relation.then(resolve, reject);
        };

        return accessor;
    }

    protected callableRelation(target: any, key: string, cached: Array<any>): Array<any> {
        const accessor: any = this.relationAccessor(target, key);

        const proxy: any = new Proxy(accessor, {
            get: (t: any, prop: any): any => {
                if (prop === "then") {
                    return (resolve: any, reject: any): Promise<any> => {
                        return Promise.resolve(cached).then(resolve, reject);
                    };
                }

                if (prop in cached) return Reflect.get(t, prop, cached);

                const value: any = Reflect.get(t, prop, t);

                return typeof value === "function" ? value.bind(t) : value;
            }
        });

        return proxy as Array<any>;
    }

    public async load(relation: string): Promise<any> {
        const accessor: any = this.relationAccessor(this, relation);
        const result: any = await accessor;

        return result;
    }

    public static async eagerLoad(
        models: Array<any>,
        ...relations: Array<EagerLoadRelation>
    ): Promise<void> {
        if (models.length === 0 || relations.length === 0) return;

        const specs: Array<EagerLoadSpec> = relations.map((entry: EagerLoadRelation) =>
            typeof entry === "string" ? {relation: entry} : entry
        );

        const groups: Map<
            string,
            {
                constraints?: (builder: QueryBuilder) => any;
                children: Array<EagerLoadSpec>;
            }
        > = new Map<
            string,
            {
                constraints?: (builder: QueryBuilder) => any;
                children: Array<EagerLoadSpec>;
            }
        >();

        for (const spec of specs) {
            const segments: Array<string> = spec.relation.split(".");
            const root: string = segments[0];
            const rest: Array<string> = segments.slice(1);

            const group = groups.get(root) || {
                children: []
            };

            if (rest.length === 0) {
                group.constraints = group.constraints || spec.constraints;
            } else {
                group.children.push({
                    relation: rest.join("."),
                    constraints: spec.constraints
                });
            }

            groups.set(root, group);
        }

        const rootTasks: Array<Promise<void>> = [];

        for (const [root, group] of groups) {
            rootTasks.push(
                (async (): Promise<void> => {
                    const model: any = new (this as any)();
                    const accessor: any = model.relationAccessor(model, root);

                    let relation: any;

                    try {
                        relation = accessor();
                    } catch {
                        Logger.setContext("ORM").warn(
                            `Relation ${root} not defined on ${this.name}.`
                        );

                        return;
                    }

                    await relation.eagerLoad(models, root, group.constraints);

                    if (group.children.length > 0) {
                        const children: Array<any> = models.flatMap(
                            (m: any) => m._relations?.[root] || []
                        );

                        if (children.length > 0) {
                            const childClass: any = (children[0] as any).constructor;

                            await childClass.eagerLoad(children, ...group.children);
                        }
                    }
                })()
            );
        }

        await Promise.all(rootTasks);
    }

    public static query(): QueryBuilder {
        const builder: QueryBuilder = new QueryBuilder(this.tableName);

        builder._modelClass = this;
        builder.setRelationResolver((name: string) => this.resolveRelation(name));

        this.applyScopes(builder, (this as any).__globalScopes || []);

        return this.applyModelDecorators(builder);
    }

    public static async all(...relations: Array<string>): Promise<Array<any>> {
        const models: Array<any> = await this.qu;
    }

    public static async with(...relations: Array<EagerLoadRelation>): Promise<Array<Model>> {
        const models: Array<any> = await this.all();
    }

    protected static resolveRelation(name: string): Relation {
        const model: any = new (this as any)();
        const accessor: any = model.relationAccessor(model, name);
        const relation: any = accessor();

        if (!(relation instanceof Relation))
            throw new RelationException(`Relation "${name}" is not defined on ${this.name}.`);

        return relation;
    }

    protected static applyScopes(
        builder: QueryBuilder,
        scopes: Array<{
            name?: string;
            scope: (builder: QueryBuilder) => QueryBuilder;
        }>
    ): QueryBuilder {
        for (const entry of scopes) entry.scope(builder);

        return builder;
    }

    protected static applyModelDecorators(builder: QueryBuilder): QueryBuilder {
        return builder;
    }
}
