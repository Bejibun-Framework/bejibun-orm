import type {Definition} from "@/types/factory";
import Model from "@/bases/Model";
import FactoryBuilder from "@/builders/FactoryBuilder";

export default class Factory {
    private static definitions: WeakMap<typeof Model, Definition> = new WeakMap<
        typeof Model,
        Definition
    >();

    public static define(modelClass: typeof Model, definition: Definition): void {
        Factory.definitions.set(modelClass, definition);
    }

    public static model(modelClass: typeof Model): FactoryBuilder {
        return new FactoryBuilder(modelClass);
    }

    public static definitionFor(modelClass: typeof Model): Definition | undefined {
        return Factory.definitions.get(modelClass);
    }
}
