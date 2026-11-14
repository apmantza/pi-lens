// flake-shape: real-process-spawn — the subject is the commit gate's own `git` reads and the real tree-sitter and ast-grep lanes over a real git repository, inside a real pi `AgentSession`; a stub could not say whether bytes nobody authored reached `git commit` judged on their staged delta.
/**
 * #5553 acceptance 4 and 5: `--lens-guard` judges the staged delta at
 * `git commit`, whoever wrote the bytes.
 *
 * Recurrence prevented: the gate read a record that only a write made through
 * a classified route fills, so bytes nobody authored (a bash command no
 * recogniser reads, a foreign tool that names no path, an external editor)
 * committed with a `debugger;` in them (`allowed(committed)`, writer-route
 * audit G2, 2026-11-13). The gate now asks git what the commit carries (a
 * dry run of the command's own commit) and judges each file's committed bytes
 * on the lines no base holds.
 *
 * REAL here: the BUILT extension's handlers inside a real pi `AgentSession`
 * (acceptance), the gate's own entry `gateStagedDelta` (the forms), the
 * dispatcher's lanes and real git repositories. Scripted is the model only,
 * at the provider boundary.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../clients/degradation-ledger.js";
import { Type } from "../clients/deps/typebox.js";
import {
	classifyObservedRunner,
	observeRunnerLatency,
	resetObservedRunnerLatency,
} from "../clients/dispatch/collect-later-tier.js";
import { gateStagedDelta } from "../clients/staged-delta.js";
import { execFileSync } from "./support/git-fixture-env.js";
import { useGlobalConfig } from "./support/global-config.js";
import {
	fauxToolCall,
	type PiFauxReply,
	piSessionFixture,
	startPiSession,
} from "./support/pi-session.js";
import {
	endTurn,
	GATE_BLOCK,
	GUARDED_FLAGS,
	RAN_MARKER,
	readTarget,
	step,
	toolResults,
	warmGuardedSession,
} from "./support/pi-session-commit-gate.js";

const fixture = piSessionFixture();
const setGlobalConfig = useGlobalConfig();

beforeAll(() => warmGuardedSession(fixture.root));

// oxlint is switched off: under husky's relative `node_modules/.bin` PATH
// entry a bare `oxlint` resolves but cannot spawn from a fixture's cwd, and the
// gate rightly refuses a lane that gives no answer. The blocker these tests
// judge is tree-sitter's `debugger-statement`; biome stays on for the lane
// failure row.
beforeEach(() =>
	setGlobalConfig({
		lsp: {
			disabledServers: ["deno", "ast-grep", "zizmor", "typos", "opengrep"],
		},
		dispatch: { disabledRunners: ["oxlint"] },
	}),
);

/** A clean committed file; `void alpha;` is a statement a writer can turn into `debugger;`. */
const CLEAN = [
	"export function f(): number {",
	"\tconst alpha = 1;",
	"\tvoid alpha;",
	"\treturn alpha;",
	"}",
	"",
].join("\n");
/** The committed file whose `debugger;` is the inherited blocker. */
const WITH_BLOCKER = CLEAN.replace("void alpha;", "debugger;");
/** The clean file with the blocker added. */
const ADDED = WITH_BLOCKER;
/** An unrelated change to a line that is not the blocker's. */
const UNRELATED = WITH_BLOCKER.replace("return alpha;", "return alpha + 1;");
const WITH_BLOCKER_PLUS_ONE_MORE = WITH_BLOCKER.replace(
	"return alpha;",
	"debugger;\n\treturn alpha;",
);

function git(proj: string, ...args: string[]): string {
	return execFileSync("git", args, {
		cwd: proj,
		encoding: "utf8",
		stdio: "pipe",
	}).trim();
}

/**
 * A project whose `HEAD` holds `files` (relative path to bytes); with none, a
 * repository with no commit yet.
 */
function seedProject(name: string, files: Record<string, string>) {
	const proj = path.join(fixture.root, name, "proj");
	fs.mkdirSync(proj, { recursive: true });
	fs.writeFileSync(path.join(proj, "package.json"), "{}\n");
	git(proj, "init", "-q");
	git(proj, "config", "user.name", "t");
	git(proj, "config", "user.email", "t@t.local");
	for (const [file, bytes] of Object.entries(files)) {
		fs.mkdirSync(path.dirname(path.join(proj, file)), { recursive: true });
		fs.writeFileSync(path.join(proj, file), bytes);
	}
	if (Object.keys(files).length > 0) {
		git(proj, "add", "-A");
		git(proj, "commit", "-qm", "base");
	}
	return proj;
}

/** A project whose `HEAD` holds `committed` as `src/target.ts`. */
function seedRepo(name: string, committed: string) {
	const proj = seedProject(name, { "src/target.ts": committed });
	return { proj, target: path.join(proj, "src", "target.ts") };
}

/** The guarded set with delta on, as the #5553 writer witness runs it. */
function flags(): Map<string, boolean> {
	return new Map(
		GUARDED_FLAGS.map(([name, value]): [string, boolean] => [
			name,
			name === "no-delta" || name === "no-autofix" ? false : value,
		]),
	);
}

/** A tool that names no path: its writes are bytes nobody authored (`foreign-blind`). */
function blindWriter(target: string, content: string): ToolDefinition {
	return {
		name: "blind_write",
		label: "Blind write",
		description: "Rewrite the project's one source file.",
		parameters: Type.Object({ note: Type.String() }),
		async execute() {
			fs.writeFileSync(target, content);
			return { content: [{ type: "text", text: "done" }], details: {} };
		},
	} as ToolDefinition;
}

/** A bash command no recogniser reads as a write: a script's own `writeFileSync` (`bash-opaque`). */
function opaqueWrite(target: string, from: string, to: string): PiFauxReply {
	const script = `const fs=require('fs');const p=process.argv[1];fs.writeFileSync(p,fs.readFileSync(p,'utf8').replace('${from}','${to}'))`;
	return step(
		fauxToolCall("bash", { command: `node -e "${script}" ${target}` }),
		"scripting",
	);
}

const stage = (target: string): PiFauxReply =>
	step(fauxToolCall("bash", { command: `git add ${target}` }), "staging");
const COMMIT = (command = 'git commit -m "wip"'): PiFauxReply =>
	step(
		fauxToolCall("bash", { command: `${command}; echo ${RAN_MARKER}` }),
		"committing",
	);

/** One unauthored writer: how it changes the file, and the bytes it leaves. */
interface Writer {
	readonly name: string;
	/** The steps of the first prompt. */
	readonly write: (target: string, from: string, to: string) => PiFauxReply[];
	/** What the test does between prompts, with no pi-lens tool involved. */
	readonly between?: (target: string, bytes: string) => void;
}

const WRITERS: readonly Writer[] = [
	{
		name: "a bash script no recogniser reads (bash-opaque)",
		write: (t, from, to) => [opaqueWrite(t, from, to)],
	},
	{
		name: "a foreign tool that names no path (foreign-blind)",
		write: () => [
			step(fauxToolCall("blind_write", { note: "rewrite" }), "writing"),
		],
	},
	{
		name: "an external editor between turns (external-editor)",
		write: () => [],
		between: (t, bytes) => fs.writeFileSync(t, bytes),
	},
];

/**
 * Run `writer` over a repo whose `HEAD` holds `committed`, leaving `bytes` on
 * disk, stage the file, then try to commit.
 */
async function commitAfter(
	name: string,
	writer: Writer,
	committed: string,
	bytes: string,
	from: string,
	to: string,
) {
	const { proj, target } = seedRepo(name, committed);
	const handle = await startPiSession({
		root: fixture.root,
		cwd: proj,
		flags: flags(),
		inlineFactory: async () => (await import("../index.js")).default,
		customTools: [blindWriter(target, bytes)],
		responses: [
			step(readTarget(target), "reading"),
			...writer.write(target, from, to),
			endTurn("written"),
			stage(target),
			COMMIT(),
			endTurn("done"),
		],
	});
	// Staging and committing wait for the second prompt, so an external
	// editor's bytes land between the two.
	await handle.prompt("look at the file");
	writer.between?.(target, bytes);
	await handle.prompt("stage it and commit");
	expect(fs.readFileSync(target, "utf8")).toBe(bytes);
	const commits = toolResults(handle.requests.at(-1) ?? [], "bash").filter(
		(r) => r.text.includes(RAN_MARKER) || r.text.includes(GATE_BLOCK),
	);
	expect(commits).toHaveLength(1);
	return commits[0];
}

describe("#5553 the commit gate judges the staged delta whoever wrote the bytes", () => {
	describe.each(WRITERS)("$name", (writer) => {
		const slug = writer.name.replace(/\W+/g, "-");

		// Acceptance 4. Recurrence prevented: the three routes were
		// `allowed(committed)` with a `debugger;` in the commit (audit G2).
		it("refuses a blocker its bytes add", { timeout: 120_000 }, async () => {
			const commit = await commitAfter(
				`${slug}-adds`,
				writer,
				CLEAN,
				ADDED,
				"void alpha;",
				"debugger;",
			);
			expect(commit?.text).toContain(GATE_BLOCK);
			expect(commit?.text).not.toContain(RAN_MARKER);
		});

		// Acceptance 3 for the unauthored routes. Recurrence prevented: a rule
		// that let inherited debt through by line text would also let an added
		// `debugger;` that reads like the committed one commit.
		it(
			"refuses a second blocker added beside the inherited one",
			{
				timeout: 120_000,
			},
			async () => {
				const commit = await commitAfter(
					`${slug}-second`,
					writer,
					WITH_BLOCKER,
					WITH_BLOCKER_PLUS_ONE_MORE,
					"return alpha;",
					"debugger;\\n\\treturn alpha;",
				);
				expect(commit?.text).toContain(GATE_BLOCK);
				expect(commit?.text).not.toContain(RAN_MARKER);
			},
		);

		// Acceptance 5. Recurrence prevented: the fix for acceptance 4 must not
		// read the whole file, or an unrelated change by a writer nobody
		// authored would be refused over the `debugger;` HEAD already holds,
		// the inherited-debt block #5553 closed for the named writers.
		it(
			"commits an unrelated change to a file whose only blocker is in HEAD",
			{
				timeout: 120_000,
			},
			async () => {
				const commit = await commitAfter(
					`${slug}-unrelated`,
					writer,
					WITH_BLOCKER,
					UNRELATED,
					"return alpha;",
					"return alpha + 1;",
				);
				expect(commit?.text).not.toContain(GATE_BLOCK);
				expect(commit?.text).toContain(RAN_MARKER);
			},
		);
	});
});

/** What the commit gate answers `command`, asked as the `tool_call` hook asks it. */
function decide(
	proj: string,
	command: string,
	options: {
		cwd?: string;
		budgetMs?: number;
		signal?: AbortSignal;
		noDelta?: boolean;
	} = {},
) {
	return gateStagedDelta(
		"bash",
		{ command },
		{
			cwd: options.cwd ?? proj,
			projectRoot: proj,
			getFlag: (flag) => flag === "no-delta" && options.noDelta === true,
		},
		options.signal,
		options.budgetMs,
	);
}

/** `commits`, `refuses` naming `file`, or `unknown` with the degraded reason. */
type Outcome = "commits" | `refuses ${string}` | `unknown ${string}`;

function expectOutcome(
	decision: Awaited<ReturnType<typeof decide>>,
	outcome: Outcome,
): void {
	const reason = decision.reason ?? "";
	if (outcome === "commits") {
		expect(decision.block, reason).toBe(false);
		return;
	}
	const [kind, detail = ""] = outcome.split(" ");
	expect(decision.block, reason).toBe(true);
	if (kind === "refuses") {
		expect(decision.unknown, reason).toBeUndefined();
		expect(reason).toContain("adds blocking findings");
		expect(reason).toContain(`${detail}:`);
	} else {
		expect(decision.unknown, reason).toBe(true);
		expect(reason).toContain(`staged_delta_${detail}`);
	}
}

const A = "src/a.ts";
const B = "src/b.ts";
const B_EDITED = CLEAN.replace("return alpha;", "return alpha + 1;");

function write(proj: string, file: string, bytes: string): void {
	fs.mkdirSync(path.dirname(path.join(proj, file)), { recursive: true });
	fs.writeFileSync(path.join(proj, file), bytes);
}

/** The read's staged copies left in the tree: none outlives a call. */
function stagedCopies(proj: string): string[] {
	return git(proj, "status", "--porcelain", "--untracked-files=all")
		.split("\n")
		.filter((line) => line.includes("pi-lens-staged-"));
}

let seeded = 0;
/**
 * Two clean files in HEAD. An external editor then puts a `debugger;` in
 * `a.ts` and leaves it unstaged, and edits `b.ts` cleanly and stages it.
 */
function twoFileProject(): string {
	const proj = seedProject(`form-${seeded++}`, { [A]: CLEAN, [B]: CLEAN });
	write(proj, A, ADDED);
	write(proj, B, B_EDITED);
	git(proj, "add", B);
	return proj;
}

describe("#5553 git resolves what the commit carries", () => {
	/**
	 * A form that carries `a.ts` refuses on its `debugger;`; one that does not,
	 * commits. Recurrence prevented: round 1 read the set from the commit's
	 * argv, and each review found a spelling it read wrong (a quoted glob, a
	 * magic pathspec, `-c`, a `git add` before the commit read as the whole
	 * tree); git's own dry run answers every one of them.
	 */
	const FORMS: ReadonlyArray<{
		form: string;
		command: string;
		outcome: Outcome;
	}> = [
		{
			form: "plain, an index with b",
			command: 'git commit -m "wip"',
			outcome: "commits",
		},
		{ form: "-a", command: 'git commit -a -m "wip"', outcome: `refuses ${A}` },
		{
			form: "--all",
			command: 'git commit --all -m "wip"',
			outcome: `refuses ${A}`,
		},
		{ form: "-am", command: 'git commit -am "wip"', outcome: `refuses ${A}` },
		{
			form: "a pathspec naming a",
			command: `git commit -m "wip" ${A}`,
			outcome: `refuses ${A}`,
		},
		{
			form: "a pathspec naming b",
			command: `git commit -m "wip" ${B}`,
			outcome: "commits",
		},
		{
			form: "-o naming b",
			command: `git commit -o -m "wip" ${B}`,
			outcome: "commits",
		},
		{
			form: "-i naming a",
			command: `git commit -i -m "wip" ${A}`,
			outcome: `refuses ${A}`,
		},
		{
			form: "a quoted glob git expands",
			command: `git commit -m "wip" 'src/*.ts'`,
			outcome: `refuses ${A}`,
		},
		{
			form: "a :(glob) magic pathspec",
			command: `git commit -m "wip" ':(glob)src/**'`,
			outcome: `refuses ${A}`,
		},
		{
			form: "a :/ top pathspec",
			command: `git commit -m "wip" ':/src'`,
			outcome: `refuses ${A}`,
		},
		{
			form: "an exclude pathspec",
			command: `git commit -m "wip" ':!${B}'`,
			outcome: `refuses ${A}`,
		},
		{
			form: "--pathspec-from-file=-",
			command: 'git commit --pathspec-from-file=- -m "wip"',
			outcome: `refuses ${A}`,
		},
		{
			form: "--amend on the index",
			command: "git commit --amend --no-edit",
			outcome: "commits",
		},
		{
			form: "--amend -a",
			command: "git commit --amend -a --no-edit",
			outcome: `refuses ${A}`,
		},
		{
			form: "-c before the verb",
			command: 'git -c user.name=z commit -m "wip"',
			outcome: "commits",
		},
		{
			form: "-c before the verb, -a",
			command: 'git -c user.name=z commit -a -m "wip"',
			outcome: `refuses ${A}`,
		},
		{
			form: "-C <dir> before the verb",
			command: 'git -C . commit -a -m "wip"',
			outcome: `refuses ${A}`,
		},
		{
			form: "a cd before it",
			command: 'cd src && git commit -m "wip"',
			outcome: "commits",
		},
		{
			form: "a cd before it, -a",
			command: 'cd src && git commit -a -m "wip"',
			outcome: `refuses ${A}`,
		},
		{
			form: "git add of b before it",
			command: `git add ${B} && git commit -m "wip"`,
			outcome: "commits",
		},
		{
			form: "git add of a before it",
			command: `git add ${A} && git commit -m "wip"`,
			outcome: `refuses ${A}`,
		},
		{
			form: "a here-doc message",
			command: `git commit -m "$(cat <<'EOF'\nwip\n\nbody\nEOF\n)"`,
			outcome: "commits",
		},
		{
			form: "a here-doc message, -a",
			command: `git commit -a -m "$(cat <<'EOF'\nwip\nEOF\n)"`,
			outcome: `refuses ${A}`,
		},
		{
			form: "read-only git before it",
			command: 'git status && git diff --stat && git commit -m "wip"',
			outcome: "commits",
		},
		// Recurrence prevented: a push segment read as a commit would pass its
		// own words (`--force`) to the commit's replay.
		{
			form: "a push after the commit",
			command: 'git commit -m "wip" && git push --force origin',
			outcome: "commits",
		},
		{
			form: "output piped after it",
			command: 'git commit -m "wip" 2>&1 | tail -3',
			outcome: "commits",
		},
		{
			form: "an unknown option",
			command: 'git commit --frobnicate -m "wip"',
			outcome: "unknown git_failed",
		},
		{
			form: "an indirect launcher",
			command: `sh -c 'git commit -m wip'`,
			outcome: "unknown unresolved_command",
		},
		{
			form: "a command before it that may write",
			command: 'npm test && git commit -m "wip"',
			outcome: "unknown unresolved_command",
		},
		{
			form: "git rm before it",
			command: `git rm -q ${B} && git commit -m "wip"`,
			outcome: "unknown unresolved_command",
		},
		{
			form: "a pathspec the shell expands",
			command: 'git commit -m "wip" src/*.ts',
			outcome: "unknown unresolved_command",
		},
		{
			form: "a message substitution that writes",
			command: 'git commit -m "$(git add -A)"',
			outcome: "unknown unresolved_command",
		},
		{
			form: "two commits",
			command: "git commit -m a && git commit -am b",
			outcome: "unknown unresolved_command",
		},
		{
			form: "an input redirection",
			command: "git commit --interactive < answers.txt",
			outcome: "unknown unresolved_command",
		},
		{
			form: "an assignment outside git's own",
			command: 'GIT_CONFIG_PARAMETERS="" git commit -m "wip"',
			outcome: "unknown unresolved_command",
		},
	];
	it.each(FORMS)(
		"$form",
		{ timeout: 120_000 },
		async ({ command, outcome }) => {
			const proj = twoFileProject();
			expectOutcome(await decide(proj, command), outcome);
			// The replay leaves the real index as it found it.
			expect(git(proj, "diff", "--cached", "--name-only")).toBe(B);
		},
	);

	// Recurrence prevented: a session in a subdirectory read the staged set
	// from that directory alone (C6), so `a.ts` would escape a commit run there.
	it.each([
		{ command: 'git commit -m "wip"', outcome: "commits" as const },
		{ command: 'git commit -a -m "wip"', outcome: `refuses ${A}` as const },
	])(
		"judges $command from a subdirectory as git runs it",
		{ timeout: 120_000 },
		async ({ command, outcome }) => {
			const proj = twoFileProject();
			write(proj, "other/keep.ts", CLEAN);
			expectOutcome(
				await decide(proj, command, { cwd: path.join(proj, "other") }),
				outcome,
			);
		},
	);

	// Recurrence prevented: git's "nothing to commit" is the dry run's exit 1
	// with nothing on stderr; read as a failure it would refuse a commit git
	// refuses by itself with its own message.
	it(
		"lets git answer a commit that carries nothing",
		{ timeout: 120_000 },
		async () => {
			const proj = seedProject(`nothing-${seeded++}`, { [A]: CLEAN });
			write(proj, "notes/scratch.ts", ADDED);
			expectOutcome(await decide(proj, 'git commit -m "wip"'), "commits");
		},
	);

	// Recurrence prevented: `--no-dry-run` after the replay's own `--dry-run`
	// turns the replay into a real commit; the hook net stops it before the
	// commit exists, and its refusal must not read as "nothing to commit".
	it(
		"refuses a command that turns the dry run into a real commit, and commits nothing",
		{
			timeout: 120_000,
		},
		async () => {
			const proj = twoFileProject();
			const head = git(proj, "rev-parse", "HEAD");
			for (const extra of ["", " --no-verify"])
				expectOutcome(
					await decide(
						proj,
						`git commit -a --no-porcelain --no-null --no-dry-run${extra} -m wip`,
					),
					"unknown git_failed",
				);
			expect(git(proj, "rev-parse", "HEAD")).toBe(head);
		},
	);
});

describe("#5553 the bytes each carried file is judged on", () => {
	// Recurrence prevented (F2): the lanes read the working file, so a
	// `debugger;` staged and then edited away in the working file committed
	// through `-c` or `GIT_INDEX_FILE=` forms. The index blob is what commits.
	it.each([
		'git commit -m "x"',
		'git -c user.name=z commit -m "x"',
		'GIT_INDEX_FILE=.git/index git commit -m "x"',
	])(
		"refuses %s when the index holds a blocker the working file does not",
		{ timeout: 120_000 },
		async (command) => {
			const proj = seedProject(`index-blob-${seeded++}`, { [A]: CLEAN });
			write(proj, A, ADDED);
			git(proj, "add", A);
			write(proj, A, CLEAN);
			expectOutcome(await decide(proj, command), `refuses ${A}`);
			expect(stagedCopies(proj)).toEqual([]);
		},
	);

	// Recurrence prevented (F7): round 1 refused every partial staging as
	// `bytes_not_staged`; a clean index blob commits whatever the working file holds.
	it(
		"commits a clean index blob beside a working file with a blocker",
		{
			timeout: 120_000,
		},
		async () => {
			const proj = seedProject("partial", { [A]: CLEAN });
			write(proj, A, B_EDITED);
			git(proj, "add", A);
			write(proj, A, ADDED);
			expectOutcome(await decide(proj, 'git commit -m "x"'), "commits");
			expect(stagedCopies(proj)).toEqual([]);
		},
	);

	// Recurrence prevented (F6): a file git reads as binary (a NUL byte, a
	// `-diff` attribute) has no hunks, so a delta read from `git diff` judged
	// none of it.
	it.each([
		{ name: "holds a NUL byte", attributes: undefined, nul: true },
		{ name: "has the -diff attribute", attributes: "*.ts -diff\n", nul: false },
	])(
		"refuses a blocker in a file that $name",
		{ timeout: 120_000 },
		async ({ attributes, nul }) => {
			const proj = seedProject(`binary-${seeded++}`, {
				[A]: CLEAN,
				...(attributes && { ".gitattributes": attributes }),
			});
			write(
				proj,
				A,
				nul
					? ADDED.replace("const alpha = 1;", "const alpha = 1; // \0")
					: ADDED,
			);
			git(proj, "add", A);
			expectOutcome(await decide(proj, 'git commit -m "x"'), `refuses ${A}`);
		},
	);

	// Recurrence prevented: with no HEAD there is no base, which a read that
	// took a failed base lookup for "nothing staged" would pass.
	it.each([
		{ name: "adds a blocker", bytes: ADDED, outcome: `refuses ${A}` as const },
		{ name: "is clean", bytes: CLEAN, outcome: "commits" as const },
	])("a first commit with no HEAD $name", { timeout: 120_000 }, async (c) => {
		const proj = seedProject(`first-${seeded++}`, {});
		write(proj, A, c.bytes);
		git(proj, "add", A);
		expectOutcome(await decide(proj, 'git commit -m "wip"'), c.outcome);
	});

	// Recurrence prevented: a deleted file has no bytes; listing it as a file
	// to lint would read a missing path as degraded or as the old blocker.
	it(
		"commits the deletion of a file that held a blocker",
		{
			timeout: 120_000,
		},
		async () => {
			const proj = seedProject("deleted", { [A]: WITH_BLOCKER, [B]: CLEAN });
			git(proj, "rm", "-q", A);
			expectOutcome(await decide(proj, 'git commit -m "wip"'), "commits");
		},
	);

	// Recurrence prevented: a rename read as a new file is wholly added, so a
	// move of a file with an inherited blocker would refuse over HEAD's debt;
	// read without its source it would miss the line the move adds.
	it.each([
		{ name: "a pure rename", bytes: undefined, outcome: "commits" as const },
		{
			name: "a rename that adds a blocker",
			bytes: WITH_BLOCKER_PLUS_ONE_MORE,
			outcome: "refuses src/moved.ts" as const,
		},
	])(
		"judges $name against the source's blob",
		{ timeout: 120_000 },
		async (c) => {
			const proj = seedProject(`rename-${seeded++}`, { [A]: WITH_BLOCKER });
			git(proj, "mv", A, "src/moved.ts");
			if (c.bytes) write(proj, "src/moved.ts", c.bytes);
			git(proj, "add", "src/moved.ts");
			expectOutcome(await decide(proj, 'git commit -m "wip"'), c.outcome);
		},
	);

	// Recurrence prevented: without `--no-delta` honoured the delta read would
	// keep passing a file the operator asked to judge whole.
	it(
		"judges the whole file under --no-delta",
		{
			timeout: 120_000,
		},
		async () => {
			const proj = seedProject("no-delta", { [A]: WITH_BLOCKER });
			write(proj, A, UNRELATED);
			git(proj, "add", A);
			expectOutcome(await decide(proj, 'git commit -m "x"'), "commits");
			expectOutcome(
				await decide(proj, 'git commit -m "x"', { noDelta: true }),
				`refuses ${A}`,
			);
		},
	);
});

describe("#5553 a git add before the commit is replayed", () => {
	// Recurrence prevented (F5): round 1 judged the whole tree for any
	// `git add X && git commit`, and refused over an untracked scratch file the
	// add never staged.
	it(
		"judges what the add stages, not an untracked file it leaves",
		{
			timeout: 120_000,
		},
		async () => {
			const proj = seedProject("scratch", { [B]: CLEAN });
			write(proj, B, B_EDITED);
			write(proj, "scratch/probe.ts", ADDED);
			expectOutcome(
				await decide(proj, `git add ${B} && git commit -m "x"`),
				"commits",
			);
			expectOutcome(
				await decide(proj, 'git add -A && git commit -m "x"'),
				"refuses scratch/probe.ts",
			);
			// The replay staged nothing for real.
			expect(git(proj, "diff", "--cached", "--name-only")).toBe("");
		},
	);

	// Recurrence prevented (C6): an untracked file listed from a subdirectory
	// cwd was cwd-scoped, so `git add -A` there (which stages the whole tree)
	// carried a file the read never saw.
	it.each(["src", "other"])(
		"judges git add -A run from %s as the whole tree",
		{ timeout: 120_000 },
		async (dir) => {
			const proj = seedProject(`subdir-${seeded++}`, {
				[B]: CLEAN,
				"other/o.ts": CLEAN,
			});
			write(proj, "src/new.ts", ADDED);
			expectOutcome(
				await decide(proj, 'git add -A && git commit -m "x"', {
					cwd: path.join(proj, dir),
				}),
				"refuses src/new.ts",
			);
		},
	);

	// Recurrence prevented (C7): a `-C` on the add and the commit read the
	// session's repository instead of the nested one they name.
	it(
		"replays git -C on the repository it names",
		{
			timeout: 120_000,
		},
		async () => {
			const proj = seedProject("outer", { [A]: CLEAN });
			const nested = path.join(proj, "nested");
			fs.mkdirSync(nested);
			git(nested, "init", "-q");
			git(nested, "config", "user.name", "t");
			git(nested, "config", "user.email", "t@t.local");
			write(nested, "x.ts", CLEAN);
			git(nested, "add", "-A");
			git(nested, "commit", "-qm", "base");
			write(nested, "y.ts", ADDED);
			expectOutcome(
				await decide(
					proj,
					'git -C nested add -A && git -C nested commit -m "x"',
				),
				"refuses nested/y.ts",
			);
		},
	);
});

describe("#5553 a merge commit is judged against every parent", () => {
	// Recurrence prevented (F4): judged against the first parent alone, a merge
	// refused over a blocker the other parent already holds, and read every
	// incoming file through the lanes until the bound passed.
	it(
		"commits an incoming blocker and 300 incoming files inside a 5 s bound, refuses one the resolution adds",
		{
			timeout: 120_000,
		},
		async () => {
			const proj = seedProject("merge", { [A]: CLEAN, [B]: CLEAN });
			git(proj, "checkout", "-qb", "topic");
			write(proj, A, ADDED);
			for (let i = 0; i < 300; i++)
				write(proj, `gen/f${i}.ts`, `export const v${i} = ${i};\n`);
			git(proj, "add", "-A");
			git(proj, "commit", "-qm", "topic");
			git(proj, "checkout", "-q", "-");
			write(proj, B, B_EDITED);
			git(proj, "commit", "-qam", "main");
			git(proj, "merge", "--no-commit", "--no-ff", "topic");
			expectOutcome(
				await decide(proj, "git commit --no-edit", { budgetMs: 5_000 }),
				"commits",
			);
			write(proj, B, ADDED);
			git(proj, "add", B);
			expectOutcome(await decide(proj, "git commit --no-edit"), `refuses ${B}`);
		},
	);

	// Decision pinned: `--no-delta` judges a carried file whole, but a file
	// equal to a parent's blob is not one the merge adds to, so it commits;
	// judging it would refuse every merge of a branch with old debt.
	it(
		"commits an incoming file equal to the other parent's under --no-delta",
		{ timeout: 120_000 },
		async () => {
			const proj = seedProject("merge-no-delta", { [A]: CLEAN, [B]: CLEAN });
			git(proj, "checkout", "-qb", "topic");
			write(proj, A, ADDED);
			git(proj, "commit", "-qam", "topic");
			git(proj, "checkout", "-q", "-");
			write(proj, B, B_EDITED);
			git(proj, "commit", "-qam", "main");
			git(proj, "merge", "--no-commit", "--no-ff", "topic");
			expectOutcome(
				await decide(proj, "git commit --no-edit", { noDelta: true }),
				"commits",
			);
		},
	);
});

describe("#5553 a lane that gives no answer refuses", () => {
	// Recurrence prevented (F3): a lane that failed on its config read as a
	// lane that found nothing, so a broken config let every commit through.
	// The control is the same file in a project with no such config.
	it(
		"refuses when a linter fails on its config, and names it",
		{
			timeout: 120_000,
		},
		async () => {
			const proj = seedProject("broken-config", { "biome.json": "{ not json" });
			write(proj, A, CLEAN);
			git(proj, "add", A);
			const decision = await decide(proj, 'git commit -m "x"');
			expectOutcome(decision, "unknown lane_incomplete");
			// The refusal names the lane and how it ended, so the fix is clear.
			expect(decision.reason).toMatch(/biome-check-json \(failed\b/);
			const control = seedProject("valid-config", {});
			write(control, A, CLEAN);
			git(control, "add", A);
			expectOutcome(await decide(control, 'git commit -m "x"'), "commits");
		},
	);

	// Decision pinned: a change that adds no line runs no lane, so a linter
	// that would fail on its config cannot refuse a commit that only deletes.
	it(
		"commits a change that adds no line beside a broken linter config",
		{ timeout: 120_000 },
		async () => {
			const proj = seedProject("deletes-only", {
				"biome.json": "{ not json",
				[A]: CLEAN,
			});
			write(proj, A, CLEAN.replace("\tvoid alpha;\n", ""));
			git(proj, "add", A);
			expectOutcome(await decide(proj, 'git commit -m "x"'), "commits");
		},
	);

	// Recurrence prevented (C2): a runner the latency tier once saw as slow
	// moved to collect-later, and the staged read dropped it, so the file read
	// as having no linter.
	it(
		"runs a runner the latency tier moved to collect-later",
		{
			timeout: 120_000,
		},
		async () => {
			const proj = seedProject("collect-later", { [A]: CLEAN });
			write(proj, A, ADDED);
			git(proj, "add", A);
			try {
				observeRunnerLatency({
					projectRoot: proj,
					runnerId: "tree-sitter",
					durationMs: 600_000,
					timedOut: true,
				});
				expect(classifyObservedRunner(proj, "tree-sitter")).toBe(
					"collect-later",
				);
				expectOutcome(await decide(proj, 'git commit -m "x"'), `refuses ${A}`);
			} finally {
				resetObservedRunnerLatency();
			}
		},
	);
});

describe("#5553 a read that gives no answer refuses, recorded once", () => {
	const stagedProject = (name: string) => {
		const proj = seedProject(name, { [A]: CLEAN });
		write(proj, A, ADDED);
		git(proj, "add", A);
		return proj;
	};
	const subjects = () =>
		getDegradationSummary()
			.find((g) => g.kind === "staged-delta-degraded")
			?.latestReasons.map((r) => r.subject);

	// Recurrence prevented (F10): the bound's refusal also wrote a `git_failed`
	// row for the git read it abandoned, naming a cause that did not happen.
	it("refuses once the bound has passed", { timeout: 120_000 }, async () => {
		resetDegradationLedger();
		const proj = stagedProject("bound");
		expectOutcome(
			await decide(proj, 'git commit -m "x"', { budgetMs: 1 }),
			"unknown lane_incomplete",
		);
		// The same file read again inside the real bound refuses on its
		// finding; by then the abandoned read's aborted git child has settled.
		expectOutcome(await decide(proj, 'git commit -m "x"'), `refuses ${A}`);
		expect(subjects()).toEqual(["lane_incomplete"]);
	});

	it("refuses for a turn that was aborted", { timeout: 120_000 }, async () => {
		expectOutcome(
			await decide(stagedProject("aborted"), 'git commit -m "x"', {
				signal: AbortSignal.abort(),
			}),
			"unknown lane_incomplete",
		);
	});

	// Recurrence prevented (C9): a throw outside the lanes' own catch escaped
	// the gate, and `tool_call`'s catch let the command run.
	it("refuses when the read throws", { timeout: 120_000 }, async () => {
		const proj = stagedProject("throws");
		const saved = process.env.TMPDIR;
		process.env.TMPDIR = path.join(fixture.root, "no-such-tmp");
		try {
			const decision = await decide(proj, 'git commit -m "x"');
			expectOutcome(decision, "unknown lane_incomplete");
			expect(decision.reason).toContain("threw");
		} finally {
			process.env.TMPDIR = saved;
		}
	});

	// Bounded observability: one record per subject per session.
	it("records a repeated refusal once", { timeout: 120_000 }, async () => {
		resetDegradationLedger();
		const proj = stagedProject("repeated");
		for (let i = 0; i < 2; i++)
			expectOutcome(
				await decide(proj, `sh -c 'git commit -m x${i}'`),
				"unknown unresolved_command",
			);
		const group = getDegradationSummary().find(
			(g) => g.kind === "staged-delta-degraded",
		);
		expect(group?.count).toBe(1);
		expect(subjects()).toEqual(["unresolved_command"]);
	});

	// A commit git runs outside any repository fails by itself, so the read
	// has nothing to judge; an add there is not replayed and refuses.
	// Recurrence prevented: a refusal here named a blocker state for a commit
	// that cannot land, and blocked the record gate's witnesses run in a
	// directory with an empty `.git`.
	it(
		"lets git refuse a commit outside any repository, refuses an add there",
		{ timeout: 120_000 },
		async () => {
			const bare = path.join(fixture.root, "norepo");
			fs.mkdirSync(bare, { recursive: true });
			expectOutcome(await decide(bare, 'git commit -m "x"'), "commits");
			const proj = stagedProject("add-norepo");
			expectOutcome(
				await decide(proj, `git -C ${bare} add -A; git commit -m "x"`),
				"unknown git_failed",
			);
		},
	);

	// Control: the same staged file and the real budget refuse on the
	// finding, so the refusals above are the bound's and not the file's.
	it(
		"control: the same file refuses on its blocker inside the bound",
		{
			timeout: 120_000,
		},
		async () => {
			expectOutcome(
				await decide(stagedProject("control"), 'git commit -m "x"'),
				`refuses ${A}`,
			);
		},
	);
});
