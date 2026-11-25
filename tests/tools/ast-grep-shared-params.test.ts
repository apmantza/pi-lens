import { describe, expect, it } from "vitest";
import { createAstGrepReplaceTool } from "../../tools/ast-grep-replace.js";
import { createAstGrepSearchTool } from "../../tools/ast-grep-search.js";

// Recurrence this prevents: `ast_grep_search` and `ast_grep_replace` each
// carried an inline copy of the language, strictness and five relational
// filter parameters (jscpd clone, 28 lines). They now come from
// `astGrepSharedParams` (tools/shared.ts). A word changed in one tool but not
// the other, or a tool dropping a shared parameter or moving it, is what these
// cells catch. The literals are the model-facing text, copied from the
// pre-fold schemas, not read back from the seam.

const client = { ensureAvailable: async () => true } as never;

const SHARED = {
	lang: {
		type: "string",
		description: "Language id, e.g. typescript, tsx, python, go.",
	},
	strictness: {
		type: "string",
		enum: ["smart", "relaxed", "ast", "cst", "signature", "template"],
		description: "Match strictness; default smart.",
	},
	insideKind: { type: "string", description: "Ancestor AST node kind filter." },
	hasKind: {
		type: "string",
		description: "Immediate child AST node kind filter.",
	},
	hasDescendantKind: {
		type: "string",
		description: "Recursive descendant AST node kind filter.",
	},
	follows: { type: "string", description: "Preceding sibling pattern filter." },
	precedes: {
		type: "string",
		description: "Following sibling pattern filter.",
	},
} as const;

const TOOLS = {
	ast_grep_search: {
		make: () => createAstGrepSearchTool(client),
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
	ast_grep_replace: {
		make: () => createAstGrepReplaceTool(client),
		keys: [
			"pattern",
			"rewrite",
			"lang",
			"paths",
			"insideKind",
			"hasKind",
			"hasDescendantKind",
			"follows",
			"precedes",
			"apply",
			"strictness",
		],
	},
} as const;

type Spec = (typeof TOOLS)[keyof typeof TOOLS];

function expectSharedWords(spec: Spec) {
	const properties = spec.make().parameters.properties as Record<
		string,
		unknown
	>;
	for (const [key, expected] of Object.entries(SHARED)) {
		expect(JSON.parse(JSON.stringify(properties[key])), key).toEqual(expected);
	}
}

function expectOrderAndRequired(spec: Spec) {
	const parameters = spec.make().parameters;
	expect(Object.keys(parameters.properties)).toEqual([...spec.keys]);
	// `lang` is required (a bare Type.String), every filter is optional.
	expect(parameters.required).toContain("lang");
	for (const key of Object.keys(SHARED).filter((k) => k !== "lang")) {
		expect(parameters.required, key).not.toContain(key);
	}
}

describe("ast-grep tools share one declaration of their common parameters", () => {
	it("ast_grep_search advertises the shared parameters with the shared words", () => {
		expectSharedWords(TOOLS.ast_grep_search);
	});

	it("ast_grep_replace advertises the shared parameters with the shared words", () => {
		expectSharedWords(TOOLS.ast_grep_replace);
	});

	it("ast_grep_search keeps its parameter order and requires only what it did", () => {
		expectOrderAndRequired(TOOLS.ast_grep_search);
	});

	it("ast_grep_replace keeps its parameter order and requires only what it did", () => {
		expectOrderAndRequired(TOOLS.ast_grep_replace);
	});

	it("gives each tool its own parameter objects, so editing one schema leaves the other", () => {
		const search = createAstGrepSearchTool(client).parameters
			.properties as Record<string, object>;
		const replace = createAstGrepReplaceTool(client).parameters
			.properties as Record<string, object>;
		for (const key of Object.keys(SHARED)) {
			expect(search[key], key).not.toBe(replace[key]);
		}
		const again = createAstGrepSearchTool(client).parameters
			.properties as Record<string, object>;
		expect(again.hasKind).not.toBe(search.hasKind);
	});
});
