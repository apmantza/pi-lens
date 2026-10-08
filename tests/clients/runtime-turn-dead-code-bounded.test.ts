/**
 * #4117: the turn_end dead-code scan (vulture) is awaited inside the turn_end
 * hook budget, like knip's (#3872, #3893).
 *
 * Recurrence prevented: `handleTurnEnd` did `await client.analyze(cwd)` outside
 * `bounded()`. A vulture scan of a Python project that takes longer than the
 * 3000 ms `turn_end` budget (measured for this PR: vulture 2.16 on 400 files /
 * 48 000 lines takes 3.3 s, 7.1 s once one linked worktree sits under the root)
 * held the handler for the whole scan, up to vulture's own 30 s timeout, so
 * pi's host loop waited and the late result landed on a turn that had already
 * advanced.
 *
 * Every case drives the real `handleTurnEnd`, the real `PythonDeadCodeClient`
 * and the real `CacheManager`. The one thing faked is the vulture process
 * (`safeSpawnAsync`): the slow scan is a promise the test releases and the
 * budget is spent on a fake clock, so no wall-clock wait and no real spawn.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const logLatency = vi.hoisted(() => vi.fn());
vi.mock("../../clients/latency-logger.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/latency-logger.js")>()),
	logLatency,
}));

const logDeadCodeScan = vi.hoisted(() => vi.fn());
vi.mock("../../clients/dead-code-logger.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../clients/dead-code-logger.js")
	>()),
	logDeadCodeScan,
}));

const vultureProcess = vi.hoisted(() => ({
	scans: 0,
	/** When set, the next scan parks on it (the slow scan under test). */
	gate: undefined as Promise<void> | undefined,
	onScan: undefined as (() => void) | undefined,
	/** When set, the scan settles with this error (vulture's own 30 s timeout). */
	failure: undefined as Error | undefined,
	/** What scan number `n` (1-based) prints; vulture's output for the project. */
	stdout: undefined as ((scan: number) => string) | undefined,
	/** The project root; vulture prints absolute paths so the parse does not depend on the test process's cwd. */
	root: "",
}));
vi.mock("../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/safe-spawn.js")>()),
	safeSpawnAsync: vi.fn(async (_command: string, args: string[]) => {
		if (!args.includes(".")) return { stdout: "", stderr: "", status: 0 };
		vultureProcess.scans += 1;
		const scanNumber = vultureProcess.scans;
		vultureProcess.onScan?.();
		await vultureProcess.gate;
		if (vultureProcess.failure) {
			return {
				stdout: "",
				stderr: "",
				status: null,
				error: vultureProcess.failure,
			};
		}
		return {
			stdout:
				vultureProcess.stdout?.(scanNumber) ??
				`${vultureProcess.root}/mod.py:4: unused function 'late' (60% confidence)\n`,
			stderr: "",
			status: 3,
		};
	}),
}));

import { CacheManager } from "../../clients/cache-manager.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import {
	type DeadCodeClient,
	type DeadCodeResult,
	PythonDeadCodeClient,
} from "../../clients/dead-code-client.js";
import { consumeTurnEndFindings } from "../../clients/runtime-context.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { handleTurnEnd } from "../../clients/runtime-turn.js";
import {
	beginScope,
	retireScope,
	type SessionScope,
} from "../../clients/session-scope.js";
import { setupTestEnvironment } from "./test-utils.js";

const CACHE_KEY = "dead-code-python";

let env: ReturnType<typeof setupTestEnvironment>;
let runtime: RuntimeCoordinator;
let cacheManager: CacheManager;
/** One client per test, as production has one per session: back-off state lives on it. */
let client: PythonDeadCodeClient;
let root: string;

function edit(name = "mod.py", via: CacheManager = cacheManager): void {
	const file = path.join(root, name);
	fs.writeFileSync(file, "x = 1\n");
	via.addModifiedRange(file, { start: 1, end: 1 }, false, root);
}

/**
 * #4154: who runs the turn, when it is not this test's primary session.
 * Another pi-lens process on the same project has its own runtime, client and
 * cache manager; a concurrent in-process subagent shares the runtime and has
 * its own session id and scope, as `index.ts` passes them.
 */
interface TurnActor {
	runtime?: RuntimeCoordinator;
	cacheManager?: CacheManager;
	sessionId?: string;
	sessionScope?: SessionScope;
}

function startTurn(
	signal?: AbortSignal,
	clients: DeadCodeClient[] = [client],
	actor: TurnActor = {},
): {
	turn: Promise<void>;
	settled: () => boolean;
} {
	let done = false;
	const turn = handleTurnEnd({
		ctxCwd: root,
		getFlag: () => false,
		dbg: () => {},
		runtime: actor.runtime ?? runtime,
		cacheManager: actor.cacheManager ?? cacheManager,
		...(signal === undefined ? {} : { signal }),
		...(actor.sessionId === undefined ? {} : { sessionId: actor.sessionId }),
		...(actor.sessionScope === undefined
			? {}
			: { sessionScope: actor.sessionScope }),
		knipClient: {
			ensureAvailable: async () => false,
			analyze: async () => ({
				success: true,
				issues: [],
				unusedExports: [],
				unusedFiles: [],
				unusedDeps: [],
				unlistedDeps: [],
				summary: "skipped",
			}),
		},
		deadCodeClients: clients,
		depChecker: { ensureAvailable: async () => false },
		testRunnerClient: { getTestRunTarget: () => null },
		resetLSPService: () => {},
		resetFormatService: () => {},
		// biome-ignore lint/suspicious/noExplicitAny: minimal turn_end deps stub
	} as any).then(() => {
		done = true;
	});
	return { turn, settled: () => done };
}

/** The turn_end advisory text the agent would read. */
function advisory(): string {
	return (
		consumeTurnEndFindings(cacheManager, root)?.messages?.[0]?.content ?? ""
	);
}

function deadCodeRows(): Array<Record<string, unknown>> {
	return logLatency.mock.calls
		.map((call) => call[0] as Record<string, unknown>)
		.filter((entry) => entry.type === "phase" && entry.phase === "dead-code")
		.map((entry) => entry.metadata as Record<string, unknown>);
}

/** Park the scan, begin a turn, and spend the whole turn_end budget on the fake clock. */
async function slowTurn(signal?: AbortSignal, actor: TurnActor = {}) {
	let release!: () => void;
	vultureProcess.gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let scan!: () => void;
	const scanning = new Promise<void>((resolve) => {
		scan = resolve;
	});
	vultureProcess.onScan = scan;
	vi.useFakeTimers();
	edit();
	const started = startTurn(signal, [client], actor);
	await scanning;
	await vi.advanceTimersByTimeAsync(3_100);
	return { ...started, release };
}

beforeEach(() => {
	logLatency.mockReset();
	logDeadCodeScan.mockReset();
	resetDegradationLedger();
	vultureProcess.scans = 0;
	vultureProcess.gate = undefined;
	vultureProcess.onScan = undefined;
	vultureProcess.failure = undefined;
	vultureProcess.stdout = undefined;
	env = setupTestEnvironment("pi-lens-4117-bounded-");
	root = env.tmpDir;
	vultureProcess.root = root;
	fs.writeFileSync(path.join(root, "pyproject.toml"), '[project]\nname="x"\n');
	runtime = new RuntimeCoordinator();
	cacheManager = new CacheManager(false);
	cacheManager.writeCache(
		CACHE_KEY,
		{
			success: true,
			language: "Python",
			unusedExports: [],
			unusedFiles: [],
			unusedDeps: [],
			unlistedDeps: [],
			summary: "baseline",
		} satisfies DeadCodeResult,
		root,
	);
	client = new PythonDeadCodeClient(false);
});
afterEach(() => {
	vi.useRealTimers();
	env.cleanup();
});

describe("#4117 turn_end dead-code scan is bounded by the hook budget", () => {
	it("returns inside the budget when the scan outlives it and records the deferral", async () => {
		const slow = await slowTurn();

		// The handler reaches its end with the scan still parked: before #4117 this
		// await never returned until vulture's own 30 s timeout.
		await slow.turn;
		expect(slow.settled()).toBe(true);
		const [row] = deadCodeRows();
		expect(row).toMatchObject({ execution: "deferred", aborted: false });
		expect(String(row?.reason)).toContain("python:deferred");
		const exceeded = getDegradationSummary().find(
			(group) => group.kind === "hook-await-exceeded",
		);
		expect(JSON.stringify(exceeded)).toContain("turn_end:dead-code");

		slow.release();
		await vi.advanceTimersByTimeAsync(10);
	});

	it("records an Escape as an abort, not as an exceeded budget", async () => {
		const controller = new AbortController();
		let release!: () => void;
		vultureProcess.gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let scan!: () => void;
		const scanning = new Promise<void>((resolve) => {
			scan = resolve;
		});
		vultureProcess.onScan = scan;
		edit();
		const started = startTurn(controller.signal);
		await scanning;

		controller.abort();
		await started.turn;

		expect(started.settled()).toBe(true);
		expect(deadCodeRows()[0]).toMatchObject({
			execution: "deferred",
			aborted: true,
		});
		expect(
			getDegradationSummary().find((g) => g.kind === "hook-await-exceeded"),
		).toBeUndefined();
		release();
	});

	it("backs off a root whose abandoned scan later timed out, instead of spawning every turn", async () => {
		// #1467's contract: after a timeout, later turns skip rather than launch
		// another 30 s vulture. The back-off used to ride on the cache row the
		// turn wrote when the scan settled INSIDE the turn; an abandoned scan
		// writes none, and a good baseline row is never overwritten by a failure.
		vultureProcess.failure = new Error("Process timed out after 30000ms");
		const slow = await slowTurn();
		await slow.turn;
		// The parked scan finally times out, long after its turn ended.
		slow.release();
		await vi.advanceTimersByTimeAsync(31_000);
		vi.useRealTimers();
		for (let turn = 0; turn < 2; turn++) {
			edit();
			await startTurn().turn;
		}

		expect(vultureProcess.scans).toBe(1);
		// A failure never replaces the good baseline row (#925).
		expect(
			cacheManager.readCache<DeadCodeResult>(CACHE_KEY, root)?.data.summary,
		).toBe("baseline");
		expect(
			JSON.stringify(
				getDegradationSummary().find(
					(group) => group.kind === "dead-code-late-scan-dropped",
				),
			),
		).toContain("scan-failed");
		const rows = deadCodeRows();
		expect(rows[0]).toMatchObject({ execution: "deferred" });
		for (const row of rows.slice(1)) {
			expect(row).toMatchObject({ skipped: true });
			expect(String(row.reason)).toContain("python:backoff:");
			expect(String(row.reason)).toContain("timed out");
		}
	});

	it("starts no further client once one has outlived the budget", async () => {
		const second = vi.fn(async () => ({
			success: true,
			language: "Other",
			unusedExports: [],
			unusedFiles: [],
			unusedDeps: [],
			unlistedDeps: [],
			summary: "other",
		}));
		let release!: () => void;
		vultureProcess.gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let scan!: () => void;
		const scanning = new Promise<void>((resolve) => {
			scan = resolve;
		});
		vultureProcess.onScan = scan;
		vi.useFakeTimers();
		edit();
		const started = startTurn(undefined, [
			client,
			{
				id: "other",
				language: "Other",
				detect: () => true,
				owns: () => true,
				ensureAvailable: async () => true,
				analyze: second,
			},
		]);
		await scanning;
		await vi.advanceTimersByTimeAsync(3_100);
		await started.turn;

		expect(second).not.toHaveBeenCalled();
		release();
	});
});

describe("#4117 round 2: a scan that missed the budget still lands", () => {
	/** Let the parked scan finish, flush its settle handler, and return to the real clock. */
	async function settle(slow: { release: () => void }): Promise<void> {
		slow.release();
		await vi.advanceTimersByTimeAsync(10);
		vi.useRealTimers();
	}

	function names(): string[] {
		return (
			cacheManager
				.readCache<DeadCodeResult>(CACHE_KEY, root)
				?.data.unusedExports.map((issue) => issue.name) ?? []
		);
	}

	it("delivers a slow scan's delta on the turn after it settles, and writes its baseline", async () => {
		// Recurrence prevented (review of #4120, F1): a root whose vulture scan is
		// slower than the budget got no per-turn delta and no baseline row for the
		// rest of the session; master delivered every turn (late).
		const slow = await slowTurn();
		await slow.turn;
		expect(advisory()).toBe("");
		await settle(slow);
		// The baseline row is written where the scan settles, not dropped.
		expect(names()).toEqual(["late"]);
		// ...and the scan's one dead-code.log event is written where it settles.
		expect(logDeadCodeScan).toHaveBeenCalledWith(
			expect.objectContaining({ root, success: true, unusedExports: 1 }),
		);

		vultureProcess.gate = undefined;
		edit("other.py");
		await startTurn().turn;
		expect(advisory()).toContain("late");

		edit("third.py");
		await startTurn().turn;
		expect(advisory()).toBe("");
		expect(vultureProcess.scans).toBe(3);
	});

	it("starts no second vulture while one is in flight, and scans the files edited meanwhile next", async () => {
		vultureProcess.stdout = (scan) =>
			scan === 1
				? `${root}/mod.py:4: unused function 'late' (60% confidence)\n`
				: `${root}/mod.py:4: unused function 'late' (60% confidence)\n${root}/other.py:7: unused function 'carried' (60% confidence)\n`;
		const slow = await slowTurn();
		await slow.turn;

		// Turn 2 while the first scan is still parked: one process, no wait.
		edit("other.py");
		await startTurn().turn;
		expect(vultureProcess.scans).toBe(1);
		expect(String(deadCodeRows()[1]?.reason)).toContain("python:in_flight");

		await settle(slow);
		vultureProcess.gate = undefined;
		edit("third.py");
		await startTurn().turn;

		// Turn 1's delta from the settled scan, turn 2's file from the next one.
		const text = advisory();
		expect(text).toContain("late");
		expect(text).toContain("carried");
		expect(vultureProcess.scans).toBe(2);
	});

	it("writes the baseline of a root that had none, and reports nothing for the scan that wrote it", async () => {
		cacheManager.clearCache(CACHE_KEY, root);
		const slow = await slowTurn();
		await slow.turn;
		await settle(slow);
		expect(names()).toEqual(["late"]);

		vultureProcess.gate = undefined;
		edit("other.py");
		await startTurn().turn;

		expect(advisory()).toBe("");
		// The late scan had no baseline to be compared with, so it adds no delta;
		// this turn's own scan is compared with the row it wrote.
		expect(String(deadCodeRows()[1]?.reason)).toBe(
			"python:late_scan,python:clean",
		);
	});

	it("counts the old session's scan once when the new session's turn joins it", async () => {
		const first = await slowTurn();
		await first.turn;
		runtime.resetForSession();

		// The new session has no entry (it lives on the old session's scope): its
		// turn joins the client's single flight and parks an entry of its own.
		edit("other.py");
		const second = startTurn();
		await vi.advanceTimersByTimeAsync(3_100);
		await second.turn;
		await settle(first);

		const dropped = getDegradationSummary().find(
			(group) => group.kind === "dead-code-late-scan-dropped",
		);
		expect(dropped?.count).toBe(1);
		expect(vultureProcess.scans).toBe(1);
		// The new session's own late scan wrote the row the one process produced.
		expect(names()).toEqual(["late"]);
	});

	it("drops a scan that settles after its session ended, and counts it", async () => {
		const slow = await slowTurn();
		await slow.turn;
		runtime.resetForSession();
		await settle(slow);

		expect(names()).toEqual([]);
		const dropped = getDegradationSummary().find(
			(group) => group.kind === "dead-code-late-scan-dropped",
		);
		expect(JSON.stringify(dropped)).toContain("session-ended");
	});
});

describe("#4117 the scan record names what was left out", () => {
	it("carries the root and the excluded worktree count on the row and the dead-code log", async () => {
		const scripted = {
			id: "python",
			language: "Python",
			detect: () => true,
			owns: () => true,
			ensureAvailable: async () => true,
			analyze: async (): Promise<DeadCodeResult> => ({
				success: true,
				language: "Python",
				unusedExports: [],
				unusedFiles: [],
				unusedDeps: [],
				unlistedDeps: [],
				summary: "ok",
				excludedWorktrees: 2,
			}),
		};
		edit();

		await startTurn(undefined, [scripted]).turn;

		expect(deadCodeRows()[0]).toMatchObject({ excludedWorktrees: 2 });
		expect(logDeadCodeScan).toHaveBeenCalledWith(
			expect.objectContaining({ root, excludedWorktrees: 2 }),
		);
	});
});

describe("#4117 the back-off after an abandoned scan's timeout", () => {
	it("is lifted by the next scan of the root that succeeds", async () => {
		vultureProcess.failure = new Error("Process timed out after 30000ms");
		await client.analyze(root);
		expect(client.recentHardFailure(root)).toContain("timed out");

		vultureProcess.failure = undefined;
		await client.analyze(root);

		expect(client.recentHardFailure(root)).toBeNull();
	});

	it("expires after 30 minutes", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vultureProcess.failure = new Error("Process timed out after 30000ms");
		await client.analyze(root);

		vi.setSystemTime(Date.now() + 30 * 60 * 1000 - 1);
		expect(client.recentHardFailure(root)).toContain("timed out");
		vi.setSystemTime(Date.now() + 2);
		expect(client.recentHardFailure(root)).toBeNull();
	});
});

describe("#4154 a late scan is fenced to its session, its edits and the row on disk", () => {
	/** Let the parked scan finish, flush its settle handler, and return to the real clock. */
	async function settle(slow: { release: () => void }): Promise<void> {
		slow.release();
		await vi.advanceTimersByTimeAsync(10);
		vi.useRealTimers();
	}

	function row(): DeadCodeResult | undefined {
		return cacheManager.readCache<DeadCodeResult>(CACHE_KEY, root)?.data;
	}

	function names(): string[] {
		return row()?.unusedExports.map((issue) => issue.name) ?? [];
	}

	/** Another pi-lens process on the same project: its own runtime, client and cache manager. */
	function otherProcess(): TurnActor & { clients: DeadCodeClient[] } {
		return {
			runtime: new RuntimeCoordinator(),
			cacheManager: new CacheManager(false),
			clients: [new PythonDeadCodeClient(false)],
		};
	}

	/** Scan 2 is the other process's own scan; every other scan prints the default finding. */
	function foreignScanPrintsGood(): void {
		vultureProcess.stdout = (scan) =>
			scan === 2
				? `${root}/other.py:7: unused function 'foreign_good' (60% confidence)\n`
				: `${root}/mod.py:4: unused function 'late' (60% confidence)\n`;
	}

	/**
	 * Resolves when a parked scan's settle has logged a failed scan. That event
	 * is written after the row decision (#4154 V1 reads the row on disk first,
	 * asynchronously), so awaiting it orders the row assertions after the write
	 * without polling a clock.
	 */
	function failureLogged(): Promise<void> {
		return new Promise((resolve) => {
			logDeadCodeScan.mockImplementation((event: { success: boolean }) => {
				if (!event.success) resolve();
			});
		});
	}

	function dropped(): string {
		return JSON.stringify(
			getDegradationSummary().find(
				(group) => group.kind === "dead-code-late-scan-dropped",
			) ?? null,
		);
	}

	it("keeps a good row another process stored while a parked scan ran, when that scan then fails", async () => {
		// Recurrence prevented (#4154 V1, model ForeignRowPoison): the settle
		// handler judged the failure against the row the scan STARTED from (none),
		// so it replaced the good row another process had stored meanwhile and the
		// next turn rescanned with no baseline.
		cacheManager.clearCache(CACHE_KEY, root);
		foreignScanPrintsGood();
		const slow = await slowTurn();
		await slow.turn;

		const other = otherProcess();
		vultureProcess.gate = undefined;
		edit("other.py", other.cacheManager);
		await startTurn(undefined, other.clients, other).turn;
		expect(names()).toEqual(["foreign_good"]);

		vultureProcess.failure = new Error("boom");
		const logged = failureLogged();
		await settle(slow);
		await logged;

		expect(row()?.success).toBe(true);
		expect(names()).toEqual(["foreign_good"]);
		expect(logDeadCodeScan).toHaveBeenCalledWith(
			expect.objectContaining({ success: false, cacheKept: true }),
		);
		expect(dropped()).toContain("scan-failed");
	});

	it("still writes a parked scan's failure when no good row is on disk, so the back-off outlives the process", async () => {
		// The other direction of the V1 guard: a failure with nothing good to
		// protect is still recorded (the failed row is what session_start and the
		// next process back off on).
		cacheManager.clearCache(CACHE_KEY, root);
		vultureProcess.failure = new Error("boom");
		const slow = await slowTurn();
		await slow.turn;
		const logged = failureLogged();
		await settle(slow);
		await logged;

		expect(row()?.success).toBe(false);
		expect(logDeadCodeScan).not.toHaveBeenCalledWith(
			expect.objectContaining({ cacheKept: true }),
		);
	});

	it("keeps a good row another process stored during an inline scan that then fails inside the budget", async () => {
		// #4154 V1, inline member: the same stale comparison, over a window of at
		// most the budget.
		cacheManager.clearCache(CACHE_KEY, root);
		foreignScanPrintsGood();
		let release!: () => void;
		vultureProcess.gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let scan!: () => void;
		const scanning = new Promise<void>((resolve) => {
			scan = resolve;
		});
		vultureProcess.onScan = scan;
		vi.useFakeTimers();
		edit();
		const turn = startTurn();
		await scanning;
		vultureProcess.onScan = undefined;

		const other = otherProcess();
		vultureProcess.gate = undefined;
		edit("other.py", other.cacheManager);
		await startTurn(undefined, other.clients, other).turn;
		expect(names()).toEqual(["foreign_good"]);

		vultureProcess.failure = new Error("boom");
		release();
		await turn.turn;

		expect(names()).toEqual(["foreign_good"]);
		const failedRow = deadCodeRows().find((meta) => meta.success === false);
		expect(failedRow).toMatchObject({ cacheKept: true });
	});

	it("delivers an edit a replaced session made while the old session's scan was still running", async () => {
		// Recurrence prevented (#4154 J1, model JoinedScanStale): after /new the
		// new session's turn joined the old session's running vulture (the
		// client's single flight is process-wide) and took its result, which
		// predates the edit, as the answer for that edit: `carried` was never
		// delivered. Scan 1 started before other.py was edited; scan 2 sees it.
		vultureProcess.stdout = (scan) =>
			scan === 1
				? `${root}/mod.py:4: unused function 'late' (60% confidence)\n`
				: `${root}/mod.py:4: unused function 'late' (60% confidence)\n${root}/other.py:7: unused function 'carried' (60% confidence)\n`;
		const first = await slowTurn();
		await first.turn;
		runtime.resetForSession();

		edit("other.py");
		const second = startTurn();
		await vi.advanceTimersByTimeAsync(3_100);
		await second.turn;
		expect(vultureProcess.scans).toBe(1);
		await settle(first);
		vultureProcess.gate = undefined;

		edit("third.py");
		await startTurn().turn;

		expect(advisory()).toContain("carried");
		expect(String(deadCodeRows().at(-1)?.reason)).toContain("python:joined");
		expect(vultureProcess.scans).toBe(2);
	});

	it("parks a joined result that predates this turn's edit even when it finishes inside the budget", async () => {
		// #4154 J1, the inline member: a fresh fetch (lens_diagnostics) started
		// the scan, the agent then edited other.py, and turn_end joined that scan
		// and got its answer inside the budget. It is not this edit's answer.
		vultureProcess.stdout = (scan) =>
			scan === 1
				? `${root}/mod.py:4: unused function 'late' (60% confidence)\n`
				: `${root}/mod.py:4: unused function 'late' (60% confidence)\n${root}/other.py:7: unused function 'carried' (60% confidence)\n`;
		let release!: () => void;
		vultureProcess.gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let scan!: () => void;
		const scanning = new Promise<void>((resolve) => {
			scan = resolve;
		});
		vultureProcess.onScan = scan;
		vi.useFakeTimers();
		const freshFetch = client.analyze(root);
		await scanning;
		vultureProcess.onScan = undefined;
		await vi.advanceTimersByTimeAsync(50);

		edit("other.py");
		const turn = startTurn();
		await vi.advanceTimersByTimeAsync(100);
		release();
		await turn.turn;
		await freshFetch;
		expect(advisory()).toBe("");
		expect(String(deadCodeRows().at(-1)?.reason)).toContain("python:joined");
		await vi.advanceTimersByTimeAsync(10);
		vi.useRealTimers();
		vultureProcess.gate = undefined;

		edit("third.py");
		await startTurn().turn;
		expect(advisory()).toContain("carried");
		expect(vultureProcess.scans).toBe(2);
	});

	it("never hands a concurrent subagent's turn the primary's settled late scan", async () => {
		// Recurrence prevented (review of #4153, F2): the entry was keyed by
		// client and root on the primary's scope, so a subagent's turn on the
		// singleton runtime took the primary's settled entry and rendered its
		// delta as its own; the primary never saw it.
		const slow = await slowTurn();
		await slow.turn;
		await settle(slow);
		vultureProcess.gate = undefined;

		const secondary: TurnActor = {
			sessionId: "secondary-B",
			sessionScope: beginScope({ role: "secondary" }),
		};
		edit("other.py");
		await startTurn(undefined, [client], secondary).turn;
		expect(advisory()).not.toContain("late");

		edit("third.py");
		await startTurn().turn;
		expect(advisory()).toContain("late");
	});

	it("drops a subagent's late scan when the subagent ends before it settles, and leaves the primary's cell alone", async () => {
		const scope = beginScope({ role: "secondary" });
		const slow = await slowTurn(undefined, {
			sessionId: "secondary-B",
			sessionScope: scope,
		});
		await slow.turn;
		retireScope(scope, "quit");
		await settle(slow);

		expect(dropped()).toContain("session-ended");
		vultureProcess.gate = undefined;
		edit("third.py");
		await startTurn().turn;
		expect(String(deadCodeRows().at(-1)?.reason)).not.toContain("late_scan");
		expect(advisory()).not.toContain("late");
	});
});
