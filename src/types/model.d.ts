import type {QueryBuilderCallback} from "@/types/query";
import Model from "@/bases/Model";
import QueryBuilder from "@/builders/QueryBuilder";

/**
 * The instance type of a model. Use as a type annotation where the value
 * `Model` (the Proxy-wrapped constructor) cannot be used in type position.
 */
export type ModelInstance<T = Record<string, any>> = Model<T>;

/** Supported model lifecycle events. */
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

/** Callback type for model events. */
export type ModelEventCallback = (
    model: ModelInstance<any>
) => boolean | Promise<boolean> | void | Promise<void>;

/** Normalized eager-load spec (string shorthand expanded into the object form). */
export type EagerLoadSpec = {
    relation: string;
    constraints?: (builder: QueryBuilder) => any;
};

/** A single relation eager-load entry: a plain relation name, or a name plus a query constraint. */
export type EagerLoadRelation = string | EagerLoadSpec;

/** A global query scope with an optional name for selective removal. */
export type GlobalScope = {
    name?: string;
    scope: QueryBuilderCallback;
};
