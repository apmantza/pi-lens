/**
 * #2430 acceptance — an unknown tool with a `path` field reaches the pipeline.
 *
 * These cases drive the production entry points (`handleToolCall`,
 * `handleToolResult`) against a real `CacheManager`, a real
 * `RuntimeCoordinator` and a real mutation bridge, and assert on
 * `turn-state.json` and the change log. Nothing here imports a helper that
 * only the fix defines, so each case fails on an ASSERTION against pre-fix
 * code rather than on a missing module.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CacheManager } from "../../clients/cache-manager.js";
import { classifyMutatingTool } from "../../clients/mutating-tool.js";
import {
	MUTATION_BRIDGE_KEY,
	registerMutationBridge,
} from "../../clients/mutation-bridge.js";
import { getProjectDataDir } from "../../clients/file-utils.js";
import { resolveLanguageRootForFile } from "../../clients/language-profile.js";
import {
	MUTATION_ATTRIBUTION_FILE,
	primePersistedMutationAttribution,
	resetMutationAttribution,
	shouldArmObservationForTool,
} from "../../clients/mutation-attribution.js";
import {
	armObservedMutation,
	resetObservedMutationNet,
} from "../../clients/observed-mutation.js";
import { readChangesSince } from "../../clients/project-changes.js";
import { countFileLines } from "../../clients/read-guard-tool-lines.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { handleToolCall } from "../../clients/runtime-tool-call.js";
import {
	clearLastAnalyzedStateCache,
	handleToolResult,
} from "../../clients/runtime-tool-result.js";
import { setupTestEnvironment } from "./test-utils.js";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";

vi.mock("../../clients/pipeline.js", () => ({
	runPipeline: vi.fn(async () => ({
		output: "",
		hasBlockers: false,
		isError: false,
		fileModified: false,
	})),
}));

vi.mock("../../clients/lsp/index.js", () => ({
	getLSPService: () => makeLspServiceDouble(),
	resetLSPService: () => {},
	notifyExternalFileChange: vi.fn(async () => undefined),
}));

vi.mock("../../clients/bootstrap.js", () => ({
	loadBootstrapClients: async () => ({
		complexityClient: {
			isSupportedFile: () => false,
			analyzeFile: async () => null,
		},
		biomeClient: {},
		ruffClient: {},
		metricsClient: {},
		agentBehaviorClient: { recordToolCall: () => [], formatWarnings: () => "" },
	}),
}));

const SOURCE = ["const a = 1;", "const b = 2;", "const c = 3;", ""].join("\n");

/** What the mocked `runPipeline` resolves to once its gate is released. */
const PIPELINE_RESULT = {
	output: "",
	hasBlockers: false,
	isError: false,
	fileModified: false,
};

/**
 * Let every pending settle/IO turn finish. The observational settle is async
 * filesystem work, so a case that starts two `handleToolResult` calls without
 * awaiting them needs the event loop to actually drain before it can read how
 * many pipelines registered.
 */
async function flushAsyncWork(ticks = 25): Promise<void> {
	for (let index = 0; index < ticks; index += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

/**
 * A `runPipeline` double whose every call parks on its own gate until the case
 * releases it. Production-faithful on the axis these cases test: a real
 * pipeline is in flight for a while, and it is exactly that window in which
 * `inFlightPipelines` has to dedup a concurrent duplicate.
 */
function gatePipeline(runPipelineMock: {
	mockReset: () => void;
	mockImplementation: (impl: never) => void;
}): {
	gates: Array<() => void>;
	contexts: Array<Record<string, unknown>>;
	release: (from: number, to: number) => void;
} {
	const gates: Array<() => void> = [];
	const contexts: Array<Record<string, unknown>> = [];
	runPipelineMock.mockReset();
	runPipelineMock.mockImplementation((async (ctx: unknown) => {
		contexts.push(ctx as Record<string, unknown>);
		await new Promise<void>((resolve) => {
			gates.push(resolve);
		});
		return PIPELINE_RESULT;
	}) as never);
	return {
		gates,
		contexts,
		release: (from: number, to: number) => {
			for (let index = from; index < Math.min(to, gates.length); index += 1) {
				gates[index]();
			}
		},
	};
}

function ungatePipeline(runPipelineMock: {
	mockReset: () => void;
	mockImplementation: (impl: never) => void;
}): void {
	runPipelineMock.mockReset();
	runPipelineMock.mockImplementation((async () => PIPELINE_RESULT) as never);
}

/**
 * The bridge is a process-global, first-wins singleton, so it is mounted once
 * per test FILE (vitest's forks pool gives each file its own process) over
 * mutable holders the individual cases swap.
 */
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

beforeEach(() => {
	resetObservedMutationNet();
	resetMutationAttribution();
});

function patchEvent(
	filePath: string,
	toolCallId: string,
): Record<string, unknown> {
	// A tool pi-lens has never met: an unknown NAME, and an input shape no
	// adapter in `MUTATION_SHAPE_ADAPTERS` recognizes. The only thing the seam
	// can see is that it names a file.
	return {
		toolName: "patch_file",
		toolCallId,
		input: { path: filePath, patch: "@@ -2 +2 @@" },
		content: [{ type: "text", text: "patched" }],
	};
}

/**
 * An unknown tool that also states the text it replaced. The NAME is unknown
 * and the SHAPE is not one an adapter shipped in `MUTATION_SHAPE_ADAPTERS`
 * recognizes, so the call is unclassified until the observational net
 * attributes it — but its input carries the `oldText`/`newText` pair the
 * #2402 applied-edit records are built from, which is what makes the skip
 * path's partial-apply step observable (#2449 review round 4, S4).
 */
function retryEvent(
	filePath: string,
	toolCallId: string,
): Record<string, unknown> {
	return {
		toolName: "patch_retry",
		toolCallId,
		input: {
			path: filePath,
			patch: "@@ -2 +2 @@",
			oldText: "const a = 1;",
			newText: "const a = 9;",
		},
		content: [{ type: "text", text: "patched" }],
	};
}

function toolCallDeps(args: {
	event: Record<string, unknown>;
	cwd: string;
	runtime: RuntimeCoordinator;
	cacheManager: CacheManager;
}): Parameters<typeof handleToolCall>[0] {
	return {
		event: args.event,
		ctx: { cwd: args.cwd },
		lensEnabled: true,
		getFlag: (name: string) => name === "no-lsp",
		dbg: () => {},
		runtime: args.runtime,
		cacheManager: args.cacheManager,
		ensureLSPConfigInitialized: async () => {},
		updateLspStatus: () => {},
		resetLSPService: () => {},
	} as unknown as Parameters<typeof handleToolCall>[0];
}

function toolResultDeps(args: {
	event: Record<string, unknown>;
	runtime: RuntimeCoordinator;
	cacheManager: CacheManager;
}): Parameters<typeof handleToolResult>[0] {
	return {
		event: args.event,
		getFlag: (name: string) => name === "no-lsp",
		dbg: () => {},
		runtime: args.runtime,
		cacheManager: args.cacheManager,
		biomeClient: {},
		ruffClient: {},
		metricsClient: {},
		resetLSPService: () => {},
		agentBehaviorRecord: () => [],
		formatBehaviorWarnings: () => "",
	} as unknown as Parameters<typeof handleToolResult>[0];
}

function newSession(tmpDir: string): {
	runtime: RuntimeCoordinator;
	cacheManager: CacheManager;
} {
	const cacheManager = new CacheManager(false);
	const runtime = new RuntimeCoordinator();
	runtime.projectRoot = tmpDir;
	runtime.setTelemetryIdentity({ sessionId: "s-2430" });
	runtime.beginTurn();
	liveRuntime = runtime;
	liveCacheManager = cacheManager;
	liveRoot = tmpDir;
	return { runtime, cacheManager };
}

describe("#2430 acceptance 1 — the FIRST call of an unknown tool lands in turn state", () => {
	it("observes the write and records it as an edit with the tool's own attribution", async () => {
		const env = setupTestEnvironment("pi-lens-2430-first-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const filePath = path.join(env.tmpDir, "observed.ts");
			fs.writeFileSync(filePath, SOURCE);
			const { runtime, cacheManager } = newSession(env.tmpDir);

			const event = patchEvent(filePath, "call-2430-first");
			await handleToolCall(
				toolCallDeps({ event, cwd: env.tmpDir, runtime, cacheManager }),
			);

			// The unknown tool executes and rewrites line 2.
			fs.writeFileSync(
				filePath,
				["const a = 1;", "const b = 222;", "const c = 3;", ""].join("\n"),
			);

			await handleToolResult(toolResultDeps({ event, runtime, cacheManager }));

			const turnState = cacheManager.readTurnState(env.tmpDir);
			const files = Object.keys(turnState.files ?? {});
			expect(files.length).toBeGreaterThan(0);
			expect(files.some((entry) => entry.includes("observed.ts"))).toBe(true);

			// The change log names the tool rather than collapsing onto agent-edit.
			expect(readChangesSince(env.tmpDir, 0)).toMatchObject([
				{ source: "agent-tool:patch_file" },
			]);

			// Deferred, never immediate — an unknown edit-shaped tool takes the
			// safe timing, so the agent_settled drain formats it.
			expect(runtime.pendingDeferredFormatCount).toBeGreaterThan(0);
		} finally {
			if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
			else process.env.PILENS_DATA_DIR = previousDataDir;
			env.cleanup();
		}
	});
});

describe("#2430 acceptance 2 — the SECOND call is classified without a snapshot", () => {
	it("classifies the same tool by name once one mutation has been observed", async () => {
		const env = setupTestEnvironment("pi-lens-2430-second-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const filePath = path.join(env.tmpDir, "twice.ts");
			fs.writeFileSync(filePath, SOURCE);
			const { runtime, cacheManager } = newSession(env.tmpDir);

			const first = patchEvent(filePath, "call-2430-a");
			// Before any observation the seam has no opinion at all: this is the
			// #2423 gap #2430 exists to close.
			expect(classifyMutatingTool(first)).toBeUndefined();

			await handleToolCall(
				toolCallDeps({ event: first, cwd: env.tmpDir, runtime, cacheManager }),
			);
			fs.writeFileSync(filePath, `${SOURCE}const d = 4;\n`);
			await handleToolResult(
				toolResultDeps({ event: first, runtime, cacheManager }),
			);

			const second = patchEvent(filePath, "call-2430-b");
			expect(classifyMutatingTool(second)).toMatchObject({
				toolName: "patch_file",
				kind: "edit",
				provenance: "learned",
			});
		} finally {
			if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
			else process.env.PILENS_DATA_DIR = previousDataDir;
			env.cleanup();
		}
	});
});

describe("#2430 acceptance 2 — persistence is reachable on the PRODUCTION path", () => {
	it("persists after two real arm/settle cycles, and a fresh session classifies from disk", async () => {
		// #2449 review round 2, F2. The pre-round test for this criterion called
		// `noteObservedMutation` twice DIRECTLY, so it proved the counter and
		// nothing about the path — and the path could not reach two, because
		// `shouldArmObservationForTool` latched off the moment the tool became
		// session-learned. `PERSIST_AFTER_OBSERVATIONS = 2` was unreachable and
		// no attribution ever reached disk for the next session to adopt.
		//
		// Every step here goes through `handleToolCall`/`handleToolResult`.
		const env = setupTestEnvironment("pi-lens-2430-persist-path-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const filePath = path.join(env.tmpDir, "persisted.ts");
			fs.writeFileSync(filePath, SOURCE);
			const { runtime, cacheManager } = newSession(env.tmpDir);

			for (const [index, body] of [
				`${SOURCE}const d = 4;\n`,
				`${SOURCE}const d = 4;\nconst e = 5;\n`,
			].entries()) {
				const event = patchEvent(filePath, `call-2430-persist-${index}`);
				await handleToolCall(
					toolCallDeps({ event, cwd: env.tmpDir, runtime, cacheManager }),
				);
				fs.writeFileSync(filePath, body);
				await handleToolResult(
					toolResultDeps({ event, runtime, cacheManager }),
				);
			}

			const attributionFile = path.join(
				getProjectDataDir(env.tmpDir),
				MUTATION_ATTRIBUTION_FILE,
			);
			expect(fs.existsSync(attributionFile)).toBe(true);
			expect(
				JSON.parse(fs.readFileSync(attributionFile, "utf-8")),
			).toMatchObject({
				version: 1,
				tools: [{ name: "patch_file", observations: 2 }],
			});

			// A FRESH session: nothing in memory, only the file on disk.
			resetMutationAttribution();
			resetObservedMutationNet();
			expect(
				classifyMutatingTool(patchEvent(filePath, "call-2430-fresh")),
			).toBeUndefined();

			primePersistedMutationAttribution(env.tmpDir);
			expect(
				classifyMutatingTool(patchEvent(filePath, "call-2430-fresh")),
			).toMatchObject({
				kind: "edit",
				provenance: "learned",
				source: "attribution:persisted",
			});
			// And a durably attributed tool is never watched again.
			expect(shouldArmObservationForTool("patch_file")).toBe(false);
		} finally {
			if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
			else process.env.PILENS_DATA_DIR = previousDataDir;
			env.cleanup();
		}
	});
});

describe("#2449 review round 3 — one receipt per physical edit", () => {
	it("records a provisionally-learned tool once, not once per half", async () => {
		// S2. A tool learned from ONE observation is classified by NAME from the
		// next call on, and is STILL armed — that second property is what makes
		// `PERSIST_AFTER_OBSERVATIONS = 2` reachable at all (round 2, F2). Both
		// halves then recorded the same edit: the settle replayed it through the
		// mutation bridge with measured ranges, and the classification chain
		// below recorded it AGAIN as a whole-file change. Three real edits
		// produced four change-log receipts, and the middle one was reported
		// twice with two different ranges.
		const env = setupTestEnvironment("pi-lens-2449-double-record-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const filePath = path.join(env.tmpDir, "thrice.ts");
			fs.writeFileSync(filePath, SOURCE);
			const { runtime, cacheManager } = newSession(env.tmpDir);

			for (const [index, body] of [
				`${SOURCE}const d = 4;\n`,
				`${SOURCE}const d = 4;\nconst e = 5;\n`,
				`${SOURCE}const d = 4;\nconst e = 5;\nconst f = 6;\n`,
			].entries()) {
				const event = patchEvent(filePath, `call-2449-double-${index}`);
				await handleToolCall(
					toolCallDeps({ event, cwd: env.tmpDir, runtime, cacheManager }),
				);
				fs.writeFileSync(filePath, body);
				await handleToolResult(
					toolResultDeps({ event, runtime, cacheManager }),
				);
			}

			// One physical edit, one receipt. Not one per bookkeeping path that
			// happened to be reachable.
			expect(
				readChangesSince(env.tmpDir, 0).map((change) => change.source),
			).toEqual([
				"agent-tool:patch_file",
				"agent-tool:patch_file",
				"agent-tool:patch_file",
			]);
		} finally {
			if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
			else process.env.PILENS_DATA_DIR = previousDataDir;
			env.cleanup();
		}
	});
});

describe("#2449 review round 3 — the async settle never reorders registration", () => {
	it("keeps two same-path tool_results with different content as distinct pipelines", async () => {
		// T4. The settle stopped being synchronous (no sync filesystem work on
		// the tool_result path), so `handleToolResult` now YIELDS on a call that
		// has an armed observation. Everything the classified chain derives from
		// the file's post-result bytes therefore has to be read BEFORE that
		// yield: a racing tool_result for the same path rewrites the file while
		// the first call is awaiting, and the first call then registers under the
		// SECOND call's state hash — collapsing two distinct pipeline runs into
		// one (#1086's composite key, and the dedupe that rides on it).
		const env = setupTestEnvironment("pi-lens-2449-settle-order-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		const previousDebounce = process.env.PI_LENS_TOOL_RESULT_DEBOUNCE_MS;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		// Route through inFlightPipelines rather than the debounce coalescer.
		delete process.env.PI_LENS_TOOL_RESULT_DEBOUNCE_MS;
		try {
			const filePath = path.join(env.tmpDir, "race.ts");
			fs.writeFileSync(filePath, "export const z = 1;\n");
			// The armed observation watches an UNRELATED path that never moves,
			// so the settle finds nothing, replays nothing, and the classified
			// chain below still runs — which is what puts the ordering under
			// test rather than the skip.
			const watched = path.join(env.tmpDir, "watched.ts");
			fs.writeFileSync(watched, SOURCE);
			const { runtime, cacheManager } = newSession(env.tmpDir);

			const { runPipeline } = await import("../../clients/pipeline.js");
			vi.mocked(runPipeline).mockClear();

			await armObservedMutation({
				toolCallId: "call-race-a",
				toolName: "edit",
				targetPath: watched,
				cwd: env.tmpDir,
				sessionGeneration: runtime.sessionGeneration,
				turnIndex: runtime.turnIndex,
			});

			const editEvent = (toolCallId: string): Record<string, unknown> => ({
				toolName: "edit",
				toolCallId,
				input: { path: filePath },
				content: [{ type: "text", text: "edited" }],
			});

			const first = handleToolResult(
				toolResultDeps({
					event: editEvent("call-race-a"),
					runtime,
					cacheManager,
				}),
			);
			// Synchronously, before the first call can resume from its settle.
			fs.writeFileSync(filePath, "export const z = 2;\n");
			const second = handleToolResult(
				toolResultDeps({
					event: editEvent("call-race-b"),
					runtime,
					cacheManager,
				}),
			);
			await Promise.all([first, second]);

			// Two distinct post-result states, two pipeline runs.
			expect(vi.mocked(runPipeline)).toHaveBeenCalledTimes(2);
		} finally {
			if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
			else process.env.PILENS_DATA_DIR = previousDataDir;
			if (previousDebounce === undefined)
				delete process.env.PI_LENS_TOOL_RESULT_DEBOUNCE_MS;
			else process.env.PI_LENS_TOOL_RESULT_DEBOUNCE_MS = previousDebounce;
			env.cleanup();
		}
	});
});

describe("#2430 — the net does not arm for a classified tool", () => {
	it("takes no snapshot for a plain `write`, so the hot path is unchanged", async () => {
		const env = setupTestEnvironment("pi-lens-2430-hotpath-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const filePath = path.join(env.tmpDir, "written.ts");
			fs.writeFileSync(filePath, SOURCE);
			const { runtime, cacheManager } = newSession(env.tmpDir);

			const statSpy = vi.spyOn(fs.promises, "stat");
			await handleToolCall(
				toolCallDeps({
					event: {
						toolName: "write",
						toolCallId: "call-2430-write",
						input: { path: filePath, content: SOURCE },
					},
					cwd: env.tmpDir,
					runtime,
					cacheManager,
				}),
			);
			const observedStats = statSpy.mock.calls.length;
			statSpy.mockRestore();

			// The seam classifies `write`, so `armObservedMutation` is never
			// reached and the snapshot's stat storm never happens. Anything above
			// a handful here means the net armed for a classified tool.
			expect(observedStats).toBeLessThan(4);
		} finally {
			if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
			else process.env.PILENS_DATA_DIR = previousDataDir;
			env.cleanup();
		}
	});
});

describe("#2430 item 3 — the settled sweep is wired ahead of the deferred drain", () => {
	it("runs the sweep before the drain and re-baselines after it", () => {
		// A source-level wiring assertion, for the same reason
		// `tests/index-loop-block-wiring.test.ts` uses one: `agent_settled` is a
		// host event this suite cannot fire, and the ORDER is the contract —
		// a sweep after the drain would queue every drifted file one whole run
		// late.
		const indexSource = fs.readFileSync(
			path.join(import.meta.dirname, "..", "..", "index.ts"),
			"utf-8",
		);
		const sweepAt = indexSource.indexOf(
			"await runObservedSettledSweepSafely(ctx)",
		);
		const drainAt = indexSource.indexOf("await runDeferredMutationDrain(ctx)");
		const refreshAt = indexSource.indexOf(
			"await refreshObservedLedgerSafely(ctx)",
		);
		expect(sweepAt).toBeGreaterThan(-1);
		expect(drainAt).toBeGreaterThan(sweepAt);
		expect(refreshAt).toBeGreaterThan(drainAt);
	});
});

describe("#2449 review round 4 — the observed-settle return skips only duplicates", () => {
	it("keeps the applied-edit records, mutation receipt and cachedExports refresh", async () => {
		// S4. Round 3 (S2) added an early return so a provisionally-learned tool
		// did not record the same physical edit twice. It was labelled "skipped turn
		// tracking" and skipped considerably more than that. Three of the steps
		// below it have NO counterpart in `recordMutationThroughSeam`, so nothing
		// else ran them:
		//
		//   - the #2402 applied-edit records, so an identical retry escalated
		//     through the oldText-not-found ladder instead of being recognized;
		//   - `recordMutationToolReceipt`, the write→edit ordering state;
		//   - the `cachedExports` refresh, so the pre-write STOP check kept firing
		//     on names the edit had just removed.
		const env = setupTestEnvironment("pi-lens-2449-narrow-skip-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const filePath = path.join(env.tmpDir, "narrowed.ts");
			const withStale = `export const staleName = 1;\n${SOURCE}`;
			fs.writeFileSync(filePath, withStale);
			const { runtime, cacheManager } = newSession(env.tmpDir);

			// Non-vacuity: neither the NAME tier nor the SHAPE tier can classify
			// this call, so the observational net is the only thing that reaches the
			// bookkeeping chain — which is what makes the skip path reachable at all.
			const firstEvent = retryEvent(filePath, "call-2449-narrow-0");
			expect(
				classifyMutatingTool(firstEvent as never, {
					filePath,
					recognizeOnly: true,
				}),
			).toBeUndefined();

			// Call 1 arms, observes and attributes the tool.
			await handleToolCall(
				toolCallDeps({
					event: firstEvent,
					cwd: env.tmpDir,
					runtime,
					cacheManager,
				}),
			);
			fs.writeFileSync(filePath, `${withStale}const d = 4;\n`);
			await handleToolResult(
				toolResultDeps({ event: firstEvent, runtime, cacheManager }),
			);

			// Call 2 is classified BY NAME from the attribution and is still armed,
			// so its tool_result takes the early return under test.
			runtime.cachedExports.set("staleName", filePath);
			const receiptSpy = vi.spyOn(runtime, "recordMutationToolReceipt");
			const appliedSpy = vi.spyOn(runtime.partialApplyRecords, "record");

			const secondEvent = retryEvent(filePath, "call-2449-narrow-1");
			await handleToolCall(
				toolCallDeps({
					event: secondEvent,
					cwd: env.tmpDir,
					runtime,
					cacheManager,
				}),
			);
			// The edit removes the exported name cachedExports is holding.
			fs.writeFileSync(filePath, `${SOURCE}const d = 4;\nconst e = 5;\n`);
			await handleToolResult(
				toolResultDeps({ event: secondEvent, runtime, cacheManager }),
			);

			// The skip really happened: one change-log receipt per physical edit,
			// which is the round-3 property the early return exists for.
			expect(
				readChangesSince(env.tmpDir, 0).map((change) => change.source),
			).toEqual(["agent-tool:patch_retry", "agent-tool:patch_retry"]);

			// And the three non-duplicated steps ran anyway.
			expect(receiptSpy).toHaveBeenCalledWith(filePath, "edit");
			expect(appliedSpy).toHaveBeenCalled();
			expect(runtime.cachedExports.has("staleName")).toBe(false);

			receiptSpy.mockRestore();
			appliedSpy.mockRestore();
		} finally {
			if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
			else process.env.PILENS_DATA_DIR = previousDataDir;
			env.cleanup();
		}
	});
});

describe("#2464 — the observed-settle path also dispatches pipeline analysis", () => {
	it("analyses EVERY call of an unknown tool, first one included, with one change-log receipt each", async () => {
		// #2464 review round 2, S2 (PROBE-P2). The observed path used to sit
		// BELOW the `mutation === undefined` gate, so CALL ONE of every unknown
		// tool — the call the observational net exists for — was recorded by the
		// bridge and then returned unanalysed. Three calls therefore produced
		// 0/1/2 pipeline runs where the contract (AC2: "an observed mutation gets
		// its pipeline analysis in the same turn") demands 1/2/3.
		//
		// It must NOT be fixed by re-running the classified chain, which would
		// re-record turn-state/change-log for an edit the bridge already recorded
		// (#2449 round 3, S2) — the receipt assertion after each call is what
		// catches that.
		const env = setupTestEnvironment("pi-lens-2464-dispatch-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const filePath = path.join(env.tmpDir, "dispatched.ts");
			fs.writeFileSync(filePath, SOURCE);
			const { runtime, cacheManager } = newSession(env.tmpDir);

			const { runPipeline } = await import("../../clients/pipeline.js");
			vi.mocked(runPipeline).mockClear();

			// Call 1 is UNCLASSIFIED (`classifyMutatingTool` returns undefined);
			// calls 2 and 3 are classified by name from call 1's attribution and
			// still armed, so all three settle observationally.
			const bodies = [
				`${SOURCE}const d = 4;\n`,
				`${SOURCE}const d = 4;\nconst e = 5;\n`,
				`${SOURCE}const d = 4;\nconst e = 5;\nconst f = 6;\n`,
			];
			for (const [index, body] of bodies.entries()) {
				const event = patchEvent(filePath, `call-2464-dispatch-${index}`);
				if (index === 0) {
					expect(classifyMutatingTool(event as never)).toBeUndefined();
				}
				await handleToolCall(
					toolCallDeps({ event, cwd: env.tmpDir, runtime, cacheManager }),
				);
				fs.writeFileSync(filePath, body);
				await handleToolResult(
					toolResultDeps({ event, runtime, cacheManager }),
				);

				// One dispatch per physical edit — including the FIRST one.
				expect(vi.mocked(runPipeline)).toHaveBeenCalledTimes(index + 1);
				// And still exactly one change-log receipt per physical edit: the
				// #2449 round-3 property, unregressed by adding the dispatch.
				expect(
					readChangesSince(env.tmpDir, 0).map((change) => change.source),
				).toEqual(
					Array.from({ length: index + 1 }, () => "agent-tool:patch_file"),
				);
			}
		} finally {
			if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
			else process.env.PILENS_DATA_DIR = previousDataDir;
			env.cleanup();
		}
	});

	it("dispatches the observed mutation with the observed-provenance context, not merely SOME context", async () => {
		// #2464 review round 2, S4 (PROBE-P1). A call-count assertion alone
		// cannot tell a dispatch of the right file under the right root from a
		// dispatch of anything at all — pin the context the pipeline actually
		// receives.
		const env = setupTestEnvironment("pi-lens-2464-context-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const filePath = path.join(env.tmpDir, "context.ts");
			fs.writeFileSync(filePath, SOURCE);
			const { runtime, cacheManager } = newSession(env.tmpDir);

			const { runPipeline } = await import("../../clients/pipeline.js");
			vi.mocked(runPipeline).mockClear();

			const event = patchEvent(filePath, "call-2464-context-0");
			await handleToolCall(
				toolCallDeps({ event, cwd: env.tmpDir, runtime, cacheManager }),
			);
			fs.writeFileSync(filePath, `${SOURCE}const d = 4;\n`);
			await handleToolResult(toolResultDeps({ event, runtime, cacheManager }));

			expect(vi.mocked(runPipeline)).toHaveBeenCalledTimes(1);
			const ctx = vi.mocked(runPipeline).mock.calls[0][0] as unknown as Record<
				string,
				unknown
			>;
			expect(ctx.filePath).toBe(filePath);
			expect(ctx.cwd).toBe(resolveLanguageRootForFile(filePath, env.tmpDir));
			expect(ctx.projectRoot).toBe(path.resolve(env.tmpDir));
			// The tool's OWN name, not a synthesized "edit"/"write" stand-in.
			expect(ctx.toolName).toBe("patch_file");
			// An unknown edit-shaped tool takes the safe timing, so the
			// `agent_settled` drain owns the fix/format — never an immediate one.
			expect(ctx.autofixMode).toBe("deferred");
			// No adapter/diff ranges exist for this provenance, so the dispatch is
			// whole-file rather than falsely scoped to lines nobody measured.
			expect(ctx.modifiedRanges).toBeUndefined();
			// A real write token from the shared counter — the same one
			// `lsp_diagnostics`' reconciliation orders verdicts by (#1561).
			expect(
				(ctx.telemetry as { writeIndex?: number } | undefined)?.writeIndex,
			).toBe(runtime.peekWriteIndex());
		} finally {
			if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
			else process.env.PILENS_DATA_DIR = previousDataDir;
			env.cleanup();
		}
	});

	it("applies the post-pipeline post-conditions on the observed path too", async () => {
		// #2464 review round 2, S1 (PROBE-P3). The observed path discarded the
		// pipeline `result`, so all three post-conditions the classified path
		// applies were skipped: the read-guard staleness re-stamp over
		// `result.changedFiles` (under `--immediate-format` the pipeline rewrites
		// the file, and without the re-stamp the NEXT edit is blocked with a
		// spurious `file_modified`), the #2402 after-write hash stamp, and the
		// already-analysed latch.
		//
		// Driven through call TWO deliberately. Call two ALREADY dispatched before
		// this round, so every red below is attributable to the missing
		// post-conditions rather than to the missing call-one dispatch the case
		// above covers — two findings, two independent reds.
		const env = setupTestEnvironment("pi-lens-2464-postconditions-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const filePath = path.join(env.tmpDir, "postconditions.ts");
			fs.writeFileSync(filePath, SOURCE);
			const { runtime, cacheManager } = newSession(env.tmpDir);

			const { runPipeline } = await import("../../clients/pipeline.js");
			vi.mocked(runPipeline).mockClear();
			// Production-faithful on the axis under test: a pipeline that FORMATS
			// rewrites the file and reports it in `changedFiles`. A double that
			// left the bytes alone could not tell the fix from the bug — the
			// after-write stamp is gated on the bytes actually having moved.
			const formattingPipeline = (async () => {
				fs.appendFileSync(filePath, "\n// formatted\n");
				return {
					output: "",
					hasBlockers: false,
					isError: false,
					fileModified: true,
					changedFiles: [filePath],
				};
			}) as never;
			vi.mocked(runPipeline).mockImplementationOnce(formattingPipeline);
			vi.mocked(runPipeline).mockImplementationOnce(formattingPipeline);

			const recordWritten = vi.fn();
			const readGuard = {
				recordWritten,
				getReadHistory: () => [],
			} as unknown as NonNullable<
				Parameters<typeof handleToolResult>[0]["readGuard"]
			>;
			const afterWriteSpy = vi.spyOn(
				runtime.partialApplyRecords,
				"noteAfterWriteHash",
			);

			// `retryEvent` carries the oldText/newText pair the #2402 applied-edit
			// records are built from — without a recorded pair there is nothing for
			// the after-write hash to stamp.
			for (const [index, body] of [
				`${SOURCE}const d = 4;\n`,
				`${SOURCE}const d = 4;\nconst e = 5;\n`,
			].entries()) {
				const event = retryEvent(filePath, `call-2464-post-${index}`);
				await handleToolCall(
					toolCallDeps({ event, cwd: env.tmpDir, runtime, cacheManager }),
				);
				fs.writeFileSync(filePath, body);
				await handleToolResult({
					...toolResultDeps({ event, runtime, cacheManager }),
					readGuard,
				});
			}

			// 0. Still one change-log receipt per physical edit. This is the
			//    assertion that keeps the observed block's `return` load-bearing:
			//    a formatting pipeline moves the bytes, so the already-analysed
			//    latch does NOT match on the way down and the classified chain
			//    would run its own whole-file recording if the return were removed.
			//    The no-op pipeline every other case uses cannot see that, because
			//    the latch masks it there.
			expect(
				readChangesSince(env.tmpDir, 0).map((change) => change.source),
			).toEqual(["agent-tool:patch_retry", "agent-tool:patch_retry"]);
			// 1. The staleness stamp is re-taken over the file the pipeline itself
			//    rewrote, so the agent's next edit is judged by read coverage.
			expect(recordWritten).toHaveBeenCalledWith(path.resolve(filePath));
			// 2. The #2402 record is re-stamped with the POST-pipeline hash, so an
			//    identical retry against the formatted bytes is still recognized as
			//    already applied instead of escalating the oldText ladder.
			expect(afterWriteSpy).toHaveBeenCalledWith(
				filePath,
				"const a = 1;",
				"const a = 9;",
				expect.any(String),
			);
			afterWriteSpy.mockRestore();

			// 3. The already-analysed latch is set, so a duplicate tool_result for
			//    the SAME bytes in the same turn does not analyse the file twice.
			const dispatchesSoFar = vi.mocked(runPipeline).mock.calls.length;
			await handleToolResult({
				...toolResultDeps({
					event: {
						toolName: "write",
						toolCallId: "call-2464-post-duplicate",
						input: { path: filePath },
						content: [{ type: "text", text: "written" }],
					},
					runtime,
					cacheManager,
				}),
				readGuard,
				_bypassDebounce: true,
			});
			expect(vi.mocked(runPipeline)).toHaveBeenCalledTimes(dispatchesSoFar);
		} finally {
			if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
			else process.env.PILENS_DATA_DIR = previousDataDir;
			env.cleanup();
		}
	});

	it("surfaces a pipeline crash on the observed path the way the classified path does", async () => {
		// #2464 review round 2, S6. A crash used to be swallowed into a `dbg`
		// line the model never sees, so an observed tool's edit came back looking
		// analysed when nothing had run. The classified chain returns the crash
		// notice with `isError: true`; the observed path now matches it.
		//
		// Asserted on call TWO, which already dispatched before this round, so
		// the red is the swallowed crash rather than the missing call-one
		// dispatch the first case covers.
		const env = setupTestEnvironment("pi-lens-2464-crash-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		const { runPipeline } = await import("../../clients/pipeline.js");
		try {
			const filePath = path.join(env.tmpDir, "crashed.ts");
			fs.writeFileSync(filePath, SOURCE);
			const { runtime, cacheManager } = newSession(env.tmpDir);

			vi.mocked(runPipeline).mockClear();
			vi.mocked(runPipeline).mockImplementation((async () => {
				throw new Error("pipeline exploded");
			}) as never);

			let outcome: Awaited<ReturnType<typeof handleToolResult>> = undefined;
			for (const [index, body] of [
				`${SOURCE}const d = 4;\n`,
				`${SOURCE}const d = 4;\nconst e = 5;\n`,
			].entries()) {
				const event = patchEvent(filePath, `call-2464-crash-${index}`);
				await handleToolCall(
					toolCallDeps({ event, cwd: env.tmpDir, runtime, cacheManager }),
				);
				fs.writeFileSync(filePath, body);
				outcome = await handleToolResult(
					toolResultDeps({ event, runtime, cacheManager }),
				);
			}

			expect(outcome?.isError).toBe(true);
			// The edit itself still stands in the change log — only the analysis
			// was lost, and the notice says so rather than the record vanishing.
			expect(
				readChangesSince(env.tmpDir, 0).map((change) => change.source),
			).toEqual(["agent-tool:patch_file", "agent-tool:patch_file"]);
		} finally {
			// The mock is module-level and shared by every case in this file.
			vi.mocked(runPipeline).mockImplementation((async () => ({
				output: "",
				hasBlockers: false,
				isError: false,
				fileModified: false,
			})) as never);
			if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
			else process.env.PILENS_DATA_DIR = previousDataDir;
			env.cleanup();
		}
	});
});

describe("#2464 review round 3 — F1: the observed dispatch shares the classified pre-conditions", () => {
	it("dispatches ONE pipeline for two concurrent observed tool_results on the same state", async () => {
		// The observed call site shipped in round 2 with NO in-flight check and no
		// already-analysed latch check, so two tool_results that settle
		// observationally against the same file+hash both reached
		// `dispatchPipelineAnalysis`. That is two `runPipeline` runs — under
		// `--immediate-format`, two autofix/format writers racing on one file —
		// where the classified chain has deduped since #1086.
		const env = setupTestEnvironment("pi-lens-2464-f1-concurrent-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		const previousDebounce = process.env.PI_LENS_TOOL_RESULT_DEBOUNCE_MS;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		// Route through inFlightPipelines rather than the debounce coalescer.
		delete process.env.PI_LENS_TOOL_RESULT_DEBOUNCE_MS;
		const { runPipeline } = await import("../../clients/pipeline.js");
		try {
			const filePath = path.join(env.tmpDir, "concurrent.ts");
			fs.writeFileSync(filePath, SOURCE);
			const { runtime, cacheManager } = newSession(env.tmpDir);
			const gated = gatePipeline(vi.mocked(runPipeline));

			// Two calls of the SAME unknown tool, both armed against the same
			// pre-write baseline, both settling on the same post-write bytes.
			const eventA = patchEvent(filePath, "call-2464-f1-a");
			const eventB = patchEvent(filePath, "call-2464-f1-b");
			for (const event of [eventA, eventB]) {
				expect(classifyMutatingTool(event as never)).toBeUndefined();
				await handleToolCall(
					toolCallDeps({ event, cwd: env.tmpDir, runtime, cacheManager }),
				);
			}
			fs.writeFileSync(filePath, `${SOURCE}const d = 4;\n`);

			// Started back to back, so neither has resumed from its settle when the
			// other starts — the exact interleave the classified chain's atomic
			// check-then-act is built for.
			const first = handleToolResult(
				toolResultDeps({ event: eventA, runtime, cacheManager }),
			);
			const second = handleToolResult(
				toolResultDeps({ event: eventB, runtime, cacheManager }),
			);
			await flushAsyncWork();

			expect(gated.gates.length).toBe(1);
			expect(vi.mocked(runPipeline)).toHaveBeenCalledTimes(1);

			gated.release(0, gated.gates.length);
			await Promise.all([first, second]);
			// The joiner is still counted: the duplicate rides the live pipeline's
			// telemetry instead of opening a second one.
			expect(vi.mocked(runPipeline)).toHaveBeenCalledTimes(1);
		} finally {
			ungatePipeline(vi.mocked(runPipeline));
			if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
			else process.env.PILENS_DATA_DIR = previousDataDir;
			if (previousDebounce === undefined)
				delete process.env.PI_LENS_TOOL_RESULT_DEBOUNCE_MS;
			else process.env.PI_LENS_TOOL_RESULT_DEBOUNCE_MS = previousDebounce;
			env.cleanup();
		}
	});

	it("keeps a later classified pipeline deduping after two observed calls settle", async () => {
		// The reviewer's round-3 choreography, end to end. Two concurrent observed
		// calls A and B on one file+hash; A resolves; a classified call C for a
		// NEW state registers; B settles last; an exact duplicate D of C arrives
		// while C is still in flight.
		//
		// Round 2's head ran FOUR pipelines here. B registered under A's key and
		// overwrote it, A's release emptied the map and deleted the OUTER entry,
		// C re-created a fresh inner map under the same path, and B's release —
		// holding a stale reference to the FIRST inner map — deleted the outer
		// entry again, evicting live C. D then found nothing to dedup against.
		const env = setupTestEnvironment("pi-lens-2464-f1-eviction-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		const previousDebounce = process.env.PI_LENS_TOOL_RESULT_DEBOUNCE_MS;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		delete process.env.PI_LENS_TOOL_RESULT_DEBOUNCE_MS;
		const { runPipeline } = await import("../../clients/pipeline.js");
		try {
			const filePath = path.join(env.tmpDir, "eviction.ts");
			fs.writeFileSync(filePath, SOURCE);
			const { runtime, cacheManager } = newSession(env.tmpDir);
			const gated = gatePipeline(vi.mocked(runPipeline));

			const eventA = patchEvent(filePath, "call-2464-f1-evict-a");
			const eventB = patchEvent(filePath, "call-2464-f1-evict-b");
			for (const event of [eventA, eventB]) {
				await handleToolCall(
					toolCallDeps({ event, cwd: env.tmpDir, runtime, cacheManager }),
				);
			}
			fs.writeFileSync(filePath, `${SOURCE}const d = 4;\n`);

			const first = handleToolResult(
				toolResultDeps({ event: eventA, runtime, cacheManager }),
			);
			const second = handleToolResult(
				toolResultDeps({ event: eventB, runtime, cacheManager }),
			);
			await flushAsyncWork();
			// Not asserted — the sibling case above owns that red. Captured so the
			// releases below name A's gate and B's gate under BOTH behaviours.
			const observedGateCount = gated.gates.length;

			gated.release(0, 1);
			await first;

			// A classified edit for a genuinely NEW state: it must run.
			fs.writeFileSync(filePath, `${SOURCE}const d = 4;\nconst e = 5;\n`);
			const classifiedEvent = (
				toolCallId: string,
			): Record<string, unknown> => ({
				toolName: "edit",
				toolCallId,
				input: { path: filePath },
				content: [{ type: "text", text: "edited" }],
			});
			const third = handleToolResult(
				toolResultDeps({
					event: classifiedEvent("call-2464-f1-evict-c"),
					runtime,
					cacheManager,
				}),
			);
			await flushAsyncWork();

			// Now B settles, holding whatever registry reference it captured.
			gated.release(1, observedGateCount);
			await second;

			// An exact duplicate of C, while C is still in flight.
			const fourth = handleToolResult(
				toolResultDeps({
					event: classifiedEvent("call-2464-f1-evict-d"),
					runtime,
					cacheManager,
				}),
			);
			await flushAsyncWork();

			// Two physical states, two pipelines: A's observed dispatch and C's
			// classified one. B joined A; D deduped against live C.
			expect(
				gated.contexts.map((ctx) => [ctx.toolName, ctx.telemetry]),
			).toEqual([
				["patch_file", expect.objectContaining({ writeIndex: 1 })],
				["edit", expect.objectContaining({ writeIndex: 2 })],
			]);
			expect(vi.mocked(runPipeline)).toHaveBeenCalledTimes(2);

			gated.release(0, gated.gates.length);
			await Promise.all([third, fourth]);
		} finally {
			ungatePipeline(vi.mocked(runPipeline));
			if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
			else process.env.PILENS_DATA_DIR = previousDataDir;
			if (previousDebounce === undefined)
				delete process.env.PI_LENS_TOOL_RESULT_DEBOUNCE_MS;
			else process.env.PI_LENS_TOOL_RESULT_DEBOUNCE_MS = previousDebounce;
			env.cleanup();
		}
	});

	it("does not re-analyse an observed mutation whose state a classified call already analysed", async () => {
		// The sequential half of the same gap: the already-analysed latch. A
		// classified call analyses a state and stamps the latch; an armed
		// observation for the SAME bytes then settles and, in round 2's head,
		// dispatched a second pipeline for a state nothing had changed since.
		const env = setupTestEnvironment("pi-lens-2464-f1-latch-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		const previousDebounce = process.env.PI_LENS_TOOL_RESULT_DEBOUNCE_MS;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		delete process.env.PI_LENS_TOOL_RESULT_DEBOUNCE_MS;
		const { runPipeline } = await import("../../clients/pipeline.js");
		try {
			const filePath = path.join(env.tmpDir, "latched.ts");
			fs.writeFileSync(filePath, SOURCE);
			const { runtime, cacheManager } = newSession(env.tmpDir);
			vi.mocked(runPipeline).mockClear();

			// Armed BEFORE the classified write, so the settle below sees the same
			// bytes the classified call just analysed.
			const observedEvent = patchEvent(filePath, "call-2464-f1-latch-obs");
			await handleToolCall(
				toolCallDeps({
					event: observedEvent,
					cwd: env.tmpDir,
					runtime,
					cacheManager,
				}),
			);

			fs.writeFileSync(filePath, `${SOURCE}const d = 4;\n`);
			await handleToolResult(
				toolResultDeps({
					event: {
						toolName: "edit",
						toolCallId: "call-2464-f1-latch-cls",
						input: { path: filePath },
						content: [{ type: "text", text: "edited" }],
					},
					runtime,
					cacheManager,
				}),
			);
			expect(vi.mocked(runPipeline)).toHaveBeenCalledTimes(1);

			await handleToolResult(
				toolResultDeps({ event: observedEvent, runtime, cacheManager }),
			);

			// Same turn, same bytes, nothing to re-analyse.
			expect(vi.mocked(runPipeline)).toHaveBeenCalledTimes(1);
		} finally {
			if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
			else process.env.PILENS_DATA_DIR = previousDataDir;
			if (previousDebounce === undefined)
				delete process.env.PI_LENS_TOOL_RESULT_DEBOUNCE_MS;
			else process.env.PI_LENS_TOOL_RESULT_DEBOUNCE_MS = previousDebounce;
			env.cleanup();
		}
	});

	it("never evicts a live registration when a stale release names the same file", async () => {
		// The identity guard in `releaseInFlightPipeline`, in isolation. With the
		// shared claim now consulted by both dispatch call sites, no production
		// path can register the same file+hash twice any more — so the guard's
		// trigger is unreachable end to end, and driving the registry seam
		// directly is the only honest way to prove the guard is doing work.
		// Delete the `inFlightPipelines.get(filePath) === registered` conjunct and
		// the last assertion goes red.
		//
		// Imported dynamically, and ONLY here, so the module-level imports of this
		// file stay to symbols that exist on pre-fix code — every other case in
		// it then fails on an assertion rather than on a missing export.
		const {
			claimPipelineDispatch,
			registerInFlightPipeline,
			releaseInFlightPipeline,
		} = await import("../../clients/runtime-tool-result.js");
		clearLastAnalyzedStateCache();
		const filePath = path.join(
			process.cwd(),
			"tests",
			"__identity-guard-2464.ts",
		);
		const settled = Promise.resolve();
		const liveClassified = {
			promise: settled,
			participantIds: ["c"],
			participantTotal: 1,
		};

		// Two registrations for one state, the shape round 2's observed path
		// could produce: the second overwrites the first inside one inner map.
		const firstMap = registerInFlightPipeline(filePath, "hash-1", {
			promise: settled,
			participantIds: ["a"],
			participantTotal: 1,
		});
		const secondMap = registerInFlightPipeline(filePath, "hash-1", {
			promise: settled,
			participantIds: ["b"],
			participantTotal: 1,
		});
		expect(secondMap).toBe(firstMap);

		// A releases: the map empties and the outer entry goes with it.
		releaseInFlightPipeline(filePath, "hash-1", firstMap);
		// A live, unrelated pipeline re-creates the outer entry under a FRESH map.
		const classifiedMap = registerInFlightPipeline(
			filePath,
			"hash-2",
			liveClassified,
		);
		expect(classifiedMap).not.toBe(firstMap);
		// B releases last, holding the stale reference.
		releaseInFlightPipeline(filePath, "hash-1", secondMap);

		const claim = claimPipelineDispatch({
			filePath,
			stateHash: "hash-2",
			turnIndex: 7,
			participantId: "d",
			dbg: () => {},
		});
		expect(claim.proceed).toBe(false);
		expect(liveClassified.participantTotal).toBe(2);

		releaseInFlightPipeline(filePath, "hash-2", classifiedMap);
	});
});

describe("#2464 review round 3 — F2: the observed dispatch targets a RECORDED path", () => {
	it("never dispatches the directory an unknown directory-target tool named", async () => {
		// `collectObservationUniverse` explicitly supports a DIRECTORY target (its
		// own entries, non-recursively), so a codemod armed on a directory is a
		// real production shape, not a contrived one. The membership guard is what
		// stops the directory itself from reaching `runPipeline`: neutralize it to
		// `pathsEqual(candidate, candidate)` and this case goes red, where a call
		// count alone stays green.
		const env = setupTestEnvironment("pi-lens-2464-f2-dir-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		const { runPipeline } = await import("../../clients/pipeline.js");
		try {
			const targetDir = path.join(env.tmpDir, "codemod-target");
			fs.mkdirSync(targetDir, { recursive: true });
			const insideDir = path.join(targetDir, "touched.ts");
			fs.writeFileSync(insideDir, SOURCE);
			const { runtime, cacheManager } = newSession(env.tmpDir);
			vi.mocked(runPipeline).mockClear();

			// An unknown tool whose only path-shaped field names the DIRECTORY.
			const event = {
				toolName: "dir_codemod",
				toolCallId: "call-2464-f2-dir",
				input: { path: targetDir, rule: "rename" },
				content: [{ type: "text", text: "rewrote 1 file" }],
			};
			expect(classifyMutatingTool(event as never)).toBeUndefined();
			await handleToolCall(
				toolCallDeps({ event, cwd: env.tmpDir, runtime, cacheManager }),
			);
			// The tool writes a file INSIDE the directory it named.
			fs.writeFileSync(insideDir, `${SOURCE}const d = 4;\n`);
			await handleToolResult(toolResultDeps({ event, runtime, cacheManager }));

			const dispatchedPaths = vi
				.mocked(runPipeline)
				.mock.calls.map(
					(call) => (call[0] as unknown as { filePath?: string }).filePath,
				);
			// `runPipeline` on a directory is meaningless — every runner it fans out
			// to reads the path as a file.
			expect(dispatchedPaths).not.toContain(targetDir);
			expect(dispatchedPaths).toEqual([]);
		} finally {
			if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
			else process.env.PILENS_DATA_DIR = previousDataDir;
			env.cleanup();
		}
	});
});
