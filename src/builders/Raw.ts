export default class Raw {
    public readonly sql: string;
    public readonly bindings: Array<any>;

    public constructor(sql: string, bindings: Array<any> = []) {
        this.sql = sql;
        this.bindings = bindings;
    }

    public toString(): string {
        return this.sql;
    }
}
