/** A prepared SQLite statement with its read/write classification. */
export interface PreparedStatement {
    statement: any;
    read: boolean;
}
