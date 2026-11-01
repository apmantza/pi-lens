/**
 * Shared fixture and driver for the lane-check CLI tests (#4047), moved
 * unchanged out of `tests/scripts/lane-check.test.ts` when its 27 cases were
 * split over three files for #3801. `cleanups` is drained by each file's own
 * `afterEach`, because a hook registers in the file that calls it.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach } from "vitest";
import { setupTestEnvironment } from "../clients/test-utils.js";
import { copyFixtureGitHelper } from "./fixture-git-copy.js";
import { gitExecFileSync, gitFixtureEnv } from "./git-fixture-env.js";

export const LANE_CHECK = path.resolve("scripts/lane-check.mjs");
export const REAL_SCRIPTS = path.resolve("scripts");
export const REAL_NODE_MODULES = path.resolve("node_modules");
export const OXFMTRC = path.resolve(".oxfmtrc.json");
export const FIXTURES = path.resolve("tests/scripts/fixtures");

export const cleanups: (() => void)[] = [];

/** Registers the `afterEach` that drains {@link cleanups}; call once per test file. */
export function useLaneCleanups(): void {
	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) cleanup();
	});
}

export type Files = Record<string, string>;
export type LaneSpec = {
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

export const packageJson = (
	buildExit = 0,
	distBuildExit = 0,
	depcruiseExit = 0,
) =>
	JSON.stringify({
		name: "lane-fixture",
		private: true,
		scripts: {
			// BUILD_LOG counts builds: lane-check builds once, not once more in the selector.
			build: `node -e "process.env.BUILD_LOG && require('fs').appendFileSync(process.env.BUILD_LOG, 'b\\n'); process.exit(${buildExit})"`,
			"build:dist": `node -e "process.env.BUILD_LOG && require('fs').appendFileSync(process.env.BUILD_LOG, 'd\\n'); if (${distBuildExit}) process.exit(${distBuildExit}); require('fs').mkdirSync('dist/clients/lsp', {recursive:true}); require('fs').writeFileSync('dist/clients/lsp/server-traits.js', '')"`,
			"test:targeted": "node scripts/with-test-lock.mjs --shared -- vitest run",
			"astgrep:self-scan": 'node -e ""',
			"depcruise:check": `node -e "process.exit(${depcruiseExit})"`,
		},
	});
export const GREEN = 'import { it } from "vitest";\nit("green", () => {});\n';
export const RED =
	'import { expect, it } from "vitest";\nit("red", () => {\n\texpect(1).toBe(2);\n});\n';
// Red on its first run only: the red does not reproduce under red-on-base.
export const FIRST_RUN_ONLY = [
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
export const FOO_TEST =
	'import { expect, it } from "vitest";\nimport { value } from "../../clients/foo";\nit("value is one", () => {\n\texpect(value).toBe(1);\n});\n';
export const BASE_FILES: Files = {
	"package.json": packageJson(),
	"tests/config/ok.test.ts": GREEN,
	"tests/clients/foo.test.ts": FOO_TEST,
	"clients/foo.ts": "export const value = 1;\n",
};

export const git = (cwd: string, ...args: string[]) =>
	String(gitExecFileSync("git", args, { cwd, encoding: "utf8" })).trim();

export function makeLane(spec: LaneSpec) {
	const env = setupTestEnvironment("pi-lens-lane-check-test-");
	cleanups.push(env.cleanup);
	const root = path.join(env.tmpDir, "repo");
	const tmp = path.join(env.tmpDir, "tmp");
	const home = path.join(env.tmpDir, "home");
	const bin = path.join(env.tmpDir, "bin");
	for (const dir of [root, tmp, home, bin]) fs.mkdirSync(dir);
	// A copy, not a symlink: the fixture repo must own its `scripts/` so the
	// copied scripts resolve their repo root and Git state inside `root`.
	fs.cpSync(REAL_SCRIPTS, path.join(root, "scripts"), { recursive: true });
	// The copied scripts run their own Git reads (lane-check's changelog check,
	// check-pr-body, red-on-base), so the copied helper needs its policy file:
	// without it the helper refuses, every case lands on `unproven` (#4552 R2).
	copyFixtureGitHelper(root);
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
export type Lane = ReturnType<typeof makeLane>;

export function runLane(
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

export const worktreeCount = (lane: Lane) =>
	git(lane.root, "worktree", "list", "--porcelain")
		.split("\n")
		.filter((line) => line.startsWith("worktree ")).length;
export const occurrences = (text: string, needle: string) =>
	text.split(needle).length - 1;
export const TIMEOUT = 170_000;
