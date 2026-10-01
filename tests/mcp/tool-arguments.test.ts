/**
 * Unknown MCP tool arguments are reported, not dropped (#3749).
 *
 * Recurrence this file guards: `pilens_diagnostics {"filePath": ...}` (the
 * schema says `path`) ran on defaults and answered `No issues in the current
 * turn delta.` -- a false clean an agent reads as a clean file. The wire
 * behavior is pinned in tests/mcp/server.smoke.test.ts ("unknown arguments");
 * this file pins the decision table the dispatcher's one check applies.
 */

import { describe, expect, it } from "vitest";
import {
	findIgnoredArguments,
	ignoredArgumentsLine,
	ignoredArgumentsStructured,
	MAX_REPORTED_KEY_CHARS,
	MAX_REPORTED_KEYS,
	refusalMatches,
	refusalResult,
	withIgnoredArguments,
} from "../../mcp/tool-arguments.js";

const ANALYZE = {
	properties: { file: {}, cwd: {}, mode: {}, flags: {} },
	required: ["file"],
};
const DIAGNOSTICS = {
	properties: { source: {}, scope: {}, mode: {}, path: {}, paths: {}, cwd: {} },
};

describe("findIgnoredArguments", () => {
	it("leaves a call untouched when every key is declared", () => {
		expect(
			findIgnoredArguments(ANALYZE, { file: "a.ts", mode: "warm" }),
		).toBeUndefined();
		expect(findIgnoredArguments(ANALYZE, {})).toBeUndefined();
	});

	it("names the ignored key and the declared key it most likely meant", () => {
		expect(findIgnoredArguments(ANALYZE, { filePath: "a.ts" })).toEqual({
			ignored: [{ key: "filePath", suggestion: "file" }],
			missingRequired: ["file"],
			// `file` leads `filePath`; it is not its head noun, so the call is refused
			// by the required key alone, never by the refusal predicate.
			unsentSuggestions: [],
		});
		expect(
			findIgnoredArguments(DIAGNOSTICS, { filePath: "a.ts" })?.ignored,
		).toEqual([{ key: "filePath", suggestion: "path" }]);
		expect(findIgnoredArguments(DIAGNOSTICS, { pth: "a.ts" })?.ignored).toEqual(
			[{ key: "pth", suggestion: "path" }],
		);
		expect(findIgnoredArguments(ANALYZE, { FILE: "a.ts" })?.ignored).toEqual([
			{ key: "FILE", suggestion: "file" },
		]);
		// Several candidates: the closest in length wins, a tie keeps the first.
		expect(
			findIgnoredArguments(
				{ properties: { pathway: {}, pathwaya: {} } },
				{ pathwayx: 1 },
			)?.ignored,
		).toEqual([{ key: "pathwayx", suggestion: "pathwaya" }]);
		expect(
			findIgnoredArguments({ properties: { abce: {}, abcf: {} } }, { abcd: 1 })
				?.ignored,
		).toEqual([{ key: "abcd", suggestion: "abce" }]);
		expect(
			findIgnoredArguments({ properties: { abcf: {}, abce: {} } }, { abcd: 1 })
				?.ignored,
		).toEqual([{ key: "abcd", suggestion: "abcf" }]);
		// One character dropped, added or replaced; two edits is not a typo.
		expect(
			findIgnoredArguments(ANALYZE, { modee: 1 })?.ignored, // spellchecker:disable-line
		).toEqual([
			{ key: "modee", suggestion: "mode" }, // spellchecker:disable-line
		]);
		expect(
			findIgnoredArguments(DIAGNOSTICS, { sourse: 1 })?.ignored, // spellchecker:disable-line
		).toEqual([
			{ key: "sourse", suggestion: "source" }, // spellchecker:disable-line
		]);
		expect(findIgnoredArguments(ANALYZE, { moed: 1 })?.ignored).toEqual([
			{ key: "moed" },
		]);
	});

	it("suggests nothing for a key that is near nothing", () => {
		expect(findIgnoredArguments(ANALYZE, { zzzzzz: 1 })?.ignored).toEqual([
			{ key: "zzzzzz" },
		]);
		// A one-letter key sits inside `flags` but is not a hint for it.
		expect(findIgnoredArguments(ANALYZE, { a: 1 })?.ignored).toEqual([
			{ key: "a" },
		]);
	});

	it("reports a required key as missing only when a key was ignored", () => {
		// The key IS sent next to a stray one: the tool runs, nothing is missing.
		expect(
			findIgnoredArguments(ANALYZE, { file: "a.ts", bogus: 1 })
				?.missingRequired,
		).toEqual([]);
		// No stray key: the gate has nothing to say; the tool's own message stands.
		expect(findIgnoredArguments(ANALYZE, { mode: "warm" })).toBeUndefined();
	});

	it("does not treat Object.prototype names as declared keys", () => {
		const args = JSON.parse('{"constructor":1,"toString":2,"__proto__":3}');
		expect(
			findIgnoredArguments(ANALYZE, args)?.ignored.map((entry) => entry.key),
		).toEqual(["constructor", "toString", "__proto__"]);
	});

	it("treats a schema with no properties as declaring nothing", () => {
		expect(
			findIgnoredArguments({ properties: {} }, { cwd: "/x" })?.ignored,
		).toEqual([{ key: "cwd" }]);
		expect(findIgnoredArguments({}, { cwd: "/x" })?.ignored).toHaveLength(1);
	});
});

describe("ignored-argument rendering", () => {
	const many = Object.fromEntries(
		Array.from({ length: MAX_REPORTED_KEYS + 4 }, (_, index) => [
			`stray${index}`,
			index,
		]),
	);

	it("renders a leading line naming the keys and the suggestion", () => {
		const report = findIgnoredArguments(DIAGNOSTICS, { filePath: "a.ts" });
		expect(report && ignoredArgumentsLine("pilens_diagnostics", report)).toBe(
			"Ignored unknown argument(s) for pilens_diagnostics: `filePath` (did you mean `path`?). They had no effect on this call.",
		);
	});

	it("bounds the keys named in the line and the structured list, keeping the exact count", () => {
		const report = findIgnoredArguments(ANALYZE, many);
		if (!report) throw new Error("expected a report");
		expect(ignoredArgumentsLine("t", report)).toContain("and 4 more.");
		expect(ignoredArgumentsStructured(report)).toEqual({
			ignoredArguments: Array.from(
				{ length: MAX_REPORTED_KEYS },
				(_, index) => `stray${index}`,
			),
			ignoredArgumentCount: MAX_REPORTED_KEYS + 4,
		});
	});

	it("cuts an oversized key so one key cannot make an unbounded line", () => {
		const huge = "k".repeat(10_000);
		const report = findIgnoredArguments(ANALYZE, { [huge]: 1 });
		if (!report) throw new Error("expected a report");
		const structured = ignoredArgumentsStructured(report);
		expect(structured.ignoredArguments[0]).toBe(
			`${"k".repeat(MAX_REPORTED_KEY_CHARS)}…`,
		);
		expect(ignoredArgumentsLine("t", report).length).toBeLessThan(300);
	});
});

describe("withIgnoredArguments", () => {
	const report = findIgnoredArguments(DIAGNOSTICS, { filePath: "a.ts" });
	if (!report) throw new Error("expected a report");

	it("puts the warning first in the first text block and attaches the structured payload", () => {
		const original = {
			content: [
				{ type: "text" as const, text: "No issues" },
				{ type: "text" as const, text: "second" },
			],
			isError: false,
		};
		const result = withIgnoredArguments(original, "pilens_diagnostics", report);
		expect(result.content[0].text).toBe(
			`${ignoredArgumentsLine("pilens_diagnostics", report)}\n\nNo issues`,
		);
		expect(result.content[1]).toEqual({ type: "text", text: "second" });
		expect(result.isError).toBe(false);
		expect(result.structuredContent).toEqual({
			ignoredArguments: ["filePath"],
			ignoredArgumentCount: 1,
		});
		// The tool's own result object is not mutated.
		expect(original.content[0].text).toBe("No issues");
	});

	it("still reports when the tool returned no text block", () => {
		const result = withIgnoredArguments({ content: [] }, "t", report);
		expect(result.content).toEqual([
			{ type: "text", text: ignoredArgumentsLine("t", report) },
		]);
	});
});

describe("refusalResult", () => {
	const reportFor = (
		schema: Parameters<typeof findIgnoredArguments>[0],
		args: Record<string, unknown>,
	) => {
		const report = findIgnoredArguments(schema, args);
		if (!report) throw new Error("expected a report");
		return report;
	};

	it("is an error naming every missing required key when an ignored key left one missing", () => {
		const report = reportFor(
			{ properties: { file: {}, symbol: {} }, required: ["file", "symbol"] },
			{ filePath: "a.ts" },
		);
		const result = refusalResult("pilens_read_symbol", report);
		expect(result?.isError).toBe(true);
		expect(result?.content[0].text).toBe(
			`${ignoredArgumentsLine("pilens_read_symbol", report)}\nNot run: required argument(s) \`file\`, \`symbol\` missing.`,
		);
		expect(result?.structuredContent.ignoredArguments).toEqual(["filePath"]);
	});

	it("is an error when the ignored key's near match is a declared key the call did not send", () => {
		const report = reportFor(DIAGNOSTICS, { filePath: "a.ts" });
		expect(report.unsentSuggestions).toEqual([
			{ key: "filePath", suggestion: "path" },
		]);
		const result = refusalResult("pilens_diagnostics", report);
		expect(result?.isError).toBe(true);
		expect(result?.content[0].text).toBe(
			`${ignoredArgumentsLine("pilens_diagnostics", report)}\nNot run: \`filePath\` looks like a mistyped \`path\`, which was not sent.`,
		);
	});

	it("names both reasons when a required key and a different spelled-out key are unsent", () => {
		const report = reportFor(
			{ properties: { file: {}, path: {} }, required: ["file"] },
			{ Path: 1 },
		);
		expect(refusalResult("t", report)?.content[0].text).toContain(
			"\nNot run: required argument(s) `file` missing; `Path` looks like a mistyped `path`, which was not sent.",
		);
	});

	it("names a required key once when it is also the spelled-out match", () => {
		const report = reportFor(
			{ properties: { path: {} }, required: ["path"] },
			{ filePath: 1 },
		);
		expect(refusalResult("t", report)?.content[0].text).toContain(
			"\nNot run: required argument(s) `path` missing.",
		);
	});

	it("lists an unsent suggestion once however many ignored keys point at it", () => {
		const report = reportFor(DIAGNOSTICS, { filePath: 1, dir_path: 2 });
		expect(report.unsentSuggestions).toEqual([
			{ key: "filePath", suggestion: "path" },
		]);
	});

	it("is undefined when the near match was also sent", () => {
		const report = reportFor(DIAGNOSTICS, { filePath: "a.ts", path: "a.ts" });
		expect(report.unsentSuggestions).toEqual([]);
		expect(refusalResult("pilens_diagnostics", report)).toBeUndefined();
	});

	it("is undefined when nothing required is missing and the key has no near match", () => {
		expect(
			refusalResult(
				"pilens_analyze",
				reportFor(ANALYZE, { file: "a.ts", bogus: 1 }),
			),
		).toBeUndefined();
		expect(
			refusalResult(
				"pilens_diagnostics",
				reportFor(DIAGNOSTICS, { zzzzzz: 1 }),
			),
		).toBeUndefined();
	});
});

// Recurrence (#3749 review F1): the refusal gate reused the loose hint scorer and
// refused calls on WRONG matches (`files` -> `maxLspFiles`, `filePath` ->
// `newFilePath` on lsp_navigation), a call master ran. The gate is this
// predicate alone; the live-schema table is in tests/mcp/server.smoke.test.ts.
describe("refusalMatches", () => {
	it("matches a declared key written another way: case, punctuation, plural, head noun", () => {
		const rows: [string, string[], string[]][] = [
			["filePath", ["path"], ["path"]],
			["file_path", ["path"], ["path"]],
			["file-path", ["path"], ["path"]],
			["Path", ["path"], ["path"]],
			["PATH", ["path"], ["path"]],
			["paths", ["path"], ["path"]],
			["path", ["paths"], ["paths"]],
			["kind", ["kinds"], ["kinds"]],
			["Server_Scope", ["scope", "serverScope"], ["serverScope"]],
			["MaxLspFiles", ["maxLspFiles"], ["maxLspFiles"]],
			["dirPath", ["file", "path"], ["path"]],
		];
		for (const [key, declared, expected] of rows)
			expect(refusalMatches(key, declared), key).toEqual(expected);
	});

	it("never matches a typo, an abbreviation, a substring, a leading word or the reverse containment", () => {
		const rows: [string, string[]][] = [
			["files", ["maxLspFiles", "path"]],
			["file", ["path", "newFilePath"]],
			["pathName", ["path"]],
			["sourcePath", ["source"]],
			["modee", ["mode"]], // spellchecker:disable-line
			["pth", ["path"]],
			["max", ["maxLspFiles"]],
			["symbol", ["maxRefsPerSymbol"]],
			["newPath", ["newFilePath"]],
			["name", ["newName"]],
			["file", ["groupByFile"]],
			["filePath", ["newFilePath"]],
			["__", ["_"]],
		];
		for (const [key, declared] of rows)
			expect(refusalMatches(key, declared), key).toEqual([]);
	});
});

describe("refusal versus hint", () => {
	it("keeps the hint and runs when the loose scorer finds a key the predicate does not", () => {
		const report = findIgnoredArguments(
			{ properties: { maxLspFiles: {}, path: {} } },
			{ files: 1 },
		);
		expect(report?.ignored).toEqual([
			{ key: "files", suggestion: "maxLspFiles" },
		]);
		expect(report?.unsentSuggestions).toEqual([]);
	});

	it("points the hint at the refusal match, so the line and the refusal agree", () => {
		const report = findIgnoredArguments(
			{ properties: { newFilePath: {}, path: {} } },
			{ filePath: 1 },
		);
		expect(report?.ignored).toEqual([{ key: "filePath", suggestion: "path" }]);
	});

	it("does not refuse when any spelling of the parameter was sent", () => {
		const report = findIgnoredArguments(
			{ properties: { path: {}, paths: {} } },
			{ filePath: 1, paths: ["a"] },
		);
		expect(report?.unsentSuggestions).toEqual([]);
	});
});
