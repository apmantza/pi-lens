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
 * until a case releases it; the baseline capture is held the same way in the
 * second case. The coordinator, its scope and the store are real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

/** When set, the next baseline capture waits for `release`. */
const heldCapture: {
	hold: boolean;
	started?: () => void;
	release?: () => void;
} = { hold: false };

vi.mock(
	"../../clients/metrics/complexity-baseline.js",
	async (importActual) => {
		const actual =
			await importActual<
				typeof import("../../clients/metrics/complexity-baseline.js")
			>();
		return {
			...actual,
			captureComplexityBaseline: async (
				...args: Parameters<typeof actual.captureComplexityBaseline>
			) => {
				if (heldCapture.hold) {
					await new Promise<void>((resolve) => {
						heldCapture.release = resolve;
						heldCapture.started?.();
					});
				}
				return actual.captureComplexityBaseline(...args);
			},
		};
	},
);

import { CacheManager } from "../../clients/cache-manager.js";
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

	it("drops a baseline whose capture finishes after the session was replaced", async () => {
		heldCapture.hold = true;
		const captureStarted = new Promise<void>((resolve) => {
			heldCapture.started = resolve;
		});
		const call = runHandlerExpectingNoThrow(() => handleToolCall(deps()));
		await captureStarted;
		runtime.resetForSession();
		heldCapture.release?.();
		pendingLoad.onStart = () => pendingLoad.resolve?.(LOADED_CLIENTS);
		if (pendingLoad.resolve) pendingLoad.resolve(LOADED_CLIENTS);
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
});
