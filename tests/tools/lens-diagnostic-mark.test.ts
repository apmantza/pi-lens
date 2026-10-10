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
import {
	clearWidgetState,
	markWidgetFileBlockersStale,
	recordDiagnostics,
	retireWidgetDependencyDriftBlockers,
} from "../../clients/widget-state.js";
import { createLensDiagnosticMarkTool } from "../../tools/lens-diagnostic-mark.js";
import {
	createCaseAliasFixture,
	removeTempDirSync,
} from "../clients/test-utils.js";

let tmpDir: string;
let previousDataDir: string | undefined;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-mark-tool-"));
	previousDataDir = process.env.PILENS_DATA_DIR;
	process.env.PILENS_DATA_DIR = path.join(tmpDir, "data");
	_resetDeferredForTests();
	_resetStateCacheForTests();
	clearWidgetState();
});

afterEach(() => {
	if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
	else process.env.PILENS_DATA_DIR = previousDataDir;
	removeTempDirSync(tmpDir);
	clearWidgetState();
});

function writeFile(name: string, content: string): string {
	const p = path.join(tmpDir, name);
	fs.writeFileSync(p, content);
	return p;
}

const tool = createLensDiagnosticMarkTool(() => tmpDir);

async function run(params: Record<string, unknown>) {
	return tool.execute("call-1", params, undefined, () => {}, { cwd: tmpDir });
}

/**
 * #4187 R4-1: a capture bridge mounted the way a co-process extension reads it,
 * so the assertions below see the entry the tool really sends.
 */
const MUTATION_BRIDGE_KEY = Symbol.for("pi-lens:mutation-bridge");
type RecordedEntry = {
	filePath: string;
	kind: string;
	consumer?: string;
	provenance?: string;
	toolCallId?: string;
};
const recordedEntries: RecordedEntry[] = [];
Object.defineProperty(globalThis, MUTATION_BRIDGE_KEY, {
	value: Object.freeze({
		version: 1 as const,
		recordMutation(entry: RecordedEntry): boolean {
			recordedEntries.push(entry);
			return true;
		},
	}),
	writable: false,
	configurable: false,
	enumerable: false,
});

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
		expect(isDeferredThisSession(tmpDir, anchor)).toBe(true);
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

describe("lens_diagnostic_mark tool — line verification/reanchoring (#802)", () => {
	it("stale line + widget-state match on another line reanchors, storing the disposition with the CURRENT line's content hash", async () => {
		const absPath = writeFile(
			"a.ts",
			"const a = 1;\nconst b = 2;\nconst target = bad();\n",
		);
		// The finding is now recorded (by a fresher pipeline run) at line 3, but
		// the agent calls with the STALE line 2 it read earlier.
		recordDiagnostics(absPath, [
			{ tool: "eslint", rule: "no-bad", message: "bad call", line: 3 },
		]);
		const result = await run({
			filePath: "a.ts",
			line: 2,
			message: "bad call",
			rule: "no-bad",
			tool: "eslint",
			disposition: "false-positive",
		});
		expect(result.isError).toBeFalsy();
		expect(String(result.content[0]?.text)).toContain("a.ts:3");
		expect(String(result.content[0]?.text)).toMatch(
			/reanchored from line 2 to 3/,
		);
		expect((result.details as { line: number }).line).toBe(3);

		// The stored strict anchor must hash line 3's ("const target = bad();")
		// content, not line 2's ("const b = 2;") — i.e. the SAME anchor a fresh
		// lens_diagnostics call against this file would derive.
		const anchor = (result.details as { anchor: string }).anchor;
		const entry = getDisposition(tmpDir, anchor);
		expect(entry?.disposition).toBe("false-positive");
	});

	// #3160: `widgetCrossCheck` looked up the RAW (possibly mis-cased) absPath
	// against `getFileDiagnostics`, which keys with `normalizeEphemeralMapKey`
	// — case-preserving on POSIX by design (no filesystem I/O on that hot
	// path). Production writers key from `ctx.filePath`, which
	// `createDispatchContext` already normalizes to the on-disk casing
	// (#2016/#3098), so a mis-cased `lens_diagnostic_mark` call derived a
	// DIFFERENT key than the one the widget stored under, missed the live
	// diagnostic, and silently fell through to the fuzzy fallback — exactly
	// the input the #802 cross-check exists for. `createCaseAliasFixture`
	// manufactures the identical kernel contract (two spellings, one file,
	// `realpath` reporting the on-disk one) with a case-variant symlink, so
	// this reproduces on the case-sensitive ubuntu Unit tests lane too — refs
	// #3098/#3159.
	it("mis-cased filePath still finds the live widget diagnostic to reanchor (#3160)", async (ctx) => {
		const fixture = createCaseAliasFixture(tmpDir, {
			content: "const a = 1;\nconst b = 2;\nconst target = bad();\n",
		});
		ctx.skip(fixture.skipReason !== undefined, fixture.skipReason ?? "");

		// The widget-state write side records under the on-disk casing (what
		// `ctx.filePath` always is in production) — never the caller's raw
		// mis-cased spelling.
		recordDiagnostics(fixture.onDisk, [
			{ tool: "eslint", rule: "no-bad", message: "bad call", line: 3 },
		]);

		const misCasedRelative = path.relative(tmpDir, fixture.rawMisCased);
		const result = await run({
			filePath: misCasedRelative,
			line: 2, // stale
			message: "bad call",
			rule: "no-bad",
			tool: "eslint",
			disposition: "false-positive",
		});

		expect(result.isError).toBeFalsy();
		expect(String(result.content[0]?.text)).toMatch(
			/reanchored from line 2 to 3/,
		);
		expect((result.details as { line: number }).line).toBe(3);
	});

	// #3184: the mark tool takes an ALREADY-absolute `filePath` argument
	// through untouched (`tools/lens-diagnostic-mark.ts:324-326`,
	// `path.isAbsolute(x) ? x : path.resolve(cwd, x)`), and before the
	// path-utils fix `normalizeMapKey` passed dot segments through on POSIX —
	// its casing arm returns the caller's spelling whenever
	// `adoptCanonicalCasing` changes nothing, and for `<dir>/../<dir>/a.ts` it
	// always does. So an agent-typed absolute path containing `/../` derived a
	// key no writer ever used (every canonical writer keys through
	// `path.resolve` first), the cross-check missed the live diagnostic, and
	// the mark silently fell through to the fuzzy fallback — the #802
	// cross-check's own defeat condition. The dot segment is built by string
	// CONCATENATION: `path.join`/`path.resolve` would fold it and make the
	// fixture vacuous.
	it("an absolute filePath with a dot segment still finds the live widget diagnostic to reanchor (#3184)", async () => {
		const absPath = writeFile(
			"a.ts",
			"const a = 1;\nconst b = 2;\nconst target = bad();\n",
		);
		// Canonical write, exactly as a per-edit dispatch keys it (ctx.filePath).
		recordDiagnostics(absPath, [
			{ tool: "eslint", rule: "no-bad", message: "bad call", line: 3 },
		]);

		const dotSegmentAbs = `${tmpDir}${path.sep}..${path.sep}${path.basename(tmpDir)}${path.sep}a.ts`;
		expect(dotSegmentAbs).toContain("..");
		expect(path.isAbsolute(dotSegmentAbs)).toBe(true);
		expect(fs.realpathSync.native(dotSegmentAbs)).toBe(
			fs.realpathSync.native(absPath),
		);

		const result = await run({
			filePath: dotSegmentAbs,
			line: 2, // stale
			message: "bad call",
			rule: "no-bad",
			tool: "eslint",
			disposition: "false-positive",
		});

		expect(result.isError).toBeFalsy();
		expect(String(result.content[0]?.text)).toMatch(
			/reanchored from line 2 to 3/,
		);
		expect((result.details as { line: number }).line).toBe(3);
	});

	// #2275 review F2: the widget footer's dependency-drift delivery cap stops
	// RENDERING a demoted row after N unconfirmed deliveries. It must not
	// splice the entry out of widget-state — this tool cross-checks that same
	// `allDiagnostics` list to reanchor, so a dropped record would silently
	// degrade every post-cap mark to the fuzzy fallback.
	it("still cross-checks a footer-capped dependency-drift demotion", async () => {
		const absPath = writeFile(
			"capped.ts",
			"const a = 1;\nconst b = 2;\nconst target = bad();\n",
		);
		recordDiagnostics(absPath, [
			{
				tool: "lsp",
				rule: "no-bad",
				message: "bad call",
				line: 3,
				severity: "error",
				semantic: "blocking",
			},
		]);
		expect(markWidgetFileBlockersStale(absPath, "dependency-drift")).toBe(true);
		expect(retireWidgetDependencyDriftBlockers(absPath)).toBe(true);

		const result = await run({
			filePath: "capped.ts",
			line: 2, // stale
			message: "bad call",
			rule: "no-bad",
			tool: "lsp",
			disposition: "false-positive",
		});
		expect(result.isError).toBeFalsy();
		expect(String(result.content[0]?.text)).toMatch(
			/reanchored from line 2 to 3/,
		);
		expect((result.details as { line: number }).line).toBe(3);
	});

	it("suppress with reanchor writes the comment above the CURRENT line, not the stale caller line", async () => {
		const absPath = writeFile(
			"a.ts",
			"const a = 1;\nconst b = 2;\nconst target = bad();\n",
		);
		recordDiagnostics(absPath, [
			{ tool: "eslint", rule: "no-bad", message: "bad call", line: 3 },
		]);
		const result = await run({
			filePath: "a.ts",
			line: 2, // stale
			message: "bad call",
			rule: "no-bad",
			tool: "eslint",
			disposition: "suppress",
		});
		expect(result.isError).toBeFalsy();
		const updated = fs.readFileSync(absPath, "utf-8").split(/\r?\n/);
		// Comment lands directly above the CURRENT (line 3) target, not above the
		// stale line 2.
		expect(updated[0]).toBe("const a = 1;");
		expect(updated[1]).toBe("const b = 2;");
		expect(updated[2]).toContain("pi-lens-ignore: no-bad");
		expect(updated[3]).toContain("const target = bad();");
	});

	it("no widget state + in-bounds non-empty line is accepted as-is (unchanged behavior)", async () => {
		const absPath = writeFile("a.ts", "const target = bad();\n");
		const result = await run({
			filePath: "a.ts",
			line: 1,
			message: "bad call",
			rule: "no-bad",
			tool: "eslint",
			disposition: "suppress",
		});
		expect(result.isError).toBeFalsy();
		expect(String(result.content[0]?.text)).not.toMatch(/reanchored/);
		const updated = fs.readFileSync(absPath, "utf-8");
		expect(updated).toContain("pi-lens-ignore: no-bad");
	});

	it("out-of-bounds line with no widget-state match errors and writes nothing", async () => {
		writeFile("a.ts", "const target = bad();\n");
		const result = await run({
			filePath: "a.ts",
			line: 99,
			message: "bad call",
			rule: "no-bad",
			tool: "eslint",
			disposition: "suppress",
		});
		expect(result.isError).toBe(true);
		expect(String(result.content[0]?.text)).toMatch(/refusing to suppress/i);
		const content = fs.readFileSync(path.join(tmpDir, "a.ts"), "utf-8");
		expect(content).toBe("const target = bad();\n");
	});

	it("blank line with no widget-state match and no plausible line nearby errors for suppress", async () => {
		// 15 blank lines — the target line (8) has no non-blank content within
		// the ± FUZZY_SEARCH_RADIUS window, so the fuzzy fallback has nothing
		// plausible to reanchor to.
		writeFile("a.ts", "\n".repeat(15));
		const result = await run({
			filePath: "a.ts",
			line: 8,
			message: "bad call",
			rule: "no-bad",
			tool: "eslint",
			disposition: "suppress",
		});
		expect(result.isError).toBe(true);
		expect(String(result.content[0]?.text)).toMatch(/refusing to suppress/i);
	});

	it("batch suppress two findings top-down in one file: both comments land correctly thanks to reanchoring", async () => {
		const absPath = writeFile(
			"a.ts",
			"const a = 1;\nconst first = bad1();\nconst mid = 2;\nconst second = bad2();\n",
		);
		// Both findings recorded at their real, current lines.
		recordDiagnostics(absPath, [
			{ tool: "eslint", rule: "no-bad", message: "bad call one", line: 2 },
			{ tool: "eslint", rule: "no-bad", message: "bad call two", line: 4 },
		]);

		// Suppress the FIRST finding (line 2) — top-down, as an agent naturally
		// would working through a findings list in order.
		const first = await run({
			filePath: "a.ts",
			line: 2,
			message: "bad call one",
			rule: "no-bad",
			tool: "eslint",
			disposition: "suppress",
		});
		expect(first.isError).toBeFalsy();

		// The second finding's line has NOT shifted in widget-state (it's a
		// stale snapshot from before this suppress ran), so the caller still
		// passes the ORIGINAL line 4 — but the real content has shifted to line
		// 5 because of the comment just inserted above line 2. Re-recording
		// widget-state to reflect the post-insert reality is what a fresh
		// lens_diagnostics call would do; simulate that here.
		recordDiagnostics(absPath, [
			{ tool: "eslint", rule: "no-bad", message: "bad call two", line: 5 },
		]);
		const second = await run({
			filePath: "a.ts",
			line: 4, // stale — pre-shift
			message: "bad call two",
			rule: "no-bad",
			tool: "eslint",
			disposition: "suppress",
		});
		expect(second.isError).toBeFalsy();
		expect(String(second.content[0]?.text)).toMatch(
			/reanchored from line 4 to 5/,
		);

		const finalLines = fs.readFileSync(absPath, "utf-8").split(/\r?\n/);
		// Comment for finding one directly above "const first = bad1();"
		const firstIdx = finalLines.findIndex((l) => l.includes("const first"));
		expect(finalLines[firstIdx - 1]).toContain("pi-lens-ignore: no-bad");
		// Comment for finding two directly above "const second = bad2();"
		const secondIdx = finalLines.findIndex((l) => l.includes("const second"));
		expect(finalLines[secondIdx - 1]).toContain("pi-lens-ignore: no-bad");
	});
});

// #4187 R4-1, R4-3 (T7): a suppress write carries no bytes of its own, so the
// read guard advances the file's authorship only when the entry says it was
// observed AND names the call whose `tool_call` checked that file. Recurrence:
// without `provenance` the record never advances (a file the agent authored
// costs a re-read), and without `toolCallId` the guard cannot license it, so it
// ends the authorship it should have kept. The guard half of the rule is pinned
// by tests/clients/runtime-tool-call.test.ts.
describe("lens_diagnostic_mark's suppress record names its call (#4187 R4-1)", () => {
	it("sends provenance observed and the suppress call's own id", async () => {
		recordedEntries.length = 0;
		const absPath = writeFile(
			"marked.ts",
			"const a = 1;\nconst target = bad();\n",
		);
		const result = await tool.execute(
			"call-4187-suppress",
			{
				filePath: "marked.ts",
				line: 2,
				message: "bad call",
				rule: "no-bad",
				tool: "eslint",
				disposition: "suppress",
			},
			undefined,
			() => {},
			{ cwd: tmpDir },
		);
		expect(result.isError).toBeFalsy();
		expect(recordedEntries).toEqual([
			expect.objectContaining({
				filePath: absPath,
				kind: "edit",
				consumer: "lens_diagnostic_mark",
				provenance: "observed",
				toolCallId: "call-4187-suppress",
			}),
		]);
	});

	it("records no mutation for a disposition that writes nothing", async () => {
		recordedEntries.length = 0;
		writeFile("deferred.ts", "const a = 1;\nconst target = bad();\n");
		const result = await tool.execute(
			"call-4187-defer",
			{
				filePath: "deferred.ts",
				line: 2,
				message: "bad call",
				rule: "no-bad",
				tool: "eslint",
				disposition: "defer",
			},
			undefined,
			() => {},
			{ cwd: tmpDir },
		);
		expect(result.isError).toBeFalsy();
		expect(recordedEntries).toEqual([]);
	});
});
