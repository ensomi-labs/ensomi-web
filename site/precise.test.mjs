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
// The range the page offers for this model: the star slider's minimum and maximum.
const RANGE = [2, 5.9];
/** Flat at each end, as the model is: every request up to 2.125 makes one chart and every request from 5.875 another. */
const plateaus = r => 2.48 + (5.27 - 2.48) * (Math.min(5.875, Math.max(2.125, r)) - 2.125) / 3.75;
const RESPONSES = {
    linear: r => r + 0.3,
    'slope 0.6': r => 0.6 * r + 1,
    saturating: plateaus,
    noisy: (r, seed) => 0.9 * r + 0.2 + noise(seed, r, 0.25),
    'noisy and saturating': (r, seed) => plateaus(r) + noise(seed, r, 0.15),
};
// Targets in the range, at its ends, and outside it, which the page does not offer and the search still takes.
const TARGETS = [1, 2, 2.5, 3.5, 4.4, 5.5, 5.9, 9], SEEDS = [0, 1, 4294967295, 2n ** 64n - 2n];
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} is not ${b}`);
const distance = (t, target) => Math.abs(t.m - target);

test('keeps the first chart when it is within the tolerance', async () => {
    const generate = fake(r => r + 0.05), { best, tries } = await precise(3.5, 7, RANGE, generate);
    assert.equal(generate.calls, 1);
    assert.deepEqual(tries, [{ k: 0, r: 3.5, seed: 7, m: 3.55 }]);
    assert.equal(best, tries[0]);
});

test('finds a linear response on its second chart', async () => {
    const { best, tries } = await precise(3.5, 7, RANGE, fake(RESPONSES.linear));
    assert.equal(tries.length, 2);
    near(tries[1].r, 3.2);
    near(best.m, 3.5);
    assert.deepEqual(tries.map(t => t.seed), [7, 7]);
});

test('takes the slope from its last two charts: a response of slope 0.6 on the third', async () => {
    const { best, tries } = await precise(4, 7, RANGE, fake(RESPONSES['slope 0.6']));
    // 4 gives 3.4; a slope of 1 asks 4.6, which gives 3.76; the slope 0.36 / 0.6 then asks 4.6 + 0.24 / 0.6.
    assert.equal(tries.length, 3);
    for (const [i, [r, m]] of [[4, 3.4], [4.6, 3.76], [5, 4]].entries()) {
        near(tries[i].r, r);
        near(tries[i].m, m);
    }
    assert.equal(best, tries[2]);
});

test('keeps the slope between its bounds and the request in the range', async () => {
    const { best, tries } = await precise(4, 7, RANGE, fake(r => 0.2 * r));
    // 4 gives 0.8; 7.2 is out of the range, so 5.9 gives 1.18; the slope 0.2 counts as 0.5, and the request cannot move.
    assert.deepEqual(tries.map(t => t.r), [4, 5.9, 5.9, 5.9, 5.9, 5.9]);
    assert.deepEqual(tries.map(t => t.seed), [7, 7, 8, 9, 10, 11]);
    assert.equal(best, tries[1]);
});

test('a target inside the range steers as before until its request meets the end of the range', async () => {
    const { best, tries } = await precise(5.5, 7, RANGE, fake(r => Math.min(5.3, r - 0.4)));
    // 5.5 gives 5.1; 5.9 gives 5.3; the slope 0.5 asks for 6.3, which is the 5.9 it already has.
    for (const [i, r] of [5.5, 5.9, 5.9, 5.9, 5.9, 5.9].entries()) near(tries[i].r, r);
    assert.deepEqual(tries.map(t => t.seed), [7, 7, 8, 9, 10, 11]);
    assert.equal(best, tries[1]);
});

test('a target at the top of the range has no request to move to and tries the next seeds', async () => {
    const generate = fake(RESPONSES.saturating), { best, tries } = await precise(5.9, 7, RANGE, generate);
    assert.equal(generate.calls, PRECISE.tries);
    assert.deepEqual(tries.map(t => t.r), [5.9, 5.9, 5.9, 5.9, 5.9, 5.9]);
    assert.deepEqual(tries.map(t => t.seed), [7, 8, 9, 10, 11, 12]);
    // Every chart is as far from the target: the earliest wins.
    assert.equal(best, tries[0]);
});

test('a target at the bottom of the range does the same', async () => {
    const { tries } = await precise(2, 7, RANGE, fake(RESPONSES.saturating));
    assert.deepEqual(tries.map(t => t.r), [2, 2, 2, 2, 2, 2]);
    assert.deepEqual(tries.map(t => t.seed), [7, 8, 9, 10, 11, 12]);
});

test('a target outside the range starts at the nearest end and is still what the charts are judged by', async () => {
    const stars = { 7: 5.2, 8: 5.0, 9: 5.6, 10: 6.4, 11: 5.5, 12: 5.3 };
    const { best, tries } = await precise(6, 7, RANGE, fake((r, seed) => stars[seed]));
    assert.deepEqual(tries.map(t => t.r), [5.9, 5.9, 5.9, 5.9, 5.9, 5.9]);
    assert.deepEqual(tries.map(t => t.seed), [7, 8, 9, 10, 11, 12]);
    // 5.6 and 6.4 are as far from 6: the earlier one is kept.
    assert.equal(best, tries[2]);
});

test('once the request moves and the star does not, keeps the best request and tries the next seeds', async () => {
    const generate = fake(r => r < 3.6 ? 2.5 : r), { best, tries } = await precise(3, 7, RANGE, generate);
    // 3 gives 2.5, and so does the 3.5 asked next: the request goes back to 3, the earliest of the equally close.
    assert.equal(generate.calls, PRECISE.tries);
    assert.deepEqual(tries.map(t => t.r), [3, 3.5, 3, 3, 3, 3]);
    assert.deepEqual(tries.map(t => t.seed), [7, 7, 8, 9, 10, 11]);
    assert.equal(best, tries[0]);
});

test('a star that is not a number ends the search with the closest chart before it', async () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
        const stars = [3.9, 4.3, bad, 4.5], generate = fake(() => stars[generate.calls - 1]), kept = [];
        const { best, tries } = await precise(4.5, 7, RANGE, generate, t => kept.push(t));
        assert.equal(generate.calls, 3);
        assert.equal(tries.length, 3);
        assert.equal(best, tries[1]);
        assert.deepEqual(kept, [tries[0], tries[1]]);
    }
});

test('a first star that is not a number ends the search with that chart', async () => {
    const generate = fake(() => NaN), kept = [], { best, tries } = await precise(4.5, 7, RANGE, generate, t => kept.push(t));
    assert.equal(generate.calls, 1);
    assert.equal(tries.length, 1);
    assert.equal(best, tries[0]);
    assert.deepEqual(kept, [tries[0]]);
});

for (const [name, response] of Object.entries(RESPONSES))
    test(`${name}: at most ${PRECISE.tries} charts, never worse than the first, stops at the tolerance, the same again`, async () => {
        for (const target of TARGETS)
            for (const seed of SEEDS) {
                const generate = fake(response), kept = [], { best, tries } = await precise(target, seed, RANGE, generate, t => kept.push(t));
                assert.equal(generate.calls, tries.length);
                assert.ok(tries.length >= 1 && tries.length <= PRECISE.tries);
                assert.deepEqual(tries.map(t => t.k), tries.map((_, i) => i));
                assert.equal(tries[0].r, Math.min(RANGE[1], Math.max(RANGE[0], target)));
                assert.equal(tries[0].seed, seed);
                // The closest, the earliest of equals, and the one the caller was last told to keep.
                assert.ok(tries.every(t => distance(best, target) <= distance(t, target)));
                assert.equal(best, tries.find(t => distance(t, target) === distance(best, target)));
                assert.equal(kept.at(-1), best);
                // It stops at the first chart within the tolerance, and otherwise only after the last chart.
                const within = tries.findIndex(t => distance(t, target) <= PRECISE.tolerance);
                assert.equal(tries.length, within < 0 ? PRECISE.tries : within + 1);
                // It asks only for stars in the range.
                for (const t of tries) assert.ok(t.r >= RANGE[0] && t.r <= RANGE[1], `${t.r}`);
                assert.deepEqual(await precise(target, seed, RANGE, fake(response)), { best, tries });
            }
    });

test('a response it can follow ends within the tolerance where a request in the range gives the target', async () => {
    // r + 0.3 gives targets from 2.3 at a request in the range; 0.6 r + 1 gives targets from 2.2 to 4.54.
    for (const [name, targets] of [['linear', [2.5, 3.5, 4.4, 5.5, 5.9]], ['slope 0.6', [2.5, 3.5, 4.4]]])
        for (const target of targets) {
            const { best } = await precise(target, 1, RANGE, fake(RESPONSES[name]));
            assert.ok(distance(best, target) <= PRECISE.tolerance, `${name} at ${target}: ${best.m}`);
        }
});

test('takes other constants than the page\'s', async () => {
    const generate = fake(RESPONSES.saturating), { tries } = await precise(5.9, 7, RANGE, generate, undefined, { ...PRECISE, tries: 3 });
    assert.equal(generate.calls, 3);
    assert.deepEqual(tries.map(t => t.seed), [7, 8, 9]);
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
