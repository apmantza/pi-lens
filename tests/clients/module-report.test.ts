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
			["def greet(name):", "    return f'hi {name}'", "", "class Greeter:", "    pass"].join(
				"\n",
			),
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

describe("moduleReport — member visibility (#258) + compact outline (#259)", () => {
	it("nests members under their class with visibility tags; private/protected stay non-exported (#258, #301)", async () => {
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

		// The exported class is the top-level public entry; members nest under it
		// rather than appearing as top-level siblings (#301).
		const service = report.api.find((e) => e.name === "Service");
		expect(service).toBeDefined();
		const members = service?.members ?? [];
		const run = members.find((e) => e.name === "run");
		const secret = members.find((e) => e.name === "secret");
		const guarded = members.find((e) => e.name === "guarded");

		// No member is hoisted to the top-level api/internal lists.
		expect(report.api.some((e) => e.name === "run")).toBe(false);
		expect(report.internal.some((e) => e.name === "secret")).toBe(false);
		expect(report.internal.some((e) => e.name === "guarded")).toBe(false);

		// Public member: exported, no visibility tag.
		expect(run?.exported).toBe(true);
		expect(run?.visibility).toBeUndefined();
		// Private/protected members: visibility-tagged, NOT exported (#258 preserved).
		expect(secret?.visibility).toBe("private");
		expect(guarded?.visibility).toBe("protected");
		expect(secret?.exported).toBe(false);
		expect(secret?.flags ?? []).not.toContain("exported");
		// summary.exports tracks the top-level public surface.
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
		const all = allNames(report);
		expect(all).toContain("Svc"); // exported class
		expect(all).toContain("method"); // class member kept (now nested under Svc)
		expect(all).toContain("top"); // module-level kept
		expect(all).not.toContain("tmp"); // function-local dropped
		// `method` is nested under its class, not a top-level sibling (#301).
		const svc = report.api.find((e) => e.name === "Svc");
		expect(svc?.members?.some((e) => e.name === "method")).toBe(true);
		expect([...report.api, ...report.internal].some((e) => e.name === "method")).toBe(
			false,
		);
	});

	it("nests class members under the container and keeps them off the top level (#301)", async () => {
		const env = makeEnv();
		const file = createTempFile(
			env.tmpDir,
			"parser.ts",
			[
				"export class Parser {",
				"  parse(): number { return 1; }",
				"  recover(): number { return 2; }",
				"}",
				"export function standalone(): void {}",
			].join("\n"),
		);
		const report = await moduleReport(file, env.tmpDir);

		const parser = report.api.find((e) => e.name === "Parser");
		expect(parser).toBeDefined();
		const memberNames = (parser?.members ?? []).map((e) => e.name);
		expect(memberNames).toContain("parse");
		expect(memberNames).toContain("recover");

		// Members stay navigable: each carries its own read args.
		const parse = parser?.members?.find((e) => e.name === "parse");
		expect(parse?.read.offset).toBe(parse?.startLine);

		// Members are not duplicated at the top level.
		expect(report.api.some((e) => e.name === "parse")).toBe(false);
		expect(report.internal.some((e) => e.name === "parse")).toBe(false);
		// A sibling top-level function is unaffected.
		expect(report.api.some((e) => e.name === "standalone")).toBe(true);

		// Members are ordered by source position.
		const lines = (parser?.members ?? []).map((e) => e.startLine);
		expect(lines).toEqual([...lines].sort((a, b) => a - b));
	});

	it("surfaces imports on a COLD cache from the extractor, classified by shape (#301)", async () => {
		const env = makeEnv();
		createTempFile(
			env.tmpDir,
			"c.ts",
			[
				'import { z } from "zod";',
				'import { local } from "./local.js";',
				'import path from "node:path";',
				"export const v = z;",
			].join("\n"),
		);
		// No warmGraph() → cold cache. Imports must still come through the extractor
		// floor rather than the empty list module_report used to return (#301).
		const report = await moduleReport("c.ts", env.tmpDir);
		expect(report.semantic.source).toBe("none"); // genuinely cold
		expect(report.imports.external).toContain("zod");
		expect(report.imports.external).toContain("node:path");
		expect(report.imports.internal).toContain("./local.js");
		expect(report.summary.imports).toBeGreaterThan(0);
	});

	it("cold imports are language-uniform: resolves an internal import to a real file (python) (#301)", async () => {
		const env = makeEnv();
		createTempFile(
			env.tmpDir,
			"app.py",
			"from .helper import h\nimport os\n\ndef go():\n    return h()\n",
		);
		createTempFile(env.tmpDir, "helper.py", "def h():\n    return 1\n");
		// No warmGraph() → cold. The cold path reuses the SAME per-language resolver
		// the warm graph uses, so internal imports resolve to actual project files
		// uniformly across languages — not just TS (#301).
		const report = await moduleReport("app.py", env.tmpDir);
		expect(report.semantic.source).toBe("none"); // genuinely cold
		expect(report.imports.external).toContain("os"); // stdlib stays external
		// `.helper` resolves to helper.py via resolveImportToFiles (python resolver).
		expect(report.imports.internal.some((p) => p.endsWith("helper.py"))).toBe(true);
	});
});

// Flatten every symbol name in a report, descending into nested members (#301).
function allNames(report: {
	api: Array<{ name: string; members?: unknown[] }>;
	internal: Array<{ name: string; members?: unknown[] }>;
}): string[] {
	const out: string[] = [];
	const walk = (entries: Array<{ name: string; members?: unknown[] }>): void => {
		for (const entry of entries) {
			out.push(entry.name);
			if (entry.members)
				walk(entry.members as Array<{ name: string; members?: unknown[] }>);
		}
	};
	walk(report.api);
	walk(report.internal);
	return out;
}

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
