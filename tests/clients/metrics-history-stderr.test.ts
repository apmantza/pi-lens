/**
 * #2095 — `getCurrentCommit()` in `clients/metrics-history.ts` ran
 * Git commit lookup without an explicit `stdio`
 * override. Node's `execSync`/`execFileSync` inherit the child's stderr to
 * the PARENT process by default (only stdout is piped into the return
 * value), so a failing `git rev-parse` prints its raw "fatal: ..." line
 * straight into the pi TUI, bypassing the surrounding try/catch entirely —
 * the catch only sees the thrown (non-zero exit) error, never the
 * already-inherited stderr stream.
 *
 * This spawns a REAL child Node process (not a mock) that requires the
 * compiled runtime module and calls `captureSnapshot()` with its cwd set to
 * a real git repo that has zero commits, so `git rev-parse --short HEAD`
 * genuinely fails and genuinely writes to stderr. The child's own stderr is
 * inherited straight from the grandchild `git` process pre-fix, so this
 * test observes the real leak rather than asserting on mocked call
 * arguments.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	gitExecFileSync,
	gitFixtureEnv,
	hasGit,
} from "../support/git-fixture-env.js";

const METRICS_HISTORY_JS = path.resolve(
	__dirname,
	"../../clients/metrics-history.js",
);

describe("metrics-history getCurrentCommit stderr suppression (#2095)", () => {
	it.skipIf(!hasGit())(
		"does not leak git's stderr when rev-parse fails in a commit-less repo",
		() => {
			const tmp = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-metrics-history-"),
			);
			const fixtureEnv = gitFixtureEnv(tmp);
			fixtureEnv.GIT_CONFIG_GLOBAL = path.join(tmp, "gitconfig");
			fixtureEnv.GIT_CONFIG_NOSYSTEM = "1";
			try {
				// A real repo with zero commits: `git rev-parse --short HEAD`
				// genuinely fails with "fatal: ambiguous argument 'HEAD': unknown
				// revision or path not in the working tree." on real stderr.
				// `stdio: "ignore"` here is the exact guard this PR is about —
				// this setup call must not itself leak `git init`'s stderr.
				gitExecFileSync("git", ["init", "-q"], {
					cwd: tmp,
					stdio: "ignore",
					env: fixtureEnv,
				});

				const dataDir = path.join(tmp, ".pilens-data");
				const filePath = path.join(tmp, "file.ts");
				// Use the synchronous, immediate-save `captureSnapshots` (not the
				// debounced `captureSnapshot`) so the resolved commit is available
				// to print without waiting on the 5s save timer.
				const script = [
					`const path = require("path");`,
					`process.chdir(${JSON.stringify(tmp)});`,
					`const { captureSnapshots } = require(${JSON.stringify(METRICS_HISTORY_JS)});`,
					`const filePath = ${JSON.stringify(filePath)};`,
					"const history = captureSnapshots([{",
					"  filePath,",
					"  metrics: {",
					"    maintainabilityIndex: 90,",
					"    cognitiveComplexity: 1,",
					"    maxNestingDepth: 1,",
					"    linesOfCode: 10,",
					"    maxCyclomatic: 1,",
					"    entropy: 1,",
					"  },",
					"}]);",
					"const relativePath = path.relative(process.cwd(), filePath);",
					// Print the resolved commit so the test can prove the failure
					// path was actually taken — not that the require target was
					// missing or the child silently crashed before reaching it.
					'process.stdout.write("COMMIT:" + JSON.stringify(history.files[relativePath].latest.commit));',
				].join("\n");

				const result = spawnSync(process.execPath, ["-e", script], {
					cwd: tmp,
					encoding: "utf-8",
					env: { ...fixtureEnv, PILENS_DATA_DIR: dataDir },
				});

				expect(result.error).toBeUndefined();
				expect(result.status).toBe(0);
				// Proves getCurrentCommit() actually took its catch/fallback
				// branch, so the stderr assertion below is checking a genuinely
				// exercised failure path, not a script that silently no-opped.
				expect(result.stdout).toContain('COMMIT:"unknown"');
				// The bug: git's raw "fatal: ..." line lands on the child's own
				// stderr, unfiltered by any try/catch inside getCurrentCommit().
				expect(result.stderr).not.toMatch(/fatal:/i);
			} finally {
				fs.rmSync(tmp, { recursive: true, force: true });
			}
		},
	);
});

describe("metrics-history per-file commit resolution (#2099)", () => {
	it.skipIf(!hasGit())(
		"records each target file's repository commit when cwd has another HEAD",
		() => {
			const tmp = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-metrics-history-repos-"),
			);
			const fixtureEnv = gitFixtureEnv(tmp);
			fixtureEnv.PI_LENS_SKIP_HOOKS = "1";
			fixtureEnv.GIT_CONFIG_GLOBAL = path.join(tmp, "gitconfig");
			fixtureEnv.GIT_CONFIG_NOSYSTEM = "1";
			const runGit = (cwd: string, args: string[]) =>
				gitExecFileSync("git", args, {
					cwd,
					stdio: "ignore",
					env: fixtureEnv,
				});
			try {
				const umbrella = tmp;
				const repoA = path.join(umbrella, "service-a");
				const repoB = path.join(umbrella, "service-b");
				fs.mkdirSync(repoA);
				fs.mkdirSync(repoB);

				for (const repo of [umbrella, repoA, repoB]) {
					runGit(repo, ["init", "-q"]);
					runGit(repo, ["config", "user.email", "test@example.com"]);
					runGit(repo, ["config", "user.name", "pi-lens test"]);
				}
				fs.writeFileSync(path.join(umbrella, "README.md"), "umbrella\n");
				runGit(umbrella, ["add", "README.md"]);
				runGit(umbrella, ["commit", "-qm", "umbrella"]);
				fs.writeFileSync(path.join(repoA, "a.ts"), "const a = 1;\n");
				runGit(repoA, ["add", "a.ts"]);
				runGit(repoA, ["commit", "-qm", "service-a"]);
				fs.writeFileSync(path.join(repoB, "b.ts"), "const b = 1;\n");
				runGit(repoB, ["add", "b.ts"]);
				runGit(repoB, ["commit", "-qm", "service-b"]);

				const expectedA = gitExecFileSync(
					"git",
					["rev-parse", "--short", "HEAD"],
					{ cwd: repoA, encoding: "utf-8", env: fixtureEnv },
				).trim();
				const expectedB = gitExecFileSync(
					"git",
					["rev-parse", "--short", "HEAD"],
					{ cwd: repoB, encoding: "utf-8", env: fixtureEnv },
				).trim();
				const umbrellaHead = gitExecFileSync(
					"git",
					["rev-parse", "--short", "HEAD"],
					{ cwd: umbrella, encoding: "utf-8", env: fixtureEnv },
				).trim();

				const dataDir = path.join(umbrella, ".pilens-data");
				const script = [
					`process.chdir(${JSON.stringify(umbrella)});`,
					`const { captureSnapshots } = require(${JSON.stringify(METRICS_HISTORY_JS)});`,
					`const files = ${JSON.stringify([path.join(repoA, "a.ts"), path.join(repoB, "b.ts")])};`,
					"const history = captureSnapshots(files.map((filePath) => ({ filePath, metrics: {",
					"  maintainabilityIndex: 90, cognitiveComplexity: 1, maxNestingDepth: 1,",
					"  linesOfCode: 10, maxCyclomatic: 1, entropy: 1,",
					"} })));",
					"process.stdout.write(JSON.stringify(files.map((filePath) => history.files[require('node:path').relative(process.cwd(), filePath)].latest.commit)));",
				].join("\n");
				const result = spawnSync(process.execPath, ["-e", script], {
					cwd: umbrella,
					encoding: "utf-8",
					env: { ...fixtureEnv, PILENS_DATA_DIR: dataDir },
				});

				expect(result.error).toBeUndefined();
				expect(result.status).toBe(0);
				expect(JSON.parse(result.stdout)).toEqual([expectedA, expectedB]);
				expect(expectedA).not.toBe(umbrellaHead);
				expect(expectedB).not.toBe(umbrellaHead);
			} finally {
				fs.rmSync(tmp, { recursive: true, force: true });
			}
		},
		30_000,
	);
});

describe("metrics-history repository guard (#2099)", () => {
	it.skipIf(!hasGit())(
		"resolves a nested repository under a non-repository umbrella",
		() => {
			const tmp = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-metrics-history-nonrepo-"),
			);
			const fixtureEnv = gitFixtureEnv(tmp);
			fixtureEnv.PI_LENS_SKIP_HOOKS = "1";
			fixtureEnv.GIT_CONFIG_GLOBAL = path.join(tmp, "gitconfig");
			fixtureEnv.GIT_CONFIG_NOSYSTEM = "1";
			const repo = path.join(tmp, "nested-repo");
			const filePath = path.join(repo, "nested.ts");
			const runGit = (args: string[]) =>
				gitExecFileSync("git", args, {
					cwd: repo,
					stdio: "ignore",
					env: fixtureEnv,
				});
			try {
				fs.mkdirSync(repo);
				runGit(["init", "-q"]);
				runGit(["config", "user.email", "test@example.com"]);
				runGit(["config", "user.name", "pi-lens test"]);
				fs.writeFileSync(filePath, "const nested = 1;\n");
				runGit(["add", "nested.ts"]);
				runGit(["commit", "-qm", "nested-repo"]);
				const expected = gitExecFileSync(
					"git",
					["rev-parse", "--short", "HEAD"],
					{
						cwd: repo,
						encoding: "utf-8",
						env: fixtureEnv,
					},
				).trim();
				const dataDir = path.join(tmp, ".pilens-data");
				const script = [
					`process.chdir(${JSON.stringify(tmp)});`,
					`const { captureSnapshots } = require(${JSON.stringify(METRICS_HISTORY_JS)});`,
					`const filePath = ${JSON.stringify(filePath)};`,
					"const history = captureSnapshots([{ filePath, metrics: {",
					"  maintainabilityIndex: 90, cognitiveComplexity: 1, maxNestingDepth: 1,",
					"  linesOfCode: 10, maxCyclomatic: 1, entropy: 1,",
					"} }]);",
					"process.stdout.write(history.files[require('node:path').relative(process.cwd(), filePath)].latest.commit);",
				].join("\n");
				const result = spawnSync(process.execPath, ["-e", script], {
					cwd: tmp,
					encoding: "utf-8",
					env: { ...fixtureEnv, PILENS_DATA_DIR: dataDir },
				});

				expect(result.error).toBeUndefined();
				expect(result.status).toBe(0);
				expect(result.stdout).toBe(expected);
				expect(result.stdout).not.toBe("unknown");
			} finally {
				fs.rmSync(tmp, { recursive: true, force: true });
			}
		},
		30_000,
	);
});

describe("metrics-history missing target directory (#2099)", () => {
	it.skipIf(!hasGit())(
		"resolves a file whose directory does not exist yet",
		() => {
			const tmp = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-metrics-history-missing-"),
			);
			const fixtureEnv = gitFixtureEnv(tmp);
			fixtureEnv.PI_LENS_SKIP_HOOKS = "1";
			fixtureEnv.GIT_CONFIG_GLOBAL = path.join(tmp, "gitconfig");
			fixtureEnv.GIT_CONFIG_NOSYSTEM = "1";
			const runGit = (args: string[]) =>
				gitExecFileSync("git", args, {
					cwd: tmp,
					stdio: "ignore",
					env: fixtureEnv,
				});
			try {
				runGit(["init", "-q"]);
				runGit(["config", "user.email", "test@example.com"]);
				runGit(["config", "user.name", "pi-lens test"]);
				fs.writeFileSync(path.join(tmp, "README.md"), "umbrella\n");
				runGit(["add", "README.md"]);
				runGit(["commit", "-qm", "fixture"]);
				const expected = gitExecFileSync(
					"git",
					["rev-parse", "--short", "HEAD"],
					{
						cwd: tmp,
						encoding: "utf-8",
						env: fixtureEnv,
					},
				).trim();
				const filePath = path.join(tmp, "sub", "gone.ts");
				const dataDir = path.join(tmp, ".pilens-data");
				const script = [
					`process.chdir(${JSON.stringify(tmp)});`,
					`const { captureSnapshots } = require(${JSON.stringify(METRICS_HISTORY_JS)});`,
					`const filePath = ${JSON.stringify(filePath)};`,
					"const history = captureSnapshots([{ filePath, metrics: {",
					"  maintainabilityIndex: 90, cognitiveComplexity: 1, maxNestingDepth: 1,",
					"  linesOfCode: 10, maxCyclomatic: 1, entropy: 1,",
					"} }]);",
					"process.stdout.write(history.files[require('node:path').relative(process.cwd(), filePath)].latest.commit);",
				].join("\n");
				const result = spawnSync(process.execPath, ["-e", script], {
					cwd: tmp,
					encoding: "utf-8",
					env: { ...fixtureEnv, PILENS_DATA_DIR: dataDir },
				});

				expect(result.error).toBeUndefined();
				expect(result.status).toBe(0);
				expect(result.stdout).toBe(expected);
				expect(result.stdout).not.toBe("unknown");
			} finally {
				fs.rmSync(tmp, { recursive: true, force: true });
			}
		},
		30_000,
	);
});
// flake-shape: real-process-spawn — real git children emit stderr bytes whose metrics classification cannot be observed in-process
