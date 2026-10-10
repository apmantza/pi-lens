/**
 * #1590: one tool result, one instruction about the target file.
 *
 * Before this fix two layers wrote that instruction. `clients/pipeline.ts`
 * claimed "the attached full content is authoritative" from changed-file
 * membership alone, and `clients/runtime-tool-result.ts` — the only layer that
 * sees the per-file attachment cap and the per-command aggregate budget —
 * appended "too large to attach" for the same file. A size-capped write
 * carried both sentences.
 *
 * These tests run the REAL composition: `runPipeline` is NOT mocked, so the
 * pipeline half of the message is produced by the shipping code. Only the
 * dispatch and LSP seams are stubbed, exactly as tests/clients/pipeline.test.ts
 * stubs them, and autofix is driven by a fake biome client that rewrites the
 * file. Every existing attachment test mocks `runPipeline` away, which is why
 * the contradiction was invisible to them.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BiomeClient } from "../../clients/biome-client.js";
import { CacheManager } from "../../clients/cache-manager.js";
import { extractWrittenPathsFromCommand } from "../../clients/bash-file-access.js";
import { getProjectChangeLogPath } from "../../clients/project-changes.js";
import type { ProjectChangeEntry } from "../../clients/project-changes.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { handleToolCall } from "../../clients/runtime-tool-call.js";
import { handleToolResult } from "../../clients/runtime-tool-result.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

const logLatency = vi.hoisted(() => vi.fn());
vi.mock("../../clients/latency-logger.js", async (importActual) => ({
	...(await importActual<typeof import("../../clients/latency-logger.js")>()),
	logLatency,
}));
vi.mock("../../clients/dispatch/integration.js", () => ({
	dispatchLintWithResult: vi.fn(),
	computeCascadeForFile: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../clients/lsp/capabilities.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../clients/lsp/capabilities.js")
	>()),
	getLSPService: vi.fn(),
	resyncGitChangedFiles: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../clients/recent-touches.js", () => ({
	appendRecentTouches: vi.fn().mockResolvedValue(undefined),
}));

import { dispatchLintWithResult } from "../../clients/dispatch/integration.js";
import { getLSPService } from "../../clients/lsp/capabilities.js";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";
import { runHandlerExpectingNoThrow } from "../support/handler-verdict.js";

const ATTACHMENT_PREFIX = "pi-lens applied autofix to ";
const ATTACHED_CLAIM = "is authoritative after autofix";
const PER_FILE_CAP_CLAIM = "the authoritative content is too large to attach";
const AGGREGATE_CLAIM = "the aggregate authoritative content for this command";
const NEUTRAL_CLAIM = "You MUST re-read modified file(s)";

/** Every instruction sentence the tool result carries, attachments excluded. */
function instructions(
	returned: { content: Array<{ text?: string }> } | undefined | void,
): string[] {
	return (returned?.content ?? [])
		.map((part) => part.text ?? "")
		.filter((text) => !text.startsWith(ATTACHMENT_PREFIX))
		.flatMap((text) => text.split("\n"))
		.filter((line) => line.includes("⚠️ **") && line.includes("re-read"));
}

/** Every attachment-decision telemetry row this tool result logged. */
function decisionRows(): Array<{ path: string; decision: string }> {
	return logLatency.mock.calls
		.map((call) => call[0])
		.filter((row) => row.phase === "authoritative_content_attachment_decision")
		.map((row) => row.metadata);
}

/** A biome that "fixes" the file by writing `content` to it. */
function fixingBiome(content: (filePath: string) => string): BiomeClient {
	return {
		isSupportedFile: () => true,
		ensureAvailable: async () => true,
		fixFileAsync: async (filePath: string) => {
			fs.writeFileSync(filePath, content(filePath));
			return { success: true, changed: true, fixed: 1 };
		},
	} as unknown as BiomeClient;
}

function toolDeps(runtime: RuntimeCoordinator, biomeClient: BiomeClient) {
	// #3005 fixture recurrence: the real pipeline must reach the Biome writer
	// before attachment-budget behavior is observed.
	fs.writeFileSync(
		path.join(runtime.projectRoot, "package.json"),
		JSON.stringify({ devDependencies: { "@biomejs/biome": "^2.4.10" } }),
	);
	fs.writeFileSync(
		path.join(runtime.projectRoot, "package-lock.json"),
		JSON.stringify({
			lockfileVersion: 3,
			packages: {
				"": {},
				"node_modules/@biomejs/biome": { version: "2.4.10" },
			},
		}),
	);
	return {
		getFlag: (name: string) => name === "no-lsp",
		dbg: () => {},
		runtime,
		cacheManager: { addModifiedRange: () => {}, readTurnState: () => ({}) },
		biomeClient,
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

function bashCallDeps(runtime: RuntimeCoordinator, command: string) {
	return {
		event: { toolName: "bash", input: { command } },
		ctx: { cwd: runtime.projectRoot },
		lensEnabled: true,
		getFlag: (name: string) => name === "no-lsp",
		dbg: () => {},
		runtime,
		cacheManager: new CacheManager(false),
		ensureLSPConfigInitialized: async () => {},
		updateLspStatus: () => {},
		resetLSPService: () => {},
	} as Parameters<typeof handleToolCall>[0];
}

function changeLogEntries(cwd: string): ProjectChangeEntry[] {
	const logPath = getProjectChangeLogPath(cwd);
	if (!fs.existsSync(logPath)) return [];
	return fs
		.readFileSync(logPath, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as ProjectChangeEntry);
}

describe("#1590 post-autofix instruction has one author", () => {
	beforeEach(() => {
		logLatency.mockClear();
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
		vi.mocked(dispatchLintWithResult).mockResolvedValue({
			diagnostics: [],
			blockers: [],
			warnings: [],
			baselineWarningCount: 0,
			fixed: [],
			resolvedCount: 0,
			output: "pipeline analysis visible",
			blockerOutput: "",
			hasBlockers: false,
		} as never);
	});

	it("a size-capped write says re-read once and never claims an attachment", async () => {
		const env = setupTestEnvironment("pi-lens-1590-size-capped-");
		try {
			const filePath = createTempFile(env.tmpDir, "big.ts", "const a=1;\n");
			const oversized = `${"x".repeat(2 * 1024 * 1024)}\n`;
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;

			const returned = await handleToolResult({
				...toolDeps(
					runtime,
					fixingBiome(() => oversized),
				),
				event: {
					toolName: "write",
					input: { path: filePath },
					content: [],
				},
			} as never);

			const text = (returned?.content ?? [])
				.map((part) => part.text ?? "")
				.join("\n");
			expect(text).not.toContain(ATTACHED_CLAIM);
			expect(text).not.toContain(ATTACHMENT_PREFIX);
			expect(instructions(returned)).toHaveLength(1);
			expect(instructions(returned)[0]).toContain(PER_FILE_CAP_CLAIM);
		} finally {
			env.cleanup();
		}
	});

	it("an attached write says the attached content is authoritative, once", async () => {
		const env = setupTestEnvironment("pi-lens-1590-attached-");
		try {
			const filePath = createTempFile(env.tmpDir, "small.ts", "const a=1;\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;

			const returned = await handleToolResult({
				...toolDeps(
					runtime,
					fixingBiome(() => "const a = 1;\n"),
				),
				event: {
					toolName: "write",
					input: { path: filePath },
					content: [],
				},
			} as never);

			const text = (returned?.content ?? [])
				.map((part) => part.text ?? "")
				.join("\n");
			expect(text).toContain(ATTACHMENT_PREFIX);
			expect(text).not.toContain(PER_FILE_CAP_CLAIM);
			expect(text).not.toContain(NEUTRAL_CLAIM);
			expect(instructions(returned)).toHaveLength(1);
			expect(instructions(returned)[0]).toContain(ATTACHED_CLAIM);
		} finally {
			env.cleanup();
		}
	});

	it("opaque bash recovery preserves analysis without claiming authorship", async () => {
		const env = setupTestEnvironment("pi-lens-1590-aggregate-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			// #3226 recurrence: a parser-recognized bash redirect plus a direct
			// handleToolResult call can pass without exercising opaque baseline,
			// recovery, or ownership gating. Keep the host/bash boundary mocked by
			// deterministic in-process writes; no child or timing is involved.
			const fileA = createTempFile(
				env.tmpDir,
				"opaque-existing.ts",
				"const a=1;\n",
			);
			const fileB = path.join(env.tmpDir, "opaque-created.ts");
			const command = `opaque-mutator --existing "${fileA}" --create "${fileB}"`;
			expect(extractWrittenPathsFromCommand(command, env.tmpDir)).toEqual([]);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			const resultDeps = toolDeps(
				runtime,
				fixingBiome(() => "const shouldNotRun = true;\n"),
			);
			expect(
				await runHandlerExpectingNoThrow(() =>
					handleToolCall(bashCallDeps(runtime, command)),
				),
			).toBeUndefined();
			fs.writeFileSync(fileA, "const a = 2;\n");
			fs.writeFileSync(fileB, "export const created = true;\n");

			const returned = await handleToolResult({
				...resultDeps,
				event: {
					toolName: "bash",
					input: { command },
					content: [{ type: "text", text: "bash complete" }],
				},
			} as never);

			expect(returned).toBeDefined();
			const returnedText = (returned?.content ?? [])
				.map((part) => part.text ?? "")
				.join("\n");
			expect(returnedText).toContain("pipeline analysis visible");
			const attachments = (returned?.content ?? []).filter((part) =>
				part.text?.startsWith(ATTACHMENT_PREFIX),
			);
			expect(attachments).toHaveLength(0);

			const lines = instructions(returned);
			expect(lines).toHaveLength(0);
			expect(lines.some((line) => line.includes(AGGREGATE_CLAIM))).toBe(false);
			expect(returnedText).not.toContain("authoritative");
			const opaqueEntries = changeLogEntries(env.tmpDir).filter(
				(entry) => entry.source === "opaque-script",
			);
			expect(
				opaqueEntries.map((entry) => path.resolve(entry.filePath)).sort(),
			).toEqual([fileA, fileB].map((file) => path.resolve(file)).sort());
			expect(runtime.getMutationsSince(0)).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						filePath: path.resolve(fileA),
						source: "opaque-script",
					}),
					expect.objectContaining({
						filePath: path.resolve(fileB),
						source: "opaque-script",
					}),
				]),
			);
			expect(decisionRows()).toEqual([]);
		} finally {
			if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
			else process.env.PILENS_DATA_DIR = previousDataDir;
			env.cleanup();
		}
	});

	it("recognized direct bash authorship still attaches autofix content", async () => {
		const env = setupTestEnvironment("pi-lens-1590-recognized-");
		try {
			const filePath = createTempFile(
				env.tmpDir,
				"direct.ts",
				"const direct=1;\n",
			);
			const command = `echo direct > "${filePath}"`;
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			const resultDeps = toolDeps(
				runtime,
				fixingBiome(() => "const direct = 1;\n"),
			);
			await runHandlerExpectingNoThrow(() =>
				handleToolCall(bashCallDeps(runtime, command)),
			);
			fs.writeFileSync(filePath, "const direct=2;\n");

			const returned = await handleToolResult({
				...resultDeps,
				event: { toolName: "bash", input: { command }, content: [] },
			} as never);

			expect(returned).toBeDefined();
			const text = (returned?.content ?? [])
				.map((part) => part.text ?? "")
				.join("\n");
			expect(text).toContain(ATTACHMENT_PREFIX);
			expect(text).toContain("const direct = 1;");
			expect(text).toContain(ATTACHED_CLAIM);
		} finally {
			env.cleanup();
		}
	});

	it("a mutation that attached nothing still logs a decision row (#1590 F1)", async () => {
		const env = setupTestEnvironment("pi-lens-1590-none-");
		try {
			// The autofix changed the file and then left no readable content
			// behind — a fixer that deletes or renames its target. There are
			// authoritative bytes to talk about, but none to attach, so the
			// decision is `none`. A missing row here would be indistinguishable
			// from missing instrumentation.
			const filePath = createTempFile(env.tmpDir, "gone.ts", "const a=1;\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;

			const returned = await handleToolResult({
				...toolDeps(
					runtime,
					fixingBiome(() => "unused"),
				),
				biomeClient: {
					isSupportedFile: () => true,
					ensureAvailable: async () => true,
					fixFileAsync: async (target: string) => {
						fs.rmSync(target);
						return { success: true, changed: true, fixed: 1 };
					},
				},
				event: {
					toolName: "write",
					input: { path: filePath },
					content: [],
				},
			} as never);

			const text = (returned?.content ?? [])
				.map((part) => part.text ?? "")
				.join("\n");
			expect(text).not.toContain(ATTACHMENT_PREFIX);
			expect(text).toContain(NEUTRAL_CLAIM);
			expect(decisionRows()).toHaveLength(1);
			expect(decisionRows()[0].decision).toBe("none");
			expect(decisionRows()[0].path).toContain(path.basename(filePath));
		} finally {
			env.cleanup();
		}
	});

	it("records the real autofix bytes in the after-write record (#2499 F2)", async () => {
		const env = setupTestEnvironment("pi-lens-2499-after-write-");
		try {
			const filePath = createTempFile(env.tmpDir, "sample.ts", "const a=1;\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			const noteAfterWriteHash = vi.spyOn(
				runtime.partialApplyRecords,
				"noteAfterWriteHash",
			);

			await handleToolResult({
				...toolDeps(
					runtime,
					fixingBiome(() => "const a = 1;\n"),
				),
				_bypassDebounce: true,
				_autofixMode: "immediate",
				event: {
					toolName: "edit",
					input: {
						path: filePath,
						edits: [{ oldText: "const a=1;", newText: "const a=1;" }],
					},
					content: [],
				},
			} as never);

			expect(noteAfterWriteHash).toHaveBeenCalledOnce();
			expect(noteAfterWriteHash.mock.calls[0]?.[3]).toBe(
				(await import("node:crypto"))
					.createHash("sha256")
					.update(fs.readFileSync(filePath))
					.digest("hex"),
			);
		} finally {
			env.cleanup();
		}
	});
});
