import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	BLOCKED_GRAMMARS,
	GRAMMAR_FILES,
	GRAMMAR_SOURCE_OVERRIDES,
	grammarBlockReason,
	type GrammarRuntime,
	grammarSourceUrl,
	LANGUAGE_TO_GRAMMAR,
	TREE_SITTER_WASMS_VERSION,
} from "../../clients/grammar-source.js";

// The postinstall pre-fetch (scripts/download-grammars.js) runs before the TS
// build, so it can't import the compiled grammar-source — it mirrors the version
// + grammar list. Read it as text (don't import: it would run main()/fetch) and
// guard against silent drift between the two.
const scriptSrc = readFileSync(
	path.resolve(
		path.dirname(fileURLToPath(import.meta.url)),
		"../../scripts/download-grammars.js",
	),
	"utf8",
);
const scriptVersion = scriptSrc.match(
	/TREE_SITTER_WASMS_VERSION\s*=\s*["']([0-9.]+)["']/,
)?.[1];
const scriptGrammars = [
	...new Set(
		[...scriptSrc.matchAll(/"(tree-sitter-[a-z0-9_]+\.wasm)"/g)].map((m) => m[1]),
	),
];

describe("grammar-source ↔ download-grammars stay in sync", () => {
	it("pins the same tree-sitter-wasms version", () => {
		expect(scriptVersion).toBe(TREE_SITTER_WASMS_VERSION);
	});

	it("downloads exactly the grammars the runtime maps", () => {
		expect(scriptGrammars.sort()).toEqual([...GRAMMAR_FILES].sort());
	});

	it("GRAMMAR_FILES is the deduped value set of LANGUAGE_TO_GRAMMAR", () => {
		expect([...GRAMMAR_FILES].sort()).toEqual(
			[...new Set(Object.values(LANGUAGE_TO_GRAMMAR))].sort(),
		);
	});

	it("mirrors the same source overrides in download-grammars.js", () => {
		for (const o of Object.values(GRAMMAR_SOURCE_OVERRIDES)) {
			// The mirror lists each override's url (which embeds package + version).
			expect(scriptSrc).toContain(o.url);
			expect(o.url).toContain(o.version);
		}
	});
});

describe("GRAMMAR_SOURCE_OVERRIDES (#255)", () => {
	it("routes lua to the @tree-sitter-grammars build, not the aggregator", () => {
		const o = GRAMMAR_SOURCE_OVERRIDES["tree-sitter-lua.wasm"];
		expect(o?.package).toBe("@tree-sitter-grammars/tree-sitter-lua");
		const url = grammarSourceUrl("tree-sitter-lua.wasm");
		expect(url).toBe(o?.url);
		expect(url).not.toContain("tree-sitter-wasms");
	});

	it("leaves non-overridden grammars on the aggregator CDN", () => {
		const url = grammarSourceUrl("tree-sitter-python.wasm");
		expect(url).toContain(`tree-sitter-wasms@${TREE_SITTER_WASMS_VERSION}`);
		expect(url).toContain("tree-sitter-python.wasm");
	});
});

describe("BLOCKED_GRAMMARS runtime guard (#432)", () => {
	const rt = (over: Partial<GrammarRuntime> = {}): GrammarRuntime => ({
		nodeMajor: 24,
		isV8: true,
		platform: "linux",
		...over,
	});

	afterEach(() => {
		delete process.env.PILENS_UNSAFE_FORCE_GRAMMAR_LOAD;
	});

	it("blocks swift on V8 + Node >= 24 (all platforms)", () => {
		for (const platform of ["linux", "darwin", "win32"] as const) {
			expect(
				grammarBlockReason("tree-sitter-swift.wasm", rt({ platform })),
			).toMatch(/crashes the runtime/);
		}
	});

	it("does NOT block swift on Node <= 22", () => {
		expect(
			grammarBlockReason("tree-sitter-swift.wasm", rt({ nodeMajor: 22 })),
		).toBeNull();
	});

	it("does NOT block swift under bun / non-V8 (JavaScriptCore)", () => {
		expect(
			grammarBlockReason("tree-sitter-swift.wasm", rt({ isV8: false })),
		).toBeNull();
	});

	it("does not block a normal grammar", () => {
		expect(grammarBlockReason("tree-sitter-typescript.wasm", rt())).toBeNull();
	});

	it("PILENS_UNSAFE_FORCE_GRAMMAR_LOAD bypasses the block (probe hatch)", () => {
		expect(grammarBlockReason("tree-sitter-swift.wasm", rt())).not.toBeNull();
		process.env.PILENS_UNSAFE_FORCE_GRAMMAR_LOAD = "1";
		expect(grammarBlockReason("tree-sitter-swift.wasm", rt())).toBeNull();
	});

	it("swift is the only currently-blocked grammar", () => {
		expect(Object.keys(BLOCKED_GRAMMARS)).toEqual(["tree-sitter-swift.wasm"]);
	});
});
