import { readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
	downloadGrammar,
	GRAMMAR_FILES,
	LANGUAGE_TO_GRAMMAR,
	TREE_SITTER_WASMS_VERSION,
	VENDORED_GRAMMARS,
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
});

describe("VENDORED grammars are never lazy-fetched (#423)", () => {
	it("lists the crashing prebuilt swift grammar", () => {
		expect(VENDORED_GRAMMARS.has("tree-sitter-swift.wasm")).toBe(true);
	});

	it("downloadGrammar refuses a vendored grammar without fetching the CDN copy", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const ok = await downloadGrammar(os.tmpdir(), "tree-sitter-swift.wasm");
		expect(ok).toBe(false); // degrade — never overwrite the committed wasm
		expect(fetchSpy).not.toHaveBeenCalled();
		fetchSpy.mockRestore();
	});
});
