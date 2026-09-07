import type { Diagnostic } from "./dispatch/types.js";
import type {
	CascadeIndeterminate,
	ImpactCascadeResult,
} from "./review-graph/types.js";

export interface CascadeNeighborResult {
	filePath: string;
	reason: "imports" | "calls" | "references" | "fallback";
	diagnostics: Diagnostic[];
	lspTouched: boolean;
	/** The touch did not confirm either clean state or diagnostics. */
	inconclusive?: boolean;
	/**
	 * #1459/#1470: scanners that did NOT look at this file — breaker open, resync
	 * deferred by the fan-out gate, or cut off by the aux grace timer. Present
	 * means "these findings are not a full picture", so a zero-diagnostic
	 * neighbour must not be rendered as a clean leaf. Deliberately separate from
	 * `inconclusive`: the primary answered and its findings stand.
	 */
	unconfirmedServerIds?: string[];
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
	| "blockers" // primary file had blocking diagnostics
	| "non_code" // file kind not eligible for cascade
	| "no_neighbors" // reverse-dep lookup found no importing files
	| "clean" // neighbors found but none had new diagnostics
	| "indeterminate" // #1023: impact could NOT be computed (degraded/cold/missing-node graph) — surfaced as an honest advisory, never as a silent all-clear
	| "error"; // the deferred compute rejected (never surfaced inline)

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
	/** Preserves selected paths for result-less indeterminate runs; bounded to the selected slice. */
	selectedNeighborPaths?: string[];
	skipReason?: CascadeSkipReason;
	/**
	 * #1023: set when the impact compute was DEGRADED/COLD/ERRORED or its
	 * selected neighbor budget omitted eligible dependents (see
	 * {@link CascadeIndeterminate}). Carries the detail the turn-end seam renders
	 * into an honest advisory. Decoupled from `skipReason` so a thrown compute
	 * (`skipReason: "error"`) can surface too.
	 */
	indeterminate?: CascadeIndeterminate;
	/**
	 * #1443: how many turn boundaries this run has survived without being
	 * consumed. Stamped by `RuntimeCoordinator.beginTurn` when it carries a run
	 * appended after the previous turn_end's `consumeCascadeRuns` (the
	 * quiet-window reconcile's late re-injection). The carry is bounded to ONE
	 * turn — beginTurn drops (and logs) anything that would reach 2. The
	 * turn-end origin filter does NOT read this field to decide whether to
	 * keep or reject a run (see `getFilesChangedSince` in runtime-turn.ts for
	 * the actual per-file supersede check) — it is carried through only for
	 * observability in the drop log's metadata.
	 */
	carriedTurns?: number;
}

/**
 * How long a cascade neighbour's diagnostics stay usable (#1816).
 *
 * One constant for two consumers that each declared their own `240_000`:
 * `clients/lsp/index.ts` (the neighbour-diagnostics cache) and
 * `clients/dispatch/integration.ts` (the cascade turn scope). They must move
 * together — a split pair reads as two independent policies and drifts.
 */
export const CASCADE_DIAGNOSTICS_TTL_MS = 240_000;
