import type {ModelInstance} from "@/types/model";
import type {RelationType} from "@/types/relation";
import Str from "@bejibun/utils/facades/Str";
import Model from "@/bases/Model";
import QueryBuilder from "@/builders/QueryBuilder";
import RelationException from "@/exceptions/RelationException";

/**
 * Model relationship container. A `Relation` is returned by
 * model relation methods (`posts() { return this.hasMany(Post); }`).
 *
 * Supports lazy loading via `await model.posts` (thenable) or explicit
 * `model.posts().get()`, plus batch eager loading through the model.
 */
export default class Relation {
    /** Type of relationship. */
    public type: RelationType;

    /** The parent model instance the relation originates from. */
    public parent: ModelInstance<any>;

    /** The related model class. */
    public related: any;

    /**
     * The foreign key column -- on the target/child table for has* and
     * morphMany, on THIS table for `belongsTo`, and on the pivot table for
     * the many-to-many types.
     */
    public foreignKey: string;

    /**
     * The owner key column -- on this/parent table for has*, on the RELATED
     * table for `belongsTo`, and on the through/pivot row otherwise.
     */
    public ownerKey: string;

    /** Accessor name (set when resolved through the model proxy). */
    public name?: string;

    /** Pivot table name (belongsToMany / morphToMany / morphedByMany). */
    declare private pivotTable?: string;

    /** Alias prefix for the pivot's parent FK (see `as()`). */
    declare private pivotAlias?: string;

    /** Pivot model class used to persist attach rows (see `using()`). */
    declare private pivotModel?: any;

    /** FK column on the pivot for the related model. */
    declare private relatedKey?: string;

    /** PK column on the related table. */
    declare private relatedOwnerKey?: string;

    /** Intermediate model class (hasOneThrough / hasManyThrough). */
    declare private through?: any;

    /** Table name of `through` (hasOneThrough / hasManyThrough). */
    declare private throughTable?: string;

    /** FK on the related table referencing the through table. */
    declare private secondKey?: string;

    /** PK on the through table. */
    declare private secondLocalKey?: string;

    /** Morph name (morphTo / morphMany / morphToMany / morphedByMany). */
    declare private morphName?: string;

    /** The pivot's `{name}_type` column (morphToMany / morphedByMany). */
    declare private morphType?: string;

    /** The `{name}_type` column. */
    declare private typeColumn?: string;

    /** Extra columns to select from the pivot table. */
    private pivotColumns: Array<string> = [];

    /**
     * Optional query constraint applied to the eager-load (one-shot) query.
     * Set only while `eagerLoad` runs; lazy `await model.posts` is unconstrained.
     */
    private constraints?: (builder: any) => any;

    /**
     * Creates a Relation instance with the given type and key columns.
     * Prefer the static factories (`hasMany`, `belongsTo`, ...) over this.
     *
     * @param {Relation["type"]} type - The relationship type.
     * @param {ModelInstance<any>} parent - The parent model instance the relation originates from.
     * @param {any} related - The related model class.
     * @param {string} foreignKey - The foreign key column on the target/child table.
     * @param {string} ownerKey - The owner key column on the parent table.
     */
    private constructor(
        type: RelationType,
        parent: ModelInstance<any>,
        related: any,
        foreignKey: string,
        ownerKey: string
    ) {
        this.type = type;
        this.parent = parent;
        this.related = related;
        this.foreignKey = foreignKey;
        this.ownerKey = ownerKey;
    }

    /**
     * Creates a "has one" relation.
     *
     * @param {ModelInstance<any>} parent - The parent model instance.
     * @param {any} related - The related model class.
     * @param {string} [foreignKey] - FK column on the child table.
     * @param {string} [ownerKey] - PK column on the parent table.
     * @returns {Relation} The relation.
     */
    public static hasOne(
        parent: ModelInstance<any>,
        related: any,
        foreignKey?: string,
        ownerKey?: string
    ): Relation {
        return Relation.hasMany(parent, related, foreignKey, ownerKey).one();
    }

    /**
     * Creates a "has many" relation.
     *
     * FK defaults to `{snake_case(parent short name)}_id`; owner key defaults
     * to the parent's primary key.
     *
     * @param {ModelInstance<any>} parent - The parent model instance.
     * @param {any} related - The related model class.
     * @param {string} [foreignKey] - FK column on the child table.
     * @param {string} [ownerKey] - PK column on the parent table.
     * @returns {Relation} The relation.
     */
    public static hasMany(
        parent: ModelInstance<any>,
        related: any,
        foreignKey?: string,
        ownerKey?: string
    ): Relation {
        return new Relation(
            "hasMany",
            parent,
            related,
            foreignKey || `${Str.toSnakeCase(parent.constructor.name)}_id`,
            ownerKey || (parent.constructor as typeof Model).idColumn || "id"
        );
    }

    /**
     * Creates a "has one through" relation.
     *
     * @param {ModelInstance<any>} parent - The parent model instance.
     * @param {any} related - The final related model class.
     * @param {any} through - The intermediate model class.
     * @param {string} [firstKey] - FK on the through table referencing parent.
     * @param {string} [secondKey] - FK on the related table referencing through.
     * @param {string} [localKey] - PK on the parent table.
     * @param {string} [secondLocalKey] - PK on the through table.
     * @returns {Relation} The relation.
     */
    public static hasOneThrough(
        parent: ModelInstance<any>,
        related: any,
        through: any,
        firstKey?: string,
        secondKey?: string,
        localKey?: string,
        secondLocalKey?: string
    ): Relation {
        return Relation.hasManyThrough(
            parent,
            related,
            through,
            firstKey,
            secondKey,
            localKey,
            secondLocalKey
        ).one();
    }

    /**
     * Creates a "has many through" relation.
     *
     * @param {ModelInstance<any>} parent - The parent model instance.
     * @param {any} related - The final related model class.
     * @param {any} through - The intermediate model class.
     * @param {string} [firstKey] - FK on the through table referencing parent.
     * @param {string} [secondKey] - FK on the related table referencing through.
     * @param {string} [localKey] - PK on the parent table.
     * @param {string} [secondLocalKey] - PK on the through table.
     * @returns {Relation} The relation.
     */
    public static hasManyThrough(
        parent: ModelInstance<any>,
        related: any,
        through: any,
        firstKey?: string,
        secondKey?: string,
        localKey?: string,
        secondLocalKey?: string
    ): Relation {
        const parentSnake: string = Str.toSnakeCase(parent.constructor.name) as string;
        const throughSnake: string = Str.toSnakeCase(through?.name || "through") as string;

        const relation: Relation = new Relation(
            "hasManyThrough",
            parent,
            related,
            firstKey || `${parentSnake}_id`,
            localKey || (parent.constructor as typeof Model).idColumn || "id"
        );

        relation.through = through;
        relation.throughTable = Relation.tableOf(through);
        relation.secondKey = secondKey || `${throughSnake}_id`;
        relation.secondLocalKey = secondLocalKey || "id";

        return relation;
    }

    /**
     * Creates a "belongs to" relation.
     *
     * FK defaults to `{snake_case(accessor name)}_id` (falls back to the
     * snake_case related short name when unnamed).
     *
     * @param {ModelInstance<any>} parent - The parent model instance.
     * @param {any} related - The related model class.
     * @param {string} [foreignKey] - FK column on this table.
     * @param {string} [ownerKey] - PK column on the related table.
     * @param {string} [name] - Accessor name (relation method name).
     * @returns {Relation} The relation.
     */
    public static belongsTo(
        parent: ModelInstance<any>,
        related: any,
        foreignKey?: string,
        ownerKey?: string,
        name?: string
    ): Relation {
        const resolvedName: string =
            name || (Str.toSnakeCase(related?.name || "related") as string);

        return new Relation(
            "belongsTo",
            parent,
            related,
            foreignKey || `${resolvedName}_id`,
            ownerKey || related?.idColumn || "id"
        );
    }

    /**
     * Creates a "belongs to many" (pivot-backed) relation.
     *
     * @param {ModelInstance<any>} parent - The parent model instance.
     * @param {any} related - The related model class.
     * @param {string} [pivotTable] - Pivot table name.
     * @param {string} [foreignKey] - FK column on the pivot for the parent.
     * @param {string} [relatedKey] - FK column on the pivot for the related.
     * @param {string} [ownerKey] - PK column on the parent table.
     * @param {string} [relatedOwnerKey] - PK column on the related table.
     * @returns {Relation} The relation.
     */
    public static belongsToMany(
        parent: ModelInstance<any>,
        related: any,
        pivotTable?: string,
        foreignKey?: string,
        relatedKey?: string,
        ownerKey?: string,
        relatedOwnerKey?: string
    ): Relation {
        const parentSnake: string = Str.toSnakeCase(parent?.constructor?.name || "model") as string;
        const relatedSnake: string = Str.toSnakeCase(related?.name || "related") as string;
        const sorted: Array<string> = [parentSnake, relatedSnake].sort();

        const relation: Relation = new Relation(
            "belongsToMany",
            parent,
            related,
            foreignKey || `${parentSnake}_id`,
            ownerKey || "id"
        );

        relation.pivotTable = pivotTable || `${sorted[0]}_${sorted[1]}`;
        relation.relatedKey = relatedKey || `${relatedSnake}_id`;
        relation.relatedOwnerKey = relatedOwnerKey || "id";

        return relation;
    }

    /**
     * Creates a polymorphic "morph to" relation (owner side).
     *
     * @param {ModelInstance<any>} parent - The parent model instance.
     * @param {any} related - The related model class (used as fallback).
     * @param {string} [name] - Morph name (defaults to the accessor).
     * @param {string} [typeColumn] - The `{name}_type` column.
     * @param {string} [idColumn] - The `{name}_id` column.
     * @returns {Relation} The relation.
     */
    public static morphTo(
        parent: ModelInstance<any>,
        related: any,
        name?: string,
        typeColumn?: string,
        idColumn?: string
    ): Relation {
        const morphName: string =
            name || (Str.toSnakeCase(related?.name || "commentable") as string);
        const relation: Relation = new Relation(
            "morphTo",
            parent,
            related,
            idColumn || `${morphName}_id`,
            "id"
        );

        relation.morphName = morphName;
        relation.typeColumn = typeColumn || `${morphName}_type`;

        return relation;
    }

    /**
     * Creates a polymorphic "morph many" relation (thumb side).
     *
     * @param {ModelInstance<any>} parent - The parent model instance.
     * @param {any} related - The related model class.
     * @param {string} name - Morph name.
     * @param {string} [typeColumn] - The `{name}_type` column.
     * @param {string} [idColumn] - The `{name}_id` column.
     * @param {string} [ownerKey] - PK on the parent table.
     * @returns {Relation} The relation.
     */
    public static morphMany(
        parent: ModelInstance<any>,
        related: any,
        name: string,
        typeColumn?: string,
        idColumn?: string,
        ownerKey?: string
    ): Relation {
        const relation: Relation = new Relation(
            "morphMany",
            parent,
            related,
            idColumn || `${name}_id`,
            ownerKey || (parent.constructor as typeof Model).idColumn || "id"
        );

        relation.morphName = name;
        relation.typeColumn = typeColumn || `${name}_type`;

        return relation;
    }

    /**
     * Creates a polymorphic "morph to many" relation (many-to-many pivot).
     *
     * @param {ModelInstance<any>} parent - The parent model instance.
     * @param {any} related - The related model class.
     * @param {string} name - Morph name.
     * @param {string} [table] - Pivot table name.
     * @param {string} [pivotForeignKey] - Parent FK on the pivot.
     * @param {string} [relatedKey] - Related FK on the pivot.
     * @param {string} [parentKey] - PK on the parent table.
     * @param {string} [relatedOwnerKey] - PK on the related table.
     * @returns {Relation} The relation.
     */
    public static morphToMany(
        parent: ModelInstance<any>,
        related: any,
        name: string,
        table?: string,
        pivotForeignKey?: string,
        relatedKey?: string,
        parentKey?: string,
        relatedOwnerKey?: string
    ): Relation {
        const relation: Relation = new Relation(
            "morphToMany",
            parent,
            related,
            pivotForeignKey || `${name}_id`,
            parentKey || "id"
        );

        relation.morphName = name;
        relation.pivotTable =
            table || `${Str.toSnakeCase(related?.name)}able_${Str.toSnakeCase(related?.name)}`;
        relation.relatedKey = relatedKey || `${Str.toSnakeCase(related?.name)}_id`;
        relation.relatedOwnerKey = relatedOwnerKey || "id";
        relation.morphType = `${name}_type`;

        return relation;
    }

    /**
     * Creates a polymorphic "morphed by many" relation (owner side of morphToMany).
     *
     * @param {ModelInstance<any>} parent - The parent model instance.
     * @param {any} related - The related model class.
     * @param {string} name - Morph name.
     * @param {string} [table] - Pivot table name.
     * @param {string} [pivotForeignKey] - Parent FK on the pivot.
     * @param {string} [relatedKey] - Related FK on the pivot.
     * @param {string} [parentKey] - PK on the parent table.
     * @param {string} [relatedOwnerKey] - PK on the related table.
     * @returns {Relation} The relation.
     */
    public static morphedByMany(
        parent: ModelInstance<any>,
        related: any,
        name: string,
        table?: string,
        pivotForeignKey?: string,
        relatedKey?: string,
        parentKey?: string,
        relatedOwnerKey?: string
    ): Relation {
        const relatedSnake: string = Str.toSnakeCase(related?.name || "related") as string;
        const relation: Relation = new Relation(
            "morphedByMany",
            parent,
            related,
            pivotForeignKey || `${relatedSnake}_id`,
            parentKey || "id"
        );

        relation.morphName = name;
        relation.pivotTable =
            table ||
            `${Str.toSnakeCase(parent?.constructor?.name)}able_${Str.toSnakeCase(parent?.constructor?.name)}`;
        relation.relatedKey = relatedKey || `${name}_id`;
        relation.relatedOwnerKey = relatedOwnerKey || "id";
        relation.morphType = `${name}_type`;

        return relation;
    }

    /**
     * The pivot table (belongsToMany only).
     *
     * @returns {string} The pivot table name.
     */
    public pivot(): string {
        return this.pivotTable!;
    }

    /**
     * Customizes the pivot foreign-key alias, e.g.
     * `as("subscriber")` makes the alias `subscriber_user_id`.
     *
     * @param {string} alias - The alias prefix.
     * @returns {Relation} This relation, for chaining.
     */
    public as(alias: string): Relation {
        this.pivotAlias = alias;

        return this;
    }

    /**
     * Sets a custom pivot model class. `attach()` then persists pivot rows
     * through model instances (casts, events, timestamps apply).
     *
     * @param {typeof Model} pivotModel - The pivot model class (extends `Model`).
     * @returns {Relation} This relation, for chaining.
     */
    public using(pivotModel: typeof Model): Relation {
        this.pivotModel = pivotModel;

        return this;
    }

    /**
     * Selects extra pivot columns on the related query.
     *
     * @param {Array<string>} columns - Pivot columns to fetch.
     * @returns {Relation} This relation, for chaining.
     */
    public withPivot(...columns: Array<string>): Relation {
        this.pivotColumns.push(...columns);

        return this;
    }

    /**
     * Builds a query builder scoped to this parent's relation.
     *
     * @returns {QueryBuilder} The scoped query.
     */
    public query(): QueryBuilder {
        switch (this.type) {
            case "belongsTo":
                return this.related
                    .query()
                    .where(this.ownerKey, "=", this.parent.getAttribute(this.foreignKey));
            case "belongsToMany":
                return this.related
                    .query()
                    .select(
                        `${Relation.tableOf(this.related)}.*`,
                        ...this.pivotColumns.map(
                            (column: string) => `${this.pivot()}.${column} AS ${column}`
                        )
                    )
                    .join(
                        this.pivot(),
                        `${this.pivot()}.${this.relatedKey!}`,
                        "=",
                        `${Relation.tableOf(this.related)}.${this.relatedOwnerKey!}`
                    )
                    .where(
                        `${this.pivot()}.${this.foreignKey}`,
                        "=",
                        this.parent.getAttribute(this.ownerKey)
                    );
            case "hasManyThrough":
                return this.related
                    .query()
                    .join(
                        this.throughTable!,
                        `${this.throughTable!}.${this.secondKey!}`,
                        "=",
                        `${Relation.tableOf(this.related)}.${this.secondLocalKey!}`
                    )
                    .where(
                        `${this.throughTable!}.${this.foreignKey}`,
                        "=",
                        this.parent.getAttribute(this.ownerKey)
                    );
            case "morphTo": {
                const typeName: any = this.parent.getAttribute(this.typeColumn!);
                const id: any = this.parent.getAttribute(this.foreignKey);

                if (!typeName || id === null || id === undefined)
                    return new QueryBuilder("__empty__").whereRaw("1 = 0");

                const modelClass: any = this.related || this.resolveMorphModel(typeName);

                return modelClass.query().where(modelClass.idColumn || "id", "=", id);
            }
            case "morphMany":
                return this.related
                    .query()
                    .where(
                        `${Relation.tableOf(this.related)}.${this.typeColumn!}`,
                        "=",
                        this.parent.constructor.name
                    )
                    .where(
                        `${Relation.tableOf(this.related)}.${this.foreignKey}`,
                        "=",
                        this.parent.getAttribute(this.ownerKey)
                    );
            case "morphToMany":
            case "morphedByMany":
                return this.related
                    .query()
                    .select(`${Relation.tableOf(this.related)}.*`)
                    .join(
                        this.pivotTable!,
                        `${this.pivotTable!}.${this.relatedKey!}`,
                        "=",
                        `${Relation.tableOf(this.related)}.${this.relatedOwnerKey!}`
                    )
                    .where(
                        `${this.pivotTable!}.${this.morphType!}`,
                        "=",
                        this.parent.constructor.name
                    )
                    .where(
                        `${this.pivotTable!}.${this.foreignKey}`,
                        "=",
                        this.parent.getAttribute(this.ownerKey)
                    );
            default:
                return this.related
                    .query()
                    .where(this.foreignKey, "=", this.parent.getAttribute(this.ownerKey));
        }
    }

    /**
     * Populates a sub-query builder with the existence check for this
     * relation, linking the related table back to the parent table via
     * qualified `whereColumn` comparisons. Used by `has`/`whereHas`/
     * `doesntHave` for `EXISTS` subqueries.
     *
     * @param {QueryBuilder} sub - The sub-query builder (table not yet set).
     * @param {string} parentTable - The parent model's table name.
     * @param {string} [operator] - Comparison operator for the count case (`>=`).
     * @param {number} [count] - Minimum/maximum count (`1`).
     */
    public applyExistenceQuery(
        sub: QueryBuilder,
        parentTable: string,
        operator: string = ">=",
        count: number = 1
    ): void {
        const relatedTable: string = Relation.tableOf(this.related);
        const useCount: boolean = !(operator === ">=" && count === 1);

        sub.from(relatedTable);

        switch (this.type) {
            case "belongsTo":
                sub.whereColumn(
                    `${relatedTable}.${this.ownerKey}`,
                    "=",
                    `${parentTable}.${this.foreignKey}`
                );

                break;
            case "belongsToMany": {
                sub.join(
                    this.pivot(),
                    `${this.pivot()},${this.relatedKey!}`,
                    "=",
                    `${relatedTable}.${this.relatedOwnerKey!}`
                );
                sub.whereColumn(
                    `${this.pivot()}.${this.foreignKey}`,
                    "=",
                    `${parentTable}.${this.ownerKey}`
                );

                if (useCount)
                    this.countConstraint(
                        sub,
                        `${this.pivot()}.${this.foreignKey}`,
                        operator,
                        count
                    );

                break;
            }
            case "hasManyThrough":
            case "hasOneThrough": {
                sub.join(
                    this.throughTable!,
                    `${this.throughTable!},${this.secondKey!}`,
                    "=",
                    `${relatedTable}.${this.secondLocalKey!}`
                );
                sub.whereColumn(
                    `${this.throughTable!}.${this.foreignKey}`,
                    "=",
                    `${parentTable}.${this.ownerKey}`
                );

                if (useCount)
                    this.countConstraint(
                        sub,
                        `${this.throughTable!}.${this.foreignKey}`,
                        operator,
                        count
                    );

                break;
            }
            case "morphMany": {
                sub.where(`${relatedTable}.${this.typeColumn!}`, "=", this.parent.constructor.name);
                sub.whereColumn(
                    `${relatedTable}.${this.foreignKey}`,
                    "=",
                    `${parentTable}.${this.ownerKey}`
                );

                if (useCount)
                    this.countConstraint(
                        sub,
                        `${relatedTable}.${this.foreignKey}`,
                        operator,
                        count
                    );

                break;
            }
            case "morphToMany":
            case "morphedByMany": {
                sub.join(
                    this.pivotTable!,
                    `${this.pivotTable!}.${this.relatedKey!}`,
                    "=",
                    `${relatedTable}.${this.relatedOwnerKey!}`
                );
                sub.where(
                    `${this.pivotTable!}.${this.morphType!}`,
                    "=",
                    this.parent.constructor.name
                );
                sub.whereColumn(
                    `${this.pivotTable!}.${this.foreignKey}`,
                    "=",
                    `${parentTable}.${this.ownerKey}`
                );

                if (useCount)
                    this.countConstraint(
                        sub,
                        `${this.pivotTable!}.${this.foreignKey}`,
                        operator,
                        count
                    );

                break;
            }
            case "morphTo":
                throw new RelationException(
                    "has()/whereHas() is not supported for morphTo relations (dynamic target type)."
                );
            default: {
                sub.whereColumn(
                    `${relatedTable}.${this.foreignKey}`,
                    "=",
                    `${parentTable}.${this.ownerKey}`
                );

                if (useCount)
                    this.countConstraint(
                        sub,
                        `${relatedTable}.${this.foreignKey}`,
                        operator,
                        count
                    );
            }
        }
    }

    /**
     * Makes the relation thenable so `await model.posts` performs a lazy
     * load and caches the result onto the parent.
     *
     * @param {any} resolve - Promise resolver.
     * @param {any} reject - Promise rejecter.
     * @returns {Promise<any>} The relation result.
     */
    public then(resolve: any, reject: any): Promise<any> {
        return this.get().then((result: any) => {
            if (this.name && this.parent) this.parent._relations[this.name!] = result;

            return resolve(result);
        }, reject);
    }

    /**
     * Fetches the related row(s) for the current parent. Resolves to a
     * single model -- or `null` when there is none -- for
     * hasOne/belongsTo/morphTo, an array otherwise.
     *
     * @returns {Promise<any>} The related model(s).
     */
    public async get(): Promise<any> {
        const rows: Array<Record<string, any>> = await this.query().getRaw();

        if (this.type === "hasOne" || this.type === "belongsTo" || this.type === "morphTo") {
            const single: Record<string, any> | undefined = rows[0];

            if (!single) return null;

            return ((await this.related.hydrate([single])) as any)[0];
        }

        return this.related.hydrate(rows);
    }

    /**
     * Touches the owner of a belongsTo/morphTo relation (used by the
     * model's `touches` option). Other relation types are no-ops.
     *
     * @returns {Promise<boolean>} True when an owner was loaded and touched.
     */
    public async touch(): Promise<boolean> {
        if (this.type !== "belongsTo" && this.type !== "morphTo") return false;

        const owner: any = await this.get();
        const target: any = Array.isArray(owner) ? owner[0] : owner;

        if (target && typeof target.touch === "function") {
            await target.touch();

            return true;
        }

        return false;
    }

    /**
     * Batch-loads this relation for many parent models (eager loading).
     *
     * @param {Array<ModelInstance>} models - The parent models.
     * @param {string} name - The relation accessor name.
     * @param {(builder: any) => any} [constraints] - Optional constraints for the eager-load query.
     * @returns {Promise<void>} Resolves when loaded.
     */
    public async eagerLoad(
        models: Array<ModelInstance>,
        name: string,
        constraints?: (builder: any) => any
    ): Promise<void> {
        this.name = name;
        this.constraints = constraints;

        if (models.length === 0) return;

        switch (this.type) {
            case "belongsTo":
                await this.eagerLoadBelongsTo(models, name);

                return;
            case "belongsToMany":
                await this.eagerLoadBelongsToMany(models, name);

                return;
            case "hasOneThrough":
            case "hasManyThrough":
                await this.eagerLoadHasManyThrough(models, name);

                return;
            case "morphTo":
                await this.eagerLoadMorphTo(models, name);

                return;
            case "morphMany":
                await this.eagerLoadMorphMany(models, name);

                return;
            case "morphToMany":
            case "morphedByMany":
                await this.eagerLoadMorphToMany(models, name);

                return;
            default:
                await this.eagerLoadHasMany(models, name);
        }
    }

    /**
     * Attaches related records to the pivot (belongsToMany only).
     *
     * @param {any} ids - Id or array of ids to attach.
     * @param {Record<string, any>} attributes - Extra pivot columns.
     * @returns {Promise<number>} Number of pivot rows inserted.
     */
    public async attach(ids: any, attributes: Record<string, any> = {}): Promise<number> {
        const list: Array<any> = Array.isArray(ids) ? ids : [ids];

        if (list.length === 0 || !this.pivot()) return 0;

        if (this.pivotModel) {
            for (const id of list) {
                const instance: ModelInstance = this.pivotModel.newInstance(
                    {
                        [this.foreignKey]: this.parent.getAttribute(this.ownerKey),
                        [this.relatedKey!]: id,
                        ...attributes
                    },
                    false
                );

                await instance.save();
            }

            return list.length;
        }

        const builder: QueryBuilder = new QueryBuilder(this.pivot());
        const rows: Array<Record<string, any>> = list.map((id: any) => ({
            [this.foreignKey]: this.parent.getAttribute(this.ownerKey),
            [this.relatedKey!]: id,
            ...attributes
        }));

        await builder.insert(rows);

        return rows.length;
    }

    /**
     * Detaches related records from the pivot (belongsToMany only).
     *
     * @param {any} [ids] - Id or array of ids to detach; all when omitted.
     * @returns {Promise<number>} Number of pivot rows removed.
     */
    public async detach(ids?: any): Promise<number> {
        if (!this.pivot()) return 0;

        const builder: QueryBuilder = new QueryBuilder(this.pivot()).where(
            this.foreignKey,
            "=",
            this.parent.getAttribute(this.ownerKey)
        );

        if (ids !== undefined) {
            const list: Array<any> = Array.isArray(ids) ? ids : [ids];

            if (list.length > 0) builder.whereIn(this.relatedKey!, list);
        }

        return builder.delete();
    }

    /**
     * Checks whether a related record is attached on the pivot.
     *
     * @param {any} id - The related record id.
     * @returns {Promise<boolean>} True when attached.
     */
    public async hasAttached(id: any): Promise<boolean> {
        if (!this.pivot()) return false;

        return await new QueryBuilder(this.pivot())
            .where(this.foreignKey, "=", this.parent.getAttribute(this.ownerKey))
            .where(this.relatedKey!, "=", id)
            .exists();
    }

    /**
     * Syncs the pivot to the given ids, detaching anything not listed.
     *
     * @param {any} ids - Id or array of ids to keep.
     * @param {Record<string, any>} attributes - Extra pivot columns.
     * @returns {Promise<number>} Number of pivot rows after sync.
     */
    public async sync(ids: any, attributes: Record<string, any> = {}): Promise<number> {
        const list: Array<any> = Array.isArray(ids) ? ids : [ids];

        await this.detach();

        if (list.length > 0) await this.attach(list, attributes);

        return list.length;
    }

    /**
     * Associates a related model and persists the foreign key. For
     * belongsTo this updates the parent; for hasOne/hasMany it writes
     * the child's FK.
     *
     * @param {ModelInstance<any>} child - The related model.
     * @returns {Promise<void>} Resolves when the model has been saved.
     */
    public async save(child: ModelInstance<any>): Promise<void> {
        if (this.type === "belongsTo") {
            this.parent.setAttribute(this.foreignKey, child.getAttribute(this.ownerKey));

            await this.parent.save();
        } else {
            child.setAttribute(this.foreignKey, this.parent.getAttribute(this.ownerKey));

            await child.save();
        }
    }

    /**
     * Creates and saves a new related model, wiring the FK.
     *
     * @param {Record<string, any>} attributes - The child attributes.
     * @returns {Promise<any>} The new related model.
     */
    public create(attributes: Record<string, any> = {}): Promise<any> {
        const child: any = new this.related(attributes);

        return this.save(child).then(() => child);
    }

    /**
     * Infers the table name when a related model does not declare one.
     *
     * @param {any} related - The related model class.
     * @returns {string} The declared or inferred table name.
     */
    private static tableOf(related: any): string {
        return (
            related?.tableName ||
            (Str.toSnakeCase(related?.name || "model", "_", true).pluralize() as string)
        );
    }

    /**
     * Applies eager-load constraints to a query builder (no-op when unset).
     *
     * @param {any} builder - The query builder to constrain.
     * @returns {any} The replacement builder or the original builder.
     */
    private applyConstraints(builder: any): any {
        if (!this.constraints) return builder;

        const result: any = this.constraints(builder);

        return result instanceof QueryBuilder ? result : builder;
    }

    /**
     * Restricts the given builder to rows whose related owner column matches
     * `keys` (`where` for a single key, `whereIn` otherwise).
     *
     * @param {QueryBuilder} builder - The related query builder.
     * @param {Array<any>} keys - The related keys to constrain by.
     * @param {string} [column] - The related owner column (defaults to relatedOwnerKey).
     * @returns {QueryBuilder} The constrained builder.
     */
    private constrained(builder: QueryBuilder, keys: Array<any>, column?: string): QueryBuilder {
        const col: string = column || this.relatedOwnerKey || this.ownerKey;

        if (keys.length === 1) return builder.where(col, "=", keys[0]);

        return builder.whereIn(col, keys);
    }

    /**
     * Applies a GROUP BY + HAVING COUNT(...) constraint for the `has`
     * count form (e.g. `has('posts', '>=', 3)`).
     *
     * @param {QueryBuilder} sub - The sub-query builder.
     * @param {string} column - The column to group by (qualified).
     * @param {string} operator - Comparison operator.
     * @param {number} count - The count threshold.
     */
    private countConstraint(
        sub: QueryBuilder,
        column: string,
        operator: string,
        count: number
    ): void {
        sub.select(column);
        sub.groupBy(column);
        sub.havingRaw(`COUNT(*) ${operator} ?`, [count]);
    }

    /**
     * Marks a hasMany relation as a single-child hasOne.
     *
     * @returns {Relation} This relation, retyped.
     */
    private one(): Relation {
        this.type = "hasOne";

        return this;
    }

    /**
     * Resolves a morph type string to its model class.
     *
     * @param {string} type - The stored morph type (class name).
     * @returns {any} The resolved model class.
     */
    private resolveMorphModel(type: string): any {
        if (this.related) return this.related;

        throw new RelationException(
            `Cannot resolve morph type "${type}" -- pass the related class to morphTo().`
        );
    }

    /**
     * Null-safe alias under which the pivot's parent FK is selected.
     *
     * @returns {string} The alias, e.g. `pivot_parent_id` (or `subscriber_parent_id`
     * when customized with `as()`).
     */
    private pivotKeyAlias(): string {
        return `${this.pivotAlias || "pivot"}_${this.foreignKey}`;
    }

    /**
     * Eager-loads a belongsTo relation via `WHERE ownerKey IN (...)`; parents
     * without an FK key get `null`.
     *
     * @param {Array<ModelInstance>} models - The parent models.
     * @param {string} name - The relation accessor name.
     * @returns {Promise<void>} Resolves when loaded.
     */
    private async eagerLoadBelongsTo(models: Array<ModelInstance>, name: string): Promise<void> {
        const keys: Array<any> = [
            ...new Set(models.map((model: ModelInstance) => model.getAttribute(this.foreignKey)))
        ].filter((key: any) => key !== null && key !== undefined);

        if (keys.length === 0) {
            for (const model of models) model._relations[name] = null;

            return;
        }

        const rows: Array<Record<string, any>> = await this.applyConstraints(
            this.constrained(this.related.query(), keys, this.ownerKey)
        ).getRaw();
        const indexed: Record<string, Record<string, any>> = Object.create(null);

        for (const row of rows) indexed[row[this.ownerKey]] = row;

        for (const model of models) {
            const match: Record<string, any> | undefined =
                indexed[model.getAttribute(this.foreignKey)];

            model._relations[name] = match
                ? ((await this.related.hydrate([match])) as any)[0]
                : null;
        }
    }

    /**
     * Eager-loads a belongsToMany relation through the pivot table.
     *
     * @param {Array<ModelInstance>} models - The parent models.
     * @param {string} name - The relation accessor name.
     * @returns {Promise<void>} Resolves when loaded.
     */
    private async eagerLoadBelongsToMany(
        models: Array<ModelInstance>,
        name: string
    ): Promise<void> {
        const keys: Array<any> = [
            ...new Set(models.map((model: ModelInstance) => model.getAttribute(this.ownerKey)))
        ].filter((key: any) => key !== null && key !== undefined);

        if (keys.length === 0) {
            for (const model of models) model._relations[name] = [];

            return;
        }

        const rows: Array<Record<string, any>> = await this.applyConstraints(
            this.constrained(
                this.related
                    .query()
                    .select(
                        `${Relation.tableOf(this.related)}.*`,
                        `${this.pivot()}.${this.foreignKey} AS ${this.pivotKeyAlias()}`
                    )
                    .join(
                        this.pivot(),
                        `${this.pivot()}.${this.relatedKey!}`,
                        "=",
                        `${Relation.tableOf(this.related)}.${this.relatedOwnerKey!}`
                    ),
                keys,
                `${this.pivot()}.${this.foreignKey}`
            )
        ).getRaw();
        const grouped: Record<string, Array<Record<string, any>>> = Object.create(null);

        for (const row of rows) {
            const key: any = row[this.pivotKeyAlias()];

            (grouped[key] ||= []).push(row);
        }

        for (const model of models) {
            model._relations[name] = await this.related.hydrate(
                grouped[model.getAttribute(this.ownerKey)] || []
            );
        }
    }

    /**
     * Eager-loads a hasOneThrough / hasManyThrough relation.
     *
     * @param {Array<ModelInstance>} models - The parent models.
     * @param {string} name - The relation accessor name.
     * @returns {Promise<void>} Resolves when loaded.
     */
    private async eagerLoadHasManyThrough(
        models: Array<ModelInstance>,
        name: string
    ): Promise<void> {
        const keys: Array<any> = [
            ...new Set(models.map((model: ModelInstance) => model.getAttribute(this.ownerKey)))
        ].filter((key: any) => key !== null && key !== undefined);

        if (keys.length === 0) {
            for (const model of models)
                model._relations[name] = this.type === "hasOneThrough" ? null : [];

            return;
        }

        const rows: Array<Record<string, any>> = await this.applyConstraints(
            this.constrained(
                this.related
                    .query()
                    .select(
                        `${Relation.tableOf(this.related)}.*`,
                        `${this.throughTable!}.${this.foreignKey} AS _through_owner_key`
                    )
                    .join(
                        this.throughTable!,
                        `${this.throughTable!}.${this.secondKey!}`,
                        "=",
                        `${Relation.tableOf(this.related)}.${this.secondLocalKey!}`
                    ),
                keys,
                `${this.throughTable!}.${this.foreignKey}`
            )
        ).getRaw();
        const grouped: Record<string, Array<Record<string, any>>> = Object.create(null);

        for (const row of rows) {
            const key: any = row._through_owner_key;

            (grouped[key] ||= []).push(row);
        }

        for (const model of models) {
            const matched: Array<Record<string, any>> =
                grouped[model.getAttribute(this.ownerKey)] || [];

            model._relations[name] =
                this.type === "hasOneThrough"
                    ? matched.length > 0
                        ? ((await this.related.hydrate([matched[0]])) as any)[0]
                        : null
                    : await this.related.hydrate(matched);
        }
    }

    /**
     * Eager-loads a morphTo relation, grouping parents by their stored morph
     * type; each group is queried with `WHERE ownerKey IN (...)` against this
     * relation's single `related` class (types never resolve to different
     * classes). Parents without a stored type get `null`.
     *
     * @param {Array<ModelInstance>} models - The parent models.
     * @param {string} name - The relation accessor name.
     * @returns {Promise<void>} Resolves when loaded.
     */
    private async eagerLoadMorphTo(models: Array<ModelInstance>, name: string): Promise<void> {
        const byType: Map<string, Array<ModelInstance>> = new Map<string, Array<ModelInstance>>();

        for (const model of models) {
            const typeName: any =
                model.getAttribute(this.typeColumn!) || model.getAttribute(`${name}_type`);

            if (typeName === null || typeName === undefined) {
                model._relations[name] = null;

                continue;
            }

            let group: Array<ModelInstance> | undefined = byType.get(typeName);

            if (!group) {
                group = [];

                byType.set(typeName, group);
            }

            group.push(model);
        }

        for (const [typeName, group] of byType) {
            const relatedClass: any = this.related || this.resolveMorphModel(typeName);
            const keys: Array<any> = [
                ...new Set(group.map((model: ModelInstance) => model.getAttribute(this.foreignKey)))
            ].filter((key: any) => key !== null && key !== undefined);

            if (keys.length === 0) {
                for (const model of group) model._relations[name] = null;

                continue;
            }

            const rows: Array<Record<string, any>> = await this.applyConstraints(
                this.constrained(relatedClass.query(), keys, this.ownerKey)
            ).getRaw();
            const indexed: Record<any, Record<string, any>> = Object.create(null);

            for (const row of rows) indexed[row[this.ownerKey]] = row;

            for (const model of group) {
                const match: Record<string, any> | undefined =
                    indexed[model.getAttribute(this.foreignKey)];

                model._relations[name] = match
                    ? ((await relatedClass.hydrate([match])) as any)[0]
                    : null;
            }
        }
    }

    /**
     * Eager-loads a morphMany relation.
     *
     * @param {Array<ModelInstance>} models - The parent models.
     * @param {string} name - The relation accessor name.
     * @returns {Promise<void>} Resolves when loaded.
     */
    private async eagerLoadMorphMany(models: Array<ModelInstance>, name: string): Promise<void> {
        const keys: Array<any> = [
            ...new Set(models.map((model: ModelInstance) => model.getAttribute(this.ownerKey)))
        ].filter((key: any) => key !== null && key !== undefined);

        if (keys.length === 0) {
            for (const model of models) model._relations[name] = [];

            return;
        }

        const rows: Array<Record<string, any>> = await this.applyConstraints(
            this.constrained(
                this.related
                    .query()
                    .select(`${Relation.tableOf(this.related)}.*`)
                    .where(
                        `${Relation.tableOf(this.related)}.${this.typeColumn!}`,
                        "=",
                        this.parent.constructor.name
                    ),
                keys,
                `${Relation.tableOf(this.related)}.${this.foreignKey}`
            )
        ).getRaw();
        const grouped: Record<string, Array<Record<string, any>>> = Object.create(null);

        for (const row of rows) {
            const key: any = row[this.foreignKey];

            (grouped[key] ||= []).push(row);
        }

        for (const model of models) {
            model._relations[name] = await this.related.hydrate(
                grouped[model.getAttribute(this.ownerKey)] || []
            );
        }
    }

    /**
     * Eager-loads a morphToMany / morphedByMany relation.
     *
     * @param {Array<ModelInstance>} models - The parent models.
     * @param {string} name - The relation accessor name.
     * @returns {Promise<void>} Resolves when loaded.
     */
    private async eagerLoadMorphToMany(models: Array<ModelInstance>, name: string): Promise<void> {
        const keys: Array<any> = [
            ...new Set(models.map((model: ModelInstance) => model.getAttribute(this.ownerKey)))
        ].filter((key: any) => key !== null && key !== undefined);

        if (keys.length === 0) {
            for (const model of models) model._relations[name] = [];

            return;
        }

        const rows: Array<Record<string, any>> = await this.applyConstraints(
            this.constrained(
                this.related
                    .query()
                    .select(
                        `${Relation.tableOf(this.related)}.*`,
                        `${this.pivotTable!}.${this.foreignKey} AS _morph_owner_key`
                    )
                    .join(
                        this.pivotTable!,
                        `${this.pivotTable!}.${this.relatedKey!}`,
                        "=",
                        `${Relation.tableOf(this.related)}.${this.relatedOwnerKey!}`
                    )
                    .where(
                        `${this.pivotTable!}.${this.morphType!}`,
                        "=",
                        this.parent.constructor.name
                    ),
                keys,
                `${this.pivotTable!}.${this.foreignKey}`
            )
        ).getRaw();
        const grouped: Record<string, Array<Record<string, any>>> = Object.create(null);

        for (const row of rows) {
            const key: any = row._morph_owner_key;

            (grouped[key] ||= []).push(row);
        }

        for (const model of models) {
            model._relations[name] = await this.related.hydrate(
                grouped[model.getAttribute(this.ownerKey)] || []
            );
        }
    }

    /**
     * Eager-loads a hasOne/hasMany relation via `WHERE fk IN (...)`.
     *
     * @param {Array<ModelInstance>} models - The parent models.
     * @param {string} name - The relation accessor name.
     * @returns {Promise<void>} Resolves when loaded.
     */
    private async eagerLoadHasMany(models: Array<ModelInstance>, name: string): Promise<void> {
        const keys: Array<any> = [
            ...new Set(models.map((model: ModelInstance) => model.getAttribute(this.ownerKey)))
        ].filter((key: any) => key !== null && key !== undefined);

        if (keys.length === 0) {
            for (const model of models) model._relations[name] = [];

            return;
        }

        const rows: Array<Record<string, any>> = await this.applyConstraints(
            this.constrained(this.related.query(), keys, this.foreignKey)
        ).getRaw();
        const grouped: Record<string, Array<Record<string, any>>> = Object.create(null);

        for (const row of rows) {
            const key: any = row[this.foreignKey];

            (grouped[key] ||= []).push(row);
        }

        for (const model of models) {
            const own: Array<Record<string, any>> =
                grouped[model.getAttribute(this.ownerKey)] || [];

            model._relations[name] =
                this.type === "hasOne"
                    ? own.length > 0
                        ? ((await this.related.hydrate([own[0]])) as any)[0]
                        : null
                    : await this.related.hydrate(own);
        }
    }
}
