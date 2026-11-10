/**
 * A raw SQL expression with optional bindings. Returned by `DB.raw()`
 * and usable where a value, a select column, or a subquery is accepted
 * (not as a table or an `orderBy()` column -- use `orderByRaw()` there).
 * The fragment keeps its `?` placeholders: `bindings` are appended to the
 * enclosing query's binding list, never inlined into `sql`.
 */
export default class Raw {
    /** The raw SQL fragment. */
    public readonly sql: string;

    /** Bound values for the fragment's `?` placeholders. */
    public readonly bindings: Array<any>;

    /**
     * Creates a raw SQL expression.
     *
     * @param {string} sql - The raw SQL fragment.
     * @param {Array<any>} [bindings] - Bound values for `?` placeholders.
     */
    public constructor(sql: string, bindings: Array<any> = []) {
        this.sql = sql;
        this.bindings = bindings;
    }

    /**
     * Returns the raw SQL string (implicit string coercion).
     *
     * @returns {string} The raw SQL.
     */
    public toString(): string {
        return this.sql;
    }
}
