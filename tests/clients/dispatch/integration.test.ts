/**
 * Dispatch Integration Tests
 *
 * Tests dispatchLintWithResult, shouldDispatch, and getAvailableRunners
 * with mocked dispatcher to avoid real tool spawning.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	dispatchLintWithResult,
	getAvailableRunners,
	resetDispatchBaselines,
	shouldDispatch,
} from "../../../clients/dispatch/integration.js";
import { normalizeMapKey } from "../../../clients/path-utils.js";

// Mock dispatcher internals to avoid real runner execution. createDispatchContext
// is wrapped (not replaced) — real implementation, but call-args are now
// observable via vi.mocked(createDispatchContext).mock.calls. This is what
// closes the options->createDispatchContext positional passthrough hop
// (integration.ts:2202-2213): dispatchForFile being fully mocked meant a
// severed telemetryModel/telemetryProvider passthrough there went unnoticed
// by every existing case in this file.
vi.mock("../../../clients/dispatch/dispatcher.js", async (importOriginal) => {
	const mod =
		await importOriginal<
			typeof import("../../../clients/dispatch/dispatcher.js")
		>();
	return {
		...mod,
		dispatchForFile: vi.fn(),
		createDispatchContext: vi.fn(mod.createDispatchContext),
	};
});

vi.mock("../../../clients/dispatch/fact-runner.js", async (importOriginal) => {
	const mod =
		await importOriginal<
			typeof import("../../../clients/dispatch/fact-runner.js")
		>();
	return {
		...mod,
		runProviders: vi.fn(),
	};
});

import {
	createDispatchContext,
	dispatchForFile,
} from "../../../clients/dispatch/dispatcher.js";
import { runProviders } from "../../../clients/dispatch/fact-runner.js";
import { getFactStoreEvictionReporter } from "../../../clients/dispatch/fact-store.js";

const emptyDispatchResult = {
	diagnostics: [],
	blockers: [],
	warnings: [],
	baselineWarningCount: 0,
	fixed: [],
	resolvedCount: 0,
	output: "",
	blockerOutput: "",
	hasBlockers: false,
};

describe("Dispatch Integration", () => {
	beforeEach(() => {
		resetDispatchBaselines();
		vi.mocked(dispatchForFile).mockReset();
		vi.mocked(dispatchForFile).mockResolvedValue(emptyDispatchResult);
		vi.mocked(runProviders).mockReset();
		vi.mocked(createDispatchContext).mockClear();
	});

	describe("dispatchLintWithResult", () => {
		it("classifies Helm YAML only when dispatch can discover a chart root", async () => {
			const root = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-dispatch-helm-"),
			);
			try {
				const ordinary = path.join(root, "service", "templates", "route.yaml");
				const nested = path.join(
					root,
					"service",
					"templates",
					"nested",
					"route.yml",
				);
				const chart = path.join(root, "chart");
				const chartFile = path.join(chart, "templates", "deployment.yaml");
				const literalBackslash = path.join(chart, "templates\\deployment.yaml");
				fs.mkdirSync(path.dirname(ordinary), { recursive: true });
				fs.mkdirSync(path.dirname(nested), { recursive: true });
				fs.mkdirSync(path.dirname(chartFile), { recursive: true });
				fs.writeFileSync(ordinary, "kind: Service\n");
				fs.writeFileSync(nested, "kind: Route\n");
				fs.writeFileSync(path.join(chart, "Chart.yaml"), "apiVersion: v2\n");
				fs.writeFileSync(chartFile, "kind: Deployment\n");
				fs.writeFileSync(literalBackslash, "kind: Deployment\n");
				const relativeChartFile = path.relative(root, chartFile);

				for (const file of [
					ordinary,
					nested,
					chartFile,
					relativeChartFile,
					literalBackslash,
				]) {
					await dispatchLintWithResult(file, root, { getFlag: () => false });
				}

				const kinds = vi
					.mocked(dispatchForFile)
					.mock.calls.map(([context]) => context.kind);
				expect(kinds).toEqual([
					"yaml",
					"yaml",
					"helm-template",
					"helm-template",
					"yaml",
				]);
			} finally {
				fs.rmSync(root, { recursive: true, force: true });
			}
		});

		it("returns empty result for unsupported file kind", async () => {
			const result = await dispatchLintWithResult("data.csv", "/project", {
				getFlag: () => false,
			});

			expect(result.diagnostics).toEqual([]);
			expect(result.hasBlockers).toBe(false);
			expect(result.output).toBe("");
		});

		it("returns empty result when no dispatch groups match", async () => {
			const result = await dispatchLintWithResult("unknown.xyz", "/project", {
				getFlag: () => false,
			});

			expect(result.diagnostics).toEqual([]);
			expect(result.hasBlockers).toBe(false);
			expect(result.output).toBe("");
		});

		it("calls dispatchForFile and returns its result", async () => {
			vi.mocked(dispatchForFile).mockResolvedValue({
				diagnostics: [
					{
						id: "test-1",
						message: "Test error",
						filePath: "app.ts",
						line: 1,
						severity: "error",
						semantic: "blocking",
						tool: "tsc",
					},
				],
				blockers: [
					{
						id: "test-1",
						message: "Test error",
						filePath: "app.ts",
						line: 1,
						severity: "error",
						semantic: "blocking",
						tool: "tsc",
					},
				],
				warnings: [],
				baselineWarningCount: 0,
				fixed: [],
				resolvedCount: 0,
				output: "Test error at line 1",
				blockerOutput: "",
				hasBlockers: true,
			});

			const result = await dispatchLintWithResult("app.ts", "/project", {
				getFlag: () => false,
			});

			expect(runProviders).toHaveBeenCalled();
			expect(dispatchForFile).toHaveBeenCalled();
			expect(result.hasBlockers).toBe(true);
			expect(result.output).toBe("Test error at line 1");
			expect(result.diagnostics).toHaveLength(1);
		});

		it("returns result with warnings but no blockers", async () => {
			vi.mocked(dispatchForFile).mockResolvedValue({
				diagnostics: [
					{
						id: "warn-1",
						message: "Unused import",
						filePath: "app.ts",
						line: 1,
						severity: "warning",
						semantic: "warning",
						tool: "biome",
					},
				],
				blockers: [],
				warnings: [
					{
						id: "warn-1",
						message: "Unused import",
						filePath: "app.ts",
						line: 1,
						severity: "warning",
						semantic: "warning",
						tool: "biome",
					},
				],
				baselineWarningCount: 0,
				fixed: [],
				resolvedCount: 0,
				output: "1 warning",
				blockerOutput: "",
				hasBlockers: false,
			});

			const result = await dispatchLintWithResult("app.ts", "/project", {
				getFlag: () => false,
			});

			expect(result.hasBlockers).toBe(false);
			expect(result.warnings).toHaveLength(1);
			expect(result.blockers).toHaveLength(0);
		});

		it("passes blockingOnly to the dispatch context (default true, override false)", async () => {
			vi.mocked(dispatchForFile).mockResolvedValue(emptyDispatchResult);

			await dispatchLintWithResult("app.ts", "/project", {
				getFlag: () => false,
			});
			expect(
				vi.mocked(dispatchForFile).mock.calls.at(-1)?.[0].blockingOnly,
			).toBe(true);

			vi.mocked(dispatchForFile).mockClear();
			await dispatchLintWithResult(
				"app.ts",
				"/project",
				{ getFlag: () => false },
				undefined,
				undefined,
				{ blockingOnly: false },
			);
			expect(
				vi.mocked(dispatchForFile).mock.calls.at(-1)?.[0].blockingOnly,
			).toBe(false);
		});

		it("carries the authoritative workspace root separately from a language root", async () => {
			await dispatchLintWithResult(
				"app.ts",
				"/repo/packages/pkg-a",
				{ getFlag: () => false },
				undefined,
				undefined,
				{ projectRoot: "/repo" },
			);

			const ctx = vi.mocked(dispatchForFile).mock.calls.at(-1)?.[0];
			expect(ctx?.cwd).toBe(
				normalizeMapKey(path.resolve("/repo/packages/pkg-a")),
			);
			expect(ctx?.projectRoot).toBe(normalizeMapKey(path.resolve("/repo")));
		});

		it("passes telemetryModel/telemetryProvider through to createDispatchContext (#1448)", async () => {
			await dispatchLintWithResult(
				"app.ts",
				"/project",
				{ getFlag: () => false },
				undefined,
				undefined,
				{
					telemetryModel: "claude-sonnet-4-5",
					telemetryProvider: "anthropic",
				},
			);

			const call = vi.mocked(createDispatchContext).mock.calls.at(-1);
			// Positional args per createDispatchContext's signature: ...,
			// projectRoot, writeIndex, telemetryModel, telemetryProvider.
			expect(call?.[8]).toBe("claude-sonnet-4-5");
			expect(call?.[9]).toBe("anthropic");

			const ctx = vi.mocked(dispatchForFile).mock.calls.at(-1)?.[0];
			expect(ctx?.telemetryModel).toBe("claude-sonnet-4-5");
			expect(ctx?.telemetryProvider).toBe("anthropic");
		});
	});

	describe("shouldDispatch", () => {
		it("returns true for TypeScript files", () => {
			expect(shouldDispatch("app.ts")).toBe(true);
			expect(shouldDispatch("app.tsx")).toBe(true);
		});

		it("returns true for Python files", () => {
			expect(shouldDispatch("app.py")).toBe(true);
		});

		it("returns true for Go files", () => {
			expect(shouldDispatch("main.go")).toBe(true);
		});

		it("returns false for unknown extensions", () => {
			expect(shouldDispatch("data.csv")).toBe(false);
			expect(shouldDispatch("image.png")).toBe(false);
			expect(shouldDispatch("unknown.xyz")).toBe(false);
		});
	});

	describe("getAvailableRunners", () => {
		it("returns runners for TypeScript files", async () => {
			const runners = await getAvailableRunners("app.ts");
			expect(runners.length).toBeGreaterThan(0);
			expect(runners).toContain("lsp");
		});

		it("returns runners for Python files", async () => {
			const runners = await getAvailableRunners("app.py");
			expect(runners.length).toBeGreaterThan(0);
			expect(runners).toContain("lsp");
		});

		// #1545: fish is lspCapable but was absent from the lsp runner's
		// appliesTo, so every registry-consulting surface reported fish as having
		// no LSP coverage. appliesTo is now derived from LANGUAGE_POLICY.
		it("returns the lsp runner for fish files", async () => {
			const runners = await getAvailableRunners("/p/a.fish");
			expect(runners[0]).toBe("lsp");
		});

		it("returns empty array for unsupported files", async () => {
			const runners = await getAvailableRunners("data.csv");
			expect(runners).toEqual([]);
		});
	});

	// #2243: importing this module (done at the top of this file) must install
	// the fact-store capacity-eviction reporter. Without it, the store's cap
	// evicts silently and item 4's ledger record is never emitted.
	it("installs the fact-store eviction reporter on import", () => {
		expect(getFactStoreEvictionReporter()).toBeTypeOf("function");
	});
});
