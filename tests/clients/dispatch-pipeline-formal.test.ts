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
// pi's real per-file queue, the one its `edit`/`write` tools run under. The
// pi host adapter hands the same export to pi-lens' writers (index.ts).
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BiomeClient } from "../../clients/biome-client.js";
import type { CacheManager } from "../../clients/cache-manager.js";
import { FormatService } from "../../clients/format-service.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { setHostFileMutationQueueLoader } from "../../clients/file-mutation-queue.js";
import { HOOK_WALL_BUDGET_MS } from "../../clients/hook-budgets.js";
import { runPipeline } from "../../clients/pipeline.js";
import { handleAgentEnd } from "../../clients/runtime-agent-end.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { handleToolResult } from "../../clients/runtime-tool-result.js";
import {
	clearWidgetState,
	exportWidgetState,
	getFileDiagnostics,
	reconcileScanDiagnostics,
	recordRunner,
} from "../../clients/widget-state.js";
import { setupTestEnvironment } from "./test-utils.js";

vi.mock("../../clients/dispatch/integration.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../clients/dispatch/integration.js")
	>()),
	dispatchLintWithResult: vi.fn(),
	computeCascadeForFile: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../clients/lsp/capabilities.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../clients/lsp/capabilities.js")
	>()),
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

// #3506 r1: an in-place formatter CHILD for the real FormatService, the shape
// of formatters.ts formatFile's spawn: it reads the file, runs, and writes its
// format of what it read, whatever the service's budget decided meanwhile.
// Like formatFile, it enters pi's queue (`enter`, #3558) before that read.
const formatterChild = vi.hoisted(() => ({
	active: false,
	parked: undefined as undefined | (() => void),
	resume: undefined as undefined | Promise<void>,
}));
vi.mock("../../clients/formatters-lazy.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/formatters-lazy.js")>();
	return {
		...actual,
		loadFormatters: async () => {
			const real = await actual.loadFormatters();
			if (!formatterChild.active) return real;
			return {
				...real,
				getFormattersForFile: async () => [{ name: "slowfmt" }],
				formatFile: async (
					fp: string,
					_formatter: unknown,
					enter?: () => Promise<void>,
				) => {
					await enter?.();
					const before = fs.readFileSync(fp, "utf8");
					formatterChild.parked?.();
					await formatterChild.resume;
					fs.writeFileSync(fp, before.replace("let value=1", "let value = 1;"));
					return { success: true, changed: true, outcome: "formatted" };
				},
			};
		},
	};
});

import { dispatchLintWithResult } from "../../clients/dispatch/integration.js";
import {
	COLLECT_LATER_THRESHOLD_MS,
	observeRunnerLatency,
	resetObservedRunnerLatency,
} from "../../clients/dispatch/collect-later-tier.js";
import {
	createDispatchContext,
	dispatchForFile,
	RunnerRegistry,
} from "../../clients/dispatch/dispatcher.js";
import { FactStore } from "../../clients/dispatch/fact-store.js";
import {
	drainPendingRunnerFindings,
	resetPendingRunnerFindings,
} from "../../clients/dispatch/pending-runner-findings.js";
import { getLSPService } from "../../clients/lsp/capabilities.js";
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

/**
 * The Biome agreement evidence the autofix gate requires before it lets an
 * autonomous writer touch the project.
 */
function writeBiomeAgreement(root: string): void {
	fs.writeFileSync(
		path.join(root, "package.json"),
		JSON.stringify({ devDependencies: { "@biomejs/biome": "^2.4.10" } }),
	);
	fs.writeFileSync(
		path.join(root, "package-lock.json"),
		JSON.stringify({
			lockfileVersion: 3,
			packages: {
				"": {},
				"node_modules/@biomejs/biome": { version: "2.4.10" },
			},
		}),
	);
}

/**
 * The agent's next edit of `filePath`, run the way pi's edit tool runs it:
 * read-modify-write inside pi's mutation queue. The body is synchronous once
 * the queue admits it.
 */
function agentAppend(filePath: string, line: string) {
	let wrote = false;
	const done = withFileMutationQueue(filePath, async () => {
		fs.writeFileSync(filePath, `${fs.readFileSync(filePath, "utf8")}${line}`);
		wrote = true;
	});
	return { done, wrote: () => wrote };
}

/**
 * Resolves once every queue call made before it has registered: pi chains
 * registrations through one module-wide promise, so a call on another path
 * registers after them. An earlier call whose file is free has run by then.
 */
function afterQueueRegistration(dir: string): Promise<void> {
	return withFileMutationQueue(
		path.join(dir, "registration-barrier"),
		async () => {},
	);
}

/**
 * A `BiomeClient.fixFileAsync` double with the real one's shape
 * (biome-client.ts): read the file, let `lint --write` rewrite what it read,
 * read it back, and report a fix only when the bytes moved. `hold` parks the
 * process between its read and the step `holdBefore` names.
 */
function gatedFixer(holdBefore: "write" | "after-read") {
	const parked = gate();
	const resume = gate();
	const fixer = {
		isSupportedFile: () => true,
		ensureAvailable: async () => true,
		fixFileAsync: async (fp: string) => {
			const before = fs.readFileSync(fp, "utf8");
			if (holdBefore === "write") {
				parked.open();
				await resume.p;
			}
			fs.writeFileSync(fp, before.replace("var ", "const "));
			if (holdBefore === "after-read") {
				parked.open();
				await resume.p;
			}
			const after = fs.readFileSync(fp, "utf8");
			return {
				success: true,
				changed: before !== after,
				fixed: before !== after ? 1 : 0,
			};
		},
	} as unknown as BiomeClient;
	return { fixer, parked, resume };
}

const text = (r: unknown) =>
	((r as { content?: Array<{ text?: string }> })?.content ?? [])
		.map((c) => c.text ?? "")
		.join("\n");

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

	// #3540: `writeIndex` restarts at every beginTurn, so the widget's guard
	// must order a turn-2 write after every turn-1 write of the same file.
	it("widget order (#3540): a file's first edit in turn 2 replaces its turn-1 widget verdict", async () => {
		const env = setupTestEnvironment("tla-widget-turns-");
		try {
			const filePath = path.join(env.tmpDir, "a.ts");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.beginTurn();
			vi.mocked(dispatchLintWithResult).mockImplementation(
				async (fp, _cwd, _pi, _ranges, _log, options) => {
					const rev = revisionOf(fp as string);
					// The real dispatcher records each runner under the token the
					// pipeline hands it (`createDispatchContext` -> `recordRunner`).
					recordRunner(
						fp as string,
						"tsc",
						`ran-${rev}`,
						0,
						0,
						options?.writeIndex,
					);
					return (
						rev === "v3" ? blocking(fp as string, "v3") : clean(rev)
					) as never;
				},
			);
			const runnerStatus = () =>
				exportWidgetState()
					.files.find((f) => f.filePath === filePath)
					?.runners.find(([id]) => id === "tsc")?.[1].status;
			for (const rev of ["v1", "v2", "v3"]) {
				fs.writeFileSync(filePath, `export const x = '${rev}';\n`);
				await handleToolResult({
					...deps(runtime, noBiome),
					event: ev("edit", filePath, rev),
				} as never);
			}
			expect(
				(getFileDiagnostics(filePath) ?? []).map((d) => d.message),
			).toEqual(["BLOCKER-FROM-v3"]);
			expect(runnerStatus()).toBe("ran-v3");
			runtime.beginTurn();
			fs.writeFileSync(filePath, "export const x = 'v4';\n");
			await handleToolResult({
				...deps(runtime, noBiome),
				event: ev("edit", filePath, "v4"),
			} as never);
			expect(
				(getFileDiagnostics(filePath) ?? []).map((d) => d.message),
			).toEqual([]);
			expect(runnerStatus()).toBe("ran-v4");
		} finally {
			env.cleanup();
		}
	});

	it("widget order (#3540): an older same-turn pipeline that settles last still does not replace the newer edit's widget verdict", async () => {
		const run = await olderSettlesLast({ v1: "blocker", v2: "clean" });
		try {
			expect(
				(getFileDiagnostics(run.filePath) ?? []).map((d) => d.message),
			).toEqual([]);
		} finally {
			run.cleanup();
		}
	});

	it("widget order (#3540): a turn-1 pipeline that settles after a turn-2 pipeline of the same file started does not write the widget", async () => {
		const env = setupTestEnvironment("tla-widget-turn-late-");
		try {
			const filePath = path.join(env.tmpDir, "a.ts");
			const other = path.join(env.tmpDir, "b.ts");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.beginTurn();
			const entered = { v1: gate(), v2: gate() };
			const release = { v1: gate(), v2: gate() };
			vi.mocked(dispatchLintWithResult).mockImplementation(async (fp) => {
				const rev = revisionOf(fp as string);
				if (rev === "v1" || rev === "v2") {
					entered[rev].open();
					await release[rev].p;
				}
				return (
					rev === "v1" ? blocking(fp as string, rev) : clean(rev)
				) as never;
			});
			// Two writes of another file first: a.ts's turn-1 token is w=3.
			for (const id of ["o1", "o2"]) {
				fs.writeFileSync(other, `export const o = '${id}';\n`);
				await handleToolResult({
					...deps(runtime, noBiome),
					event: ev("edit", other, id),
				} as never);
			}
			fs.writeFileSync(filePath, "export const x = 'v1';\n");
			const late = handleToolResult({
				...deps(runtime, noBiome),
				event: ev("edit", filePath, "c1"),
			} as never);
			await entered.v1.p;
			runtime.beginTurn();
			// a.ts's first edit in turn 2 (w=1) has started its analysis.
			fs.writeFileSync(filePath, "export const x = 'v2';\n");
			const newer = handleToolResult({
				...deps(runtime, noBiome),
				event: ev("edit", filePath, "c2"),
			} as never);
			await entered.v2.p;
			release.v1.open();
			await late;
			expect(
				(getFileDiagnostics(filePath) ?? []).map((d) => d.message),
			).toEqual([]);
			release.v2.open();
			await newer;
			expect(
				(getFileDiagnostics(filePath) ?? []).map((d) => d.message),
			).toEqual([]);
		} finally {
			env.cleanup();
		}
	});

	// #3540 r2 (F1): the widget's write guards outlive `resetForSession` — a
	// `/reload` keeps the widget, and a stale session-1 write can land after
	// `/new` cleared it. The token's turn half is an order turn that a session
	// reset never restarts, so session 1's turn 5 never outranks session 2.
	describe("widget order across a session reset (#3540 r2)", () => {
		const widget = (filePath: string) =>
			(getFileDiagnostics(filePath) ?? []).map((d) => d.message);

		function scriptVerdicts(verdicts: Record<string, "clean" | "blocker">) {
			vi.mocked(dispatchLintWithResult).mockImplementation(async (fp) => {
				const rev = revisionOf(fp as string);
				return (
					verdicts[rev] === "blocker" ? blocking(fp as string, rev) : clean(rev)
				) as never;
			});
		}

		async function edit(
			runtime: RuntimeCoordinator,
			filePath: string,
			bytes: string,
		) {
			fs.writeFileSync(filePath, bytes);
			return handleToolResult({
				...deps(runtime, noBiome),
				event: ev("edit", filePath, bytes),
			} as never);
		}

		/**
		 * Session 1 runs five turns; in turn 5 another file's two edits come
		 * first, so a.ts's dispatch draws write index 3.
		 */
		async function fiveTurns(runtime: RuntimeCoordinator, dir: string) {
			for (let turn = 0; turn < 5; turn += 1) runtime.beginTurn();
			const other = path.join(dir, "b.ts");
			await edit(runtime, other, "export const o = 'o1';\n");
			await edit(runtime, other, "export const o = 'o2';\n");
		}

		it("A: after /reload, session 2's first clean edit replaces session 1's turn-5 widget blocker", async () => {
			const env = setupTestEnvironment("tla-widget-reload-");
			try {
				const filePath = path.join(env.tmpDir, "a.ts");
				const runtime = new RuntimeCoordinator();
				runtime.projectRoot = env.tmpDir;
				scriptVerdicts({ v1: "blocker", v2: "clean" });
				await fiveTurns(runtime, env.tmpDir);
				await edit(runtime, filePath, "export const x = 'v1';\n");
				expect(widget(filePath)).toEqual(["BLOCKER-FROM-v1"]);
				// /reload: session_start resets the runtime and keeps the widget.
				runtime.resetForSession();
				runtime.beginTurn();
				await edit(runtime, filePath, "export const x = 'v2';\n");
				expect(widget(filePath)).toEqual([]);
			} finally {
				env.cleanup();
			}
		});

		it("A no-drop: in the same session, turn 6's clean edit replaces the turn-5 widget blocker", async () => {
			const env = setupTestEnvironment("tla-widget-reload-nodrop-");
			try {
				const filePath = path.join(env.tmpDir, "a.ts");
				const runtime = new RuntimeCoordinator();
				runtime.projectRoot = env.tmpDir;
				scriptVerdicts({ v1: "blocker", v2: "clean" });
				await fiveTurns(runtime, env.tmpDir);
				await edit(runtime, filePath, "export const x = 'v1';\n");
				expect(widget(filePath)).toEqual(["BLOCKER-FROM-v1"]);
				runtime.beginTurn();
				await edit(runtime, filePath, "export const x = 'v2';\n");
				expect(widget(filePath)).toEqual([]);
			} finally {
				env.cleanup();
			}
		});

		/**
		 * A session-1 turn-5 pipeline parks in its dispatch; `between` runs
		 * before it is released (a `/new`, or a turn boundary); then session 2
		 * (or turn 6) edits the file clean.
		 */
		async function parkedTurnFive(
			between: (runtime: RuntimeCoordinator) => void,
		) {
			const env = setupTestEnvironment("tla-widget-parked-");
			try {
				const filePath = path.join(env.tmpDir, "a.ts");
				const runtime = new RuntimeCoordinator();
				runtime.projectRoot = env.tmpDir;
				await fiveTurns(runtime, env.tmpDir);
				const entered = gate();
				const release = gate();
				vi.mocked(dispatchLintWithResult).mockImplementation(async (fp) => {
					const rev = revisionOf(fp as string);
					if (rev === "v1") {
						entered.open();
						await release.p;
						return blocking(fp as string, rev) as never;
					}
					return clean(rev) as never;
				});
				const parked = edit(runtime, filePath, "export const x = 'v1';\n");
				await entered.p;
				between(runtime);
				release.open();
				// index.ts' bound abandoned it; its widget write lands now.
				await parked;
				runtime.beginTurn();
				await edit(runtime, filePath, "export const x = 'v2';\n");
				return widget(filePath);
			} finally {
				env.cleanup();
			}
		}

		it("B: a session-1 pipeline released after /new plants no token that outranks session 2's clean edit", async () => {
			expect(
				await parkedTurnFive((runtime) => {
					// /new: session_start resets the runtime and clears the widget.
					runtime.resetForSession();
					clearWidgetState();
				}),
			).toEqual([]);
		});

		it("B no-drop: in the same session, a turn-5 pipeline released at the turn boundary is replaced by turn 6's clean edit", async () => {
			expect(await parkedTurnFive(() => {})).toEqual([]);
		});

		it("mixed producers: after /reload, a pipeline verdict drawn after a lens reservation in the same turn is not dropped", async () => {
			const env = setupTestEnvironment("tla-widget-mixed-");
			try {
				const filePath = path.join(env.tmpDir, "a.ts");
				const runtime = new RuntimeCoordinator();
				runtime.projectRoot = env.tmpDir;
				scriptVerdicts({ v1: "clean", v2: "blocker" });
				await fiveTurns(runtime, env.tmpDir);
				await edit(runtime, filePath, "export const x = 'v1';\n");
				runtime.resetForSession();
				runtime.beginTurn();
				// lsp_diagnostics' reservation (index.ts injects this), then a
				// confirmed clean for the file...
				expect(
					reconcileScanDiagnostics(
						filePath,
						[],
						true,
						runtime.nextWriteOrderToken(),
					),
				).toBe(true);
				// ...then the agent's next edit of it blocks.
				await edit(runtime, filePath, "export const x = 'v2';\n");
				expect(widget(filePath)).toEqual(["BLOCKER-FROM-v2"]);
			} finally {
				env.cleanup();
			}
		});
	});

	it("session straddle (#3506 r1 F8): an old session's handler that settles after session_start records nothing into the new session", async () => {
		const env = setupTestEnvironment("tla-inline-session-");
		try {
			const filePath = path.join(env.tmpDir, "a.ts");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			for (let turn = 0; turn < 3; turn += 1) runtime.beginTurn();
			const { entered, release } = scriptDispatch({
				v1: "blocker",
				v2: "blocker",
			});
			fs.writeFileSync(filePath, "export const x = 'v1';\n");
			// index.ts' bound abandoned this handler; it runs on.
			const late = handleToolResult({
				...deps(runtime, noBiome),
				event: ev("edit", filePath, "c1"),
			} as never);
			await entered.p;
			runtime.resetForSession();
			runtime.beginTurn();
			resetDegradationLedger();
			release.open();
			await late;
			expect(inlineSummaries(runtime)).toEqual([]);
			// The dropped write is observable, not silent.
			expect(
				getDegradationSummary().filter(
					(group) => group.kind === "generation-guard-stale-write",
				),
			).toEqual([
				expect.objectContaining({
					latestReasons: [
						expect.objectContaining({
							subject: `runtime-session:${filePath}`,
						}),
					],
				}),
			]);
			// The new session's own first edit records under its own token.
			fs.writeFileSync(filePath, "export const y = 'v2';\n");
			await handleToolResult({
				...deps(runtime, noBiome),
				event: ev("edit", filePath, "c2"),
			} as never);
			expect(inlineSummaries(runtime)).toEqual([
				{ writeIndex: 1, blocker: "BLOCKER-FROM-v2" },
			]);
		} finally {
			env.cleanup();
		}
	});

	it("session straddle (#3506 r1 F8): an old session's clean that settles after session_start does not clear the new session's blocker", async () => {
		const env = setupTestEnvironment("tla-inline-session-clear-");
		try {
			const filePath = path.join(env.tmpDir, "a.ts");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			for (let turn = 0; turn < 3; turn += 1) runtime.beginTurn();
			const { entered, release } = scriptDispatch({
				v1: "clean",
				v2: "blocker",
			});
			fs.writeFileSync(filePath, "export const x = 'v1';\n");
			const late = handleToolResult({
				...deps(runtime, noBiome),
				event: ev("edit", filePath, "c1"),
			} as never);
			await entered.p;
			runtime.resetForSession();
			runtime.beginTurn();
			fs.writeFileSync(filePath, "export const y = 'v2';\n");
			await handleToolResult({
				...deps(runtime, noBiome),
				event: ev("edit", filePath, "c2"),
			} as never);
			release.open();
			await late;
			expect(inlineSummaries(runtime)).toEqual([
				{ writeIndex: 1, blocker: "BLOCKER-FROM-v2" },
			]);
		} finally {
			env.cleanup();
		}
	});

	// ── #3568: a handler index.ts abandoned, resuming after session_start ─────
	describe("#3568: a tool_result handler that straddles a session replacement", () => {
		/** A clean verdict carrying one fixable and one code-quality warning. */
		function withWarnings(filePath: string, label: string) {
			const warning = (rule: string, fixable: boolean) => ({
				id: `eslint:${rule}:${label}`,
				tool: "eslint",
				rule,
				message: `${rule.toUpperCase()}-FROM-${label}`,
				filePath,
				line: 1,
				column: 1,
				severity: "warning",
				semantic: "warning",
				fixable,
			});
			return {
				...clean(label),
				warnings: [warning("no-var", true), warning("complexity", false)],
			};
		}
		const warningsOf = (runtime: RuntimeCoordinator) => ({
			actionable: runtime.peekActionableWarnings().map((w) => w.message),
			quality: runtime.peekCodeQualityWarnings().map((w) => w.message),
		});
		const staleSubjects = () =>
			getDegradationSummary()
				.filter((group) => group.kind === "generation-guard-stale-write")
				.flatMap((group) => group.latestReasons.map((r) => r.subject));

		it("a session-1 handler's warnings, settling after session_start, do not land in session 2's turn", async () => {
			const env = setupTestEnvironment("tla-3568-warnings-");
			try {
				const filePath = path.join(env.tmpDir, "a.ts");
				const runtime = new RuntimeCoordinator();
				runtime.projectRoot = env.tmpDir;
				runtime.beginTurn();
				const entered = gate();
				const release = gate();
				vi.mocked(dispatchLintWithResult).mockImplementation(async (fp) => {
					entered.open();
					await release.p;
					return withWarnings(fp as string, "v1") as never;
				});
				fs.writeFileSync(filePath, "export const x = 'v1';\n");
				const late = handleToolResult({
					...deps(runtime, noBiome),
					event: ev("edit", filePath, "c1"),
				} as never);
				await entered.p;
				runtime.resetForSession();
				runtime.beginTurn();
				resetDegradationLedger();
				release.open();
				await late;
				expect(warningsOf(runtime)).toEqual({ actionable: [], quality: [] });
				expect(staleSubjects()).toEqual([`runtime-session:${filePath}`]);
			} finally {
				env.cleanup();
			}
		});

		it("no-drop (shape 54): a handler that stays in its session records its warnings", async () => {
			const env = setupTestEnvironment("tla-3568-warnings-own-");
			try {
				const filePath = path.join(env.tmpDir, "a.ts");
				const runtime = new RuntimeCoordinator();
				runtime.projectRoot = env.tmpDir;
				runtime.beginTurn();
				vi.mocked(dispatchLintWithResult).mockImplementation(
					async (fp) => withWarnings(fp as string, "v1") as never,
				);
				fs.writeFileSync(filePath, "export const x = 'v1';\n");
				await handleToolResult({
					...deps(runtime, noBiome),
					event: ev("edit", filePath, "c1"),
				} as never);
				expect(warningsOf(runtime)).toEqual({
					actionable: ["NO-VAR-FROM-v1"],
					quality: ["COMPLEXITY-FROM-v1"],
				});
			} finally {
				env.cleanup();
			}
		});

		it("a handler parked before its dispatch captures its session at entry, so its verdict does not land in session 2", async () => {
			const env = setupTestEnvironment("tla-3568-entry-");
			try {
				const filePath = path.join(env.tmpDir, "a.ts");
				const runtime = new RuntimeCoordinator();
				runtime.projectRoot = env.tmpDir;
				runtime.beginTurn();
				vi.mocked(dispatchLintWithResult).mockImplementation(
					async (fp) =>
						({
							...blocking(fp as string, "v1"),
							warnings: withWarnings(fp as string, "v1").warnings,
						}) as never,
				);
				fs.writeFileSync(filePath, "export const x = 'v1';\n");
				// Parked on the on-demand clients bound, before any capture the
				// dispatch took until #3568.
				const late = handleToolResult({
					...deps(runtime, noBiome, { resident: false }),
					event: ev("edit", filePath, "c1"),
				} as never);
				await bootstrapGate.parked(1);
				runtime.resetForSession();
				runtime.beginTurn();
				resetDegradationLedger();
				bootstrapGate.release();
				await late;
				expect(inlineSummaries(runtime)).toEqual([]);
				expect(runtime.gitGuardHasBlockers).toBe(false);
				expect(warningsOf(runtime)).toEqual({ actionable: [], quality: [] });
				expect(staleSubjects()).toContain(`runtime-session:${filePath}`);
			} finally {
				env.cleanup();
			}
		});

		it("no-drop (shape 54): a handler parked before its dispatch in its own session records its verdict", async () => {
			const env = setupTestEnvironment("tla-3568-entry-own-");
			try {
				const filePath = path.join(env.tmpDir, "a.ts");
				const runtime = new RuntimeCoordinator();
				runtime.projectRoot = env.tmpDir;
				runtime.beginTurn();
				vi.mocked(dispatchLintWithResult).mockImplementation(
					async (fp) => blocking(fp as string, "v1") as never,
				);
				fs.writeFileSync(filePath, "export const x = 'v1';\n");
				const own = handleToolResult({
					...deps(runtime, noBiome, { resident: false }),
					event: ev("edit", filePath, "c1"),
				} as never);
				await bootstrapGate.parked(1);
				bootstrapGate.release();
				await own;
				expect(inlineSummaries(runtime)).toEqual([
					{ writeIndex: 1, blocker: "BLOCKER-FROM-v1" },
				]);
			} finally {
				env.cleanup();
			}
		});

		/**
		 * The collect-later runner through the real dispatcher: the dispatch
		 * double does with the pipeline's options what `dispatchLintWithResult`
		 * does (`tests/clients/dispatch/integration.test.ts` pins that hop),
		 * then runs an inline runner the case parks and a collect-later runner
		 * the dispatcher defers after it.
		 */
		async function deferAcrossReplacement(replace: boolean) {
			const env = setupTestEnvironment("tla-3568-runner-");
			try {
				const filePath = path.join(env.tmpDir, "a.ts");
				const runtime = new RuntimeCoordinator();
				runtime.projectRoot = env.tmpDir;
				runtime.beginTurn();
				resetPendingRunnerFindings();
				observeRunnerLatency({
					projectRoot: env.tmpDir,
					runnerId: "fixture-runner",
					durationMs: COLLECT_LATER_THRESHOLD_MS + 1,
				});
				const entered = gate();
				const release = gate();
				const registry = new RunnerRegistry();
				registry.register({
					id: "gate-runner",
					appliesTo: ["jsts"],
					priority: 1,
					run: async () => {
						entered.open();
						await release.p;
						return { status: "succeeded", diagnostics: [], semantic: "none" };
					},
				});
				registry.register({
					id: "fixture-runner",
					appliesTo: ["jsts"],
					priority: 2,
					run: async () => ({
						status: "succeeded",
						diagnostics: [],
						semantic: "warning",
					}),
				});
				vi.mocked(dispatchLintWithResult).mockImplementation(
					async (fp, cwd, pi, ranges, _log, options) => {
						const ctx = createDispatchContext(
							fp as string,
							cwd as string,
							pi as never,
							new FactStore(),
							true,
							ranges,
							options?.projectRoot,
							options?.writeIndex,
							options?.telemetryModel,
							options?.telemetryProvider,
							options?.sessionGeneration,
						);
						await dispatchForFile(
							ctx,
							[{ mode: "all", runnerIds: ["gate-runner", "fixture-runner"] }],
							registry,
						);
						return clean("v1") as never;
					},
				);
				fs.writeFileSync(filePath, "export const x = 'v1';\n");
				const handler = handleToolResult({
					...deps(runtime, noBiome),
					event: ev("edit", filePath, "c1"),
				} as never);
				await entered.p;
				if (replace) {
					// session_start: the store is cleared and the generation bumped
					// in one tick (runtime-session.ts).
					resetPendingRunnerFindings();
					runtime.resetForSession();
					runtime.beginTurn();
				}
				release.open();
				await handler;
				// Session 2's turn end drains the store.
				return (await drainPendingRunnerFindings(0)).map((e) => e.runnerId);
			} finally {
				resetObservedRunnerLatency();
				resetPendingRunnerFindings();
				env.cleanup();
			}
		}

		it("a session-1 handler's collect-later runner, deferred after session_start, is not drained by session 2's turn end", async () => {
			expect(await deferAcrossReplacement(true)).toEqual([]);
		});

		it("no-drop (shape 54): a handler that stays in its session defers its collect-later runner to its turn end", async () => {
			expect(await deferAcrossReplacement(false)).toEqual(["fixture-runner"]);
		});
	});

	// ── #3506: pi-lens' own writers inside pi's mutation queue ────────────────
	describe("the immediate autofix and the deferred drain", () => {
		beforeEach(() => {
			setHostFileMutationQueueLoader(async () => ({ withFileMutationQueue }));
		});
		afterEach(() => {
			setHostFileMutationQueueLoader(undefined);
			formatterChild.active = false;
			formatterChild.parked = undefined;
			formatterChild.resume = undefined;
		});

		it("FixerParallel (#3506): the immediate autofix does not write over an agent edit made through pi's queue", async () => {
			const env = setupTestEnvironment("tla-fixer-lost-");
			try {
				writeBiomeAgreement(env.tmpDir);
				const filePath = path.join(env.tmpDir, "a.ts");
				const runtime = new RuntimeCoordinator();
				runtime.projectRoot = env.tmpDir;
				runtime.beginTurn();
				vi.mocked(dispatchLintWithResult).mockImplementation(
					async () => clean("any") as never,
				);
				const { fixer, parked, resume } = gatedFixer("write");
				fs.writeFileSync(filePath, "var a = 1;\n");
				const write = handleToolResult({
					...deps(runtime, fixer),
					event: ev("write", filePath, "c1"),
				} as never);
				await parked.p;
				const agent = agentAppend(filePath, "export const AGENT_EDIT_2 = 2;\n");
				await afterQueueRegistration(env.tmpDir);
				resume.open();
				await write;
				await agent.done;
				expect(fs.readFileSync(filePath, "utf8")).toBe(
					"const a = 1;\nexport const AGENT_EDIT_2 = 2;\n",
				);
			} finally {
				env.cleanup();
			}
		});

		it("FixerAttribution (#3506): an agent edit is never reported as pi-lens' autofix, and its own analysis runs", async () => {
			const env = setupTestEnvironment("tla-fixer-attr-");
			try {
				writeBiomeAgreement(env.tmpDir);
				const filePath = path.join(env.tmpDir, "a.ts");
				const runtime = new RuntimeCoordinator();
				runtime.projectRoot = env.tmpDir;
				runtime.beginTurn();
				const analysed: string[] = [];
				vi.mocked(dispatchLintWithResult).mockImplementation(async (fp) => {
					analysed.push(fs.readFileSync(fp as string, "utf8"));
					return clean("any") as never;
				});
				// Nothing to fix: the fixer writes back what it read, then parks
				// before its after-read.
				const { fixer, parked, resume } = gatedFixer("after-read");
				fs.writeFileSync(filePath, "export const a = 1;\n");
				const write = handleToolResult({
					...deps(runtime, fixer),
					event: ev("write", filePath, "c1"),
				} as never);
				await parked.p;
				const agent = agentAppend(filePath, "export const AGENT_EDIT_2 = 2;\n");
				await afterQueueRegistration(env.tmpDir);
				resume.open();
				const writeResult = await write;
				await agent.done;
				await handleToolResult({
					...deps(runtime, noBiome),
					event: ev("edit", filePath, "c2"),
				} as never);
				expect(text(writeResult)).not.toContain("pi-lens applied autofix");
				expect(analysed.filter((a) => a.includes("AGENT_EDIT_2"))).toHaveLength(
					1,
				);
			} finally {
				env.cleanup();
			}
		});

		it("FixerQueueNoReToken (#3506): a pipeline whose autofix fixed a newer revision records it under a fresh write index", async () => {
			const env = setupTestEnvironment("tla-fixer-token-");
			try {
				writeBiomeAgreement(env.tmpDir);
				const filePath = path.join(env.tmpDir, "a.ts");
				const runtime = new RuntimeCoordinator();
				runtime.projectRoot = env.tmpDir;
				runtime.beginTurn();
				vi.mocked(dispatchLintWithResult).mockImplementation(async (fp) => {
					const bytes = fs.readFileSync(fp as string, "utf8");
					const rev = bytes.includes("E3")
						? "v3"
						: bytes.includes("E2")
							? "v2"
							: "v1";
					return blocking(fp as string, rev) as never;
				});
				// The first write's fixer starts late (its availability probe),
				// by which time two more edits have landed.
				const probing = gate();
				const probed = gate();
				const fixer = {
					isSupportedFile: () => true,
					ensureAvailable: async () => {
						probing.open();
						await probed.p;
						return true;
					},
					fixFileAsync: async (fp: string) => {
						const before = fs.readFileSync(fp, "utf8");
						fs.writeFileSync(fp, before.replace("var ", "const "));
						const after = fs.readFileSync(fp, "utf8");
						return {
							success: true,
							changed: before !== after,
							fixed: before !== after ? 1 : 0,
						};
					},
				} as unknown as BiomeClient;
				fs.writeFileSync(filePath, "var a = 1;\n");
				const write = handleToolResult({
					...deps(runtime, fixer),
					event: ev("write", filePath, "c1"),
				} as never);
				await probing.p;
				fs.writeFileSync(filePath, "var a = 1;\nexport const E2 = 2;\n");
				await handleToolResult({
					...deps(runtime, noBiome),
					event: ev("edit", filePath, "c2"),
				} as never);
				fs.writeFileSync(
					filePath,
					"var a = 1;\nexport const E2 = 2;\nexport const E3 = 3;\n",
				);
				probed.open();
				await write;
				// Edit 3's own handler finds the bytes already analysed.
				await handleToolResult({
					...deps(runtime, noBiome),
					event: ev("edit", filePath, "c3"),
				} as never);
				expect(fs.readFileSync(filePath, "utf8")).toBe(
					"const a = 1;\nexport const E2 = 2;\nexport const E3 = 3;\n",
				);
				expect(
					(getFileDiagnostics(filePath) ?? []).map((d) => d.message),
				).toEqual(["BLOCKER-FROM-v3"]);
				expect(inlineSummaries(runtime)).toEqual([
					{ writeIndex: 3, blocker: "BLOCKER-FROM-v3" },
				]);
			} finally {
				env.cleanup();
			}
		});

		/**
		 * #3559: edit A's fixer is parked in its availability probe; edit B
		 * records a blocker at turn 1, w=2; the turn ends; A's fixer then fixes
		 * B's bytes and re-tokens. `fixed` is the dispatch verdict on the fixed
		 * bytes (v3). `afterReload` (#3540 r2) runs the replay in a second
		 * session whose turn restarted while the order turn did not.
		 */
		async function reTokenAcrossTurn(
			fixed: "blocker" | "clean",
			afterReload = false,
		) {
			const env = setupTestEnvironment("tla-fixer-token-turn-");
			try {
				writeBiomeAgreement(env.tmpDir);
				const filePath = path.join(env.tmpDir, "a.ts");
				const runtime = new RuntimeCoordinator();
				runtime.projectRoot = env.tmpDir;
				if (afterReload) {
					for (let turn = 0; turn < 3; turn += 1) runtime.beginTurn();
					runtime.resetForSession();
				}
				runtime.beginTurn();
				vi.mocked(dispatchLintWithResult).mockImplementation(async (fp) => {
					const bytes = fs.readFileSync(fp as string, "utf8");
					if (bytes.includes("const a"))
						return (
							fixed === "blocker" ? blocking(fp as string, "v3") : clean("v3")
						) as never;
					const rev = bytes.includes("E2") ? "v2" : "v1";
					return blocking(fp as string, rev) as never;
				});
				const probing = gate();
				const probed = gate();
				const fixer = {
					isSupportedFile: () => true,
					ensureAvailable: async () => {
						probing.open();
						await probed.p;
						return true;
					},
					fixFileAsync: async (fp: string) => {
						const before = fs.readFileSync(fp, "utf8");
						fs.writeFileSync(fp, before.replace("var ", "const "));
						const after = fs.readFileSync(fp, "utf8");
						return {
							success: true,
							changed: before !== after,
							fixed: before !== after ? 1 : 0,
						};
					},
				} as unknown as BiomeClient;
				fs.writeFileSync(filePath, "var a = 1;\n");
				const write = handleToolResult({
					...deps(runtime, fixer),
					event: ev("write", filePath, "c1"),
				} as never);
				await probing.p;
				fs.writeFileSync(filePath, "var a = 1;\nexport const E2 = 2;\n");
				await handleToolResult({
					...deps(runtime, noBiome),
					event: ev("edit", filePath, "c2"),
				} as never);
				expect(inlineSummaries(runtime)).toEqual([
					{ writeIndex: 2, blocker: "BLOCKER-FROM-v2" },
				]);
				runtime.beginTurn();
				probed.open();
				await write;
				expect(fs.readFileSync(filePath, "utf8")).toBe(
					"const a = 1;\nexport const E2 = 2;\n",
				);
				return {
					inline: inlineSummaries(runtime),
					widget: (getFileDiagnostics(filePath) ?? []).map((d) => d.message),
				};
			} finally {
				env.cleanup();
			}
		}

		it("FixerQueueNoReToken across turns (#3559): a pipeline that re-tokens after its turn ended records its fixed-bytes verdict under the new turn", async () => {
			expect(await reTokenAcrossTurn("blocker")).toEqual({
				inline: [{ writeIndex: 1, blocker: "BLOCKER-FROM-v3" }],
				widget: ["BLOCKER-FROM-v3"],
			});
		});

		it("FixerQueueNoReToken across turns (#3559, #3540 r2): after /reload, the re-token orders by the order turn, not the session's turn", async () => {
			expect(await reTokenAcrossTurn("blocker", true)).toEqual({
				inline: [{ writeIndex: 1, blocker: "BLOCKER-FROM-v3" }],
				widget: ["BLOCKER-FROM-v3"],
			});
		});

		it("FixerQueueNoReToken across turns (#3559): a re-tokened clean verdict on the fixed bytes clears the older turn's blocker", async () => {
			expect(await reTokenAcrossTurn("clean")).toEqual({
				inline: [],
				widget: [],
			});
		});

		it("FixerQueue (#3506): a queued pipeline whose fixer changed nothing keeps its handler's token, so the newer edit's verdict stands", async () => {
			const env = setupTestEnvironment("tla-fixer-keep-token-");
			try {
				writeBiomeAgreement(env.tmpDir);
				const filePath = path.join(env.tmpDir, "a.ts");
				const runtime = new RuntimeCoordinator();
				runtime.projectRoot = env.tmpDir;
				runtime.beginTurn();
				vi.mocked(dispatchLintWithResult).mockImplementation(
					async (fp) =>
						blocking(fp as string, revisionOf(fp as string)) as never,
				);
				fs.writeFileSync(filePath, "export const a = 'v1';\n");
				// The agent's edit 2 already holds pi's queue for the file.
				const agentEntered = gate();
				const agentGo = gate();
				const agent = withFileMutationQueue(filePath, async () => {
					agentEntered.open();
					await agentGo.p;
					fs.writeFileSync(filePath, "export const a = 'v2';\n");
				});
				await agentEntered.p;
				// The first write's pipeline reaches its fixer and queues behind it.
				const atAutofix = gate();
				const dbg: Dbg = (message) => {
					if (message.startsWith("autofix: policy for")) atAutofix.open();
				};
				const { fixer, parked, resume } = gatedFixer("write");
				const write = handleToolResult({
					...deps(runtime, fixer, { dbg }),
					event: ev("write", filePath, "c1"),
				} as never);
				await atAutofix.p;
				agentGo.open();
				await agent;
				// The fixer reads v2 and finds nothing to fix; meanwhile edit 2's own
				// handler analyses v2.
				await parked.p;
				await handleToolResult({
					...deps(runtime, noBiome),
					event: ev("edit", filePath, "c2"),
				} as never);
				resume.open();
				await write;
				expect(
					(getFileDiagnostics(filePath) ?? []).map((d) => d.message),
				).toEqual(["BLOCKER-FROM-v2"]);
				expect(inlineSummaries(runtime)).toEqual([
					{ writeIndex: 2, blocker: "BLOCKER-FROM-v2" },
				]);
			} finally {
				env.cleanup();
			}
		});

		it("immediate format (#3506): the --immediate-format write does not overwrite an agent edit made through pi's queue", async () => {
			const env = setupTestEnvironment("tla-immediate-format-");
			try {
				const filePath = path.join(env.tmpDir, "a.ts");
				fs.writeFileSync(filePath, "let value=1\n");
				vi.mocked(dispatchLintWithResult).mockImplementation(
					async () => clean("any") as never,
				);
				// #3558: the real FormatService, which hands the hold to the
				// formatter (the child double below) to enter before its read.
				const parked = gate();
				const resume = gate();
				formatterChild.active = true;
				formatterChild.parked = parked.open;
				formatterChild.resume = resume.p;
				const formatService = new FormatService("tla", true);
				const run = runPipeline(
					{
						filePath,
						cwd: env.tmpDir,
						toolName: "edit",
						autofixMode: "deferred",
						getFlag: (name: string) =>
							name === "immediate-format" || name === "no-lsp",
						dbg: () => {},
					},
					{
						biomeClient: noBiome as unknown as BiomeClient,
						ruffClient: {} as never,
						metricsClient: {} as never,
						getFormatService: () => formatService,
						fixedThisTurn: new Set<string>(),
					},
				);
				await parked.p;
				const agent = agentAppend(filePath, "export const AGENT_EDIT_2 = 2;\n");
				await afterQueueRegistration(env.tmpDir);
				resume.open();
				await run;
				await agent.done;
				expect(fs.readFileSync(filePath, "utf8")).toBe(
					"let value = 1;\nexport const AGENT_EDIT_2 = 2;\n",
				);
			} finally {
				env.cleanup();
			}
		});

		function drainDeps(
			runtime: RuntimeCoordinator,
			env: { tmpDir: string },
			overrides: {
				biomeClient?: BiomeClient;
				getFormatService?: () => FormatService;
			},
		) {
			return {
				ctxCwd: env.tmpDir,
				getFlag: (name: string) => name === "no-lsp",
				notify: () => {},
				dbg: () => {},
				runtime,
				cacheManager: {
					addModifiedRange: () => {},
				} as unknown as CacheManager,
				biomeClient: overrides.biomeClient,
				ruffClient: {} as never,
				getFormatService:
					overrides.getFormatService ?? (() => ({}) as FormatService),
			};
		}

		it("deferred drain (#3506): the agent_end autofix does not write over an agent edit made through pi's queue", async () => {
			const env = setupTestEnvironment("tla-drain-autofix-");
			try {
				writeBiomeAgreement(env.tmpDir);
				fs.writeFileSync(path.join(env.tmpDir, "biome.json"), "{}\n");
				const filePath = path.join(env.tmpDir, "a.ts");
				fs.writeFileSync(filePath, "var a = 1;\n");
				const runtime = new RuntimeCoordinator();
				runtime.projectRoot = env.tmpDir;
				runtime.deferMutation(
					filePath,
					env.tmpDir,
					"edit",
					env.tmpDir,
					"autofix",
				);
				const { fixer, parked, resume } = gatedFixer("write");
				const drain = handleAgentEnd(
					drainDeps(runtime, env, { biomeClient: fixer }),
				);
				await parked.p;
				const agent = agentAppend(filePath, "export const AGENT_EDIT_2 = 2;\n");
				await afterQueueRegistration(env.tmpDir);
				resume.open();
				await drain;
				await agent.done;
				expect(fs.readFileSync(filePath, "utf8")).toBe(
					"const a = 1;\nexport const AGENT_EDIT_2 = 2;\n",
				);
			} finally {
				env.cleanup();
			}
		});

		it("deferred drain (#3506): the agent_end format does not write over an agent edit made through pi's queue", async () => {
			const env = setupTestEnvironment("tla-drain-format-");
			try {
				const filePath = path.join(env.tmpDir, "a.ts");
				fs.writeFileSync(filePath, "let value=1\n");
				const runtime = new RuntimeCoordinator();
				runtime.projectRoot = env.tmpDir;
				runtime.deferMutation(
					filePath,
					env.tmpDir,
					"edit",
					env.tmpDir,
					"format",
				);
				// #3558: the real FormatService, which hands the hold to the
				// formatter (the child double below) to enter before its read.
				const parked = gate();
				const resume = gate();
				formatterChild.active = true;
				formatterChild.parked = parked.open;
				formatterChild.resume = resume.p;
				const formatService = new FormatService("tla", true);
				const drain = handleAgentEnd(
					drainDeps(runtime, env, { getFormatService: () => formatService }),
				);
				await parked.p;
				const agent = agentAppend(filePath, "export const AGENT_EDIT_2 = 2;\n");
				await afterQueueRegistration(env.tmpDir);
				resume.open();
				await drain;
				await agent.done;
				expect(fs.readFileSync(filePath, "utf8")).toBe(
					"let value = 1;\nexport const AGENT_EDIT_2 = 2;\n",
				);
			} finally {
				env.cleanup();
			}
		});

		// ── review round 1 ──────────────────────────────────────────────────
		describe("the hold outlives an abandoned formatter child (r1 F3)", () => {
			beforeEach(() => {
				formatterChild.active = true;
				vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			});
			afterEach(() => {
				vi.useRealTimers();
				formatterChild.active = false;
				formatterChild.parked = undefined;
				formatterChild.resume = undefined;
			});

			/** Parks the formatter child between its read and its write. */
			function parkChild() {
				const parked = gate();
				const resume = gate();
				formatterChild.parked = parked.open;
				formatterChild.resume = resume.p;
				return { parked, resume };
			}

			it("FixerOrphan (#3506 r1): the --immediate-format child the budget gave up on keeps pi's queue until it writes", async () => {
				const env = setupTestEnvironment("tla-format-orphan-");
				try {
					const filePath = path.join(env.tmpDir, "a.ts");
					fs.writeFileSync(filePath, "let value=1\n");
					vi.mocked(dispatchLintWithResult).mockImplementation(
						async () => clean("any") as never,
					);
					const { parked, resume } = parkChild();
					const run = runPipeline(
						{
							filePath,
							cwd: env.tmpDir,
							toolName: "edit",
							autofixMode: "deferred",
							getFlag: (name: string) =>
								name === "immediate-format" || name === "no-lsp",
							dbg: () => {},
						},
						{
							biomeClient: noBiome as unknown as BiomeClient,
							ruffClient: {} as never,
							metricsClient: {} as never,
							getFormatService: () => new FormatService("tla", true),
							fixedThisTurn: new Set<string>(),
						},
					);
					await parked.p;
					// The service's per-file budget fires; the child runs on.
					await vi.advanceTimersByTimeAsync(
						HOOK_WALL_BUDGET_MS.tool_result_edit,
					);
					await run;
					const agent = agentAppend(
						filePath,
						"export const AGENT_EDIT_2 = 2;\n",
					);
					await afterQueueRegistration(env.tmpDir);
					expect(agent.wrote()).toBe(false);
					resume.open();
					await agent.done;
					expect(fs.readFileSync(filePath, "utf8")).toBe(
						"let value = 1;\nexport const AGENT_EDIT_2 = 2;\n",
					);
				} finally {
					env.cleanup();
				}
			});

			it("FixerOrphan (#3506 r1): the --immediate-format child an Escape gave up on keeps pi's queue until it writes", async () => {
				const env = setupTestEnvironment("tla-format-escape-");
				try {
					const filePath = path.join(env.tmpDir, "a.ts");
					fs.writeFileSync(filePath, "let value=1\n");
					vi.mocked(dispatchLintWithResult).mockImplementation(
						async () => clean("any") as never,
					);
					const { parked, resume } = parkChild();
					const escape = new AbortController();
					const run = runPipeline(
						{
							filePath,
							cwd: env.tmpDir,
							toolName: "edit",
							autofixMode: "deferred",
							getFlag: (name: string) =>
								name === "immediate-format" || name === "no-lsp",
							dbg: () => {},
							signal: escape.signal,
						},
						{
							biomeClient: noBiome as unknown as BiomeClient,
							ruffClient: {} as never,
							metricsClient: {} as never,
							getFormatService: () => new FormatService("tla", true),
							fixedThisTurn: new Set<string>(),
						},
					);
					await parked.p;
					escape.abort();
					await run;
					const agent = agentAppend(
						filePath,
						"export const AGENT_EDIT_2 = 2;\n",
					);
					await afterQueueRegistration(env.tmpDir);
					expect(agent.wrote()).toBe(false);
					resume.open();
					await agent.done;
					expect(fs.readFileSync(filePath, "utf8")).toBe(
						"let value = 1;\nexport const AGENT_EDIT_2 = 2;\n",
					);
				} finally {
					env.cleanup();
				}
			});

			it("deferred drain (#3506 r1): the drain formatter its 30 s aggregate gave up on keeps pi's queue until it writes", async () => {
				const env = setupTestEnvironment("tla-drain-format-orphan-");
				try {
					const filePath = path.join(env.tmpDir, "a.ts");
					fs.writeFileSync(filePath, "let value=1\n");
					const runtime = new RuntimeCoordinator();
					runtime.projectRoot = env.tmpDir;
					runtime.deferMutation(
						filePath,
						env.tmpDir,
						"edit",
						env.tmpDir,
						"format",
					);
					const { parked, resume } = parkChild();
					const drain = handleAgentEnd(
						drainDeps(runtime, env, {
							getFormatService: () => new FormatService("tla", true),
						}),
					);
					await parked.p;
					// The hook's own bound fires first; the phase's 30 s aggregate
					// then gives up on the child, which runs on.
					await vi.advanceTimersByTimeAsync(30_000);
					await drain;
					const agent = agentAppend(
						filePath,
						"export const AGENT_EDIT_2 = 2;\n",
					);
					await afterQueueRegistration(env.tmpDir);
					expect(agent.wrote()).toBe(false);
					resume.open();
					await agent.done;
					expect(fs.readFileSync(filePath, "utf8")).toBe(
						"let value = 1;\nexport const AGENT_EDIT_2 = 2;\n",
					);
				} finally {
					env.cleanup();
				}
			});
		});

		/** A Biome client whose availability probe (an install) is in flight. */
		function installingBiome() {
			const installing = gate();
			const installed = gate();
			const client = {
				isSupportedFile: () => true,
				ensureAvailable: async () => {
					installing.open();
					await installed.p;
					return true;
				},
				fixFileAsync: async () => ({ success: true, changed: false, fixed: 0 }),
			} as unknown as BiomeClient;
			return { client, installing, installed };
		}

		it("autofix install (#3506 r1 F5): an install in progress does not hold pi's queue, so the agent's edit lands", async () => {
			const env = setupTestEnvironment("tla-fixer-install-");
			try {
				writeBiomeAgreement(env.tmpDir);
				const filePath = path.join(env.tmpDir, "a.ts");
				const runtime = new RuntimeCoordinator();
				runtime.projectRoot = env.tmpDir;
				runtime.beginTurn();
				vi.mocked(dispatchLintWithResult).mockImplementation(
					async () => clean("any") as never,
				);
				const { client, installing, installed } = installingBiome();
				fs.writeFileSync(filePath, "var a = 1;\n");
				const write = handleToolResult({
					...deps(runtime, client),
					event: ev("write", filePath, "c1"),
				} as never);
				await installing.p;
				const agent = agentAppend(filePath, "export const AGENT_EDIT_2 = 2;\n");
				await afterQueueRegistration(env.tmpDir);
				expect(agent.wrote()).toBe(true);
				installed.open();
				await write;
			} finally {
				env.cleanup();
			}
		});

		it("deferred drain install (#3506 r1 F5): an install in progress does not hold pi's queue, so the agent's edit lands", async () => {
			const env = setupTestEnvironment("tla-drain-install-");
			try {
				writeBiomeAgreement(env.tmpDir);
				fs.writeFileSync(path.join(env.tmpDir, "biome.json"), "{}\n");
				const filePath = path.join(env.tmpDir, "a.ts");
				fs.writeFileSync(filePath, "var a = 1;\n");
				const runtime = new RuntimeCoordinator();
				runtime.projectRoot = env.tmpDir;
				runtime.deferMutation(
					filePath,
					env.tmpDir,
					"edit",
					env.tmpDir,
					"autofix",
				);
				const { client, installing, installed } = installingBiome();
				const drain = handleAgentEnd(
					drainDeps(runtime, env, { biomeClient: client }),
				);
				await installing.p;
				const agent = agentAppend(filePath, "export const AGENT_EDIT_2 = 2;\n");
				await afterQueueRegistration(env.tmpDir);
				expect(agent.wrote()).toBe(true);
				installed.open();
				await drain;
			} finally {
				env.cleanup();
			}
		});

		it("fixer crash (#3506 r1 F6): a fixer that throws inside the hold releases pi's queue", async () => {
			const env = setupTestEnvironment("tla-fixer-throws-");
			try {
				writeBiomeAgreement(env.tmpDir);
				const filePath = path.join(env.tmpDir, "a.ts");
				fs.writeFileSync(filePath, "var a = 1;\n");
				const inFixer = gate();
				const crash = gate();
				const fixer = {
					isSupportedFile: () => true,
					ensureAvailable: async () => true,
					fixFileAsync: async () => {
						inFixer.open();
						await crash.p;
						throw new Error("fixer crashed");
					},
				} as unknown as BiomeClient;
				const run = runPipeline(
					{
						filePath,
						cwd: env.tmpDir,
						toolName: "write",
						getFlag: (name: string) => name === "no-lsp",
						dbg: () => {},
					},
					{
						biomeClient: fixer,
						ruffClient: { isPythonFile: () => false } as never,
						metricsClient: {} as never,
						getFormatService: () => ({}) as FormatService,
						fixedThisTurn: new Set<string>(),
					},
				);
				await inFixer.p;
				const agent = agentAppend(filePath, "export const AGENT_EDIT_2 = 2;\n");
				crash.open();
				await expect(run).rejects.toThrow("fixer crashed");
				await afterQueueRegistration(env.tmpDir);
				expect(agent.wrote()).toBe(true);
			} finally {
				env.cleanup();
			}
		});
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
