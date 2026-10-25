import Model from "@/bases/Model";
import QueryBuilder from "@/builders/QueryBuilder";

export type ModelEvent =
    | "creating"
    | "created"
    | "retrieved"
    | "updating"
    | "updated"
    | "deleting"
    | "deleted"
    | "saving"
    | "saved"
    | "restoring"
    | "restored";

export type ModelEventCallback = (
    model: Model<any>
) => boolean | Promise<boolean> | void | Promise<void>;

export type EagerLoadSpec = {
    relation: string;
    constraints?: (builder: QueryBuilder) => any;
};

export type EagerLoadRelation = string | EagerLoadSpec;
