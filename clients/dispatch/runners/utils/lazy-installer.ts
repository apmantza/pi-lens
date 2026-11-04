/**
 * The one lazy-install seam (#1537).
 *
 * Best-effort installs of language-specific tools, triggered when a runner or a
 * formatter finds its tool absent. There were two copies of this — the
 * `attempted` Set here and `formatters.ts`'s `_lazyInstallAttempts` — and both
 * carried the same defect: the key went in BEFORE the install ran and never came
 * out. A `gem install rubocop` that died on a network blip was therefore never
 * retried for the rest of the session, and the tool stayed skipped.
 *
 * The guard itself is right, and it stays: an install storm is worse than a
 * missed install, and these spawns are up to 3 minutes each. What was wrong is
 * that a transient failure and a genuine refusal were recorded identically, with
 * no expiry on either. So the record is now written AFTER the install, and it
 * carries the outcome:
 *
 *   * `succeeded` — nothing more to do this session.
 *   * `failed`, transient (timed out, killed, EAGAIN) — retried after a
 *     cooldown, at most LAZY_INSTALL_MAX_TRANSIENT_ATTEMPTS times, then held.
 *   * `failed`, durable (the package MANAGER is not on this machine) — held for
 *     the session. No cooldown can conjure a `gem`.
 *
 * The vocabulary is #1534's `InstallAttemptFact`, so `describeInstallAttempt`
 * turns this record straight into the `availability_decision` install evidence
 * (#1500) — which is what makes "we tried and the network failed" tellable from
 * "this tool cannot be installed here".
 *
 * A trust denial is deliberately NOT recorded: `assertInstallAllowed` is
 * re-evaluated per call and a later grant must retry (#1350).
 */

import { isToolInstallDisabledByEnv } from "../../../env-utils.js";
import { safeSpawnAsync } from "../../../safe-spawn.js";
import { assertInstallAllowed } from "../../../project-trust.js";
import { logExtension } from "../../../extension-log.js";
import {
	classifyProbeFailure,
	installRetryDelayMs,
	type InstallAttemptFact,
} from "./availability-policy.js";

export type LazyInstallTool = "rubocop" | "rust-clippy" | "rustfmt";

interface LazyInstallSpec {
	command: string;
	args: string[];
}

/**
 * What each install actually runs. Every one of these is a MACHINE-GLOBAL
 * mutation — `gem install rubocop` and `rustup component add` write to the
 * user's gem/toolchain root, not into `cwd` — which is why the hold is shared
 * across seams rather than being per caller (#1537 review F4). A runner and a
 * formatter asking for the same `gem install rubocop` are asking for the same
 * one thing; the second must be suppressed, not run again.
 */
// golangci-lint deliberately has no entry here: it auto-installs through the
// shared TOOL_EXECUTION_POLICY seam instead (`resolveAvailableOrInstall` +
// `ensureTool` in clients/dispatch/runners/utils/runner-helpers.ts, wired in
// golangci-lint.ts). A "golangci-lint" arm briefly lived in this map with no
// caller reaching it through EITHER `tryLazyInstall` or
// `tryLazyInstallForFormatter` — dead since introduction (#1572 sweep).
const LAZY_INSTALL_SPECS: Record<LazyInstallTool, LazyInstallSpec> = {
	rubocop: { command: "gem", args: ["install", "rubocop", "--no-document"] },
	"rust-clippy": { command: "rustup", args: ["component", "add", "clippy"] },
	rustfmt: { command: "rustup", args: ["component", "add", "rustfmt"] },
};

/**
 * Every lazy install ignores an ambient cancellation.
 *
 * The two merged copies disagreed — the formatter one opted in, the runner one
 * did not — and keeping that difference per CALLER while the two share a hold
 * made the cancellation semantics first-caller-wins: whether a `gem install`
 * could be killed mid-write depended on which seam happened to reach it first
 * (#1537 review F4). Nondeterminism is the worse of the two options, so the
 * property belongs to the tool.
 *
 * `true` is the safe direction and the one the newer copy already chose: a
 * half-finished `gem install` or `rustup component add` leaves a broken
 * toolchain, whereas letting it finish costs at most the spawn's own budget
 * below. This is a deliberate behaviour change for the runner seam.
 */
const LAZY_INSTALL_IGNORES_AMBIENT_SIGNAL = true;

const LAZY_INSTALL_TIMEOUT_MS = 180_000;

/**
 * The retry ladder is `installRetryDelayMs` — #1497's install-class one, not a
 * second copy of it.
 *
 * A lazy install is exactly what that ladder is for: a network install on a
 * ~3-minute budget, not a 1.5–5 s version probe, so the probe ladder's 30 s
 * first rung would mean a full install every 30 seconds on a sick network. The
 * caller's cadence is the other half — both entry points are reached per save
 * (and #1539 made a degraded formatter selection re-detect on every pass), so
 * the window has to be far longer than a save interval or the guard is
 * decorative.
 *
 * The first cut wrote its own doubling formula with a 30-minute cap and a
 * 3-attempt ceiling that could never reach it: the stated cost and the real one
 * disagreed. That is the pattern #1514's review rejected and which
 * `availability-policy.ts` now documents as rejected. `installRetryDelayMs`
 * returns 0 once the ladder is spent, so the ceiling is read off the ladder
 * rather than tracked beside it — no arithmetic, nothing unreachable, and no
 * second set of numbers to drift.
 */
interface LazyInstallState {
	fact: InstallAttemptFact;
	/** Epoch ms a retry becomes allowed. 0 means held for the session. */
	retryAtMs: number;
	transientAttempts: number;
}

const attempts = new Map<string, LazyInstallState>();

function key(cwd: string, tool: LazyInstallTool): string {
	return `${cwd}:${tool}`;
}

/**
 * What the last lazy install for this tool+cwd did, in #1534's vocabulary.
 *
 * Feed it to `describeInstallAttempt` to put the install evidence beside the
 * availability verdict it produced. `undefined` means nothing was attempted,
 * which `describeInstallAttempt` renders as `not-attempted` rather than
 * inventing a failure.
 */
export function getLazyInstallAttempt(
	tool: LazyInstallTool,
	cwd: string,
): InstallAttemptFact | undefined {
	return attempts.get(key(cwd, tool))?.fact;
}

/**
 * Drop every lazy-install verdict, so the next call may try again.
 *
 * Called from `session_start`'s per-session reset block in `runtime-session.ts`,
 * beside `resetInstallRetryLatches()` (#1497) — and from NOWHERE else.
 *
 * The boundary is the whole point (#1537 review F1). The first cut wired this
 * into `clearFormatterRuntimeState()`, reasoning that it was "the session-reset
 * path already wired". It is not: that runs from `resetFormatService()`, which
 * `handleTurnEnd` calls every turn. So "held for the session" was held for a
 * TURN — six turns against a missing `gem` meant six 180-second install spawns
 * where the pre-fix bug managed one, the ladder never advanced, and the
 * `InstallAttemptFact` was erased at the same moment. A hold too short is the
 * #1497 storm; a hold too long is the #1494 permanent latch. Only the session
 * boundary is correct, and only a test that drives the real `handleSessionStart`
 * can prove this is wired to it (the #1266 lesson).
 */
export function resetLazyInstallAttempts(): void {
	// Verdicts only. `inFlight` is concurrency bookkeeping, not session state:
	// clearing it mid-install would let the next caller start a SECOND concurrent
	// install of the same tool, which is the very thing it prevents. Its entries
	// are removed by their own `finally`.
	attempts.clear();
}

/** Why a call declined to spawn, when it declined. */
type Suppression = "succeeded" | "cooling" | "held";

function suppressionFor(
	state: LazyInstallState | undefined,
): Suppression | null {
	if (!state) return null;
	if (state.fact.outcome === "succeeded") return "succeeded";
	if (state.retryAtMs === 0) return "held";
	return Date.now() < state.retryAtMs ? "cooling" : null;
}

/**
 * Installs currently running, so callers that arrive mid-install join the one in
 * flight instead of starting another (#1537 review F3).
 *
 * The suppression check and the record write are separated by a spawn that can
 * take three minutes, and the sequential storm-guard test could never see it:
 * three concurrent callers each read "no record yet" and each spawned, the
 * ladder counted a single failure for three installs, and whichever finished
 * last overwrote the others' verdict — a stale success could bury a later
 * failure. Keyed identically to `attempts`, and evicted in a `finally` so a
 * rejection cannot leave a permanent phantom in-flight entry.
 */
const inFlight = new Map<string, Promise<boolean>>();

async function runLazyInstall(
	tool: LazyInstallTool,
	cwd: string,
	spec: LazyInstallSpec,
): Promise<boolean> {
	// Both entry points reach here, so the operator's switch is read once (#5231).
	// Not recorded in `attempts`: a refusal is policy, re-evaluated per call like
	// a trust denial, so unsetting the switch lets the next call install.
	if (isToolInstallDisabledByEnv()) return false;
	const k = key(cwd, tool);
	const running = inFlight.get(k);
	// Joining, not re-answering: both callers get the outcome of the install they
	// actually waited for.
	if (running) return running;

	const previous = attempts.get(k);
	const suppressed = suppressionFor(previous);
	if (suppressed !== null) {
		logExtension({
			subsystem: "install",
			message: `lazy-install ${tool} suppressed (${suppressed})`,
			metadata: {
				tool,
				cwd,
				suppressed,
				outcome: previous?.fact.outcome,
				...(previous?.fact.reason && { reason: previous.fact.reason }),
				...(suppressed === "cooling" && {
					retryAfterMs: Math.max(0, (previous?.retryAtMs ?? 0) - Date.now()),
				}),
			},
		});
		return false;
	}

	const started = performInstall(k, tool, cwd, spec);
	inFlight.set(k, started);
	try {
		return await started;
	} finally {
		inFlight.delete(k);
	}
}

async function performInstall(
	k: string,
	tool: LazyInstallTool,
	cwd: string,
	spec: LazyInstallSpec,
): Promise<boolean> {
	let result: Awaited<ReturnType<typeof safeSpawnAsync>>;
	try {
		result = await safeSpawnAsync(spec.command, spec.args, {
			timeout: LAZY_INSTALL_TIMEOUT_MS,
			cwd,
			...(LAZY_INSTALL_IGNORES_AMBIENT_SIGNAL && { ignoreAmbientSignal: true }),
		});
	} catch (err) {
		// A throw from the spawn boundary is not evidence that the tool cannot be
		// installed, so it is transient like any other failure to get a fair run.
		result = {
			stdout: "",
			stderr: (err as Error)?.message ?? String(err),
			status: null,
			error: err as Error,
			failure: "spawn",
		} as Awaited<ReturnType<typeof safeSpawnAsync>>;
	}

	if (!result.error && result.status === 0) {
		attempts.set(k, {
			fact: { outcome: "succeeded" },
			retryAtMs: 0,
			transientAttempts: 0,
		});
		return true;
	}

	// `classifyProbeFailure` owns the transient taxonomy (timeout, kill, EAGAIN)
	// and the one durable case that matters here: `tool-not-found` on the package
	// MANAGER. Everything else RAN and exited nonzero, which for an install is
	// the retry candidate — a network failure and a nonexistent package are
	// indistinguishable from the exit code, so the attempt CEILING is what stops
	// the second one from retrying forever, not a guess at the cause.
	const classified = classifyProbeFailure(result, {
		command: spec.command,
		unclassifiedFailureOutcome: "transient",
	});
	const durable = classified.outcome === "missing";
	const reason = (
		result.error?.message ??
		result.stderr ??
		`exit ${result.status}`
	)
		.trim()
		.slice(0, 200);

	// Re-read the record rather than trusting one captured before the spawn
	// (#1537 review P3). `resetLazyInstallAttempts` clears `attempts` but leaves
	// `inFlight`, so an install can outlive the session that started it — and a
	// captured counter let that survivor stamp the OLD session's attempt count
	// onto the NEW session's empty map, opening a fresh session already HELD with
	// no attempts of its own. Re-reading makes the settle count as attempt 1 of
	// whatever session is current. Nothing else can write this key while the
	// install is in flight (the in-flight map is what guarantees that), so in the
	// ordinary case this reads exactly what was captured.
	const settledPrevious = attempts.get(k);
	const transientAttempts = durable
		? 0
		: (settledPrevious?.transientAttempts ?? 0) + 1;
	// The ceiling is READ OFF the ladder: `installRetryDelayMs` returns 0 once its
	// list is spent, which is the same "no retry, the verdict is latched" signal
	// `noteUnavailable` returns. No separate max-attempts comparison to disagree
	// with the ladder's real length (#1537 review F2).
	const cooldownMs = durable ? 0 : installRetryDelayMs(transientAttempts);
	const retryAtMs = cooldownMs === 0 ? 0 : Date.now() + cooldownMs;

	attempts.set(k, {
		fact: { outcome: "failed", reason },
		retryAtMs,
		transientAttempts,
	});
	logExtension({
		subsystem: "install",
		message: `lazy-install ${tool} failed: ${reason}`,
		metadata: {
			tool,
			cwd,
			command: spec.command,
			cause: classified.cause,
			durable,
			transientAttempts,
			held: retryAtMs === 0,
			...(retryAtMs > 0 && { retryAfterMs: retryAtMs - Date.now() }),
			evidence: classified.evidence,
		},
	});
	return false;
}

/**
 * Best-effort lazy install for language-specific linters.
 *
 * Returns true only when an install just ran and succeeded — a suppressed call
 * returns false rather than repeating the previous answer, so a caller cannot
 * mistake "already handled" for "just installed".
 */
export async function tryLazyInstall(
	tool: LazyInstallTool,
	cwd: string,
): Promise<boolean> {
	if (!assertInstallAllowed(`runner lazy install: ${tool}`)) return false;
	return runLazyInstall(tool, cwd, LAZY_INSTALL_SPECS[tool]);
}

/**
 * The formatter-facing entry point. Distinct only for the trust gate's audit
 * label, which names the seam that asked; the state, the spawn options, the
 * classification and the ladder are all shared, because this was a two-copy
 * shape and a fix in one copy is not a fix (#1537).
 */
export async function tryLazyInstallForFormatter(
	tool: "rubocop" | "rustfmt",
	cwd: string,
): Promise<boolean> {
	if (!assertInstallAllowed(`formatter lazy install: ${tool}`)) return false;
	return runLazyInstall(tool, cwd, LAZY_INSTALL_SPECS[tool]);
}
