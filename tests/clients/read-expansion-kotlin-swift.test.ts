/**
 * Read-expansion symbol names for Kotlin and Swift (#5320), plus the Java
 * control that keeps the fix from widening `type_identifier` globally.
 *
 * `getSymbolName` in `clients/read-expansion.ts` returned the node type
 * whenever no direct child matched its name allowlist, so a Kotlin or Swift
 * read note called every function `function_declaration` and named the class
 * ancestry `class_declaration`. #5317 fixed one member of this shape for Groovy
 * (`quoted_identifier`, see groovy-structural-consumers.test.ts); Kotlin and
 * Swift are the other members: their function name is a `simple_identifier`
 * child and their class name is a `type_identifier` child.
 *
 * Own file on purpose (the #255 multi-grammar wall): the Kotlin and Swift
 * grammars are heavy, so this worker loads only these two plus Java. Swift is
 * blocked from loading on Node >= 24 (it aborts the runtime, #432), so the
 * Swift slices skip there; the Kotlin and Java slices cover the same seam.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { grammarBlockReason } from "../../clients/grammar-source.js";
import { tryExpandRead } from "../../clients/read-expansion.js";
import type { TreeSitterClient } from "../../clients/tree-sitter-client.js";
import { getSharedTreeSitterClient } from "../../clients/tree-sitter-shared.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

// Swift never loads on Node >= 24 (#432), so tryExpandRead degrades to
// undefined there and the Swift slices cannot assert a name. lane: CI and the
// dev box both run Node 22 (`.github/workflows/ci.yml` node-version 22).
const swiftBlocked = Boolean(grammarBlockReason("tree-sitter-swift.wasm"));

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length) cleanups.pop()?.();
});
function makeEnv() {
	const env = setupTestEnvironment("pi-lens-readexp-ks-");
	cleanups.push(env.cleanup);
	return env;
}

let client: TreeSitterClient;
beforeAll(async () => {
	client = getSharedTreeSitterClient() as TreeSitterClient;
	await client.init();
});

// Line numbers below are 1-based, matching the read tool's `offset`.
const KOTLIN = [
	"package com.example",
	"",
	"class Greeter(private val prefix: String) {",
	'    val tag = "greeter"',
	"",
	"    fun greet(name: String): String {",
	"        val line = prefix + name",
	"        return line",
	"    }",
	"}",
	"",
	"fun shout(text: String): String {",
	"    return text.uppercase()",
	"}",
	"",
].join("\n");

const SWIFT = [
	"import Foundation",
	"",
	"class Greeter {",
	'    let tag = "greeter"',
	"",
	"    func greet(name: String) -> String {",
	"        let line = tag + name",
	"        return line",
	"    }",
	"}",
	"",
	"func shout(text: String) -> String {",
	"    return text.uppercased()",
	"}",
	"",
].join("\n");

const JAVA = [
	"package com.example;",
	"",
	"public class Greeter {",
	"    private final String prefix;",
	"",
	"    public Greeter(String prefix) {",
	"        this.prefix = prefix;",
	"    }",
	"",
	"    public String greet(String name) {",
	"        return prefix + name;",
	"    }",
	"}",
	"",
].join("\n");

async function expand(file: string, source: string, offset: number) {
	const env = makeEnv();
	const path = createTempFile(env.tmpDir, file, source);
	const expanded = await tryExpandRead(
		path,
		offset,
		1,
		source.split("\n").length,
		client,
	);
	expect(expanded).toBeDefined();
	return expanded!;
}

describe("read expansion names Kotlin symbols (#5320)", () => {
	it("names a Kotlin method by its name, not function_declaration", async () => {
		// Line 8 is `return line`, inside `greet` (lines 6-9).
		const expanded = await expand("Greeter.kt", KOTLIN, 8);
		expect(expanded.enclosingSymbol.kind).toBe("function_declaration");
		expect(expanded.enclosingSymbol.name).toBe("greet");
	});

	it("names a top-level Kotlin function by its name", async () => {
		// Line 13 is `return text.uppercase()`, inside `shout` (lines 12-14).
		const expanded = await expand("Greeter.kt", KOTLIN, 13);
		expect(expanded.enclosingSymbol.kind).toBe("function_declaration");
		expect(expanded.enclosingSymbol.name).toBe("shout");
		expect(expanded.ancestry).toBeUndefined();
	});

	it("names the enclosing Kotlin class in the ancestry", async () => {
		const expanded = await expand("Greeter.kt", KOTLIN, 8);
		expect(expanded.ancestry?.map((a) => a.name)).toEqual(["Greeter"]);
		expect(expanded.ancestry?.map((a) => a.kind)).toEqual([
			"class_declaration",
		]);
	});

	it("names the class when the class itself is the enclosing symbol", async () => {
		// Line 4 is the `val tag` property: the deepest enclosing symbol is the
		// class, not a function.
		const expanded = await expand("Greeter.kt", KOTLIN, 4);
		expect(expanded.enclosingSymbol.kind).toBe("class_declaration");
		expect(expanded.enclosingSymbol.name).toBe("Greeter");
	});
});

describe("read expansion names Swift symbols (#5320)", () => {
	it.skipIf(swiftBlocked)(
		"names a Swift method by its name, not function_declaration",
		async () => {
			// Line 8 is `return line`, inside `greet` (lines 6-9).
			const expanded = await expand("Greeter.swift", SWIFT, 8);
			expect(expanded.enclosingSymbol.kind).toBe("function_declaration");
			expect(expanded.enclosingSymbol.name).toBe("greet");
		},
	);

	it.skipIf(swiftBlocked)(
		"names a top-level Swift function by its name",
		async () => {
			// Line 13 is `return text.uppercased()`, inside `shout` (12-14).
			const expanded = await expand("Greeter.swift", SWIFT, 13);
			expect(expanded.enclosingSymbol.kind).toBe("function_declaration");
			expect(expanded.enclosingSymbol.name).toBe("shout");
			expect(expanded.ancestry).toBeUndefined();
		},
	);

	it.skipIf(swiftBlocked)(
		"names the enclosing Swift class in the ancestry",
		async () => {
			const expanded = await expand("Greeter.swift", SWIFT, 8);
			expect(expanded.ancestry?.map((a) => a.name)).toEqual(["Greeter"]);
			expect(expanded.ancestry?.map((a) => a.kind)).toEqual([
				"class_declaration",
			]);
		},
	);

	it.skipIf(swiftBlocked)(
		"names the class when the class itself is the enclosing symbol",
		async () => {
			// Line 4 is the `let tag` property.
			const expanded = await expand("Greeter.swift", SWIFT, 4);
			expect(expanded.enclosingSymbol.kind).toBe("class_declaration");
			expect(expanded.enclosingSymbol.name).toBe("Greeter");
		},
	);
});

describe("read expansion keeps Java names (#5320 control)", () => {
	// Recurrence: a Java `method_declaration` children are
	// `modifiers, type_identifier(String), identifier(greet)`, so a name lookup
	// that accepted `type_identifier` unconditionally would read the RETURN
	// TYPE as the name. This case pins the opposite.
	it("names a Java method by its name, not its return type", async () => {
		// Line 11 is `return prefix + name;`, inside `greet` (lines 10-12).
		const expanded = await expand("Greeter.java", JAVA, 11);
		expect(expanded.enclosingSymbol.kind).toBe("method_declaration");
		expect(expanded.enclosingSymbol.name).toBe("greet");
		expect(expanded.ancestry?.map((a) => a.name)).toEqual(["Greeter"]);
	});

	it("names a Java class by its name", async () => {
		// Line 4 is the `prefix` field: the class is the enclosing symbol.
		const expanded = await expand("Greeter.java", JAVA, 4);
		expect(expanded.enclosingSymbol.kind).toBe("class_declaration");
		expect(expanded.enclosingSymbol.name).toBe("Greeter");
	});
});
