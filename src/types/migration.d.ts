/** A single tracked migration row. */
export type MigrationRow = {
    id: number;
    migration: string;
    batch: number;
};
