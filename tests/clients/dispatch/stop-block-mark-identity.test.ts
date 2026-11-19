/**
 * A false-positive mark made from the per-edit STOP block must hide the
 * finding it was made from.
 *
 * The STOP block (`buildEnrichedBlockerOutput` in `clients/pipeline.ts`)
 * renders each blocker as `L<n>: <message>`. It never prints the tool, and
 * mypy folds its error code into the message (`[import-not-found] Cannot
 * find ...`, `clients/dispatch/runners/mypy.ts`). An agent marking what it
 * was shown therefore passes `rule: "import-not-found"` and the message
 * without the bracket, and no `tool`. The finding anchors on
 * `tool: "mypy"` and the bracketed message, so the strict anchors differed
 * on two parts and the mark hid nothing: the agent marked the same finding
 * three times in one session, each mark reporting `previousDisposition:
 * false-positive`.
 *
 * The turn-end re-serve of the same block already accepts a mark without
 * tool or rule (`inlineBlockerIdentities`, #3246); the dispatcher's output
 * filter, which decides the live STOP block, did not.
 *
 * Every case drives the real producers: mypy output through the real
 * `parseMypyOutput`, the mark through the real `lens_diagnostic_mark` tool,
 * and the filter through `dispatchForFile`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	_resetDeferredForTests,
	_resetStateCacheForTests,
} from "../../../clients/diagnostic-dispositions.js";
import {
	clearCoverageNoticeState,
	createDispatchContext,
	dispatchForFile,
	RunnerRegistry,
} from "../../../clients/dispatch/dispatcher.js";
import { FactStore } from "../../../clients/dispatch/fact-store.js";
import { parseMypyOutput } from "../../../clients/dispatch/runners/mypy.js";
import type {
	Diagnostic,
	RunnerGroup,
} from "../../../clients/dispatch/types.js";
import { clearWidgetState } from "../../../clients/widget-state.js";
import { createLensDiagnosticMarkTool } from "../../../tools/lens-diagnostic-mark.js";
import { createMockRunner } from "../../mocks/runner-factory.js";
import { setupTestEnvironment } from "../test-utils.js";

let projectRoot: string;
let cleanup: () => void;
let previousDataDir: string | undefined;

const MISSING =
	'Cannot find implementation or library stub for module named "pkg"';
const FILE_CONTENT = [
	"from pkg import (",
	"    thing,",
	")",
	"from pkg import other",
	"",
].join("\n");
// mypy's own output shape: `<file>:<line>: error: <message>  [<code>]`.
const MYPY_OUTPUT = [
	`t.py:1: error: ${MISSING}  [import-not-found]`,
	`t.py:4: error: ${MISSING}  [import-not-found]`,
	"Found 2 errors in 1 file (checked 1 source file)",
].join("\n");

beforeEach(() => {
	({ tmpDir: projectRoot, cleanup } =
		setupTestEnvironment("pi-lens-stop-mark-"));
	previousDataDir = process.env.PILENS_DATA_DIR;
	process.env.PILENS_DATA_DIR = path.join(projectRoot, ".data");
	_resetDeferredForTests();
	_resetStateCacheForTests();
	clearCoverageNoticeState();
	clearWidgetState();
});

afterEach(() => {
	if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
	else process.env.PILENS_DATA_DIR = previousDataDir;
	_resetStateCacheForTests();
	clearWidgetState();
	cleanup();
});

function writeTarget(): string {
	const fileAbs = path.join(projectRoot, "t.py");
	fs.writeFileSync(fileAbs, FILE_CONTENT);
	return fileAbs;
}

function mypyDiagnostics(fileAbs: string): Diagnostic[] {
	return parseMypyOutput(MYPY_OUTPUT, fileAbs, projectRoot);
}

async function dispatchMypy(
	fileAbs: string,
	reshape: (ds: Diagnostic[]) => Diagnostic[] = (ds) => ds,
): Promise<Diagnostic[]> {
	const registry = new RunnerRegistry();
	const diagnostics = reshape(mypyDiagnostics(fileAbs));
	registry.register(
		createMockRunner({
			id: "mypy",
			appliesTo: ["python"],
			runResult: { status: "failed", diagnostics, semantic: "blocking" },
		}),
	);
	const facts = new FactStore();
	const ctx = createDispatchContext(
		fileAbs,
		projectRoot,
		{ getFlag: () => false },
		facts,
	);
	facts.setFileFact(ctx.filePath, "file.content", FILE_CONTENT);
	const groups: RunnerGroup[] = [{ mode: "all", runnerIds: ["mypy"] }];
	const result = await dispatchForFile(ctx, groups, registry);
	return result.blockers;
}

async function mark(params: Record<string, unknown>): Promise<void> {
	const tool = createLensDiagnosticMarkTool(() => projectRoot);
	const result = await tool.execute(
		"call-1",
		{ disposition: "false-positive", reason: "test", ...params },
		undefined,
		() => {},
		{ cwd: projectRoot },
	);
	expect(result.isError).not.toBe(true);
	_resetStateCacheForTests();
}

describe("a mark made from the STOP block hides the finding it names", () => {
	it("premise: the real mypy parser folds the code into the message and names the tool", () => {
		const [first] = mypyDiagnostics(writeTarget());
		expect(first).toMatchObject({
			tool: "mypy",
			rule: "import-not-found",
			message: `[import-not-found] ${MISSING}`,
			line: 1,
			semantic: "blocking",
		});
	});

	it("reports both findings when nothing is marked (control)", async () => {
		const blockers = await dispatchMypy(writeTarget());
		expect(blockers.map((b) => b.line)).toEqual([1, 4]);
	});

	it("honors a mark that splits the rendered [rule] message into rule and message, with no tool", async () => {
		const fileAbs = writeTarget();
		// Exactly what the agent passed in the recorded session.
		await mark({
			path: fileAbs,
			line: 1,
			rule: "import-not-found",
			message: MISSING,
		});
		const blockers = await dispatchMypy(fileAbs);
		expect(blockers.map((b) => b.line)).toEqual([4]);
	});

	it("honors a mark that quotes the rendered message whole, with no tool or rule", async () => {
		const fileAbs = writeTarget();
		await mark({
			path: fileAbs,
			line: 1,
			message: `[import-not-found] ${MISSING}`,
		});
		const blockers = await dispatchMypy(fileAbs);
		expect(blockers.map((b) => b.line)).toEqual([4]);
	});

	it("still honors a mark with the finding's canonical identity", async () => {
		const fileAbs = writeTarget();
		await mark({
			path: fileAbs,
			line: 1,
			tool: "mypy",
			rule: "import-not-found",
			message: `[import-not-found] ${MISSING}`,
		});
		const blockers = await dispatchMypy(fileAbs);
		expect(blockers.map((b) => b.line)).toEqual([4]);
	});

	it("does not hide the same message on another line: the mark stays bound to its line", async () => {
		const fileAbs = writeTarget();
		await mark({
			path: fileAbs,
			line: 1,
			rule: "import-not-found",
			message: MISSING,
		});
		const blockers = await dispatchMypy(fileAbs);
		expect(blockers.some((b) => b.line === 4)).toBe(true);
	});

	it("does not take a different rule's bracket for this rule's", async () => {
		const fileAbs = writeTarget();
		// The message text matches once its bracket is stripped, but the mark
		// names another rule, so it is not this finding.
		await mark({
			path: fileAbs,
			line: 1,
			rule: "attr-defined",
			message: MISSING,
		});
		const blockers = await dispatchMypy(fileAbs);
		expect(blockers.map((b) => b.line)).toEqual([1, 4]);
	});

	it("keeps a bracket that is not the finding's own rule as message text", async () => {
		const fileAbs = writeTarget();
		// ast-grep's shape: the bracket names a category, not the rule
		// (`clients/dispatch/runners/ast-grep-napi.ts`). Stripping it would
		// let a mark on the bare text match a finding it never quoted.
		const categorised = (ds: Diagnostic[]): Diagnostic[] =>
			ds.map((d) => ({ ...d, message: `[slop] ${MISSING}` }));
		await mark({
			path: fileAbs,
			line: 1,
			rule: "import-not-found",
			message: MISSING,
		});
		const blockers = await dispatchMypy(fileAbs, categorised);
		expect(blockers.map((b) => b.line)).toEqual([1, 4]);
	});

	// Review r1 (CodeRabbit on #5711): an alias spelling of one finding must
	// not match a DIFFERENT live finding whose own message is that spelling, or
	// one mark on the second silences both (the #5367 ownership rule, applied
	// to every alias, not only the display form).
	function withBareSibling(bareMessage: string, bracketed?: string) {
		return (ds: Diagnostic[]): Diagnostic[] => {
			const [first] = ds;
			if (!first) throw new Error("fixture: mypy parsed no diagnostic");
			const a =
				bracketed === undefined ? first : { ...first, message: bracketed };
			const b: Diagnostic = {
				...first,
				id: "sibling-bare",
				// Another column, so the overlap dedupe (`findingKey`: file, line,
				// column, class, rule) keeps both findings on the one line.
				column: (first.column ?? 1) + 4,
				message: bareMessage,
			};
			return [a, b];
		};
	}

	it("keeps a bracketed finding when the mark names a different finding whose message is its stripped form", async () => {
		const fileAbs = writeTarget();
		const reshape = withBareSibling(MISSING);
		// Control: both findings reach the block unmarked.
		expect(
			(await dispatchMypy(fileAbs, reshape)).map((b) => b.message),
		).toEqual([`[import-not-found] ${MISSING}`, MISSING]);
		await mark({
			path: fileAbs,
			line: 1,
			tool: "mypy",
			rule: "import-not-found",
			message: MISSING,
		});
		const blockers = await dispatchMypy(fileAbs, reshape);
		expect(blockers.map((b) => b.message)).toEqual([
			`[import-not-found] ${MISSING}`,
		]);
	});

	it("keeps a long bracketed finding when the mark names a different finding whose message is its stripped display form", async () => {
		const fileAbs = writeTarget();
		const prefix = "[import-not-found] ";
		const long = `${prefix}${"x".repeat(1000)}A`;
		// What a cascade-style render shows of `long` (its first 100 characters),
		// minus the bracket: the spelling a mark on the sibling carries.
		const bare = "x".repeat(100 - prefix.length);
		const reshape = withBareSibling(bare, long);
		expect(
			(await dispatchMypy(fileAbs, reshape)).map((b) => b.message),
		).toEqual([long, bare]);
		await mark({
			path: fileAbs,
			line: 1,
			tool: "mypy",
			rule: "import-not-found",
			message: bare,
		});
		const blockers = await dispatchMypy(fileAbs, reshape);
		expect(blockers.map((b) => b.message)).toEqual([long]);
	});
});
