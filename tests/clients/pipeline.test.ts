/**
 * Pipeline Integration Tests
 *
 * Tests the core write pipeline (runPipeline) with mocked external dependencies.
 * Uses real temp files for file system operations and mocks for:
 * - BiomeClient, RuffClient, TestRunnerClient, MetricsClient
 * - FormatService, LSPService
 * - dispatchLintWithResult
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BiomeClient } from "../../clients/biome-client.js";
import type { Diagnostic } from "../../clients/dispatch/types.js";
import { formatDiagnostics } from "../../clients/dispatch/utils/format-utils.js";
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
	_getDegradationLedgerStateForTests,
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { createTempFile, setupTestEnvironment } from "../clients/test-utils.js";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";
import {
	_resetForTests as resetBusPublish,
	wireBusEmitter,
} from "../../clients/bus-publish.js";
import {
	_resetDiagnosticsPublishForTests as resetDiagnosticsPublish,
	wireDiagnosticsBusEmitter,
} from "../../clients/diagnostics-publish.js";

vi.mock("../../clients/safe-spawn.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/safe-spawn.js")>();
	return {
		...actual,
		safeSpawnAsync: vi.fn(
			async (
				command: string,
				args: readonly string[],
				options?: Parameters<typeof actual.safeSpawnAsync>[2],
			) => {
				if (command === "cargo" && args[0] === "--version") {
					return { stdout: "cargo 1.82.0", stderr: "", status: 0 };
				}
				if (command === "cargo" && args[0] === "clippy") {
					fs.writeFileSync(
						path.join(options?.cwd ?? "", "src", "helper.rs"),
						"pub fn helper() { 1 + 1; }\n",
					);
					return { stdout: "", stderr: "", status: 0 };
				}
				return actual.safeSpawnAsync(command, [...args], options);
			},
		),
	};
});

// Mock the dispatch integration to avoid side effects
vi.mock("../../clients/dispatch/integration.js", () => ({
	dispatchLintWithResult: vi.fn(),
	computeCascadeForFile: vi.fn().mockResolvedValue(undefined),
}));

import {
	computeCascadeForFile,
	dispatchLintWithResult,
} from "../../clients/dispatch/integration.js";

// Mock LSP service
vi.mock("../../clients/lsp/index.js", () => ({
	getLSPService: vi.fn(),
}));

import { getLSPService } from "../../clients/lsp/index.js";

describe("Pipeline", () => {
	let tmpDir: string;
	let mockLSPService: ReturnType<typeof makeLspServiceDouble>;

	beforeEach(async () => {
		resetDegradationLedger();
		const env = setupTestEnvironment();
		tmpDir = env.tmpDir;
		// #3005 fixture recurrence: autonomous Biome writers require independent
		// project agreement evidence, even when the client itself is a test double.
		fs.writeFileSync(
			path.join(tmpDir, "package.json"),
			JSON.stringify({ devDependencies: { "@biomejs/biome": "^2.4.10" } }),
		);
		fs.writeFileSync(
			path.join(tmpDir, "package-lock.json"),
			JSON.stringify({
				lockfileVersion: 3,
				packages: {
					"": {},
					"node_modules/@biomejs/biome": { version: "2.4.10" },
				},
			}),
		);
		mockLSPService = makeLspServiceDouble({
			supportsLSP: vi.fn().mockReturnValue(true),
			hasLSP: vi.fn().mockResolvedValue(true),
		});
		vi.mocked(getLSPService).mockReturnValue(mockLSPService as any);
		vi.mocked(dispatchLintWithResult).mockReset();
		const { resetFormatService } =
			await import("../../clients/format-service.js");
		resetFormatService();
	});

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

	it("leaves the post-write identity absent when autofix changes only a side-effect file", async () => {
		// Regression #2499 F1: `fileModified` aggregates side-effect writes, but
		// `postWriteStateHash` must identify only bytes owned by this pipeline for
		// the target file. The real runPipeline and Rust autofix path are used; the
		// subprocess boundary supplies the deterministic side-effect write.
		const crateDir = path.join(tmpDir, "crate");
		const srcDir = path.join(crateDir, "src");
		fs.mkdirSync(srcDir, { recursive: true });
		fs.writeFileSync(
			path.join(crateDir, "Cargo.toml"),
			'[package]\nname = "fixture"\nversion = "0.1.0"\nedition = "2021"\n',
		);
		const filePath = path.join(srcDir, "main.rs");
		fs.writeFileSync(filePath, "mod helper;\nfn main() {}\n");
		fs.writeFileSync(path.join(srcDir, "helper.rs"), "pub fn helper() {}\n");
		// #3005 fixture recurrence: rust-clippy's project-config agreement is
		// anchored at the pipeline cwd, while Cargo's real fixture is nested.
		fs.writeFileSync(
			path.join(tmpDir, "Cargo.toml"),
			'[workspace]\nmembers = ["crate"]\n',
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

		const targetBefore = fs.readFileSync(filePath, "utf-8");
		const result = await runPipeline(
			createMockContext(filePath),
			createMockDeps({ getFormatService: () => ({}) as any }),
		);

		expect(result.fileModified).toBe(true);
		expect(result.changedFiles).toEqual([path.join(srcDir, "helper.rs")]);
		expect(fs.readFileSync(filePath, "utf-8")).toBe(targetBefore);
		expect(result.postWriteStateHash).toBeUndefined();
	});

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

	it("binds blocker content to the pre-dispatch analysis bytes", async () => {
		const filePath = createTempFile(
			tmpDir,
			"blocker-baseline.ts",
			"const x = 1;\n",
		);
		const diagnostic = {
			id: "blocker",
			message: "bad code",
			filePath,
			severity: "error" as const,
			source: "test",
			tool: "ast-grep",
			semantic: "blocking" as const,
			line: 1,
			column: 1,
		};
		vi.mocked(dispatchLintWithResult).mockImplementationOnce(async () => {
			// Model a writer that runs while the analysis promise is suspended.
			fs.writeFileSync(filePath, "const x = 2;\n");
			return {
				diagnostics: [diagnostic],
				blockers: [diagnostic],
				warnings: [],
				baselineWarningCount: 0,
				fixed: [],
				resolvedCount: 0,
				output: "blocked",
				blockerOutput: "blocked",
				hasBlockers: true,
			};
		});

		const result = await runPipeline(
			createMockContext(filePath),
			createMockDeps(),
		);

		expect(result.inlineBlockerFileContent).toEqual({
			size: Buffer.byteLength("const x = 1;\n"),
			sha256: createHash("sha256").update("const x = 1;\n").digest("hex"),
		});
	});

	it("hands the cascade the PROJECT root alongside the language cwd (#3157)", async () => {
		// The cascade's display filter reads the disposition store and the
		// `.pi-lens.json` rule policy, both written under the project root
		// (`lens_diagnostic_mark` is wired with `() => runtime.projectRoot`), while
		// `ctx.cwd` is `resolveLanguageRootForFile`'s nested answer. Without this
		// argument every mark is silently missed in a monorepo and #3157's whole
		// filter is inert there — the #1030 recurrence.
		const languageRoot = path.join(tmpDir, "packages", "app");
		fs.mkdirSync(languageRoot, { recursive: true });
		const filePath = createTempFile(
			languageRoot,
			"cascade-root.ts",
			"const x=1",
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

		await runPipeline(
			createMockContext(filePath, {
				cwd: languageRoot,
				projectRoot: tmpDir,
			}),
			createMockDeps(),
		);

		expect(computeCascadeForFile).toHaveBeenCalledWith(
			filePath,
			languageRoot,
			expect.objectContaining({ projectRoot: tmpDir }),
		);
	});

	it("hands the cascade the session generation captured at dispatch (#3512)", async () => {
		// The cascade's tier-3 touch record drops a touch whose dispatch session
		// was replaced. The handle comes from runtime-tool-result.ts; if this hop
		// drops it, the guard is inert in production.
		const filePath = createTempFile(tmpDir, "cascade-generation.ts", "x");
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
		const sessionGeneration = {
			generation: 7,
			isCurrent: () => true,
			guardedWrite: <T>(_subject: string, write: () => T) => write(),
		};

		await runPipeline(
			createMockContext(filePath, { sessionGeneration }),
			createMockDeps(),
		);

		expect(computeCascadeForFile).toHaveBeenCalledWith(
			filePath,
			tmpDir,
			expect.objectContaining({ sessionGeneration }),
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
			vi.mocked(dispatchLintWithResult).mockImplementationOnce(async () => {
				// A third-party writer can change the file while dispatch awaits. The
				// pipeline identity must remain the formatter's earlier bytes.
				fs.writeFileSync(filePath, "third-party write\n");
				return {
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
			});
			const formatterStateHash = (await import("node:crypto"))
				.createHash("sha256")
				.update("const x = 1;\n")
				.digest("hex");

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
			expect(result.postWriteStateHash).toBe(formatterStateHash);
		});

		it("does not autonomously rewrite an observed opaque mutation", async () => {
			// Regression #3226: opaque bash recovery proves only that bytes changed;
			// treating that observation as model authorship lets the normal pipeline
			// rewrite extracted/downloaded/generated artifacts.
			const filePath = createTempFile(
				tmpDir,
				"opaque-artifact.js",
				"(function(){\n  return 1;\n})();\n",
			);
			const before = fs.readFileSync(filePath, "utf8");
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
			const formatFile = vi.fn(async (fp: string) => {
				fs.writeFileSync(fp, "(() => 1)();\n");
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
			});

			const result = await runPipeline(
				createMockContext(filePath, {
					getFlag: (name) => name === "immediate-format",
					allowAutonomousWriters: false,
				}),
				createMockDeps({
					getFormatService: () => ({ recordRead: vi.fn(), formatFile }) as any,
				}),
			);

			expect(formatFile).not.toHaveBeenCalled();
			expect(fs.readFileSync(filePath, "utf8")).toBe(before);
			expect(result.fileModified).toBe(false);
			expect(result.postAutofixNotice).toBeUndefined();
			expect(
				getDegradationSummary().some(
					(entry) => entry.kind === "opaque-mutation-ownership-boundary",
				),
			).toBe(true);
		});

		it("keeps opaque findings advisory instead of directing an edit", async () => {
			// The artifact remains analyzable, but blocker/actionable delivery must
			// not turn third-party bytes into instructions for the model to edit.
			const filePath = createTempFile(
				tmpDir,
				"opaque-findings.js",
				"const x=1;\n",
			);
			const blocker = {
				id: "opaque-blocker",
				message: "OPAQUE-BLOCKER",
				filePath,
				severity: "error" as const,
				semantic: "blocking" as const,
				tool: "biome",
				line: 1,
			};
			const warning = {
				id: "opaque-actionable",
				message: "OPAQUE-ACTIONABLE",
				filePath,
				severity: "warning" as const,
				semantic: "warning" as const,
				tool: "biome",
				line: 1,
				fixable: true,
				fixKind: "pipeline" as const,
				fixSuggestion: "edit this file",
			};
			vi.mocked(dispatchLintWithResult).mockResolvedValue({
				diagnostics: [blocker, warning],
				blockers: [blocker],
				warnings: [warning],
				baselineWarningCount: 0,
				fixed: [],
				resolvedCount: 0,
				output: "OPAQUE-BLOCKER\nOPAQUE-ACTIONABLE",
				blockerOutput: "OPAQUE-BLOCKER",
				hasBlockers: true,
			});

			const result = await runPipeline(
				createMockContext(filePath, { allowAutonomousWriters: false }),
				createMockDeps(),
			);

			expect(result.diagnostics).toEqual([blocker, warning]);
			expect(result.hasBlockers).toBe(false);
			expect(result.inlineBlockerSummary).toBeUndefined();
			expect(result.actionableWarnings).toEqual([]);
			expect(result.output).toContain("OPAQUE-ACTIONABLE");
			expect(result.output).not.toContain("OPAQUE-BLOCKER");
		});

		it("bounds opaque ownership telemetry across many paths (#3226 review P2)", async () => {
			// Recurrence: per-path once keys made opaque recovery retain one hidden
			// identity per artifact. Drive the real pipeline seam with the reviewer's
			// 10,000-path population and inspect both hidden ledger populations and
			// the independent public count/dropped evidence.
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
			const deps = createMockDeps({ getFormatService: () => ({}) as any });
			const firstPath = path.join(tmpDir, "opaque-0.js");
			await runPipeline(
				createMockContext(firstPath, { allowAutonomousWriters: false }),
				deps,
			);
			await runPipeline(
				createMockContext(firstPath, { allowAutonomousWriters: false }),
				deps,
			);
			for (let index = 1; index < 10_000; index++) {
				await runPipeline(
					createMockContext(path.join(tmpDir, `opaque-${index}.js`), {
						allowAutonomousWriters: false,
					}),
					deps,
				);
			}

			const state = _getDegradationLedgerStateForTests();
			expect(state.onceKeys).toBe(0);
			expect(state.tallies).toBe(1);
			expect(state.retainedEntries).toBe(1);
			expect(getDegradationSummary()).toEqual([
				expect.objectContaining({
					kind: "opaque-mutation-ownership-boundary",
					count: 10_001,
					droppedCount: 10_001 - 1,
					latestReasons: expect.arrayContaining([
						expect.objectContaining({ subject: "pipeline" }),
					]),
				}),
			]);

			resetDegradationLedger();
			expect(_getDegradationLedgerStateForTests()).toEqual({
				onceKeys: 0,
				tallies: 0,
				retainedEntries: 0,
			});
			expect(getDegradationSummary()).toEqual([]);
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
					// #3405: the post-write sync is the touch that knows pi-lens wrote
					// the file, so it is the one that declares a save.
					saved: true,
					// #3481: when the synced bytes were read.
					readStamp: expect.any(Number),
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

	// #3481: the LSP sync carries WHEN its content was read, so the per-path
	// notify queue can refuse to land it over a newer read of the same file.
	// A stamp taken before the read that produced the synced bytes (the
	// pre-format read, say) would rank post-format bytes as older than they are.
	describe("LSP sync read stamp (#3481)", () => {
		const cleanDispatch = {
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
		const syncedStamp = () => {
			const calls = (
				mockLSPService.touchFile as unknown as {
					mock: {
						calls: Array<
							[string, string, { source?: string; readStamp?: number }]
						>;
					};
				}
			).mock.calls;
			return calls.find(([, , opts]) => opts?.source === "lsp_sync")?.[2]
				.readStamp;
		};

		it("stamps the sync with the read after an immediate format", async () => {
			const filePath = createTempFile(tmpDir, "stamp-format.ts", "const x=1");
			vi.mocked(dispatchLintWithResult).mockResolvedValue(cleanDispatch);
			const formatService = getFormatService("test", true);
			let formattedAt = Number.POSITIVE_INFINITY;
			formatService.formatFile = async (fp: string) => {
				fs.writeFileSync(fp, "const x = 1;\n");
				formattedAt = performance.now();
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
			};

			await runPipeline(
				createMockContext(filePath, {
					getFlag: (name) => name === "immediate-format",
				}),
				createMockDeps({ getFormatService: () => formatService }),
			);

			expect(syncedStamp()).toBeGreaterThanOrEqual(formattedAt);
		});

		it("stamps the sync with the read after an autofix", async () => {
			const filePath = createTempFile(tmpDir, "stamp-fix.ts", "const x=1");
			vi.mocked(dispatchLintWithResult).mockResolvedValue(cleanDispatch);
			const deps = createMockDeps();
			let fixedAt = Number.POSITIVE_INFINITY;
			deps.biomeClient = {
				isSupportedFile: () => true,
				ensureAvailable: async () => true,
				fixFileAsync: async () => {
					fs.writeFileSync(filePath, "const x = 1;\n");
					fixedAt = performance.now();
					return { success: true, changed: true, fixed: 1 };
				},
			} as unknown as BiomeClient;

			await runPipeline(createMockContext(filePath), deps);

			expect(syncedStamp()).toBeGreaterThanOrEqual(fixedAt);
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
			// #3190 fixture fidelity: the chart sibling must EXIST on disk. This
			// case pins the CROSS-FILE line filter, and since #3190 the shared
			// deleted-path gate retracts a blocker citing a missing file before
			// the record is built — a never-created fixture would make the case
			// pass through the gate under test rather than through the filter.
			const otherChartFile = createTempFile(
				tmpDir,
				"values.yaml",
				`${"replicas: 2\n".repeat(200)}`,
			);
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
		// lane: windows-vitest
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

		// #3188: the readback-FAILED sibling of the case above. The reporter's
		// shape is a bash-written file the same command deleted (`cat > probe.py
		// … ; rm probe.py`): opaque-mutation recovery hands the recovered path to
		// runPipeline, the readback throws, and the real dispatcher still returns
		// one blocker citing the now-missing path — the DispatchResult below is
		// the exact shape measured from `dispatchLintWithResult` on a deleted
		// `.py` file. The gate then retracts every blocker, and this branch
		// rendered `🔴 STOP — 0 issue(s) must be fixed:` with nothing under it.
		describe("#3188 readback-failed branch with a total retraction", () => {
			// Measured from the real dispatcher (ruff on a deleted path).
			const DEAD_BLOCKER_OUTPUT =
				"\n🔴 STOP — 1 issue(s) must be fixed:\n  L1: DEAD-PATH-BLOCKER-MARKER No such file or directory (os error 2)\n";

			function deadPathDispatch(
				deletedPath: string,
				tail = "",
			): Awaited<ReturnType<typeof dispatchLintWithResult>> {
				return {
					diagnostics: [],
					blockers: [
						{
							id: "dead-3",
							message:
								"DEAD-PATH-BLOCKER-MARKER No such file or directory (os error 2)",
							filePath: deletedPath,
							line: 1,
							severity: "error",
							semantic: "blocking",
							tool: "ruff",
						},
					],
					warnings: [],
					baselineWarningCount: 0,
					fixed: [],
					resolvedCount: 0,
					output: `${DEAD_BLOCKER_OUTPUT}${tail}`,
					blockerOutput: DEAD_BLOCKER_OUTPUT,
					hasBlockers: true,
				};
			}

			it("delivers nothing at all when the readback failed and every blocker cites a deleted path", async () => {
				// The pipeline's own target file is the deleted one, so
				// `fileContent` is undefined and the #2028 re-render branch runs.
				const deletedPath = path.join(tmpDir, "probe.py");
				vi.mocked(dispatchLintWithResult).mockResolvedValue(
					deadPathDispatch(deletedPath),
				);

				const result = await runPipeline(
					createMockContext(deletedPath),
					createMockDeps(),
				);

				// No ghost banner…
				expect(result.output).not.toContain("🔴 STOP");
				expect(result.output).not.toContain("0 issue(s)");
				// …no ungated replay of the retracted blocker text (#2028)…
				expect(result.output).not.toContain("DEAD-PATH-BLOCKER-MARKER");
				// …and not even a bare separator. `handleToolResult` decides on
				// `output` truthiness (runtime-tool-result.ts's
				// `if (!output && !result.postMutation) return;` and the
				// `result: output ? "completed" : "no_output"` latency row), so a
				// whitespace-only string is still a delivered tool-result block —
				// and it would also displace the pipeline's own all-clear line,
				// which is exactly what the #2028 guarded sibling branch renders
				// for this same input class.
				expect(result.output).not.toMatch(/^\s*$/);
				expect(result.output).toMatch(/^✓ .*clean/);
			});

			it("still delivers the post-blocker slice when the readback failed and every blocker cites a deleted path", async () => {
				// Total retraction does NOT mean the whole branch is skipped: the
				// coverage/fixed tail after `blockerOutput` is not gated content
				// and must survive.
				const deletedPath = path.join(tmpDir, "probe-with-tail.py");
				vi.mocked(dispatchLintWithResult).mockResolvedValue(
					deadPathDispatch(deletedPath, "COVERAGE-TAIL-MARKER: ok\n"),
				);

				const result = await runPipeline(
					createMockContext(deletedPath),
					createMockDeps(),
				);

				expect(result.output).toContain("COVERAGE-TAIL-MARKER");
				expect(result.output).not.toContain("🔴 STOP");
				expect(result.output).not.toContain("DEAD-PATH-BLOCKER-MARKER");
			});

			it("keeps the surviving blocker when the readback failed and only some blockers cite a deleted path", async () => {
				// The 5-in-159 non-zero form from the report: a partial retraction
				// must still render the gated banner with the surviving count.
				const deletedPath = path.join(tmpDir, "gone.py");
				const livePath = createTempFile(tmpDir, "still-here.py", "x = 1\n");
				vi.mocked(dispatchLintWithResult).mockResolvedValue({
					diagnostics: [],
					blockers: [
						{
							id: "dead-4",
							message: "DEAD-PATH-BLOCKER-MARKER finding in removed file",
							filePath: deletedPath,
							line: 1,
							severity: "error",
							semantic: "blocking",
							tool: "ruff",
						},
						{
							id: "live-4",
							message: "SURVIVING-BLOCKER-MARKER undefined name",
							filePath: livePath,
							line: 1,
							severity: "error",
							semantic: "blocking",
							tool: "ruff",
						},
					],
					warnings: [],
					baselineWarningCount: 0,
					fixed: [],
					resolvedCount: 0,
					output: "\n🔴 STOP — 2 issue(s) must be fixed:\n",
					blockerOutput: "\n🔴 STOP — 2 issue(s) must be fixed:\n",
					hasBlockers: true,
				});

				// Target path is deleted ⇒ readback fails ⇒ same branch as above.
				const result = await runPipeline(
					createMockContext(path.join(tmpDir, "deleted-target.py")),
					createMockDeps(),
				);

				expect(result.output).toContain("🔴 STOP — 1 issue(s)");
				expect(result.output).toContain("SURVIVING-BLOCKER-MARKER");
				expect(result.output).not.toContain("DEAD-PATH-BLOCKER-MARKER");
			});
		});
	});

	// #3190: the DURABLE record the pipeline hands the turn-end surface
	// (`inlineBlockerSummary` / `Sources` / `Lines` / `Diagnostics`, consumed by
	// `runtime.recordInlineBlockers`) is built from the SAME `deliverableBlockers`
	// set the 🔴 STOP block above renders — one gate, applied once here. Before
	// this, a blocker whose cited file no longer exists was retracted from the
	// tool result and then re-delivered at turn end, and the ungated
	// `hasBlockers` still latched the commit gate. The recurrence these cases
	// prevent is that re-delivery.
	describe("#3190 inline-blocker record built from the gated set", () => {
		/** `dispatcher.ts`'s own expression for `blockerOutput` (`:1409`). */
		function dispatchWith(blockers: Diagnostic[]) {
			const blockerOutput = formatDiagnostics(blockers, "blocking");
			return {
				diagnostics: [...blockers],
				blockers,
				warnings: [],
				baselineWarningCount: 0,
				fixed: [],
				resolvedCount: 0,
				output: blockerOutput,
				blockerOutput,
				hasBlockers: blockers.length > 0,
			};
		}

		function blocker(
			filePath: string,
			line: number,
			message: string,
			tool: string,
		): Diagnostic {
			return {
				id: `${tool}:${line}`,
				message,
				filePath,
				line,
				severity: "error",
				semantic: "blocking",
				tool,
			} as Diagnostic;
		}

		it("carries no record and no blocker verdict when every blocker cites a deleted path", async () => {
			const filePath = createTempFile(tmpDir, "live-3190.ts", "const x = 1;");
			const deletedPath = path.join(tmpDir, "gone-3190.ts");
			vi.mocked(dispatchLintWithResult).mockResolvedValue(
				dispatchWith([
					blocker(
						deletedPath,
						1,
						"GHOST-3190-MARKER in removed file",
						"gitleaks",
					),
				]) as never,
			);

			const result = await runPipeline(
				createMockContext(filePath),
				createMockDeps(),
			);

			expect(result.inlineBlockerSummary).toBeUndefined();
			expect(result.inlineBlockerSources).toBeUndefined();
			expect(result.inlineBlockerLines).toBeUndefined();
			expect(result.inlineBlockerDiagnostics).toBeUndefined();
			// The verdict `runtime.updateGitGuardStatus` latches the commit gate
			// from (`clients/runtime-tool-result.ts`) must agree with the silence.
			expect(result.hasBlockers).toBe(false);
		});

		it("carries only the surviving blocker when some blockers cite a deleted path", async () => {
			const filePath = createTempFile(
				tmpDir,
				"partial-3190.ts",
				"const x = 1;",
			);
			const deletedPath = path.join(tmpDir, "gone-partial-3190.ts");
			vi.mocked(dispatchLintWithResult).mockResolvedValue(
				dispatchWith([
					blocker(
						deletedPath,
						9,
						"GHOST-3190-MARKER in removed file",
						"gitleaks",
					),
					blocker(filePath, 1, "SURVIVOR-3190-MARKER unused var", "lsp"),
				]) as never,
			);

			const result = await runPipeline(
				createMockContext(filePath),
				createMockDeps(),
			);

			expect(result.inlineBlockerSummary).toContain("SURVIVOR-3190-MARKER");
			expect(result.inlineBlockerSummary).not.toContain("GHOST-3190-MARKER");
			expect(result.inlineBlockerSummary).toContain("1 issue(s)");
			expect(result.inlineBlockerSources).toEqual(["lsp"]);
			expect(result.inlineBlockerLines).toEqual([1]);
			expect(result.inlineBlockerDiagnostics).toHaveLength(1);
			expect(result.hasBlockers).toBe(true);
		});

		it("does not carry a cited line from a retracted blocker on the edited file", async () => {
			// The one shape where `inlineBlockerLines` differs from the ungated
			// derivation: the edited file itself is gone (the #3188 bash-write-then-
			// delete shape), a blocker cites it, and a second blocker cites a live
			// sibling. The dead line is the only one the cross-file filter would
			// keep, and the past-EOF gate at turn end would then measure it against
			// a file that no longer exists.
			const deletedTarget = path.join(tmpDir, "deleted-target-3190.ts");
			const liveSibling = createTempFile(
				tmpDir,
				"sibling-3190.ts",
				"const y = 2;\n",
			);
			vi.mocked(dispatchLintWithResult).mockResolvedValue(
				dispatchWith([
					blocker(deletedTarget, 42, "GHOST-3190-MARKER past the end", "ruff"),
					blocker(liveSibling, 1, "SURVIVOR-3190-MARKER unused var", "ruff"),
				]) as never,
			);

			const result = await runPipeline(
				createMockContext(deletedTarget),
				createMockDeps(),
			);

			expect(result.inlineBlockerLines).toEqual([]);
			expect(result.inlineBlockerSummary).toContain("SURVIVOR-3190-MARKER");
			expect(result.inlineBlockerSummary).not.toContain("GHOST-3190-MARKER");
		});

		it("leaves the record byte-identical to the dispatcher's blockerOutput when nothing is retracted", async () => {
			const filePath = createTempFile(tmpDir, "intact-3190.ts", "const x = 1;");
			const dispatch = dispatchWith([
				blocker(filePath, 1, "SURVIVOR-3190-MARKER unused var", "lsp"),
				blocker(filePath, 2, "SECOND-3190-MARKER shadowed name", "lsp"),
			]);
			vi.mocked(dispatchLintWithResult).mockResolvedValue(dispatch as never);

			const result = await runPipeline(
				createMockContext(filePath),
				createMockDeps(),
			);

			expect(result.inlineBlockerSummary).toBe(dispatch.blockerOutput.trim());
			expect(result.inlineBlockerSources).toEqual(["lsp"]);
			expect(result.inlineBlockerLines).toEqual([1, 2]);
			expect(result.inlineBlockerDiagnostics).toHaveLength(2);
			expect(result.hasBlockers).toBe(true);
		});
	});
});
