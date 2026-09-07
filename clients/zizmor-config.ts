import * as path from "node:path";
import { type SpawnResult, safeSpawnAsync } from "./safe-spawn.js";
import { findLocalToolConfig } from "./path-utils.js";
import { incrementDegradationCount } from "./degradation-ledger.js";
import {
	type AvailabilityCause,
	type AvailabilityOutcome,
	type AvailabilityLatch,
	classifyProbeFailure,
	createAvailabilityLatch,
	logAvailabilityDecision,
	startHostStallSampler,
} from "./dispatch/runners/utils/availability-policy.js";

/**
 * zizmor (GitHub Actions workflow security scanner) configuration discovery and
 * online-mode token resolution. zizmor runs as a cross-cutting auxiliary LSP
 * (#272); this module owns the two repo/environment-derived inputs the server
 * spawn and the auxiliary profile need.
 */

// zizmor discovers its config (curated ignores + per-rule config) as
// `zizmor.yml`/`.yaml` at the repo root or under `.github/` — see zizmor's
// configuration docs (discovery order: .github/zizmor.y[a]ml, then root). The
// presence of one is the repo's deliberate opt-in: it carries the author's
// chosen severities/ignores, so we let zizmor findings BLOCK in that workspace
// (advisory-only otherwise, like Opengrep's local-rules gate).
const LOCAL_ZIZMOR_CONFIG_NAMES = [
	path.join(".github", "zizmor.yml"),
	path.join(".github", "zizmor.yaml"),
	"zizmor.yml",
	"zizmor.yaml",
] as const;

// Deliberately UNCEILINGED at $HOME (refs #2472 review round 3, F1): a
// user-level `~/zizmor.yml` (or `~/.github/zizmor.yml`) is a legitimate
// global config, not an escaped-workspace accident.
export function findLocalZizmorConfig(startDir: string): string | undefined {
	return findLocalToolConfig(startDir, LOCAL_ZIZMOR_CONFIG_NAMES);
}

// zizmor's own input collection (see `zizmor --collect`) only ever audits three
// path shapes: workflow YAML under `.github/workflows/`, a composite/reusable
// action definition (`action.yml`/`action.yaml`, anywhere in the repo — GitHub
// resolves these relative to whichever directory references them, not just the
// root), and the repo's Dependabot config (`.github/dependabot.yml`/`.yaml`,
// GitHub only ever reads this one location). Every other YAML file is a
// guaranteed no-op: measured directly against a real `zizmor --lsp` process
// (#<issue>), a non-matching file gets NO `publishDiagnostics` at all — not
// even an empty one — so `waitForDiagnostics` burns its full aggregateWaitMs
// budget (2000ms, bounded by the per-edit caller cap) on every such edit for
// zero signal (#636). This predicate is the LSP-candidacy gate (server.ts's
// `ZizmorServer.pathFilter`) that keeps zizmor out of the candidate list for
// files it can never report on, mirroring its own collection rules exactly —
// under-matching would silently drop real workflow/action coverage,
// over-matching would leave the wasted-wait gap in place for common
// non-GitHub YAML (docker-compose.yml, k8s manifests, …).
export function isZizmorAuditTarget(filePath: string): boolean {
	const normalized = filePath.replace(/\\/g, "/");
	const base = path.basename(normalized).toLowerCase();
	if (/(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/i.test(normalized)) return true;
	if (base === "action.yml" || base === "action.yaml") return true;
	if (/(^|\/)\.github\/dependabot\.ya?ml$/i.test(normalized)) return true;
	return false;
}

// A transient-aware latch for the `gh auth token` derivation (#1535, the
// #1467/#1494 permanent-probe-latch family). The old code folded EVERY
// failure — including a 5s host stall — into a memoized `{ value: undefined }`
// that stuck for the whole process, so a single slow `gh` disabled zizmor's
// GitHub-aware online audits (known-vulnerable-actions, unpinned-uses,
// impostor-commit) for the rest of the session while the scan still reported
// success. Only a genuine answer (gh ran and returned a real exit code, or is
// proven absent) latches now; a timeout/stall/unspawnable probe expires on the
// shared cooldown and is re-probed on the next call.
//
// The cooldown ladder is capped below zizmor's respawn cadence, but that
// cadence isn't a single number: `clients/runtime-turn.ts`'s ordinary LSP
// idle reset is 240s, while a subagent session or budget pressure can
// recycle the fleet on `clients/lsp-budget.ts`'s shorter
// `DEFAULT_LSP_BUDGET_IDLE_TIMEOUT_MS` (60s). The 120s cap sits BELOW the
// 240s cadence but ABOVE the 60s one, so that faster respawn can still land
// inside a still-cooling verdict — the shared default cap
// (`TRANSIENT_MAX_COOLDOWN_MS`, 5 min) would make either respawn read the
// cache instead of re-probing. The 60s gap is covered differently: the
// cache-hit path in `resolveZizmorGitHubToken` logs an
// `availability_decision` and counts a degradation on every transient cache
// read, not only on the probe that produced it, so a respawn landing inside
// EITHER cadence is still observable even when it isn't re-probed (#1535
// review).
const ZIZMOR_TOKEN_MAX_COOLDOWN_MS = 120_000;
const ghTokenLatch = createAvailabilityLatch({
	maxCooldownMs: ZIZMOR_TOKEN_MAX_COOLDOWN_MS,
});
let cachedToken: string | undefined;

const GH_TOKEN_PROBE_TIMEOUT_MS = 5000;

/**
 * Forget the memoized `gh auth token` verdict. Called at `session_start`
 * (`clients/runtime-session.ts`, alongside the sibling `#1266`
 * `resetDispatchAvailabilityState` reset) so a user who runs `gh auth login`
 * and starts a new session doesn't keep reading a stale "no token" answer
 * from the previous one — the latch is process-lived storage, but its
 * DURABILITY contract is per-session, matching every other dispatch
 * availability latch.
 */
export function resetZizmorTokenAvailability(): void {
	ghTokenLatch.reset();
	cachedToken = undefined;
}

/**
 * Test-only internals access for the session-state registry probe (#1535):
 * the conformance suite arms a latched "missing" verdict and proves the
 * session reset forgets it.
 */
export function _getZizmorTokenLatchForTests(): AvailabilityLatch {
	return ghTokenLatch;
}

/** Test-only alias — kept so existing tests don't need a rename. */
export function _resetZizmorTokenCacheForTests(): void {
	resetZizmorTokenAvailability();
}

interface GhTokenFailureVerdict {
	outcome: AvailabilityOutcome;
	cause: AvailabilityCause;
	/**
	 * How THIS verdict was reached. Only the passthrough branch below is a
	 * genuine `classifyProbeFailure` read; the other three branches assert
	 * their own outcome/cause from this function's own rules, so they are
	 * `"caller"` even though this function LOOKS like a classifier (#2226
	 * review F2 — carried through so `recordGhTokenUnavailable` doesn't have
	 * to guess).
	 */
	classifiedBy: "probe" | "caller";
}

/**
 * Classify a failed `gh auth token` probe.
 *
 * `classifyProbeFailure`'s default branch treats ANY unrecognized failure —
 * including a spawn that never actually ran (EACCES, a resolution error, the
 * generic `spawn-failed` bucket) — as a durable `non-installable` verdict.
 * That is correct for a probe that ran and rejected, but wrong here: an
 * unspawnable prober never asked `gh` anything, so it must not be read as a
 * durable "no" (the lesson from this week's sibling-fix reviews on the
 * #1467/#1494 latch family). Only two shapes may latch: a completed run (any
 * exit code — that IS gh's answer) and a proven-absent `gh` binary.
 */
function classifyGhTokenFailure(
	res: SpawnResult,
	hostStallMs: number,
): GhTokenFailureVerdict {
	// #1651 review F5: `!res.error` alone is not proof gh ran and answered.
	// A `null` or negative `status` is Node's OWN signal that the process
	// never completed a real run — no completed process exits with either —
	// so this never trusts a bare-`error` check over that shape, regardless
	// of whether `safeSpawnAsync` happened to attach an `error` for this
	// particular result. OS-independent by construction: it reads the status
	// Node reports, not a platform-specific errno.
	const neverAnswered = res.status === null || (res.status ?? 0) < 0;
	if (!res.error && !neverAnswered) {
		// The process ran to completion with a real (nonzero, since the zero
		// exit is handled before this is ever called) exit code — a genuine
		// "not authenticated" (or otherwise rejected) answer, safe to cache.
		return {
			outcome: "non-installable",
			cause: "probe-rejected",
			classifiedBy: "caller",
		};
	}
	if (res.spawnFailure?.kind === "tool-not-found") {
		// gh genuinely isn't on PATH — a durable fact about the machine.
		return { outcome: "missing", cause: "not-found", classifiedBy: "caller" };
	}
	const classified = classifyProbeFailure(res, { hostStallMs });
	if (classified.outcome === "transient" || classified.outcome === "missing") {
		return { ...classified, classifiedBy: "probe" };
	}
	// Everything else (EACCES/permission-denied, cwd-unresolvable, a generic
	// spawn-failed, or an unrecognized errno) means the child never launched —
	// that's evidence about this moment, not about gh's auth state.
	return {
		outcome: "transient",
		cause: classified.cause,
		classifiedBy: "caller",
	};
}

async function deriveGhCliToken(): Promise<string | undefined> {
	const sampler = startHostStallSampler();
	const startedAt = Date.now();
	// Best-effort: a missing/unauthenticated `gh` just leaves zizmor offline.
	// ignoreAmbientSignal so a mid-turn Esc can't silently drop the server into
	// offline mode; short timeout so a wedged `gh` never stalls the warm spawn.
	// safeSpawnAsync never rejects (every failure resolves into `res`), so no
	// try/finally is needed to guarantee the sampler stops.
	const res = await safeSpawnAsync("gh", ["auth", "token"], {
		timeout: GH_TOKEN_PROBE_TIMEOUT_MS,
		ignoreAmbientSignal: true,
	});
	const hostStallMs = sampler.stop();
	const elapsedMs = Date.now() - startedAt;

	if (!res.error && res.status === 0) {
		const token = res.stdout.trim();
		if (token.length > 0) {
			ghTokenLatch.noteAvailable();
			logAvailabilityDecision({
				tool: "zizmor-gh-token",
				verdict: "available",
				outcome: "success",
				cause: "ok",
				elapsedMs,
				latched: true,
				hostStallMs,
				budgetMs: GH_TOKEN_PROBE_TIMEOUT_MS,
				classifiedBy: "probe",
			});
			return token;
		}
		// `gh` ran cleanly and answered with nothing — a genuine, durable "no
		// token" verdict (distinct from a rejected/nonzero exit), so it is safe
		// to cache. Reviewer-caught #1535 gap: the pre-fix version of this
		// branch called `noteAvailable()` / logged `verdict:"available"` here
		// regardless of whether `token` was empty, so the record claimed the
		// online audits ran while zizmor was actually about to launch offline
		// — the #1535 silence moved into the telemetry instead of being fixed.
		return recordGhTokenUnavailable(
			{
				outcome: "non-installable",
				cause: "empty-result",
				classifiedBy: "caller",
			},
			elapsedMs,
			hostStallMs,
		);
	}

	return recordGhTokenUnavailable(
		classifyGhTokenFailure(res, hostStallMs),
		elapsedMs,
		hostStallMs,
	);
}

/**
 * Shared tail for every "no token" verdict: latches (or cools down) the
 * memo, records the degradation this causes when it isn't durable-expected,
 * and logs the decision. Centralized so the empty-answer and failure paths
 * can't drift on which fields get set.
 */
function recordGhTokenUnavailable(
	{ outcome, cause, classifiedBy }: GhTokenFailureVerdict,
	elapsedMs: number,
	hostStallMs: number,
): undefined {
	const retryAfterMs = ghTokenLatch.noteUnavailable(outcome, cause);
	if (outcome === "transient") {
		recordZizmorOfflineDegradation(
			`gh auth token probe ${cause}; running offline until the next zizmor start (retry allowed in ${Math.round(retryAfterMs / 1000)}s)`,
		);
	}
	logAvailabilityDecision({
		tool: "zizmor-gh-token",
		verdict: "unavailable",
		outcome,
		cause,
		elapsedMs,
		latched: outcome !== "transient",
		hostStallMs,
		...(retryAfterMs > 0 && { retryAfterMs }),
		budgetMs: GH_TOKEN_PROBE_TIMEOUT_MS,
		// Shared tail for both call paths; the caller carries whether ITS
		// own verdict was a `classifyProbeFailure` passthrough or one of
		// this module's own assertions (#2226 review F2).
		classifiedBy,
	});
	return undefined;
}

/**
 * The degradation itself: zizmor is about to run offline
 * (known-vulnerable-actions/unpinned-uses/impostor-commit skipped) NOT
 * because the token is genuinely absent, but because a probe never got a
 * fair hearing (or is still cooling down from one). Make that legible
 * instead of letting the scan silently report "clean" (#1459's
 * security-silence shape).
 *
 * `incrementDegradationCount` (not the bare `recordDegradation`) per
 * AGENTS.md's degradation-telemetry convention: every offline spawn across a
 * cooldown cycle contributes to the exact group count, but the health view
 * retains only one updated entry per subject instead of five near-identical
 * lines.
 */
function recordZizmorOfflineDegradation(reason: string): void {
	incrementDegradationCount({
		kind: "mode-suppression",
		subject: "zizmor",
		reason,
	});
}

/**
 * Resolve a GitHub token to put zizmor into ONLINE mode, so the audits that need
 * the GitHub API (e.g. `known-vulnerable-actions`, `unpinned-uses`,
 * `impostor-commit`) actually run instead of being silently skipped.
 *
 * zizmor's own precedence: `ZIZMOR_OFFLINE` forces offline regardless of any
 * token; otherwise any of `GH_TOKEN` / `GITHUB_TOKEN` / `ZIZMOR_GITHUB_TOKEN`
 * enables online mode. Those env vars already flow to the spawned server
 * (launchLSP merges `process.env`), so the ONLY gap we close here is the very
 * common case of a user who has authenticated the `gh` CLI but exported no
 * token — we derive one via `gh auth token`. Memoized per session through a
 * transient-aware latch (#1535, reset by `resetZizmorTokenAvailability` at
 * `session_start`): only a genuine answer (gh ran and returned an exit code,
 * or is proven absent) is remembered — a timeout/stall/unspawnable probe
 * expires on a cooldown and is re-derived on the next call, so a single slow
 * `gh` can't disable online audits for the rest of the session.
 *
 * Caveat callers should know: this only decides what token a NEW zizmor spawn
 * receives. A warm zizmor process already has its `GH_TOKEN` set at launch
 * time (`ZizmorServer.spawn`) and does not re-read it — recovering from a
 * transient failure means the NEXT spawn goes online, not the current one.
 */
export async function resolveZizmorGitHubToken(): Promise<string | undefined> {
	// Respect an explicit offline request — never derive a token then.
	if (process.env.ZIZMOR_OFFLINE) return undefined;
	const fromEnv =
		process.env.ZIZMOR_GITHUB_TOKEN ||
		process.env.GH_TOKEN ||
		process.env.GITHUB_TOKEN;
	if (fromEnv) return fromEnv;
	const memo = ghTokenLatch.read();
	if (memo !== null) {
		if (memo === false && ghTokenLatch.getOutcome() === "transient") {
			// Served straight from the still-cooling latch: no new probe runs,
			// so `deriveGhCliToken`'s own logging never fires. Without this, once
			// the cooldown ladder crosses zizmor's own respawn cadence (bounded
			// below `TRANSIENT_MAX_COOLDOWN_MS` via `ZIZMOR_TOKEN_MAX_COOLDOWN_MS`
			// for exactly this reason) a spawn could start offline with nothing
			// in latency.log or the degradation ledger to say so (#1535 review).
			const cause = ghTokenLatch.getCause();
			if (cause === null) {
				// `getOutcome() === "transient"` is only ever set by `noteUnavailable`
				// in the same call that sets `cause` — the two fields are written
				// together, so this can't happen without the latch's own invariant
				// breaking. Assert rather than fabricate a plausible-looking default
				// (e.g. `?? "probe-timeout"`): a fake cause here would silently
				// mislabel WHY the current cycle is offline, in exactly the spot
				// this fix exists to make honest.
				throw new Error(
					"zizmor gh-token latch: transient outcome with no cause (invariant violated)",
				);
			}
			const retryAfterMs = Math.max(
				0,
				ghTokenLatch.getRetryAtMs() - Date.now(),
			);
			recordZizmorOfflineDegradation(
				`gh auth token still cooling down (${cause}); serving cached offline verdict, retry allowed in ${Math.round(retryAfterMs / 1000)}s`,
			);
			logAvailabilityDecision({
				tool: "zizmor-gh-token",
				verdict: "unavailable",
				outcome: "transient",
				cause,
				elapsedMs: 0,
				latched: false,
				hostStallMs: 0,
				...(retryAfterMs > 0 && { retryAfterMs }),
				budgetMs: GH_TOKEN_PROBE_TIMEOUT_MS,
				// No probe ran here: the latch's own remembered cause is replayed
				// as-is, so the call site is the one asserting it (#2209).
				classifiedBy: "caller",
			});
		}
		return memo ? cachedToken : undefined;
	}
	cachedToken = await deriveGhCliToken();
	return cachedToken;
}
