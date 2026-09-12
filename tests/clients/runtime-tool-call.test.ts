import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CacheManager } from "../../clients/cache-manager.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { handleToolCall } from "../../clients/runtime-tool-call.js";
import type { TreeSitterClient } from "../../clients/tree-sitter-client.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";

// handleToolCall calls getLSPService() directly (not via DI, matching the
// pattern already used by runtime-session.ts). Stub it so tests never spin up
// a real LSP client — auto-touch is best-effort/fire-and-forget so a stub
// touchFile that resolves immediately is enough to observe its call args.
const touchFileMock = vi.fn().mockResolvedValue(undefined);
const getWarmClientForFileMock = vi.fn().mockResolvedValue(undefined);
vi.mock("../../clients/lsp/index.js", () => ({
	getLSPService: () =>
		makeLspServiceDouble({
			touchFile: touchFileMock,
			getWarmClientForFile: getWarmClientForFileMock,
		}),
	resetLSPService: () => {},
}));

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

// #2402: the partial-apply afterWrite routes through handleToolResult, whose
// dispatch pipeline is a real subprocess surface. The mock keeps the test at
// the contract seam (post-edit analysis succeeded/failed) without spawning
// formatters or runners; runPipeline's isError is exactly what the afterWrite
// callback reads to classify postEditStatus.
const runPipelineMock = vi.hoisted(() => vi.fn());
vi.mock("../../clients/pipeline.js", () => ({
	runPipeline: runPipelineMock,
}));

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
			await handleToolCall(
				baseDeps({
					runtime,
					getFlag: (name) => name === "no-complexity",
					event: { toolName: "read", input: { filePath } },
				}),
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

	it("does not let heredoc body words trigger the real git guard", async () => {
		const env = setupTestEnvironment("pi-lens-2726-heredoc-guard-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setTelemetryIdentity({ sessionId: "session-2726" });
			runtime.updateGitGuardStatus(true, "existing blocker");
			const result = await handleToolCall(
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
			const result = await handleToolCall(
				baseDeps({
					runtime,
					ctx: { cwd: env.tmpDir },
					getFlag: (name) => name === "lens-guard",
					event: {
						toolName: "bash",
						input: { command: "cat <<EOF; echo git push\nbody\nEOF" },
					},
				}),
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
			const result = await handleToolCall(
				baseDeps({
					runtime,
					ctx: { cwd: env.tmpDir },
					getFlag: (name) => name === "lens-guard",
					event: {
						toolName: "bash",
						input: { command: "cat <<EOF; git push\nbody\nEOF" },
					},
				}),
			);
			expect(result).toMatchObject({ block: expect.anything() });
		} finally {
			env.cleanup();
		}
	});
	it("is a no-op when lensEnabled is false", async () => {
		const runtime = new RuntimeCoordinator();
		const recordRead = vi.spyOn(runtime.readGuard, "recordRead");
		const result = await handleToolCall(
			baseDeps({
				lensEnabled: false,
				runtime,
				event: { toolName: "read", input: { path: "/does/not/matter" } },
			}),
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

			await handleToolCall(
				baseDeps({
					runtime,
					event: { toolName: "read", input: { path: filePath } },
					ctx: { cwd: env.tmpDir },
				}),
			);

			expect(recordRead).toHaveBeenCalledWith(
				expect.objectContaining({
					filePath,
					effectiveOffset: 1,
				}),
			);
			expect(touchFileMock).toHaveBeenCalled();
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

			await handleToolCall(
				baseDeps({
					runtime,
					event: {
						toolName: "read",
						input: { path: filePath, offset: 2, limit: 1 },
					},
					ctx: { cwd: env.tmpDir },
					getTreeSitterClient,
				}),
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

			await handleToolCall(
				baseDeps({
					runtime,
					event: {
						toolName: "read",
						input: { path: filePath, offset: 2, limit: 1 },
					},
					ctx: { cwd: env.tmpDir },
					getTreeSitterClient,
				}),
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

			const result = await handleToolCall(
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
			);

			expect(result).toMatchObject({ block: true });
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

			const result = await handleToolCall(
				baseDeps({
					runtime,
					ctx: { cwd: env.tmpDir },
					event: {
						toolName: "write",
						input: { path: filePath, content: "export const x = 1;\n" },
					},
				}),
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

			const result = await handleToolCall(
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
			);

			expect(result).toMatchObject({ block: true });
			expect((result as { reason: string }).reason).toContain("shared");
		} finally {
			env.cleanup();
		}
	});
});

// ── #2402: mixed-validity preflight → partial apply contract ────────────────
// Drives the REAL handleToolCall path (preflight → partial apply → synthetic
// post-edit dispatch) with only the process boundary mocked (runPipeline).
describe("#2402 partial-apply contract (mixed-validity preflight)", () => {
	// The canonical #2402 batch: edits[0] is valid and oldText is contained in
	// its own newText (an extended import line); edits[1] genuinely misses.
	function mixedBatchEvent(filePath: string) {
		return {
			toolName: "edit",
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

	it("commits the valid subset once and reports PARTIAL APPLY on first attempt", async () => {
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

			const result = await handleToolCall(
				baseDeps({
					runtime,
					ctx: { cwd: env.tmpDir },
					event: mixedBatchEvent(filePath),
				}),
			);

			expect(result).toMatchObject({ block: true });
			const reason = (result as { reason: string }).reason;
			expect(reason.startsWith("⚠️ PARTIAL APPLY")).toBe(true);
			expect(reason).toContain("edits[0]");
			expect(reason).toContain("Post-apply analysis");
			expect(fs.readFileSync(filePath, "utf-8")).toBe(
				"import { A } from 'm';\nimport { B } from 'm';\nconst tail = 1;\n",
			);
		} finally {
			env.cleanup();
		}
	});

	it("commits a normalized raw span in a mixed-validity batch", async () => {
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
			const result = await handleToolCall(
				baseDeps({
					runtime,
					ctx: { cwd: env.tmpDir },
					event: {
						toolName: "edit",
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
			);
			expect(result).toMatchObject({ block: true });
			expect(fs.readFileSync(filePath, "utf8")).toBe(
				"const total = a+b;\nconst tail = 1;\n",
			);
		} finally {
			env.cleanup();
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

			const result = await handleToolCall(
				baseDeps({
					runtime,
					ctx: { cwd: env.tmpDir },
					event: mixedBatchEvent(filePath),
				}),
			);

			expect(result).toMatchObject({ block: true });
			const reason = (result as { reason: string }).reason;
			// The bytes are on disk; the message must lead with that fact and must
			// never relabel them as a retryable oldText miss.
			expect(reason.startsWith("⚠️ PARTIAL APPLY")).toBe(true);
			expect(reason).not.toContain("RETRYABLE");
			expect(reason).toContain("committed bytes stand");
			expect(fs.readFileSync(filePath, "utf-8")).toContain(
				"import { B } from 'm';",
			);
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
			const event = mixedBatchEvent(filePath);

			await handleToolCall(
				baseDeps({ runtime, ctx: { cwd: env.tmpDir }, event }),
			);
			const afterFirst = fs.readFileSync(filePath, "utf-8");
			expect(afterFirst).toBe(
				"import { A } from 'm';\nimport { B } from 'm';\nconst tail = 1;\n",
			);

			// Identical retry: edits[0]'s oldText still occurs exactly once
			// (inside its own applied newText). The retry must recognize the
			// applied record, not re-execute the write.
			const retry = await handleToolCall(
				baseDeps({ runtime, ctx: { cwd: env.tmpDir }, event }),
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
			const retry = await handleToolCall(
				baseDeps({ runtime, ctx: { cwd: env.tmpDir }, event: editEvent }),
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
			const recordWritten = vi.spyOn(runtime.readGuard, "recordWritten");
			const seqBefore = runtime.projectSeq;

			const result = await handleToolCall(
				baseDeps({
					runtime,
					ctx: { cwd: env.tmpDir },
					event: {
						toolName: "edit",
						input: {
							path: filePath,
							edits: [
								{ oldText: "const b = 2;", newText: "const b = 20;" },
								{ oldText: "function gone() {}", newText: "noop" },
							],
						},
					},
				}),
			);

			expect(result).toMatchObject({ block: true });
			// One mutation: the partial apply's committed write, attributed to
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

			// The synthetic post-edit dispatch stamps the read guard so a
			// follow-up edit is not judged stale against our own commit.
			expect(recordWritten).toHaveBeenCalledWith(filePath);
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
			await handleToolCall({
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
			});
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
			await handleToolCall({
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
			});
			expect(checkEdit).toHaveBeenCalledTimes(2);
			expect(checkEdit.mock.calls[1]![0]).toBe(filePath);
			expect(checkEdit.mock.calls[1]![1]).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});
});
