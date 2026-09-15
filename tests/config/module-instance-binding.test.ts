/**
 * #1565 — the live demonstration behind the guard in
 * module-instance-coverage.test.ts.
 *
 * `resetDispatchAvailabilityState` is the session reset the availability tests
 * call in `beforeEach`. It works by bumping a module-level generation counter
 * that every checker compares itself against. Import it through
 * `runner-helpers.ts` and vitest hands back a SECOND instance of that module:
 * the reset bumps the copy's counter, the compiled checker keeps reading the
 * compiled counter, and the latch the reset was supposed to clear survives.
 *
 * This test asserts the reset actually clears state the COMPILED checker holds.
 * To reproduce the failure it guards against, re-spell the RESET import below —
 * the second of the two, on its own line for exactly this reason — as
 * `runner-helpers.ts`, leaving the checker's import on `.js`. The last
 * assertion goes red: that is the failure every `.ts`-bound reset in the suite
 * was declining to notice.
 *
 * The two imports are deliberately NOT merged into one statement. Re-spelling a
 * combined import would move the checker onto the `.ts` instance along with the
 * reset, leaving the pair self-consistent and the test green — the same
 * accidental consistency that let 36 all-`.ts` test files look fine on master.
 * The hazard is the MIX, so the demonstration has to be able to spell a mix.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TRANSIENT_BASE_COOLDOWN_MS } from "../../clients/dispatch/runners/utils/availability-policy.js";
// The code under test. Keep this one `.js` when reproducing.
import { createAvailabilityChecker } from "../../clients/dispatch/runners/utils/runner-helpers.js";
// The reset under demonstration. Re-spell THIS one `.ts` to reproduce red.
import { resetDispatchAvailabilityState } from "../../clients/dispatch/runners/utils/runner-helpers.js";

vi.mock("../../clients/latency-logger.js", async (importOriginal) => ({
	...(await importOriginal()),
	logLatency: vi.fn(),
	getLastLoggedPhase: () => undefined,
}));

vi.mock("../../clients/sessionstart-logger.js", () => ({
	logSessionStart: vi.fn(),
}));

vi.mock("../../clients/safe-spawn.js", () => ({
	safeSpawn: vi.fn(() => ({ stdout: "", stderr: "", status: 1 })),
	safeSpawnAsync: vi.fn(async () => ({ stdout: "", stderr: "", status: 1 })),
}));

vi.mock("../../clients/installer/index.js", () => ({
	// #2140: the probe resolver asks the installer for a release-managed
	// binary (`~/.pi-lens/bin`) before falling back to PATH. Undefined is
	// "no managed install", which is what these tests already assumed.
	findManagedToolBinary: vi.fn(async () => undefined),
	ensureTool: vi.fn(async () => null),
	isSpawnableCommand: vi.fn(async () => true),
	resetPathWalkMemo: vi.fn(),
	getToolEnvironment: vi.fn(async () => ({ ...process.env })),
}));

const missingResult = () => ({
	stdout: "",
	stderr: "",
	status: null,
	error: Object.assign(new Error("spawn missing ENOENT"), { code: "ENOENT" }),
	failure: "spawn" as const,
	spawnFailure: { kind: "tool-not-found" } as never,
});

const okResult = () => ({ stdout: "1.0.0", stderr: "", status: 0 });

async function spawnMock() {
	const mod = await import("../../clients/safe-spawn.js");
	return vi.mocked(mod.safeSpawnAsync);
}

describe("session reset binds the compiled module instance (#1565)", () => {
	beforeEach(async () => {
		(await spawnMock()).mockReset();
		resetDispatchAvailabilityState();
		vi.useFakeTimers({ toFake: ["Date"] });
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("clears a latched missing verdict the compiled checker is holding", async () => {
		const spawn = await spawnMock();
		spawn.mockResolvedValue(missingResult());
		const checker = createAvailabilityChecker("pi-lens-1565-absent-tool");

		expect(await checker.isAvailableAsync(process.cwd())).toBe(false);
		expect(checker.getOutcome(process.cwd())).toBe("missing");

		// A missing verdict is durable for the session: the tool is now on the
		// machine and time has passed, and the seam still must not re-probe.
		spawn.mockResolvedValue(okResult());
		vi.setSystemTime(new Date(Date.now() + 10 * TRANSIENT_BASE_COOLDOWN_MS));
		expect(await checker.isAvailableAsync(process.cwd())).toBe(false);
		expect(spawn).toHaveBeenCalledTimes(1);

		// Only the session reset clears it — and only if the reset the test holds
		// is the compiled module's reset, not a `.ts` duplicate's.
		resetDispatchAvailabilityState();
		expect(await checker.isAvailableAsync(process.cwd())).toBe(true);
		expect(spawn).toHaveBeenCalledTimes(2);
	});
});
