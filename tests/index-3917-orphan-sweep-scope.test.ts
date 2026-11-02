/**
 * #3917: no test reaches the HOST process table through the orphan backstop.
 *
 * `index.ts` arms `scheduleUntrackedOrphanSweep` on every real primary
 * `session_start`. The sweep enumerates the machine's whole process table and
 * kills a foreign orphan whose owner is dead, and the #2042 kill guard then
 * fails the file at teardown although every test passed (the #3521 fork-tree
 * file, 2026-09-30). `tests/support/vitest-setup.ts` scopes the backstop's
 * `Name`-filtered table query to an empty table for every file; a suite that
 * needs the real table opts in with `vi.unmock("…/process-snapshot.js")`
 * (tests/clients/instance-reaper-unref.test.ts, whose real enumeration spawn
 * reds without it, is the no-drop witness for that arm).
 *
 * Recurrence this file pins: the scope silently stops covering the sweep (the
 * setup mock deleted, or `enumerateManagedProcesses` changing the column it
 * filters on) and the next real `session_start` in any of the 36 files that arm
 * the sweep enumerates the host again.
 *
 * This drives the real `index.ts` `session_start` and the real sweep body (lock,
 * stamp, enumeration, partition, outcome). The delay seam is the
 * scheduler's own: a wrapper hands the sweep a zero delay and its documented
 * `onComplete` observer. The only fake sits at the process boundary
 * (`child-unref.js`'s spawn): a process-listing spawn is recorded and answers
 * an empty table, so even a broken scope cannot hand a real host process to the
 * sweep's kill.
 */
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../clients/bootstrap.js", async () => {
	const { bootstrapSeamMock } = await import("./support/bootstrap-mock.js");
	return bootstrapSeamMock(async () => ({
		metricsClient: { reset: () => {} },
		todoScanner: {},
		biomeClient: { isAvailable: () => false },
		ruffClient: { isAvailable: () => false },
		knipClient: {
			isAvailable: () => false,
			analyze: async () => ({
				success: false,
				summary: "unavailable",
				issues: [],
			}),
		},
		jscpdClient: { isAvailable: () => false },
		depChecker: { isAvailable: () => false },
		testRunnerClient: { detectRunner: () => null },
		goClient: { isGoAvailableAsync: async () => false },
		rustClient: { isAvailableAsync: async () => false },
		agentBehaviorClient: {
			recordToolCall: () => {},
			formatWarnings: () => "",
		},
		complexityClient: {
			isSupportedFile: () => false,
			analyzeFile: () => null,
		},
	}));
});
// The sweep is armed by index.ts itself, not by the session handler.
vi.mock("../clients/runtime-session.js", () => ({
	handleSessionStart: async () => {},
}));

const seam = vi.hoisted(() => {
	let complete: (outcome: string) => void = () => {};
	return {
		/** Settles with the backstop sweep's outcome, via its `onComplete` seam. */
		completed: new Promise<string>((resolve) => {
			complete = resolve;
		}),
		complete: (outcome: string) => complete(outcome),
		/** Every process-listing spawn that reached the process boundary. */
		listings: [] as string[],
	};
});

vi.mock("../clients/instance-reaper.js", async (importOriginal) => {
	const original =
		await importOriginal<typeof import("../clients/instance-reaper.js")>();
	return {
		...original,
		scheduleUntrackedOrphanSweep: (
			_delayMs?: number,
			options: import("../clients/instance-reaper.js").BackstopSweepOptions = {},
		) =>
			original.scheduleUntrackedOrphanSweep(0, {
				...options,
				onComplete: (outcome) => {
					seam.complete(outcome);
					options.onComplete?.(outcome);
				},
			}),
	};
});

vi.mock("../clients/child-unref.js", async (importOriginal) => {
	const original =
		await importOriginal<typeof import("../clients/child-unref.js")>();
	return {
		...original,
		spawnCollectStdoutResult: (
			...args: Parameters<typeof original.spawnCollectStdoutResult>
		) => {
			const image = path.basename(args[0]).toLowerCase();
			if (image !== "ps" && image !== "powershell.exe") {
				return original.spawnCollectStdoutResult(...args);
			}
			seam.listings.push(image);
			return Promise.resolve({ stdout: "", status: "ok" as const });
		},
	};
});

import extension from "../index.js";
import { _resetSessionLifecycleForTests } from "../clients/session-lifecycle.js";
import {
	cleanupTestEnvironmentsDrained,
	setupTestEnvironment,
} from "./clients/test-utils.js";
import { endMockSessions } from "./support/mock-session-teardown.js";
import { createPiMock, makeCtx } from "./support/pi-mock.js";

const TMP_PREFIX = "pi-lens-3917-scope-";

describe("#3917 the default scope keeps the orphan sweep off the host process table", () => {
	let env: ReturnType<typeof setupTestEnvironment>;
	let previousHome: string | undefined;
	let previousDataDir: string | undefined;

	beforeEach(() => {
		_resetSessionLifecycleForTests();
		env = setupTestEnvironment(TMP_PREFIX);
		// The stamp, lock and registry of this file's sweep live in its own home:
		// a sibling's fresh stamp would answer `cooldown` with no scan at all.
		previousHome = process.env.PI_LENS_HOME;
		process.env.PI_LENS_HOME = path.join(env.tmpDir, "home");
		previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
	});

	afterEach(async () => {
		// #5146: end the session before the lifecycle state and the root go.
		await endMockSessions();
		if (previousHome === undefined) delete process.env.PI_LENS_HOME;
		else process.env.PI_LENS_HOME = previousHome;
		if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
		else process.env.PILENS_DATA_DIR = previousDataDir;
		_resetSessionLifecycleForTests();
		env.cleanup();
		await cleanupTestEnvironmentsDrained(TMP_PREFIX);
	});

	it("a real session_start's sweep runs to its end without reaching the process table", async () => {
		const pi = createPiMock();
		extension(pi.asExtensionAPI());
		await pi.emit(
			"session_start",
			{ reason: "startup" },
			makeCtx({ cwd: env.tmpDir, sessionId: "s-3917" }),
		);

		expect({ outcome: await seam.completed, listings: seam.listings }).toEqual({
			outcome: "clean",
			listings: [],
		});
	});
});
