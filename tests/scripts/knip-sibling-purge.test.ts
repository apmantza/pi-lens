// flake-shape: real-process-spawn — real `git` calls against a throwaway
// fixture repo; gitignore/tracked-vs-untracked resolution is the exact
// mechanism under test, which no mock reproduces faithfully.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { purgeCompiledSiblings } from "../../scripts/lib/knip-sibling-purge.mjs";
import { execFileSync } from "../support/git-fixture-env.js";

const tempDirs: string[] = [];

function git(cwd: string, args: string[]): void {
	execFileSync("git", args, { cwd, stdio: "pipe" });
}

/**
 * A throwaway git repo shaped like the compiled-sibling problem: a tracked
 * `.ts` source with a gitignored `.js` build artifact beside it, PLUS two
 * decoys the purge must leave alone — an ignored `.js` with no tracked
 * `.ts` sibling, and a `.js` that IS tracked (never "--others").
 */
function fixtureRepo(): string {
	const root = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-lens-knip-sibling-purge-2698-"),
	);
	tempDirs.push(root);
	git(root, ["init", "--quiet"]);
	git(root, ["config", "user.email", "test@example.com"]);
	git(root, ["config", "user.name", "Test"]);

	fs.writeFileSync(path.join(root, ".gitignore"), "*.js\n!tracked.js\n");
	fs.writeFileSync(path.join(root, "source.ts"), "export const x = 1;\n");
	fs.writeFileSync(path.join(root, "tracked.js"), "// checked in on purpose\n");
	git(root, ["add", ".gitignore", "source.ts", "tracked.js"]);
	git(root, ["commit", "--quiet", "-m", "init"]);

	// The compiled sibling: gitignored, untracked, same basename as source.ts.
	fs.writeFileSync(path.join(root, "source.js"), "// tsc build output\n");
	// A decoy: gitignored, untracked, but no tracked .ts sibling — must survive.
	fs.writeFileSync(path.join(root, "orphan.js"), "// not a compiled sibling\n");

	return root;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("purgeCompiledSiblings (#2698)", () => {
	it("removes only the gitignored .js file with a tracked .ts sibling", () => {
		const root = fixtureRepo();

		const purged = purgeCompiledSiblings(root);

		expect(purged).toEqual(["source.js"]);
		expect(fs.existsSync(path.join(root, "source.js"))).toBe(false);
		expect(fs.existsSync(path.join(root, "orphan.js"))).toBe(true);
		expect(fs.existsSync(path.join(root, "tracked.js"))).toBe(true);
	});

	it("is a no-op on a repo with no compiled siblings on disk", () => {
		const root = fixtureRepo();
		fs.rmSync(path.join(root, "source.js"));

		expect(purgeCompiledSiblings(root)).toEqual([]);
	});

	it("propagates a git failure instead of silently doing nothing", () => {
		const notARepo = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-knip-sibling-purge-not-a-repo-"),
		);
		tempDirs.push(notARepo);

		expect(() => purgeCompiledSiblings(notARepo)).toThrow();
	});

	// #2698 review round 2, F3, red-first: the unbounded `execFileSync` call
	// this replaced used Node's 1 MB default `maxBuffer` against a listing
	// already 43% of that cap on this repo — a real ENOBUFS, not a
	// hypothetical. `deps.maxBuffer` makes the same real overflow (real
	// `git`, real buffer cap, no mocked error) reproducible against a tiny
	// fixture: `git ls-files` output for even one file exceeds 1 byte.
	it("F3: throws (real ENOBUFS) when git's output exceeds maxBuffer", () => {
		const root = fixtureRepo();

		expect(() => purgeCompiledSiblings(root, { maxBuffer: 1 })).toThrow(
			/ENOBUFS|maxBuffer/i,
		);
	});

	// #2698 review round 3, R2-F3, red-first: `timeout`/`killSignal` were the
	// one guard added alongside `maxBuffer` with no test of their own —
	// deleting both lines from the real runner left every prior test green.
	// `deps.timeout: 1` forces a REAL `ETIMEDOUT` against a real `git` process
	// (fork+exec alone reliably exceeds 1ms) — no mocked error.
	//
	// #5516 review round 1, F5: this case used to assert `signal: "SIGKILL"`
	// too, and that member is FLAKY — a 1 ms timeout races the child's own
	// exit, and Node then reports `code: "ETIMEDOUT"` with `signal: null` and
	// `status: 0`. Measured: 27 of 200 `execFileSync` calls against a prompt
	// `git --version` (13.5%), 86 of 800 calls through this export in the
	// review probe, and 2 of 15 runs of this file. The file runs in the gating
	// Unit shards (`wallClockBudgetInclude`), so the flake reds them. `code:
	// "ETIMEDOUT"` held in every one of those calls, so this pins the code and
	// `killSignal` is UNPINNED: pinning it needs a runner seam that still
	// honours `timeout` (`deps.git` bypasses the timeout entirely), and that is
	// new mechanism for a maintainer decision, not a test assertion.
	it("F3/R2-F3: throws (real ETIMEDOUT) when a git call exceeds timeout", () => {
		const root = fixtureRepo();

		expect(() => purgeCompiledSiblings(root, { timeout: 1 })).toThrow(
			expect.objectContaining({ code: "ETIMEDOUT" }),
		);
	});
});
