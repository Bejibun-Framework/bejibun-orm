import type {Definition, FactoryContext, StateClosure} from "@/types/factory";
import type {ModelInstance} from "@/types/model";
import Model from "@/bases/Model";
import FactoryException from "@/exceptions/FactoryException";
import Factory from "@/facades/Factory";

/**
 * Fluent builder returned by `Factory.model()` / `Model.factory()`.
 */
export default class FactoryBuilder {
    /** The target model class. */
    protected modelClass: typeof Model;

    /** Number of instances to build. */
    protected amount: number = 1;

    /** Pending state mutations. */
    protected states: Array<StateClosure> = [];

    /**
     * Instantiates a factory builder.
     *
     * @param {typeof Model} modelClass - The model class to build.
     */
    public constructor(modelClass: typeof Model) {
        this.modelClass = modelClass;
    }

    /**
     * Sets how many instances to build.
     *
     * @param {number} numberOfModels - The instance count.
     * @returns {this} This builder, for chaining.
     */
    public count(numberOfModels: number): FactoryBuilder {
        this.amount = numberOfModels;

        return this;
    }

    /**
     * Registers a state mutation applied to every definition.
     *
     * @param {StateClosure} state - Receives the merged attributes and returns new ones.
     * @returns {this} This builder, for chaining.
     */
    public state(state: StateClosure): FactoryBuilder {
        this.states.push(state);

        return this;
    }

    /**
     * Builds the instances without persisting them.
     *
     * @param {Record<string, any> | Array<Record<string, any>>} [overrides] - Per-instance or shared attribute overrides.
     * @returns {Promise<any>} One instance, or an array when `count()` was used.
     */
    public async make(overrides?: Record<string, any> | Array<Record<string, any>>): Promise<any> {
        const rows: Array<any> = await this.buildAll(overrides);
        const instances: Array<any> = rows.map((row: any) =>
            this.modelClass.newInstance(row, false)
        );

        return this.amount === 1 ? instances[0] : instances;
    }

    /**
     * Builds and persists the instances, one `save()` per instance in order
     * (no bulk insert). When the model has timestamps they are set
     * automatically by the insert.
     *
     * @param {Record<string, any> | Array<Record<string, any>>} [overrides] - Per-instance or shared attribute overrides.
     * @returns {Promise<any>} One model instance, or an array of them when `count()` was used.
     */
    public async create(
        overrides?: Record<string, any> | Array<Record<string, any>>
    ): Promise<any> {
        const rows: Array<any> = await this.buildAll(overrides);
        const created: Array<any> = [];

        for (const row of rows) {
            const instance: ModelInstance = this.modelClass.newInstance(row, false);

            await instance.save();

            created.push(instance);
        }

        return this.amount === 1 ? created[0] : created;
    }

    /**
     * Sets the builder's `count()` to `count`, then delegates to `create()` --
     * instances are persisted sequentially, one `save()` per instance, not via
     * a single bulk insert.
     *
     * @param {number} [count] - How many instances (defaults to the `count()` value).
     * @param {Record<string, any> | Array<Record<string, any>>} [overrides] - Per-instance or shared attribute overrides.
     * @returns {Promise<Array<any>>} The persisted instances, always as an array.
     */
    public async createMany(
        count: number = this.amount,
        overrides?: Record<string, any> | Array<Record<string, any>>
    ): Promise<Array<any>> {
        this.count(count);

        const result: any = await this.create(overrides);

        return Array.isArray(result) ? result : [result];
    }

    /**
     * Resolves the attribute maps for every instance, applying definitions,
     * state mutators, and overrides.
     *
     * @param {Record<string, any> | Array<Record<string, any>>} overrides - Optional per-instance or shared overrides.
     * @returns {Promise<Array<Record<string, any>>>} The resolved attribute maps.
     */
    private async buildAll(
        overrides?: Record<string, any> | Array<Record<string, any>>
    ): Promise<Array<Record<string, any>>> {
        const definition: Definition | undefined = Factory.definitionFor(this.modelClass);

        if (!definition)
            throw new FactoryException(
                `No factory definition registered for [${this.modelClass.name}]. Call Factory.define() first.`
            );

        const count: number = this.amount;
        const rows: Array<Record<string, any>> = [];
        const overrideList: Array<Record<string, any>> = Array.isArray(overrides)
            ? overrides
            : Array.from({length: count}, () => overrides || {});

        for (let index: number = 0; index < count; index++) {
            const context: FactoryContext = {count, index};
            let attributes: Record<string, any> = await definition(context);

            for (const state of this.states) {
                attributes = {
                    ...attributes,
                    ...state(attributes, context)
                };
            }

            rows.push({
                ...attributes,
                ...overrideList[index]
            });
        }

        return rows;
    }
}
