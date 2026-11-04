/**
 * #1464: the write path and the context nudge double-informed the agent.
 *
 * Since #1414 a `write` whose immediate autofix changed the file gets the full
 * post-fix bytes attached to its OWN tool result, and the nudge still told the
 * next turn to re-read that same file. These tests bind the three-way contract
 * end to end — write path decision in `handleToolResult`, bus publish in
 * `publishFilesTouched`, drain in `consumeAgentNudge` — rather than only at the
 * nudge module's own seam (tests/clients/agent-nudge.test.ts):
 *
 *   1. attached           ⇒ no nudge entry for that path
 *   2. size-capped        ⇒ still nudges (the inversion guard)
 *   3. aggregate-degraded ⇒ still nudges for the degraded path only
 *   4. deferred autofix   ⇒ nudges unchanged (that path attaches nothing)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	_resetAgentNudgeForTests,
	consumeAgentNudge,
	wireAgentNudgeSubscriber,
} from "../../clients/agent-nudge.js";
import {
	_resetForTests as resetBusPublish,
	publishFilesTouched,
	wireBusEmitter,
} from "../../clients/bus-publish.js";
import type { ReadGuard } from "../../clients/read-guard.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { handleToolResult } from "../../clients/runtime-tool-result.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

vi.mock("../../clients/pipeline.js", () => ({ runPipeline: vi.fn() }));

// The cross-process record is a separate delivery of the same payload (#492)
// and writes to disk; this suite is about the in-process bus arm.
vi.mock("../../clients/recent-touches.js", () => ({
	appendRecentTouches: vi.fn().mockResolvedValue(undefined),
}));

/**
 * Every path is "relevant" here. The read/edit-history filter is the nudge
 * module's own concern (agent-nudge.test.ts covers it); admitting everything
 * keeps these cases about the attachment decision alone.
 */
const alwaysRelevantGuard = {
	getReadHistory: () => [{}],
	getEditHistory: () => [],
	recordRead: () => {},
	recordWritten: () => {},
} as unknown as ReadGuard;

function wireBus() {
	const handlers: Array<(data: unknown) => void> = [];
	const bus = {
		on: (_channel: string, handler: (data: unknown) => void) => {
			handlers.push(handler);
			return () => {};
		},
		emit: (_channel: string, data: unknown) => {
			for (const handler of handlers) handler(data);
		},
	};
	wireAgentNudgeSubscriber({
		events: bus,
		getReadGuard: () => alwaysRelevantGuard,
	});
	wireBusEmitter((channel, data) => {
		bus.emit(channel, data);
	});
}

function toolDeps(runtime: RuntimeCoordinator) {
	return {
		getFlag: () => false,
		dbg: () => {},
		runtime,
		cacheManager: { addModifiedRange: () => {}, readTurnState: () => ({}) },
		biomeClient: {},
		ruffClient: {},
		resetLSPService: () => {},
		agentBehaviorRecord: () => [],
		formatBehaviorWarnings: () => "",
		readGuard: alwaysRelevantGuard,
	} as unknown as Parameters<typeof handleToolResult>[0];
}

/**
 * Stand in for the real pipeline's immediate-autofix arm: publish the touch
 * where `clients/pipeline.ts` publishes it (inside `runPipeline`, before the
 * attachment decision runs), and hand back the same `postMutation` shape.
 */
function mockPipelineAutofix(
	cwd: string,
	content: (filePath: string) => string,
) {
	return async (ctx: { filePath: string; autofixMode?: string }) => {
		const absolute = path.resolve(ctx.filePath);
		const immediate = ctx.autofixMode !== "deferred";
		if (immediate) {
			publishFilesTouched({ reason: "autofix", paths: [absolute], cwd });
		}
		return {
			output: "",
			hasBlockers: false,
			isError: false,
			fileModified: immediate,
			changedFiles: immediate ? [absolute] : [],
			postMutation: immediate
				? { filePath: absolute, content: content(absolute), source: "autofix" }
				: undefined,
		};
	};
}

describe("#1464 write-path autofix nudge suppression", () => {
	beforeEach(async () => {
		const { runPipeline } = await import("../../clients/pipeline.js");
		vi.mocked(runPipeline).mockReset();
		_resetAgentNudgeForTests();
		resetBusPublish();
		wireBus();
	});

	afterEach(() => {
		_resetAgentNudgeForTests();
		resetBusPublish();
	});

	it("a write whose post-fix content was attached produces no nudge entry for that path", async () => {
		const { runPipeline } = await import("../../clients/pipeline.js");
		const env = setupTestEnvironment("pi-lens-1464-attached-");
		try {
			const filePath = createTempFile(
				env.tmpDir,
				"src/app.ts",
				"const a = 1;\n",
			);
			vi.mocked(runPipeline).mockImplementation(
				mockPipelineAutofix(env.tmpDir, (p) =>
					fs.readFileSync(p, "utf-8"),
				) as never,
			);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;

			const returned = await handleToolResult({
				...toolDeps(runtime),
				event: { toolName: "write", input: { path: filePath }, content: [] },
			} as never);

			expect(
				returned?.content.some((part) =>
					part.text?.startsWith("pi-lens applied autofix to"),
				),
			).toBe(true);
			expect(consumeAgentNudge()).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});

	it("a write whose attachment was size-capped still nudges", async () => {
		const { runPipeline } = await import("../../clients/pipeline.js");
		const env = setupTestEnvironment("pi-lens-1464-size-capped-");
		try {
			const filePath = createTempFile(env.tmpDir, "src/big.ts", "x\n");
			const oversized = "x".repeat(2 * 1024 * 1024 + 1);
			vi.mocked(runPipeline).mockImplementation(
				mockPipelineAutofix(env.tmpDir, () => oversized) as never,
			);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;

			const returned = await handleToolResult({
				...toolDeps(runtime),
				event: { toolName: "write", input: { path: filePath }, content: [] },
			} as never);

			expect(returned?.content.at(-1)?.text).toContain("too large to attach");
			const nudge = consumeAgentNudge();
			expect(nudge).toBeDefined();
			expect(nudge?.messages[0].content).toContain("big.ts");
		} finally {
			env.cleanup();
		}
	});

	it("a multi-file bash write nudges only for the path the aggregate budget degraded", async () => {
		const { runPipeline } = await import("../../clients/pipeline.js");
		const env = setupTestEnvironment("pi-lens-1464-aggregate-");
		try {
			// Each file fits the 2 MiB per-attachment cap alone; the pair does not,
			// so the second degrades to the re-read warning and must keep nudging
			// even though its own per-file decision said "attached".
			const bigContent = "x".repeat(1.5 * 1024 * 1024);
			const fileA = createTempFile(env.tmpDir, "agg-a.ts", "x\n");
			const fileB = createTempFile(env.tmpDir, "agg-b.ts", "x\n");
			vi.mocked(runPipeline).mockImplementation(
				mockPipelineAutofix(env.tmpDir, () => bigContent) as never,
			);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;

			const returned = await handleToolResult({
				...toolDeps(runtime),
				event: {
					toolName: "bash",
					input: { command: `echo x > "${fileA}"; echo x > "${fileB}"` },
					content: [],
				},
			} as never);

			expect(
				returned?.content.filter((part) =>
					part.text?.startsWith("pi-lens applied autofix to"),
				),
			).toHaveLength(1);
			const nudge = consumeAgentNudge();
			expect(nudge).toBeDefined();
			expect(nudge?.messages[0].content).toContain("1 file(s)");
			expect(nudge?.messages[0].content).toContain("agg-b.ts");
			expect(nudge?.messages[0].content).not.toContain("agg-a.ts");
		} finally {
			env.cleanup();
		}
	});

	it("deferred edit autofix keeps nudging — that path attaches nothing", async () => {
		const { runPipeline } = await import("../../clients/pipeline.js");
		const env = setupTestEnvironment("pi-lens-1464-deferred-");
		try {
			const filePath = createTempFile(
				env.tmpDir,
				"src/later.ts",
				"const a = 1;\n",
			);
			vi.mocked(runPipeline).mockImplementation(
				mockPipelineAutofix(env.tmpDir, () => "unused") as never,
			);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;

			const returned = await handleToolResult({
				...toolDeps(runtime),
				event: { toolName: "edit", input: { path: filePath }, content: [] },
			} as never);
			expect(vi.mocked(runPipeline).mock.calls[0][0].autofixMode).toBe(
				"deferred",
			);
			expect(
				returned?.content?.some((part) =>
					part.text?.startsWith("pi-lens applied autofix to"),
				) ?? false,
			).toBe(false);

			// runtime-agent-end.ts publishes the deferred autofix batch itself,
			// long after the tool result the agent already consumed.
			publishFilesTouched({
				reason: "autofix",
				paths: [path.resolve(filePath)],
				cwd: env.tmpDir,
			});

			const nudge = consumeAgentNudge();
			expect(nudge).toBeDefined();
			expect(nudge?.messages[0].content).toContain("later.ts");
			expect(nudge?.messages[0].content).toContain("re-read before editing");
		} finally {
			env.cleanup();
		}
	});
});
