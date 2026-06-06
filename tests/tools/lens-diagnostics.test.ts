import { describe, expect, it, vi } from "vitest";
import { createLensDiagnosticsTool } from "../../tools/lens-diagnostics.js";

// ── Mock widget state ─────────────────────────────────────────────────────────

const mockSummaries: ReturnType<typeof import("../../clients/widget-state.js")["getFileDiagnosticSummaries"]> = [];

vi.mock("../../clients/widget-state.js", () => ({
	getFileDiagnosticSummaries: () => mockSummaries,
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeCacheManager(data: Record<string, unknown> = {}) {
	return {
		readCache: vi.fn((key: string) =>
			data[key] ? { data: data[key], meta: { savedAt: "", scanner: key } } : undefined,
		),
	};
}

function makeTool(cacheData: Record<string, unknown> = {}) {
	return createLensDiagnosticsTool(makeCacheManager(cacheData) as any, () => "/proj");
}

async function run(tool: ReturnType<typeof makeTool>, params: Record<string, unknown> = {}) {
	return tool.execute("1", params, new AbortController().signal, null, { cwd: "/proj" });
}

// ── schema ────────────────────────────────────────────────────────────────────

describe("lens_diagnostics schema", () => {
	it("exposes mode and severity parameters", () => {
		const tool = makeTool();
		const props = (tool.parameters as { properties: Record<string, unknown> }).properties;
		expect(props.mode).toBeDefined();
		expect(props.severity).toBeDefined();
	});

	it("defaults to delta mode when no params supplied", async () => {
		const cm = makeCacheManager({});
		const tool = createLensDiagnosticsTool(cm as any, () => "/proj");
		await tool.execute("1", {}, new AbortController().signal, null, { cwd: "/proj" });
		// readCache should have been called (delta path)
		expect(cm.readCache).toHaveBeenCalled();
	});

	it("does not call LSP — reads from cache only", async () => {
		// If the tool tried to probe LSP it would throw (no LSP service injected).
		// The fact that it completes without error proves it is cache-only.
		const result = await run(makeTool(), { mode: "all" });
		expect(result).toBeDefined();
	});
});

// ── delta mode ────────────────────────────────────────────────────────────────

describe("lens_diagnostics mode=delta", () => {
	it("returns clean message when caches are empty", async () => {
		const result = await run(makeTool());
		expect(String(result.content[0].text)).toContain("No");
		expect(result.details).toMatchObject({ mode: "delta" });
	});

	it("formats actionable warnings from cache", async () => {
		const tool = makeTool({
			"actionable-warnings": {
				files: [
					{
						filePath: "/proj/src/foo.ts",
						warnings: [
							{ line: 10, rule: "no-unused-vars", tool: "eslint", code: undefined, message: "x is unused" },
						],
					},
				],
				summary: { warnings: 1 },
			},
		});
		const result = await run(tool, { mode: "delta" });
		const text = String(result.content[0].text);
		expect(text).toContain("foo.ts");
		expect(text).toContain("L10");
		expect(text).toContain("x is unused");
	});

	it("formats code quality warnings from cache", async () => {
		const tool = makeTool({
			"code-quality-warnings": {
				files: [
					{
						filePath: "/proj/src/bar.ts",
						warnings: [
							{ line: 5, rule: "high-complexity", tool: "complexity", code: undefined, message: "cyclomatic complexity 20" },
						],
					},
				],
				summary: { warnings: 1 },
			},
		});
		const result = await run(tool, { mode: "delta" });
		const text = String(result.content[0].text);
		expect(text).toContain("bar.ts");
		expect(text).toContain("high-complexity");
	});

	it("combines actionable and quality warnings from both caches", async () => {
		const tool = makeTool({
			"actionable-warnings": {
				files: [{ filePath: "/proj/src/foo.ts", warnings: [{ line: 1, rule: "r1", tool: "t", message: "fixable" }] }],
				summary: { warnings: 1 },
			},
			"code-quality-warnings": {
				files: [{ filePath: "/proj/src/foo.ts", warnings: [{ line: 2, rule: "r2", tool: "t", message: "quality" }] }],
				summary: { warnings: 1 },
			},
		});
		const result = await run(tool, { mode: "delta" });
		const text = String(result.content[0].text);
		expect(text).toContain("fixable");
		expect(text).toContain("quality");
	});

	it("severity=error excludes warnings in delta mode", async () => {
		const tool = makeTool({
			"actionable-warnings": {
				files: [{ filePath: "/proj/src/foo.ts", warnings: [{ line: 1, rule: "r", tool: "t", message: "warn" }] }],
				summary: { warnings: 1 },
			},
		});
		const result = await run(tool, { mode: "delta", severity: "error" });
		const text = String(result.content[0].text);
		// No actionable warnings (they're warnings, not errors)
		expect(text).toContain("No error");
	});
});

// ── all mode ──────────────────────────────────────────────────────────────────

type Summary = (typeof mockSummaries)[number];
type Diag = Summary["diagnostics"][number];

function sum(
	filePath: string,
	counts: { blocking?: number; errors?: number; warnings?: number },
	opts: { hasFinalSnapshot?: boolean; diagnostics?: Diag[] } = {},
): Summary {
	return {
		filePath,
		blocking: counts.blocking ?? 0,
		errors: counts.errors ?? 0,
		warnings: counts.warnings ?? 0,
		hasFinalSnapshot: opts.hasFinalSnapshot ?? true,
		diagnostics: opts.diagnostics ?? [],
	};
}

describe("lens_diagnostics mode=all", () => {
	it("returns no-files message when widget state is empty", async () => {
		mockSummaries.length = 0;
		const result = await run(makeTool(), { mode: "all" });
		expect(String(result.content[0].text)).toContain("No files diagnosed");
	});

	it("returns clean message when all files have zero issues", async () => {
		mockSummaries.length = 0;
		mockSummaries.push(sum("/proj/src/clean.ts", {}));
		const result = await run(makeTool(), { mode: "all" });
		expect(String(result.content[0].text)).toContain("✓");
	});

	it("lists files with blocking errors first", async () => {
		mockSummaries.length = 0;
		mockSummaries.push(sum("/proj/src/warn.ts", { warnings: 2 }));
		mockSummaries.push(sum("/proj/src/error.ts", { blocking: 1, errors: 1 }));
		const result = await run(makeTool(), { mode: "all" });
		const text = String(result.content[0].text);
		expect(text.indexOf("error.ts")).toBeLessThan(text.indexOf("warn.ts"));
		expect(text).toContain("🔴");
	});

	it("severity=error filters to only error/blocking files", async () => {
		mockSummaries.length = 0;
		mockSummaries.push(sum("/proj/src/clean.ts", { warnings: 3 }));
		mockSummaries.push(sum("/proj/src/broken.ts", { blocking: 1 }));
		const result = await run(makeTool(), { mode: "all", severity: "error" });
		const text = String(result.content[0].text);
		expect(text).toContain("broken.ts");
		expect(text).not.toContain("clean.ts");
	});

	it("shows pending indicator for files without final snapshot", async () => {
		mockSummaries.length = 0;
		mockSummaries.push(sum("/proj/src/pending.ts", { errors: 1 }, { hasFinalSnapshot: false }));
		const result = await run(makeTool(), { mode: "all" });
		expect(String(result.content[0].text)).toContain("pending");
	});

	it("severity=warning excludes blocking/error-only files", async () => {
		mockSummaries.length = 0;
		mockSummaries.push(sum("/proj/a.ts", { blocking: 1 }));
		mockSummaries.push(sum("/proj/b.ts", { warnings: 2 }));
		const result = await run(makeTool(), { mode: "all", severity: "warning" });
		const text = String(result.content[0].text);
		expect(text).toContain("b.ts");
		expect(text).not.toContain("a.ts");
	});

	it("severity=all shows all issue types", async () => {
		mockSummaries.length = 0;
		mockSummaries.push(sum("/proj/a.ts", { blocking: 1, warnings: 2 }));
		const result = await run(makeTool(), { mode: "all", severity: "all" });
		const text = String(result.content[0].text);
		expect(text).toContain("a.ts");
		expect(text).toContain("🔴");
	});

	it("summary counts total blocking/errors/warnings", async () => {
		mockSummaries.length = 0;
		mockSummaries.push(sum("/proj/a.ts", { blocking: 1, errors: 2, warnings: 3 }));
		mockSummaries.push(sum("/proj/b.ts", { errors: 1, warnings: 1 }));
		const result = await run(makeTool(), { mode: "all" });
		expect(result.details).toMatchObject({ totalBlocking: 1, totalErrors: 3, totalWarnings: 4 });
	});

	// ── actual-message exposure (the point of the tool) ───────────────────────────

	it("lists the actual diagnostic messages, not just counts", async () => {
		mockSummaries.length = 0;
		mockSummaries.push(
			sum(
				"/proj/src/foo.ts",
				{ blocking: 1, warnings: 1 },
				{
					diagnostics: [
						{ severity: "error", semantic: "blocking", message: "Type 'string' is not assignable to 'number'", line: 12, rule: "ts2322", tool: "tsc" },
						{ severity: "warning", message: "Unexpected console statement", line: 30, rule: "no-console", tool: "eslint" },
					],
				},
			),
		);
		const result = await run(makeTool(), { mode: "all" });
		const text = String(result.content[0].text);
		expect(text).toContain("Type 'string' is not assignable to 'number'");
		expect(text).toContain("L12");
		expect(text).toContain("ts2322");
		expect(text).toContain("Unexpected console statement");
		expect(text).toContain("L30");
	});

	it("notes when a file has more diagnostics than the per-file storage cap", async () => {
		mockSummaries.length = 0;
		mockSummaries.push(
			sum(
				"/proj/src/big.ts",
				{ warnings: 20 },
				{
					diagnostics: [
						{ severity: "warning", message: "w1", line: 1, rule: "r" },
						{ severity: "warning", message: "w2", line: 2, rule: "r" },
					],
				},
			),
		);
		const result = await run(makeTool(), { mode: "all" });
		const text = String(result.content[0].text);
		expect(text).toContain("w1");
		expect(text).toMatch(/18 more not shown/);
	});

	it("severity=error hides warning messages but shows error messages", async () => {
		mockSummaries.length = 0;
		mockSummaries.push(
			sum(
				"/proj/src/mix.ts",
				{ blocking: 1, warnings: 1 },
				{
					diagnostics: [
						{ severity: "error", semantic: "blocking", message: "BOOM error here", line: 1, rule: "e" },
						{ severity: "warning", message: "minor warning here", line: 2, rule: "w" },
					],
				},
			),
		);
		const result = await run(makeTool(), { mode: "all", severity: "error" });
		const text = String(result.content[0].text);
		expect(text).toContain("BOOM error here");
		expect(text).not.toContain("minor warning here");
	});
});
