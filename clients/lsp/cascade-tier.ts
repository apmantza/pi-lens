/**
 * Tier-aware cascade-lane wait policy (#458, re-scope №2).
 *
 * The cascade/deferred lane (`computeCascadeForFile`'s neighbor-touch fan-out
 * in `clients/dispatch/integration.ts`) actively opens neighbor files against
 * their LSP client and waits up to a per-touch budget (~1000ms cold-snapshot /
 * 2000ms warm) for `textDocument/publishDiagnostics` before deciding the
 * neighbor is clean. For a Tier-3 server — one that is `push-only` AND known
 * to publish NOTHING on a clean→clean transition (see
 * docs/lsp-capability-matrix.md; today that's typescript-language-server, the
 * lone core-set instance) — that wait can never distinguish "clean" from
 * "still analyzing"; it always burns its full budget. Dogfooding measured
 * ~221 such `lsp_diagnostics_timeout` events/day.
 *
 * pi 0.80.6's `agent_settled` quiet window (#483, `clients/quiet-window.ts`)
 * gives the cascade lane a place to resolve that ambiguity OUT of the
 * per-touch budget: fire the touch (didOpen/didChange still happens, so the
 * server starts real work), record it as outstanding, and reconcile against
 * whatever landed in the client's diagnostics cache by the time the agent run
 * goes idle. A touch nothing arrived for by then is recorded `unresolved` —
 * never silently treated as `clean` (the #240 doctrine: a missing answer is
 * not an affirmative answer).
 *
 * This module is deliberately NOT hardcoded to server names for the "should
 * this file skip its in-lane wait" question: it reads the live capability
 * snapshot's `workspaceDiagnosticsSupport.mode` (from
 * `detectWorkspaceDiagnosticsSupport`, cached at `initialize`) and combines it
 * with the `silentOnClean` marker on that server's `DiagnosticStrategy`
 * (`server-strategies.ts`) — the same per-server behavioral-knowledge table
 * the rest of the LSP layer already uses. A server with no live snapshot yet,
 * or whose mode isn't `push-only`, or that isn't marked `silentOnClean`, is
 * NOT tier-3 — the caller keeps today's full in-lane wait. Fail-safe is
 * always "wait like before".
 *
 * #524/#529/#541/#558: a server id can now be backed by more than one actual
 * binary — "typescript" is classic typescript-language-server OR TS7's
 * native `tsc --lsp --stdio` (PR #526). PR #526 originally routed the
 * native-ts7 variant through the fail-safe "waits" path because
 * `silentOnClean` had only been measured against the classic server; #541
 * (2026-07-11) briefly lifted that exclusion after a clean-signal probe run
 * appeared to show native-ts7 silent too. A follow-up dual-environment
 * re-measurement (2026-07-12, nightly CI on Linux AND a live local run on
 * Windows dev, same `typescript@7.0.2` both times) found native-ts7 now
 * publishes 2 version-less diagnostic sets on the clean transition
 * (`cleanPubs=2(v:0)`) — it is NOT silent. Classic is unaffected and
 * confirmed still silent (`cleanPubs=0(v:0)`) in the same run. This is
 * therefore an EVIDENCE-BASED revert, not the original unverified caution:
 * native-ts7's clean-signal behavior IS known, and it is "publishes, not
 * silent". The snapshot's `launchVariant` marker again routes a native-ts7
 * snapshot through "waits" while the shared `silentOnClean` flag stays
 * `true` for classic. `scripts/probe-clean-signal.mjs`'s drift check no
 * longer compares native-ts7 rows against the shared marker (it now expects
 * `false` for them explicitly) — see that file's header for the regression
 * watch this sets up for a future TS7 build that becomes silent again.
 */

import { logCascade } from "../cascade-logger.js";
import { logLatency } from "../latency-logger.js";
import { normalizeMapKey } from "../path-utils.js";
import { registerQuietWindowTask } from "../quiet-window.js";
import { getServersForFileWithConfig } from "./config.js";
import type { LSPService } from "./index.js";
import { getStrategy } from "./server-strategies.js";

// --- Kill switch (lazy, memoized — house style per clients/runtime-config.ts /
// clients/quiet-window.ts's isQuietWindowEnabled) ---

let _enabledCache: boolean | undefined;

/** `PI_LENS_TIER_AWARE_CASCADE=0` disables the whole feature: every cascade
 * touch waits in-lane exactly as it did before #458, no outstanding-touch
 * bookkeeping, no reconcile task registered. */
export function isTierAwareCascadeEnabled(): boolean {
	if (_enabledCache !== undefined) return _enabledCache;
	_enabledCache = process.env.PI_LENS_TIER_AWARE_CASCADE !== "0";
	return _enabledCache;
}

/** Test-only: clear the memoized kill-switch read. */
export function _resetTierAwareCascadeEnabledForTests(): void {
	_enabledCache = undefined;
}

export type CascadeWaitTier = "tier3-silent" | "waits";

/**
 * Classify whether `filePath`'s PRIMARY language server is a cascade-lane
 * Tier-3 (push-only, silent-on-clean) server. Ambiguous or missing capability
 * data is always `"waits"` (today's behavior) — this function must never be
 * the reason a real answer gets missed.
 */
export function classifyCascadeWaitTier(
	lspService: Pick<LSPService, "getCapabilitySnapshots">,
	filePath: string,
	snapshots: Awaited<ReturnType<LSPService["getCapabilitySnapshots"]>>,
): CascadeWaitTier {
	void lspService; // kept in the signature for call-site clarity/typing only
	const servers = getServersForFileWithConfig(filePath).filter(
		(s) => s.role !== "auxiliary",
	);
	const primary = servers[0];
	if (!primary) return "waits";

	const snapshot = snapshots.find((s) => s.serverId === primary.id);
	if (!snapshot) return "waits"; // no live snapshot yet — fail-safe

	const mode = snapshot.workspaceDiagnosticsSupport?.mode;
	if (mode !== "push-only") return "waits"; // pull servers are always affirmative

	const strategy = getStrategy(primary.id);
	if (strategy.silentOnClean !== true) return "waits"; // 2*/unknown push-only

	// #524/#529/#541/#558: `silentOnClean` on a server-id-keyed strategy is
	// only proven against the variant it was actually measured against.
	// "typescript" today means either classic typescript-language-server
	// (confirmed silent-on-clean, 2026-07-12 dual-environment re-measurement)
	// or TS7's native `tsc --lsp --stdio` (the SAME re-measurement found it
	// publishes 2 version-less diagnostic sets on clean — NOT silent, a
	// drift from the earlier #541 measurement). A native-ts7 snapshot must
	// NOT inherit the classic verdict: fall through to "waits", the same
	// ambiguous/fail-safe path an unmarked or non-push-only server already
	// takes. `launchVariant === "classic"` or absent (older snapshots that
	// predate the marker) keeps today's tier-3 behavior exactly.
	if (snapshot.launchVariant === "native-ts7") return "waits";

	return "tier3-silent";
}

// --- Outstanding-touch registry -------------------------------------------

interface OutstandingTouch {
	filePath: string;
	serverId: string;
	/**
	 * Sampled BEFORE the touch's didOpen/didChange notify is sent, so any
	 * publish that lands after the notify — including one landing in the
	 * notify→record gap — reads as post-touch at reconcile time. Compared
	 * against the client's PER-FILE publish timestamp (`getAllDiagnostics()`'s
	 * `ts`), never against a client-wide signal: a cascade touches multiple
	 * neighbors on the SAME client, so a client-wide counter advanced by
	 * neighbor A's publish must not "prove" neighbor B clean (#240).
	 */
	touchedAt: number;
}

// Keyed by normalized file path. A later touch for the same file simply
// replaces the earlier entry (only the most recent touch matters — an
// older touch's diagnostics, if they ever arrive, are still a strict superset
// concern the newer touch already re-supersedes via didOpen/didChange).
const _outstandingTouches = new Map<string, OutstandingTouch>();

/**
 * Record a Tier-3 cascade touch that skipped its in-lane wait. Called right
 * after the (still-performed) didOpen/didChange notify, before returning
 * without waiting. `touchedAt` must be sampled BEFORE the notify (see the
 * field doc) so the reconcile comparison can never misread a publish that
 * raced the record as pre-touch.
 */
export function recordOutstandingCascadeTouch(entry: OutstandingTouch): void {
	_outstandingTouches.set(normalizeMapKey(entry.filePath), entry);
}

/** Test-only: clear the outstanding-touch registry between test cases. */
export function _resetOutstandingCascadeTouchesForTests(): void {
	_outstandingTouches.clear();
}

/** Test-only: peek at the registry without mutating it. */
export function _getOutstandingCascadeTouchesForTests(): OutstandingTouch[] {
	return [...(_outstandingTouches.values() as Iterable<OutstandingTouch>)];
}

export interface ReconcileOutcome {
	filePath: string;
	serverId: string;
	outcome: "resolved-found" | "resolved-clean" | "unresolved";
	ageMs: number;
	diagnosticCount?: number;
}

/**
 * Reconcile every outstanding Tier-3 touch against the LSP client's current
 * diagnostics cache. For each:
 *   - If the client holds a PER-FILE diagnostics entry for the touched file
 *     whose publish timestamp (`getAllDiagnostics()`'s `ts` — the max of the
 *     push/pull timestamps for that file, client.ts) is newer than the
 *     touch's pre-notify `touchedAt`, something published for THAT FILE since
 *     the touch — record `resolved-found` (diagnostics present) or
 *     `resolved-clean` (empty, but PROVEN empty by an actual publish for that
 *     file after the touch). A client-WIDE signal is deliberately not used:
 *     it advances on any file's publish, so it could falsely "prove" a silent
 *     neighbor clean when a sibling neighbor published (#240).
 *   - If nothing published for the file by settle time, record `unresolved` —
 *     per the #240 doctrine this is NEVER treated as clean.
 *
 * Client lookup is WARM-ONLY (`getWarmClientForFile`): the quiet window must
 * never resurrect an idle-reaped server (a full tsserver spawn + cold index)
 * just to write a log line. A warm-miss ⇒ `unresolved`.
 *
 * Always drains the whole registry (each entry is independently resolved;
 * one entry's client lookup failing doesn't block the rest) and never
 * throws — callers (the quiet-window task) must be fail-safe.
 */
export async function reconcileOutstandingCascadeTouches(
	lspService: Pick<LSPService, "getWarmClientForFile">,
): Promise<ReconcileOutcome[]> {
	const outcomes: ReconcileOutcome[] = [];
	const entries = [..._outstandingTouches.entries()];
	_outstandingTouches.clear();

	for (const [key, touch] of entries) {
		const ageMs = Date.now() - touch.touchedAt;
		try {
			const spawned = await lspService.getWarmClientForFile(touch.filePath);
			if (!spawned || spawned.client.serverId !== touch.serverId) {
				outcomes.push({
					filePath: touch.filePath,
					serverId: touch.serverId,
					outcome: "unresolved",
					ageMs,
				});
				continue;
			}
			const entry = spawned.client
				.getAllDiagnostics()
				.get(normalizeMapKey(touch.filePath));
			if (!entry || entry.ts <= touch.touchedAt) {
				// No per-file publish since the touch (or ever) — a missing answer
				// is not a clean answer.
				outcomes.push({
					filePath: touch.filePath,
					serverId: touch.serverId,
					outcome: "unresolved",
					ageMs,
				});
				continue;
			}
			outcomes.push({
				filePath: touch.filePath,
				serverId: touch.serverId,
				outcome: entry.diags.length > 0 ? "resolved-found" : "resolved-clean",
				ageMs,
				diagnosticCount: entry.diags.length,
			});
		} catch (err) {
			outcomes.push({
				filePath: touch.filePath,
				serverId: touch.serverId,
				outcome: "unresolved",
				ageMs,
			});
			logLatency({
				type: "phase",
				phase: "cascade_tier3_reconcile_error",
				filePath: key,
				durationMs: 0,
				metadata: { error: String(err) },
			});
		}
	}
	return outcomes;
}

let _reconcileTaskRegistered = false;

/**
 * Register the Tier-3 reconcile task with the quiet-window scheduler
 * (`clients/quiet-window.ts`). Idempotent — safe to call more than once
 * (e.g. multiple extension activations in tests).
 */
export function registerCascadeTierReconcileTask(
	getLspService: () => Pick<LSPService, "getWarmClientForFile">,
): void {
	if (_reconcileTaskRegistered) return;
	_reconcileTaskRegistered = true;

	registerQuietWindowTask("cascade_tier3_reconcile", async () => {
		if (!isTierAwareCascadeEnabled()) return;
		if (_outstandingTouches.size === 0) return;
		const outcomes = await reconcileOutstandingCascadeTouches(getLspService());
		if (outcomes.length === 0) return;

		let resolvedFound = 0;
		let resolvedClean = 0;
		let unresolved = 0;
		let ageSumMs = 0;
		for (const o of outcomes) {
			if (o.outcome === "resolved-found") resolvedFound++;
			else if (o.outcome === "resolved-clean") resolvedClean++;
			else unresolved++;
			ageSumMs += o.ageMs;
		}
		const avgAgeMs = Math.round(ageSumMs / outcomes.length);

		logCascade({
			phase: "cascade_tier3_reconcile",
			filePath: "<quiet-window>",
			metadata: {
				count: outcomes.length,
				resolvedFound,
				resolvedClean,
				unresolved,
				avgAgeMs,
				outcomes,
			},
		});
	});
}

/** Test-only: undo registerCascadeTierReconcileTask's idempotency guard. */
export function _resetCascadeTierReconcileRegistrationForTests(): void {
	_reconcileTaskRegistered = false;
}
