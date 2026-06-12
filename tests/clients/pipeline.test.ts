/**
 * Pipeline Integration Tests
 *
 * Tests the core write pipeline (runPipeline) with mocked external dependencies.
 * Uses real temp files for file system operations and mocks for:
 * - BiomeClient, RuffClient, TestRunnerClient, MetricsClient
 * - FormatService, LSPService
 * - dispatchLintWithResult
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BiomeClient } from "../../clients/biome-client.js";
import { getFormatService } from "../../clients/format-service.js";
import { MetricsClient } from "../../clients/metrics-client.js";
import {
	type PipelineContext,
	type PipelineDeps,
	runPipeline,
} from "../../clients/pipeline.js";
import type { RuffClient } from "../../clients/ruff-client.js";
import { TestRunnerClient } from "../../clients/test-runner-client.js";
import { createTempFile, setupTestEnvironment } from "../clients/test-utils.js";

// Mock the dispatch integration to avoid side effects
vi.mock("../../clients/dispatch/integration.js", () => ({
	dispatchLintWithResult: vi.fn(),
	computeCascadeForFile: vi.fn().mockResolvedValue(undefined),
}));

import { dispatchLintWithResult } from "../../clients/dispatch/integration.js";

// Mock LSP service
vi.mock("../../clients/lsp/index.js", () => ({
	getLSPService: vi.fn(),
}));

import { getLSPService } from "../../clients/lsp/index.js";

// Mock secrets scanner to control blocking behavior
vi.mock("../../clients/secrets-scanner.js", async (importOriginal) => {
	const mod =
		await importOriginal<typeof import("../../clients/secrets-scanner.js")>();
	return {
		...mod,
		scanForSecrets: vi.fn(mod.scanForSecrets),
	};
});

import { scanForSecrets } from "../../clients/secrets-scanner.js";

describe("Pipeline", () => {
	let tmpDir: string;
	let mockLSPService: ReturnType<typeof createMockLSPService>;

	beforeEach(async () => {
		const env = setupTestEnvironment();
		tmpDir = env.tmpDir;
		mockLSPService = createMockLSPService();
		vi.mocked(getLSPService).mockReturnValue(mockLSPService as any);
		vi.mocked(dispatchLintWithResult).mockReset();
		vi.mocked(scanForSecrets).mockReset();
		const { resetFormatService } = await import(
			"../../clients/format-service.js"
		);
		resetFormatService();
	});

	function createMockLSPService() {
		return {
			supportsLSP: vi.fn().mockReturnValue(true),
			hasLSP: vi.fn().mockResolvedValue(true),
			openFile: vi.fn().mockResolvedValue(undefined),
			touchFile: vi.fn().mockResolvedValue(undefined),
			getAllDiagnostics: vi.fn().mockResolvedValue(new Map()),
		};
	}

	function createMockDeps(overrides?: Partial<PipelineDeps>): PipelineDeps {
		// Use mock clients to avoid real tool execution during tests
		const mockBiome = {
			isSupportedFile: () => true,
			ensureAvailable: async () => false, // unavailable = won't run
			fixFileAsync: async () => ({
				success: true,
				changed: false,
				fixed: 0,
			}),
		} as unknown as BiomeClient;
		const mockRuff = {
			isPythonFile: () => false,
			ensureAvailable: async () => false,
			fixFileAsync: async () => ({
				success: true,
				changed: false,
				fixed: 0,
			}),
		} as unknown as RuffClient;
		const testRunnerClient = new TestRunnerClient();
		const metricsClient = new MetricsClient();

		return {
			biomeClient: mockBiome,
			ruffClient: mockRuff,
			testRunnerClient,
			metricsClient,
			getFormatService: () => getFormatService("test-session", false),
			fixedThisTurn: new Set(),
			...overrides,
		} as PipelineDeps;
	}

	function createMockContext(
		filePath: string,
		overrides?: Partial<PipelineContext>,
	): PipelineContext {
		return {
			filePath,
			cwd: tmpDir,
			toolName: "edit",
			getFlag: () => false,
			dbg: () => {},
			...overrides,
		};
	}

	describe("Secrets scan (blocking)", () => {
		it("blocks the pipeline when secrets are found", async () => {
			const filePath = createTempFile(
				tmpDir,
				"config.ts",
				"const apiKey = 'sk-live-123'",
			);
			vi.mocked(scanForSecrets).mockReturnValue([
				{ line: 1, message: "API key detected" },
			]);

			const result = await runPipeline(
				createMockContext(filePath),
				createMockDeps(),
			);

			expect(result.isError).toBe(true);
			expect(result.hasBlockers).toBe(true);
			expect(result.output).toContain("API key detected");
			expect(result.fileModified).toBe(false);
		});

		it("continues pipeline when no secrets found", async () => {
			const filePath = createTempFile(tmpDir, "app.ts", "console.log('hello')");
			vi.mocked(scanForSecrets).mockReturnValue([]);
			vi.mocked(dispatchLintWithResult).mockResolvedValue({
				diagnostics: [],
				blockers: [],
				warnings: [],
				baselineWarningCount: 0,
				fixed: [],
				resolvedCount: 0,
				output: "",
				blockerOutput: "",
				hasBlockers: false,
			});

			const result = await runPipeline(
				createMockContext(filePath),
				createMockDeps(),
			);

			expect(result.isError).toBe(false);
		}, 15_000);

		it("skips secrets scan when file content is undefined (deleted file)", async () => {
			const filePath = path.join(tmpDir, "deleted.ts");
			vi.mocked(dispatchLintWithResult).mockResolvedValue({
				diagnostics: [],
				blockers: [],
				warnings: [],
				baselineWarningCount: 0,
				fixed: [],
				resolvedCount: 0,
				output: "",
				blockerOutput: "",
				hasBlockers: false,
			});

			const result = await runPipeline(
				createMockContext(filePath),
				createMockDeps(),
			);

			expect(result.isError).toBe(false);
			expect(scanForSecrets).not.toHaveBeenCalled();
		});
	});

	describe("Format phase", () => {
		it("defers format by default", async () => {
			const filePath = createTempFile(tmpDir, "unformatted.ts", "const x=1");
			vi.mocked(scanForSecrets).mockReturnValue([]);
			vi.mocked(dispatchLintWithResult).mockResolvedValue({
				diagnostics: [],
				blockers: [],
				warnings: [],
				baselineWarningCount: 0,
				fixed: [],
				resolvedCount: 0,
				output: "",
				blockerOutput: "",
				hasBlockers: false,
			});

			const formatService = getFormatService("test", true);
			const formatFile = vi.fn(formatService.formatFile.bind(formatService));
			formatService.formatFile = formatFile;

			const result = await runPipeline(
				createMockContext(filePath),
				createMockDeps({ getFormatService: () => formatService }),
			);

			expect(formatFile).not.toHaveBeenCalled();
			expect(result.fileModified).toBe(false);
		});

		it("marks file as modified when immediate format changes content", async () => {
			const filePath = createTempFile(tmpDir, "unformatted.ts", "const x=1");
			vi.mocked(scanForSecrets).mockReturnValue([]);
			vi.mocked(dispatchLintWithResult).mockResolvedValue({
				diagnostics: [],
				blockers: [],
				warnings: [],
				baselineWarningCount: 0,
				fixed: [],
				resolvedCount: 0,
				output: "",
				blockerOutput: "",
				hasBlockers: false,
			});

			// Manually modify the file to simulate formatter effect
			const formatService = getFormatService("test", true);
			const originalFormatFile = formatService.formatFile.bind(formatService);
			// Override deps to use enabled format service for this test only
			const deps = createMockDeps({
				getFormatService: () => formatService,
			});
			formatService.formatFile = async (fp: string) => {
				const result = await originalFormatFile(fp);
				// Force a file change by writing different content
				if (fp === filePath || path.resolve(fp) === path.resolve(filePath)) {
					fs.writeFileSync(filePath, "const x = 1;\n");
					return {
						filePath: fp,
						formatters: [{ name: "biome", success: true, changed: true }],
						anyChanged: true,
						allSucceeded: true,
					};
				}
				return result;
			};

			const result = await runPipeline(
				createMockContext(filePath, {
					getFlag: (name) => name === "immediate-format",
				}),
				deps,
			);

			expect(result.fileModified).toBe(true);
			expect(result.output).toContain("File was modified by auto-format/fix");
		});

		it("surfaces formatter failures instead of plain clean output", async () => {
			const filePath = createTempFile(
				tmpDir,
				"format-fails.ts",
				"const x = 1;",
			);
			vi.mocked(scanForSecrets).mockReturnValue([]);
			vi.mocked(dispatchLintWithResult).mockResolvedValue({
				diagnostics: [],
				blockers: [],
				warnings: [],
				baselineWarningCount: 0,
				fixed: [],
				resolvedCount: 0,
				output: "",
				blockerOutput: "",
				hasBlockers: false,
			});

			const formatService = getFormatService("test", true);
			formatService.formatFile = async (fp: string) => ({
				filePath: fp,
				formatters: [
					{
						name: "prettier",
						success: false,
						changed: false,
						error: "timed out",
					},
				],
				anyChanged: false,
				allSucceeded: false,
			});

			const result = await runPipeline(
				createMockContext(filePath, {
					getFlag: (name) => name === "immediate-format",
				}),
				createMockDeps({ getFormatService: () => formatService }),
			);

			expect(result.output).toContain("Auto-format failed");
			expect(result.output).toContain("prettier: timed out");
			expect(result.output).not.toMatch(/^✓ .*clean/);
		});

		it("skips format when --no-autoformat flag is set", async () => {
			const filePath = createTempFile(tmpDir, "app.ts", "const x = 1;");
			vi.mocked(scanForSecrets).mockReturnValue([]);
			vi.mocked(dispatchLintWithResult).mockResolvedValue({
				diagnostics: [],
				blockers: [],
				warnings: [],
				baselineWarningCount: 0,
				fixed: [],
				resolvedCount: 0,
				output: "",
				blockerOutput: "",
				hasBlockers: false,
			});

			const result = await runPipeline(
				createMockContext(filePath, {
					getFlag: (name) => name === "no-autoformat",
				}),
				createMockDeps(),
			);

			expect(result.fileModified).toBe(false);
		});
	});

	describe("LSP sync", () => {
		it("syncs file with LSP when not deferred", async () => {
			const filePath = createTempFile(tmpDir, "app.ts", "const x = 1;");
			vi.mocked(scanForSecrets).mockReturnValue([]);
			vi.mocked(dispatchLintWithResult).mockResolvedValue({
				diagnostics: [],
				blockers: [],
				warnings: [],
				baselineWarningCount: 0,
				fixed: [],
				resolvedCount: 0,
				output: "",
				blockerOutput: "",
				hasBlockers: false,
			});

			// Pass --no-autofix so LSP sync isn't deferred
			await runPipeline(
				createMockContext(filePath, {
					getFlag: (name) => name === "no-autofix",
				}),
				createMockDeps(),
			);

			// The post-edit sync goes through touchFile (not the bare openFile) so it
			// registers in the touch-debounce map via markTouched — letting the
			// dispatch-lsp-runner's touch moments later skip its redundant didChange
			// instead of clearing the diagnostics this push triggers (#203).
			expect(mockLSPService.touchFile).toHaveBeenCalledWith(
				filePath,
				"const x = 1;",
				{
					diagnostics: "none",
					source: "lsp_sync",
					clientScope: "primary",
					maxClientWaitMs: 5000,
				},
			);
			// The old openFile path (which never registered the touch) must not run.
			expect(mockLSPService.openFile).not.toHaveBeenCalled();
		});

		it("skips LSP sync when --no-lsp flag is set", async () => {
			const filePath = createTempFile(tmpDir, "app.ts", "const x = 1;");
			vi.mocked(scanForSecrets).mockReturnValue([]);
			vi.mocked(dispatchLintWithResult).mockResolvedValue({
				diagnostics: [],
				blockers: [],
				warnings: [],
				baselineWarningCount: 0,
				fixed: [],
				resolvedCount: 0,
				output: "",
				blockerOutput: "",
				hasBlockers: false,
			});

			await runPipeline(
				createMockContext(filePath, {
					getFlag: (name) => name === "no-lsp",
				}),
				createMockDeps(),
			);

			expect(mockLSPService.touchFile).not.toHaveBeenCalled();
			expect(mockLSPService.openFile).not.toHaveBeenCalled();
		});
	});

	describe("Dispatch lint", () => {
		it("sets hasBlockers when dispatch returns blockers", async () => {
			const filePath = createTempFile(tmpDir, "app.ts", "const x = 1;");
			vi.mocked(scanForSecrets).mockReturnValue([]);
			vi.mocked(dispatchLintWithResult).mockResolvedValue({
				diagnostics: [
					{
						id: "err-1",
						message: "Type error",
						filePath,
						line: 1,
						severity: "error",
						semantic: "blocking",
						tool: "tsc",
					},
				],
				blockers: [
					{
						id: "err-1",
						message: "Type error",
						filePath,
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
				output: "Type error at line 1",
				blockerOutput: "",
				hasBlockers: true,
			});

			const result = await runPipeline(
				createMockContext(filePath),
				createMockDeps(),
			);

			expect(result.hasBlockers).toBe(true);
			expect(result.output).toContain("Type error");
		});

		it("includes autofix count in output when fixes applied", async () => {
			const filePath = createTempFile(tmpDir, "app.ts", "const x=1");
			vi.mocked(scanForSecrets).mockReturnValue([]);
			vi.mocked(dispatchLintWithResult).mockResolvedValue({
				diagnostics: [],
				blockers: [],
				warnings: [],
				baselineWarningCount: 0,
				fixed: [],
				resolvedCount: 0,
				output: "",
				blockerOutput: "",
				hasBlockers: false,
			});

			// Simulate biome fixing the file
			const deps = createMockDeps();
			const fixBiome = {
				isSupportedFile: () => true,
				ensureAvailable: async () => true,
				fixFileAsync: async () => ({
					success: true,
					changed: true,
					fixed: 1,
				}),
			} as unknown as BiomeClient;
			deps.biomeClient = fixBiome;

			const result = await runPipeline(createMockContext(filePath), deps);

			expect(result.output).toContain("Auto-fixed");
			expect(result.fileModified).toBe(true);
		});
	});

	describe("Test runner", () => {
		it("skips tests when --no-tests flag is set", async () => {
			const filePath = createTempFile(tmpDir, "app.ts", "const x = 1;");
			vi.mocked(scanForSecrets).mockReturnValue([]);
			vi.mocked(dispatchLintWithResult).mockResolvedValue({
				diagnostics: [],
				blockers: [],
				warnings: [],
				baselineWarningCount: 0,
				fixed: [],
				resolvedCount: 0,
				output: "",
				blockerOutput: "",
				hasBlockers: false,
			});

			const result = await runPipeline(
				createMockContext(filePath, {
					getFlag: (name) => name === "no-tests",
				}),
				createMockDeps(),
			);

			expect(result.output).not.toContain("Tests");
		});
	});

	describe("All-clear output", () => {
		it("returns clean checkmark when no issues", async () => {
			const filePath = createTempFile(tmpDir, "app.ts", "const x = 1;");
			vi.mocked(scanForSecrets).mockReturnValue([]);
			vi.mocked(dispatchLintWithResult).mockResolvedValue({
				diagnostics: [],
				blockers: [],
				warnings: [],
				baselineWarningCount: 0,
				fixed: [],
				resolvedCount: 0,
				output: "",
				blockerOutput: "",
				hasBlockers: false,
			});

			const result = await runPipeline(
				createMockContext(filePath),
				createMockDeps(),
			);

			expect(result.output).toContain("✓");
			expect(result.hasBlockers).toBe(false);
			expect(result.isError).toBe(false);
		});
	});
});
