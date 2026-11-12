import { describe, expect, it } from "vitest";
import { createAstGrepSearchTool } from "../../tools/ast-grep-search.js";
import { createLensDiagnosticsTool } from "../../tools/lens-diagnostics.js";
import { createLspNavigationTool } from "../../tools/lsp-navigation.js";

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const astClient = {
	ensureAvailable: async () => true,
	search: async () => ({ matches: [] }),
	searchWithRule: async () => ({ matches: [] }),
	validatePattern: async () => ({ valid: true }),
	validateRule: async () => ({ valid: true }),
	formatMatches: () => "",
} as any;

const expected = {
	ast_grep_search: {
		// 1473 -> 1590 (#5371): the `paths` entry carries the shared glob clause
		// (`PATHS_GLOB_CLAUSE`, tools/shared.ts) so the parameter stops advertising
		// a meaning the tool did not have.
		total: 1590,
		maximum: 2995,
		keys: [
			"dump",
			"pattern",
			"lang",
			"paths",
			"selector",
			"context",
			"nodeKind",
			"insideKind",
			"hasKind",
			"hasDescendantKind",
			"follows",
			"precedes",
			"rule",
			"skip",
			"maxMatches",
			"groupByFile",
			"strictness",
			"validateOnly",
		],
	},
	lens_diagnostics: {
		// 1964 -> 2086 (#5041): `file` and `filePath` are declared aliases of
		// `path` on this tool, because the MCP mirror shares this schema.
		// 2086 -> 2203 (#5371): the `paths` entry carries the shared glob clause.
		total: 2203,
		maximum: 2594,
		keys: [
			"source",
			"scope",
			"mode",
			"path",
			"file",
			"filePath",
			"concurrency",
			"waitMs",
			"serverScope",
			"refreshRunners",
			"maxProjectFiles",
			"maxLspFiles",
			"includeGenerated",
			"analysisRoot",
			"severity",
			"paths",
		],
	},
	lsp_navigation: {
		// 1729 -> 1851 (#5041): `file` and `filePath` are declared aliases of
		// `path`, for the same shared-schema reason.
		// 1851 -> 2205 (#1449, #5506): `view` adds the JSON hatch to the text
		// default, and strict providers need typed items for command arguments.
		total: 2205,
		maximum: 2593,
		keys: [
			"operation",
			"path",
			"file",
			"filePath",
			"line",
			"character",
			"symbol",
			"endLine",
			"endCharacter",
			"newName",
			"newFilePath",
			"apply",
			"command",
			"commandArguments",
			"query",
			"kinds",
			"exactMatch",
			"topLevelOnly",
			"maxResults",
			"callHierarchyItem",
			"view",
		],
	},
} as const;

describe("trimmed parameter schema byte pins (#2800 item 13)", () => {
	it.each([
		["ast_grep_search", () => createAstGrepSearchTool(astClient).parameters],
		[
			"lens_diagnostics",
			() => createLensDiagnosticsTool({} as any, () => "").parameters,
		],
		[
			"lsp_navigation",
			() => createLspNavigationTool(() => undefined).parameters,
		],
	] as const)("pins %s below its trim floor", (name, getSchema) => {
		const schema = getSchema();
		expect(Object.keys((schema as any).properties)).toEqual(
			expected[name].keys,
		);
		expect(
			bytes(schema),
			`${name} must remain at least 25% smaller`,
		).toBeLessThanOrEqual(expected[name].maximum);
		expect(bytes(schema), `${name} exact byte count`).toBe(
			expected[name].total,
		);
	});
});
