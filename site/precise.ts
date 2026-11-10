/** Precise difficulty: makes several charts and keeps the one whose measured star is closest to the star asked for.
 *
 * The runtime generates once per request and seed, and a chart can come out easier or harder than its request. This
 * search asks again: it moves the request by how far the last chart missed, and once moving the request no longer
 * moves the star it keeps the best request and tries other seeds. It knows nothing of the page or the runtime: the
 * caller generates and measures. The Android app follows the same rule with the same constants, so that both give the
 * same charts; change them together. */

/** A seed as the page holds it: a number up to Number.MAX_SAFE_INTEGER, a bigint above, up to 64 bits. */
export type Seed = number | bigint;
/** One chart of a search: the star `r` and the seed the model was asked for, and the star `m` the chart measured. */
export interface Try { k: number; r: number; seed: Seed; m: number }

export const PRECISE = {
    /** The most charts one search makes. */
    tries: 6,
    /** A chart within this of the target ends the search. */
    tolerance: 0.05,
    /** How far above or below the target a request may go. */
    reach: 3,
    /** The least and the most measured stars per requested star that two tries may tell the next request. */
    slope: [0.5, 2.0] as readonly [number, number],
    /** A measured star or a request that moves less than this has stopped moving. */
    still: 0.01,
};

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/** `seed + n` as a seed: it wraps at 64 bits, and is a number where a number holds it exactly. */
export function addSeed(seed: Seed, n: number): Seed {
    const sum = BigInt.asUintN(64, BigInt(seed) + BigInt(n));
    return sum <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(sum) : sum;
}

/** Searches for a chart of `target` stars from `seed`. `generate` makes the chart of try `k` for a star and a seed and
 * gives its measured star; `keep` is called when the chart just made is the closest so far, so that the caller holds
 * on to that chart and drops the others. Gives the closest try, the earliest of equals, and every try in order. */
export async function precise(target: number, seed: Seed, generate: (star: number, seed: Seed, k: number) => Promise<number>, keep?: (best: Try) => void, { tries: most, tolerance, reach, slope: [gentlest, steepest], still } = PRECISE) {
    const tries: Try[] = [];
    let r = target, current = seed, saturated = false, seedTries = 0, best: Try | undefined;
    for (let k = 0; ; k++) {
        const m = await generate(r, current, k), made: Try = { k, r, seed: current, m };
        tries.push(made);
        if (!best || Math.abs(m - target) < Math.abs(best.m - target)) {
            best = made;
            keep?.(best);
        }
        if (Math.abs(best.m - target) <= tolerance || k >= most - 1) return { best, tries };
        if (!saturated) {
            // Until then every try has the first seed, so the latest earlier try of another request is the one to compare.
            let prev: Try | undefined;
            for (let i = k - 1; i >= 0 && !prev; i--)
                if (tries[i].seed === current && tries[i].r !== r) prev = tries[i];
            // The request moved and the star did not.
            if (prev && Math.abs(m - prev.m) < still) saturated = true;
            else {
                const slope = prev ? clamp((m - prev.m) / (r - prev.r), gentlest, steepest) : 1;
                const next = clamp(r + (target - m) / slope, target - reach, target + reach);
                if (Math.abs(next - r) < still) saturated = true;
                else r = next;
            }
        }
        if (saturated) {
            r = best.r;
            seedTries += 1;
            current = addSeed(seed, seedTries);
        }
    }
}
