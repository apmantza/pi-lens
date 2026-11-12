/**
 * #3814 witness — a collect-later runner's BLOCKING finding gates
 * `git commit` / `git push` under `--lens-guard`, through the pi HOST entry.
 *
 * Recurrence this prevents: a runner slower than `COLLECT_LATER_THRESHOLD_MS`
 * is deferred off the write path (`dispatcher.ts` -> `deferRunnerFindings`).
 * Its blocking findings reach the agent only as a turn-end advisory
 * (#3796/#3808) and never entered the blocker state the commit gate reads
 * (`RuntimeCoordinator` inline-blocker map -> latch, persisted record), so the
 * same type error that blocks a push when a fast runner raises it let the push
 * through when a slow runner raised it (live dogfood 2026-09-30, B2b/B3).
 *
 * Doubles: `clients/pipeline.js` only — a true process boundary (it spawns
 * every configured linter). Its stand-in runs the REAL `dispatchForFile` with a
 * registered runner that the real collect-later tier defers, so the pending
 * entry, its freshness baseline and the settle path are the production ones.
 * `handleToolResult`, `handleTurnEnd`, the `RuntimeCoordinator`, the
 * `CacheManager`, the pending store, the shared finding policy and
 * `evaluateGitGuard` (via the `tool_call` hook on a bash commit) are REAL.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

const pipeline = vi.hoisted(() => ({ runPipeline: vi.fn() }));
vi.mock("../clients/pipeline.js", () => pipeline);

// The latency sink fixes its path when it loads, so the redirect to a private
// home runs hoisted, before any import (the #3521 witness's shape): the row
// assertion below reads the REAL sink and must not read a sibling run's rows.
//
// #4864: the parent is `os.tmpdir()`, never `.`. A `process.env.TMPDIR ?? "."`
// parent resolves to the CHECKOUT ROOT on every runner that leaves TMPDIR
// unset (CI does), which makes this home a directory NAMED at the repository
// root: a repo-walking scan on a sibling worker lists it and then ENOENTs when
// this file's afterAll removes it. `os.tmpdir()` reads the same variable with
// the OS fallback, so the parent is never the checkout.
const witnessHome = await vi.hoisted(async () => {
	const previous = process.env.PI_LENS_HOME;
	const { mkdtempSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	// #5098: the family is spelled at an `mkdtempSync` call, not assembled with
	// `join(tmpdir(), ...pid)`. The serialized tmp-fixture hygiene owner maps a
	// census entry to its owner by the declared prefix of a tmp-root `mkdtemp`
	// (AGENTS.md shape 8: a name-only skip has no observable owner), and the pid
	// spelling made this home `owner: tests/unknown`: the owner could neither
	// spare it as a sibling invocation's live root nor blame it, so any sighting
	// of it redded a shard. The same call lets the shared setup's tmp-root
	// interposer see the creation, and the harness claim below makes the root
	// harness-owned: whatever re-creates it after this file's teardown is removed
	// by the worker's own sweep, not by the run-end census (`#2912`).
	const home = mkdtempSync(join(tmpdir(), "pi-lens-3814-witness-home-"));
	const { getTmpRootRegistry, registerTmpRoot } =
		await import("./support/tmp-root-registry.js");
	registerTmpRoot(getTmpRootRegistry(), home, "registered");
	process.env.PI_LENS_HOME = home;
	return { home, previous };
});

import {
	COLLECT_LATER_THRESHOLD_MS,
	observeRunnerLatency,
	resetObservedRunnerLatency,
} from "../clients/dispatch/collect-later-tier.js";
import {
	createDispatchContext,
	dispatchForFile,
	RunnerRegistry,
} from "../clients/dispatch/dispatcher.js";
import { FactStore } from "../clients/dispatch/fact-store.js";
import { formatDiagnostics } from "../clients/dispatch/utils/format-utils.js";
import { resetPendingRunnerFindings } from "../clients/dispatch/pending-runner-findings.js";
import type { Diagnostic, RunnerResult } from "../clients/dispatch/types.js";
import { markDisposition } from "../clients/diagnostic-dispositions.js";
import {
	getProjectSnapshotPersistStateForTests,
	saveProjectSnapshot,
} from "../clients/project-snapshot.js";
import type { ProjectSnapshot } from "../clients/project-snapshot.js";
import { BLOCKER_REPEAT_HEADING } from "../clients/runtime-context.js";
import {
	clearLatencyLog,
	flushLatencyLog,
	getLatencyLogPath,
} from "../clients/latency-logger.js";
import extension from "../index.js";
import { _resetSessionLifecycleForTests } from "../clients/session-lifecycle.js";
import { removeTempDirSync } from "./clients/test-utils.js";
import { drainRegisteredBackgroundWritesForTests } from "./support/background-write-drains.js";
import {
	makeContextWithSystemEvent,
	makeSessionStartEvent,
} from "./support/host-event-factory.js";
import { endMockSessions } from "./support/mock-session-teardown.js";
import { createPiMock, makeCtx } from "./support/pi-mock.js";
import { useGlobalConfig } from "./support/global-config.js";

const SESSION_ID = "pi-3814-deferred-gate-session";
const RUNNER_ID = "slow-runner";
/** A non-TypeScript registry entry driven through the same gate seam (#3896 R2). */
const PY_RUNNER_ID = "pyright";

let tmpDir: string;
let filePath: string;
let previousTestMode: string | undefined;
/** What the deferred runner answers for the NEXT edit's dispatch. */
let runnerAnswer: (editedPath: string) => Promise<RunnerResult>;
/** The same, for the non-jsts runner. */
let pyRunnerAnswer: (editedPath: string) => Promise<RunnerResult>;
/** An in-band blocker the pipeline's own verdict raises for the same edit. */
let inlineBlocker: Diagnostic | undefined;

const CLEAN_PIPELINE_RESULT = {
	output: "",
	hasBlockers: false,
	isError: false,
	fileModified: false,
};

beforeEach(async () => {
	// The latency row is off in test mode.
	previousTestMode = process.env.PI_LENS_TEST_MODE;
	process.env.PI_LENS_TEST_MODE = "0";
	_resetSessionLifecycleForTests();
	clearLatencyLog();
	await flushLatencyLog();
	resetObservedRunnerLatency();
	resetPendingRunnerFindings();
	inlineBlocker = undefined;
	runnerAnswer = answersClean;
	pyRunnerAnswer = answersClean;
	pipeline.runPipeline.mockReset();
	tmpDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-3814-gate-")),
	);
	filePath = path.join(tmpDir, "src", "app.ts");
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, "alpha();\n");
	const registry = new RunnerRegistry();
	registry.register({
		id: RUNNER_ID,
		appliesTo: ["jsts"],
		priority: 1,
		run: async (ctx) => runnerAnswer(ctx.filePath),
	});
	// A real non-TypeScript row: the same collect-later deferral and the same
	// commit gate, reached only for a python file kind (#3896 R2).
	registry.register({
		id: PY_RUNNER_ID,
		appliesTo: ["python"],
		priority: 1,
		run: async (ctx) => pyRunnerAnswer(ctx.filePath),
	});
	// The pipeline's own verdict: clean unless a test sets `inlineBlocker`, so
	// the deferred runner is the only source of findings by default.
	pipeline.runPipeline.mockImplementation(
		async (ctx: {
			filePath: string;
			cwd: string;
			projectRoot: string;
			telemetry?: { writeIndex?: number };
		}) => {
			observeRunnerLatency({
				projectRoot: ctx.projectRoot,
				runnerId: RUNNER_ID,
				durationMs: COLLECT_LATER_THRESHOLD_MS + 1,
			});
			observeRunnerLatency({
				projectRoot: ctx.projectRoot,
				runnerId: PY_RUNNER_ID,
				durationMs: COLLECT_LATER_THRESHOLD_MS + 1,
			});
			const dispatchCtx = createDispatchContext(
				ctx.filePath,
				ctx.cwd,
				{ getFlag: () => false },
				new FactStore(),
				undefined,
				undefined,
				ctx.projectRoot,
				ctx.telemetry?.writeIndex,
			);
			await dispatchForFile(
				dispatchCtx,
				[{ mode: "all", runnerIds: [RUNNER_ID, PY_RUNNER_ID] }],
				registry,
			);
			return inlineBlocker
				? inlinePipelineResult(inlineBlocker)
				: CLEAN_PIPELINE_RESULT;
		},
	);
});

afterEach(async () => {
	// #5146: end the case's sessions before its root goes.
	await endMockSessions();
	_resetSessionLifecycleForTests();
	if (previousTestMode === undefined) delete process.env.PI_LENS_TEST_MODE;
	else process.env.PI_LENS_TEST_MODE = previousTestMode;
	resetPendingRunnerFindings();
	removeTempDirSync(tmpDir);
});

/**
 * #5098 — the teardown the leak needs, and the guard that pins it.
 *
 * Recurrence this prevents: CI run 41191317503 (shard 2/5) redded
 * tmp-fixture-hygiene on `pi-lens-3814-witness-home-5495` (owner:
 * tests/unknown), on a PR that never touched this file. A project-snapshot
 * persist was still in flight when this hook removed the home: `session_start`
 * resolves long before the persist worker writes, and the worker holds the
 * project-data root it was handed, so the write re-created
 * `<home>/projects/<slug>/cache/project-snapshot.json.gz` after the removal and
 * minutes before the run-end sweep judged the root.
 *
 * The persist worker's own delay seam holds one write open over the teardown,
 * so the settle is what the file relies on instead of a race with the worker's
 * timing (the seam `tests/index-lsp-config-root-eviction.test.ts` uses for the
 * same reason, and `tests/clients/background-write-drains.test.ts` pins at the
 * seam). Deleting the settle below reddens the assertion at the end of this hook
 * on every run.
 */
const PLANTED_PERSIST_DELAY_MS = 750;
/** How long after the removal the hook watches for a re-created home. */
const POST_REMOVAL_WATCH_MS = 2500;
/** A released snapshot body, for the persist planted in `afterAll` (#5098). */
const PLANTED_SNAPSHOT = JSON.parse(
	fs.readFileSync(
		path.join(
			import.meta.dirname,
			"fixtures/snapshot-persist/released-4.3.0/snapshot.json",
		),
		"utf-8",
	),
) as ProjectSnapshot;

afterAll(async () => {
	// Plant the writer this teardown has to survive before joining it, so the hook
	// proves it joins a live persist instead of passing because the machine was
	// fast. The persist entry is the production one, and the delay is the persist
	// module's own test seam; a `session_start` plant would work too but re-arms
	// the global-bin-dir prime (#5261), which is a different writer with its own
	// bounded settle and nothing to do with this file's gate.
	const previousPersistDelay =
		process.env.PI_LENS_TEST_SNAPSHOT_PERSIST_WORKER_DELAY_MS;
	process.env.PI_LENS_TEST_SNAPSHOT_PERSIST_WORKER_DELAY_MS = String(
		PLANTED_PERSIST_DELAY_MS,
	);
	try {
		// The planted project lives inside the witness home, so it adds no tmp-root
		// entry. `saveProjectSnapshot` hands the body to the persist worker and
		// returns, so with the delay above the write lands ~750 ms later: the window
		// the removal used to fall into.
		const plantedCwd = path.join(witnessHome.home, "teardown-project");
		saveProjectSnapshot(plantedCwd, PLANTED_SNAPSHOT);
		// The plant planted: prove the persist is still held by the worker BEFORE
		// joining it, so the settle below has the work it claims to join (an
		// afterAll guard that never had a writer in front of it proves nothing).
		let persistState = getProjectSnapshotPersistStateForTests(plantedCwd);
		for (
			let i = 0;
			i < 40 && !(persistState.active || persistState.queued);
			i++
		) {
			await new Promise((resolve) => setTimeout(resolve, 25));
			persistState = getProjectSnapshotPersistStateForTests(plantedCwd);
		}
		expect(persistState.active || persistState.queued).toBe(true);

		// Join every deferred writer while the home is still pinned, so the bytes it
		// has queued land inside the root that is about to go. The runner is strict:
		// a drain that reports work still landing throws here rather than letting
		// this hook remove a root from under a live writer.
		await drainRegisteredBackgroundWritesForTests();
		await flushLatencyLog();
	} finally {
		if (previousPersistDelay === undefined)
			delete process.env.PI_LENS_TEST_SNAPSHOT_PERSIST_WORKER_DELAY_MS;
		else
			process.env.PI_LENS_TEST_SNAPSHOT_PERSIST_WORKER_DELAY_MS =
				previousPersistDelay;
	}
	if (witnessHome.previous === undefined) delete process.env.PI_LENS_HOME;
	else process.env.PI_LENS_HOME = witnessHome.previous;
	// Restore `PI_LENS_HOME` before the removal: a tail writer that resolves the
	// machine-state directory when it lands
	// (`clients/instance-registry.ts`'s `registryPath`) then cannot re-create this
	// path, whichever home it last saw (#5024).
	removeTempDirSync(witnessHome.home);
	// Then watch the removed path for longer than the planted writer holds a write.
	// A teardown that removed the home under a live writer shows up here, rather
	// than as a run-end hygiene red on a shard minutes later.
	const watchUntil = Date.now() + POST_REMOVAL_WATCH_MS;
	while (Date.now() < watchUntil && !fs.existsSync(witnessHome.home)) {
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	expect(fs.existsSync(witnessHome.home)).toBe(false);
});

/** The fields of a latency row these cases read. */
interface LatencyRow {
	phase?: string;
	metadata?: Record<string, unknown>;
}

async function latencyRows(): Promise<LatencyRow[]> {
	await flushLatencyLog();
	return (
		fs.existsSync(getLatencyLogPath())
			? fs.readFileSync(getLatencyLogPath(), "utf8")
			: ""
	)
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as LatencyRow);
}

function blockingDiagnostic(line = 1): Diagnostic {
	return blockingDiagnosticFor(RUNNER_ID, filePath, line, "TS2349");
}

/** The same blocking finding on another runner and file (the non-jsts row). */
function blockingDiagnosticFor(
	runnerId: string,
	targetPath: string,
	line = 1,
	rule = "TS2349",
): Diagnostic {
	return {
		id: `${runnerId}:${path.basename(targetPath)}:${line}`,
		message: "alpha is not a function",
		filePath: targetPath,
		line,
		column: 1,
		severity: "error",
		semantic: "blocking",
		tool: runnerId,
		rule,
	};
}

/** The `PipelineResult` the real pipeline builds for an inline blocking run. */
function inlinePipelineResult(blocker: Diagnostic) {
	const summary = formatDiagnostics([blocker], "blocking").trim();
	const bytes = fs.readFileSync(filePath);
	return {
		output: summary,
		hasBlockers: true,
		isError: false,
		fileModified: false,
		inlineBlockerSummary: summary,
		inlineBlockerSources: [blocker.tool],
		inlineBlockerLines: [blocker.line],
		inlineBlockerDiagnostics: [blocker],
		inlineBlockerFileContent: {
			size: bytes.byteLength,
			sha256: createHash("sha256").update(bytes).digest("hex"),
		},
	};
}

/** A runner that settles with the blocking finding the way #3808 delivers it. */
const answersBlocking =
	(shape: "succeeded" | "failed"): typeof runnerAnswer =>
	async (editedPath) =>
		path.resolve(editedPath) !== path.resolve(filePath)
			? await answersClean()
			: {
					status: shape,
					diagnostics: [blockingDiagnostic()],
					semantic: "blocking",
					...(shape === "failed"
						? { failureKind: "blocking_diagnostics" as const }
						: {}),
				};

const answersClean = async (): Promise<RunnerResult> => ({
	status: "succeeded",
	diagnostics: [],
	semantic: "none",
});

async function startSession(guard = true) {
	setGlobalConfig({ guard: { enabled: guard } });
	const pi = createPiMock();
	extension(pi.asExtensionAPI());
	await pi.emit(
		"session_start",
		makeSessionStartEvent(),
		makeCtx({ cwd: tmpDir, sessionId: SESSION_ID }),
	);
	const ctx = () => makeCtx({ cwd: tmpDir });
	return {
		pi,
		/** The real commit gate: pi-lens's `tool_call` hook on a bash git verb. */
		gate: async (command = 'git commit -m "wip"') =>
			((await pi.emit(
				"tool_call",
				{ toolName: "bash", input: { command } },
				ctx(),
			)) ?? {}) as { block?: boolean; reason?: string },
		turnStart: async () => await pi.emit("turn_start", {}, ctx()),
		edit: async (file = filePath) =>
			await pi.emit(
				"tool_result",
				{
					toolName: "edit",
					input: { path: file },
					details: { diff: "+  1 alpha();" },
					content: [{ type: "text", text: "base" }],
				},
				ctx(),
			),
		turnEnd: async () => {
			await pi.emit("turn_end", {}, ctx());
			const injected = (await pi.emit(
				"context_with_system",
				makeContextWithSystemEvent([{ role: "user", content: "keep working" }]),
				ctx(),
			)) as { messages?: Array<{ content: string }> } | undefined;
			return (injected?.messages ?? []).map((m) => m.content).join("\n\n");
		},
	};
}

/** Let the deferred runner's promise settle (it was handed to the store). */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * An edit made after the runner scanned: the file's mtime moves past the
 * pending entry's `markedAtMs` plus the freshness tolerance, without a timer.
 */
function editAfterScan(content: string): void {
	fs.writeFileSync(filePath, content);
	const later = new Date(Date.now() + 2_000);
	fs.utimesSync(filePath, later, later);
}

const setGlobalConfig = useGlobalConfig();

describe("#3814: deferred blocking findings gate the commit", () => {
	for (const shape of ["succeeded", "failed"] as const) {
		it(`blocks a commit made before turn end on a settled ${shape} deferred blocker`, async () => {
			runnerAnswer = answersBlocking(shape);
			const host = await startSession();
			await host.turnStart();
			await host.edit();
			await settle();

			const verdict = await host.gate();
			expect(verdict.block).toBe(true);
			expect(verdict.reason).toContain("COMMIT BLOCKED (--lens-guard)");
			expect(verdict.reason).toContain("alpha is not a function");
			// A push is guarded by the same call.
			expect((await host.gate("git push origin HEAD")).block).toBe(true);
		});

		it(`keeps blocking after turn end delivered the ${shape} deferred blocker`, async () => {
			runnerAnswer = answersBlocking(shape);
			const host = await startSession();
			await host.turnStart();
			await host.edit();
			await settle();
			const delivered = await host.turnEnd();
			// One blocker section, the tier an in-band blocker gets (r1 M2).
			expect(delivered).toContain("Unresolved from this turn");
			expect(delivered).toContain("alpha is not a function");

			const verdict = await host.gate();
			expect(verdict.block).toBe(true);
			expect(verdict.reason).toContain("COMMIT BLOCKED (--lens-guard)");

			// A later turn that touched nothing keeps the same answer.
			await host.turnStart();
			await host.turnEnd();
			expect((await host.gate()).block).toBe(true);
		});
	}

	it("allows the commit once a later edit resolves the deferred blocker", async () => {
		runnerAnswer = answersBlocking("succeeded");
		const host = await startSession();
		await host.turnStart();
		await host.edit();
		await settle();
		await host.turnEnd();
		expect((await host.gate()).block).toBe(true);

		// The agent fixes the file; the re-check (also deferred) answers clean.
		runnerAnswer = answersClean;
		editAfterScan("alpha = () => 1;\n");
		await host.turnStart();
		await host.edit();
		await settle();
		await host.turnEnd();

		expect((await host.gate()).block).toBeUndefined();
	});

	it("does not block on a deferred blocker the edit that followed made stale, before turn end", async () => {
		runnerAnswer = answersBlocking("succeeded");
		const host = await startSession();
		await host.turnStart();
		await host.edit();
		await settle();
		// The file changed after the runner scanned it: its answer is about old
		// bytes (the freshness gate's mtime vs scannedAt verdict).
		editAfterScan("alpha = () => 1;\n");

		expect((await host.gate()).block).toBeUndefined();
	});

	it("answers with the message an in-band blocker gets", async () => {
		// Same diagnostic, raised once by a deferred runner and once by the
		// pipeline's inline verdict: the agent reads one message shape.
		runnerAnswer = answersBlocking("succeeded");
		const deferredHost = await startSession();
		await deferredHost.turnStart();
		await deferredHost.edit();
		await settle();
		const deferred = await deferredHost.gate();

		resetPendingRunnerFindings();
		runnerAnswer = answersClean;
		inlineBlocker = blockingDiagnostic();
		const inlineHost = await startSession();
		await inlineHost.turnStart();
		await inlineHost.edit();
		const inline = await inlineHost.gate();

		expect(deferred.block).toBe(true);
		expect(deferred.reason).toBe(inline.reason);
		expect(deferred.reason).toMatch(
			/^🔴 COMMIT BLOCKED \(--lens-guard\): unresolved blockers must be fixed before commit\/push\.\n/,
		);
	});

	it("does not block on a deferred finding that is not blocking", async () => {
		// Recurrence: routing every late finding into the blocker channel would
		// gate commits on advisories. Only `semantic: "blocking"` survivors do.
		runnerAnswer = async () => ({
			status: "succeeded",
			diagnostics: [{ ...blockingDiagnostic(), semantic: "warning" }],
			semantic: "warning",
		});
		const host = await startSession();
		await host.turnStart();
		await host.edit();
		await settle();
		expect((await host.gate()).block).toBeUndefined();
		await host.turnEnd();
		expect((await host.gate()).block).toBeUndefined();
	});

	it("blocks the commit on a non-TypeScript (python) deferred blocker", async () => {
		// #3896 R2: the deployable registry row is not TypeScript-only. A real
		// non-jsts runner's blocking finding reaches the same gate seam.
		const pyPath = path.join(tmpDir, "src", "app.py");
		fs.writeFileSync(pyPath, "alpha()\n");
		pyRunnerAnswer = async (editedPath) =>
			path.resolve(editedPath) !== path.resolve(pyPath)
				? await answersClean()
				: {
						status: "succeeded",
						diagnostics: [blockingDiagnosticFor(PY_RUNNER_ID, pyPath)],
						semantic: "blocking",
					};
		const host = await startSession();
		await host.turnStart();
		await host.edit(pyPath);
		await settle();

		const verdict = await host.gate();
		expect(verdict.block).toBe(true);
		expect(verdict.reason).toContain("COMMIT BLOCKED (--lens-guard)");
		expect(verdict.reason).toContain("alpha is not a function");
		// The recorded provenance names the non-jsts runner, not a TS one.
		const rows = (await latencyRows()).filter(
			(row) => row.phase === "deferred_runner_blockers",
		);
		expect(rows.at(-1)?.metadata?.runnerIds).toEqual([PY_RUNNER_ID]);
	});

	it("does not block on a non-TypeScript warning-tier deferred finding", async () => {
		// The blocking/warning tier decides, not the runner's language.
		const pyPath = path.join(tmpDir, "src", "app.py");
		fs.writeFileSync(pyPath, "alpha()\n");
		pyRunnerAnswer = async (editedPath) =>
			path.resolve(editedPath) !== path.resolve(pyPath)
				? await answersClean()
				: {
						status: "succeeded",
						diagnostics: [
							{
								...blockingDiagnosticFor(PY_RUNNER_ID, pyPath),
								semantic: "warning",
							},
						],
						semantic: "warning",
					};
		const host = await startSession();
		await host.turnStart();
		await host.edit(pyPath);
		await settle();

		expect((await host.gate()).block).toBeUndefined();
		await host.turnEnd();
		expect((await host.gate()).block).toBeUndefined();
	});

	it("keeps an in-band blocker on the same file when a deferred one joins it", async () => {
		// Recurrence: a deferred answer REPLACING the file's record would drop the
		// fast runners' blocker for the same bytes; it must merge.
		inlineBlocker = {
			...blockingDiagnostic(2),
			id: "inline-tool:app.ts:2",
			tool: "inline-tool",
			rule: "no-eval",
			message: "inline finding on beta",
		};
		runnerAnswer = answersBlocking("succeeded");
		const host = await startSession();
		await host.turnStart();
		await host.edit();
		await settle();
		expect((await host.gate()).block).toBe(true);
		const delivered = await host.turnEnd();
		// #4921: the merged set reaches the agent once as a delivery. #5240: the
		// next prompt names the unchanged set once more, as a repeat of the
		// blockers alone (never a second delivery), and the gate still holds it.
		const replay = await (async () => {
			await host.turnStart();
			return await host.turnEnd();
		})();

		expect(delivered).toContain("inline finding on beta");
		expect(delivered).toContain("alpha is not a function");
		expect(delivered).not.toContain(BLOCKER_REPEAT_HEADING);
		expect(replay).toContain(BLOCKER_REPEAT_HEADING);
		expect(replay.split("alpha is not a function")).toHaveLength(2);
		expect(replay.split("inline finding on beta")).toHaveLength(2);
		expect((await host.gate()).block).toBe(true);
	});

	it("lists one finding once when an inline lane and a deferred lane both blocked on it", async () => {
		// Recurrence (#5416): the record merged on tool + rule, so the language
		// server's `Pyright:reportUndefinedVariable` and the slow `pyright` CLI's
		// `reportUndefinedVariable` for one name were two blockers, and the STOP
		// read "2 issue(s)" for one problem.
		inlineBlocker = {
			...blockingDiagnostic(1),
			id: "lsp:reportUndefinedVariable:1",
			tool: "lsp",
			rule: "Pyright:reportUndefinedVariable",
			message: "alpha is not defined",
		};
		runnerAnswer = async (editedPath) =>
			path.resolve(editedPath) !== path.resolve(filePath)
				? await answersClean()
				: {
						status: "succeeded",
						diagnostics: [
							{
								...blockingDiagnostic(1),
								id: "pyright-reportUndefinedVariable",
								tool: "pyright",
								rule: "reportUndefinedVariable",
								message: "alpha is not defined",
							},
						],
						semantic: "blocking",
					};
		const host = await startSession();
		await host.turnStart();
		await host.edit();
		await settle();
		const verdict = await host.gate();
		const delivered = await host.turnEnd();
		expect(verdict.block).toBe(true);
		expect(verdict.reason).toContain("1 issue(s) must be fixed");
		expect(delivered.split("alpha is not defined")).toHaveLength(2);
	});

	for (const order of ["gate-first", "turn-end-first"] as const) {
		it(`delivers the finding once at the delivering turn end, ${order}`, async () => {
			// Recurrence (r1 M2): with the gate recording first, the replay section and
			// the late advisory both carried the finding in one message.
			runnerAnswer = answersBlocking("succeeded");
			const host = await startSession();
			await host.turnStart();
			await host.edit();
			await settle();
			if (order === "gate-first") expect((await host.gate()).block).toBe(true);
			const delivering = await host.turnEnd();
			expect(delivering.split("alpha is not a function")).toHaveLength(2);
			expect(delivering).toContain("Unresolved from this turn");
			expect((await host.gate()).block).toBe(true);

			await host.turnStart();
			const other = path.join(tmpDir, "src", "other.ts");
			fs.writeFileSync(other, "export const other = 1;\n");
			await host.edit(other);
			const later = await host.turnEnd();
			expect(later.split("alpha is not a function").length).toBeLessThanOrEqual(
				2,
			);

			const lane = (await latencyRows()).filter(
				(row) => row.phase === "late_runner_findings",
			);
			expect(lane.at(0)?.metadata).toMatchObject({
				delivered: 1,
				blockersRecorded: order === "gate-first" ? 0 : 1,
			});
		});
	}

	it("allows the commit after every deferred blocker was marked false-positive", async () => {
		// Recurrence (#3248 shape): a disposition verdict on a record with no
		// content baseline reads as `inline_policy_stale` and blocks the commit
		// as unknown. The deferred record carries the analysed bytes' baseline.
		runnerAnswer = answersBlocking("succeeded");
		const host = await startSession();
		await host.turnStart();
		await host.edit();
		await settle();
		await host.turnEnd();
		expect((await host.gate()).block).toBe(true);
		markDisposition(
			tmpDir,
			{
				cwd: tmpDir,
				filePath,
				tool: RUNNER_ID,
				rule: "TS2349",
				message: "alpha is not a function",
				line: 1,
				content: fs.readFileSync(filePath, "utf8"),
			},
			"false-positive",
		);
		// A turn that edits an unrelated file composes the replay, which is where
		// the policy verdict reaches the latch.
		const other = path.join(tmpDir, "src", "other.ts");
		fs.writeFileSync(other, "export const other = 1;\n");
		await host.turnStart();
		await host.edit(other);
		await host.turnEnd();

		const verdict = await host.gate();
		expect(verdict.reason).toBeUndefined();
		expect(verdict.block).toBeUndefined();
	});

	it("writes one freshness record for a stale answer, from the turn end and not from the gate", async () => {
		// Recurrence (r1 L1): the gate judged a stale answer and wrote
		// `finding_stale_line_demote`, then the turn-end lane judged the same
		// answer and wrote it again, two rows for one decision.
		runnerAnswer = answersBlocking("succeeded");
		const host = await startSession();
		await host.turnStart();
		await host.edit();
		await settle();
		editAfterScan("alpha = () => 1;\n");
		await host.gate();
		await host.gate();
		const staleRows = async () =>
			(await latencyRows()).filter(
				(row) =>
					row.phase === "finding_stale_line_demote" &&
					row.metadata?.store === "late-runner-findings",
			);
		expect(await staleRows()).toHaveLength(0);

		// The next edit's own re-check answers clean, so only the first answer is stale.
		runnerAnswer = answersClean;
		await host.turnStart();
		await host.edit();
		await host.turnEnd();
		expect(await staleRows()).toHaveLength(1);
	});

	it("keeps blocking when the deferred runner also cites another file past this file's end", async () => {
		// Recurrence (r1 M1): a foreign line number in the record's `lines` made the
		// past-EOF sweep demote and retire the whole record, and the gate opened
		// while the file still had the error. The pipeline's writer keeps only the
		// record's own file's lines (#1641 F2); the deferred writer must too.
		const other = path.join(tmpDir, "src", "other.ts");
		fs.writeFileSync(other, "export const other = 1;\n");
		const foreign: Diagnostic = {
			...blockingDiagnostic(500),
			id: `${RUNNER_ID}:other.ts:500`,
			filePath: other,
			message: "other.ts is broken",
		};
		runnerAnswer = async (editedPath) =>
			path.resolve(editedPath) !== path.resolve(filePath)
				? await answersClean()
				: {
						status: "succeeded",
						diagnostics: [blockingDiagnostic(1), foreign],
						semantic: "blocking",
					};
		const host = await startSession();
		await host.turnStart();
		await host.edit();
		await settle();
		expect((await host.gate()).block).toBe(true);
		await host.turnEnd();
		await host.turnStart();
		await host.edit(other);
		await host.turnEnd();
		await host.turnStart();
		fs.writeFileSync(other, "export const other = 2;\n");
		await host.edit(other);
		await host.turnEnd();

		expect((await host.gate()).block).toBe(true);
		expect((await host.gate("git push origin HEAD")).block).toBe(true);
		expect(fs.readFileSync(filePath, "utf8")).toBe("alpha();\n");
	});

	// Recurrence (r1 M3): the deferred recording refreshed the latch but not the
	// persisted guard record, so across a session boundary the deferred blocker
	// let the commit through while an inline blocker blocked as `session_mismatch`.
	//
	// The INLINE half of this loop moved to tier 2 (#4632 slice 4,
	// `tests/index-4632-s4-tool-call-verdict.test.ts`): its blocker needs no
	// deferred tier, so it is produced by a real bundled rule and read through
	// pi's own replacement, where the model-visible refusal and the tool not
	// running are both observable. What stays here is the deferred half.
	for (const reason of ["new", "resume", "fork", "reload"] as const) {
		for (const order of ["gate-first", "turn-end-first"] as const) {
			it(`blocks the ${reason} session as an unknown record, deferred blocker, ${order}`, async () => {
				runnerAnswer = answersBlocking("succeeded");
				const host = await startSession();
				await host.turnStart();
				await host.edit();
				await settle();
				if (order === "gate-first") await host.gate();
				else await host.turnEnd();
				expect((await host.gate()).block).toBe(true);
				await host.pi.emit(
					"session_shutdown",
					{ reason },
					makeCtx({ cwd: tmpDir, sessionId: SESSION_ID }),
				);
				await host.pi.emit(
					"session_start",
					makeSessionStartEvent({ reason }),
					makeCtx({ cwd: tmpDir, sessionId: `next-${reason}` }),
				);
				const verdict = await host.gate();

				expect(verdict.block).toBe(true);
				expect(verdict.reason).toContain("session_mismatch");
			});
		}
	}

	it("does not block on a runner still in flight", async () => {
		// Unknown is not a finding: the answer has not arrived, and a gate that
		// refused every commit while a 5s+ runner runs would block the agent on
		// nothing it can fix. The pending store still owns the run for turn end.
		let answer!: (result: RunnerResult) => void;
		runnerAnswer = () =>
			new Promise<RunnerResult>((resolve) => {
				answer = resolve;
			});
		const host = await startSession();
		await host.turnStart();
		await host.edit();
		await settle();

		expect((await host.gate()).block).toBeUndefined();
		answer(await answersClean());
	});

	it("does not block on a deferred blocker the agent marked false-positive", async () => {
		runnerAnswer = answersBlocking("succeeded");
		const host = await startSession();
		await host.turnStart();
		await host.edit();
		await settle();
		markDisposition(
			tmpDir,
			{
				cwd: tmpDir,
				filePath,
				tool: RUNNER_ID,
				rule: "TS2349",
				message: "alpha is not a function",
				line: 1,
				content: fs.readFileSync(filePath, "utf8"),
			},
			"false-positive",
		);

		expect((await host.gate()).block).toBeUndefined();
	});

	it("does not gate without --lens-guard", async () => {
		runnerAnswer = answersBlocking("succeeded");
		const host = await startSession(false);
		await host.turnStart();
		await host.edit();
		await settle();

		expect((await host.gate()).block).toBeUndefined();
	});

	it("records one bounded row when the gate blocks on a deferred blocker", async () => {
		runnerAnswer = answersBlocking("succeeded");
		const host = await startSession();
		await host.turnStart();
		await host.edit();
		await settle();
		expect((await host.gate()).block).toBe(true);
		// A repeat attempt blocks again but finds nothing new to record.
		expect((await host.gate()).block).toBe(true);

		const rows = (await latencyRows()).filter(
			(row) => row.phase === "deferred_runner_blockers",
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.metadata).toMatchObject({
			site: "commit_gate",
			recorded: 1,
			runnerIds: [RUNNER_ID],
			fileCount: 1,
		});
	});

	it("counts the turn-end recording on the late-runner row", async () => {
		runnerAnswer = answersBlocking("succeeded");
		const host = await startSession();
		await host.turnStart();
		await host.edit();
		await settle();
		await host.turnEnd();

		const lane = (await latencyRows()).filter(
			(row) => row.phase === "late_runner_findings",
		);
		expect(lane.at(-1)?.metadata).toMatchObject({
			delivered: 1,
			blockersRecorded: 1,
		});
	});
});
