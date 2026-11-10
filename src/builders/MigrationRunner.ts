import type {MigrationRow} from "@/types/migration";
import App from "@bejibun/app";
import Logger from "@bejibun/logger";
import {isNotEmpty} from "@bejibun/utils/utils/utils";
import Grammar from "@/builders/Grammar";
import DatabaseDriverEnum from "@/enums/DatabaseDriverEnum";
import DB from "@/facades/DB";

/** Cache-buster so an edited migration file is re-imported, not re-read. */
let moduleSlug: number = 0;

/**
 * Migration runner: scans `database/migrations` for migration files,
 * runs those not yet recorded (`up`), records the batch, and supports
 * rollback/fresh/status via the `migrations` table.
 */
export default class MigrationRunner {
    /** Base path override (for testing/embedded usage). */
    protected basePath: string | null = null;

    /** Migration directory relative to the app root. */
    protected directory: string = "migrations";

    /** Name of the tracking table. */
    protected table: string = "migrations";

    /**
     * Grammar used for raw runs (dialect-aware).
     * Built lazily so the facade is already stamped/configured
     * (an eager initializer would read the pre-config default driver, e.g. "pg").
     */
    protected _grammar: Grammar | undefined = undefined;

    protected get grammar(): Grammar {
        return (this._grammar ??= new Grammar(DB.connection()));
    }

    /**
     * Per-instance command chain. Mutating commands run in FIFO order so
     * concurrent `latest()`/`fresh()`/`rollback()`/`refresh()` calls on the
     * same runner cannot interleave their tracking-table reads and batch
     * bookkeeping. Each instance owns its directory and tracking table,
     * so unrelated runners stay independent (no global over-serialization).
     */
    private commandTail: Promise<unknown> = Promise.resolve();

    /**
     * Creates a migration runner targeting an optional base path.
     *
     * @param {string} [basePath] - Base path override for the migration directory.
     */
    public constructor(basePath?: string) {
        if (basePath) this.basePath = basePath;
    }

    /**
     * Returns names of migrations that have not been run yet, without
     * mutating the database (no tracking table is created).
     *
     * @returns {Promise<Array<string>>} Pending migration names.
     */
    public async pending(): Promise<Array<string>> {
        const files: Array<string> = this.files();
        let ran: Set<string>;

        try {
            ran = new Set<string>(await this.ranNames());
        } catch {
            ran = new Set<string>();
        }

        return files
            .map((file: string) => this.basename(file))
            .filter((name: string) => !ran.has(name));
    }

    /**
     * Reports the migrations that would run, without executing anything.
     *
     * @returns {Promise<Array<string>>} Names of the migrations that would be run.
     */
    public async pretend(): Promise<Array<string>> {
        const names: Array<string> = await this.pending();

        for (const name of names) Logger.setContext("MIGRATE").info(`Would migrate ${name}`);

        return names;
    }

    /**
     * Displays the migration status.
     *
     * @returns {Promise<Array<Record<string, any>>>} Status entry per migration file.
     */
    public async status(): Promise<Array<Record<string, any>>> {
        await this.ensureTrackingTable();

        const ran: Set<string> = new Set<string>(await this.ranNames());
        const batchOf: Record<string, number> = {};

        for (const row of await this.raw<MigrationRow>(
            `SELECT * FROM ${this.grammar.quote(this.table)}`
        )) {
            batchOf[row.migration] = row.batch;
        }

        return this.files().map((file: string) => {
            const name: string = this.basename(file);

            if (ran.has(name))
                return {
                    file: name,
                    ran: true,
                    batch: batchOf[name] ?? 1
                };

            return {
                file: name,
                ran: false,
                batch: null
            };
        });
    }

    /**
     * Runs all migrations that have not been run yet.
     *
     * @returns {Promise<Array<string>>} Names of the migrations that were run.
     */
    public async latest(): Promise<Array<string>> {
        return this.serialized(() => this.runLatest());
    }

    /**
     * Rolls back the latest migration batch.
     *
     * @returns {Promise<Array<string>>} Names of the migrations that were rolled back.
     */
    public async rollback(): Promise<Array<string>> {
        return this.serialized(() => this.runRollback());
    }

    /**
     * Rolls back every recorded batch, then re-runs all migrations. Only
     * each migration's own `down()` runs; unlike `fresh()`, the tracking
     * table is not dropped.
     *
     * @returns {Promise<Array<string>>} Names of the migrations that were run.
     */
    public async refresh(): Promise<Array<string>> {
        return this.serialized(async () => {
            while ((await this.runRollback()).length > 0) {
                // Keep rolling back until no recorded batches remain.
            }

            return this.runLatest();
        });
    }

    /**
     * Runs every migration from scratch: calls `down()` on every migration
     * file in reverse order (errors are logged and swallowed), drops the
     * tracking table, then re-runs everything. No table is dropped by the
     * runner itself -- each migration's `down()` owns its schema.
     *
     * @returns {Promise<Array<string>>} Names of the migrations that were run.
     */
    public async fresh(): Promise<Array<string>> {
        return this.serialized(() => this.runFresh());
    }

    /**
     * Run helper that keeps the caller's signature. Forwards to the
     * grammar pool (not a new connection) for transaction-caller consistency.
     *
     * @param {string} sql - SQL.
     * @param {Array<any>} bindings - Bound values.
     * @returns {Promise<Array<T>>} Rows for a SELECT, the driver statement result for writes.
     */
    protected async raw<T = any>(sql: string, bindings: Array<any> = []): Promise<Array<T>> {
        return DB.select<T>(sql, bindings);
    }

    /**
     * Runs a migration file's `up`/`down` function.
     *
     * @param {string} file - Absolute path to the migration file.
     * @param {"up" | "down"} action - Name of the exported function to call: `up` or `down`,
     *   invoked as `mod[action](DB)`.
     * @returns {Promise<void>} Resolves once finished.
     */
    protected async runMigration(file: string, action: "up" | "down"): Promise<void> {
        moduleSlug++;

        const mod: Record<string, any> = await import(
            `${Bun.pathToFileURL(file).href}?t=${moduleSlug}`
        );

        if (typeof mod[action] !== "function")
            throw new Error(`Migration ${this.basename(file)} missing export ${action}().`);

        await mod[action](DB);
    }

    /**
     * The latest() body, safe to call re-entrantly from another command.
     *
     * @returns {Promise<Array<string>>} Names of the migrations that were run.
     */
    protected async runLatest(): Promise<Array<string>> {
        await this.ensureTrackingTable();

        const files: Array<string> = this.files();
        const ran: Set<string> = new Set<string>(await this.ranNames());
        const pending: Array<string> = files.filter(
            (file: string) => !ran.has(this.basename(file))
        );

        if (pending.length === 0) return [];

        const nextBatch: number = (await this.maxBatch()) + 1;
        const executed: Array<string> = [];

        for (const file of pending) {
            const name: string = this.basename(file);

            Logger.setContext("MIGRATE").info(`Migrating ${name}`);

            await DB.transaction(async () => {
                await this.runMigration(file, "up");

                await this.record(name, nextBatch);
            });

            executed.push(name);
        }

        return executed;
    }

    /**
     * The rollback() read-and-run body, re-entrant-safe.
     *
     * @returns {Promise<Array<string>>} Names of the migrations that were rolled back.
     */
    protected async runRollback(): Promise<Array<string>> {
        await this.ensureTrackingTable();

        const rows: Array<MigrationRow> = await this.raw<MigrationRow>(
            `SELECT * FROM ${this.grammar.quote(this.table)} ORDER BY batch DESC, id DESC`
        );

        if (rows.length === 0) return [];

        const lastBatch: number = rows[0].batch;
        const rolled: Array<string> = [];

        for (const row of rows) {
            if (row.batch !== lastBatch) break;

            const file: string | undefined = await this.resolveFile(row.migration);

            if (!file) {
                Logger.setContext("MIGRATE").warn(
                    `Migration file ${row.migration} not found, skipping down()`
                );

                await this.unrecord(row.migration);

                continue;
            }

            Logger.setContext("MIGRATE").info(`Rolling back ${row.migration}`);

            await DB.transaction(async () => {
                await this.runMigration(file, "down");

                await this.unrecord(row.migration);
            });

            rolled.push(row.migration);
        }

        return rolled;
    }

    /**
     * The fresh() body, re-entrant-safe.
     *
     * @returns {Promise<Array<string>>} Names of the migrations that were run.
     */
    protected async runFresh(): Promise<Array<string>> {
        const files: Array<string> = this.files();

        for (const file of [...files].reverse()) {
            const name: string = this.basename(file);

            Logger.setContext("MIGRATE").info(`Reversing ${name}`);

            await this.tryRunMigration(file, "down");
        }

        await this.dropTrackingTable();

        return this.runLatest();
    }

    /**
     * Returns migration files sorted lexicographically by filename (so
     * `10_x.ts` runs before `2_x.ts`).
     *
     * @returns {Array<string>} Absolute paths to migration files.
     */
    protected files(): Array<string> {
        const directory: string = this.basePath || App.Path.databasePath(this.directory);
        const names: Array<string> = Array.from(
            new Bun.Glob("*.ts").scanSync({
                cwd: directory
            })
        ).sort();

        return names.map((name: string) => `${directory}/${name}`);
    }

    /**
     * Ensures the tracking table exists.
     *
     * @returns {Promise<void>} Resolves once the table is ready.
     */
    private async ensureTrackingTable(): Promise<void> {
        const g: Grammar = this.grammar;
        const exists: boolean = isNotEmpty(
            await this.raw(`SELECT 1 FROM ${g.quote(this.table)} LIMIT 1`).catch(() => null)
        );

        if (exists) return;

        const driver: string = g.driverName();
        const idType: string =
            driver === DatabaseDriverEnum.Pg
                ? "SERIAL PRIMARY KEY"
                : driver === DatabaseDriverEnum.Mysql
                  ? "INTEGER PRIMARY KEY AUTO_INCREMENT"
                  : "INTEGER PRIMARY KEY AUTOINCREMENT";

        await this.raw(
            `CREATE TABLE IF NOT EXISTS ${g.quote(this.table)} (${g.quote("id")} ${idType}, ${g.quote("migration")} VARCHAR(255) NOT NULL UNIQUE, ${g.quote("batch")} INTEGER NOT NULL)`
        );
    }

    /**
     * Drops the tracking table.
     *
     * @returns {Promise<void>} Resolves once the table is dropped.
     */
    private async dropTrackingTable(): Promise<void> {
        await this.raw(`DROP TABLE IF EXISTS ${this.grammar.quote(this.table)}`).catch(
            () => undefined
        );
    }

    /**
     * Returns names of migrations already recorded.
     *
     * @returns {Promise<Array<string>>} List of names.
     */
    private async ranNames(): Promise<Array<string>> {
        const g: Grammar = this.grammar;
        const rows: Array<{
            migration: string;
        }> = await this.raw<{
            migration: string;
        }>(`SELECT ${g.quote("migration")} FROM ${g.quote(this.table)}`);

        return rows.map((row: {migration: string}) => row.migration);
    }

    /**
     * Returns the highest batch number so far.
     *
     * @returns {Promise<number>} The last batch value, or 0 when empty.
     */
    private async maxBatch(): Promise<number> {
        const g: Grammar = this.grammar;
        const rows: Array<{
            max: number;
        }> = await this.raw<{
            max: number;
        }>(`SELECT COALESCE(MAX(${g.quote("batch")}), 0) AS max FROM ${g.quote(this.table)}`);

        return Number(rows[0]?.max ?? 0);
    }

    /**
     * Records an executed migration.
     *
     * @param {string} name - Migration name.
     * @param {number} batch - Batch number.
     * @returns {Promise<void>} Resolves once recorded.
     */
    private async record(name: string, batch: number): Promise<void> {
        const g: Grammar = this.grammar;
        const driver: string = g.driverName();
        const migrationCol: string = g.quote("migration");
        const batchCol: string = g.quote("batch");
        const values: string = `(${migrationCol}, ${batchCol}) VALUES (?, ?)`;

        let sql: string;

        switch (driver) {
            case DatabaseDriverEnum.Sqlite:
                sql = `INSERT OR IGNORE INTO ${g.quote(this.table)} ${values}`;

                break;
            case DatabaseDriverEnum.Pg:
                sql = `INSERT INTO ${g.quote(this.table)} ${values} ON CONFLICT (${g.quote("migration")}) DO NOTHING`;

                break;
            default:
                sql = `INSERT IGNORE INTO ${g.quote(this.table)} ${values}`;

                break;
        }

        await this.raw(sql, [name, batch]);
    }

    /**
     * Removes a migration record.
     *
     * @param {string} name - Migration name.
     * @returns {Promise<void>} Resolves once removed.
     */
    private async unrecord(name: string): Promise<void> {
        const g: Grammar = this.grammar;

        await this.raw(`DELETE FROM ${g.quote(this.table)} WHERE ${g.quote("migration")} = ?`, [
            name
        ]);
    }

    /**
     * Resolves the file path from a migration name.
     *
     * @param {string} name - Migration name.
     * @returns {Promise<string | undefined>} Absolute path, or undefined when absent.
     */
    private async resolveFile(name: string): Promise<string | undefined> {
        const file: string = `${this.basePath || App.Path.databasePath(this.directory)}/${name}.ts`;

        return (await Bun.file(file).exists()) ? file : undefined;
    }

    /**
     * Attempts to run `up`/`down`, swallowing errors (used by fresh).
     *
     * @param {string} file - Absolute path to the migration file.
     * @param {"up" | "down"} action - Name of the exported function to call: `up` or `down`.
     * @returns {Promise<void>} Resolves even when an error occurs.
     */
    private async tryRunMigration(file: string, action: "up" | "down"): Promise<void> {
        try {
            await this.runMigration(file, action);
        } catch (error: any) {
            Logger.setContext("MIGRATE").warn(
                `${this.basename(file)} ${action}(...) skipped: ${error?.message ?? error}`
            );
        }
    }

    /**
     * Serializes a command onto this instance's FIFO command chain.
     *
     * @param {() => Promise<T>} task - The command body to run.
     * @returns {Promise<T>} A promise for the command result.
     */
    private serialized<T>(task: () => Promise<T>): Promise<T> {
        const current: Promise<T> = this.commandTail.then(task, task);

        this.commandTail = current.then(
            () => undefined,
            () => undefined
        );

        return current;
    }

    /**
     * Extracts the name from a path.
     *
     * @param {string} file - Absolute path.
     * @returns {string} Name without extension.
     */
    private basename(file: string): string {
        return file.split("/").pop()!.replace(/\.ts$/, "");
    }
}
