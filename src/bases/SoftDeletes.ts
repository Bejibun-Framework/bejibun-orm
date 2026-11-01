import Model from "@/bases/Model";
import QueryBuilder from "@/builders/QueryBuilder";

/**
 * Mixin that adds soft-delete behavior to model subclasses.
 *
 * Usage:
 *
 * ```ts
 * class Post extends SoftDeletes(Model) {
 *   public static tableName = "posts";
 * }
 * ```
 *
 * Adds a `deleted_at` column, filters soft-deleted rows out of normal
 * queries, turns `delete()` into a soft delete, and provides
 * `withTrashed()`, `onlyTrashed()`, `restore()`, `forceDelete()`.
 *
 * @param {B} Base - The base model class.
 * @returns {typeof Model} A model subclass with soft-delete behavior.
 */
export default function SoftDeletes<B extends typeof Model>(Base: B) {
    const Ctor: typeof Model = Base;

    class SoftDeletesModel extends Ctor {
        /** The column marking soft-deleted rows. */
        public static deletedColumn: string | null = "deleted_at";

        /**
         * Builds a query that only returns soft-deleted rows.
         *
         * @returns {QueryBuilder} A builder filtered to deleted rows.
         */
        public static onlyTrashed(): QueryBuilder {
            const modelClass: typeof SoftDeletesModel = this;
            const builder: QueryBuilder = new QueryBuilder(modelClass.tableName);

            builder._modelClass = modelClass;
            builder.setRelationResolver((name: string) => modelClass.resolveRelation(name));

            modelClass.applyScopes(builder, modelClass.__globalScopes || []);

            return modelClass.applyModelDecorators(builder, "only-trashed");
        }

        /**
         * Builds a query that includes soft-deleted rows.
         *
         * @returns {QueryBuilder} A builder without the soft-delete filter.
         */
        public static withTrashed(): QueryBuilder {
            const modelClass: typeof SoftDeletesModel = this;
            const builder: QueryBuilder = new QueryBuilder(modelClass.tableName);

            builder._modelClass = modelClass;
            builder.setRelationResolver((name: string) => modelClass.resolveRelation(name));

            modelClass.applyScopes(builder, modelClass.__globalScopes || []);

            return modelClass.applyModelDecorators(builder, "with-trashed");
        }

        /**
         * Deletes the model. Soft-deletes when the marker column is active.
         *
         * @returns {Promise<boolean>} True when the row was marked deleted.
         */
        public async delete(): Promise<boolean> {
            const modelClass: typeof SoftDeletesModel = this.constructor as typeof SoftDeletesModel;
            const deletedColumn: string | null = modelClass.deletedColumn;

            if (deletedColumn === null) return super.delete();

            const id: any = this.getAttribute(modelClass.idColumn);

            if (id === undefined) return false;

            if (!(await this.fireModelEvent("deleting"))) return false;

            const now: string = modelClass.now();
            const changed: number = await this.performSoftDelete(now);

            if (changed === 0) return false;

            this.setAttribute(deletedColumn, now);

            await this.fireModelEvent("deleted");
            await this.touchOwners();

            return true;
        }

        /**
         * Permanently deletes the row, ignoring soft-delete.
         *
         * @returns {Promise<boolean>} True when the row was deleted.
         */
        public async forceDelete(): Promise<boolean> {
            return super.delete();
        }

        /**
         * Restores the model from soft delete.
         *
         * @returns {Promise<boolean>} True when restored successfully.
         */
        public async restore(): Promise<boolean> {
            const modelClass: typeof SoftDeletesModel = this.constructor as typeof SoftDeletesModel;
            const deletedColumn: string | null = modelClass.deletedColumn;
            const id: any = this.getAttribute(modelClass.idColumn);

            if (deletedColumn === null || id === undefined) return false;

            if (!(await this.fireModelEvent("restoring"))) return false;

            const result: number = await new QueryBuilder(modelClass.tableName)
                .where(modelClass.idColumn, "=", id)
                .update({
                    [deletedColumn]: null
                });

            this.setAttribute(deletedColumn, null);
            this._exists = true;

            await this.fireModelEvent("restored");

            if (result > 0) await this.touchOwners();

            return result > 0;
        }

        /**
         * Whether the model is currently soft-deleted (marker column is
         * non-null). NOTE: an absent/never-loaded attribute is `undefined`,
         * which also counts as "set" here, so a brand-new unsaved instance may
         * report `true`.
         *
         * @returns {boolean} True when the marker column is set.
         */
        public trashed(): boolean {
            const modelClass: typeof SoftDeletesModel = this.constructor as typeof SoftDeletesModel;
            const deletedColumn: string | null = modelClass.deletedColumn;

            return deletedColumn !== null && this.getAttribute(deletedColumn) !== null;
        }

        /**
         * Applies the soft-delete filter to a query builder.
         *
         * - `"default"` - only active rows (deleted null).
         * - `"with-trashed"` - all rows.
         * - `"only-trashed"` - only deleted rows.
         *
         * @param {QueryBuilder} builder - The query builder.
         * @param {"default" | "with-trashed" | "only-trashed"} mode - The filter mode.
         * @returns {QueryBuilder} The filtered builder.
         */
        protected static applyModelDecorators(
            builder: QueryBuilder,
            mode: "default" | "with-trashed" | "only-trashed" = "default"
        ): QueryBuilder {
            const modelClass: typeof SoftDeletesModel = this;
            const deletedColumn: string | null = modelClass.deletedColumn;

            if (deletedColumn) {
                if (mode === "only-trashed") {
                    builder.whereNotNull(deletedColumn);
                } else if (mode === "default") {
                    builder.whereNull(deletedColumn);
                }
            }

            return builder;
        }

        /**
         * Performs the soft delete: marks the marker column with a timestamp.
         *
         * @param {string} now - The current timestamp.
         * @returns {Promise<number>} Resolves after the update.
         */
        protected async performSoftDelete(now: string): Promise<number> {
            const model = this;
            const modelClass: typeof SoftDeletesModel =
                model.constructor as typeof SoftDeletesModel;
            const id: any = model.getAttribute(modelClass.idColumn);
            const deletedColumn: string | null = modelClass.deletedColumn;

            if (!model._exists || deletedColumn === null || id === undefined) return 0;

            return new QueryBuilder(modelClass.tableName)
                .where(modelClass.idColumn, "=", id)
                .whereNull(deletedColumn)
                .update({
                    [deletedColumn]: now
                });
        }
    }

    return SoftDeletesModel as unknown as B & {
        new (...args: Array<any>): InstanceType<B> & {
            delete(): Promise<boolean>;
            forceDelete(): Promise<boolean>;
            restore(): Promise<boolean>;
            trashed(): boolean;
        };
    };
}
