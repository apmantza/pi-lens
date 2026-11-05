/**
 * Groovy grammar smoke and symbol-query gates (#5235 slice 3).
 *
 * dekobon/tree-sitter-groovy v0.3.0 is BUILT BY US and committed to
 * `vendor/grammars/` unpatched, because no publisher ships a wasm for it. It
 * parses 70% of a 1,353-file real corpus with no ERROR node, so these tests
 * pin three things: the vendored artifact is registered and shipped, the
 * committed grammar-health fixture parses clean, and the symbol queries
 * compile against it (a query that fails to compile silently turns the whole
 * language's outline off, the #251 shape).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	downloadGrammarDetailed,
	isVendoredGrammar,
	LANGUAGE_TO_GRAMMAR,
	VENDORED_GRAMMARS,
	vendoredGrammarsDir,
} from "../../clients/grammar-source.js";
import type { TreeSitterClient } from "../../clients/tree-sitter-client.js";
import { getSharedTreeSitterClient } from "../../clients/tree-sitter-shared.js";
import { TreeSitterSymbolExtractor } from "../../clients/tree-sitter-symbol-extractor.js";

interface Node {
	type: string;
	isMissing?: boolean;
	children?: Node[];
}

function countBadNodes(root: Node): { errors: number; missing: number } {
	let errors = 0;
	let missing = 0;
	const stack: Node[] = [root];
	while (stack.length > 0) {
		const node = stack.pop();
		if (!node) continue;
		if (node.type === "ERROR") errors++;
		if (node.isMissing) missing++;
		for (const child of node.children ?? []) stack.push(child);
	}
	return { errors, missing };
}

const GROOVY_GRAMMAR = "tree-sitter-groovy.wasm";
const FIXTURE = path.resolve(
	import.meta.dirname,
	"../fixtures/grammar-health/groovy.groovy",
);

// An unclosed class body, the shape every editor produces mid-edit.
const BROKEN_GROOVY = `class Broken {
    void run() {
        println 'x'
`;

// The four gap families docs/language-coverage.md lists for this grammar. Each
// must still carry an ERROR or MISSING node on the vendored wasm.
const DOCUMENTED_GAPS: Record<string, string> = {
	"nested class": "class A {\n    static class B {}\n}\n",
	"nested interface": "class A {\n    interface I {}\n}\n",
	"command call with named args": 'mail to: "a", subject: "s"\n',
	"annotated underscore": "@Library('x') _\n",
	"untyped field with modifiers only": "class A {\n    static x = { 1 }\n}\n",
	diamond: "def m = new HashMap<>()\n",
};

let client: TreeSitterClient;
beforeAll(async () => {
	client = getSharedTreeSitterClient() as TreeSitterClient;
	await client.init();
});

describe("Groovy grammar smoke (#5235)", () => {
	it("registers groovy against the committed wasm, with the CLI pinned", () => {
		expect(LANGUAGE_TO_GRAMMAR.groovy).toBe(GROOVY_GRAMMAR);
		expect(isVendoredGrammar(GROOVY_GRAMMAR)).toBe(true);
		const source = VENDORED_GRAMMARS[GROOVY_GRAMMAR];
		expect(source?.commit).toBe("654e4c2d736571dbc512043a1dc26017c7aedc85");
		// Recurrence: the CUE entry's unpinned `npx tree-sitter-cli` builds with
		// whatever CLI npm serves that day, so the recipe is not reproducible.
		expect(source?.buildCommand).toMatch(/tree-sitter-cli@\d+\.\d+\.\d+ /);
	});

	it("ships the committed wasm where the resolver looks for it", () => {
		const wasm = path.join(vendoredGrammarsDir(), GROOVY_GRAMMAR);
		expect(fs.existsSync(wasm)).toBe(true);
		// A wasm preamble, not an HTML error page (#1548's poisoning shape).
		expect([...fs.readFileSync(wasm).subarray(0, 4)]).toEqual([
			0x00, 0x61, 0x73, 0x6d,
		]);
	});

	it("parses the grammar-health fixture with no ERROR or MISSING nodes", async () => {
		const source = fs.readFileSync(FIXTURE, "utf8");
		const tree = await client.parseFile(FIXTURE, "groovy", source);
		expect(tree).toBeTruthy();
		expect(tree?.rootNode.type).toBe("source_file");
		expect(countBadNodes(tree?.rootNode as unknown as Node)).toEqual({
			errors: 0,
			missing: 0,
		});
	});

	it("degrades an unclosed class to an ERROR node without crashing", async () => {
		const tree = await client.parseFile(
			"Broken.groovy",
			"groovy",
			BROKEN_GROOVY,
		);
		expect(tree).toBeTruthy();
		const bad = countBadNodes(tree?.rootNode as unknown as Node);
		expect(bad.errors + bad.missing).toBeGreaterThan(0);
		// The #255 failure shape: a broken parse poisoning every LATER parse on
		// the shared WASM module. A fresh path misses the tree cache that the
		// smoke test above filled for FIXTURE, and `parserInvocations` proves
		// this parse ran the parser instead of replaying a cached tree (PR #5317
		// review).
		const before = client.getParseCacheStats().parserInvocations;
		const after = await client.parseFile(
			"Recovered.groovy",
			"groovy",
			fs.readFileSync(FIXTURE, "utf8"),
		);
		expect(client.getParseCacheStats().parserInvocations).toBeGreaterThan(
			before,
		);
		expect(countBadNodes(after?.rootNode as unknown as Node)).toEqual({
			errors: 0,
			missing: 0,
		});
	});

	// Recurrence: docs/language-coverage.md and docs/features.md list these
	// gaps by name. A re-vendor that fixes one leaves a documented limit that
	// no longer exists; this reds so the docs change in the same PR.
	for (const [name, source] of Object.entries(DOCUMENTED_GAPS)) {
		it(`still fails to parse the documented gap: ${name}`, async () => {
			const tree = await client.parseFile("Gap.groovy", "groovy", source);
			expect(tree).toBeTruthy();
			const bad = countBadNodes(tree?.rootNode as unknown as Node);
			expect(bad.errors + bad.missing).toBeGreaterThan(0);
		});
	}
});

describe("Groovy vendored wasm is never downloaded (#5235)", () => {
	let tmpDir: string;
	beforeAll(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-vendored-gv-"));
	});
	afterAll(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	// Recurrence: a retryable verdict would put a fetch that can never succeed
	// (no CDN carries this wasm) on #1536's cooldown ladder forever.
	it("refuses with a non-retryable verdict", async () => {
		const result = await downloadGrammarDetailed(tmpDir, GROOVY_GRAMMAR);
		expect(result.ok).toBe(false);
		expect(result.retryable).toBe(false);
		// The vendored refusal names where the file ships; an unknown-grammar
		// refusal does not.
		expect(result.reason).toContain("vendor/grammars");
		expect(fs.existsSync(path.join(tmpDir, GROOVY_GRAMMAR))).toBe(false);
	});
});

describe("Groovy symbol queries (#5235)", () => {
	async function extract(src: string, file = "A.groovy") {
		const tree = await client.parseFile(file, "groovy", src);
		expect(tree).toBeTruthy();
		const extractor = new TreeSitterSymbolExtractor("groovy", client);
		expect(await extractor.init()).toBe(true);
		return extractor.extract(tree, file, src);
	}

	const SRC = [
		"import a.b.C",
		"",
		"class Spec {",
		"    def handler = { x -> x }",
		"    Spec(String n) { }",
		'    def "adds two numbers"() { expect: 1 }',
		"    def run() {",
		"        def local = { y -> y }",
		"        local(1)",
		"    }",
		"}",
		"trait T { void t() { } }",
		"interface I { void i() }",
		"enum E { ONE }",
		"def top = { z -> z }",
		"",
	].join("\n");

	// Recurrence: #251, a defs query that fails to compile against a grammar
	// turned the language's outline off with no error; the closure patterns are
	// the new, restricted ones (a field or top-level script variable only).
	it("compiles every defs, refs and imports pattern against the vendored wasm", async () => {
		const out = await extract(SRC);
		expect(out.coverage).toEqual({
			definitions: "complete",
			references: "complete",
			imports: "complete",
		});
		expect(out.symbols.length).toBeGreaterThan(0);
	});

	it("lists classes, traits, interfaces, enums, constructors and methods", async () => {
		const { symbols } = await extract(SRC);
		const byName = new Map(symbols.map((s) => [s.name, s.kind]));
		expect(symbols.find((s) => s.name === "Spec")?.kind).toBe("class");
		expect(byName.get("T")).toBe("class");
		expect(byName.get("E")).toBe("class");
		expect(byName.get("I")).toBe("interface");
		expect(byName.get("t")).toBe("method");
		expect(byName.get("run")).toBe("method");
		// A constructor reports as a function, as it does for Java.
		expect(
			symbols.some((s) => s.kind === "function" && s.name === "Spec"),
		).toBe(true);
		// A Spock feature name keeps its quotes.
		expect(byName.get('"adds two numbers"')).toBe("method");
	});

	// Recurrence: a method-local `def c = {}` is also a
	// local_variable_declaration; an unrestricted closure pattern lists every
	// local closure of every method as module structure.
	it("lists a closure held by a field or a top-level variable, not a method-local one", async () => {
		const { symbols } = await extract(SRC);
		const closures = symbols
			.filter((s) => s.kind === "function" && s.name !== "Spec")
			.map((s) => s.name)
			.sort();
		expect(closures).toEqual(["handler", "top"]);
		expect(symbols.some((s) => s.name === "local")).toBe(false);
	});

	it("emits call, constructor-call and type refs, and imports", async () => {
		const src = [
			"import static java.lang.Math.max",
			"import a.b.*",
			"class K {",
			"    Map<String, Date> m = new HashMap<String, Date>()",
			"    def go() { helper(1); other.run(2); new Date() }",
			"}",
			"",
		].join("\n");
		const out = await extract(src);
		const refs = out.refs.map((r) => `${r.referenceKind}:${r.symbolName}`);
		expect(refs).toEqual(
			expect.arrayContaining([
				"call:helper",
				"call:run",
				"type:Date",
				// `new Date()` (type_identifier) and `new HashMap<..>()` (generic_type)
				// are separate constructor-reference patterns; each is asserted so
				// neither can be dropped unseen (PR #5317 review).
				"call:Date",
				"call:HashMap",
			]),
		);
		expect(out.imports.map((i) => i.source)).toEqual([
			"java.lang.Math.max",
			"a.b",
		]);
	});
});
