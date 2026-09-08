import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	envFor,
	gitExecFileSync,
	gitExecSync,
} from "../../scripts/lib/git-fixture-env.mjs";

describe("JavaScript Git fixture environment", () => {
	const scratch: string[] = [];
	afterEach(() => {
		for (const dir of scratch.splice(0))
			fs.rmSync(dir, { recursive: true, force: true });
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

	it("keeps exec and shell wrappers inside a throwaway repository", () => {
		const repo = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-mjs-git-wrapper-"),
		);
		scratch.push(repo);
		gitExecFileSync(["init", "-q"], { cwd: repo, stdio: "ignore" });
		fs.writeFileSync(path.join(repo, "file.txt"), "fixture\n");
		expect(
			String(
				gitExecSync("git status --porcelain", { cwd: repo, encoding: "utf8" }),
			),
		).toContain("file.txt");
		expect(() =>
			gitExecFileSync(["config", "--get", "user.name"], { cwd: repo }),
		).toThrow();
	});
});
// flake-shape: real-process-spawn — the real git fixture process is the environment contention boundary
