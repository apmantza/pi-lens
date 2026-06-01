import type { Diagnostic } from "./dispatch/types.js";
import type { ImpactCascadeResult } from "./review-graph/types.js";

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
	| "clean";      // neighbors found but none had new diagnostics

/**
 * Always-present result of one computeCascadeForFile invocation.
 * result is defined only when formatted output was produced.
 */
export interface CascadeRun {
	filePath: string;
	result: CascadeResult | undefined;
	neighborCount: number;
	diagnosticCount: number;
	skipReason?: CascadeSkipReason;
}
