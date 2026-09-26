/**
 * Cross-process LSP budget (#449 slice 2 — PROTOTYPE).
 *
 * Slice 1 (#472/#474/#475, `clients/instance-registry.ts` +
 * `clients/instance-reaper.ts`) made every concurrent pi-lens process visible
 * to every other one via `~/.pi-lens/instances.json`. This module is the
 * first thing that DOES something with that visibility: a machine-wide cap
 * on total live LSP server processes. When a NEW session starts and the
 * machine is already over budget, it degrades its OWN spawn plan — it never
 * touches another instance's already-running servers.
 *
 * Deliberately NOT a clearinghouse: no negotiation, no reservation, no
 * cross-process locking. Each session reads the registry once at
 * `session_start`, decides locally, and moves on — a "position limit," per
 * the issue's own framing, not shared ownership of anyone else's servers.
 *
 * Degrade mechanism chosen for this first slice: skip spawning AUXILIARY LSP
 * servers (role:"auxiliary" in clients/lsp/server.ts — opengrep, ast-grep,
 * zizmor, typos, marksman) for the remainder of THIS session, keeping only
 * the primary language server per file. Auxiliaries are cross-cutting
 * scanners layered on top of (not required for) core diagnostics, so this is
 * the cheapest, highest-signal thing to shed under machine-wide pressure.
 * The cached decision also shortens this session's idle reset and lets
 * pull-capable servers skip their push fallback. All three degrade mechanisms
 * read the same session-boundary snapshot; pressure never changes mid-touch.
 *
 * Ceiling default (`DEFAULT_LSP_BUDGET_CEILING = 16`): a rough RAM-budget
 * back-of-envelope, not a measured figure (#620's CPU/RSS sampling had not
 * landed as of this prototype) — assume ~250MB average RSS per live LSP
 * child process (typescript-language-server/pyright cold-index spikes
 * higher, short-lived auxiliaries like typos-lsp are much lighter, so this
 * is a rough blend) against a soft target of ~4GB machine-wide dedicated to
 * the LSP fleet: 4000MB / 250MB ≈ 16. Deliberately conservative-permissive
 * for a first cut — the goal is to catch the "25 concurrent node.exe, several
 * at 600MB-2GB RSS" pathological pile-up this was written in response to
 * (dogfooding note, 2026-07-12/13), not to micromanage the common 2-4-agent
 * case. `PI_LENS_LSP_BUDGET_CEILING` overrides it once real-world data (#620)
 * says otherwise.
 *
 * Kill switch: `PI_LENS_CROSS_PROCESS_BUDGET=0` disables this module
 * entirely (every session always spawns its full fleet, today's behavior) —
 * lazy env read, never memoized, matching the house style
 * (session-lifecycle.ts / runtime-config.ts).
 */

import {
	type InstanceEntry,
	isInstanceRegistryEnabled,
	readInstanceRegistry,
} from "./instance-registry.js";
import { realIsPidAlive, STALE_HEARTBEAT_MS } from "./instance-reaper.js";
import { logLatency } from "./latency-logger.js";
import { isInPidNamespace, ownPidNamespace } from "./process-snapshot.js";

/** See the module docstring for the derivation. */
export const DEFAULT_LSP_BUDGET_CEILING = 16;
export const DEFAULT_LSP_BUDGET_IDLE_TIMEOUT_MS = 60_000;

/** `PI_LENS_CROSS_PROCESS_BUDGET=0` disables the budget check entirely —
 *  lazy env read (house style), never memoized so tests can flip it mid-run. */
export function isCrossProcessBudgetEnabled(): boolean {
	return process.env.PI_LENS_CROSS_PROCESS_BUDGET !== "0";
}

/** `PI_LENS_LSP_BUDGET_CEILING` overrides {@link DEFAULT_LSP_BUDGET_CEILING}.
 *  Non-finite/non-positive overrides are ignored (NaN-guard house style, see
 *  clients/runtime-config.ts) — falls back to the default rather than
 *  silently producing a ceiling of 0 (which would degrade every session). */
export function getLspBudgetCeiling(): number {
	const raw = Number(process.env.PI_LENS_LSP_BUDGET_CEILING);
	return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_LSP_BUDGET_CEILING;
}

/** Optional aggregate host + LSP-child RSS ceiling. Undefined means disabled. */
export function getLspBudgetRssCeilingBytes(): number | undefined {
	const raw = Number(process.env.PI_LENS_LSP_BUDGET_RSS_MB);
	return Number.isFinite(raw) && raw > 0 ? raw * 1024 * 1024 : undefined;
}

export function getLspBudgetIdleTimeoutMs(): number {
	const raw = Number(process.env.PI_LENS_LSP_BUDGET_IDLE_TIMEOUT_MS);
	return Number.isFinite(raw) && raw > 0
		? raw
		: DEFAULT_LSP_BUDGET_IDLE_TIMEOUT_MS;
}

export interface LspBudgetDecision {
	/** Sum of `lspChildren.length` across every registry entry whose owning
	 *  pid is currently alive. Entries whose parent pid is dead are excluded —
	 *  their children are the orphan reaper's job (clients/instance-reaper.ts),
	 *  not counted as "live" load here. */
	totalLiveLspServers: number;
	ceiling: number;
	totalRssBytes?: number;
	rssCeilingBytes?: number;
	rssPressure: boolean;
	overBudget: boolean;
	/** The one degrade mechanism this prototype implements: skip auxiliary
	 *  LSP servers for the current session. Equal to `overBudget` today —
	 *  broken out as its own field so a future slice can add a second,
	 *  independently-triggered mechanism (e.g. shorter idle-reaper timeout)
	 *  without every caller needing to re-derive it from `overBudget`. */
	degradeAuxiliary: boolean;
	shortenIdleTimeout: boolean;
	preferPullOnly: boolean;
}

/**
 * PURE decision function — no I/O. Mirrors `decideOrphanReaping`'s shape
 * (clients/instance-reaper.ts) for the same reason: injectable liveness
 * predicate, fully unit-testable with fake registry data, zero real
 * process.kill/spawn/fs calls.
 *
 * Liveness is counted, not just registry presence, because a dead-parent
 * instance's `lspChildren` entries are exactly the orphan reaper's target —
 * counting them here would double-penalize new sessions for load that's
 * already being cleaned up (or was already cleaned up and the entry just
 * hasn't been pruned from this snapshot yet).
 *
 * An entry from another pid namespace (#3539 review F1) names a pid that
 * means nothing here, so it counts as live only while its heartbeat is
 * fresh: a dead container's entry must not hold the budget forever.
 */
export function decideLspBudget(
	registry: readonly InstanceEntry[],
	isPidAlive: (pid: number) => boolean,
	ceiling: number,
	rssCeilingBytes?: number,
	now = Date.now(),
	ownNamespace?: string,
): LspBudgetDecision {
	const hasFreshHeartbeat = (instance: InstanceEntry) => {
		const heartbeatMs = Date.parse(instance.heartbeatAt);
		return (
			Number.isFinite(heartbeatMs) && now - heartbeatMs <= STALE_HEARTBEAT_MS
		);
	};
	const liveInstances = registry.filter((instance) =>
		isInPidNamespace(instance, ownNamespace)
			? isPidAlive(instance.pid)
			: hasFreshHeartbeat(instance),
	);
	const totalLiveLspServers = liveInstances.reduce(
		(sum, instance) => sum + instance.lspChildren.length,
		0,
	);
	const hasCompleteFreshSamples =
		rssCeilingBytes !== undefined &&
		liveInstances.length > 0 &&
		liveInstances.every((instance) => {
			return (
				hasFreshHeartbeat(instance) &&
				Number.isFinite(instance.rssBytes) &&
				instance.lspChildren.every((child) => Number.isFinite(child.rssBytes))
			);
		});
	const totalRssBytes = hasCompleteFreshSamples
		? liveInstances.reduce(
				(sum, instance) =>
					sum +
					instance.rssBytes +
					instance.lspChildren.reduce(
						(childSum, child) => childSum + (child.rssBytes ?? 0),
						0,
					),
				0,
			)
		: undefined;
	const rssPressure =
		totalRssBytes !== undefined &&
		rssCeilingBytes !== undefined &&
		totalRssBytes >= rssCeilingBytes;
	const overBudget = totalLiveLspServers >= ceiling || rssPressure;
	return {
		totalLiveLspServers,
		ceiling,
		totalRssBytes,
		rssCeilingBytes,
		rssPressure,
		overBudget,
		degradeAuxiliary: overBudget,
		shortenIdleTimeout: overBudget,
		preferPullOnly: overBudget,
	};
}

// --- Module-scope decision cache, read by clients/dispatch/auxiliary-lsp.ts ---
//
// session_start fires this check fire-and-forget (must never block session
// start on a registry read) and stashes the result here; the auxiliary-LSP
// enablement gate reads it synchronously on every dispatch. Default (before
// the async check resolves, or if it's never run — e.g. the kill switch, or
// a process that never reached session_start) is "don't degrade" — fail
// toward today's behavior, exactly like the concurrent-session guard.

let cachedDecision: LspBudgetDecision | undefined;

/** True once the budget check has run this process and found the machine
 *  over the configured ceiling. Read by
 *  `clients/dispatch/auxiliary-lsp.ts#enabledAuxiliaryLspServerIds`. Never
 *  throws; absent-decision (not yet checked, or disabled) reads as `false`. */
export function shouldDegradeAuxiliaryLsp(): boolean {
	return cachedDecision?.degradeAuxiliary ?? false;
}

export function shouldShortenLspIdleTimeout(): boolean {
	return cachedDecision?.shortenIdleTimeout ?? false;
}

export function shouldPreferPullOnlyDiagnostics(): boolean {
	return cachedDecision?.preferPullOnly ?? false;
}

/** Test-only: reset the module-scope cache between tests. */
export function _resetLspBudgetDecisionForTests(): void {
	cachedDecision = undefined;
}

/**
 * Fire-and-forget budget check for `session_start`. Reads the instance
 * registry, decides via {@link decideLspBudget}, and caches the result for
 * `shouldDegradeAuxiliaryLsp` to read on subsequent dispatch calls. Never
 * throws — a failed check just leaves the cache at its "don't degrade"
 * default, matching every other best-effort registry consumer in this
 * codebase (registerInstance/sweepOrphans).
 *
 */
export async function checkCrossProcessLspBudget(
	testOverrides: {
		registry?: readonly InstanceEntry[];
		isPidAlive?: (pid: number) => boolean;
	} = {},
): Promise<void> {
	if (!isCrossProcessBudgetEnabled() || !isInstanceRegistryEnabled()) return;
	try {
		const registry = testOverrides.registry ?? (await readInstanceRegistry());
		if (registry.length === 0) return; // nothing to be over budget against
		const ceiling = getLspBudgetCeiling();
		const decision = decideLspBudget(
			registry,
			testOverrides.isPidAlive ?? realIsPidAlive,
			ceiling,
			getLspBudgetRssCeilingBytes(),
			Date.now(),
			ownPidNamespace(),
		);
		cachedDecision = decision;
		if (decision.overBudget) {
			logLatency({
				type: "phase",
				phase: "cross_process_lsp_budget_degraded",
				filePath: "",
				durationMs: 0,
				metadata: {
					totalLiveLspServers: decision.totalLiveLspServers,
					ceiling: decision.ceiling,
					totalRssBytes: decision.totalRssBytes,
					rssCeilingBytes: decision.rssCeilingBytes,
					rssPressure: decision.rssPressure,
					instanceCount: registry.length,
				},
			});
		}
	} catch {
		// Best-effort observability-driven check — never throw out of
		// session_start over this.
	}
}
