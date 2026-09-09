/**
 * #1537 — the lazy-install attempt latch was set BEFORE the install ran and
 * never cleared, so a `gem install rubocop` or `rustup component add` that died
 * on a network blip was never retried for the rest of the session.
 *
 * The guard itself is right: an install storm is worse than a missed install.
 * What was wrong is that a transient failure and a genuine refusal were recorded
 * identically, with no expiry on either. The latch now keys off the attempt's
 * OUTCOME, using #1534's `InstallAttemptFact` vocabulary.
 *
 * Both entry points are covered, because this was a two-copy shape and a fix in
 * one is not a fix: `lazy-installer.ts`'s `tryLazyInstall` (runners) and
 * `formatters.ts`'s `tryLazyInstallFormatterTool`.
 */

import { withResidentBootstrap } from "../support/bootstrap-access.js";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	resetProjectTrust,
	setProjectTrustState,
} from "../../clients/project-trust.js";
import {
	INSTALL_TRANSIENT_COOLDOWNS_MS,
	INSTALL_TRANSIENT_MAX_ATTEMPTS,
	describeInstallAttempt,
	installRetryDelayMs,
} from "../../clients/dispatch/runners/utils/availability-policy.js";
import {
	getLazyInstallAttempt,
	resetLazyInstallAttempts,
	tryLazyInstall,
} from "../../clients/dispatch/runners/utils/lazy-installer.js";

/** The first cooldown the shared install ladder owes (#1514's list, not a formula). */
const FIRST_COOLDOWN_MS = INSTALL_TRANSIENT_COOLDOWNS_MS[0] ?? 0;

const { safeSpawnAsync } = vi.hoisted(() => ({ safeSpawnAsync: vi.fn() }));

vi.mock("../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/safe-spawn.js")>()),
	safeSpawnAsync,
}));

// The session_start wiring assertion drives the real handler, so the heavy
// collaborators it reaches are stubbed the same way
// `runtime-session-dispatch-reset.test.ts` stubs them.
vi.mock("../../clients/lsp/config.js", () => ({
	loadLSPConfig: vi.fn().mockResolvedValue({}),
	initLSPConfig: vi.fn().mockResolvedValue(undefined),
	getServerInitOverride: vi.fn().mockReturnValue(undefined),
}));
vi.mock("../../clients/lsp/index.js", () => ({
	getLSPService: vi.fn(() => makeLspServiceDouble()),
}));

const okResult = { stdout: "", stderr: "", status: 0 };

/** The install ran and exited nonzero — the retry candidate. */
const failedResult = {
	stdout: "",
	stderr: "Could not find a valid gem 'rubocop' (network is unreachable)",
	status: 1,
};

/** The install was killed by its own budget. Unambiguously transient. */
const timedOutResult = {
	stdout: "",
	stderr: "",
	status: null,
	error: new Error("Process timed out after 180000ms"),
	failure: "timeout",
	spawnFailure: { kind: "timeout" },
};

/**
 * The package MANAGER is not on this machine. Durable: no `gem`, no gem
 * install, not this session and not after any cooldown.
 */
const managerMissingResult = {
	stdout: "",
	stderr: "",
	status: null,
	error: Object.assign(new Error("spawn gem ENOENT"), { code: "ENOENT" }),
	failure: "spawn",
	spawnFailure: { kind: "tool-not-found" },
};

const advance = (ms: number) => vi.setSystemTime(new Date(Date.now() + ms));

/** Minimal deps for the real `handleSessionStart`, per the #1266 test's shape. */
function makeSessionStartDeps(
	ctxCwd: string,
): Parameters<
	typeof import("../../clients/runtime-session.js").handleSessionStart
>[0] {
	const unavailable = {
		isAvailable: () => false,
		ensureAvailable: async () => false,
	};
	return withResidentBootstrap({
		ctxCwd,
		getFlag: () => false,
		notify: vi.fn(),
		dbg: () => {},
		log: () => {},
		runtime: {
			sessionGeneration: 1,
			isCurrentSession: () => true,
			markStartupScanInFlight: () => {},
			clearStartupScanInFlight: () => {},
			complexityBaselines: new Map(),
			resetForSession: () => {},
			projectRoot: "",
			projectRulesScan: { hasCustomRules: false, rules: [] },
			cachedExports: new Map(),
			errorDebtBaseline: { testsPassed: true, buildPassed: true },
		},
		metricsClient: { reset: () => {} },
		cacheManager: { writeCache: () => {}, readCache: () => null },
		todoScanner: { scanDirectory: () => ({ items: [] }) },
		astGrepClient: { ...unavailable, scanExports: async () => new Map() },
		biomeClient: unavailable,
		ruffClient: unavailable,
		knipClient: unavailable,
		jscpdClient: unavailable,
		depChecker: unavailable,
		testRunnerClient: {
			detectRunner: () => ({ runner: "vitest", config: null }),
			runTestFile: () => ({ failed: 1, error: false }),
		},
		goClient: { isGoAvailableAsync: async () => false },
		rustClient: { isAvailableAsync: async () => false },
		ensureTool: vi.fn(async () => null),
		cleanStaleTsBuildInfo: () => [],
		resetDispatchBaselines: () => {},
		resetLSPService: () => {},
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
	}) as any;
}

let cwdSeq = 0;
const freshCwd = () => `/proj/lazy-install-${cwdSeq++}`;

beforeEach(() => {
	safeSpawnAsync.mockReset();
	resetLazyInstallAttempts();
	setProjectTrustState("trusted");
	vi.useFakeTimers({ toFake: ["Date"] });
	return () => {
		vi.useRealTimers();
		resetProjectTrust();
	};
});

describe("a transient lazy-install failure is retried (#1537)", () => {
	it("retries the runner seam after the cooldown", async () => {
		const cwd = freshCwd();
		safeSpawnAsync.mockResolvedValue(timedOutResult);

		expect(await tryLazyInstall("rust-clippy", cwd)).toBe(false);
		expect(safeSpawnAsync).toHaveBeenCalledTimes(1);

		advance(FIRST_COOLDOWN_MS + 1);
		safeSpawnAsync.mockResolvedValue(okResult);
		expect(await tryLazyInstall("rust-clippy", cwd)).toBe(true);
		expect(safeSpawnAsync).toHaveBeenCalledTimes(2);
	});

	it("retries the formatter seam after the cooldown", async () => {
		// The second copy of the shape. A fix in one is not a fix.
		const { tryLazyInstallFormatterTool } =
			await import("../../clients/formatters.js");
		const cwd = freshCwd();
		safeSpawnAsync.mockResolvedValue(failedResult);

		expect(await tryLazyInstallFormatterTool("rubocop", cwd)).toBe(false);
		expect(safeSpawnAsync).toHaveBeenCalledTimes(1);

		advance(FIRST_COOLDOWN_MS + 1);
		safeSpawnAsync.mockResolvedValue(okResult);
		expect(await tryLazyInstallFormatterTool("rubocop", cwd)).toBe(true);
		expect(safeSpawnAsync).toHaveBeenCalledTimes(2);
	});

	it("holds the storm guard inside the cooldown window", async () => {
		// The caller's cadence is per-save, and #1539 made a degraded formatter
		// selection re-detect every pass — so an unbounded retry here would be a
		// 180 s install per save. Many calls inside the window: exactly one spawn.
		const cwd = freshCwd();
		safeSpawnAsync.mockResolvedValue(timedOutResult);

		expect(await tryLazyInstall("rust-clippy", cwd)).toBe(false);
		for (let i = 0; i < 5; i++) {
			advance(FIRST_COOLDOWN_MS / 10);
			expect(await tryLazyInstall("rust-clippy", cwd)).toBe(false);
		}
		expect(safeSpawnAsync).toHaveBeenCalledTimes(1);
	});

	it("escalates the cooldown and then holds for the session", async () => {
		// Bounded, not indefinite (#1497's lesson): three ≤180 s installs, then
		// the verdict is terminal until a session reset or a success.
		const cwd = freshCwd();
		safeSpawnAsync.mockResolvedValue(timedOutResult);

		for (
			let attempt = 1;
			attempt <= INSTALL_TRANSIENT_MAX_ATTEMPTS;
			attempt++
		) {
			expect(await tryLazyInstall("rust-clippy", cwd)).toBe(false);
			advance(installRetryDelayMs(attempt) + 1);
		}
		expect(safeSpawnAsync).toHaveBeenCalledTimes(
			INSTALL_TRANSIENT_MAX_ATTEMPTS,
		);

		// Past every cooldown the ladder could produce: still held.
		advance(FIRST_COOLDOWN_MS * 1000);
		expect(await tryLazyInstall("rust-clippy", cwd)).toBe(false);
		expect(safeSpawnAsync).toHaveBeenCalledTimes(
			INSTALL_TRANSIENT_MAX_ATTEMPTS,
		);
	});
});

describe("the retry ladder is the shared install-class one (#1537 review F2)", () => {
	it("uses #1514's ladder, with no second copy to drift from it", () => {
		// The first cut wrote its own doubling formula with a 30-minute cap and a
		// 3-attempt ceiling that could never reach it — the exact pattern #1514's
		// review rejected, and which availability-policy.ts now documents as
		// rejected. There is one ladder: an explicit list whose length IS the
		// ceiling, no arithmetic, nothing unreachable.
		expect(INSTALL_TRANSIENT_MAX_ATTEMPTS).toBe(
			INSTALL_TRANSIENT_COOLDOWNS_MS.length + 1,
		);
		// Every rung is reachable, and the last attempt is owed no cooldown at all
		// — 0 is the ladder's own "held" signal.
		for (let attempt = 1; attempt < INSTALL_TRANSIENT_MAX_ATTEMPTS; attempt++) {
			expect(installRetryDelayMs(attempt)).toBeGreaterThan(0);
		}
		expect(installRetryDelayMs(INSTALL_TRANSIENT_MAX_ATTEMPTS)).toBe(0);

		// The cooldown-vs-cadence screen: these installs are up to 3 minutes and
		// both entry points are reached per save, so a probe-sized 30 s first rung
		// would make the guard decorative.
		expect(FIRST_COOLDOWN_MS).toBeGreaterThan(60_000);
	});
});

describe("only a session boundary clears a lazy-install hold (#1537 review F1)", () => {
	it("survives a turn boundary", async () => {
		// The hold was reachable only through `clearFormatterRuntimeState()`
		// (formatters.ts) <- `resetFormatService()` (format-service.ts) <-
		// `handleTurnEnd` (runtime-turn.ts:309,327,1719,1835). That runs EVERY
		// TURN, so "held for the session" was held for a turn: six turns against a
		// missing package manager meant six `gem install` spawns where the pre-fix
		// code managed one, and the InstallAttemptFact was wiped at the same
		// moment. A transient failure meant a full 180 s install per turn — the
		// #1497 storm this fix cites in its own docstring.
		const { clearFormatterRuntimeState } =
			await import("../../clients/formatters.js");
		const cwd = freshCwd();
		safeSpawnAsync.mockResolvedValue(managerMissingResult);
		expect(await tryLazyInstall("rubocop", cwd)).toBe(false);

		for (let turn = 0; turn < 6; turn++) {
			clearFormatterRuntimeState();
			expect(await tryLazyInstall("rubocop", cwd)).toBe(false);
		}
		// One spawn across six turn boundaries.
		expect(safeSpawnAsync).toHaveBeenCalledTimes(1);
		expect(getLazyInstallAttempt("rubocop", cwd)?.outcome).toBe("failed");
	});

	it("is cleared by the real session_start handler, not just by the helper", async () => {
		// The wiring assertion. The previous test passed under BOTH wirings, which
		// is precisely how the turn-boundary reset went unnoticed: it proved the
		// helper works when called directly, never that production calls it at the
		// right boundary (the #1266 lesson, and the pattern
		// `runtime-session-dispatch-reset.test.ts` established).
		const { handleSessionStart } =
			await import("../../clients/runtime-session.js");
		const cwd = freshCwd();
		safeSpawnAsync.mockResolvedValue(managerMissingResult);
		expect(await tryLazyInstall("rubocop", cwd)).toBe(false);
		expect(safeSpawnAsync).toHaveBeenCalledTimes(1);

		await handleSessionStart(makeSessionStartDeps(cwd));

		safeSpawnAsync.mockResolvedValue(okResult);
		expect(await tryLazyInstall("rubocop", cwd)).toBe(true);
		expect(safeSpawnAsync).toHaveBeenCalledTimes(2);
	});
});

describe("concurrent callers share one install (#1537 review F3)", () => {
	it("spawns once for callers that arrive during the install", async () => {
		// Check-then-act split by a 180-second await. The storm-guard test above is
		// SEQUENTIAL, so it never saw this: three concurrent callers each read "no
		// record yet" and each spawned, the ladder counted one failure, and a stale
		// success could overwrite a later failure.
		const cwd = freshCwd();
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		safeSpawnAsync.mockImplementation(async () => {
			await gate;
			return failedResult;
		});

		const inFlight = [
			tryLazyInstall("rubocop", cwd),
			tryLazyInstall("rubocop", cwd),
			tryLazyInstall("rubocop", cwd),
		];
		release?.();
		expect(await Promise.all(inFlight)).toEqual([false, false, false]);
		expect(safeSpawnAsync).toHaveBeenCalledTimes(1);

		// One failure, so one rung of the ladder is spent — not three.
		advance(FIRST_COOLDOWN_MS + 1);
		safeSpawnAsync.mockResolvedValue(okResult);
		expect(await tryLazyInstall("rubocop", cwd)).toBe(true);
	});

	it("does not settle an old session's attempt count into a new session (#1537 review P3)", async () => {
		// `resetLazyInstallAttempts` clears `attempts` but deliberately leaves
		// `inFlight`, so an install can outlive the session that started it. The
		// attempt counter used to be captured BEFORE the ≤180 s spawn and written
		// after it settled, so that survivor stamped the OLD session's count onto
		// the NEW session's empty map: burn rungs 1 and 2, have the third settle
		// across `session_start`, and the fresh session opened already HELD with
		// zero attempts of its own.
		const cwd = freshCwd();
		safeSpawnAsync.mockResolvedValue(failedResult);

		// Rungs 1 and 2 of the old session.
		expect(await tryLazyInstall("rubocop", cwd)).toBe(false);
		advance(installRetryDelayMs(1) + 1);
		expect(await tryLazyInstall("rubocop", cwd)).toBe(false);
		advance(installRetryDelayMs(2) + 1);

		// The third install is still in flight when the session turns over.
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		safeSpawnAsync.mockImplementation(async () => {
			await gate;
			return failedResult;
		});
		const survivor = tryLazyInstall("rubocop", cwd);
		resetLazyInstallAttempts();
		release?.();
		expect(await survivor).toBe(false);
		expect(safeSpawnAsync).toHaveBeenCalledTimes(3);

		// The new session must still own a ladder. Either the settle counts as its
		// first attempt or it is dropped entirely — both are fine. What must not
		// happen is a fresh session that is already held.
		const spawnsBefore = safeSpawnAsync.mock.calls.length;
		safeSpawnAsync.mockResolvedValue(okResult);
		advance(installRetryDelayMs(1) + 1);
		expect(await tryLazyInstall("rubocop", cwd)).toBe(true);
		expect(safeSpawnAsync.mock.calls.length).toBe(spawnsBefore + 1);
	});

	it("gives every concurrent caller the same answer on success", async () => {
		const cwd = freshCwd();
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		safeSpawnAsync.mockImplementation(async () => {
			await gate;
			return okResult;
		});

		const inFlight = [
			tryLazyInstall("rust-clippy", cwd),
			tryLazyInstall("rust-clippy", cwd),
		];
		release?.();
		// Both callers observe the install they were waiting on, rather than one of
		// them being told "already handled" for an install that had not finished.
		expect(await Promise.all(inFlight)).toEqual([true, true]);
		expect(safeSpawnAsync).toHaveBeenCalledTimes(1);
	});
});

describe("the two seams share one hold per tool+cwd (#1537 review F4)", () => {
	it("suppresses the formatter seam after the runner seam already tried", async () => {
		// A deliberate consequence of merging the copies, pinned so it cannot drift
		// back silently: `gem install rubocop` is a MACHINE-GLOBAL install, so the
		// second seam asking for the same one must be suppressed, not run again.
		const { tryLazyInstallFormatterTool } =
			await import("../../clients/formatters.js");
		const cwd = freshCwd();
		safeSpawnAsync.mockResolvedValue(managerMissingResult);

		expect(await tryLazyInstall("rubocop", cwd)).toBe(false);
		expect(await tryLazyInstallFormatterTool("rubocop", cwd)).toBe(false);
		expect(safeSpawnAsync).toHaveBeenCalledTimes(1);
	});

	it("uses the same spawn options whichever seam wins the race", async () => {
		// Sharing a hold while the options depended on WHICH caller happened to
		// spawn first made cancellation semantics nondeterministic. The options are
		// a property of the tool now, so both orders produce the same spawn.
		const { tryLazyInstallFormatterTool } =
			await import("../../clients/formatters.js");
		safeSpawnAsync.mockResolvedValue(okResult);

		// Distinct cwds, so each seam actually spawns; `cwd` is the one option that
		// legitimately differs, so it is excluded from the comparison.
		const spawnShape = () => {
			const call = safeSpawnAsync.mock.calls.at(-1);
			const { cwd: _cwd, ...options } = (call?.[2] ?? {}) as Record<
				string,
				unknown
			>;
			return { command: call?.[0], args: call?.[1], options };
		};

		await tryLazyInstall("rubocop", freshCwd());
		const viaRunner = spawnShape();
		await tryLazyInstallFormatterTool("rubocop", freshCwd());
		const viaFormatter = spawnShape();

		expect(viaFormatter).toEqual(viaRunner);
		expect(viaRunner.options).toMatchObject({ ignoreAmbientSignal: true });
	});
});

describe("a durable lazy-install failure keeps its session-long hold (#1537)", () => {
	it("does not retry when the package manager itself is absent", async () => {
		const cwd = freshCwd();
		safeSpawnAsync.mockResolvedValue(managerMissingResult);

		expect(await tryLazyInstall("rubocop", cwd)).toBe(false);
		expect(safeSpawnAsync).toHaveBeenCalledTimes(1);

		// No cooldown expiry rescues this: there is no `gem` to run.
		advance(FIRST_COOLDOWN_MS * 100);
		expect(await tryLazyInstall("rubocop", cwd)).toBe(false);
		expect(safeSpawnAsync).toHaveBeenCalledTimes(1);
	});

	it("still dedupes after a success", async () => {
		// Control: the original guard's whole purpose. Must hold before and after.
		const cwd = freshCwd();
		safeSpawnAsync.mockResolvedValue(okResult);

		expect(await tryLazyInstall("rust-clippy", cwd)).toBe(true);
		advance(FIRST_COOLDOWN_MS * 100);
		expect(await tryLazyInstall("rust-clippy", cwd)).toBe(false);
		expect(safeSpawnAsync).toHaveBeenCalledTimes(1);
	});
});

describe("lazy-install state re-arms and is readable (#1537)", () => {
	it("re-arms when the reset helper is called", async () => {
		// The helper's own unit. Deliberately NOT the wiring proof: this passes
		// whether the helper is called at session_start or at turn_end, which is
		// exactly how the turn-boundary reset slipped through. See the
		// handleSessionStart test above for the binding assertion.
		const cwd = freshCwd();
		safeSpawnAsync.mockResolvedValue(managerMissingResult);
		expect(await tryLazyInstall("rubocop", cwd)).toBe(false);

		resetLazyInstallAttempts();
		safeSpawnAsync.mockResolvedValue(okResult);
		expect(await tryLazyInstall("rubocop", cwd)).toBe(true);
		expect(safeSpawnAsync).toHaveBeenCalledTimes(2);
	});

	it("survives a per-save caller cadence", async () => {
		// #1539 changes this seam's caller cadence from once-per-session to
		// once-per-SAVE: while a preferred formatter is unreachable the selection is
		// provisional, so `detect()` — and therefore this install — is reached on
		// every save. The ladder has to be sized against that caller, not against a
		// once-per-session one. 40 saves a minute apart, one 5-minute rung.
		const { tryLazyInstallFormatterTool } =
			await import("../../clients/formatters.js");
		const cwd = freshCwd();
		safeSpawnAsync.mockResolvedValue(failedResult);
		expect(await tryLazyInstallFormatterTool("rubocop", cwd)).toBe(false);

		const saveIntervalMs = 60_000;
		expect(FIRST_COOLDOWN_MS).toBeGreaterThan(saveIntervalMs);
		for (let save = 0; save < 40; save++) {
			advance(saveIntervalMs);
			await tryLazyInstallFormatterTool("rubocop", cwd);
		}
		// 40 minutes of saves against a 5/10-minute ladder that gives up: the three
		// attempts the ladder allows, and then nothing.
		expect(safeSpawnAsync).toHaveBeenCalledTimes(
			INSTALL_TRANSIENT_MAX_ATTEMPTS,
		);
	});

	it("reports the attempt in #1534's vocabulary, for install evidence", async () => {
		// Nothing distinguished "we tried once and the network failed" from "this
		// tool cannot be installed here". `describeInstallAttempt` is the seam that
		// turns it into the `availability_decision` record's install evidence.
		const cwd = freshCwd();
		expect(getLazyInstallAttempt("rubocop", cwd)).toBeUndefined();
		expect(
			describeInstallAttempt(getLazyInstallAttempt("rubocop", cwd)),
		).toEqual({ install: "not-attempted" });

		safeSpawnAsync.mockResolvedValue(failedResult);
		await tryLazyInstall("rubocop", cwd);
		const attempt = getLazyInstallAttempt("rubocop", cwd);
		expect(attempt?.outcome).toBe("failed");
		expect(describeInstallAttempt(attempt)).toMatchObject({
			install: "failed",
		});
		expect(describeInstallAttempt(attempt).installReason).toContain(
			"network is unreachable",
		);

		safeSpawnAsync.mockResolvedValue(okResult);
		advance(FIRST_COOLDOWN_MS + 1);
		await tryLazyInstall("rubocop", cwd);
		expect(getLazyInstallAttempt("rubocop", cwd)?.outcome).toBe("succeeded");
	});

	it("feeds the rust-clippy runner's availability_decision (#1537 review F5)", async () => {
		// `getLazyInstallAttempt` is only worth having if something reads it. The
		// rust-clippy runner is the production consumer: when the post-install
		// re-probe still fails it records WHY, so "we ran `rustup component add` and
		// the network failed" reaches latency.log instead of a silent skip.
		const cwd = freshCwd();
		safeSpawnAsync.mockResolvedValue(failedResult);
		await tryLazyInstall("rust-clippy", cwd);

		const evidence = describeInstallAttempt(
			getLazyInstallAttempt("rust-clippy", cwd),
		);
		expect(evidence).toMatchObject({ install: "failed" });
		expect(evidence.installReason).toContain("network is unreachable");
		// The runner's own wiring — that it passes this into an
		// `availability_decision` — is asserted by driving the real runner in
		// `tests/clients/dispatch/runners/cwd-probe-latching.test.ts`.
	});

	it("does not record a trust denial, so a later grant retries", async () => {
		// #1350's invariant, restated against the new record: the trust gate is
		// re-evaluated per call and must never latch. `declined` is not written.
		const cwd = freshCwd();
		setProjectTrustState("untrusted");
		expect(await tryLazyInstall("rust-clippy", cwd)).toBe(false);
		expect(safeSpawnAsync).not.toHaveBeenCalled();
		expect(getLazyInstallAttempt("rust-clippy", cwd)).toBeUndefined();

		setProjectTrustState("trusted");
		safeSpawnAsync.mockResolvedValue(okResult);
		expect(await tryLazyInstall("rust-clippy", cwd)).toBe(true);
	});
});
