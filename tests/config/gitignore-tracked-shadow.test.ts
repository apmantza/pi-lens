import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { gitExecFileSync } from "../support/git-fixture-env.js";
import { assertNonEmptyScan } from "../support/sweep-kit.js";

const root = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
);

/**
 * A git-tracked file that also matches a `.gitignore` pattern is invisible
 * to any ignore-respecting tool that doesn't special-case tracked status —
 * `rg`, plain `grep --exclude-from`, GitHub code search. Git itself keeps
 * tracking the file (`git status`/`git check-ignore` on an already-indexed
 * path both special-case it), so nothing in git itself flags the shadow
 * (#2250).
 *
 * `git check-ignore --no-index` is git's own textual pattern evaluator —
 * the same primitive `rg`'s gitignore support and GitHub code search apply
 * — so piping every tracked path through it is the ground truth for "would
 * a real ignore-respecting tool skip this file", with zero reimplemented
 * gitignore dialect (a hand-rolled matcher previously here missed
 * negations entirely and produced false positives on `.changelog/*.md`
 * fragments git does NOT actually ignore). `-z`/`--stdin -z` NUL-delimit
 * both ends so no filename with a space or unusual character is misread.
 */
function findShadowedTrackedFiles(): string[] {
	const tracked = gitExecFileSync("git", ["ls-files", "-z"], {
		cwd: root,
		encoding: "utf8",
	});
	const trackedCount = tracked.split("\0").filter(Boolean).length;
	// Floor set well under the repo's real tracked-file count (~2,950) so it
	// still catches a silent zero — e.g. the `input` forwarding this test
	// relies on (git-fixture-env.ts's GitExecOptions) getting dropped in a
	// future edit, which would make `shadowed` trivially equal `[]` for the
	// wrong reason and pass forever (#2250 review V3).
	assertNonEmptyScan("git ls-files (tracked files scanned)", trackedCount, 500);

	let shadowed: string;
	try {
		shadowed = gitExecFileSync(
			"git",
			["check-ignore", "--no-index", "--stdin", "-z"],
			{ cwd: root, encoding: "utf8", input: tracked },
		);
	} catch (err) {
		// git check-ignore exits 1 when NONE of the stdin paths are ignored —
		// that's the passing case, not a failure. Any other exit still throws.
		const e = err as { status?: number; stdout?: string | Buffer };
		if (e.status !== 1) throw err;
		shadowed =
			typeof e.stdout === "string"
				? e.stdout
				: (e.stdout?.toString("utf8") ?? "");
	}

	return shadowed.split("\0").filter(Boolean);
}

describe("gitignore does not shadow tracked files (#2250)", () => {
	it("no git-tracked file is reported ignored by git check-ignore --no-index", () => {
		const shadowed = findShadowedTrackedFiles();
		expect(shadowed).toEqual([]);
	});
});
// flake-shape: real-process-spawn — real gitignore rules and index entries decide shadow files outside the test process
