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
});
