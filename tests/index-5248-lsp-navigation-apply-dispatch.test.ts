// flake-shape: real-process-spawn — the subject is a REAL language-server child behind pi-lens's real LSP client answering rename, rename_file and executeCommand; a stubbed service could not say whether the bytes it wrote reached a dispatcher.
/**
 * #5248 witness: the files an applied `lsp_navigation` rename, rename_file or
 * executeCommand wrote are dispatched like an `edit`'s, so the blocker the
 * write introduced reaches the commit gate.
 *
 * Recurrence prevented: these three operations record their writes through
 * `recordLspMutation` straight into the mutation bridge, which defers autofix
 * and format but queues no dispatch, and `lsp_navigation` is never armed for
 * the observation net (`isPiLensToolName`). A `debugger;` a rename produced
 * reached neither the turn-end check nor `git commit` under `--lens-guard`,
 * while the same bytes through `edit` blocked (the `ast_grep_replace` twin is
 * #5239, tests/index-5239-ast-grep-replace-dispatch.test.ts).
 *
 * REAL here: the BUILT extension's `tool_call` / `tool_result` handlers in a
 * real pi `AgentSession`, pi-lens's own `lsp_navigation` tool, its real LSP
 * client and workspace-edit applier, the real stdio server child
 * (`tests/fixtures/fake-lsp-server.mjs` with `FAKE_LSP_RENAME=1`: a real
 * whole-word rename over the documents the client opened, and the fixture's
 * existing `fake.applyEdit` server-initiated edit), the dispatcher and the
 * commit gate. Scripted is the model only, at the provider boundary.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	flushLatencyLog,
	getLatencyLogPath,
} from "../clients/latency-logger.js";
import { useGlobalConfig } from "./support/global-config.js";
import { readNdjsonRows } from "./support/ndjson-rows.js";
import {
	GATE_BLOCK,
	GUARDED_FLAGS,
	RAN_MARKER,
	type DispatchRow,
	BLOCKING_FILE,
	commitAttempt,
	endTurn,
	readTarget,
	reportedRules,
	runnerRowsFor,
	step,
	toolResults,
	warmGuardedSession,
} from "./support/pi-session-commit-gate.js";
import {
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

/** A statement that becomes `debugger;` when `placeholder` is renamed to `debugger`. */
const RENAMEABLE = (n: number) =>
	`export function f${n}(): number {\n\tplaceholder;\n\treturn ${n};\n}\n`;
const AFTER_RENAME = (n: number) =>
	`export function f${n}(): number {\n\tdebugger;\n\treturn ${n};\n}\n`;

beforeEach(() => {
	// The bundled TypeScript server's launcher is the fixture and no other
	// server answers `.ts`. A launcher override rides the machine-global config:
	// a project-tier `command` is refused (clients/lsp/config.ts
	// REPO_TIER_SERVER_FIELDS).
	setGlobalConfig({
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
	});
});

function activateNavigation(): Record<string, unknown> {
	return fauxToolCall("pi_lens_activate_tools", { tools: ["lsp_navigation"] });
}

function navigate(args: Record<string, unknown>): Record<string, unknown> {
	return fauxToolCall("lsp_navigation", args);
}

/** Two sibling files in one project; the first is the one the model names. */
function seedPair(name: string, first: string, second: string) {
	const proj = path.join(fixture.root, name, "proj");
	const src = path.join(proj, "src");
	fs.mkdirSync(src, { recursive: true });
	fs.writeFileSync(path.join(proj, "package.json"), "{}\n");
	const a = path.join(src, "a.ts");
	const b = path.join(src, "b.ts");
	fs.writeFileSync(a, first);
	fs.writeFileSync(b, second);
	return { proj, a, b };
}

function openLspSession(
	proj: string,
	responses: Parameters<typeof startPiSession>[0]["responses"],
) {
	return startPiSession({
		root: fixture.root,
		cwd: proj,
		// `false` deletes the key, which turns LSP back on.
		flags: new Map<string, boolean>([...GUARDED_FLAGS, ["no-lsp", false]]),
		inlineFactory: async () => (await import("../index.js")).default,
		responses,
	});
}

async function rowsOf(_handle: Awaited<ReturnType<typeof openLspSession>>) {
	// Inline mode shares the latency logger's module with the extension, and
	// the logger keeps its own queue, which the session's writer flush does not
	// reach, so the test drains it (the #4483 witness reads rows the same way).
	await flushLatencyLog();
	const read = readNdjsonRows(getLatencyLogPath());
	expect(read.skipped).toBe(0);
	return read.rows as DispatchRow[];
}

/** The model's last bash result: the commit attempt. */
function commitResult(handle: Awaited<ReturnType<typeof openLspSession>>) {
	const commits = toolResults(handle.requests.at(-1) ?? [], "bash");
	expect(commits).toHaveLength(1);
	return commits[0];
}

/** Every `lsp_navigation` result the model received, in order. */
function navigationResults(handle: Awaited<ReturnType<typeof openLspSession>>) {
	return toolResults(handle.requests.at(-1) ?? [], "lsp_navigation");
}

describe("#5248 an applied lsp_navigation write dispatches what it wrote", () => {
	it(
		"refuses a commit over the blocker a rename introduced, dispatching each renamed file once",
		{ timeout: 120_000 },
		async () => {
			const { proj, a, b } = seedPair("rename", RENAMEABLE(1), RENAMEABLE(2));
			const handle = await openLspSession(proj, [
				step(activateNavigation(), "activating"),
				step(readTarget(a), "reading a"),
				step(readTarget(b), "reading b"),
				// Opens `b` in the server, so the rename edit spans both files.
				step(
					navigate({ operation: "hover", path: b, line: 2, character: 2 }),
					"opening b",
				),
				step(
					navigate({
						operation: "rename",
						path: a,
						line: 2,
						character: 2,
						newName: "debugger",
						apply: true,
					}),
					"renaming",
				),
				step(commitAttempt(), "committing"),
				endTurn("done"),
			]);
			await handle.prompt("rename and commit");

			// The rename really landed in both files: the defect was delivery.
			expect(fs.readFileSync(a, "utf8")).toBe(AFTER_RENAME(1));
			expect(fs.readFileSync(b, "utf8")).toBe(AFTER_RENAME(2));
			const rows = await rowsOf(handle);
			const commit = commitResult(handle);
			expect(commit?.text).toContain(GATE_BLOCK);
			expect(commit?.text).not.toContain(RAN_MARKER);
			expect(commit?.isError).toBe(true);

			// Each file reached the dispatcher exactly once.
			for (const file of [a, b])
				expect(
					reportedRules(rows, file).filter((r) => r === "debugger-statement"),
				).toHaveLength(1);
		},
	);

	// Recurrence prevented (CodeRabbit on #5244 r4): a RELATIVE `path` on an
	// applied rename took the `path_attribution_missing` early return in
	// `handleToolResult` before the applied-files feed, so the written files
	// never reached the dispatcher or the commit gate.
	it(
		"refuses a commit over the blocker a rename with a relative path introduced",
		{ timeout: 120_000 },
		async () => {
			const { proj, a, b } = seedPair(
				"rename-rel",
				RENAMEABLE(1),
				RENAMEABLE(2),
			);
			const handle = await openLspSession(proj, [
				step(activateNavigation(), "activating"),
				step(readTarget(a), "reading a"),
				step(readTarget(b), "reading b"),
				step(
					navigate({ operation: "hover", path: b, line: 2, character: 2 }),
					"opening b",
				),
				step(
					navigate({
						operation: "rename",
						path: path.relative(proj, a),
						line: 2,
						character: 2,
						newName: "debugger",
						apply: true,
					}),
					"renaming",
				),
				step(commitAttempt(), "committing"),
				endTurn("done"),
			]);
			await handle.prompt("rename and commit");

			expect(fs.readFileSync(a, "utf8")).toBe(AFTER_RENAME(1));
			expect(fs.readFileSync(b, "utf8")).toBe(AFTER_RENAME(2));
			const rows = await rowsOf(handle);
			const commit = commitResult(handle);
			expect(commit?.text).toContain(GATE_BLOCK);
			expect(commit?.text).not.toContain(RAN_MARKER);
			for (const file of [a, b])
				expect(
					reportedRules(rows, file).filter((r) => r === "debugger-statement"),
				).toHaveLength(1);
		},
	);

	it(
		"dispatches nothing for a dry-run rename, a rename at no symbol, or a rename missing its name",
		{ timeout: 120_000 },
		async () => {
			const { proj, a, b } = seedPair(
				"rename-none",
				RENAMEABLE(1),
				RENAMEABLE(2),
			);
			const handle = await openLspSession(proj, [
				step(activateNavigation(), "activating"),
				step(readTarget(a), "reading a"),
				step(
					navigate({
						operation: "rename",
						path: a,
						line: 2,
						character: 2,
						newName: "debugger",
						apply: false,
					}),
					"previewing",
				),
				// Column 1 is the tab before `placeholder`: no identifier there.
				step(
					navigate({
						operation: "rename",
						path: a,
						line: 2,
						character: 1,
						newName: "debugger",
						apply: true,
					}),
					"renaming nothing",
				),
				step(
					navigate({
						operation: "rename",
						path: a,
						line: 2,
						character: 2,
						apply: true,
					}),
					"renaming without a name",
				),
				endTurn("done"),
			]);
			await handle.prompt("rename badly");

			expect(fs.readFileSync(a, "utf8")).toBe(RENAMEABLE(1));
			expect(fs.readFileSync(b, "utf8")).toBe(RENAMEABLE(2));
			// Three calls really answered: a silent no-call would pass for free.
			expect(navigationResults(handle)).toHaveLength(3);
			const rows = await rowsOf(handle);
			for (const file of [a, b]) expect(runnerRowsFor(rows, file)).toEqual([]);
		},
	);

	it(
		"refuses a commit over the blocker an executeCommand apply introduced",
		{ timeout: 120_000 },
		async () => {
			const { proj, a } = seedPair("execute", RENAMEABLE(1), RENAMEABLE(2));
			const handle = await openLspSession(proj, [
				step(activateNavigation(), "activating"),
				step(readTarget(a), "reading a"),
				step(
					navigate({
						operation: "executeCommand",
						path: a,
						command: "fake.applyEdit",
						commandArguments: [
							pathToFileURL(a).href,
							{
								line: 1,
								startCharacter: 1,
								endCharacter: 12,
								newText: "debugger",
							},
						],
						apply: true,
					}),
					"executing",
				),
				step(commitAttempt(), "committing"),
				endTurn("done"),
			]);
			await handle.prompt("execute and commit");

			expect(fs.readFileSync(a, "utf8")).toBe(AFTER_RENAME(1));
			const commit = commitResult(handle);
			expect(commit?.text).toContain(GATE_BLOCK);
			expect(commit?.text).not.toContain(RAN_MARKER);
			const rows = await rowsOf(handle);
			expect(
				reportedRules(rows, a).filter((r) => r === "debugger-statement"),
			).toHaveLength(1);
		},
	);

	it(
		"dispatches nothing for an executeCommand dry run",
		{ timeout: 120_000 },
		async () => {
			const { proj, a } = seedPair("execute-dry", RENAMEABLE(1), RENAMEABLE(2));
			const handle = await openLspSession(proj, [
				step(activateNavigation(), "activating"),
				step(readTarget(a), "reading a"),
				step(
					navigate({
						operation: "executeCommand",
						path: a,
						command: "fake.applyEdit",
						commandArguments: [pathToFileURL(a).href],
						apply: false,
					}),
					"previewing",
				),
				endTurn("done"),
			]);
			await handle.prompt("preview");

			expect(fs.readFileSync(a, "utf8")).toBe(RENAMEABLE(1));
			expect(navigationResults(handle)).toHaveLength(1);
			expect(runnerRowsFor(await rowsOf(handle), a)).toEqual([]);
		},
	);

	it(
		"refuses a commit over the blocker a renamed file carries to its new path",
		{ timeout: 120_000 },
		async () => {
			const { proj, a } = seedPair("rename-file", BLOCKING_FILE, RENAMEABLE(2));
			const moved = path.join(proj, "src", "moved.ts");
			const handle = await openLspSession(proj, [
				step(activateNavigation(), "activating"),
				step(readTarget(a), "reading a"),
				step(
					navigate({
						operation: "rename_file",
						path: a,
						newFilePath: moved,
						apply: true,
					}),
					"moving",
				),
				step(commitAttempt(), "committing"),
				endTurn("done"),
			]);
			await handle.prompt("move and commit");

			expect(fs.existsSync(a)).toBe(false);
			expect(fs.readFileSync(moved, "utf8")).toBe(BLOCKING_FILE);
			const commit = commitResult(handle);
			expect(commit?.text).toContain(GATE_BLOCK);
			expect(commit?.text).not.toContain(RAN_MARKER);
			const rows = await rowsOf(handle);
			expect(
				reportedRules(rows, moved).filter((r) => r === "debugger-statement"),
			).toHaveLength(1);
			// The path the file left is not dispatched.
			expect(runnerRowsFor(rows, a)).toEqual([]);
		},
	);
});
