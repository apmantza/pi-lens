/**
 * #775 / #4126 — a `too-many-source-files` / `too-many-entries` startup-scan
 * verdict silently skipped the warm pipeline (heavy scans, TODO scan,
 * dominant-language LSP pre-warm) with only a debug-log line, unlike the
 * slow-FS probe which fires a visible notify (`runtime-session.ts` around the
 * `slowFsVerdict.slow` check). These tests drive the real `handleSessionStart`
 * on both paths that observe a size skip, the full-mode branch (pre-seeded
 * verdict, same technique as `runtime-session-scan-cache.test.ts`) and the
 * default first-session quick warmup (a real over-cap tree), and assert:
 *   - every size-bounded verdict fires the warm-skip notify exactly once per
 *     session start, naming the bound that produced it;
 *   - a deferred warmup whose session was superseded or shut down delivers
 *     nothing (#4126 N1), so a replacement start shows one line, its own;
 *   - a raised PI_LENS_STARTUP_SCAN_MAX_ENTRIES re-walks on the next session
 *     instead of reusing the stored `too-many-entries` verdict (#4126 N2);
 *   - a normal (small, `canWarmCaches: true`) project never fires it.
 */

import { withResidentBootstrap } from "../support/bootstrap-access.js";
import * as fs from "node:fs";
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
import {
	buildProjectSnapshotFromRuntime,
	saveProjectSnapshot,
	waitForProjectSnapshotPersistsForTests,
} from "../../clients/project-snapshot.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { getDegradationSummary } from "../../clients/degradation-ledger.js";
import { getStartupScanMaxSourceFilesDerived } from "../../clients/project-scale.js";
import { retireScope } from "../../clients/session-scope.js";
import {
	cleanupTestEnvironmentsDrained,
	createTempFile,
	setupTestEnvironment,
} from "./test-utils.js";
import { suspendAt, waitFor } from "./interleaving-kit.js";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";

vi.mock("../../clients/lsp/config.js", () => ({
	loadLSPConfig: vi.fn().mockResolvedValue({}),
	initLSPConfig: vi.fn().mockResolvedValue(undefined),
	getServerInitOverride: vi.fn().mockReturnValue(undefined),
}));

vi.mock("../../clients/lsp/capabilities.js", () => ({
	getLSPService: vi.fn(() => makeLspServiceDouble()),
}));

// The quick-mode warmup's scan is the one await the N1 tests must hold open
// while another session starts; the spy delegates to the real walk otherwise.
const resolveStartupScanContextAsyncSpy = vi.hoisted(() => vi.fn());
const scanSeam = vi.hoisted(() => ({
	actual: undefined as
		| typeof import("../../clients/startup-scan.js").resolveStartupScanContextAsync
		| undefined,
}));

vi.mock("../../clients/startup-scan.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/startup-scan.js")>();
	scanSeam.actual = actual.resolveStartupScanContextAsync;
	resolveStartupScanContextAsyncSpy.mockImplementation(
		actual.resolveStartupScanContextAsync,
	);
	return {
		...actual,
		resolveStartupScanContextAsync: resolveStartupScanContextAsyncSpy,
	};
});

import { handleSessionStart } from "../../clients/runtime-session.js";
import {
	_resetStartupScanMaxEntriesForTests,
	getStartupScanMaxEntries,
} from "../../clients/startup-scan.js";

const WARM_SKIP_LINE = "Project-size limits disabled background warm scans";

function setStartupMode(mode: "full" | "quick"): () => void {
	const prev = process.env.PI_LENS_STARTUP_MODE;
	process.env.PI_LENS_STARTUP_MODE = mode;
	return () => {
		if (prev === undefined) delete process.env.PI_LENS_STARTUP_MODE;
		else process.env.PI_LENS_STARTUP_MODE = prev;
	};
}

function makeDeps(
	ctxCwd: string,
	notify: (msg: string, level: string) => void,
	runtime: RuntimeCoordinator = new RuntimeCoordinator(),
	dbg: (msg: string) => void = () => {},
) {
	return withResidentBootstrap({
		ctxCwd,
		getFlag: () => false,
		notify,
		dbg,
		log: () => {},
		runtime,
		metricsClient: { reset: () => {} },
		cacheManager: { writeCache: () => {}, readCache: () => null },
		todoScanner: { scanDirectory: () => ({ items: [] }) },
		astGrepClient: {
			isAvailable: () => false,
			ensureAvailable: async () => false,
			scanExports: async () => new Map(),
		},
		biomeClient: {
			isAvailable: () => false,
			ensureAvailable: async () => false,
		},
		ruffClient: {
			isAvailable: () => false,
			ensureAvailable: async () => false,
		},
		knipClient: {
			isAvailable: () => false,
			ensureAvailable: async () => false,
		},
		jscpdClient: {
			isAvailable: () => false,
			ensureAvailable: async () => false,
		},
		depChecker: {
			isAvailable: () => false,
			ensureAvailable: async () => false,
		},
		testRunnerClient: {
			detectRunner: () => null,
			runTestFile: () => ({ failed: 0, error: false }),
		},
		goClient: { isGoAvailableAsync: async () => false },
		rustClient: { isAvailableAsync: async () => false },
		ensureTool: vi.fn(async () => null),
		cleanStaleTsBuildInfo: () => [],
		resetDispatchBaselines: () => {},
		resetLSPService: () => {},
	}) as any;
}

function warmSkipLines<T extends { msg: string }>(
	notifications: ReadonlyArray<T>,
): T[] {
	return notifications.filter((n) => n.msg.includes(WARM_SKIP_LINE));
}

function writeSourceFiles(cwd: string, count: number): void {
	fs.mkdirSync(path.join(cwd, ".git"), { recursive: true });
	for (let i = 0; i < count; i++) {
		fs.writeFileSync(
			path.join(cwd, `file-${i}.ts`),
			"export const value = 1;\n",
		);
	}
}

/**
 * The process's first interactive session: quick mode with the deferred
 * warmup armed. Returns a restore for the env and globals it moved.
 */
function armFirstQuickSession(): () => void {
	const processGlobals = globalThis as typeof globalThis & {
		__piLensFirstSessionDone?: boolean;
		__piLensWarmupScheduled?: boolean;
	};
	const previousDelay = process.env.PI_LENS_WARMUP_DELAY_MS;
	delete process.env.PI_LENS_STARTUP_MODE;
	process.env.PI_LENS_WARMUP_DELAY_MS = "0";
	delete processGlobals.__piLensFirstSessionDone;
	delete processGlobals.__piLensWarmupScheduled;
	return () => {
		if (previousDelay === undefined) delete process.env.PI_LENS_WARMUP_DELAY_MS;
		else process.env.PI_LENS_WARMUP_DELAY_MS = previousDelay;
	};
}

/** The warmup's own debug line right before it reports the size skip. */
const warmupReachedSkip = (dbg: ReadonlyArray<string>) =>
	dbg.some((m) => m.includes("warmup: skipping language-profile"));

describe("warm-pipeline size-skip notify (#775)", () => {
	let restoreStartupMode: () => void;
	let previousDataDir: string | undefined;

	const cleanupWarmSkipNotifyTemps = async () => {
		await cleanupTestEnvironmentsDrained("pi-lens-warm-skip-notify-", {
			beforeDrain: waitForProjectSnapshotPersistsForTests,
		});
	};

	afterEach(cleanupWarmSkipNotifyTemps);
	afterAll(cleanupWarmSkipNotifyTemps);

	beforeEach(() => {
		restoreStartupMode = setStartupMode("full");
		previousDataDir = process.env.PILENS_DATA_DIR;
	});

	afterEach(() => {
		restoreStartupMode();
		if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
		else process.env.PILENS_DATA_DIR = previousDataDir;
		if (scanSeam.actual)
			resolveStartupScanContextAsyncSpy.mockImplementation(scanSeam.actual);
	});

	it("fires the warm-skip notify once, naming the entry-budget override, for a too-many-entries verdict", async () => {
		const env = setupTestEnvironment("pi-lens-warm-skip-notify-entries-");
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const cwd = path.join(env.tmpDir, "project");
			fs.mkdirSync(path.join(cwd, ".git"), { recursive: true });
			const maxProjectFiles = getStartupScanMaxSourceFilesDerived(cwd);

			const seedRuntime = new RuntimeCoordinator();
			seedRuntime.seedProjectSequence(0);
			const seedSnapshot = buildProjectSnapshotFromRuntime({
				cwd,
				runtime: seedRuntime,
				startupScan: {
					cwd,
					scanRoot: cwd,
					projectRoot: cwd,
					canWarmCaches: false,
					reason: "too-many-entries",
					maxProjectFiles,
					maxScanEntries: getStartupScanMaxEntries(),
					computedAt: Date.now(),
				},
			});
			saveProjectSnapshot(cwd, seedSnapshot);

			const notifications: Array<{ msg: string; level: string }> = [];
			await handleSessionStart(
				makeDeps(cwd, (msg, level) => notifications.push({ msg, level })),
			);

			const warmSkipNotices = warmSkipLines(notifications);
			expect(warmSkipNotices).toHaveLength(1);
			expect(warmSkipNotices[0].level).toBe("warning");
			expect(warmSkipNotices[0].msg).toContain(
				`PI_LENS_STARTUP_SCAN_MAX_ENTRIES=<n> to override the ${getStartupScanMaxEntries()}-entry cap`,
			);
			expect(
				getDegradationSummary().find(
					(entry) => entry.kind === "startup-warm-skipped",
				)?.latestReasons[0]?.reason,
			).toBe(`too-many-entries; maxScanEntries=${getStartupScanMaxEntries()}`);
		} finally {
			env.cleanup();
		}
	});

	it("fires the warm-skip notify once for a too-many-source-files verdict and records its bound", async () => {
		const env = setupTestEnvironment("pi-lens-warm-skip-notify-files-");
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const cwd = path.join(env.tmpDir, "project");
			fs.mkdirSync(path.join(cwd, ".git"), { recursive: true });
			const maxProjectFiles = getStartupScanMaxSourceFilesDerived(cwd);

			const seedRuntime = new RuntimeCoordinator();
			seedRuntime.seedProjectSequence(0);
			const seedSnapshot = buildProjectSnapshotFromRuntime({
				cwd,
				runtime: seedRuntime,
				startupScan: {
					cwd,
					scanRoot: cwd,
					projectRoot: cwd,
					canWarmCaches: false,
					reason: "too-many-source-files",
					sourceFileCount: 5000,
					maxProjectFiles,
					maxScanEntries: getStartupScanMaxEntries(),
					computedAt: Date.now(),
				},
			});
			saveProjectSnapshot(cwd, seedSnapshot);

			const notifications: Array<{ msg: string; level: string }> = [];
			await handleSessionStart(
				makeDeps(cwd, (msg, level) => notifications.push({ msg, level })),
			);

			const warmSkipNotices = warmSkipLines(notifications);
			expect(warmSkipNotices).toHaveLength(1);
			expect(warmSkipNotices[0].msg).toContain(
				`maxProjectFiles in .pi-lens.json to override the ${maxProjectFiles}-source-file cap`,
			);
			expect(getDegradationSummary()).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						kind: "startup-warm-skipped",
						count: 1,
						latestReasons: [
							expect.objectContaining({
								reason: `too-many-source-files; maxProjectFiles=${maxProjectFiles}`,
							}),
						],
					}),
				]),
			);
		} finally {
			env.cleanup();
		}
	});

	it("shows a size skip on the default first quick session (#4126 F1)", async () => {
		const env = setupTestEnvironment("pi-lens-warm-skip-notify-quick-");
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		const restoreQuick = armFirstQuickSession();
		try {
			const cwd = path.join(env.tmpDir, "project");
			writeSourceFiles(cwd, getStartupScanMaxSourceFilesDerived(cwd) + 1);
			const notifications: Array<{ msg: string; level: string }> = [];
			await handleSessionStart(
				makeDeps(cwd, (msg, level) => notifications.push({ msg, level })),
			);
			// #4126 N4: the warmup exposes no awaitable; the wait is bounded.
			await waitFor(
				() => warmSkipLines(notifications),
				(lines) => lines.length > 0,
				{ timeoutMs: 4_000 },
			);
			expect(warmSkipLines(notifications)).toHaveLength(1);
			expect(getDegradationSummary()).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ kind: "startup-warm-skipped", count: 1 }),
				]),
			);
		} finally {
			restoreQuick();
			env.cleanup();
		}
	});

	// #4126 N1: session A (the process's first, quick) has its warmup in
	// flight when B (`/new`, a sequential replacement on the same coordinator)
	// starts. B's `resetForSession` supersedes A's scope, so A's deferred skip
	// must deliver nothing: the user sees one line, B's, and B's ledger holds
	// one record. Red when the `isCurrentSession` guard in
	// `notifyStartupWarmSkip` is removed: A's line lands after B's.
	it("delivers a superseded warmup's size skip to no one; the replacement session reports its own (#4126 N1)", async () => {
		const env = setupTestEnvironment("pi-lens-warm-skip-notify-superseded-");
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		const restoreQuick = armFirstQuickSession();
		const gate = suspendAt(resolveStartupScanContextAsyncSpy, scanSeam.actual);
		try {
			const cwd = path.join(env.tmpDir, "project");
			writeSourceFiles(cwd, getStartupScanMaxSourceFilesDerived(cwd) + 1);
			const runtime = new RuntimeCoordinator();
			const lines: Array<{ msg: string; level: string }> = [];
			const dbg: string[] = [];
			await handleSessionStart(
				makeDeps(
					cwd,
					(msg, level) => lines.push({ msg: `A:${msg}`, level }),
					runtime,
					(m) => dbg.push(m),
				),
			);
			// A's warmup has fired and is parked inside its scan.
			await gate.admitted;
			expect(warmSkipLines(lines)).toHaveLength(0);

			// B: every non-first start is full mode by default; pinned here.
			process.env.PI_LENS_STARTUP_MODE = "full";
			await handleSessionStart(
				makeDeps(
					cwd,
					(msg, level) => lines.push({ msg: `B:${msg}`, level }),
					runtime,
					(m) => dbg.push(m),
				),
			);
			expect(warmSkipLines(lines).map((n) => n.msg.slice(0, 2))).toEqual([
				"B:",
			]);

			gate.release();
			await gate.completed;
			await waitFor(() => dbg, warmupReachedSkip, { timeoutMs: 4_000 });

			expect(warmSkipLines(lines).map((n) => n.msg.slice(0, 2))).toEqual([
				"B:",
			]);
			expect(getDegradationSummary()).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ kind: "startup-warm-skipped", count: 1 }),
				]),
			);
		} finally {
			gate.restore();
			restoreQuick();
			env.cleanup();
		}
	});

	// #4126 N1, the other way a session stops being current: pi's
	// `session_shutdown` retires the coordinator's scope (`retireScope` in
	// index.ts) and no replacement starts. The scope id never moves, so a
	// plain generation compare would still publish through the dead session's
	// ctx; `isCurrentSession` sees the retirement. Red under either the head's
	// `sessionGeneration !==` compare or no guard at all.
	it("delivers nothing from a warmup whose session was shut down with no replacement (#4126 N1)", async () => {
		const env = setupTestEnvironment("pi-lens-warm-skip-notify-shutdown-");
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		const restoreQuick = armFirstQuickSession();
		const gate = suspendAt(resolveStartupScanContextAsyncSpy, scanSeam.actual);
		try {
			const cwd = path.join(env.tmpDir, "project");
			writeSourceFiles(cwd, getStartupScanMaxSourceFilesDerived(cwd) + 1);
			const runtime = new RuntimeCoordinator();
			const lines: Array<{ msg: string; level: string }> = [];
			const dbg: string[] = [];
			await handleSessionStart(
				makeDeps(
					cwd,
					(msg, level) => lines.push({ msg, level }),
					runtime,
					(m) => dbg.push(m),
				),
			);
			await gate.admitted;

			retireScope(runtime.sessionScope, "shutdown");

			gate.release();
			await gate.completed;
			await waitFor(() => dbg, warmupReachedSkip, { timeoutMs: 4_000 });

			expect(warmSkipLines(lines)).toHaveLength(0);
			expect(
				getDegradationSummary().some(
					(entry) => entry.kind === "startup-warm-skipped",
				),
			).toBe(false);
		} finally {
			gate.restore();
			restoreQuick();
			env.cleanup();
		}
	});

	// #4126 N2 (verify probe P5): session 1 skips at a 100-entry cap and tells
	// the user to raise PI_LENS_STARTUP_SCAN_MAX_ENTRIES. They do, and the next
	// process must re-walk under the raised cap and warm, instead of reusing
	// the stored verdict and repeating the hint. The memo reset stands in for
	// the new process's first env read.
	it("re-walks after PI_LENS_STARTUP_SCAN_MAX_ENTRIES is raised instead of reusing the stored too-many-entries verdict (#4126 N2)", async () => {
		const env = setupTestEnvironment("pi-lens-warm-skip-notify-raised-cap-");
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		const previousCap = process.env.PI_LENS_STARTUP_SCAN_MAX_ENTRIES;
		const previousSync = process.env.PI_LENS_SNAPSHOT_PERSIST_SYNC;
		try {
			// The first session's verdict must be on disk before the second
			// starts; the worker offload is covered by project-snapshot.test.ts.
			process.env.PI_LENS_SNAPSHOT_PERSIST_SYNC = "1";
			const cwd = path.join(env.tmpDir, "project");
			writeSourceFiles(cwd, 150);

			process.env.PI_LENS_STARTUP_SCAN_MAX_ENTRIES = "100";
			_resetStartupScanMaxEntriesForTests();
			const first: Array<{ msg: string; level: string }> = [];
			const firstDbg: string[] = [];
			await handleSessionStart(
				makeDeps(
					cwd,
					(msg, level) => first.push({ msg, level }),
					new RuntimeCoordinator(),
					(m) => firstDbg.push(m),
				),
			);
			expect(firstDbg).toContain("session_start scan-context source=computed");
			expect(warmSkipLines(first)).toHaveLength(1);
			expect(warmSkipLines(first)[0].msg).toContain(
				"PI_LENS_STARTUP_SCAN_MAX_ENTRIES=<n> to override the 100-entry cap",
			);
			expect(
				getDegradationSummary().find(
					(entry) => entry.kind === "startup-warm-skipped",
				)?.latestReasons[0]?.reason,
			).toBe("too-many-entries; maxScanEntries=100");

			process.env.PI_LENS_STARTUP_SCAN_MAX_ENTRIES = "100000";
			_resetStartupScanMaxEntriesForTests();
			const second: Array<{ msg: string; level: string }> = [];
			const secondDbg: string[] = [];
			await handleSessionStart(
				makeDeps(
					cwd,
					(msg, level) => second.push({ msg, level }),
					new RuntimeCoordinator(),
					(m) => secondDbg.push(m),
				),
			);
			expect(secondDbg).toContain("session_start scan-context source=computed");
			expect(warmSkipLines(second)).toHaveLength(0);
			expect(
				getDegradationSummary().some(
					(entry) => entry.kind === "startup-warm-skipped",
				),
			).toBe(false);
		} finally {
			if (previousCap === undefined)
				delete process.env.PI_LENS_STARTUP_SCAN_MAX_ENTRIES;
			else process.env.PI_LENS_STARTUP_SCAN_MAX_ENTRIES = previousCap;
			_resetStartupScanMaxEntriesForTests();
			if (previousSync === undefined)
				delete process.env.PI_LENS_SNAPSHOT_PERSIST_SYNC;
			else process.env.PI_LENS_SNAPSHOT_PERSIST_SYNC = previousSync;
			env.cleanup();
		}
	});

	it("shows the real session-start skip for a project above the safe startup-scan bound (#4126)", async () => {
		const env = setupTestEnvironment("pi-lens-warm-skip-notify-large-");
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const cwd = path.join(env.tmpDir, "project");
			fs.mkdirSync(path.join(cwd, ".git"), { recursive: true });
			fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
			for (let i = 0; i < getStartupScanMaxSourceFilesDerived(cwd) + 1; i++) {
				fs.writeFileSync(
					path.join(cwd, "src", `file-${i}.ts`),
					"export const value = 1;\n",
				);
			}
			const notifications: Array<{ msg: string; level: string }> = [];
			await handleSessionStart(
				makeDeps(cwd, (msg, level) => notifications.push({ msg, level })),
			);
			const warmSkip = warmSkipLines(notifications);
			expect(warmSkip).toHaveLength(1);
			expect(warmSkip[0].msg).toContain("maxProjectFiles");
			expect(
				getDegradationSummary().some(
					(entry) => entry.kind === "startup-warm-skipped",
				),
			).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("never fires the warm-skip notify for a small project that warms normally", async () => {
		const env = setupTestEnvironment("pi-lens-warm-skip-notify-small-");
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			fs.mkdirSync(path.join(env.tmpDir, "project", ".git"), {
				recursive: true,
			});
			const cwd = path.join(env.tmpDir, "project");
			createTempFile(env.tmpDir, "project/index.ts", "export const x = 1;\n");

			const notifications: Array<{ msg: string; level: string }> = [];
			await handleSessionStart(
				makeDeps(cwd, (msg, level) => notifications.push({ msg, level })),
			);

			expect(warmSkipLines(notifications)).toHaveLength(0);
		} finally {
			env.cleanup();
		}
	});
});
