/**
 * Replays of the `formal/dispatch-pipeline` counterexamples against the real
 * `handleToolResult` + `runPipeline` + `RuntimeCoordinator` + widget store.
 * Only the dispatch runners, the LSP service and the fixer PROCESS are
 * doubled; every ordering decision under test is production code. Each case
 * names the TLC config whose trace it replays.
 *
 * No wall clock: every interleaving is pinned with a gate a double opens or
 * waits on.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { handleToolResult } from "../../clients/runtime-tool-result.js";
import { clearWidgetState } from "../../clients/widget-state.js";
import { setupTestEnvironment } from "./test-utils.js";

vi.mock("../../clients/dispatch/integration.js", () => ({
	dispatchLintWithResult: vi.fn(),
	computeCascadeForFile: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../clients/lsp/index.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/lsp/index.js")>()),
	getLSPService: vi.fn(),
	resyncGitChangedFiles: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../clients/recent-touches.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/recent-touches.js")>()),
	appendRecentTouches: vi.fn().mockResolvedValue(undefined),
}));
// The on-demand bootstrap: clients are NOT resident until the test opens the
// gate, which is the state the #3508 claim gap needs.
const bootstrapGate = vi.hoisted(() => {
	const waiters: Array<() => void> = [];
	let onPark: (() => void) | undefined;
	return {
		waiters,
		park(waiter: () => void) {
			waiters.push(waiter);
			onPark?.();
		},
		/** Resolves once `count` demands are parked on the gate. */
		parked(count: number): Promise<void> {
			return new Promise((resolve) => {
				onPark = () => {
					if (waiters.length >= count) resolve();
				};
				onPark();
			});
		},
		release: () => waiters.splice(0).forEach((w) => w()),
	};
});
vi.mock("../../clients/bootstrap.js", async () => {
	const { bootstrapSeamMock } = await import("../support/bootstrap-mock.js");
	return bootstrapSeamMock(
		() =>
			new Promise((resolve) => {
				bootstrapGate.park(() =>
					resolve({
						biomeClient: {
							isSupportedFile: () => false,
							ensureAvailable: async () => false,
						},
						ruffClient: {
							isPythonFile: () => false,
							ensureAvailable: async () => false,
						},
						metricsClient: {},
					}),
				);
			}),
	);
});

import { dispatchLintWithResult } from "../../clients/dispatch/integration.js";
import { getLSPService } from "../../clients/lsp/index.js";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";

function gate() {
	let open!: () => void;
	const p = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { p, open };
}

function clean(label: string) {
	return {
		diagnostics: [],
		blockers: [],
		warnings: [],
		baselineWarningCount: 0,
		fixed: [],
		resolvedCount: 0,
		output: `analysed ${label}: clean`,
		blockerOutput: "",
		hasBlockers: false,
	};
}

type Dbg = (message: string) => void;

function deps(
	runtime: RuntimeCoordinator,
	biomeClient: unknown,
	options: { resident?: boolean; dbg?: Dbg } = {},
) {
	const resident = options.resident ?? true;
	return {
		getFlag: (name: string) => name === "no-lsp",
		dbg: options.dbg ?? (() => {}),
		runtime,
		cacheManager: { addModifiedRange: () => {}, readTurnState: () => ({}) },
		...(resident
			? {
					biomeClient,
					ruffClient: {
						isPythonFile: () => false,
						ensureAvailable: async () => false,
					},
					metricsClient: {},
				}
			: {}),
		resetLSPService: () => {},
		agentBehaviorRecord: () => [],
		formatBehaviorWarnings: () => "",
	} as unknown as Parameters<typeof handleToolResult>[0];
}
const noBiome = {
	isSupportedFile: () => false,
	ensureAvailable: async () => false,
};
const ev = (toolName: string, filePath: string, id: string) => ({
	toolName,
	toolCallId: id,
	input: { path: filePath },
	details: {},
	content: [],
});

describe("formal/dispatch-pipeline replays", () => {
	beforeEach(() => {
		clearWidgetState();
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
	});

	it("ClaimGap (#3508): with the bootstrap clients not resident, two handlers for one post-write state dispatch once", async () => {
		const env = setupTestEnvironment("tla-claim-gap-");
		try {
			const filePath = path.join(env.tmpDir, "a.ts");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.beginTurn();
			// `decided` opens once the second handler has either joined the live
			// pipeline (the fixed code) or dispatched its own (the claim gap);
			// only then may the first dispatch finish.
			const decided = gate();
			const finish = gate();
			vi.mocked(dispatchLintWithResult).mockImplementation(async () => {
				if (vi.mocked(dispatchLintWithResult).mock.calls.length > 1)
					decided.open();
				await finish.p;
				return clean("a") as never;
			});
			const dbg: Dbg = (message) => {
				if (message.includes("skipping duplicate concurrent state"))
					decided.open();
			};
			fs.writeFileSync(filePath, "export const a = 1;\n");
			// Two parallel edits of one file both landed before either handler
			// hashed it, so both handlers see the same post-write state.
			const first = handleToolResult({
				...deps(runtime, noBiome, { resident: false, dbg }),
				event: ev("edit", filePath, "c1"),
			} as never);
			const second = handleToolResult({
				...deps(runtime, noBiome, { resident: false, dbg }),
				event: ev("edit", filePath, "c2"),
			} as never);
			// Both handlers park on the bootstrap demand; releasing it resumes
			// them in order.
			await bootstrapGate.parked(2);
			bootstrapGate.release();
			await decided.p;
			finish.open();
			await Promise.all([first, second]);
			expect(vi.mocked(dispatchLintWithResult).mock.calls).toHaveLength(1);
		} finally {
			env.cleanup();
		}
	});
});
