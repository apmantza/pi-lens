import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { gitExecFileSync } from "./git-fixture-env.js";
import {
	assertCleanGitConfig,
	localConfigPath,
	snapshotGitConfigState,
} from "./git-config-guard.js";
import { runGitConfigGuardSetup } from "./git-config-guard-setup.js";

const scratch: string[] = [];
afterEach(() => {
	for (const dir of scratch.splice(0))
		fs.rmSync(dir, { recursive: true, force: true });
});

describe("Git contamination guard", () => {
	it.each([
		["pi-lens test", "name"],
		["t", "name"],
	])("fails on the known fixture name %j", (value) => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-git-guard-"));
		scratch.push(dir);
		const config = path.join(dir, "config");
		fs.writeFileSync(
			config,
			`[core]\n\tbare = false\n[user]\n\tname = ${value}\n`,
		);
		expect(() => assertCleanGitConfig(config)).toThrow(
			/known fixture identity/,
		);
	});

	it.each([["test@example.com"], ["t@t.t"], ["t@t.local"]])(
		"fails on the known fixture email %j",
		(value) => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-git-guard-"));
			scratch.push(dir);
			const config = path.join(dir, "config");
			fs.writeFileSync(config, `[user]\n\temail = ${value}\n`);
			expect(() => assertCleanGitConfig(config)).toThrow(
				/known fixture identity/,
			);
		},
	);

	it("fails on a known fixture identity in a subsection, not only the bare user section", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-git-guard-"));
		scratch.push(dir);
		const config = path.join(dir, "config");
		fs.writeFileSync(config, '[user "fixture"]\n\temail = t@t.t\n');
		expect(() => assertCleanGitConfig(config)).toThrow(
			/known fixture identity/,
		);
	});

	it("fails on core.bare=true", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-git-guard-"));
		scratch.push(dir);
		const config = path.join(dir, "config");
		fs.writeFileSync(config, "[core]\n\tbare = true\n");
		expect(() => assertCleanGitConfig(config)).toThrow(/core\.bare=true/);
	});

	it("accepts a clean non-bare config", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-git-guard-"));
		scratch.push(dir);
		const config = path.join(dir, "config");
		fs.writeFileSync(config, "[core]\n\tbare = false\n");
		expect(() => assertCleanGitConfig(config)).not.toThrow();
	});

	it("does not flag a maintainer's own non-fixture identity (F5 narrowing)", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-git-guard-"));
		scratch.push(dir);
		const config = path.join(dir, "config");
		fs.writeFileSync(
			config,
			"[user]\n\tname = Apostolos Mantzaris\n\temail = ap.mantza@gmail.com\n",
		);
		expect(() => assertCleanGitConfig(config)).not.toThrow();
	});

	it("does not flag a fixture-shaped identity that was already present at suite start (#2251)", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-git-guard-"));
		scratch.push(dir);
		const config = path.join(dir, "config");
		// A maintainer whose real identity happens to equal a fixture value
		// (e.g. `user.name=t`, `user.email=t@t.local`) must never trip the
		// guard just because the value matches — only a CHANGE during the
		// run is contamination.
		fs.writeFileSync(config, "[user]\n\tname = t\n\temail = t@t.local\n");
		const baseline = snapshotGitConfigState(config);
		expect(() => assertCleanGitConfig(config, baseline)).not.toThrow();
	});

	it("still flags a fixture identity that appears during the run even when a different fixture value already existed (#2251)", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-git-guard-"));
		scratch.push(dir);
		const config = path.join(dir, "config");
		fs.writeFileSync(config, "[user]\n\tname = t\n");
		const baseline = snapshotGitConfigState(config);
		// A DIFFERENT fixture identity shows up mid-run: real contamination,
		// not just the maintainer's pre-existing "t".
		fs.writeFileSync(
			config,
			"[user]\n\tname = t\n\temail = test@example.com\n",
		);
		expect(() => assertCleanGitConfig(config, baseline)).toThrow(
			/known fixture identity/,
		);
	});

	it("still flags core.bare=true that appears during the run, baseline or not (#2251)", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-git-guard-"));
		scratch.push(dir);
		const config = path.join(dir, "config");
		fs.writeFileSync(config, "[core]\n\tbare = false\n");
		const baseline = snapshotGitConfigState(config);
		fs.writeFileSync(config, "[core]\n\tbare = true\n");
		expect(() => assertCleanGitConfig(config, baseline)).toThrow(
			/core\.bare=true/,
		);
	});

	it("resolves a linked worktree's config to the COMMON dir, not the per-worktree gitdir (F4)", () => {
		const root = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-git-guard-wt-"),
		);
		scratch.push(root);
		const main = path.join(root, "main");
		const worktree = path.join(root, "wt");
		fs.mkdirSync(main, { recursive: true });
		gitExecFileSync("git", ["init", "-q"], { cwd: main });
		fs.writeFileSync(path.join(main, "README.md"), "seed\n");
		gitExecFileSync("git", ["add", "README.md"], { cwd: main });
		// Author via env, not `git config`, so the shared config starts clean
		// and core.bare=true below is the ONLY contamination under test.
		gitExecFileSync("git", ["commit", "-q", "-m", "seed"], {
			cwd: main,
			env: {
				...process.env,
				GIT_AUTHOR_NAME: "t",
				GIT_AUTHOR_EMAIL: "t@t.t",
				GIT_COMMITTER_NAME: "t",
				GIT_COMMITTER_EMAIL: "t@t.t",
			},
		});
		gitExecFileSync("git", ["worktree", "add", "-q", worktree], {
			cwd: main,
		});

		// The per-worktree gitdir has no config of its own: a naive resolver
		// that stops there sees a missing file and reports clean.
		const naivePath = path.join(
			main,
			".git",
			"worktrees",
			path.basename(worktree),
			"config",
		);
		expect(fs.existsSync(naivePath)).toBe(false);

		// Contaminate the shared config the worktree actually inherits.
		gitExecFileSync("git", ["config", "core.bare", "true"], { cwd: main });

		const resolved = localConfigPath(worktree);
		expect(resolved).toBe(path.join(main, ".git", "config"));
		expect(() => assertCleanGitConfig(resolved)).toThrow(/core\.bare=true/);
	});
});

describe("runGitConfigGuardSetup one-time warn (#2251 fix round F2)", () => {
	it("warns once, naming the value, when a fixture-shaped identity is already present at suite start", () => {
		const dir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-git-guard-warn-"),
		);
		scratch.push(dir);
		fs.mkdirSync(path.join(dir, ".git"));
		fs.writeFileSync(
			path.join(dir, ".git", "config"),
			"[user]\n\tname = t\n\temail = t@t.local\n",
		);

		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			runGitConfigGuardSetup(dir);
			expect(warn).toHaveBeenCalledTimes(1);
			const message = warn.mock.calls[0]?.[0] as string;
			expect(message).toContain("t");
			expect(message).toContain("t@t.local");
		} finally {
			warn.mockRestore();
		}
	});

	it("does not warn when the config starts clean", () => {
		const dir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-git-guard-warn-"),
		);
		scratch.push(dir);
		fs.mkdirSync(path.join(dir, ".git"));
		fs.writeFileSync(
			path.join(dir, ".git", "config"),
			"[user]\n\tname = Real Maintainer\n",
		);

		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			runGitConfigGuardSetup(dir);
			expect(warn).not.toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});

	it("still returns a teardown that flags NEW contamination even after warning on baseline", () => {
		const dir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-git-guard-warn-"),
		);
		scratch.push(dir);
		fs.mkdirSync(path.join(dir, ".git"));
		const configPath = path.join(dir, ".git", "config");
		fs.writeFileSync(configPath, "[user]\n\tname = t\n");

		// The returned teardown closure resolves its config path via
		// teardown()'s own process.cwd() (unchanged production behavior — only
		// setup's baseline snapshot is cwd-injectable), so chdir into the
		// fixture for the duration of this test to exercise it faithfully. A
		// single try/finally spans BOTH the chdir-dependent calls so a throw
		// from either one still restores cwd — leaving cwd inside `dir` would
		// make the afterEach cleanup's rmSync fail (EPERM: can't remove a
		// directory that is the current working directory on Windows).
		const originalCwd = process.cwd();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			process.chdir(dir);
			const teardown = runGitConfigGuardSetup(dir);
			// A DIFFERENT fixture value appears mid-run: real contamination, not
			// just the pre-existing baseline "t".
			fs.writeFileSync(
				configPath,
				"[user]\n\tname = t\n\temail = test@example.com\n",
			);
			expect(() => teardown()).toThrow(/known fixture identity/);
		} finally {
			process.chdir(originalCwd);
			warn.mockRestore();
		}
	});
});
// flake-shape: real-process-spawn — this test calls a child-process helper; its boundary remains part of the contention surface
