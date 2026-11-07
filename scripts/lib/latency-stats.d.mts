// Type declarations for latency-stats.mjs (#4363).

export interface Threshold {
	/** Head median over base median at which a slowdown counts. */
	minRatio: number;
	/** Absolute slowdown, in milliseconds, at which it counts. */
	minDiffMs: number;
}
export interface Interval {
	point: number;
	lo: number;
	hi: number;
}
export interface Comparison {
	baseMedian: number;
	headMedian: number;
	diff: Interval;
	ratio: Interval;
}
export interface Judgement {
	significant: boolean;
	aboveThreshold: boolean;
	regression: boolean;
}
export interface BootstrapOptions {
	iterations?: number;
	confidence?: number;
	seed?: number;
}
export const DEFAULT_THRESHOLD: Readonly<Threshold>;
export const DEFAULT_ITERATIONS: number;
export const DEFAULT_CONFIDENCE: number;
export const DEFAULT_SEED: number;
export function mulberry32(seed: number): () => number;
export function bootstrapCompare(
	base: readonly number[],
	head: readonly number[],
	options?: BootstrapOptions,
): Comparison;
export function judge(comparison: Comparison, threshold?: Threshold): Judgement;
