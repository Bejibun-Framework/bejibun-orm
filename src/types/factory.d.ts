/** Definition context passed to a factory definition. */
export type FactoryContext = {
    /** Total number of instances being created. */
    count: number;

    /** Zero-based index of the current instance. */
    index: number;
};

/** A factory definition callback. */
export type Definition = (
    context: FactoryContext
) => Record<string, any> | Promise<Record<string, any>>;

/** A state mutation callback. */
export type StateClosure = (
    attributes: Record<string, any>,
    context: FactoryContext
) => Record<string, any>;
