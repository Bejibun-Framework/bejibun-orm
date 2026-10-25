import type {EagerLoadRelation, EagerLoadSpec, ModelEvent, ModelEventCallback} from "@/types/model";
import type {QueryBuilderCallback} from "@/types/query";
import Logger from "@bejibun/logger";
import Luxon from "@bejibun/utils/facades/Luxon";
import Relation from "@/bases/Relation";
import QueryBuilder from "@/builders/QueryBuilder";
import DatabaseDriverEnum from "@/enums/DatabaseDriverEnum";
import RelationException from "@/exceptions/RelationException";

let MODEL_METHOD_KEYS: Set<string> | null = null;
const RELATION_METHOD_KEYS: WeakMap<object, Set<string>> = new WeakMap<object, Set<string>>();

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
        scope: QueryBuilderCallback;
    }> = [];

    protected _attributes: Record<string, any> = {};
    protected _original: Record<string, any> = {};
    protected _exists: boolean = false;
    protected _relations?: Record<string, any> = {};
    protected _changes?: Record<string, any> = {};

    private _saveChain?: Promise<void>;

    declare protected _privateHidden?: Array<string>;
    declare protected _privateAppends?: Array<string>;

    public constructor(attributes: Record<string, any> = {}) {
        this.fill(attributes);

        return new Proxy(this, this.proxyHandlers());
    }

    public setAttribute(key: string, value: any): void {
        this._attributes[key] = this.castIncoming(key, value);
    }

    public getAttribute(key: string): any {
        return this._attributes[key];
    }

    public get(key: string): any {
        return this.getAttribute(key);
    }

    public attribute<K extends keyof T & string>(key: K): T[K] {
        return this.getAttribute(key) as T[K];
    }

    public attributes(): Partial<T> {
        return {
            ...this._attributes
        } as Partial<T>;
    }

    public static preventLazyLoading(value: boolean = true): void {
        this.lazyLoadingPreventionEnabled = value;
    }

    public static now(): string {
        return Luxon.DateTime.now().toFormat(this.dateFormat || "yyyy-MM-dd HH:mm:ss.SSS");
    }

    public async save(): Promise<Model> {
        const tail: Promise<void> = this._saveChain ?? Promise.resolve();
        let done!: () => void;
        const slot: Promise<void> = new Promise<void>((resolve) => (done = resolve));
        const link: Promise<void> = tail.then(() => slot);

        this._saveChain = link;

        await tail;

        try {
            let persisted: boolean;

            if (!this._exists) persisted = await this.insert();
            else persisted = await perf;
        } finally {
            done();

            if (this._saveChain === link) this._saveChain = undefined;
        }
    }

    public fill(attributes: Record<string, any>): Model<T> {
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

    public forceFill(attributes: Record<string, any>): Model<T> {
        for (const [key, value] of Object.entries(attributes)) {
            this.setAttribute(key, value);
        }

        return this;
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

    public static newQueryWithoutScopes(): QueryBuilder {
        const builder: QueryBuilder = new QueryBuilder(this.tableName);

        builder._modelClass = this;
        builder.setRelationResolver((name: string) => this.resolveRelation(name));

        return builder;
    }

    public static withoutGlobalScope(nameOrFunc: string | QueryBuilderCallback): QueryBuilder {
        const builder: QueryBuilder = new QueryBuilder(this.tableName);

        builder._modelClass = this;
        builder.setRelationResolver((name: string) => this.resolveRelation(name));

        const kept: Array<{
            name?: string;
            scope: QueryBuilderCallback;
        }> = ((this as any).__globalScopes || []).filter((entry: any) =>
            typeof nameOrFunc === "function"
                ? entry.scope !== nameOrFunc
                : entry.name !== nameOrFunc
        );

        this.applyScopes(builder, kept);

        return this.applyModelDecorators(builder);
    }

    public static withoutGlobalScopes(): QueryBuilder {
        return this.newQueryWithoutScopes();
    }

    public static async withoutEvents<T = any>(callback: () => Promise<T> | T): Promise<T> {
        const self: any = this as any;
        const depth: number = self.__withoutEventsDepth || 0;
        const own: boolean = Object.prototype.hasOwnProperty.call(this, "__events");
        const previous: Record<string, Array<ModelEventCallback>> | undefined = self.__events;

        self.__events = {};
        self.__withoutEventsDepth = depth + 1;

        try {
            return await callback();
        } finally {
            self.__withoutEventsDepth = depth;

            if (depth === 0) {
                if (own || previous !== undefined) self.__events = previous;
                else delete self.__events;
            }
        }
    }

    public static async withoutTimestamps<T = any>(callback: () => Promise<T> | T): Promise<T> {
        const modelClass: any = this as any;
        const previous: boolean = modelClass.timestampsEnabled;

        modelClass.timestampsEnabled = false;

        try {
            return await callback();
        } finally {
            modelClass.timestampsEnabled = previous;
        }
    }

    public static newQuery(): QueryBuilder {
        return this.query();
    }

    public static async all(...relations: Array<string>): Promise<Array<any>> {
        const models: Array<any> = await this.query().get();

        if (relations.length > 0) await this.eagerLoad(models, ...relations);

        return models;
    }

    public static async with(...relations: Array<EagerLoadRelation>): Promise<Array<Model>> {
        const models: Array<any> = await this.all();

        await this.eagerLoad(models, ...relations);

        return models;
    }

    public static async withAll(): Promise<Array<any>> {
        const model: any = new (this as any)();
        const relationKeys: Array<string> = Object.getOwnPropertyNames(
            (this as any).prototype
        ).filter(
            (name: string) =>
                name !== "constructor" &&
                typeof (this as any).prototype[name] === "function" &&
                !name.startsWith("_") &&
                !Object.getOwnPropertyDescriptor(Model.prototype, name)
        );
        const relationNames: Array<string> = relationKeys.filter((key: string) => {
            try {
                const accessor: any = model.relationAccessor(model, key);
                const val: any = accessor();

                return val instanceof Relation;
            } catch {
                return false;
            }
        });

        return this.with(...relationNames);
    }

    public static async loadMissing(
        models: Array<any>,
        ...relations: Array<string>
    ): Promise<Array<any>> {
        const unloaded: Array<any> = models.filter((m: any) => !m.relationLoaded(relations[0]));

        if (unloaded.length > 0) await this.eagerLoad(unloaded, ...relations);

        return models;
    }

    protected proxyHandlers(): ProxyHandler<Model<any>> {
        return Model.MODEL_PROXY_HANDLERS;
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
            scope: QueryBuilderCallback;
        }>
    ): QueryBuilder {
        for (const entry of scopes) entry.scope(builder);

        return builder;
    }

    protected static applyModelDecorators(builder: QueryBuilder): QueryBuilder {
        return builder;
    }

    protected relationLoaded(relation: string): boolean {
        return relation in this._relations;
    }

    protected async fireModelEvent(event: ModelEvent): Promise<boolean> {
        const modelClass: typeof Model<T> = this.constructor as typeof Model<T>;
        const callbacks: Array<ModelEventCallback> = modelClass.__events?.[event] || [];

        for (const callback of callbacks) {
            const result: boolean | void | Promise<boolean | void> = await callback(this);

            if (result === false) return false;
        }

        return true;
    }

    protected castOutgoing(key: string, value: any): any {
        const cast: string | undefined = (this.constructor as any).casts?.[key];

        if (!cast) return value;

        switch (cast) {
            case "json":
            case "array":
            case "object":
                return typeof value === "string" ? value : JSON.stringify(value);
            case "datetime":
            case "timestamp":
                if (value && typeof value.toFormat === "function")
                    return value.toFormat(
                        (this.constructor as any).dateFormat || "yyyy-MM-dd HH:mm:ss"
                    );

                return value;
            default:
                return value;
        }
    }

    protected static snapshotValue(
        value: any,
        seen: WeakMap<object, any> = new WeakMap<object, any>()
    ): any {
        if (value === null || typeof value !== "object") return value;

        if (seen.has(value)) return seen.get(value);

        if (value instanceof Date) {
            const copy: Date = new Date(value.getTime());

            seen.set(value, copy);

            return copy;
        }

        if (Buffer.isBuffer(value)) {
            const copy: Buffer = Buffer.from(value);

            seen.set(value, copy);

            return copy;
        }

        if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
            const copy: any = structuredClone(value);

            seen.set(value, copy);

            return copy;
        }

        const prototype: object | null = Object.getPrototypeOf(value);

        if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null)
            return value;

        const copy: any = Array.isArray(value) ? new Array(value.length) : Object.create(prototype);

        seen.set(value, copy);

        for (const key of Object.keys(value)) {
            Object.defineProperty(copy, key, {
                value: this.snapshotValue(value[key], seen),
                enumerable: true,
                configurable: true,
                writable: true
            });
        }

        return copy;
    }

    protected async insert(): Promise<boolean> {
        const modelClass: typeof Model = this.constructor as typeof Model;

        if (!(await this.fireModelEvent("saving"))) return false;

        if (!(await this.fireModelEvent("creating"))) return false;

        const attributes: Record<string, any> = this.attributes();

        if (modelClass.timestampsEnabled && modelClass.createdColumn) {
            if (!attributes[modelClass.createdColumn])
                attributes[modelClass.createdColumn] = modelClass.now();
        }

        if (modelClass.timestampsEnabled && modelClass.updatedColumn) {
            if (!attributes[modelClass.updatedColumn])
                attributes[modelClass.updatedColumn] = modelClass.now();
        }

        if (
            modelClass.lockVersionColumn &&
            attributes[modelClass.lockVersionColumn] === undefined
        ) {
            attributes[modelClass.lockVersionColumn] = 1;
        }

        const outgoing: Record<string, any> = {};

        for (const [key, value] of Object.entries(attributes)) {
            outgoing[key] = this.castOutgoing(key, value);
        }

        const builder: QueryBuilder = new QueryBuilder(modelClass.tableName);

        if (builder.grammar.driverName() === DatabaseDriverEnum.Pg)
            this.rehydrateJsonForPg(outgoing);

        const id: any = await builder.insertGetId(outgoing, modelClass.idColumn);

        if (
            modelClass.idColumn &&
            id !== undefined &&
            attributes[modelClass.idColumn] === undefined
        ) {
            attributes[modelClass.idColumn] = this.castIncoming(modelClass.idColumn, id);
        }

        this._exists = true;
        this._attributes = {...attributes};
        this.syncOriginal(attributes);

        await this.fireModelEvent("created");
        await this.fireModelEvent("saved");

        return true;
    }

    private relationAccessor(target: any, key: string): any {
        const method: any = (target.constructor?.prototype || {})[key];

        if (typeof method !== "function")
            throw new RelationException(
                `Relation "${key}" is not defined on ${target.constructor.name}.`
            );

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

    private rehydrateJsonForPg(outgoing: Record<string, any>): void {
        const casts: Record<string, string> | undefined = (this.constructor as any).casts;

        if (!casts) return;

        for (const [key, value] of Object.entries(outgoing)) {
            const cast: string | undefined = casts[key];

            if (
                (cast === "json" || cast === "array" || cast === "object") &&
                typeof value === "string"
            ) {
                try {
                    outgoing[key] = JSON.parse(value);
                } catch {
                    outgoing[key] = value;
                }
            }
        }
    }

    private callableRelation(target: any, key: string, cached: Array<any>): Array<any> {
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

    private static modelMethodKeys(): Set<string> {
        if (MODEL_METHOD_KEYS) return MODEL_METHOD_KEYS;

        const keys: Set<string> = new Set<string>();

        for (const key of Object.getOwnPropertyNames(Model.prototype)) keys.add(key);
        for (const key of Object.getOwnPropertyNames(Object.prototype)) keys.add(key);

        MODEL_METHOD_KEYS = keys;

        return keys;
    }

    private static relationMethodKeys(ctor: object): Set<string> {
        let keys: Set<string> | undefined = RELATION_METHOD_KEYS.get(ctor);

        if (!keys) {
            keys = new Set<string>();

            let proto: any = (ctor as any).prototype;

            while (proto && proto !== Model.prototype) {
                for (const key of Object.getOwnPropertyNames(proto)) {
                    if (typeof proto[key] === "function") keys.add(key);
                }

                proto = Object.getPrototypeOf(proto);
            }

            RELATION_METHOD_KEYS.set(ctor, keys);
        }

        return keys;
    }

    private static readonly MODEL_PROXY_HANDLERS: ProxyHandler<Model<any>> = {
        get: (target: Model<any>, prop: string | symbol, receiver: any): any => {
            if (typeof prop === "symbol") return Reflect.get(target, prop, receiver);

            const key: string = prop as string;

            if (key.startsWith("_")) return Reflect.get(target, key, receiver);

            if (Object.prototype.hasOwnProperty.call(target._relations, key)) {
                const cached: any = target._relations[key];

                if (Array.isArray(cached))
                    return (target as any).callableRelation(target, key, cached);

                return cached;
            }

            if (Model.modelMethodKeys().has(key)) return Reflect.get(target, key, receiver);

            if (Model.relationMethodKeys(target.constructor).has(key))
                return target.relationAccessor(target, key);

            if (key === "id") {
                const modelClass: any = target.constructor;

                return target.getAttribute(modelClass.idColumn);
            }

            return target.getAttribute(key);
        },
        set: (target: Model<any>, prop: string | symbol, value: any): boolean => {
            if (typeof prop === "symbol") {
                Reflect.set(target, prop, value);

                return true;
            }

            const key: string = prop as string;

            if (key.startsWith("_")) {
                target[key] = value;

                return true;
            }

            if (key === "id") {
                const modelClass: any = target.constructor;

                target.setAttribute(modelClass.idColumn, value);

                return true;
            }

            if (Object.prototype.hasOwnProperty.call(target._relations, key)) {
                target._relations[key] = value;

                return true;
            }

            target.setAttribute(key, value);

            return true;
        },
        ownKeys: (target: Model<any>): ArrayLike<string | symbol> => {
            const owned: Set<string | symbol> = new Set<string | symbol>(Reflect.ownKeys(target));
            const attributeKeys: Array<string> = Object.keys(target._attributes).filter(
                (key: string) => !owned.has(key)
            );

            return [...owned, ...attributeKeys];
        },
        getOwnPropertyDescriptor: (
            target: Model<any>,
            prop: string | symbol
        ): PropertyDescriptor | undefined => {
            if (
                typeof prop === "string" &&
                Object.prototype.hasOwnProperty.call(target._attributes, prop)
            )
                return {
                    enumerable: true,
                    configurable: true,
                    writable: true,
                    value: target.getAttribute(prop)
                };

            return Reflect.getOwnPropertyDescriptor(target, prop);
        }
    };

    private syncOriginal(attributes: Record<string, any> = this._attributes): void {
        this._original = (this.constructor as typeof Model).snapshotValue(attributes);
    }
}
