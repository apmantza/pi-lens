// flake-shape: real-process-spawn — the subject is the commit gate's own `git` reads and the real tree-sitter and ast-grep lanes over a real git repository, inside a real pi `AgentSession`; a stub could not say whether bytes nobody authored reached `git commit` judged on their staged delta.
/**
 * #5553 acceptance 4 and 5: `--lens-guard` judges the staged delta at
 * `git commit`, whoever wrote the bytes.
 *
 * Recurrence prevented: the gate read a record that only a write made through
 * a classified route fills, so bytes nobody authored (a bash command no
 * recogniser reads, a foreign tool that names no path, an external editor)
 * committed with a `debugger;` in them (`allowed(committed)`, writer-route
 * audit G2, 2026-11-13). The gate now lists the staged set itself and judges
 * each file on the lines the commit adds against `HEAD`.
 *
 * REAL here: the BUILT extension's handlers inside a real pi `AgentSession`,
 * the dispatcher's lanes, the commit gate and a real git repository. Scripted
 * is the model only, at the provider boundary.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Type } from "../clients/deps/typebox.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../clients/degradation-ledger.js";
import { gateStagedDelta } from "../clients/staged-delta.js";
import { useGlobalConfig } from "./support/global-config.js";
import { execFileSync } from "./support/git-fixture-env.js";
import {
	GATE_BLOCK,
	GUARDED_FLAGS,
	RAN_MARKER,
	endTurn,
	readTarget,
	step,
	toolResults,
	warmGuardedSession,
} from "./support/pi-session-commit-gate.js";
import {
	type PiFauxReply,
	fauxToolCall,
	piSessionFixture,
	startPiSession,
} from "./support/pi-session.js";

const fixture = piSessionFixture();
const setGlobalConfig = useGlobalConfig();

beforeAll(() => warmGuardedSession(fixture.root));

beforeEach(() =>
	setGlobalConfig({
		lsp: {
			disabledServers: ["deno", "ast-grep", "zizmor", "typos", "opengrep"],
		},
	}),
);

/** A clean committed file; `placeholder;` is a statement a writer can turn into `debugger;`. */
const CLEAN = [
	"export function f(): number {",
	"\tconst alpha = 1;",
	"\tplaceholder;",
	"\treturn alpha;",
	"}",
	"",
].join("\n");
/** The committed file whose `debugger;` is the inherited blocker. */
const WITH_BLOCKER = CLEAN.replace("placeholder;", "debugger;");
/** The clean file with the blocker added. */
const ADDED = WITH_BLOCKER;
/** An unrelated change to a line that is not the blocker's. */
const UNRELATED = WITH_BLOCKER.replace("return alpha;", "return alpha + 1;");
const WITH_BLOCKER_PLUS_ONE_MORE = WITH_BLOCKER.replace(
	"return alpha;",
	"debugger;\n\treturn alpha;",
);

function git(proj: string, ...args: string[]): void {
	execFileSync("git", args, { cwd: proj, stdio: "ignore" });
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
	git(proj, "config", "user.email", "t@t");
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
				"placeholder;",
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
			{ timeout: 120_000 },
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
			{ timeout: 120_000 },
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

/** What the gate answered one commit command in a project, as the model read it. */
async function commitCommand(
	proj: string,
	command: string,
	between: () => void,
) {
	const handle = await startPiSession({
		root: fixture.root,
		cwd: proj,
		flags: flags(),
		inlineFactory: async () => (await import("../index.js")).default,
		responses: [
			step(readTarget(path.join(proj, "package.json")), "reading"),
			endTurn("looked"),
			COMMIT(command),
			endTurn("done"),
		],
	});
	await handle.prompt("look at the project");
	between();
	await handle.prompt("commit");
	const commits = toolResults(handle.requests.at(-1) ?? [], "bash").filter(
		(r) => r.text.includes(RAN_MARKER) || r.text.includes(GATE_BLOCK),
	);
	expect(commits).toHaveLength(1);
	return commits[0]?.text ?? "";
}

const A = "src/a.ts";
const B = "src/b.ts";
const B_EDITED = CLEAN.replace("return alpha;", "return alpha + 1;");

describe("#5553 the staged set is read from the commit's argv", () => {
	/**
	 * Two clean files in HEAD. An external editor then puts a `debugger;` in
	 * `a.ts` and leaves it unstaged, and edits `b.ts` cleanly and stages it. A
	 * commit form that carries `a.ts` refuses; one that does not, commits.
	 * Recurrence prevented: reading the set from the record (nothing, for
	 * bytes nobody authored) or from the whole tree (every dirty file) would
	 * pass the first row or refuse the second.
	 */
	const FORMS: ReadonlyArray<{
		form: string;
		command: string;
		refused: boolean;
	}> = [
		{
			form: "plain, an index with b",
			command: 'git commit -m "wip"',
			refused: false,
		},
		{ form: "-a", command: 'git commit -a -m "wip"', refused: true },
		{ form: "--all", command: 'git commit --all -m "wip"', refused: true },
		{
			form: "a pathspec naming a",
			command: `git commit -m "wip" ${A}`,
			refused: true,
		},
		{
			form: "a pathspec naming b",
			command: `git commit -m "wip" ${B}`,
			refused: false,
		},
		{
			form: "-o naming b",
			command: `git commit -o -m "wip" ${B}`,
			refused: false,
		},
		{
			form: "-i naming a",
			command: `git commit -i -m "wip" ${A}`,
			refused: true,
		},
		{
			form: "--amend on the index",
			command: "git commit --amend --no-edit",
			refused: false,
		},
		{
			form: "--amend -a",
			command: "git commit --amend -a --no-edit",
			refused: true,
		},
		{
			form: "a short cluster -am",
			command: 'git commit -am "wip"',
			refused: true,
		},
		{
			form: "-C <dir> before the verb",
			command: 'git -C . commit -a -m "wip"',
			refused: true,
		},
		{
			form: "an unknown option",
			command: 'git commit --frobnicate -m "wip"',
			refused: true,
		},
		{ form: "-p", command: "git commit -p", refused: true },
		{
			form: "a pathspec the shell expands",
			command: `git commit -m "wip" src/*.ts`,
			refused: true,
		},
		{
			form: "a cd before it",
			command: 'cd src && git commit -m "wip"',
			refused: true,
		},
		{
			form: "git add and commit in one command",
			command: 'git add src/b.ts && git commit -m "wip"',
			refused: true,
		},
		{
			form: "an indirect launcher",
			command: `sh -c 'git commit -m wip'`,
			refused: true,
		},
	];
	it.each(FORMS)(
		"$form",
		{ timeout: 120_000 },
		async ({ form, command, refused }) => {
			const proj = seedProject(`form-${form.replace(/\W+/g, "-")}`, {
				[A]: CLEAN,
				[B]: CLEAN,
			});
			const text = await commitCommand(proj, command, () => {
				fs.writeFileSync(path.join(proj, A), ADDED);
				fs.writeFileSync(path.join(proj, B), B_EDITED);
				git(proj, "add", B);
			});
			if (refused) {
				expect(text).toContain(GATE_BLOCK);
				expect(text).toContain("src/a.ts");
				expect(text).not.toContain(RAN_MARKER);
			} else {
				expect(text).not.toContain(GATE_BLOCK);
				expect(text).toContain(RAN_MARKER);
			}
		},
	);

	// Recurrence prevented: `git add -A` stages a file git does not list as
	// differing from HEAD, so a superset read from `git diff` alone would never
	// see a new file an external editor created.
	it(
		"reads an untracked file when the form stages by itself",
		{ timeout: 120_000 },
		async () => {
			const proj = seedProject("form-untracked", { [B]: CLEAN });
			const text = await commitCommand(
				proj,
				'git add -A && git commit -m "wip"',
				() => fs.writeFileSync(path.join(proj, A), ADDED),
			);
			expect(text).toContain(GATE_BLOCK);
			expect(text).toContain("src/a.ts");
			expect(text).not.toContain(RAN_MARKER);
		},
	);

	// Recurrence prevented: a push stages and commits nothing, so reading the
	// tree for it would refuse every push over a dirty file.
	it("reads nothing for a push", { timeout: 120_000 }, async () => {
		const proj = seedProject("form-push", { [A]: CLEAN });
		const text = await commitCommand(proj, "git push --dry-run origin", () =>
			fs.writeFileSync(path.join(proj, A), ADDED),
		);
		expect(text).not.toContain(GATE_BLOCK);
	});
});

describe("#5553 the base each staged file is judged against", () => {
	// Recurrence prevented: `git diff HEAD` fails with no commit, which a gate
	// that read the failure as "nothing staged" would pass.
	it.each([
		{ name: "adds a blocker", bytes: ADDED, refused: true },
		{ name: "is clean", bytes: CLEAN, refused: false },
	])("a first commit with no HEAD $name", { timeout: 120_000 }, async (c) => {
		const proj = seedProject(`first-${c.name.replace(/\W+/g, "-")}`, {});
		const text = await commitCommand(proj, 'git commit -m "wip"', () => {
			fs.mkdirSync(path.join(proj, "src"));
			fs.writeFileSync(path.join(proj, A), c.bytes);
			git(proj, "add", A);
		});
		expect(text.includes(GATE_BLOCK)).toBe(c.refused);
		expect(text.includes(RAN_MARKER)).toBe(!c.refused);
	});

	// Recurrence prevented: a deleted file has no bytes; listing it as a file to
	// lint would read a missing path as degraded or, worse, as the old blocker.
	it(
		"commits the deletion of a file that held a blocker",
		{ timeout: 120_000 },
		async () => {
			const proj = seedProject("deleted", { [A]: WITH_BLOCKER, [B]: CLEAN });
			const text = await commitCommand(proj, 'git commit -m "wip"', () =>
				git(proj, "rm", "-q", A),
			);
			expect(text).not.toContain(GATE_BLOCK);
			expect(text).toContain(RAN_MARKER);
		},
	);

	// Recurrence prevented: a rename read as a new file is wholly added, so a
	// move of a file with an inherited blocker would refuse over HEAD's debt;
	// read as a plain modification it would miss the line the move adds.
	it.each([
		{ name: "a pure rename", edit: (p: string) => p, refused: false },
		{
			name: "a rename that adds a blocker",
			edit: () => WITH_BLOCKER_PLUS_ONE_MORE,
			refused: true,
		},
	])(
		"judges $name by its hunks against the old blob",
		{ timeout: 120_000 },
		async (c) => {
			const proj = seedProject(`rename-${c.name.replace(/\W+/g, "-")}`, {
				[A]: WITH_BLOCKER,
			});
			const text = await commitCommand(proj, 'git commit -m "wip"', () => {
				git(proj, "mv", A, "src/moved.ts");
				if (c.refused)
					fs.writeFileSync(path.join(proj, "src/moved.ts"), c.edit(""));
				git(proj, "add", "src/moved.ts");
			});
			expect(text.includes(GATE_BLOCK)).toBe(c.refused);
			expect(text.includes(RAN_MARKER)).toBe(!c.refused);
		},
	);

	// Recurrence prevented: without `--no-delta` honoured the delta read would
	// keep passing a file the operator asked to judge whole.
	it(
		"judges the whole file under --no-delta",
		{ timeout: 120_000 },
		async () => {
			const proj = seedProject("no-delta", { [A]: WITH_BLOCKER });
			const handle = await startPiSession({
				root: fixture.root,
				cwd: proj,
				flags: new Map(GUARDED_FLAGS),
				inlineFactory: async () => (await import("../index.js")).default,
				responses: [COMMIT(), endTurn("done")],
			});
			fs.writeFileSync(path.join(proj, A), UNRELATED);
			git(proj, "add", A);
			await handle.prompt("commit");
			const text =
				toolResults(handle.requests.at(-1) ?? [], "bash").at(0)?.text ?? "";
			expect(text).toContain(GATE_BLOCK);
		},
	);
});

describe("#5553 a staged set the gate cannot read refuses, once", () => {
	// Recurrence prevented: the lanes read the working file, so a file staged
	// clean and then edited would be judged for bytes the commit does not carry.
	it(
		"refuses a staged file whose working bytes differ from the index",
		{ timeout: 120_000 },
		async () => {
			const proj = seedProject("not-staged", { [A]: CLEAN });
			resetDegradationLedger();
			const handle = await startPiSession({
				root: fixture.root,
				cwd: proj,
				flags: flags(),
				inlineFactory: async () => (await import("../index.js")).default,
				responses: [
					step(readTarget(path.join(proj, "package.json")), "reading"),
					endTurn("looked"),
					COMMIT(),
					COMMIT(),
					endTurn("done"),
				],
			});
			await handle.prompt("look");
			fs.writeFileSync(path.join(proj, A), UNRELATED);
			git(proj, "add", A);
			fs.writeFileSync(path.join(proj, A), ADDED);
			await handle.prompt("commit twice");
			const commits = toolResults(handle.requests.at(-1) ?? [], "bash");
			expect(commits).toHaveLength(2);
			for (const commit of commits) {
				expect(commit.text).toContain(GATE_BLOCK);
				expect(commit.text).toContain("staged_delta_bytes_not_staged");
				expect(commit.text).toContain("git add");
			}
			// Bounded observability: two refusals, one degradation record.
			const group = getDegradationSummary().find(
				(g) => g.kind === "staged-delta-degraded",
			);
			expect(group?.count).toBe(1);
			expect(group?.latestReasons.map((r) => r.subject)).toEqual([
				"bytes_not_staged",
			]);
		},
	);

	// Recurrence prevented: a staged-delta read that gave no answer (git slow,
	// a lane hung, the turn aborted) read as "nothing found" would let the
	// commit through; it refuses as degraded instead.
	describe("a read that gives no answer", () => {
		const COMMIT_X = { command: 'git commit -m "x"' };
		const stagedProject = (name: string) => {
			const proj = seedProject(name, { [A]: CLEAN });
			fs.writeFileSync(path.join(proj, A), ADDED);
			git(proj, "add", A);
			return proj;
		};
		const decide = (
			proj: string,
			signal: AbortSignal | undefined,
			budgetMs?: number,
		) =>
			gateStagedDelta(
				"bash",
				COMMIT_X,
				{ cwd: proj, projectRoot: proj, getFlag: () => false },
				signal,
				budgetMs,
			);

		it("refuses once the bound has passed", { timeout: 120_000 }, async () => {
			resetDegradationLedger();
			const decision = await decide(stagedProject("bound"), undefined, 1);
			expect(decision).toMatchObject({ block: true, unknown: true });
			expect(decision.reason).toContain("staged_delta_lane_incomplete");
		});

		it(
			"refuses for a turn that was aborted",
			{ timeout: 120_000 },
			async () => {
				const decision = await decide(
					stagedProject("aborted"),
					AbortSignal.abort(),
				);
				expect(decision).toMatchObject({ block: true, unknown: true });
				expect(decision.reason).toContain("staged_delta_lane_incomplete");
			},
		);

		// Control: the same staged file and the real budget refuse on the
		// finding, so the two refusals above are the bound's and not the file's.
		it(
			"control: the same file refuses on its blocker inside the bound",
			{ timeout: 120_000 },
			async () => {
				const decision = await decide(stagedProject("control"), undefined);
				expect(decision.block).toBe(true);
				expect(decision.unknown).toBeUndefined();
				expect(decision.reason).toContain("src/a.ts");
			},
		);
	});
});
