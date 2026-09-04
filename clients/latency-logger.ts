import * as path from "node:path";
import { isTestMode } from "./env-utils.js";
import { getGlobalPiLensLogDir } from "./probe-home-state.js";
import { createNdjsonLogger } from "./ndjson-logger.js";
import { getMaxLogSizeMB } from "./log-cleanup.js";
import { normalizeLoggedPath } from "./path-utils.js";

const LATENCY_LOG_DIR = getGlobalPiLensLogDir();
const LATENCY_LOG_FILE = path.join(LATENCY_LOG_DIR, "latency.log");

const writer = createNdjsonLogger({
	filePath: LATENCY_LOG_FILE,
	maxBytes: getMaxLogSizeMB() * 1024 * 1024,
});

export interface LatencyEntry {
	type: "runner" | "tool_result" | "phase";
	/** ISO timestamp when this entry was written (= finish time for runners) */
	ts?: string;
	/** Process that wrote the entry; used to isolate current-session telemetry. */
	pid?: number;
	/** ISO timestamp when the runner/phase started — diff with ts = durationMs */
	startedAt?: string;
	toolName?: string;
	filePath: string;
	fullPath?: string;
	phase?: string;
	durationMs: number;
	totalDurationMs?: number;
	result?: string;
	runnerId?: string;
	status?: string;
	diagnosticCount?: number;
	semantic?: string;
	/** Per-diagnostic summary when a runner produces findings — aids root-cause analysis */
	diagnostics?: Array<{
		rule?: string;
		message: string;
		line?: number;
		semantic?: string;
	}>;
	/** For dispatch_complete: actual wall-clock time (groups run in parallel) */
	wallClockMs?: number;
	/** For dispatch_complete: sum of all individual runner durationMs */
	sumMs?: number;
	/** wallClockMs - sumMs ≥ 0 means parallelism saved this many ms */
	parallelGainMs?: number;
	metadata?: Record<string, unknown>;
}

/** Bound on the `recentPhases` ring below — keeps the attribution record small. */
export const RECENT_PHASE_CAP = 5;

/**
 * Most recent non-`loop_block` phases seen by `logLatency`, newest first, for
 * cheap block attribution (#1122 / #1123 item 1, widened #1723): the
 * event-loop-block probe fires at turn_end and cannot see *what* stalled the
 * loop, so it stamps the phases that ran as a starting point for root-causing
 * a genuine block. A single `lastPhase` pointer names only the phase that
 * finished right before the block — useless when the CPU hog itself never got
 * to log a completion (it was busy blocking the loop). Keeping a short,
 * bounded ring instead gives the block's neighborhood, not just one frame of
 * it, while staying O(1) per call and fixed-size in memory. Tracked before the
 * test-mode guard so it is deterministic and unit-testable.
 */
let recentPhases: Array<{ phase: string; ts: string }> = [];

/**
 * Phases excluded from `lastPhase` attribution alongside `loop_block`.
 * #1412 L3: `lsp_typescript_project_identity` is the classic-TS first-open
 * project-identity probe (tsserver-sync.ts) — a detached, best-effort
 * telemetry sample fired on every first didOpen, not genuine work. Letting it
 * win `lastPhase` would overwrite the real stall attribution for a
 * loop_block that happens to land right after a first open.
 * #1432 review: `advisory_provenance_decision`,
 * `authoritative_content_attachment_decision`, and
 * `agent_end_deferred_mutation_drain` are the same shape — zero-duration
 * decision telemetry, not genuine work — so they get the same exclusion.
 * `agent_end_deferred_mutation_requeue` (S2d gap 4's per-requeue record) and
 * `session_end_bus_rollup` (S2d gap 5's session-end rollup) are new
 * zero-duration siblings of the same shape, added alongside them.
 *
 * `lsp_aux_wait_outcome` (#1458) is DIFFERENT from every entry above: its
 * `durationMs` is a REAL bounded wait, not zero-duration decision telemetry.
 * WHICH wait depends on the row's `waitShape` (#1533), so read that field before
 * comparing two rows: `"aux_grace"` measures only the post-primary auxiliary
 * grace (up to a few seconds), while `"aggregate"` — the `clientScope: "all"`
 * producer, which arms no grace of its own — measures the whole diagnostics wait
 * from before the primaries settled. The `"aggregate"` number is therefore
 * systematically larger for the same auxiliary; it is not a regression. It is
 * still
 * excluded because it is a WAIT-OUTCOME RECORD written after the aux wait
 * already completed, not the stall itself — that wait ran inside the
 * `lsp_touch_file`/diagnostics phase surrounding it, so letting this summary
 * row win `lastPhase` would misattribute a `loop_block` to the record instead
 * of to whatever phase is actually stalled when the block fires.
 * #1453: `tool_set_mutation` records an active-tool-set rewrite (zero-duration
 * bookkeeping, and it fires during session_start where a real stall must stay
 * attributed to the work around it), so it is excluded for the same reason.
 * #1467: `availability_decision` records a tool-probe verdict. Its `durationMs`
 * is the child's own probe time (often zero for a fast path or a cached
 * decision) and the record is bookkeeping ABOUT a probe, not host work — a
 * loop_block landing next to one must stay attributed to whatever really
 * stalled the loop, which is frequently the very thing that expired the probe.
 *
 * #1461 slice 1: `finding_dead_path_drop` is the same shape — the record a
 * delivery seam writes when it drops findings whose cited path no longer
 * exists. #1622 adds `finding_stale_line_demote`, its sibling for findings
 * whose cited file was edited after the scan.
 *
 * #1459: the three scanner-coverage records are summary rows written from inside
 * `lsp_touch_file`, and two of them carry ANOTHER write's age as `durationMs`
 * (`lsp_notify_resync_deferred`, `lsp_notify_write_late_landed`) rather than
 * their own work. `lsp_scanner_coverage_gap` reports the touch's elapsed time for
 * joinability. Letting any of them win `lastPhase` would attribute a `loop_block`
 * to the record instead of to the touch that is actually stalled.
 *
 * #1996: `cache_usage_summary` is a zero-duration session rollup over earlier
 * usage records. It reports no new work and therefore cannot own last-phase
 * stall attribution.
 *
 * #2249: `concurrent_session_bind_rollup` is the same shape as
 * `session_end_bus_rollup`/`path_attribution_verified_rollup` above — a
 * zero-duration session-end summary of records already logged individually,
 * not new work of its own.
 *
 * #2044: `test_runner_failed_target_state` is a zero-duration decision after a
 * bounded filesystem probe. The surrounding turn-end test-selection phase owns
 * any real work, so this row must not replace it in stall attribution.
 */
const LAST_PHASE_EXCLUDED = new Set([
	"loop_block",
	"lsp_typescript_project_identity",
	"advisory_provenance_decision",
	"authoritative_content_attachment_decision",
	"agent_end_deferred_mutation_drain",
	"agent_end_deferred_mutation_requeue",
	"session_end_bus_rollup",
	"cache_usage_summary",
	"test_runner_failed_target_state",
	"lsp_aux_wait_outcome",
	"tool_set_mutation",
	"availability_decision",
	"finding_dead_path_drop",
	"finding_stale_line_demote",
	"lsp_scanner_coverage_gap",
	"lsp_notify_resync_deferred",
	"lsp_notify_write_late_landed",
	"lsp_notify_stall_cpu_busy",
	"degradation_ledger",
	"path_attribution_verified_rollup",
	"concurrent_session_bind_rollup",
	"auxiliary_readiness",
]);

/**
 * The last non-`loop_block` phase logged, or undefined if none yet. Carries its
 * own `ts` so a consumer can gauge staleness: it is intentionally NOT cleared at
 * turn/window boundaries, so on a turn that logged no phase of its own it may
 * point at a prior turn's phase — compare `ts` against the block time before
 * trusting it as the cause (it is a breadcrumb, not proof).
 */
export function getLastLoggedPhase():
	| { phase: string; ts: string }
	| undefined {
	return recentPhases[0];
}

/**
 * The last `limit` non-`loop_block` phases logged, newest first (#1723).
 * Bounded to `RECENT_PHASE_CAP` regardless of `limit` — a caller cannot
 * request an unbounded ring. Same staleness caveat as `getLastLoggedPhase`:
 * these are breadcrumbs from whatever ran most recently, not proof of cause.
 */
export function getRecentLoggedPhases(
	limit = RECENT_PHASE_CAP,
): Array<{ phase: string; ts: string }> {
	return recentPhases.slice(0, Math.min(limit, RECENT_PHASE_CAP));
}

/**
 * Test-only: the ring's actual storage length, bypassing the read-side
 * `Math.min` clamp in `getRecentLoggedPhases` entirely. Needed because that
 * clamp and the write-side `.slice(0, RECENT_PHASE_CAP)` in `logLatency` are
 * a compensating pair — as long as ONE of them is intact, the other's
 * deletion is invisible to any test that only observes
 * `getRecentLoggedPhases()` output length. This pins the write-side guard
 * specifically: if its `.slice` is deleted, storage grows past the cap and
 * this returns the unclamped size regardless of what the read side does.
 */
export function _recentPhasesStorageLengthForTest(): number {
	return recentPhases.length;
}

/**
 * Test-only: seed the ring directly, bypassing the write-side cap in
 * `logLatency`. Lets a test put the ring in a state the normal write path can
 * never produce (more than `RECENT_PHASE_CAP` entries), so the read-side
 * clamp in `getRecentLoggedPhases` can be pinned independently of the
 * write-side guard (see `_recentPhasesStorageLengthForTest` above for why
 * that independence matters).
 */
export function _setRecentPhasesForTest(
	entries: Array<{ phase: string; ts: string }>,
): void {
	recentPhases = entries;
}

/** A phase's start marker, and the identity key its own `phaseFinished` call needs. */
export interface PhaseToken {
	phase: string;
	startedAt: string;
}

interface ClosedBracket {
	phase: string;
	startedAt: string;
	closedAt: string;
}

/** Bound on the closed-bracket ring below — same size discipline as `recentPhases`. */
export const CLOSED_BRACKET_CAP = RECENT_PHASE_CAP;

/**
 * Phases currently executing, keyed by their own start token (#1723 review
 * round: this replaces an earlier single-slot design that broke two ways.
 * `dispatchForFile` runs its runner groups in PARALLEL (`Promise.all`,
 * dispatcher.ts), so overlap is the NORMAL case, not an edge case:
 *   F1 — a single slot holds only the LAST starter. A cheap idle runner
 *        starting after a CPU hog wins the slot outright; a block gets
 *        attributed to the innocent idle runner while the hog stays
 *        anonymous.
 *   F2 — the inverse: a quick sibling that starts SECOND but FINISHES FIRST
 *        clears the slot the moment its own `finally` runs, wiping out the
 *        still-running long phase's attribution — the identity-token check
 *        only guarded the OTHER stale-clear direction (an EARLIER phase's
 *        late finish clobbering a LATER phase), not this one.
 * A `Map` keyed by the token itself (not by phase name — two calls can share
 * a name) fixes both: every bracket owns its own entry regardless of what
 * else is live, and `phaseFinished` only ever removes ITS OWN entry. `Map`
 * iteration order is insertion order, so the oldest surviving entry — read by
 * `getCurrentPhase` — is the longest-running phase still open: the one most
 * likely to own a long block.
 */
const liveBrackets = new Map<PhaseToken, true>();

/**
 * Recently CLOSED brackets, newest first, bounded to `CLOSED_BRACKET_CAP`
 * (#1723 review round, F3 — the decisive finding). `phaseFinished` runs
 * inside a `finally`, which resumes as a MICROTASK, while the host schedules
 * `turn_end` as a MACROTASK — and microtasks always fully drain before the
 * next macrotask runs. For the motivating SYNCHRONOUS block, this means the
 * offending phase has ALREADY closed (its `finally` already ran) by the time
 * `turn_end` gets to sample: `liveBrackets` alone reads EMPTY for exactly the
 * case this feature exists to catch. Keeping a short history of recently
 * closed brackets lets `getPhaseForWindow` below check whether a block's time
 * window overlaps a bracket that already closed, not only ones still open.
 */
let closedBrackets: ClosedBracket[] = [];

/**
 * Mark a phase as started. Returns a token the caller must pass back to
 * `phaseFinished` — the token itself is the map key, so it identifies this
 * bracket uniquely even against a same-named sibling running concurrently.
 * Cost per call: one object allocation, one `Date.now()`/`toISOString()`
 * call, and one `Map.set` (O(1), no scan of any collection) — negligible
 * next to the runner/phase work it brackets. Measured against this PR's own
 * call site (dispatcher.ts's per-runner `runRunner`): a native ast-grep or
 * tree-sitter scan, or a subprocess spawn, is orders of magnitude more
 * expensive than one map insert.
 */
export function phaseStarted(phase: string): PhaseToken {
	const token: PhaseToken = { phase, startedAt: new Date().toISOString() };
	liveBrackets.set(token, true);
	return token;
}

/**
 * Close a bracket: removes it from `liveBrackets` (one `Map.delete`, O(1))
 * and records it on the closed-bracket ring, bounded to `CLOSED_BRACKET_CAP`
 * with the oldest entry dropped first — see the `closedBrackets` doc comment
 * above for why a closed history is load-bearing, not just nice-to-have
 * (#1723 review F3). `Map.delete` reports whether it actually removed
 * anything, so a stale or duplicate `phaseFinished` call (the token isn't
 * live — already closed, or never was) is a no-op and can't push a phantom
 * entry onto the closed ring.
 *
 * Callers MUST pair this with `phaseStarted` via try/finally — an exception
 * or an abandoned promise that skips this call leaves a phantom entry in
 * `liveBrackets` forever, silently misattributing every LATER loop_block to
 * stale work (catalog: a bracket that must clear on finish, never left to a
 * process-lifetime latch). `resetCurrentPhaseForSession` is the session-
 * boundary backstop for the case where even try/finally doesn't run (a torn-
 * down activation whose in-flight phase never gets a chance to unwind).
 *
 * #1723 review round 3 (N3) — the honest residual: a bracket leaked this way
 * (e.g. a torn-down concurrent secondary, see `resetCurrentPhaseForSession`)
 * has no age or size cap of its own and sits in `liveBrackets` until the next
 * FULL session start clears it. It does NOT go unnoticed in the meantime: a
 * leaked bracket is old by construction, so its `elapsedMs` is large, and
 * `getPhaseForWindow`'s tie-break below prefers the SMALLER-`elapsedMs`
 * candidate on an overlap tie — a genuine culprit whose own lifetime roughly
 * matches the block window beats a stale bracket that merely contains it.
 * The leak is real; it is demoted, not silently trusted.
 */
export function phaseFinished(token: PhaseToken): void {
	if (!liveBrackets.delete(token)) return;
	closedBrackets = [
		{
			phase: token.phase,
			startedAt: token.startedAt,
			closedAt: new Date().toISOString(),
		},
		...closedBrackets,
	].slice(0, CLOSED_BRACKET_CAP);
}

/**
 * The OLDEST phase still executing, if any — the longest-running open
 * bracket. #1723 review round 3: this has NO production consumer — `turn_end`
 * (index.ts) reads `getPhaseForWindow` below instead, since this function
 * alone cannot see a phase that already closed, which is exactly what
 * happens for a synchronous block by the time anything samples it (F3).
 * Kept deliberately as a TEST SEAM: several regression tests assert "which
 * phase is currently open" directly, without constructing a window, which is
 * simpler to read and still exercises the same `liveBrackets` map the
 * production path shares. Remove if it stops earning its keep.
 */
export function getCurrentPhase(): PhaseToken | undefined {
	const oldest = liveBrackets.keys().next();
	return oldest.done ? undefined : oldest.value;
}

export interface PhaseWindowAttribution {
	phase: string;
	startedAt: string;
	/** True if this bracket was still open (live) at read time; false if it had already closed. */
	stillRunning: boolean;
	/** The bracket's full lifetime so far: (closedAt ?? now) − startedAt. */
	elapsedMs: number;
}

/**
 * A candidate bracket is ignored outright if its OWN lifetime (`elapsedMs`)
 * is under this fraction of the window's length (#1723 review round 3, N4).
 * Overlap alone is not enough: the bounded closed-bracket ring can churn a
 * real culprit out (busy siblings filling `CLOSED_BRACKET_CAP`), leaving only
 * a 1ms bracket that happens to have SOME positive overlap with an 18-second
 * window — reporting it would be a CONFIDENT WRONG ANSWER, worse than no
 * answer. 5%: a genuine cause's own duration should be a meaningful fraction
 * of the block it explains, not a sliver of it. Below that, absent-but-honest
 * (return `undefined`) beats present-but-wrong.
 */
const MIN_PLAUSIBLE_ELAPSED_FRACTION = 0.05;

/**
 * Attribute a block's time window `[windowStartMs, windowEndMs]` to whichever
 * bracket — live OR recently closed — best explains it (#1723 review, F3:
 * the decisive finding). A live bracket's end, for overlap purposes, is
 * "now" (it is still running); a closed bracket's end is its own `closedAt`.
 *
 * Ranked by CONTAINMENT FRACTION (`overlapMs / max(elapsedMs, windowLengthMs)`),
 * not raw overlap (#1723 review round 4, N1 — after round 3's elapsedMs
 * tie-break turned out not to engage in practice). Raw overlap is capped at
 * the window's own length, and a LIVE bracket's end is always `nowMs` — the
 * window's own end — so a long-lived, still-running INNOCENT bracket always
 * scores the maximum possible raw overlap. A genuine CLOSED culprit can only
 * match that by closing at the exact sample instant, which `turn_end` never
 * does: it samples milliseconds AFTER the culprit's `finally` runs, so the
 * culprit's raw overlap is always slightly short of the window's full length
 * — round 3's "exact tie" tie-break never engaged, and the innocent bracket
 * won every time on raw overlap alone. Fraction fixes this structurally: a
 * culprit whose own lifetime roughly IS the window scores close to 1.0
 * regardless of a few milliseconds of sampling lag, while a long-lived
 * innocent bracket that merely CONTAINS the window scores meaningfully
 * lower (its `elapsedMs` denominator is bigger).
 *
 * The denominator is `max(elapsedMs, windowLengthMs)`, not bare `elapsedMs`
 * (#1723 review round 5, R1 — the fraction metric's own blind spot). A bare
 * `elapsedMs` denominator meant a SHORT bracket wholly INSIDE the window
 * scored a perfect, undeserved 1.0 (`overlapMs === elapsedMs` whenever a
 * bracket never spills past either window edge) and beat a real culprit
 * whose bracket spans slightly MORE than the window — e.g. a 1s innocent
 * bracket fully inside an 18.27s window outscored a genuine 19.27s-lifetime
 * culprit that explains the whole window and then some. Using the WINDOW's
 * length as a floor on the denominator caps the achievable fraction at
 * `overlapMs / windowLengthMs` for any bracket no bigger than the window
 * itself, so a small bracket can no longer out-rank a big one purely by
 * being small; a bracket LARGER than the window still divides by its own
 * `elapsedMs`, so the round-4 sampling-lag fix (a big bracket's fraction
 * tracks how much of ITS OWN lifetime overlaps) is unaffected. Free
 * improvement noted while verifying this: it also further demotes an N3
 * leaked bracket when something is competing against it (its `elapsedMs`
 * denominator, already large, only grows).
 *
 * The round-3 elapsedMs comparison is kept as the tie-break for a genuine
 * FRACTION tie (two candidates scoring identically) — still reachable under
 * this metric: two brackets that both partially overlap the window by the
 * SAME amount (`overlapMs` equal) but have different lifetimes both share the
 * `windowLengthMs` denominator (since both are ≤ the window), so their
 * fractions tie while their `elapsedMs` differs. See
 * `tests/clients/latency-logger.test.ts` for a constructed example.
 *
 * The tie-break compares within an EPSILON band (`FRACTION_TIE_EPSILON` =
 * `1e-4`), not exact `===` equality (#1723 review round 6, R3). Co-starting
 * — two brackets opening with the identical `startedAt` millisecond string
 * — is the NORMAL path, not an edge case: `dispatchForFile` launches its
 * runner groups via `Promise.all`, and a runner's `when` precondition awaits
 * only microtasks, so this happens routinely. Closed form for a culprit
 * that closes `lag` ms before the sample versus a co-started bracket that
 * stays live: the culprit scores `1 - lag/W`, the co-started bracket scores
 * `1/(1 + lag/W)` — the co-started bracket wins by `(lag/W)^2`, which at a
 * real `W` = 18 270ms and `lag` = 5ms is ~7e-8 — far below millisecond
 * timestamp resolution, so an EXACT tie never actually engages and the
 * "winner" becomes floating-point rounding noise instead. `1e-4` is well
 * above any realistic `(lag/W)^2` term (a co-started pair collapses into it)
 * and well below the gap between two genuinely different candidates in every
 * test/probe this module has been checked against.
 *
 * The tie-break is a TWO-PASS selection over every candidate, not a
 * single-pass streaming comparison (#1723 review round 7, S1 — a blocker).
 * A single running `bestFraction`, reassigned on every accepted candidate
 * INCLUDING a tie-win, chains: "near" is not transitive, so three candidates
 * at fractions 0.600000 / 0.600080 / 0.600160 (adjacent gaps inside the
 * epsilon band, but the OUTER gap between the first and third outside it)
 * let the running best walk across the whole band one hop at a time — the
 * final answer then depends on SCAN ORDER, reachable at roughly 1.5ms of
 * overlap difference in an 18s window, which is routine under `Promise.all`
 * co-start with three or more candidates. Reseeding `bestFraction` via
 * `Math.max(...)` alone does not fix this — the defect is the chaining
 * itself, not the seed value. The fix: pass 1 finds the maximum fraction
 * across ALL candidates (a plain reduction, immune to order); pass 2 keeps
 * only the candidates within the epsilon band OF THAT MAXIMUM — not of each
 * other, and not of a running value that could itself have drifted — and
 * picks the smallest `elapsedMs` among them. Order-independent by
 * construction: the three-candidate example above always excludes the
 * first candidate (its gap from the true maximum exceeds the epsilon, even
 * though its gap from its immediate neighbor does not), regardless of scan
 * order.
 *
 * Composes with N4's plausibility floor below in the natural order: the
 * floor FILTERS candidates (an implausibly short bracket is never even a
 * candidate for fraction ranking, and never enters the `candidates` array at
 * all); fraction then RANKS the survivors via the two passes above. A
 * bracket that clears the floor always has a well-defined fraction in (0, 1].
 *
 * A candidate needs a STRICTLY POSITIVE overlap: `if (fraction <= 0) return;`
 * enforces that explicitly, before the candidate is even collected — pass 1's
 * `maxFraction` is seeded at 0 and only ever updated by a STRICTLY GREATER
 * value, so without this guard a lone zero-or-negative-fraction candidate
 * would sit "within the epsilon band of the seeded 0" in pass 2 and be
 * wrongly attributed. #1723 review N2 deleted an EARLIER version of this
 * guard as dead code under the round-2 single-pass design, where a strict
 * `>` comparison against a 0-seeded running best already excluded it with no
 * help needed — that reasoning does not carry over to the two-pass shape,
 * where pass 2's job is specifically to find candidates NEAR a seed value.
 *
 * This is the seam that makes the SYNCHRONOUS motivating case attributable at
 * all: the offending phase's `finally` (a microtask) always runs before
 * `turn_end` (a macrotask) samples, so by the time this is called the
 * bracket has typically already moved from `liveBrackets` to
 * `closedBrackets` — checking only the live set reads empty for exactly that
 * case, which is why `getCurrentPhase` alone was not enough.
 *
 * KNOWN RESIDUAL (#1723 review round 4, stated not fixed): a leaked bracket
 * (see `phaseFinished`'s doc comment on N3) with NO competing candidate still
 * wins any window it fully contains, however many times over its own
 * lifetime exceeds the window — fraction ranking only demotes a leak when
 * something else is competing for the same window. A ceiling on elapsedMs
 * relative to the window length (e.g. reject a candidate whose lifetime is
 * some large multiple of the window) would close this, at the cost of a
 * second magic number; left open pending a concrete false-positive to size
 * it against.
 *
 * Caveat for an automated consumer (e.g. #1549's loop_block ↔
 * lsp_diagnostics_timeout correlation): the window's own end is `now` at
 * SAMPLE time, which assumes the block ended right when `turn_end` read
 * `getEventLoopStats()` — a reasonable approximation, not a measured fact.
 * `startedAt`/`elapsedMs`/`stillRunning` on the returned attribution let a
 * human reader judge that assumption per-record; an automated correlation
 * should account for the same slack rather than treating the window edges as
 * exact.
 */
/**
 * #1723 review round 6, R3 / round 7, S1: how close two fractions must be to
 * count as the SAME answer rather than a genuinely different one. See
 * `getPhaseForWindow`'s doc comment for the closed-form derivation (a
 * co-started bracket's fraction gap from the true culprit is order
 * `(lag/W)^2`, ~7e-8 at production scale) and why a single-pass streaming
 * comparison against this band is NOT enough on its own (S1, below).
 */
const FRACTION_TIE_EPSILON = 1e-4;

interface FractionCandidate {
	phase: string;
	startedAt: string;
	stillRunning: boolean;
	elapsedMs: number;
	fraction: number;
}

export function getPhaseForWindow(
	windowStartMs: number,
	windowEndMs: number,
): PhaseWindowAttribution | undefined {
	const nowMs = Date.now();
	const windowLengthMs = windowEndMs - windowStartMs;
	const minPlausibleElapsedMs = windowLengthMs * MIN_PLAUSIBLE_ELAPSED_FRACTION;
	const candidates: FractionCandidate[] = [];

	const consider = (
		phase: string,
		startedAt: string,
		endMs: number,
		stillRunning: boolean,
	): void => {
		const startMs = Date.parse(startedAt);
		const elapsedMs = endMs - startMs;
		if (elapsedMs < minPlausibleElapsedMs) return; // N4: implausibly short to be the cause
		const overlapMs =
			Math.min(endMs, windowEndMs) - Math.max(startMs, windowStartMs);
		// #1723 review round 5, R1: divide by max(elapsedMs, windowLengthMs), not
		// elapsedMs alone — see the function doc comment for why a bare
		// elapsedMs denominator let a short bracket wholly INSIDE the window
		// score a perfect, undeserved 1.0.
		const fraction = overlapMs / Math.max(elapsedMs, windowLengthMs);
		if (fraction <= 0) return; // no meaningful overlap — never a candidate
		candidates.push({ phase, startedAt, stillRunning, elapsedMs, fraction });
	};

	for (const token of liveBrackets.keys()) {
		consider(token.phase, token.startedAt, nowMs, true);
	}
	for (const closed of closedBrackets) {
		consider(
			closed.phase,
			closed.startedAt,
			Date.parse(closed.closedAt),
			false,
		);
	}
	if (candidates.length === 0) return undefined;

	// #1723 review round 7, S1 (blocker): a single-pass streaming comparison
	// against `FRACTION_TIE_EPSILON` (round 6's shape) CHAINS — each accepted
	// candidate becomes the new `bestFraction`, including a tie-win, and
	// "near" is not transitive. A chain of near-ties whose adjacent gaps sit
	// inside the epsilon band but whose OUTER gap does not (e.g. three
	// candidates at fractions 0.600000 / 0.600080 / 0.600160, an 18s window)
	// lets the running "best" walk across the whole band one hop at a time,
	// so the final answer depends on SCAN ORDER — reachable at roughly 1.5ms
	// of overlap difference in an 18s window, routine under `Promise.all`
	// co-start. `bestFraction = Math.max(...)` alone does NOT fix this: the
	// bug is the CHAINING, not the seed value.
	//
	// Fixed with two independent passes instead, order-independent by
	// construction:
	//   Pass 1 finds the MAXIMUM fraction across every candidate — a plain
	//     reduction, immune to scan order.
	//   Pass 2 keeps only the candidates within `FRACTION_TIE_EPSILON` OF
	//     THAT MAXIMUM (not of each other, and not of a running "best" that
	//     could itself have already drifted) and picks the smallest
	//     `elapsedMs` among THEM. In the three-candidate example above, only
	//     the two candidates within the band of the true maximum (0.600160)
	//     compete; the third, whose gap from the maximum exceeds the epsilon
	//     even though its gap from its IMMEDIATE neighbor does not, is
	//     correctly excluded regardless of which order the three were
	//     scanned in.
	let maxFraction = 0;
	for (const candidate of candidates) {
		if (candidate.fraction > maxFraction) maxFraction = candidate.fraction;
	}
	let best: FractionCandidate | undefined;
	for (const candidate of candidates) {
		if (Math.abs(candidate.fraction - maxFraction) > FRACTION_TIE_EPSILON)
			continue;
		if (best === undefined || candidate.elapsedMs < best.elapsedMs)
			best = candidate;
	}
	if (best === undefined) return undefined;
	return {
		phase: best.phase,
		startedAt: best.startedAt,
		stillRunning: best.stillRunning,
		elapsedMs: best.elapsedMs,
	};
}

/**
 * Test-only: the closed-bracket ring's actual storage length, mirroring
 * `_recentPhasesStorageLengthForTest` above — pins that `phaseFinished`'s
 * `.slice(0, CLOSED_BRACKET_CAP)` guard is intact independent of any
 * read-side behavior (#1723 review: "ring unbounded" mutation).
 */
export function _closedBracketsStorageLengthForTest(): number {
	return closedBrackets.length;
}

/**
 * Session-boundary backstop: unconditionally clears BOTH the live-bracket map
 * and the closed-bracket ring. `phaseFinished` is the normal clear path
 * (paired via try/finally at each call site), but this module's state is
 * process-lifetime, not session-scoped, so a phase abandoned mid-flight by a
 * torn-down activation (an abort that skips straight past the `finally`, a
 * session replaced mid-scan) would otherwise leave a phantom bracket live
 * forever — misattributing every loop_block in every LATER session to that
 * one stale phase.
 *
 * #1723 review F4 — placement is deliberate, and DIFFERENT from
 * `warmDispatchAtSessionStart()`: call this only once `session_start` has
 * confirmed it is running a FULL session start (`decideSessionStart(...)
 * .runFullSessionStart`), i.e. from BEHIND the #473 concurrent-secondary
 * gate, not before it. The reason is the opposite of what an unconditional,
 * "re-arm on every session_start" placement would give: this module's state
 * is process-shared across every concurrently-live activation in the same
 * process, exactly like the LSP fleet / runtime generation #473 already
 * protects — a concurrent secondary's `session_start` firing while the
 * PARENT activation has genuinely in-flight brackets must not wipe the
 * parent's live attribution out from under it. Only a real sequential
 * session replacement (new/resume/fork/reload confirmed by
 * `decideSessionStart`) may safely assume no other activation still owns
 * live brackets in this process. A concurrent secondary's OWN torn-down
 * brackets are still covered: each caller's `phaseFinished` runs in its own
 * try/finally, and if that activation is torn down hard enough to skip even
 * that, the accepted cost is a stale bracket that the NEXT full session start
 * clears — not a wrong clear of a sibling that is still working.
 */
export function resetCurrentPhaseForSession(): void {
	liveBrackets.clear();
	closedBrackets = [];
}

/**
 * Phases already written ONCE for the current session (#2526).
 *
 * Session-scoped telemetry bookkeeping, which is this module's own domain —
 * the same reason `liveBrackets` and `recentPhases` live here rather than in
 * each producer. A producer that is called many times per session but whose
 * record is a SESSION fact (`config_resolved`: `loadLSPConfig` runs at session
 * start, per served root, and on the first edit, all resolving the same
 * config) asks here instead of keeping its own latch, so the "one row per
 * session" a log reader counts against is a property of the logger rather than
 * a convention each producer re-implements.
 */
const oncePerSessionPhases = new Set<string>();

/**
 * The identity every once-per-session record of THIS session is stamped with
 * (#2526 review round 2, F2).
 *
 * A line-oriented log reader cannot join two files by adjacency: sessionstart.
 * log's start lines and latency.log's phase rows interleave differently, rotate
 * independently, and (for the warm MCP server) can span days. The first round
 * therefore SUBTRACTED row counts from start-line counts, which silently
 * assumed the two counted the same population — they do not, and the
 * mismatch both masked total silence and manufactured a permanent false
 * deficit. An id makes the join explicit: `handleSessionStart` publishes it
 * beside its expectation, the record carries it, and the analyzer matches.
 *
 * It is minted HERE, beside the claim set it identifies, so "which session is
 * this record from" and "has this session already recorded" can never answer
 * from different sessions.
 *
 * Minted at module load too, not only on re-arm: the warm MCP server resolves
 * config through `ensureReady` without any session boundary of its own, and a
 * record with no id at all would be unjoinable rather than merely unmatched.
 */
let sessionRecordSeq = 0;

function mintSessionRecordId(): string {
	sessionRecordSeq += 1;
	return `${process.pid.toString(36)}-${Date.now().toString(36)}-${sessionRecordSeq.toString(36)}`;
}

let sessionRecordId = mintSessionRecordId();

/**
 * The current session's record identity — an opaque, process-local token.
 *
 * Deliberately NOT the host's session id: that is user-facing conversation
 * identity pi-lens does not otherwise write to disk, and the join only needs
 * "the same session", not "which conversation".
 */
export function currentSessionRecordId(): string {
	return sessionRecordId;
}

/**
 * The claim key. A phase is claimed per SCOPE (#2526 review round 2, F3):
 * `config_resolved` is a fact about a (session, project root) pair, and the
 * warm MCP server serves N roots from one process — keying on the phase name
 * alone recorded the first root's documents and silently dropped every other
 * root's, so a legacy config in project B could never surface its smell.
 *
 * `scope` is REQUIRED (#2526 review round 3, S3 — narrowed from optional):
 * the one production caller always passes one, and an unscoped claim is the
 * exact shape F3 found unsafe — a phase-only key recording the first caller
 * and silently dropping every later one under a different scope. A future
 * producer with no natural scope can pass a constant string; that is still an
 * explicit choice, not a silently-defaulted one.
 */
function claimKey(phase: string, scope: string): string {
	return `${phase}\0${scope}`;
}

/**
 * Claim the session's one record for `phase` within `scope`.
 *
 * Returns true exactly once per session and scope; every later call for the
 * same pair returns false until {@link resetOncePerSessionPhases} re-arms it.
 * Callers should claim BEFORE building the payload, so a claim that loses the
 * race costs nothing.
 */
export function claimPhaseOncePerSession(
	phase: string,
	scope: string,
): boolean {
	const key = claimKey(phase, scope);
	if (oncePerSessionPhases.has(key)) return false;
	oncePerSessionPhases.add(key);
	return true;
}

/**
 * Release every scope's claim for ONE phase, without touching the others
 * (#2526 review round 2, S1).
 *
 * A producer's own `resetForTests` needs its own phase re-armed, not a blanket
 * clear of a shared session-scoped structure: the blanket call reached into
 * claims other producers own and, worse, re-minted the session identity as a
 * side effect of an unrelated module's reset.
 */
export function releaseOncePerSessionPhase(phase: string): void {
	const prefix = `${phase}\0`;
	for (const key of oncePerSessionPhases) {
		if (key.startsWith(prefix)) oncePerSessionPhases.delete(key);
	}
}

/**
 * Re-arm every once-per-session phase claim for a new session, and mint the
 * new session's record identity.
 *
 * PLACEMENT (#2526 review round 2, F1): this is called from index.ts's
 * `session_start` closure, from BEHIND the #473 concurrent-secondary gate,
 * beside `resetCurrentPhaseForSession` — and NOT from inside
 * `handleSessionStart`. index.ts resolves this session's config in
 * `ensureLSPConfigInitialized` BEFORE it calls the handler, so a re-arm inside
 * the handler fires between the session's own two resolutions: the ensure
 * writes a row, the handler wipes the claim, and the deferred `loadLSPConfig`
 * writes a second row for the same session. The first session of a process got
 * two rows and every later one (whose ensure the process-lifetime
 * `_lspConfigInitializedCwds` memo short-circuits) got one, which is
 * unrecoverable for any per-session count.
 *
 * A latch that is never re-armed silences its record for the rest of the
 * PROCESS (AGENTS.md catalog shape 17), which for a positive-observability
 * record is the exact silence it exists to end — so the re-arm must exist; it
 * just has to sit ahead of the session's first resolution rather than in the
 * middle of them.
 *
 * The warm MCP server (`clients/mcp/session.ts` calls `handleSessionStart`
 * directly, never through index.ts) therefore keeps ONE identity for the life
 * of the process. That is the honest answer for it: a warm server has no
 * session boundary, its "session" is the process, and F3's per-root scoping is
 * what gives it one record per served root.
 */
export function resetOncePerSessionPhases(): void {
	oncePerSessionPhases.clear();
	sessionRecordId = mintSessionRecordId();
}

export function logLatency(entry: LatencyEntry): void {
	const ts = new Date().toISOString();
	if (
		entry.type === "phase" &&
		entry.phase &&
		!LAST_PHASE_EXCLUDED.has(entry.phase)
	) {
		recentPhases = [{ phase: entry.phase, ts }, ...recentPhases].slice(
			0,
			RECENT_PHASE_CAP,
		);
	}
	if (isTestMode()) {
		return;
	}
	// #2219 (the #2141 class): `filePath` mixes raw `path.resolve()`/`cwd`
	// values (module-report.ts) with already-normalized ones
	// (dispatcher.ts-derived `ctx.filePath`) AND non-path labels ("<pi-lens>",
	// a tool name, a shell command) that several call sites deliberately use
	// as a coarse identity — see bounded-telemetry.ts's comment on this field.
	// `normalizeLoggedPath` normalizes only values that are already
	// fully-qualified paths, leaving every label/command untouched.
	writer.log({
		...entry,
		ts,
		pid: process.pid,
		filePath: normalizeLoggedPath(entry.filePath),
	});
}

export function getLatencyLogPath(): string {
	return LATENCY_LOG_FILE;
}

/** Resolve once all enqueued latency writes are on disk (tests/shutdown). */
export function flushLatencyLog(): Promise<void> {
	return writer.flush();
}

export function clearLatencyLog(): void {
	// Enqueue the truncate in the same serialized queue so a clear cannot race a
	// pending drain. Await flushLatencyLog() if you need the file empty on disk.
	writer.truncate();
}
