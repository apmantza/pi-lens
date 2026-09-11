/**
 * #1497 review round: the install-class retry ceiling is terminal for a
 * SESSION, not for the process.
 *
 * The first cut of #1497 latched `installExhausted` inside a latch that lives
 * on a process-lived client instance (`bootstrap.ts` builds the security-scan
 * clients once), and nothing re-armed it at `session_start`. A repaired network
 * plus a full session reset still read exhausted — the #1266/#1490/#1535 shape.
 *
 * These assert the re-arm at three levels: the latch, the govulncheck client
 * that owns one, and the degradation record whose lifetime has to match the
 * latch's (both clear at session start, so a second session can both retry the
 * install and report it again if it fails again).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Imported through the `.js` specifiers the CLIENTS use, deliberately: vitest
// treats `foo.ts` and `foo.js` as two module instances here, so a test that
// resets module-level state through the `.ts` specifier resets a copy nothing
// under test can see — and passes vacuously (defect shape 7).
import {
	createAvailabilityLatch,
	INSTALL_TRANSIENT_BASE_COOLDOWN_MS,
	INSTALL_TRANSIENT_COOLDOWNS_MS,
	INSTALL_TRANSIENT_MAX_ATTEMPTS,
	resetInstallRetryLatches,
} from "../../clients/dispatch/runners/utils/availability-policy.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";

const { logLatencySpy } = vi.hoisted(() => ({ logLatencySpy: vi.fn() }));

vi.mock("../../clients/latency-logger.js", async (importOriginal) => ({
	...(await importOriginal()),
	logLatency: logLatencySpy,
	getLastLoggedPhase: () => undefined,
}));

vi.mock("../../clients/safe-spawn.js", () => ({
	safeSpawn: vi.fn(() => ({ stdout: "", stderr: "", status: 1 })),
	safeSpawnAsync: vi.fn(async () => ({ stdout: "", stderr: "", status: 1 })),
}));

vi.mock("../../clients/sessionstart-logger.js", () => ({
	logSessionStart: vi.fn(),
}));

const timeoutResult = {
	stdout: "",
	stderr: "",
	status: null,
	error: new Error("Process timed out after 60000ms"),
	failure: "timeout",
	spawnFailure: { kind: "timeout" },
};

const missingResult = {
	stdout: "",
	stderr: "",
	status: null,
	error: Object.assign(new Error("spawn missing ENOENT"), { code: "ENOENT" }),
	failure: "spawn",
	spawnFailure: { kind: "tool-not-found" },
};

const INSTALL_MARK = { operationClass: "install" as const } satisfies {
	operationClass: "install";
};

async function spawnMock() {
	const mod = await import("../../clients/safe-spawn.js");
	return vi.mocked(mod.safeSpawnAsync);
}

/** govulncheck absent, the Go toolchain present, every `go install` timing out. */
function mockPerpetuallyTimingOutInstall(
	spawn: Awaited<ReturnType<typeof spawnMock>>,
): () => number {
	spawn.mockImplementation(async (cmd, args) => {
		const argv = Array.isArray(args) ? args.join(" ") : "";
		if (String(cmd) === "go" && argv.startsWith("version"))
			return { stdout: "go1.22.0", stderr: "", status: 0 } as never;
		if (String(cmd) === "go" && argv.startsWith("install"))
			return timeoutResult as never;
		return missingResult as never;
	});
	return () =>
		spawn.mock.calls.filter(
			([cmd, args]) =>
				String(cmd) === "go" && Array.isArray(args) && args[0] === "install",
		).length;
}

function decisions(): Record<string, unknown>[] {
	return logLatencySpy.mock.calls
		.map(([entry]) => entry as Record<string, unknown>)
		.filter((entry) => entry.phase === "availability_decision")
		.map((entry) => entry.metadata as Record<string, unknown>);
}

beforeEach(async () => {
	logLatencySpy.mockClear();
	(await spawnMock()).mockReset();
	resetDegradationLedger();
	resetInstallRetryLatches();
	vi.useFakeTimers({ toFake: ["Date"] });
});

afterEach(() => {
	vi.useRealTimers();
});

describe("install-class retry ceiling re-arms per session (#1497 review F1)", () => {
	it("re-arms an exhausted latch at the next session reset", () => {
		const latch = createAvailabilityLatch();
		for (let i = 1; i < INSTALL_TRANSIENT_MAX_ATTEMPTS; i += 1) {
			latch.noteUnavailable("transient", "probe-timeout", INSTALL_MARK);
		}
		expect(
			latch.noteUnavailable("transient", "probe-timeout", INSTALL_MARK),
		).toBe(0);
		expect(latch.isInstallExhausted()).toBe(true);

		// A repaired network and a full day change nothing WITHIN the session.
		vi.setSystemTime(new Date(Date.now() + 24 * 60 * 60 * 1000));
		expect(latch.read()).toBe(false);

		// The next session re-arms it: `read()` says "probe again", and the
		// ladder starts over from the base cooldown.
		resetInstallRetryLatches();
		expect(latch.read()).toBeNull();
		expect(latch.isInstallExhausted()).toBe(false);
		expect(
			latch.noteUnavailable("transient", "probe-timeout", INSTALL_MARK),
		).toBe(INSTALL_TRANSIENT_BASE_COOLDOWN_MS);
	});

	it("keeps a durable missing verdict across a session re-arm", () => {
		// The re-arm is scoped to install-class state. A genuinely absent tool is
		// still absent; clearing that verdict here would resurrect the probe storm
		// the durable latch exists to prevent.
		const latch = createAvailabilityLatch();
		latch.noteUnavailable("missing", "not-found");

		resetInstallRetryLatches();

		expect(latch.read()).toBe(false);
		expect(latch.getOutcome()).toBe("missing");
	});

	it("restarts the install ladder for a latch that had not yet exhausted it", () => {
		const latch = createAvailabilityLatch();
		expect(
			latch.noteUnavailable("transient", "probe-timeout", INSTALL_MARK),
		).toBe(INSTALL_TRANSIENT_COOLDOWNS_MS[0]);

		resetInstallRetryLatches();

		// Attempt counting is per session too, so the second session's first
		// install failure waits the base cooldown, not the escalated one.
		expect(
			latch.noteUnavailable("transient", "probe-timeout", INSTALL_MARK),
		).toBe(INSTALL_TRANSIENT_COOLDOWNS_MS[0]);
	});
});

describe("govulncheck install ceiling, end to end (#1497 review F1/F3/F7)", () => {
	async function exhaustTheCeiling(): Promise<{
		installCount: () => number;
		client: { ensureAvailable(): Promise<boolean> };
	}> {
		const spawn = await spawnMock();
		const totalInstalls = mockPerpetuallyTimingOutInstall(spawn);
		// Counted from here: a test may exhaust the ceiling twice (once per
		// simulated session) on the same spawn mock.
		const before = totalInstalls();
		const installCount = (): number => totalInstalls() - before;
		const { GovulncheckClient } =
			await import("../../clients/govulncheck-client.js");
		const client = new GovulncheckClient(false);
		for (const cooldown of [0, ...INSTALL_TRANSIENT_COOLDOWNS_MS]) {
			vi.setSystemTime(new Date(Date.now() + cooldown + 1));
			expect(await client.ensureAvailable()).toBe(false);
		}
		expect(installCount()).toBe(INSTALL_TRANSIENT_MAX_ATTEMPTS);
		return { installCount, client };
	}

	it("re-probes after a session reset instead of staying dead for the process", async () => {
		const { installCount, client } = await exhaustTheCeiling();

		// Within the session: no further compile, whatever the clock says.
		vi.setSystemTime(new Date(Date.now() + 24 * 60 * 60 * 1000));
		expect(await client.ensureAvailable()).toBe(false);
		expect(installCount()).toBe(INSTALL_TRANSIENT_MAX_ATTEMPTS);

		// New session, repaired network: the install runs again and succeeds.
		resetInstallRetryLatches();
		const spawn = await spawnMock();
		spawn.mockResolvedValue({
			stdout: "govulncheck v1.1.3",
			stderr: "",
			status: 0,
		} as never);
		expect(await client.ensureAvailable()).toBe(true);
	});

	it("records the exhaustion once, with a lifetime that matches the latch", async () => {
		await exhaustTheCeiling();

		const exhaustion = () =>
			getDegradationSummary().filter(
				(group) => group.kind === "install-retry-exhausted",
			);
		expect(exhaustion()).toHaveLength(1);
		expect(exhaustion()[0]?.count).toBe(1);
		expect(exhaustion()[0]?.latestReasons[0]?.subject).toBe("govulncheck");

		// The ledger and the latch clear at the same boundary (`session_start`
		// calls both), so a second session that fails again reports again rather
		// than going quiet behind a stale once-per-session gate.
		resetDegradationLedger();
		resetInstallRetryLatches();
		expect(exhaustion()).toHaveLength(0);

		await exhaustTheCeiling();
		expect(exhaustion()).toHaveLength(1);
	});

	it("writes a ceiling decision row that says who classified it, and why", async () => {
		await exhaustTheCeiling();

		const ceiling = decisions().filter(
			(row) => row.cause === "install-retry-exhausted",
		);
		expect(ceiling).toHaveLength(1);
		expect(ceiling[0]).toMatchObject({
			tool: "govulncheck",
			verdict: "unavailable",
			outcome: "transient",
			latched: true,
			// #1534's convention: a verdict the CALL SITE asserted says so, and
			// carries the install facts a reader would otherwise have to guess.
			classifiedBy: "caller",
		});
		expect(ceiling[0]?.retryAfterMs).toBeUndefined();
		const evidence = ceiling[0]?.evidence as Record<string, unknown>;
		expect(evidence).toMatchObject({
			command: "go install",
			install: "failed",
		});
		expect(String(evidence.installReason)).toContain("retries disabled");
	});
});
