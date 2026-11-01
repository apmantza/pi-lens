// #4949: tree-sitter recovers from syntax it cannot parse and the extractor
// then drops declarations silently; a read-tool miss read as absence. The
// extractor flags a recovered tree, module-report discloses it in `warnings`,
// the tool text renders it on a miss and on module_report.
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
	moduleReport,
	readEnclosing,
	readSymbol,
} from "../../clients/module-report.js";
import type { TreeSitterClient } from "../../clients/tree-sitter-client.js";
import { getSharedTreeSitterClient } from "../../clients/tree-sitter-shared.js";
import { TreeSitterSymbolExtractor } from "../../clients/tree-sitter-symbol-extractor.js";
import {
	createModuleReportTool,
	createReadEnclosingTool,
	createReadSymbolTool,
} from "../../tools/module-report.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

const WARNING =
	"tree-sitter could not parse part of this file; the symbol list may be incomplete.";

// Valid TypeScript that the shipped grammar cannot parse: `importOriginal<typeof
// import("./t.js")>()` makes tree-sitter recover and drop `errorDiag`.
const ERROR_TS = [
	'import { vi } from "vitest";',
	'vi.mock("./t.js", async (importOriginal) => ({',
	'\t...(await importOriginal<typeof import("./t.js")>()),',
	"\ta: 1,",
	"}));",
	"",
	"function errorDiag(n: number): number {",
	"\treturn n;",
	"}",
	"",
].join("\n");

const BAD_PY =
	"def good():\n    return 1\n\ndef broken(:\n    x = [1,\n\ndef after():\n    pass\n";

const CLEAN_TS = "export function clean(n: number): number {\n  return n;\n}\n";

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length) cleanups.pop()?.();
});
function makeEnv() {
	const env = setupTestEnvironment("pi-lens-syntax-errors-");
	cleanups.push(env.cleanup);
	return env;
}

let client: TreeSitterClient;
beforeAll(async () => {
	client = getSharedTreeSitterClient()!;
	await client.init();
});

describe("extract() syntaxErrors flag (#4949)", () => {
	async function extractOf(lang: string, file: string, src: string) {
		const env = makeEnv();
		const fp = createTempFile(env.tmpDir, file, src);
		const tree = await client.parseFile(fp, lang);
		const extractor = new TreeSitterSymbolExtractor(lang, client);
		await extractor.init();
		return extractor.extract(tree!, fp, src);
	}

	it("flags a recovered tree and omits the flag on a clean one; coverage stays complete", async () => {
		const broken = await extractOf("typescript", "m.ts", ERROR_TS);
		const clean = await extractOf("typescript", "c.ts", CLEAN_TS);
		expect(broken.syntaxErrors).toBe(true);
		expect("syntaxErrors" in clean).toBe(false);
		// Non-goal pin: call-graph gating reads coverage.definitions; the flag
		// must not smuggle a coverage change in.
		expect(broken.coverage?.definitions).toBe("complete");
		expect(clean.coverage?.definitions).toBe("complete");
	});
});

describe("read tools disclose a recovered parse (#4949)", () => {
	it("readSymbol miss on the importOriginal<typeof import()> file carries the warning", async () => {
		const env = makeEnv();
		const file = createTempFile(env.tmpDir, "m.ts", ERROR_TS);
		const result = await readSymbol(file, "errorDiag", env.tmpDir);
		expect(result.found).toBe(false);
		expect(result.warnings).toContain(WARNING);
	});

	it("broken Python: a miss after the error warns, a hit before it is unchanged", async () => {
		const env = makeEnv();
		const file = createTempFile(env.tmpDir, "bad.py", BAD_PY);
		const miss = await readSymbol(file, "after", env.tmpDir);
		expect(miss.found).toBe(false);
		expect(miss.warnings).toContain(WARNING);
		const hit = await readSymbol(file, "good", env.tmpDir);
		expect(hit.found).toBe(true);
		expect(hit.warnings).toBeUndefined();
	});

	// Recurrence: a disclosure that fires on every file trains the agent to
	// ignore it.
	it("a clean file carries no warning on a miss or a hit", async () => {
		const env = makeEnv();
		const file = createTempFile(env.tmpDir, "c.ts", CLEAN_TS);
		const miss = await readSymbol(file, "ghost", env.tmpDir);
		expect(miss.found).toBe(false);
		expect(miss.warnings).toBeUndefined();
		const hit = await readSymbol(file, "clean", env.tmpDir);
		expect(hit.found).toBe(true);
		expect(hit.warnings).toBeUndefined();
		const enclosing = await readEnclosing(file, 99, env.tmpDir);
		expect(enclosing.warnings).toBeUndefined();
	});

	it("readEnclosing on a line inside the dropped declaration carries the warning", async () => {
		const env = makeEnv();
		const file = createTempFile(env.tmpDir, "m.ts", ERROR_TS);
		const result = await readEnclosing(file, 8, env.tmpDir);
		expect(result.found).toBe(false);
		expect(result.warnings).toContain(WARNING);
	});

	it("module_report lists the warning for an error-bearing file only", async () => {
		const env = makeEnv();
		const bad = createTempFile(env.tmpDir, "bad.py", BAD_PY);
		const clean = createTempFile(env.tmpDir, "c.ts", CLEAN_TS);
		expect((await moduleReport(bad, env.tmpDir)).warnings).toContain(WARNING);
		expect(
			(await moduleReport(clean, env.tmpDir)).warnings ?? [],
		).not.toContain(WARNING);
	});
});

describe("tool text renders the warning (#4949)", () => {
	const ctx = (cwd: string) => ({ cwd });
	it("read_symbol miss, read_enclosing miss and module_report show it; a hit does not", async () => {
		const env = makeEnv();
		createTempFile(env.tmpDir, "m.ts", ERROR_TS);
		createTempFile(env.tmpDir, "bad.py", BAD_PY);
		const readSym = createReadSymbolTool(
			() => env.tmpDir,
			() => undefined,
		);
		const readEnc = createReadEnclosingTool(
			() => env.tmpDir,
			() => undefined,
		);
		const report = createModuleReportTool(() => env.tmpDir);

		const miss = await readSym.execute(
			"1",
			{ path: "m.ts", symbol: "errorDiag" },
			undefined,
			null,
			ctx(env.tmpDir),
		);
		expect(String(miss.content[0]?.text)).toContain(`Warnings: ${WARNING}`);
		const hit = await readSym.execute(
			"2",
			{ path: "bad.py", symbol: "good" },
			undefined,
			null,
			ctx(env.tmpDir),
		);
		expect(String(hit.content[0]?.text)).not.toContain("could not parse part");
		const enc = await readEnc.execute(
			"3",
			{ path: "m.ts", line: 8 },
			undefined,
			null,
			ctx(env.tmpDir),
		);
		expect(String(enc.content[0]?.text)).toContain(WARNING);
		const rep = await report.execute(
			"4",
			{ path: "bad.py" },
			undefined,
			null,
			ctx(env.tmpDir),
		);
		expect(String(rep.content[0]?.text)).toContain(WARNING);
	});

	// Recurrence: a recovered parse that drops EVERY declaration makes the report
	// unavailable, and the unavailable early return dropped the warning
	// exactly there (#4949 review F1). The stale `view: "compact"` below
	// exercises the #5137 fall-through to the default preset on that path.
	it("module_report stale view on a zero-symbol error file falls through and keeps the warning (#5137)", async () => {
		const env = makeEnv();
		createTempFile(env.tmpDir, "garbage.py", "def (:\n  x = [\n )) garbage\n");
		const report = createModuleReportTool(() => env.tmpDir);
		const result = await report.execute(
			"5",
			{ path: "garbage.py", view: "compact" },
			undefined,
			null,
			ctx(env.tmpDir),
		);
		const text = String(result.content[0]?.text);
		expect(text).toContain("unavailable");
		expect(text).toContain(`WARNING: ${WARNING}`);
	});
});
