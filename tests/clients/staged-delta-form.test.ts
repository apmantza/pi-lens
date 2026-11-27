/**
 * #5553: which bash commands the commit gate's staged-delta read can replay
 * with `git commit --dry-run`, and how it replays them.
 *
 * Recurrence prevented: the read replays the commit on a private index copy
 * before the command runs, so any earlier command that may change what the
 * commit carries (`npm test`, `git rm`, a script, a substitution that writes)
 * would leave it judging a set the commit no longer has. Only the listed forms
 * replay; everything else is `unresolved`, which the gate refuses (a gate
 * refuses what it does not recognise). Round 2's list refused a clean commit
 * in 15 of 42 common agent shapes (a here-doc message, `timeout`, `export`,
 * `make &&`, `git rm`), so each of those now has a replay row here.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { decodeShellCommand } from "../../clients/bash-file-access.js";
import {
	isGitCommitOrPushAttempt,
	planStagedCommit,
	REPLAYED_MESSAGE,
} from "../../clients/git-guard.js";
import { setupTestEnvironment } from "./test-utils.js";

describe("planStagedCommit", () => {
	const env = setupTestEnvironment("staged-delta-form-");
	const dir = () => fs.realpathSync.native(env.tmpDir);
	const plan = (command: string) =>
		planStagedCommit("bash", { command }, dir());

	it.each([
		{ command: 'git commit -m "a b"', globals: [], args: ["-m", "a b"] },
		// #5638: the blanks of a message are the shell's, ANSI-C quote included;
		// a blank-collapse pass with its own quote model turned `a'  b` into `a' b`.
		{
			command: "git commit -m $'a\\'  b'",
			globals: [],
			args: ["-m", "a'  b"],
		},
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
		// A message the commit reads from a here-doc does not change what it
		// carries; the dry run reads its own input.
		{
			command: "git commit -F - <<'EOF'\nx\nEOF",
			globals: [],
			args: ["-F", "-"],
		},
		{ command: "git commit --file=- <<< x", globals: [], args: ["--file=-"] },
		{
			command: "git commit -F - <<EOF\nfix: $(git log -1 --format=%s)\nEOF",
			globals: [],
			args: ["-F", "-"],
		},
		// Wrappers that run their command unchanged.
		{ command: "time git commit -m x", globals: [], args: ["-m", "x"] },
		{ command: "time -p git commit -m x", globals: [], args: ["-m", "x"] },
		{ command: "timeout 60 git commit -m x", globals: [], args: ["-m", "x"] },
		{
			command: "timeout -k 5 --preserve-status 1.5m git commit -m x",
			globals: [],
			args: ["-m", "x"],
		},
		{ command: "env git commit -m x", globals: [], args: ["-m", "x"] },
		// A variable git does not read changes nothing the replay passes.
		{ command: "FOO=1 git commit -m x", globals: [], args: ["-m", "x"] },
		{ command: "env FOO=1 git commit -m x", globals: [], args: ["-m", "x"] },
		// Preambles and steps that cannot change the index.
		{
			command: "export FOO=1; git commit -m x",
			globals: [],
			args: ["-m", "x"],
		},
		{
			command: "set -euo pipefail; git commit -m x",
			globals: [],
			args: ["-m", "x"],
		},
		{ command: "set -e; set -o pipefail; git commit", globals: [], args: [] },
		{ command: "ls && pwd && git commit -m x", globals: [], args: ["-m", "x"] },
		{ command: "make && git commit -m x", globals: [], args: ["-m", "x"] },
		{ command: "make test && git commit -m x", globals: [], args: ["-m", "x"] },
		{ command: "npm test && git commit -m x", globals: [], args: ["-m", "x"] },
		{
			command: "npm run lint && npm run-script build && git commit -m x",
			globals: [],
			args: ["-m", "x"],
		},
	])("replays $command", ({ command, globals, args }) => {
		expect(plan(command)).toEqual({
			steps: [],
			commit: { cwd: dir(), env: {}, globals, args },
		});
	});

	it("carries git's own variables from an env wrapper or an export", () => {
		for (const command of [
			"env GIT_AUTHOR_NAME=a git commit -m x",
			"timeout 60 env GIT_AUTHOR_NAME=a git commit -m x",
			"export GIT_AUTHOR_NAME=a; git commit -m x",
		])
			expect(plan(command), command).toEqual({
				steps: [],
				commit: {
					cwd: dir(),
					env: { GIT_AUTHOR_NAME: "a" },
					globals: [],
					args: ["-m", "x"],
				},
			});
		expect(
			plan("export GIT_INDEX_FILE=.git/alt && git add -A && git commit -m x"),
		).toEqual({
			steps: [
				{
					verb: "add",
					cwd: dir(),
					env: { GIT_INDEX_FILE: ".git/alt" },
					globals: [],
					args: ["-A"],
				},
			],
			commit: {
				cwd: dir(),
				env: { GIT_INDEX_FILE: ".git/alt" },
				globals: [],
				args: ["-m", "x"],
			},
		});
	});

	it("replays a git rm and a git mv that run before the commit after &&", () => {
		expect(
			plan("git rm -r old && git mv a.ts b.ts && git commit -m x"),
		).toEqual({
			steps: [
				{ verb: "rm", cwd: dir(), env: {}, globals: [], args: ["-r", "old"] },
				{
					verb: "mv",
					cwd: dir(),
					env: {},
					globals: [],
					args: ["a.ts", "b.ts"],
				},
			],
			commit: { cwd: dir(), env: {}, globals: [], args: ["-m", "x"] },
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
			steps: [{ verb: "add", cwd: dir(), env: {}, globals: [], args: ["-A"] }],
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
		[
			"a command that may stage",
			"./scripts/stage.sh && git commit -m x",
			"`./scripts/stage.sh`",
		],
		["a node script", "node x.js && git commit -m x", "`node`"],
		[
			"an npm verb not on the list",
			"npm install && git commit -m x",
			"`npm install`",
		],
		["npx", "npx lint-staged && git commit -m x", "`npx`"],
		[
			"a step with a pipe",
			"npm test 2>&1 | tail -5 && git commit -m x",
			"`npm test`",
		],
		["a make with a redirection", "make > log && git commit -m x", "`make`"],
		[
			"a step whose words the shell expands",
			'make "$t" && git commit -m x',
			"`make`",
		],
		// A failed `git rm` must stop the commit: its `--cached` replay checks less.
		["git rm before ;", "git rm a.ts; git commit -m x", "git rm"],
		["git mv before ;", "git mv a.ts b.ts; git commit -m x", "git mv"],
		[
			"git reset",
			"git add a.ts && git reset a.ts && git commit -m x",
			"git reset",
		],
		["an unknown wrapper", "nice git commit -m x", "another command"],
		["nohup", "nohup git commit -m x", "another command"],
		["an env option", "env -i git commit -m x", "`env -i`"],
		[
			"an env assignment of git's config",
			"env GIT_CONFIG_PARAMETERS=x git commit -m x",
			"GIT_CONFIG_PARAMETERS=",
		],
		[
			"a timeout option not on the list",
			"timeout -v 60 git commit -m x",
			"`timeout -v`",
		],
		[
			"a duration the shell expands",
			'timeout "$t" git commit -m x',
			"`timeout`",
		],
		["an export git reads", "export PATH=/x; git commit -m x", "export PATH"],
		[
			"an export of git's config",
			"export GIT_CONFIG_PARAMETERS=x; git commit -m x",
			"export GIT_CONFIG_PARAMETERS",
		],
		["a bare export", "export FOO; git commit -m x", "`export FOO`"],
		[
			"an export the shell expands",
			'export FOO="$x"; git commit -m x',
			"`export`",
		],
		["a set that changes the words", "set -- a b; git commit -m x", "`set --`"],
		["a set flag not on the list", "set -f; git commit -m x", "`set -f`"],
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
		[
			"a here-doc that feeds a path list",
			"git commit --pathspec-from-file=- <<'EOF'\na.ts\nEOF",
			"input",
		],
		[
			"a here-doc whose substitution stages",
			"git commit -F - <<EOF\ndon't $(git add x)\nEOF",
			"substitution runs `git`",
		],
		["a pipe into the commit", "cat m | git commit -F -", "alongside"],
		["an assignment git reads", "PATH=/x git commit -m x", "PATH="],
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

describe("command substitutions, read with bash's quoting", () => {
	const dir = () => process.cwd();
	const plan = (command: string) =>
		planStagedCommit("bash", { command }, dir());

	// Recurrence prevented (verify r3 R3-1): the gate's own text scanner took a
	// `'` inside "…" for a quote, and every later substitution went unread, so
	// a message that ran `git add -A` replayed as if it only read.
	it.each([
		`git commit -m "don't $(git add -A)"`,
		`git commit -m "it's" -m "$(git add -A)"`,
		`git commit -m "$(cat <<EOF\nit's $(git add -A)\nEOF\n)"`,
		`git commit -m "a \\"it's\\" $(git add -A)"`,
		`git commit -m $'it\\'s' -m "$(git add -A)"`,
		`git commit -m "$( echo "$(git add -A)" )"`,
		'git commit -m "it\'s `git add -A`"',
		`# don't\ngit commit -m "$(git add -A)"`,
		`git commit -m "$(echo ')' ; git add -A)"`,
		`git commit -m "$(echo it\\'s; git add -A)"`,
		// A subshell's `)` inside the body is not the body's end.
		`git commit -m "$( (echo a); git add -A)"`,
	])("does not replay %s", (command) => {
		const answer = plan(command);
		expect(answer).toHaveProperty("unresolved");
		expect((answer as { unresolved: string }).unresolved).toContain(
			"substitution runs `git`",
		);
	});

	it.each([
		`git commit -m "$(git add -A`,
		`git commit -m "it's $(git log`,
		'git commit -m "`git add -A"',
	])("does not replay an unterminated substitution: %s", (command) => {
		expect(plan(command)).toHaveProperty("unresolved");
	});

	it.each([
		`git commit -m "don't $(git log -1 --format=%s)"`,
		`git commit -m 'it'"'"'s' -m "$(git log -1)"`,
		`git commit -m $'it\\'s ok' -m "$(git log -1)"`,
		`git commit -m "$(cat <<'EOF'\nit's $(not run)\nEOF\n)"`,
		// Inside `$(…)` an escaped backtick is a character echo prints.
		'git commit -m "$(echo \\`git add -A\\`)"',
	])("replays %s, whose substitutions only read", (command) => {
		expect(plan(command)).toHaveProperty("commit");
	});

	// The same scan decides whether a command commits at all: missed, the
	// whole commit gate stood aside.
	it.each([
		`echo "it's $(git commit -m x)"`,
		`echo "it's $(git push)"`,
		'echo "it\'s `git commit -m x`"',
	])("reads %s as a commit or push", (command) => {
		expect(isGitCommitOrPushAttempt("bash", { command })).toBe(true);
	});

	// Recurrence prevented (verify r4 R4-3): each fail-closed branch of the
	// parser survived its own removal, because every unterminated row also ran
	// `git add`. These bodies only read, so the branch alone decides.
	it.each([
		["the depth cap", `git commit -m "$(echo $(echo $(echo $(git log -1))))"`],
		["an unclosed $( body", "git commit -m $(git log -1"],
		["an unclosed double quote", `git commit -m "abc`],
		["an unclosed backtick", "git commit -m `git log -1"],
	])("refuses %s, whose bodies only read", (_branch, command) => {
		expect(plan(command)).toEqual({
			unresolved:
				"a quote or command substitution that does not close, or substitutions nested past three levels",
		});
	});

	// Recurrence prevented (verify r4 R4-2): a here-doc the reader takes where
	// bash sees none swallowed the rest of the command, the commit included,
	// so detection said "no commit" and the gate stood aside while HEAD took
	// a `debugger;`. A here-doc whose body never starts or never ends leaves
	// the read incomplete, and an incomplete read that names the verb is an
	// attempt.
	it.each([
		"x=$((1<<A))\n$(git add -A)\ngit commit -m x",
		"echo ${x:-<<'EOF'}\n$(git add -A)\ngit commit -m x",
		"cat <<EOF\\\n\n$(git add -A)\nEOF\ngit commit -m x",
		"cat <<EOF\ngit push",
		// Bash reads `<<` in `$(( … ))` as a shift; the reader's here-doc is
		// still pending at the `)` and would swallow the commit up to `A`.
		"x=$(( 1 << A ))\ngit commit -m x\nA",
		// The verb is named through quotes the read never finished.
		"cat <<EOF\ngit co'mm'it -m x",
		// Verify r5 R5-1: `<<` inside `${…}` or open parens is no here-doc
		// the reader can trust, even when a later line ends it.
		"echo ${x:-<<EOF}\ngit commit -m x\nEOF}",
		"for ((i=1<<E; i<2; i++)); do :; done\ngit commit -m x\nE",
		"(( x = 1 << 3 ))\ngit commit -m x\n3",
		"echo $((1 << A))\ngit commit -m x\nA",
	])("reads %j as a commit or push and does not replay it", (command) => {
		expect(isGitCommitOrPushAttempt("bash", { command })).toBe(true);
		expect(plan(command)).toHaveProperty("unresolved");
	});

	// Recurrence prevented (r5 attack on the rule above): the reader kept the
	// `$` of a `$'E'` delimiter, so its here-doc ran past bash's `E` line and
	// swallowed the commit up to a `$E` line, a complete read.
	it("ends a $'…' delimited here-doc where bash does", () => {
		expect(
			isGitCommitOrPushAttempt("bash", {
				command: "cat <<$'E'\nx\nE\ngit commit -m y\n$E",
			}),
		).toBe(true);
	});

	it("does not read an unterminated here-doc that names no verb as a commit", () => {
		expect(
			isGitCommitOrPushAttempt("bash", { command: "cat <<EOF\nnotes" }),
		).toBe(false);
	});

	// Recurrence prevented (verify r4 R4-2, fourth root): bash removes a
	// `\<newline>` before it reads words, so `#` after one starts a comment
	// only where a blank came before the continuation.
	it("reads the commit after a comment that follows a line continuation", () => {
		expect(
			isGitCommitOrPushAttempt("bash", {
				command: "echo a \\\n# <<EOF\ngit commit -m x\nEOF",
			}),
		).toBe(true);
	});

	it("reads a substitution in a word a line continuation joins", () => {
		// Bash runs `-m 'a#<output of git add -A>'`: no blank came before the
		// `\<newline>`, so the `#` is a character of the word.
		const answer = plan(`git commit -m "a"\\\n#"$(git add -A)"`);
		expect(answer).toHaveProperty("unresolved");
		expect((answer as { unresolved: string }).unresolved).toContain(
			"substitution runs `git`",
		);
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

	// Recurrence prevented: bash runs an unquoted here-doc's substitutions
	// before the commit, and a `'` in the message hides them from a scan of
	// the command text, so the decoder names them.
	it("names the commands an unquoted here-doc's substitutions run", () => {
		const commands = decodeShellCommand(
			"git commit -F - <<EOF\ndon't $(git add x)\nEOF",
		);
		expect(
			commands.map((simple) => [
				simple.words.map((word) => word.text).join(" "),
				simple.heredocSubstitution === true,
			]),
		).toEqual([
			["git commit -F -", false],
			["git add x", true],
		]);
		expect(
			decodeShellCommand("git commit -F - <<'EOF'\n$(git add x)\nEOF"),
		).toHaveLength(1);
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
