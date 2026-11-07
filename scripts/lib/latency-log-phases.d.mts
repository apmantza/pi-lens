// Type declarations for latency-log-phases.mjs (untyped .mjs imported from .ts tests).

export function parseNdjsonEntries(
	text: string,
): Array<Record<string, unknown>>;

export function findPhaseEntries(
	entries: Array<Record<string, unknown>>,
	phase: string,
	sinceIso?: string,
): Array<Record<string, unknown>>;

export function phaseWasLogged(
	entries: Array<Record<string, unknown>>,
	phase: string,
	sinceIso?: string,
): boolean;

export function noPhasesLogged(
	entries: Array<Record<string, unknown>>,
	phases: string[],
	sinceIso?: string,
): boolean;

export function countEntriesSince(
	entries: Array<Record<string, unknown>>,
	sinceIso: string,
): number;

/**
 * The p-quantile of an ascending sample by the clamped floor-rank index
 * `clamp(floor(p * n), 0, n - 1)`. Every returned value is an observed sample.
 */
export function lowerRankPercentile(
	sorted: readonly number[],
	p: number,
): number;

export const LEGACY_AGE_PHASES: ReadonlySet<string>;

export function latencyAgeMs(entry: unknown): number | undefined;

export function latencySpanMs(entry: unknown): number | undefined;
