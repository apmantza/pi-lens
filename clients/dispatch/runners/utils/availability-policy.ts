/**
 * Shared availability policy for tool probes (#1467).
 *
 * A `--version` probe answers one question — "can I run this tool right now?" —
 * and it can fail for two very different reasons:
 *
 *   * the tool is **missing**: a durable fact about the machine, worth caching
 *     for the session and worth an "install it" message;
 *   * the probe was **transient**: a timeout, an abort, an EAGAIN. That is
 *     evidence about *this moment*, not about the tool. Caching it as a
 *     permanent `false` disables a healthy tool for the life of the process,
 *     and wording it as "not installed" sends the user to reinstall something
 *     that is already on disk.
 *
 * knip hit exactly that: a 5 s host-side probe budget, an event-loop stall that
 * ate most of it, a latched `false`, and three days of "Knip not available.
 * Install with: npm install -D knip" over a knip that answered `--version` in
 * 0.8 s outside the host. This module owns the policy so every client — the
 * `createAvailabilityChecker` seam, knip, madge, govulncheck, vulture — shares
 * one taxonomy, one retry rule, and one message split.
 *
 * Kept dependency-light on purpose (only the latency logger) so client modules
 * can import the policy without pulling in the dispatch/installer graph.
 */

import { logLatency } from "../../../latency-logger.js";

export type AvailabilityOutcome =
	| "success"
	| "missing"
	| "transient"
	| "non-installable";

/**
 * Why a probe reached its verdict. `outcome` decides the control flow (install
 * / retry / give up); `cause` is what we tell the user and log, and it is the
 * only thing that distinguishes "timed out" from "not installed".
 */
export type AvailabilityCause =
	| "ok"
	| "fast-path"
	| "not-found"
	| "probe-timeout"
	| "host-stall"
	| "probe-rejected"
	| "bad-cwd"
	| "policy-denied"
	| "empty-result"
	/**
	 * An install-class operation kept failing transiently and hit its retry
	 * ceiling (#1497). The outcome stays `transient` — the failures WERE
	 * transient — so this cause is the only thing that stops the verdict from
	 * being described as "it will be retried" when nothing will retry it until
	 * the next session.
	 */
	| "install-retry-exhausted";

/**
 * What the spawn ACTUALLY returned, carried beside the verdict derived from it
 * (#1500).
 *
 * Migrating a tool to this policy makes its storage correct and says nothing
 * about its classification. A call site can hand the latch `("missing",
 * "not-found")` for a failure that was really transient, and the resulting row
 * is a well-formed `missing` verdict — indistinguishable from a genuine
 * absence. That defect is deliberately ungated (a lint that flags every literal
 * classification would fire on every correct post-ENOENT write), so the record
 * carries the raw facts instead: a reader can audit the derivation rather than
 * trust it.
 */
export interface ProbeEvidence {
	/**
	 * The command this evidence DESCRIBES, when it is not the tool the row is
	 * about. govulncheck's install path probes `go`, and a row that carries go's
	 * errno under `tool: "govulncheck"` invites the exact misreading this field
	 * exists to prevent (#1500 review).
	 */
	command?: string;
	/** Exit status the probe returned; `null` when it never exited. */
	status?: number | null;
	/** `safeSpawnAsync`'s structured failure reason. */
	failure?: string;
	/** Typed spawn-boundary failure kind. */
	spawnFailureKind?: string;
	/**
	 * `error.code` from the spawn's Error, when there was one — Node's errno
	 * STRING (`"ENOENT"`, `"EACCES"`, `"UNKNOWN"`), never the numeric errno. Named
	 * `errno` because that is what a log reader greps for; the type is the
	 * contract.
	 */
	errno?: string;
	/**
	 * A repair was attempted after the probe, and how it went.
	 *
	 * `not-attempted` is its own value on purpose: an installer that declines
	 * (auto-install off, trust denied, attempt already suppressed) returns the
	 * same empty result as one that tried and failed, and writing `failed` for
	 * both fabricates an attempt that never happened.
	 */
	install?: "succeeded" | "failed" | "unavailable" | "not-attempted";
	/**
	 * Bounded (200 char) reason the installer gave, verbatim.
	 *
	 * Deliberately FREE TEXT, not a taxonomy: it is read by humans debugging one
	 * host, and every attempt to enumerate installer failure modes ages worse than
	 * the strings themselves. `install` is the field to branch on; this one is the
	 * field to read. If a consumer ever needs to branch on the reason, that is the
	 * signal to promote the specific case into `install` rather than to parse this.
	 */
	installReason?: string;
	/**
	 * Basename of the binary a pi-lens-MANAGED directory answered with. Two
	 * kinds of row carry it:
	 *
	 *   * the compensating `available` row after a probe-then-install recovery
	 *     (#1606), where `install: "succeeded"` or a cache resolved it without
	 *     a fresh attempt — the only durable record that the tool came back;
	 *   * a plain probe `available` row (NO `install` key at all) whose
	 *     resolution came from `~/.pi-lens/tools/node_modules/.bin` or
	 *     `~/.pi-lens/bin` rather than from PATH or a project venv (#2140).
	 *
	 * `binary` present therefore means "pi-lens's own install answered this",
	 * and its absence means PATH/venv/vendor. `source` names WHICH managed
	 * family when the command is a registry id; a managed shim whose command
	 * is not itself a registry id (`markdownlint-cli2`) carries `binary` with
	 * no `source` rather than a guessed one.
	 *
	 * Deliberately a BASENAME, never the resolved absolute path — same rule as
	 * `unreachablePreferred` below (#1568 review): an absolute path under the
	 * user's home is a leak risk in a shared log, and it breaks a reader
	 * grepping latency.log for a bare tool name across every row.
	 */
	binary?: string;
	/**
	 * Which installer family resolved `binary`, alongside it. Derived from the
	 * tool registry's own `installStrategy` (#1612 review F1) — never
	 * hand-mapped per runner, since a second, parallel list drifts out of sync
	 * with the registry the moment either one changes:
	 *
	 *   * `"managed-dir"`  — an npm-strategy install into pi-lens's managed
	 *     tools directory (gitleaks, trivy, opengrep, pyright, jscpd, knip, …).
	 *   * `"go-install"`   — a Go-toolchain install (govulncheck).
	 *   * `"pip-user"`     — a pip --user install (ruff).
	 *   * `"github-release"` — a GitHub-release binary download (golangci-lint,
	 *     shellcheck, shfmt, terragrunt, tflint, helm, trivy).
	 *   * `"archive-dist"` — a downloaded archive's extracted binary (spotbugs).
	 *   * `"maven-jar"`    — a Maven-resolved jar (ktfmt).
	 */
	source?:
		| "managed-dir"
		| "go-install"
		| "pip-user"
		| "github-release"
		| "archive-dist"
		| "maven-jar";
	/**
	 * Milliseconds the probe spent RESOLVING which command to run, before the
	 * `--version` spawn that `durationMs` measures (#2140 review F2).
	 *
	 * The two are separate on purpose. `durationMs` is compared against
	 * `budgetMs` by `recordAvailabilityProbeOverrun`, so folding resolution
	 * into it would charge the probe budget for work the budget does not
	 * govern. But resolution is no longer free: the managed rungs stat the
	 * managed directories and, on a first touch, run their own verification
	 * spawn — measured at 313ms of a 621ms managed hit whose row claimed
	 * 308ms. Without this field that half is invisible in latency.log, which
	 * is exactly how the cost of a resolution rung escapes review.
	 *
	 * Worst case for a release-managed tool is `MANAGED_VERIFY_TIMEOUT_MS`
	 * (5s, the verification spawn) plus the checker's own `probeTimeout`
	 * (5s by default) — 10s, both bounded, and the verification verdict is
	 * memoized per binary per session.
	 */
	resolveMs?: number;
	/**
	 * Set instead of a fresh `install` outcome when `installed` came from an
	 * already-known-good answer rather than an install this call actually ran
	 * (#1612 review F2, #1636 review). Pairs with `install: "not-attempted"`:
	 * without this, a row that fires on every dispatch (because the checker's
	 * own probe keeps missing on PATH, #1612 follow-up) reads as a fresh
	 * install succeeding every time, when only the very first one did.
	 *
	 *   * `"cache"`    — the installer's in-memory session cache or its
	 *     persistent probe cache already held a verified path.
	 *   * `"path"`     — a plain PATH / managed-dir discovery this call, no
	 *     cache and no install involved.
	 *   * `"declined"` — policy said no (kill switch, `allowInstall: false`,
	 *     project trust) and the binary it hands back is whatever discovery
	 *     found anyway. Neither a cache hit nor a fresh install: #1636 review
	 *     caught this collapsing into `"cache"`, which reads a policy refusal
	 *     as a resolved-and-trusted answer.
	 */
	resolved?: "cache" | "path" | "declined";
	/**
	 * Whether this compensating `available` row cleared a latched `unavailable`
	 * row, or corrected nothing (#1657). The two rows are otherwise identical
	 * and the once-per-correction memo treats them differently, so without this
	 * field a log reader cannot tell which one happened — the very distinction
	 * the memo is built on (#1674 review F4).
	 */
	correctsLatchedRow?: boolean;
}

/**
 * Read the evidence off a spawn result, dropping keys it does not carry.
 *
 * `command` is worth passing whenever the spawn is NOT the tool the decision is
 * about — a preflight, a fallback candidate, an interpreter.
 */
export function describeProbeEvidence(
	result: ProbeFailureShape,
	command?: string,
): ProbeEvidence {
	const errno = (result.error as NodeJS.ErrnoException | undefined)?.code;
	return {
		...(command !== undefined && { command }),
		...(result.status !== undefined && { status: result.status }),
		...(result.failure !== undefined && { failure: result.failure }),
		...(result.spawnFailure?.kind !== undefined && {
			spawnFailureKind: result.spawnFailure.kind,
		}),
		...(errno !== undefined && { errno }),
	};
}

/** The installer's own record of what its last attempt did. */
export interface InstallAttemptFact {
	outcome: "succeeded" | "failed" | "unavailable" | "declined" | "skipped";
	reason?: string;
}

/**
 * Evidence for an install attempt, from what the installer EXPLICITLY recorded.
 *
 * The first version of this inferred attempt-ness from the installer's failure
 * REASON map, and a review proved that inverts the answer in both directions:
 * that map is written by the kill-switch and install-lock branches and by
 * nothing on the genuine-failure or success paths, so a policy decline read as a
 * failed download and every real download failure — the retry candidate this
 * evidence exists to surface — read as a policy decision. `getInstallAttempt`
 * now records the outcome at each branch that knows it, and this maps it.
 *
 * `declined` and `skipped` both collapse to `not-attempted`, because that is the
 * distinction a reader acts on; which of the two it was survives in `reason`.
 *
 * The fact is passed in rather than fetched here, so the policy module stays
 * free of the installer graph.
 */
export function describeInstallAttempt(
	attempt: InstallAttemptFact | undefined,
	options: { installedButRejected?: boolean } = {},
): ProbeEvidence {
	const reason = attempt?.reason?.slice(0, 200);
	if (options.installedButRejected) {
		// The install ran and produced a binary the caller then refused. Claiming
		// `failed` would blame the download for a validation verdict.
		return {
			install: "succeeded",
			installReason: reason ?? "installed binary failed validation",
		};
	}
	if (attempt === undefined) return { install: "not-attempted" };
	switch (attempt.outcome) {
		case "succeeded":
			return { install: "succeeded", ...(reason && { installReason: reason }) };
		case "failed":
			return { install: "failed", ...(reason && { installReason: reason }) };
		case "unavailable":
			return {
				install: "unavailable",
				...(reason && { installReason: reason }),
			};
		default:
			return {
				install: "not-attempted",
				...(reason && { installReason: reason }),
			};
	}
}

export interface AvailabilityDecision {
	tool: string;
	/** Producer scope for independent availability evidence (#2351). */
	producer?: "security-scan" | "lsp-launch";
	verdict: "available" | "unavailable";
	outcome: AvailabilityOutcome;
	cause: AvailabilityCause;
	/**
	 * How the outcome/cause was reached. `probe` means `classifyProbeFailure`
	 * derived it from `evidence`; `caller` means the call site asserted it. A
	 * `caller` row is the one a reviewer has to justify (#1500).
	 */
	classifiedBy?: "probe" | "caller" | "joined";
	/** The raw spawn facts the verdict was derived FROM. */
	evidence?: ProbeEvidence;
	/** Wall time the probe took, ms. 0 for fast paths and cached decisions. */
	elapsedMs: number;
	/** True when this verdict is remembered until the next session reset. */
	latched: boolean;
	/** Host event-loop stall observed while the probe was in flight, ms. */
	hostStallMs?: number;
	/** For a non-latched verdict: how long until the next probe is allowed. */
	retryAfterMs?: number;
	/** Probe budget the verdict was measured against, ms. */
	budgetMs?: number;
	/**
	 * This verdict did not win on the merits (#1568). An ordered candidate walk
	 * stopped at a tier that answered, but a tier AHEAD of it was unreachable
	 * rather than absent — so the winner is in use provisionally and the sweep
	 * is owed a re-run once the stalled tier's cooldown expires.
	 *
	 * Its own field rather than an inference from `latched: false`: on an
	 * `available` row, `latched` was previously always `true`, so a reader had no
	 * way to tell a real win from a degraded one (#1559's `formatter_selected`
	 * lesson, in the tool-tier domain).
	 */
	provisional?: boolean;
	/**
	 * The candidates ahead of the winner that were unreachable, in ask order.
	 * Named as in #1559's `formatter_selected` record so one grep covers both.
	 *
	 * Candidate NAMES, never resolved paths: a tier can be an absolute
	 * `node_modules/.bin/<name>` under the user's home, and every sibling row in
	 * this log carries a bare tool name. Writing the path there would both leak
	 * it and break the grep (#1568 review F3).
	 */
	unreachablePreferred?: readonly string[];
	/**
	 * No candidate answered this sweep; the verdict re-serves the winner the
	 * previous (provisional) sweep found (#1568 review F1).
	 *
	 * Only ever set beside `provisional`, and only when the failure class was
	 * transient. It is the row that explains why an `available` verdict was
	 * emitted by a sweep in which nothing was reachable.
	 */
	retained?: boolean;
	/**
	 * True when NO probe ran: the latch served a still-cooling verdict and the
	 * caller opted to record it anyway (#1539). It keeps the opt-in rows below
	 * separable from real decisions, so a reader counting probes and a reader
	 * asking "how long has this been off" get different, honest answers.
	 */
	servedFromCooldown?: boolean;
}

/**
 * Cooldown after a transient failure. Bounded exponential so a genuinely sick
 * machine is not re-probed every call, while a one-off stall costs at most one
 * cooldown: 30 s, 60 s, 120 s … capped at 5 min.
 */
export const TRANSIENT_BASE_COOLDOWN_MS = 30_000;
export const TRANSIENT_MAX_COOLDOWN_MS = 300_000;

/**
 * A timeout the host itself caused is not evidence about the tool at all, so it
 * gets a short fixed cooldown (just enough to avoid a probe storm while the
 * loop is still stalling) and never escalates.
 */
export const HOST_STALL_COOLDOWN_MS = 5_000;

/**
 * Host stall, in ms, that has to overlap a probe window before we stop counting
 * a timeout as evidence about the tool. Well under the smallest probe budget
 * (1.5 s) so a stall can only ever *soften* a verdict we would otherwise latch.
 */
export const HOST_STALL_EVIDENCE_MS = 500;

/** Never mistake a transient verdict for a durable one. */
export function isLatchingOutcome(outcome: AvailabilityOutcome): boolean {
	return outcome !== "transient";
}

export function transientRetryDelayMs(
	attempts: number,
	cause: AvailabilityCause,
	/**
	 * Override for `TRANSIENT_MAX_COOLDOWN_MS`. A caller whose own respawn
	 * cadence is shorter than the shared 5-minute ceiling (e.g. an LSP auxiliary
	 * whose idle reset recycles the process well before the ladder maxes out)
	 * must cap its own ladder below that cadence — otherwise a respawn can land
	 * inside a still-cooling-down cache window and start silently offline
	 * (#1535).
	 */
	maxCooldownMs: number = TRANSIENT_MAX_COOLDOWN_MS,
): number {
	if (cause === "host-stall") return HOST_STALL_COOLDOWN_MS;
	const exponent = Math.max(0, attempts - 1);
	return Math.min(
		maxCooldownMs,
		TRANSIENT_BASE_COOLDOWN_MS * 2 ** Math.min(exponent, 10),
	);
}

/**
 * Install-class transient policy (#1497): the operation being retried is a
 * network install/compile with a ~60 s budget (govulncheck's `go install`),
 * not a 1.5–5 s version probe. The probe schedule above would re-run that
 * compile every 5 minutes indefinitely — a ~20% duty cycle on one core with
 * nothing that ever gives up.
 *
 * The cost, stated: the ladder IS `INSTALL_TRANSIENT_COOLDOWNS_MS` — 5 min,
 * then 10 min, then give up. Three ≤60 s compiles across ~15 minutes, and then
 * the verdict is terminal FOR THE SESSION: `resetInstallRetryLatches()` at the
 * next `session_start` (or a successful run) re-arms it, so a genuinely
 * repaired network still recovers without a host restart. What ends is the
 * *indefinite* retry, not the recovery #1489 fixed.
 *
 * The ceiling is DERIVED from the ladder rather than written beside it: an
 * earlier revision paired a doubling formula with a 30-minute cap that a
 * 3-attempt ceiling could never reach, so the stated cost and the real one
 * disagreed. One list, no arithmetic, nothing unreachable.
 *
 * There is no host-stall shortcut here, and install-class failures keep their
 * own cooldown slot: the retry itself is the expensive part no matter who ate
 * the budget, so a cheap probe failure must not be able to shorten it.
 */
export const INSTALL_TRANSIENT_BASE_COOLDOWN_MS = 300_000;

/** Cooldown before install retry N, in order. Its length sets the ceiling. */
export const INSTALL_TRANSIENT_COOLDOWNS_MS: readonly number[] = [
	INSTALL_TRANSIENT_BASE_COOLDOWN_MS,
	INSTALL_TRANSIENT_BASE_COOLDOWN_MS * 2,
];

/** Install attempts allowed per session, including the one that gives up. */
export const INSTALL_TRANSIENT_MAX_ATTEMPTS =
	INSTALL_TRANSIENT_COOLDOWNS_MS.length + 1;

/**
 * Cooldown owed after `attempts` install-class failures, or **0** when the
 * ladder is spent — the same "no retry, the verdict is latched" signal
 * `noteUnavailable` returns.
 */
export function installRetryDelayMs(attempts: number): number {
	return INSTALL_TRANSIENT_COOLDOWNS_MS[Math.max(0, attempts - 1)] ?? 0;
}

/**
 * Session generation for install-class retry state (#1497 review F1).
 *
 * The exhausted verdict is durable for a SESSION, but the latches holding it
 * belong to process-lived client instances (`SecurityScanClient` and friends
 * are built once in `bootstrap.ts`). Without this, "terminal for the session"
 * silently became terminal for the process: a repaired network plus a full
 * `session_start` reset still read exhausted, which is the #1266/#1490/#1535
 * shape. A counter rather than a latch registry, so nothing has to be
 * hand-maintained and no latch is retained for the sake of resetting it.
 */
let installRetryGeneration = 0;

/**
 * Re-arm install-class retries in every latch. Called from `session_start`'s
 * per-session reset block beside `resetDispatchAvailabilityState()`.
 */
export function resetInstallRetryLatches(): void {
	installRetryGeneration += 1;
}

/** The subset of a spawn result the classification actually reads. */
export interface ProbeFailureShape {
	/** The spawn's Error, whose `code` carries the errno when there is one. */
	error?: Error | null;
	status?: number | null;
	failure?: string;
	spawnFailure?: { kind?: string };
}

export interface ClassifyOptions {
	/** Host stall observed during the probe window, ms. */
	hostStallMs?: number;
	/** The command that was spawned, recorded on the returned evidence. */
	command?: string;
	/** Compatibility for legacy probes whose test doubles carry no failure kind. */
	unclassifiedFailureOutcome?: AvailabilityOutcome;
}

/**
 * Classify a failed probe into an outcome + cause.
 *
 * The stall arm is the #1467 fix for the measurement itself: the probe budget
 * is enforced by a HOST-side `setTimeout`, so a stalled event loop expires the
 * budget while the child is still healthy and mid-startup. When a stall
 * overlapped the window we keep the outcome transient but re-cause it as
 * `host-stall`, which shortens the cooldown and — critically — says so in the
 * telemetry, instead of silently blaming the tool.
 */
export function classifyProbeFailure(
	result: ProbeFailureShape,
	options: ClassifyOptions = {},
): {
	outcome: AvailabilityOutcome;
	cause: AvailabilityCause;
	/** The facts this verdict was derived from, for the decision record (#1500). */
	evidence: ProbeEvidence;
} {
	const evidence = describeProbeEvidence(result, options.command);
	const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
	if (result.spawnFailure?.kind === "tool-not-found") {
		return { outcome: "missing", cause: "not-found", evidence };
	}
	if (
		result.failure === "timeout" ||
		result.failure === "aborted" ||
		result.failure === "signal" ||
		result.spawnFailure?.kind === "killed" ||
		result.spawnFailure?.kind === "timeout" ||
		errorCode === "EAGAIN" ||
		errorCode === "EBUSY"
	) {
		const stalled = (options.hostStallMs ?? 0) >= HOST_STALL_EVIDENCE_MS;
		return {
			outcome: "transient",
			cause: stalled ? "host-stall" : "probe-timeout",
			evidence,
		};
	}
	// A present command that rejects its version probe (or an EACCES/EINVAL/
	// UNKNOWN failure) is not repaired by reinstalling it.
	const outcome = options.unclassifiedFailureOutcome ?? "non-installable";
	return {
		outcome,
		cause: outcome === "missing" ? "not-found" : "probe-rejected",
		evidence,
	};
}

/**
 * Accumulate how long the host event loop was blocked while something else was
 * in flight. A timer scheduled every `intervalMs` that fires late by L ms means
 * the loop was unavailable for L ms of the window — exactly the time the probe
 * budget was being spent on the host rather than on the child.
 *
 * `unref`'d and cleared on the single settle path, so it can never hold a
 * print-mode process open (recurring defect shape 4).
 */
export function startHostStallSampler(intervalMs = 100): {
	stop: () => number;
} {
	let stallMs = 0;
	let last = Date.now();
	let stopped = false;
	const timer: NodeJS.Timeout | undefined = setInterval(() => {
		const now = Date.now();
		const lateness = now - last - intervalMs;
		if (lateness > 0) stallMs += lateness;
		last = now;
	}, intervalMs);
	timer?.unref?.();
	return {
		stop: (): number => {
			if (stopped) return Math.round(stallMs);
			stopped = true;
			clearInterval(timer);
			// A stall in progress when the probe settles is still stall inside the
			// window; count the tail the interval never got to observe.
			const tail = Date.now() - last - intervalMs;
			if (tail > 0) stallMs += tail;
			return Math.round(stallMs);
		},
	};
}

/**
 * A transient-aware availability latch for clients that memoize their own
 * `available` flag (knip, madge, govulncheck, vulture).
 *
 * `read()` returns `null` when the caller must probe again — either it has
 * never probed, or the last failure was transient and its cooldown has expired.
 * Only a durable outcome (`missing` / `non-installable`) is remembered for the
 * whole session, which is the invariant that stops one slow second at warm-up
 * from disabling an installed tool for the life of the process.
 */
export interface AvailabilityLatch {
	read(): boolean | null;
	noteAvailable(cause?: AvailabilityCause): void;
	/**
	 * Record an available verdict that did NOT win on the merits (#1568): an
	 * ordered candidate walk stopped at a tier that answered while a tier ahead
	 * of it was unreachable rather than absent.
	 *
	 * The verdict is served — the tool works right now, and re-sweeping on every
	 * call would be its own storm — but only until `transientCause`'s cooldown
	 * expires, after which `read()` returns `null` and the caller re-sweeps.
	 * Escalates on the same ladder as a transient failure, so a preferred tier
	 * that keeps stalling is not re-probed every 30 s forever.
	 *
	 * Returns the cooldown applied, in ms, for the decision record.
	 */
	noteProvisionallyAvailable(transientCause: AvailabilityCause): number;
	/**
	 * True while the current verdict is an available-but-provisional one.
	 *
	 * The question a re-sweep has to ask before it gives up: "was the answer I am
	 * about to overwrite a real verdict, or a placeholder?" A sweep that finds
	 * nothing TRANSIENTLY must not turn a working tool off when the answer it
	 * holds came from a candidate that actually ran (#1568 review F1).
	 */
	isProvisional(): boolean;
	/**
	 * Returns the retry delay in ms; 0 means the verdict is latched.
	 *
	 * `opts.operationClass: "install"` marks the failure of an install-class
	 * operation (a network install/compile, #1497) rather than a cheap probe:
	 * it escalates on the install schedule, holds its own cooldown slot, and
	 * latches for the session once INSTALL_TRANSIENT_MAX_ATTEMPTS is reached,
	 * instead of retrying forever. The cause is rewritten to
	 * `install-retry-exhausted` at the ceiling so the verdict describes itself
	 * honestly.
	 */
	noteUnavailable(
		outcome: AvailabilityOutcome,
		cause: AvailabilityCause,
		opts?: { operationClass?: "probe" | "install" },
	): number;
	reset(): void;
	getOutcome(): AvailabilityOutcome | null;
	getCause(): AvailabilityCause | null;
	/**
	 * Epoch ms after which a transient verdict may be re-probed; 0 if latched.
	 *
	 * This is the EFFECTIVE gate: the later of the probe-class and
	 * install-class cooldowns, which is exactly what `read()` enforces. A
	 * caller that reads one class's slot alone would conclude a retry is due
	 * while the other class is still cooling (#1497 review F2).
	 *
	 * "0 if latched" is not the same as "0 whenever the tool is available". A
	 * PROVISIONAL verdict is both: `read()` returns `true` — the tool works and
	 * is being served — while this returns a future timestamp, because the sweep
	 * is still due for re-evaluation (#1568). Read the pair, not either alone.
	 */
	getRetryAtMs(): number;
	/** True once install-class retries are spent for this session (#1497). */
	isInstallExhausted(): boolean;
}

export interface AvailabilityLatchOptions {
	/**
	 * Cap on the transient cooldown ladder, ms. Defaults to the shared
	 * `TRANSIENT_MAX_COOLDOWN_MS` (5 min). Pass a lower value when this latch's
	 * own process respawns on a shorter cadence, so the ladder can never
	 * outlive it (see `transientRetryDelayMs`'s `maxCooldownMs` doc, #1535).
	 */
	maxCooldownMs?: number;
}

export function createAvailabilityLatch(
	options: AvailabilityLatchOptions = {},
): AvailabilityLatch {
	let available: boolean | null = null;
	let outcome: AvailabilityOutcome | null = null;
	let cause: AvailabilityCause | null = null;
	let retryAtMs = 0;
	let transientAttempts = 0;
	let installAttempts = 0;
	let installExhausted = false;
	// Install-class failures own their own cooldown slot (#1497 review F2). A
	// cheap probe failure that lands mid-install-cooldown must not be able to
	// shorten it — the 5 s host-stall shortcut on the probe ladder would
	// otherwise collapse 5 minutes of install spacing into seconds.
	let installRetryAtMs = 0;
	/**
	 * The current `available` verdict is a degraded selection (#1568), held only
	 * until `retryAtMs`. Separate from `available` because it does not change
	 * what the caller is told — the tool IS usable — only how long the answer
	 * may be reused.
	 */
	let provisional = false;
	const maxCooldownMs = options.maxCooldownMs ?? TRANSIENT_MAX_COOLDOWN_MS;
	let installGeneration = installRetryGeneration;

	function clearVerdict(): void {
		available = null;
		outcome = null;
		cause = null;
		retryAtMs = 0;
		transientAttempts = 0;
		installAttempts = 0;
		installExhausted = false;
		installRetryAtMs = 0;
		provisional = false;
	}

	/**
	 * Fold in any `resetInstallRetryLatches()` that happened since the last
	 * touch. Install-class state is per-session, so a new generation drops the
	 * attempt count and the cooldown; when the exhausted verdict IS the state,
	 * the whole verdict goes with it and the next `read()` returns `null` so the
	 * caller re-probes.
	 */
	function syncInstallGeneration(): void {
		if (installGeneration === installRetryGeneration) return;
		installGeneration = installRetryGeneration;
		if (installExhausted) {
			clearVerdict();
			return;
		}
		installAttempts = 0;
		installRetryAtMs = 0;
	}

	/** The later of the two class cooldowns — the gate `read()` enforces. */
	function effectiveRetryAtMs(): number {
		return Math.max(retryAtMs, installRetryAtMs);
	}

	return {
		read(): boolean | null {
			syncInstallGeneration();
			// A provisional `true` expires exactly like a transient `false`: the
			// answer was served, the sweep is still owed (#1568).
			if (available === true) {
				if (provisional && Date.now() >= effectiveRetryAtMs()) return null;
				return true;
			}
			if (available !== false) return available;
			if (installExhausted) return false;
			if (outcome !== "transient") return false;
			return Date.now() >= effectiveRetryAtMs() ? null : false;
		},
		noteAvailable(nextCause: AvailabilityCause = "ok"): void {
			installGeneration = installRetryGeneration;
			available = true;
			outcome = "success";
			cause = nextCause;
			retryAtMs = 0;
			transientAttempts = 0;
			installAttempts = 0;
			installExhausted = false;
			installRetryAtMs = 0;
			provisional = false;
		},
		noteProvisionallyAvailable(transientCause: AvailabilityCause): number {
			syncInstallGeneration();
			available = true;
			outcome = "success";
			// The cause names why the verdict is PROVISIONAL, which is the only
			// thing about it worth recording: `ok` would describe a clean win.
			cause = transientCause;
			provisional = true;
			installAttempts = 0;
			installExhausted = false;
			installRetryAtMs = 0;
			// Same ladder as a transient failure, and the same counter: a preferred
			// tier that stalls on every sweep must back off rather than buy a fresh
			// 30 s window each time.
			transientAttempts += 1;
			const delay = transientRetryDelayMs(
				transientAttempts,
				transientCause,
				maxCooldownMs,
			);
			retryAtMs = Date.now() + delay;
			return delay;
		},
		noteUnavailable(
			nextOutcome: AvailabilityOutcome,
			nextCause: AvailabilityCause,
			opts?: { operationClass?: "probe" | "install" },
		): number {
			syncInstallGeneration();
			available = false;
			outcome = nextOutcome;
			cause = nextCause;
			provisional = false;
			if (isLatchingOutcome(nextOutcome)) {
				retryAtMs = 0;
				installRetryAtMs = 0;
				return 0;
			}
			if (opts?.operationClass === "install") {
				installAttempts += 1;
				const installDelay = installRetryDelayMs(installAttempts);
				if (installDelay === 0) {
					// Terminal for the session (#1497): the caller reads the 0 as
					// "latched" and must surface it, because the user-visible symptom
					// of an unbounded install retry is a busy core, not a missing tool.
					// The cause carries that, so no describe path can promise a retry
					// that will not happen before the next session (review F5).
					installExhausted = true;
					cause = "install-retry-exhausted";
					retryAtMs = 0;
					installRetryAtMs = 0;
					return 0;
				}
				// Install-class keeps its OWN slot: a cheap probe failure landing
				// inside this window (host-stall's 5 s shortcut, say) must not be
				// able to pull the next 60 s compile forward (review F2).
				installRetryAtMs = Date.now() + installDelay;
				return installDelay;
			}
			transientAttempts += 1;
			const delay = transientRetryDelayMs(
				transientAttempts,
				nextCause,
				maxCooldownMs,
			);
			retryAtMs = Date.now() + delay;
			return delay;
		},
		reset(): void {
			installGeneration = installRetryGeneration;
			clearVerdict();
		},
		getOutcome: () => outcome,
		getCause: () => cause,
		getRetryAtMs: () => effectiveRetryAtMs(),
		isProvisional: () => provisional,
		isInstallExhausted: () => {
			syncInstallGeneration();
			return installExhausted;
		},
	};
}

/** True when the verdict came from a probe that never got a fair hearing. */
export function isTransientDecision(
	decision: { outcome?: AvailabilityOutcome | null } | null | undefined,
): boolean {
	return decision?.outcome === "transient";
}

/**
 * THE message split. Every "tool X is unavailable" string a user or agent sees
 * is produced here, so "the probe timed out" can never be worded as "install
 * it" again. `installHint` is the command that would actually fix a genuinely
 * missing tool.
 */
export function describeUnavailability(options: {
	tool: string;
	installHint: string;
	outcome?: AvailabilityOutcome | null;
	cause?: AvailabilityCause | null;
	elapsedMs?: number;
	retryAfterMs?: number;
}): string {
	const { tool, installHint } = options;
	if (options.outcome !== "transient") {
		return `${tool} not available. Install with: ${installHint}`;
	}
	if (options.cause === "install-retry-exhausted") {
		// A transient outcome whose retries are spent. The generic transient arm
		// below ends in "It will be retried", which nothing will do before the
		// next session — so this case describes itself instead (#1497 review F5).
		return `${tool} install kept timing out and reached its retry ceiling (${INSTALL_TRANSIENT_MAX_ATTEMPTS} attempts). ${tool} is not reported missing — the install is not being retried again this session, and recovers at the next session. To install it now: ${installHint}`;
	}
	const elapsed = options.elapsedMs ? ` after ${options.elapsedMs}ms` : "";
	const stalled =
		options.cause === "host-stall"
			? " (the pi host event loop stalled during the probe window, so the budget expired on the host side)"
			: "";
	const retry = options.retryAfterMs
		? ` Retrying in ${Math.round(options.retryAfterMs / 1000)}s.`
		: " It will be retried.";
	return `${tool} availability probe timed out${elapsed}${stalled}. ${tool} is not reported missing — this is a probe timeout, not a missing install.${retry}`;
}

/**
 * One record per availability DECISION (not per cache hit), so a probe that is
 * failing is visible in latency.log the same day instead of being inferred from
 * three days of silence.
 *
 * Bounded by construction: the seam probes each tool at most once per cwd per
 * session generation, plus once per expired transient cooldown.
 *
 * Exception: a consumer whose own respawn cadence can be shorter than its
 * cooldown ladder may deliberately ALSO log on a still-cooling cache hit, so
 * a respawn landing inside that window isn't silently unobservable — see
 * `clients/zizmor-config.ts`'s `resolveZizmorGitHubToken` (#1535). That is an
 * opt-in per caller, not a change to this function's own bound.
 */
export function logAvailabilityDecision(
	decision: AvailabilityDecision,
	filePath = "<pi-lens>",
): void {
	logLatency({
		type: "phase",
		phase: "availability_decision",
		filePath,
		durationMs: Math.round(decision.elapsedMs),
		metadata: {
			tool: decision.tool,
			...(decision.producer !== undefined && {
				producer: decision.producer,
			}),
			verdict: decision.verdict,
			outcome: decision.outcome,
			cause: decision.cause,
			latched: decision.latched,
			...(decision.classifiedBy !== undefined && {
				classifiedBy: decision.classifiedBy,
			}),
			// The raw facts sit beside the verdict they produced, so a `missing` row
			// can be read as justified or not without re-running anything (#1500).
			...(decision.evidence !== undefined && { evidence: decision.evidence }),
			...(decision.hostStallMs !== undefined && {
				hostStallMs: decision.hostStallMs,
			}),
			...(decision.retryAfterMs !== undefined && {
				retryAfterMs: decision.retryAfterMs,
			}),
			...(decision.budgetMs !== undefined && { budgetMs: decision.budgetMs }),
			...(decision.provisional === true && { provisional: true }),
			...(decision.unreachablePreferred !== undefined && {
				unreachablePreferred: decision.unreachablePreferred,
			}),
			...(decision.retained === true && { retained: true }),
			...(decision.servedFromCooldown === true && { servedFromCooldown: true }),
		},
	});
}
