// flake-shape: in-process-mock — the analyzer bootstrap (the shared seam double), its analysis and the metrics-history writer are held open so a session replacement can land inside each await; the coordinator, its scope and the store are real.
/**
 * #4220 / #5087 S2a: the `tool_call` complexity baseline is written in the
 * session that took it, or not at all.
 *
 * Recurrence prevented: #4220. `handleToolCallImpl` added the file to
 * `runtime.complexityBaselines`, and recorded its metrics-history snapshot,
 * after the analyzer-bootstrap and analysis awaits, with no captured session
 * scope. A `/new` that landed inside those awaits retired the session, the
 * successor's `session_start` cleared the store, and the late write then put
 * the old session's file into the successor's store: the successor never took
 * its own baseline for that file.
 *
 * The bootstrap module is the shared `bootstrapSeamMock`, its load held open
 * until a case releases it; the analysis the baseline is taken from is held
 * the same way in the second case, and the LSP config init in the third. The
 * coordinator, its scope and the store are real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NamedFunctionMetrics } from "../../clients/metrics/function-metrics.js";

const pendingLoad: {
	resolve?: (value: unknown) => void;
	onStart?: () => void;
} = {};

function loadStarted(): Promise<void> {
	if (pendingLoad.resolve) return Promise.resolve();
	return new Promise((resolve) => {
		pendingLoad.onStart = resolve;
	});
}

/** When set, the next analysis waits for `release`. */
const heldCapture: {
	hold: boolean;
	started?: () => void;
	release?: () => void;
} = { hold: false };

const LOADED_CLIENTS = {
	complexityClient: {
		isSupportedFile: () => true,
		analyzeFile: async () => {
			if (heldCapture.hold) {
				await new Promise<void>((resolve) => {
					heldCapture.release = resolve;
					heldCapture.started?.();
				});
			}
			return ANALYSIS;
		},
	},
	biomeClient: {},
	ruffClient: {},
};

const ANALYSIS = {
	maintainabilityIndex: 70,
	cognitiveComplexity: 1,
	maxNestingDepth: 1,
	linesOfCode: 1,
	maxCyclomaticComplexity: 1,
	codeEntropy: 0,
	measuredFunctions: [] as NamedFunctionMetrics[],
};

vi.mock("../../clients/bootstrap.js", async () => {
	const { bootstrapSeamMock } = await import("../support/bootstrap-mock.js");
	return bootstrapSeamMock(
		() =>
			new Promise((resolve) => {
				pendingLoad.resolve = resolve;
				pendingLoad.onStart?.();
			}),
	);
});

const snapshots: string[] = [];
vi.mock("../../clients/metrics-history.js", () => ({
	captureSnapshot: (filePath: string) => {
		snapshots.push(filePath);
	},
}));

import { CacheManager } from "../../clients/cache-manager.js";
import { complexityBaselineKey } from "../../clients/metrics/complexity-baseline.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { handleToolCall } from "../../clients/runtime-tool-call.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";
import { runHandlerExpectingNoThrow } from "../support/handler-verdict.js";
import { installLspServiceDouble } from "../support/lsp-service-seam.js";

let env: ReturnType<typeof setupTestEnvironment>;
let runtime: RuntimeCoordinator;
let filePath: string;

beforeEach(async () => {
	await installLspServiceDouble();
	pendingLoad.resolve = undefined;
	pendingLoad.onStart = undefined;
	heldCapture.hold = false;
	heldCapture.started = undefined;
	heldCapture.release = undefined;
	snapshots.length = 0;
	env = setupTestEnvironment("pi-lens-4220-scope-");
	runtime = new RuntimeCoordinator();
	runtime.projectRoot = env.tmpDir;
	filePath = createTempFile(
		env.tmpDir,
		"scoped.ts",
		"export function f(a: number) {\n\treturn a > 0 ? a : -a;\n}\n",
	);
});

afterEach(() => {
	env.cleanup();
});

function deps() {
	return {
		event: { toolName: "read", input: { path: filePath } },
		ctx: { signal: new AbortController().signal, cwd: env.tmpDir },
		lensEnabled: true,
		getFlag: () => false,
		dbg: () => {},
		runtime,
		cacheManager: new CacheManager(false),
		ensureLSPConfigInitialized: async () => {},
		updateLspStatus: () => {},
	} as unknown as Parameters<typeof handleToolCall>[0];
}

describe("#4220 — the tool_call complexity baseline stays in its own session", () => {
	it("writes nothing into the successor when the session is replaced during the analyzer load", async () => {
		const call = runHandlerExpectingNoThrow(() => handleToolCall(deps()));
		await loadStarted();
		// `/new`: the successor's session_start retires the scope and clears
		// the store (runtime-session.ts and resetForSession both do).
		runtime.resetForSession();
		pendingLoad.resolve?.(LOADED_CLIENTS);
		await call;

		expect(runtime.complexityBaselines.size).toBe(0);
		expect(snapshots).toEqual([]);
	});

	it("drops a baseline whose analysis finishes after the session was replaced", async () => {
		heldCapture.hold = true;
		const captureStarted = new Promise<void>((resolve) => {
			heldCapture.started = resolve;
		});
		pendingLoad.onStart = () => pendingLoad.resolve?.(LOADED_CLIENTS);
		const call = runHandlerExpectingNoThrow(() => handleToolCall(deps()));
		await captureStarted;
		runtime.resetForSession();
		heldCapture.release?.();
		await call;

		expect(runtime.complexityBaselines.size).toBe(0);
		expect(snapshots).toEqual([]);
	});

	it("writes nothing into the successor when the session is replaced during the LSP config init", async () => {
		// #5443 review F5: `ensureLSPConfigInitialized` is awaited on every
		// tool_call without --no-lsp, long before the baseline block. A handle
		// captured at the block named the successor, so the old session's file
		// landed in the successor's store.
		let initStarted: () => void = () => {};
		const started = new Promise<void>((resolve) => {
			initStarted = resolve;
		});
		let releaseInit: () => void = () => {};
		const held = {
			...deps(),
			ensureLSPConfigInitialized: () =>
				new Promise<void>((resolve) => {
					releaseInit = resolve;
					initStarted();
				}),
		};
		pendingLoad.onStart = () => pendingLoad.resolve?.(LOADED_CLIENTS);
		const call = runHandlerExpectingNoThrow(() => handleToolCall(held));
		await started;
		runtime.resetForSession();
		releaseInit();
		await call;

		expect(runtime.complexityBaselines.size).toBe(0);
		expect(snapshots).toEqual([]);
	});

	it("keeps the baseline in a session that stays live", async () => {
		const call = runHandlerExpectingNoThrow(() => handleToolCall(deps()));
		await loadStarted();
		pendingLoad.resolve?.(LOADED_CLIENTS);
		await call;

		expect(runtime.complexityBaselines.size).toBe(1);
		expect(snapshots).toEqual([filePath]);
	});

	it("takes the first-touch table from the analysis, not from a second measure of the file", async () => {
		// #5443 review F6: the first touch measured the file twice, once for
		// the table and once in `analyzeFile` (12k lines: 356 -> 536-600 ms).
		// The file on disk declares `f`; the analysis names `measured`, so only
		// a table taken from the analysis holds `measured` and not `f`.
		const measured: NamedFunctionMetrics = {
			name: "measured",
			key: "measured",
			line: 1,
			endLine: 3,
			cyclomatic: 7,
			cognitive: 4,
			nesting: 2,
			length: 3,
			parameters: 1,
		};
		ANALYSIS.measuredFunctions = [measured];
		try {
			pendingLoad.onStart = () => pendingLoad.resolve?.(LOADED_CLIENTS);
			await runHandlerExpectingNoThrow(() => handleToolCall(deps()));
		} finally {
			ANALYSIS.measuredFunctions = [];
		}

		const held = runtime.complexityBaselines.get(
			complexityBaselineKey(filePath),
		);
		expect([...(held?.last?.entries() ?? [])]).toEqual([
			["measured", { name: "measured", cyclomatic: 7, nesting: 2 }],
		]);
	});
});
