import type {RelationType} from "@/types/relation";
import Str from "@bejibun/utils/facades/Str";
import QueryBuilder from "@/builders/QueryBuilder";

const tableOf = (related: any): string => {
    return related?.tableName || Str.toSnakeCase(related?.name || "model", "_", true).pluralize() as string;
};

export default class Relation {
    public type: RelationType;
    public parent: any;
    public related: any;
    public foreignKey: string;
    public ownerKey: string;
    public name?: string;

    protected declare pivotTable?: string;
    protected declare relatedKey?: string;
    protected declare relatedOwnerKey?: string;
    protected declare through?: any;
    protected declare throughTable?: string;
    protected declare secondKey?: string;
    protected declare secondLocalKey?: string;
    protected declare morphName?: string;
    protected declare morphType?: string;
    protected declare typeColumn?: string;
    protected declare pivotAlias?: string;
    protected declare pivotModel?: string;

    protected pivotColumns?: Array<string> = [];
    protected constraints?: (builder: any) => any;

    private constructor(type: RelationType, parent: any, related: any, foreignKey: string, ownerKey: string) {
        this.type = type;
        this.parent = parent;
        this.related = related;
        this.foreignKey = foreignKey;
        this.ownerKey = ownerKey;
    }

    public static hasOne(parent: any, related: any, foreignKey?: string, ownerKey?: string): Relation {
        return Relation.hasMany(parent, related, foreignKey, ownerKey).one();
    }

    public static hasMany(parent: any, related: any, foreignKey?: string, ownerKey?: string): Relation {
        return new Relation(
            "hasMany",
            parent,
            related,
            foreignKey || `${Str.toSnakeCase(parent?.constructor?.name || parent)}_id`,
            ownerKey || parent?.constructor?.idColumn || "id"
        )
    }

    public static belongsTo(parent: any, related: any, foreignKey?: string, ownerKey?: string, name?: string): Relation {
        const resolvedName: string = name || (Str.toSnakeCase(related?.name || "related") as string);

        return new Relation(
            "belongsTo",
            parent,
            related,
            foreignKey || `${resolvedName}_id`,
            ownerKey || related?.idColumn || "id"
        );
    }

    public static belongsToMany(parent: any, related: any, pivotTable?: string, foreignKey?: string, relatedKey?: string, ownerKey?: string, relatedOwnerKey?: string): Relation {
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

    public static hasOneThrough(parent: any, related: any, through: any, firstKey?: string, secondKey?: string, localKey?: string, secondLocalKey?: string): Relation {
        return Relation.hasManyThrough(parent, related, through, firstKey, secondKey, localKey, secondLocalKey).one();
    }

    public static hasManyThrough(parent: any, related: any, through: any, firstKey?: string, secondKey?: string, localKey?: string, secondLocalKey?: string): Relation {
        const parentSnake: string = Str.toSnakeCase(parent?.constructor?.name || parent) as string;
        const throughSnake: string = Str.toSnakeCase(through?.name || "through") as string;

        const relation: Relation = new Relation(
            "hasManyThrough",
            parent,
            related,
            firstKey || `${parentSnake}_id`
            localKey || parent?.constructor?.idColumn || "id"
        );

        relation.through = through;
        relation.throughTable = tableOf(through);
        relation.secondKey = secondKey || `${throughSnake}_id`;
        relation.secondLocalKey = secondLocalKey || "id";

        return relation;
    }

    public static morphTo(parent: any, related: any, name?: string, typeColumn?: string, idColumn?: string): Relation {
        const morphName: string = name || Str.toSnakeCase(related?.name || "commentable") as string;

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

    public static morphMany(parent: any, related: any, name: string, typeColumn?: string, idColumn?: string, ownerKey?: string): Relation {
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

    public static morphToMany(parent: any, related: any, name: string, table?: string, pivotForeignKey?: string, relatedKey?: string, parentKey?: string, relatedOwnerKey?: string): Relation {
        const relation: Relation = new Relation(
            "morphToMany",
            parent,
            related,
            pivotForeignKey || `${name}_id`,
            parentKey || "id"
        );

        relation.morphName = name;
        relation.pivotTable = table || `${Str.toSnakeCase(related?.name)}able_${Str.toSnakeCase(related?.name)}`;
        relation.relatedKey = relatedKey || `${Str.toSnakeCase(related?.name)}_id`;
        relation.relatedOwnerKey = relatedOwnerKey || "id";
        relation.morphType = `${name}_type`;

        return relation;
    }

    public static morphedByMany(parent: any, related: any, name: string, table?: string, pivotForeignKey?: string, relatedKey?: string, parentKey?: string, relatedOwnerKey?: string): Relation {
        const relatedSnake: string = Str.toSnakeCase(related?.name || "related") as string;

        const relation: Relation = new Relation(
            "morphedByMany",
            parent,
            related,
            pivotForeignKey || `${relatedSnake}_id`,
            parentKey || "id"
        );

        relation.morphName = name;
        relation.pivotTable = table || `${Str.toSnakeCase(parent?.constructor?.name)}able_${Str.toSnakeCase(parent?.constructor?.name)}`;
        relation.relatedKey = relatedKey || `${name}_id`;
        relation.relatedOwnerKey = relatedOwnerKey || "id";
        relation.morphType = `${name}_type`;

        return relation;
    }

    protected applyConstraints(builder: any): any {
        if (!this.constraints) return builder;

        const result: any = this.constraints(builder);

        return result instanceof QueryBuilder ? result : builder;
    }

    protected one(): Relation {
        this.type = "hasOne";

        return this;
    }
}
