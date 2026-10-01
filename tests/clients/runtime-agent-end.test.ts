import * as fs from "node:fs";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import * as path from "node:path";
import type { ActionableWarningsReport } from "../../clients/actionable-warnings.js";
import { CacheManager } from "../../clients/cache-manager.js";
import { getProjectDataDir } from "../../clients/file-utils.js";
import { resolvePiLensFlag } from "../../clients/lens-config.js";
import { recordMutationThroughSeam } from "../../clients/mutation-bridge.js";
import { readChangesSince } from "../../clients/project-changes.js";
import { loadPiLensProjectConfig } from "../../clients/project-lens-config.js";
import { handleAgentEnd } from "../../clients/runtime-agent-end.js";
import { handleToolCall } from "../../clients/runtime-tool-call.js";
import { handleToolResult } from "../../clients/runtime-tool-result.js";
import { getLastLoggedPhase } from "../../clients/latency-logger.js";
import * as latencyLogger from "../../clients/latency-logger.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { setAmbientAbortSignal } from "../../clients/safe-spawn.js";
import {
	createTempFile,
	cleanupTestEnvironmentsDrained,
	setupTestEnvironment,
} from "./test-utils.js";
import {
	_resetForTests as resetBusPublish,
	wireBusEmitter,
} from "../../clients/bus-publish.js";
import {
	_resetFormatEventsPublishForTests as resetFormatEventsPublish,
	wireFormatEventsBusEmitter,
} from "../../clients/format-events-publish.js";

// Only the "stale report" test below enables lens-actionable-warning-autofix,
// and it returns before reaching applyConservativeActionableWarningFixes (the
// staleness check short-circuits first) — safe to mock this at module scope
// for the dedicated #502 fix-provenance test further down without affecting
// any other test in this file.
const applyConservativeActionableWarningFixesMock = vi.fn();
vi.mock("../../clients/actionable-warnings.js", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("../../clients/actionable-warnings.js")
		>();
	return {
		...actual,
		applyConservativeActionableWarningFixes: (
			...args: Parameters<typeof actual.applyConservativeActionableWarningFixes>
		) => applyConservativeActionableWarningFixesMock(...args),
	};
});

// #1642 F3: only `runPipeline` (tool-result.ts's own dispatch, exercised by
// the "drive the real queue path" test below via handleToolResult) is
// stubbed — `runAutofix`/`runFormatPhase`/`resyncLspFile` stay REAL, since
// every other test in this file relies on agent-end.ts's own use of them.
vi.mock("../../clients/pipeline.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/pipeline.js")>();
	return { ...actual, runPipeline: vi.fn() };
});

// #3785 review r1 F1: the #3521 format cases run the real FormatService,
// whose FileTime shared the read guard's; only the formatter child is
// doubled there, per case. Every other case doubles the service itself.
vi.mock("../../clients/formatters.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/formatters.js")>();
	return {
		...actual,
		getFormattersForFile: vi.fn(actual.getFormattersForFile),
		formatFile: vi.fn(actual.formatFile),
	};
});
import { getFormatService } from "../../clients/format-service.js";
import {
	type FormatterInfo,
	formatFile as runFormatter,
	getFormattersForFile,
} from "../../clients/formatters.js";

describe("runtime-agent-end deferred formatting", () => {
	const cleanupAgentEndTemps = async () => {
		await cleanupTestEnvironmentsDrained("pi-lens-agent-end-");
	};

	afterEach(cleanupAgentEndTemps);
	afterAll(cleanupAgentEndTemps);

	it("does not resolve autofix clients for format-only records", async () => {
		const env = setupTestEnvironment("pi-lens-agent-end-format-only-clients-");
		try {
			const filePath = createTempFile(
				env.tmpDir,
				"format-only.ts",
				"const x=1\n",
			);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.deferFormat(filePath, env.tmpDir, "write", env.tmpDir);
			const getAutofixClients = vi.fn();
			await handleAgentEnd({
				ctxCwd: env.tmpDir,
				getFlag: (name) => name === "no-lsp",
				notify: vi.fn(),
				dbg: () => {},
				runtime,
				cacheManager: { addModifiedRange: vi.fn() } as any,
				getFormatService: () =>
					({
						recordRead: () => {},
						formatFile: async (fp: string) => ({
							filePath: fp,
							formatters: [],
							anyChanged: false,
							allSucceeded: true,
						}),
					}) as any,
				getAutofixClients,
			});
			expect(getAutofixClients).not.toHaveBeenCalled();
		} finally {
			env.cleanup();
		}
	});

	it("merges both phases when an aborted drain requeues one path twice", async () => {
		const env = setupTestEnvironment("pi-lens-agent-end-both-abort-");
		const controller = new AbortController();
		controller.abort();
		setAmbientAbortSignal(controller.signal);
		try {
			const logSpy = vi.spyOn(latencyLogger, "logLatency");
			const filePath = createTempFile(env.tmpDir, "both.ts", "const x=1\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.deferMutation(
				filePath,
				env.tmpDir,
				"edit",
				env.tmpDir,
				"autofix",
			);
			runtime.deferMutation(filePath, env.tmpDir, "edit", env.tmpDir, "format");

			await handleAgentEnd({
				ctxCwd: env.tmpDir,
				getFlag: (name) => name === "no-lsp",
				notify: vi.fn(),
				dbg: () => {},
				runtime,
				cacheManager: { addModifiedRange: vi.fn() } as any,
				getFormatService: () =>
					({ recordRead: () => {}, formatFile: vi.fn() }) as any,
			});

			expect(runtime.consumeDeferredFormatFiles()[0].kinds).toEqual(
				new Set(["autofix", "format"]),
			);
			// S2d (gap 4, #1432 review): one per-requeue record per abort branch,
			// distinguishable by reason/kinds instead of collapsing into the
			// aggregate drain row's coalesced requeuedKinds set.
			expect(logSpy).toHaveBeenCalledWith(
				expect.objectContaining({
					phase: "agent_end_deferred_mutation_requeue",
					metadata: expect.objectContaining({
						reason: "abort",
						kinds: ["autofix"],
						fileCount: 1,
					}),
				}),
			);
			expect(logSpy).toHaveBeenCalledWith(
				expect.objectContaining({
					phase: "agent_end_deferred_mutation_requeue",
					metadata: expect.objectContaining({
						reason: "abort",
						kinds: ["format"],
						fileCount: 1,
					}),
				}),
			);
		} finally {
			setAmbientAbortSignal(undefined);
			env.cleanup();
		}
	});

	it("preserves both kinds when autofix clients and formatting fail", async () => {
		const env = setupTestEnvironment("pi-lens-agent-end-both-fail-");
		try {
			const logSpy = vi.spyOn(latencyLogger, "logLatency");
			const filePath = createTempFile(env.tmpDir, "both.ts", "const x=1\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.deferMutation(
				filePath,
				env.tmpDir,
				"edit",
				env.tmpDir,
				"autofix",
			);
			runtime.deferMutation(filePath, env.tmpDir, "edit", env.tmpDir, "format");

			await handleAgentEnd({
				ctxCwd: env.tmpDir,
				getFlag: (name) => name === "no-lsp",
				notify: vi.fn(),
				dbg: () => {},
				runtime,
				cacheManager: { addModifiedRange: vi.fn() } as any,
				getFormatService: () =>
					({
						recordRead: () => {},
						formatFile: async () => {
							throw new Error("format failed");
						},
					}) as any,
			});

			expect(runtime.consumeDeferredFormatFiles()[0].kinds).toEqual(
				new Set(["autofix", "format"]),
			);
			// S2d (gap 4, #1432 review): no biomeClient/ruffClient were passed, so
			// the autofix branch requeues for "clients-unavailable"; the format
			// branch requeues separately for "format-failed" — two distinct
			// per-requeue records, not one indistinguishable aggregate.
			expect(logSpy).toHaveBeenCalledWith(
				expect.objectContaining({
					phase: "agent_end_deferred_mutation_requeue",
					metadata: expect.objectContaining({
						reason: "clients-unavailable",
						kinds: ["autofix"],
						fileCount: 1,
					}),
				}),
			);
			expect(logSpy).toHaveBeenCalledWith(
				expect.objectContaining({
					phase: "agent_end_deferred_mutation_requeue",
					metadata: expect.objectContaining({
						reason: "format-failed",
						kinds: ["format"],
						fileCount: 1,
					}),
				}),
			);
		} finally {
			env.cleanup();
		}
	});

	it("does not requeue or fail an unavailable formatter; records it distinctly (#2413)", async () => {
		const env = setupTestEnvironment("pi-lens-agent-end-unavailable-");
		try {
			const logSpy = vi.spyOn(latencyLogger, "logLatency");
			const filePath = createTempFile(env.tmpDir, "src/app.ts", "const x=1\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.deferFormat(filePath, env.tmpDir, "edit", env.tmpDir);

			// The FormatService reports the selected formatter as unavailable — the
			// oxfmt ENOENT trap after the fix. Pre-fix this arrived as a failed file,
			// was requeued as format-failed, and re-fired on every subsequent
			// agent_end. It must now drain once, distinctly, and never requeue.
			const formatFile = vi.fn(async (fp: string) => ({
				filePath: fp,
				formatters: [
					{
						name: "oxfmt",
						success: true,
						changed: false,
						outcome: "unavailable" as const,
						error: "oxfmt: formatter executable not found",
					},
				],
				anyChanged: false,
				allSucceeded: true,
			}));

			// `vi.spyOn(logLatency)` shares accumulated history across this file's
			// tests (spies are never restored), so scope the negative requeue
			// assertion to only the calls this handleAgentEnd makes.
			logSpy.mockClear();

			const summary = await handleAgentEnd({
				ctxCwd: env.tmpDir,
				getFlag: (name) => name === "no-lsp",
				notify: vi.fn(),
				dbg: () => {},
				runtime,
				cacheManager: { addModifiedRange: vi.fn() } as any,
				getFormatService: () => ({ recordRead: () => {}, formatFile }) as any,
			});

			// Not a failed file, and surfaced under its own bucket.
			expect(summary?.failed).toEqual([]);
			expect(summary?.unavailable).toEqual([
				{
					filePath,
					formatter: "oxfmt",
					reason: "oxfmt: formatter executable not found",
				},
			]);
			// Durable unavailability is NOT requeued — the queue is drained.
			expect(runtime.pendingDeferredFormatCount).toBe(0);
			expect(runtime.consumeDeferredFormatFiles()).toEqual([]);
			// And no `format-failed` requeue record was ever emitted for it.
			expect(logSpy).not.toHaveBeenCalledWith(
				expect.objectContaining({
					phase: "agent_end_deferred_mutation_requeue",
					metadata: expect.objectContaining({ reason: "format-failed" }),
				}),
			);
		} finally {
			env.cleanup();
		}
	});

	it("runs deferred autofix before format on the final edit state", async () => {
		const env = setupTestEnvironment("pi-lens-agent-end-mutation-order-");
		try {
			const logSpy = vi.spyOn(latencyLogger, "logLatency");
			const filePath = createTempFile(
				env.tmpDir,
				"src/app.ts",
				"let value=1\n",
			);
			fs.writeFileSync(path.join(env.tmpDir, "biome.json"), "{}\n");
			// The shared agreement gate requires independent lockfile evidence for
			// the Biome autonomous writer; the config file alone must not authorize
			// a deferred mutation.
			fs.writeFileSync(
				path.join(env.tmpDir, "package.json"),
				JSON.stringify({ devDependencies: { "@biomejs/biome": "^1.0.0" } }),
			);
			fs.writeFileSync(
				path.join(env.tmpDir, "package-lock.json"),
				JSON.stringify({
					packages: { "node_modules/@biomejs/biome": { version: "1.0.0" } },
				}),
			);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.deferMutation(
				filePath,
				env.tmpDir,
				"edit",
				env.tmpDir,
				"autofix",
			);
			runtime.deferMutation(filePath, env.tmpDir, "edit", env.tmpDir, "format");
			const order: string[] = [];
			const biomeClient = {
				isSupportedFile: () => true,
				ensureAvailable: async () => true,
				fixFileAsync: async (fp: string) => {
					order.push("autofix");
					fs.writeFileSync(fp, "const value=1\n");
					return { success: true, changed: true, fixed: 1 };
				},
			};
			await handleAgentEnd({
				ctxCwd: env.tmpDir,
				getFlag: (name) => name === "no-lsp",
				notify: vi.fn(),
				dbg: () => {},
				runtime,
				cacheManager: { addModifiedRange: vi.fn() } as any,
				biomeClient: biomeClient as any,
				ruffClient: {} as any,
				getFormatService: () =>
					({
						recordRead: () => {},
						formatFile: async (fp: string) => {
							order.push("format");
							fs.writeFileSync(fp, "const value = 1;\n");
							return {
								filePath: fp,
								formatters: [{ name: "biome", success: true, changed: true }],
								anyChanged: true,
								allSucceeded: true,
							};
						},
					}) as any,
			});
			expect(order).toEqual(["autofix", "format"]);
			expect(fs.readFileSync(filePath, "utf-8")).toBe("const value = 1;\n");
			expect(logSpy).toHaveBeenCalledWith(
				expect.objectContaining({
					phase: "agent_end_deferred_mutation_drain",
					metadata: expect.objectContaining({
						autofixRecords: 1,
						formatRecords: 1,
						coalescedPaths: 1,
						requeuedKinds: [],
					}),
				}),
			);
		} finally {
			env.cleanup();
		}
	});

	it("formats each queued file once, clears the queue, and records a format change", async () => {
		const env = setupTestEnvironment("pi-lens-agent-end-format-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const filePath = createTempFile(env.tmpDir, "src/app.ts", "const x=1");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.deferFormat(filePath, env.tmpDir, "edit", env.tmpDir);
			runtime.deferFormat(filePath, env.tmpDir, "write", env.tmpDir);

			const formatFile = vi.fn(async (fp: string) => {
				fs.writeFileSync(fp, "const x = 1;\n");
				return {
					filePath: fp,
					formatters: [{ name: "biome", success: true, changed: true }],
					anyChanged: true,
					allSucceeded: true,
				};
			});
			const modifiedRanges: Array<{ filePath: string; range: unknown }> = [];
			const notify = vi.fn();

			const summary = await handleAgentEnd({
				ctxCwd: env.tmpDir,
				getFlag: (name) => name === "no-lsp",
				notify,
				dbg: () => {},
				runtime,
				cacheManager: {
					addModifiedRange: (changedFile: string, range: unknown) => {
						modifiedRanges.push({ filePath: changedFile, range });
					},
				} as any,
				getFormatService: () =>
					({
						recordRead: () => {},
						formatFile,
					}) as any,
			});

			expect(formatFile).toHaveBeenCalledTimes(1);
			expect(summary?.queued).toBe(1);
			expect(summary?.changed).toEqual([filePath]);
			expect(runtime.pendingDeferredFormatCount).toBe(0);
			expect(modifiedRanges.map((entry) => entry.filePath)).toEqual([filePath]);
			expect(readChangesSince(env.tmpDir, 0)).toMatchObject([
				{
					seq: 1,
					source: "format",
					filePath,
					fileSeq: 1,
				},
			]);
			expect(notify).toHaveBeenCalledWith(
				"pi-lens deferred format applied to 1 file(s): app.ts",
				"info",
			);
			expect(getLastLoggedPhase()?.phase).toBe(
				"agent_end_deferred_format_done",
			);
		} finally {
			if (previousDataDir === undefined) {
				delete process.env.PILENS_DATA_DIR;
			} else {
				process.env.PILENS_DATA_DIR = previousDataDir;
			}
			env.cleanup();
		}
	});

	it("formats multiple files and preserves all side effects", async () => {
		const env = setupTestEnvironment("pi-lens-agent-end-multi-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const file1 = createTempFile(env.tmpDir, "src/a.ts", "const a=1");
			const file2 = createTempFile(env.tmpDir, "src/b.ts", "const b=2");
			const file3 = createTempFile(env.tmpDir, "src/c.ts", "const c=3");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.deferFormat(file1, env.tmpDir, "edit", env.tmpDir);
			runtime.deferFormat(file2, env.tmpDir, "edit", env.tmpDir);
			runtime.deferFormat(file3, env.tmpDir, "edit", env.tmpDir);

			const formatFile = vi.fn(async (fp: string) => {
				fs.writeFileSync(fp, fs.readFileSync(fp, "utf-8") + "\n");
				return {
					filePath: fp,
					formatters: [{ name: "biome", success: true, changed: true }],
					anyChanged: true,
					allSucceeded: true,
				};
			});

			const modifiedRanges: string[] = [];
			const summary = await handleAgentEnd({
				ctxCwd: env.tmpDir,
				getFlag: (name) => name === "no-lsp",
				notify: vi.fn(),
				dbg: () => {},
				runtime,
				cacheManager: {
					addModifiedRange: (fp: string) =>
						modifiedRanges.push(path.basename(fp)),
				} as any,
				getFormatService: () => ({ recordRead: () => {}, formatFile }) as any,
			});

			// All three files formatted
			expect(formatFile).toHaveBeenCalledTimes(3);
			expect(summary?.queued).toBe(3);
			expect(summary?.changed).toHaveLength(3);

			// Side effects recorded for all three files
			expect(modifiedRanges).toHaveLength(3);
			expect(readChangesSince(env.tmpDir, 0)).toHaveLength(3);
		} finally {
			if (previousDataDir === undefined) {
				delete process.env.PILENS_DATA_DIR;
			} else {
				process.env.PILENS_DATA_DIR = previousDataDir;
			}
			env.cleanup();
		}
	});

	it("bounds formatter concurrency and yields between ordered bookkeeping (#1387)", async () => {
		const env = setupTestEnvironment("pi-lens-agent-end-yield-");
		const setImmediateSpy = vi.spyOn(globalThis, "setImmediate");
		try {
			const files = Array.from({ length: 10 }, (_, index) =>
				createTempFile(env.tmpDir, `${index}.ts`, `const x${index}=1`),
			);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			for (const file of files) {
				runtime.deferFormat(file, env.tmpDir, "edit", env.tmpDir);
			}
			let inFlight = 0;
			let maxInFlight = 0;
			const immediateCallsAtBookkeeping: number[] = [];
			const formatFile = vi.fn(async (filePath: string) => {
				inFlight++;
				maxInFlight = Math.max(maxInFlight, inFlight);
				await new Promise<void>((resolve) => setImmediate(resolve));
				inFlight--;
				return {
					filePath,
					formatters: [{ name: "fake", success: true, changed: true }],
					anyChanged: true,
					allSucceeded: true,
				};
			});

			await handleAgentEnd({
				ctxCwd: env.tmpDir,
				getFlag: (name) => name === "no-lsp",
				notify: vi.fn(),
				dbg: () => {},
				runtime,
				cacheManager: {
					addModifiedRange: vi.fn(() => {
						immediateCallsAtBookkeeping.push(setImmediateSpy.mock.calls.length);
					}),
				} as any,
				getFormatService: () => ({ recordRead: () => {}, formatFile }) as any,
			});

			expect(formatFile).toHaveBeenCalledTimes(files.length);
			expect(maxInFlight).toBeLessThanOrEqual(3);
			expect(maxInFlight).toBe(3);
			expect(immediateCallsAtBookkeeping).toHaveLength(files.length);
			for (let index = 1; index < immediateCallsAtBookkeeping.length; index++) {
				expect(immediateCallsAtBookkeeping[index]).toBeGreaterThan(
					immediateCallsAtBookkeeping[index - 1],
				);
			}
		} finally {
			setImmediateSpy.mockRestore();
			env.cleanup();
		}
	});

	it("requeues claimed files that were not started when the ambient turn aborts", async () => {
		const env = setupTestEnvironment("pi-lens-agent-end-abort-");
		const controller = new AbortController();
		setAmbientAbortSignal(controller.signal);
		try {
			const files = ["a.ts", "b.ts", "c.ts"].map((name) =>
				createTempFile(env.tmpDir, name, `const ${name[0]}=1`),
			);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			for (const file of files)
				runtime.deferFormat(file, env.tmpDir, "edit", env.tmpDir);
			const started: string[] = [];
			const formatFile = vi.fn(async (filePath: string) => {
				started.push(filePath);
				controller.abort();
				return {
					filePath,
					formatters: [{ name: "fake", success: true, changed: false }],
					anyChanged: false,
					allSucceeded: true,
				};
			});

			await handleAgentEnd({
				ctxCwd: env.tmpDir,
				getFlag: (name) => name === "no-lsp",
				notify: vi.fn(),
				dbg: () => {},
				runtime,
				cacheManager: { addModifiedRange: vi.fn() } as any,
				getFormatService: () => ({ recordRead: () => {}, formatFile }) as any,
			});

			expect(started).toHaveLength(1);
			expect(runtime.pendingDeferredFormatCount).toBe(2);
			expect(
				runtime.consumeDeferredFormatFiles().map((record) => record.filePath),
			).toEqual(files.slice(1));
		} finally {
			setAmbientAbortSignal(undefined);
			env.cleanup();
		}
	});

	it("rejects deferFormat calls that omit turnStateCwd at compile time (PR #114 lock)", () => {
		const runtime = new RuntimeCoordinator();
		// @ts-expect-error — turnStateCwd is required; omitting it would
		// silently reintroduce the monorepo cwd-mismatch bug PR #105 fixed.
		runtime.deferFormat("/some/file.ts", "/dispatch/cwd", "edit");
		// Sanity: the correct 4-arg form compiles and registers the entry.
		runtime.deferFormat(
			"/some/file.ts",
			"/dispatch/cwd",
			"edit",
			"/workspace/root",
		);
		expect(runtime.pendingDeferredFormatCount).toBeGreaterThan(0);
	});

	it("records deferred format bookkeeping under the workspace root in monorepos", async () => {
		const env = setupTestEnvironment("pi-lens-agent-end-monorepo-format-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const workspaceRoot = path.join(env.tmpDir, "workspace");
			const goModuleDir = path.join(
				workspaceRoot,
				"platform",
				"svc",
				"go",
				"daemon",
			);
			const filePath = createTempFile(
				goModuleDir,
				"main.go",
				"package main\n\nfunc main() {}\n",
			);
			createTempFile(goModuleDir, "go.mod", "module daemon\n\ngo 1.22\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = workspaceRoot;
			runtime.deferFormat(filePath, goModuleDir, "edit", workspaceRoot);
			const cacheManager = new CacheManager(false);
			const formatFile = vi.fn(async (fp: string) => {
				fs.writeFileSync(fp, `${fs.readFileSync(fp, "utf-8")}\n`);
				return {
					filePath: fp,
					formatters: [{ name: "gofmt", success: true, changed: true }],
					anyChanged: true,
					allSucceeded: true,
				};
			});

			await handleAgentEnd({
				ctxCwd: workspaceRoot,
				getFlag: (name) => name === "no-lsp",
				notify: vi.fn(),
				dbg: () => {},
				runtime,
				cacheManager,
				getFormatService: () => ({ recordRead: () => {}, formatFile }) as any,
			});

			expect(formatFile).toHaveBeenCalledTimes(1);
			expect(readChangesSince(workspaceRoot, 0)).toMatchObject([
				{ source: "format", filePath },
			]);
			expect(readChangesSince(goModuleDir, 0)).toEqual([]);
			expect(
				Object.keys(cacheManager.readTurnState(workspaceRoot).files),
			).toEqual(["platform/svc/go/daemon/main.go"]);
			expect(
				Object.keys(cacheManager.readTurnState(goModuleDir).files),
			).toEqual([]);
		} finally {
			if (previousDataDir === undefined) {
				delete process.env.PILENS_DATA_DIR;
			} else {
				process.env.PILENS_DATA_DIR = previousDataDir;
			}
			env.cleanup();
		}
	});

	// #1607: the actionable-warnings cache is only ever written when the
	// "lens-actionable-warnings" flag is on (clients/runtime-turn.ts). A
	// reader that ignores that flag reads on every agent_end regardless, and
	// with the writer off it always misses — logging a misleading "cache
	// missing or expired" line at 100% of calls in a production host where
	// only the (unrelated) autofix flag looks enabled.
	it("skips the actionable-warnings cache read when the writer flag is off (#1607)", async () => {
		const env = setupTestEnvironment("pi-lens-agent-end-aw-writer-off-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			const readCache = vi.fn();
			const dbg = vi.fn();

			await handleAgentEnd({
				ctxCwd: env.tmpDir,
				// Only the autofix flag is on; the writer flag
				// ("lens-actionable-warnings") is off, as in production.
				// getFlagSource is a real (defined) resolver, matching the
				// production wiring the issue describes.
				getFlag: (name) =>
					name === "lens-actionable-warning-autofix" || name === "no-lsp",
				getFlagSource: () => "default",
				notify: vi.fn(),
				dbg,
				runtime,
				cacheManager: { readCache, addModifiedRange: vi.fn() } as any,
				getFormatService: () =>
					({ recordRead: () => {}, formatFile: vi.fn() }) as any,
			});

			expect(readCache).not.toHaveBeenCalled();
			expect(dbg).not.toHaveBeenCalledWith(
				expect.stringContaining("cache missing or expired"),
			);
		} finally {
			env.cleanup();
		}
	});

	it("logs a distinct 'cache absent' reason when no cache file was ever written (#1607)", async () => {
		const env = setupTestEnvironment("pi-lens-agent-end-aw-cache-absent-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			const dbg = vi.fn();

			await handleAgentEnd({
				ctxCwd: env.tmpDir,
				getFlag: (name) =>
					name === "lens-actionable-warnings" ||
					name === "lens-actionable-warning-autofix" ||
					name === "no-lsp",
				notify: vi.fn(),
				dbg,
				runtime,
				// A real CacheManager with no cache file ever written for this
				// project: the "no entry" case.
				cacheManager: new CacheManager(false),
				getFormatService: () =>
					({ recordRead: () => {}, formatFile: vi.fn() }) as any,
			});

			expect(dbg).toHaveBeenCalledWith(expect.stringContaining("cache absent"));
			expect(dbg).not.toHaveBeenCalledWith(
				expect.stringContaining("cache missing or expired"),
			);
			expect(dbg).not.toHaveBeenCalledWith(
				expect.stringContaining("cache expired"),
			);
		} finally {
			env.cleanup();
		}
	});

	it("logs a distinct 'cache expired' reason when the cache entry is older than the 10-minute TTL (#1607)", async () => {
		const env = setupTestEnvironment("pi-lens-agent-end-aw-cache-expired-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			const dbg = vi.fn();
			const cacheManager = new CacheManager(false);
			const report: ActionableWarningsReport = {
				generatedAt: new Date().toISOString(),
				scope: "turn_delta",
				sessionId: "s1",
				turnIndex: 1,
				projectSeqEnd: 1,
				deltaOnly: true,
				includeLspCodeActions: true,
				files: [],
				summary: {
					warnings: 0,
					unsuppressed: 0,
					suppressed: 0,
					files: 0,
					actions: 0,
					autoFixEligible: 0,
				},
			};
			cacheManager.writeCache("actionable-warnings", report, env.tmpDir);
			const metaPath = path.join(
				getProjectDataDir(env.tmpDir),
				"cache",
				"actionable-warnings.meta.json",
			);
			const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
			// Older than the 10-minute TTL enforced at the read site.
			meta.timestamp = new Date(Date.now() - 11 * 60_000).toISOString();
			fs.writeFileSync(metaPath, JSON.stringify(meta));

			await handleAgentEnd({
				ctxCwd: env.tmpDir,
				getFlag: (name) =>
					name === "lens-actionable-warnings" ||
					name === "lens-actionable-warning-autofix" ||
					name === "no-lsp",
				notify: vi.fn(),
				dbg,
				runtime,
				cacheManager,
				getFormatService: () =>
					({ recordRead: () => {}, formatFile: vi.fn() }) as any,
			});

			expect(dbg).toHaveBeenCalledWith(
				expect.stringContaining("cache expired"),
			);
			expect(dbg).not.toHaveBeenCalledWith(
				expect.stringContaining("cache missing or expired"),
			);
			expect(dbg).not.toHaveBeenCalledWith(
				expect.stringContaining("cache absent"),
			);
		} finally {
			env.cleanup();
		}
	});

	it("skips actionable warning autofix when the cached report is stale", async () => {
		const env = setupTestEnvironment("pi-lens-agent-end-stale-aw-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.seedProjectSequence(2);
			const report: ActionableWarningsReport = {
				generatedAt: new Date().toISOString(),
				scope: "turn_delta",
				sessionId: "s1",
				turnIndex: 1,
				projectSeqEnd: 1,
				deltaOnly: true,
				includeLspCodeActions: true,
				files: [],
				summary: {
					warnings: 0,
					unsuppressed: 0,
					suppressed: 0,
					files: 0,
					actions: 0,
					autoFixEligible: 0,
				},
			};
			const dbg = vi.fn();
			const notify = vi.fn();

			const summary = await handleAgentEnd({
				ctxCwd: env.tmpDir,
				getFlag: (name) =>
					name === "lens-actionable-warning-autofix" ||
					name === "lens-actionable-warnings" ||
					name === "no-lsp",
				notify,
				dbg,
				runtime,
				cacheManager: {
					readCache: () => ({ data: report }),
					addModifiedRange: vi.fn(),
				} as any,
				getFormatService: () =>
					({ recordRead: () => {}, formatFile: vi.fn() }) as any,
			});

			expect(summary?.queued).toBe(0);
			expect(dbg).toHaveBeenCalledWith(
				expect.stringContaining("stale report (project_seq_mismatch"),
			);
			expect(notify).not.toHaveBeenCalledWith(
				expect.stringContaining("conservative LSP warning quickfix"),
				"info",
			);
		} finally {
			env.cleanup();
		}
	});

	it("project config disables actionable warning autofix", async () => {
		const env = setupTestEnvironment("pi-lens-agent-end-project-policy-");
		try {
			fs.writeFileSync(
				path.join(env.tmpDir, ".pi-lens.json"),
				JSON.stringify({
					actionableWarnings: { autoFix: { enabled: false } },
				}),
			);
			const projectConfig = loadPiLensProjectConfig(env.tmpDir);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			const readCache = vi.fn();
			applyConservativeActionableWarningFixesMock.mockClear();

			const summary = await handleAgentEnd({
				ctxCwd: env.tmpDir,
				getFlag: (name) =>
					resolvePiLensFlag(
						name,
						undefined,
						{ actionableWarnings: { autoFix: { enabled: true } } },
						projectConfig,
					),
				notify: vi.fn(),
				dbg: vi.fn(),
				runtime,
				cacheManager: { readCache } as any,
				getFormatService: () => ({}) as any,
			});

			expect(summary).toBeUndefined();
			expect(readCache).not.toHaveBeenCalled();
			expect(
				applyConservativeActionableWarningFixesMock,
			).not.toHaveBeenCalled();
		} finally {
			env.cleanup();
		}
	});

	it("skips actionable warning autofix for files excluded by project ignore (#1247)", async () => {
		const env = setupTestEnvironment("pi-lens-agent-end-ignore-");
		try {
			const filePath = createTempFile(env.tmpDir, "CHANGELOG.md", "# Title\n");
			fs.writeFileSync(
				path.join(env.tmpDir, ".pi-lens.json"),
				JSON.stringify({ ignore: ["CHANGELOG.md"] }),
			);
			loadPiLensProjectConfig(env.tmpDir);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.seedProjectSequence(1);
			const report: ActionableWarningsReport = {
				generatedAt: new Date().toISOString(),
				scope: "turn_delta",
				sessionId: "s1",
				turnIndex: 1,
				projectSeqEnd: 1,
				deltaOnly: true,
				includeLspCodeActions: true,
				files: [
					{
						filePath,
						displayPath: "CHANGELOG.md",
						warnings: [
							{
								id: "aw:1",
								filePath,
								displayPath: "CHANGELOG.md",
								severity: "warning",
								tool: "markdownlint",
								message: "list indent",
								suppressed: false,
								origin: "dispatch",
								actions: [
									{
										title: "Fix list indent",
										hasEdit: true,
										hasCommand: false,
										autoFixEligible: true,
									},
								],
							},
						],
					},
				],
				summary: {
					warnings: 1,
					unsuppressed: 1,
					suppressed: 0,
					files: 1,
					actions: 1,
					autoFixEligible: 1,
				},
			};
			const dbg = vi.fn();
			applyConservativeActionableWarningFixesMock.mockClear();

			await handleAgentEnd({
				ctxCwd: env.tmpDir,
				getFlag: (name) =>
					name === "lens-actionable-warning-autofix" ||
					name === "lens-actionable-warnings" ||
					name === "no-lsp",
				notify: vi.fn(),
				dbg,
				runtime,
				cacheManager: {
					readCache: () => ({ data: report }),
					addModifiedRange: vi.fn(),
				} as any,
				getFormatService: () =>
					({ recordRead: () => {}, formatFile: vi.fn() }) as any,
			});

			expect(
				applyConservativeActionableWarningFixesMock,
			).not.toHaveBeenCalled();
			expect(dbg).toHaveBeenCalledWith(
				expect.stringContaining("ignored by project"),
			);
		} finally {
			applyConservativeActionableWarningFixesMock.mockReset();
			env.cleanup();
		}
	});

	it("skips queued files when autoformat is disabled", async () => {
		const env = setupTestEnvironment("pi-lens-agent-end-format-");
		try {
			const filePath = createTempFile(env.tmpDir, "src/app.ts", "const x=1");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.deferFormat(filePath, env.tmpDir, "edit", env.tmpDir);
			const formatFile = vi.fn();

			const summary = await handleAgentEnd({
				ctxCwd: env.tmpDir,
				getFlag: (name) => name === "no-autoformat" || name === "no-lsp",
				notify: () => {},
				dbg: () => {},
				runtime,
				cacheManager: { addModifiedRange: () => {} } as any,
				getFormatService: () =>
					({
						recordRead: () => {},
						formatFile,
					}) as any,
			});

			expect(formatFile).not.toHaveBeenCalled();
			expect(summary?.skipped).toEqual([{ filePath, reason: "no-autoformat" }]);
			expect(runtime.pendingDeferredFormatCount).toBe(0);
		} finally {
			env.cleanup();
		}
	});

	it('publishes pilens:files:touched reason:"format" for deferred-format changed files (#482)', async () => {
		const env = setupTestEnvironment("pi-lens-agent-end-bus-format-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const filePath = createTempFile(env.tmpDir, "src/app.ts", "const x=1");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.deferFormat(filePath, env.tmpDir, "edit", env.tmpDir);

			const formatFile = vi.fn(async (fp: string) => {
				fs.writeFileSync(fp, "const x = 1;\n");
				return {
					filePath: fp,
					formatters: [{ name: "biome", success: true, changed: true }],
					anyChanged: true,
					allSucceeded: true,
				};
			});

			const emit = vi.fn();
			wireBusEmitter(emit);

			await handleAgentEnd({
				ctxCwd: env.tmpDir,
				getFlag: (name) => name === "no-lsp",
				notify: vi.fn(),
				dbg: () => {},
				runtime,
				cacheManager: { addModifiedRange: () => {} } as any,
				getFormatService: () => ({ recordRead: () => {}, formatFile }) as any,
			});

			expect(emit).toHaveBeenCalledWith(
				"pilens:files:touched",
				expect.objectContaining({
					v: 1,
					source: "pi-lens",
					reason: "format",
					paths: [filePath.replace(/\\/g, "/")],
				}),
			);
		} finally {
			resetBusPublish();
			if (previousDataDir === undefined) {
				delete process.env.PILENS_DATA_DIR;
			} else {
				process.env.PILENS_DATA_DIR = previousDataDir;
			}
			env.cleanup();
		}
	});

	it("publishes pilens:format:start with the queued paths at deferred-format start (#673)", async () => {
		const env = setupTestEnvironment("pi-lens-agent-end-bus-format-start-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const filePath = createTempFile(env.tmpDir, "src/app.ts", "const x=1");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.deferFormat(filePath, env.tmpDir, "edit", env.tmpDir);

			const formatFile = vi.fn(async (fp: string) => {
				fs.writeFileSync(fp, "const x = 1;\n");
				return {
					filePath: fp,
					formatters: [{ name: "biome", success: true, changed: true }],
					anyChanged: true,
					allSucceeded: true,
				};
			});

			const emit = vi.fn();
			wireFormatEventsBusEmitter(emit);

			await handleAgentEnd({
				ctxCwd: env.tmpDir,
				getFlag: (name) => name === "no-lsp",
				notify: vi.fn(),
				dbg: () => {},
				runtime,
				cacheManager: { addModifiedRange: () => {} } as any,
				getFormatService: () => ({ recordRead: () => {}, formatFile }) as any,
			});

			expect(emit).toHaveBeenCalledWith(
				"pilens:format:start",
				expect.objectContaining({
					v: 1,
					source: "pi-lens",
					fileCount: 1,
					paths: [filePath.replace(/\\/g, "/")],
				}),
			);
		} finally {
			resetFormatEventsPublish();
			if (previousDataDir === undefined) {
				delete process.env.PILENS_DATA_DIR;
			} else {
				process.env.PILENS_DATA_DIR = previousDataDir;
			}
			env.cleanup();
		}
	});

	it("does not publish pilens:format:start when there is nothing queued (#673)", async () => {
		const env = setupTestEnvironment(
			"pi-lens-agent-end-bus-format-start-empty-",
		);
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;

			const emit = vi.fn();
			wireFormatEventsBusEmitter(emit);

			await handleAgentEnd({
				ctxCwd: env.tmpDir,
				getFlag: () => false,
				notify: vi.fn(),
				dbg: () => {},
				runtime,
				cacheManager: { addModifiedRange: () => {} } as any,
				getFormatService: () =>
					({ recordRead: () => {}, formatFile: vi.fn() }) as any,
			});

			expect(emit).not.toHaveBeenCalledWith(
				"pilens:format:start",
				expect.anything(),
			);
		} finally {
			resetFormatEventsPublish();
			if (previousDataDir === undefined) {
				delete process.env.PILENS_DATA_DIR;
			} else {
				process.env.PILENS_DATA_DIR = previousDataDir;
			}
			env.cleanup();
		}
	});

	it('includes fix-provenance entries (kind:"format") for deferred-format changed files (#502)', async () => {
		const env = setupTestEnvironment("pi-lens-agent-end-bus-fixes-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const filePath = createTempFile(env.tmpDir, "src/app.ts", "const x=1");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.deferFormat(filePath, env.tmpDir, "edit", env.tmpDir);

			const formatFile = vi.fn(async (fp: string) => {
				fs.writeFileSync(fp, "const x = 1;\n");
				return {
					filePath: fp,
					formatters: [{ name: "prettier", success: true, changed: true }],
					anyChanged: true,
					allSucceeded: true,
				};
			});

			const emit = vi.fn();
			wireBusEmitter(emit);

			await handleAgentEnd({
				ctxCwd: env.tmpDir,
				getFlag: (name) => name === "no-lsp",
				notify: vi.fn(),
				dbg: () => {},
				runtime,
				cacheManager: { addModifiedRange: () => {} } as any,
				getFormatService: () => ({ recordRead: () => {}, formatFile }) as any,
			});

			const call = emit.mock.calls.find((c) => c[0] === "pilens:files:touched");
			expect(call?.[1]).toMatchObject({
				fixes: [
					{
						path: filePath.replace(/\\/g, "/"),
						tool: "prettier",
						kind: "format",
					},
				],
			});
		} finally {
			resetBusPublish();
			if (previousDataDir === undefined) {
				delete process.env.PILENS_DATA_DIR;
			} else {
				process.env.PILENS_DATA_DIR = previousDataDir;
			}
			env.cleanup();
		}
	});

	it('includes fix-provenance entries (tool:"lsp-quickfix", kind:"autofix") for actionable-warning autofix changed files (#502)', async () => {
		const env = setupTestEnvironment("pi-lens-agent-end-aw-fixes-");
		try {
			const filePath = createTempFile(
				env.tmpDir,
				"src/app.ts",
				"const x = 1;\n",
			);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.seedProjectSequence(1);
			const report: ActionableWarningsReport = {
				generatedAt: new Date().toISOString(),
				scope: "turn_delta",
				sessionId: "s1",
				turnIndex: 1,
				projectSeqEnd: 1,
				deltaOnly: true,
				includeLspCodeActions: true,
				files: [
					{
						filePath,
						displayPath: "src/app.ts",
						warnings: [
							{
								id: "aw:502",
								filePath,
								displayPath: "src/app.ts",
								severity: "warning",
								tool: "typescript",
								message: "unused var",
								suppressed: false,
								origin: "dispatch",
								actions: [
									{
										title: "Remove unused var",
										hasEdit: true,
										hasCommand: false,
										autoFixEligible: true,
									},
								],
							},
						],
					},
				],
				summary: {
					warnings: 1,
					unsuppressed: 1,
					suppressed: 0,
					files: 1,
					actions: 1,
					autoFixEligible: 1,
				},
			};
			applyConservativeActionableWarningFixesMock.mockResolvedValueOnce({
				considered: 1,
				applied: 1,
				changedFiles: [filePath],
				skipped: [],
			});

			const emit = vi.fn();
			wireBusEmitter(emit);

			await handleAgentEnd({
				ctxCwd: env.tmpDir,
				getFlag: (name) =>
					name === "lens-actionable-warning-autofix" ||
					name === "lens-actionable-warnings" ||
					name === "no-lsp",
				notify: vi.fn(),
				dbg: vi.fn(),
				runtime,
				cacheManager: {
					readCache: () => ({ data: report }),
					addModifiedRange: vi.fn(),
				} as any,
				getFormatService: () =>
					({ recordRead: () => {}, formatFile: vi.fn() }) as any,
			});

			const call = emit.mock.calls.find((c) => c[0] === "pilens:files:touched");
			expect(call?.[1]).toMatchObject({
				reason: "autofix",
				fixes: [
					{
						path: filePath.replace(/\\/g, "/"),
						tool: "lsp-quickfix",
						kind: "autofix",
					},
				],
			});
		} finally {
			resetBusPublish();
			applyConservativeActionableWarningFixesMock.mockReset();
			env.cleanup();
		}
	});

	describe("pilens:autofix:start (#684)", () => {
		function eligibleReport(
			filePath: string,
			projectSeqEnd: number,
		): ActionableWarningsReport {
			return {
				generatedAt: new Date().toISOString(),
				scope: "turn_delta",
				sessionId: "s1",
				turnIndex: 1,
				projectSeqEnd,
				deltaOnly: true,
				includeLspCodeActions: true,
				files: [
					{
						filePath,
						displayPath: "app.ts",
						warnings: [
							{
								id: "aw:1",
								filePath,
								displayPath: "app.ts",
								severity: "warning",
								tool: "eslint",
								message: "unused var",
								actions: [
									{
										title: "Remove unused variable",
										hasEdit: true,
										hasCommand: false,
										autoFixEligible: true,
									},
								],
								suppressed: false,
								origin: "lsp",
							},
						],
					},
				],
				summary: {
					warnings: 1,
					unsuppressed: 1,
					suppressed: 0,
					files: 1,
					actions: 1,
					autoFixEligible: 1,
				},
			};
		}

		it("publishes pilens:autofix:start with the eligible paths when the report is fresh and non-empty", async () => {
			const env = setupTestEnvironment("pi-lens-agent-end-bus-autofix-start-");
			try {
				const filePath = createTempFile(
					env.tmpDir,
					"src/app.ts",
					"const x = 1;\n",
				);
				const runtime = new RuntimeCoordinator();
				runtime.projectRoot = env.tmpDir;
				runtime.seedProjectSequence(1);
				const report = eligibleReport(filePath, 1);
				applyConservativeActionableWarningFixesMock.mockResolvedValueOnce({
					considered: 1,
					applied: 1,
					changedFiles: [filePath],
					skipped: [],
				});

				const emit = vi.fn();
				wireFormatEventsBusEmitter(emit);

				await handleAgentEnd({
					ctxCwd: env.tmpDir,
					getFlag: (name) =>
						name === "lens-actionable-warning-autofix" ||
						name === "lens-actionable-warnings" ||
						name === "no-lsp",
					notify: vi.fn(),
					dbg: vi.fn(),
					runtime,
					cacheManager: {
						readCache: () => ({ data: report }),
						addModifiedRange: vi.fn(),
					} as any,
					getFormatService: () =>
						({ recordRead: () => {}, formatFile: vi.fn() }) as any,
				});

				expect(emit).toHaveBeenCalledWith(
					"pilens:autofix:start",
					expect.objectContaining({
						v: 1,
						source: "pi-lens",
						fileCount: 1,
						eligibleCount: 1,
						paths: [filePath.replace(/\\/g, "/")],
					}),
				);
			} finally {
				resetFormatEventsPublish();
				applyConservativeActionableWarningFixesMock.mockReset();
				env.cleanup();
			}
		});

		it("does not publish pilens:autofix:start when the cached report is stale", async () => {
			const env = setupTestEnvironment("pi-lens-agent-end-bus-autofix-stale-");
			try {
				const filePath = createTempFile(
					env.tmpDir,
					"src/app.ts",
					"const x = 1;\n",
				);
				const runtime = new RuntimeCoordinator();
				runtime.projectRoot = env.tmpDir;
				runtime.seedProjectSequence(2);
				// projectSeqEnd (1) mismatches the current project seq (2) — stale.
				const report = eligibleReport(filePath, 1);

				const emit = vi.fn();
				wireFormatEventsBusEmitter(emit);

				await handleAgentEnd({
					ctxCwd: env.tmpDir,
					getFlag: (name) =>
						name === "lens-actionable-warning-autofix" || name === "no-lsp",
					notify: vi.fn(),
					dbg: vi.fn(),
					runtime,
					cacheManager: {
						readCache: () => ({ data: report }),
						addModifiedRange: vi.fn(),
					} as any,
					getFormatService: () =>
						({ recordRead: () => {}, formatFile: vi.fn() }) as any,
				});

				expect(emit).not.toHaveBeenCalledWith(
					"pilens:autofix:start",
					expect.anything(),
				);
				expect(
					applyConservativeActionableWarningFixesMock,
				).not.toHaveBeenCalled();
			} finally {
				resetFormatEventsPublish();
				applyConservativeActionableWarningFixesMock.mockReset();
				env.cleanup();
			}
		});

		it("does not publish pilens:autofix:start when the cached report is missing", async () => {
			const env = setupTestEnvironment(
				"pi-lens-agent-end-bus-autofix-missing-",
			);
			try {
				const runtime = new RuntimeCoordinator();
				runtime.projectRoot = env.tmpDir;

				const emit = vi.fn();
				wireFormatEventsBusEmitter(emit);

				await handleAgentEnd({
					ctxCwd: env.tmpDir,
					getFlag: (name) =>
						name === "lens-actionable-warning-autofix" || name === "no-lsp",
					notify: vi.fn(),
					dbg: vi.fn(),
					runtime,
					cacheManager: {
						readCache: () => undefined,
						addModifiedRange: vi.fn(),
					} as any,
					getFormatService: () =>
						({ recordRead: () => {}, formatFile: vi.fn() }) as any,
				});

				expect(emit).not.toHaveBeenCalledWith(
					"pilens:autofix:start",
					expect.anything(),
				);
			} finally {
				resetFormatEventsPublish();
				env.cleanup();
			}
		});

		it("does not publish pilens:autofix:start when the report is fresh but has no autofix-eligible warnings", async () => {
			const env = setupTestEnvironment("pi-lens-agent-end-bus-autofix-empty-");
			try {
				const runtime = new RuntimeCoordinator();
				runtime.projectRoot = env.tmpDir;
				runtime.seedProjectSequence(1);
				const report: ActionableWarningsReport = {
					generatedAt: new Date().toISOString(),
					scope: "turn_delta",
					sessionId: "s1",
					turnIndex: 1,
					projectSeqEnd: 1,
					deltaOnly: true,
					includeLspCodeActions: true,
					files: [],
					summary: {
						warnings: 0,
						unsuppressed: 0,
						suppressed: 0,
						files: 0,
						actions: 0,
						autoFixEligible: 0,
					},
				};
				applyConservativeActionableWarningFixesMock.mockResolvedValueOnce({
					considered: 0,
					applied: 0,
					changedFiles: [],
					skipped: [],
				});

				const dbg = vi.fn();
				const emit = vi.fn();
				wireFormatEventsBusEmitter(emit);

				await handleAgentEnd({
					ctxCwd: env.tmpDir,
					getFlag: (name) =>
						name === "lens-actionable-warning-autofix" ||
						name === "lens-actionable-warnings" ||
						name === "no-lsp",
					notify: vi.fn(),
					dbg,
					runtime,
					cacheManager: {
						readCache: () => ({ data: report }),
						addModifiedRange: vi.fn(),
					} as any,
					getFormatService: () =>
						({ recordRead: () => {}, formatFile: vi.fn() }) as any,
				});

				expect(emit).not.toHaveBeenCalledWith(
					"pilens:autofix:start",
					expect.anything(),
				);
				// P2-A: the zero-eligible skip is explicit in the debug log — a
				// regression that collapses eligibleCount to 0 is not silent.
				expect(dbg).toHaveBeenCalledWith(
					expect.stringContaining("0 autofix-eligible warnings, skipping"),
				);
			} finally {
				resetFormatEventsPublish();
				applyConservativeActionableWarningFixesMock.mockReset();
				env.cleanup();
			}
		});
	});

	describe("#791 deferred-format ownership", () => {
		it("a non-owning session's agent_end does NOT format a foreign record; it stays queued", async () => {
			const env = setupTestEnvironment("pi-lens-agent-end-ownership-foreign-");
			try {
				const filePath = createTempFile(env.tmpDir, "src/app.ts", "const x=1");
				const runtime = new RuntimeCoordinator();
				runtime.projectRoot = env.tmpDir;
				// Turn N: the OWNER (session-parent) writes the file.
				runtime.deferFormat(
					filePath,
					env.tmpDir,
					"edit",
					env.tmpDir,
					"session-parent",
				);
				// Turn N+1: a read-only turn begins (e.g. a concurrent in-process
				// subagent's own turn_start), advancing the shared turn counter.
				runtime.beginTurn();

				const formatFile = vi.fn();
				const summary = await handleAgentEnd({
					ctxCwd: env.tmpDir,
					getFlag: (name) => name === "no-lsp",
					notify: vi.fn(),
					dbg: () => {},
					runtime,
					cacheManager: { addModifiedRange: vi.fn() } as any,
					getFormatService: () => ({ recordRead: () => {}, formatFile }) as any,
					// The non-owner: a different, KNOWN session id.
					currentSessionId: "session-subagent",
				});

				expect(formatFile).not.toHaveBeenCalled();
				expect(summary).toBeUndefined();
				expect(runtime.pendingDeferredFormatCount).toBe(1);
			} finally {
				env.cleanup();
			}
		});

		it("the owning session's agent_end DOES format its own queued record", async () => {
			const env = setupTestEnvironment("pi-lens-agent-end-ownership-owner-");
			const previousDataDir = process.env.PILENS_DATA_DIR;
			process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
			try {
				const filePath = createTempFile(env.tmpDir, "src/app.ts", "const x=1");
				const runtime = new RuntimeCoordinator();
				runtime.projectRoot = env.tmpDir;
				runtime.deferFormat(
					filePath,
					env.tmpDir,
					"edit",
					env.tmpDir,
					"session-parent",
				);

				const formatFile = vi.fn(async (fp: string) => {
					fs.writeFileSync(fp, "const x = 1;\n");
					return {
						filePath: fp,
						formatters: [{ name: "biome", success: true, changed: true }],
						anyChanged: true,
						allSucceeded: true,
					};
				});

				const summary = await handleAgentEnd({
					ctxCwd: env.tmpDir,
					getFlag: (name) => name === "no-lsp",
					notify: vi.fn(),
					dbg: () => {},
					runtime,
					cacheManager: { addModifiedRange: vi.fn() } as any,
					getFormatService: () => ({ recordRead: () => {}, formatFile }) as any,
					currentSessionId: "session-parent",
				});

				expect(formatFile).toHaveBeenCalledTimes(1);
				expect(summary?.changed).toEqual([filePath]);
				expect(runtime.pendingDeferredFormatCount).toBe(0);
			} finally {
				if (previousDataDir === undefined) {
					delete process.env.PILENS_DATA_DIR;
				} else {
					process.env.PILENS_DATA_DIR = previousDataDir;
				}
				env.cleanup();
			}
		});

		it("an unknown current session id falls back to claiming everything (fail-safe: no regression on hosts without stable ids)", async () => {
			const env = setupTestEnvironment("pi-lens-agent-end-ownership-unknown-");
			const previousDataDir = process.env.PILENS_DATA_DIR;
			process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
			try {
				const filePath = createTempFile(env.tmpDir, "src/app.ts", "const x=1");
				const runtime = new RuntimeCoordinator();
				runtime.projectRoot = env.tmpDir;
				runtime.deferFormat(
					filePath,
					env.tmpDir,
					"edit",
					env.tmpDir,
					"session-parent",
				);

				const formatFile = vi.fn(async (fp: string) => {
					fs.writeFileSync(fp, "const x = 1;\n");
					return {
						filePath: fp,
						formatters: [{ name: "biome", success: true, changed: true }],
						anyChanged: true,
						allSucceeded: true,
					};
				});

				const summary = await handleAgentEnd({
					ctxCwd: env.tmpDir,
					getFlag: (name) => name === "no-lsp",
					notify: vi.fn(),
					dbg: () => {},
					runtime,
					cacheManager: { addModifiedRange: vi.fn() } as any,
					getFormatService: () => ({ recordRead: () => {}, formatFile }) as any,
					// currentSessionId omitted — host never supplied one.
				});

				expect(formatFile).toHaveBeenCalledTimes(1);
				expect(summary?.changed).toEqual([filePath]);
			} finally {
				if (previousDataDir === undefined) {
					delete process.env.PILENS_DATA_DIR;
				} else {
					process.env.PILENS_DATA_DIR = previousDataDir;
				}
				env.cleanup();
			}
		});

		it("staleness fallback: an old orphaned foreign record IS claimed and logged", async () => {
			const env = setupTestEnvironment("pi-lens-agent-end-ownership-stale-");
			const previousDataDir = process.env.PILENS_DATA_DIR;
			process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
			try {
				const filePath = createTempFile(env.tmpDir, "src/app.ts", "const x=1");
				const runtime = new RuntimeCoordinator();
				runtime.projectRoot = env.tmpDir;
				runtime.deferFormat(
					filePath,
					env.tmpDir,
					"edit",
					env.tmpDir,
					"session-dead-parent",
				);

				const formatFile = vi.fn(async (fp: string) => {
					fs.writeFileSync(fp, "const x = 1;\n");
					return {
						filePath: fp,
						formatters: [{ name: "biome", success: true, changed: true }],
						anyChanged: true,
						allSucceeded: true,
					};
				});
				const dbg = vi.fn();

				const summary = await handleAgentEnd({
					ctxCwd: env.tmpDir,
					getFlag: (name) => name === "no-lsp",
					notify: vi.fn(),
					dbg,
					runtime,
					cacheManager: { addModifiedRange: vi.fn() } as any,
					getFormatService: () => ({ recordRead: () => {}, formatFile }) as any,
					currentSessionId: "session-new-secondary",
					// Negative threshold: any elapsed time at all counts as stale,
					// the smallest reliable way to force the fallback without a
					// clock-injection hook.
					staleAfterMs: -1,
				});

				expect(formatFile).toHaveBeenCalledTimes(1);
				expect(summary?.changed).toEqual([filePath]);
				expect(runtime.pendingDeferredFormatCount).toBe(0);
				expect(dbg).toHaveBeenCalledWith(
					expect.stringContaining("staleness fallback claimed"),
				);
			} finally {
				if (previousDataDir === undefined) {
					delete process.env.PILENS_DATA_DIR;
				} else {
					process.env.PILENS_DATA_DIR = previousDataDir;
				}
				env.cleanup();
			}
		});

		it("staleness fallback: an orphan whose origin does not match the claiming context is left queued, never formatted (#1642 F3)", async () => {
			const env = setupTestEnvironment(
				"pi-lens-agent-end-ownership-origin-mismatch-",
			);
			const previousDataDir = process.env.PILENS_DATA_DIR;
			process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
			try {
				// #1642 F3 shape: a record queued from a WORKTREE (a different
				// origin cwd than the parent checkout now running agent_end) must
				// never be claimed by the stale-orphan fallback just because its
				// owning session died and it aged out. Session identity alone
				// isn't enough — the origin cwd must also match.
				//
				// Driven through the REAL queuing path (handleToolCall +
				// handleToolResult) rather than a hand-written
				// `runtime.deferFormat` call: `turnStateCwd` is ALWAYS the
				// workspace root in production (`runtime-tool-result.ts`'s
				// `path.resolve(workspaceRoot)`), so a test that varied
				// `turnStateCwd` to simulate a worktree origin exercised a shape
				// production never produces. `originCwd` (this PR's new field) is
				// what production actually varies per call.
				const { runPipeline } = await import("../../clients/pipeline.js");
				vi.mocked(runPipeline).mockReset();
				vi.mocked(runPipeline).mockResolvedValue({
					output: "",
					hasBlockers: false,
					isError: false,
					fileModified: false,
				});

				const worktreeRoot = path.join(env.tmpDir, "worktree");
				const worktreeFile = createTempFile(
					worktreeRoot,
					"src/app.ts",
					"const x=1",
				);

				const runtime = new RuntimeCoordinator();
				runtime.projectRoot = env.tmpDir;
				const toolCallId = "call-origin-mismatch";

				await handleToolCall({
					event: {
						toolCallId,
						toolName: "write",
						input: { path: "src/app.ts", content: "const x=1" },
					},
					ctx: { cwd: worktreeRoot },
					lensEnabled: true,
					getFlag: (name: string) => name === "no-lsp",
					dbg: () => {},
					runtime,
					cacheManager: new CacheManager(false),
					ensureLSPConfigInitialized: async () => {},
					updateLspStatus: () => {},
					resetLSPService: () => {},
				} as any);

				await handleToolResult({
					event: {
						toolCallId,
						toolName: "write",
						input: { path: "src/app.ts", content: "const x=1" },
						content: [{ type: "text", text: "base" }],
					},
					getFlag: () => false,
					dbg: () => {},
					runtime,
					cacheManager: new CacheManager(false),
					biomeClient: {},
					ruffClient: {},
					metricsClient: {},
					resetLSPService: () => {},
					agentBehaviorRecord: () => [],
					formatBehaviorWarnings: () => "",
					sessionId: "session-dead-worktree",
					dbgDebugMarker: true,
				} as any);

				// Sanity: the real queue path actually queued this file (under
				// its own worktree origin) before agent_end ever runs.
				expect(runtime.pendingDeferredFormatCount).toBe(1);

				const formatFile = vi.fn(async (fp: string) => {
					fs.writeFileSync(fp, "const x = 1;\n");
					return {
						filePath: fp,
						formatters: [{ name: "biome", success: true, changed: true }],
						anyChanged: true,
						allSucceeded: true,
					};
				});
				const dbg = vi.fn();

				const summary = await handleAgentEnd({
					ctxCwd: env.tmpDir, // the PARENT checkout is claiming
					getFlag: (name) => name === "no-lsp",
					notify: vi.fn(),
					dbg,
					runtime,
					cacheManager: { addModifiedRange: vi.fn() } as any,
					getFormatService: () => ({ recordRead: () => {}, formatFile }) as any,
					currentSessionId: "session-new-parent",
					// Negative threshold: any elapsed time at all counts as stale.
					staleAfterMs: -1,
				});

				expect(formatFile).not.toHaveBeenCalled();
				expect(summary?.changed ?? []).toEqual([]);
				// Left queued, NOT deleted: a legitimate crashed-session orphan
				// from a different origin must stay claimable by that origin's
				// own future flush, not vanish forever.
				expect(runtime.pendingDeferredFormatCount).toBe(1);
				expect(fs.readFileSync(worktreeFile, "utf-8")).toBe("const x=1");
				expect(dbg).toHaveBeenCalledWith(expect.stringContaining("orphan"));
			} finally {
				if (previousDataDir === undefined) {
					delete process.env.PILENS_DATA_DIR;
				} else {
					process.env.PILENS_DATA_DIR = previousDataDir;
				}
				env.cleanup();
			}
		});

		it("#1678 item 1: an orphan re-surfacing across N agent_ends collapses into ONE ledger entry with a running count, not N raw events", async () => {
			const { getDegradationSummary, resetDegradationLedger } =
				await import("../../clients/degradation-ledger.js");
			resetDegradationLedger();
			const env = setupTestEnvironment("pi-lens-agent-end-orphan-ledger-");
			const previousDataDir = process.env.PILENS_DATA_DIR;
			process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
			try {
				const worktreeRoot = path.join(env.tmpDir, "worktree");
				const filePath = createTempFile(
					worktreeRoot,
					"src/app.ts",
					"const x=1",
				);
				const runtime = new RuntimeCoordinator();
				runtime.projectRoot = env.tmpDir;
				// Queued under the worktree's own origin, by a session that will
				// never come back to flush it (#1642 F3 shape).
				runtime.deferFormat(
					filePath,
					worktreeRoot,
					"edit",
					env.tmpDir,
					"session-dead-worktree",
					worktreeRoot,
				);

				const runOnce = () =>
					handleAgentEnd({
						ctxCwd: env.tmpDir, // the PARENT checkout claims — origin mismatch
						getFlag: (name) => name === "no-lsp",
						notify: vi.fn(),
						dbg: () => {},
						runtime,
						cacheManager: { addModifiedRange: vi.fn() } as any,
						getFormatService: () =>
							({ recordRead: () => {}, formatFile: vi.fn() }) as any,
						currentSessionId: "session-new-parent",
						staleAfterMs: -1,
					});

				const AGENT_END_CALLS = 3;
				for (let i = 0; i < AGENT_END_CALLS; i++) {
					await runOnce();
				}

				// Still queued after every flush — never silently dropped.
				expect(runtime.pendingDeferredFormatCount).toBe(1);

				const summary = getDegradationSummary();
				const orphanGroups = summary.filter(
					(group) => group.kind === "path-attribution-orphan-unresolved",
				);
				expect(orphanGroups).toHaveLength(1);
				expect(orphanGroups[0].count).toBe(AGENT_END_CALLS);
			} finally {
				if (previousDataDir === undefined) {
					delete process.env.PILENS_DATA_DIR;
				} else {
					process.env.PILENS_DATA_DIR = previousDataDir;
				}
				env.cleanup();
			}
		});

		it("#1678 item 1 (wrap, not additive): a perpetual orphan fires the raw logLatency event exactly ONCE across N agent_ends, every repeat counted only by the ledger", async () => {
			const { getDegradationSummary, resetDegradationLedger } =
				await import("../../clients/degradation-ledger.js");
			resetDegradationLedger();
			const env = setupTestEnvironment("pi-lens-agent-end-orphan-wrap-");
			const previousDataDir = process.env.PILENS_DATA_DIR;
			process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
			try {
				const worktreeRoot = path.join(env.tmpDir, "worktree");
				const filePath = createTempFile(
					worktreeRoot,
					"src/app.ts",
					"const x=1",
				);
				const runtime = new RuntimeCoordinator();
				runtime.projectRoot = env.tmpDir;
				runtime.deferFormat(
					filePath,
					worktreeRoot,
					"edit",
					env.tmpDir,
					"session-dead-worktree",
					worktreeRoot,
				);

				// spyOn reuses any pre-existing spy on this module-level function
				// (this file never restores/clears between tests), so its call
				// history can carry calls from earlier tests. Clear it right
				// after acquiring it so this test only sees its OWN 3 agent_ends.
				const logSpy = vi.spyOn(latencyLogger, "logLatency");
				logSpy.mockClear();

				const runOnce = () =>
					handleAgentEnd({
						ctxCwd: env.tmpDir, // the PARENT checkout claims — origin mismatch
						getFlag: (name) => name === "no-lsp",
						notify: vi.fn(),
						dbg: () => {},
						runtime,
						cacheManager: { addModifiedRange: vi.fn() } as any,
						getFormatService: () =>
							({ recordRead: () => {}, formatFile: vi.fn() }) as any,
						currentSessionId: "session-new-parent",
						staleAfterMs: -1,
					});

				const AGENT_END_CALLS = 3;
				for (let i = 0; i < AGENT_END_CALLS; i++) {
					await runOnce();
				}

				// The raw forensic event must fire on the RISING edge only — the
				// first time this orphan is observed — not once per agent_end. A
				// wrap that merely ADDS a ledger call alongside the unconditional
				// logLatency (rather than gating it) fails this assertion.
				const orphanMismatchCalls = logSpy.mock.calls.filter(
					([entry]) =>
						(entry as { phase?: string }).phase ===
						"agent_end_deferred_format_orphan_origin_mismatch",
				);
				expect(orphanMismatchCalls).toHaveLength(1);

				// Every repeat still shows up, but only through the bounded ledger
				// count — same evidence as the item-1 test above, re-asserted here
				// alongside the log-call assertion so the two halves of "wrap it"
				// (stop the raw spam, keep the count) are pinned together.
				const summary = getDegradationSummary();
				const orphanGroups = summary.filter(
					(group) => group.kind === "path-attribution-orphan-unresolved",
				);
				expect(orphanGroups).toHaveLength(1);
				expect(orphanGroups[0].count).toBe(AGENT_END_CALLS);
			} finally {
				if (previousDataDir === undefined) {
					delete process.env.PILENS_DATA_DIR;
				} else {
					process.env.PILENS_DATA_DIR = previousDataDir;
				}
				env.cleanup();
			}
		});

		it("#1678 item 3: a mismatch-flush leaves the record queued, then a flush from the MATCHING origin reclaims and formats it", async () => {
			const env = setupTestEnvironment("pi-lens-agent-end-orphan-reclaim-");
			const previousDataDir = process.env.PILENS_DATA_DIR;
			process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
			try {
				const worktreeRoot = path.join(env.tmpDir, "worktree");
				const filePath = createTempFile(
					worktreeRoot,
					"src/app.ts",
					"const x=1",
				);
				const runtime = new RuntimeCoordinator();
				runtime.projectRoot = env.tmpDir;
				runtime.deferFormat(
					filePath,
					worktreeRoot,
					"edit",
					env.tmpDir,
					"session-dead-worktree",
					worktreeRoot,
				);

				const formatFile = vi.fn(async (fp: string) => {
					fs.writeFileSync(fp, "const x = 1;\n");
					return {
						filePath: fp,
						formatters: [{ name: "biome", success: true, changed: true }],
						anyChanged: true,
						allSucceeded: true,
					};
				});

				// First flush: the PARENT checkout claims. Origin mismatch (parent
				// vs. worktree) leaves the record queued, unformatted.
				const mismatchSummary = await handleAgentEnd({
					ctxCwd: env.tmpDir,
					getFlag: (name) => name === "no-lsp",
					notify: vi.fn(),
					dbg: () => {},
					runtime,
					cacheManager: { addModifiedRange: vi.fn() } as any,
					getFormatService: () => ({ recordRead: () => {}, formatFile }) as any,
					currentSessionId: "session-new-parent",
					staleAfterMs: -1,
				});
				expect(formatFile).not.toHaveBeenCalled();
				expect(mismatchSummary?.changed ?? []).toEqual([]);
				expect(runtime.pendingDeferredFormatCount).toBe(1);

				// Second flush: this time the WORKTREE itself claims — its origin
				// matches the record's origin, so the stale-orphan fallback reclaims
				// and formats it instead of leaving it queued forever.
				const matchSummary = await handleAgentEnd({
					ctxCwd: worktreeRoot,
					getFlag: (name) => name === "no-lsp",
					notify: vi.fn(),
					dbg: () => {},
					runtime,
					cacheManager: { addModifiedRange: vi.fn() } as any,
					getFormatService: () => ({ recordRead: () => {}, formatFile }) as any,
					currentSessionId: "session-new-worktree",
					staleAfterMs: -1,
				});
				expect(formatFile).toHaveBeenCalledTimes(1);
				expect(matchSummary?.changed).toEqual([filePath]);
				expect(runtime.pendingDeferredFormatCount).toBe(0);
			} finally {
				if (previousDataDir === undefined) {
					delete process.env.PILENS_DATA_DIR;
				} else {
					process.env.PILENS_DATA_DIR = previousDataDir;
				}
				env.cleanup();
			}
		});
	});

	describe("#484 turn-summary collection gate", () => {
		it("does not record deferred-format events on the turn-summary collector when lens-turn-summary is off (default)", async () => {
			const env = setupTestEnvironment("pi-lens-agent-end-summary-off-");
			const previousDataDir = process.env.PILENS_DATA_DIR;
			process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
			try {
				const filePath = createTempFile(env.tmpDir, "src/app.ts", "const x=1");
				const runtime = new RuntimeCoordinator();
				runtime.projectRoot = env.tmpDir;
				runtime.deferFormat(filePath, env.tmpDir, "edit", env.tmpDir);

				const formatFile = vi.fn(async (fp: string) => {
					fs.writeFileSync(fp, "const x = 1;\n");
					return {
						filePath: fp,
						formatters: [{ name: "biome", success: true, changed: true }],
						anyChanged: true,
						allSucceeded: true,
					};
				});

				await handleAgentEnd({
					ctxCwd: env.tmpDir,
					// lens-turn-summary NOT among the true-returning flags — default off
					getFlag: (name) => name === "no-lsp",
					notify: vi.fn(),
					dbg: () => {},
					runtime,
					cacheManager: { addModifiedRange: () => {} } as any,
					getFormatService: () => ({ recordRead: () => {}, formatFile }) as any,
				});

				expect(runtime.turnSummary.isEmpty()).toBe(true);
			} finally {
				if (previousDataDir === undefined) {
					delete process.env.PILENS_DATA_DIR;
				} else {
					process.env.PILENS_DATA_DIR = previousDataDir;
				}
				env.cleanup();
			}
		});

		it("records a format event on the turn-summary collector when lens-turn-summary is on", async () => {
			const env = setupTestEnvironment("pi-lens-agent-end-summary-on-");
			const previousDataDir = process.env.PILENS_DATA_DIR;
			process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
			try {
				const filePath = createTempFile(env.tmpDir, "src/app.ts", "const x=1");
				const runtime = new RuntimeCoordinator();
				runtime.projectRoot = env.tmpDir;
				runtime.deferFormat(filePath, env.tmpDir, "edit", env.tmpDir);

				const formatFile = vi.fn(async (fp: string) => {
					fs.writeFileSync(fp, "const x = 1;\n");
					return {
						filePath: fp,
						formatters: [{ name: "biome", success: true, changed: true }],
						anyChanged: true,
						allSucceeded: true,
					};
				});

				await handleAgentEnd({
					ctxCwd: env.tmpDir,
					getFlag: (name) => name === "no-lsp" || name === "lens-turn-summary",
					notify: vi.fn(),
					dbg: () => {},
					runtime,
					cacheManager: { addModifiedRange: () => {} } as any,
					getFormatService: () => ({ recordRead: () => {}, formatFile }) as any,
				});

				expect(runtime.turnSummary.isEmpty()).toBe(false);
				const details = runtime.turnSummary.consume(1);
				expect(details.files).toHaveLength(1);
				expect(details.files[0].events).toEqual([
					{ kind: "format", tool: "biome" },
				]);
			} finally {
				if (previousDataDir === undefined) {
					delete process.env.PILENS_DATA_DIR;
				} else {
					process.env.PILENS_DATA_DIR = previousDataDir;
				}
				env.cleanup();
			}
		});

		it("suppresses the info-level deferred-format success toast when lens-turn-summary is on, but keeps the failure toast", async () => {
			const env = setupTestEnvironment("pi-lens-agent-end-summary-toast-");
			const previousDataDir = process.env.PILENS_DATA_DIR;
			process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
			try {
				const filePath = createTempFile(env.tmpDir, "src/app.ts", "const x=1");
				const runtime = new RuntimeCoordinator();
				runtime.projectRoot = env.tmpDir;
				runtime.deferFormat(filePath, env.tmpDir, "edit", env.tmpDir);

				const formatFile = vi.fn(async (fp: string) => {
					fs.writeFileSync(fp, "const x = 1;\n");
					return {
						filePath: fp,
						formatters: [{ name: "biome", success: true, changed: true }],
						anyChanged: true,
						allSucceeded: true,
					};
				});
				const notify = vi.fn();

				await handleAgentEnd({
					ctxCwd: env.tmpDir,
					getFlag: (name) => name === "no-lsp" || name === "lens-turn-summary",
					notify,
					dbg: () => {},
					runtime,
					cacheManager: { addModifiedRange: () => {} } as any,
					getFormatService: () => ({ recordRead: () => {}, formatFile }) as any,
				});

				// The success info toast is redundant once the transcript entry is
				// opted in — must not fire.
				expect(notify).not.toHaveBeenCalledWith(
					expect.stringContaining("deferred format applied to"),
					"info",
				);
			} finally {
				if (previousDataDir === undefined) {
					delete process.env.PILENS_DATA_DIR;
				} else {
					process.env.PILENS_DATA_DIR = previousDataDir;
				}
				env.cleanup();
			}
		});
	});
});

// #3521 review F1 (catalog shape 22): pi marks the run inactive before it
// awaits the agent_settled handlers, so a /tree can land while this drain
// awaits a formatter, an autofix client or an LSP quick fix. The drain's
// `recordWritten` must then not credit the file to the new branch. Each case
// moves the branch from INSIDE the awaited writer, the way the host
// interleaves, and backdates the written file so the pre-#3520 mtime
// fallback (a separate, named residual) cannot answer instead of the fence.
describe("runtime-agent-end deferred writes across a /tree (#3521)", () => {
	const LONG_AGO = new Date("2000-01-01T00:00:00Z");
	const settle = (filePath: string, content: string) => {
		fs.writeFileSync(filePath, content);
		fs.utimesSync(filePath, LONG_AGO, LONG_AGO);
	};
	const zeroRead = (runtime: RuntimeCoordinator, filePath: string) =>
		runtime.readGuard.checkEdit(filePath, [1, 1]).action;

	afterEach(async () => {
		await cleanupTestEnvironmentsDrained("pi-lens-agent-end-branch-");
	});

	for (const moved of [true, false]) {
		it(`${moved ? "does not credit" : "credits"} a deferred format write ${moved ? "that lands after" : "with no"} /tree`, async () => {
			const env = setupTestEnvironment("pi-lens-agent-end-branch-fmt-");
			const previousDataDir = process.env.PILENS_DATA_DIR;
			process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
			try {
				const filePath = createTempFile(env.tmpDir, "src/app.ts", "const x=1");
				fs.utimesSync(filePath, LONG_AGO, LONG_AGO);
				const runtime = new RuntimeCoordinator();
				runtime.projectRoot = env.tmpDir;
				runtime.deferFormat(filePath, env.tmpDir, "edit", env.tmpDir);
				const { getDegradationSummary, resetDegradationLedger } =
					await import("../../clients/degradation-ledger.js");
				resetDegradationLedger();
				vi.mocked(getFormattersForFile).mockResolvedValueOnce([
					{ name: "biome" } as FormatterInfo,
				]);
				vi.mocked(runFormatter).mockImplementationOnce(async (fp: string) => {
					if (moved) runtime.readGuard.retainBranch(new Set());
					settle(fp, "const x = 1;\n");
					return { success: true, changed: true, outcome: "formatted" };
				});
				await handleAgentEnd({
					ctxCwd: env.tmpDir,
					getFlag: (name) => name === "no-lsp",
					notify: () => {},
					dbg: () => {},
					runtime,
					cacheManager: { addModifiedRange: () => {} } as any,
					// As `index.ts` builds it for the drain: the guard's session id.
					getFormatService: () =>
						getFormatService(runtime.telemetrySessionId, true),
				});
				// #3525: the agent never saw these bytes: authorship, not FileTime.
				expect(runtime.readGuard.fileTimeMoved(filePath)).toBe(true);
				expect(zeroRead(runtime, filePath)).toBe(moved ? "block" : "allow");
				// The refused write leaves one counted, discriminating record.
				expect(
					getDegradationSummary().find(
						(group) => group.kind === "read-guard-write-after-branch-move",
					)?.count,
				).toBe(moved ? 1 : undefined);
				// The move is branch-scoped: the session's change log keeps the
				// drain's record either way.
				expect(readChangesSince(env.tmpDir, 0)).toMatchObject([
					{ source: "format", filePath },
				]);
			} finally {
				if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
				else process.env.PILENS_DATA_DIR = previousDataDir;
				env.cleanup();
			}
		});

		it(`${moved ? "does not credit" : "credits"} a deferred autofix write ${moved ? "that lands after" : "with no"} /tree`, async () => {
			const env = setupTestEnvironment("pi-lens-agent-end-branch-fix-");
			try {
				const filePath = createTempFile(
					env.tmpDir,
					"src/app.ts",
					"let value=1\n",
				);
				fs.utimesSync(filePath, LONG_AGO, LONG_AGO);
				fs.writeFileSync(path.join(env.tmpDir, "biome.json"), "{}\n");
				fs.writeFileSync(
					path.join(env.tmpDir, "package.json"),
					JSON.stringify({ devDependencies: { "@biomejs/biome": "^1.0.0" } }),
				);
				fs.writeFileSync(
					path.join(env.tmpDir, "package-lock.json"),
					JSON.stringify({
						packages: { "node_modules/@biomejs/biome": { version: "1.0.0" } },
					}),
				);
				const runtime = new RuntimeCoordinator();
				runtime.projectRoot = env.tmpDir;
				runtime.deferMutation(
					filePath,
					env.tmpDir,
					"edit",
					env.tmpDir,
					"autofix",
				);
				const biomeClient = {
					isSupportedFile: () => true,
					ensureAvailable: async () => true,
					fixFileAsync: async (fp: string) => {
						if (moved) runtime.readGuard.retainBranch(new Set());
						settle(fp, "const value=1\n");
						return { success: true, changed: true, fixed: 1 };
					},
				};
				await handleAgentEnd({
					ctxCwd: env.tmpDir,
					getFlag: (name) => name === "no-lsp",
					notify: vi.fn(),
					dbg: () => {},
					runtime,
					cacheManager: { addModifiedRange: vi.fn() } as any,
					biomeClient: biomeClient as any,
					ruffClient: {} as any,
					getFormatService: () =>
						({ recordRead: () => {}, formatFile: vi.fn() }) as any,
				});
				// #3525: the agent never saw these bytes: authorship, not FileTime.
				expect(runtime.readGuard.fileTimeMoved(filePath)).toBe(true);
				expect(zeroRead(runtime, filePath)).toBe(moved ? "block" : "allow");
			} finally {
				env.cleanup();
			}
		});

		it(`${moved ? "does not credit" : "credits"} an actionable-warning quick fix ${moved ? "that lands after" : "with no"} /tree`, async () => {
			const env = setupTestEnvironment("pi-lens-agent-end-branch-aw-");
			try {
				const filePath = createTempFile(
					env.tmpDir,
					"src/app.ts",
					"const x = 1;\n",
				);
				fs.utimesSync(filePath, LONG_AGO, LONG_AGO);
				const runtime = new RuntimeCoordinator();
				runtime.projectRoot = env.tmpDir;
				runtime.seedProjectSequence(1);
				const report: ActionableWarningsReport = {
					generatedAt: new Date().toISOString(),
					scope: "turn_delta",
					sessionId: "s1",
					turnIndex: 1,
					projectSeqEnd: 1,
					deltaOnly: true,
					includeLspCodeActions: true,
					files: [
						{
							filePath,
							displayPath: "src/app.ts",
							// #3676: the quick fix credits the epoch its entry was built on.
							branchEpoch: runtime.readGuard.currentBranchEpoch,
							branchScope: runtime.readGuard.lineageKey,
							warnings: [
								{
									id: "aw:3521",
									filePath,
									displayPath: "src/app.ts",
									severity: "warning",
									tool: "typescript",
									message: "unused var",
									suppressed: false,
									origin: "dispatch",
									actions: [
										{
											title: "Remove unused var",
											hasEdit: true,
											hasCommand: false,
											autoFixEligible: true,
										},
									],
								},
							],
						},
					],
					summary: {
						warnings: 1,
						unsuppressed: 1,
						suppressed: 0,
						files: 1,
						actions: 1,
						autoFixEligible: 1,
					},
				};
				applyConservativeActionableWarningFixesMock.mockImplementationOnce(
					async (args: {
						mutationContext: {
							readGuard?: { recordWritten: (filePath: string) => void };
						};
					}) => {
						if (moved) runtime.readGuard.retainBranch(new Set());
						settle(filePath, "const x = 2;\n");
						args.mutationContext.readGuard?.recordWritten(filePath);
						return {
							considered: 1,
							applied: 1,
							changedFiles: [filePath],
							skipped: [],
						};
					},
				);
				await handleAgentEnd({
					ctxCwd: env.tmpDir,
					getFlag: (name) =>
						name === "lens-actionable-warning-autofix" ||
						name === "lens-actionable-warnings" ||
						name === "no-lsp",
					notify: vi.fn(),
					dbg: vi.fn(),
					runtime,
					cacheManager: {
						readCache: () => ({ data: report }),
						addModifiedRange: vi.fn(),
					} as any,
					getFormatService: () =>
						({ recordRead: () => {}, formatFile: vi.fn() }) as any,
				});
				expect(applyConservativeActionableWarningFixesMock).toHaveBeenCalled();
				// #3525: the agent never saw these bytes: authorship, not FileTime.
				expect(runtime.readGuard.fileTimeMoved(filePath)).toBe(true);
				expect(zeroRead(runtime, filePath)).toBe(moved ? "block" : "allow");
			} finally {
				applyConservativeActionableWarningFixesMock.mockReset();
				env.cleanup();
			}
		});
	}

	// #3521 round-3 verify F-B, reshaped by #3676 (F-A): a /tree that lands
	// before the drain starts must still refuse the quick fix's write. The
	// report was built before the move, so it carries the old epoch; a drain
	// that credited the epoch current at its own entry would credit it to the
	// new branch.
	it("does not credit a quick fix whose report predates a /tree that landed before the drain started", async () => {
		const env = setupTestEnvironment("pi-lens-agent-end-branch-aw-entry-");
		try {
			const filePath = createTempFile(
				env.tmpDir,
				"src/app.ts",
				"const x = 1;\n",
			);
			fs.utimesSync(filePath, LONG_AGO, LONG_AGO);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.seedProjectSequence(1);
			const report: ActionableWarningsReport = {
				generatedAt: new Date().toISOString(),
				scope: "turn_delta",
				sessionId: "s1",
				turnIndex: 1,
				projectSeqEnd: 1,
				deltaOnly: true,
				includeLspCodeActions: true,
				files: [
					{
						filePath,
						displayPath: "src/app.ts",
						branchEpoch: runtime.readGuard.currentBranchEpoch,
						branchScope: runtime.readGuard.lineageKey,
						warnings: [
							{
								id: "aw:3521-entry",
								filePath,
								displayPath: "src/app.ts",
								severity: "warning",
								tool: "typescript",
								message: "unused var",
								suppressed: false,
								origin: "dispatch",
								actions: [
									{
										title: "Remove unused var",
										hasEdit: true,
										hasCommand: false,
										autoFixEligible: true,
									},
								],
							},
						],
					},
				],
				summary: {
					warnings: 1,
					unsuppressed: 1,
					suppressed: 0,
					files: 1,
					actions: 1,
					autoFixEligible: 1,
				},
			};
			applyConservativeActionableWarningFixesMock.mockImplementationOnce(
				async (args: {
					mutationContext: {
						readGuard?: { recordWritten: (filePath: string) => void };
					};
				}) => {
					settle(filePath, "const x = 2;\n");
					args.mutationContext.readGuard?.recordWritten(filePath);
					return {
						considered: 1,
						applied: 1,
						changedFiles: [filePath],
						skipped: [],
					};
				},
			);
			// The report was built at epoch 0; the /tree lands while the sweep awaits.
			runtime.readGuard.retainBranch(new Set());
			await handleAgentEnd({
				ctxCwd: env.tmpDir,
				getFlag: (name) =>
					name === "lens-actionable-warning-autofix" ||
					name === "lens-actionable-warnings" ||
					name === "no-lsp",
				notify: vi.fn(),
				dbg: vi.fn(),
				runtime,
				cacheManager: {
					readCache: () => ({ data: report }),
					addModifiedRange: vi.fn(),
				} as any,
				getFormatService: () =>
					({ recordRead: () => {}, formatFile: vi.fn() }) as any,
			});
			expect(applyConservativeActionableWarningFixesMock).toHaveBeenCalled();
			expect(zeroRead(runtime, filePath)).toBe("block");
		} finally {
			applyConservativeActionableWarningFixesMock.mockReset();
			env.cleanup();
		}
	});

	// #3676. The quick fix is credited with the oldest branch epoch among the
	// entries it fixes. Recurrence: a cache file written before the stamp
	// existed (readable for ten minutes), a malformed epoch, or one entry older
	// than its neighbours must not be credited to whichever branch the settle
	// runs on. The fix is still applied; only its credit is withheld, and the
	// row says why. The probed file is `a`; `b` is a neighbour in the same pass.
	// `scopes` overrides the guard lineage each entry was built under (default:
	// the live guard's), `neighbour` makes `b` something the pass cannot fix.
	const quickFixPass = async (
		epochs: readonly [unknown, unknown],
		opts: {
			moved?: boolean;
			scopes?: readonly [unknown, unknown];
			neighbour?: "fixable" | "not eligible" | "suppressed";
			/** The pid the process presents when the pass runs (a resume elsewhere). */
			pidAtSettle?: number;
		} = {},
	) => {
		const { moved = true, neighbour = "fixable" } = opts;
		const env = setupTestEnvironment("pi-lens-agent-end-branch-aw-pass-");
		try {
			const a = createTempFile(env.tmpDir, "src/a.ts", "const x = 1;\n");
			const b = createTempFile(env.tmpDir, "src/b.ts", "const y = 1;\n");
			for (const file of [a, b]) fs.utimesSync(file, LONG_AGO, LONG_AGO);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.seedProjectSequence(1);
			if (moved) runtime.readGuard.retainBranch(new Set());
			const { getDegradationSummary, resetDegradationLedger } =
				await import("../../clients/degradation-ledger.js");
			resetDegradationLedger();
			const scopes = opts.scopes ?? [
				runtime.readGuard.lineageKey,
				runtime.readGuard.lineageKey,
			];
			const entry = (
				filePath: string,
				branchEpoch: unknown,
				branchScope: unknown,
				kind: "fixable" | "not eligible" | "suppressed" = "fixable",
			) => ({
				filePath,
				displayPath: path.basename(filePath),
				branchEpoch,
				branchScope,
				warnings: [
					{
						id: `aw:3676:${path.basename(filePath)}`,
						filePath,
						displayPath: path.basename(filePath),
						severity: "warning",
						tool: "typescript",
						message: "unused var",
						suppressed: kind === "suppressed",
						origin: "dispatch",
						actions: [
							{
								title: "Remove unused var",
								hasEdit: true,
								hasCommand: false,
								autoFixEligible: kind !== "not eligible",
							},
						],
					},
				],
			});
			const report = {
				generatedAt: new Date().toISOString(),
				scope: "turn_delta",
				sessionId: "s1",
				turnIndex: 1,
				projectSeqEnd: 1,
				deltaOnly: true,
				includeLspCodeActions: true,
				files: [
					entry(a, epochs[0], scopes[0]),
					entry(b, epochs[1], scopes[1], neighbour),
				],
				summary: {
					warnings: 2,
					unsuppressed: 2,
					suppressed: 0,
					files: 2,
					actions: 2,
					autoFixEligible: 2,
				},
			} as unknown as ActionableWarningsReport;
			applyConservativeActionableWarningFixesMock.mockImplementationOnce(
				async (args: {
					mutationContext: {
						readGuard?: { recordWritten: (filePath: string) => void };
					};
				}) => {
					settle(a, "const x = 2;\n");
					args.mutationContext.readGuard?.recordWritten(a);
					return {
						considered: 1,
						applied: 1,
						changedFiles: [a],
						skipped: [],
					};
				},
			);
			// `process.pid` is a data property, so `vi.spyOn(process, "pid", "get")`
			// has no getter to spy on: swap the descriptor and restore it below.
			const pidDescriptor = Object.getOwnPropertyDescriptor(process, "pid")!;
			if (opts.pidAtSettle !== undefined)
				Object.defineProperty(process, "pid", {
					...pidDescriptor,
					value: opts.pidAtSettle,
				});
			try {
				await handleAgentEnd({
					ctxCwd: env.tmpDir,
					getFlag: (name) =>
						name === "lens-actionable-warning-autofix" ||
						name === "lens-actionable-warnings" ||
						name === "no-lsp",
					notify: vi.fn(),
					dbg: vi.fn(),
					runtime,
					cacheManager: {
						readCache: () => ({ data: report }),
						addModifiedRange: vi.fn(),
					} as any,
					getFormatService: () =>
						({ recordRead: () => {}, formatFile: vi.fn() }) as any,
				});
			} finally {
				Object.defineProperty(process, "pid", pidDescriptor);
			}
			expect(applyConservativeActionableWarningFixesMock).toHaveBeenCalled();
			expect(fs.readFileSync(a, "utf8")).toBe("const x = 2;\n");
			return {
				verdict: zeroRead(runtime, a),
				rows: getDegradationSummary().filter(
					(group) => group.kind === "actionable-warnings-quickfix-uncredited",
				),
				subject: env.tmpDir,
			};
		} finally {
			applyConservativeActionableWarningFixesMock.mockReset();
			env.cleanup();
		}
	};

	for (const [label, epoch] of [
		["no branchEpoch", undefined],
		["a negative branchEpoch", -1],
		["a fractional branchEpoch", 1.5],
		["a string branchEpoch", "1"],
	] as const) {
		it(`applies a quick fix from an entry with ${label} and credits it to no branch`, async () => {
			const { verdict, rows, subject } = await quickFixPass([epoch, 1]);
			expect(verdict).toBe("block");
			expect(rows).toEqual([
				expect.objectContaining({
					count: 1,
					latestReasons: [expect.objectContaining({ subject })],
				}),
			]);
		});
	}

	// F10/F11. Recurrence (#3912 review r1 F2): a new guard restarts the epoch at
	// 0, so an entry another guard stamped 0 equals the live 0 of a fork, a /new
	// session or a resume. The live epoch is 0 here, as in a fresh guard.
	for (const [label, scope] of [
		["another process's guard", `${process.pid + 1}:${1}`],
		["another scope of this process", "scope-from-a-dead-guard"],
		["no scope (a cache file from before the stamp)", undefined],
	] as const) {
		it(`applies a quick fix from an entry built under ${label} and credits it to no branch`, async () => {
			const { verdict, rows, subject } = await quickFixPass([0, 0], {
				moved: false,
				scopes: [scope, scope],
			});
			expect(verdict).toBe("block");
			expect(rows).toEqual([
				expect.objectContaining({
					count: 1,
					latestReasons: [expect.objectContaining({ subject })],
				}),
			]);
		});
	}

	// F11, the pid term of `lineageKey`. A resume in another process presents the
	// same guard ticket (the counter restarts at 1 in each process) and the same
	// epoch 0; only the pid differs. The report is built under the real pid, then
	// the process presents another one when the pass runs.
	it("applies a quick fix from an entry the same ticket and epoch stamped in another process and credits it to no branch", async () => {
		const { verdict, rows, subject } = await quickFixPass([0, 0], {
			moved: false,
			pidAtSettle: process.pid + 1,
		});
		expect(verdict).toBe("block");
		expect(rows).toEqual([
			expect.objectContaining({
				count: 1,
				latestReasons: [expect.objectContaining({ subject })],
			}),
		]);
	});

	it("credits a quick fix pass whose entries were built under the live guard at epoch 0", async () => {
		expect((await quickFixPass([0, 0], { moved: false })).verdict).toBe(
			"allow",
		);
	});

	// M12/M13. The pass is credited over the entries it can fix. A neighbour it
	// cannot fix (no eligible action, or suppressed) is not part of the evidence,
	// however old: crediting over every enabled entry would withhold a credit the
	// probed file's own entry earns.
	for (const neighbour of ["not eligible", "suppressed"] as const) {
		it(`ignores an older neighbour entry the pass cannot fix (${neighbour})`, async () => {
			expect((await quickFixPass([1, 0], { neighbour })).verdict).toBe("allow");
		});
	}

	// The live epoch is 1 (a /tree ran). The pass is credited with the oldest of
	// its entries' epochs, in whichever order they come, and an entry without
	// one withholds the credit however many of its neighbours have one.
	for (const [label, epochs, verdict] of [
		["both entries on the live branch", [1, 1], "allow"],
		["an older neighbour after it", [1, 0], "block"],
		["an older neighbour before it", [0, 1], "block"],
		["an unstamped neighbour after it", [1, undefined], "block"],
		["an unstamped neighbour before it", [undefined, 1], "block"],
	] as const) {
		it(`credits a quick fix pass with its oldest entry: ${label}`, async () => {
			expect((await quickFixPass(epochs)).verdict).toBe(verdict);
		});
	}
});

// #3521 round-2 verify R2-F1 (catalog shape 22): the branch epoch was taken
// when a settle started, not when the work was queued. A record the branch-X
// run queued, and that an aborted or failed drain put back in the queue, was
// then drained at the next settle on branch Y with Y's epoch and credited as
// authored on Y. The common trigger: /tree while the agent streams, because
// pi's selector awaits abort() first and the aborted settle requeues every
// pending record. Each case queues on X, lets a first settle requeue the
// record, moves the branch, and drains at a second settle that passes the
// epoch it captured at entry, exactly as onAgentSettled does. The files are
// backdated so the pre-#3520 mtime fallback cannot answer instead of the fence.
describe("runtime-agent-end deferred records queued before a /tree (#3521 R2-F1)", () => {
	const LONG_AGO = new Date("2000-01-01T00:00:00Z");
	const settle = (filePath: string, content: string) => {
		fs.writeFileSync(filePath, content);
		fs.utimesSync(filePath, LONG_AGO, LONG_AGO);
	};
	type Base = Omit<Parameters<typeof handleAgentEnd>[0], "runtime">;

	afterEach(async () => {
		await cleanupTestEnvironmentsDrained("pi-lens-agent-end-requeue-");
	});

	/** The zero-read edit verdict on the branch the second settle runs on. */
	async function acrossSettles(args: {
		/** Queue the record on X and run whatever first settle requeues it. */
		onX: (
			runtime: RuntimeCoordinator,
			filePath: string,
			base: Base,
			cwd: string,
		) => Promise<void>;
		moved: boolean;
		/** Runs on Y, after the move and before Y's settle. */
		onY?: (runtime: RuntimeCoordinator, filePath: string, cwd: string) => void;
		secondSettle?: Partial<Parameters<typeof handleAgentEnd>[0]>;
	}): Promise<string> {
		const env = setupTestEnvironment("pi-lens-agent-end-requeue-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const filePath = createTempFile(env.tmpDir, "src/app.ts", "const x=1");
			fs.utimesSync(filePath, LONG_AGO, LONG_AGO);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			const base: Base = {
				ctxCwd: env.tmpDir,
				getFlag: (name) => name === "no-lsp",
				notify: () => {},
				dbg: () => {},
				cacheManager: { addModifiedRange: () => {} } as any,
				getFormatService: () =>
					({
						recordRead: () => {},
						formatFile: async (fp: string) => {
							settle(fp, "const x = 1;\n");
							return {
								filePath: fp,
								formatters: [{ name: "biome", success: true, changed: true }],
								anyChanged: true,
								allSucceeded: true,
							};
						},
					}) as any,
			};
			await args.onX(runtime, filePath, base, env.tmpDir);
			if (args.moved) runtime.readGuard.retainBranch(new Set());
			args.onY?.(runtime, filePath, env.tmpDir);
			await handleAgentEnd({
				...base,
				runtime,
				...args.secondSettle,
			});
			return runtime.readGuard.checkEdit(filePath, [1, 1]).action;
		} finally {
			if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
			else process.env.PILENS_DATA_DIR = previousDataDir;
			env.cleanup();
		}
	}

	/** Branch X queues a format, and an ESC-aborted settle requeues it. */
	const abortedOnX = async (
		runtime: RuntimeCoordinator,
		filePath: string,
		base: Base,
		cwd: string,
	) => {
		runtime.deferFormat(filePath, cwd, "edit", cwd);
		const aborted = new AbortController();
		aborted.abort();
		await handleAgentEnd({
			...base,
			runtime,
			signal: aborted.signal,
		});
		expect(runtime.pendingDeferredMutationCount).toBe(1);
	};

	/** Branch X queues a format, and a settle whose formatter throws requeues it. */
	const formatFailedOnX = async (
		runtime: RuntimeCoordinator,
		filePath: string,
		base: Base,
		cwd: string,
	) => {
		runtime.deferFormat(filePath, cwd, "edit", cwd);
		await handleAgentEnd({
			...base,
			runtime,
			getFormatService: () =>
				({
					recordRead: () => {},
					formatFile: async () => {
						throw new Error("formatter crashed");
					},
				}) as any,
		});
		expect(runtime.pendingDeferredMutationCount).toBe(1);
	};

	/** Branch X queues an autofix, and a settle without clients requeues it. */
	const clientsUnavailableOnX = async (
		runtime: RuntimeCoordinator,
		filePath: string,
		base: Base,
		cwd: string,
	) => {
		runtime.deferMutation(filePath, cwd, "edit", cwd, "autofix");
		await handleAgentEnd({
			...base,
			runtime,
		});
		expect(runtime.pendingDeferredMutationCount).toBe(1);
	};
	const autofixClients = {
		biomeClient: {
			isSupportedFile: () => true,
			ensureAvailable: async () => true,
			fixFileAsync: async (fp: string) => {
				settle(fp, "const x = 1;\n");
				return { success: true, changed: true, fixed: 1 };
			},
		} as any,
		ruffClient: {} as any,
	};
	const withBiomeProject = (cwd: string) => {
		fs.writeFileSync(path.join(cwd, "biome.json"), "{}\n");
		fs.writeFileSync(
			path.join(cwd, "package.json"),
			JSON.stringify({ devDependencies: { "@biomejs/biome": "^1.0.0" } }),
		);
		fs.writeFileSync(
			path.join(cwd, "package-lock.json"),
			JSON.stringify({
				packages: { "node_modules/@biomejs/biome": { version: "1.0.0" } },
			}),
		);
	};

	for (const moved of [true, false]) {
		const verdict = moved ? "block" : "allow";
		const where = moved ? "after a /tree" : "with no /tree";

		it(`drains an abort-requeued format ${where} as ${verdict}`, async () => {
			expect(await acrossSettles({ onX: abortedOnX, moved })).toBe(verdict);
		});

		it(`drains a format-failed requeued format ${where} as ${verdict}`, async () => {
			expect(await acrossSettles({ onX: formatFailedOnX, moved })).toBe(
				verdict,
			);
		});

		it(`drains a clients-unavailable requeued autofix ${where} as ${verdict}`, async () => {
			expect(
				await acrossSettles({
					onX: async (runtime, filePath, base, cwd) => {
						withBiomeProject(cwd);
						await clientsUnavailableOnX(runtime, filePath, base, cwd);
					},
					moved,
					secondSettle: autofixClients,
				}),
			).toBe(verdict);
		});

		it(`drains a secondary's stale-orphan format ${where} as ${verdict}`, async () => {
			expect(
				await acrossSettles({
					onX: async (runtime, filePath, _base, cwd) => {
						runtime.deferFormat(filePath, cwd, "edit", cwd, "secondary");
					},
					moved,
					// The primary's settle claims the secondary's record as a stale
					// orphan (any age is stale here; same origin).
					secondSettle: { currentSessionId: "primary", staleAfterMs: -1 },
				}),
			).toBe(verdict);
		});
	}

	// Coalesce (catalog shape 55): a merged record carries the NEWER epoch.
	// Y's own touch of F came after every older-branch write to F, so Y has
	// seen the bytes the drain rewrites; keeping X's epoch would be a false
	// block.
	it("credits a requeued format that branch Y queued again after the /tree", async () => {
		expect(
			await acrossSettles({
				onX: abortedOnX,
				moved: true,
				onY: (runtime, filePath, cwd) =>
					runtime.deferFormat(filePath, cwd, "edit", cwd),
			}),
		).toBe("allow");
	});

	/** A settled-sweep replay of F through the bridge, carrying its epoch. */
	const sweepReplay = (
		runtime: RuntimeCoordinator,
		filePath: string,
		cwd: string,
		readGuardBranchEpoch: number,
	) =>
		expect(
			recordMutationThroughSeam(
				{ filePath, kind: "write", readGuardBranchEpoch },
				{
					getRuntime: () => runtime as never,
					getCacheManager: () => ({ addModifiedRange: () => {} }),
					getProjectRoot: () => cwd,
					getDispatchCwd: () => cwd,
					countFileLines: () => 1,
					isRecordable: () => true,
					dbg: () => {},
				},
			),
		).toBe(true);

	it("credits Y's queued format when a pre-move sweep replay re-touches it", async () => {
		expect(
			await acrossSettles({
				onX: async () => {},
				moved: true,
				onY: (runtime, filePath, cwd) => {
					runtime.deferFormat(filePath, cwd, "edit", cwd);
					// The settle that captured epoch 0 replays drift on F after the move.
					sweepReplay(runtime, filePath, cwd, 0);
				},
			}),
		).toBe("allow");
	});

	// #3677 round 3 (verify r2 V2): a settle that captured epoch 2 replays drift
	// after `resetForSession`, whose new guard restarts at 0. Round 2 queued that
	// dead session's write at the CURRENT epoch, so this drain credited it to the
	// new session one hop after the bridge's own stamp refused it.
	const deadSessionReplay = (
		runtime: RuntimeCoordinator,
		filePath: string,
		cwd: string,
		queueFirst: boolean,
	) => {
		runtime.readGuard.retainBranch(new Set());
		runtime.readGuard.retainBranch(new Set());
		const captured = runtime.readGuard.currentBranchEpoch;
		runtime.resetForSession();
		expect(runtime.readGuard.currentBranchEpoch).toBeLessThan(captured);
		if (queueFirst) runtime.deferFormat(filePath, cwd, "edit", cwd);
		sweepReplay(runtime, filePath, cwd, captured);
	};

	it("drains nothing a dead session's sweep replay queued after a session reset", async () => {
		expect(
			await acrossSettles({
				onX: async () => {},
				moved: false,
				onY: (runtime, filePath, cwd) =>
					deadSessionReplay(runtime, filePath, cwd, false),
			}),
		).toBe("block");
	});

	// The #3677 poison: the dead session's epoch must not reach the `Math.max`
	// merge of a record the new session queued itself, or its own write is
	// refused.
	it("credits the new session's queued format when a dead session's sweep replay re-touches it", async () => {
		expect(
			await acrossSettles({
				onX: async () => {},
				moved: false,
				onY: (runtime, filePath, cwd) =>
					deadSessionReplay(runtime, filePath, cwd, true),
			}),
		).toBe("allow");
	});

	// T6: the settled sweep's entries are created inside the settle, after its
	// awaits. A /tree can land first; the deferred record the replay queues must
	// carry the epoch the settle captured, not the one current at queue time.
	for (const moved of [true, false]) {
		it(`drains a format a settled-sweep replay queued ${moved ? "after a /tree" : "with no /tree"} as ${moved ? "block" : "allow"}`, async () => {
			expect(
				await acrossSettles({
					onX: async () => {},
					moved,
					onY: (runtime, filePath, cwd) =>
						sweepReplay(runtime, filePath, cwd, 0),
				}),
			).toBe(moved ? "block" : "allow");
		});
	}

	// The inverse merge: X's record is requeued into one that branch Y queued
	// while X's drain awaited its formatter (the /tree landed in between).
	it("credits an older requeued format merged into a record branch Y queued meanwhile", async () => {
		expect(
			await acrossSettles({
				onX: async (runtime, filePath, base, cwd) => {
					runtime.deferFormat(filePath, cwd, "edit", cwd);
					await handleAgentEnd({
						...base,
						runtime,
						getFormatService: () =>
							({
								recordRead: () => {},
								formatFile: async () => {
									runtime.readGuard.retainBranch(new Set());
									runtime.deferFormat(filePath, cwd, "edit", cwd);
									throw new Error("formatter crashed");
								},
							}) as any,
					});
					expect(runtime.pendingDeferredMutationCount).toBe(1);
				},
				moved: false,
			}),
		).toBe("allow");
	});

	// T7: a record the drain requeues merges into one that a stale sweep entry
	// created while the drain awaited its formatter; the merged record keeps the
	// newer epoch.
	it("credits a requeued format merged into a record a pre-move sweep created meanwhile", async () => {
		expect(
			await acrossSettles({
				onX: async (runtime, filePath, base, cwd) => {
					// Y's record: the move comes first here, so the "X" run is Y's.
					runtime.readGuard.retainBranch(new Set());
					runtime.deferFormat(filePath, cwd, "edit", cwd);
					await handleAgentEnd({
						...base,
						runtime,
						getFormatService: () =>
							({
								recordRead: () => {},
								formatFile: async () => {
									// A settle that captured epoch 0 replays drift on F
									// while this drain awaits, then the format fails.
									sweepReplay(runtime, filePath, cwd, 0);
									throw new Error("formatter crashed");
								},
							}) as any,
					});
					expect(runtime.pendingDeferredMutationCount).toBe(1);
				},
				moved: false,
			}),
		).toBe("allow");
	});
});
