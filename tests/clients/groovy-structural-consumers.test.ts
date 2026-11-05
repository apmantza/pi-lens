/**
 * Groovy through the consumers that read the vendored grammar (#5235 slice 3):
 * module_report (the issue's acceptance line), the kind route that reaches
 * `Jenkinsfile` / `build.gradle`, and read expansion. Real client, real wasm;
 * nothing is mocked. Kept apart from module-report.test.ts so the Groovy wasm
 * is the only extra grammar loaded in this worker (the #255 wall).
 */
import * as path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { EXTENSION_TO_GRAMMAR } from "../../clients/language-registry.js";
import { moduleReport } from "../../clients/module-report.js";
import { tryExpandRead } from "../../clients/read-expansion.js";
import type { TreeSitterClient } from "../../clients/tree-sitter-client.js";
import { getSharedTreeSitterClient } from "../../clients/tree-sitter-shared.js";
import { symbolExtractionGrammar } from "../../clients/tree-sitter-symbol-extractor.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

const SYNTAX_WARNING =
	"tree-sitter could not parse part of this file; the symbol list may be incomplete.";

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length) cleanups.pop()?.();
});
function makeEnv() {
	const env = setupTestEnvironment("pi-lens-groovy-");
	cleanups.push(env.cleanup);
	return env;
}

let client: TreeSitterClient;
beforeAll(async () => {
	client = getSharedTreeSitterClient() as TreeSitterClient;
	await client.init();
});

// A class lists its methods as `members`, so flatten before looking one up.
type Entry = { name: string; members?: unknown[] } & Record<string, unknown>;
function flatten(entries: Entry[]): Entry[] {
	return entries.flatMap((e) => [e, ...flatten((e.members ?? []) as Entry[])]);
}
function allEntries(report: {
	api: unknown[];
	internal: unknown[];
}): Array<Entry & { kind: string; signature?: string }> {
	return flatten([...report.api, ...report.internal] as Entry[]) as Array<
		Entry & { kind: string; signature?: string }
	>;
}

const SERVICE = [
	"package com.example",
	"",
	"import groovy.json.JsonSlurper",
	"",
	"class OrderService {",
	"    String name",
	"",
	"    OrderService(String name) {",
	"        this.name = name",
	"    }",
	"",
	"    Object find(String id) {",
	"        def text = id.trim()",
	"        return text",
	"    }",
	"",
	"    private int count(List items) {",
	"        int total = 0",
	"        for (item in items) {",
	"            total += 1",
	"        }",
	"        return total",
	"    }",
	"}",
	"",
].join("\n");

describe("module_report on a Groovy class (#5235 acceptance)", () => {
	it("lists the class with its methods and the import", async () => {
		const env = makeEnv();
		const file = createTempFile(env.tmpDir, "OrderService.groovy", SERVICE);

		const report = await moduleReport(file, env.tmpDir);

		expect(report.available).toBe(true);
		expect(report.language).toBe("groovy");
		expect(report.warnings ?? []).not.toContain(SYNTAX_WARNING);
		const entries = allEntries(report);
		expect(entries.map((e) => e.name)).toEqual(
			expect.arrayContaining(["OrderService", "find", "count"]),
		);
		expect(entries.find((e) => e.name === "OrderService")?.kind).toBe("class");
		const find = entries.find((e) => e.name === "find");
		expect(find?.kind).toBe("method");
		expect(find?.signature).toContain("String id");
		expect(report.imports.external).toContain("groovy.json.JsonSlurper");
		// No tuned callback rules for Groovy: the report must say so.
		expect(report.callbackSupport).toBe("generic");
	});

	// Recurrence: #4949, a partial parse read as absence. Groovy is the first
	// grammar here that ships with a known ~30% partial-parse rate, so the
	// disclosure has to fire on it.
	it("warns that the symbol list may be incomplete on a partial parse", async () => {
		const env = makeEnv();
		const file = createTempFile(
			env.tmpDir,
			"Nested.groovy",
			"class Outer {\n    static class Inner {}\n    void run() { }\n}\n",
		);

		const report = await moduleReport(file, env.tmpDir);

		expect(report.available).toBe(true);
		expect(report.warnings).toContain(SYNTAX_WARNING);
	});
});

describe("kind route reaches Jenkinsfile and build.gradle (#5235)", () => {
	// Recurrence: the grammar is keyed by extension for the extension-keyed
	// consumers, which `.gradle` must not join (it would claim every .gradle
	// file), so these named files reach it only through `symbolExtractionGrammar`.
	it("resolves the groovy grammar for the named files and not for other .gradle files", () => {
		expect(symbolExtractionGrammar("groovy", "/p/Jenkinsfile")).toBe("groovy");
		expect(symbolExtractionGrammar("groovy", "/p/build.gradle")).toBe("groovy");
		expect(symbolExtractionGrammar("groovy", "/p/settings.gradle")).toBe(
			"groovy",
		);
		expect(EXTENSION_TO_GRAMMAR[".gradle"]).toBeUndefined();
		expect(EXTENSION_TO_GRAMMAR[".groovy"]).toBe("groovy");
		expect(EXTENSION_TO_GRAMMAR[".gsh"]).toBe("groovy");
	});

	for (const [name, source, expected] of [
		[
			"Jenkinsfile",
			"def build(String target) {\n    echo \"building ${target}\"\n}\n\nbuild('app')\n",
			"build",
		],
		[
			"build.gradle",
			"def versionOf(String name) {\n    return '1.0'\n}\n\ndependencies {\n    implementation 'a:b:1.0'\n}\n",
			"versionOf",
		],
	] as const) {
		it(`module_report lists a function from ${name}`, async () => {
			const env = makeEnv();
			const file = createTempFile(env.tmpDir, name, source);

			const report = await moduleReport(file, env.tmpDir);

			expect(report.available).toBe(true);
			expect(report.language).toBe("groovy");
			expect(allEntries(report).map((e) => e.name)).toContain(expected);
		});
	}
});

describe("read expansion on a Groovy file (#5235)", () => {
	it("widens a partial read inside a method to the whole method", async () => {
		const env = makeEnv();
		const file = createTempFile(env.tmpDir, "OrderService.groovy", SERVICE);
		const total = SERVICE.split("\n").length;

		// Line 20 is `total += 1`, inside `count` (lines 17-23).
		const expanded = await tryExpandRead(file, 20, 1, total, client);

		expect(expanded).toBeDefined();
		expect(expanded?.enclosingSymbol.kind).toBe("method_declaration");
		expect(expanded?.enclosingSymbol.name).toBe("count");
		expect(expanded?.enclosingSymbol.startLine).toBe(17);
		expect(expanded?.enclosingSymbol.endLine).toBe(23);
		expect(expanded?.ancestry?.map((a) => a.name)).toEqual(["OrderService"]);
	});

	// Recurrence: read expansion is keyed by extension, so a `.gradle` file must
	// not expand under the Groovy grammar.
	it("does not expand a .gradle file", async () => {
		const env = makeEnv();
		const file = createTempFile(
			env.tmpDir,
			path.join("app", "extra.gradle"),
			SERVICE,
		);
		const expanded = await tryExpandRead(
			file,
			20,
			1,
			SERVICE.split("\n").length,
			client,
		);
		expect(expanded).toBeUndefined();
	});
});

describe("directory scan for Groovy (#5235)", () => {
	// Recurrence: the structural-search walk keys on a hand-kept extension map
	// (`getExtensionsForLanguage`); a language missing from it scans no files
	// and reports a clean zero.
	it("collects the four Groovy extensions and leaves .gradle and .txt out", () => {
		const env = makeEnv();
		for (const name of [
			"a.groovy",
			"b.gvy",
			"c.gy",
			"d.gsh",
			"e.gradle",
			"f.txt",
		])
			createTempFile(env.tmpDir, path.join("src", name), "class A {}\n");

		// collectFiles is private; the walk needs no grammar loaded.
		// biome-ignore lint/suspicious/noExplicitAny: private method under test
		const files: string[] = (client as any).collectFiles(env.tmpDir, "groovy");

		expect(files.map((f) => path.basename(f)).sort()).toEqual([
			"a.groovy",
			"b.gvy",
			"c.gy",
			"d.gsh",
		]);
	});
});
