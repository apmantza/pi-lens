import { captureComplexityBaseline } from "../../clients/metrics/complexity-baseline.js";
import * as containment from "../../clients/symbol-containment.js";
import { MAX_MEASURED_BYTES } from "../../clients/metrics/complexity-baseline.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComplexityClient } from "../../clients/complexity-client.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

const client = new ComplexityClient();
const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length) cleanups.pop()?.();
});

async function analyze(name: string, src: string) {
	const env = setupTestEnvironment("pi-lens-cx-");
	cleanups.push(env.cleanup);
	const file = createTempFile(env.tmpDir, name, src);
	return client.analyzeFile(file);
}

describe("ComplexityClient.isSupportedFile", () => {
	it.each([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cts", ".py", ".go", ".rs"])(
		"supports %s",
		(ext) => {
			expect(client.isSupportedFile(`src/f${ext}`)).toBe(true);
		},
	);
	it.each([".md", ".txt", ".json", ".css"])("does not support %s", (ext) => {
		expect(client.isSupportedFile(`src/f${ext}`)).toBe(false);
	});
});

describe("ComplexityClient.analyzeFile — JS/TS", () => {
	it("assigns first-touch keys only when the delta baseline is read", async () => {
		const keying = vi.spyOn(containment, "buildQualifiedName");
		try {
			const measured = await analyze(
				"lazy.ts",
				"class A {\n f() { return 1; }\n}\n",
			);
			const baseline = captureComplexityBaseline(measured?.measuredFunctions);
			expect(measured?.functionCount).toBe(1);
			expect(keying).toHaveBeenCalledTimes(0);
			expect([...baseline.last!.keys()]).toEqual(["A.f"]);
			expect(keying).toHaveBeenCalledTimes(1);
			expect([...baseline.last!.keys()]).toEqual(["A.f"]);
			expect(keying).toHaveBeenCalledTimes(1);
		} finally {
			keying.mockRestore();
		}
	});

	it("keeps first-touch keys at the byte cap and skips them above it", async () => {
		// V1: read first touches used to key files beyond the edit-path cap.
		const body = "function f() { return 1; }\n//";
		const atCap =
			body + "x".repeat(MAX_MEASURED_BYTES - Buffer.byteLength(body));
		const measured = await analyze("at-cap.ts", atCap);
		const keying = vi.spyOn(containment, "buildQualifiedName");
		let skipped;
		try {
			skipped = await analyze("above-cap.ts", atCap.slice(0, -1) + "é");
			expect(keying).toHaveBeenCalledTimes(0);
		} finally {
			keying.mockRestore();
		}
		expect(measured?.measuredFunctions?.map((f) => f.key)).toEqual(["f"]);
		expect(skipped?.functionCount).toBe(1);
		expect(skipped?.maxCyclomaticComplexity).toBe(1);
		expect(skipped?.measuredFunctions).toBeUndefined();
	});

	it("keeps JS/TS cyclomatic contributions zero-based", async () => {
		const noDecision = await analyze(
			"no-decision.ts",
			"function f() { return 1; }\n",
		);
		const oneDecision = await analyze(
			"one-decision.ts",
			"function f(n: number) { if (n) return 1; return 0; }\n",
		);

		expect(noDecision!.functions[0]?.cyclomatic).toBe(0);
		expect(oneDecision!.functions[0]?.cyclomatic).toBe(1);
	});

	it("computes cyclomatic / cognitive / nesting / MI for a TS function", async () => {
		const m = await analyze(
			"a.ts",
			`function f(n: number) {\n  if (n > 0 && n < 10) { for (const i of xs) { if (i) return 1; } }\n  return n ? 1 : 2;\n}\n`,
		);
		expect(m).not.toBeNull();
		expect(m!.functionCount).toBe(1);
		// if + && + for-of + if + ternary = 5
		expect(m!.maxCyclomaticComplexity).toBe(5);
		expect(m!.cognitiveComplexity).toBeGreaterThan(0);
		expect(m!.maxNestingDepth).toBeGreaterThanOrEqual(3);
		expect(m!.maintainabilityIndex).toBeGreaterThanOrEqual(0);
		expect(m!.maintainabilityIndex).toBeLessThanOrEqual(100);
		// Halstead was dropped.
		expect("halsteadVolume" in m!).toBe(false);
	});

	it("counts try/catch and multiple functions", async () => {
		const m = await analyze(
			"b.ts",
			`function a() { try { risky(); } catch (e) {} }\nconst b = () => 1;\n`,
		);
		expect(m!.functionCount).toBe(2);
		expect(m!.tryCatchCount).toBe(1);
	});
});

describe("ComplexityClient.analyzeFile — language-agnostic", () => {
	it("python: boolean_operator + match + conditional counted", async () => {
		const m = await analyze(
			"c.py",
			`def foo(a, b):\n    if a and b:\n        for i in x:\n            if i: return 1\n    return 1 if a else 2\n`,
		);
		expect(m).not.toBeNull();
		expect(m!.functionCount).toBe(1);
		// if + and + for + if + conditional = 5
		expect(m!.maxCyclomaticComplexity).toBe(5);
		expect(m!.tryCatchCount).toBe(0);
	});

	it("go: switch case counted, no try/catch", async () => {
		const m = await analyze(
			"d.go",
			`func foo(a int) int {\n\tif a > 0 && a < 9 { for i := 0; i < a; i++ {} }\n\tswitch a { case 1: }\n\treturn 0\n}\n`,
		);
		expect(m).not.toBeNull();
		expect(m!.functionCount).toBe(1);
		expect(m!.tryCatchCount).toBe(0);
		expect(m!.maxCyclomaticComplexity).toBeGreaterThanOrEqual(3);
	});

	it("rust: match arms counted, no try/catch", async () => {
		const m = await analyze(
			"e.rs",
			`fn foo(a: i32) -> i32 {\n\tif a > 0 && a < 9 { for i in 0..a {} }\n\tmatch a { 1 => 1, _ => 0 }\n}\n`,
		);
		expect(m).not.toBeNull();
		expect(m!.functionCount).toBe(1);
		expect(m!.tryCatchCount).toBe(0);
		expect(m!.maxCyclomaticComplexity).toBeGreaterThanOrEqual(3);
	});
});

describe("ComplexityClient.analyzeFile — degradation", () => {
	it("returns null for unsupported languages", async () => {
		expect(await analyze("f.md", "# hello\n")).toBeNull();
	});
	it("returns null, not zeros, for a code language with no metrics table", async () => {
		expect(
			await analyze("F.java", "class F { int f() { return 1; } }\n"),
		).toBeNull();
	});
	it("returns null for a non-existent file", async () => {
		expect(await client.analyzeFile("/nope/does-not-exist.ts")).toBeNull();
	});
});
