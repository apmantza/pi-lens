import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AstGrepClient } from "../../clients/ast-grep-client.js";
import { CacheManager } from "../../clients/cache-manager.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import {
	type LspMutationContext,
	recordLspMutation,
} from "../../clients/lsp-mutation.js";
import {
	getMutationBridge,
	registerMutationBridge,
} from "../../clients/mutation-bridge.js";
import { countFileLines } from "../../clients/read-guard-tool-lines.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { handleToolCall } from "../../clients/runtime-tool-call.js";
import type { TreeSitterClient } from "../../clients/tree-sitter-client.js";
import { createLensDiagnosticMarkTool } from "../../tools/lens-diagnostic-mark.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";
import { installLspServiceDouble } from "../support/lsp-service-seam.js";
import { runHandlerExpectingNoThrow } from "../support/handler-verdict.js";

// handleToolCall calls getLSPService() directly (not via DI, matching the
// pattern already used by runtime-session.ts). Stub it so tests never spin up
// a real LSP client — auto-touch is best-effort/fire-and-forget so a stub
// touchFile that resolves immediately is enough to observe its call args.
const touchFileMock = vi.fn().mockResolvedValue(undefined);
const getWarmClientForFileMock = vi.fn().mockResolvedValue(undefined);
beforeEach(async () => {
	await installLspServiceDouble({
		touchFile: touchFileMock,
		getWarmClientForFile: getWarmClientForFileMock,
	});
});

vi.mock("../../clients/bootstrap.js", async () => {
	const { bootstrapSeamMock } = await import("../support/bootstrap-mock.js");
	return bootstrapSeamMock(async () => ({
		complexityClient: {
			isSupportedFile: () => false,
			analyzeFile: async () => null,
		},
		biomeClient: {},
		ruffClient: {},
		metricsClient: {},
		agentBehaviorClient: { recordToolCall: () => [], formatWarnings: () => "" },
	}));
});

// #2402/#5120: a partial apply's tool_result runs handleToolResult, whose
// dispatch pipeline is a real subprocess surface. The mock keeps the test at
// the contract seam (post-edit analysis succeeded/failed) without spawning
// formatters or runners; runPipeline's isError is exactly what the
// tool_result reads to classify postEditStatus.
const runPipelineMock = vi.hoisted(() => vi.fn());
vi.mock("../../clients/pipeline.js", () => ({
	runPipeline: runPipelineMock,
}));

// The read-guard log is a file sink that test mode silences; capture its rows
// at the emit seam, passing every other export through.
const readGuardRows = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock("../../clients/read-guard-logger.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/read-guard-logger.js")>();
	return {
		...actual,
		logReadGuardEvent: (entry: Record<string, unknown>) => {
			readGuardRows.push(entry);
		},
	};
});

function mockPipelineSucceeds(output = ""): void {
	runPipelineMock.mockResolvedValue({
		output,
		hasBlockers: false,
		isError: false,
		fileModified: false,
	});
}

function mockPipelineFails(output = "post-edit pipeline blocked"): void {
	runPipelineMock.mockResolvedValue({
		output,
		hasBlockers: true,
		isError: true,
		fileModified: false,
	});
}

function baseDeps(
	overrides: Partial<Parameters<typeof handleToolCall>[0]> = {},
) {
	const runtime = new RuntimeCoordinator();
	return {
		event: { toolName: "read", input: {} },
		ctx: {},
		lensEnabled: true,
		getFlag: () => false,
		dbg: () => {},
		runtime,
		cacheManager: new CacheManager(false),
		ensureLSPConfigInitialized: async () => {},
		updateLspStatus: () => {},
		resetLSPService: () => {},
		...overrides,
	} as Parameters<typeof handleToolCall>[0];
}

describe("handleToolCall", () => {
	it("retires owned in-process authorship at tool_call (#4187 R4)", async () => {
		for (const [toolName, inputFor] of [
			[
				"ast_grep_replace",
				(filePath: string) => ({ apply: true, paths: [filePath] }),
			],
			[
				"lens_diagnostic_mark",
				(filePath: string) => ({ filePath, disposition: "suppress" }),
			],
			[
				"lsp_navigation",
				(filePath: string) => ({ path: filePath, operation: "rename" }),
			],
		] as const) {
			const env = setupTestEnvironment(`pi-lens-4187-owned-${toolName}-`);
			try {
				const filePath = createTempFile(
					env.tmpDir,
					"authored.ts",
					"const a = 1;\n",
				);
				const runtime = new RuntimeCoordinator();
				runtime.projectRoot = env.tmpDir;
				runtime.readGuard.recordWritten(filePath, {
					stampFileTime: false,
					toolCallId: "call-4187-bash",
				});
				fs.writeFileSync(filePath, "const external = 1;\n");
				await runHandlerExpectingNoThrow(() =>
					handleToolCall(
						baseDeps({
							runtime,
							ctx: { cwd: env.tmpDir },
							event: { toolName, input: inputFor(filePath) },
						}),
					),
				);
				fs.writeFileSync(filePath, "const owned = 1;\n");
				runtime.readGuard.recordWritten(filePath, {
					stampFileTime: false,
					advanceAuthorship: true,
				});
				expect(runtime.readGuard.checkEdit(filePath, [1, 1]).action).toBe(
					"block",
				);
			} finally {
				env.cleanup();
			}
		}
	});

	it("does not collect a complexity baseline when disabled", async () => {
		resetDegradationLedger();
		const env = setupTestEnvironment("pi-lens-runtime-tool-call-complexity-");
		try {
			const filePath = createTempFile(
				env.tmpDir,
				"src/disabled.ts",
				"const x = 1;\n",
			);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			await runHandlerExpectingNoThrow(() =>
				handleToolCall(
					baseDeps({
						runtime,
						getFlag: (name) => name === "no-complexity",
						event: { toolName: "read", input: { filePath } },
					}),
				),
			);
			expect(runtime.complexityBaselines.has(filePath)).toBe(false);
			expect(
				getDegradationSummary().some(
					(entry) => entry.kind === "startup-analyzer-disabled",
				),
			).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("judges the commit gate's record as the session that runs the commit (#4921)", async () => {
		// RECURRENCE GUARDED: #4921. The gate compared the record's owner with
		// the coordinator's id, so a subagent's commit was refused with
		// `session_mismatch` over a record only it owns, whose file is gone.
		const env = setupTestEnvironment("pi-lens-4921-gate-session-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setTelemetryIdentity({ sessionId: "session-4921-primary" });
			const cacheManager = new CacheManager(false);
			const gone = path.join(env.tmpDir, "gone.ts");
			cacheManager.writeCache(
				"turn-end-findings",
				{
					content: "blocker",
					hasBlockers: true,
					affectedFiles: [gone],
					sessionId: "session-4921-subagent",
					projectSeqStart: 0,
					projectSeqEnd: 0,
					fileSeqByPath: { [gone.replace(/\\/g, "/")]: 0 },
					fileContentHashes: {},
				},
				env.tmpDir,
			);
			const commit = (sessionId: string) =>
				runHandlerExpectingNoThrow(() =>
					handleToolCall(
						baseDeps({
							runtime,
							cacheManager,
							sessionId,
							ctx: { cwd: env.tmpDir },
							getFlag: (name) => name === "lens-guard",
							event: {
								toolName: "bash",
								input: { command: "git commit -m x" },
							},
						}),
					),
				);
			expect(await commit("session-4921-subagent")).toBeUndefined();
			expect(await commit("session-4921-primary")).toMatchObject({
				block: true,
				reason: expect.stringContaining("session_mismatch"),
			});
		} finally {
			env.cleanup();
		}
	});

	it("does not let heredoc body words trigger the real git guard", async () => {
		const env = setupTestEnvironment("pi-lens-2726-heredoc-guard-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setTelemetryIdentity({ sessionId: "session-2726" });
			runtime.updateGitGuardStatus(true, "existing blocker");
			const result = await runHandlerExpectingNoThrow(() =>
				handleToolCall(
					baseDeps({
						runtime,
						ctx: { cwd: env.tmpDir },
						getFlag: (name) => name === "lens-guard",
						event: {
							toolName: "bash",
							input: {
								command: "cat <<EOF\nbody text: git push\nEOF\n",
							},
						},
					}),
				),
			);
			expect(result).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});

	it("does not block a command after a heredoc delimiter metacharacter", async () => {
		const env = setupTestEnvironment("pi-lens-2726-heredoc-operator-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setTelemetryIdentity({ sessionId: "session-2726-operator" });
			runtime.updateGitGuardStatus(true, "existing blocker");
			const result = await runHandlerExpectingNoThrow(() =>
				handleToolCall(
					baseDeps({
						runtime,
						ctx: { cwd: env.tmpDir },
						getFlag: (name) => name === "lens-guard",
						event: {
							toolName: "bash",
							input: { command: "cat <<EOF; echo git push\nbody\nEOF" },
						},
					}),
				),
			);
			expect(result).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});

	it("still blocks a git command after a heredoc body", async () => {
		const env = setupTestEnvironment("pi-lens-2726-heredoc-git-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setTelemetryIdentity({ sessionId: "session-2726-git" });
			runtime.updateGitGuardStatus(true, "existing blocker");
			const result = await runHandlerExpectingNoThrow(() =>
				handleToolCall(
					baseDeps({
						runtime,
						ctx: { cwd: env.tmpDir },
						getFlag: (name) => name === "lens-guard",
						event: {
							toolName: "bash",
							input: { command: "cat <<EOF; git push\nbody\nEOF" },
						},
					}),
				),
			);
			expect(result).toMatchObject({ block: expect.anything() });
		} finally {
			env.cleanup();
		}
	});
	it("is a no-op when lensEnabled is false", async () => {
		const runtime = new RuntimeCoordinator();
		const recordRead = vi.spyOn(runtime.readGuard, "recordRead");
		const result = await runHandlerExpectingNoThrow(() =>
			handleToolCall(
				baseDeps({
					lensEnabled: false,
					runtime,
					event: { toolName: "read", input: { path: "/does/not/matter" } },
				}),
			),
		);
		expect(result).toBeUndefined();
		expect(recordRead).not.toHaveBeenCalled();
	});

	it("registers the resolved native read path before the host returns it and LSP-warms it", async () => {
		touchFileMock.mockClear();
		const env = setupTestEnvironment("pi-lens-runtime-tool-call-read-");
		try {
			const filePath = createTempFile(
				env.tmpDir,
				"src/a.ts",
				"line1\nline2\nline3\n",
			);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			const recordRead = vi.spyOn(runtime.readGuard, "recordRead");

			await runHandlerExpectingNoThrow(() =>
				handleToolCall(
					baseDeps({
						runtime,
						event: {
							toolName: "read",
							toolCallId: "read-call",
							parentToolCallId: "codemode-call",
							input: { path: filePath },
						},
						ctx: { cwd: env.tmpDir },
					}),
				),
			);

			// The provisional record is keyed by the call's own identity for the
			// tool_result that supersedes it, and carries no transcript identity:
			// it showed the agent nothing yet, so no branch move may keep it
			// (#4185 round 1 F1: with `toolCallId` here, a read that errored
			// licensed an edit after /clone).
			expect(recordRead).toHaveBeenCalledWith(
				expect.objectContaining({
					filePath,
					effectiveOffset: 1,
					provisional: true,
					source: "native-read:read-call:provisional",
				}),
				// #1649: the handler's one pass is the capture; the guard takes none.
				{ captureLineHashes: false },
			);
			expect(recordRead.mock.calls[0]?.[0]).not.toHaveProperty("toolCallId");
			expect(touchFileMock).toHaveBeenCalled();
			// #3481 round 1: the auto-touch says when it read the file, so the
			// notify queue can order it against the other reads of that file.
			expect(touchFileMock.mock.calls.at(-1)?.[2]).toEqual(
				expect.objectContaining({ readStamp: expect.any(Number) }),
			);
		} finally {
			env.cleanup();
		}
	});

	it("uses the shared tree-sitter client for partial-read expansion", async () => {
		const env = setupTestEnvironment("pi-lens-runtime-tool-call-expansion-");
		try {
			const filePath = createTempFile(
				env.tmpDir,
				"src/expand.ts",
				"function outer() {\n\treturn 1;\n}\n",
			);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			const init = vi.fn().mockResolvedValue(false);
			const client = { init } as unknown as TreeSitterClient;
			const getTreeSitterClient = vi.fn(() => client);

			await runHandlerExpectingNoThrow(() =>
				handleToolCall(
					baseDeps({
						runtime,
						event: {
							toolName: "read",
							input: { path: filePath, offset: 2, limit: 1 },
						},
						ctx: { cwd: env.tmpDir },
						getTreeSitterClient,
					}),
				),
			);

			expect(getTreeSitterClient).toHaveBeenCalledTimes(1);
			expect(init).toHaveBeenCalledTimes(1);
		} finally {
			env.cleanup();
		}
	});

	it("skips partial-read expansion when the shared runtime is poisoned", async () => {
		const env = setupTestEnvironment("pi-lens-runtime-tool-call-poisoned-");
		try {
			const filePath = createTempFile(
				env.tmpDir,
				"src/poisoned.ts",
				"function outer() {\n\treturn 1;\n}\n",
			);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			const getTreeSitterClient = vi.fn(() => null);

			await runHandlerExpectingNoThrow(() =>
				handleToolCall(
					baseDeps({
						runtime,
						event: {
							toolName: "read",
							input: { path: filePath, offset: 2, limit: 1 },
						},
						ctx: { cwd: env.tmpDir },
						getTreeSitterClient,
					}),
				),
			);

			expect(getTreeSitterClient).toHaveBeenCalledTimes(1);
		} finally {
			env.cleanup();
		}
	});

	it("blocks an edit on an existing file that was never read (zero_read)", async () => {
		const env = setupTestEnvironment("pi-lens-runtime-tool-call-edit-");
		try {
			const filePath = createTempFile(
				env.tmpDir,
				"src/b.ts",
				"function foo() {\n\treturn 1;\n}\n",
			);
			const beforeSession = new Date(Date.now() - 1000);
			fs.utimesSync(filePath, beforeSession, beforeSession);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;

			const result = await runHandlerExpectingNoThrow(() =>
				handleToolCall(
					baseDeps({
						runtime,
						ctx: { cwd: env.tmpDir },
						event: {
							toolName: "edit",
							input: {
								path: filePath,
								oldText: "function foo() {\n\treturn 1;\n}",
								newText: "function foo() {\n\treturn 2;\n}",
							},
						},
					}),
				),
			);

			expect(result).toMatchObject({ block: true });
		} finally {
			env.cleanup();
		}
	});

	it("blocks a zero-read edit after another writer rewrote the file mid-session, and injects no read (#3520)", async () => {
		const env = setupTestEnvironment("pi-lens-runtime-tool-call-foreign-");
		try {
			const filePath = createTempFile(
				env.tmpDir,
				"src/foreign.ts",
				"function foo() {\n\treturn 1;\n}\n",
			);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			const guard = runtime.readGuard;
			// An external editor or git writes it after the guard exists; pi-lens
			// observed nothing, so there is no recordWritten.
			fs.writeFileSync(filePath, "function foo() {\n\treturn 7;\n}\n");
			const later = new Date(Date.now() + 60_000);
			fs.utimesSync(filePath, later, later);

			const result = await runHandlerExpectingNoThrow(() =>
				handleToolCall(
					baseDeps({
						runtime,
						ctx: { cwd: env.tmpDir },
						event: {
							toolName: "edit",
							input: {
								path: filePath,
								oldText: "return 7;",
								newText: "return 8;",
							},
						},
					}),
				),
			);

			expect(result).toMatchObject({ block: true });
			expect((result as { reason: string }).reason).toContain(
				"Edit without read",
			);
			expect(guard.getReadHistory(filePath)).toEqual([]);
		} finally {
			env.cleanup();
		}
	});

	it("does not block a write, and lets a subsequent edit through once read-guard sees the write", async () => {
		const env = setupTestEnvironment("pi-lens-runtime-tool-call-write-");
		try {
			const filePath = path.join(env.tmpDir, "src", "c.ts");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;

			// noteCreatedFile only prevents a *future* zero_read block if the file
			// exists on disk by the time the write's tool_call fires (the write
			// tool creates the file itself; here we simulate that by writing it
			// before invoking tool_call, matching how the pipeline actually runs).
			createTempFile(env.tmpDir, "src/c.ts", "export const x = 1;\n");

			const result = await runHandlerExpectingNoThrow(() =>
				handleToolCall(
					baseDeps({
						runtime,
						ctx: { cwd: env.tmpDir },
						event: {
							toolName: "write",
							input: { path: filePath, content: "export const x = 1;\n" },
						},
					}),
				),
			);

			expect(result).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});

	it("blocks a write that redefines an export cached from another file", async () => {
		const env = setupTestEnvironment("pi-lens-runtime-tool-call-dupe-");
		try {
			const otherFile = createTempFile(
				env.tmpDir,
				"src/original.ts",
				"export function shared() {}\n",
			);
			const targetFile = createTempFile(
				env.tmpDir,
				"src/dupe.ts",
				"export const y = 1;\n",
			);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.cachedExports.set("shared", otherFile);

			const result = await runHandlerExpectingNoThrow(() =>
				handleToolCall(
					baseDeps({
						runtime,
						ctx: { cwd: env.tmpDir },
						event: {
							toolName: "write",
							input: {
								path: targetFile,
								content: "export function shared() {}\n",
							},
						},
					}),
				),
			);

			expect(result).toMatchObject({ block: true });
			expect((result as { reason: string }).reason).toContain("shared");
		} finally {
			env.cleanup();
		}
	});
});

// ── #2402 / #5120: mixed-validity preflight → partial apply contract ────────
// Drives the REAL handleToolCall and handleToolResult around pi's own native
// edit tool (`createEditTool`), with only the process boundary mocked
// (runPipeline). tool_call rewrites the batch to its matched subset (#5120),
// the host edit writes it, and tool_result reports the partial apply.
describe("#2402 partial-apply contract (mixed-validity preflight)", () => {
	// The canonical #2402 batch: edits[0] is valid and oldText is contained in
	// its own newText (an extended import line); edits[1] genuinely misses.
	function mixedBatchEvent(filePath: string, toolCallId = "call-partial") {
		return {
			toolName: "edit",
			toolCallId,
			input: {
				path: filePath,
				edits: [
					{
						oldText: "import { A } from 'm';",
						newText: "import { A } from 'm';\nimport { B } from 'm';",
					},
					{ oldText: "function gone() {}", newText: "noop" },
				],
			},
		};
	}

	/** The read an edit needs: the whole file, as a native read records it. */
	function readWhole(runtime: RuntimeCoordinator, filePath: string): void {
		const lines = fs.readFileSync(filePath, "utf8").split("\n").length;
		runtime.readGuard.recordRead({
			filePath,
			requestedOffset: 1,
			requestedLimit: lines,
			effectiveOffset: 1,
			effectiveLimit: lines,
			expandedByLsp: false,
			turnIndex: runtime.turnIndex,
			writeIndex: 0,
			timestamp: Date.now(),
		});
	}

	/**
	 * pi's own edit tool runs the args the tool_call handlers left, and pi
	 * turns a throw into an error result (agent-loop's
	 * `executePreparedToolCall`). The real host code, at the host boundary.
	 */
	async function hostEdit(
		cwd: string,
		event: { toolCallId: string; input: unknown },
	): Promise<{
		content: Array<{ type: string; text?: string }>;
		details?: unknown;
		isError: boolean;
	}> {
		const { createEditTool } = await import("@earendil-works/pi-coding-agent");
		try {
			const result = await createEditTool(cwd).execute(
				event.toolCallId,
				event.input as never,
			);
			return {
				content: result.content as Array<{ type: string; text?: string }>,
				details: result.details,
				isError: false,
			};
		} catch (error) {
			return {
				content: [{ type: "text", text: (error as Error).message }],
				isError: true,
			};
		}
	}

	async function toolResult(
		runtime: RuntimeCoordinator,
		event: { toolName: string; toolCallId: string; input: unknown },
		host: Awaited<ReturnType<typeof hostEdit>>,
	) {
		const { handleToolResult } =
			await import("../../clients/runtime-tool-result.js");
		return handleToolResult({
			event: { ...event, ...host },
			getFlag: () => false,
			dbg: () => {},
			runtime,
			readGuard: runtime.readGuard,
			cacheManager: new CacheManager(false),
			biomeClient: {},
			ruffClient: {},
			metricsClient: {},
			resetLSPService: () => {},
			agentBehaviorRecord: () => [],
			formatBehaviorWarnings: () => "",
		} as never);
	}

	/** One partial apply the way pi runs it: tool_call, host edit, tool_result. */
	async function partialApply(
		env: { tmpDir: string },
		runtime: RuntimeCoordinator,
		event: { toolName: string; toolCallId: string; input: unknown },
		beforeHost?: () => void,
	) {
		const call = await runHandlerExpectingNoThrow(() =>
			handleToolCall(baseDeps({ runtime, ctx: { cwd: env.tmpDir }, event })),
		);
		beforeHost?.();
		const host = await hostEdit(env.tmpDir, event);
		const result = await toolResult(runtime, event, host);
		const text = (result?.content ?? [])
			.map((part) => part.text ?? "")
			.join("\n");
		return { call, host, result, text };
	}

	it("rewrites a mixed batch to its matched subset and writes nothing from tool_call", async () => {
		// RECURRENCE GUARDED: #5120. The direct write landed before any later
		// tool_call handler could refuse it.
		const env = setupTestEnvironment("pi-lens-5120-rewrite-");
		try {
			mockPipelineSucceeds();
			const original = "import { A } from 'm';\nconst tail = 1;\n";
			const filePath = createTempFile(env.tmpDir, "src/first.ts", original);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			readWhole(runtime, filePath);
			const event = mixedBatchEvent(filePath);

			const call = await runHandlerExpectingNoThrow(() =>
				handleToolCall(baseDeps({ runtime, ctx: { cwd: env.tmpDir }, event })),
			);

			expect(call).toBeUndefined();
			expect(event.input.edits).toEqual([
				{
					oldText: "import { A } from 'm';",
					newText: "import { A } from 'm';\nimport { B } from 'm';",
				},
			]);
			expect(fs.readFileSync(filePath, "utf-8")).toBe(original);
		} finally {
			env.cleanup();
		}
	});

	it("reports PARTIAL APPLY at tool_result once the host edit wrote the subset", async () => {
		const env = setupTestEnvironment("pi-lens-2402-first-");
		try {
			mockPipelineSucceeds("post-edit analysis ok");
			const filePath = createTempFile(
				env.tmpDir,
				"src/first.ts",
				"import { A } from 'm';\nconst tail = 1;\n",
			);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			readWhole(runtime, filePath);

			const { result, text } = await partialApply(
				env,
				runtime,
				mixedBatchEvent(filePath),
			);

			expect(result?.isError).toBe(true);
			expect(
				text.startsWith("⚠️ PARTIAL APPLY — 1 edit committed (edits[0])"),
			).toBe(true);
			expect(text).toContain('edits[1].oldText ("function gone() {}")');
			expect(text).toContain("post-edit analysis ok");
			expect(text).not.toContain("RETRYABLE");
			expect(fs.readFileSync(filePath, "utf-8")).toBe(
				"import { A } from 'm';\nimport { B } from 'm';\nconst tail = 1;\n",
			);
		} finally {
			env.cleanup();
		}
	});

	it("hands the host edit the raw span a normalization tier matched", async () => {
		// #1053: the bytes replaced are the span the preflight approved, never a
		// re-search of the agent's normalized text: the file has an en dash and
		// trailing spaces the agent's oldText does not.
		const env = setupTestEnvironment("pi-lens-2402-normalized-");
		try {
			mockPipelineSucceeds("post-edit analysis ok");
			const filePath = createTempFile(
				env.tmpDir,
				"src/normalized.ts",
				"const total = a–b;   \nconst tail = 1;\n",
			);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			readWhole(runtime, filePath);
			const event = {
				toolName: "edit",
				toolCallId: "call-normalized",
				input: {
					path: filePath,
					edits: [
						{ oldText: "const total = a-b;", newText: "const total = a+b;" },
						{ oldText: "const missing = true;", newText: "noop" },
					],
				},
			};

			const { host } = await partialApply(env, runtime, event);

			expect(event.input.edits[0]?.oldText).toBe("const total = a–b;   ");
			expect(host.isError).toBe(false);
			expect(fs.readFileSync(filePath, "utf8")).toBe(
				"const total = a+b;\nconst tail = 1;\n",
			);

			// #2402: the applied record is keyed by the pair the agent sent, not
			// the span bytes the host received, so resending the same batch is
			// recognised as applied rather than reported as an oldText miss.
			const retry = await runHandlerExpectingNoThrow(() =>
				handleToolCall(
					baseDeps({
						runtime,
						ctx: { cwd: env.tmpDir },
						event: {
							toolName: "edit",
							toolCallId: "call-normalized-retry",
							input: {
								path: filePath,
								edits: [
									{
										oldText: "const total = a-b;",
										newText: "const total = a+b;",
									},
									{ oldText: "const missing = true;", newText: "noop" },
								],
							},
						},
					}),
				),
			);
			const reason = (retry as { reason: string }).reason;
			expect(reason).toContain("edits[0] was already applied");
			expect(reason).not.toMatch(/edits\[0\]\.oldText/);
		} finally {
			env.cleanup();
		}
	});

	it("keeps CRLF, a BOM and a lone CR file's endings through the host edit", async () => {
		// #1053's line-ending guarantees, now the host edit's: the rewritten
		// oldText is the span's LF view, which the host matches after its own
		// normalization and writes back in the file's endings.
		for (const [name, raw, expected] of [
			[
				"crlf",
				"const a = 1;\r\nconst b = 2;\r\n",
				"const a = 1;\r\nconst b = 20;\r\n",
			],
			[
				"bom",
				"\uFEFFconst a = 1;\nconst b = 2;\n",
				"\uFEFFconst a = 1;\nconst b = 20;\n",
			],
		] as const) {
			const env = setupTestEnvironment(`pi-lens-5120-endings-${name}-`);
			try {
				mockPipelineSucceeds();
				const filePath = createTempFile(env.tmpDir, `src/${name}.ts`, raw);
				const runtime = new RuntimeCoordinator();
				runtime.projectRoot = env.tmpDir;
				readWhole(runtime, filePath);
				const { text } = await partialApply(env, runtime, {
					toolName: "edit",
					toolCallId: `call-${name}`,
					input: {
						path: filePath,
						edits: [
							{ oldText: "const b = 2;", newText: "const b = 20;" },
							{ oldText: "missing line", newText: "noop" },
						],
					},
				});
				expect(text).toMatch(/^⚠️ PARTIAL APPLY/);
				expect(fs.readFileSync(filePath, "utf8")).toBe(expected);
			} finally {
				env.cleanup();
			}
		}
	});

	it("labels committed partial-apply bytes as applied even when post-edit analysis fails", async () => {
		const env = setupTestEnvironment("pi-lens-2402-committed-");
		try {
			mockPipelineFails();
			const filePath = createTempFile(
				env.tmpDir,
				"src/committed.ts",
				"import { A } from 'm';\nconst tail = 1;\n",
			);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			readWhole(runtime, filePath);

			const { result, text } = await partialApply(
				env,
				runtime,
				mixedBatchEvent(filePath),
			);

			// The bytes are on disk; the message must lead with that fact and must
			// never relabel them as a retryable oldText miss.
			expect(result?.isError).toBe(true);
			expect(text.startsWith("⚠️ PARTIAL APPLY")).toBe(true);
			expect(text).not.toContain("RETRYABLE");
			expect(text).toContain("committed bytes stand");
			expect(fs.readFileSync(filePath, "utf-8")).toContain(
				"import { B } from 'm';",
			);
		} finally {
			env.cleanup();
		}
	});

	it("keeps the preflight verdict and writes nothing when the host edit refuses the subset", async () => {
		// #5120: the snapshot check before the write is now the host edit's own
		// re-match. A file that changed after tool_call fails it, closed: no
		// bytes, and the agent still gets the whole batch's verdict.
		const env = setupTestEnvironment("pi-lens-5120-host-refused-");
		try {
			mockPipelineSucceeds();
			const filePath = createTempFile(
				env.tmpDir,
				"src/refused.ts",
				"import { A } from 'm';\nconst tail = 1;\n",
			);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			readWhole(runtime, filePath);
			const changed = "import { C } from 'm';\nconst tail = 1;\n";

			const { host, result, text } = await partialApply(
				env,
				runtime,
				mixedBatchEvent(filePath),
				() => fs.writeFileSync(filePath, changed),
			);

			expect(host.isError).toBe(true);
			expect(result?.isError).toBe(true);
			expect(text).toMatch(/^🔄 RETRYABLE/);
			expect(text).toContain('edits[1].oldText ("function gone() {}")');
			expect(text).toContain("Batch not applied");
			expect(text).not.toContain("PARTIAL APPLY");
			expect(fs.readFileSync(filePath, "utf-8")).toBe(changed);
		} finally {
			env.cleanup();
		}
	});

	it("blocks a mixed batch with the whole verdict when the call has no id", async () => {
		// No id, no tool_result to report the partial apply in: the batch fails
		// whole, as the host edit would fail it, and the input is left alone.
		const env = setupTestEnvironment("pi-lens-5120-no-id-");
		try {
			const original = "import { A } from 'm';\nconst tail = 1;\n";
			const filePath = createTempFile(env.tmpDir, "src/no-id.ts", original);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			readWhole(runtime, filePath);
			const { toolCallId: _id, ...event } = mixedBatchEvent(filePath);

			const call = await runHandlerExpectingNoThrow(() =>
				handleToolCall(baseDeps({ runtime, ctx: { cwd: env.tmpDir }, event })),
			);

			expect(call).toMatchObject({ block: true });
			expect((call as { reason: string }).reason).toMatch(/^🔄 RETRYABLE/);
			expect(event.input.edits).toHaveLength(2);
			expect(fs.readFileSync(filePath, "utf-8")).toBe(original);
		} finally {
			env.cleanup();
		}
	});

	it("drops the partial apply with the call when pi-lens's own read guard refuses the subset", async () => {
		// The rewritten subset is an ordinary edit, so pi-lens's own checks
		// judge it; a refusal there leaves no record for a later tool_result.
		const env = setupTestEnvironment("pi-lens-5120-own-block-");
		try {
			const filePath = createTempFile(
				env.tmpDir,
				"src/unread.ts",
				"import { A } from 'm';\nconst tail = 1;\n",
			);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			const event = mixedBatchEvent(filePath, "call-unread");

			const call = await runHandlerExpectingNoThrow(() =>
				handleToolCall(baseDeps({ runtime, ctx: { cwd: env.tmpDir }, event })),
			);

			expect(call).toMatchObject({ block: true });
			expect((call as { reason: string }).reason).toContain(
				"Edit without read",
			);
			expect(runtime.takeToolCallPartialApply("call-unread")).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});

	it("recognizes an exact retry of an already-applied edit instead of re-applying it", async () => {
		const env = setupTestEnvironment("pi-lens-2402-retry-");
		try {
			mockPipelineSucceeds("post-edit analysis ok");
			const filePath = createTempFile(
				env.tmpDir,
				"src/retry.ts",
				"import { A } from 'm';\nconst tail = 1;\n",
			);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			readWhole(runtime, filePath);

			await partialApply(env, runtime, mixedBatchEvent(filePath, "call-first"));
			const afterFirst = fs.readFileSync(filePath, "utf-8");
			expect(afterFirst).toBe(
				"import { A } from 'm';\nimport { B } from 'm';\nconst tail = 1;\n",
			);

			// Identical retry: edits[0]'s oldText still occurs exactly once
			// (inside its own applied newText). The retry must recognize the
			// applied record, not re-execute the write.
			const retry = await runHandlerExpectingNoThrow(() =>
				handleToolCall(
					baseDeps({
						runtime,
						ctx: { cwd: env.tmpDir },
						event: mixedBatchEvent(filePath, "call-retry"),
					}),
				),
			);

			expect(retry).toMatchObject({ block: true });
			// Duplication is the #2402 defect: the file must be byte-identical.
			expect(fs.readFileSync(filePath, "utf-8")).toBe(afterFirst);
			const reason = (retry as { reason: string }).reason;
			expect(reason).toContain("already applied");
			// edits[0] is never reported as an oldText miss: the applied record
			// resolves it before the failure ladder runs.
			expect(reason).not.toMatch(/edits\[0\]\.oldText/);
		} finally {
			env.cleanup();
		}
	});

	it("answers an exact retry of a fully-applied edit with an already-applied verdict", async () => {
		const env = setupTestEnvironment("pi-lens-2402-full-retry-");
		try {
			mockPipelineSucceeds();
			const filePath = createTempFile(
				env.tmpDir,
				"src/full-retry.ts",
				"const a = 1;\nconst b = 2;\n",
			);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			const editEvent = {
				toolName: "edit",
				input: {
					path: filePath,
					edits: [{ oldText: "const b = 2;", newText: "const b = 20;" }],
				},
			};

			// Simulate the host having applied the edit: write the result, then
			// run the real tool_result handler so the full-success record lands.
			fs.writeFileSync(filePath, "const a = 1;\nconst b = 20;\n");
			const { handleToolResult } =
				await import("../../clients/runtime-tool-result.js");
			await handleToolResult({
				event: {
					...editEvent,
					content: [],
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
			} as never);

			// Identical retry through the real tool_call path.
			const retry = await runHandlerExpectingNoThrow(() =>
				handleToolCall(
					baseDeps({ runtime, ctx: { cwd: env.tmpDir }, event: editEvent }),
				),
			);

			expect(retry).toMatchObject({ block: true });
			const reason = (retry as { reason: string }).reason;
			expect(reason.startsWith("✅ ALREADY APPLIED")).toBe(true);
			expect(reason).toContain("edits[0]");
			expect(reason).not.toMatch(/RETRYABLE|attempt #/);
			expect(fs.readFileSync(filePath, "utf-8")).toBe(
				"const a = 1;\nconst b = 20;\n",
			);
		} finally {
			env.cleanup();
		}
	});

	it("logs the batch summary over the agent's batch, with the edits that applied", async () => {
		// The executed batch is renumbered (the subset's edits[0] is the agent's
		// edits[1] here); the committed summary must still name the original
		// batch and the original index.
		const env = setupTestEnvironment("pi-lens-5120-summary-");
		try {
			mockPipelineSucceeds();
			const filePath = createTempFile(
				env.tmpDir,
				"src/summary.ts",
				"const a = 1;\nconst b = 2;\n",
			);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			readWhole(runtime, filePath);
			readGuardRows.length = 0;

			await partialApply(env, runtime, {
				toolName: "edit",
				toolCallId: "call-summary",
				input: {
					path: filePath,
					edits: [
						{ oldText: "function gone() {}", newText: "noop" },
						{ oldText: "const b = 2;", newText: "const b = 20;" },
					],
				},
			});

			const committed = readGuardRows
				.filter((row) => row.event === "edit_batch_summary")
				.map(
					(row) =>
						(row.metadata as { editBatchSummary: Record<string, unknown> })
							.editBatchSummary,
				)
				.filter((summary) => summary.commitStatus === "committed");
			expect(committed).toHaveLength(1);
			expect(committed[0]).toMatchObject({
				requestedTotal: 2,
				appliedIndexes: [1],
				appliedTotal: 1,
			});
		} finally {
			env.cleanup();
		}
	});

	it("keeps one mutation receipt, change-log entry, and read-guard stamp per partial apply", async () => {
		const env = setupTestEnvironment("pi-lens-2402-bookkeeping-");
		try {
			mockPipelineSucceeds("post-edit analysis ok");
			const filePath = createTempFile(
				env.tmpDir,
				"src/bookkeeping.ts",
				"const a = 1;\nconst b = 2;\n",
			);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			readWhole(runtime, filePath);
			const recordWritten = vi.spyOn(runtime.readGuard, "recordWritten");
			const seqBefore = runtime.projectSeq;

			await partialApply(env, runtime, {
				toolName: "edit",
				toolCallId: "call-bookkeeping",
				input: {
					path: filePath,
					edits: [
						{ oldText: "const b = 2;", newText: "const b = 20;" },
						{ oldText: "function gone() {}", newText: "noop" },
					],
				},
			});

			// One mutation: the host edit's write of the subset, attributed to
			// source `partial-apply` through the single mutation seam (#2000).
			const receipts = runtime.getMutationsSince(seqBefore);
			expect(receipts).toHaveLength(1);
			expect(receipts[0].source).toBe("partial-apply");
			expect(runtime.projectSeq).toBeGreaterThan(seqBefore);

			// The durable change log carries the same single entry.
			const { readProjectChanges } =
				await import("../../clients/project-changes.js");
			const entries = readProjectChanges(env.tmpDir).filter(
				(entry) => entry.filePath === filePath,
			);
			expect(entries).toHaveLength(1);
			expect(entries[0].source).toBe("partial-apply");

			// The host edit's tool_result credits the commit to the read guard as
			// for any oldText edit: its lines are not known, so the authorship is
			// `unknown`, never the whole file the synthetic write claimed before
			// #5120. The handler hands over the bytes it already hashed for the
			// authorship's content identity (#4131).
			expect(recordWritten).toHaveBeenCalledWith(
				filePath,
				expect.objectContaining({
					authorship: "unknown",
					contentHash: expect.stringMatching(/^[0-9a-f]{64}$/),
				}),
			);
		} finally {
			env.cleanup();
		}
	});
});

/**
 * Review round 4, finding F5. `clients/hashline-anchor.ts`'s per-file anchor
 * memo is keyed by `mtimeMs`+`size` alone. A rewrite that lands within one
 * mtime tick and does not change the file's byte length changes NEITHER key,
 * so a memo that survived across `tool_call`s could serve the PREVIOUS
 * content's anchor index to a `tool_call` that reads the file after it
 * changed. The fix drops the memo at the `tool_call` boundary
 * (`handleToolCallImpl` entry in `clients/runtime-tool-call.ts`), so this
 * drives `handleToolCall` itself — the reviewer's probe reproduces the
 * mtime+size collision exactly, then asserts on what `readGuard.checkEdit`
 * was actually told about the SECOND call, since that is what the guard and
 * `addModifiedRange` act on downstream.
 */
describe("#2423 review round 4 (F5) — the hashline anchor memo drops at the tool_call boundary", () => {
	it("does not resolve a rewritten file's line from a same-mtime, same-size stale memo", async () => {
		const env = setupTestEnvironment("pi-lens-2423-f5-anchor-memo-");
		try {
			const filePath = createTempFile(
				env.tmpDir,
				"src/memo.ts",
				"alpha\nbeta\ngamma\n",
			);
			// "alpha" -> "zebra": same byte length (5 ASCII chars), same total
			// file size, so the ONLY thing that could distinguish the two reads
			// is a genuine re-read, never mtime+size.
			const before = "alpha\nbeta\ngamma\n";
			const after = "zebra\nbeta\ngamma\n";
			expect(Buffer.byteLength(after)).toBe(Buffer.byteLength(before));
			const { computeHashlineAnchors } =
				await import("../../clients/hashline-anchor.js");
			const anchorForAlpha = computeHashlineAnchors(before)![0]!;
			// Pinned, not "now": two separate fs.writeFileSync calls landing on
			// the same wall-clock tick is exactly the scenario under test, and
			// asserting it via real timing would be flaky by construction.
			const pinnedMtime = new Date(2026, 0, 1, 12, 0, 0, 0);
			fs.utimesSync(filePath, pinnedMtime, pinnedMtime);
			const statBefore = fs.statSync(filePath);

			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			const checkEdit = vi.spyOn(runtime.readGuard, "checkEdit");
			const deps = baseDeps({
				runtime,
				ctx: { cwd: env.tmpDir },
			});

			// Call 1: warms `clients/hashline-anchor.ts`'s per-file memo against
			// `before`'s content (this is what makes the second call a proof of
			// the DROP, not just "the file happened to be read fresh once").
			await runHandlerExpectingNoThrow(() =>
				handleToolCall({
					...deps,
					event: {
						toolName: "replace",
						input: {
							path: filePath,
							remove_from: anchorForAlpha,
							remove_to: anchorForAlpha,
							replacement_lines: ["placeholder"],
						},
					},
				}),
			);
			expect(checkEdit).toHaveBeenCalledTimes(1);
			expect(checkEdit.mock.calls[0]![0]).toBe(filePath);
			expect(checkEdit.mock.calls[0]![1]).toEqual([1, 1]);

			// Rewrite with DIFFERENT content, IDENTICAL mtime and size.
			fs.writeFileSync(filePath, after, "utf8");
			fs.utimesSync(filePath, pinnedMtime, pinnedMtime);
			const statAfter = fs.statSync(filePath);
			expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs);
			expect(statAfter.size).toBe(statBefore.size);

			// Call 2 quotes the SAME anchor token. "alpha" no longer exists in
			// the file, so a genuine re-read must fail to resolve it — a memo
			// that survived from call 1 would instead answer `line: 1`
			// confidently, because that is exactly what it answered before.
			await runHandlerExpectingNoThrow(() =>
				handleToolCall({
					...deps,
					event: {
						toolName: "replace",
						input: {
							path: filePath,
							remove_from: anchorForAlpha,
							remove_to: anchorForAlpha,
							replacement_lines: ["placeholder"],
						},
					},
				}),
			);
			expect(checkEdit).toHaveBeenCalledTimes(2);
			expect(checkEdit.mock.calls[1]![0]).toBe(filePath);
			expect(checkEdit.mock.calls[1]![1]).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});
});

// #3052: the indent-autopatch bridge (handleToolCall -> tryCorrectIndentation-
// MismatchFromContent -> retargetReplacementIndentation) must not pick a
// block comment's alignment as the base nesting unit when it patches
// newText for a real "edit" tool call. Drives the actual production
// sequence end to end (no hand-rolled reimplementation of either function).
describe("#3052 indent autopatch does not retarget from a comment's alignment", () => {
	it("patches newText's deeper nesting from the code's own indent unit, not the JSDoc's", async () => {
		mockPipelineSucceeds();
		const env = setupTestEnvironment("pi-lens-3052-premise-");
		try {
			// The real file already has the corrected indentation: a 1-space
			// JSDoc continuation (comment ratio 1->2) and a 4-space code line
			// whose OWN ratio (4->3) differs from the comment's.
			const corrected = "/**\n  * doc\n  */\nfunction f() {\n   go();\n}\n";
			const filePath = createTempFile(env.tmpDir, "src/f.ts", corrected);
			// The model's oldText guess (mismatched vs. the real file) and a
			// newText whose second line nests one level deeper than anything
			// oldText showed the corrector.
			const oldText = "/**\n * doc\n */\nfunction f() {\n    go();\n}";
			const newText = "function g() {\n    a();\n        b();\n}";
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			const event = {
				toolName: "edit",
				input: { path: filePath, oldText, newText },
			};

			await runHandlerExpectingNoThrow(() =>
				handleToolCall(baseDeps({ runtime, ctx: { cwd: env.tmpDir }, event })),
			);

			// applyNewText patches event.input.newText in place (the host then
			// applies this replacement text) — assert the PATCHED value, the
			// same field production hands back to the caller.
			expect((event.input as { newText: string }).newText).toBe(
				"function g() {\n   a();\n      b();\n}",
			);
		} finally {
			env.cleanup();
		}
	});
});

// #3116: the same indent-autopatch bridge must not pick a multi-line
// template literal's interior alignment as the base nesting unit either
// (AGENTS.md defect 49, fifth member; #3052's own case for block comments).
// Drives the actual production sequence end to end (no hand-rolled
// reimplementation of retargetReplacementIndentation).
describe("#3116 indent autopatch does not retarget from a template literal's alignment", () => {
	it("patches newText's deeper nesting from the code's own indent unit, not the template's", async () => {
		mockPipelineSucceeds();
		const env = setupTestEnvironment("pi-lens-3116-premise-");
		try {
			// The real file already has the corrected indentation: a 1-space
			// template-literal interior (template ratio 1->2) and a 4-space code
			// line whose OWN ratio (4->3) differs from the template's.
			const corrected =
				"const HELP = `\n  text\n`;\nfunction f() {\n   go();\n}\n";
			const filePath = createTempFile(env.tmpDir, "src/f.ts", corrected);
			// The model's oldText guess (mismatched vs. the real file) and a
			// newText whose second line nests one level deeper than anything
			// oldText showed the corrector.
			const oldText = "const HELP = `\n text\n`;\nfunction f() {\n    go();\n}";
			const newText = "function g() {\n    a();\n        b();\n}";
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			const event = {
				toolName: "edit",
				input: { path: filePath, oldText, newText },
			};

			await runHandlerExpectingNoThrow(() =>
				handleToolCall(baseDeps({ runtime, ctx: { cwd: env.tmpDir }, event })),
			);

			// Pre-fix, this exact input patched `b();` to 16 literal spaces (the
			// template's 1-space unit doubled 8 times) instead of the
			// code-derived 6 — quoted in the PR body's premise transcript.
			expect((event.input as { newText: string }).newText).toBe(
				"function g() {\n   a();\n      b();\n}",
			);
		} finally {
			env.cleanup();
		}
	});
});

// #3116 review round 2, F1 probe (b): the same bridge must not mis-scale
// when the agent's oldText fragment crosses a template-literal boundary —
// here, from one template's closer, through real code, into a SECOND
// template's own interior line. Drives the actual production sequence (real
// file on disk, real handleToolCall -> tryCorrectIndentationMismatchFromContent
// -> retargetReplacementIndentation) so the fix is proven through the same
// matchNormalizedContent/findUniqueMatchLineRange wiring runtime-tool-call.ts
// uses, not a hand-fed fileContext.
describe("#3116 review round 2 — indent autopatch resolves a boundary-crossing fragment via the real file", () => {
	it("resolves the deeper newText line from the code's own ratio, not the second template's", async () => {
		mockPipelineSucceeds();
		const env = setupTestEnvironment("pi-lens-3116-r2-f1b-");
		try {
			// Real file: template A (interior "   p", 3sp), real code ("go();",
			// 2sp), template B (interior "   q", 3sp).
			const corrected =
				"const A = `\n   p\n`;\nfunction f() {\n  go();\n}\nconst B = `\n   q\n`;\n";
			const filePath = createTempFile(env.tmpDir, "src/f.ts", corrected);
			// The agent's oldText fragment starts at template A's CLOSER and ends
			// at template B's interior line — crossing straight through B's
			// opener. Both indentation-mismatched vs. the real file: "go();" at
			// 4sp (real: 2sp) and "q" at 2sp (real: 3sp).
			const oldText = "`;\nfunction f() {\n    go();\n}\nconst B = `\n  q";
			const newText = "function g() {\n    a();\n        b();\n}";
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			const event = {
				toolName: "edit",
				input: { path: filePath, oldText, newText },
			};

			await runHandlerExpectingNoThrow(() =>
				handleToolCall(baseDeps({ runtime, ctx: { cwd: env.tmpDir }, event })),
			);

			// A fragment-only lexer reads A's closer backtick as an opener and
			// B's opener backtick as a closer, wrongly excluding "go();"'s
			// indent from the base pick while wrongly leaving "q"'s indent
			// eligible — producing 12 literal spaces for `b();` (the template's
			// 2->3 ratio, scaled x4) instead of the code-derived 4 (its own
			// 4->2 ratio, halved twice). Reproduced directly against
			// retargetReplacementIndentation before this test was written (PR
			// body, F1 probe b transcript).
			expect((event.input as { newText: string }).newText).toBe(
				"function g() {\n  a();\n    b();\n}",
			);
		} finally {
			env.cleanup();
		}
	});
});

/**
 * #1193 P3: `shouldSkipLspAutoTouch` hand-rolled `.replace(/\\/g, "/")` — the
 * ~55th inline copy of the idiom `toPosix` exists to own. These cases drive the
 * real `handleToolCall` entry point and observe the seam through the LSP
 * double's `touchFile`, so the separator fold and the marker case-fold are each
 * pinned by an independent effect rather than by reading the source.
 *
 * The fold is behaviour-preserving by construction (`toPosix` IS the deleted
 * expression). On a POSIX host `path.resolve` already answers forward slashes,
 * so the separator case below is the ONLY one whose verdict the fold decides on
 * this lane — a Windows-shaped spelling reaching a POSIX host, which is the
 * cross-platform variant of the Windows-only property (AGENTS.md shape 35)
 * rather than a `skipIf(process.platform)` the ubuntu lane never runs.
 */
describe("LSP auto-touch skip path folding (#1193)", () => {
	async function touchedFor(relativePath: string): Promise<boolean> {
		touchFileMock.mockClear();
		const env = setupTestEnvironment("pi-lens-autotouch-fold-");
		try {
			const filePath = createTempFile(env.tmpDir, relativePath, "export {};\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			await runHandlerExpectingNoThrow(() =>
				handleToolCall(
					baseDeps({
						runtime,
						event: { toolName: "read", input: { path: filePath } },
						ctx: { cwd: env.tmpDir },
					}),
				),
			);
			return touchFileMock.mock.calls.length > 0;
		} finally {
			env.cleanup();
		}
	}

	it("auto-touches an ordinary source file", async () => {
		expect(await touchedFor("src/a.ts")).toBe(true);
	});

	it("skips an internal artifact under a forward-slash marker directory", async () => {
		expect(await touchedFor(".pi-lens/scratch.ts")).toBe(false);
	});

	it("skips an internal artifact whose marker segment is mis-cased", async () => {
		// The marker match is deliberately case-folded: on a case-insensitive
		// filesystem `.PI-Lens` and `.pi-lens` are ONE directory, and an
		// artifact under it must not be handed to the LSP either way.
		expect(await touchedFor(".PI-Lens/scratch.ts")).toBe(false);
	});

	it("skips an internal artifact whose marker separator is a backslash", async () => {
		// A Windows-shaped spelling arriving on a POSIX host, where a backslash
		// is an ordinary filename character: only the separator fold turns
		// `<tmp>/.pi-lens\\scratch.ts` into a path containing `/.pi-lens/`.
		// This is the one case on this lane whose verdict `toPosix` decides.
		expect(await touchedFor(".pi-lens\\scratch.ts")).toBe(false);
	});

	it("does not skip a non-path sentinel basename outside its marker directory", async () => {
		// `case.json` is only an internal artifact under a `/cases/` directory;
		// elsewhere `case.*` is an ordinary project file.
		expect(await touchedFor("cases/case.ts")).toBe(true);
	});
});

/**
 * #3650: `lsp_navigation` declares its target as `path`
 * (`tools/lsp-navigation.ts:863`), and the call-side reader in this file read
 * `filePath` alone. For a read-only operation the classifier returns no
 * mutation, so the raw path never resolved: `handleToolCall` returned at
 * `if (!filePath) return;` and every path-keyed step of the call site was
 * skipped for a file the agent had just named — the LSP config init for its
 * root, the nav auto-touch (`source: "tool_call:lsp_navigation"`), the
 * once-per-file complexity baseline, and the eligibility and gitignore
 * verdicts. Proven through the real `handleToolCall`, observed on the LSP
 * seam's `touchFile`.
 *
 * The `lsp_navigation` tool warms the file itself before its own request
 * (`openFileBestEffort`, `tools/lsp-navigation.ts:785`), so this call-site
 * touch is not the only warm: what the case pins is that the CALL's declared
 * path resolves at all, which is the seam the fix repairs.
 */
describe("lsp_navigation call-side path field (#3650)", () => {
	it("auto-touches the file an lsp_navigation call names in `path`", async () => {
		touchFileMock.mockClear();
		const env = setupTestEnvironment("pi-lens-3650-nav-path-");
		try {
			const filePath = createTempFile(env.tmpDir, "src/app.ts", "export {};\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			await runHandlerExpectingNoThrow(() =>
				handleToolCall(
					baseDeps({
						runtime,
						event: {
							toolName: "lsp_navigation",
							toolCallId: "call-nav-path",
							input: {
								operation: "references",
								path: "src/app.ts",
								line: 1,
							},
						},
						ctx: { cwd: env.tmpDir },
					}),
				),
			);
			expect(touchFileMock).toHaveBeenCalledWith(
				filePath,
				expect.any(String),
				expect.objectContaining({ source: "tool_call:lsp_navigation" }),
			);
		} finally {
			env.cleanup();
		}
	});
});

/**
 * RECURRENCE GUARDED (#5047 r1 F4): #5041 declared `file` and `filePath` as
 * accepted spellings of `lsp_navigation`'s `path`, but both host readers on
 * this seam read only `path` (and `filePath`, call-side). A rename sent with
 * `file` therefore resolved no path at `tool_call`: no read credit for the
 * agent's own edit, no touch, and no attribution, while the same rename through
 * `path` had all three. Driven through the real `handleToolCall`; the credit is
 * the read guard's own `noteCheckedPaths`, observed with a pass-through spy.
 */
describe("lsp_navigation call-side `file` alias (#5047 F4)", () => {
	for (const spelling of ["path", "file", "filePath"] as const) {
		it(`resolves, touches and credits a rename sent through \`${spelling}\``, async () => {
			touchFileMock.mockClear();
			const env = setupTestEnvironment("pi-lens-5047-nav-alias-");
			try {
				const filePath = createTempFile(
					env.tmpDir,
					"src/app.ts",
					"export const value = 1;\n",
				);
				const runtime = new RuntimeCoordinator();
				runtime.projectRoot = env.tmpDir;
				const credited = vi.spyOn(runtime.readGuard, "noteCheckedPaths");
				await runHandlerExpectingNoThrow(() =>
					handleToolCall(
						baseDeps({
							runtime,
							event: {
								toolName: "lsp_navigation",
								toolCallId: `call-nav-${spelling}`,
								input: {
									operation: "rename",
									[spelling]: "src/app.ts",
									line: 1,
									character: 14,
									newName: "renamed",
								},
							},
							ctx: { cwd: env.tmpDir },
						}),
					),
				);
				expect(touchFileMock).toHaveBeenCalledWith(
					filePath,
					expect.any(String),
					expect.objectContaining({ source: "tool_call:lsp_navigation" }),
				);
				expect(credited).toHaveBeenCalledWith(`call-nav-${spelling}`, [
					filePath,
				]);
			} finally {
				env.cleanup();
			}
		});
	}
});

// ---------------------------------------------------------------------------
// #4187 R4-1 — the licensed set is the set the call NAMED, never the wider set
// it wrote. Third recurrence of "named path vs written set" on this seam
// (R2-3, then R4-1): round 4 retired the named path but advanced EVERY path the
// producer recorded, so a rename's importers, an ast-grep folder and a
// server-initiated `workspace/applyEdit` each re-baselined an authorship over
// bytes nothing had checked.
//
// Every case drives the real `handleToolCall` for the pre-write check and the
// real producer seam for the record: `recordLspMutation` with the context
// `tools/lsp-navigation.ts` builds (runtime and cacheManager threaded: the
// direct branch) or the runtime-less one `clients/lsp/client.ts` builds for a
// server-initiated edit (the bridge fallback), the real `AstGrepClient.replace`
// for an apply, and the real `lens_diagnostic_mark` tool for a suppress. Each
// producer records through a real registered mutation bridge, so the entry the
// guard judges is the producer's own, never a hand-built one.
// ---------------------------------------------------------------------------

const LICENSE_FIXTURE =
	"const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\n";
/** Line 2 is the finding `lens_diagnostic_mark` suppresses in the cases below. */
const DIAG_MARK_FIXTURE = "const a = 1;\nconst target = bad();\nconst c = 3;\n";

/** The mutation bridge's runtime, per case: the registration is first-wins. */
let bridgeRuntime: RuntimeCoordinator | undefined;
let bridgeRoot = "";
let bridgeCacheManager: CacheManager | undefined;
registerMutationBridge({
	getRuntime: () => bridgeRuntime as never,
	getCacheManager: () => (bridgeCacheManager ??= new CacheManager(false)),
	getProjectRoot: () => bridgeRoot,
	getDispatchCwd: () => bridgeRoot,
	countFileLines,
	isRecordable: () => true,
	dbg: () => {},
});

/**
 * The real `lens_diagnostic_mark` suppress: it writes the inline ignore comment
 * and records it through the registered bridge, so the entry the guard judges is
 * the producer's own shape, not a hand-built one. Returns the tool's `isError`.
 */
async function suppressLine2(
	cwd: string,
	toolCallId: string,
): Promise<unknown> {
	const result = await createLensDiagnosticMarkTool(() => cwd).execute(
		toolCallId,
		{
			filePath: "target.ts",
			line: 2,
			message: "bad call",
			rule: "no-bad",
			tool: "eslint",
			disposition: "suppress",
		},
		undefined,
		() => {},
		{ cwd },
	);
	return result.isError;
}

/** Authorship the way a recognized bash write credits it (#3525). */
function bashAuthor(
	runtime: RuntimeCoordinator,
	filePath: string,
	toolCallId: string,
): void {
	runtime.readGuard.recordWritten(filePath, {
		stampFileTime: false,
		toolCallId,
	});
}

/** Another writer changes line 2, the line every case below edits next. */
function foreignWriteLine2(filePath: string): void {
	const lines = fs.readFileSync(filePath, "utf-8").split("\n");
	lines[1] = "const external = 2;";
	fs.writeFileSync(filePath, lines.join("\n"));
}

/** One line rewritten, the way an LSP workspace edit or an apply rewrites it. */
function toolRewriteLine3(filePath: string): void {
	const lines = fs.readFileSync(filePath, "utf-8").split("\n");
	lines[2] = "const rewritten = 3;";
	fs.writeFileSync(filePath, lines.join("\n"));
}

function lspResultsFor(files: readonly string[]) {
	return [
		{
			descriptions: [],
			files: [...files],
			operationTotal: 1,
			appliedOperationTotal: 1,
			appliedOperationIndexes: [0],
			operationCounts: {
				textEdits: files.length,
				create: 0,
				rename: 0,
				delete: 0,
			},
			fileDetails: files.map((filePath) => ({
				filePath,
				range: { start: 3, end: 3 },
				importsChanged: false,
			})),
		},
	];
}

/** The context `tools/lsp-navigation.ts` builds for a mutating operation. */
function lspToolContext(
	runtime: RuntimeCoordinator,
	cacheManager: CacheManager,
	args: { cwd: string; toolCallId?: string; operation: string },
): LspMutationContext {
	return {
		cwd: args.cwd,
		correlationId: "corr-lsp",
		...(args.toolCallId !== undefined && { toolCallId: args.toolCallId }),
		tool: `lsp_navigation:${args.operation}`,
		source:
			args.operation === "executeCommand"
				? "lsp-execute-command"
				: "lsp-rename",
		runtime: runtime as never,
		cacheManager,
		readGuard: runtime.readGuard,
		emitSummary: false,
	};
}

/**
 * The context `clients/lsp/client.ts` builds for a server-initiated
 * `workspace/applyEdit`: no runtime, no cacheManager, no readGuard and no call
 * of its own, so `bookkeepLspMutation` takes its bridge fallback.
 */
function serverApplyEditContext(cwd: string): LspMutationContext {
	return {
		cwd,
		correlationId: "corr-apply-edit",
		tool: "lsp-workspace-applyEdit",
		source: "lsp-execute-command",
	};
}

/** A real `AstGrepClient` whose runner reports one match in `target`. */
function astGrepClientRewriting(target: string): AstGrepClient {
	const client = new AstGrepClient();
	(client as unknown as { runner: { exec: unknown } }).runner = {
		exec: vi.fn(async (args: string[]) =>
			args.includes("--update-all")
				? { matches: [], totalMatches: 0, truncated: false }
				: {
						matches: [
							{
								file: target,
								range: {
									start: { line: 2, column: 0 },
									end: { line: 2, column: 5 },
								},
								text: "const c",
							},
						],
						totalMatches: 1,
						truncated: false,
					},
		),
	};
	vi.spyOn(client, "ensureAvailable").mockResolvedValue(true);
	return client;
}

async function callTool(
	runtime: RuntimeCoordinator,
	cwd: string,
	event: {
		toolName: string;
		toolCallId?: string;
		input: Record<string, unknown>;
	},
): Promise<void> {
	await runHandlerExpectingNoThrow(() =>
		handleToolCall(baseDeps({ runtime, ctx: { cwd }, event: event as never })),
	);
}

describe("#4187 R4-1 — a bytes-less write advances only what its own call named", () => {
	it("an lsp_navigation rename advances the file it named and ends every importer it also wrote", async () => {
		const env = setupTestEnvironment("pi-lens-4187-r41-rename-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			const cacheManager = new CacheManager(false);
			const named = createTempFile(env.tmpDir, "named.ts", LICENSE_FIXTURE);
			const importer = createTempFile(
				env.tmpDir,
				"importer.ts",
				LICENSE_FIXTURE,
			);
			bashAuthor(runtime, named, "call-rename-bash-1");
			bashAuthor(runtime, importer, "call-rename-bash-2");
			// Another writer changed the importer before the rename ran; nothing
			// checked the importer, so the rename must not vouch for its bytes.
			foreignWriteLine2(importer);
			await callTool(runtime, env.tmpDir, {
				toolName: "lsp_navigation",
				toolCallId: "call-rename",
				input: { operation: "rename", path: "named.ts", apply: true },
			});
			toolRewriteLine3(named);
			toolRewriteLine3(importer);
			recordLspMutation(
				lspToolContext(runtime, cacheManager, {
					cwd: env.tmpDir,
					toolCallId: "call-rename",
					operation: "rename",
				}),
				{ results: lspResultsFor([named, importer]) },
			);
			// The named file: its own call checked it, so the advance stands and
			// the next positional edit needs no read (R3-1 option B, no-drop).
			expect(runtime.readGuard.checkEdit(named, [3, 3]).action).toBe("allow");
			// The importer: written but never named, so its authorship ended.
			const importerVerdict = runtime.readGuard.checkEdit(importer, [2, 2]);
			expect(importerVerdict.action).toBe("block");
			expect(importerVerdict.reason).toContain(
				"File modified since your write",
			);
		} finally {
			env.cleanup();
		}
	});

	it("an lsp_navigation rename_file ends the authorship of every importer it rewrote", async () => {
		const env = setupTestEnvironment("pi-lens-4187-r41-rename-file-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			const cacheManager = new CacheManager(false);
			const renamed = createTempFile(env.tmpDir, "source.ts", LICENSE_FIXTURE);
			const importer = createTempFile(
				env.tmpDir,
				"importer.ts",
				LICENSE_FIXTURE,
			);
			bashAuthor(runtime, renamed, "call-rename-file-bash-1");
			bashAuthor(runtime, importer, "call-rename-file-bash-2");
			foreignWriteLine2(importer);
			await callTool(runtime, env.tmpDir, {
				toolName: "lsp_navigation",
				toolCallId: "call-rename-file",
				input: { operation: "rename_file", path: "source.ts", apply: true },
			});
			toolRewriteLine3(renamed);
			toolRewriteLine3(importer);
			recordLspMutation(
				lspToolContext(runtime, cacheManager, {
					cwd: env.tmpDir,
					toolCallId: "call-rename-file",
					operation: "rename_file",
				}),
				{ results: lspResultsFor([renamed, importer]) },
			);
			expect(runtime.readGuard.checkEdit(renamed, [3, 3]).action).toBe("allow");
			expect(runtime.readGuard.checkEdit(importer, [2, 2]).action).toBe(
				"block",
			);
		} finally {
			env.cleanup();
		}
	});

	it("an lsp_navigation executeCommand advances only the path its call named", async () => {
		const env = setupTestEnvironment("pi-lens-4187-r41-exec-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			const cacheManager = new CacheManager(false);
			const named = createTempFile(env.tmpDir, "named.ts", LICENSE_FIXTURE);
			const other = createTempFile(env.tmpDir, "other.ts", LICENSE_FIXTURE);
			bashAuthor(runtime, named, "call-exec-bash-1");
			bashAuthor(runtime, other, "call-exec-bash-2");
			foreignWriteLine2(other);
			await callTool(runtime, env.tmpDir, {
				toolName: "lsp_navigation",
				toolCallId: "call-exec",
				input: { operation: "executeCommand", path: "named.ts", apply: true },
			});
			toolRewriteLine3(named);
			toolRewriteLine3(other);
			recordLspMutation(
				lspToolContext(runtime, cacheManager, {
					cwd: env.tmpDir,
					toolCallId: "call-exec",
					operation: "executeCommand",
				}),
				{ results: lspResultsFor([named, other]) },
			);
			expect(runtime.readGuard.checkEdit(named, [3, 3]).action).toBe("allow");
			expect(runtime.readGuard.checkEdit(other, [2, 2]).action).toBe("block");
		} finally {
			env.cleanup();
		}
	});

	it("a server-initiated workspace/applyEdit, which has no tool_call, never advances an authorship", async () => {
		const env = setupTestEnvironment("pi-lens-4187-r41-apply-edit-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			bridgeRuntime = runtime;
			bridgeRoot = env.tmpDir;
			const filePath = createTempFile(env.tmpDir, "target.ts", LICENSE_FIXTURE);
			bashAuthor(runtime, filePath, "call-apply-edit-bash");
			foreignWriteLine2(filePath);
			// No handleToolCall at all: the server initiated the edit, so nothing
			// checked the file and no call id exists to license an advance.
			toolRewriteLine3(filePath);
			recordLspMutation(serverApplyEditContext(env.tmpDir), {
				results: lspResultsFor([filePath]),
			});
			const verdict = runtime.readGuard.checkEdit(filePath, [2, 2]);
			expect(verdict.action).toBe("block");
			expect(verdict.reason).toContain("File modified since your write");
		} finally {
			bridgeRuntime = undefined;
			bridgeRoot = "";
			env.cleanup();
		}
	});

	it("an ast_grep_replace apply over a folder ends the authorship of every file it rewrote", async () => {
		const env = setupTestEnvironment("pi-lens-4187-r41-ast-grep-dir-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			bridgeRuntime = runtime;
			bridgeRoot = env.tmpDir;
			const target = createTempFile(
				env.tmpDir,
				"src/target.ts",
				LICENSE_FIXTURE,
			);
			bashAuthor(runtime, target, "call-ast-grep-dir-bash");
			foreignWriteLine2(target);
			await callTool(runtime, env.tmpDir, {
				toolName: "ast_grep_replace",
				toolCallId: "call-ast-grep-dir",
				input: { apply: true, paths: ["src"] },
			});
			toolRewriteLine3(target);
			await astGrepClientRewriting(target).replace(
				"const c = 3",
				"const rewritten = 3",
				"typescript",
				[path.join(env.tmpDir, "src")],
				true,
				{ toolCallId: "call-ast-grep-dir" },
			);
			expect(runtime.readGuard.checkEdit(target, [2, 2]).action).toBe("block");
		} finally {
			bridgeRuntime = undefined;
			bridgeRoot = "";
			env.cleanup();
		}
	});

	it("an ast_grep_replace apply with no paths ends the authorship of the file it rewrote", async () => {
		const env = setupTestEnvironment("pi-lens-4187-r41-ast-grep-none-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			bridgeRuntime = runtime;
			bridgeRoot = env.tmpDir;
			const target = createTempFile(env.tmpDir, "target.ts", LICENSE_FIXTURE);
			bashAuthor(runtime, target, "call-ast-grep-none-bash");
			foreignWriteLine2(target);
			await callTool(runtime, env.tmpDir, {
				toolName: "ast_grep_replace",
				toolCallId: "call-ast-grep-none",
				input: { apply: true },
			});
			toolRewriteLine3(target);
			await astGrepClientRewriting(target).replace(
				"const c = 3",
				"const rewritten = 3",
				"typescript",
				[env.tmpDir],
				true,
				{ toolCallId: "call-ast-grep-none" },
			);
			expect(runtime.readGuard.checkEdit(target, [2, 2]).action).toBe("block");
		} finally {
			bridgeRuntime = undefined;
			bridgeRoot = "";
			env.cleanup();
		}
	});

	it("an ast_grep_replace apply over the file it named keeps that file's authorship", async () => {
		const env = setupTestEnvironment("pi-lens-4187-r41-ast-grep-file-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			bridgeRuntime = runtime;
			bridgeRoot = env.tmpDir;
			const target = createTempFile(env.tmpDir, "target.ts", LICENSE_FIXTURE);
			bashAuthor(runtime, target, "call-ast-grep-file-bash");
			await callTool(runtime, env.tmpDir, {
				toolName: "ast_grep_replace",
				toolCallId: "call-ast-grep-file",
				input: { apply: true, paths: ["target.ts"] },
			});
			toolRewriteLine3(target);
			await astGrepClientRewriting(target).replace(
				"const c = 3",
				"const rewritten = 3",
				"typescript",
				[target],
				true,
				{ toolCallId: "call-ast-grep-file" },
			);
			// No other writer moved the file, so the licensed advance stands and
			// the next positional edit needs no read.
			expect(runtime.readGuard.checkEdit(target, [3, 3]).action).toBe("allow");
		} finally {
			bridgeRuntime = undefined;
			bridgeRoot = "";
			env.cleanup();
		}
	});

	it("a lens_diagnostic_mark suppress keeps the authorship of the file it named", async () => {
		const env = setupTestEnvironment("pi-lens-4187-r41-diag-mark-own-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			bridgeRuntime = runtime;
			bridgeRoot = env.tmpDir;
			const target = createTempFile(env.tmpDir, "target.ts", DIAG_MARK_FIXTURE);
			bashAuthor(runtime, target, "call-diag-mark-bash");
			await callTool(runtime, env.tmpDir, {
				toolName: "lens_diagnostic_mark",
				toolCallId: "call-diag-mark",
				input: { filePath: "target.ts", disposition: "suppress" },
			});
			// The real tool writes the inline ignore comment and records it
			// through the registered bridge, so the entry is the producer's own.
			expect(await suppressLine2(env.tmpDir, "call-diag-mark")).toBeFalsy();
			expect(runtime.readGuard.checkEdit(target, [1, 1]).action).toBe("allow");
		} finally {
			if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
			else process.env.PILENS_DATA_DIR = previousDataDir;
			bridgeRuntime = undefined;
			bridgeRoot = "";
			env.cleanup();
		}
	});

	it("a lens_diagnostic_mark suppress does not re-author a line another writer changed", async () => {
		const env = setupTestEnvironment("pi-lens-4187-r41-diag-mark-foreign-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			bridgeRuntime = runtime;
			bridgeRoot = env.tmpDir;
			const target = createTempFile(env.tmpDir, "target.ts", DIAG_MARK_FIXTURE);
			bashAuthor(runtime, target, "call-diag-mark-foreign-bash");
			// Another writer changes line 3, which the suppress never touches.
			const lines = DIAG_MARK_FIXTURE.split("\n");
			lines[2] = "const external = 3;";
			fs.writeFileSync(target, lines.join("\n"));
			await callTool(runtime, env.tmpDir, {
				toolName: "lens_diagnostic_mark",
				toolCallId: "call-diag-mark-foreign",
				input: { filePath: "target.ts", disposition: "suppress" },
			});
			expect(
				await suppressLine2(env.tmpDir, "call-diag-mark-foreign"),
			).toBeFalsy();
			const verdict = runtime.readGuard.checkEdit(target, [3, 3]);
			expect(verdict.action).toBe("block");
			expect(verdict.reason).toContain("File modified since your write");
		} finally {
			if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
			else process.env.PILENS_DATA_DIR = previousDataDir;
			bridgeRuntime = undefined;
			bridgeRoot = "";
			env.cleanup();
		}
	});

	it("licenses the call that checked the path, not an earlier call that did", async () => {
		const env = setupTestEnvironment("pi-lens-4187-r41-license-key-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			const cacheManager = new CacheManager(false);
			const named = createTempFile(env.tmpDir, "named.ts", LICENSE_FIXTURE);
			const importer = createTempFile(
				env.tmpDir,
				"importer.ts",
				LICENSE_FIXTURE,
			);
			bashAuthor(runtime, named, "call-license-key-bash-1");
			bashAuthor(runtime, importer, "call-license-key-bash-2");
			// An earlier call checks the importer while its bytes still hold, so
			// nothing is retired and the importer keeps a live license for THAT
			// call. The call never writes (the tool fails, the agent moves on).
			await callTool(runtime, env.tmpDir, {
				toolName: "ast_grep_replace",
				toolCallId: "call-earlier",
				input: { apply: true, paths: ["importer.ts"] },
			});
			// Another writer changes the importer after that check.
			foreignWriteLine2(importer);
			// A later, different call writes it as a rename's importer. Its own
			// tool_call named only `named.ts`, so the earlier call's license must
			// not serve it: the advance is per call, not per path.
			await callTool(runtime, env.tmpDir, {
				toolName: "lsp_navigation",
				toolCallId: "call-later",
				input: { operation: "rename", path: "named.ts", apply: true },
			});
			toolRewriteLine3(named);
			toolRewriteLine3(importer);
			recordLspMutation(
				lspToolContext(runtime, cacheManager, {
					cwd: env.tmpDir,
					toolCallId: "call-later",
					operation: "rename",
				}),
				{ results: lspResultsFor([named, importer]) },
			);
			expect(runtime.readGuard.checkEdit(named, [3, 3]).action).toBe("allow");
			expect(runtime.readGuard.checkEdit(importer, [2, 2]).action).toBe(
				"block",
			);
		} finally {
			env.cleanup();
		}
	});

	it("spends an observed bridge license after one write", async () => {
		const env = setupTestEnvironment("pi-lens-4187-r51-license-spend-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			bridgeRuntime = runtime;
			bridgeRoot = env.tmpDir;
			const filePath = createTempFile(env.tmpDir, "reuse.ts", LICENSE_FIXTURE);
			bashAuthor(runtime, filePath, "call-reuse-bash");

			// The real tool-call handler retires/checks the path and arms the
			// observed producer's one-use (call,path) license.
			await callTool(runtime, env.tmpDir, {
				toolName: "ast_grep_replace",
				toolCallId: "call-reuse",
				input: { apply: true, paths: ["reuse.ts"] },
			});
			toolRewriteLine3(filePath);
			const bridge = getMutationBridge();
			expect(
				bridge?.recordMutation({
					filePath,
					kind: "edit",
					consumer: "observed-license-spend",
					provenance: "observed",
					toolCallId: "call-reuse",
				}),
			).toBe(true);

			const lines = fs.readFileSync(filePath, "utf-8").split("\n");
			lines[1] = "const external_again = 2;";
			fs.writeFileSync(filePath, lines.join("\n"));
			// R5-1 recurrence: a settled call id must not spend its license again
			// to re-baseline over the second writer's bytes.
			expect(
				bridge?.recordMutation({
					filePath,
					kind: "edit",
					consumer: "observed-license-spend",
					provenance: "observed",
					toolCallId: "call-reuse",
				}),
			).toBe(true);
			expect(runtime.readGuard.checkEdit(filePath, [2, 2]).action).toBe(
				"block",
			);
		} finally {
			bridgeRuntime = undefined;
			bridgeRoot = "";
			env.cleanup();
		}
	});

	it("spends an observed bridge license after one whole-file write (SpendLicense)", async () => {
		// #4393 pin for formal/read-guard SpendLicense (== BridgeNoAdvance): a
		// whole-file record keeps the authorship's whole-file scope, so only the
		// spent license refuses the second writer's line. Recurrence: a reusable
		// (call,path) license survived every suite (#4399 review F2).
		const env = setupTestEnvironment("pi-lens-4393-license-spend-whole-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			bridgeRuntime = runtime;
			bridgeRoot = env.tmpDir;
			const filePath = createTempFile(env.tmpDir, "whole.ts", LICENSE_FIXTURE);
			bashAuthor(runtime, filePath, "call-whole-bash");
			await callTool(runtime, env.tmpDir, {
				toolName: "ast_grep_replace",
				toolCallId: "call-whole",
				input: { apply: true, paths: ["whole.ts"] },
			});
			const bridge = getMutationBridge();
			const record = () =>
				bridge?.recordMutation({
					filePath,
					kind: "write",
					consumer: "observed-license-spend-whole",
					provenance: "observed",
					toolCallId: "call-whole",
				});
			toolRewriteLine3(filePath);
			expect(record()).toBe(true);
			foreignWriteLine2(filePath);
			toolRewriteLine3(filePath);
			expect(record()).toBe(true);
			expect(runtime.readGuard.checkEdit(filePath, [2, 2]).action).toBe(
				"block",
			);
		} finally {
			bridgeRuntime = undefined;
			bridgeRoot = "";
			env.cleanup();
		}
	});

	it("matches an observed license across a symlink spelling", async () => {
		const env = setupTestEnvironment("pi-lens-4187-r52-symlink-license-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			bridgeRuntime = runtime;
			bridgeRoot = env.tmpDir;
			fs.mkdirSync(path.join(env.tmpDir, "real"));
			const realPath = createTempFile(
				env.tmpDir,
				"real/target.ts",
				LICENSE_FIXTURE,
			);
			const linkRoot = path.join(env.tmpDir, "link");
			fs.symlinkSync("real", linkRoot, "dir");
			bashAuthor(runtime, realPath, "call-symlink-bash");

			await callTool(runtime, env.tmpDir, {
				toolName: "unknown_writer",
				toolCallId: "call-symlink",
				input: { path: "link/target.ts" },
			});
			toolRewriteLine3(realPath);
			const bridge = getMutationBridge();
			bridge?.recordMutation({
				filePath: realPath,
				kind: "edit",
				consumer: "symlink-writer",
				provenance: "observed",
				toolCallId: "call-symlink",
				touchedLines: [3, 3],
			});
			// R5-2 recurrence: independently derived link/real spellings name one
			// file, so the own write must not cost a needless re-read.
			expect(runtime.readGuard.checkEdit(realPath, [3, 3]).action).toBe(
				"allow",
			);
		} finally {
			bridgeRuntime = undefined;
			bridgeRoot = "";
			env.cleanup();
		}
	});
});
