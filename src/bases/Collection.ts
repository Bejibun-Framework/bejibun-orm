import RecordNotFoundException from "@/exceptions/RecordNotFoundException";

export default class Collection<T = any> implements Iterable<T> {
    protected readonly items: Array<T>;

    public constructor(items: Array<T> = []) {
        this.items = items;
    }

    public [Symbol.iterator](): Iterator<T> {
        return this.items[Symbol.iterator]();
    }

    public all(): Array<T> {
        return [...this.items];
    }

    public get length(): number {
        return this.items.length;
    }

    public isEmpty(): boolean {
        return this.length === 0;
    }

    public isNotEmpty(): boolean {
        return !this.isEmpty();
    }

    public map<R>(callback: (item: T, index: number) => R): Collection<R> {
        return new Collection<R>(this.items.map(callback));
    }

    public flatMap<R>(callback: (item: T, index: number) => Array<R>): Collection<R> {
        return new Collection<R>(this.items.flatMap((item: T, index: number) => callback(item, index)));
    }

    public each(callback: (item: T, index: number) => void): this {
        this.items.forEach(callback);

        return this;
    }

    public get(index: number, value?: T): T | undefined {
        if (value !== undefined) {
            this.items[index] = value;

            return value;
        }

        return this.items[index];
    }

    public filter(callback: (item: T, index: number) => boolean): Collection<T> {
        return new Collection<T>(this.items.filter(callback));
    }

    public where(key: string, operator: any, value?: any): Collection<T> {
        if (arguments.length === 2) {
            value = operator;
            operator = "=";
        }

        const match = (a: any, b: any, op: any): boolean => {
            switch (op) {
                case ">":
                    return a > b;
                case ">=":
                    return a >= b;
                case "<":
                    return a < b;
                case "<=":
                    return a <= b;
                case "!=":
                    return a !== b;
                case "in":
                    return Array.isArray(b) && b.includes(a);
                default:
                    return a === b;
            }
        };

        return new Collection<T>(this.items.filter((item: T) => match(this.dotGet(item, key), value, operator)));
    }

    public contains(predicate: ((item: T) => boolean) | any): boolean {
        return typeof predicate === "function"
            ? this.items.some(predicate as (item: T) => boolean)
            : this.items.includes(predicate);
    }

    public first(callback?: (item: T, index: number) => boolean): T | undefined {
        if (!callback) return this.items[0];

        for (let i: number = 0; i < this.length; i++) {
            if (callback(this.items[i], i)) return this.items[i];
        }

        return undefined;
    }

    public last(callback?: (item: T, index: number) => boolean): T | undefined {
        if (!callback) return this.items[this.length - 1];

        for (let i: number = this.length - 1; i >= 0; i--) {
            if (callback(this.items[i], i)) return this.items[i];
        }

        return undefined;
    }

    public firstOrFail(message: string = "Item not found."): T {
        const item: T | undefined = this.first();

        if (item === undefined) throw new RecordNotFoundException(message);

        return item;
    }

    public pluck<R = any>(column: string, key?: string): Collection<R> | Record<string, R> {
        const values: Array<R> = this.items.map((item: T) => this.dotGet(item, column));

        if (!key) return new Collection<R>(values);

        const index: Record<string, R> = Object.create(null) as Record<string, R>;

        for (const item of this.items) {
            const itemKey: any = (item as any)?.[key];
            const itemValue: R = this.dotGet(item, column);

            index[String(itemKey)] = itemValue;
        }

        return index;
    }

    public reduce<R>(callback: (carry: R, item: T) => R, initial: R): R {
        let carry: R = initial;

        for (const item of this.items) {
            carry = callback(carry, item);
        }

        return carry;
    }

    public sum(column?: string | ((item: T) => number)): number {
        return this.reduce((total, item) => {
            const value: number = typeof column === "function"
                ? column(item)
                : column
                    ? Number((item as any)?.[column]) || 0
                    : Number(item) || 0;
        }, 0);
    }

    public avg(column?: string | ((item: T) => number)): number {
        if (this.length === 0) return NaN;

        return this.sum(column) / this.length;
    }

    public min(column?: string): number {
        return Math.min(...this.numValues(column));
    }

    public max(column?: string): number {
        return Math.max(...this.numValues(column));
    }

    public count(callback?: (item: T) => boolean): number {
        if (!callback) return this.length;

        return this.filter(callback).length;
    }

    public groupBy(key: string | ((item: T) => string)): Record<string, Collection<T>> {
        const groups: Record<string, Array<T>> = Object.create(null) as Record<string, Array<T>>;

        for (const item of this.items) {
            const groupKey: string = typeof key === "function" ? String(key(item)) : String((item as any)?.[key]);

            (groups[groupKey] ||= []).push(item);
        }

        const result: Record<string, Collection<T>> = Object.create(null) as Record<string, Collection<T>>;

        for (const [k, items] of Object.entries(groups)) {
            result[k] = new Collection(items);
        }

        return result;
    }

    public keyBy(key: string | ((item: T) => any)): Collection<T> {
        const index: Record<string, T> = Object.create(null) as Record<string, T>;

        for (const item of this.items) {
            const itemKey: any = typeof key === "function" ? key(item) : (item as any)?.[key];

            index[String(itemKey)] = item;
        }

        return new Collection<T>(Object.values(index));
    }

    private dotGet(item: any, column: string): any {
        return column.split(".").reduce((acc: any, k: string) => acc?.[k], item);
    }

    private numValues(column?: string): Array<number> {
        if (this.length === 0) return [0];

        return this.items.map((item: T) => column ? Number((item as any)?.[column]) || 0 : Number(item) || 0);
    }
}