/**
 * #1467 — a transient probe failure must not latch permanent unavailability.
 *
 * These assert the SHARED seam (`createAvailabilityChecker` + the availability
 * policy), which is what knip, madge, jscpd and every other spawn-probed client
 * resolve through. Per-client wiring is covered in
 * `availability-latching-clients.test.ts`.
 */

import * as os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	classifyProbeFailure,
	createAvailabilityLatch,
	describeUnavailability,
	HOST_STALL_COOLDOWN_MS,
	INSTALL_TRANSIENT_BASE_COOLDOWN_MS,
	INSTALL_TRANSIENT_MAX_ATTEMPTS,
	installRetryDelayMs,
	startHostStallSampler,
	TRANSIENT_BASE_COOLDOWN_MS,
	TRANSIENT_MAX_COOLDOWN_MS,
	transientRetryDelayMs,
} from "../../../../clients/dispatch/runners/utils/availability-policy.js";
import {
	createAvailabilityChecker,
	resetDispatchAvailabilityState,
	resolveAvailableOrInstall,
} from "../../../../clients/dispatch/runners/utils/runner-helpers.js";

const { logLatencySpy } = vi.hoisted(() => ({ logLatencySpy: vi.fn() }));

vi.mock("../../../../clients/latency-logger.js", async (importOriginal) => ({
	...(await importOriginal()),
	logLatency: logLatencySpy,
	getLastLoggedPhase: () => undefined,
}));

vi.mock("../../../../clients/sessionstart-logger.js", () => ({
	logSessionStart: vi.fn(),
}));

vi.mock("../../../../clients/safe-spawn.js", () => ({
	safeSpawn: vi.fn(() => ({ stdout: "", stderr: "", status: 1 })),
	safeSpawnAsync: vi.fn(async () => ({ stdout: "", stderr: "", status: 1 })),
}));

vi.mock("../../../../clients/installer/index.js", () => ({
	// #2140: the probe resolver asks the installer for a release-managed
	// binary (`~/.pi-lens/bin`) before falling back to PATH. Undefined is
	// "no managed install", which is what these tests already assumed.
	findManagedToolBinary: vi.fn(async () => undefined),
	ensureTool: vi.fn(async () => null),
	getInstallAttempt: vi.fn(() => undefined),
	getLastEnsureResolutionSource: vi.fn(() => undefined),
	getToolInstallStrategy: vi.fn(() => undefined),
	isSpawnableCommand: vi.fn(async () => true),
	resetPathWalkMemo: vi.fn(),
	getToolEnvironment: vi.fn(async () => ({ ...process.env })),
}));

const timeoutResult = () => ({
	stdout: "",
	stderr: "",
	status: null,
	error: Object.assign(new Error("Process timed out after 5000ms"), {}),
	failure: "timeout" as const,
	spawnFailure: { kind: "timeout" } as never,
});

const missingResult = () => ({
	stdout: "",
	stderr: "",
	status: null,
	error: Object.assign(new Error("spawn missing ENOENT"), { code: "ENOENT" }),
	failure: "spawn" as const,
	spawnFailure: { kind: "tool-not-found" } as never,
});

const okResult = () => ({ stdout: "1.0.0", stderr: "", status: 0 });

const decisions = () =>
	logLatencySpy.mock.calls
		.map((call) => call[0])
		.filter((entry) => entry?.phase === "availability_decision");

describe("availability seam: transient failures do not latch (#1467)", () => {
	beforeEach(async () => {
		const safeSpawnMod = await import("../../../../clients/safe-spawn.js");
		vi.mocked(safeSpawnMod.safeSpawnAsync).mockReset();
		logLatencySpy.mockReset();
		resetDispatchAvailabilityState();
		vi.useFakeTimers({ toFake: ["Date"] });
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("re-probes after the cooldown and reports the tool available again", async () => {
		const safeSpawnMod = await import("../../../../clients/safe-spawn.js");
		vi.mocked(safeSpawnMod.safeSpawnAsync).mockResolvedValue(timeoutResult());
		const checker = createAvailabilityChecker("slowtool");

		expect(await checker.isAvailableAsync(process.cwd())).toBe(false);
		expect(checker.getOutcome(process.cwd())).toBe("transient");

		// Inside the cooldown the verdict is reused — no probe storm.
		expect(await checker.isAvailableAsync(process.cwd())).toBe(false);
		expect(safeSpawnMod.safeSpawnAsync).toHaveBeenCalledTimes(1);

		// After the cooldown the seam must ask again. On current (pre-fix) code
		// the cached `false` is permanent and this stays false forever.
		vi.setSystemTime(new Date(Date.now() + TRANSIENT_BASE_COOLDOWN_MS + 1));
		vi.mocked(safeSpawnMod.safeSpawnAsync).mockResolvedValue(okResult());
		expect(await checker.isAvailableAsync(process.cwd())).toBe(true);
		expect(safeSpawnMod.safeSpawnAsync).toHaveBeenCalledTimes(2);
		expect(checker.getOutcome(process.cwd())).toBe("success");
		expect(checker.getCommand(process.cwd())).toBe("slowtool");
	});

	it("still latches a genuine missing tool and never re-probes it", async () => {
		const safeSpawnMod = await import("../../../../clients/safe-spawn.js");
		vi.mocked(safeSpawnMod.safeSpawnAsync).mockResolvedValue(missingResult());
		const checker = createAvailabilityChecker("absenttool");

		expect(await checker.isAvailableAsync(process.cwd())).toBe(false);
		expect(checker.getOutcome(process.cwd())).toBe("missing");

		vi.setSystemTime(new Date(Date.now() + 10 * TRANSIENT_BASE_COOLDOWN_MS));
		expect(await checker.isAvailableAsync(process.cwd())).toBe(false);
		expect(safeSpawnMod.safeSpawnAsync).toHaveBeenCalledTimes(1);
		expect(checker.getVerdict(process.cwd())).toMatchObject({
			outcome: "missing",
			cause: "not-found",
			latched: true,
			retryAtMs: 0,
		});
	});

	it("escalates the cooldown so a sick machine is not re-probed every call", () => {
		expect(transientRetryDelayMs(1, "probe-timeout")).toBe(
			TRANSIENT_BASE_COOLDOWN_MS,
		);
		expect(transientRetryDelayMs(2, "probe-timeout")).toBe(
			TRANSIENT_BASE_COOLDOWN_MS * 2,
		);
		expect(transientRetryDelayMs(50, "probe-timeout")).toBe(300_000);
		// A host stall is not evidence about the tool, so its retry stays short
		// and never escalates.
		expect(transientRetryDelayMs(7, "host-stall")).toBe(HOST_STALL_COOLDOWN_MS);
	});

	it("gives install-class retries their own, much longer schedule (#1497)", () => {
		// The retried operation is a ≤60s network compile, not a 1.5–5s probe,
		// so the probe-class base/cap would run it at a ~20% duty cycle forever.
		expect(installRetryDelayMs(1)).toBe(INSTALL_TRANSIENT_BASE_COOLDOWN_MS);
		expect(installRetryDelayMs(2)).toBe(INSTALL_TRANSIENT_BASE_COOLDOWN_MS * 2);
		// The install base starts where the probe schedule tops out.
		expect(INSTALL_TRANSIENT_BASE_COOLDOWN_MS).toBeGreaterThanOrEqual(
			TRANSIENT_MAX_COOLDOWN_MS,
		);
	});

	it("owes no cooldown at or past the attempt ceiling (#1497 review F4)", () => {
		// The ceiling is DERIVED from the ladder, so every attempt the ladder does
		// not fund returns 0 — the same "latched, nothing will retry" signal
		// `noteUnavailable` returns. An earlier cut paired a doubling formula with
		// a 30-minute cap the 3-attempt ceiling could never reach, and a test
		// pinned that unreachable branch as if it were policy.
		expect(installRetryDelayMs(INSTALL_TRANSIENT_MAX_ATTEMPTS)).toBe(0);
		expect(installRetryDelayMs(50)).toBe(0);
		// Every attempt BELOW the ceiling is funded; the two numbers cannot drift.
		for (
			let attempt = 1;
			attempt < INSTALL_TRANSIENT_MAX_ATTEMPTS;
			attempt += 1
		) {
			expect(installRetryDelayMs(attempt)).toBeGreaterThan(0);
		}
	});

	it("writes one availability decision record per verdict", async () => {
		const safeSpawnMod = await import("../../../../clients/safe-spawn.js");
		vi.mocked(safeSpawnMod.safeSpawnAsync).mockResolvedValue(timeoutResult());
		const checker = createAvailabilityChecker(
			"telemetrytool",
			"",
			["--version"],
			{
				probeTimeout: 1500,
			},
		);

		await checker.isAvailableAsync(process.cwd());
		await checker.isAvailableAsync(process.cwd());

		// One decision, not one per call: the record marks a decision, not a hit.
		expect(decisions()).toHaveLength(1);
		expect(decisions()[0]).toMatchObject({
			type: "phase",
			phase: "availability_decision",
			metadata: {
				tool: "telemetrytool",
				verdict: "unavailable",
				outcome: "transient",
				cause: "probe-timeout",
				latched: false,
				retryAfterMs: TRANSIENT_BASE_COOLDOWN_MS,
				budgetMs: 1500,
			},
		});
		expect(decisions()[0].metadata.hostStallMs).toBeTypeOf("number");
	});

	it("resolves through a fastPath without spawning, and says so in telemetry", async () => {
		const safeSpawnMod = await import("../../../../clients/safe-spawn.js");
		const checker = createAvailabilityChecker("fasttool", "", ["--version"], {
			fastPath: () => "/managed/bin/fasttool",
		});

		expect(await checker.isAvailableAsync(process.cwd())).toBe(true);
		expect(safeSpawnMod.safeSpawnAsync).not.toHaveBeenCalled();
		expect(decisions()[0].metadata).toMatchObject({
			tool: "fasttool",
			verdict: "available",
			cause: "fast-path",
		});
	});
});

describe("availability policy: cause taxonomy and messages (#1467)", () => {
	it("blames the host, not the tool, when a stall overlapped the probe window", () => {
		// EXACT shape, including the `evidence` #1500 added: a `toMatchObject` here
		// would stop noticing a field that appears or disappears, which is the one
		// thing a classification pin is for.
		const timeoutEvidence = {
			status: null,
			failure: "timeout",
			spawnFailureKind: "timeout",
		};
		expect(classifyProbeFailure(timeoutResult(), { hostStallMs: 0 })).toEqual({
			outcome: "transient",
			cause: "probe-timeout",
			evidence: timeoutEvidence,
		});
		expect(
			classifyProbeFailure(timeoutResult(), { hostStallMs: 4618 }),
		).toEqual({
			outcome: "transient",
			cause: "host-stall",
			evidence: timeoutEvidence,
		});
		expect(
			classifyProbeFailure(missingResult(), { hostStallMs: 4618 }),
		).toEqual({
			outcome: "missing",
			cause: "not-found",
			evidence: {
				status: null,
				failure: "spawn",
				spawnFailureKind: "tool-not-found",
				errno: "ENOENT",
			},
		});
		// `command` is carried only when the caller names the spawn.
		expect(
			classifyProbeFailure(missingResult(), { command: "go" }).evidence.command,
		).toBe("go");
	});

	it("words a timed-out probe as a timeout, never as a missing install", () => {
		const transient = describeUnavailability({
			tool: "Knip",
			installHint: "npm install -D knip",
			outcome: "transient",
			cause: "probe-timeout",
			elapsedMs: 5528,
			retryAfterMs: 30_000,
		});
		expect(transient).toContain("timed out");
		expect(transient).toContain("5528ms");
		expect(transient).not.toContain("Install with");

		const missing = describeUnavailability({
			tool: "Knip",
			installHint: "npm install -D knip",
			outcome: "missing",
			cause: "not-found",
		});
		expect(missing).toBe(
			"Knip not available. Install with: npm install -D knip",
		);
	});

	it("names the host stall in the message when the loop, not the tool, stalled", () => {
		const message = describeUnavailability({
			tool: "Knip",
			installHint: "npm install -D knip",
			outcome: "transient",
			cause: "host-stall",
			elapsedMs: 5528,
		});
		expect(message).toContain("event loop stalled");
		expect(message).not.toContain("Install with");
	});

	it("measures a synchronous host block against the probe window", () => {
		vi.useRealTimers();
		const sampler = startHostStallSampler(50);
		const until = Date.now() + 600;
		while (Date.now() < until) {
			// Deliberate synchronous block: this is exactly what expires a
			// host-side probe budget while the child is still healthy.
		}
		expect(sampler.stop()).toBeGreaterThan(400);
	});

	// The test above never exercises the interval: nothing fires during a
	// synchronous block, so its whole figure comes from the tail computed in
	// stop(). Zeroing the interval's accumulation therefore leaves it green,
	// which would retire the sampler's entire reason for existing — and with
	// it the host-stall vs probe-timeout split that decides whether a verdict
	// latches. Here the loop RECOVERS before stop(), so the tail is negligible
	// and the figure can only come from the interval observing its own
	// lateness.
	it("attributes a stall the loop recovered from before the probe settled", async () => {
		vi.useRealTimers();
		const sampler = startHostStallSampler(50);
		const until = Date.now() + 400;
		while (Date.now() < until) {
			// Same deliberate block, but the sampler keeps running afterwards.
		}
		// Let the loop run quietly: the first tick after the block reports ~400ms
		// of lateness, and subsequent ticks are on time, so `last` ends up fresh.
		await new Promise((r) => setTimeout(r, 200));
		const stallMs = sampler.stop();
		expect(stallMs).toBeGreaterThan(300);
	});
});

describe("availability latch: shared client-side memo (#1467)", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"] });
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("returns null (re-probe) once a transient verdict's cooldown expires", () => {
		const latch = createAvailabilityLatch();
		expect(latch.read()).toBeNull();

		const delay = latch.noteUnavailable("transient", "probe-timeout");
		expect(delay).toBe(TRANSIENT_BASE_COOLDOWN_MS);
		expect(latch.read()).toBe(false);

		vi.setSystemTime(new Date(Date.now() + delay + 1));
		expect(latch.read()).toBeNull();
	});

	it("keeps a durable verdict for the whole session", () => {
		const latch = createAvailabilityLatch();
		expect(latch.noteUnavailable("missing", "not-found")).toBe(0);
		vi.setSystemTime(new Date(Date.now() + 3_600_000));
		expect(latch.read()).toBe(false);
		expect(latch.getCause()).toBe("not-found");
	});

	it("clears transient escalation once the tool answers", () => {
		const latch = createAvailabilityLatch();
		latch.noteUnavailable("transient", "probe-timeout");
		latch.noteAvailable();
		expect(latch.read()).toBe(true);
		expect(latch.noteUnavailable("transient", "probe-timeout")).toBe(
			TRANSIENT_BASE_COOLDOWN_MS,
		);
	});

	it("latches an install-class operation after the attempt ceiling (#1497)", () => {
		const latch = createAvailabilityLatch();
		const install = { operationClass: "install" as const };

		let delay = latch.noteUnavailable("transient", "probe-timeout", install);
		expect(delay).toBe(INSTALL_TRANSIENT_BASE_COOLDOWN_MS);
		expect(latch.read()).toBe(false);
		vi.setSystemTime(new Date(Date.now() + delay + 1));
		expect(latch.read()).toBeNull();

		delay = latch.noteUnavailable("transient", "probe-timeout", install);
		expect(delay).toBe(INSTALL_TRANSIENT_BASE_COOLDOWN_MS * 2);
		vi.setSystemTime(new Date(Date.now() + delay + 1));
		expect(latch.read()).toBeNull();

		// The third consecutive timeout reaches the ceiling: the verdict becomes
		// terminal for the session (a returned 0 means latched) and no cooldown
		// expiry ever re-arms it…
		expect(latch.noteUnavailable("transient", "probe-timeout", install)).toBe(
			0,
		);
		expect(INSTALL_TRANSIENT_MAX_ATTEMPTS).toBe(3);
		expect(latch.read()).toBe(false);
		vi.setSystemTime(new Date(Date.now() + 3_600_000));
		expect(latch.read()).toBe(false);

		// …but the recovery paths still work: a success re-arms the schedule.
		latch.noteAvailable();
		expect(latch.read()).toBe(true);
		expect(latch.noteUnavailable("transient", "probe-timeout", install)).toBe(
			INSTALL_TRANSIENT_BASE_COOLDOWN_MS,
		);
	});

	it("keeps install-class attempts independent of the probe-class schedule", () => {
		const latch = createAvailabilityLatch();
		latch.noteUnavailable("transient", "probe-timeout", {
			operationClass: "install",
		});
		// A probe-class failure on the same latch still gets the probe schedule,
		// unaffected by the install attempt that came before it.
		expect(latch.noteUnavailable("transient", "probe-timeout")).toBe(
			TRANSIENT_BASE_COOLDOWN_MS,
		);
	});

	it("never lets a probe failure shorten an install cooldown (#1497 review F2)", () => {
		const latch = createAvailabilityLatch();
		const installDelay = latch.noteUnavailable("transient", "probe-timeout", {
			operationClass: "install",
		});
		expect(installDelay).toBe(INSTALL_TRANSIENT_BASE_COOLDOWN_MS);
		const installGate = latch.getRetryAtMs();

		// A cheap `--version` probe fails while the install is still cooling. A
		// host stall gets the 5 s shortcut — correct for the probe, and fatal if it
		// reschedules the 60 s compile with it. Assert the GATE, not the returned
		// delay: the delay is right in both worlds.
		expect(latch.noteUnavailable("transient", "host-stall")).toBe(
			HOST_STALL_COOLDOWN_MS,
		);
		expect(latch.getRetryAtMs()).toBe(installGate);

		vi.setSystemTime(new Date(Date.now() + HOST_STALL_COOLDOWN_MS + 1));
		expect(latch.read()).toBe(false);
		vi.setSystemTime(new Date(installGate + 1));
		expect(latch.read()).toBeNull();
	});

	it("describes an exhausted ceiling honestly (#1497 review F5)", () => {
		const latch = createAvailabilityLatch();
		const install = { operationClass: "install" as const };
		for (let i = 1; i < INSTALL_TRANSIENT_MAX_ATTEMPTS; i += 1) {
			latch.noteUnavailable("transient", "probe-timeout", install);
		}
		expect(latch.noteUnavailable("transient", "probe-timeout", install)).toBe(
			0,
		);

		// The failures WERE transient, so the outcome stays transient — which is
		// why the cause has to carry the terminal-ness. Without it the message
		// below ends in "It will be retried", and nothing will.
		expect(latch.getCause()).toBe("install-retry-exhausted");
		const message = describeUnavailability({
			tool: "govulncheck",
			installHint: "go install golang.org/x/vuln/cmd/govulncheck@latest",
			outcome: latch.getOutcome(),
			cause: latch.getCause(),
		});
		expect(message).not.toContain("It will be retried");
		expect(message).toMatch(/retry ceiling/i);
		expect(message).toContain("next session");
	});
});

/**
 * #1612 — class sibling of #1606: `resolveAvailableOrInstallUnshared` backs
 * `resolveAvailableOrInstall`, the seam shared by ~16 runners (golangci-lint,
 * ruff, shellcheck, pyright, knip, jscpd, …). When the PATH probe misses but
 * the installer then resolves the binary, the probe's latched `unavailable`
 * row stood alone: nothing recorded the recovery.
 *
 * Review round F1-F4: the first pass hand-picked `source: "managed-dir"` for
 * every tool, asserted `install: "succeeded"` unconditionally, and claimed
 * `latched: true` right after clearing the checker's own cache. This block
 * replaces that with one case per installer strategy the registry actually
 * uses behind this seam, derives the `install`/`resolved` evidence from
 * `getInstallAttempt` instead of asserting it, asserts the honest `latched:
 * false`, and covers the once-per-correction and failure-path angles the
 * first pass missed.
 */
async function installerMocks() {
	return import("../../../../clients/installer/index.js");
}

describe.each([
	{ tool: "jscpd", strategy: "npm", source: "managed-dir" },
	{ tool: "ruff", strategy: "pip", source: "pip-user" },
	{ tool: "golangci-lint", strategy: "github", source: "github-release" },
	{ tool: "spotbugs", strategy: "archive", source: "archive-dist" },
	{ tool: "ktfmt", strategy: "maven", source: "maven-jar" },
] as const)(
	"resolveAvailableOrInstall compensating row: %s (#1612)",
	({ tool, strategy, source }) => {
		beforeEach(async () => {
			const safeSpawnMod = await import("../../../../clients/safe-spawn.js");
			const installerMod = await installerMocks();
			vi.mocked(safeSpawnMod.safeSpawnAsync).mockReset();
			vi.mocked(installerMod.ensureTool).mockReset();
			vi.mocked(installerMod.getInstallAttempt).mockReset();
			vi.mocked(installerMod.getToolInstallStrategy).mockReset();
			vi.mocked(installerMod.isSpawnableCommand).mockReset();
			vi.mocked(installerMod.isSpawnableCommand).mockResolvedValue(true);
			vi.mocked(installerMod.getToolInstallStrategy).mockImplementation(
				(id: string) => (id === tool ? strategy : undefined),
			);
			logLatencySpy.mockReset();
			resetDispatchAvailabilityState();
		});

		it(`emits a compensating available row tagged "${source}" when ensureTool runs a real install`, async () => {
			const safeSpawnMod = await import("../../../../clients/safe-spawn.js");
			const installerMod = await installerMocks();
			vi.mocked(safeSpawnMod.safeSpawnAsync).mockResolvedValue(missingResult());
			vi.mocked(installerMod.ensureTool).mockResolvedValue(
				`/managed/bin/${tool}`,
			);
			// A REAL install just ran this call — the honest case for
			// `install: "succeeded"` (#1612 review F2).
			vi.mocked(installerMod.getInstallAttempt).mockReturnValue({
				outcome: "succeeded",
				at: Date.now(),
			});
			const checker = createAvailabilityChecker(tool);

			const resolved = await resolveAvailableOrInstall(
				checker,
				tool,
				process.cwd(),
			);

			expect(resolved).toBe(`/managed/bin/${tool}`);
			const records = decisions();
			expect(records).toHaveLength(2);

			expect(records[0].metadata).toMatchObject({
				tool,
				verdict: "unavailable",
				outcome: "missing",
				cause: "not-found",
				classifiedBy: "probe",
			});

			// The compensating row requires: the installer resolved the tool after
			// the probe latched it absent, so a second row must say so — with the
			// `source` tag DERIVED from the registry's own strategy for this tool
			// (#1612 review F1), not a hand-picked constant.
			expect(records[1].metadata).toMatchObject({
				tool,
				verdict: "available",
				outcome: "success",
				cause: "ok",
				classifiedBy: "caller",
				// checker.reset() just cleared the cache; nothing is held pinned the
				// instant this row is written (#1612 review F3).
				latched: false,
				evidence: {
					install: "succeeded",
					binary: tool,
					source,
				},
			});

			// Explicit latch/log agreement (#1610 review angle 1, reapplied here):
			// the value the ~16 callers act on and the verdict this row logs must
			// say the same thing.
			expect(Boolean(resolved)).toBe(
				records[1].metadata.verdict === "available",
			);
		});
	},
);

describe("resolveAvailableOrInstall compensating row: once per correction (#1612 review F2)", () => {
	beforeEach(async () => {
		const safeSpawnMod = await import("../../../../clients/safe-spawn.js");
		const installerMod = await installerMocks();
		vi.mocked(safeSpawnMod.safeSpawnAsync).mockReset();
		vi.mocked(installerMod.ensureTool).mockReset();
		vi.mocked(installerMod.getInstallAttempt).mockReset();
		vi.mocked(installerMod.getToolInstallStrategy).mockReset();
		vi.mocked(installerMod.isSpawnableCommand).mockReset();
		vi.mocked(installerMod.isSpawnableCommand).mockResolvedValue(true);
		vi.mocked(installerMod.getToolInstallStrategy).mockReturnValue("pip");
		logLatencySpy.mockReset();
		resetDispatchAvailabilityState();
	});

	it("logs exactly one available row across three sequential calls, and a cache-only recovery never claims succeeded", async () => {
		const safeSpawnMod = await import("../../../../clients/safe-spawn.js");
		const installerMod = await installerMocks();
		// Every probe misses, every call: `checker.reset()` clears the cache on
		// each recovery, so the NEXT call re-probes PATH from scratch and misses
		// again for a managed-dir-only install (the separate createVenvFinder
		// bug). That must not read as three fresh corrections.
		vi.mocked(safeSpawnMod.safeSpawnAsync).mockResolvedValue(missingResult());
		vi.mocked(installerMod.ensureTool).mockResolvedValue("/managed/bin/ruff");
		// Only the FIRST call's `ensureTool` actually ran an install; calls 2 and
		// 3 resolve from the installer's own cache with no fresh attempt —
		// `getInstallAttempt` answers accordingly.
		vi.mocked(installerMod.getInstallAttempt)
			.mockReturnValueOnce({ outcome: "succeeded", at: Date.now() })
			.mockReturnValue(undefined);
		const checker = createAvailabilityChecker("ruff");
		const cwd = process.cwd();

		const first = await resolveAvailableOrInstall(checker, "ruff", cwd);
		const second = await resolveAvailableOrInstall(checker, "ruff", cwd);
		const third = await resolveAvailableOrInstall(checker, "ruff", cwd);

		expect([first, second, third]).toEqual(Array(3).fill("/managed/bin/ruff"));

		const available = decisions().filter(
			(record) => record.metadata.verdict === "available",
		);
		// Pre-fix, this was 3 (one per call, every one dishonestly claiming
		// `install: "succeeded"`). Fixed, it is exactly 1 — the genuine
		// correction — even though the caller keeps getting a resolved path on
		// every call.
		expect(available).toHaveLength(1);
		expect(available[0].metadata.evidence).toMatchObject({
			install: "succeeded",
		});
	});

	it("tags a cache-resolved correction as not-attempted, never succeeded", async () => {
		// A DIFFERENT cwd's first-ever correction for this tool, after some
		// other cwd already installed it this session: `ensureTool` resolves it
		// from its own cache (no fresh attempt), so this is a genuine new
		// correction for THIS cwd, but the evidence must not claim an install
		// that didn't happen here.
		const safeSpawnMod = await import("../../../../clients/safe-spawn.js");
		const installerMod = await installerMocks();
		vi.mocked(safeSpawnMod.safeSpawnAsync).mockResolvedValue(missingResult());
		vi.mocked(installerMod.ensureTool).mockResolvedValue("/managed/bin/ruff");
		vi.mocked(installerMod.getInstallAttempt).mockReturnValue(undefined);
		const checker = createAvailabilityChecker("ruff");

		// Must be a REAL, existing directory: the checker's probe path does a
		// `fs.stat` on `cwd` first and reads a nonexistent one as "bad cwd", not
		// "missing tool" — a different, non-installable outcome entirely.
		const otherCwd = os.tmpdir();
		const resolved = await resolveAvailableOrInstall(checker, "ruff", otherCwd);

		expect(resolved).toBe("/managed/bin/ruff");
		const available = decisions().filter(
			(record) => record.metadata.verdict === "available",
		);
		expect(available).toHaveLength(1);
		expect(available[0].metadata.evidence).toMatchObject({
			install: "not-attempted",
			resolved: "cache",
			binary: "ruff",
		});
		expect(available[0].metadata.evidence).not.toHaveProperty(
			"install",
			"succeeded",
		);
	});
});

describe("resolveAvailableOrInstall compensating row: failure path agreement (#1612 review F4)", () => {
	beforeEach(async () => {
		const safeSpawnMod = await import("../../../../clients/safe-spawn.js");
		const installerMod = await installerMocks();
		vi.mocked(safeSpawnMod.safeSpawnAsync).mockReset();
		vi.mocked(installerMod.ensureTool).mockReset();
		vi.mocked(installerMod.getInstallAttempt).mockReset();
		vi.mocked(installerMod.getToolInstallStrategy).mockReset();
		vi.mocked(installerMod.isSpawnableCommand).mockReset();
		vi.mocked(installerMod.isSpawnableCommand).mockResolvedValue(true);
		logLatencySpy.mockReset();
		resetDispatchAvailabilityState();
	});

	it("logs no available row when the probe misses and the install ALSO fails", async () => {
		// The #1610-review angle 1 agreement check is vacuous if it only ever
		// exercises the success path (`true === true` by construction). This
		// covers the other half: a falsy `resolved` must correspond to no
		// `available` row at all, not just a differently-worded one.
		const safeSpawnMod = await import("../../../../clients/safe-spawn.js");
		const installerMod = await installerMocks();
		vi.mocked(safeSpawnMod.safeSpawnAsync).mockResolvedValue(missingResult());
		vi.mocked(installerMod.ensureTool).mockResolvedValue(undefined);
		const checker = createAvailabilityChecker("ruff");

		const resolved = await resolveAvailableOrInstall(
			checker,
			"ruff",
			process.cwd(),
		);

		expect(resolved).toBeNull();
		const records = decisions();
		const available = records.filter(
			(record) => record.metadata.verdict === "available",
		);
		expect(Boolean(resolved)).toBe(available.length > 0);
		expect(available).toHaveLength(0);
		expect(
			records.some((record) => record.metadata.verdict === "unavailable"),
		).toBe(true);
	});
});
