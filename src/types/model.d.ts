import Model from "@/bases/Model";
import QueryBuilder from "@/builders/QueryBuilder";

export type ModelEventCallback = (
    model: Model<any>
) => boolean | Promise<boolean> | void | Promise<void>;

export type EagerLoadSpec = {
    relation: string;
    constraints?: (builder: QueryBuilder) => any;
}

export type EagerLoadRelation = string | EagerLoadSpec;