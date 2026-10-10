/**
 * #2939 M7 — `signal: deps.ctx.signal` on the `tool_call` complexity-baseline
 * bootstrap demand.
 *
 * Recurrence prevented: #2523 AC4. The ambient abort slot is published by
 * `tool_result`, AFTER this hook has already run, so at `tool_call` the hook's
 * own `ctx.signal` is the only live signal there is. Without it forwarded, a
 * user who presses Escape while the analyzer graph is still loading waits the
 * demand's whole `BOOTSTRAP_LOAD_TIMEOUT_MS` out before the tool call returns —
 * and the cancel then reaches the ledger as a `timeout`, which is exactly the
 * inversion `requestBootstrapClients`'s `unavailableReason !== "aborted"` guard
 * exists to prevent.
 *
 * PR #3411 round 1 DELETED this forwarding because the file's existing 26 cases
 * stayed green under the deletion: none of them drives the hook with an aborted
 * `ctx.signal` and a load still in flight. This case does, and reds.
 *
 * The bootstrap module is the shared production-faithful `bootstrapSeamMock`,
 * whose `requestBootstrapClients` consumes the caller's signal the way
 * production's `bounded()` does; its load is given a real (faked) delay so
 * "released by the signal" and "waited the load out" are two different
 * observable moments rather than one hang. Everything else — the runtime
 * coordinator, the cache manager, the baseline map — is real.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The analyzer-bootstrap load, held open until a case releases it. No timer:
 * the point is a load still IN FLIGHT when the caller aborts, and a raw
 * raw timer wait would be a new `raw-timer-wait` population entry for a wait
 * this file does not actually need.
 */
const pendingLoad = vi.hoisted(() => ({
	resolve: undefined as ((clients: unknown) => void) | undefined,
}));

const LOADED_CLIENTS = {
	complexityClient: {
		isSupportedFile: () => true,
		analyzeFile: async () => ({
			maintainabilityIndex: 70,
			cognitiveComplexity: 1,
			maxNestingDepth: 1,
			linesOfCode: 1,
			maxCyclomaticComplexity: 1,
			codeEntropy: 0,
		}),
	},
	biomeClient: {},
	ruffClient: {},
	metricsClient: {},
};

// Partial mock (#2281 sweep): every real export stays, only the two accessors
// `handleToolCall` reaches for are replaced, so nothing here spins up a real
// LSP client for an auto-touch this case does not measure.
vi.mock("../../clients/lsp/capabilities.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/lsp/capabilities.js")>();
	const { makeLspServiceDouble } =
		await import("../support/lsp-service-double.js");
	return {
		...actual,
		getLSPService: () => makeLspServiceDouble({}),
		resetLSPService: () => {},
	};
});

vi.mock("../../clients/bootstrap.js", async () => {
	const { bootstrapSeamMock } = await import("../support/bootstrap-mock.js");
	return bootstrapSeamMock(
		() =>
			new Promise((resolve) => {
				pendingLoad.resolve = resolve;
			}),
	);
});

import { CacheManager } from "../../clients/cache-manager.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { handleToolCall } from "../../clients/runtime-tool-call.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";
import { runHandlerExpectingNoThrow } from "../support/handler-verdict.js";

let env: ReturnType<typeof setupTestEnvironment>;
let runtime: RuntimeCoordinator;
let filePath: string;

beforeEach(() => {
	pendingLoad.resolve = undefined;
	env = setupTestEnvironment("pi-lens-2939-escape-");
	runtime = new RuntimeCoordinator();
	runtime.projectRoot = env.tmpDir;
	filePath = createTempFile(
		env.tmpDir,
		"baselined.ts",
		"export const a = 1;\n",
	);
});

afterEach(() => {
	vi.useRealTimers();
	env.cleanup();
});

function deps(signal: AbortSignal) {
	return {
		event: { toolName: "read", input: { path: filePath } },
		ctx: { signal, cwd: env.tmpDir },
		lensEnabled: true,
		getFlag: () => false,
		dbg: () => {},
		runtime,
		cacheManager: new CacheManager(false),
		ensureLSPConfigInitialized: async () => {},
		updateLspStatus: () => {},
		resetLSPService: () => {},
	} as unknown as Parameters<typeof handleToolCall>[0];
}

describe("#2939 M7 — Escape releases the complexity-baseline demand", () => {
	it("returns without waiting the bootstrap load out when the hook signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		// Fake timers only as a deterministic microtask/timer pump; no wall clock
		// is spent and no timer is armed by this file.
		vi.useFakeTimers();

		let settled = false;
		const call = runHandlerExpectingNoThrow(() =>
			handleToolCall(deps(controller.signal)),
		).then(() => {
			settled = true;
		});
		await vi.advanceTimersByTimeAsync(0);

		// Nothing has released the load, and the hook is already done: the
		// aborted signal reached the demand, which failed open at once. (The
		// shared double answers null before even starting the load; production
		// starts it and abandons the wait — either way the wait is released by
		// the signal, which is the axis under test.)
		expect(settled).toBe(true);
		expect(runtime.complexityBaselines.size).toBe(0);

		// Let the abandoned load settle so nothing dangles into the next case.
		pendingLoad.resolve?.(LOADED_CLIENTS);
		await call;
	});

	it("still takes the baseline when the hook signal is live", async () => {
		// The inverse direction: a live signal must not short-circuit the demand.
		vi.useFakeTimers();
		const call = runHandlerExpectingNoThrow(() =>
			handleToolCall(deps(new AbortController().signal)),
		);
		await vi.advanceTimersByTimeAsync(0);
		pendingLoad.resolve?.(LOADED_CLIENTS);
		await call;

		expect(runtime.complexityBaselines.size).toBe(1);
	});
});
