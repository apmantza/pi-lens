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

import { installLspServiceDouble } from "../support/lsp-service-seam.js";
import { scaledTestTimeout } from "../support/test-timeout-scale.js";

// #4019: the Windows lane declares PI_LENS_TEST_TIMEOUT_SCALE=3 because a
// native path-canonicalization syscall per pipeline run makes a population
// test cost several times its Linux time; the factor is the lane's, and
// `scaledTestTimeout` is its one home (#4592 review F5 fold). 1 everywhere
// else, so no POSIX budget moves.

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
		mockLSPService = await installLspServiceDouble({
			supportsLSP: vi.fn().mockReturnValue(true),
			hasLSP: vi.fn().mockResolvedValue(true),
		});
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

	// #4137 round 3: `clearInlineBlockers` compares the bytes a run without
	// authorship read against the record it would clear, so the baseline is
	// returned for a clean result too, not only beside a blocker.
	it("carries the content baseline of the bytes it analysed on a clean result", async () => {
		const filePath = createTempFile(
			tmpDir,
			"clean-baseline.ts",
			"const x = 1;\n",
		);
		vi.mocked(dispatchLintWithResult).mockImplementationOnce(async () => ({
			diagnostics: [],
			blockers: [],
			warnings: [],
			baselineWarningCount: 0,
			fixed: [],
			resolvedCount: 0,
			output: "clean",
			blockerOutput: "",
			hasBlockers: false,
		}));

		const result = await runPipeline(
			createMockContext(filePath, { allowAutonomousWriters: false }),
			createMockDeps(),
		);

		expect(result.hasBlockers).toBe(false);
		expect(result.inlineBlockerFileContent).toEqual({
			size: Buffer.byteLength("const x = 1;\n"),
			sha256: createHash("sha256").update("const x = 1;\n").digest("hex"),
		});
	});

	it.each([2 * 1024 * 1024, 2 * 1024 * 1024 + 1])(
		"preserves inline baseline byte boundary at %i",
		async (size) => {
			const filePath = createTempFile(
				tmpDir,
				"clean-baseline.ts",
				"x".repeat(size),
			);
			vi.mocked(dispatchLintWithResult).mockImplementationOnce(async () => ({
				diagnostics: [],
				blockers: [],
				warnings: [],
				baselineWarningCount: 0,
				fixed: [],
				resolvedCount: 0,
				output: "clean",
				blockerOutput: "",
				hasBlockers: false,
			}));

			const result = await runPipeline(
				createMockContext(filePath, { allowAutonomousWriters: false }),
				createMockDeps(),
			);

			expect(result.hasBlockers).toBe(false);
			expect(result.inlineBlockerFileContent).toEqual(
				size <= 2 * 1024 * 1024
					? {
							size,
							sha256: createHash("sha256")
								.update("x".repeat(size))
								.digest("hex"),
						}
					: undefined,
			);
		},
	);

	it("states why a delta-promoted unused finding blocks in the enriched STOP block (#3218)", async () => {
		// The turn-end replay renders through `formatDiagnostics`, but the inline
		// tool result renders the enriched variant. Both must carry the seam's
		// rationale, or the agent sees a hint-severity finding labelled a blocker
		// with no explanation during the edit itself.
		const filePath = createTempFile(
			tmpDir,
			"promoted-blocker.ts",
			"const tmpdir = 1;\n",
		);
		const blocker: Diagnostic = {
			id: "promoted-unused",
			message: "'tmpdir' is declared but its value is never read.",
			filePath,
			severity: "error",
			semantic: "blocking",
			tool: "lsp",
			line: 1,
			promotionNote:
				"new in this edit → blocks in delta mode; pre-existing unused declarations only advise.",
		};
		vi.mocked(dispatchLintWithResult).mockResolvedValue({
			diagnostics: [blocker],
			blockers: [blocker],
			warnings: [],
			baselineWarningCount: 0,
			fixed: [],
			resolvedCount: 0,
			output: "",
			blockerOutput: "",
			hasBlockers: true,
		});

		const result = await runPipeline(
			createMockContext(filePath),
			createMockDeps(),
		);

		expect(result.output).toContain("🔴 STOP — 1 issue(s) must be fixed");
		expect(result.output).toContain(
			"new in this edit → blocks in delta mode; pre-existing unused declarations only advise.",
		);
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
		// #3568: and the dispatch, whose collect-later runner defers its result
		// to a turn end through the same handle
		// (tests/clients/dispatch/runner-collect-later.test.ts pins the drop).
		expect(dispatchLintWithResult).toHaveBeenCalledWith(
			filePath,
			tmpDir,
			expect.anything(),
			undefined,
			expect.anything(),
			expect.objectContaining({ sessionGeneration }),
		);
	});

	it("hands the cascade the dispatch's order turn beside its session turn (#3540 r2)", async () => {
		// The cascade's widget reconcile orders by the order turn, which a
		// session reset never restarts; `turnSeq` (the session's turn) keeps
		// scoping its caches. If this hop drops `orderTurn`, the reconcile is
		// unordered in production.
		const filePath = createTempFile(tmpDir, "cascade-order-turn.ts", "x");
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
				telemetry: {
					model: "m",
					sessionId: "s",
					turnIndex: 1,
					orderTurn: 6,
					writeIndex: 2,
				},
			}),
			createMockDeps(),
		);

		expect(computeCascadeForFile).toHaveBeenCalledWith(
			filePath,
			tmpDir,
			expect.objectContaining({ turnSeq: 1, orderTurn: 6, writeSeq: 2 }),
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
				const result = await originalFormatFile(fp, {
					sessionRoot: path.dirname(fp),
				});
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

		it(
			"bounds opaque ownership telemetry across many paths (#3226 review P2)",
			async () => {
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
				// 10,000 sequential real pipeline runs: ~0.7 s on Linux, past Vitest's
				// 5 s default on the Windows runner where every run pays native
				// path-canonicalization syscalls (#4019). The population is the claim, so
				// the budget grows rather than the population shrinking.
				//
				// #4518: the fixed 60 s budget was still a coin flip there -- measured
				// 36.8 s on a green master run and past 60 s on two red ones
				// (jobs 117494029210 green, 117489510490 and 117436379966 red), which
				// is what kept the lane red before it could gate. The lane's own scale
				// is the margin (180 s on Windows, unchanged on POSIX) rather than a
				// second magic constant.
			},
			scaledTestTimeout(60_000),
		);

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
				const result = await originalFormatFile(fp, {
					sessionRoot: path.dirname(fp),
				});
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
				const result = await originalFormatFile(fp, {
					sessionRoot: path.dirname(fp),
				});
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

	describe("Cascade compute rejection (#3605)", () => {
		const { WebAssembly } = globalThis as unknown as {
			WebAssembly: { RuntimeError: new (message: string) => Error };
		};

		async function cascadeAfterRejection(error: Error) {
			const filePath = createTempFile(tmpDir, "cascade-throws.ts", "x");
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
			vi.mocked(computeCascadeForFile).mockRejectedValueOnce(error);
			const result = await runPipeline(
				createMockContext(filePath),
				createMockDeps(),
			);
			return (await result.cascadePromise)?.indeterminate;
		}

		it("reports a tree-sitter wasm trap as a degraded graph, not a compute error", async () => {
			// The per-edit cascade turned the reporter's wasm trap into
			// `cascade_indeterminate` / `error`.
			expect(
				await cascadeAfterRejection(
					new WebAssembly.RuntimeError("table index is out of bounds"),
				),
			).toEqual({
				reason: "graph_degraded",
				detail: "review graph degraded — tree-sitter wasm runtime failure",
			});
		});

		it("still reports any other rejection as a compute error", async () => {
			expect(await cascadeAfterRejection(new TypeError("cascade bug"))).toEqual(
				{ reason: "error", detail: "cascade computation failed" },
			);
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

		// Recurrence: #4734 review F1 and Greptile "Unchecked edits look checked".
		// `tool_result` read "found nothing" off `output` being empty, but a clean
		// run's output is the all-clear line, and an empty output is a format-only
		// change whose primary may never have answered. #4734 r3: the all-clear
		// line is not the verdict either; it also ends a run with only warnings,
		// one no language server answered, and one without authorship holding a
		// blocker. Each cell below is a row of the round-3 state table.
		const cleanDispatch = (
			shape: {
				unconfirmedStatus?: string;
				primaryLspChecked?: true;
				warnings?: Diagnostic[];
				heldBackBlockers?: Diagnostic[];
			} = {},
		) =>
			({
				diagnostics: shape.warnings ?? [],
				blockers: [],
				warnings: shape.warnings ?? [],
				baselineWarningCount: 0,
				fixed: [],
				resolvedCount: 0,
				output: "",
				blockerOutput: "",
				hasBlockers: false,
				...(shape.unconfirmedStatus !== undefined && {
					unconfirmedStatus: shape.unconfirmedStatus,
				}),
				...(shape.primaryLspChecked && { primaryLspChecked: true }),
				...(shape.heldBackBlockers && {
					heldBackBlockers: shape.heldBackBlockers,
				}),
			}) as Awaited<ReturnType<typeof dispatchLintWithResult>>;
		const answered = { primaryLspChecked: true } as const;
		const verdictOf = async (
			filePath: string,
			dispatched: Awaited<ReturnType<typeof dispatchLintWithResult>>,
			overrides?: Partial<PipelineContext>,
		) => {
			vi.mocked(dispatchLintWithResult).mockResolvedValue(dispatched);
			const result = await runPipeline(
				createMockContext(filePath, overrides),
				createMockDeps(),
			);
			return [result.output.split(" · ")[0], result.checkedClean];
		};

		it("reports a checked clean verdict with the clean line, and none for an unconfirmed one", async () => {
			const filePath = createTempFile(tmpDir, "app.ts", "const x = 1;");
			// A file no language covers ends with a bare timing line, no "clean".
			const unknownPath = createTempFile(tmpDir, "notes.zzz", "x\n");

			expect({
				// Row 14, the one cell: a language server answered, nothing recorded.
				clean: await verdictOf(filePath, cleanDispatch(answered)),
				// Row 7.
				unconfirmed: (
					await verdictOf(
						filePath,
						cleanDispatch({
							unconfirmedStatus:
								"no primary language server answered (disabled)",
						}),
					)
				).map((v) => (typeof v === "string" ? v.split(" — ")[0] : v)),
				// Row 9: the dispatcher sets no language-server verdict without a kind.
				unknown: (await verdictOf(unknownPath, cleanDispatch())).map((v) =>
					typeof v === "string" ? v.includes("clean") : v,
				),
			}).toEqual({
				clean: ["✓ JavaScript/TypeScript clean", true],
				unconfirmed: ["⚠ JavaScript/TypeScript unconfirmed", false],
				unknown: [false, false],
			});
		});

		it("reports no checked clean verdict for a run with only a warning behind the clean line", async () => {
			// Row 6 (verify r2 F1): the dispatcher renders no text for a warning, so
			// the run ends with the clean line while it recorded a finding.
			const filePath = createTempFile(tmpDir, "warn.ts", "const x = 1;");
			const warning: Diagnostic = {
				id: "lsp-unused",
				message: "'x' is declared but never read",
				filePath,
				line: 1,
				severity: "warning",
				semantic: "warning",
				tool: "lsp",
			};

			expect(
				await verdictOf(
					filePath,
					cleanDispatch({ ...answered, warnings: [warning] }),
				),
			).toEqual(["✓ JavaScript/TypeScript clean", false]);
		});

		it("reports no checked clean verdict for a clean line no language server answered", async () => {
			// Rows 8 and 10-13 (verify r2 F4): `--no-lsp`, a CLI primary, a fallback
			// linter, a deferred or a latched silent server all reach the pipeline
			// as this shape, no `unconfirmedStatus` and no language-server verdict
			// (the dispatcher cells in coverage-notice-runner-outcome.test.ts).
			const filePath = createTempFile(tmpDir, "nolsp.ts", "const x = 1;");

			expect(await verdictOf(filePath, cleanDispatch())).toEqual([
				"✓ JavaScript/TypeScript clean",
				false,
			]);
		});

		it("reports no checked clean verdict, and the withheld disclosure, for a run without authorship that keeps a blocker", async () => {
			// Row 5: without authorship (#3226) a held-back blocker renders no STOP
			// text. #5108: the run no longer ends with the clean line over it; it
			// states that the blocker was withheld.
			const filePath = createTempFile(
				tmpDir,
				"held.ts",
				"const x: number = 'a';",
			);
			const blocker: Diagnostic = {
				id: "lsp-2322",
				message: "Type 'string' is not assignable to type 'number'.",
				filePath,
				line: 1,
				severity: "error",
				semantic: "blocking",
				tool: "lsp",
			};

			expect(
				await verdictOf(
					filePath,
					cleanDispatch({ ...answered, heldBackBlockers: [blocker] }),
					{ allowAutonomousWriters: false },
				),
			).toEqual([
				expect.stringMatching(/^⚠ 1 blocking finding in held\.ts withheld/),
				false,
			]);
		});

		it("reports no checked clean verdict for a format-only change whose primary did not answer", async () => {
			const filePath = createTempFile(tmpDir, "fmt.ts", "const x=1;\n");
			vi.mocked(dispatchLintWithResult).mockResolvedValue(
				cleanDispatch({
					unconfirmedStatus: "no primary language server answered (disabled)",
				}),
			);
			const formatFile = vi.fn(async (fp: string) => {
				fs.writeFileSync(fp, "const x = 1;\n");
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
				}),
				createMockDeps({
					getFormatService: () => ({ recordRead: vi.fn(), formatFile }) as any,
				}),
			);

			// The shape the consumer used to read as "found nothing": no output.
			expect(formatFile).toHaveBeenCalled();
			expect(result.output).toBe("");
			expect(result.postAutofixNotice).toBeDefined();
			expect(result.checkedClean).toBe(false);
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
	// #5108: a run without authorship (#3226) withholds the STOP block and the
	// record, and says so. Recurrence prevented: pi session 01a192b9, where the
	// withheld blocker left the output empty and `buildAllClearOutput` rendered
	// `✓ JavaScript/TypeScript clean` over an lsp error on the written file.
	describe("#5108 withheld blockers in a run without authorship", () => {
		function blocker(
			filePath: string,
			tool: string,
			message: string,
			line = 3,
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

		// The family axis: the disclosure keys off the run's blocker set, not off
		// which runner raised it or which language the file is.
		it.each([
			["a TypeScript language server", "config.ts", "lsp"],
			["a Python language server", "config.py", "lsp"],
			["a Rust language server", "config.rs", "lsp"],
			["oxlint", "config.ts", "oxlint"],
		])(
			"discloses the blocker %s raised, never the all-clear",
			async (_member, name, tool) => {
				const filePath = createTempFile(tmpDir, name, "x = 1\n");
				vi.mocked(dispatchLintWithResult).mockResolvedValue(
					dispatchWith([
						blocker(filePath, tool, "Cannot find name 'PROVIDER_INFERX'"),
					]) as never,
				);

				const result = await runPipeline(
					createMockContext(filePath, { allowAutonomousWriters: false }),
					createMockDeps(),
				);

				expect(result.output).toContain(
					`1 blocking finding in ${name} withheld`,
				);
				expect(result.output).not.toMatch(/clean|\u2713/);
				expect(result.output).not.toContain("STOP");
				expect(result.withheldBlockerLine).toBe(result.output);
				// Withheld stays withheld (#3226, #4137): no record for the turn-end
				// replay and no verdict for the commit gate.
				expect(result.hasBlockers).toBe(false);
				expect(result.inlineBlockerSummary).toBeUndefined();
				expect(result.checkedClean).toBe(false);
			},
		);

		it("counts every withheld blocker", async () => {
			const filePath = createTempFile(tmpDir, "two.ts", "const x = 1;\n");
			vi.mocked(dispatchLintWithResult).mockResolvedValue(
				dispatchWith([
					blocker(filePath, "lsp", "first", 1),
					blocker(filePath, "oxlint", "second", 2),
				]) as never,
			);

			const result = await runPipeline(
				createMockContext(filePath, { allowAutonomousWriters: false }),
				createMockDeps(),
			);

			expect(result.output).toContain("2 blocking findings in two.ts withheld");
			expect(result.output).toContain("lens_diagnostics mode=all lists them");
		});

		it("keeps the all-clear for a run that held no blocker", async () => {
			// The control: the disclosure is the blocker's, not every unauthored
			// run's.
			const filePath = createTempFile(tmpDir, "fine.ts", "const x = 1;\n");
			vi.mocked(dispatchLintWithResult).mockResolvedValue(
				dispatchWith([]) as never,
			);

			const result = await runPipeline(
				createMockContext(filePath, { allowAutonomousWriters: false }),
				createMockDeps(),
			);

			expect(result.output).toContain("clean");
			expect(result.withheldBlockerLine).toBeUndefined();
		});

		it("renders the STOP block, not the disclosure, when the run is authored", async () => {
			// The other direction: authorship decides the channel, and the two are
			// never both rendered for one blocker.
			const filePath = createTempFile(tmpDir, "authored.ts", "const x = 1;\n");
			vi.mocked(dispatchLintWithResult).mockResolvedValue(
				dispatchWith([blocker(filePath, "lsp", "bad name")]) as never,
			);

			const result = await runPipeline(
				createMockContext(filePath),
				createMockDeps(),
			);

			expect(result.output).toContain("STOP");
			expect(result.output).not.toContain("withheld");
			expect(result.withheldBlockerLine).toBeUndefined();
		});
	});
});
