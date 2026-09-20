/** Metadata read from a local orm file. */
export type OrmType = {
    /** Time-to-live in milliseconds, or null for no expiry. */
    ttl: number | null;

    /** The ormd value payload. */
    data: any;
};
