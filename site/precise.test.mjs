import assert from 'node:assert/strict';
import test from 'node:test';

const { PRECISE, addSeed, precise } = await import('./precise.ts');

/** A generator for `precise` from a model of the star a request and a seed come out at, counting its calls. */
function fake(star) {
    const generate = async (r, seed) => {
        generate.calls++;
        return star(r, seed);
    };
    generate.calls = 0;
    return generate;
}
/** A star offset from the seed and the request alone, within ±`size`: the same chart for the same request and seed. */
function noise(seed, r, size) {
    let h = (Number(BigInt.asUintN(32, BigInt(seed))) ^ Math.round(r * 1000) * 0x9e3779b1) >>> 0;
    h = Math.imul(h ^ h >>> 16, 0x85ebca6b) >>> 0;
    h = Math.imul(h ^ h >>> 13, 0xc2b2ae35) >>> 0;
    return ((h ^ h >>> 16) >>> 0) / 0xffffffff * 2 * size - size;
}
const RESPONSES = {
    linear: r => r + 0.3,
    'slope 0.6': r => 0.6 * r + 1,
    // Flat outside the stars the model was fitted on, as a request far outside them is expected to come out.
    saturating: r => Math.min(5.9, Math.max(2.1, r)),
    noisy: (r, seed) => 0.9 * r + 0.2 + noise(seed, r, 0.25),
    'noisy and saturating': (r, seed) => Math.min(5.9, Math.max(2.1, r)) + noise(seed, r, 0.15),
};
const TARGETS = [1, 1.7, 2, 3.5, 4.4, 5.9, 6, 7.5, 9], SEEDS = [0, 1, 4294967295, 2n ** 64n - 2n];
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} is not ${b}`);
const distance = (t, target) => Math.abs(t.m - target);

test('keeps the first chart when it is within the tolerance', async () => {
    const generate = fake(r => r + 0.05), { best, tries } = await precise(3.5, 7, generate);
    assert.equal(generate.calls, 1);
    assert.deepEqual(tries, [{ k: 0, r: 3.5, seed: 7, m: 3.55 }]);
    assert.equal(best, tries[0]);
});

test('finds a linear response on its second chart', async () => {
    const { best, tries } = await precise(3.5, 7, fake(RESPONSES.linear));
    assert.equal(tries.length, 2);
    near(tries[1].r, 3.2);
    near(best.m, 3.5);
    assert.deepEqual(tries.map(t => t.seed), [7, 7]);
});

test('takes the slope from its last two charts: a response of slope 0.6 on the third', async () => {
    const { best, tries } = await precise(4, 7, fake(RESPONSES['slope 0.6']));
    // 4 gives 3.4; a slope of 1 asks 4.6, which gives 3.76; the slope 0.36 / 0.6 then asks 4.6 + 0.24 / 0.6.
    assert.equal(tries.length, 3);
    for (const [i, [r, m]] of [[4, 3.4], [4.6, 3.76], [5, 4]].entries()) {
        near(tries[i].r, r);
        near(tries[i].m, m);
    }
    assert.equal(best, tries[2]);
});

test('keeps the slope between its bounds and the request within its reach of the target', async () => {
    const { tries } = await precise(4, 7, fake(r => 0.2 * r));
    // 4 gives 0.8; 7.2 is out of reach, so 7 gives 1.4; the slope 0.2 counts as 0.5, and the request cannot move.
    assert.deepEqual(tries.map(t => t.r), [4, 7, 7, 7, 7, 7]);
    assert.deepEqual(tries.map(t => t.seed), [7, 7, 8, 9, 10, 11]);
});

test('once the request moves and the star does not, keeps the best request and tries the next seeds', async () => {
    const generate = fake(RESPONSES.saturating), { best, tries } = await precise(8, 7, generate);
    assert.equal(generate.calls, PRECISE.tries);
    assert.deepEqual(tries.map(t => t.r), [8, 10.1, 8, 8, 8, 8]);
    assert.deepEqual(tries.map(t => t.seed), [7, 7, 8, 9, 10, 11]);
    // Every chart is as far from the target: the earliest wins.
    assert.equal(best, tries[0]);
});

test('the next seeds stay at the best request and can give a closer chart', async () => {
    const stars = { 7: 5.9, 8: 5.7, 9: 6.3, 10: 6.1, 11: 5.95 };
    const { best, tries } = await precise(8, 7, fake((r, seed) => stars[seed]));
    assert.deepEqual(tries.map(t => t.seed), [7, 7, 8, 9, 10, 11]);
    assert.deepEqual(tries.map(t => t.r), [8, 10.1, 8, 8, 8, 8]);
    assert.equal(best, tries[3]);
});

for (const [name, response] of Object.entries(RESPONSES))
    test(`${name}: at most ${PRECISE.tries} charts, never worse than the first, stops at the tolerance, the same again`, async () => {
        for (const target of TARGETS)
            for (const seed of SEEDS) {
                const generate = fake(response), kept = [], { best, tries } = await precise(target, seed, generate, t => kept.push(t));
                assert.equal(generate.calls, tries.length);
                assert.ok(tries.length >= 1 && tries.length <= PRECISE.tries);
                assert.deepEqual(tries.map(t => t.k), tries.map((_, i) => i));
                assert.equal(tries[0].r, target);
                assert.equal(tries[0].seed, seed);
                // The closest, the earliest of equals, and the one the caller was last told to keep.
                assert.ok(tries.every(t => distance(best, target) <= distance(t, target)));
                assert.equal(best, tries.find(t => distance(t, target) === distance(best, target)));
                assert.equal(kept.at(-1), best);
                // It stops at the first chart within the tolerance, and otherwise only after the last chart.
                const within = tries.findIndex(t => distance(t, target) <= PRECISE.tolerance);
                assert.equal(tries.length, within < 0 ? PRECISE.tries : within + 1);
                for (const t of tries) assert.ok(Math.abs(t.r - target) <= PRECISE.reach);
                assert.deepEqual(await precise(target, seed, fake(response)), { best, tries });
            }
    });

test('a response it can follow ends within the tolerance where a request within reach gives the target', async () => {
    // 0.6 r + 1 gives the target at a request within 3 of it for targets up to 7.
    for (const [name, most] of [['linear', 9], ['slope 0.6', 7]])
        for (const target of TARGETS.filter(t => t <= most)) {
            const { best } = await precise(target, 1, fake(RESPONSES[name]));
            assert.ok(distance(best, target) <= PRECISE.tolerance, `${name} at ${target}: ${best.m}`);
        }
});

test('takes other constants than the page\'s', async () => {
    const generate = fake(RESPONSES.saturating), { tries } = await precise(8, 7, generate, undefined, { ...PRECISE, tries: 3 });
    assert.equal(generate.calls, 3);
    assert.deepEqual(tries.map(t => t.seed), [7, 7, 8]);
});

test('adds to a seed within 64 bits, as a number where a number holds it', () => {
    assert.equal(addSeed(7, 1), 8);
    assert.equal(addSeed(4294967295, 1), 4294967296);
    assert.equal(addSeed(Number.MAX_SAFE_INTEGER, 0), Number.MAX_SAFE_INTEGER);
    assert.equal(addSeed(Number.MAX_SAFE_INTEGER, 2), 9007199254740993n);
    assert.equal(addSeed(2n ** 64n - 2n, 1), 2n ** 64n - 1n);
    assert.equal(addSeed(2n ** 64n - 1n, 1), 0);
    assert.equal(addSeed(2n ** 64n - 1n, 3), 2);
});
