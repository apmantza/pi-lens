/**
 * Subagent light mode (#449 slice 0).
 *
 * The nicobailon/pi-subagents extension spawns each subagent as a child `pi`
 * CLI process and sets `PI_SUBAGENT_CHILD=1` unconditionally in every child's
 * environment (plus `PI_SUBAGENT_RUN_ID` / `PI_SUBAGENT_CHILD_AGENT`). Every
 * child currently loads pi-lens fully by default, so a 4-way fan-out pays 4
 * full LSP pre-warms + 4 sets of heavyweight startup scans in the same cwd —
 * mostly wasted on short-lived task agents.
 *
 * This module only classifies the session; it does not change any behavior
 * itself. Callers (`runtime-session.ts`) gate the LSP pre-warm and the seven
 * heavyweight external-CLI startup scans on `isSubagentSession()`. Per-edit
 * LSP dispatch is untouched — light mode must not disable diagnostics.
 *
 * Escape hatch: `PI_LENS_SUBAGENT_FULL=1` forces full (non-light) behavior
 * even inside a detected subagent session.
 *
 * Follows the lazy-memoized-config house style (see `runtime-config.ts` /
 * `slow-fs.ts`): env values are read lazily at call time, not module load.
 */

/** True iff pi-lens is running inside a nicobailon/pi-subagents child `pi`
 * process, and the caller has not forced full behavior via the escape hatch. */
export function isSubagentSession(): boolean {
	if (process.env.PI_LENS_SUBAGENT_FULL === "1") return false;
	return process.env.PI_SUBAGENT_CHILD === "1";
}

export interface SubagentIdentity {
	runId?: string;
	agentName?: string;
}

/**
 * Best-effort identity of the current subagent, read from the env vars the
 * nicobailon/pi-subagents extension sets alongside `PI_SUBAGENT_CHILD=1`.
 * Returns `undefined` when neither identity var is present (e.g. not a
 * subagent session, or a future extension that doesn't set them).
 */
export function getSubagentIdentity(): SubagentIdentity | undefined {
	const runId = process.env.PI_SUBAGENT_RUN_ID || undefined;
	const agentName = process.env.PI_SUBAGENT_CHILD_AGENT || undefined;
	if (runId === undefined && agentName === undefined) return undefined;
	return { runId, agentName };
}

/** Human-readable degradation notice surfaced once per session when subagent
 * light mode engages, so a subagent never sees a silently-empty scan result. */
export function subagentLightModeNotice(): string {
	return "subagent session — skipped background code-quality scans (set PI_LENS_SUBAGENT_FULL=1 to override)";
}

/** Test-only: nothing is memoized in this module today (env is read fresh on
 * every call), but this hook exists so callers/tests can reset state uniformly
 * if a memoization layer is added later — matching the `_resetForTests`
 * convention used by `runtime-config.ts` / `slow-fs.ts`. */
export function _resetSubagentModeForTests(): void {
	// no-op: no memoized state yet.
}
