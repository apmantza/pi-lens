/**
 * The auxiliary LSP lifecycle and wait policy (#1488).
 *
 * The auxiliary contract had no home. Its diagnostic half — profiles,
 * enablement, native-inline suppression, tool re-tag, blocking policy — lives
 * in clients/dispatch/auxiliary-lsp.ts. Its lifecycle half was spread across
 * clients/lsp/index.ts (the with-auxiliary touch path, the `getDiagnostics`
 * descriptors, the budgets, the cut-off ids), clients/lsp/aggregation.ts (the
 * shared grace window) and clients/lsp/wait-policy/strategies.ts (per-server
 * `aggregateWaitMs`), so every auxiliary fix edited two or three of them
 * together: #1458 changed both index.ts and aggregation.ts to express ONE
 * policy, and #1470 sat on the same seam.
 *
 * This module is that half's home: the declared-budget-capped-by-a-ceiling
 * rule and the knobs that feed it. The role predicate its callers read is
 * `isAuxiliary` in clients/lsp/server-traits.ts, which is also the trait
 * table's declaration surface.
 *
 * The third expression of the capped-budget rule stays where it is, on purpose:
 * `raceToCompletion`'s aux-grace window (clients/lsp/aggregation.ts) applies
 * `min(ceiling, max(still-pending declared budgets))` to a SET of budgets
 * inside ONE shared timer, so it grants every pending auxiliary the window of
 * its slowest pending sibling. Folding it into {@link auxWaitBudgetMs} would
 * change `raceToCompletion`'s public signature to carry a set, and its
 * over-granting caveat is documented and pinned where the timer lives
 * (tests/clients/lsp/aggregation.test.ts). Named as a #1756 stage-2 residual.
 */

import { getSuccessfulLspSpawnDurationMs } from "./spawn-history.js";

/**
 * Read the `PI_LENS_AUX_GRACE_MS` env override at call time (not module load
 * time) so tests can set it per case. Controls the CEILING on how long
 * auxiliary-role promises (opengrep, ast-grep, zizmor, …) are waited after all
 * primary-role promises have settled, in both `getDiagnostics`
 * (`raceToCompletion`) and the `touchFile` push wait (#1458 S2 — the two lanes
 * share the same declared-budget-capped-by-ceiling shape). Each auxiliary
 * still gets only its OWN declared `aggregateWaitMs` up to this ceiling — this
 * is not a flat per-touch wait. Returns undefined when the var is absent; each
 * call site then supplies its own default ceiling, which is
 * {@link DEFAULT_AUX_GRACE_CEILING_MS} at both of them.
 */
export function readEnvAuxGraceMs(): number | undefined {
	const raw = process.env.PI_LENS_AUX_GRACE_MS;
	if (raw === undefined) return undefined;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed < 0) return undefined;
	return parsed;
}

export const DEFAULT_AUX_GRACE_CEILING_MS = 2000;
export const MAX_ADAPTIVE_AUX_GRACE_CEILING_MS = 8000;
export const ADAPTIVE_AUX_GRACE_MARGIN_MS = 500;

/**
 * ONE auxiliary's wait budget for ONE touch: its own declared wait, capped by
 * the configured (or default) ceiling — except a COLD auxiliary with an
 * observed spawn duration, which earns an adaptive window instead so a scanner
 * whose rule-load cold start exceeds the ceiling is not cut off before its
 * first answer (#1458 S2).
 *
 * Whether to ask at all is the CALLER's decision, and the two touchFile call
 * sites keep their own gates: the per-server timeout arm asks only for a cold
 * auxiliary with a configured ceiling or an observed spawn, and falls back to
 * the timeout it declared otherwise. Moved verbatim from clients/lsp/index.ts
 * by #1488 — same signature, same three arms, same values.
 */
export function auxWaitBudgetMs(
	serverId: string,
	isCold: boolean,
	configuredCeilingMs: number | undefined,
	declaredWaitMs: number,
): number {
	if (configuredCeilingMs !== undefined || !isCold) {
		return Math.min(
			declaredWaitMs,
			configuredCeilingMs ?? DEFAULT_AUX_GRACE_CEILING_MS,
		);
	}
	const observedSpawnMs = getSuccessfulLspSpawnDurationMs(serverId);
	if (observedSpawnMs === undefined || observedSpawnMs <= 0) {
		return Math.min(declaredWaitMs, DEFAULT_AUX_GRACE_CEILING_MS);
	}
	return Math.min(
		MAX_ADAPTIVE_AUX_GRACE_CEILING_MS,
		Math.max(declaredWaitMs, observedSpawnMs + ADAPTIVE_AUX_GRACE_MARGIN_MS),
	);
}
