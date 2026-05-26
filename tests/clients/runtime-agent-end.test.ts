import * as fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import * as path from "node:path";
import type { ActionableWarningsReport } from "../../clients/actionable-warnings.js";
import { readChangesSince } from "../../clients/project-changes.js";
import { handleAgentEnd } from "../../clients/runtime-agent-end.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

describe("runtime-agent-end deferred formatting", () => {
	it("formats each queued file once, clears the queue, and records a format change", async () => {
		const env = setupTestEnvironment("pi-lens-agent-end-format-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const filePath = createTempFile(env.tmpDir, "src/app.ts", "const x=1");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.deferFormat(filePath, env.tmpDir, "edit");
			runtime.deferFormat(filePath, env.tmpDir, "write");

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
			runtime.deferFormat(file1, env.tmpDir, "edit");
			runtime.deferFormat(file2, env.tmpDir, "edit");
			runtime.deferFormat(file3, env.tmpDir, "edit");

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
			runtime.deferFormat(filePath, env.tmpDir, "edit");
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
});
