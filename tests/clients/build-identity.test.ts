/**
 * #1775: `sessionstart.log` recorded no build identity. `getBuildIdentity`
 * fills that gap with the serving checkout's commit, entry-file mtime, and
 * package version — derived from the RUNNING build's own files
 * (`getPackageRoot` + `review-graph/git-identity.ts`'s spawn-free
 * `resolveGitIdentity`), never from `process.cwd()`.
 *
 * Spawns a REAL child Node process against real fixture git repos, mirroring
 * metrics-history-stderr.test.ts's approach and reusing its git-fixture
 * conventions (env scrubbed via gitFixtureEnv, no `GIT_DIR`-family leakage,
 * fixture-only identity literals already registered in
 * tests/support/git-config-guard.ts's KNOWN_FIXTURE_NAMES/EMAILS).
 *
 * #2210 review round F2: a `.git` found in an ANCESTOR of the package root
 * must NOT be reported as this build's identity — a packaged install nested
 * under any repo-tracked ancestor (dotfiles in $HOME is the common case)
 * would otherwise confidently misattribute an unrelated repo's commit. The
 * "no owning repo" scenario below plants a REAL git repo one level ABOVE the
 * package root, so the assertion holds regardless of whatever ambient state
 * `os.tmpdir()`'s true ancestry happens to have — it no longer depends on
 * "no ancestor of os.tmpdir() is a repo" the way a bare no-git fixture would.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
	gitExecFileSync,
	gitFixtureEnv,
	hasGit,
} from "../support/git-fixture-env.js";

const BUILD_IDENTITY_JS = path.resolve(
	__dirname,
	"../../clients/build-identity.js",
);

function writeFixturePackage(dir: string, version: string): void {
	fs.writeFileSync(
		path.join(dir, "package.json"),
		JSON.stringify({ name: "fixture", version }),
	);
}

/** Runs `getBuildIdentity(entryUrl)` in a fresh child process — with
 *  PI_LENS_TEST_MODE forced to "0" so the real (non-test-mode) computation
 *  path runs even though this itself executes under vitest — and returns the
 *  parsed JSON result printed to stdout. */
function runGetBuildIdentity(
	cwd: string,
	entryFile: string,
	env: NodeJS.ProcessEnv,
): Record<string, unknown> {
	const entryUrl = pathToFileURL(entryFile).href;
	const script = [
		`const { getBuildIdentity } = require(${JSON.stringify(BUILD_IDENTITY_JS)});`,
		`process.stdout.write(JSON.stringify(getBuildIdentity(${JSON.stringify(entryUrl)})));`,
	].join("\n");
	const result = spawnSync(process.execPath, ["-e", script], {
		cwd,
		encoding: "utf-8",
		env: { ...env, PI_LENS_TEST_MODE: "0" },
	});
	expect(result.error).toBeUndefined();
	expect(result.status).toBe(0);
	return JSON.parse(result.stdout);
}

describe("getBuildIdentity (#1775)", () => {
	it.skipIf(!hasGit())(
		"records the real commit and the package version for a repo that owns its package root",
		() => {
			const tmp = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-build-identity-"),
			);
			const fixtureEnv = gitFixtureEnv(tmp);
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
				runGit(["config", "user.name", "fixture"]);
				writeFixturePackage(tmp, "9.9.9");
				const entryFile = path.join(tmp, "entry.js");
				fs.writeFileSync(entryFile, "// fixture entry\n");
				runGit(["add", "package.json", "entry.js"]);
				runGit(["commit", "-qm", "fixture"]);
				const expectedCommit = gitExecFileSync(
					"git",
					["rev-parse", "--short=8", "HEAD"],
					{ cwd: tmp, encoding: "utf-8", env: fixtureEnv },
				).trim();

				const identity = runGetBuildIdentity(tmp, entryFile, fixtureEnv);

				expect(identity.commit).toBe(expectedCommit);
				expect(identity.version).toBe("9.9.9");
				expect(typeof identity.entryMtime).toBe("string");
				expect(new Date(identity.entryMtime as string).toString()).not.toBe(
					"Invalid Date",
				);
			} finally {
				fs.rmSync(tmp, { recursive: true, force: true });
			}
		},
	);

	it.skipIf(!hasGit())(
		"reports commit=unknown when the nearest .git belongs to an ANCESTOR, not the package root (#2210 F2)",
		() => {
			const tmp = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-build-identity-ancestor-"),
			);
			const fixtureEnv = gitFixtureEnv(tmp);
			fixtureEnv.GIT_CONFIG_GLOBAL = path.join(tmp, "gitconfig");
			fixtureEnv.GIT_CONFIG_NOSYSTEM = "1";
			const runGit = (cwd: string, args: string[]) =>
				gitExecFileSync("git", args, {
					cwd,
					stdio: "ignore",
					env: fixtureEnv,
				});
			try {
				// A real, committed repo at `tmp` — the ANCESTOR. The package root
				// this test cares about is nested one level below it and has no
				// `.git` of its own, so `resolveGitIdentity` walking up from the
				// package root finds `tmp`'s `.git` first — exactly the dotfiles-
				// repo-in-$HOME shape F2 is guarding against.
				runGit(tmp, ["init", "-q"]);
				runGit(tmp, ["config", "user.email", "test@example.com"]);
				runGit(tmp, ["config", "user.name", "fixture"]);
				fs.writeFileSync(path.join(tmp, "README.md"), "ancestor\n");
				runGit(tmp, ["add", "README.md"]);
				runGit(tmp, ["commit", "-qm", "ancestor"]);

				const packageRoot = path.join(tmp, "nested", "pkg");
				fs.mkdirSync(packageRoot, { recursive: true });
				writeFixturePackage(packageRoot, "1.2.3");
				const entryFile = path.join(packageRoot, "entry.js");
				fs.writeFileSync(entryFile, "// fixture entry\n");

				const identity = runGetBuildIdentity(
					packageRoot,
					entryFile,
					fixtureEnv,
				);

				expect(identity.commit).toBe("unknown");
				expect(identity.version).toBe("1.2.3");
			} finally {
				fs.rmSync(tmp, { recursive: true, force: true });
			}
		},
	);

	it('falls back to "unknown" commit and the package version outside a git repo', () => {
		const tmp = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-build-identity-nogit-"),
		);
		try {
			writeFixturePackage(tmp, "2.3.4");
			const entryFile = path.join(tmp, "entry.js");
			fs.writeFileSync(entryFile, "// fixture entry\n");

			const identity = runGetBuildIdentity(tmp, entryFile, {
				...process.env,
			});

			// Correct with OR without an ambient repo above `tmp`: an ancestor
			// repo is rejected by the F2 ownership check the same as no repo at
			// all, so this no longer depends on "no ancestor of os.tmpdir() is a
			// repo" the way a pre-F2 fixture would have.
			expect(identity.commit).toBe("unknown");
			expect(identity.version).toBe("2.3.4");
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("returns undefined inside the test runner (no computation when the log is a no-op)", () => {
		const tmp = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-build-identity-testmode-"),
		);
		try {
			writeFixturePackage(tmp, "5.6.7");
			const entryFile = path.join(tmp, "entry.js");
			fs.writeFileSync(entryFile, "// fixture entry\n");
			const entryUrl = pathToFileURL(entryFile).href;
			const script = [
				`const { getBuildIdentity } = require(${JSON.stringify(BUILD_IDENTITY_JS)});`,
				`process.stdout.write(JSON.stringify(getBuildIdentity(${JSON.stringify(entryUrl)}) ?? "TEST_MODE_UNDEFINED"));`,
			].join("\n");
			const result = spawnSync(process.execPath, ["-e", script], {
				cwd: tmp,
				encoding: "utf-8",
				env: { ...process.env, PI_LENS_TEST_MODE: "1" },
			});
			expect(result.error).toBeUndefined();
			expect(result.status).toBe(0);
			expect(JSON.parse(result.stdout)).toBe("TEST_MODE_UNDEFINED");
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
});
// flake-shape: real-process-spawn — the real build subprocess boundary is part of identity contention
