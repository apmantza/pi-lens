// Bootstrapped comparison of two latency samples (#4363).
//
// `scripts/check-hot-path-latency.mjs` times each hot path N times on the
// base tree and N times on the head tree. One run per tree says nothing about
// noise: #4344 round 2 claimed 624 ms to 7 ms from one run each. This module
// resamples both groups with replacement, so the verdict carries a confidence
// interval instead of a point estimate.
//
// The rule is stated once, here, and printed with every report:
//
//   a metric is a REGRESSION when it is both
//     significant     the lower bound of the CI of (head median - base median)
//                     is above zero, and
//     above threshold the point estimate is at least `minRatio` times the base
//                     median AND at least `minDiffMs` slower.
//
// Medians (the shared one in test-shard-assignment.mjs), not means: a host hiccup that slows one sample does not move them.
// The ratio threshold keeps a real 3 % shift on a 600 ms path from failing
// the lane; the millisecond floor keeps a 40 % shift on a 2 ms path (below the
// noise of a shared runner) from failing it.

import { median } from "./test-shard-assignment.mjs";

export const DEFAULT_THRESHOLD = Object.freeze({
	minRatio: 1.25,
	minDiffMs: 5,
});
export const DEFAULT_ITERATIONS = 2000;
export const DEFAULT_CONFIDENCE = 0.95;
/** Fixed so one set of samples always yields one verdict. */
export const DEFAULT_SEED = 0x4363;

/** Seeded generator (mulberry32): the bootstrap must be reproducible. */
export function mulberry32(seed) {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function resample(values, random) {
	return Array.from(
		{ length: values.length },
		() => values[Math.floor(random() * values.length)],
	);
}

function percentile(sorted, p) {
	const at = Math.min(
		sorted.length - 1,
		Math.max(0, Math.floor(p * sorted.length)),
	);
	return sorted[at];
}

/**
 * Compare `head` against `base` samples (milliseconds, N >= 2 each).
 * Returns the medians and the bootstrapped interval of the difference and of
 * the ratio of medians.
 */
export function bootstrapCompare(base, head, options = {}) {
	const {
		iterations = DEFAULT_ITERATIONS,
		confidence = DEFAULT_CONFIDENCE,
		seed = DEFAULT_SEED,
	} = options;
	if (base.length < 2 || head.length < 2) {
		throw new Error("bootstrapCompare needs at least 2 samples per group");
	}
	const random = mulberry32(seed);
	const diffs = [];
	const ratios = [];
	for (let i = 0; i < iterations; i++) {
		const b = median(resample(base, random));
		const h = median(resample(head, random));
		diffs.push(h - b);
		ratios.push(b > 0 ? h / b : Number.POSITIVE_INFINITY);
	}
	diffs.sort((a, b) => a - b);
	ratios.sort((a, b) => a - b);
	const tail = (1 - confidence) / 2;
	const baseMedian = median(base);
	const headMedian = median(head);
	return {
		baseMedian,
		headMedian,
		diff: {
			point: headMedian - baseMedian,
			lo: percentile(diffs, tail),
			hi: percentile(diffs, 1 - tail),
		},
		ratio: {
			point:
				baseMedian > 0 ? headMedian / baseMedian : Number.POSITIVE_INFINITY,
			lo: percentile(ratios, tail),
			hi: percentile(ratios, 1 - tail),
		},
	};
}

/** The verdict of one comparison under the rule at the top of this file. */
export function judge(comparison, threshold = DEFAULT_THRESHOLD) {
	const significant = comparison.diff.lo > 0;
	const aboveThreshold =
		comparison.ratio.point >= threshold.minRatio &&
		comparison.diff.point >= threshold.minDiffMs;
	return {
		significant,
		aboveThreshold,
		regression: significant && aboveThreshold,
	};
}
