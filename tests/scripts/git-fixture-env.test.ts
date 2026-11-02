import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
	envFor,
	gitExecFileSync,
	gitExecSync,
} from "../../scripts/lib/git-fixture-env.mjs";
import { gitExecFileSync as tsGitExecFileSync } from "../support/git-fixture-env.js";

describe("JavaScript Git fixture environment", () => {
	const scratch: string[] = [];
	afterEach(() => {
		for (const dir of scratch.splice(0))
			fs.rmSync(dir, { recursive: true, force: true });
	});

	const policyFile = path.resolve(
		import.meta.dirname,
		"../fixtures/git-fixture-global.gitconfig",
	);

	/**
	 * Commit in a fresh throwaway repo through `run`, with git's trace2 stream
	 * on. The trace records the parent's `child_start` before it forks, so a
	 * DETACHED maintenance child is still named in the file (#4552).
	 */
	function commitFixture(
		run: (args: string[], cwd: string, trace: string) => void,
	): string {
		const repo = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-git-maintenance-"),
		);
		scratch.push(repo);
		const trace = path.join(repo, "trace2.json");
		run(["init", "-q", "--initial-branch=main"], repo, trace);
		run(
			[
				"-C",
				repo,
				"-c",
				"user.name=pi-lens-test",
				"-c",
				"user.email=pi-lens-test@example.com",
				"commit",
				"-q",
				"--allow-empty",
				"-m",
				"fixture",
			],
			repo,
			trace,
		);
		return fs.readFileSync(trace, "utf8");
	}

	/** Background-maintenance children the trace2 stream names. */
	function maintenanceChildStarts(events: string): string[] {
		// Positive control: without it, an empty or unrelated trace would satisfy
		// the empty-list assertion below.
		expect(events).toContain('"name":"commit"');
		return events
			.split("\n")
			.filter((line) => line.includes('"child_start"'))
			.filter((line) => line.includes("maintenance"));
	}

	const jsRun = (args: string[], cwd: string, trace: string) =>
		gitExecFileSync(args, {
			cwd,
			stdio: "ignore",
			env: { GIT_TRACE2_EVENT: trace },
		});
	const tsRun = (args: string[], cwd: string, trace: string) =>
		tsGitExecFileSync("git", args, {
			cwd,
			stdio: "ignore",
			env: { GIT_TRACE2_EVENT: trace },
		});

	it("scrubs inherited Git state and config injection", () => {
		const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-mjs-git-env-"));
		scratch.push(repo);
		gitExecFileSync(["init", "-q"], { cwd: repo, stdio: "ignore" });
		expect(
			String(
				gitExecFileSync(["rev-parse", "--git-dir"], {
					cwd: repo,
					env: {
						GIT_DIR: path.join(os.tmpdir(), "escape"),
						GIT_CONFIG_COUNT: "1",
						GIT_CONFIG_KEY_0: "core.bare",
						GIT_CONFIG_VALUE_0: "true",
					},
					encoding: "utf8",
				}),
			),
		).toBe(".git\n");
	});

	it("scrubs indexed config keys even without a count (review F1)", () => {
		// GIT_CONFIG_COUNT is scrubbed by name, so git would ignore orphaned
		// KEY/VALUE entries anyway; this pins the pattern loop itself so a
		// future COUNT passthrough cannot resurrect the injection.
		const env = envFor("C:/tmp", {
			GIT_CONFIG_KEY_0: "core.bare",
			GIT_CONFIG_VALUE_0: "true",
		});
		expect(env.GIT_CONFIG_KEY_0).toBeUndefined();
		expect(env.GIT_CONFIG_VALUE_0).toBeUndefined();
		expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
	});

	// Recurrence: #4552. `git commit` runs `run_auto_maintenance`, which forks a
	// DETACHED `git maintenance run --auto --quiet --detach` child. The child
	// outlives the fixture cell and writes inside `.git` (maintenance.lock,
	// packed-refs.lock, repack temp files), so the gating Unit shard failed in
	// `afterEach` teardown with ENOTEMPTY on the fixture `.git` instead of in an
	// assertion. A fixture never needs background maintenance, so the global
	// config the helper hands every fixture Git process is the checked-in policy
	// that turns it off.
	it("forks no detached auto-maintenance child from a fixture commit (#4552)", () => {
		expect(maintenanceChildStarts(commitFixture(jsRun))).toEqual([]);
	});

	// The TypeScript twin carries the same policy (#4552): a fixture that ran
	// through only one of the two helpers would still fork the detached child,
	// so the twin needs a behavioural witness, not only a path-string check.
	// Review R3: the string parity case below could not have caught a twin that
	// kept the policy path but lost it from the environment it hands git.
	it("forks no detached auto-maintenance child through the TypeScript twin (#4552)", () => {
		expect(maintenanceChildStarts(commitFixture(tsRun))).toEqual([]);
	});

	// Recurrence: #4552 review R2. `scripts/lib/git-fixture-env.mjs` resolves the
	// policy file relative to ITS OWN module, and four fixtures copy it into a
	// clone or throwaway tree. A copy that forgot the policy silently gave its
	// Git spawns the DEFAULT config, so `git maintenance run --auto` forked the
	// detached child again -- the exact teardown race this PR closes. A relocated
	// copy must fail loudly instead.
	it("refuses to build an environment when a relocated copy has no policy file (#4552)", async () => {
		const relocated = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-git-relocated-"),
		);
		scratch.push(relocated);
		const copy = path.join(relocated, "scripts", "lib", "git-fixture-env.mjs");
		fs.mkdirSync(path.dirname(copy), { recursive: true });
		fs.copyFileSync(
			path.resolve(
				import.meta.dirname,
				"../../scripts/lib/git-fixture-env.mjs",
			),
			copy,
		);
		const relocatedHelper = (await import(pathToFileURL(copy).href)) as {
			envFor: (
				cwd: string,
				overrides?: Record<string, string>,
			) => Record<string, string>;
		};
		expect(() => relocatedHelper.envFor("C:/tmp", {})).toThrow(
			/fixture Git policy missing/,
		);
		// The absent FILE is the only difference: copying it makes the same module
		// build a policed environment, so the refusal is about the policy, not the
		// relocation.
		const policyCopy = path.join(
			relocated,
			"tests",
			"fixtures",
			"git-fixture-global.gitconfig",
		);
		fs.mkdirSync(path.dirname(policyCopy), { recursive: true });
		fs.copyFileSync(policyFile, policyCopy);
		expect(relocatedHelper.envFor("C:/tmp", {}).GIT_CONFIG_GLOBAL).toBe(
			policyCopy,
		);
	});

	// Recurrence: the TypeScript twin sets GIT_CONFIG_NOSYSTEM by hand beside the
	// policy path, and no other case reads a system config: the two #4552 cases
	// above go red on a lost policy file or path, not on a system config git
	// would still read, so a fixture could inherit the host's /etc/gitconfig.
	it("ignores a system git config through the TypeScript twin", () => {
		const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-ts-git-sys-"));
		scratch.push(repo);
		const system = path.join(repo, "system.gitconfig");
		fs.writeFileSync(system, "[pilens]\n\tprobe = from-system\n");
		// `git config --get` exits 1 for an unset key; any other failure (git
		// missing, a spawn error) has no status 1 and fails this assertion.
		expect(() =>
			tsGitExecFileSync("git", ["config", "--get", "pilens.probe"], {
				cwd: repo,
				stdio: "ignore",
				env: { GIT_CONFIG_SYSTEM: system },
			}),
		).toThrow(expect.objectContaining({ status: 1 }));
	});

	// Recurrence: `gitExecSync` and `gitExecFileSync` each build their own
	// options. A wrapper that stopped passing `envFor` kept `git status` working,
	// so the old case (a `status` line plus a `config --get user.name` that throws
	// only on a host with no global user) stayed green; the fixture then ran on
	// the host's Git state and config. Both wrappers must hand git the scrubbed
	// environment and the fixture policy.
	function expectWrapperInsideRepo(
		run: (repo: string, env: NodeJS.ProcessEnv, args: string[]) => unknown,
	) {
		const repo = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-mjs-git-wrapper-"),
		);
		scratch.push(repo);
		gitExecFileSync(["init", "-q"], { cwd: repo, stdio: "ignore" });
		fs.writeFileSync(path.join(repo, "file.txt"), "fixture\n");
		expect(String(run(repo, {}, ["status", "--porcelain"]))).toContain(
			"file.txt",
		);
		// An inherited GIT_DIR pointing elsewhere must not redirect the command.
		expect(
			String(
				run(repo, { GIT_DIR: path.join(os.tmpdir(), "escape") }, [
					"rev-parse",
					"--git-dir",
				]),
			),
		).toBe(".git\n");
		// The fixture policy is what git reads as global config.
		expect(String(run(repo, {}, ["config", "--get", "maintenance.auto"]))).toBe(
			"false\n",
		);
	}

	it("keeps gitExecFileSync inside a throwaway repository", () => {
		expectWrapperInsideRepo((repo, env, args) =>
			gitExecFileSync(args, { cwd: repo, env, encoding: "utf8" }),
		);
	});

	it("keeps gitExecSync inside a throwaway repository", () => {
		expectWrapperInsideRepo((repo, env, args) =>
			gitExecSync(`git ${args.join(" ")}`, {
				cwd: repo,
				env,
				encoding: "utf8",
			}),
		);
	});
});
// flake-shape: real-process-spawn — real git fixture children resolve sanitized environment variables and repository metadata
