console.log = () => {};
console.error = () => {};

const {default: Orm} = await import("../../index.js");
const {default: OrmBuilder} = await import("../../builders/OrmBuilder.js");

const ITERATIONS = 20_000;
const WARMUP = 500;

for (let i = 0; i < WARMUP; i++) {
    const b = new OrmBuilder();
    b.driver;
}

let t0 = performance.now();
for (let i = 0; i < ITERATIONS; i++) {
    const b = new OrmBuilder();
    b.driver;
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
