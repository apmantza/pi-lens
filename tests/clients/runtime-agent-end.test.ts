import * as fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import * as path from "node:path";
import type { ActionableWarningsReport } from "../../clients/actionable-warnings.js";
import { CacheManager } from "../../clients/cache-manager.js";
import { readChangesSince } from "../../clients/project-changes.js";
import { handleAgentEnd } from "../../clients/runtime-agent-end.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";
import {
	_resetForTests as resetBusPublish,
	wireBusEmitter,
} from "../../clients/bus-publish.js";

// Only the "stale report" test below enables lens-actionable-warning-autofix,
// and it returns before reaching applyConservativeActionableWarningFixes (the
// staleness check short-circuits first) — safe to mock this at module scope
// for the dedicated #502 fix-provenance test further down without affecting
// any other test in this file.
const applyConservativeActionableWarningFixesMock = vi.fn();
vi.mock("../../clients/actionable-warnings.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/actionable-warnings.js")>();
	return {
		...actual,
		applyConservativeActionableWarningFixes: (
			...args: Parameters<typeof actual.applyConservativeActionableWarningFixes>
		) => applyConservativeActionableWarningFixesMock(...args),
	};
});

describe("runtime-agent-end deferred formatting", () => {
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
			expect(Object.keys(cacheManager.readTurnState(workspaceRoot).files)).toEqual([
				"platform/svc/go/daemon/main.go",
			]);
			expect(Object.keys(cacheManager.readTurnState(goModuleDir).files)).toEqual(
				[],
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
					name === "lens-actionable-warning-autofix" || name === "no-lsp",
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

	it("publishes pilens:files:touched reason:\"format\" for deferred-format changed files (#482)", async () => {
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

	it("includes fix-provenance entries (kind:\"format\") for deferred-format changed files (#502)", async () => {
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

	it("includes fix-provenance entries (tool:\"lsp-quickfix\", kind:\"autofix\") for actionable-warning autofix changed files (#502)", async () => {
		const env = setupTestEnvironment("pi-lens-agent-end-aw-fixes-");
		try {
			const filePath = createTempFile(env.tmpDir, "src/app.ts", "const x = 1;\n");
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
					getFormatService: () =>
						({ recordRead: () => {}, formatFile }) as any,
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
					getFlag: (name) =>
						name === "no-lsp" || name === "lens-turn-summary",
					notify: vi.fn(),
					dbg: () => {},
					runtime,
					cacheManager: { addModifiedRange: () => {} } as any,
					getFormatService: () =>
						({ recordRead: () => {}, formatFile }) as any,
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
					getFlag: (name) =>
						name === "no-lsp" || name === "lens-turn-summary",
					notify,
					dbg: () => {},
					runtime,
					cacheManager: { addModifiedRange: () => {} } as any,
					getFormatService: () =>
						({ recordRead: () => {}, formatFile }) as any,
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
