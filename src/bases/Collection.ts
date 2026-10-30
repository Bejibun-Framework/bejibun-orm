import RecordNotFoundException from "@/exceptions/RecordNotFoundException";

/**
 * Collection of arbitrary items with chainable transformation and query helpers.
 * Backed by a native array; every method returns a new `Collection`
 * (or a plain value) without mutating the source -- except `push()`,
 * `prepend()` and `get(index, value)`, which mutate in place and return `this`.
 */
export default class Collection<T = any> implements Iterable<T> {
    /** The wrapped items. */
    protected readonly items: Array<T>;

    /**
     * Instantiates a collection.
     *
     * @param {Array<T>} [items] - The items to wrap.
     */
    public constructor(items: Array<T> = []) {
        this.items = items;
    }

    /**
     * Iterates with `for...of`.
     *
     * @returns {Iterator<T>} An iterator over the items.
     */
    public [Symbol.iterator](): Iterator<T> {
        return this.items[Symbol.iterator]();
    }

    /**
     * Returns the number of items.
     *
     * @returns {number} The count.
     */
    public get length(): number {
        return this.items.length;
    }

    /**
     * Returns `true` when the collection is empty.
     *
     * @returns {boolean} Whether empty.
     */
    public isEmpty(): boolean {
        return this.length === 0;
    }

    /**
     * Returns `true` when the collection is not empty.
     *
     * @returns {boolean} Whether non-empty.
     */
    public isNotEmpty(): boolean {
        return !this.isEmpty();
    }

    /**
     * Filters items by predicate. Use `where()` for property/operator
     * filtering.
     *
     * @param {(item: T, index: number) => boolean} callback - The predicate.
     * @returns {Collection<T>} A new collection.
     */
    public filter(callback: (item: T, index: number) => boolean): Collection<T> {
        return new Collection<T>(this.items.filter(callback));
    }

    /**
     * Iterates each item.
     *
     * @param {(item: T, index: number) => void} callback - The visitor.
     * @returns {this} This collection (chainable).
     */
    public each(callback: (item: T, index: number) => void): Collection<T> {
        this.items.forEach(callback);

        return this;
    }

    /**
     * Maps each item through `callback`.
     *
     * @param {(item: T, index: number) => R} callback - The mapper.
     * @returns {Collection<R>} A new collection.
     */
    public map<R>(callback: (item: T, index: number) => R): Collection<R> {
        return new Collection<R>(this.items.map(callback));
    }

    /**
     * Maps then flattens one level.
     *
     * @param {(item: T, index: number) => Array<R>} callback - The mapper returning arrays.
     * @returns {Collection<R>} A new collection.
     */
    public flatMap<R>(callback: (item: T, index: number) => Array<R>): Collection<R> {
        return new Collection<R>(
            this.items.flatMap((item: T, index: number) => callback(item, index))
        );
    }

    /**
     * Asymmetric `where` filter: `where(key, value)` or
     * `where(key, operator, value)` (`=`, `>`, `>=`, `<`, `<=`, `!=`, `in`).
     *
     * @param {string} key - The property path.
     * @param {any} operator - Operator or value.
     * @param {any} [value] - The comparison value.
     * @returns {Collection<T>} A new collection.
     */
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

    /**
     * Returns `true` when any item satisfies the predicate (or holds the value).
     *
     * @param {((item: T) => boolean) | any} predicate - The predicate or value to search for.
     * @returns {boolean} Whether found.
     */
    public contains(predicate: ((item: T) => boolean) | any): boolean {
        return typeof predicate === "function"
            ? this.items.some(predicate as (item: T) => boolean)
            : this.items.includes(predicate);
    }

    /**
     * Returns whether any item is truthy for a column, or satisfies a
     * predicate.
     *
     * @param {string | ((item: T) => boolean)} key - Column name or predicate.
     * @returns {boolean} Whether any item holds a truthy value.
     */
    public some(key: string | ((item: T) => boolean)): boolean {
        return typeof key === "function"
            ? this.items.some(key)
            : this.items.some((item: T) => Boolean((item as any)?.[key]));
    }

    /**
     * Reduces the collection to a single value.
     *
     * @param {(carry: R, item: T) => R} callback - The reducer.
     * @param {R} initial - The initial accumulator.
     * @returns {R} The accumulated value.
     */
    public reduce<R>(callback: (carry: R, item: T) => R, initial: R): R {
        let carry: R = initial;

        for (const item of this.items) {
            carry = callback(carry, item);
        }

        return carry;
    }

    /**
     * Counts how many items match the predicate.
     *
     * @param {(item: T) => boolean} [callback] - The predicate; defaults to counting all.
     * @returns {number} The count.
     */
    public count(callback?: (item: T) => boolean): number {
        if (!callback) return this.length;

        return this.filter(callback).length;
    }

    /**
     * Sums a column (or a mapper result).
     *
     * @param {string | ((item: T) => number)} column - Column name or mapper.
     * @returns {number} The sum.
     */
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

    /**
     * Averages a column (or a mapper result).
     *
     * @param {string | ((item: T) => number)} column - Column name or mapper.
     * @returns {number} The average.
     */
    public avg(column?: string | ((item: T) => number)): number {
        if (this.length === 0) return NaN;

        return this.sum(column) / this.length;
    }

    /**
     * Returns the minimum value.
     *
     * @param {string} column - Column name (optional).
     * @returns {number} The minimum.
     */
    public min(column?: string): number {
        return Math.min(...this.numValues(column));
    }

    /**
     * Returns the maximum value.
     *
     * @param {string} column - Column name (optional).
     * @returns {number} The maximum.
     */
    public max(column?: string): number {
        return Math.max(...this.numValues(column));
    }

    /**
     * Groups items by a column or mapper key.
     *
     * @param {string | ((item: T) => string)} key - Column name or mapper.
     * @returns {Record<string, Collection<T>>} A plain object of collections.
     */
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

    /**
     * Deduplicates items by a column/mapper key (last item wins per key) and
     * returns their values -- the key/index itself is NOT retained.
     *
     * @param {string | ((item: T) => any)} key - Column name or mapper.
     * @returns {Collection<T>} A new collection of the kept items.
     */
    public keyBy(key: string | ((item: T) => any)): Collection<T> {
        const index: Record<string, T> = Object.create(null) as Record<string, T>;

        for (const item of this.items) {
            const itemKey: any = typeof key === "function" ? key(item) : (item as any)?.[key];

            index[String(itemKey)] = item;
        }

        return new Collection<T>(Object.values(index));
    }

    /**
     * Removes duplicate items (by value, or by a column/mapper).
     *
     * @param {string | ((item: T) => any)} [key] - Column name or mapper.
     * @returns {Collection<T>} A new collection.
     */
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

    /**
     * Sorts items (stable; the default comparator is a plain `>`/`<` compare,
     * not locale-aware).
     *
     * @param {(a: T, b: T) => number} [callback] - Comparator; defaults to ascending.
     * @returns {Collection<T>} A new collection.
     */
    public sort(callback?: (a: T, b: T) => number): Collection<T> {
        const copy: Array<T> = [...this.items];

        if (callback) copy.sort(callback);
        else copy.sort((a: T, b: T) => (a > b ? 1 : a < b ? -1 : 0));

        return new Collection<T>(copy);
    }

    /**
     * Reverses the item order.
     *
     * @returns {Collection<T>} A new collection.
     */
    public reverse(): Collection<T> {
        return new Collection<T>([...this.items].reverse());
    }

    /**
     * Shuffles the items.
     *
     * @returns {Collection<T>} A new collection.
     */
    public shuffle(): Collection<T> {
        const copy: Array<T> = [...this.items];

        for (let i: number = copy.length - 1; i > 0; i--) {
            const j: number = Math.floor(Math.random() * (i + 1));

            [copy[i], copy[j]] = [copy[j], copy[i]];
        }

        return new Collection<T>(copy);
    }

    /**
     * Returns a slice of the collection.
     *
     * @param {number} offset - Start offset.
     * @param {number} [length] - Number of items.
     * @returns {Collection<T>} A new collection.
     */
    public slice(offset: number, length?: number): Collection<T> {
        return new Collection<T>(
            length === undefined
                ? this.items.slice(offset)
                : this.items.slice(offset, offset + length)
        );
    }

    /**
     * Returns the first `take` items.
     *
     * @param {number} take - How many items.
     * @returns {Collection<T>} A new collection.
     */
    public take(take: number): Collection<T> {
        return this.slice(0, take);
    }

    /**
     * Skips the first `skip` items.
     *
     * @param {number} skip - How many items to skip.
     * @returns {Collection<T>} A new collection.
     */
    public skip(skip: number): Collection<T> {
        return this.slice(skip);
    }

    /**
     * Chunks the collection into smaller collections.
     *
     * @param {number} size - Chunk size.
     * @returns {Array<Collection<T>>} An array of collections.
     */
    public chunk(size: number): Array<Collection<T>> {
        if (size <= 0) return [];

        const chunks: Array<Collection<T>> = [];

        for (let i: number = 0; i < this.length; i += size) {
            chunks.push(this.slice(i, i + size));
        }

        return chunks;
    }

    /**
     * Page offset items: only items between `(page - 1) * perPage` and
     * `page * perPage`.
     *
     * @param {number} page - One-based page.
     * @param {number} perPage - Page size.
     * @returns {Collection<T>} A new collection.
     */
    public forPage(page: number, perPage: number): Collection<T> {
        return this.slice((page - 1) * perPage, perPage);
    }

    /**
     * Concatenates items to the end.
     *
     * @param {Array<Array<T> | Collection<T>>} others - The items (or another collection) to append.
     * @returns {Collection<T>} A new collection.
     */
    public concat(...others: Array<Array<T> | Collection<T>>): Collection<T> {
        return new Collection<T>([
            ...this.items,
            ...others.flatMap((other) => (other instanceof Collection ? other.all() : other))
        ]);
    }

    /**
     * Merges `others` (appending values are returned last).
     *
     * @param {Array<Array<T> | Collection<T>>} others - Items or collection to append.
     * @returns {Collection<T>} A new collection.
     */
    public merge(...others: Array<Array<T> | Collection<T>>): Collection<T> {
        return this.concat(...others);
    }

    /**
     * Appends items, mutating the source.
     *
     * @param {Array<T>} items - The items to push.
     * @returns {this} This collection (chainable).
     */
    public push(...items: Array<T>): Collection<T> {
        this.items.push(...items);

        return this;
    }

    /**
     * Prepends items, mutating the source and returning it.
     *
     * @param {Array<T>} items - The items to prepend.
     * @returns {this} This collection (chainable).
     */
    public prepend(...items: Array<T>): Collection<T> {
        this.items.unshift(...items);

        return this;
    }

    /**
     * Joins the items into a string.
     *
     * @param {string} [glue] - The separator.
     * @returns {string} The joined string.
     */
    public implode(glue: string = ""): string {
        return this.items.join(glue);
    }

    /**
     * Executes `callback` for side effects, returning this collection.
     *
     * @param {(collection: this) => void} callback - The side effect.
     * @returns {this} This collection (chainable).
     */
    public tap(callback: (collection: this) => void): Collection<T> {
        callback(this);

        return this;
    }

    /**
     * Passes the collection to `callback` and returns its result verbatim --
     * arrays are NOT re-wrapped in a `Collection`.
     *
     * @param {(collection: this) => R} callback - The transform.
     * @returns {R} The callback result.
     */
    public pipe<R>(callback: (collection: this) => R): R {
        return callback(this);
    }

    /**
     * Splits the collection into two: matching and non-matching.
     *
     * @param {(item: T) => boolean} callback - The predicate.
     * @returns {[Collection<T>, Collection<T>]} `[matching, rest]`.
     */
    public partition(callback: (item: T) => boolean): [Collection<T>, Collection<T>] {
        const left: Array<T> = [];
        const right: Array<T> = [];

        for (const item of this.items) {
            (callback(item) ? left : right).push(item);
        }

        return [new Collection<T>(left), new Collection<T>(right)];
    }

    /**
     * KEEPS only the items whose `id` (or the item itself, for non-objects)
     * is listed -- it does not exclude them.
     *
     * @param {Array<any>} values - Ids/values to keep.
     * @returns {Collection<T>} A new collection.
     */
    public only(...values: Array<any>): Collection<T> {
        return this.filter((item: T) =>
            values.includes(typeof item === "object" && item !== null ? (item as any).id : item)
        );
    }

    /**
     * Extracts a column's values, optionally keyed by another column.
     *
     * @param {string} column - The value column.
     * @param {string} [key] - The key column.
     * @returns {Collection<R> | Record<string, R>} A new collection (or plain object when `key` given).
     */
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

    /**
     * Returns the wrapped array (a shallow copy).
     *
     * @returns {Array<T>} The items.
     */
    public all(): Array<T> {
        return [...this.items];
    }

    /**
     * Reads the element at `index`, or (mutating) sets it when `value` is
     * given. Not offset syntax -- `undefined` can never be stored, since a
     * `undefined` `value` is treated as a read.
     *
     * @param {number} index - The offset.
     * @param {T} [value] - When given, sets the element.
     * @returns {T | undefined} The element (or the assigned value), `undefined` when missing.
     */
    public get(index: number, value?: T): T | undefined {
        if (value !== undefined) {
            this.items[index] = value;

            return value;
        }

        return this.items[index];
    }

    /**
     * Returns the first item (or undefined).
     *
     * @param {(item: T, index: number) => boolean} [callback] - Optional predicate.
     * @returns {T | undefined} The item, or undefined.
     */
    public first(callback?: (item: T, index: number) => boolean): T | undefined {
        if (!callback) return this.items[0];

        for (let i: number = 0; i < this.length; i++) {
            if (callback(this.items[i], i)) return this.items[i];
        }

        return undefined;
    }

    /**
     * Returns the last item (or undefined).
     *
     * @param {(item: T, index: number) => boolean} [callback] - Optional predicate.
     * @returns {T | undefined} The item, or undefined.
     */
    public last(callback?: (item: T, index: number) => boolean): T | undefined {
        if (!callback) return this.items[this.length - 1];

        for (let i: number = this.length - 1; i >= 0; i--) {
            if (callback(this.items[i], i)) return this.items[i];
        }

        return undefined;
    }

    /**
     * First item, throwing a `RecordNotFoundException` (code `404`) when none
     * exists -- same default error type as `QueryBuilder.firstOrFail`.
     *
     * @param {string} [message] - The error message.
     * @returns {T} The item.
     */
    public firstOrFail(message: string = "Item not found."): T {
        const item: T | undefined = this.first();

        if (item === undefined) throw new RecordNotFoundException(message);

        return item;
    }

    /**
     * Serializes the collected items into a plain array; items exposing a
     * `toArray()` method (models, nested collections) are converted, every
     * other value is kept as-is.
     *
     * @returns {Array<T>} The plain array.
     */
    public toArray(): Array<T> {
        return this.map((item: T) =>
            item !== null && typeof item === "object" && "toArray" in item
                ? (item as any).toArray()
                : item
        ).all();
    }

    /**
     * Returns the same plain array as `toArray()` -- a serializable value, not
     * a JSON string.
     *
     * @returns {Array<any>} The plain array.
     */
    public toJSON(): Array<T> {
        return this.toArray();
    }

    /**
     * Reads a dotted-path value (e.g. `user.profile.age`) off an item,
     * `undefined` when any segment is missing. The single source for
     * column-dot access across this class.
     *
     * @param {any} item - The item to read from.
     * @param {string} column - The dotted column path.
     * @returns {any} The resolved value.
     */
    private dotGet(item: any, column: string): any {
        return column.split(".").reduce((acc: any, k: string) => acc?.[k], item);
    }

    /**
     * Iterates the numeric values produced by `column`/items.
     *
     * @param {string} column - Optional column name.
     * @returns {Array<number>} Numeric values.
     */
    private numValues(column?: string): Array<number> {
        if (this.length === 0) return [0];

        return this.items.map((item: T) =>
            column ? Number((item as any)?.[column]) || 0 : Number(item) || 0
        );
    }
}
