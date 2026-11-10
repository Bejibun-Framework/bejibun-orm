import type {Definition} from "@/types/factory";
import Model from "@/bases/Model";
import FactoryBuilder from "@/builders/FactoryBuilder";

/**
 * Model factory facade. Register attribute definitions with
 * `Factory.define(Model, fn)` then build/persist instances through
 * `Factory.model(Model)` or the model's `factory()` static.
 */
export default class Factory {
    /** Registered definitions, keyed by model class. */
    private static definitions: WeakMap<typeof Model, Definition> = new WeakMap<
        typeof Model,
        Definition
    >();

    /**
     * Registers a factory definition for a model class.
     *
     * @param {typeof Model} modelClass - The model class.
     * @param {Definition} definition - Returns the attribute map for one instance.
     */
    public static define(modelClass: typeof Model, definition: Definition): void {
        Factory.definitions.set(modelClass, definition);
    }

    /**
     * Returns a factory builder for the given model class.
     *
     * @param {typeof Model} modelClass - The model class.
     * @returns {FactoryBuilder} A factory builder.
     */
    public static model(modelClass: typeof Model): FactoryBuilder {
        return new FactoryBuilder(modelClass);
    }

    /**
     * Reads the definition registered for a model class.
     *
     * @param {typeof Model} modelClass - The model class.
     * @returns {Definition | undefined} The registered definition, if any.
     */
    public static definitionFor(modelClass: typeof Model): Definition | undefined {
        return Factory.definitions.get(modelClass);
    }
}
