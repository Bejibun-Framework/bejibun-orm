import type {
    EagerLoadRelation,
    EagerLoadSpec,
    GlobalScope,
    ModelEvent,
    ModelEventCallback
} from "@/types/model";
import type {QueryBuilderCallback} from "@/types/query";
import Logger from "@bejibun/logger";
import Luxon from "@bejibun/utils/facades/Luxon";
import Collection from "@/bases/Collection";
import Relation from "@/bases/Relation";
import FactoryBuilder from "@/builders/FactoryBuilder";
import QueryBuilder from "@/builders/QueryBuilder";
import DatabaseDriverEnum from "@/enums/DatabaseDriverEnum";
import OptimisticLockException from "@/exceptions/OptimisticLockException";
import RelationException from "@/exceptions/RelationException";
import UniqueConstraintViolationException from "@/exceptions/UniqueConstraintViolationException";
import Factory from "@/facades/Factory";

/** Lazily-built set of string keys on `Model.prototype` + `Object.prototype`. */
let MODEL_METHOD_KEYS: Set<string> | null = null;

/** Per-constructor cache of function names defined on the model subclass. */
const RELATION_METHOD_SETS: WeakMap<object, Set<string>> = new WeakMap<object, Set<string>>();

class Model<T = Record<string, any>> {
    /** Table queried by this model. */
    public static tableName: string;

    /** Primary key column. */
    public static idColumn: string = "id";

    /** Timestamp column set on create. */
    public static createdColumn: string | null = "created_at";

    /** Timestamp column set on update. */
    public static updatedColumn: string | null = "updated_at";

    /**
     * Optional optimistic-lock version column. Defaults to `null` (disabled).
     *
     * When set, `save()` on a persisted model runs its UPDATE guarded by
     * `WHERE version = <loaded value>`, bumps the version, and throws
     * `OptimisticLockException` if a concurrent writer already changed it --
     * eliminating last-writer-wins lost updates.
     *
     * The version starts at `1` on insert; eager `touch()`/`touchOwners()`
     * writes bypass the guard (call `save()` to re-guard).
     */
    public static lockVersionColumn: string | null = null;

    /** Default database connection. */
    public static connectionName?: string;

    /** Column type cast mapping to value reader/writer. */
    public static casts: Record<string, string> = {};

    /** Computed attributes appended during serialization. */
    public static appends: Array<string> = [];

    /** Attributes hidden during serialization. */
    public static hidden: Array<string> = [];

    /** Attributes always shown during serialization. */
    public static visible: Array<string> = [];

    /** Attributes allowed for mass assignment. */
    public static fillable: Array<string> = [];

    /** Attributes protected from mass assignment (guard). */
    public static guarded: Array<string> = [];

    /** Date format for timestamp columns. */
    public static dateFormat: string = "yyyy-MM-dd HH:mm:ss.SSS";

    /** Whether the model manages timestamps automatically. */
    public static timestampsEnabled: boolean = true;

    /** BelongsTo/MorphTo relations to touch whenever this model is saved. */
    public static touches: Array<string> = [];

    /** Guards against lazy-loading relations when enabled. */
    public static lazyLoadingPreventionEnabled: boolean = false;

    /** Event listeners per model class. */
    protected static __events: Record<string, Array<ModelEventCallback>> = {};

    /** Global scopes applied to all queries. */
    protected static __globalScopes: Array<GlobalScope> = [];

    /** Internal attribute storage keyed by column name. */
    protected _attributes: Record<string, any> = {};

    /** Snapshot of attributes from the last load or save. */
    protected _original: Record<string, any> = {};

    /** Attribute changes recorded during the last update. */
    protected _changes: Record<string, any> = {};

    /** Whether the record exists in the database. */
    protected _exists: boolean = false;

    /** Cached relations keyed by relation name. */
    protected _relations: Record<string, any> = {};

    /** Serializes concurrent `save()` calls on this instance (see `save`). */
    private _saveChain?: Promise<void>;

    /** Guards against a mutator re-entering `setAttribute()` recursively. */
    private _inMutator: boolean = false;

    /** Per-instance appends override, set by `append()`. */
    declare protected _privateAppends?: Array<string>;

    /** Per-instance hidden override, set by `makeHidden()`/`makeVisible()`. */
    declare protected _privateHidden?: Array<string>;

    /**
     * Creates a new model, mass-filling the given attributes and returning
     * a Proxy that routes attribute and relation access.
     *
     * @param {Record<string, any>} attributes - Initial attributes.
     */
    public constructor(attributes: Record<string, any> = {}) {
        this.fill(attributes);

        return new Proxy(this, this.proxyHandlers());
    }

    /**
     * Creates a model instance from database attributes without running
     * the constructor (skips mass-assignment guards and initializes hydrated
     * attributes directly). Used by `find`/`hydrate`.
     *
     * @param {Record<string, any>} attributes - The row attributes.
     * @param {boolean} [exists] - Whether the instance is persisted.
     * @returns {any} The proxied model instance.
     */
    public static newInstance(attributes: Record<string, any>, exists: boolean = false): any {
        const instance: any = Object.create(this.prototype);
        const attrs: Record<string, any> = {};

        for (const [key, value] of Object.entries(attributes)) {
            attrs[key] = instance.castIncoming(key, value);
        }

        instance._attributes = attrs;
        instance._exists = exists;
        instance._relations = {};
        instance._changes = {};

        instance.syncOriginal(attrs);

        const proxied: any = new Proxy(instance, instance.proxyHandlers());

        if (exists && this.__events?.retrieved?.length) {
            Promise.resolve(proxied.fireModelEvent("retrieved")).catch((error: any) => {
                Logger.setContext("ORM").error(`Retrieved event failed: ${String(error)}`);
            });
        }

        return proxied;
    }

    /**
     * Enables/disables the lazy-loading guard. When enabled, accessing an
     * unloaded relation on a model throws instead of issuing a query.
     * Relation methods stay callable and eager loading still works.
     *
     * @param {boolean} [value] - Guard on (`true`) or off (`false`).
     */
    public static preventLazyLoading(value: boolean = true): void {
        this.lazyLoadingPreventionEnabled = value;
    }

    /**
     * Returns the current timestamp formatted for this model.
     *
     * @returns {string} The formatted timestamp.
     */
    public static now(): string {
        return Luxon.DateTime.now().toFormat(this.dateFormat || "yyyy-MM-dd HH:mm:ss.SSS");
    }

    /**
     * Returns the name of the primary key column.
     *
     * @returns {string} The primary key column name.
     */
    public static getKeyName(): string {
        return this.idColumn;
    }

    /**
     * Returns a plain array of model attributes.
     *
     * @param {Array<Model>} models - Array of model instances.
     * @returns {Array<Record<string, any>>} Plain arrays.
     */
    public static toArray(models: Array<Model>): Array<Record<string, any>> {
        return models.map((model: Model) => model.toJSON());
    }

    /**
     * Eager-loads multiple relations for a collection of models,
     * supporting dotted paths (`posts.comments`).
     *
     * @param {Array<any>} models - The collection.
     * @param {Array<EagerLoadRelation>} relations - Relations to load.
     * @returns {Promise<void>} Resolves when all loaded.
     */
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

            const group = groups.get(root) || {children: []};

            if (rest.length === 0) {
                // Constraints on the root relation apply to its own query.
                group.constraints = group.constraints || spec.constraints;
            } else {
                group.children.push({
                    relation: rest.join("."),
                    constraints: spec.constraints
                });
            }

            groups.set(root, group);
        }

        // Distinct root relations are independent queries -- resolve them in
        // parallel (each root's nested children chain stays ordered inside it)
        // instead of serially.
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

    /**
     * Registers a model event callback.
     *
     * @param {ModelEvent} event - The event name (creating, created, etc.).
     * @param {ModelEventCallback} callback - The callback.
     */
    public static on(event: ModelEvent, callback: ModelEventCallback): void {
        if (!Object.prototype.hasOwnProperty.call(this, "__events")) this.__events = {};

        const events: any = this.__events;

        if (!events[event]) events[event] = [];

        events[event].push(callback);
    }

    /**
     * Registers a `creating` model event callback.
     *
     * @param {ModelEventCallback} callback - The event callback.
     */
    public static creating(callback: ModelEventCallback): void {
        this.on("creating", callback);
    }

    /**
     * Registers a `created` model event callback.
     *
     * @param {ModelEventCallback} callback - The event callback.
     */
    public static created(callback: ModelEventCallback): void {
        this.on("created", callback);
    }

    /**
     * Registers a `retrieved` model event callback, fired every time a
     * model is materialized from the database (via `find`, `get`, `hydrate`).
     *
     * @param {ModelEventCallback} callback - The event callback.
     */
    public static retrieved(callback: ModelEventCallback): void {
        this.on("retrieved", callback);
    }

    /**
     * Registers an `updating` model event callback.
     *
     * @param {ModelEventCallback} callback - The event callback.
     */
    public static updating(callback: ModelEventCallback): void {
        this.on("updating", callback);
    }

    /**
     * Registers an `updated` model event callback.
     *
     * @param {ModelEventCallback} callback - The event callback.
     */
    public static updated(callback: ModelEventCallback): void {
        this.on("updated", callback);
    }

    /**
     * Registers a `deleting` model event callback.
     *
     * @param {ModelEventCallback} callback - The event callback.
     */
    public static deleting(callback: ModelEventCallback): void {
        this.on("deleting", callback);
    }

    /**
     * Registers a `deleted` model event callback.
     *
     * @param {ModelEventCallback} callback - The event callback.
     */
    public static deleted(callback: ModelEventCallback): void {
        this.on("deleted", callback);
    }

    /**
     * Registers a `saving` model event callback.
     *
     * @param {ModelEventCallback} callback - The event callback.
     */
    public static saving(callback: ModelEventCallback): void {
        this.on("saving", callback);
    }

    /**
     * Registers a `saved` model event callback.
     *
     * @param {ModelEventCallback} callback - The event callback.
     */
    public static saved(callback: ModelEventCallback): void {
        this.on("saved", callback);
    }

    /**
     * Registers a `restoring` model event callback.
     *
     * @param {ModelEventCallback} callback - The event callback.
     */
    public static restoring(callback: ModelEventCallback): void {
        this.on("restoring", callback);
    }

    /**
     * Registers a `restored` model event callback.
     *
     * @param {ModelEventCallback} callback - The event callback.
     */
    public static restored(callback: ModelEventCallback): void {
        this.on("restored", callback);
    }

    /**
     * Registers an observer class (object with lifecycle methods).
     *
     * @param {any} observer - Observer class instance.
     */
    public static observe(observer: any): void {
        const events: Array<ModelEvent> = [
            "creating",
            "created",
            "updating",
            "updated",
            "deleting",
            "deleted",
            "saving",
            "saved",
            "restoring",
            "restored"
        ];

        for (const event of events) {
            if (typeof observer[event] === "function")
                this.on(event, observer[event].bind(observer));
        }
    }

    /**
     * Registers a global scope that applies to ALL queries. Scope names
     * are optional but enable removing a specific scope later.
     *
     * @param {string | QueryBuilderCallback} nameOrScope - The scope name, or a function receiving a
     * QueryBuilder and returning it.
     * @param {QueryBuilderCallback} [scope] - The scope function (required when named).
     */
    public static addGlobalScope(
        nameOrScope: string | QueryBuilderCallback,
        scope?: QueryBuilderCallback
    ): void {
        const entry: GlobalScope =
            typeof nameOrScope === "function"
                ? {scope: nameOrScope}
                : {name: nameOrScope, scope: scope!};

        this.__globalScopes = [...(this.__globalScopes || []), entry];
    }

    /**
     * Returns a QueryBuilder WITHOUT global scopes.
     *
     * @returns {QueryBuilder} The builder.
     */
    public static newQueryWithoutScopes(): QueryBuilder {
        const builder: QueryBuilder = new QueryBuilder(this.tableName);

        builder._modelClass = this;
        builder.setRelationResolver((name: string) => this.resolveRelation(name));

        return builder;
    }

    /**
     * Returns a QueryBuilder WITHOUT the named (or given) global scope,
     * keeping every other active scope.
     *
     * @param {string | QueryBuilderCallback} nameOrFunc - The scope name or function to drop.
     * @returns {QueryBuilder} The builder.
     */
    public static withoutGlobalScope(nameOrFunc: string | QueryBuilderCallback): QueryBuilder {
        const builder: QueryBuilder = new QueryBuilder(this.tableName);

        builder._modelClass = this;
        builder.setRelationResolver((name: string) => this.resolveRelation(name));

        const kept: Array<GlobalScope> = ((this as any).__globalScopes || []).filter(
            (entry: GlobalScope) =>
                typeof nameOrFunc === "function"
                    ? entry.scope !== nameOrFunc
                    : entry.name !== nameOrFunc
        );

        this.applyScopes(builder, kept);

        return this.applyModelDecorators(builder);
    }

    /**
     * Returns a QueryBuilder with ALL global scopes removed.
     *
     * @returns {QueryBuilder} The builder.
     */
    public static withoutGlobalScopes(): QueryBuilder {
        return this.newQueryWithoutScopes();
    }

    /**
     * Runs a callback with every model event temporarily muted.
     *
     * @param {() => Promise<T> | T} callback - The work to run without events.
     * @returns {Promise<T>} The callback result.
     */
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
                // Restore the original own value; a class that never declared events
                // must NOT gain the parent's event object as an own property (which
                // would later let `Sub.on()` mutate the shared parent's array).
                if (own || previous !== undefined) self.__events = previous;
                else delete self.__events;
            }
        }
    }

    /**
     * Runs a callback with automatic timestamps temporarily disabled.
     *
     * @param {() => Promise<T> | T} callback - The work to run without timestamps.
     * @returns {Promise<T>} The callback result.
     */
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

    /**
     * Hydrates raw database rows into model instances.
     *
     * @param {Array<Record<string, any>>} rows - The database rows.
     * @returns {Promise<Array<any>>} The hydrated models.
     */
    public static async hydrate(rows: Array<Record<string, any>>): Promise<Array<any>> {
        return rows.map((row: Record<string, any>) => this.newInstance(row, true));
    }

    /**
     * Wraps items (typically hydrated models or raw rows) into a
     * `Collection` instance.
     *
     * @param {Array<any>} items - The items to wrap.
     * @returns {Collection<any>} The collection.
     */
    public static collect(items: Array<any> = []): Collection<any> {
        return new Collection<any>(items);
    }

    /**
     * Returns a factory builder for this model. Requires a definition
     * registered via `Factory.define(Model, fn)`.
     *
     * @returns {FactoryBuilder} The factory builder.
     */
    public static factory(): FactoryBuilder {
        return Factory.model(this);
    }

    /**
     * Returns a QueryBuilder with global scopes applied.
     *
     * @returns {QueryBuilder} The builder.
     */
    public static query(): QueryBuilder {
        const builder: QueryBuilder = new QueryBuilder(this.tableName);

        builder._modelClass = this;
        builder.setRelationResolver((name: string) => this.resolveRelation(name));

        this.applyScopes(builder, (this as any).__globalScopes || []);

        return this.applyModelDecorators(builder);
    }

    /**
     * Returns a new QueryBuilder for this model's table.
     *
     * @returns {QueryBuilder} The builder.
     */
    public static newQuery(): QueryBuilder {
        return this.query();
    }

    /**
     * Returns all models, optionally eager-loading relations.
     *
     * @param {Array<string>} relations - Relations to eager-load.
     * @returns {Promise<Array<any>>} The hydrated models.
     */
    public static async all(...relations: Array<string>): Promise<Array<any>> {
        const models: Array<any> = await this.query().get();

        if (relations.length > 0) await this.eagerLoad(models, ...relations);

        return models;
    }

    /**
     * Returns all models of this class, optionally eager-loading relations.
     *
     * @param {Array<EagerLoadRelation>} relations - Relations to eager-load.
     * @returns {Promise<Array<Model>>} The hydrated models.
     */
    public static async with(...relations: Array<EagerLoadRelation>): Promise<Array<Model>> {
        const models: Array<any> = await this.all();

        await this.eagerLoad(models, ...relations);

        return models;
    }

    /**
     * Returns all models, eager-loading ALL defined relations.
     *
     * @returns {Promise<Array<any>>} The hydrated models with all relations.
     */
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

    /**
     * Eager-load a relation on an existing set of models.
     *
     * @param {Array<any>} models - The models to load onto.
     * @param {Array<string>} relations - Relation name(s).
     * @returns {Promise<Array<any>>} Same models with loaded relations.
     */
    public static async loadMissing(
        models: Array<any>,
        ...relations: Array<string>
    ): Promise<Array<any>> {
        const unloaded: Array<any> = models.filter((m: any) => !m.relationLoaded(relations[0]));

        if (unloaded.length > 0) await this.eagerLoad(unloaded, ...relations);

        return models;
    }

    /**
     * Creates and persists a new model.
     *
     * @param {Record<string, any>} attributes - The model attributes.
     * @returns {Promise<any>} The new model.
     */
    public static async create(attributes: Record<string, any>): Promise<any> {
        const instance: any = new (this as any)(attributes);

        await instance.save();

        return instance;
    }

    /**
     * Creates a model bypassing mass-assignment guards. Model events still
     * fire, and a unique-constraint violation propagates.
     *
     * @param {Record<string, any>} attributes - Attributes.
     * @returns {Promise<any>} The new model.
     */
    public static async forceCreate(attributes: Record<string, any>): Promise<any> {
        const instance: any = new (this as any)(attributes);

        instance.forceFill(attributes);

        await instance.save();

        return instance;
    }

    /**
     * Finds a model by its primary key.
     *
     * @param {any} id - The primary key value.
     * @returns {Promise<any | undefined>} The matching model, or undefined.
     */
    public static async find(id: any): Promise<any | undefined> {
        const model: any = await this.query().where(this.idColumn, "=", id).first();

        if (!model) return undefined;

        return model;
    }

    /**
     * Finds a model by primary key, throwing an error when none matches.
     * The error carries a `code` (default `404`) so framework exception
     * handlers can map it to a response status.
     *
     * @param {any} id - The primary key value.
     * @param {any} error - Custom error, factory, or constructor tuple to throw.
     * @returns {Promise<any>} The matching model.
     * @throws {RecordNotFoundException} When no row matches and no custom error is supplied.
     */
    public static async findOrFail(id: any, error?: any): Promise<any> {
        return this.query().findOrFail(id, ["*"], error);
    }

    /**
     * Returns fresh instances from the database for multiple IDs.
     *
     * @param {Array<any>} ids - The IDs to find.
     * @returns {Promise<Array<any>>} Array of models.
     */
    public static async findMany(ids: Array<any>): Promise<Array<any>> {
        if (ids.length === 0) return [];

        return this.query().whereIn(this.idColumn, ids).get();
    }

    /**
     * Returns the first instance matching `attributes`, or a new, unsaved
     * instance initialized with `attributes` and additional `values`.
     *
     * @param {Record<string, any>} attributes - Attributes to search / seed.
     * @param {Record<string, any>} [values] - Additional values for the new instance.
     * @returns {Promise<any>} The existing or new (unsaved) model.
     */
    public static async firstOrNew(
        attributes: Record<string, any>,
        values: Record<string, any> = {}
    ): Promise<any> {
        const found: any = await this.query()
            .where((query: QueryBuilder) => {
                for (const [key, value] of Object.entries(attributes)) {
                    query.where(key, "=", value);
                }
            })
            .first();

        if (found) return found;

        const model: any = new (this as any)(attributes);

        if (Object.keys(values).length > 0) model.forceFill(values);

        return model;
    }

    /**
     * Returns the first record matching `attributes`, or creates one from
     * `attributes` + `values`. An existing record is returned untouched --
     * `values` are never applied to it (see `updateOrCreate`).
     *
     * @param {Record<string, any>} attributes - Attributes to search / create.
     * @param {Record<string, any>} [values] - Additional values if creating.
     * @returns {Promise<any>} The model.
     */
    public static async firstOrCreate(
        attributes: Record<string, any>,
        values: Record<string, any> = {}
    ): Promise<any> {
        const search = (query: QueryBuilder): void => {
            for (const [key, value] of Object.entries(attributes)) {
                query.where(key, "=", value);
            }
        };
        const instance: any = await this.query().where(search).first();

        if (instance) return instance;

        try {
            return await this.create({...attributes, ...values});
        } catch (error: any) {
            // A concurrent request created the row between our find and our
            // insert. Lose the race gracefully: reload and return the winner.
            if (!(error instanceof UniqueConstraintViolationException)) throw error;

            const raced: any = await this.query().where(search).first();

            if (raced) return raced;

            throw error;
        }
    }

    /**
     * Returns the first result matching the attributes, creating it when none
     * matches.
     *
     * @param {Record<string, any>} attributes - Attributes to search for.
     * @param {Record<string, any>} [values] - Values applied to the record, whether it already
     * exists (saved) or is created.
     * @returns {Promise<any>} The model.
     */
    public static async updateOrCreate(
        attributes: Record<string, any>,
        values: Record<string, any> = {}
    ): Promise<any> {
        const search = (query: QueryBuilder): void => {
            for (const [key, value] of Object.entries(attributes)) {
                query.where(key, "=", value);
            }
        };
        const instance: any = await this.query().where(search).first();

        if (instance) {
            if (Object.keys(values).length > 0) {
                instance.forceFill(values);

                await instance.save();
            }

            return instance;
        }

        try {
            return await this.create({...attributes, ...values});
        } catch (error: any) {
            // A concurrent request created (or updated) the row after our find
            // missed it -- reload and apply the values to the winner.
            if (!(error instanceof UniqueConstraintViolationException)) throw error;

            const raced: any = await this.query().where(search).first();

            if (raced) {
                if (Object.keys(values).length > 0) {
                    raced.forceFill(values);

                    await raced.save();
                }

                return raced;
            }

            throw error;
        }
    }

    /**
     * Static proxy `where`.
     *
     * @param {Array<any>} args - Column, operator, value args.
     * @returns {QueryBuilder} Query builder.
     */
    public static where(...args: Array<any>): QueryBuilder {
        return this.query().where(...args);
    }

    /**
     * Filters results by the existence of a relation.
     *
     * @param {string} relation - The relation name.
     * @param {string} operator - The comparison operator.
     * @param {number} count - The minimum relation row count.
     * @returns {QueryBuilder} The query builder.
     */
    public static has(relation: string, operator: string = ">=", count: number = 1): QueryBuilder {
        return this.query().has(relation, operator, count);
    }

    /**
     * Filters results by the existence of a relation (OR clause).
     *
     * @param {string} relation - The relation name.
     * @param {string} operator - The comparison operator.
     * @param {number} count - The minimum relation row count.
     * @returns {QueryBuilder} The query builder.
     */
    public static orHas(
        relation: string,
        operator: string = ">=",
        count: number = 1
    ): QueryBuilder {
        return this.query().orHas(relation, operator, count);
    }

    /**
     * Constrains the query on the relation with a callback.
     *
     * @param {string} relation - The relation name.
     * @param {QueryBuilderCallback} callback - Constraints on the relation query.
     * @param {string} operator - The comparison operator.
     * @param {number} count - The minimum relation row count.
     * @returns {QueryBuilder} The query builder.
     */
    public static whereHas(
        relation: string,
        callback?: QueryBuilderCallback,
        operator: string = ">=",
        count: number = 1
    ): QueryBuilder {
        return this.query().whereHas(relation, callback, operator, count);
    }

    /**
     * Constrains the query on the relation with a callback (OR clause).
     *
     * @param {string} relation - The relation name.
     * @param {QueryBuilderCallback} callback - Constraints on the relation query.
     * @param {string} operator - The comparison operator.
     * @param {number} count - The minimum relation row count.
     * @returns {QueryBuilder} The query builder.
     */
    public static orWhereHas(
        relation: string,
        callback?: QueryBuilderCallback,
        operator: string = ">=",
        count: number = 1
    ): QueryBuilder {
        return this.query().orWhereHas(relation, callback, operator, count);
    }

    /**
     * Filters results by the absence of a relation.
     *
     * @param {string} relation - The relation name.
     * @param {string} operator - The comparison operator.
     * @param {number} count - The relation row count threshold.
     * @returns {QueryBuilder} The query builder.
     */
    public static doesntHave(
        relation: string,
        operator: string = ">=",
        count: number = 1
    ): QueryBuilder {
        return this.query().doesntHave(relation, operator, count);
    }

    /**
     * Filters results by the absence of a relation (OR clause).
     *
     * @param {string} relation - The relation name.
     * @param {string} operator - The comparison operator.
     * @param {number} count - The relation row count threshold.
     * @returns {QueryBuilder} The query builder.
     */
    public static orDoesntHave(
        relation: string,
        operator: string = ">=",
        count: number = 1
    ): QueryBuilder {
        return this.query().orDoesntHave(relation, operator, count);
    }

    /**
     * Constrains the query on the absence of a relation with a callback.
     *
     * @param {string} relation - The relation name.
     * @param {QueryBuilderCallback} callback - Constraints on the relation query.
     * @param {string} operator - The comparison operator.
     * @param {number} count - The relation row count threshold.
     * @returns {QueryBuilder} The query builder.
     */
    public static whereDoesntHave(
        relation: string,
        callback?: QueryBuilderCallback,
        operator: string = ">=",
        count: number = 1
    ): QueryBuilder {
        return this.query().whereDoesntHave(relation, callback, operator, count);
    }

    /**
     * Constrains the query on the absence of a relation with a callback
     * (OR clause).
     *
     * @param {string} relation - The relation name.
     * @param {QueryBuilderCallback} callback - Constraints on the relation query.
     * @param {string} operator - The comparison operator.
     * @param {number} count - The relation row count threshold.
     * @returns {QueryBuilder} The query builder.
     */
    public static orWhereDoesntHave(
        relation: string,
        callback?: QueryBuilderCallback,
        operator: string = ">=",
        count: number = 1
    ): QueryBuilder {
        return this.query().orWhereDoesntHave(relation, callback, operator, count);
    }

    /**
     * Constrains the query on a column of a related table.
     *
     * @param {string} relation - The relation name.
     * @param {string} column - The related column.
     * @param {any} operator - The comparison operator.
     * @param {any} value - The comparison value.
     * @returns {QueryBuilder} The query builder.
     */
    public static whereRelation(
        relation: string,
        column: string,
        operator?: any,
        value?: any
    ): QueryBuilder {
        return this.query().whereRelation(relation, column, operator, value);
    }

    /**
     * Constrains the query on a column of a related table (OR clause).
     *
     * @param {string} relation - The relation name.
     * @param {string} column - The related column.
     * @param {any} operator - The comparison operator.
     * @param {any} value - The comparison value.
     * @returns {QueryBuilder} The query builder.
     */
    public static orWhereRelation(
        relation: string,
        column: string,
        operator?: any,
        value?: any
    ): QueryBuilder {
        return this.query().orWhereRelation(relation, column, operator, value);
    }

    /**
     * Filters by `whereHas` and eager-loads the matching relation.
     *
     * @param {string} relation - Relation name.
     * @param {QueryBuilderCallback} [callback] - Constraints on the relation query.
     * @param {string} [operator] - Comparison operator (`>=`).
     * @param {number} [count] - Threshold count (`1`).
     * @returns {Promise<Array<Model>>} The hydrated models with the relation loaded.
     */
    public static async withWhereHas(
        relation: string,
        callback?: QueryBuilderCallback,
        operator: string = ">=",
        count: number = 1
    ): Promise<Array<Model<any>>> {
        const models: Array<any> = await this.query()
            .whereHas(relation, callback, operator, count)
            .get();

        await this.eagerLoad(models, relation);

        return models;
    }

    /**
     * Sets an attribute. Runs a `set<Name>Attribute()` mutator when one is
     * defined, then casts the stored value according to the model casts.
     *
     * @param {string} key - The attribute name.
     * @param {any} value - The attribute value.
     */
    public setAttribute(key: string, value: any): void {
        if (!this._inMutator && this.setAttributeFromMutator(key, value)) return;

        this._attributes[key] = this.castIncoming(key, value);
    }

    /**
     * Gets the raw stored attribute value. Accessors
     * (`get<Name>Attribute()`) run on property access instead, e.g.
     * `model.first_name`; this method never applies one or an outgoing cast.
     *
     * @param {string} key - The attribute name.
     * @returns {any} The attribute value.
     */
    public getAttribute(key: string): any {
        return this._attributes[key];
    }

    /**
     * Proxy getter, alias for `getAttribute`.
     *
     * @param {string} key - The attribute name.
     * @returns {any} The attribute value.
     */
    public get(key: string): any {
        return this.getAttribute(key);
    }

    /**
     * Typed attribute getter. Key must be a known attribute of `T`,
     * e.g. with `class User extends Model<UserAttributes>`, `user.attribute("name")`
     * returns `UserAttributes["name"]`.
     *
     * @param {K} key - A known attribute key.
     * @returns {T[K]} The attribute value.
     */
    public attribute<K extends keyof T & string>(key: K): T[K] {
        return this.getAttribute(key);
    }

    /**
     * Returns a shallow copy of every attribute, typed as `T`.
     *
     * @returns {Partial<T>} The attributes.
     */
    public attributes(): Partial<T> {
        return {...this._attributes} as Partial<T>;
    }

    /**
     * Returns the original (last-saved) value of an attribute.
     *
     * @param {string} key - The attribute name.
     * @returns {any} The original value.
     */
    public getOriginal(key?: string): any {
        const modelClass: typeof Model = this.constructor as typeof Model;

        if (key) return modelClass.snapshotValue(this._original[key]);

        return modelClass.snapshotValue(this._original);
    }

    /**
     * Returns a map of attributes that were changed during the last save.
     *
     * @returns {Record<string, any>} Changed attributes from last save.
     */
    public getChanges(): Record<string, any> {
        return {...this._changes};
    }

    /**
     * Returns a new, unsaved clone of this model with the primary key and
     * timestamps removed, ready to be saved as a new record. The clone is
     * built through the constructor, so mass-assignment guards still apply.
     *
     * @param {Array<string>} [except] - Additional attributes to exclude.
     * @returns {any} The replicated (unsaved) model instance.
     */
    public replicate(except: Array<string> = []): any {
        const modelClass: typeof Model = this.constructor as typeof Model;
        const exclude: Set<string> = new Set<string>([
            modelClass.idColumn,
            ...(modelClass.createdColumn ? [modelClass.createdColumn] : []),
            ...(modelClass.updatedColumn ? [modelClass.updatedColumn] : []),
            ...except
        ]);
        const attributes: Record<string, any> = {};

        for (const key of Object.keys(this._attributes)) {
            if (exclude.has(key)) continue;

            attributes[key] = this.getAttribute(key);
        }

        return new (this.constructor as any)(attributes);
    }

    /**
     * Mass-assigns attributes, honoring fillable/guarded restrictions.
     * A non-empty `fillable` acts as an allowlist; otherwise a non-empty
     * `guarded` (including `"*"`) rejects the listed keys. When BOTH are
     * empty (the default) every attribute is mass-assignable.
     *
     * @param {Record<string, any>} attributes - The attributes to fill.
     * @returns {this} This model.
     */
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

    /**
     * Sets attributes bypassing mass-assignment guards (fillable/guarded).
     *
     * @param {Record<string, any>} attributes - Attributes to force fill.
     * @returns {this} This model.
     */
    public forceFill(attributes: Record<string, any>): Model<T> {
        for (const [key, value] of Object.entries(attributes)) {
            this.setAttribute(key, value);
        }

        return this;
    }

    /**
     * Dynamically appends attributes when serializing.
     *
     * @param {Array<string>} attributes - Computed attribute names.
     * @returns {this} This model.
     */
    public append(...attributes: Array<string>): Model<any> {
        this._privateAppends = [
            ...(this._privateAppends ?? (this.constructor as typeof Model).appends),
            ...attributes
        ];

        return this;
    }

    /**
     * Makes attributes visible when serializing.
     *
     * @param {Array<string>} attributes - Attributes to make visible.
     * @returns {this} This model.
     */
    public makeVisible(...attributes: Array<string>): Model<any> {
        const hidden: Array<string> =
            this._privateHidden ?? (this.constructor as typeof Model).hidden;

        this._privateHidden = hidden.filter((h: string) => !attributes.includes(h));

        return this;
    }

    /**
     * Makes attributes hidden when serializing.
     *
     * @param {Array<string>} attributes - Attributes to make hidden.
     * @returns {this} This model.
     */
    public makeHidden(...attributes: Array<string>): Model<any> {
        this._privateHidden = [
            ...(this._privateHidden ?? (this.constructor as typeof Model).hidden),
            ...attributes
        ];

        return this;
    }

    /**
     * Returns a map of attributes that have been changed since last load.
     *
     * @returns {Record<string, any>} Changed attributes.
     */
    public getDirty(): Record<string, any> {
        const dirty: Record<string, any> = {};

        for (const key of Object.keys(this._attributes)) {
            const value: any = this.getAttribute(key);

            if (!(this.constructor as typeof Model).attributesEqual(this._original[key], value))
                dirty[key] = value;
        }

        return dirty;
    }

    /**
     * Returns true if the model has been modified since it was loaded.
     *
     * @param {string} [key] - Optional specific column to check.
     * @returns {boolean} True when the model or the given column is dirty.
     */
    public isDirty(key?: string): boolean {
        const dirty: Record<string, any> = this.getDirty();

        if (key) return key in dirty;

        return Object.keys(dirty).length > 0;
    }

    /**
     * Returns true if the model has NOT been modified since it was loaded.
     *
     * @param {string} [key] - Optional specific column to check.
     * @returns {boolean} True when the model or the given column is clean.
     */
    public isClean(key?: string): boolean {
        return !this.isDirty(key);
    }

    /**
     * Returns whether the model is persisted in the database.
     *
     * @returns {boolean} True when the model exists in the database.
     */
    public exists(): boolean {
        return this._exists;
    }

    /**
     * Returns the primary key value.
     *
     * @returns {any} The primary key value.
     */
    public getKey(): any {
        return this.getAttribute((this.constructor as typeof Model).idColumn);
    }

    /**
     * Returns the model as a plain object with outgoing casts applied,
     * dropping `hidden` attributes and, when `visible` is non-empty, keeping
     * only those keys. Loaded relations are serialized too; `appends` accessors
     * are NOT run here (see `toArray()`).
     *
     * @returns {Record<string, any>} The model attributes.
     */
    public toJSON(): Record<string, any> {
        const modelClass: typeof Model = this.constructor as typeof Model;
        const hiddenModel: Array<string> = this._privateHidden ?? modelClass.hidden;
        const visibleModel: Array<string> = modelClass.visible || [];
        const allowed: (key: string) => boolean =
            visibleModel.length > 0 ? (key: string) => visibleModel.includes(key) : () => true;
        const result: Record<string, any> = {};

        for (const key of Object.keys(this._attributes)) {
            if (!allowed(key)) continue;

            if (hiddenModel.includes(key)) continue;

            result[key] = this.castOutgoing(key, this.getAttribute(key));
        }

        for (const [key, value] of Object.entries(this._relations)) {
            if (!allowed(key)) continue;

            if (hiddenModel.includes(key)) continue;

            result[key] =
                value && typeof value.toJSON === "function"
                    ? value.toJSON()
                    : Array.isArray(value) &&
                        value.length > 0 &&
                        typeof value[0]?.toJSON === "function"
                      ? value.map((item: any) => item.toJSON())
                      : value;
        }

        return result;
    }

    /**
     * Converts the model to a plain object. Runs the same `hidden`/`visible`
     * filtering as `toJSON()` -- hidden attributes are NOT included -- and then
     * adds each `appends` entry that has a `get<Name>Attribute()` accessor.
     *
     * @returns {Record<string, any>} The serialized attributes (loaded relations included).
     */
    public toArray(): Record<string, any> {
        const result: Record<string, any> = this.toJSON();
        const modelClass: typeof Model = this.constructor as typeof Model;

        for (const attr of this._privateAppends ?? modelClass.appends) {
            if (this.hasAttributeAccessor(attr)) result[attr] = this.getAttributeFromMutator(attr);
        }

        return result;
    }

    /**
     * Updates the `updated` timestamp column and persists the change.
     *
     * @returns {Promise<boolean>} True when a timestamp column exists and the row was saved.
     */
    public async touch(): Promise<boolean> {
        const modelClass: typeof Model = this.constructor as typeof Model;

        if (!modelClass.updatedColumn || !this._exists) return false;

        const stamp: string = modelClass.now();

        await new QueryBuilder(modelClass.tableName)
            .where(modelClass.idColumn, "=", this.getAttribute(modelClass.idColumn))
            .update({
                [modelClass.updatedColumn]: stamp
            });

        this.setAttribute(modelClass.updatedColumn, stamp);

        this._original[modelClass.updatedColumn] = this.getAttribute(modelClass.updatedColumn);

        return true;
    }

    /**
     * Loads a related record and stores it under the relation name.
     *
     * @param {string} relation - The relation accessor NAME (e.g. `"posts"`).
     * @returns {Promise<any>} The loaded related model(s).
     */
    public async load(relation: string): Promise<any> {
        const accessor: any = this.relationAccessor(this, relation);
        const result: any = await accessor;

        return result;
    }

    /**
     * Returns a fresh model instance from the database (re-queries).
     *
     * @param {Array<string>} [relations] - Relation names to load. Loading is lazy and
     * single-valued, so only the FIRST name is applied.
     * @returns {Promise<Model | undefined>} A fresh instance, or `undefined` when the model has no id or
     * no matching row.
     */
    public async fresh(...relations: Array<string>): Promise<Model | undefined> {
        const modelClass: typeof Model = this.constructor as typeof Model;
        const id: any = this.getAttribute(modelClass.idColumn);

        if (id === undefined) return undefined;

        const instance: any = await modelClass.find(id);

        if (instance && relations.length > 0) await instance.load(...relations);

        return instance;
    }

    /**
     * Refreshes the model attributes from the database.
     *
     * @returns {Promise<this>} This model, with fresh attributes.
     */
    public async refresh(): Promise<Model<any>> {
        if (!this._exists) return this;

        const modelClass: typeof Model = this.constructor as typeof Model;
        const id: any = this.getAttribute(modelClass.idColumn);
        const row: Record<string, any> | undefined = await new QueryBuilder(modelClass.tableName)
            .where(modelClass.idColumn, "=", id)
            .first();

        if (row) {
            const attrs: Record<string, any> = {};

            for (const [key, value] of Object.entries(row)) {
                attrs[key] = this.castIncoming(key, value);
            }

            this.syncOriginal(attrs);

            this._attributes = {...attrs};
            this._relations = {};
        }

        return this;
    }

    /**
     * Increments a column by `amount`, optionally setting extra columns.
     * Runs a single UPDATE and syncs the local attributes.
     *
     * @param {string} column - The numeric column to increment.
     * @param {number} [amount] - The amount (`1` by default).
     * @param {Record<string, any>} [extra] - Extra columns to set.
     * @returns {Promise<this>} This model.
     */
    public async increment(
        column: string,
        amount: number = 1,
        extra: Record<string, any> = {}
    ): Promise<Model<any>> {
        const modelClass: typeof Model = this.constructor as typeof Model;

        if (!this._exists) return this;

        await new QueryBuilder(modelClass.tableName)
            .where(modelClass.idColumn, "=", this.getAttribute(modelClass.idColumn))
            .increment(column, amount, extra);

        const current: number = Number(this.getAttribute(column)) || 0;

        this.setAttribute(column, current + amount);

        for (const [key, value] of Object.entries(extra)) {
            this.setAttribute(key, value);
        }

        this._changes = {
            ...extra,
            [column]: this.getAttribute(column)
        };
        this._original[column] = this.getAttribute(column);

        return this;
    }

    /**
     * Decrements a column by `amount`, optionally setting extra columns.
     *
     * @param {string} column - The numeric column to decrement.
     * @param {number} [amount] - The amount (`1` by default).
     * @param {Record<string, any>} [extra] - Extra columns to set.
     * @returns {Promise<this>} This model.
     */
    public async decrement(
        column: string,
        amount: number = 1,
        extra: Record<string, any> = {}
    ): Promise<Model<any>> {
        const modelClass: typeof Model = this.constructor as typeof Model;

        if (!this._exists) return this;

        await new QueryBuilder(modelClass.tableName)
            .where(modelClass.idColumn, "=", this.getAttribute(modelClass.idColumn))
            .decrement(column, amount, extra);

        const current: number = Number(this.getAttribute(column)) || 0;

        this.setAttribute(column, current - amount);

        for (const [key, value] of Object.entries(extra)) {
            this.setAttribute(key, value);
        }

        this._changes = {
            ...extra,
            [column]: this.getAttribute(column)
        };
        this._original[column] = this.getAttribute(column);

        return this;
    }

    /**
     * Persists the model, inserting a new row or updating the existing one.
     *
     * Concurrent calls on the same instance are serialized: a second `save()`
     * fired before the first resolves waits for it, so an unsaved model can
     * never be inserted twice in parallel.
     *
     * Resolves with the model even when a `saving`/`creating`/`updating`
     * listener cancelled the write -- nothing is persisted in that case.
     *
     * @returns {Promise<this>} This model.
     */
    public async save(): Promise<Model<any>> {
        const tail: Promise<void> = this._saveChain ?? Promise.resolve();
        let done!: () => void;
        const slot: Promise<void> = new Promise<void>((resolve) => (done = resolve));
        const link: Promise<void> = tail.then(() => slot);

        this._saveChain = link;

        await tail;

        try {
            let persisted: boolean;

            if (!this._exists) persisted = await this.insert();
            else persisted = await this.performUpdate();

            // Never touch owners when a `saving`/`creating` listener cancelled the
            // insert -- the model was not persisted, so nothing should ripple.
            if (persisted) await this.touchOwners();

            return this;
        } finally {
            done();

            if (this._saveChain === link) this._saveChain = undefined;
        }
    }

    /**
     * Deletes the model from the database.
     *
     * @returns {Promise<boolean>} True if rows were deleted.
     */
    public async delete(): Promise<boolean> {
        const modelClass: typeof Model = this.constructor as typeof Model;
        const id: any = this.getAttribute(modelClass.idColumn);

        if (id === undefined) return false;

        if (!(await this.fireModelEvent("deleting"))) return false;

        const deleted: number = await new QueryBuilder(modelClass.tableName)
            .where(modelClass.idColumn, "=", id)
            .delete();

        this._exists = false;

        await this.fireModelEvent("deleted");

        if (deleted > 0) await this.touchOwners();

        return deleted > 0;
    }

    /**
     * Force-deletes the model (bypasses soft delete).
     *
     * @returns {Promise<boolean>} True if rows were deleted.
     */
    public async forceDelete(): Promise<boolean> {
        const modelClass: typeof Model = this.constructor as typeof Model;
        const id: any = this.getAttribute(modelClass.idColumn);

        if (id === undefined) return false;

        const deleted: number = await new QueryBuilder(modelClass.tableName)
            .where(modelClass.idColumn, "=", id)
            .delete();

        this._exists = false;

        return deleted > 0;
    }

    /**
     * Defines a has one relation.
     *
     * @param {any} related - The related model.
     * @param {string} foreignKey - The FK column on the child table.
     * @param {string} ownerKey - The PK column on the parent.
     * @returns {Relation} The relation.
     */
    public hasOne(related: any, foreignKey?: string, ownerKey?: string): Relation {
        return Relation.hasOne(this, related, foreignKey, ownerKey);
    }

    /**
     * Defines a has many relation.
     *
     * @param {any} related - The related model.
     * @param {string} foreignKey - The FK column on the child table.
     * @param {string} ownerKey - The PK column on the parent.
     * @returns {Relation} The relation.
     */
    public hasMany(related: any, foreignKey?: string, ownerKey?: string): Relation {
        return Relation.hasMany(this, related, foreignKey, ownerKey);
    }

    /**
     * Defines a belongs to relation.
     *
     * @param {any} related - The related model.
     * @param {string} foreignKey - The FK column on this table.
     * @param {string} ownerKey - The PK column on the related model.
     * @param {string} name - Name used to derive the default foreign key (defaults to
     * the related class's snake_case short name).
     * @returns {Relation} The relation.
     */
    public belongsTo(
        related: any,
        foreignKey?: string,
        ownerKey?: string,
        name?: string
    ): Relation {
        return Relation.belongsTo(this, related, foreignKey, ownerKey, name);
    }

    /**
     * Defines a belongs to many relation.
     *
     * @param {any} related - The related model.
     * @param {string} pivotTable - The pivot table name.
     * @param {string} foreignKey - The pivot FK column for the parent.
     * @param {string} relatedKey - The pivot FK column for the related.
     * @param {string} ownerKey - The PK column on the parent.
     * @param {string} relatedOwnerKey - The PK column on the related.
     * @returns {Relation} The relation.
     */
    public belongsToMany(
        related: any,
        pivotTable?: string,
        foreignKey?: string,
        relatedKey?: string,
        ownerKey?: string,
        relatedOwnerKey?: string
    ): Relation {
        return Relation.belongsToMany(
            this,
            related,
            pivotTable,
            foreignKey,
            relatedKey,
            ownerKey,
            relatedOwnerKey
        );
    }

    /**
     * Applies the given global scope entries to a builder.
     *
     * @param {QueryBuilder} builder - The query builder.
     * @param {Array<GlobalScope>} scopes - The scope entries to apply.
     * @returns {QueryBuilder} The scoped builder.
     */
    protected static applyScopes(builder: QueryBuilder, scopes: Array<GlobalScope>): QueryBuilder {
        for (const entry of scopes) entry.scope(builder);

        return builder;
    }

    /**
     * Applies model scopes to the builder. Without a trait, no filter.
     *
     * @param {QueryBuilder} builder - The query builder.
     * @returns {QueryBuilder} The decorated builder.
     */
    protected static applyModelDecorators(builder: QueryBuilder): QueryBuilder {
        return builder;
    }

    /**
     * Resolves a relation accessor name to a `Relation` instance.
     *
     * @param {string} name - Relation accessor name.
     * @returns {Relation} The resolved relation.
     */
    protected static resolveRelation(name: string): Relation {
        const model: any = new (this as any)();
        const accessor: any = model.relationAccessor(model, name);
        const relation: any = accessor();

        if (!(relation instanceof Relation))
            throw new RelationException(`Relation "${name}" is not defined on ${this.name}.`);

        return relation;
    }

    /**
     * Copies mutable attribute values without stripping custom cast prototypes.
     * Override for mutable custom casts, delegating other values to `super`.
     *
     * @param {any} value - The attribute value to copy.
     * @param {WeakMap<object, any>} [seen] - Previously copied objects used to preserve shared and circular references.
     * @returns {any} An independent snapshot of the value.
     */
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

        if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
            // Custom casts (such as immutable Luxon DateTime) retain their prototype.
            return value;
        }

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

    /**
     * Semantic equality for dirty-change detection: `5` and `"5"` compare
     * equal, as do two objects/arrays with identical JSON content (e.g. a
     * reloaded `json` cast value vs. the local object). `NaN !== NaN` while
     * everything else falls back to strict equality.
     *
     * @param {any} a - The original value.
     * @param {any} b - The current value.
     * @returns {boolean} Whether the values compare equal.
     */
    protected static attributesEqual(a: any, b: any): boolean {
        if (a === b) return true;

        if (a === null || b === null || a === undefined || b === undefined) return a === b;

        const ta: string = typeof a;
        const tb: string = typeof b;

        if (ta === "object" && tb === "object") {
            if (a instanceof Date || b instanceof Date) {
                return a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : false;
            }

            try {
                return JSON.stringify(a) === JSON.stringify(b);
            } catch {
                return false;
            }
        }

        if ((ta === "number" && tb === "string") || (ta === "string" && tb === "number")) {
            const numericA: number = Number(a);
            const numericB: number = Number(b);

            return Number.isFinite(numericA) && Number.isFinite(numericB)
                ? numericA === numericB
                : false;
        }

        return false;
    }

    /**
     * Applies a `set<Name>Attribute()` mutator for an attribute.
     *
     * @param {string} key - The attribute key.
     * @param {any} value - The raw value being set.
     * @returns {boolean} True if a mutator handled the assignment.
     */
    protected setAttributeFromMutator(key: string, value: any): boolean {
        const mutator: any = Model.prototypeMethod(this, Model.mutatorName(key));

        if (typeof mutator !== "function") return false;

        const previous: boolean = this._inMutator;

        this._inMutator = true;

        try {
            Reflect.apply(mutator, this, [value]);
        } finally {
            this._inMutator = previous;
        }

        return true;
    }

    /**
     * Returns the accessor value for an attribute (`get<Name>Attribute()`).
     *
     * @param {string} key - The attribute key.
     * @returns {any} The accessor value, or undefined.
     */
    protected getAttributeFromMutator(key: string): any {
        const accessor: any = Model.prototypeMethod(this, Model.accessorName(key));

        if (typeof accessor === "function") return Reflect.apply(accessor, this, []);

        return undefined;
    }

    /**
     * Returns whether the attribute has a `get<Name>Attribute()` accessor.
     *
     * @param {string} key - The attribute key.
     * @returns {boolean} True when an accessor exists.
     */
    protected hasAttributeAccessor(key: string): boolean {
        return typeof Model.prototypeMethod(this, Model.accessorName(key)) === "function";
    }

    /**
     * Builds the Proxy trap handlers that route attribute reads, writes,
     * and enumeration through the model's internal state.
     *
     * @returns {ProxyHandler<Model<any>>} The proxy trap handlers.
     */
    protected proxyHandlers(): ProxyHandler<Model<any>> {
        return Model.MODEL_PROXY_HANDLERS;
    }

    /**
     * Casts an incoming value (DB to local).
     *
     * @param {string} key - The attribute name.
     * @param {any} value - The raw value.
     * @returns {any} The cast value.
     */
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

    /**
     * Casts an outgoing value (local to serialized form).
     *
     * @param {string} key - The attribute name.
     * @param {any} value - The local value.
     * @returns {any} The cast value.
     */
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

    /**
     * Returns true if a relation has been loaded.
     *
     * @param {string} relation - The relation name.
     * @returns {boolean} True when the relation has been loaded.
     */
    protected relationLoaded(relation: string): boolean {
        return relation in this._relations;
    }

    /**
     * Fires a model event and returns false if any callback cancels it.
     *
     * @param {ModelEvent} event - The event name.
     * @returns {Promise<boolean>} True if event was not cancelled.
     */
    protected async fireModelEvent(event: ModelEvent): Promise<boolean> {
        const modelClass: typeof Model<T> = this.constructor as typeof Model<T>;
        const callbacks: Array<ModelEventCallback> = modelClass.__events?.[event] || [];

        for (const callback of callbacks) {
            const result: boolean | void | Promise<boolean | void> = await callback(this);

            if (result === false) return false;
        }

        return true;
    }

    /**
     * Inserts the model's attributes as a new row.
     *
     * Returns `false` when a `saving`/`creating` listener cancels the insert
     * (nothing is persisted), `true` once the row exists.
     *
     * @returns {Promise<boolean>} Whether the row was persisted.
     */
    protected async insert(): Promise<boolean> {
        const modelClass: typeof Model = this.constructor as typeof Model;

        if (!(await this.fireModelEvent("saving"))) return false;

        if (!(await this.fireModelEvent("creating"))) return false;

        // Snapshot AFTER the events so attribute writes made by `saving`/
        // `creating` listeners are persisted (and retained), then add the
        // timestamp defaults the model still lacks.
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

        if (builder.grammar.driverName() === DatabaseDriverEnum.Pg) {
            // Bun's pg driver encodes JS objects into a proper JSON value, but a
            // pre-stringified JSON string would be stored as a JSON scalar string
            // (double-encoded: `#>' '{grade}'` returns NULL). Rehydrate json-cast
            // columns so Postgres stores a real object, matching mysql/sqlite.
            this.rehydrateJsonForPg(outgoing);
        }

        const id: any = await builder.insertGetId(outgoing, modelClass.idColumn);

        if (
            modelClass.idColumn &&
            id !== undefined &&
            attributes[modelClass.idColumn] === undefined
        ) {
            // Respect a user `casts` on the id column (e.g. `id: "int"`) so the
            // assigned key matches what `castIncoming` would produce on fetch.
            attributes[modelClass.idColumn] = this.castIncoming(modelClass.idColumn, id);
        }

        this._exists = true;
        this._attributes = {...attributes};
        this.syncOriginal(attributes);

        await this.fireModelEvent("created");
        await this.fireModelEvent("saved");

        return true;
    }

    /**
     * Performs an UPDATE of the persisted row.
     *
     * @returns {Promise<boolean>} `false` only when a `saving`/`updating` listener cancelled the
     * update; `true` once the row is untouched-or-updated.
     */
    protected async performUpdate(): Promise<boolean> {
        const modelClass: typeof Model = this.constructor as typeof Model;

        const id: any = this.getAttribute(modelClass.idColumn);

        // A model that exists but never captured its id (no auto-increment column) cannot be located --
        // no-op instead of silently re-inserting a duplicate row.
        if (id === undefined) return true;

        const dirty: Record<string, any> = this.getDirty();

        if (modelClass.timestampsEnabled && modelClass.updatedColumn) {
            dirty[modelClass.updatedColumn] = modelClass.now();
        }

        if (Object.keys(dirty).length === 0) return true;

        if (!(await this.fireModelEvent("saving"))) return false;
        if (!(await this.fireModelEvent("updating"))) return false;

        this._changes = {...dirty};

        const outgoing: Record<string, any> = {};

        for (const [key, value] of Object.entries(dirty)) {
            outgoing[key] = this.castOutgoing(key, value);
        }

        // Optimistic-lock guard: attach the loaded version to the UPDATE and
        // bump it, so a stale writer (version already advanced) matches zero
        // rows and fails instead of silently overwriting.
        const versionColumn: string | null = modelClass.lockVersionColumn;
        const originalVersion: any =
            versionColumn === null ? undefined : this._original[versionColumn];
        const hasVersion: boolean = versionColumn !== null && originalVersion !== undefined;

        if (hasVersion) {
            outgoing[versionColumn] = Number(originalVersion) + 1;
        }

        const builder: QueryBuilder = new QueryBuilder(modelClass.tableName);

        if (builder.grammar.driverName() === DatabaseDriverEnum.Pg)
            this.rehydrateJsonForPg(outgoing);

        let updater: QueryBuilder = builder.where(modelClass.idColumn, "=", id);

        if (hasVersion) {
            updater = updater.where(versionColumn, "=", originalVersion);
        }

        const affected: number = await updater.update(outgoing);

        if (hasVersion && affected === 0) {
            throw new OptimisticLockException(
                modelClass.name,
                this.getAttribute(modelClass.idColumn)
            );
        }

        if (hasVersion) this.setAttribute(versionColumn as string, outgoing[versionColumn]);

        this.syncOriginal();

        await this.fireModelEvent("updated");
        await this.fireModelEvent("saved");

        return true;
    }

    /**
     * Touches the owners of every relation listed in the model's
     * `touches` option (belongsTo / morphTo).
     *
     * @returns {Promise<void>} Resolves when all owners are touched.
     */
    protected async touchOwners(): Promise<void> {
        const modelClass: typeof Model = this.constructor as typeof Model;
        const prototype: any = Object.getPrototypeOf(this);

        for (const name of modelClass.touches || []) {
            const accessor: any = prototype ? prototype[name] : undefined;

            if (typeof accessor !== "function") continue;

            const relation: any = accessor.call(this);

            if (relation instanceof Relation && typeof relation.touch === "function")
                await relation.touch();
        }
    }

    /**
     * The `relationMethodKeys` set cache (defined above) plus a single shared,
     * stateless proxy-handler object for every model instance.
     *
     * Every hydrated row was previously allocated a fresh handler object with
     * closures capturing the instance; the handlers only ever read `_attributes`,
     * `_relations`, and the model/relation method-key caches off the `target`, so
     * one immutable handler can serve all models of all classes. Removes one
     * object + N closures per row for large result sets.
     */
    private static readonly MODEL_PROXY_HANDLERS: ProxyHandler<Model<any>> = {
        get: (target: Model<any>, prop: string | symbol, receiver: any): any => {
            if (typeof prop === "symbol") return Reflect.get(target, prop, receiver);

            const key: string = prop as string;

            if (key.startsWith("_")) return Reflect.get(target, key, receiver);

            if (Object.prototype.hasOwnProperty.call(target._relations, key)) {
                const cached: any = target._relations[key];

                if (Array.isArray(cached)) return target.callableRelation(target, key, cached);

                return cached;
            }

            if (Model.modelMethodKeys().has(key)) return Reflect.get(target, key, receiver);

            if (Model.relationMethodKeys(target.constructor).has(key))
                return target.relationAccessor(target, key);

            if (key === "id") {
                const modelClass: any = target.constructor;

                return target.getAttribute(modelClass.idColumn);
            }

            const accessor: any = Model.prototypeMethod(target, Model.accessorName(key));

            if (typeof accessor === "function") return Reflect.apply(accessor, receiver, []);

            return target.getAttribute(key);
        },
        set: (target: Model<any>, prop: string | symbol, value: any, receiver: any): boolean => {
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

                receiver.setAttribute(modelClass.idColumn, value);

                return true;
            }

            if (Object.prototype.hasOwnProperty.call(target._relations, key)) {
                target._relations[key] = value;

                return true;
            }

            receiver.setAttribute(key, value);

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

    /**
     * Returns (and caches) every method key reachable on a base model instance,
     * replacing a per-access `key in Model.prototype` prototype-chain walk with a
     * `Set.has` lookup.
     *
     * @returns {Set<string>} The method-key set.
     */
    private static modelMethodKeys(): Set<string> {
        if (MODEL_METHOD_KEYS) return MODEL_METHOD_KEYS;

        const keys: Set<string> = new Set<string>();

        for (const key of Object.getOwnPropertyNames(Model.prototype)) keys.add(key);
        for (const key of Object.getOwnPropertyNames(Object.prototype)) keys.add(key);

        MODEL_METHOD_KEYS = keys;

        return keys;
    }

    /**
     * Converts an attribute key (`first_name`, `firstName`) to StudlyCase.
     *
     * @param {string} key - The attribute key.
     * @returns {string} The StudlyCase form.
     */
    private static studlyAttribute(key: string): string {
        return key
            .split(/[-_\s]+/)
            .filter((part: string) => part.length > 0)
            .map((part: string) => part.charAt(0).toUpperCase() + part.slice(1))
            .join("");
    }

    /**
     * Returns the accessor method name for an attribute key.
     *
     * @param {string} key - The attribute key.
     * @returns {string} The `get<Name>Attribute` method name.
     */
    private static accessorName(key: string): string {
        return `get${Model.studlyAttribute(key)}Attribute`;
    }

    /**
     * Returns the mutator method name for an attribute key.
     *
     * @param {string} key - The attribute key.
     * @returns {string} The `set<Name>Attribute` method name.
     */
    private static mutatorName(key: string): string {
        return `set${Model.studlyAttribute(key)}Attribute`;
    }

    /**
     * Looks up a method on the prototype chain without triggering proxy traps.
     *
     * @param {any} instance - The model instance (proxy or raw).
     * @param {string} name - The method name.
     * @returns {any} The function, or undefined when absent.
     */
    private static prototypeMethod(instance: any, name: string): any {
        let proto: any = Object.getPrototypeOf(instance);

        while (proto) {
            const descriptor: PropertyDescriptor | undefined = Object.getOwnPropertyDescriptor(
                proto,
                name
            );

            if (descriptor && typeof descriptor.value === "function") return descriptor.value;

            proto = Object.getPrototypeOf(proto);
        }

        return undefined;
    }

    /**
     * Returns (and caches) the function names defined on a model subclass
     * prototype -- relation accessors and helpers -- avoiding a `typeof target[key]`
     * prototype walk on every attribute read.
     *
     * @param {object} ctor - The model constructor.
     * @returns {Set<string>} The subclass function-name set.
     */
    private static relationMethodKeys(ctor: object): Set<string> {
        let keys: Set<string> | undefined = RELATION_METHOD_SETS.get(ctor);

        if (!keys) {
            keys = new Set<string>();

            let proto: any = (ctor as any).prototype;

            while (proto && proto !== Model.prototype) {
                for (const key of Object.getOwnPropertyNames(proto)) {
                    if (typeof proto[key] === "function") keys.add(key);
                }

                proto = Object.getPrototypeOf(proto);
            }

            RELATION_METHOD_SETS.set(ctor, keys);
        }

        return keys;
    }

    /**
     * Captures an independent baseline for dirty checking after load/save.
     *
     * @param {Record<string, any>} [attributes] - The attributes to snapshot, defaulting to the current attributes.
     */
    private syncOriginal(attributes: Record<string, any> = this._attributes): void {
        this._original = (this.constructor as typeof Model).snapshotValue(attributes);
    }

    /**
     * Returns a callable/thenable accessor for a relation method, so both
     * `await model.posts` and `model.posts()` perform a lazy load and
     * cache the result under the relation name.
     *
     * @param {any} target - The proxied target.
     * @param {string} key - Relation accessor name.
     * @returns {any} The accessor function.
     */
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
                const error: RelationException = new RelationException(
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

    /**
     * Rehydrates json/array/object-cast columns back to objects so Bun's pg
     * driver stores a real JSON value instead of a double-encoded JSON scalar
     * string (`meta #> '{grade}'` would be NULL after a pre-stringified write).
     *
     * @param {Record<string, any>} outgoing - The pre-serialized insert/update payload.
     */
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

    /**
     * Wraps a cached relation array into a callable that can also be
     * invoked as a method (returning a fresh Relation) while still
     * behaving like the underlying array during iteration/length checks.
     *
     * @param {any} target - The proxied target.
     * @param {string} key - Relation accessor name.
     * @param {Array<any>} cached - The cached related rows.
     * @returns {Array<any>} The callable array.
     */
    private callableRelation(target: any, key: string, cached: Array<any>): Array<any> {
        const accessor: any = this.relationAccessor(target, key);

        const proxy: any = new Proxy(accessor, {
            get: (t: any, prop: any): any => {
                if (prop === "then") {
                    return (resolve: any, reject: any): Promise<any> => {
                        return Promise.resolve(cached).then(resolve, reject);
                    };
                }

                if (prop in cached) return Reflect.get(cached, prop, cached);

                const value: any = Reflect.get(t, prop, t);

                return typeof value === "function" ? value.bind(t) : value;
            }
        });

        return proxy as Array<any>;
    }
}

/**
 * The exported `Model` is the class wrapped in a Proxy. The `get` trap
 * forwards any unknown static access that matches a `QueryBuilder` method to
 * a scoped builder, allowing `User.where(...).get()`,
 * `User.orderBy(...).first()`, `User.count()`, `User.pluck("name")`, ... all
 * work without an explicit `.query()`. Existing static methods (`find`,
 * `create`, `where`, `has`, `firstOrNew`, ...) and static data (`tableName`,
 * `idColumn`, `fillable`, ...) take precedence.
 */
export default new Proxy(Model, {
    get(target: typeof Model, prop: string | symbol, receiver: any): any {
        if (prop in target) return Reflect.get(target, prop, receiver);

        if (typeof prop === "string" && prop !== "then" && prop in QueryBuilder.prototype) {
            return (...args: Array<any>): any => {
                const builder: QueryBuilder = Reflect.apply(target.query, receiver, []);

                return builder[prop](...args);
            };
        }

        return undefined;
    }
}) as typeof Model;
