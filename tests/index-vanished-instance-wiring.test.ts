import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import extension from "../index.js";
import { getGlobalPiLensDir } from "../clients/file-utils.js";
import { _resetSessionLifecycleForTests } from "../clients/session-lifecycle.js";
import { createPiMock, makeCtx } from "./support/pi-mock.js";
import { removeTempDirSync } from "./clients/test-utils.js";

/**
 * End-to-end wiring guard for the #1123 item 2 vanished-instance marker: a
 * REAL session_start (registerInstance/sweepOrphans path untouched) against a
 * registry file seeded with a dead-pid entry must log the marker line BEFORE
 * sweepOrphans prunes that same entry — the two must not race the other way,
 * or the vanished set would already be empty by the time the marker runs.
 *
 * `logSessionStart` is spied (not the real writer, which no-ops under
 * `isTestMode()` — see clients/sessionstart-logger.ts) so the exact line is
 * observable without depending on real sessionstart.log I/O.
 *
 * Two mechanisms make the assertions below deterministic. Both are stated
 * here because #3042 is what a WRONG version of this paragraph cost:
 *
 * 1. LIVENESS. `process.kill(pid, 0)` is the ONE liveness seam this path
 *    uses — `clients/instance-reaper.ts`'s `realIsPidAlive` is the single
 *    liveness function, and both consumers reached from session_start take
 *    it (`logVanishedInstances`'s default argument, and
 *    `decideOrphanReaping`'s). The OS process-table queries in that file
 *    (`queryCommandLines`/`findPidsByMarkerWindows`) only ever run over a
 *    registry entry's recorded `lspChildren`, and the fixture below records
 *    none. So spying `process.kill` genuinely settles the synthetic pid's
 *    liveness on every path the sweep takes, whatever the runner's process
 *    table says about that number.
 *
 * 2. THE REGISTRY FILE. Since #2912 `PI_LENS_HOME` lived at
 *    `<repo>/.probe-home` for the whole vitest run, so `instances.json` and
 *    its `.lock` were shared by every test file running concurrently; since
 *    #3721 each worker has its own home (`<run-shared home>/worker-home-<run>-
 *    <pid>`), so concurrent forks no longer share either file. The reaper's
 *    prune is still best-effort: it gives up after `withInstanceRegistryLock`'s
 *    500 ms deadline and returns "could-not-acquire", which `instance-reaper.ts`
 *    discards. #3042 reproduced that with `PRUNE-RESULT could-not-acquire`
 *    under eight concurrent holders. Each case below still runs against its
 *    OWN `PI_LENS_HOME`: a late write from the previous case must not land in
 *    this one's registry, and the per-case home keeps this fixture from
 *    clobbering the worker registry its sibling files use.
 */

vi.mock("../clients/bootstrap.js", async () => {
	const { bootstrapSeamMock } = await import("./support/bootstrap-mock.js");
	return bootstrapSeamMock(async () => ({
		metricsClient: { reset: () => {} },
		todoScanner: {},
		biomeClient: { isAvailable: () => false },
		ruffClient: { isAvailable: () => false },
		knipClient: {
			isAvailable: () => false,
			analyze: async () => ({
				success: false,
				summary: "unavailable",
				issues: [],
			}),
		},
		jscpdClient: { isAvailable: () => false },
		depChecker: { isAvailable: () => false },
		testRunnerClient: { detectRunner: () => null },
		goClient: { isGoAvailableAsync: async () => false },
		rustClient: { isAvailableAsync: async () => false },
		agentBehaviorClient: { recordToolCall: () => {}, formatWarnings: () => "" },
		complexityClient: { isSupportedFile: () => false, analyzeFile: () => null },
	}));
});
vi.mock("../clients/runtime-session.js", () => ({
	handleSessionStart: async () => {},
}));

const { logSessionStartSpy } = vi.hoisted(() => ({
	logSessionStartSpy: vi.fn(),
}));
vi.mock("../clients/sessionstart-logger.js", async (importActual) => {
	const actual =
		await importActual<typeof import("../clients/sessionstart-logger.js")>();
	return {
		...actual,
		logSessionStart: (msg: string) => logSessionStartSpy(msg),
	};
});

// #2512: the session_start handler kicks off registerInstance/
// logVanishedInstances/sweepOrphans fire-and-forget (session_start must not
// block on registry I/O — see index.ts's own comment at the call site) and
// this test used to bridge the gap with a fixed 50ms sleep, hoping the real
// fs read-modify-write chain landed by then. Under shared-slot contention
// (#2509 round 4's 47-file batch) it sometimes did not, and the assertions
// below raced ahead of the write. `sweepOrphans` is the LAST step of that
// chain (index.ts's `.finally(() => { void sweepOrphans(); })`), so wrapping
// it to notify a listener after it settles gives an exact, awaitable signal
// for "the whole chain has landed" instead of a wall-clock guess — the same
// shape as instance-registry.ts's own `_settleRegistryMutationsForTests`,
// just for the reaper's independent (non-tail-queued) prune write.
const { onSweepOrphansSettled, notifySweepOrphansSettled } = vi.hoisted(() => {
	const listeners = new Set<() => void>();
	return {
		onSweepOrphansSettled: (cb: () => void): (() => void) => {
			listeners.add(cb);
			return () => listeners.delete(cb);
		},
		notifySweepOrphansSettled: () => {
			for (const cb of listeners) cb();
		},
	};
});
vi.mock("../clients/instance-reaper.js", async (importActual) => {
	const actual =
		await importActual<typeof import("../clients/instance-reaper.js")>();
	return {
		...actual,
		sweepOrphans: async (): Promise<void> => {
			try {
				await actual.sweepOrphans();
			} finally {
				notifySweepOrphansSettled();
			}
		},
	};
});

/** Resolves the NEXT time the wrapped `sweepOrphans` above completes. Must be
 * called (to register the listener) BEFORE the action that triggers it, so
 * the completion can never be missed racing the listener's own registration. */
function waitForSweepOrphansSettled(): Promise<void> {
	return new Promise((resolve) => {
		const unsubscribe = onSweepOrphansSettled(() => {
			unsubscribe();
			resolve();
		});
	});
}

/** The registry file the PRODUCTION resolver picks, not a paraphrase of it —
 *  `clients/instance-registry.ts` spells this exact join. */
function registryFilePath(): string {
	return path.join(getGlobalPiLensDir(), "instances.json");
}

/** `projectRoot` values recorded in the registry under `home`. An absent or
 *  unreadable file means "nothing recorded" — a concurrent fork is always
 *  mid-rename somewhere in the run-shared one. */
function projectRootsInRegistryUnder(home: string): string[] {
	try {
		const raw = JSON.parse(
			fs.readFileSync(path.join(home, "instances.json"), "utf-8"),
		);
		return (raw.instances as { projectRoot: string }[]).map(
			(entry) => entry.projectRoot,
		);
	} catch {
		return [];
	}
}

/** The run-shared home vitest-setup pins for every worker, captured before
 *  any per-case override below replaces it. */
const runSharedHome = process.env.PI_LENS_HOME as string;

describe("index session_start vanished-instance wiring (#1123 item 2)", () => {
	let tmp: string;
	let prevDataDir: string | undefined;
	let prevHome: string | undefined;
	let caseHome: string;
	let caseIndex = 0;

	beforeEach(() => {
		logSessionStartSpy.mockClear();
		// The #473 concurrent-session guard's classifier state is process-module-
		// scope (by design — it detects an in-process subagent bind sharing the
		// SAME module instance as its parent). Reset it so each test's
		// session_start is classified "primary", not a false "concurrent-
		// secondary" left over from a previous test's ctx in this same file.
		_resetSessionLifecycleForTests();
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-vanished-wiring-"));
		prevDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(tmp, "data");
		// #3042, mechanism 2 in the module docstring: a registry this case
		// owns outright. A FRESH directory per case, not per file — the
		// session_start chain is fire-and-forget, so a late write from the
		// previous case must not be able to land in this one's registry
		// either. Same shape as tests/index-multi-root-session-start.test.ts,
		// which pins its own home under `.probe-home` for the same reason.
		prevHome = process.env.PI_LENS_HOME;
		caseHome = path.join(
			process.cwd(),
			".probe-home",
			"index-vanished-instance-wiring",
			String(++caseIndex),
		);
		removeTempDirSync(caseHome);
		fs.mkdirSync(caseHome, { recursive: true });
		process.env.PI_LENS_HOME = caseHome;
	});

	afterEach(() => {
		if (prevDataDir === undefined) delete process.env.PILENS_DATA_DIR;
		else process.env.PILENS_DATA_DIR = prevDataDir;
		if (prevHome === undefined) delete process.env.PI_LENS_HOME;
		else process.env.PI_LENS_HOME = prevHome;
		removeTempDirSync(caseHome);
		removeTempDirSync(tmp);
		vi.restoreAllMocks();
		vi.clearAllMocks();
	});

	it("logs the marker for a dead-pid registry entry, then the reaper still prunes it", async () => {
		const deadPid = process.pid + 100_000;
		const realProcessKill = process.kill.bind(process);
		vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
			if (pid === deadPid && signal === 0) {
				throw Object.assign(new Error("synthetic dead pid"), { code: "ESRCH" });
			}
			return realProcessKill(pid, signal);
		});
		fs.writeFileSync(
			registryFilePath(),
			JSON.stringify({
				instances: [
					{
						pid: deadPid,
						startedAt: "2026-08-06T20:00:00.000Z",
						projectRoot: "/dead-project",
						rssBytes: 512 * 1024 * 1024,
						heartbeatAt: "2026-08-06T22:30:00.000Z",
						lspChildCount: 0,
						lspChildren: [],
					},
				],
			}),
			"utf-8",
		);
		// #3042 guard — the recurrence: this seed used to land in the
		// run-shared `<repo>/.probe-home/instances.json`, the one file every
		// other concurrently-running fork registers into. That made the prune
		// below race sibling forks for a 500 ms lock deadline it silently
		// loses ("could-not-acquire", dropped by instance-reaper.ts), and
		// blew away their entries on the way in — the seed takes no lock.
		// `/dead-project` is this fixture's own sentinel root: no real
		// instance can record it, so finding it in the run-shared registry
		// means the per-case `PI_LENS_HOME` above stopped applying.
		expect(projectRootsInRegistryUnder(runSharedHome)).not.toContain(
			"/dead-project",
		);

		const pi = createPiMock();
		extension(pi.asExtensionAPI());
		// Registered BEFORE emit so the settle notification can never fire
		// before this listener exists to catch it.
		const settled = waitForSweepOrphansSettled();
		await pi.emit("session_start", {}, makeCtx({ cwd: tmp }));
		// registerInstance/logVanishedInstances/sweepOrphans are fire-and-forget
		// (session_start must not block on registry I/O); sweepOrphans is the
		// LAST step of that chain, so awaiting its settle signal proves the
		// marker log (which runs strictly before it) has already landed too.
		await settled;

		// logSessionStart (via dbg()) also carries plenty of other session_start
		// trace lines — isolate the marker line specifically.
		const markerLines = logSessionStartSpy.mock.calls
			.map((call) => call[0] as string)
			.filter((line) => line.includes("previous instance pid"));
		expect(markerLines).toHaveLength(1);
		const line = markerLines[0];
		expect(line).toContain(`previous instance pid ${deadPid}`);
		expect(line).toContain("2026-08-06T22:30:00.000Z");
		expect(line).toContain("512MB");
		expect(line).toContain("exited without shutdown");

		// The reaper's own dead-pid prune still ran afterward — the marker read
		// must not have swallowed or blocked it.
		const raw = JSON.parse(fs.readFileSync(registryFilePath(), "utf-8"));
		expect(raw.instances.map((i: { pid: number }) => i.pid)).not.toContain(
			deadPid,
		);
	});

	it("logs nothing when the registry has no dead entries", async () => {
		const pi = createPiMock();
		extension(pi.asExtensionAPI());
		const settled = waitForSweepOrphansSettled();
		await pi.emit("session_start", {}, makeCtx({ cwd: tmp }));
		await settled;

		const markerLines = logSessionStartSpy.mock.calls
			.map((call) => call[0] as string)
			.filter((line) => line.includes("previous instance pid"));
		expect(markerLines).toHaveLength(0);
	});
});
