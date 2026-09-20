console.log = () => {};
console.error = () => {};

const {default: Orm} = await import("@bejibun-baseline/orm");

const ITERATIONS = 20_000;
const WARMUP = 500;
const driver = "driver";

for (let i = 0; i < WARMUP; i++) {
    const b = new (await import("@bejibun-baseline/orm/builders/OrmBuilder")).default();
    b[driver];
}

let t0 = performance.now();
for (let i = 0; i < ITERATIONS; i++) {
    const b = new (await import("@bejibun-baseline/orm/builders/OrmBuilder")).default();
    b[driver];
}
const buildMs = performance.now() - t0;

await Orm.connection("redis").put("bench:put", "bench-value");

for (let i = 0; i < WARMUP; i++) {
    await Orm.connection("redis").put("bench:put", "bench-value");
    await Orm.connection("redis").get("bench:key-old");
    await Orm.connection("redis").has("bench:key-old");
}

t0 = performance.now();
for (let i = 0; i < ITERATIONS; i++) {
    await Orm.connection("redis").put("bench:put", "bench-value");
}
const putMs = performance.now() - t0;

await Orm.connection("redis").put("bench:key", "bench-value");

t0 = performance.now();
for (let i = 0; i < ITERATIONS; i++) {
    await Orm.connection("redis").get("bench:key");
}
const getMs = performance.now() - t0;

t0 = performance.now();
for (let i = 0; i < ITERATIONS; i++) {
    await Orm.connection("redis").has("bench:key");
}
const hasMs = performance.now() - t0;

process.stdout.write(`${buildMs}|${putMs}|${getMs}|${hasMs}\n`);
