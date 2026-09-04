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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BiomeClient } from "../../clients/biome-client.js";
import { getFormatService } from "../../clients/format-service.js";
import { MetricsClient } from "../../clients/metrics-client.js";
import { resolvePiLensFlag } from "../../clients/lens-config.js";
import {
	type PipelineContext,
	type PipelineDeps,
	runPipeline,
} from "../../clients/pipeline.js";
import { renderPostAutofixNotice } from "../../clients/post-autofix-notice.js";
import { loadPiLensProjectConfig } from "../../clients/project-lens-config.js";
import type { RuffClient } from "../../clients/ruff-client.js";
import { TestRunnerClient } from "../../clients/test-runner-client.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { createTempFile, setupTestEnvironment } from "../clients/test-utils.js";
import {
	_resetForTests as resetBusPublish,
	wireBusEmitter,
} from "../../clients/bus-publish.js";
import {
	_resetDiagnosticsPublishForTests as resetDiagnosticsPublish,
	wireDiagnosticsBusEmitter,
} from "../../clients/diagnostics-publish.js";

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

describe("Pipeline", () => {
	let tmpDir: string;
	let mockLSPService: ReturnType<typeof createMockLSPService>;

	beforeEach(async () => {
		resetDegradationLedger();
		const env = setupTestEnvironment();
		tmpDir = env.tmpDir;
		mockLSPService = createMockLSPService();
		vi.mocked(getLSPService).mockReturnValue(mockLSPService as any);
		vi.mocked(dispatchLintWithResult).mockReset();
		const { resetFormatService } =
			await import("../../clients/format-service.js");
		resetFormatService();
	});

	function createMockLSPService() {
		return {
			supportsLSP: vi.fn().mockReturnValue(true),
			hasLSP: vi.fn().mockResolvedValue(true),
			openFile: vi.fn().mockResolvedValue(undefined),
			touchFile: vi.fn().mockResolvedValue(undefined),
			getAuxiliaryClientsForFile: vi.fn().mockResolvedValue([]),
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

	it("project config disables format and autofix while preserving diagnostics", async () => {
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({
				format: { enabled: false },
				autofix: { enabled: false },
			}),
		);
		const projectConfig = loadPiLensProjectConfig(tmpDir);
		const getFlag = (name: string) =>
			resolvePiLensFlag(
				name,
				false,
				{ format: { mode: "immediate" } },
				projectConfig,
			);
		const filePath = createTempFile(tmpDir, "project-policy.ts", "const x=1");
		const formatFile = vi.fn();
		const ensureBiomeAvailable = vi.fn().mockResolvedValue(true);
		const diagnostic = {
			id: "project-policy-diagnostic",
			message: "unused var",
			filePath,
			severity: "warning" as const,
			source: "test",
			tool: "test",
			semantic: "warning" as const,
			line: 1,
			column: 1,
		};
		vi.mocked(dispatchLintWithResult).mockResolvedValue({
			diagnostics: [diagnostic],
			blockers: [],
			warnings: [diagnostic],
			baselineWarningCount: 0,
			fixed: [],
			resolvedCount: 0,
			output: "unused var",
			blockerOutput: "",
			hasBlockers: false,
		});

		const result = await runPipeline(
			createMockContext(filePath, { getFlag }),
			createMockDeps({
				getFormatService: () => ({ formatFile }) as any,
				biomeClient: {
					isSupportedFile: () => true,
					ensureAvailable: ensureBiomeAvailable,
				} as unknown as BiomeClient,
			}),
		);

		expect(formatFile).not.toHaveBeenCalled();
		expect(ensureBiomeAvailable).not.toHaveBeenCalled();
		expect(dispatchLintWithResult).toHaveBeenCalledOnce();
		expect(result.diagnostics).toEqual([diagnostic]);
		expect(result.fileModified).toBe(false);
	});

	it("passes the workspace root to dispatch when cwd is a nested language root", async () => {
		const nestedDir = path.join(tmpDir, "packages", "pkg-a");
		fs.mkdirSync(nestedDir, { recursive: true });
		const filePath = createTempFile(nestedDir, "nested.ts", "const x = 1;\n");
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
				cwd: nestedDir,
				projectRoot: tmpDir,
			}),
			createMockDeps(),
		);

		expect(vi.mocked(dispatchLintWithResult)).toHaveBeenCalledWith(
			filePath,
			nestedDir,
			expect.objectContaining({ getFlag: expect.any(Function) }),
			undefined,
			expect.objectContaining({
				model: "unknown",
				sessionId: "unknown",
			}),
			{ projectRoot: tmpDir },
		);
	});

	describe("Format phase", () => {
		it("defers format by default", async () => {
			const filePath = createTempFile(tmpDir, "unformatted.ts", "const x=1");
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
						formatters: [
							{
								name: "biome",
								success: true,
								changed: true,
								outcome: "formatted" as const,
							},
						],
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
			// #1590: the pipeline hands up the notice DATA and renders no sentence
			// of its own — it cannot see whether the authoritative bytes shipped.
			// `handleToolResult` renders it; the neutral wording is what a
			// format-only change (no attachment) produces there.
			expect(result.output).not.toContain(
				"File was modified by auto-format/fix",
			);
			expect(result.postAutofixNotice?.changedFiles).toContain(
				path.basename(filePath),
			);
			expect(
				renderPostAutofixNotice(result.postAutofixNotice as never, "none"),
			).toContain("File was modified by auto-format/fix");
			// #1590 review F2: a run that changed the file must NOT also report
			// itself clean. The notice moved a layer up, so the all-clear gate now
			// has to account for it; without that, `output` falls through to
			// `buildAllClearOutput` and the same result says "clean" and
			// "modified".
			expect(result.output).not.toContain("clean");
			expect(result.output).toBe("");
		});

		it("surfaces formatter failures instead of plain clean output", async () => {
			const filePath = createTempFile(
				tmpDir,
				"format-fails.ts",
				"const x = 1;",
			);
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
						outcome: "failed" as const,
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
			expect(getDegradationSummary()).toEqual([
				expect.objectContaining({
					kind: "formatter-failure",
					count: 1,
					latestReasons: [
						{ subject: "prettier:format-fails.ts", reason: "timed out" },
					],
				}),
			]);
			expect(result.output).not.toMatch(/^✓ .*clean/);
		});

		it("skips format when --no-autoformat flag is set", async () => {
			const filePath = createTempFile(tmpDir, "app.ts", "const x = 1;");
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

	describe("Bus publish (#482 pilens:files:touched)", () => {
		afterEach(() => {
			resetBusPublish();
		});

		it('publishes reason:"format" with the fixed file\'s path when immediate format changes content', async () => {
			const filePath = createTempFile(tmpDir, "unformatted.ts", "const x=1");
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

			const emit = vi.fn();
			wireBusEmitter(emit);

			const formatService = getFormatService("test", true);
			const originalFormatFile = formatService.formatFile.bind(formatService);
			const deps = createMockDeps({ getFormatService: () => formatService });
			formatService.formatFile = async (fp: string) => {
				const result = await originalFormatFile(fp);
				if (fp === filePath || path.resolve(fp) === path.resolve(filePath)) {
					fs.writeFileSync(filePath, "const x = 1;\n");
					return {
						filePath: fp,
						formatters: [
							{
								name: "biome",
								success: true,
								changed: true,
								outcome: "formatted" as const,
							},
						],
						anyChanged: true,
						allSucceeded: true,
					};
				}
				return result;
			};

			await runPipeline(
				createMockContext(filePath, {
					getFlag: (name) => name === "immediate-format",
				}),
				deps,
			);

			expect(emit).toHaveBeenCalledWith(
				"pilens:files:touched",
				expect.objectContaining({
					v: 1,
					source: "pi-lens",
					reason: "format",
					paths: [path.resolve(filePath).replace(/\\/g, "/")],
					cwd: tmpDir.replace(/\\/g, "/"),
				}),
			);
		});

		it('publishes reason:"autofix" with the fixed file\'s path when an autofix tool changes content', async () => {
			const filePath = createTempFile(tmpDir, "messy.ts", "const x=1");
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

			const emit = vi.fn();
			wireBusEmitter(emit);

			const mockBiome = {
				isSupportedFile: () => true,
				ensureAvailable: async () => true,
				fixFileAsync: async () => {
					fs.writeFileSync(filePath, "const x = 1;\n");
					return { success: true, changed: true, fixed: 1 };
				},
			} as unknown as BiomeClient;

			await runPipeline(
				createMockContext(filePath, { getFlag: () => false }),
				createMockDeps({ biomeClient: mockBiome }),
			);

			const filesTouchedCall = emit.mock.calls.find(
				(call) => call[0] === "pilens:files:touched",
			);
			expect(filesTouchedCall).toBeDefined();
			expect(filesTouchedCall?.[1]).toMatchObject({
				v: 1,
				source: "pi-lens",
				reason: "autofix",
				paths: [path.resolve(filePath).replace(/\\/g, "/")],
			});
		});

		it("does not publish when nothing changes", async () => {
			const filePath = createTempFile(tmpDir, "clean.ts", "const x = 1;\n");
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

			const emit = vi.fn();
			wireBusEmitter(emit);

			await runPipeline(
				createMockContext(filePath, {
					getFlag: (name) => name === "no-autofix",
				}),
				createMockDeps(),
			);

			expect(emit).not.toHaveBeenCalled();
		});

		it("includes fix-provenance entries on the format publish", async () => {
			const filePath = createTempFile(tmpDir, "unformatted2.ts", "const x=1");
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

			const emit = vi.fn();
			wireBusEmitter(emit);

			const formatService = getFormatService("test", true);
			const originalFormatFile = formatService.formatFile.bind(formatService);
			const deps = createMockDeps({ getFormatService: () => formatService });
			formatService.formatFile = async (fp: string) => {
				const result = await originalFormatFile(fp);
				if (fp === filePath || path.resolve(fp) === path.resolve(filePath)) {
					fs.writeFileSync(filePath, "const x = 1;\n");
					return {
						filePath: fp,
						formatters: [
							{
								name: "biome",
								success: true,
								changed: true,
								outcome: "formatted" as const,
							},
						],
						anyChanged: true,
						allSucceeded: true,
					};
				}
				return result;
			};

			await runPipeline(
				createMockContext(filePath, {
					getFlag: (name) => name === "immediate-format",
				}),
				deps,
			);

			const call = emit.mock.calls.find((c) => c[0] === "pilens:files:touched");
			expect(call?.[1]).toMatchObject({
				fixes: [
					{
						path: path.resolve(filePath).replace(/\\/g, "/"),
						tool: "biome",
						kind: "format",
					},
				],
			});
		});
	});

	describe("Bus publish (#502 pilens:diagnostics)", () => {
		afterEach(() => {
			resetDiagnosticsPublish();
		});

		it("publishes the file's diagnostics after dispatch completes", async () => {
			const filePath = createTempFile(tmpDir, "diag.ts", "const x = 1;\n");
			vi.mocked(dispatchLintWithResult).mockResolvedValue({
				diagnostics: [
					{
						id: "d1",
						message: "unused var",
						filePath,
						line: 1,
						column: 1,
						severity: "warning",
						semantic: "warning",
						tool: "eslint",
						rule: "no-unused-vars",
						fixable: true,
					},
				],
				blockers: [],
				warnings: [],
				baselineWarningCount: 0,
				fixed: [],
				resolvedCount: 0,
				output: "",
				blockerOutput: "",
				hasBlockers: false,
			});

			const emit = vi.fn();
			wireDiagnosticsBusEmitter(emit);

			await runPipeline(
				createMockContext(filePath, { getFlag: () => false }),
				createMockDeps(),
			);

			expect(emit).toHaveBeenCalledWith(
				"pilens:diagnostics",
				expect.objectContaining({
					v: 1,
					source: "pi-lens",
					files: [
						expect.objectContaining({
							path: path.resolve(filePath).replace(/\\/g, "/"),
							diagnostics: [
								expect.objectContaining({
									ruleId: "no-unused-vars",
									severity: "warning",
									tool: "eslint",
									fixable: true,
								}),
							],
						}),
					],
				}),
			);
		});

		it("does not publish when there are no diagnostics and the file was never dirty", async () => {
			const filePath = createTempFile(
				tmpDir,
				"clean-diag.ts",
				"const x = 1;\n",
			);
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

			const emit = vi.fn();
			wireDiagnosticsBusEmitter(emit);

			await runPipeline(
				createMockContext(filePath, { getFlag: () => false }),
				createMockDeps(),
			);

			expect(emit).not.toHaveBeenCalled();
		});

		it("emits an explicit clean [] event when a previously-dirty file's diagnostics clear on a later write", async () => {
			const filePath = createTempFile(tmpDir, "flip.ts", "const x = 1;\n");

			vi.mocked(dispatchLintWithResult).mockResolvedValueOnce({
				diagnostics: [
					{
						id: "d1",
						message: "unused var",
						filePath,
						line: 1,
						column: 1,
						severity: "warning",
						semantic: "warning",
						tool: "eslint",
						rule: "no-unused-vars",
					},
				],
				blockers: [],
				warnings: [],
				baselineWarningCount: 0,
				fixed: [],
				resolvedCount: 0,
				output: "",
				blockerOutput: "",
				hasBlockers: false,
			});

			const emit = vi.fn();
			wireDiagnosticsBusEmitter(emit);

			await runPipeline(
				createMockContext(filePath, { getFlag: () => false }),
				createMockDeps(),
			);
			expect(emit).toHaveBeenCalledTimes(1);

			vi.mocked(dispatchLintWithResult).mockResolvedValueOnce({
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
				createMockContext(filePath, { getFlag: () => false }),
				createMockDeps(),
			);

			expect(emit).toHaveBeenCalledTimes(2);
			expect(emit.mock.calls[1][1]).toMatchObject({
				files: [
					expect.objectContaining({
						path: path.resolve(filePath).replace(/\\/g, "/"),
						diagnostics: [],
					}),
				],
			});

			// a THIRD still-clean run does not re-emit (no new transition).
			vi.mocked(dispatchLintWithResult).mockResolvedValueOnce({
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
				createMockContext(filePath, { getFlag: () => false }),
				createMockDeps(),
			);
			expect(emit).toHaveBeenCalledTimes(2);
		});
	});

	describe("LSP sync", () => {
		it("syncs file with LSP when not deferred", async () => {
			const filePath = createTempFile(tmpDir, "app.ts", "const x = 1;");
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

	// #1641 review F1/F2: `inlineBlockerLines` is the structured field the
	// turn-end past-EOF gate (`clients/blocker-past-eof.ts`) reads. It has
	// exactly one production writer (`runPipeline`, here) — a test that calls
	// `RuntimeCoordinator.recordInlineBlockers` directly proves nothing about
	// whether the pipeline actually populates it.
	describe("inlineBlockerLines (#1641)", () => {
		it("captures the cited lines from dispatch's blocking diagnostics", async () => {
			const filePath = createTempFile(tmpDir, "app.ts", "const x = 1;");
			vi.mocked(dispatchLintWithResult).mockResolvedValue({
				diagnostics: [],
				blockers: [
					{
						id: "err-1",
						message: "Type error",
						filePath,
						line: 7,
						severity: "error",
						semantic: "blocking",
						tool: "tsc",
					},
					{
						id: "err-2",
						message: "Another error",
						filePath,
						line: 12,
						severity: "error",
						semantic: "blocking",
						tool: "tsc",
					},
				],
				warnings: [],
				baselineWarningCount: 0,
				fixed: [],
				resolvedCount: 0,
				output: "errors",
				blockerOutput: "errors",
				hasBlockers: true,
			});

			const result = await runPipeline(
				createMockContext(filePath),
				createMockDeps(),
			);

			expect(result.inlineBlockerLines).toEqual([7, 12]);
		});

		it("does NOT harvest a line from a blocker reported against a different file", async () => {
			// A chart-wide runner (helm-lint, helm-render) reports blocking
			// diagnostics against OTHER files in the chart alongside the edited
			// one — e.g. editing a 4-line template but the blocker is really
			// against `values.yaml:150`. That line describes different content
			// than the file this record's past-EOF gate will check, so it must
			// never be attributed to THIS file's record (#1641 review F2).
			const filePath = createTempFile(
				tmpDir,
				"templates/deploy.yaml",
				"a: 1\n",
			);
			const otherChartFile = path.join(tmpDir, "values.yaml");
			vi.mocked(dispatchLintWithResult).mockResolvedValue({
				diagnostics: [],
				blockers: [
					{
						id: "helm-1",
						message: "nil pointer evaluating interface {}.replicas",
						filePath: otherChartFile,
						line: 150,
						severity: "error",
						semantic: "blocking",
						tool: "helm-lint",
					},
				],
				warnings: [],
				baselineWarningCount: 0,
				fixed: [],
				resolvedCount: 0,
				output: "helm error",
				blockerOutput: "helm error",
				hasBlockers: true,
			});

			const result = await runPipeline(
				createMockContext(filePath),
				createMockDeps(),
			);

			expect(result.inlineBlockerLines).toEqual([]);
		});

		// #1641 review round 2 (LOW, win32-only — the dogfood host): an
		// LSP-sourced diagnostic's `filePath` is stamped with realpath canonical
		// casing (dispatch/runners/lsp.ts -> normalizeMapKey), but the pipeline's
		// OWN `ctx.filePath` can arrive with a lowercase drive letter — the same
		// drive-letter class as #1139/#1150. A bare `path.resolve` equality does
		// not fold that case difference, so it drops EVERY LSP blocker line and
		// this record silently skips the past-EOF gate — fail-open, but exactly
		// the pre-fix behavior on the surface #1641 targets. Declared skipped off
		// Windows (#2089): CI's Unit tests job runs on ubuntu-latest, where
		// case-folding is a no-op, and an early return there would report a PASS
		// on a body that asserted nothing.
		it.skipIf(process.platform !== "win32")(
			"still captures lines when the blocker's path differs from ctx.filePath only by drive-letter case (win32)",
			async () => {
				const filePath = createTempFile(tmpDir, "app.ts", "const x = 1;");
				const lowerDriveFilePath =
					filePath.charAt(0).toLowerCase() + filePath.slice(1);
				// The diagnostic's path is the OPPOSITE case from `ctx.filePath` —
				// simulating an LSP-stamped realpath-canonical path colliding with a
				// pipeline call site that received a lowercase-drive path.
				const canonicalCaseFilePath =
					filePath.charAt(0).toUpperCase() + filePath.slice(1);
				vi.mocked(dispatchLintWithResult).mockResolvedValue({
					diagnostics: [],
					blockers: [
						{
							id: "lsp-1",
							message: "Type error",
							filePath: canonicalCaseFilePath,
							line: 3,
							severity: "error",
							semantic: "blocking",
							tool: "lsp",
						},
					],
					warnings: [],
					baselineWarningCount: 0,
					fixed: [],
					resolvedCount: 0,
					output: "type error",
					blockerOutput: "type error",
					hasBlockers: true,
				});

				const result = await runPipeline(
					createMockContext(lowerDriveFilePath),
					createMockDeps(),
				);

				expect(result.inlineBlockerLines).toEqual([3]);
			},
		);
	});

	// #2028: the 🔴 STOP block is a registered agent-facing delivery surface
	// (finding-delivery-gate.ts's `tool-call:stop-blocker`), so blockers whose
	// cited file no longer exists are dropped before rendering — there is no
	// remediation for content in a deleted file.
	describe("#2028 stop-blocker deleted-path gate", () => {
		it("drops blockers whose cited file was deleted from the rendered STOP block", async () => {
			const filePath = createTempFile(
				tmpDir,
				"live.ts",
				"const x = 1;\nconst y = 2;\n",
			);
			const deletedPath = path.join(tmpDir, "deleted-by-agent.ts");
			vi.mocked(dispatchLintWithResult).mockResolvedValue({
				diagnostics: [],
				blockers: [
					{
						id: "dead-1",
						message: "DELETED-FILE-BLOCKER-MARKER secret in removed file",
						filePath: deletedPath,
						line: 1,
						severity: "error",
						semantic: "blocking",
						tool: "gitleaks",
					},
					{
						id: "live-1",
						message: "LIVE-FILE-BLOCKER-MARKER unused var",
						filePath,
						line: 1,
						severity: "error",
						semantic: "blocking",
						tool: "lsp",
					},
				],
				warnings: [],
				baselineWarningCount: 0,
				fixed: [],
				resolvedCount: 0,
				output:
					"DELETED-FILE-BLOCKER-MARKER secret in removed file\nLIVE-FILE-BLOCKER-MARKER unused var\ncoverage: ok",
				blockerOutput:
					"DELETED-FILE-BLOCKER-MARKER secret in removed file\nLIVE-FILE-BLOCKER-MARKER unused var\n",
				hasBlockers: true,
			});

			const result = await runPipeline(
				createMockContext(filePath),
				createMockDeps(),
			);

			expect(result.hasBlockers).toBe(true);
			// The live blocker renders at full authority…
			expect(result.output).toContain("LIVE-FILE-BLOCKER-MARKER");
			expect(result.output).toContain("🔴 STOP");
			// …the deleted-file blocker does not render at all.
			expect(result.output).not.toContain("DELETED-FILE-BLOCKER-MARKER");
			// The surviving blocker's count is the LIVE one, not the raw total.
			expect(result.output).toContain("1 issue(s)");
		});

		it("renders no STOP header when every blocker cites a deleted file", async () => {
			const filePath = createTempFile(tmpDir, "clean-now.ts", "const x = 1;");
			const deletedPath = path.join(tmpDir, "also-deleted.ts");
			vi.mocked(dispatchLintWithResult).mockResolvedValue({
				diagnostics: [],
				blockers: [
					{
						id: "dead-2",
						message: "GHOST-BLOCKER-MARKER finding in removed file",
						filePath: deletedPath,
						line: 1,
						severity: "error",
						semantic: "blocking",
						tool: "gitleaks",
					},
				],
				warnings: [],
				baselineWarningCount: 0,
				fixed: [],
				resolvedCount: 0,
				output: "GHOST-BLOCKER-MARKER finding in removed file",
				blockerOutput: "GHOST-BLOCKER-MARKER finding in removed file",
				hasBlockers: true,
			});

			const result = await runPipeline(
				createMockContext(filePath),
				createMockDeps(),
			);

			// No "🔴 STOP — 0 issue(s)" ghost header, and no replay of the raw
			// blocker text either.
			expect(result.output).not.toContain("🔴 STOP");
			expect(result.output).not.toContain("GHOST-BLOCKER-MARKER");
		});
	});
});
