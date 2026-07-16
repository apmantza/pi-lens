import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	_resetDeferredForTests,
	_resetStateCacheForTests,
	getDisposition,
	isDeferredThisSession,
} from "../../clients/diagnostic-dispositions.js";
import { createLensDiagnosticMarkTool } from "../../tools/lens-diagnostic-mark.js";

let tmpDir: string;
let previousDataDir: string | undefined;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-mark-tool-"));
	previousDataDir = process.env.PILENS_DATA_DIR;
	process.env.PILENS_DATA_DIR = path.join(tmpDir, "data");
	_resetDeferredForTests();
	_resetStateCacheForTests();
});

afterEach(() => {
	if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
	else process.env.PILENS_DATA_DIR = previousDataDir;
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeFile(name: string, content: string): string {
	const p = path.join(tmpDir, name);
	fs.writeFileSync(p, content);
	return p;
}

const tool = createLensDiagnosticMarkTool(() => tmpDir);

async function run(params: Record<string, unknown>) {
	return tool.execute(
		"call-1",
		params,
		undefined,
		() => {},
		{ cwd: tmpDir },
	);
}

describe("lens_diagnostic_mark tool (#690)", () => {
	it("disposition=suppress writes the inline comment into the real file AND records a store entry", async () => {
		writeFile("a.ts", "const a = 1;\nconst target = bad();\n");
		const result = await run({
			filePath: "a.ts",
			line: 2,
			message: "bad call",
			rule: "no-bad",
			tool: "eslint",
			disposition: "suppress",
		});

		expect(result.isError).toBeFalsy();
		const updated = fs.readFileSync(path.join(tmpDir, "a.ts"), "utf-8");
		expect(updated).toContain("// pi-lens-ignore: no-bad");

		const anchor = (result.details as { anchor: string }).anchor;
		expect(anchor.startsWith("ddw:")).toBe(true);
		expect(getDisposition(tmpDir, anchor)?.disposition).toBe("suppress");
	});

	it("disposition=suppress without a rule errors", async () => {
		writeFile("a.ts", "const target = bad();\n");
		const result = await run({
			filePath: "a.ts",
			line: 1,
			message: "bad call",
			disposition: "suppress",
		});
		expect(result.isError).toBe(true);
	});

	it("disposition=defer leaves the file untouched and isDeferredThisSession is true for the returned anchor", async () => {
		const content = "const target = bad();\n";
		writeFile("a.ts", content);
		const result = await run({
			filePath: "a.ts",
			line: 1,
			message: "bad call",
			rule: "no-bad",
			disposition: "defer",
		});
		expect(result.isError).toBeFalsy();
		expect(fs.readFileSync(path.join(tmpDir, "a.ts"), "utf-8")).toBe(content);
		const anchor = (result.details as { anchor: string }).anchor;
		expect(isDeferredThisSession(anchor)).toBe(true);
	});

	it("disposition=flagged records the disposition and getDisposition shows flagged with fix context", async () => {
		writeFile("a.ts", "const target = bad();\n");
		const result = await run({
			filePath: "a.ts",
			line: 1,
			message: "bad call",
			rule: "no-bad",
			disposition: "flagged",
			reason: "fix later",
		});
		expect(result.isError).toBeFalsy();
		const anchor = (result.details as { anchor: string }).anchor;
		const entry = getDisposition(tmpDir, anchor);
		expect(entry?.disposition).toBe("flagged");
		expect(entry?.reason).toBe("fix later");
		expect(entry?.line).toBe(1);
		expect(entry?.lineText).toBe("const target = bad();");
	});

	it("errors gracefully on an unreadable file path", async () => {
		const result = await run({
			filePath: "does-not-exist.ts",
			line: 1,
			message: "bad call",
			rule: "no-bad",
			disposition: "false-positive",
		});
		expect(result.isError).toBe(true);
		expect(String(result.content[0]?.text)).toMatch(/could not read/i);
	});
});
