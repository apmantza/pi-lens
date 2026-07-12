import { afterEach, describe, expect, it } from "vitest";
import { moduleReport } from "../../clients/module-report.js";
import type { ModuleSymbolEntry } from "../../clients/module-report.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

// module_report (#325): middle-man / delegate-only class detection is a
// structural pass over the already-extracted outline (not an ast-grep rule —
// see #325 for why existence-matching can't soundly express "EVERY method is
// a pure forward"). These tests exercise the flag end-to-end through
// moduleReport rather than unit-testing middle-man-analysis.ts in isolation,
// since the real risk (per the issue) is false positives on legitimate
// forwarding layers reachable only through the full extraction pipeline
// (nested members, signatures, review-graph-free cold path).

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length) cleanups.pop()?.();
});

function makeEnv(prefix = "pi-lens-middleman-") {
	const env = setupTestEnvironment(prefix);
	cleanups.push(env.cleanup);
	return env;
}

function findClass(
	entries: ModuleSymbolEntry[],
	name: string,
): ModuleSymbolEntry | undefined {
	return entries.find((e) => e.name === name && e.kind === "class");
}

describe("middle-man / delegate-only class detection (#325)", () => {
	it("flags a class whose every method is a pure forward to one held field", async () => {
		const env = makeEnv();
		const file = createTempFile(
			env.tmpDir,
			"middleman.ts",
			[
				"class RealThing {",
				"  doWork(a: number, b: number): number { return a + b; }",
				"  ping(): void {}",
				"  save(x: string): void {}",
				"}",
				"",
				"export class ThingHandle {",
				"  private inner: RealThing;",
				"  constructor(inner: RealThing) { this.inner = inner; }",
				"  doWork(a: number, b: number): number {",
				"    return this.inner.doWork(a, b);",
				"  }",
				"  ping(): void {",
				"    this.inner.ping();",
				"  }",
				"  save(x: string): void {",
				"    this.inner.save(x);",
				"  }",
				"}",
			].join("\n"),
		);

		const report = await moduleReport(file, env.tmpDir);
		const handle = findClass([...report.api, ...report.internal], "ThingHandle");

		expect(handle).toBeDefined();
		expect(handle?.flags).toContain("middle man");
		expect(handle?.delegationRatio).toBe(1);
	});

	it("does not flag a small class with only one forwarding method (too few methods to judge)", async () => {
		const env = makeEnv();
		const file = createTempFile(
			env.tmpDir,
			"tiny.ts",
			[
				"export class TinyHandle {",
				"  private inner: { doWork(a: number): number };",
				"  doWork(a: number): number {",
				"    return this.inner.doWork(a);",
				"  }",
				"}",
			].join("\n"),
		);

		const report = await moduleReport(file, env.tmpDir);
		const handle = findClass([...report.api, ...report.internal], "TinyHandle");

		expect(handle).toBeDefined();
		expect(handle?.flags ?? []).not.toContain("middle man");
	});

	it("does not flag a class with real logic alongside a couple of forwarding convenience methods", async () => {
		const env = makeEnv();
		const file = createTempFile(
			env.tmpDir,
			"mixed.ts",
			[
				"export class OrderService {",
				"  private repo: { save(o: unknown): void; find(id: string): unknown };",
				"",
				"  save(o: unknown): void {",
				"    this.repo.save(o);",
				"  }",
				"",
				"  find(id: string): unknown {",
				"    return this.repo.find(id);",
				"  }",
				"",
				"  validate(order: { total: number }): boolean {",
				"    if (order.total < 0) return false;",
				"    let ok = true;",
				"    for (let i = 0; i < 3; i++) {",
				"      if (order.total > 1000 * i) ok = ok && true;",
				"    }",
				"    return ok;",
				"  }",
				"",
				"  summarize(order: { total: number }): string {",
				"    const tax = order.total * 0.2;",
				"    return `total=${order.total} tax=${tax}`;",
				"  }",
				"}",
			].join("\n"),
		);

		const report = await moduleReport(file, env.tmpDir);
		const svc = findClass([...report.api, ...report.internal], "OrderService");

		expect(svc).toBeDefined();
		expect(svc?.flags ?? []).not.toContain("middle man");
	});

	it("guards named facade/adapter/proxy/wrapper classes even at 100% delegation", async () => {
		const env = makeEnv();
		const names = ["ApiAdapter", "ConfigFacade", "LoggingProxy", "HttpWrapper"];
		for (const name of names) {
			const file = createTempFile(
				env.tmpDir,
				`${name}.ts`,
				[
					`export class ${name} {`,
					"  private inner: { doWork(a: number): number; ping(): void };",
					"  doWork(a: number): number {",
					"    return this.inner.doWork(a);",
					"  }",
					"  ping(): void {",
					"    this.inner.ping();",
					"  }",
					"}",
				].join("\n"),
			);

			const report = await moduleReport(file, env.tmpDir);
			const cls = findClass([...report.api, ...report.internal], name);
			expect(cls, `${name} should be extracted`).toBeDefined();
			expect(
				cls?.flags ?? [],
				`${name} is a named forwarding pattern and must not be flagged`,
			).not.toContain("middle man");
		}
	});

	it("guards a class that structurally implements an interface (typed adapter shape)", async () => {
		const env = makeEnv();
		const file = createTempFile(
			env.tmpDir,
			"typed-adapter.ts",
			[
				"interface Store {",
				"  doWork(a: number): number;",
				"  ping(): void;",
				"}",
				"",
				"export class StoreImpl implements Store {",
				"  private inner: Store;",
				"  doWork(a: number): number {",
				"    return this.inner.doWork(a);",
				"  }",
				"  ping(): void {",
				"    this.inner.ping();",
				"  }",
				"}",
			].join("\n"),
		);

		const report = await moduleReport(file, env.tmpDir);
		const cls = findClass([...report.api, ...report.internal], "StoreImpl");

		expect(cls).toBeDefined();
		expect(cls?.flags ?? []).not.toContain("middle man");
	});

	it("does not flag when forwards target more than one held field", async () => {
		const env = makeEnv();
		const file = createTempFile(
			env.tmpDir,
			"two-fields.ts",
			[
				"export class SplitHandle {",
				"  private a: { doWork(x: number): number };",
				"  private b: { ping(): void; save(x: string): void };",
				"  doWork(x: number): number {",
				"    return this.a.doWork(x);",
				"  }",
				"  ping(): void {",
				"    this.b.ping();",
				"  }",
				"  save(x: string): void {",
				"    this.b.save(x);",
				"  }",
				"}",
			].join("\n"),
		);

		const report = await moduleReport(file, env.tmpDir);
		const handle = findClass([...report.api, ...report.internal], "SplitHandle");

		expect(handle).toBeDefined();
		expect(handle?.flags ?? []).not.toContain("middle man");
	});

	it("does not flag when a forwarding call transforms/reorders arguments", async () => {
		const env = makeEnv();
		const file = createTempFile(
			env.tmpDir,
			"transforms.ts",
			[
				"export class TransformHandle {",
				"  private inner: { doWork(a: number, b: number): number };",
				"  doWork(a: number, b: number): number {",
				"    return this.inner.doWork(b, a);",
				"  }",
				"  compute(a: number, b: number): number {",
				"    if (a > b) return a - b;",
				"    return b - a;",
				"  }",
				"}",
			].join("\n"),
		);

		const report = await moduleReport(file, env.tmpDir);
		const handle = findClass([...report.api, ...report.internal], "TransformHandle");

		expect(handle).toBeDefined();
		expect(handle?.flags ?? []).not.toContain("middle man");
	});

	it("excludes accessors (getters/setters) from the delegation ratio", async () => {
		const env = makeEnv();
		const file = createTempFile(
			env.tmpDir,
			"accessors.ts",
			[
				"export class Handle {",
				"  private inner: { doWork(a: number): number; ping(): void };",
				"  get value(): number { return 42; }",
				"  set value(v: number) { /* noop */ }",
				"  doWork(a: number): number {",
				"    return this.inner.doWork(a);",
				"  }",
				"  ping(): void {",
				"    this.inner.ping();",
				"  }",
				"}",
			].join("\n"),
		);

		const report = await moduleReport(file, env.tmpDir);
		const handle = findClass([...report.api, ...report.internal], "Handle");

		expect(handle).toBeDefined();
		expect(handle?.flags).toContain("middle man");
	});

	it("flags a Python class whose every method is a pure forward via self.field", async () => {
		const env = makeEnv();
		const file = createTempFile(
			env.tmpDir,
			"middleman.py",
			[
				"class ThingHandle:",
				"    def __init__(self, inner):",
				"        self.inner = inner",
				"",
				"    def do_work(self, a, b):",
				"        return self.inner.do_work(a, b)",
				"",
				"    def ping(self):",
				"        self.inner.ping()",
				"",
			].join("\n"),
		);

		const report = await moduleReport(file, env.tmpDir);
		const handle = findClass([...report.api, ...report.internal], "ThingHandle");

		expect(handle).toBeDefined();
		expect(handle?.flags).toContain("middle man");
	});
});
