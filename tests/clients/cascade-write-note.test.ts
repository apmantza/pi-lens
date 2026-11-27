/**
 * #5812 round 4 (CodeRabbit F2): a write that records its turn-state range
 * and never reaches a dispatch must not leave an earlier write's language
 * server answer standing. The turn end's settle read that stale answer as
 * covering the file and forgot the neighbour's pending cascade error.
 *
 * Real: the observed-mutation arm, `handleToolResult`, the mutation bridge, the
 * `CacheManager` worklist, `handleTurnEnd` and the cascade pending store.
 * Doubled: `runPipeline` (the pipeline's verdict), and the bootstrap demand,
 * which a case fails to stand for analyzer clients that are not ready.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CacheManager } from "../../clients/cache-manager.js";
import {
	forgetCascadePendingNeighbor,
	listCascadePendingNeighbors,
	noteCascadeWrite,
	recordDeliveredCascadeNeighbor,
} from "../../clients/cascade-format.js";
import { countFileLines } from "../../clients/read-guard-tool-lines.js";
import {
	MUTATION_BRIDGE_KEY,
	registerMutationBridge,
} from "../../clients/mutation-bridge.js";
import { resetMutationAttribution } from "../../clients/mutation-attribution.js";
import {
	armObservedMutation,
	resetObservedMutationNet,
} from "../../clients/observed-mutation.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { handleToolResult } from "../../clients/runtime-tool-result.js";
import { handleTurnEnd } from "../../clients/runtime-turn.js";
import { installLspServiceDouble } from "../support/lsp-service-seam.js";
import { setupTestEnvironment } from "./test-utils.js";

const requestBootstrapClients = vi.hoisted(() => vi.fn());
vi.mock("../../clients/bootstrap.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/bootstrap.js")>();
	requestBootstrapClients.mockImplementation(actual.requestBootstrapClients);
	return { ...actual, requestBootstrapClients };
});

vi.mock("../../clients/pipeline.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/pipeline.js")>()),
	runPipeline: vi.fn(async () => ({
		output: "",
		hasBlockers: false,
		isError: false,
		fileModified: false,
	})),
}));

/** The bridge is a process-global singleton, mounted once per test file. */
let liveRuntime: RuntimeCoordinator | undefined;
let liveCacheManager: CacheManager | undefined;
let liveRoot = "";
if (!(MUTATION_BRIDGE_KEY in (globalThis as object))) {
	registerMutationBridge({
		getRuntime: () => liveRuntime as never,
		getCacheManager: () => liveCacheManager as never,
		getProjectRoot: () => liveRoot,
		getDispatchCwd: () => liveRoot,
		countFileLines,
		isRecordable: () => true,
		dbg: () => {},
	});
}

const EMPTY_KNIP_RESULT = {
	success: true,
	issues: [],
	unusedExports: [],
	unusedFiles: [],
	unusedDeps: [],
	unlistedDeps: [],
	summary: "",
};

let env: ReturnType<typeof setupTestEnvironment>;
let previousDataDir: string | undefined;
let neighbour = "";

beforeEach(async () => {
	await installLspServiceDouble();
	resetObservedMutationNet();
	resetMutationAttribution();
	requestBootstrapClients.mockClear();
	env = setupTestEnvironment("pi-lens-5812-write-note-");
	previousDataDir = process.env.PILENS_DATA_DIR;
	process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
	neighbour = path.join(env.tmpDir, "n1.ts");
	fs.writeFileSync(neighbour, "export const n = 1;\n");
});

afterEach(() => {
	forgetCascadePendingNeighbor(neighbour);
	noteCascadeWrite(neighbour, []);
	if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
	else process.env.PILENS_DATA_DIR = previousDataDir;
	env.cleanup();
});

function newSession(): {
	runtime: RuntimeCoordinator;
	cacheManager: CacheManager;
} {
	const cacheManager = new CacheManager(false);
	const runtime = new RuntimeCoordinator();
	runtime.projectRoot = env.tmpDir;
	runtime.setTelemetryIdentity({ sessionId: "s-5812" });
	runtime.beginTurn();
	liveRuntime = runtime;
	liveCacheManager = cacheManager;
	liveRoot = env.tmpDir;
	return { runtime, cacheManager };
}

/**
 * An earlier write of the neighbour that a language server answered (its
 * applied verdict's note), then the error a later turn end delivered for it.
 */
function answeredThenPending(): void {
	noteCascadeWrite(neighbour, ["lsp"]);
	recordDeliveredCascadeNeighbor(
		neighbour,
		[
			{
				id: "ts:2304",
				message: "Cannot find name 'BAD_CALL'.",
				filePath: neighbour,
				line: 1,
				column: 1,
				severity: "error",
				semantic: "blocking",
				tool: "lsp",
			},
		],
		0,
		Date.now() - 60_000,
	);
}

async function turnEnd(
	runtime: RuntimeCoordinator,
	cacheManager: CacheManager,
): Promise<void> {
	await handleTurnEnd({
		ctxCwd: env.tmpDir,
		getFlag: () => false,
		dbg: () => {},
		runtime,
		cacheManager,
		knipClient: {
			ensureAvailable: async () => false,
			analyze: async () => EMPTY_KNIP_RESULT,
		},
		deadCodeClients: [],
		depChecker: { ensureAvailable: async () => false },
		testRunnerClient: { getTestRunTarget: () => null },
		resetLSPService: () => {},
		resetFormatService: () => {},
	} as never);
}

function toolResultDeps(
	event: Record<string, unknown>,
	runtime: RuntimeCoordinator,
	cacheManager: CacheManager,
	clients: boolean,
): Parameters<typeof handleToolResult>[0] {
	return {
		event,
		getFlag: (name: string) => name === "no-lsp",
		dbg: () => {},
		runtime,
		cacheManager,
		...(clients && { biomeClient: {}, ruffClient: {} }),
		resetLSPService: () => {},
		agentBehaviorRecord: () => [],
		formatBehaviorWarnings: () => "",
	} as unknown as Parameters<typeof handleToolResult>[0];
}

const heldErrorCount = () =>
	listCascadePendingNeighbors().find((e) => e.filePath === neighbour)
		?.errorCount;

describe("#5812 F2: a write that never dispatches voids the file's earlier answer", () => {
	it("keeps a neighbour's pending error after a classified write whose clients were not ready", async () => {
		const { runtime, cacheManager } = newSession();
		answeredThenPending();
		requestBootstrapClients.mockResolvedValueOnce(null);
		const content = "export const n = 2;\n";
		fs.writeFileSync(neighbour, content);
		await handleToolResult(
			toolResultDeps(
				{
					toolName: "write",
					input: { path: neighbour, content },
					content: [{ type: "text", text: "wrote" }],
				},
				runtime,
				cacheManager,
				false,
			),
		);
		const { runPipeline } = await import("../../clients/pipeline.js");
		expect(vi.mocked(runPipeline)).not.toHaveBeenCalled();
		expect(
			Object.keys(cacheManager.readTurnState(env.tmpDir).files),
		).toHaveLength(1);
		await turnEnd(runtime, cacheManager);
		expect(heldErrorCount()).toBe(1);
	});

	it("keeps a neighbour's pending error after an observed write whose clients were not ready", async () => {
		const { runtime, cacheManager } = newSession();
		answeredThenPending();
		const event = {
			toolName: "patch_file",
			toolCallId: "call-5812-observed",
			input: { path: neighbour, patch: "@@ -1 +1 @@" },
			content: [{ type: "text", text: "patched" }],
		};
		// The tool_call arm, without the git probe `handleToolCall` would spawn.
		await armObservedMutation({
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			targetPath: neighbour,
			cwd: env.tmpDir,
			sessionGeneration: runtime.sessionGeneration,
			turnIndex: runtime.turnIndex,
		});
		fs.writeFileSync(neighbour, "export const n = 3;\n");
		requestBootstrapClients.mockResolvedValueOnce(null);
		await handleToolResult(toolResultDeps(event, runtime, cacheManager, false));
		const { runPipeline } = await import("../../clients/pipeline.js");
		expect(vi.mocked(runPipeline)).not.toHaveBeenCalled();
		expect(requestBootstrapClients).toHaveBeenCalled();
		expect(
			Object.keys(cacheManager.readTurnState(env.tmpDir).files),
		).toHaveLength(1);
		await turnEnd(runtime, cacheManager);
		expect(heldErrorCount()).toBe(1);
	});

	it("keeps a neighbour's pending error after the pipeline's autofix rewrote it as a side effect", async () => {
		const { runtime, cacheManager } = newSession();
		answeredThenPending();
		const target = path.join(env.tmpDir, "t.ts");
		const content = "export const t = 1;\n";
		fs.writeFileSync(target, content);
		const { runPipeline } = await import("../../clients/pipeline.js");
		vi.mocked(runPipeline).mockImplementationOnce((async () => {
			fs.writeFileSync(neighbour, "export const n = 4;\n");
			return {
				output: "",
				hasBlockers: false,
				isError: false,
				fileModified: false,
				changedFiles: [neighbour],
			};
		}) as never);
		await handleToolResult(
			toolResultDeps(
				{
					toolName: "write",
					input: { path: target, content },
					content: [{ type: "text", text: "wrote" }],
				},
				runtime,
				cacheManager,
				true,
			),
		);
		expect(vi.mocked(runPipeline)).toHaveBeenCalledTimes(1);
		expect(
			Object.keys(cacheManager.readTurnState(env.tmpDir).files),
		).toHaveLength(2);
		await turnEnd(runtime, cacheManager);
		expect(heldErrorCount()).toBe(1);
	});
});
