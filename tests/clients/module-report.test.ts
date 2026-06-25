import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FactStore } from "../../clients/dispatch/fact-store.js";
import { moduleReport, readSymbol } from "../../clients/module-report.js";
import {
	buildOrUpdateGraph,
	clearReviewGraphWorkspaceCache,
} from "../../clients/review-graph/builder.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

// module_report consumes the cached review graph read-only (#256) — it never
// builds and never calls an LSP server. Production warms the cache via the edit
// pipeline; tests must do the same before asserting graph-derived who-uses-this.
async function warmGraph(cwd: string): Promise<void> {
	await buildOrUpdateGraph(cwd, [], new FactStore());
}

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length) cleanups.pop()?.();
	clearReviewGraphWorkspaceCache(); // isolate the module-global graph cache
});

function makeEnv(prefix = "pi-lens-modreport-") {
	const env = setupTestEnvironment(prefix);
	cleanups.push(env.cleanup);
	return env;
}

describe("moduleReport — outline + structure", () => {
	it("extracts a TypeScript outline with signatures, line ranges, and read args", async () => {
		const env = makeEnv();
		const file = createTempFile(
			env.tmpDir,
			"sample.ts",
			[
				"export function add(a: number, b: number): number {",
				"  return a + b;",
				"}",
				"",
				"function helper(x: string) {",
				"  return x.trim();",
				"}",
			].join("\n"),
		);

		const report = await moduleReport(file, env.tmpDir);

		expect(report.available).toBe(true);
		expect(report.language).toBe("jsts");
		expect(report.staleness).toBe("fresh");

		const add = report.api.find((e) => e.name === "add");
		expect(add).toBeDefined();
		expect(add?.exported).toBe(true);
		expect(add?.kind).toBe("function");
		expect(add?.signature).toContain("a: number");
		// endLine must exceed startLine for a multi-line function (the Symbol.endLine
		// enabler) and drive the pre-computed read args.
		expect(add!.endLine).toBeGreaterThan(add!.startLine);
		expect(add!.read).toEqual({
			path: file,
			offset: add!.startLine,
			limit: add!.endLine - add!.startLine + 1,
		});

		// Non-exported symbol is routed to `internal`, not `api`.
		expect(report.internal.some((e) => e.name === "helper")).toBe(true);
		expect(report.api.some((e) => e.name === "helper")).toBe(false);
	});

	it("extracts a Python outline (language-uniform, not TS-only)", async () => {
		const env = makeEnv();
		const file = createTempFile(
			env.tmpDir,
			"sample.py",
			[
				"def greet(name):",
				"    return f'hi {name}'",
				"",
				"class Greeter:",
				"    pass",
			].join("\n"),
		);

		const report = await moduleReport(file, env.tmpDir);

		expect(report.available).toBe(true);
		expect(report.language).toBe("python");
		const names = [...report.api, ...report.internal].map((e) => e.name);
		expect(names).toContain("greet");
		expect(names).toContain("Greeter");
	});

	it("extracts a .tsx file via the JSX-aware grammar (downloaded-grammar coverage)", async () => {
		const env = makeEnv();
		const file = createTempFile(
			env.tmpDir,
			"widget.tsx",
			[
				"export function Widget(props: { label: string }) {",
				"  return <div>{props.label}</div>;",
				"}",
			].join("\n"),
		);

		const report = await moduleReport(file, env.tmpDir);

		expect(report.available).toBe(true);
		expect(report.api.some((e) => e.name === "Widget")).toBe(true);
	});

	it("returns available:false for a non-symbol-bearing file (json)", async () => {
		const env = makeEnv();
		const file = createTempFile(env.tmpDir, "data.json", '{"a": 1}\n');
		const report = await moduleReport(file, env.tmpDir);
		expect(report.available).toBe(false);
		expect(report.staleness).toBe("unavailable");
		expect(report.api).toHaveLength(0);
	});

	it("returns an unavailable report for a missing file", async () => {
		const env = makeEnv();
		const report = await moduleReport("nope.ts", env.tmpDir);
		expect(report.available).toBe(false);
		expect(report.staleness).toBe("unavailable");
	});
});

describe("moduleReport — review-graph who-uses-this", () => {
	it("resolves cross-file callers from the review graph", async () => {
		const env = makeEnv();
		createTempFile(
			env.tmpDir,
			"a.ts",
			"export function foo(x: number): number {\n  return x + 1;\n}\n",
		);
		createTempFile(
			env.tmpDir,
			"b.ts",
			[
				'import { foo } from "./a.js";',
				"export function callsFoo(): number {",
				"  return foo(41);",
				"}",
			].join("\n"),
		);

		await warmGraph(env.tmpDir);
		const report = await moduleReport("a.ts", env.tmpDir);

		expect(report.available).toBe(true);
		expect(report.staleness).toBe("fresh");
		// Provenance is honest: who-uses-this came from the AST review graph (#256).
		expect(report.semantic.source).toBe("review-graph");
		const foo = report.api.find((e) => e.name === "foo");
		expect(foo).toBeDefined();
		expect(foo?.usedBy?.some((u) => u.file.endsWith("b.ts"))).toBe(true);
		// usedBy paths are cwd-relative for scanning (not absolute) (#256).
		expect(foo?.usedBy?.every((u) => !path.isAbsolute(u.file))).toBe(true);
		// recommendedReads should surface the referenced, exported symbol.
		expect(report.recommendedReads.some((r) => r.symbol === "foo")).toBe(true);
	});

	it("drops a function-local declaration from the outline entirely (#259, supersedes #256 routing)", async () => {
		const env = makeEnv();
		const file = createTempFile(
			env.tmpDir,
			"nested.ts",
			[
				"export function outer(): number {",
				"  const localHelper = (n: number) => n * 2;",
				"  return localHelper(21);",
				"}",
			].join("\n"),
		);
		const report = await moduleReport(file, env.tmpDir);
		// outer is the module export; localHelper is a function-local → it is no
		// longer surfaced in EITHER list (it was routed to internal pre-#259).
		expect(report.api.some((e) => e.name === "outer")).toBe(true);
		expect(report.api.some((e) => e.name === "localHelper")).toBe(false);
		expect(report.internal.some((e) => e.name === "localHelper")).toBe(false);
	});

	it("Tier 3: serves who-uses-this from the persisted disk snapshot when the in-memory cache is cold (cross-process)", async () => {
		const env = makeEnv();
		createTempFile(
			env.tmpDir,
			"a.ts",
			"export function foo(x: number): number {\n  return x + 1;\n}\n",
		);
		createTempFile(
			env.tmpDir,
			"b.ts",
			[
				'import { foo } from "./a.js";',
				"export function callsFoo(): number {",
				"  return foo(41);",
				"}",
			].join("\n"),
		);
		await warmGraph(env.tmpDir); // builds + persists to disk (async)

		// Simulate a fresh process (the edit pipeline persisted; module_report runs
		// elsewhere with an empty in-memory cache). persistGraph writes async, so
		// clear in-memory and poll until the disk snapshot lands.
		let foo: { usedBy?: Array<{ file: string }> } | undefined;
		for (let attempt = 0; attempt < 20; attempt++) {
			clearReviewGraphWorkspaceCache(); // force the disk (Tier 3) path
			const report = await moduleReport("a.ts", env.tmpDir);
			foo = report.api.find((e) => e.name === "foo");
			if (foo?.usedBy?.length) break;
			await new Promise((r) => setTimeout(r, 50));
		}
		expect(foo?.usedBy?.some((u) => u.file.endsWith("b.ts"))).toBe(true);
	});

	it("populates imports for a non-jsts language (python) via graph import edges (#249)", async () => {
		const env = makeEnv();
		createTempFile(
			env.tmpDir,
			"app.py",
			"import os\nimport requests\nfrom . import helper\n\ndef go():\n    return os.getcwd()\n",
		);
		createTempFile(env.tmpDir, "helper.py", "def h():\n    return 1\n");

		await warmGraph(env.tmpDir);
		const report = await moduleReport("app.py", env.tmpDir);

		expect(report.available).toBe(true);
		// External package imports come through the new tree-sitter import edges.
		expect(report.imports.external).toContain("os");
		expect(report.imports.external).toContain("requests");
		expect(report.summary.imports).toBeGreaterThan(0);
	});

	it("LSP disabled (budget 0) → semantic.source is none", async () => {
		const env = makeEnv();
		createTempFile(
			env.tmpDir,
			"a.ts",
			"export function foo(x: number): number {\n  return x + 1;\n}\n",
		);
		const report = await moduleReport("a.ts", env.tmpDir);
		expect(report.semantic.source).toBe("none");
		expect(report.semantic.implementations).toBe(false);
	});

	it("read-only: no cached graph (cold) → outline only, no build, who-uses-this empty", async () => {
		const env = makeEnv();
		createTempFile(
			env.tmpDir,
			"a.ts",
			"export function foo(x: number): number {\n  return x + 1;\n}\n",
		);
		createTempFile(
			env.tmpDir,
			"b.ts",
			'import { foo } from "./a.js";\nexport const r = foo(1);\n',
		);
		// No warmGraph() → the cache is cold. module_report must NOT build it.
		const report = await moduleReport("a.ts", env.tmpDir);
		expect(report.available).toBe(true); // outline still extracts
		const foo = report.api.find((e) => e.name === "foo");
		expect(foo).toBeDefined();
		expect(foo?.usedBy).toBeUndefined(); // cold graph → no who-uses-this
		expect(report.imports.external).toHaveLength(0);
	});
});

describe("moduleReport — cold-cache imports (#301)", () => {
	it("TS: resolves a relative import to an in-project file and buckets externals", async () => {
		const env = makeEnv();
		createTempFile(env.tmpDir, "dep.ts", "export const x = 1;\n");
		const file = createTempFile(
			env.tmpDir,
			"main.ts",
			[
				'import { x } from "./dep";',
				'import { readFileSync } from "node:fs";',
				'import express from "express";',
				"export const y = x;",
			].join("\n"),
		);
		// Cold cache: no warmGraph(). Imports must still populate from tree-sitter
		// (previously zero), resolving the relative import to the real file.
		const report = await moduleReport(file, env.tmpDir);
		expect(report.semantic.source).toBe("none"); // proves cold path
		expect(report.imports.internal).toContain("dep.ts");
		// Bare specifiers stay external.
		expect(report.imports.external).toContain("express");
		expect(report.imports.external).toContain("node:fs");
		expect(report.summary.imports).toBe(
			report.imports.internal.length + report.imports.external.length,
		);
	});

	it("TS: an unresolvable relative import falls back to the internal bucket by shape", async () => {
		const env = makeEnv();
		const file = createTempFile(
			env.tmpDir,
			"a.ts",
			'import { foo } from "./not-created";\nexport const r = 1;\n',
		);
		const report = await moduleReport(file, env.tmpDir);
		// No file on disk to resolve to, but "./" shape ⇒ internal, never external.
		expect(report.imports.internal).toContain("./not-created");
		expect(report.imports.external).toHaveLength(0);
	});

	it("Python: resolves a dotted intra-package import on a cold cache", async () => {
		const env = makeEnv();
		createTempFile(env.tmpDir, "pkg/__init__.py", "");
		createTempFile(env.tmpDir, "pkg/util.py", "def helper():\n    return 1\n");
		const file = createTempFile(
			env.tmpDir,
			"pkg/main.py",
			["from pkg.util import helper", "import os", "", "helper()"].join("\n"),
		);
		const report = await moduleReport(file, env.tmpDir);
		expect(report.language).toBe("python");
		expect(report.imports.internal.some((p) => p.endsWith("util.py"))).toBe(
			true,
		);
		expect(report.imports.external).toContain("os");
	});

	it("warm graph wins: cold extraction does not override a populated graph", async () => {
		const env = makeEnv();
		createTempFile(env.tmpDir, "dep.ts", "export const x = 1;\n");
		const file = createTempFile(
			env.tmpDir,
			"main.ts",
			'import { x } from "./dep";\nexport const y = x;\n',
		);
		await warmGraph(env.tmpDir);
		const report = await moduleReport(file, env.tmpDir);
		expect(report.semantic.source).toBe("review-graph"); // warm
		expect(report.imports.internal).toContain("dep.ts");
	});
});

describe("moduleReport — member nesting (#301)", () => {
	it("ranks a hot nested method into recommendedReads via the flat list", async () => {
		const env = makeEnv();
		const file = createTempFile(
			env.tmpDir,
			"svc.ts",
			[
				"export class Svc {",
				"  hot(): number { return 1; }",
				"}",
				"export function caller(): number { return new Svc().hot(); }",
			].join("\n"),
		);
		await warmGraph(env.tmpDir); // so who-uses-this scores the nested method
		const report = await moduleReport(file, env.tmpDir);
		// Svc is top-level with hot nested under it.
		const svc = report.api.find((e) => e.name === "Svc");
		expect((svc?.members ?? []).some((e) => e.name === "hot")).toBe(true);
		// recommendedReads ranks over the FLAT list, so a referenced nested method
		// can still surface as a recommended read.
		const reads = report.recommendedReads.map((r) => r.symbol);
		expect(reads).toContain("hot");
	});
});

describe("moduleReport — member visibility (#258) + compact outline (#259)", () => {
	it("routes private/protected members of an exported class to internal with a visibility tag (#258)", async () => {
		const env = makeEnv();
		const file = createTempFile(
			env.tmpDir,
			"svc.ts",
			[
				"export class Service {",
				"  run(): number { return 1; }",
				"  private secret(): number { return 2; }",
				"  protected guarded(): number { return 3; }",
				"}",
			].join("\n"),
		);
		const report = await moduleReport(file, env.tmpDir);

		// The exported class is the top-level api entry; its members nest under it
		// (#301) rather than appearing flat at top level.
		const svc = report.api.find((e) => e.name === "Service");
		expect(svc).toBeDefined();
		expect(report.api.some((e) => e.name === "run")).toBe(false);
		const members = svc?.members ?? [];
		const run = members.find((e) => e.name === "run");
		const secret = members.find((e) => e.name === "secret");
		const guarded = members.find((e) => e.name === "guarded");

		// Public member: exported, no visibility tag.
		expect(run?.exported).toBe(true);
		expect(run?.visibility).toBeUndefined();
		// Private/protected members are reachable but not public API → tagged,
		// not exported, even though they nest under an exported class.
		expect(secret?.visibility).toBe("private");
		expect(guarded?.visibility).toBe("protected");
		expect(secret?.exported).toBe(false);
		expect(secret?.flags ?? []).not.toContain("exported");
		// summary.exports counts the top-level api split only.
		expect(report.summary.exports).toBe(report.api.length);
	});

	it("keeps class members + module-level symbols while dropping function-locals (#259)", async () => {
		const env = makeEnv();
		const file = createTempFile(
			env.tmpDir,
			"m.ts",
			[
				"export class Svc {",
				"  method(): number {",
				"    const tmp = (x: number) => x + 1;",
				"    return tmp(1);",
				"  }",
				"}",
				"export function top(): void {}",
			].join("\n"),
		);
		const report = await moduleReport(file, env.tmpDir);
		const topLevel = [...report.api, ...report.internal].map((e) => e.name);
		expect(topLevel).toContain("Svc"); // exported class — top level
		expect(topLevel).toContain("top"); // module-level fn — top level
		expect(topLevel).not.toContain("method"); // class member → nested, not top
		expect(topLevel).not.toContain("tmp"); // function-local dropped entirely

		// The member lives under its container (#301), and the function-local stays
		// dropped at every level.
		const svc = [...report.api, ...report.internal].find(
			(e) => e.name === "Svc",
		);
		const memberNames = (svc?.members ?? []).map((e) => e.name);
		expect(memberNames).toContain("method");
		expect(memberNames).not.toContain("tmp");
	});
});

describe("readSymbol — verbatim body for guard-satisfying reads", () => {
	it("returns the exact source lines of a named symbol", async () => {
		const env = makeEnv();
		createTempFile(
			env.tmpDir,
			"sample.ts",
			[
				"const noise = 1;",
				"export function target(n: number): number {",
				"  const doubled = n * 2;",
				"  return doubled;",
				"}",
			].join("\n"),
		);

		const result = await readSymbol("sample.ts", "target", env.tmpDir);

		expect(result.found).toBe(true);
		expect(result.kind).toBe("function");
		expect(result.startLine).toBe(2);
		expect(result.endLine).toBe(5);
		expect(result.source).toContain("export function target");
		expect(result.source).toContain("return doubled;");
		// Must not leak lines outside the symbol body.
		expect(result.source).not.toContain("const noise");
	});

	it("reports not-found for an unknown symbol", async () => {
		const env = makeEnv();
		createTempFile(env.tmpDir, "sample.ts", "export const x = 1;\n");
		const result = await readSymbol("sample.ts", "ghost", env.tmpDir);
		expect(result.found).toBe(false);
	});
});
