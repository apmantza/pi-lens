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
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
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
vi.mock("../../clients/lsp/index.js", () => ({ getLSPService: vi.fn() }));
vi.mock("../../clients/recent-touches.js", () => ({
	appendRecentTouches: vi.fn().mockResolvedValue(undefined),
}));

import { dispatchLintWithResult } from "../../clients/dispatch/integration.js";
import { getLSPService } from "../../clients/lsp/index.js";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";

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
			output: "",
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

	it("an aggregate-degraded path in a bash write says re-read once", async () => {
		const env = setupTestEnvironment("pi-lens-1590-aggregate-");
		try {
			// Each file fits the 2 MiB per-file cap alone; the pair does not, so
			// the second path degrades to the re-read warning. Its pipeline half
			// used to still call its own attachment authoritative.
			const big = `${"x".repeat(1.5 * 1024 * 1024)}\n`;
			const fileA = createTempFile(env.tmpDir, "agg-a.ts", "const a=1;\n");
			const fileB = createTempFile(env.tmpDir, "agg-b.ts", "const b=1;\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;

			const returned = await handleToolResult({
				...toolDeps(
					runtime,
					fixingBiome(() => big),
				),
				event: {
					toolName: "bash",
					input: { command: `echo x > "${fileA}"; echo x > "${fileB}"` },
					content: [],
				},
			} as never);

			const attachments = (returned?.content ?? []).filter((part) =>
				part.text?.startsWith(ATTACHMENT_PREFIX),
			);
			expect(attachments).toHaveLength(1);
			expect(attachments[0].text).toContain(path.basename(fileA));

			const lines = instructions(returned);
			expect(lines).toHaveLength(2);
			const attachedLines = lines.filter((line) =>
				line.includes(ATTACHED_CLAIM),
			);
			expect(attachedLines).toHaveLength(1);
			expect(attachedLines[0]).toContain(path.basename(fileA));
			const degraded = lines.filter((line) => line.includes(AGGREGATE_CLAIM));
			expect(degraded).toHaveLength(1);
			expect(degraded[0]).toContain(path.basename(fileB));
			// One row per path, and the reason is on the row.
			expect(decisionRows().map((row) => row.decision)).toEqual([
				"attached",
				"aggregate-budget-degraded",
			]);
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
});
