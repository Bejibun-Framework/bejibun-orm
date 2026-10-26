import type {RelationType} from "@/types/relation";
import Str from "@bejibun/utils/facades/Str";
import Model from "@/bases/Model";
import QueryBuilder from "@/builders/QueryBuilder";
import RelationException from "@/exceptions/RelationException";

export default class Relation {
    public type: RelationType;
    public parent: any;
    public related: any;
    public foreignKey: string;
    public ownerKey: string;
    public name?: string;

    declare private pivotTable?: string;
    declare private relatedKey?: string;
    declare private relatedOwnerKey?: string;
    declare private through?: any;
    declare private throughTable?: string;
    declare private secondKey?: string;
    declare private secondLocalKey?: string;
    declare private morphName?: string;
    declare private morphType?: string;
    declare private typeColumn?: string;
    declare private pivotAlias?: string;
    declare private pivotModel?: string;

    private pivotColumns?: Array<string> = [];
    private constraints?: (builder: any) => any;

    private constructor(
        type: RelationType,
        parent: any,
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

    public static hasOne(
        parent: any,
        related: any,
        foreignKey?: string,
        ownerKey?: string
    ): Relation {
        return Relation.hasMany(parent, related, foreignKey, ownerKey).one();
    }

    public static hasMany(
        parent: any,
        related: any,
        foreignKey?: string,
        ownerKey?: string
    ): Relation {
        return new Relation(
            "hasMany",
            parent,
            related,
            foreignKey || `${Str.toSnakeCase(parent?.constructor?.name || parent)}_id`,
            ownerKey || parent?.constructor?.idColumn || "id"
        );
    }

    public static belongsTo(
        parent: any,
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

    public static belongsToMany(
        parent: any,
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

    public static hasOneThrough(
        parent: any,
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

    public static hasManyThrough(
        parent: any,
        related: any,
        through: any,
        firstKey?: string,
        secondKey?: string,
        localKey?: string,
        secondLocalKey?: string
    ): Relation {
        const parentSnake: string = Str.toSnakeCase(parent?.constructor?.name || parent) as string;
        const throughSnake: string = Str.toSnakeCase(through?.name || "through") as string;

        const relation: Relation = new Relation(
            "hasManyThrough",
            parent,
            related,
            firstKey || `${parentSnake}_id`,
            localKey || parent?.constructor?.idColumn || "id"
        );

        relation.through = through;
        relation.throughTable = Relation.tableOf(through);
        relation.secondKey = secondKey || `${throughSnake}_id`;
        relation.secondLocalKey = secondLocalKey || "id";

        return relation;
    }

    public static morphTo(
        parent: any,
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

    public static morphMany(
        parent: any,
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
            ownerKey || parent?.constructor?.idColumn || "id"
        );

        relation.morphName = name;
        relation.typeColumn = typeColumn || `${name}_type`;

        return relation;
    }

    public static morphToMany(
        parent: any,
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

    public static morphedByMany(
        parent: any,
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

    public pivot(): string {
        return this.pivotTable!;
    }

    public as(alias: string): Relation {
        this.pivotAlias = alias;

        return this;
    }

    public using(pivotModel: typeof Model): Relation {
        this.pivotModel = pivotModel;

        return this;
    }

    public withPivot(...columns: Array<string>): Relation {
        this.pivotColumns.push(...columns);

        return this;
    }

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

    public async get(): Promise<any> {
        const rows: Array<Record<string, any>> = await this.query().getRaw();

        if (this.type === "hasOne" || this.type === "belongsTo" || this.type === "morphTo") {
            const single: Record<string, any> | undefined = rows[0];

            if (!single) return null;

            return ((await this.related.hydrate([single])) as any)[0];
        }

        return this.related.hydrate(rows);
    }

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

    private applyConstraints(builder: any): any {
        if (!this.constraints) return builder;

        const result: any = this.constraints(builder);

        return result instanceof QueryBuilder ? result : builder;
    }

    private one(): Relation {
        this.type = "hasOne";

        return this;
    }

    private static tableOf(related: any): string {
        return (
            related?.tableName ||
            (Str.toSnakeCase(related?.name || "model", "_", true).pluralize() as string)
        );
    }

    private resolveMorphModel(type: string): any {
        if (this.related) return this.related;

        throw new RelationException(
            `Cannot resolve morph type "${type}" -- pass the related class to morphTo().`
        );
    }

    protected countConstraint(
        sub: QueryBuilder,
        column: string,
        operator: string,
        count: number
    ): void {
        sub.select(column);
        sub.groupBy(column);
        sub.havingRaw(`COUNT(*) ${operator} ?`, [count]);
    }
}
