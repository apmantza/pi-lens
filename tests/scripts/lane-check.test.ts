// flake-shape: real-process-spawn — the subject is `npm run lane:check`'s own
// process contract: the real CLI drives the real pre-push selector, the real
// red-on-base and real vitest over a real Git fixture, and the verdict and
// exit code are what a delegated lane acts on. An in-process stub would restate
// the transcripts the verdict is parsed from instead of proving the parse.
// lane: ubuntu Unit tests (POSIX sh git shim, TMPDIR-derived scratch root).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	decideLane,
	laneExitCode,
	reportedFailureFiles,
	unattributedFailure,
} from "../../scripts/lane-check.mjs";
import { acquireTestLock, getLockPath } from "../../scripts/lib/suite-lock.mjs";
import { setupTestEnvironment } from "../clients/test-utils.js";
import { gitExecFileSync, gitFixtureEnv } from "../support/git-fixture-env.js";

const LANE_CHECK = path.resolve("scripts/lane-check.mjs");
const REAL_SCRIPTS = path.resolve("scripts");
const REAL_NODE_MODULES = path.resolve("node_modules");
const OXFMTRC = path.resolve(".oxfmtrc.json");
const FIXTURES = path.resolve("tests/scripts/fixtures");

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

type Files = Record<string, string>;
type LaneSpec = {
	/** Committed at origin/master. */
	base: Files;
	/** Committed on top of the base (the lane's own commit). */
	head?: Files;
	/** Uncommitted edits to tracked files. */
	edits?: Files;
	/** Untracked files. */
	untracked?: Files;
	detach?: boolean;
};

const packageJson = (buildExit = 0, distBuildExit = 0) =>
	JSON.stringify({
		name: "lane-fixture",
		private: true,
		scripts: {
			// BUILD_LOG counts builds: lane-check builds once, not once more in the selector.
			build: `node -e "process.env.BUILD_LOG && require('fs').appendFileSync(process.env.BUILD_LOG, 'b\\n'); process.exit(${buildExit})"`,
			"build:dist": `node -e "process.env.BUILD_LOG && require('fs').appendFileSync(process.env.BUILD_LOG, 'd\\n'); if (${distBuildExit}) process.exit(${distBuildExit}); require('fs').mkdirSync('dist/clients/lsp', {recursive:true}); require('fs').writeFileSync('dist/clients/lsp/server-traits.js', '')"`,
			"test:targeted": "node scripts/with-test-lock.mjs --shared -- vitest run",
			"astgrep:self-scan": 'node -e ""',
		},
	});
const GREEN = 'import { it } from "vitest";\nit("green", () => {});\n';
const RED =
	'import { expect, it } from "vitest";\nit("red", () => {\n\texpect(1).toBe(2);\n});\n';
// Red on its first run only: the red does not reproduce under red-on-base.
const FIRST_RUN_ONLY = [
	'import { existsSync, writeFileSync } from "node:fs";',
	'import { expect, it } from "vitest";',
	'it("first run only", () => {',
	"\tconst marker = `${process.env.FLAKE_DIR}/seen`;",
	"\tconst first = !existsSync(marker);",
	'\twriteFileSync(marker, "x");',
	"\texpect(first).toBe(false);",
	"});",
	"",
].join("\n");
const FOO_TEST =
	'import { expect, it } from "vitest";\nimport { value } from "../../clients/foo";\nit("value is one", () => {\n\texpect(value).toBe(1);\n});\n';
const BASE_FILES: Files = {
	"package.json": packageJson(),
	"tests/config/ok.test.ts": GREEN,
	"tests/clients/foo.test.ts": FOO_TEST,
	"clients/foo.ts": "export const value = 1;\n",
};

const git = (cwd: string, ...args: string[]) =>
	String(gitExecFileSync("git", args, { cwd, encoding: "utf8" })).trim();

function makeLane(spec: LaneSpec) {
	const env = setupTestEnvironment("pi-lens-lane-check-test-");
	cleanups.push(env.cleanup);
	const root = path.join(env.tmpDir, "repo");
	const tmp = path.join(env.tmpDir, "tmp");
	const home = path.join(env.tmpDir, "home");
	const bin = path.join(env.tmpDir, "bin");
	for (const dir of [root, tmp, home, bin]) fs.mkdirSync(dir);
	// A copy, not a symlink: with-test-lock.mjs is a no-op behind a symlinked
	// `scripts/` (its entry-point check compares real paths).
	fs.cpSync(REAL_SCRIPTS, path.join(root, "scripts"), { recursive: true });
	fs.copyFileSync(OXFMTRC, path.join(root, ".oxfmtrc.json"));
	fs.symlinkSync(REAL_NODE_MODULES, path.join(root, "node_modules"), "dir");
	const write = (files: Files) => {
		for (const [name, content] of Object.entries(files)) {
			fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
			fs.writeFileSync(path.join(root, name), content);
		}
	};
	write({
		"vitest.config.mjs":
			'export default {\n\tcacheDir: "./.vite-cache",\n\ttest: { include: ["tests/**/*.test.ts"] },\n};\n',
		".gitignore": "node_modules\n.vite-cache\nPR_BODY.md\nCOMMIT_MSG.txt\n",
	});
	write(spec.base);
	const commit = (message: string, files: Files = {}) => {
		git(root, "add", "-A");
		// `-f` only for the files the spec names: a handoff file is gitignored.
		for (const name of Object.keys(files)) git(root, "add", "-f", name);
		git(
			root,
			"-c",
			"user.email=t@example.com",
			"-c",
			"user.name=T",
			"commit",
			"-q",
			"-m",
			message,
		);
	};
	git(root, "init", "-q", "-b", "main");
	commit("base", spec.base);
	git(root, "update-ref", "refs/remotes/origin/master", "HEAD");
	git(root, "checkout", "-q", "-b", "lane/fixture");
	if (spec.head) {
		write(spec.head);
		commit("head", spec.head);
	}
	if (spec.detach) git(root, "checkout", "-q", "--detach");
	if (spec.edits) write(spec.edits);
	if (spec.untracked) write(spec.untracked);

	// The real git behind a PATH shim that refuses `worktree add`, the way a
	// guarded plegma lane does (#4047 review H1).
	const realGit = spawnSync("sh", ["-c", "command -v git"], {
		encoding: "utf8",
	}).stdout.trim();
	fs.writeFileSync(
		path.join(bin, "git"),
		[
			"#!/bin/sh",
			`real=${realGit}`,
			'if [ "$1 $2" = \'worktree add\' ] && [ -n "$GUARDED_LANE" ]; then',
			"  echo 'plegma-guard: git worktree add is refused in worker lanes' >&2; exit 1",
			"fi",
			'exec "$real" "$@"',
		].join("\n"),
		{ mode: 0o755 },
	);
	return { root, tmp, home, bin };
}
type Lane = ReturnType<typeof makeLane>;

function runLane(
	lane: Lane,
	extraEnv: Record<string, string> = {},
	args: string[] = [],
) {
	const env: NodeJS.ProcessEnv = {
		...gitFixtureEnv(lane.root),
		PATH: `${lane.bin}${path.delimiter}${process.env.PATH}`,
		TMPDIR: lane.tmp,
		PI_LENS_HOME: lane.home,
		FLAKE_DIR: lane.tmp,
		BUILD_LOG: path.join(lane.home, "builds.log"),
		PI_LENS_TEST_MAX_WORKERS: "2",
		...extraEnv,
	};
	// The ambient runner's lock bypass must not leak into the hermetic fixture.
	if (!("PI_LENS_TEST_NO_LOCK" in extraEnv)) delete env.PI_LENS_TEST_NO_LOCK;
	const result = spawnSync(process.execPath, [LANE_CHECK, ...args], {
		cwd: lane.root,
		encoding: "utf8",
		timeout: 150_000,
		maxBuffer: 64 * 1024 * 1024,
		env,
	});
	const out = `${result.stdout}${result.stderr}`;
	const recordLine = result.stdout
		.split("\n")
		.find((line) => line.startsWith('{"base"'));
	return {
		status: result.status,
		out,
		record: recordLine ? JSON.parse(recordLine) : undefined,
	};
}

const worktreeCount = (lane: Lane) =>
	git(lane.root, "worktree", "list", "--porcelain")
		.split("\n")
		.filter((line) => line.startsWith("worktree ")).length;
const scratch = (lane: Lane) => {
	const dir = path.join(lane.tmp, "pi-lens-scratch");
	return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
};
const occurrences = (text: string, needle: string) =>
	text.split(needle).length - 1;
const TIMEOUT = 170_000;

describe("lane-check verdict table (#4047 round 2)", () => {
	it(
		"rebuilds a missing dist dependency before governance suites (#4239)",
		() => {
			const lane = makeLane({
				base: {
					...BASE_FILES,
					"clients/lsp/server-traits.ts":
						"export const isAuxiliary = () => false;\\n",
				},
				head: { "tests/config/added.test.ts": GREEN },
			});
			const run = runLane(lane);
			expect(run.status).toBe(0);
			expect(run.record.verdict).toBe("clean");
			expect(run.out).toContain(
				"[lane-check] dist/ missing or stale (dist/clients/lsp/server-traits.js); running npm run build:dist...",
			);
			expect(
				fs.existsSync(
					path.join(lane.root, "dist/clients/lsp/server-traits.js"),
				),
			).toBe(true);
			expect(fs.readFileSync(path.join(lane.home, "builds.log"), "utf8")).toBe(
				"b\nd\n",
			);
		},
		TIMEOUT,
	);

	it(
		"all green: clean, exit 0, the summary names the real branch",
		() => {
			const lane = makeLane({
				base: BASE_FILES,
				head: { "tests/config/added.test.ts": GREEN },
			});
			const run = runLane(lane);
			expect(run.status).toBe(0);
			expect(run.record.verdict).toBe("clean");
			expect(run.record.failedFiles).toEqual([]);
			expect(run.record.checks.build).toBe(0);
			expect(run.record.checks.targeted).toEqual({
				status: 0,
				failed: [],
				selected: 1,
				matched: 1,
				capped: false,
			});
			expect(run.out).toContain(
				"selection: selected 1, matched 1, capped false",
			);
			expect(run.out).toContain("verdict: clean (exit 0)");
			expect(run.out).toContain("branch: lane/fixture");
			// One build for the lane: no red to compare, so red-on-base builds none.
			expect(fs.readFileSync(path.join(lane.home, "builds.log"), "utf8")).toBe(
				"b\n",
			);
			expect(run.out).not.toContain("tools/4047-lane-check");
		},
		TIMEOUT,
	);

	// Recurrence: four workers called reds unrelated on 2026-10-07 that
	// red-on-base would have called CAUSED-BY-CHANGE.
	it(
		"red only on HEAD with the base reachable: red-caused, exit 1, one red-on-base run for a file red in both sets",
		() => {
			const lane = makeLane({
				base: BASE_FILES,
				head: { "tests/config/bad.test.ts": RED },
			});
			const run = runLane(lane);
			expect(run.status).toBe(1);
			expect(run.record.verdict).toBe("red-caused");
			expect(run.record.failedFiles).toEqual([
				{ file: "tests/config/bad.test.ts", verdict: "CAUSED-BY-CHANGE" },
			]);
			// The file reds in the targeted AND the governance run: one batch, one
			// comparison (two builds), not one per set.
			expect(occurrences(run.out, "BASE origin/master")).toBe(1);
			expect(run.out).toContain("CAUSED-BY-CHANGE: tests/config/bad.test.ts");
			expect(worktreeCount(lane)).toBe(1);
			expect(scratch(lane)).toEqual([]);
			// The lane's own TMPDIR is inherited (red-on-base made its scratch root
			// there); the old gate forced a shared `../probes-4047` instead.
			expect(fs.existsSync(path.join(lane.tmp, "pi-lens-scratch"))).toBe(true);
		},
		TIMEOUT,
	);

	it(
		"a file with a base-red test and a change-broken sibling is red-caused (the worst test wins)",
		() => {
			const two = (second: string) =>
				`import { expect, it } from "vitest";\nit("old red", () => {\n\texpect(1).toBe(2);\n});\nit("sibling", () => {\n\texpect(1).toBe(${second});\n});\n`;
			const lane = makeLane({
				base: { ...BASE_FILES, "tests/config/mixed.test.ts": two("1") },
				head: { "tests/config/mixed.test.ts": two("2") },
			});
			const run = runLane(lane);
			expect(run.status).toBe(1);
			expect(run.record.failedFiles).toEqual([
				{ file: "tests/config/mixed.test.ts", verdict: "CAUSED-BY-CHANGE" },
			]);
			expect(run.out).toContain(
				"RED-ON-BASE  tests/config/mixed.test.ts > old red",
			);
		},
		TIMEOUT,
	);

	it(
		"red only on HEAD in a lane that refuses git worktree add: red-caused, exit 1, from the archive base tree",
		() => {
			const lane = makeLane({
				base: BASE_FILES,
				head: { "tests/config/bad.test.ts": RED },
			});
			const run = runLane(lane, { GUARDED_LANE: "1" });
			expect(run.out).toContain("plegma-guard: git worktree add is refused");
			expect(run.status).toBe(1);
			expect(run.record.verdict).toBe("red-caused");
			expect(run.record.redOnBase.baseTree).toBe("git-archive");
			expect(run.record.failedFiles).toEqual([
				{ file: "tests/config/bad.test.ts", verdict: "CAUSED-BY-CHANGE" },
			]);
			expect(worktreeCount(lane)).toBe(1);
			expect(scratch(lane)).toEqual([]);
		},
		TIMEOUT,
	);

	it(
		"red on the base too: clean, exit 0, listed as RED-ON-BASE",
		() => {
			const lane = makeLane({
				base: { ...BASE_FILES, "tests/config/old-red.test.ts": RED },
				head: { "tests/config/added.test.ts": GREEN },
			});
			const run = runLane(lane);
			expect(run.status).toBe(0);
			expect(run.record.verdict).toBe("clean");
			expect(run.record.failedFiles).toEqual([
				{ file: "tests/config/old-red.test.ts", verdict: "RED-ON-BASE" },
			]);
			expect(run.out).toContain("RED-ON-BASE: tests/config/old-red.test.ts");
		},
		TIMEOUT,
	);

	it(
		"build failure: unproven, exit 3, and no test step runs",
		() => {
			const lane = makeLane({
				base: BASE_FILES,
				head: {
					"package.json": packageJson(1),
					"tests/config/added.test.ts": GREEN,
				},
			});
			const run = runLane(lane);
			expect(run.status).toBe(3);
			expect(run.record.verdict).toBe("unproven");
			expect(run.record.checks.build).toBe(1);
			expect(run.record.checks.targeted).toBeUndefined();
			expect(run.record.findings).toEqual([
				{
					kind: "unproven",
					reason: "build failed (exit 1); no test step ran",
				},
			]);
			expect(run.out).toContain("verdict: unproven (exit 3)");
		},
		TIMEOUT,
	);

	it(
		"dist build failure: unproven, exit 3, and no test step runs",
		() => {
			const lane = makeLane({
				base: {
					...BASE_FILES,
					"clients/lsp/server-traits.ts":
						"export const isAuxiliary = () => false;\\n",
				},
				head: {
					"package.json": packageJson(0, 1),
					"tests/config/added.test.ts": GREEN,
				},
			});
			const run = runLane(lane);
			expect(run.status).toBe(3);
			expect(run.record.verdict).toBe("unproven");
			expect(run.record.checks.build).toBe(0);
			expect(run.record.checks.distBuild).toBe(1);
			expect(run.record.checks.targeted).toBeUndefined();
			expect(run.record.findings).toEqual([
				{
					kind: "unproven",
					reason: "dist build failed (exit 1); no test step ran",
				},
			]);
			expect(run.out).toContain(
				"[lane-check] dist build failed; run `npm run build:dist` to rebuild dist/.",
			);
		},
		TIMEOUT,
	);

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
	// and lane:check printed `verdict: clean`.
	it(
		"a capped selection is unproven, never clean, and says what ran",
		() => {
			const many: Files = {};
			for (let i = 0; i < 25; i += 1)
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
				selected: 0,
				matched: 26,
				capped: true,
			});
			expect(run.record.findings).toEqual([
				{
					kind: "unproven",
					reason:
						"selection capped: 26 test files matched, 0 ran; run the full suite or narrow the change",
				},
			]);
			expect(run.out).toContain(
				"selection: selected 0, matched 26, capped true",
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

describe("lane-check transcript parsing", () => {
	const recorded = (name: string) =>
		fs
			.readFileSync(path.join(FIXTURES, name), "utf8")
			.replaceAll("<ESC>", "\u001b");
	const candidates = [
		"tests/scripts/zz-probe-red-a.test.ts",
		"tests/scripts/zz-probe-red-b.test.ts",
		"tests/scripts/zz-probe-green.test.ts",
	];

	// The transcripts are real vitest 5.0.3 output from this repo's config (a
	// `|default|` project prefix), one with FORCE_COLOR=1: ANSI codes in front
	// of `FAIL` hid every red from the old parse, which then read as no red.
	it.each(["lane-check-vitest-red.txt", "lane-check-vitest-red-color.txt"])(
		"names exactly the failing files of the recorded vitest transcript %s",
		(name) => {
			expect(reportedFailureFiles(recorded(name), candidates).sort()).toEqual([
				"tests/scripts/zz-probe-red-a.test.ts",
				"tests/scripts/zz-probe-red-b.test.ts",
			]);
		},
	);

	it("a failed run that names fewer files than vitest counted is unattributed", () => {
		const output = recorded("lane-check-vitest-red.txt");
		const named = reportedFailureFiles(output, candidates.slice(0, 1));
		expect(named).toEqual(["tests/scripts/zz-probe-red-a.test.ts"]);
		expect(unattributedFailure(1, output, named)).toBe(
			"exit 1: vitest counted 2 failing file(s), 1 named",
		);
		expect(
			unattributedFailure(1, output, reportedFailureFiles(output, candidates)),
		).toBeNull();
		expect(unattributedFailure(1, "[pre-push] Error: Command failed", [])).toBe(
			"exit 1 and no failing test file named in the output",
		);
		expect(unattributedFailure(0, output, [])).toBeNull();
	});

	it("only `clean` exits 0; red-caused outranks unproven", () => {
		const caused = { kind: "red-caused", reason: "x" } as const;
		const unproven = { kind: "unproven", reason: "y" } as const;
		expect(decideLane([])).toBe("clean");
		expect(decideLane([unproven])).toBe("unproven");
		expect(decideLane([unproven, caused])).toBe("red-caused");
		expect(
			["clean", "red-caused", "unproven"].map((v) => laneExitCode(v)),
		).toEqual([0, 1, 3]);
		expect(laneExitCode("anything-else")).toBe(3);
	});
});
