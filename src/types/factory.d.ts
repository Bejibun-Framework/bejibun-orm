export type FactoryContext = {
    count: number;
    index: number;
};

export type Definition = (
    context: FactoryContext
) => Record<string, any> | Promise<Record<string, any>>;

export type StateClosure = (
    attributes: Record<string, any>,
    context: FactoryContext
) => Record<string, any>;
