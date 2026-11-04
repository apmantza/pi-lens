/**
 * Every "is this recorded pid still running" question answers through
 * `realIsPidAlive` (`clients/pid-liveness.ts`), the one `process.kill(pid, 0)`
 * check. Four modules kept a copy of it: the turn-state owner check, the
 * generation lock, the bounded pid-file lock, and the install lock (the last
 * one has its cell in `installer/install-lock.test.ts`, where the installer's
 * home pin lives).
 *
 * Recurrence this prevents: the turn-state copy read EPERM as "dead", so a
 * live worklist owned by a process the caller may not signal (another user, an
 * elevated Windows process) was handed to the next writer as `available`; the
 * seam reads EPERM as alive. Each cell below drives a former copy through its
 * production caller with `process.kill` answering a sentinel pid, so a change
 * to the seam's EPERM or ESRCH reading reds every former copy at once.
 *
 * `process.kill` is the OS boundary: the double answers only the sentinel pid
 * with signal 0 and passes everything else through.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	acquireBoundedPidFileLock,
	acquireQuarantinePidFileLock,
} from "../../clients/bounded-pid-file-lock.js";
import { CacheManager } from "../../clients/cache-manager.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { getProjectDataDir } from "../../clients/file-utils.js";
import { pidFileIsStale } from "../../clients/generation-lock.js";
import { realIsPidAlive } from "../../clients/pid-liveness.js";
import { setupTestEnvironment } from "./test-utils.js";

/** Below Linux's pid_max, so it is a valid pid Node would hand to the kernel. */
const SENTINEL_PID = 4_000_001;

const realKill = process.kill.bind(process);

function sentinelAnswers(code: "EPERM" | "ESRCH"): void {
	vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
		if (pid === SENTINEL_PID && signal === 0) {
			throw Object.assign(new Error(`kill ${code}`), { code });
		}
		return realKill(pid, signal as NodeJS.Signals | number);
	});
}

let env: { tmpDir: string; cleanup: () => void };

beforeEach(() => {
	env = setupTestEnvironment("pi-lens-pid-liveness-seam-");
});

afterEach(() => {
	resetDegradationLedger();
	vi.restoreAllMocks();
	env.cleanup();
});

describe("realIsPidAlive", () => {
	it.each([
		["EPERM", true],
		["ESRCH", false],
	] as const)("reads %s as alive=%s", (code, alive) => {
		sentinelAnswers(code);
		expect(realIsPidAlive(SENTINEL_PID)).toBe(alive);
	});
});

describe("realIsPidAlive on a pid Node refuses to signal", () => {
	// A pid above 2^31-1 makes `process.kill` throw ERR_INVALID_ARG_TYPE, which
	// is not ESRCH: it reads alive, and the read is recorded once per code so
	// the ambiguous verdict is visible (the three lock copies read it dead).
	it("reads it alive and records pid-liveness-unprobeable once per code", () => {
		expect(realIsPidAlive(3_000_000_000)).toBe(true);
		expect(realIsPidAlive(3_000_000_001)).toBe(true);
		const group = getDegradationSummary().find(
			(g) => g.kind === "pid-liveness-unprobeable",
		);
		expect(group?.count).toBe(1);
		expect(group?.latestReasons[0]?.subject).toBe("ERR_INVALID_ARG_TYPE");
	});

	it("records nothing for EPERM, an ordinary answer", () => {
		sentinelAnswers("EPERM");
		expect(realIsPidAlive(SENTINEL_PID)).toBe(true);
		expect(
			getDegradationSummary().some(
				(g) => g.kind === "pid-liveness-unprobeable",
			),
		).toBe(false);
	});
});

describe("turn-state owner liveness", () => {
	function persistForeignWorklist(): void {
		const dir = getProjectDataDir(env.tmpDir);
		fs.mkdirSync(dir, { recursive: true });
		const lastEdit = new Date().toISOString();
		fs.writeFileSync(
			path.join(dir, "turn-state.json"),
			JSON.stringify({
				files: {
					"src/a.ts": {
						modifiedRanges: [{ start: 1, end: 3 }],
						importsChanged: false,
						lastEdit,
					},
				},
				turnCycles: 0,
				maxCycles: 3,
				lastUpdated: lastEdit,
				sessionId: "lens-other",
				owner: {
					kind: "pi",
					id: "lens-other",
					pid: SENTINEL_PID,
					lastSeen: lastEdit,
				},
			}),
		);
	}

	it("keeps a worklist whose owner pid answers EPERM away from the next writer", () => {
		persistForeignWorklist();
		sentinelAnswers("EPERM");
		expect(
			new CacheManager(false).getTurnStateAccess(env.tmpDir, {
				kind: "pi",
				id: "lens-next",
			}),
		).toBe("foreign-live");
	});

	it("hands a worklist whose owner pid is gone (ESRCH) to the next writer", () => {
		persistForeignWorklist();
		sentinelAnswers("ESRCH");
		expect(
			new CacheManager(false).getTurnStateAccess(env.tmpDir, {
				kind: "pi",
				id: "lens-next",
			}),
		).toBe("available");
	});
});

describe("generation-lock pid file staleness", () => {
	function pidFile(): string {
		const file = path.join(env.tmpDir, "holder.pid");
		fs.writeFileSync(file, `${SENTINEL_PID} ${Date.now()}\n`);
		return file;
	}

	it.each([
		["EPERM", false],
		["ESRCH", true],
	] as const)(
		"a pid file whose owner answers %s is stale=%s",
		(code, stale) => {
			const file = pidFile();
			sentinelAnswers(code);
			expect(pidFileIsStale(file, 3_600_000)).toBe(stale);
		},
	);
});

describe("bounded pid-file lock owner liveness", () => {
	it("a pre-generation lock file owned by an EPERM pid still holds contenders out", () => {
		const lockPath = path.join(env.tmpDir, "plain.lock");
		fs.writeFileSync(lockPath, `${SENTINEL_PID}:${Date.now()}:tok`, "utf8");
		sentinelAnswers("EPERM");
		const logContention = vi.fn();
		const release = acquireBoundedPidFileLock(lockPath, {
			waitMs: 40,
			retryMs: 5,
			timeoutMessage: "eperm owner timed out",
			onContention: "skip-log",
			logContention,
		});
		expect(release).toBeNull();
		expect(logContention).toHaveBeenCalledOnce();
		expect(fs.existsSync(lockPath)).toBe(true);
	});

	it("a pre-generation lock file owned by an ESRCH pid is reclaimed", () => {
		const lockPath = path.join(env.tmpDir, "plain.lock");
		fs.writeFileSync(lockPath, `${SENTINEL_PID}:${Date.now()}:tok`, "utf8");
		sentinelAnswers("ESRCH");
		const release = acquireBoundedPidFileLock(lockPath, {
			waitMs: 200,
			retryMs: 5,
			timeoutMessage: "esrch owner timed out",
		});
		expect(typeof release).toBe("function");
		release();
	});

	function quarantineLock(): string {
		const lockPath = path.join(
			fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-liveness-q-")),
			"state.lock",
		);
		fs.mkdirSync(lockPath, { recursive: true });
		fs.writeFileSync(
			path.join(lockPath, "owner.json"),
			JSON.stringify({ pid: SENTINEL_PID, createdAt: Date.now(), token: "t" }),
			"utf8",
		);
		return lockPath;
	}

	it("a quarantine lock whose owner answers EPERM is not reclaimed", async () => {
		const lockPath = quarantineLock();
		try {
			sentinelAnswers("EPERM");
			const logContention = vi.fn();
			const release = await acquireQuarantinePidFileLock(lockPath, {
				waitMs: 40,
				retryMs: 5,
				staleMs: 3_600_000,
				timeoutMessage: "eperm quarantine timed out",
				onContention: "skip-log",
				logContention,
			});
			expect(release).toBeNull();
			expect(fs.existsSync(path.join(lockPath, "owner.json"))).toBe(true);
		} finally {
			fs.rmSync(path.dirname(lockPath), { recursive: true, force: true });
		}
	});

	it("a quarantine lock whose owner answers ESRCH is reclaimed", async () => {
		const lockPath = quarantineLock();
		try {
			sentinelAnswers("ESRCH");
			const release = await acquireQuarantinePidFileLock(lockPath, {
				waitMs: 300,
				retryMs: 5,
				staleMs: 3_600_000,
				timeoutMessage: "esrch quarantine timed out",
			});
			expect(typeof release).toBe("function");
			await release?.();
		} finally {
			fs.rmSync(path.dirname(lockPath), { recursive: true, force: true });
		}
	});
});
