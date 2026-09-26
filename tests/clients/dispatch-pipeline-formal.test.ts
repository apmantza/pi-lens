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
import {
	clearWidgetState,
	getFileDiagnostics,
} from "../../clients/widget-state.js";
import { setupTestEnvironment } from "./test-utils.js";

vi.mock("../../clients/dispatch/integration.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../clients/dispatch/integration.js")
	>()),
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

function blocking(filePath: string, label: string) {
	const d = {
		id: `tsc:${label}`,
		tool: "tsc",
		rule: "TS2322",
		message: `BLOCKER-FROM-${label}`,
		filePath,
		line: 1,
		column: 1,
		severity: "error",
		semantic: "blocking",
	};
	return {
		diagnostics: [d],
		blockers: [d],
		warnings: [],
		baselineWarningCount: 0,
		fixed: [],
		resolvedCount: 0,
		output: `STOP ${label}`,
		blockerOutput: `STOP ${label}`,
		hasBlockers: true,
	};
}

/** The revision label a fixture file's bytes carry (`v1`, `v2`, ...). */
function revisionOf(filePath: string): string {
	return /v\d/.exec(fs.readFileSync(filePath, "utf8"))?.[0] ?? "none";
}

/**
 * Dispatch double for the inline-record replays: `slow` revisions park until
 * their gate opens, and `entered` opens once one of them has been dispatched.
 */
function scriptDispatch(verdicts: Record<string, "clean" | "blocker">) {
	const entered = gate();
	const release = gate();
	vi.mocked(dispatchLintWithResult).mockImplementation(async (fp) => {
		const rev = revisionOf(fp as string);
		if (rev === "v1") {
			entered.open();
			await release.p;
		}
		return (
			verdicts[rev] === "blocker" ? blocking(fp as string, rev) : clean(rev)
		) as never;
	});
	return { entered, release };
}

function inlineSummaries(runtime: RuntimeCoordinator) {
	return runtime.getInlineBlockersSnapshot().map((r) => ({
		writeIndex: r.writeIndex,
		blocker: r.summary.match(/BLOCKER-FROM-v\d/)?.[0],
	}));
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

	// ── #3507: the inline-blocker record (InlineParallel) ──────────────────────
	// P1 is the older edit's pipeline, parked in its dispatch; P2, the newer
	// edit's, runs to completion; then P1 settles last.
	async function olderSettlesLast(
		verdicts: Record<string, "clean" | "blocker">,
	): Promise<{
		runtime: RuntimeCoordinator;
		filePath: string;
		afterP2: ReturnType<typeof inlineSummaries>;
		cleanup: () => void;
	}> {
		const env = setupTestEnvironment("tla-inline-");
		const filePath = path.join(env.tmpDir, "a.ts");
		const runtime = new RuntimeCoordinator();
		runtime.projectRoot = env.tmpDir;
		runtime.beginTurn();
		const { entered, release } = scriptDispatch(verdicts);
		fs.writeFileSync(filePath, "export const x = 'v1';\n");
		const p1 = handleToolResult({
			...deps(runtime, noBiome),
			event: ev("edit", filePath, "c1"),
		} as never);
		await entered.p;
		fs.writeFileSync(filePath, "export const y = 'v2';\n");
		await handleToolResult({
			...deps(runtime, noBiome),
			event: ev("edit", filePath, "c2"),
		} as never);
		const afterP2 = inlineSummaries(runtime);
		release.open();
		await p1;
		return { runtime, filePath, afterP2, cleanup: env.cleanup };
	}

	it("InlineParallel (#3507): an older clean pipeline that settles last does not erase the newer edit's blocker", async () => {
		const run = await olderSettlesLast({ v1: "clean", v2: "blocker" });
		try {
			expect(run.afterP2).toEqual([
				{ writeIndex: 2, blocker: "BLOCKER-FROM-v2" },
			]);
			expect(inlineSummaries(run.runtime)).toEqual(run.afterP2);
			expect(run.runtime.gitGuardHasBlockers).toBe(true);
			// The widget store's own guard agrees.
			expect(
				(getFileDiagnostics(run.filePath) ?? []).map((d) => d.message),
			).toEqual(["BLOCKER-FROM-v2"]);
		} finally {
			run.cleanup();
		}
	});

	it("InlineParallel (#3507): an older blocker that settles last does not replace the newer edit's verdict", async () => {
		const run = await olderSettlesLast({ v1: "blocker", v2: "blocker" });
		try {
			expect(inlineSummaries(run.runtime)).toEqual([
				{ writeIndex: 2, blocker: "BLOCKER-FROM-v2" },
			]);
		} finally {
			run.cleanup();
		}
	});

	it("InlineParallel (#3507): an older blocker that settles after the newer edit cleared the record neither restores it nor latches the commit gate", async () => {
		const run = await olderSettlesLast({ v1: "blocker", v2: "clean" });
		try {
			expect(run.afterP2).toEqual([]);
			expect(inlineSummaries(run.runtime)).toEqual([]);
			expect(run.runtime.gitGuardHasBlockers).toBe(false);
		} finally {
			run.cleanup();
		}
	});

	it("InlineParallel (#3507): the order spans turns, so a later turn's clean clears a blocker recorded under a higher write index", async () => {
		const env = setupTestEnvironment("tla-inline-turns-");
		try {
			const filePath = path.join(env.tmpDir, "a.ts");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.beginTurn();
			vi.mocked(dispatchLintWithResult).mockImplementation(
				async (fp) =>
					(revisionOf(fp as string) === "v3"
						? blocking(fp as string, "v3")
						: clean(revisionOf(fp as string))) as never,
			);
			for (const rev of ["v1", "v2", "v3"]) {
				fs.writeFileSync(filePath, `export const x = '${rev}';\n`);
				await handleToolResult({
					...deps(runtime, noBiome),
					event: ev("edit", filePath, rev),
				} as never);
			}
			expect(inlineSummaries(runtime)).toEqual([
				{ writeIndex: 3, blocker: "BLOCKER-FROM-v3" },
			]);
			runtime.beginTurn();
			fs.writeFileSync(filePath, "export const x = 'v4';\n");
			await handleToolResult({
				...deps(runtime, noBiome),
				event: ev("edit", filePath, "v4"),
			} as never);
			expect(inlineSummaries(runtime)).toEqual([]);
			expect(runtime.gitGuardHasBlockers).toBe(false);
		} finally {
			env.cleanup();
		}
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
