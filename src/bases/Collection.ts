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
        return new Collection<R>(
            this.items.flatMap((item: T, index: number) => callback(item, index))
        );
    }

    public each(callback: (item: T, index: number) => void): Collection<T> {
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

        return this.filter((item: T) => match(this.dotGet(item, key), value, operator));
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
        return this.reduce((total: number, item: T) => {
            const value: number =
                typeof column === "function"
                    ? column(item)
                    : column
                      ? Number((item as any)?.[column]) || 0
                      : Number(item) || 0;

            return total + value;
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
            const groupKey: string =
                typeof key === "function" ? String(key(item)) : String((item as any)?.[key]);

            (groups[groupKey] ||= []).push(item);
        }

        const result: Record<string, Collection<T>> = Object.create(null) as Record<
            string,
            Collection<T>
        >;

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

    public unique(key?: string | ((item: T) => any)): Collection<T> {
        const seenValues: Set<any> = new Set<any>();
        const seenObjects: Set<object> = new Set<object>();

        return this.filter((item: T) => {
            if (key) {
                const id: string = String(
                    typeof key === "function" ? key(item) : (item as any)?.[key]
                );

                if (seenValues.has(id)) return false;

                seenValues.add(id);

                return true;
            }

            if (item !== null && typeof item === "object") {
                if (seenObjects.has(item as unknown as object)) return false;

                seenObjects.add(item as unknown as object);

                return true;
            }

            if (seenValues.has(item)) return false;

            seenValues.add(item);

            return true;
        });
    }

    public sort(callback?: (a: T, b: T) => number): Collection<T> {
        const copy: Array<T> = [...this.items];

        if (callback) copy.sort(callback);
        else copy.sort((a: T, b: T) => (a > b ? 1 : a < b ? -1 : 0));

        return new Collection<T>(copy);
    }

    public reverse(): Collection<T> {
        return new Collection<T>([...this.items].reverse());
    }

    public shuffle(): Collection<T> {
        const copy: Array<T> = [...this.items];

        for (let i: number = copy.length - 1; i > 0; i--) {
            const j: number = Math.floor(Math.random() * (i + 1));

            [copy[i], copy[j]] = [copy[j], copy[i]];
        }

        return new Collection<T>(copy);
    }

    public slice(offset: number, length?: number): Collection<T> {
        return new Collection<T>(
            length === undefined
                ? this.items.slice(offset)
                : this.items.slice(offset, offset + length)
        );
    }

    public take(take: number): Collection<T> {
        return this.slice(0, take);
    }

    public skip(skip: number): Collection<T> {
        return this.slice(skip);
    }

    public chunk(size: number): Array<Collection<T>> {
        if (size <= 0) return [];

        const chunks: Array<Collection<T>> = [];

        for (let i: number = 0; i < this.length; i += size) {
            chunks.push(this.slice(i, i + size));
        }

        return chunks;
    }

    public forPage(page: number, perPage: number): Collection<T> {
        return this.slice((page - 1) * perPage, perPage);
    }

    public concat(...others: Array<Array<T> | Collection<T>>): Collection<T> {
        return new Collection<T>([
            ...this.items,
            ...others.flatMap((other) => (other instanceof Collection ? other.all() : other))
        ]);
    }

    public merge(...others: Array<Array<T> | Collection<T>>): Collection<T> {
        return this.concat(...others);
    }

    public push(...items: Array<T>): Collection<T> {
        this.items.push(...items);

        return this;
    }

    public prepend(...items: Array<T>): Collection<T> {
        this.items.unshift(...items);

        return this;
    }

    public implode(glue: string = ""): string {
        return this.items.join(glue);
    }

    public tap(callback: (collection: this) => void): Collection<T> {
        callback(this);

        return this;
    }

    public pipe<R>(callback: (collection: this) => R): R {
        return callback(this);
    }

    public some(key: string | ((item: T) => boolean)): boolean {
        return typeof key === "function"
            ? this.items.some(key)
            : this.items.some((item: T) => Boolean((item as any)?.[key]));
    }

    public partition(callback: (item: T) => boolean): [Collection<T>, Collection<T>] {
        const left: Array<T> = [];
        const right: Array<T> = [];

        for (const item of this.items) {
            (callback(item) ? left : right).push(item);
        }

        return [new Collection<T>(left), new Collection<T>(right)];
    }

    public only(...values: Array<any>): Collection<T> {
        return this.filter((item: T) =>
            values.includes(typeof item === "object" && item !== null ? (item as any).id : item)
        );
    }

    public toArray(): Array<T> {
        return this.map((item: T) =>
            item !== null && typeof item === "object" && "toArray" in item
                ? (item as any).toArray()
                : item
        ).all();
    }

    public toJSON(): Array<T> {
        return this.toArray();
    }

    private dotGet(item: any, column: string): any {
        return column.split(".").reduce((acc: any, k: string) => acc?.[k], item);
    }

    private numValues(column?: string): Array<number> {
        if (this.length === 0) return [0];

        return this.items.map((item: T) =>
            column ? Number((item as any)?.[column]) || 0 : Number(item) || 0
        );
    }
}
