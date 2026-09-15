import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CacheManager } from "../../clients/cache-manager.js";
import {
	MUTATION_BRIDGE_KEY,
	registerMutationBridge,
} from "../../clients/mutation-bridge.js";
import { countFileLines } from "../../clients/read-guard-tool-lines.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { handleToolCall } from "../../clients/runtime-tool-call.js";
import { handleToolResult } from "../../clients/runtime-tool-result.js";
import {
	clearLatencyReports,
	getLatencyReports,
} from "../../clients/dispatch/integration.js";
import { setupTestEnvironment } from "./test-utils.js";

const SOURCE = "const value = 1;\n";

const spawnState = vi.hoisted(() => ({
	releaseSpawn: undefined as (() => void) | undefined,
	spawnStarted: undefined as (() => void) | undefined,
	spawnCalls: 0,
}));
let liveRuntime: RuntimeCoordinator | undefined;
let liveCacheManager: CacheManager | undefined;
let liveRoot = "";

vi.mock("../../clients/safe-spawn.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/safe-spawn.js")>();
	return {
		...actual,
		safeSpawnAsync: vi.fn(
			async (...args: Parameters<typeof actual.safeSpawnAsync>) => {
				spawnState.spawnCalls += 1;
				spawnState.spawnStarted?.();
				if (spawnState.releaseSpawn && spawnState.spawnCalls === 1)
					await new Promise<void>(
						(resolve) => (spawnState.releaseSpawn = resolve),
					);
				return actual.safeSpawnAsync(...args);
			},
		),
	};
});

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

function deps(
	event: Record<string, unknown>,
	runtime: RuntimeCoordinator,
	cacheManager: CacheManager,
): Parameters<typeof handleToolResult>[0] {
	return {
		event,
		getFlag: (name: string) =>
			name === "no-lsp" || name === "no-autoformat" || name === "no-autofix",
		dbg: () => {},
		runtime,
		cacheManager,
		biomeClient: {},
		ruffClient: {},
		metricsClient: {},
		resetLSPService: () => {},
		agentBehaviorRecord: () => [],
		formatBehaviorWarnings: () => "",
	} as unknown as Parameters<typeof handleToolResult>[0];
}

function callDeps(
	event: Record<string, unknown>,
	cwd: string,
	runtime: RuntimeCoordinator,
	cacheManager: CacheManager,
): Parameters<typeof handleToolCall>[0] {
	return {
		event,
		ctx: { cwd },
		lensEnabled: true,
		getFlag: (name: string) => name === "no-lsp",
		dbg: () => {},
		runtime,
		cacheManager,
		ensureLSPConfigInitialized: async () => {},
		updateLspStatus: () => {},
		resetLSPService: () => {},
	} as unknown as Parameters<typeof handleToolCall>[0];
}

function event(filePath: string): Record<string, unknown> {
	return {
		toolName: "patch_file",
		toolCallId: "call-2499-real-pipeline",
		input: { path: filePath, patch: "@@ -1 +1 @@" },
		content: [{ type: "text", text: "patched" }],
	};
}

async function waitForSpawn(): Promise<void> {
	if (spawnState.spawnCalls > 0) return;
	await new Promise<void>((resolve) => {
		spawnState.spawnStarted = resolve;
	});
	spawnState.spawnStarted = undefined;
}

describe("#2499 analysed-state latch with the real pipeline", () => {
	beforeEach(() => {
		spawnState.releaseSpawn = undefined;
		spawnState.spawnStarted = undefined;
		spawnState.spawnCalls = 0;
		clearLatencyReports();
	});

	it("records the state analysed before an external runner lets another writer change disk", async () => {
		// Regression #2499: the latch must describe the bytes runPipeline analysed,
		// not a later disk state written by an unrelated process while a host runner
		// is pending. The real runPipeline is used; safeSpawnAsync is mocked only at
		// the external-process boundary to create the genuine analysis window.
		const env = setupTestEnvironment("pi-lens-2499-real-pipeline-");
		const previousHome = process.env.PI_LENS_HOME;
		process.env.PI_LENS_HOME = path.join(env.tmpDir, "home");
		try {
			const filePath = path.join(env.tmpDir, "latch.py");
			fs.writeFileSync(filePath, SOURCE);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setTelemetryIdentity({ sessionId: "s-2499" });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);
			liveRuntime = runtime;
			liveCacheManager = cacheManager;
			liveRoot = env.tmpDir;
			const firstEvent = event(filePath);

			await handleToolCall(
				callDeps(firstEvent, env.tmpDir, runtime, cacheManager),
			);
			fs.writeFileSync(filePath, `${SOURCE}# analysed-state\n`);

			spawnState.releaseSpawn = () => {};
			const first = handleToolResult(deps(firstEvent, runtime, cacheManager));
			await waitForSpawn();

			// The real pipeline has read and is analysing S1. A third party now writes S2.
			fs.writeFileSync(filePath, `${SOURCE}# post-pipeline-disk\n`);
			spawnState.releaseSpawn?.();
			await first;
			const reportsAfterFirst = getLatencyReports().filter(
				(report) => report.filePath === filePath,
			).length;

			// S2 differs from S1. The second real pipeline must run; pre-fix code
			// incorrectly stamped S2 for the first run and skipped this dispatch.
			spawnState.releaseSpawn = undefined;
			await handleToolResult(deps(firstEvent, runtime, cacheManager));
			expect(
				getLatencyReports().filter((report) => report.filePath === filePath)
					.length,
			).toBeGreaterThan(reportsAfterFirst);
		} finally {
			spawnState.releaseSpawn = undefined;
			if (previousHome === undefined) delete process.env.PI_LENS_HOME;
			else process.env.PI_LENS_HOME = previousHome;
			env.cleanup();
		}
	}, 30000);
});
