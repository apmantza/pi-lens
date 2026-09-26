/**
 * Replays of the `formal/store-freshness` counterexamples for the inline
 * blocker record and the widget store, driven through the real
 * `handleToolResult` + `runPipeline` + `RuntimeCoordinator` + widget store and
 * the real turn-end sweep. Only the dispatch runners and the LSP service are
 * doubled. Each case names the TLC config whose trace it replays.
 *
 * Recurrence: a verdict stamped with `Date.now()` at RECORD time (after the
 * dispatch await) treats a write that landed during the dispatch as older
 * than the verdict, so no freshness gate ever demotes it (#3503); a non-LSP
 * record's mtime fast path skips its hash inside the tolerance window
 * (#3504).
 *
 * No wall clock: `Date` is faked and pinned per step, and every mtime is set
 * with `utimesSync`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BiomeClient } from "../../clients/biome-client.js";
import { sweepInlineBlockerFreshness } from "../../clients/blocker-freshness.js";
import type { FormatService } from "../../clients/format-service.js";
import { setHostFileMutationQueueLoader } from "../../clients/file-mutation-queue.js";
import { runPipeline } from "../../clients/pipeline.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { handleToolResult } from "../../clients/runtime-tool-result.js";
import {
	clearWidgetState,
	getFileDiagnostics,
	getWidgetBlockingFilesForSweep,
	markWidgetFileBlockersStale,
	reconcileStaleWidgetDependencyBlockers,
	reconcileStaleWidgetFiles,
} from "../../clients/widget-state.js";
import { setupTestEnvironment } from "./test-utils.js";

vi.mock("../../clients/dispatch/integration.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../clients/dispatch/integration.js")
	>()),
	dispatchLintWithResult: vi.fn(),
	computeCascadeForFile: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../clients/lsp/index.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/lsp/index.js")>()),
	getLSPService: vi.fn(),
	resyncGitChangedFiles: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../clients/recent-touches.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/recent-touches.js")>()),
	appendRecentTouches: vi.fn().mockResolvedValue(undefined),
}));

import { dispatchLintWithResult } from "../../clients/dispatch/integration.js";
import { getLSPService } from "../../clients/lsp/index.js";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";

// The model's timeline, in ms. T_READ is the pipeline's analysis read; the
// dispatch awaits for 1.5 s, and a parallel write lands 400 ms into it.
const T_READ = 1_900_000_000_000;
const T_EDIT = T_READ + 400;
const T_REC = T_READ + 1500;

function setMtime(file: string, ms: number): void {
	fs.utimesSync(file, ms / 1000, ms / 1000);
}

function blockingFrom(tool: string, filePath: string) {
	const d = {
		id: `${tool}:blocker`,
		tool,
		rule: "TS2305",
		message: "BLOCKER computed on the pre-edit bytes",
		filePath,
		line: 1,
		column: 1,
		severity: "error",
		semantic: "blocking",
	};
	return {
		diagnostics: [d],
		blockers: [d],
		warnings: [],
		baselineWarningCount: 0,
		fixed: [],
		resolvedCount: 0,
		output: "STOP",
		blockerOutput: "STOP",
		hasBlockers: true,
	};
}

/**
 * Dispatch double: the analysis takes from T_READ to T_REC, and `during` runs
 * at T_EDIT, the moment a parallel tool call writes.
 */
function dispatchWith(tool: string, during?: () => void) {
	vi.mocked(dispatchLintWithResult).mockImplementation(async (fp) => {
		vi.setSystemTime(T_EDIT);
		during?.();
		vi.setSystemTime(T_REC);
		return blockingFrom(tool, fp as string) as never;
	});
}

const noBiome = {
	isSupportedFile: () => false,
	ensureAvailable: async () => false,
};

function deps(runtime: RuntimeCoordinator) {
	return {
		getFlag: (name: string) => name === "no-lsp",
		dbg: () => {},
		runtime,
		cacheManager: { addModifiedRange: () => {}, readTurnState: () => ({}) },
		biomeClient: noBiome,
		ruffClient: {
			isPythonFile: () => false,
			ensureAvailable: async () => false,
		},
		metricsClient: {},
		resetLSPService: () => {},
		agentBehaviorRecord: () => [],
		formatBehaviorWarnings: () => "",
	} as unknown as Parameters<typeof handleToolResult>[0];
}

const ev = (filePath: string) => ({
	toolName: "edit",
	toolCallId: "c1",
	input: { path: filePath },
	details: {},
	content: [],
});

/** One edit of `consumer.ts`, analysed from T_READ. */
async function editConsumer(env: { tmpDir: string }) {
	const filePath = path.join(env.tmpDir, "consumer.ts");
	const dep = path.join(env.tmpDir, "dep.ts");
	fs.writeFileSync(
		filePath,
		'import { y } from "./dep.js";\nexport const z = y;\n',
	);
	setMtime(filePath, T_READ - 1000);
	fs.writeFileSync(dep, "export const x = 1;\n");
	setMtime(dep, T_READ - 1000);
	const runtime = new RuntimeCoordinator();
	runtime.projectRoot = env.tmpDir;
	runtime.beginTurn();
	return { filePath, dep, runtime };
}

/**
 * The turn-end sweep as `runtime-turn.ts` calls it: the inline records plus the
 * widget store's blocking rows (#1790), with `consumer.ts` importing `dep`.
 */
function turnEndSweep(runtime: RuntimeCoordinator, cwd: string, dep?: string) {
	return sweepInlineBlockerFreshness(runtime, cwd, {
		resolveForwardImports: () => (dep ? [dep] : []),
		additionalEntries: getWidgetBlockingFilesForSweep().map((row) => ({
			filePath: row.filePath,
			recordedAtMs: row.recordedAtMs,
			demote: () =>
				markWidgetFileBlockersStale(row.filePath, "dependency-drift"),
		})),
	});
}

function inlineRecord(runtime: RuntimeCoordinator) {
	const [record] = runtime.getInlineBlockersSnapshot();
	return {
		recordedAtMs: record?.recordedAtMs,
		stale: record?.stale ?? false,
		staleReason: record?.staleReason,
	};
}

function widgetRows(filePath: string) {
	return (getFileDiagnostics(filePath) ?? []).map((d) => ({
		stale: d.stale ?? false,
		staleReason: d.staleReason,
	}));
}

describe("formal/store-freshness replays", () => {
	beforeEach(() => {
		clearWidgetState();
		vi.mocked(getLSPService).mockReturnValue(
			makeLspServiceDouble({
				supportsLSP: () => false,
				hasLSP: async () => false,
				openFile: async () => {},
				touchFile: async () => {},
				getAllDiagnostics: async () => new Map(),
			}) as never,
		);
		vi.mocked(dispatchLintWithResult).mockReset();
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(T_READ);
	});
	afterEach(() => {
		vi.useRealTimers();
		clearWidgetState();
	});

	// ── #3503: the reference stamp is the analysis read ──────────────────────
	describe("the verdict is stamped at the analysis read (#3503)", () => {
		/** consumer.ts edited, with its dependency written 400 ms into the dispatch. */
		async function depWrittenDuringDispatch(env: { tmpDir: string }) {
			const edit = await editConsumer(env);
			dispatchWith("lsp", () => {
				fs.writeFileSync(
					edit.dep,
					"export const x = 1;\nexport const y = 2;\n",
				);
				setMtime(edit.dep, T_EDIT);
			});
			await handleToolResult({
				...deps(edit.runtime),
				event: ev(edit.filePath),
			} as never);
			return edit;
		}

		it("BlockerDepLateStamp (#3503): a dependency written during the dispatch demotes the inline blocker and the widget row at turn end", async () => {
			const env = setupTestEnvironment("tla-store-dep-");
			try {
				const { filePath, dep, runtime } = await depWrittenDuringDispatch(env);
				const recordedAtMs = inlineRecord(runtime).recordedAtMs;
				const sweepFeed = getWidgetBlockingFilesForSweep();
				const counts = await turnEndSweep(runtime, env.tmpDir, dep);
				expect(counts.revalidated).toBe(1);
				expect(inlineRecord(runtime)).toMatchObject({
					stale: true,
					staleReason: "dependency-drift",
				});
				expect(widgetRows(filePath)).toEqual([
					{ stale: true, staleReason: "dependency-drift" },
				]);
				// The one stamp fed the record and the sweep's widget population.
				expect(recordedAtMs).toBe(T_READ);
				expect(sweepFeed).toEqual([
					{ filePath: path.resolve(filePath), recordedAtMs: T_READ },
				]);
			} finally {
				env.cleanup();
			}
		});

		it("BlockerDepLateStamp (#3503): a dependency written during the dispatch demotes the widget row through the widget store's own import gate", async () => {
			const env = setupTestEnvironment("tla-store-dep-widget-");
			try {
				const { filePath } = await depWrittenDuringDispatch(env);
				// The real import resolver, reading consumer.ts' own import.
				const result = await reconcileStaleWidgetDependencyBlockers(env.tmpDir);
				expect(result.demoted).toBe(1);
				expect(widgetRows(filePath)).toEqual([
					{ stale: true, staleReason: "dependency-drift" },
				]);
			} finally {
				env.cleanup();
			}
		});

		it("FixReadStamp control (#3503): a dependency written before the analysis read does not demote", async () => {
			const env = setupTestEnvironment("tla-store-dep-before-");
			try {
				const { filePath, dep, runtime } = await editConsumer(env);
				// Written before the read, its mtime leading the clock by 40 ms
				// (the #1710 skew the 50 ms tolerance absorbs).
				setMtime(dep, T_READ + 40);
				dispatchWith("lsp");
				await handleToolResult({
					...deps(runtime),
					event: ev(filePath),
				} as never);
				expect(
					(await reconcileStaleWidgetDependencyBlockers(env.tmpDir)).demoted,
				).toBe(0);
				const counts = await turnEndSweep(runtime, env.tmpDir, dep);
				expect(counts.revalidated).toBe(0);
				expect(inlineRecord(runtime)).toMatchObject({ stale: false });
				expect(widgetRows(filePath)).toEqual([
					{ stale: false, staleReason: undefined },
				]);
			} finally {
				env.cleanup();
			}
		});

		it("WidgetOwnLateStamp (#3503): the file rewritten during the dispatch drops its widget row", async () => {
			const env = setupTestEnvironment("tla-store-own-");
			try {
				const { filePath, runtime } = await editConsumer(env);
				dispatchWith("lsp", () => {
					fs.writeFileSync(filePath, "export const z = 3;\n");
					setMtime(filePath, T_EDIT);
				});
				await handleToolResult({
					...deps(runtime),
					event: ev(filePath),
				} as never);
				expect(widgetRows(filePath)).toHaveLength(1);
				expect(await reconcileStaleWidgetFiles()).toBe(1);
				expect(widgetRows(filePath)).toEqual([]);
			} finally {
				env.cleanup();
			}
		});

		// No-drop direction: the stamp is the FINAL analysis read, after
		// pi-lens' own writes, so its own write never demotes its own verdict.
		function pipelineDeps(overrides: {
			getFormatService?: () => FormatService;
			biomeClient?: unknown;
		}) {
			return {
				biomeClient: (overrides.biomeClient ?? noBiome) as BiomeClient,
				ruffClient: { isPythonFile: () => false } as never,
				metricsClient: {} as never,
				getFormatService:
					overrides.getFormatService ??
					(() => ({ recordRead: () => {} }) as unknown as FormatService),
				fixedThisTurn: new Set<string>(),
			};
		}

		it("FixReadStamp no-drop (#3503): the --immediate-format write that precedes the read does not drop the row", async () => {
			const env = setupTestEnvironment("tla-store-format-");
			try {
				const filePath = path.join(env.tmpDir, "a.ts");
				fs.writeFileSync(filePath, "let value=1\n");
				setMtime(filePath, T_READ - 1000);
				dispatchWith("lsp");
				const formatService = {
					recordRead: () => {},
					formatFile: async (fp: string) => {
						vi.setSystemTime(T_EDIT);
						fs.writeFileSync(fp, "let value = 1;\n");
						setMtime(fp, T_EDIT);
						return {
							filePath: fp,
							formatters: [{ name: "biome", success: true, changed: true }],
							anyChanged: true,
							allSucceeded: true,
						};
					},
				} as unknown as FormatService;
				const result = await runPipeline(
					{
						filePath,
						cwd: env.tmpDir,
						toolName: "edit",
						autofixMode: "deferred",
						getFlag: (name: string) =>
							name === "immediate-format" || name === "no-lsp",
						dbg: () => {},
					},
					pipelineDeps({ getFormatService: () => formatService }),
				);
				expect(result.fileModified).toBe(true);
				expect(await reconcileStaleWidgetFiles()).toBe(0);
				expect(widgetRows(filePath)).toHaveLength(1);
				// The same stamp is what the inline record receives.
				expect(result.analysisReadAtMs).toBe(T_EDIT);
			} finally {
				env.cleanup();
			}
		});

		describe("the immediate autofix", () => {
			beforeEach(() => {
				setHostFileMutationQueueLoader(async () => ({ withFileMutationQueue }));
			});
			afterEach(() => {
				setHostFileMutationQueueLoader(undefined);
			});

			it("FixReadStamp no-drop (#3503): the autofix write that precedes the re-read does not drop the row", async () => {
				const env = setupTestEnvironment("tla-store-autofix-");
				try {
					fs.writeFileSync(
						path.join(env.tmpDir, "package.json"),
						JSON.stringify({
							devDependencies: { "@biomejs/biome": "^2.4.10" },
						}),
					);
					fs.writeFileSync(
						path.join(env.tmpDir, "package-lock.json"),
						JSON.stringify({
							lockfileVersion: 3,
							packages: {
								"": {},
								"node_modules/@biomejs/biome": { version: "2.4.10" },
							},
						}),
					);
					const filePath = path.join(env.tmpDir, "a.ts");
					fs.writeFileSync(filePath, "var a = 1;\n");
					setMtime(filePath, T_READ - 1000);
					dispatchWith("lsp");
					const fixer = {
						isSupportedFile: () => true,
						ensureAvailable: async () => true,
						fixFileAsync: async (fp: string) => {
							vi.setSystemTime(T_EDIT);
							fs.writeFileSync(fp, "const a = 1;\n");
							setMtime(fp, T_EDIT);
							return { success: true, changed: true, fixed: 1 };
						},
					};
					const result = await runPipeline(
						{
							filePath,
							cwd: env.tmpDir,
							toolName: "write",
							getFlag: (name: string) => name === "no-lsp",
							dbg: () => {},
						},
						pipelineDeps({ biomeClient: fixer }),
					);
					expect(result.fileModified).toBe(true);
					expect(await reconcileStaleWidgetFiles()).toBe(0);
					expect(widgetRows(filePath)).toHaveLength(1);
					// The same stamp is what the inline record receives.
					expect(result.analysisReadAtMs).toBe(T_EDIT);
				} finally {
					env.cleanup();
				}
			});
		});
	});

	// ── #3504: a non-LSP record hashes whenever it has a hash baseline ───────
	describe("a non-LSP record confirms equal-size bytes by hash (#3504)", () => {
		for (const [label, mtimeMs] of [
			["inside the 50 ms tolerance after the stamp", T_READ + 20],
			["with an mtime older than the stamp", T_READ - 500],
		] as const) {
			it(`BlockerNonLspOwnFastPath (#3504): a same-size rewrite ${label} is demoted for self-drift`, async () => {
				const env = setupTestEnvironment("tla-store-self-");
				try {
					const { filePath, runtime } = await editConsumer(env);
					const before = fs.readFileSync(filePath, "utf8");
					dispatchWith("ast-grep", () => {
						const after = before.replace("z = y", "q = y");
						expect(after.length).toBe(before.length);
						fs.writeFileSync(filePath, after);
						setMtime(filePath, mtimeMs);
					});
					await handleToolResult({
						...deps(runtime),
						event: ev(filePath),
					} as never);
					expect(inlineRecord(runtime)).toMatchObject({ stale: false });
					const counts = await turnEndSweep(runtime, env.tmpDir);
					expect(counts.revalidated).toBe(1);
					expect(inlineRecord(runtime)).toMatchObject({
						stale: true,
						staleReason: "self-drift",
					});
				} finally {
					env.cleanup();
				}
			});
		}

		for (const [label, mtimeMs] of [
			["inside the tolerance", T_READ + 20],
			["past the tolerance", T_REC + 400],
		] as const) {
			it(`FixBlockerForceHash no-drop (#3504): a touch that moves the mtime ${label} without changing a byte keeps the record`, async () => {
				const env = setupTestEnvironment("tla-store-touch-");
				try {
					const { filePath, runtime } = await editConsumer(env);
					dispatchWith("ast-grep", () => setMtime(filePath, mtimeMs));
					await handleToolResult({
						...deps(runtime),
						event: ev(filePath),
					} as never);
					const counts = await turnEndSweep(runtime, env.tmpDir);
					expect(counts).toMatchObject({ kept: 1, revalidated: 0 });
					expect(inlineRecord(runtime)).toMatchObject({ stale: false });
				} finally {
					env.cleanup();
				}
			});
		}
	});
});
