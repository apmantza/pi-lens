// flake-shape: real-process-spawn — real `git worktree add` children write the linked-worktree `.git` files and the `worktrees/*/gitdir` registry that checkout ownership is read from; an in-process stub would only restate the assumption under test

/**
 * #3872: knip at turn_end runs in the checkout that OWNS the edit, counts no
 * nested git worktree as project files, and stays inside the turn_end budget.
 *
 * Recurrence prevented (live session 01a0f1c5, 2026-09-30, 191 of 196 edits in
 * `.worktrees/*`): `handleTurnEnd` spawned knip at the session cwd for every
 * edit, whichever checkout it landed in, and knip walked into every unignored
 * `.worktrees/*` directory. `totalIssues` climbed 9256 -> 16187 (about +300 per
 * worktree), `newIssues` attributed one issue per first touch to the agent, and
 * the 7 s scan ran past the 3 s hook budget (`hook-await-exceeded` at
 * 3131/3000 ms, then `phase knip 7178`) while the handler kept the turn open.
 *
 * Every case drives the real `handleTurnEnd`, the real `KnipClient` and the
 * real `CacheManager` over REAL git worktrees (`git worktree add`, the
 * `tests/support/git-fixture-env.ts` helpers). The one thing faked is the knip
 * process, and only on the axis under test: `fakeKnip` reports every `unused*`
 * export in EVERY `.ts` file under its spawn cwd, `.worktrees/*` included --
 * which is what the real binary did on a fixture with the same shape
 * (`knip --reporter=json` on a repo with three unignored linked worktrees listed
 * all of their files; transcript in the PR body).
 *
 * Boundary decision (flake-shape): no real knip spawn and no wall-clock wait.
 * The slow scan is a promise the test releases, and the budget is spent on a
 * fake clock installed before the turn starts.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

const logLatency = vi.hoisted(() => vi.fn());
vi.mock("../../clients/latency-logger.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/latency-logger.js")>()),
	logLatency,
}));

const knipProcess = vi.hoisted(() => ({
	spawns: [] as Array<{ cwd: string; args: string[] }>,
	/** When set, the next knip spawn parks on it (the slow scan under test). */
	gate: undefined as Promise<void> | undefined,
	onSpawn: undefined as (() => void) | undefined,
	scan: undefined as ((cwd: string) => string) | undefined,
	/** When set, the spawn settles with this error (knip's own 30 s timeout). */
	failure: undefined as Error | undefined,
}));
vi.mock("../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/safe-spawn.js")>()),
	safeSpawnAsync: vi.fn(
		async (_command: string, args: string[], options?: { cwd?: string }) => {
			if (!args.includes("--reporter=json")) {
				return { stdout: "", stderr: "", status: 0 };
			}
			const cwd = options?.cwd ?? "";
			knipProcess.spawns.push({ cwd, args });
			knipProcess.onSpawn?.();
			await knipProcess.gate;
			if (knipProcess.failure) {
				return {
					stdout: "",
					stderr: "",
					status: null,
					error: knipProcess.failure,
				};
			}
			return {
				stdout: knipProcess.scan?.(cwd) ?? '{"issues":[]}',
				stderr: "",
				status: 1,
			};
		},
	),
}));
vi.mock("../../clients/sessionstart-logger.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../clients/sessionstart-logger.js")
	>()),
	logSessionStart: vi.fn(),
}));

import { CacheManager } from "../../clients/cache-manager.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { _resetInstanceRegistryEnabledForTests } from "../../clients/instance-registry.js";
import { KnipClient } from "../../clients/knip-client.js";
import { resolveKnipScanRoots } from "../../clients/knip-scan-roots.js";
import { consumeTurnEndFindings } from "../../clients/runtime-context.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { handleTurnEnd } from "../../clients/runtime-turn.js";
import { gitExecFileSync } from "../support/git-fixture-env.js";
import { setupTestEnvironment } from "./test-utils.js";

const SESSION = "knip-root-session";

/**
 * What the real binary reports for a tree: every `unused*` export of every
 * `.ts` file below its cwd. It skips `node_modules` and `.git` (knip's own
 * GLOBAL_IGNORE_PATTERNS) and nothing else -- an unignored `.worktrees/x` is
 * walked like any other directory.
 */
function fakeKnip(cwd: string): string {
	const issues: unknown[] = [];
	const walk = (dir: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			if (entry.name === "node_modules" || entry.name === ".git") continue;
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(full);
				continue;
			}
			if (!entry.name.endsWith(".ts")) continue;
			const names = [
				...fs.readFileSync(full, "utf8").matchAll(/export const (unused\w+)/g),
			].map((match) => ({ name: match[1], line: 1 }));
			if (names.length === 0) continue;
			issues.push({
				file: path.relative(cwd, full).replace(/\\/g, "/"),
				exports: names,
			});
		}
	};
	walk(cwd);
	return JSON.stringify({ issues });
}

let env: ReturnType<typeof setupTestEnvironment>;
let runtime: RuntimeCoordinator;
let cacheManager: CacheManager;
/** One client per test, as production has one per session: back-off state lives on it. */
let knipClient: KnipClient;
let main: string;

function git(cwd: string, ...args: string[]): void {
	gitExecFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
}

function write(dir: string, relative: string, content: string): string {
	const file = path.join(dir, relative);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
	return file;
}

/** A real repository whose `.worktrees/` is NOT gitignored (the plegma shape). */
function initRepo(dir: string): void {
	fs.mkdirSync(dir, { recursive: true });
	git(dir, "init", "-q", "-b", "main");
	git(dir, "config", "user.email", "test@example.com");
	git(dir, "config", "user.name", "t");
	write(dir, "package.json", '{"name":"fixture","version":"1.0.0"}\n');
	write(dir, "src/a.ts", "export const unusedA = 1;\n");
	git(dir, "add", "-A");
	git(dir, "commit", "-qm", "init");
}

function addWorktree(name: string): string {
	const dir = path.join(main, ".worktrees", name);
	git(main, "worktree", "add", "-q", "-b", name, dir);
	return dir;
}

/** The agent wrote `file`: the worklist row turn_end reads, plus the runtime's own seq bump. */
function edit(file: string): void {
	runtime.recordProjectMutation({ filePath: file, source: "agent-edit" });
	cacheManager.addModifiedRange(
		file,
		{ start: 1, end: 1 },
		false,
		main,
		SESSION,
	);
}

/** One project-local knip shim at the session root, so no managed install is probed. */
function installKnipShim(root: string): void {
	const bin = path.join(root, "node_modules", ".bin");
	fs.mkdirSync(bin, { recursive: true });
	fs.writeFileSync(
		path.join(bin, process.platform === "win32" ? "knip.cmd" : "knip"),
		"#!/bin/sh\nexit 0\n",
	);
}

function turnEndDeps(signal?: AbortSignal) {
	return {
		ctxCwd: main,
		getFlag: () => false,
		dbg: () => {},
		runtime,
		cacheManager,
		...(signal === undefined ? {} : { signal }),
		knipClient,
		deadCodeClients: [],
		depChecker: { ensureAvailable: async () => false },
		testRunnerClient: { getTestRunTarget: () => null },
		resetLSPService: () => {},
		resetFormatService: () => {},
	} as unknown as Parameters<typeof handleTurnEnd>[0];
}

async function turnEnd(): Promise<string> {
	await handleTurnEnd(turnEndDeps());
	return (
		consumeTurnEndFindings(cacheManager, main)?.messages?.[0]?.content ?? ""
	);
}

function knipRows(): Array<Record<string, unknown>> {
	return logLatency.mock.calls
		.map((call) => call[0] as Record<string, unknown>)
		.filter((entry) => entry.type === "phase" && entry.phase === "knip");
}

/** `totalIssues` of the `index`-th `knip` row (negative counts from the end). */
function totalIssuesOf(index: number): number | undefined {
	const row = knipRows().at(index);
	return (row?.metadata as { totalIssues?: number } | undefined)?.totalIssues;
}

function spawnCwds(): string[] {
	return knipProcess.spawns.map((spawn) => spawn.cwd);
}

function realPath(p: string): string {
	return fs.realpathSync.native(p);
}

beforeAll(() => {
	vi.stubEnv("PI_LENS_INSTANCE_REGISTRY", "0");
	_resetInstanceRegistryEnabledForTests();
});
afterAll(() => {
	vi.unstubAllEnvs();
	_resetInstanceRegistryEnabledForTests();
});

beforeEach(() => {
	logLatency.mockReset();
	resetDegradationLedger();
	knipProcess.spawns.length = 0;
	knipProcess.gate = undefined;
	knipProcess.onSpawn = undefined;
	knipProcess.scan = fakeKnip;
	knipProcess.failure = undefined;
	env = setupTestEnvironment("pi-lens-3872-knip-root-");
	vi.stubEnv("PI_LENS_HOME", path.join(env.tmpDir, "machine"));
	main = path.join(env.tmpDir, "main");
	initRepo(main);
	installKnipShim(main);
	runtime = new RuntimeCoordinator();
	runtime.projectRoot = main;
	runtime.setTelemetryIdentity({ sessionId: SESSION });
	cacheManager = new CacheManager(false);
	knipClient = new KnipClient(false);
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
	vi.stubEnv("PI_LENS_INSTANCE_REGISTRY", "0");
	env.cleanup();
});

describe("#3872 scan root: the checkout that owns the edit", () => {
	it("scans a linked worktree's own root for an edit there, never the session checkout", async () => {
		const x = addWorktree("x");
		edit(path.join(x, "src", "a.ts"));

		await turnEnd();

		expect(spawnCwds().map(realPath)).toEqual([realPath(x)]);
		expect(knipRows().map((row) => row.filePath)).toEqual([x]);
	});

	it("scans the session cwd exactly as before when every edit is in the session checkout", async () => {
		addWorktree("x");
		edit(path.join(main, "src", "a.ts"));

		await turnEnd();

		expect(spawnCwds()).toEqual([main]);
		expect(knipProcess.spawns[0]?.args).toEqual(
			expect.arrayContaining(["--reporter=json", "--cache"]),
		);
	});

	it("scans each distinct checkout once per turn and records the roots beyond the cap", async () => {
		const worktrees = ["w1", "w2", "w3"].map(addWorktree);
		for (const dir of worktrees) edit(path.join(dir, "src", "a.ts"));
		edit(path.join(worktrees[0] as string, "src", "b.ts"));
		edit(path.join(main, "src", "a.ts"));

		await turnEnd();

		// main + w1 + w2 are scanned; w3 is over the cap of 3. w1 is edited twice
		// and scanned once.
		expect(spawnCwds().map(realPath).sort()).toEqual(
			[main, worktrees[0], worktrees[1]]
				.map((dir) => realPath(dir as string))
				.sort(),
		);
		const skipped = getDegradationSummary().find(
			(group) => group.kind === "turn-end-knip-root-skipped",
		);
		expect(skipped?.count).toBe(1);
		expect(JSON.stringify(skipped)).toContain("root-cap");
		expect(JSON.stringify(skipped)).toContain(".worktrees/w3");
	});

	it("keeps an edit in a nested independent clone in the session scan", async () => {
		// Not a linked worktree of this repository (different commondir): its
		// files stay part of the session's own scan, exactly as before #3872.
		const clone = path.join(main, "vendor-clone");
		initRepo(clone);
		edit(path.join(clone, "src", "a.ts"));

		await turnEnd();

		expect(spawnCwds()).toEqual([main]);
	});

	it("keeps today's single cwd scan when the session cwd is not in a git checkout", async () => {
		// Fail-open: ownership cannot be established, so the old behaviour stays.
		const plain = path.join(env.tmpDir, "plain");
		write(plain, "package.json", '{"name":"plain"}\n');
		write(plain, "src/a.ts", "export const unusedA = 1;\n");
		installKnipShim(plain);
		main = plain;
		runtime.projectRoot = plain;
		edit(path.join(plain, "src", "a.ts"));

		await turnEnd();

		expect(spawnCwds()).toEqual([plain]);
	});
});

describe("#3872 scan population: nested worktrees are not project files", () => {
	it("keeps the session checkout's issue count flat as linked worktrees appear under it", async () => {
		edit(path.join(main, "src", "a.ts"));
		await turnEnd();
		const before = totalIssuesOf(-1);
		expect(before).toBe(1);

		for (const name of ["w1", "w2", "w3"]) addWorktree(name);
		edit(path.join(main, "src", "a.ts"));
		await turnEnd();

		expect(spawnCwds()).toEqual([main, main]);
		expect(totalIssuesOf(-1)).toBe(before);
	});

	it("still counts a worktree's own files when that worktree is the scan root", async () => {
		const x = addWorktree("x");
		edit(path.join(x, "src", "a.ts"));

		await turnEnd();

		expect(totalIssuesOf(0)).toBe(1);
	});
});

describe("#3872 delta: a root's first scan still reports this turn's own issues", () => {
	it("reports what the agent added on the first-touch turn, then diffs later turns against the stored scan", async () => {
		const x = addWorktree("x");
		const file = path.join(x, "src", "a.ts");
		fs.appendFileSync(file, "export const unusedNew = 3;\n");
		edit(file);
		const first = await turnEnd();

		// No stored scan for this root: the issues in the files modified THIS turn
		// are reported (the same answer a cold session checkout gives), never hidden.
		expect(first).toContain("unusedNew");
		expect(first).toContain(path.join(".worktrees", "x", "src", "a.ts"));

		fs.appendFileSync(file, "export const unusedB = 2;\n");
		edit(file);
		const second = await turnEnd();

		expect(second).toContain("unusedB");
		expect(second).not.toContain("unusedNew");
		expect(second).not.toContain("unusedA");
	});

	it("delivers a session-checkout edit's issues when no scan is stored yet", async () => {
		fs.appendFileSync(
			path.join(main, "src", "a.ts"),
			"export const unusedNew = 3;\n",
		);
		edit(path.join(main, "src", "a.ts"));

		expect(await turnEnd()).toContain("unusedNew");
	});
});

describe("#3872 budget: a slow scan no longer holds the turn_end handler", () => {
	/** Start a turn on a fake clock, with the scan parked until released. */
	function slowTurn(): {
		turn: Promise<void>;
		spawned: Promise<void>;
		release: () => void;
		settled: () => boolean;
	} {
		let release!: () => void;
		knipProcess.gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let spawn!: () => void;
		const spawned = new Promise<void>((resolve) => {
			spawn = resolve;
		});
		knipProcess.onSpawn = spawn;
		vi.useFakeTimers();
		let done = false;
		const turn = handleTurnEnd(turnEndDeps()).then(() => {
			done = true;
		});
		return { turn, spawned, release, settled: () => done };
	}

	it("returns inside the turn_end budget, records the deferral, and writes no late cache row", async () => {
		const x = addWorktree("x");
		edit(path.join(x, "src", "a.ts"));
		const slow = slowTurn();

		await slow.spawned;
		await vi.advanceTimersByTimeAsync(3_100);
		await slow.turn;
		expect(slow.settled()).toBe(true);
		// The handler reached its end inside the budget: it cleared its OWN turn's
		// worklist before any newer turn could begin, so nothing is "retained".
		expect(cacheManager.readTurnState(main).files).toEqual({});

		const [row] = knipRows();
		expect(row?.metadata).toMatchObject({
			execution: "deferred",
			aborted: false,
		});
		const exceeded = getDegradationSummary().find(
			(group) => group.kind === "hook-await-exceeded",
		);
		expect(JSON.stringify(exceeded)).toContain("turn_end:knip");

		// The scan settles late: nothing it computes may reach the abandoned turn.
		slow.release();
		await vi.advanceTimersByTimeAsync(10);
		vi.useRealTimers();
		expect(cacheManager.readCache("knip", x)).toBeNull();
		expect(cacheManager.readCache("knip", main)).toBeNull();
	});

	it("backs off a root whose abandoned scan later timed out, instead of spawning every turn", async () => {
		// #1467's contract: after a timeout, later turns skip rather than launch
		// another 30 s knip. The back-off used to ride on the cache row the turn
		// wrote when the scan settled INSIDE the turn; an abandoned scan writes none.
		const x = addWorktree("x");
		knipProcess.failure = new Error("Process timed out after 30000ms");
		for (let turn = 0; turn < 4; turn++) {
			edit(path.join(x, "src", "a.ts"));
			const slow = slowTurn();
			await vi.advanceTimersByTimeAsync(3_100);
			await slow.turn;
			// The parked scan finally times out, long after its turn ended.
			slow.release();
			await vi.advanceTimersByTimeAsync(31_000);
			vi.useRealTimers();
		}

		expect(spawnCwds()).toHaveLength(1);
		const rows = knipRows().map(
			(row) => row.metadata as Record<string, unknown>,
		);
		expect(rows[0]).toMatchObject({ execution: "deferred" });
		for (const row of rows.slice(1)) {
			expect(row).toMatchObject({ skipped: true });
			expect(String(row.reason)).toContain("timed out");
		}
	});

	it("reports this turn's issues on the next completed scan of a root whose earlier scan was deferred", async () => {
		const x = addWorktree("x");
		const file = path.join(x, "src", "a.ts");
		edit(file);
		const slow = slowTurn();
		await slow.spawned;
		await vi.advanceTimersByTimeAsync(3_100);
		await slow.turn;
		slow.release();
		await vi.advanceTimersByTimeAsync(10);
		vi.useRealTimers();
		knipProcess.gate = undefined;

		// Nothing was stored for x: the deferred scan wrote no baseline.
		fs.appendFileSync(file, "export const unusedNew = 3;\n");
		edit(file);
		expect(await turnEnd()).toContain("unusedNew");
	});

	it("starts no further scan once one has spent the budget, and counts the skipped roots", async () => {
		const [x, y] = ["x", "y"].map(addWorktree);
		edit(path.join(x as string, "src", "a.ts"));
		edit(path.join(y as string, "src", "a.ts"));
		const slow = slowTurn();

		await slow.spawned;
		await vi.advanceTimersByTimeAsync(3_100);
		await slow.turn;
		vi.useRealTimers();

		expect(spawnCwds().map(realPath)).toEqual([realPath(x as string)]);
		const skipped = getDegradationSummary().find(
			(group) => group.kind === "turn-end-knip-root-skipped",
		);
		expect(skipped?.count).toBe(1);
		expect(JSON.stringify(skipped)).toContain("budget");
		slow.release();
	});

	it("still delivers a scan that finishes inside the budget", async () => {
		const x = addWorktree("x");
		const file = path.join(x, "src", "a.ts");
		edit(file);
		await turnEnd();
		fs.appendFileSync(file, "export const unusedB = 2;\n");
		edit(file);

		expect(await turnEnd()).toContain("unusedB");
		expect(knipRows().at(-1)?.metadata).toMatchObject({
			execution: "executed",
		});
		expect(
			getDegradationSummary().find(
				(group) => group.kind === "hook-await-exceeded",
			),
		).toBeUndefined();
	});

	it("releases on Escape without a hook-await-exceeded row", async () => {
		const x = addWorktree("x");
		edit(path.join(x, "src", "a.ts"));
		const controller = new AbortController();
		let release!: () => void;
		knipProcess.gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let spawn!: () => void;
		const spawned = new Promise<void>((resolve) => {
			spawn = resolve;
		});
		knipProcess.onSpawn = spawn;
		const turn = handleTurnEnd(turnEndDeps(controller.signal));

		await spawned;
		controller.abort();
		await turn;
		release();

		expect(
			getDegradationSummary().find(
				(group) => group.kind === "hook-await-exceeded",
			),
		).toBeUndefined();
		expect(knipRows()[0]?.metadata).toMatchObject({
			execution: "deferred",
			aborted: true,
		});
	});
});

describe("#3872 scope resolution as a function (guards the branches a turn cannot reach)", () => {
	it("scans the session cwd alone when there is nothing to attribute", () => {
		// `files.length === 0 && runtime.hasCascadeRuns()` reaches knip with an
		// empty worklist; a root list of [] would silently skip the refresh.
		expect(resolveKnipScanRoots(main, [])).toEqual({
			roots: [main],
			overCap: [],
		});
	});

	it("keeps the session cwd when it is a plain directory that merely contains a repository", () => {
		// `session` is null here. Removing the guard throws on `session.root`.
		const workspace = path.join(env.tmpDir, "ws");
		const repo = path.join(workspace, "repoA");
		initRepo(repo);

		expect(
			resolveKnipScanRoots(workspace, [path.join(repo, "src", "a.ts")]),
		).toEqual({ roots: [workspace], overCap: [] });
	});

	it("treats an edit spelled by the real path as session-owned when the session cwd is a symlink", () => {
		const link = path.join(env.tmpDir, "link");
		fs.symlinkSync(
			main,
			link,
			process.platform === "win32" ? "junction" : "dir",
		);

		expect(
			resolveKnipScanRoots(link, [path.join(realPath(main), "src", "a.ts")]),
		).toEqual({ roots: [link], overCap: [] });
	});

	it("keeps a monorepo package directory as the session root instead of the repository top", () => {
		// The session checkout owns this edit, so the scan stays at the cwd the
		// session chose (`mono/packages/a`), not at `mono`.
		const mono = path.join(env.tmpDir, "mono");
		initRepo(mono);
		const pkg = path.join(mono, "packages", "a");
		write(pkg, "package.json", '{"name":"a"}\n');
		write(pkg, "src/x.ts", "export const x = 1;\n");

		expect(resolveKnipScanRoots(pkg, [path.join(pkg, "src", "x.ts")])).toEqual({
			roots: [pkg],
			overCap: [],
		});
	});

	// State-space cell S10 (#3872 r3): a link inside the repository that points
	// into a worktree gives one checkout two spellings that both pass
	// `addModifiedRange`. Scan roots keep the edit's spelling, but the one
	// process per checkout per turn is decided on the real path.
	it("scans a worktree reached through two spellings once", () => {
		const x = addWorktree("x");
		const viaLink = path.join(main, "wt-link");
		fs.symlinkSync(
			x,
			viaLink,
			process.platform === "win32" ? "junction" : "dir",
		);

		expect(
			resolveKnipScanRoots(main, [
				path.join(viaLink, "src", "a.ts"),
				path.join(x, "src", "a.ts"),
			]),
		).toEqual({ roots: [viaLink], overCap: [] });
	});
});

describe("#3872 population details", () => {
	it("keeps an issue that names no file when nested worktrees exist", async () => {
		addWorktree("x");
		knipProcess.scan = () =>
			JSON.stringify({
				issues: [
					{ file: "", dependencies: [{ name: "left-pad" }] },
					{ file: "src/a.ts", exports: [{ name: "unusedA", line: 1 }] },
					{
						file: ".worktrees/x/src/a.ts",
						exports: [{ name: "unusedA", line: 1 }],
					},
				],
			});
		edit(path.join(main, "src", "a.ts"));

		await turnEnd();

		expect(totalIssuesOf(0)).toBe(2);
	});
});

describe("#3872 identity: a symlinked session cwd is the same checkout", () => {
	function useSymlinkedSession(): string {
		const link = path.join(env.tmpDir, "link");
		fs.symlinkSync(
			main,
			link,
			process.platform === "win32" ? "junction" : "dir",
		);
		main = link;
		runtime.projectRoot = link;
		return link;
	}

	it("still scans a linked worktree in its own root", async () => {
		useSymlinkedSession();
		const x = addWorktree("x");
		edit(path.join(x, "src", "a.ts"));

		await turnEnd();

		expect(spawnCwds().map(realPath)).toEqual([realPath(x)]);
	});

	it("still drops nested worktree files from the session scan", async () => {
		const link = useSymlinkedSession();
		for (const name of ["w1", "w2"]) addWorktree(name);
		edit(path.join(link, "src", "a.ts"));

		await turnEnd();

		expect(totalIssuesOf(0)).toBe(1);
	});

	// Verify r2, R2-1 (state-space cell S4): round 2 scanned the worktree under
	// its REAL path while the edit's key stayed spelled through the link, so the
	// delta compared two spellings of one file and dropped the issue. The row
	// read `executed`, `newIssues: 0`: a clean-looking turn that discarded a
	// finding (shape 10).
	it("delivers a worktree edit's new issue when the session cwd is a symlink", async () => {
		useSymlinkedSession();
		const x = addWorktree("x");
		const file = path.join(x, "src", "a.ts");
		fs.appendFileSync(file, "export const unusedNew = 3;\n");
		edit(file);

		const message = await turnEnd();

		expect(message).toContain("unusedNew");
		expect(message).toContain(".worktrees/x/src/a.ts");
		expect(message).not.toContain(realPath(x));
	});

	// State-space cell S5: the session cwd is real but `.worktrees` itself is a
	// link to another disk (a scratch volume). The worktree's real root is
	// outside the session spelling; the edit's key is not.
	it("delivers a worktree edit's new issue when the worktrees directory is a symlink", async () => {
		const elsewhere = path.join(env.tmpDir, "elsewhere");
		fs.mkdirSync(elsewhere);
		fs.symlinkSync(
			elsewhere,
			path.join(main, ".worktrees"),
			process.platform === "win32" ? "junction" : "dir",
		);
		const x = addWorktree("x");
		const file = path.join(x, "src", "a.ts");
		fs.appendFileSync(file, "export const unusedNew = 3;\n");
		edit(file);

		const message = await turnEnd();

		expect(spawnCwds().map(realPath)).toEqual([realPath(x)]);
		expect(message).toContain("unusedNew");
	});

	// Verify r2, R2-3: git writes real paths into `worktrees/<name>/gitdir`, but
	// a registry entry written before its directory moved behind a link (a home
	// relocated onto a symlinked volume) names the old spelling. The matcher
	// compares canonical prefixes, so the registry side must be canonical too.
	it("drops a nested worktree whose registry entry names it through a link", async () => {
		addWorktree("x");
		const alias = path.join(env.tmpDir, "alias");
		fs.symlinkSync(
			main,
			alias,
			process.platform === "win32" ? "junction" : "dir",
		);
		fs.writeFileSync(
			path.join(main, ".git", "worktrees", "x", "gitdir"),
			`${path.join(alias, ".worktrees", "x", ".git")}\n`,
		);

		const result = await knipClient.analyze(main);

		expect(result.issues.map((issue) => issue.file)).toEqual(["src/a.ts"]);
	});
});

describe("#3872 the timeout back-off's own lifecycle", () => {
	const timedOut = (): Error => new Error("Process timed out after 30000ms");

	it("forgets a recorded timeout once a scan of that root succeeds", async () => {
		knipProcess.failure = timedOut();
		await knipClient.analyze(main);
		expect(knipClient.recentHardFailure(main)).toContain("timed out");

		knipProcess.failure = undefined;
		await knipClient.analyze(main);

		expect(knipClient.recentHardFailure(main)).toBeNull();
	});

	it("lets a root back in after the 30 minute window", async () => {
		knipProcess.failure = timedOut();
		await knipClient.analyze(main);
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(Date.now() + 29 * 60_000);
		expect(knipClient.recentHardFailure(main)).toContain("timed out");

		vi.setSystemTime(Date.now() + 2 * 60_000);

		expect(knipClient.recentHardFailure(main)).toBeNull();
	});

	it("starts a new session with no recorded timeout", async () => {
		knipProcess.failure = timedOut();
		await knipClient.analyze(main);

		knipClient.resetSessionState();

		expect(knipClient.recentHardFailure(main)).toBeNull();
	});

	it("does not back off a failure that is not a timeout or a kill", async () => {
		knipProcess.failure = new Error("spawn knip ENOENT");
		await knipClient.analyze(main);

		expect(knipClient.recentHardFailure(main)).toBeNull();
	});
});

describe("#3872 one hard-failure rule for every back-off reader", () => {
	/** A dead-code client whose only observable is whether turn_end ran it. */
	function deadCodeProbe() {
		return {
			id: "probe",
			language: "Probe",
			detect: () => true,
			owns: () => true,
			ensureAvailable: async () => true,
			analyze: vi.fn(async () => ({
				success: true,
				language: "Probe",
				unusedExports: [],
				unusedFiles: [],
				unusedDeps: [],
				unlistedDeps: [],
				summary: "clean",
			})),
		};
	}

	// Verify r2, R2-2. Recurrence: the #1467 back-off was spelled three times
	// (the knip client's stamp, turn_end's knip row and its dead-code row). A
	// wording added to one copy only splits them, and the reader that misses it
	// launches another heavyweight scan every turn.
	it("backs off on the same failure wordings in the knip client, the knip row and the dead-code row", async () => {
		const wordings = [
			["Process timed out after 30000ms", true],
			["Process killed after exceeding its output cap", true],
			["terminated by SIGTERM", true],
			["terminated by SIGKILL", true],
			["terminated by SIGABRT", true],
			["spawn knip ENOENT", false],
			["Failed to parse output", false],
		] as const;
		const verdicts: Array<{ message: string; readers: boolean[] }> = [];
		for (const [message] of wordings) {
			// Reader 1: the client's own stamp, set where a scan settles.
			const stampClient = new KnipClient(false);
			knipProcess.failure = new Error(message);
			await stampClient.analyze(main);
			knipProcess.failure = undefined;
			const stamped = stampClient.recentHardFailure(main) !== null;

			// Readers 2 and 3: turn_end's back-off on a cached failure row.
			knipClient = new KnipClient(false);
			cacheManager.writeCache(
				"knip",
				{
					success: false,
					issues: [],
					unusedExports: [],
					unusedFiles: [],
					unusedDeps: [],
					unlistedDeps: [],
					summary: `Error: ${message}`,
				},
				main,
			);
			cacheManager.writeCache(
				"dead-code-probe",
				{
					success: false,
					language: "Probe",
					unusedExports: [],
					unusedFiles: [],
					unusedDeps: [],
					unlistedDeps: [],
					summary: message,
				},
				main,
			);
			const deadCode = deadCodeProbe();
			knipProcess.spawns.length = 0;
			edit(path.join(main, "src", "a.ts"));
			await handleTurnEnd({
				...turnEndDeps(),
				deadCodeClients: [deadCode],
			} as unknown as Parameters<typeof handleTurnEnd>[0]);

			verdicts.push({
				message,
				readers: [
					stamped,
					knipProcess.spawns.length === 0,
					deadCode.analyze.mock.calls.length === 0,
				],
			});
		}

		expect(verdicts).toEqual(
			wordings.map(([message, hard]) => ({
				message,
				readers: [hard, hard, hard],
			})),
		);
	});
});
