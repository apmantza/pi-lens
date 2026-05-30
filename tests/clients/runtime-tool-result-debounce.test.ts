import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CacheManager } from "../../clients/cache-manager.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import {
	flushDebouncedToolResults,
	handleToolResult,
} from "../../clients/runtime-tool-result.js";
import { setupTestEnvironment } from "./test-utils.js";

vi.mock("../../clients/pipeline.js", () => ({
	runPipeline: vi.fn(),
}));

let previousDebounceEnv: string | undefined;

function makeDeps(
	filePath: string,
	runtime: RuntimeCoordinator,
	cacheManager: CacheManager,
	overrides: Partial<Parameters<typeof handleToolResult>[0]> = {},
): Parameters<typeof handleToolResult>[0] {
	return {
		event: {
			toolName: "edit",
			input: { path: filePath },
			details: {},
			content: [{ type: "text", text: "base" }],
		},
		getFlag: () => false,
		dbg: () => {},
		runtime,
		cacheManager,
		biomeClient: {},
		ruffClient: {},
		testRunnerClient: {},
		metricsClient: {},
		resetLSPService: () => {},
		agentBehaviorRecord: () => [],
		formatBehaviorWarnings: () => "",
		...overrides,
	} as Parameters<typeof handleToolResult>[0];
}

describe("tool_result debounce (#115)", () => {
	beforeEach(async () => {
		previousDebounceEnv = process.env.PI_LENS_TOOL_RESULT_DEBOUNCE_MS;
		const pipeline = await import("../../clients/pipeline.js");
		vi.mocked(pipeline.runPipeline).mockReset();
		vi.mocked(pipeline.runPipeline).mockResolvedValue({
			output: "✓ no blockers",
			hasBlockers: false,
			isError: false,
			fileModified: false,
		});
	});

	afterEach(async () => {
		// Always flush so a hung debounce timer doesn't leak across tests.
		await flushDebouncedToolResults();
		if (previousDebounceEnv === undefined) {
			delete process.env.PI_LENS_TOOL_RESULT_DEBOUNCE_MS;
		} else {
			process.env.PI_LENS_TOOL_RESULT_DEBOUNCE_MS = previousDebounceEnv;
		}
	});

	it("coalesces two back-to-back tool_results within the window into one pipeline run", async () => {
		process.env.PI_LENS_TOOL_RESULT_DEBOUNCE_MS = "150";
		const env = setupTestEnvironment("pi-lens-debounce-coalesce-");
		try {
			const filePath = path.join(env.tmpDir, "a.ts");
			fs.writeFileSync(filePath, "export const x = 1;\n");
			const cacheManager = new CacheManager(false);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setTelemetryIdentity({ sessionId: "debounce-coalesce" });
			runtime.beginTurn();

			const first = handleToolResult(makeDeps(filePath, runtime, cacheManager));
			// Mutate file to change state before the second call.
			fs.writeFileSync(filePath, "export const x = 2;\n");
			const second = handleToolResult(makeDeps(filePath, runtime, cacheManager));

			await Promise.all([first, second]);

			const { runPipeline } = await import("../../clients/pipeline.js");
			expect(vi.mocked(runPipeline)).toHaveBeenCalledTimes(1);
		} finally {
			env.cleanup();
		}
	});

	it("runs both pipelines when calls are spaced beyond the window", async () => {
		process.env.PI_LENS_TOOL_RESULT_DEBOUNCE_MS = "60";
		const env = setupTestEnvironment("pi-lens-debounce-spaced-");
		try {
			const filePath = path.join(env.tmpDir, "a.ts");
			fs.writeFileSync(filePath, "export const x = 1;\n");
			const cacheManager = new CacheManager(false);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setTelemetryIdentity({ sessionId: "debounce-spaced" });
			runtime.beginTurn();

			await handleToolResult(makeDeps(filePath, runtime, cacheManager));
			// Wait beyond the debounce window so the second call schedules a fresh run.
			await new Promise((resolve) => setTimeout(resolve, 120));
			fs.writeFileSync(filePath, "export const x = 2;\n");
			await handleToolResult(makeDeps(filePath, runtime, cacheManager));

			const { runPipeline } = await import("../../clients/pipeline.js");
			expect(vi.mocked(runPipeline)).toHaveBeenCalledTimes(2);
		} finally {
			env.cleanup();
		}
	});

	it("flushDebouncedToolResults forces a pending pipeline to run immediately", async () => {
		process.env.PI_LENS_TOOL_RESULT_DEBOUNCE_MS = "5000";
		const env = setupTestEnvironment("pi-lens-debounce-flush-");
		try {
			const filePath = path.join(env.tmpDir, "a.ts");
			fs.writeFileSync(filePath, "export const x = 1;\n");
			const cacheManager = new CacheManager(false);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setTelemetryIdentity({ sessionId: "debounce-flush" });
			runtime.beginTurn();

			const pending = handleToolResult(makeDeps(filePath, runtime, cacheManager));
			// Without the flush, the 5s debounce would keep the pipeline pending.
			await flushDebouncedToolResults();
			await pending;

			const { runPipeline } = await import("../../clients/pipeline.js");
			expect(vi.mocked(runPipeline)).toHaveBeenCalledTimes(1);
		} finally {
			env.cleanup();
		}
	});

	it("runs immediately when the debounce env var is unset or zero", async () => {
		delete process.env.PI_LENS_TOOL_RESULT_DEBOUNCE_MS;
		const env = setupTestEnvironment("pi-lens-debounce-disabled-");
		try {
			const filePath = path.join(env.tmpDir, "a.ts");
			fs.writeFileSync(filePath, "export const x = 1;\n");
			const cacheManager = new CacheManager(false);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setTelemetryIdentity({ sessionId: "debounce-disabled" });
			runtime.beginTurn();

			await handleToolResult(makeDeps(filePath, runtime, cacheManager));

			const { runPipeline } = await import("../../clients/pipeline.js");
			expect(vi.mocked(runPipeline)).toHaveBeenCalledTimes(1);

			// Explicit 0 behaves the same as unset.
			process.env.PI_LENS_TOOL_RESULT_DEBOUNCE_MS = "0";
			fs.writeFileSync(filePath, "export const x = 2;\n");
			await handleToolResult(makeDeps(filePath, runtime, cacheManager));
			expect(vi.mocked(runPipeline)).toHaveBeenCalledTimes(2);
		} finally {
			env.cleanup();
		}
	});

	it("rejects non-numeric / negative env values and falls back to disabled", async () => {
		process.env.PI_LENS_TOOL_RESULT_DEBOUNCE_MS = "not-a-number";
		const env = setupTestEnvironment("pi-lens-debounce-bogus-env-");
		try {
			const filePath = path.join(env.tmpDir, "a.ts");
			fs.writeFileSync(filePath, "export const x = 1;\n");
			const cacheManager = new CacheManager(false);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setTelemetryIdentity({ sessionId: "debounce-bogus" });
			runtime.beginTurn();

			await handleToolResult(makeDeps(filePath, runtime, cacheManager));
			const { runPipeline } = await import("../../clients/pipeline.js");
			expect(vi.mocked(runPipeline)).toHaveBeenCalledTimes(1);
		} finally {
			env.cleanup();
		}
	});
});
