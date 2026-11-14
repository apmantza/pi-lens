// flake-shape: real-process-spawn — the subject is a REAL ast-grep CLI, a real `sed`, a real language-server child and a real `git` repo under a real pi session; a stub could not say whether the bytes a writer changed reached the commit gate with the inherited blocker still counted.
/**
 * #5553 witness: a writer that changes a file already holding a committed
 * blocker is judged on its delta, like a host `edit`.
 *
 * Recurrence prevented: only host `write` and `edit` took the pre-edit
 * baseline (`capturePreEditSeed`, #4483), so an unrelated change through
 * `ast_grep_replace`, `sed -i`, an unclassified foreign tool or an LSP rename
 * was judged on the whole file, and `git commit` refused a `debugger;` the
 * change never added (writer-route audit, 2026-11-13).
 *
 * REAL here: the BUILT extension's handlers inside a real pi `AgentSession`,
 * the dispatcher, the commit gate, a real git repository holding the
 * committed blocker, the real ast-grep CLI, `sed`, and the fake language
 * server's real rename. Scripted is the model only, at the provider boundary.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Type } from "../clients/deps/typebox.js";
import {
	flushLatencyLog,
	getLatencyLogPath,
} from "../clients/latency-logger.js";
import { CLEAN_OBSERVATION_ARM_LIMIT } from "../clients/mutation-attribution.js";
import { normalizeMapKey } from "../clients/path-utils.js";
import { useGlobalConfig } from "./support/global-config.js";
import { readNdjsonRows } from "./support/ndjson-rows.js";
import { execFileSync } from "./support/git-fixture-env.js";
import {
	GATE_BLOCK,
	GUARDED_FLAGS,
	RAN_MARKER,
	commitAttempt,
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

const fakeServer = path.join(
	path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
	"tests",
	"fixtures",
	"fake-lsp-server.mjs",
);
const fixture = piSessionFixture();
const setGlobalConfig = useGlobalConfig();

beforeAll(() => warmGuardedSession(fixture.root));

const baseConfig = {
	lsp: {
		serverOverrides: {
			typescript: {
				command: [process.execPath, fakeServer],
				env: { FAKE_LSP_RENAME: "1" },
			},
		},
		disabledServers: [
			"deno",
			"ast-grep",
			"zizmor",
			"typos",
			"opengrep",
			"fallow",
		],
		warmFiles: ["no-such-warm-file.ts"],
	},
};

beforeEach(() => setGlobalConfig(baseConfig));

/**
 * The committed file: its `debugger;` is the inherited blocker. `placeholder;`
 * is a statement a writer can turn into a second, identical `debugger;`. The
 * trailing marker is the fake language server's own "clean" switch, so its
 * fixed diagnostic does not stand in for the blocker under test.
 */
const COMMITTED = [
	"export function f(): number {",
	"\tconst alpha = 1;",
	"\tplaceholder;",
	"\tdebugger;",
	"\treturn alpha;",
	"}",
	"// fake-lsp-clean",
	"",
].join("\n");
/** An unrelated change to a line that is not the blocker's. */
const UNRELATED = COMMITTED.replace("return alpha;", "return alpha + 1;");
const RENAMED = COMMITTED.replaceAll("alpha", "beta");
/** The change that adds a second blocker, its line text equal to the first's. */
const ADDED = COMMITTED.replace("placeholder;", "debugger;");

/**
 * The same file with the inherited blocker far from the line a host edit
 * turns into an identical one. A host `edit` reports only the lines near its
 * touch (the tree-sitter gate), so with the lines adjacent both reads come
 * back and the count alone refuses the second; the gap is what makes the
 * dispatch see the added line and not the inherited one.
 */
const GAP = 40;
const COMMITTED_GAP = [
	"export function f(): number {",
	"\tconst alpha = 1;",
	"\tdebugger;",
	...Array.from({ length: GAP }, (_, i) => `\t// filler ${i}`),
	"\tplaceholder;",
	"\treturn alpha;",
	"}",
	"// fake-lsp-clean",
	"",
].join("\n");
const ADDED_GAP = COMMITTED_GAP.replace("placeholder;", "debugger;");

/** A project whose `HEAD` holds the file with its blocker. */
function seedRepo(name: string, committed = COMMITTED) {
	const proj = path.join(fixture.root, name, "proj");
	const target = path.join(proj, "src", "target.ts");
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(path.join(proj, "package.json"), "{}\n");
	fs.writeFileSync(target, committed);
	const git = (...args: string[]) =>
		execFileSync("git", args, {
			cwd: proj,
			stdio: "ignore",
		});
	git("init", "-q");
	git("add", "-A");
	git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base");
	return { proj, target };
}

/**
 * The guarded set with delta on, and autofix on only where a case applies. A
 * `false` entry deletes the helper's default key (`flagMap` in
 * support/pi-session.ts), which turns the analyzer back on.
 */
function flagsFor(lsp: boolean): Map<string, boolean> {
	const on = new Set(["no-delta", "no-autofix", ...(lsp ? ["no-lsp"] : [])]);
	return new Map(
		GUARDED_FLAGS.map(([name, value]): [string, boolean] => [
			name,
			on.has(name) ? false : value,
		]),
	);
}

function foreignWriter(): ToolDefinition {
	return {
		name: "foreign_write",
		label: "Foreign write",
		description: "Rewrite a file with the bytes given.",
		parameters: Type.Object({ path: Type.String(), content: Type.String() }),
		async execute(_id: string, params: { path: string; content: string }) {
			fs.writeFileSync(params.path, params.content);
			return {
				content: [{ type: "text", text: `wrote ${params.path}` }],
				details: {},
			};
		},
	} as ToolDefinition;
}

/** A read-only extension tool: it names a path and writes nothing. */
function foreignPeek(): ToolDefinition {
	return {
		name: "foreign_peek",
		label: "Foreign peek",
		description: "Read a file.",
		parameters: Type.Object({ path: Type.String() }),
		async execute(_id: string, params: { path: string }) {
			return {
				content: [{ type: "text", text: fs.readFileSync(params.path, "utf8") }],
				details: {},
			};
		},
	} as ToolDefinition;
}

/**
 * The files of `proj` a pre-edit capture row names, as path keys. Inline
 * mode shares the latency logger with the extension, whose queue the
 * session's own flush does not reach, so the test drains it (the #5248
 * witness reads rows the same way).
 */
async function capturedFiles(proj: string): Promise<string[]> {
	await flushLatencyLog();
	const read = readNdjsonRows(getLatencyLogPath());
	expect(read.skipped).toBe(0);
	return read.rows
		.filter((row) => row.phase === "pre_edit_capture")
		.map((row) => normalizeMapKey(String(row.filePath)))
		.filter((file) => file.startsWith(normalizeMapKey(proj) + "/"))
		.sort();
}

/** The `runners` a capture row of `file` names, as ids. */
async function capturedRunners(file: string): Promise<string[]> {
	await flushLatencyLog();
	const rows = readNdjsonRows(getLatencyLogPath()).rows.filter(
		(row) =>
			row.phase === "pre_edit_capture" &&
			normalizeMapKey(String(row.filePath)) === normalizeMapKey(file),
	);
	expect(rows).toHaveLength(1);
	const runners = (rows[0]?.metadata as { runners?: string } | undefined)
		?.runners;
	return (runners ?? "").split(",");
}

const activate = (tool: string) =>
	fauxToolCall("pi_lens_activate_tools", { tools: [tool] });

/** One writer: the steps that change the target, and what they leave on disk. */
interface Writer {
	readonly name: string;
	readonly lsp?: true;
	readonly unrelated: (target: string) => PiFauxReply[];
	readonly adds: (target: string) => PiFauxReply[];
	readonly unrelatedBytes: string;
	readonly addsBytes: string;
}

const replace = (target: string, pattern: string, rewrite: string) => [
	step(activate("ast_grep_replace"), "activating"),
	step(
		fauxToolCall("ast_grep_replace", {
			pattern,
			rewrite,
			lang: "typescript",
			paths: [target],
			apply: true,
		}),
		"replacing",
	),
];
// BSD `sed` takes the backup suffix as a separate argument, GNU `sed` attached.
// Neither spelling with a suffix attached (`-i.bak`) is a named write to the
// prescan, so the cases use the suffix-less GNU form and BSD's empty one.
const SED_INPLACE = process.platform === "darwin" ? "sed -i ''" : "sed -i";
const sed = (target: string, expression: string) => [
	step(
		fauxToolCall("bash", {
			command: `${SED_INPLACE} '${expression}' ${target}`,
		}),
		"sed",
	),
];
const foreign = (target: string, content: string) => [
	step(fauxToolCall("foreign_write", { path: target, content }), "writing"),
];
const rename = (
	target: string,
	line: number,
	character: number,
	to: string,
) => [
	step(activate("lsp_navigation"), "activating"),
	step(
		fauxToolCall("lsp_navigation", {
			operation: "rename",
			path: target,
			line,
			character,
			newName: to,
			apply: true,
		}),
		"renaming",
	),
];

const WRITERS: readonly Writer[] = [
	{
		name: "ast_grep_replace",
		unrelated: (t) => replace(t, "return alpha;", "return alpha + 1;"),
		adds: (t) => replace(t, "placeholder", "debugger"),
		unrelatedBytes: UNRELATED,
		addsBytes: ADDED,
	},
	{
		name: "sed -i",
		unrelated: (t) => sed(t, "s/return alpha;/return alpha + 1;/"),
		adds: (t) => sed(t, "s/placeholder;/debugger;/"),
		unrelatedBytes: UNRELATED,
		addsBytes: ADDED,
	},
	{
		name: "a foreign tool's write",
		unrelated: (t) => foreign(t, UNRELATED),
		adds: (t) => foreign(t, ADDED),
		unrelatedBytes: UNRELATED,
		addsBytes: ADDED,
	},
	{
		name: "an LSP rename",
		lsp: true,
		unrelated: (t) => rename(t, 2, 8, "beta"),
		adds: (t) => rename(t, 3, 2, "debugger"),
		unrelatedBytes: RENAMED,
		addsBytes: ADDED,
	},
];

/** Run `steps` over a fresh committed repo, then try to commit. */
async function commitAfter(
	name: string,
	writer: Pick<Writer, "lsp">,
	steps: (target: string) => PiFauxReply[],
	committed = COMMITTED,
) {
	const { proj, target } = seedRepo(name, committed);
	const handle = await startPiSession({
		root: fixture.root,
		cwd: proj,
		flags: flagsFor(writer.lsp === true),
		inlineFactory: async () => (await import("../index.js")).default,
		customTools: [foreignWriter(), foreignPeek()],
		responses: [
			step(readTarget(target), "reading"),
			...steps(target),
			step(commitAttempt(), "committing"),
			endTurn("done"),
		],
	});
	await handle.prompt("change the file and commit");
	const commits = toolResults(handle.requests.at(-1) ?? [], "bash").filter(
		(r) => r.text.includes(RAN_MARKER) || r.text.includes(GATE_BLOCK),
	);
	expect(commits).toHaveLength(1);
	return { target, commit: commits[0], handle };
}

describe("#5553 every path-naming writer is judged on its delta", () => {
	it("control: a host edit of an unrelated line commits", async () => {
		const { target, commit } = await commitAfter("edit", {}, (t) => [
			step(
				fauxToolCall("edit", {
					path: t,
					edits: [{ oldText: "return alpha;", newText: "return alpha + 1;" }],
				}),
				"editing",
			),
		]);
		expect(fs.readFileSync(target, "utf8")).toBe(UNRELATED);
		expect(commit?.text).not.toContain(GATE_BLOCK);
		expect(commit?.text).toContain(RAN_MARKER);
		// Recurrence prevented: a host edit carries its touched lines, so the two
		// edit-gated lanes judge only those and need no seed; seeding them would
		// run tree-sitter and ast-grep before every file's first edit.
		const runners = await capturedRunners(target);
		expect(runners).toContain("oxlint");
		expect(runners).not.toContain("tree-sitter");
		expect(runners).not.toContain("ast-grep-napi");
	});

	// Recurrence prevented: a preview writes nothing, and an applied replace
	// over a folder writes files its `paths` never named. The first has nothing
	// to seed; the second is the named-versus-written gap the PR body records
	// (shape 64), and a folder is no file to read.
	it(
		"seeds nothing for a preview or a folder",
		{ timeout: 120_000 },
		async () => {
			const { proj, target } = seedRepo("preview-folder");
			const handle = await startPiSession({
				root: fixture.root,
				cwd: proj,
				flags: flagsFor(true),
				inlineFactory: async () => (await import("../index.js")).default,
				responses: [
					step(activate("ast_grep_replace"), "activating"),
					step(activate("lsp_navigation"), "activating"),
					step(readTarget(target), "reading"),
					step(
						fauxToolCall("ast_grep_replace", {
							pattern: "return alpha;",
							rewrite: "return alpha + 1;",
							lang: "typescript",
							paths: [target],
							apply: false,
						}),
						"previewing",
					),
					step(
						fauxToolCall("lsp_navigation", {
							operation: "rename",
							path: target,
							line: 2,
							character: 8,
							newName: "beta",
							apply: false,
						}),
						"previewing",
					),
					step(
						fauxToolCall("ast_grep_replace", {
							pattern: "return alpha;",
							rewrite: "return alpha + 1;",
							lang: "typescript",
							paths: [path.dirname(target)],
							apply: true,
						}),
						"applying over the folder",
					),
					endTurn("done"),
				],
			});
			await handle.prompt("preview, then apply over the folder");
			// The folder apply really rewrote the file the seed never named.
			expect(fs.readFileSync(target, "utf8")).toBe(UNRELATED);
			expect(await capturedFiles(proj)).toEqual([]);
		},
	);

	// Recurrence prevented: the observed-write route arms for every tool pi-lens
	// does not classify, and a `read` names a path like a writer does. A first
	// cut seeded the file of each such call, so every first read of a file paid
	// a linter run and installed a seed no writer asked for.
	it("takes no pre-edit seed for a read of the file", async () => {
		const { proj, target } = seedRepo("read-only");
		const handle = await startPiSession({
			root: fixture.root,
			cwd: proj,
			flags: flagsFor(false),
			inlineFactory: async () => (await import("../index.js")).default,
			responses: [step(readTarget(target), "reading"), endTurn("done")],
		});
		await handle.prompt("read it");
		expect(await capturedFiles(proj)).toEqual([]);
	});

	// Recurrence prevented: the seed is worth a linter run only where the
	// observational net will replay the tool's write. A read-only extension tool
	// that names a path is armed for its first CLEAN_OBSERVATION_ARM_LIMIT calls
	// and then not; a capture on every later call taxed it for good.
	it("stops seeding the files of a foreign tool the net has seen clean", async () => {
		const { proj, target } = seedRepo("foreign-peek");
		const others = Array.from(
			{ length: CLEAN_OBSERVATION_ARM_LIMIT },
			(_, i) => {
				const file = path.join(proj, "src", `peek${i}.ts`);
				fs.writeFileSync(file, COMMITTED);
				return file;
			},
		);
		const peeked = [target, ...others];
		const handle = await startPiSession({
			root: fixture.root,
			cwd: proj,
			flags: flagsFor(false),
			inlineFactory: async () => (await import("../index.js")).default,
			customTools: [foreignPeek()],
			responses: [
				...peeked.map((file) =>
					step(fauxToolCall("foreign_peek", { path: file }), "peeking"),
				),
				endTurn("done"),
			],
		});
		await handle.prompt("peek at each");
		expect(await capturedFiles(proj)).toEqual(
			peeked
				.slice(0, CLEAN_OBSERVATION_ARM_LIMIT)
				.map((file) => normalizeMapKey(file))
				.sort(),
		);
	});

	// Recurrence prevented (CodeRabbit on #5583, runtime-tool-call.ts): a
	// provider's replay is a card for a write already done, so its file holds
	// the post-write bytes; the early site seeded them like the host-edit site
	// would not (`isProviderReplayCall`, #5160).
	it("takes no seed for a provider's replay of a write", async () => {
		const { proj, target } = seedRepo("provider-replay");
		const handle = await startPiSession({
			root: fixture.root,
			cwd: proj,
			flags: flagsFor(false),
			inlineFactory: async () => (await import("../index.js")).default,
			customTools: [foreignWriter()],
			responses: [
				step(readTarget(target), "reading"),
				step(
					fauxToolCall(
						"foreign_write",
						{ path: target, content: UNRELATED },
						{ id: "cursor-replay-1" },
					),
					"replaying",
				),
				endTurn("done"),
			],
		});
		await handle.prompt("replay a write");
		expect(await capturedFiles(proj)).toEqual([]);
	});

	// Recurrence prevented: a command names files the host-edit site would
	// skip (dispatch never analyses a gitignored or vendored file) and files the
	// write creates; seeding them ran a linter, or logged a skipped row, for
	// every redirect of a build script.
	it("seeds the existing project file a command names and no other", async () => {
		const { proj, target } = seedRepo("named-targets");
		const ignored = path.join(proj, "src", "ignored.ts");
		const vendored = path.join(proj, "vendor", "lib.ts");
		const created = path.join(proj, "src", "created.ts");
		fs.writeFileSync(path.join(proj, ".gitignore"), "ignored.ts\n");
		fs.mkdirSync(path.dirname(vendored), { recursive: true });
		fs.writeFileSync(ignored, COMMITTED);
		fs.writeFileSync(vendored, COMMITTED);
		const handle = await startPiSession({
			root: fixture.root,
			cwd: proj,
			flags: flagsFor(false),
			inlineFactory: async () => (await import("../index.js")).default,
			responses: [
				step(
					fauxToolCall("bash", {
						command: `${SED_INPLACE} 's/return alpha;/return alpha + 1;/' ${target} ${ignored} ${vendored}; printf x > ${created}`,
					}),
					"writing",
				),
				endTurn("done"),
			],
		});
		await handle.prompt("write several files");
		expect(await capturedFiles(proj)).toEqual([normalizeMapKey(target)]);
	});

	// Recurrence prevented: an unclassified tool takes the observed-write route
	// for its first calls; once pi-lens learned its name (`provenance:
	// "learned"`) its calls reach the host-edit capture site, which seeded
	// linters only, so a later call blocked where the first committed.
	it(
		"commits every call of a foreign tool pi-lens learned from the first",
		{ timeout: 120_000 },
		async () => {
			const { proj, target } = seedRepo("foreign-learned");
			const second = path.join(proj, "src", "second.ts");
			const third = path.join(proj, "src", "third.ts");
			fs.writeFileSync(second, COMMITTED);
			fs.writeFileSync(third, COMMITTED);
			execFileSync("git", ["add", "-A"], {
				cwd: proj,
				stdio: "ignore",
			});
			execFileSync(
				"git",
				["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "two"],
				{ cwd: proj, stdio: "ignore" },
			);
			const handle = await startPiSession({
				root: fixture.root,
				cwd: proj,
				flags: flagsFor(false),
				inlineFactory: async () => (await import("../index.js")).default,
				customTools: [foreignWriter()],
				responses: [
					step(readTarget(target), "reading"),
					...foreign(target, UNRELATED),
					step(readTarget(second), "reading"),
					...foreign(second, UNRELATED),
					step(readTarget(third), "reading"),
					...foreign(third, UNRELATED),
					step(commitAttempt(), "committing"),
					endTurn("done"),
				],
			});
			await handle.prompt("write three files and commit");
			expect(fs.readFileSync(target, "utf8")).toBe(UNRELATED);
			expect(fs.readFileSync(second, "utf8")).toBe(UNRELATED);
			expect(fs.readFileSync(third, "utf8")).toBe(UNRELATED);
			const commits = toolResults(handle.requests.at(-1) ?? [], "bash");
			expect(commits).toHaveLength(1);
			expect(commits[0]?.text).not.toContain(GATE_BLOCK);
			expect(commits[0]?.text).toContain(RAN_MARKER);
		},
	);

	// The linters read the whole file and count each seeded entry once, so
	// whichever of them is installed refuses the second `debugger;` on its own
	// and hides the defect below (a run without `node_modules/.bin` on PATH has
	// biome and reds nothing). Only the edit-gated lanes judge these cases.
	describe("with the linters that flag a debugger statement disabled", () => {
		beforeEach(() =>
			setGlobalConfig({
				...baseConfig,
				dispatch: { disabledRunners: ["biome-check-json", "eslint", "oxlint"] },
			}),
		);

		// Recurrence prevented (#5553 r2, review F1/F2): the seed of the two
		// edit-gated lanes describes the whole file, so it may only classify a
		// dispatch that reads the whole file. A host `edit` reads its touched lines
		// alone; the `debugger;` it adds reads like the inherited one 40 lines away,
		// and matched against a seed that no writer ever consumed it committed. The
		// four seeders below leave such a seed: a writer that changed the file, a
		// writer that matched nothing, and a read-only tool that named the file.
		describe.each([
			{
				name: "a sed that changed the file",
				steps: (t: string) => sed(t, "s/return alpha;/return alpha + 1;/"),
				edited: ADDED_GAP.replace("return alpha;", "return alpha + 1;"),
			},
			{
				name: "a sed that matched nothing",
				steps: (t: string) => sed(t, "s/NO_SUCH_TEXT/x/"),
				edited: ADDED_GAP,
			},
			{
				name: "an ast_grep_replace that matched nothing",
				steps: (t: string) => replace(t, "noSuchIdentifier()", "other()"),
				edited: ADDED_GAP,
			},
			{
				name: "a read-only foreign tool that named the file",
				steps: (t: string) => [
					step(fauxToolCall("foreign_peek", { path: t }), "peeking"),
				],
				edited: ADDED_GAP,
			},
		])("refuses the identical blocker a host edit adds after $name", (c) => {
			it("commit is blocked", { timeout: 120_000 }, async () => {
				const { target, commit } = await commitAfter(
					`gap-${c.name.replace(/\W+/g, "-")}`,
					{},
					(t) => [
						...c.steps(t),
						step(readTarget(t), "reading again"),
						step(
							fauxToolCall("edit", {
								path: t,
								edits: [{ oldText: "placeholder;", newText: "debugger;" }],
							}),
							"editing",
						),
					],
					COMMITTED_GAP,
				);
				expect(fs.readFileSync(target, "utf8")).toBe(c.edited);
				expect(commit?.text).toContain(GATE_BLOCK);
				expect(commit?.text).not.toContain(RAN_MARKER);
			});
		});

		// Control for the four above: the same host edit with no earlier writer
		// takes no seed and is refused, so the cases differ only by the seed.
		it(
			"control: a host edit alone that adds the identical blocker is refused",
			{ timeout: 120_000 },
			async () => {
				const { commit } = await commitAfter(
					"gap-control",
					{},
					(t) => [
						step(
							fauxToolCall("edit", {
								path: t,
								edits: [{ oldText: "placeholder;", newText: "debugger;" }],
							}),
							"editing",
						),
					],
					COMMITTED_GAP,
				);
				expect(commit?.text).toContain(GATE_BLOCK);
			},
		);
	});

	describe.each(WRITERS)("$name", (writer) => {
		const slug = writer.name.replace(/\W+/g, "-");

		// Recurrence prevented: the writer-route audit (2026-11-13) found an
		// unrelated change through each of these blocked at `git commit` over
		// the `debugger;` HEAD already held, while the same change through a
		// host `edit` committed (#5553).
		it(
			"commits an unrelated change to a file whose blocker is already in HEAD",
			{ timeout: 120_000 },
			async () => {
				const { target, commit } = await commitAfter(
					`${slug}-unrelated`,
					writer,
					writer.unrelated,
				);
				expect(fs.readFileSync(target, "utf8")).toBe(writer.unrelatedBytes);
				expect(commit?.text).not.toContain(GATE_BLOCK);
				expect(commit?.text).toContain(RAN_MARKER);
			},
		);

		// Recurrence prevented: a baseline that hid the blocker the writer
		// itself adds would let it commit. The added line reads exactly like the
		// inherited one, so only counting each seeded entry once refuses it.
		it(
			"still refuses a second blocker the writer adds beside the inherited one",
			{ timeout: 120_000 },
			async () => {
				const { target, commit } = await commitAfter(
					`${slug}-adds`,
					writer,
					writer.adds,
				);
				expect(fs.readFileSync(target, "utf8")).toBe(writer.addsBytes);
				expect(commit?.text).toContain(GATE_BLOCK);
				expect(commit?.text).not.toContain(RAN_MARKER);
			},
		);
	});
});
