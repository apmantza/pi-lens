import { describe, expect, it } from "vitest";
import {
	createModuleReportTool,
	createReadEnclosingTool,
	createReadSymbolTool,
} from "../../tools/module-report.js";
import { createTempFile, setupTestEnvironment } from "../clients/test-utils.js";

// module_report is read-only (no graph build, no LSP — #256), so these tool
// tests need no LSP-disabling guard.

type Recorded = {
	filePath: string;
	symbol: { name: string; kind: string; startLine: number; endLine: number };
};

describe("module_report tool", () => {
	it("returns a navigable JSON report with derivable (not per-symbol) read args (outline)", async () => {
		const env = setupTestEnvironment("pi-lens-modreport-tool-");
		try {
			createTempFile(
				env.tmpDir,
				"sample.ts",
				"export function add(a: number, b: number): number {\n  return a + b;\n}\n",
			);
			const tool = createModuleReportTool(() => env.tmpDir);
			const result = await tool.execute(
				"1",
				{ path: "sample.ts" },
				undefined,
				null,
				{ cwd: env.tmpDir },
			);
			expect(result.isError).toBe(false);
			const report = JSON.parse(String(result.content[0]?.text));
			expect(report.available).toBe(true);
			const add = report.api.find((e: { name: string }) => e.name === "add") as
				| { name: string; startLine: number; endLine: number; read?: unknown }
				| undefined;
			expect(add).toBeTruthy();
			// No per-symbol `read` block (#512) — offset/limit are pure derivations
			// of startLine/endLine on the report's own `path`.
			expect(add?.read).toBeUndefined();
			expect(add?.startLine).toBeGreaterThan(0);
			expect(add?.endLine).toBeGreaterThanOrEqual(add?.startLine ?? 0);
		} finally {
			env.cleanup();
		}
	});

	it("passes through summary view", async () => {
		const env = setupTestEnvironment("pi-lens-modreport-tool-");
		try {
			createTempFile(
				env.tmpDir,
				"sample.ts",
				"export function add(a: number, b: number): number {\n  return a + b;\n}\n",
			);
			const tool = createModuleReportTool(() => env.tmpDir);
			const result = await tool.execute(
				"summary",
				{ path: "sample.ts", view: "summary" },
				undefined,
				null,
				{ cwd: env.tmpDir },
			);
			const report = JSON.parse(String(result.content[0]?.text));
			expect(report.view).toBe("summary");
			expect(report.provenance.symbols).toBe("syntax");
			expect(result.details.view).toBe("summary");
		} finally {
			env.cleanup();
		}
	});

	it("includes callback count in details", async () => {
		const env = setupTestEnvironment("pi-lens-modreport-tool-");
		try {
			createTempFile(
				env.tmpDir,
				"callbacks.ts",
				"export function run(ctx: any) {\n  return { resetLSPService: () => ctx.ui.setStatus('x') };\n}\n",
			);
			const tool = createModuleReportTool(() => env.tmpDir);
			const result = await tool.execute(
				"callbacks",
				{ path: "callbacks.ts", focus: "reset ctx" },
				undefined,
				null,
				{ cwd: env.tmpDir },
			);
			expect(result.details.callbacks).toBeGreaterThan(0);
			const report = JSON.parse(String(result.content[0]?.text));
			expect(report.callbacks[0].name).toContain("resetLSPService");
			expect(report.recommendedReads[0].symbol).toContain("resetLSPService");
		} finally {
			env.cleanup();
		}
	});

	it("reports isError for a non-symbol-bearing file", async () => {
		const env = setupTestEnvironment("pi-lens-modreport-tool-");
		try {
			createTempFile(env.tmpDir, "data.json", "{}\n");
			const tool = createModuleReportTool(() => env.tmpDir);
			const result = await tool.execute(
				"1",
				{ path: "data.json" },
				undefined,
				null,
				{ cwd: env.tmpDir },
			);
			expect(result.isError).toBe(true);
		} finally {
			env.cleanup();
		}
	});
});

describe("read_enclosing tool", () => {
	it("returns the enclosing callback body and records read coverage", async () => {
		const env = setupTestEnvironment("pi-lens-readenc-tool-");
		try {
			createTempFile(
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
			const recorded: Recorded[] = [];
			const tool = createReadEnclosingTool(
				() => env.tmpDir,
				(filePath, symbol) => recorded.push({ filePath, symbol }),
			);

			const result = await tool.execute(
				"read-enclosing",
				{ path: "callbacks.ts", line: 4 },
				undefined,
				null,
				{ cwd: env.tmpDir },
			);

			expect(result.isError).toBeUndefined();
			expect(String(result.content[0]?.text)).toContain("ctx.ui.setStatus");
			expect(recorded).toHaveLength(1);
			expect(recorded[0].symbol).toMatchObject({
				name: "run.resetLSPService@3",
				kind: "object_property_callback",
				startLine: 3,
				endLine: 5,
			});
			expect(result.details).toMatchObject({ readRecorded: true });
		} finally {
			env.cleanup();
		}
	});

	it("returns a helpful error for oversized enclosing ranges", async () => {
		const env = setupTestEnvironment("pi-lens-readenc-tool-");
		try {
			createTempFile(
				env.tmpDir,
				"sample.ts",
				"export function big() {\n  const a = 1;\n  const b = 2;\n  return a + b;\n}\n",
			);
			const tool = createReadEnclosingTool(
				() => env.tmpDir,
				() => undefined,
			);

			const result = await tool.execute(
				"read-enclosing",
				{ path: "sample.ts", line: 3, maxLines: 2 },
				undefined,
				null,
				{ cwd: env.tmpDir },
			);

			expect(result.isError).toBe(true);
			expect(String(result.content[0]?.text)).toContain("above maxLines 2");
			expect(result.details).toMatchObject({
				found: false,
				name: "big",
				kind: "function",
				startLine: 1,
				endLine: 5,
			});
		} finally {
			env.cleanup();
		}
	});

	it("returns and records a partial slice for oversized enclosing ranges", async () => {
		const env = setupTestEnvironment("pi-lens-readenc-tool-");
		try {
			createTempFile(
				env.tmpDir,
				"sample.ts",
				"export function big() {\n  const a = 1;\n  const b = 2;\n  const c = 3;\n  return a + b + c;\n}\n",
			);
			const recorded: Recorded[] = [];
			const tool = createReadEnclosingTool(
				() => env.tmpDir,
				(filePath, symbol) => recorded.push({ filePath, symbol }),
			);

			const result = await tool.execute(
				"read-enclosing",
				{
					path: "sample.ts",
					line: 4,
					maxLines: 2,
					onOversize: "slice",
					aroundLine: 3,
				},
				undefined,
				null,
				{ cwd: env.tmpDir },
			);

			expect(result.isError).toBeUndefined();
			expect(String(result.content[0]?.text)).toContain("partial of 1-6");
			expect(String(result.content[0]?.text)).not.toContain(
				"export function big",
			);
			expect(result.details).toMatchObject({
				found: true,
				partial: true,
				startLine: 3,
				endLine: 5,
				enclosingStartLine: 1,
				enclosingEndLine: 6,
				readRecorded: true,
			});
			expect(recorded[0].symbol).toMatchObject({
				name: "big",
				startLine: 3,
				endLine: 5,
			});
		} finally {
			env.cleanup();
		}
	});
});

describe("read_symbol tool", () => {
	it("returns the symbol body and fires the read-guard tie-in with its range", async () => {
		const env = setupTestEnvironment("pi-lens-readsym-tool-");
		try {
			createTempFile(
				env.tmpDir,
				"sample.ts",
				"const noise = 1;\nexport function target(n: number): number {\n  return n * 2;\n}\n",
			);
			const recorded: Recorded[] = [];
			const tool = createReadSymbolTool(
				() => env.tmpDir,
				(filePath, symbol) => recorded.push({ filePath, symbol }),
			);
			const result = await tool.execute(
				"1",
				{ path: "sample.ts", symbol: "target" },
				undefined,
				null,
				{ cwd: env.tmpDir },
			);
			expect(result.isError).toBeUndefined();
			const text = String(result.content[0]?.text);
			expect(text).toContain("export function target");
			expect(text).not.toContain("const noise");
			// Tie-in fired exactly once with the symbol's resolved range.
			expect(recorded).toHaveLength(1);
			expect(recorded[0].symbol.name).toBe("target");
			expect(recorded[0].symbol.startLine).toBe(2);
			expect(recorded[0].symbol.endLine).toBe(4);
			expect(result.details).toMatchObject({ readRecorded: true });
		} finally {
			env.cleanup();
		}
	});

	it("still returns the body when read-guard recording throws", async () => {
		const env = setupTestEnvironment("pi-lens-readsym-tool-");
		try {
			createTempFile(
				env.tmpDir,
				"sample.ts",
				"export function target(): number {\n  return 1;\n}\n",
			);
			const tool = createReadSymbolTool(
				() => env.tmpDir,
				() => {
					throw new Error("record failed");
				},
			);
			const result = await tool.execute(
				"1",
				{ path: "sample.ts", symbol: "target" },
				undefined,
				null,
				{ cwd: env.tmpDir },
			);
			expect(result.isError).toBeUndefined();
			expect(String(result.content[0]?.text)).toContain("return 1");
			expect(result.details).toMatchObject({ readRecorded: false });
		} finally {
			env.cleanup();
		}
	});

	it("reads callback handles and records them as read-guard coverage", async () => {
		const env = setupTestEnvironment("pi-lens-readsym-tool-");
		try {
			createTempFile(
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
			const recorded: Recorded[] = [];
			const tool = createReadSymbolTool(
				() => env.tmpDir,
				(filePath, symbol) => recorded.push({ filePath, symbol }),
			);
			const result = await tool.execute(
				"callback",
				{ path: "callbacks.ts", symbol: "run.resetLSPService@3" },
				undefined,
				null,
				{ cwd: env.tmpDir },
			);
			expect(result.isError).toBeUndefined();
			expect(String(result.content[0]?.text)).toContain("ctx.ui.setStatus");
			expect(recorded).toHaveLength(1);
			expect(recorded[0].symbol).toMatchObject({
				name: "run.resetLSPService@3",
				kind: "object_property_callback",
				startLine: 3,
				endLine: 5,
			});
			expect(result.details).toMatchObject({ readRecorded: true });
		} finally {
			env.cleanup();
		}
	});

	it("does NOT record a guard read when the symbol is missing", async () => {
		const env = setupTestEnvironment("pi-lens-readsym-tool-");
		try {
			createTempFile(env.tmpDir, "sample.ts", "export const x = 1;\n");
			const recorded: Recorded[] = [];
			const tool = createReadSymbolTool(
				() => env.tmpDir,
				(filePath, symbol) => recorded.push({ filePath, symbol }),
			);
			const result = await tool.execute(
				"1",
				{ path: "sample.ts", symbol: "ghost" },
				undefined,
				null,
				{ cwd: env.tmpDir },
			);
			expect(result.isError).toBe(true);
			expect(recorded).toHaveLength(0);
		} finally {
			env.cleanup();
		}
	});

	it("extends the recorded read-guard range to cover an attached doc comment (#523)", async () => {
		const env = setupTestEnvironment("pi-lens-readsym-tool-");
		try {
			createTempFile(
				env.tmpDir,
				"sample.ts",
				[
					"/**", // 1
					" * Whether agent nudges are enabled for this session.", // 2
					" */", // 3
					"export function isAgentNudgeEnabled(): boolean {", // 4
					"  return true;", // 5
					"}", // 6
				].join("\n"),
			);
			const recorded: Recorded[] = [];
			const tool = createReadSymbolTool(
				() => env.tmpDir,
				(filePath, symbol) => recorded.push({ filePath, symbol }),
			);
			const result = await tool.execute(
				"1",
				{ path: "sample.ts", symbol: "isAgentNudgeEnabled" },
				undefined,
				null,
				{ cwd: env.tmpDir },
			);
			expect(result.isError).toBeUndefined();
			expect(String(result.content[0]?.text)).toContain(
				"Whether agent nudges are enabled",
			);
			expect(recorded).toHaveLength(1);
			// Coverage starts at the comment, not the declaration line.
			expect(recorded[0].symbol.startLine).toBe(1);
			expect(recorded[0].symbol.endLine).toBe(6);
		} finally {
			env.cleanup();
		}
	});

	it("embeds did-you-mean suggestions in the miss response (#523)", async () => {
		const env = setupTestEnvironment("pi-lens-readsym-tool-");
		try {
			createTempFile(
				env.tmpDir,
				"sample.ts",
				"export function isAgentNudgeEnabled(): boolean {\n  return true;\n}\n",
			);
			const tool = createReadSymbolTool(
				() => env.tmpDir,
				() => {},
			);
			const result = await tool.execute(
				"1",
				{ path: "sample.ts", symbol: "isAgentNudgeEnable" },
				undefined,
				null,
				{ cwd: env.tmpDir },
			);
			expect(result.isError).toBe(true);
			expect((result.details as { suggestions?: string[] }).suggestions).toContain(
				"isAgentNudgeEnabled",
			);
			expect(String(result.content[0]?.text)).toContain("Did you mean");
		} finally {
			env.cleanup();
		}
	});

	it("resolves a Class.method qualified name to the member's body (#523)", async () => {
		const env = setupTestEnvironment("pi-lens-readsym-tool-");
		try {
			createTempFile(
				env.tmpDir,
				"sample.ts",
				[
					"export class Foo {",
					"  bar(): number {",
					"    return 1;",
					"  }",
					"}",
					"",
					"export class Baz {",
					"  bar(): number {",
					"    return 2;",
					"  }",
					"}",
				].join("\n"),
			);
			const tool = createReadSymbolTool(
				() => env.tmpDir,
				() => {},
			);
			const result = await tool.execute(
				"1",
				{ path: "sample.ts", symbol: "Baz.bar" },
				undefined,
				null,
				{ cwd: env.tmpDir },
			);
			expect(result.isError).toBeUndefined();
			const text = String(result.content[0]?.text);
			expect(text).toContain("return 2;");
			expect(text).not.toContain("return 1;");
		} finally {
			env.cleanup();
		}
	});

	it("notes ambiguity for a duplicate name and resolves it via kind (#523)", async () => {
		const env = setupTestEnvironment("pi-lens-readsym-tool-");
		try {
			createTempFile(
				env.tmpDir,
				"sample.ts",
				[
					"export interface Foo {",
					"  id: number;",
					"}",
					"",
					"export function Foo(): void {}",
				].join("\n"),
			);
			const tool = createReadSymbolTool(
				() => env.tmpDir,
				() => {},
			);

			const ambiguous = await tool.execute(
				"1",
				{ path: "sample.ts", symbol: "Foo" },
				undefined,
				null,
				{ cwd: env.tmpDir },
			);
			expect(ambiguous.isError).toBeUndefined();
			const ambiguousDetails = ambiguous.details as {
				kind?: string;
				ambiguous?: { count: number; kinds: string[] };
			};
			expect(ambiguousDetails.ambiguous).toMatchObject({ count: 2 });
			expect(String(ambiguous.content[0]?.text)).toContain("pass `kind`");

			const disambiguated = await tool.execute(
				"2",
				{ path: "sample.ts", symbol: "Foo", kind: "function" },
				undefined,
				null,
				{ cwd: env.tmpDir },
			);
			const disambiguatedDetails = disambiguated.details as {
				kind?: string;
				ambiguous?: { count: number; kinds: string[] };
			};
			expect(disambiguatedDetails.kind).toBe("function");
			expect(disambiguatedDetails.ambiguous).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});
});
