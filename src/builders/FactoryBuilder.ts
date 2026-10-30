import type {StateClosure} from "@/types/factory";
import Model from "@/bases/Model";

export default class FactoryBuilder {
    protected modelClass: typeof Model;
    protected amount: number = 1;
    protected states: Array<StateClosure> = [];

    public constructor(modelClass: typeof Model) {
        this.modelClass = modelClass;
    }

    public count(numberOfModels: number): FactoryBuilder {
        this.amount = numberOfModels;

        return this;
    }

    public state(state: StateClosure): FactoryBuilder {
        this.states.push(state);

        return this;
    }
}
