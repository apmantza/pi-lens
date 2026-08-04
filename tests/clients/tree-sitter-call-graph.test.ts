import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { buildCallGraph } from "../../clients/call-graph.js";
import { grammarBlockReason, LANGUAGE_TO_GRAMMAR } from "../../clients/grammar-source.js";
import { getSharedTreeSitterClient } from "../../clients/tree-sitter-shared.js";
import type { TreeSitterClient } from "../../clients/tree-sitter-client.js";
import { TreeSitterSymbolExtractor } from "../../clients/tree-sitter-symbol-extractor.js";
import type { Symbol, SymbolRef } from "../../clients/symbol-types.js";

const FIXTURE_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../fixtures/call-graph",
);

interface CallFixture {
	language: string;
	directory: string;
	caller: string;
	callee: string;
}

const CALL_FIXTURES: CallFixture[] = [
	{ language: "typescript", directory: "typescript", caller: "caller.ts", callee: "callee.ts" },
	{ language: "tsx", directory: "tsx", caller: "caller.tsx", callee: "callee.tsx" },
	{ language: "python", directory: "python", caller: "caller.py", callee: "callee.py" },
	{ language: "go", directory: "go", caller: "caller.go", callee: "callee.go" },
	{ language: "rust", directory: "rust", caller: "caller.rs", callee: "callee.rs" },
	{ language: "ruby", directory: "ruby", caller: "caller.rb", callee: "callee.rb" },
	{ language: "c", directory: "c", caller: "caller.c", callee: "callee.c" },
	{ language: "cpp", directory: "cpp", caller: "caller.cpp", callee: "callee.cpp" },
	{ language: "java", directory: "java-call", caller: "Caller.java", callee: "Callee.java" },
	{ language: "kotlin", directory: "kotlin-call", caller: "Caller.kt", callee: "Callee.kt" },
	{ language: "csharp", directory: "csharp", caller: "caller.cs", callee: "callee.cs" },
	{ language: "php", directory: "php", caller: "caller.php", callee: "callee.php" },
	{ language: "swift", directory: "swift", caller: "caller.swift", callee: "callee.swift" },
	{ language: "lua", directory: "lua", caller: "caller.lua", callee: "callee.lua" },
	{ language: "ocaml", directory: "ocaml", caller: "caller.ml", callee: "callee.ml" },
	{ language: "zig", directory: "zig", caller: "caller.zig", callee: "callee.zig" },
	{ language: "bash", directory: "bash", caller: "caller.sh", callee: "callee.sh" },
	{ language: "elixir", directory: "elixir", caller: "caller.ex", callee: "callee.ex" },
	{ language: "javascript", directory: "javascript", caller: "caller.js", callee: "callee.js" },
	{ language: "javascript", directory: "javascript", caller: "caller.jsx", callee: "callee.js" },
	{ language: "javascript", directory: "javascript", caller: "caller.mjs", callee: "callee.js" },
	{ language: "javascript", directory: "javascript", caller: "caller.cjs", callee: "callee.js" },
];

const TYPE_REFERENCE_FIXTURES: CallFixture[] = [
	{ language: "java", directory: "java", caller: "Caller.java", callee: "Callee.java" },
	{ language: "kotlin", directory: "kotlin", caller: "Caller.kt", callee: "Callee.kt" },
	// Dart's shipped refs query intentionally exposes type references only; keep
	// an actual fixture assertion so it is not mistaken for call coverage.
	{ language: "dart", directory: "dart", caller: "caller.dart", callee: "callee.dart" },
];

let client: TreeSitterClient;

beforeAll(async () => {
	client = getSharedTreeSitterClient()!;
	expect(await client.init()).toBe(true);
});

async function extractFixture(
	language: string,
	relativePath: string,
): Promise<{ filePath: string; symbols: Symbol[]; refs: SymbolRef[] }> {
	const filePath = path.join(FIXTURE_ROOT, relativePath);
	const source = fs.readFileSync(filePath, "utf8");
	const tree = await client.parseFile(filePath, language);
	expect(tree, `${language}:${relativePath} did not parse`).toBeTruthy();
	const extractor = new TreeSitterSymbolExtractor(language, client);
	expect(await extractor.init(), `${language} grammar did not initialize`).toBe(true);
	const extracted = extractor.extract(tree!, filePath, source);
	return { filePath, symbols: extracted.symbols, refs: extracted.refs };
}

async function buildFixtureGraph(fixture: CallFixture) {
	const caller = await extractFixture(
		fixture.language,
		path.join(fixture.directory, fixture.caller),
	);
	const callee = await extractFixture(
		fixture.language,
		path.join(fixture.directory, fixture.callee),
	);
	const graph = buildCallGraph(
		new Map([
			[caller.filePath, caller.symbols],
			[callee.filePath, callee.symbols],
		]),
		new Map([
			[caller.filePath, caller.refs],
			[callee.filePath, callee.refs],
		]),
	);
	return { caller, callee, graph };
}

describe("Tree-sitter call-graph fixtures", () => {
	for (const fixture of CALL_FIXTURES) {
		const blocked = Boolean(
			grammarBlockReason(LANGUAGE_TO_GRAMMAR[fixture.language]),
		);
		it.skipIf(blocked)(
			`resolves a call from ${fixture.language}:${fixture.caller} to ${fixture.callee}`,
			async () => {
				const { caller, graph } = await buildFixtureGraph(fixture);
				const callRef = caller.refs.find(
					(ref) => ref.symbolName === "helper" && ref.referenceKind === "call",
				);
				expect(callRef, `${fixture.language} fixture did not emit a call ref`).toBeDefined();
				expect(
					graph.edges.some(
						(edge) =>
							edge.callerFile === caller.filePath &&
							edge.calleeSymbol === "helper",
					),
				).toBe(true);
				expect(graph.coverage).toMatchObject({
					callsEvidence: expect.any(Number),
					resolvedEvidence: expect.any(Number),
				});
			},
		);
	}

	for (const fixture of TYPE_REFERENCE_FIXTURES) {
		const blocked = Boolean(
			grammarBlockReason(LANGUAGE_TO_GRAMMAR[fixture.language]),
		);
		it.skipIf(blocked)(
			`keeps type references out of calls for ${fixture.language}`,
			async () => {
				const { caller, graph } = await buildFixtureGraph(fixture);
				const typeRef = caller.refs.find(
					(ref) => ref.symbolName === "Callee" && ref.referenceKind === "type",
				);
				expect(typeRef, `${fixture.language} fixture did not emit a type ref`).toBeDefined();
				expect(graph.edges).toHaveLength(0);
				expect(graph.coverage?.typeOnlyEvidence).toBeGreaterThan(0);
			},
		);
	}
});
