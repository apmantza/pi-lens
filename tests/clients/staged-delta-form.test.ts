/**
 * #5553: which bash commands the commit gate's staged-delta read can replay
 * with `git commit --dry-run`, and how it replays them.
 *
 * Recurrence prevented: the read replays the commit on a private index copy
 * before the command runs, so any earlier command that may change what the
 * commit carries (`npm test`, `git rm`, a script, a substitution that writes)
 * would leave it judging a set the commit no longer has. Only the listed forms
 * replay; everything else is `unresolved`, which the gate refuses (a gate
 * refuses what it does not recognise).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { decodeShellCommand } from "../../clients/bash-file-access.js";
import { planStagedCommit, REPLAYED_MESSAGE } from "../../clients/git-guard.js";
import { setupTestEnvironment } from "./test-utils.js";

describe("planStagedCommit", () => {
	const env = setupTestEnvironment("staged-delta-form-");
	const dir = () => fs.realpathSync.native(env.tmpDir);
	const plan = (command: string) =>
		planStagedCommit("bash", { command }, dir());

	it.each([
		{ command: 'git commit -m "a b"', globals: [], args: ["-m", "a b"] },
		{
			command: "git -C sub -c k=v commit -a",
			globals: ["-C", "sub", "-c", "k=v"],
			args: ["-a"],
		},
		// The message is the shell's; the replay passes a literal in its place.
		{
			command: `git commit -m "$(cat <<'EOF'\nsubject\n\nbody\nEOF\n)"`,
			globals: [],
			args: ["-m", REPLAYED_MESSAGE],
		},
		{
			command: 'git commit -m "$msg"',
			globals: [],
			args: ["-m", REPLAYED_MESSAGE],
		},
		{ command: 'git commit -m "x"; echo done', globals: [], args: ["-m", "x"] },
		{
			command: 'git commit -m "x" 2>&1 | tail -3',
			globals: [],
			args: ["-m", "x"],
		},
		{
			command: "git status && git diff --stat && git commit -m x",
			globals: [],
			args: ["-m", "x"],
		},
	])("replays $command", ({ command, globals, args }) => {
		expect(plan(command)).toEqual({
			adds: [],
			commit: { cwd: dir(), env: {}, globals, args },
		});
	});

	it("replays a git add and a cd before the commit, in the directory each runs in", () => {
		const src = path.join(dir(), "src");
		fs.mkdirSync(src, { recursive: true });
		expect(
			plan(
				"git add -A && cd src && GIT_INDEX_FILE=../.git/alt git commit -m x",
			),
		).toEqual({
			adds: [{ cwd: dir(), env: {}, globals: [], args: ["-A"] }],
			commit: {
				cwd: src,
				env: { GIT_INDEX_FILE: "../.git/alt" },
				globals: [],
				args: ["-m", "x"],
			},
		});
	});

	// Each row is a form that may change what the commit carries after the
	// replay looked, or one the replay cannot pass to git as bash would.
	it.each([
		["an indirect launcher", "sh -c 'git commit -m x'", "another command"],
		["a command that may write", "npm test && git commit -m x", "`npm`"],
		["git rm", "git rm a.ts && git commit -m x", "git rm"],
		["two commits", "git commit -m a && git commit -m b", "more than one"],
		["a glob the shell expands", "git commit -m x src/*.ts", "shell expands"],
		[
			"a git option the shell expands",
			'git -c "$k" commit -m x',
			"shell expands",
		],
		[
			"a substitution that writes",
			'git commit -m "$(rm -rf x)"',
			"substitution runs `rm`",
		],
		[
			"a substitution that writes a file",
			'git commit -m "$(echo x > f)"',
			"output redirection",
		],
		[
			"a substitution that stages",
			'git commit -m "$(git add -A)"',
			"substitution runs `git`",
		],
		["an input redirection", "git commit --interactive < answers", "input"],
		["a here-doc message file", "git commit -F - <<'EOF'\nx\nEOF", "input"],
		["an assignment outside git's own", "FOO=1 git commit -m x", "FOO="],
		["an add alongside it", "git add -A & git commit -m x", "alongside"],
		[
			"an add with a redirection",
			"git add -A > log && git commit -m x",
			"redirection",
		],
		["an add in a group", "(git add -A) && git commit -m x", "group"],
		["a background commit", "git commit -m x &", "background"],
		["a cd it cannot follow", "cd missing && git commit -m x", "`cd`"],
		["a cd to home", "cd ~/x && git commit -m x", "`cd`"],
		// The guard reads `co^mmit` as `commit` (cmd.exe drops a caret); bash
		// passes it as written, so it is no commit the replay can run.
		["a verb only the guard reads as commit", "git co^mmit -m x", "may commit"],
	])("does not replay %s", (_name, command, why) => {
		const answer = plan(command);
		expect(answer).toHaveProperty("unresolved");
		expect((answer as { unresolved: string }).unresolved).toContain(why);
	});

	it("does not replay another tool's command", () => {
		expect(planStagedCommit("edit", { path: "a.ts" }, dir())).toEqual({
			unresolved: "the edit tool",
		});
	});
});

describe("decodeShellCommand", () => {
	// Recurrence prevented: a `2>&1` read as a command boundary would split
	// the commit from its own redirection, and an input redirection read as
	// an output one would let a commit's stdin go unreplayed.
	it.each([
		{ command: "git commit -m x 2>&1", input: false, output: true },
		{ command: "git commit -m x > log", input: false, output: true },
		{ command: "git commit < answers", input: true, output: false },
		{ command: "git commit -F - <<'EOF'\nx\nEOF", input: true, output: false },
		{ command: "git commit -F - <<< x", input: true, output: false },
		{ command: 'git commit -m "a b"', input: false, output: false },
	])("reads $command as one command", ({ command, input, output }) => {
		const commands = decodeShellCommand(command);
		expect(commands).toHaveLength(1);
		expect(commands[0]).toMatchObject({
			redirected: input || output,
			input,
			output,
		});
		expect(commands[0]?.words[0]?.text).toBe("git");
	});

	it("passes each word's value as bash does", () => {
		const [simple] = decodeShellCommand(`git commit -m "a b" 'c'd "$x" $y`);
		expect(simple?.words.slice(0, 5).map((word) => word.text)).toEqual([
			"git",
			"commit",
			"-m",
			"a b",
			"cd",
		]);
		expect(simple?.words[5]).toMatchObject({
			hidden: "expansion",
			singleField: true,
		});
		expect(simple?.words[6]?.hidden).toBe("expansion");
		expect(simple?.words[6]?.singleField).toBeUndefined();
	});
});
