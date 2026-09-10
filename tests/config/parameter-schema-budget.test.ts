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
		total: 1629,
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
		total: 1612,
		maximum: 2594,
		keys: [
			"source",
			"scope",
			"mode",
			"path",
			"concurrency",
			"waitMs",
			"serverScope",
			"refreshRunners",
			"maxProjectFiles",
			"maxLspFiles",
			"includeGenerated",
			"severity",
			"paths",
		],
	},
	lsp_navigation: {
		total: 2145,
		maximum: 2593,
		keys: [
			"operation",
			"path",
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
		expect(bytes(schema), `${name} exact byte count`).toBe(
			expected[name].total,
		);
		expect(
			bytes(schema),
			`${name} must remain at least 25% smaller`,
		).toBeLessThanOrEqual(expected[name].maximum);
	});
});
