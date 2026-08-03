import type { Diagnostic } from "./dispatch/types.js";
import type {
	CascadeIndeterminate,
	ImpactCascadeResult,
} from "./review-graph/types.js";

export type { CascadeIndeterminate };

export interface CascadeNeighborResult {
	filePath: string;
	reason: "imports" | "calls" | "references" | "fallback";
	diagnostics: Diagnostic[];
	lspTouched: boolean;
	durationMs?: number;
}

export interface CascadeResult {
	filePath: string;
	impact: ImpactCascadeResult;
	neighbors: CascadeNeighborResult[];
	formatted: string;
}

/** Why a cascade run produced no formatted output. */
export type CascadeSkipReason =
	| "blockers"    // primary file had blocking diagnostics
	| "non_code"    // file kind not eligible for cascade
	| "no_neighbors" // reverse-dep lookup found no importing files
	| "clean"       // neighbors found but none had new diagnostics
	| "indeterminate" // #1023: impact could NOT be computed (degraded/cold/missing-node graph) — surfaced as an honest advisory, never as a silent all-clear
	| "error";      // the deferred compute rejected (never surfaced inline)

/**
 * Always-present result of one computeCascadeForFile invocation.
 * result is defined only when formatted output was produced.
 */
export interface CascadeRun {
	filePath: string;
	/** Sequence captured when the write launched this deferred computation. */
	origin?: { turnSeq?: number; writeSeq?: number; projectSeq?: number };
	result: CascadeResult | undefined;
	neighborCount: number;
	diagnosticCount: number;
	skipReason?: CascadeSkipReason;
	/**
	 * #1023: set when the impact compute was DEGRADED/COLD/ERRORED (see
	 * {@link CascadeIndeterminate}). Carries the detail the turn-end seam renders
	 * into an honest "downstream impact not computed" advisory. Decoupled from
	 * `skipReason` so a thrown compute (`skipReason: "error"`) can surface too.
	 */
	indeterminate?: CascadeIndeterminate;
}
