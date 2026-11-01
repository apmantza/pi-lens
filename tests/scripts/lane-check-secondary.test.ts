// flake-shape: real-process-spawn — the subject is `npm run lane:check`'s own
// process contract: the real CLI drives the real pre-push selector, the real
// red-on-base and real vitest over a real Git fixture, and the verdict and
// exit code are what a delegated lane acts on. An in-process stub would restate
// the transcripts the verdict is parsed from instead of proving the parse.
// lane: ubuntu Unit tests (POSIX sh git shim, TMPDIR-derived scratch root).
// Split out of lane-check.test.ts for #3801: the secondary-check, transcript-size, cap, usage and handoff cases.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
	useLaneCleanups,
	type Files,
	packageJson,
	FOO_TEST,
	BASE_FILES,
	makeLane,
	runLane,
	TIMEOUT,
} from "../support/lane-check-kit.js";

useLaneCleanups();

describe("lane-check verdict table (#4047 round 2)", () => {
	it(
		"a failed secondary check (oxfmt) is unproven, exit 3, with every test green",
		() => {
			const lane = makeLane({
				base: BASE_FILES,
				head: { "clients/unformatted.ts": "export   const   x=1\n" },
			});
			const run = runLane(lane);
			expect(run.status).toBe(3);
			expect(run.record.verdict).toBe("unproven");
			expect(run.record.failedFiles).toEqual([]);
			expect(run.record.checks.format).not.toBe(0);
			expect(run.record.findings).toEqual([
				{
					kind: "unproven",
					reason: expect.stringMatching(/^check format failed \(exit \d+\)$/),
				},
			]);
		},
		TIMEOUT,
	);

	// #4344 r2: a declared-client-leaf violation redded CI's Dependency
	// boundaries job after a lane:check that never ran the cruise.
	it(
		"a failed dependency-boundary check is unproven, exit 3, with every test green",
		() => {
			const lane = makeLane({
				base: BASE_FILES,
				head: { "package.json": packageJson(0, 0, 1) },
			});
			const run = runLane(lane);
			expect(run.status).toBe(3);
			expect(run.record.checks.depcruise).toBe(1);
			expect(run.record.findings).toContainEqual({
				kind: "unproven",
				reason: "check depcruise failed (exit 1)",
			});
		},
		TIMEOUT,
	);

	it(
		"an unformatted untracked file is checked too: unproven, exit 3",
		() => {
			const lane = makeLane({
				base: BASE_FILES,
				untracked: { "clients/unformatted.ts": "export   const   x=1\n" },
			});
			const run = runLane(lane);
			expect(run.status).toBe(3);
			expect(run.record.checks.format).not.toBe(0);
		},
		TIMEOUT,
	);

	// Recurrence: spawnSync's 1 MiB default kills the child on a long
	// transcript, which then reads as a failed run with no named file.
	it(
		"a green run whose transcript is over 1 MiB is still clean",
		() => {
			const lane = makeLane({
				base: BASE_FILES,
				head: {
					"tests/config/noisy.test.ts":
						'import { it } from "vitest";\nit("noisy", () => {\n\tprocess.stdout.write("x".repeat(1_500_000));\n});\n',
				},
			});
			const run = runLane(lane);
			expect(run.out.length).toBeGreaterThan(1_048_576);
			expect(run.status).toBe(0);
			expect(run.record.verdict).toBe("clean");
		},
		TIMEOUT,
	);

	// Recurrence (#4074 verify r2 F1): one comment line in a hub file matched 144
	// test files, the selector ran only the governance registries and exited 0,
	// and lane:check printed `verdict: clean`. Since #4489 the capped run also
	// keeps the change's own tests and the best 25 import matches; it is still
	// unproven, because the matches past the cap did not run.
	it(
		"a capped selection is unproven, never clean, and says what ran",
		() => {
			const many: Files = {};
			for (let i = 0; i < 26; i += 1)
				many[`tests/clients/many-${i}.test.ts`] = FOO_TEST;
			const lane = makeLane({
				base: { ...BASE_FILES, ...many },
				head: { "clients/foo.ts": "export const value = 1; // touched\n" },
			});
			const run = runLane(lane);
			expect(run.status).toBe(3);
			expect(run.record.verdict).toBe("unproven");
			expect(run.record.checks.targeted).toEqual({
				status: 0,
				failed: [],
				selected: 26,
				matched: 27,
				capped: true,
			});
			expect(run.record.findings).toEqual([
				{
					kind: "unproven",
					reason:
						"selection capped: 27 test files matched, 26 ran; run the full suite or narrow the change",
				},
			]);
			expect(run.out).toContain(
				"selection: selected 26, matched 27, capped true",
			);
			expect(run.out).toContain(
				"selection capped: run the full suite or narrow the change",
			);
		},
		TIMEOUT,
	);

	// Recurrence (#4074 verify r2 F2a): `--body` with no path silently skipped
	// the body lint and the lane could still read clean.
	it(
		"--body with no path is a usage error: exit 2, and no step runs",
		() => {
			const lane = makeLane({ base: BASE_FILES });
			const run = runLane(lane, {}, ["--body"]);
			expect(run.status).toBe(2);
			expect(run.out).toContain("lane-check: --body needs a file path");
			expect(run.record).toBeUndefined();
			expect(fs.existsSync(path.join(lane.home, "builds.log"))).toBe(false);
		},
		TIMEOUT,
	);

	// Recurrence (#4074 verify r3 F3/F4): `--body=/nonexistent` was not a
	// recognised spelling, so the lane ran on and silently skipped the lint.
	it.each([
		[["--body", "--other"], "lane-check: --body needs a file path"],
		[["--body="], "lane-check: --body needs a file path"],
		[["--body=/nonexistent/body.md"], "lane-check: --body file does not exist"],
		[
			["--body", "/nonexistent/body.md"],
			"lane-check: --body file does not exist",
		],
		[["--bodyx", "body.md"], "lane-check: unknown argument --bodyx"],
	])(
		"a bad body argument %j is a usage error: exit 2, and no step runs",
		(args, message) => {
			const lane = makeLane({ base: BASE_FILES });
			const run = runLane(lane, {}, args);
			expect(run.status).toBe(2);
			expect(run.out).toContain(message);
			expect(run.record).toBeUndefined();
			expect(fs.existsSync(path.join(lane.home, "builds.log"))).toBe(false);
		},
		TIMEOUT,
	);

	it.each(["--body", "--body="])(
		"%s <path> is accepted in both spellings and the body lint runs",
		(flag) => {
			const lane = makeLane({ base: BASE_FILES });
			const body = path.join(lane.tmp, "body.md");
			fs.writeFileSync(body, "## Why\n\nx\n");
			const args = flag === "--body" ? [flag, body] : [`${flag}${body}`];
			const run = runLane(lane, {}, args);
			// The fixture body is not a valid PR body: the lint ran and failed.
			expect(run.record.checks.body).not.toBeNull();
			expect(run.record.checks.body).not.toBe(0);
			expect(run.status).toBe(3);
		},
		TIMEOUT,
	);

	it(
		"a tracked root handoff file is red-caused, exit 1",
		() => {
			const lane = makeLane({
				base: BASE_FILES,
				head: { "PR_BODY.md": "body\n" },
			});
			const run = runLane(lane);
			expect(run.status).toBe(1);
			expect(run.record.verdict).toBe("red-caused");
			expect(run.record.findings).toEqual([
				{
					kind: "red-caused",
					reason: "root handoff file is tracked: PR_BODY.md",
				},
			]);
		},
		TIMEOUT,
	);
});
