/**
 * Base class for database seeders. Subclasses override `run()`.
 */
export default class Seeder {
    /** Seeder name (defaults to the class name). */
    public name: string;

    /**
     * Creates a seeder, defaulting `name` to the class name.
     */
    public constructor() {
        this.name = this.constructor.name;
    }

    /**
     * Runs this seeder.
     *
     * @returns {Promise<void>} Resolves when the seeder has finished.
     */
    public async run(): Promise<void> {
        // Implemented in the subclass
    }

    /**
     * Calls another seeder from within `run()`.
     *
     * @param {any} SeederClass - The other seeder class.
     * @returns {Promise<void>} Resolves when the seeder has finished.
     */
    public async call(SeederClass: any): Promise<void> {
        const instance: Seeder = new SeederClass();

        await instance.run();
    }
}
