// Type declarations for lsp-idle-eviction-doc.mjs (untyped .mjs imported from .ts tests).

export type IdleEvictionResult =
	| "eligible"
	| "vetoed"
	| "inconclusive"
	| "unavailable";

export type IdleEvictionPolicy = "transparent" | "resident" | "unmeasured";

export interface IdleEvictionRow {
	serverId: string;
	role?: "primary" | "auxiliary";
	declared?: string;
	fixture?: string | null;
	result: IdleEvictionResult;
	reason?: string;
	initMs?: number;
	rssBytes?: number | null;
	respawn?: "ok" | "failed" | "not-evicted";
	coldStartMs?: number;
	coverage?: "preserved" | "narrowed" | "unproven";
	/** Findings the respawned server reported that the baseline did not. */
	widened?: number;
}

export interface IdleEvictionFinding {
	serverId: string;
	kind: string;
	severity: "drift" | "proposal" | "info";
	detail: string;
}

export const REASONS: Record<string, string>;
export const RESULT_STATES: readonly IdleEvictionResult[];

export function summarizeRows(rows: readonly IdleEvictionRow[]): {
	total: number;
	eligible: number;
	vetoed: number;
	inconclusive: number;
	unavailable: number;
	budget: number;
};

export function idleEvictionDrift(
	rows: readonly IdleEvictionRow[],
	declared: ReadonlyMap<string, string>,
): IdleEvictionFinding[];

export function renderIdleEvictionDoc(options: {
	rows: readonly IdleEvictionRow[];
	declared: ReadonlyMap<string, string>;
	date: string;
	platform: string;
}): string;

export function renderRawTable(rows: readonly IdleEvictionRow[]): string;

export function parseIdleEvictionDoc(text: string):
	| {
			serverId: string;
			role: string;
			declared: string;
			result: string;
			reason: string | undefined;
			respawn: string;
			coverage: string;
	  }[]
	| null;

export interface IdleEvictionHeld {
	serverId: string;
	/** The published cells that stand: `result|reason|respawn|coverage`. */
	prior: string;
	/** The cells tonight measured, in the same form. */
	measured: string;
	/** Set when the night is a flip held for its second agreeing night. */
	pendingRuns?: number;
}

export function publishIdleEvictionDoc(night: {
	rows: readonly IdleEvictionRow[];
	declared: ReadonlyMap<string, string>;
	date: string;
	platform: string;
	/** The committed document the night starts from; absent or unparsable publishes unheld. */
	priorDoc?: string;
	/** The capability matrix carrying the pending flips; absent publishes unheld. */
	matrixText?: string;
}): { doc: string; matrixText: string | undefined; held: IdleEvictionHeld[] };

export function reportIdleEvictionHeld(
	held: readonly IdleEvictionHeld[],
	sink: {
		env: Record<string, string | undefined>;
		log: (line: string) => void;
	},
): void;

export const IDLE_EVICTION_DRIFT_TITLE: string;

export function buildIdleEvictionDriftBody(
	findings: readonly IdleEvictionFinding[],
	options?: { runUrl?: string | null },
): string | null;

export function driftIssueState(
	rows: readonly IdleEvictionRow[],
	declared: ReadonlyMap<string, string>,
): "drift" | "clean" | "unknown";
