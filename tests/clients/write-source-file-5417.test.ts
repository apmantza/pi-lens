/**
 * #5417: the writers that did not share the formatter's and autofix's write
 * rules. `ast_grep_replace`, an LSP workspace edit and `lens_diagnostic_mark`
 * wrote a file of a sibling repo (an `adopted` root) with no refusal, and the
 * last of them wrote outside pi's per-file mutation queue. An interrupted
 * `ast_grep_replace` also left the files it had already rewritten unrecorded.
 *
 * Each cell drives the production entry (the tool, or `applyWorkspaceEdit`)
 * with the real root classifier, the real degradation ledger and, for the
 * queue cell, pi's real `withFileMutationQueue`. Doubles stand only at the
 * process boundary: the ast-grep child (`runner.exec`) and the filesystem
 * write that parks the writer between its read and its write.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
// pi's real per-file queue, the one its `edit`/`write` tools run under.
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AstGrepClient } from "../../clients/ast-grep-client.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { setHostFileMutationQueueLoader } from "../../clients/file-mutation-queue.js";
import { applyWorkspaceEdit } from "../../clients/lsp/edits.js";
import { writeSourceFile } from "../../clients/write-source-file.js";
import { createAstGrepReplaceTool } from "../../tools/ast-grep-replace.js";
import { createLensDiagnosticMarkTool } from "../../tools/lens-diagnostic-mark.js";
import {
	getTmpRootRegistry,
	registerTmpRoot,
} from "../support/tmp-root-registry.js";
import { setupTestEnvironment } from "./test-utils.js";

// Parks `lens_diagnostic_mark` between its read and its write of one file.
const writeGate = vi.hoisted(() => ({
	target: undefined as string | undefined,
	parked: undefined as undefined | (() => void),
	resume: undefined as undefined | Promise<void>,
}));
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	const writeFile = async (
		...args: Parameters<typeof actual.promises.writeFile>
	) => {
		if (writeGate.target !== undefined && args[0] === writeGate.target) {
			writeGate.parked?.();
			await writeGate.resume;
		}
		return actual.promises.writeFile(...args);
	};
	const promises = { ...actual.promises, writeFile };
	return { ...actual, default: { ...actual, promises }, promises };
});

const MUTATION_BRIDGE_KEY = Symbol.for("pi-lens:mutation-bridge");
type Recorded = { filePath: string; consumer?: string; editRanges?: unknown };
const recorded: Recorded[] = [];
Object.defineProperty(globalThis, MUTATION_BRIDGE_KEY, {
	value: Object.freeze({
		version: 1 as const,
		recordMutation(entry: Recorded): boolean {
			recorded.push(entry);
			return true;
		},
	}),
	writable: false,
	configurable: false,
	enumerable: false,
});

function gate() {
	let open!: () => void;
	const p = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { p, open };
}

let session: ReturnType<typeof setupTestEnvironment>;
let sessionRoot: string;
let sibling: string;
const siblings: string[] = [];

beforeEach(() => {
	resetDegradationLedger();
	recorded.length = 0;
	session = setupTestEnvironment("pi-lens-write-source-5417-");
	sessionRoot = fs.realpathSync(session.tmpDir);
	// #4867: an ADOPTABLE sibling project cannot sit under the tmp root (a direct
	// tmp child is pi-owned staging), so it lives under the git-ignored
	// `.probe-home` of the checkout and is registered for the tmp-hygiene sweep.
	fs.mkdirSync(path.join(process.cwd(), ".probe-home"), { recursive: true });
	sibling = fs.realpathSync(
		fs.mkdtempSync(path.join(process.cwd(), ".probe-home", "write-source-")),
	);
	registerTmpRoot(getTmpRootRegistry(), sibling, "registered");
	siblings.push(sibling);
	fs.writeFileSync(path.join(sibling, "package.json"), "{}\n");
});

afterEach(() => {
	setHostFileMutationQueueLoader(undefined);
	writeGate.target = undefined;
	for (const dir of siblings.splice(0))
		fs.rmSync(dir, { recursive: true, force: true });
	session.cleanup();
});

/** The ledger rows the root guard wrote, as `subject` strings. */
function refusalSubjects(): string[] {
	return getDegradationSummary()
		.filter((group) => group.kind === "adopted-root-writer-skipped")
		.flatMap((group) => group.latestReasons)
		.map((row) => row.subject ?? "");
}

function match(file: string, line = 0) {
	return {
		file,
		range: { start: { line, column: 0 }, end: { line, column: 5 } },
		text: "var x",
	};
}

/** A client whose `ast-grep` child is a double that rewrites like `--update-all`. */
function clientWithExec(
	matches: ReturnType<typeof match>[],
	onUpdateAll: () => { error?: string } = () => ({}),
) {
	const exec = vi.fn(async (args: string[]) => {
		if (args.includes("--update-all"))
			return {
				matches: [],
				totalMatches: 0,
				truncated: false,
				...onUpdateAll(),
			};
		return { matches, totalMatches: matches.length, truncated: false };
	});
	const client = new AstGrepClient();
	(client as unknown as { runner: { exec: typeof exec } }).runner = { exec };
	vi.spyOn(client, "ensureAvailable").mockResolvedValue(true);
	vi.spyOn(client, "formatMatches").mockReturnValue("");
	return { client, exec };
}

function wroteUpdateAll(exec: ReturnType<typeof vi.fn>): boolean {
	return exec.mock.calls.some((call) =>
		(call[0] as string[]).includes("--update-all"),
	);
}

async function applyTool(
	tool: ReturnType<typeof createAstGrepReplaceTool>,
	paths: string[],
	extra: Record<string, unknown> = {},
) {
	return tool.execute(
		"call-5417",
		{
			pattern: "var $X",
			rewrite: "let $X",
			lang: "typescript",
			paths,
			apply: true,
			...extra,
		},
		new AbortController().signal,
		undefined,
		{ cwd: sessionRoot },
	);
}

describe("ast_grep_replace apply honors the session's writable roots (#5417)", () => {
	it("refuses a pattern apply whose match is in a sibling repo, writes nothing and records the refusal", async () => {
		const file = path.join(sibling, "b.ts");
		fs.writeFileSync(file, "var b = 1;\n");
		const { client, exec } = clientWithExec([match(file)]);

		const result = await applyTool(createAstGrepReplaceTool(client), [sibling]);

		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("writable roots");
		expect(wroteUpdateAll(exec)).toBe(false);
		expect(refusalSubjects()).toEqual([`${file}:ast_grep_replace`]);
		expect(recorded).toEqual([]);
	});

	it("refuses a structural apply whose match is in a sibling repo", async () => {
		const file = path.join(sibling, "b.ts");
		fs.writeFileSync(file, "var b = 1;\n");
		const client = new AstGrepClient();
		const tempScanWithFixAsync = vi.fn(async () => ({
			matches: [match(file)],
		}));
		(client as unknown as { runner: unknown }).runner = {
			tempScanDetailedAsync: vi.fn(async () => ({
				matches: [match(file)],
				status: 0,
			})),
			tempScanWithFixAsync,
		};
		vi.spyOn(client, "ensureAvailable").mockResolvedValue(true);
		vi.spyOn(client, "formatMatches").mockReturnValue("");

		const result = await applyTool(
			createAstGrepReplaceTool(client),
			[sibling],
			{ insideKind: "function_declaration" },
		);

		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("writable roots");
		expect(tempScanWithFixAsync).not.toHaveBeenCalled();
		expect(refusalSubjects()).toEqual([`${file}:ast_grep_replace`]);
	});

	it("still applies a match inside the session (the guard refuses by class, not by default)", async () => {
		const file = path.join(sessionRoot, "a.ts");
		fs.writeFileSync(file, "var a = 1;\n");
		const { client, exec } = clientWithExec([match(file)]);

		const result = await applyTool(createAstGrepReplaceTool(client), [file]);

		expect(result.isError).toBeFalsy();
		expect(wroteUpdateAll(exec)).toBe(true);
		expect(refusalSubjects()).toEqual([]);
		expect(result.details?.appliedFiles).toEqual([file]);
	});

	it("refuses an apply under the no-autofix flag and still previews", async () => {
		const file = path.join(sessionRoot, "a.ts");
		fs.writeFileSync(file, "var a = 1;\n");
		const { client, exec } = clientWithExec([match(file)]);
		const tool = createAstGrepReplaceTool(client, undefined, (name) =>
			name === "no-autofix" ? true : undefined,
		);

		const applied = await applyTool(tool, [file]);
		expect(applied.isError).toBe(true);
		expect(applied.content[0]?.text).toContain("no-autofix");
		expect(exec).not.toHaveBeenCalled();

		const preview = await applyTool(tool, [file], { apply: false });
		expect(preview.isError).toBeFalsy();
		expect(wroteUpdateAll(exec)).toBe(false);
	});

	it("refuses an apply that names no session root", async () => {
		const file = path.join(sessionRoot, "a.ts");
		fs.writeFileSync(file, "var a = 1;\n");
		const { client, exec } = clientWithExec([match(file)]);

		const result = await client.replace(
			"var $X",
			"let $X",
			"typescript",
			[file],
			true,
		);

		expect(result.applied).toBe(false);
		expect(result.error).toContain("no session root");
		expect(exec).not.toHaveBeenCalled();
	});
});

describe("an interrupted ast_grep_replace records the files it already rewrote (#5417)", () => {
	// Real ast-grep 0.x, a read-only file among writable ones: `--update-all`
	// rewrote a.ts and c.ts, then exited 6 ("Cannot rewrite file b.ts").
	it("pattern apply: names the rewritten files, not the one it could not write", async () => {
		const [a, b, c] = ["a.ts", "b.ts", "c.ts"].map((name) =>
			path.join(sessionRoot, name),
		);
		for (const file of [a, b, c]) fs.writeFileSync(file, "var x = 1;\n");
		const { client } = clientWithExec([match(a), match(b), match(c)], () => {
			fs.writeFileSync(a, "let x = 1;\n");
			fs.writeFileSync(c, "let x = 1;\n");
			return { error: "Cannot rewrite file b.ts: Permission denied" };
		});

		const result = await applyTool(createAstGrepReplaceTool(client), [
			sessionRoot,
		]);

		expect(result.isError).toBe(true);
		expect(result.details?.appliedFiles).toEqual([a, c]);
		expect(recorded.map((entry) => entry.filePath)).toEqual([a, c]);
	});

	it("structural apply: the failing path's rewritten files are named too", async () => {
		const [a, b] = ["a.ts", "b.ts"].map((name) => path.join(sessionRoot, name));
		for (const file of [a, b]) fs.writeFileSync(file, "var x = 1;\n");
		const client = new AstGrepClient();
		(client as unknown as { runner: unknown }).runner = {
			tempScanDetailedAsync: vi.fn(async () => ({
				matches: [match(a), match(b)],
				status: 0,
			})),
			tempScanWithFixAsync: vi.fn(async () => {
				fs.writeFileSync(a, "let x = 1;\n");
				return {
					matches: [],
					writeStarted: true,
					error: "ast-grep apply failed with exit code 6",
				};
			}),
		};
		vi.spyOn(client, "ensureAvailable").mockResolvedValue(true);
		vi.spyOn(client, "formatMatches").mockReturnValue("");

		const result = await applyTool(
			createAstGrepReplaceTool(client),
			[sessionRoot],
			{ insideKind: "function_declaration" },
		);

		expect(result.isError).toBe(true);
		expect(result.details?.appliedFiles).toEqual([a]);
		expect(recorded.map((entry) => entry.filePath)).toEqual([a]);
	});
});

describe("applyWorkspaceEdit honors the session's writable roots (#5417)", () => {
	function edit(file: string) {
		return {
			changes: {
				[pathToFileURL(file).href]: [
					{
						range: {
							start: { line: 0, character: 0 },
							end: { line: 0, character: 5 },
						},
						newText: "const",
					},
				],
			},
		};
	}

	// The language server runs in the sibling repo, so its own workspace
	// confinement admits the file; only the session's roots refuse it.
	async function expectSiblingEditRefused(
		options: Parameters<typeof applyWorkspaceEdit>[2],
	) {
		const file = path.join(sibling, "lib.ts");
		fs.writeFileSync(file, "value = 1;\n");

		await expect(
			applyWorkspaceEdit(edit(file), sibling, options),
		).rejects.toThrow(/writable roots/);

		expect(fs.readFileSync(file, "utf8")).toBe("value = 1;\n");
		expect(refusalSubjects()).toEqual([`${file}:lsp-edit`]);
	}

	it("refuses a server edit of a sibling repo's file named by sessionRoot", async () => {
		await expectSiblingEditRefused({ sessionRoot });
	});

	it("refuses a server edit of a sibling repo's file named by the mutation context's project root", async () => {
		await expectSiblingEditRefused({
			mutationContext: {
				cwd: sessionRoot,
				correlationId: "5417",
				tool: "lsp-rename",
				source: "lsp-rename" as const,
				runtime: { projectRoot: sessionRoot },
			},
			observe: false,
		});
	});

	it("applies the same edit to a file inside the session", async () => {
		const file = path.join(sessionRoot, "lib.ts");
		fs.writeFileSync(file, "value = 1;\n");

		const applied = await applyWorkspaceEdit(edit(file), sessionRoot, {
			sessionRoot,
		});

		expect(applied.files).toHaveLength(1);
		expect(fs.readFileSync(file, "utf8")).toBe("const = 1;\n");
		expect(refusalSubjects()).toEqual([]);
	});
});

describe("lens_diagnostic_mark suppress honors the roots and the queue (#5417)", () => {
	function suppress(
		tool: ReturnType<typeof createLensDiagnosticMarkTool>,
		file: string,
	) {
		return tool.execute(
			"call-5417",
			{
				filePath: file,
				line: 2,
				message: "bad call",
				rule: "no-bad",
				tool: "eslint",
				disposition: "suppress",
			},
			undefined,
			() => {},
			{ cwd: sessionRoot },
		);
	}

	it("refuses a suppress in a sibling repo, writes nothing and records the refusal", async () => {
		const file = path.join(sibling, "x.ts");
		fs.writeFileSync(file, "const a = 1;\nconst target = bad();\n");

		const result = await suppress(
			createLensDiagnosticMarkTool(() => sessionRoot),
			file,
		);

		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("writable roots");
		expect(fs.readFileSync(file, "utf8")).toBe(
			"const a = 1;\nconst target = bad();\n",
		);
		expect(refusalSubjects()).toEqual([`${file}:lens_diagnostic_mark`]);
		expect(recorded).toEqual([]);
	});

	it("waits for pi's queue: an agent edit made while the mark is parked is not erased", async () => {
		// Recurrence: the mark read the file, then wrote its stale copy back with a
		// plain `fs.writeFile`, outside pi's per-file queue, so a concurrent agent
		// edit (or the deferred formatter's) was erased by it.
		const file = path.join(sessionRoot, "x.ts");
		fs.writeFileSync(file, "const a = 1;\nconst target = bad();\n");
		setHostFileMutationQueueLoader(async () => ({ withFileMutationQueue }));
		const parked = gate();
		const resume = gate();
		writeGate.target = file;
		writeGate.parked = parked.open;
		writeGate.resume = resume.p;

		const marking = suppress(
			createLensDiagnosticMarkTool(() => sessionRoot),
			file,
		);
		await parked.p;
		// The agent's edit, the way pi's edit tool makes it: inside pi's queue.
		let agentWrote = false;
		const agent = withFileMutationQueue(file, async () => {
			fs.appendFileSync(file, "export const AGENT = 2;\n");
			agentWrote = true;
		});
		// A call on another path registers after every earlier queue call, and an
		// earlier call whose file is free has run by then.
		await withFileMutationQueue(
			path.join(sessionRoot, "registration-barrier"),
			async () => {},
		);
		expect(agentWrote).toBe(false);

		resume.open();
		const result = await marking;
		await agent;

		expect(result.isError).toBeFalsy();
		const final = fs.readFileSync(file, "utf8");
		expect(final).toContain("// pi-lens-ignore: no-bad");
		expect(final).toContain("export const AGENT = 2;");
	});
});

describe("writeSourceFile records on every exit (#5417)", () => {
	it("records a write that threw, then rethrows that error", async () => {
		// Recurrence: a throw after some files were written must still reach the
		// writer's authorship record, which the LSP applier alone did by hand.
		const file = path.join(sessionRoot, "x.ts");
		const exits: Array<{ ok: boolean; error?: unknown }> = [];
		const boom = new Error("disk full");

		await expect(
			writeSourceFile(
				{ filePaths: [file], record: (exit) => void exits.push(exit) },
				async () => {
					throw boom;
				},
			),
		).rejects.toBe(boom);

		expect(exits).toEqual([{ ok: false, error: boom }]);
	});

	it("records a clean write with its value", async () => {
		const exits: unknown[] = [];

		const value = await writeSourceFile(
			{
				filePaths: [path.join(sessionRoot, "x.ts")],
				record: (exit) => void exits.push(exit),
			},
			async () => 7,
		);

		expect(value).toBe(7);
		expect(exits).toEqual([{ ok: true, value: 7 }]);
	});
});
