/**
 * #5553: which files a `git commit` argv makes it carry, and which commands
 * the gate reads as a plain commit at all.
 *
 * Recurrence prevented: a commit option the parser did not list read as no
 * option (`-a` lost in a cluster, `--only` after `--include`, a value taken
 * for a pathspec) names the wrong set of files, so a file the commit carries
 * is never judged. Only a listed form resolves; every other argv is `undefined`
 * and judged by the superset (a gate refuses what it does not recognise).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { decodeShellWords } from "../../clients/bash-file-access.js";
import { readGuardedSegments } from "../../clients/git-guard.js";
import { parseCommitStageForm } from "../../clients/staged-delta.js";
import { setupTestEnvironment } from "./test-utils.js";

/** The form of the one `git commit` in `command`, as the gate reads it. */
function formOf(command: string, cwd: string) {
	const segments = readGuardedSegments("bash", { command }, cwd);
	const commit = segments?.guarded.find((segment) => segment.commit);
	return commit ? parseCommitStageForm(commit.args) : "unread";
}

describe("parseCommitStageForm", () => {
	const ROWS: ReadonlyArray<
		[string, string, { source: string; pathspecs: string[] } | undefined]
	> = [
		["no option", "git commit", { source: "index", pathspecs: [] }],
		["a message", 'git commit -m "a b"', { source: "index", pathspecs: [] }],
		[
			"a message that looks like an option",
			'git commit -m "-a"',
			{ source: "index", pathspecs: [] },
		],
		["-a", "git commit -a", { source: "all", pathspecs: [] }],
		["--all", "git commit --all -m x", { source: "all", pathspecs: [] }],
		["-a in a cluster", "git commit -qam x", { source: "all", pathspecs: [] }],
		[
			"-a ahead of an attached message",
			"git commit -amx",
			{ source: "all", pathspecs: [] },
		],
		[
			"a pathspec",
			"git commit -m x src/a.ts",
			{ source: "paths", pathspecs: ["src/a.ts"] },
		],
		[
			"pathspecs after --",
			"git commit -m x -- src/a.ts -b",
			{ source: "paths", pathspecs: ["src/a.ts", "-b"] },
		],
		[
			"--only",
			"git commit --only -m x src/a.ts",
			{ source: "paths", pathspecs: ["src/a.ts"] },
		],
		[
			"-o",
			"git commit -o -m x src/a.ts",
			{ source: "paths", pathspecs: ["src/a.ts"] },
		],
		[
			"-i with a pathspec",
			"git commit -i -m x src/a.ts",
			{ source: "index+paths", pathspecs: ["src/a.ts"] },
		],
		[
			"--include with a pathspec",
			"git commit --include src/a.ts -m x",
			{ source: "index+paths", pathspecs: ["src/a.ts"] },
		],
		[
			"--amend",
			"git commit --amend --no-edit",
			{ source: "index", pathspecs: [] },
		],
		[
			"--amend -a",
			"git commit --amend -a --no-edit",
			{ source: "all", pathspecs: [] },
		],
		[
			"a value option written with =",
			"git commit --message=x --author=a",
			{ source: "index", pathspecs: [] },
		],
		[
			"a value option written apart",
			"git commit --message x --author a src/a.ts",
			{ source: "paths", pathspecs: ["src/a.ts"] },
		],
		["an unknown long option", "git commit --frobnicate", undefined],
		["an unknown short option", "git commit -Z", undefined],
		["-p", "git commit -p", undefined],
		["--patch", "git commit --patch", undefined],
		[
			"--pathspec-from-file",
			"git commit --pathspec-from-file=list.txt",
			undefined,
		],
		["an option the shell expands", 'git commit "$FLAGS"', undefined],
		["a pathspec the shell expands", "git commit src/*.ts", undefined],
		["a pathspec from a variable", 'git commit -m x "$FILE"', undefined],
	];
	it.each(ROWS)("%s", (_name, command, expected) => {
		const words = decodeShellWords(command)[0]?.words.slice(2) ?? [];
		const form = parseCommitStageForm(words);
		expect(
			form === undefined
				? undefined
				: { source: form.source, pathspecs: [...form.pathspecs] },
		).toEqual(expected);
	});
});

describe("readGuardedSegments", () => {
	const env = setupTestEnvironment("staged-delta-form-");
	const dir = () => fs.realpathSync.native(env.tmpDir);

	it("reads a plain commit with a trailing echo", () => {
		expect(formOf('git commit -m "x"; echo done', dir())).toMatchObject({
			source: "index",
		});
	});

	// Recurrence prevented: an index-changing verb ahead of the commit makes the
	// staged set the one the command will build, not the one on disk now.
	it.each(["git add -A && git commit -m x", "git rm a.ts && git commit -m x"])(
		"marks %s as one that may change the index",
		(command) => {
			expect(
				readGuardedSegments("bash", { command }, dir())?.indexMayChange,
			).toBe(true);
		},
	);

	it("lets a read-only verb ahead of the commit leave the index alone", () => {
		expect(
			readGuardedSegments(
				"bash",
				{ command: "git status && git diff && git commit -m x" },
				dir(),
			)?.indexMayChange,
		).toBe(false);
	});

	it("places a commit by the -C directory it names", () => {
		const sub = path.join(dir(), "sub");
		fs.mkdirSync(sub);
		const guarded = readGuardedSegments(
			"bash",
			{ command: "git -C sub commit -m x" },
			dir(),
		)?.guarded;
		expect(guarded?.map((g) => g.directory)).toEqual([sub]);
	});

	// Recurrence prevented: a `cd`, an assignment, a wrapper and a launcher can
	// retarget the commit, so they are no form this reads.
	it.each([
		"cd sub && git commit -m x",
		"GIT_DIR=x git commit -m x",
		"sh -c 'git commit -m x'",
		"git -c user.name=t commit -m x",
		"git -C missing-dir commit -m x",
	])("does not read %s", (command) => {
		expect(readGuardedSegments("bash", { command }, dir())).toBeUndefined();
	});
});
