// flake-shape: real-process-spawn — the subject is `npm run lane:check`'s own
// process contract: the real CLI drives the real pre-push selector, the real
// red-on-base and real vitest over a real Git fixture, and the verdict and
// exit code are what a delegated lane acts on. An in-process stub would restate
// the transcripts the verdict is parsed from instead of proving the parse.
// lane: ubuntu Unit tests (POSIX sh git shim, TMPDIR-derived scratch root).
// Split out of lane-check.test.ts for #3801: the held-lock cases and the dirty-tree cases.
import { acquireTestLock, getLockPath } from "../../scripts/lib/suite-lock.mjs";
import { describe, expect, it } from "vitest";

import {
	useLaneCleanups,
	GREEN,
	RED,
	FIRST_RUN_ONLY,
	BASE_FILES,
	makeLane,
	type Lane,
	runLane,
	TIMEOUT,
} from "../support/lane-check-kit.js";

useLaneCleanups();

describe("lane-check verdict table (#4047 round 2)", () => {
	describe("a held exclusive test lock", () => {
		async function withExclusiveLock<T>(lane: Lane, body: () => T) {
			const previous = process.env.PI_LENS_HOME;
			process.env.PI_LENS_HOME = lane.home;
			const exclusive = await acquireTestLock({
				lockPath: getLockPath(),
				slots: 2,
				pollIntervalMs: 10,
				heartbeatIntervalMs: 5_000,
			});
			try {
				return body();
			} finally {
				await exclusive.release();
				if (previous === undefined) delete process.env.PI_LENS_HOME;
				else process.env.PI_LENS_HOME = previous;
			}
		}

		it(
			"targeted selector failure with no attributable file: unproven, exit 3",
			async () => {
				const lane = makeLane({
					base: BASE_FILES,
					head: { "tests/config/added.test.ts": GREEN },
				});
				const run = await withExclusiveLock(lane, () =>
					runLane(lane, { PI_LENS_TEST_LOCK_TIMEOUT_MS: "300" }),
				);
				expect(run.status).toBe(3);
				expect(run.record.verdict).toBe("unproven");
				expect(run.record.checks.targeted.status).not.toBe(0);
				expect(run.record.checks.targeted.failed).toEqual([]);
				expect(
					run.record.findings.map((f: { reason: string }) => f.reason),
				).toEqual(
					expect.arrayContaining([
						expect.stringMatching(
							/^targeted run: exit \d+ and no failing test file/,
						),
					]),
				);
			},
			TIMEOUT,
		);

		it(
			"unparsable governance failure (the selector ran clean): unproven, exit 3",
			async () => {
				// A docs-only change selects no test, so only the governance batch
				// needs the lock and fails without naming a file.
				const lane = makeLane({
					base: BASE_FILES,
					head: { "docs/note.md": "# note\n" },
				});
				const run = await withExclusiveLock(lane, () =>
					runLane(lane, { PI_LENS_TEST_LOCK_TIMEOUT_MS: "300" }),
				);
				expect(run.status).toBe(3);
				expect(run.record.checks.targeted.status).toBe(0);
				expect(run.record.checks.governance.status).not.toBe(0);
				const reasons = run.record.findings.map(
					(f: { reason: string }) => f.reason,
				);
				expect(reasons).toEqual([
					expect.stringMatching(
						/^governance run: exit \d+ and no failing test file/,
					),
				]);
			},
			TIMEOUT,
		);
	});

	// Recurrence (#4047 review H3): a grant-none lane leaves its change
	// uncommitted, and the gate diffed only committed ranges.
	it(
		"uncommitted edit to a tracked file that reds: red-caused, exit 1",
		() => {
			const lane = makeLane({
				base: BASE_FILES,
				edits: { "clients/foo.ts": "export const value = 2;\n" },
			});
			const run = runLane(lane);
			expect(run.status).toBe(1);
			expect(run.record.verdict).toBe("red-caused");
			expect(run.record.failedFiles).toEqual([
				{ file: "tests/clients/foo.test.ts", verdict: "CAUSED-BY-CHANGE" },
			]);
			expect(run.record.uncommitted).toBe(1);
		},
		TIMEOUT,
	);

	it(
		"untracked test file that reds: red-caused, exit 1",
		() => {
			const lane = makeLane({
				base: BASE_FILES,
				untracked: { "tests/clients/fresh.test.ts": RED },
			});
			const run = runLane(lane);
			expect(run.status).toBe(1);
			expect(run.record.failedFiles).toEqual([
				{ file: "tests/clients/fresh.test.ts", verdict: "CAUSED-BY-CHANGE" },
			]);
		},
		TIMEOUT,
	);

	it(
		"dirty tree with no red: clean, exit 0, uncommitted is reported and a detached HEAD says so",
		() => {
			const lane = makeLane({
				base: { ...BASE_FILES, "docs/note.md": "# note\n" },
				edits: { "docs/note.md": "# note\n\nmore\n" },
				untracked: { "scratch.txt": "x\n" },
				detach: true,
			});
			const run = runLane(lane);
			expect(run.status).toBe(0);
			expect(run.record.verdict).toBe("clean");
			expect(run.record.uncommitted).toBe(2);
			expect(run.out).toContain("uncommitted: 2 file(s)");
			expect(run.out).toContain("branch: (detached)");
		},
		TIMEOUT,
	);

	it(
		"a red that does not reproduce under red-on-base is unproven, never clean",
		() => {
			const lane = makeLane({
				base: BASE_FILES,
				head: { "tests/clients/flaky.test.ts": FIRST_RUN_ONLY },
			});
			const run = runLane(lane);
			expect(run.status).toBe(3);
			expect(run.record.verdict).toBe("unproven");
			expect(run.record.failedFiles).toEqual([
				{ file: "tests/clients/flaky.test.ts", verdict: "INCONCLUSIVE" },
			]);
			expect(run.out).toContain("INCONCLUSIVE: 1 (not evidence of unrelated)");
		},
		TIMEOUT,
	);
});
