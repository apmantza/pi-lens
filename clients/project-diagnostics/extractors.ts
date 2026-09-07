import type {
	AvailabilityCause,
	AvailabilityOutcome,
} from "../dispatch/runners/utils/availability-policy.js";

/**
 * Provenance metadata for the heavyweight project analyzers surfaced in
 * `lens_diagnostics mode=full`.
 *
 * NOTE (#585 regression cleanup): this module USED to also own
 * `extractCachedProjectDiagnostics` — a CACHE-ONLY reader that adapted each
 * analyzer's cached result to `ProjectDiagnostic[]` via a parallel `EXTRACTORS`
 * registry. #585 replaced that reader in production with
 * `fetchFreshProjectDiagnostics` (./fresh-fetch.ts), which triggers-or-joins a
 * fresh run instead of settling for a possibly-hours-stale session_start
 * snapshot. The old reader lingered here wired only to a test — a SECOND,
 * dead surfacing path whose registry could (and did) silently diverge from
 * fresh-fetch's `ANALYZER_IDS`: opengrep was registered here but missing there,
 * so opengrep scanned+cached yet never reached the agent (the exact #585-class
 * regression this cleanup removes). The parallel registry is gone; fresh-fetch
 * is the single source of truth (#883).
 *
 * What survives is the honesty metadata (#533): given an analyzer id that
 * fresh-fetch reported `cold` (not applicable / unavailable this run),
 * `warmTriggerFor` names what WOULD warm it, so the rendered note is actionable
 * rather than a bare "not run".
 */

export interface FailedProjectAnalyzer {
	id: string;
	summary: string;
}

/**
 * #533: which trigger warms each analyzer, surfaced in the "cold" honesty note
 * so the note is actionable (names what to do), matching the #511/#514 house
 * shape. Keyed by the ids `fetchFreshProjectDiagnostics` (./fresh-fetch.ts)
 * reports in its `cold` list — keep in sync with that module's `ANALYZER_IDS`.
 */
const WARM_TRIGGER: Record<string, string> = {
	knip: "runs at session-start",
	jscpd: "runs at session-start",
	madge: "runs at session-start",
	gitleaks:
		"runs at session-start (config opt-in), or on any git repo via mode=full (#608)",
	govulncheck: "runs at session-start (Go projects only)",
	opengrep: "runs at session-start",
	trivy: "runs at session-start",
	"dead-code": "runs at session-start (Python projects only)",
	"test-runner":
		"fires per-edit at turn_end (only after a source file with a discoverable test companion is edited)",
};

function warmTriggerFor(analyzerId: string): string {
	return WARM_TRIGGER[analyzerId] ?? "runs at session-start";
}

/**
 * #1623: single formatter for a "not run" lane entry — reused by every
 * caller that renders `fetchFreshProjectDiagnostics`'s `cold` list (today,
 * `tools/lens-diagnostics.ts`'s mode=full) so the wording can't drift
 * per-caller. Prefers the SPECIFIC reason captured at the decision point
 * (`coldReasons`, ./fresh-fetch.ts) over the generic `warmTriggerFor` guess —
 * the latter only remains a fallback for a `cold` id this map doesn't cover.
 */
export function formatNotRunEntry(
	analyzerId: string,
	coldReasons: Record<string, string> | undefined,
): string {
	const reason = coldReasons?.[analyzerId];
	return reason
		? `${analyzerId} — not run (${reason})`
		: `${analyzerId} — not run (${warmTriggerFor(analyzerId)})`;
}

/**
 * #1623: human-readable age, for a lane whose result was served from cache
 * rather than executed fresh this call (see `cachedAgeMs`, ./fresh-fetch.ts).
 * Mirrors the granularity an agent actually needs to judge staleness — exact
 * seconds don't matter, "12m" vs "3h" does.
 */
export function formatCacheAge(ms: number): string {
	// #1623 fix-round F4: `CacheManager.readCache` accepts a missing/corrupt
	// `meta.timestamp` as a HIT (the timestamp only gates staleness, not
	// validity), so `Date.now() - new Date(badTimestamp).getTime()` reaches
	// here as NaN. Rendering "NaNh old" is a worse honesty gap than the one
	// this whole module exists to close — say the age is unknown instead of
	// fabricating one. Mirrors the sibling `Number.isFinite` guard in
	// `./cache.ts`'s `reconcileProjectDiagnosticsSnapshot` (fail-safe on an
	// unparseable timestamp rather than propagate NaN).
	if (!Number.isFinite(ms)) return "age unknown";
	if (ms < 0) return "0m";
	const totalMinutes = Math.round(ms / 60_000);
	if (totalMinutes < 1) return "under 1m";
	if (totalMinutes < 60) return `${totalMinutes}m`;
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`;
}

/**
 * #1623 fix-round F5: the full "<age> old" phrase for a cache-read lane.
 * Every render call site used to append the literal word " old" after
 * `formatCacheAge` itself, so a corrupt/missing timestamp's "age unknown"
 * came out as the ungrammatical "age unknown old" — the exact residual the
 * issue's tracking comment named. "Old" only makes sense once an age is
 * actually known, so this is the single place that decides whether to say
 * it, instead of every caller repeating (and occasionally forgetting) the
 * same guard.
 */
export function formatCacheAgeOld(ms: number): string {
	const age = formatCacheAge(ms);
	return Number.isFinite(ms) ? `${age} old` : age;
}

/**
 * #1623 fix-round F1: the shape every availability-verdict accessor added to
 * gitleaks/trivy/opengrep/govulncheck (`SecurityScanClient`), knip
 * (`KnipClient`), madge (`DependencyChecker`), and jscpd (`JscpdClient`)
 * returns — mirrors `AvailabilityVerdict` (dispatch/runners/utils/
 * runner-helpers.ts) minus the fields this caller doesn't need.
 */
export interface AvailabilityVerdictLike {
	outcome: AvailabilityOutcome | null;
	cause: AvailabilityCause | null;
	/** Epoch ms after which a transient verdict may be re-probed; 0 = latched. */
	retryAtMs: number;
}

/**
 * #1623 fix-round F1: a "cold" reason for an analyzer whose `ensureAvailable()`
 * returned false, built from the SAME `AvailabilityOutcome`/`AvailabilityCause`
 * taxonomy every dispatch-side unavailability message already uses
 * (`describeUnavailability`, availability-policy.ts) — not a re-guessed
 * "binary unavailable" for every failure shape.
 *
 * `ensureAvailable() === false` collapses at least three distinct causes: a
 * durable absence (`missing`), a transient probe under an active retry
 * cooldown (`transient`), and — for govulncheck specifically — a project-trust
 * install denial the latch never even records (`assertInstallAllowed` returns
 * before touching it, project-trust.ts). fresh-fetch.ts's govulncheck task
 * checks trust denial itself, via `projectTrustDenialReason()`, before
 * falling back to this function. Wording a cooldown as "unavailable" would
 * repeat, one layer up, exactly the dispatch-layer defect #1467 fixed.
 */
export function reasonFromAvailabilityVerdict(
	tool: string,
	verdict: AvailabilityVerdictLike | undefined,
): string {
	if (!verdict || verdict.outcome === null) return `${tool} binary unavailable`;
	const { outcome, cause } = verdict;
	if (outcome === "transient") {
		if (cause === "install-retry-exhausted") {
			return `${tool} install kept timing out and hit its retry ceiling this session (not reported missing)`;
		}
		const remainingMs = verdict.retryAtMs - Date.now();
		const remainingS = remainingMs > 0 ? Math.round(remainingMs / 1000) : 0;
		return `${tool} availability probe — retry cooldown (${remainingS}s), not a missing install`;
	}
	if (outcome === "non-installable") {
		return `${tool} unavailable on this host (non-installable)`;
	}
	return `${tool} binary unavailable`;
}
