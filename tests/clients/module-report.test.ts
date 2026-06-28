import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FactStore } from "../../clients/dispatch/fact-store.js";
import {
	moduleReport,
	readEnclosing,
	readSymbol,
} from "../../clients/module-report.js";
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

	it("supports a payload-reducing summary view with section provenance", async () => {
		const env = makeEnv();
		const file = createTempFile(
			env.tmpDir,
			"summary.ts",
			[
				"export function add(a: number, b: number): number {",
				"  return a + b;",
				"}",
				"function helper() {",
				"  return add(1, 2);",
				"}",
			].join("\n"),
		);

		const report = await moduleReport(file, env.tmpDir, { view: "summary" });

		expect(report.view).toBe("summary");
		expect(report.api[0]).toMatchObject({
			name: "add",
			kind: "function",
			read: { path: file, offset: 1, limit: 3 },
		});
		expect(report.api[0].usedBy).toBeUndefined();
		expect(report.callbacks).toEqual([]);
		expect(report.provenance).toMatchObject({
			symbols: "syntax",
			callbacks: "none",
		});
		expect(report.recommendedReads.length).toBeGreaterThan(0);
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

	it("surfaces important anonymous callbacks with read handles and risk flags", async () => {
		const env = makeEnv();
		const file = createTempFile(
			env.tmpDir,
			"callbacks.ts",
			[
				"export async function run(ctx: any) {",
				"  await handleTurnEnd({",
				"    resetLSPService: () => {",
				"      ctx.ui.setStatus('x');",
				"    },",
				"  });",
				"}",
				'pi.on("turn_end", async (_event, ctx) => {',
				"  ctx.ui.notify('x');",
				"});",
				"setTimeout(() => {",
				"  resetFn();",
				"}, 240_000);",
			].join("\n"),
		);

		const report = await moduleReport(file, env.tmpDir);

		const reset = report.callbacks.find(
			(callback) => callback.name === "run.resetLSPService@3",
		);
		expect(reset).toMatchObject({
			kind: "object_property_callback",
			startLine: 3,
			endLine: 5,
			read: { path: file, offset: 3, limit: 3 },
		});
		expect(reset?.flags).toContain("captures ctx.ui");

		const event = report.callbacks.find((callback) =>
			callback.name.startsWith('pi.on("turn_end")@'),
		);
		expect(event?.kind).toBe("event_handler");
		expect(event?.flags).toEqual(
			expect.arrayContaining(["async", "captures ctx.ui", "lifecycle"]),
		);

		const timer = report.callbacks.find((callback) =>
			callback.name.startsWith("setTimeout@"),
		);
		expect(timer?.kind).toBe("timer_callback");
		expect(timer?.flags).toContain("detached timer");
	});

	it("extracts inline executable handles across non-TypeScript grammars", async () => {
		const env = makeEnv();
		const py = createTempFile(
			env.tmpDir,
			"callbacks.py",
			'def run(ctx):\n    callbacks = {"reset": lambda: ctx.ui.set_status("x")}\n',
		);
		const go = createTempFile(
			env.tmpDir,
			"callbacks.go",
			'package main\nfunc run() {\n  cb := func() { println("x") }\n  cb()\n}\n',
		);
		const rust = createTempFile(
			env.tmpDir,
			"callbacks.rs",
			'fn run() {\n    let cb = || { println!("x"); };\n}\n',
		);

		const pyReport = await moduleReport(py, env.tmpDir);
		expect(pyReport.callbacks).toContainEqual(
			expect.objectContaining({
				name: 'run."reset"@2',
				kind: "object_property_callback",
				rawKind: "lambda",
			}),
		);
		expect(pyReport.callbacks[0]?.flags).toContain("captures ctx.ui");

		const goReport = await moduleReport(go, env.tmpDir);
		expect(goReport.callbacks).toContainEqual(
			expect.objectContaining({
				name: "run.cb@3",
				kind: "assigned_callback",
				rawKind: "func_literal",
			}),
		);

		const rustReport = await moduleReport(rust, env.tmpDir);
		expect(rustReport.callbacks).toContainEqual(
			expect.objectContaining({
				name: "run.cb@2",
				kind: "assigned_callback",
				rawKind: "closure_expression",
			}),
		);
	});

	it("surfaces Go goroutine and deferred closures via language-tuned rules", async () => {
		const env = makeEnv();
		const go = createTempFile(
			env.tmpDir,
			"lifecycle.go",
			[
				"package main",
				"",
				"func run() {",
				"	go func() {",
				'		println("async work")',
				"	}()",
				"	defer func() {",
				'		println("cleanup")',
				"	}()",
				"}",
			].join("\n"),
		);

		const report = await moduleReport(go, env.tmpDir);

		// A bare goroutine closure used to be DROPPED by the generic rules
		// (classified as a no-name "callback"); the Go rule set now surfaces it.
		const goroutine = report.callbacks.find((cb) => cb.kind === "goroutine");
		expect(goroutine).toBeDefined();
		expect(goroutine?.name).toMatch(/^run\.goroutine@\d+$/);
		expect(goroutine?.rawKind).toBe("func_literal");
		expect(goroutine?.flags).toContain("goroutine");

		const deferred = report.callbacks.find(
			(cb) => cb.kind === "deferred_callback",
		);
		expect(deferred).toBeDefined();
		expect(deferred?.name).toMatch(/^run\.defer@\d+$/);
		expect(deferred?.flags).toContain("deferred");
	});

	it("reports callbackSupport honestly per language (tuned vs generic)", async () => {
		const env = makeEnv();
		const go = createTempFile(
			env.tmpDir,
			"support.go",
			"package main\nfunc run() {}\n",
		);
		const py = createTempFile(
			env.tmpDir,
			"support.py",
			"def run():\n    pass\n",
		);
		const rs = createTempFile(env.tmpDir, "support.rs", "fn run() {}\n");
		const rb = createTempFile(env.tmpDir, "support.rb", "def run\nend\n");

		// Go/Python/Rust have tuned rule sets; Ruby falls back to the generic
		// JS/TS-shaped heuristics, so the report must say so.
		expect((await moduleReport(go, env.tmpDir)).callbackSupport).toBe("tuned");
		expect((await moduleReport(py, env.tmpDir)).callbackSupport).toBe("tuned");
		expect((await moduleReport(rs, env.tmpDir)).callbackSupport).toBe("tuned");
		expect((await moduleReport(rb, env.tmpDir)).callbackSupport).toBe(
			"generic",
		);
	});

	it("surfaces Python scheduler/future lambdas via language-tuned rules", async () => {
		const env = makeEnv();
		const py = createTempFile(
			env.tmpDir,
			"lifecycle.py",
			[
				"def schedule(loop, fut, ctx):",
				"    loop.call_later(5, lambda: ctx.ui.refresh())",
				"    fut.add_done_callback(lambda r: ctx.done(r))",
			].join("\n"),
		);

		const report = await moduleReport(py, env.tmpDir);

		// A bare-arg lambda used to be DROPPED by the generic rules; the Python
		// rule set classifies scheduler/future lambdas as lifecycle callbacks.
		const timer = report.callbacks.find((cb) => cb.kind === "timer_callback");
		expect(timer).toBeDefined();
		expect(timer?.rawKind).toBe("lambda");
		expect(timer?.flags).toContain("detached timer");
		expect(timer?.flags).toContain("captures ctx.ui");

		const future = report.callbacks.find((cb) => cb.kind === "future_callback");
		expect(future).toBeDefined();
		expect(future?.flags).toContain("future completion");
	});

	it("surfaces Rust spawned and move closures via language-tuned rules", async () => {
		const env = makeEnv();
		const rs = createTempFile(
			env.tmpDir,
			"lifecycle.rs",
			[
				"fn run() {",
				"    std::thread::spawn(move || {",
				"        handle();",
				"    });",
				"}",
			].join("\n"),
		);

		const report = await moduleReport(rs, env.tmpDir);

		const task = report.callbacks.find((cb) => cb.kind === "task");
		expect(task).toBeDefined();
		expect(task?.rawKind).toBe("closure_expression");
		expect(task?.flags).toContain("spawned");
		expect(task?.flags).toContain("move");
	});

	it("flags Java thread/executor submits and listeners", async () => {
		// Java rides this file (its grammar is already loaded for the decorators
		// test); Kotlin/C# are heavy and live in their own file (#255).
		const env = makeEnv();
		const java = createTempFile(
			env.tmpDir,
			"Lifecycle.java",
			[
				"class C {",
				"  void run() {",
				"    exec.submit(() -> work());",
				"    new Thread(() -> go()).start();",
				"    btn.addActionListener(e -> click());",
				"  }",
				"}",
			].join("\n"),
		);

		const report = await moduleReport(java, env.tmpDir);
		expect(report.callbackSupport).toBe("tuned");
		const kinds = report.callbacks.map((c) => c.kind);
		expect(kinds).toContain("task"); // submit + new Thread
		expect(
			report.callbacks.find((c) => c.flags?.includes("thread")),
		).toBeDefined();
		expect(kinds).toContain("event_handler"); // addActionListener
	});

	it("surfaces decorators/attributes/annotations on symbols across grammars", async () => {
		const env = makeEnv();
		const flatten = (
			entries: Array<{
				name: string;
				decorators?: string[];
				members?: unknown[];
			}>,
		): Array<{ name: string; decorators?: string[] }> =>
			entries.flatMap((e) => [
				e,
				...flatten(
					(e.members ?? []) as Array<{ name: string; decorators?: string[] }>,
				),
			]);
		const find = async (file: string, name: string) => {
			const r = await moduleReport(file, env.tmpDir);
			return flatten([...r.api, ...r.internal]).find((s) => s.name === name);
		};

		// Python: multiple decorators as preceding siblings of a decorated_definition.
		const py = createTempFile(
			env.tmpDir,
			"dec.py",
			'@app.get("/x")\n@auth\ndef handler():\n    return 1\n',
		);
		expect((await find(py, "handler"))?.decorators).toEqual([
			'@app.get("/x")',
			"@auth",
		]);

		// Rust: attribute_item as a preceding sibling.
		const rs = createTempFile(
			env.tmpDir,
			"dec.rs",
			"#[tokio::main]\nasync fn main() { run(); }\n",
		);
		expect((await find(rs, "main"))?.decorators).toEqual(["#[tokio::main]"]);

		// TypeScript: decorator as an own child of the class declaration.
		const ts = createTempFile(
			env.tmpDir,
			"dec.ts",
			"@Injectable()\nexport class Svc {\n  foo() {}\n}\n",
		);
		expect((await find(ts, "Svc"))?.decorators).toEqual(["@Injectable()"]);

		// Java: annotation nested in a `modifiers` container on a nested METHOD member.
		const java = createTempFile(
			env.tmpDir,
			"Dec.java",
			"public class C {\n  @Override\n  public void run() {}\n}\n",
		);
		expect((await find(java, "run"))?.decorators).toEqual(["@Override"]);
	});

	it("flags async functions/methods on symbol entries", async () => {
		const env = makeEnv();
		const flatten = (
			entries: Array<{ name: string; flags?: string[]; members?: unknown[] }>,
		): Array<{ name: string; flags?: string[] }> =>
			entries.flatMap((e) => [
				e,
				...flatten(
					(e.members ?? []) as Array<{ name: string; flags?: string[] }>,
				),
			]);
		const isAsync = async (file: string, name: string) => {
			const r = await moduleReport(file, env.tmpDir);
			return flatten([...r.api, ...r.internal])
				.find((s) => s.name === name)
				?.flags?.includes("async");
		};

		const py = createTempFile(
			env.tmpDir,
			"async.py",
			"async def fetch():\n    pass\n\n\ndef plain():\n    pass\n",
		);
		expect(await isAsync(py, "fetch")).toBe(true);
		expect(await isAsync(py, "plain")).toBeFalsy();

		const ts = createTempFile(
			env.tmpDir,
			"async.ts",
			"export async function go() {}\nexport class C {\n  async m() {}\n}\n",
		);
		expect(await isAsync(ts, "go")).toBe(true);
		expect(await isAsync(ts, "m")).toBe(true); // nested async method

		const rs = createTempFile(env.tmpDir, "async.rs", "async fn go() {}\n");
		expect(await isAsync(rs, "go")).toBe(true);
	});

	it("read_enclosing resolves a Go goroutine body by line", async () => {
		const env = makeEnv();
		const go = createTempFile(
			env.tmpDir,
			"enclosing.go",
			[
				"package main",
				"",
				"func run() {",
				"	go func() {",
				'		println("inside goroutine")',
				"	}()",
				"}",
			].join("\n"),
		);

		// Line 5 is inside the goroutine closure body.
		const result = await readEnclosing(go, 5, env.tmpDir);
		expect(result.found).toBe(true);
		expect(result.kind).toBe("goroutine");
		expect(result.source).toContain("inside goroutine");
	});

	it("uses focus only to rank existing recommended reads", async () => {
		const env = makeEnv();
		const file = createTempFile(
			env.tmpDir,
			"callbacks.ts",
			[
				"export function run(ctx: any) {",
				"  return {",
				"    resetLSPService: () => {",
				"      ctx.ui.setStatus('x');",
				"    },",
				"  };",
				"}",
			].join("\n"),
		);

		const report = await moduleReport(file, env.tmpDir, {
			focus: "stale ctx idle reset",
		});

		expect(report.recommendedReads[0]).toMatchObject({
			symbol: "run.resetLSPService@3",
			offset: 3,
			limit: 3,
		});
		expect(report.recommendedReads[0]?.reason).toContain("matches focus");
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

	it("C/C++: resolves a local #include, buckets a system header external (#302)", async () => {
		const env = makeEnv();
		createTempFile(env.tmpDir, "foo.h", "int foo(void);\n");
		const file = createTempFile(
			env.tmpDir,
			"main.c",
			[
				'#include "foo.h"',
				"#include <stdio.h>",
				'#include "missing.h"',
				"int main(void) { return foo(); }",
			].join("\n"),
		);
		const report = await moduleReport(file, env.tmpDir);
		expect(report.language).toBe("cxx");
		expect(report.semantic.source).toBe("none"); // cold path
		// Local include resolves to the real header.
		expect(report.imports.internal).toContain("foo.h");
		// An unresolved local include stays internal by C convention (quoted form).
		expect(report.imports.internal).toContain("missing.h");
		// System header keeps its <> and is external.
		expect(report.imports.external).toContain("<stdio.h>");
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

describe("moduleReport — cross-file blast radius (#304)", () => {
	// dep ← mid ← top, function-wrapped so the review graph captures call edges.
	function makeChain(env: { tmpDir: string }) {
		createTempFile(
			env.tmpDir,
			"dep.ts",
			"export function foo(x: number): number {\n  return x + 1;\n}\n",
		);
		createTempFile(
			env.tmpDir,
			"mid.ts",
			'import { foo } from "./dep.js";\nexport function bar(): number {\n  return foo(1);\n}\n',
		);
		createTempFile(
			env.tmpDir,
			"top.ts",
			'import { bar } from "./mid.js";\nexport function baz(): number {\n  return bar();\n}\n',
		);
	}

	it("is omitted unless requested", async () => {
		const env = makeEnv();
		makeChain(env);
		await warmGraph(env.tmpDir);
		const report = await moduleReport("dep.ts", env.tmpDir);
		expect(report.blastRadius).toBeUndefined();
	});

	it("warm + requested: lists transitive dependents as ranked file reads", async () => {
		const env = makeEnv();
		makeChain(env);
		await warmGraph(env.tmpDir);
		const report = await moduleReport("dep.ts", env.tmpDir, {
			blastRadius: true,
		});
		expect(report.blastRadius).toBeDefined();
		const files = report.blastRadius?.files ?? [];
		const names = files.map((f) => f.file);
		// Direct dependent (mid) at depth 1; transitive dependent (top) deeper.
		expect(names).toContain("mid.ts");
		const mid = files.find((f) => f.file === "mid.ts");
		expect(mid?.minDepth).toBe(1);
		expect(mid?.dependents).toBeGreaterThanOrEqual(1);
		expect(mid?.relations.length).toBeGreaterThanOrEqual(1);
		// Ranked closest-first: the first entry is the shallowest.
		expect(files[0]?.minDepth).toBeLessThanOrEqual(
			files[files.length - 1]?.minDepth ?? 99,
		);
		// read args point at the dependent file (absolute machine path), offset 1.
		expect(mid?.read.offset).toBe(1);
		expect(path.isAbsolute(mid?.read.path ?? "")).toBe(true);
		// The module itself never appears in its own blast radius.
		expect(names).not.toContain("dep.ts");
	});

	it("cold cache + requested: section omitted, no build (read-only #256)", async () => {
		const env = makeEnv();
		makeChain(env);
		// No warmGraph() → cold. Requesting blast radius must NOT build a graph.
		const report = await moduleReport("dep.ts", env.tmpDir, {
			blastRadius: true,
		});
		expect(report.semantic.source).toBe("none"); // proves cold
		expect(report.blastRadius).toBeUndefined();
	});

	it("warm but nothing depends on the file: section omitted", async () => {
		const env = makeEnv();
		createTempFile(env.tmpDir, "lonely.ts", "export const solo = 1;\n");
		await warmGraph(env.tmpDir);
		const report = await moduleReport("lonely.ts", env.tmpDir, {
			blastRadius: true,
		});
		expect(report.blastRadius).toBeUndefined();
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

describe("readEnclosing — search/diagnostic line to exact body", () => {
	it("returns the smallest callback enclosing a line", async () => {
		const env = makeEnv();
		const file = createTempFile(
			env.tmpDir,
			"callbacks.ts",
			[
				"export function run(ctx: any) {",
				"  return {",
				"    resetLSPService: () => {",
				"      ctx.ui.setStatus('x');",
				"    },",
				"  };",
				"}",
			].join("\n"),
		);

		const result = await readEnclosing(file, 4, env.tmpDir);

		expect(result.found).toBe(true);
		expect(result.name).toBe("run.resetLSPService@3");
		expect(result.kind).toBe("object_property_callback");
		expect(result.startLine).toBe(3);
		expect(result.endLine).toBe(5);
		expect(result.source).toContain("ctx.ui.setStatus");
		expect(result.source).not.toContain("return {");
	});

	it("falls back to a named symbol when no callback encloses the line", async () => {
		const env = makeEnv();
		const file = createTempFile(
			env.tmpDir,
			"sample.py",
			"def outer():\n    value = 1\n    return value\n",
		);

		const result = await readEnclosing(file, 2, env.tmpDir);

		expect(result.found).toBe(true);
		expect(result.name).toBe("outer");
		expect(result.kind).toBe("function");
		expect(result.source).toContain("return value");
	});

	it("honors maxLines without returning oversized source", async () => {
		const env = makeEnv();
		const file = createTempFile(
			env.tmpDir,
			"sample.ts",
			"export function big() {\n  const a = 1;\n  const b = 2;\n  return a + b;\n}\n",
		);

		const result = await readEnclosing(file, 3, env.tmpDir, { maxLines: 2 });

		expect(result.found).toBe(false);
		expect(result.name).toBe("big");
		expect(result.error).toContain("above maxLines 2");
		expect(result.source).toBeUndefined();
	});

	it("can return a bounded slice when the enclosing body is oversized", async () => {
		const env = makeEnv();
		const file = createTempFile(
			env.tmpDir,
			"big-slice.ts",
			[
				"export function big() {",
				"  const a = 1;",
				"  const b = 2;",
				"  const c = 3;",
				"  return a + b + c;",
				"}",
			].join("\n"),
		);

		const result = await readEnclosing(file, 4, env.tmpDir, {
			maxLines: 2,
			onOversize: "slice",
			aroundLine: 3,
		});

		expect(result.found).toBe(true);
		expect(result.partial).toBe(true);
		expect(result.name).toBe("big");
		expect(result.startLine).toBe(3);
		expect(result.endLine).toBe(5);
		expect(result.enclosingStartLine).toBe(1);
		expect(result.enclosingEndLine).toBe(6);
		expect(result.selection?.strategy).toBe("oversize-slice");
		expect(result.source).toContain("const c = 3");
		expect(result.source).not.toContain("export function big");
	});

	it("can return a nested outline when the enclosing body is oversized", async () => {
		const env = makeEnv();
		const file = createTempFile(
			env.tmpDir,
			"big-outline.ts",
			[
				"export function big() {",
				"  function nested() {",
				"    return 1;",
				"  }",
				"  return nested();",
				"}",
			].join("\n"),
		);

		const result = await readEnclosing(file, 5, env.tmpDir, {
			maxLines: 2,
			onOversize: "outline",
		});

		expect(result.found).toBe(false);
		expect(result.name).toBe("big");
		expect(result.selection?.strategy).toBe("oversize-outline");
		expect(result.outline?.map((item) => item.name)).toContain("nested");
		expect(result.outline?.[0]?.read).toMatchObject({ offset: 2, limit: 3 });
		expect(result.source).toBeUndefined();
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

	it("returns the exact source lines of a module_report callback handle", async () => {
		const env = makeEnv();
		const file = createTempFile(
			env.tmpDir,
			"callbacks.ts",
			[
				"export async function run(ctx: any) {",
				"  await handleTurnEnd({",
				"    resetLSPService: () => {",
				"      ctx.ui.setStatus('x');",
				"    },",
				"  });",
				"}",
			].join("\n"),
		);
		const report = await moduleReport(file, env.tmpDir);
		const handle = report.callbacks.find(
			(callback) => callback.name === "run.resetLSPService@3",
		)?.name;
		expect(handle).toBeDefined();

		const result = await readSymbol(file, handle!, env.tmpDir);

		expect(result.found).toBe(true);
		expect(result.kind).toBe("object_property_callback");
		expect(result.startLine).toBe(3);
		expect(result.endLine).toBe(5);
		expect(result.source).toContain("resetLSPService");
		expect(result.source).toContain("ctx.ui.setStatus");
		expect(result.source).not.toContain("handleTurnEnd");
	});

	it("reports not-found for an unknown symbol", async () => {
		const env = makeEnv();
		createTempFile(env.tmpDir, "sample.ts", "export const x = 1;\n");
		const result = await readSymbol("sample.ts", "ghost", env.tmpDir);
		expect(result.found).toBe(false);
	});
});
