/**
 * #1857 — the registry-independent orphan backstop.
 *
 * Four defects, one sweep:
 *
 * 1. `killedCount++` ran unconditionally after a `killPidTree` that returned
 *    no success signal, so `killed: 4` could mean four failures.
 * 2. The only record was a `{scanned, killed}` count emitted on the reaped
 *    path — "ran and found nothing", "never ran", and "threw" were the same
 *    absence.
 * 3. Nothing named WHICH process was killed.
 * 4. A name-matching process spawned seconds ago but not yet registered was
 *    kill-eligible the moment its parent shim looked dead.
 *
 * Plus the cost defect the issue opened on: a 9344ms OS-process enumeration
 * on the session_start critical path, with no timeout and no cooldown.
 *
 * `node:child_process`, the instance registry, and the latency logger are
 * mocked, so the sweep runs on Linux CI and on Windows without touching the
 * real OS process table. Platform-shaped assertions are made against the
 * MOCK's recorded argv, never against `process.platform` behavior.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface SpawnRecord {
	command: string;
	args: string[];
}

const h = vi.hoisted(() => {
	const spawns: SpawnRecord[] = [];
	const latency: Array<Record<string, unknown>> = [];
	const state: {
		registry: unknown[];
		enabled: boolean;
		/** stdout the enumeration child emits, per platform-agnostic mock. */
		stdout: string;
		/** when set, the child emits `error` instead of `close`. */
		spawnError: boolean;
		/** when set, the child never settles (exercises the scan timeout). */
		hang: boolean;
		/** pids the fake `process.kill(pid, 0)` probe reports as alive. */
		alivePids: Set<number>;
		/** pids handed to every enumeration ("scanner") child spawned. */
		scannerPids: number[];
		/** pids that received a bare `child.kill()` rather than a tree kill. */
		bareKills: number[];
	} = {
		registry: [],
		enabled: true,
		stdout: "",
		spawnError: false,
		hang: false,
		alivePids: new Set<number>(),
		scannerPids: [],
		bareKills: [],
	};
	let nextPid = 90_000;
	function makeFakeChild(command: string, args: string[]) {
		spawns.push({ command, args });
		const stdout = {
			handlers: [] as Array<(chunk: string) => void>,
			on(_event: string, cb: (chunk: string) => void) {
				stdout.handlers.push(cb);
				return stdout;
			},
			unref() {},
		};
		const isEnumeration = !command.toLowerCase().includes("taskkill");
		const pid = nextPid++;
		if (isEnumeration) state.scannerPids.push(pid);
		const child = {
			pid,
			stdout,
			stderr: null,
			stdin: null,
			unref() {},
			kill() {
				state.bareKills.push(pid);
			},
			on() {
				return child;
			},
			once(event: string, cb: (...a: unknown[]) => void) {
				if (isEnumeration && state.hang) return child;
				if (event === "error" && isEnumeration && state.spawnError) {
					setImmediate(() => cb(new Error("spawn failed")));
				}
				if (event === "close" && !(isEnumeration && state.spawnError)) {
					setImmediate(() => {
						if (isEnumeration && state.stdout) {
							for (const handler of stdout.handlers) handler(state.stdout);
						}
						// Match Node's ChildProcess "close" contract exactly. Omitting the
						// second argument turns a successful exit into an exit-error under
						// the production classifier (`undefined !== null`).
						cb(0, null);
					});
				}
				return child;
			},
		};
		return child;
	}
	return { spawns, latency, state, makeFakeChild };
});

vi.mock("node:child_process", () => ({
	spawn: vi.fn((command: string, args: string[]) =>
		h.makeFakeChild(command, args),
	),
}));

vi.mock("../../clients/instance-registry.js", () => ({
	isInstanceRegistryEnabled: () => h.state.enabled,
	readInstanceRegistry: async () => h.state.registry,
}));

vi.mock("../../clients/latency-logger.js", () => ({
	logLatency: (entry: Record<string, unknown>) => {
		h.latency.push(entry);
	},
}));

import {
	BACKSTOP_SPAWN_GRACE_MS,
	MANAGED_BINARY_NAMES,
	MANAGED_IMAGE_NAMES,
	type OsProcessInfo,
	partitionBackstopCandidates,
	scheduleUntrackedOrphanSweep,
	sweepUntrackedOrphans as sweepUntrackedOrphansImpl,
} from "../../clients/instance-reaper.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";

const isWindows = process.platform === "win32";

/** One enumeration output row in the shape the host platform's parser reads.
 *  Both branches are exercised on both platforms via the row builder, so the
 *  test asserts the sweep's BEHAVIOR, not the host's OS. */
function enumerationRow(proc: {
	pid: number;
	parentPid: number;
	ageMs: number | undefined;
	command: string;
}): string {
	if (isWindows) {
		// The age column PowerShell computes: a millisecond count, or an empty
		// field when `CreationDate` was not a usable datetime.
		const age = proc.ageMs === undefined ? "" : String(proc.ageMs);
		return `${proc.pid}\t${proc.parentPid}\t${age}\t${proc.command}`;
	}
	const etime =
		proc.ageMs === undefined
			? "-"
			: (() => {
					const total = Math.floor(proc.ageMs / 1000);
					const mm = String(Math.floor(total / 60)).padStart(2, "0");
					const ss = String(total % 60).padStart(2, "0");
					return `${mm}:${ss}`;
				})();
	return `  ${proc.pid} ${proc.parentPid} ${etime} ${proc.command}`;
}

function reasonsFor(kind: string): Array<{ subject: string; reason: string }> {
	return (
		getDegradationSummary().find((g) => g.kind === kind)?.latestReasons ?? []
	);
}

// #2669: a sweep that spares a candidate on the grace arms a follow-up sweep
// on a real timer (as little as a few ms — tests pin `graceRetryDelayMs`).
// That retry appends its OWN `orphan_backstop_reaped` row asynchronously,
// with no `graceRetryInMs` (it always runs with `allowGraceRetry: false`).
// Reading "the LAST such row" is therefore reading the wrong sweep's
// metadata whenever the assertion runs late enough for that timer to have
// already fired — a real race on loaded CI runners, not a test order
// dependency. `sweepIndex` is the watermark taken right before the most
// recently INVOKED sweep, so the lookup always resolves to the row THAT
// sweep logged (the first `orphan_backstop_reaped` row at or after the
// watermark), never a later retry's.
let sweepIndex = 0;

function sweepUntrackedOrphans(
	...args: Parameters<typeof sweepUntrackedOrphansImpl>
): ReturnType<typeof sweepUntrackedOrphansImpl> {
	sweepIndex = h.latency.length;
	return sweepUntrackedOrphansImpl(...args);
}

function lastBackstopRecord(
	startIndex = sweepIndex,
): Record<string, unknown> | undefined {
	return h.latency
		.slice(startIndex)
		.find((entry) => entry.phase === "orphan_backstop_reaped");
}

function backstopMetadataForSweep(startIndex: number): Record<string, unknown> {
	return (lastBackstopRecord(startIndex)?.metadata ?? {}) as Record<
		string,
		unknown
	>;
}

function backstopMetadata(): Record<string, unknown> {
	return backstopMetadataForSweep(sweepIndex);
}

const ORPHAN_COMMAND = isWindows
	? "C:\\tools\\opengrep.exe --lsp"
	: "/opt/tools/opengrep --lsp";

/** Sweep options that keep every test fast and hermetic: no cooldown, and a
 *  kill-verification budget of one immediate probe. */
const FAST = { force: true, verifyAttempts: 1, verifyIntervalMs: 0 } as const;

beforeEach(() => {
	h.spawns.length = 0;
	h.latency.length = 0;
	sweepIndex = 0;
	h.state.registry = [];
	h.state.enabled = true;
	h.state.stdout = "";
	h.state.spawnError = false;
	h.state.hang = false;
	h.state.alivePids = new Set<number>();
	h.state.scannerPids.length = 0;
	h.state.bareKills.length = 0;
	// Each test gets a fresh cooldown stamp and sweep lock. PI_LENS_HOME is
	// redirected per worker (tests/support/vitest-setup.ts), so this only ever
	// touches the worker's own temp dir.
	fs.rmSync(path.join(process.env.PI_LENS_HOME ?? "", "orphan-backstop.json"), {
		force: true,
	});
	fs.rmSync(path.join(process.env.PI_LENS_HOME ?? "", "orphan-backstop.lock"), {
		recursive: true,
		force: true,
	});
	resetDegradationLedger();
	vi.spyOn(process, "kill").mockImplementation(((pid: number) => {
		if (h.state.alivePids.has(Math.abs(pid))) return true;
		const err = new Error("no such process") as NodeJS.ErrnoException;
		err.code = "ESRCH";
		throw err;
	}) as unknown as typeof process.kill);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("#1857 item 1+3: kill accounting is verified and carries identity", () => {
	it("counts a SURVIVING process as unverified, not as a kill, and names it", async () => {
		h.state.stdout = enumerationRow({
			pid: 5000,
			parentPid: 4000,
			ageMs: 10 * 60 * 1000,
			command: ORPHAN_COMMAND,
		});
		// The orphan survives the kill; its dead parent (4000) stays dead.
		h.state.alivePids = new Set([5000]);

		const outcome = await sweepUntrackedOrphans(FAST);

		// #1864 review F4: this test previously asserted "reaped" for a sweep
		// that verified NOTHING — the accounting defect this PR exists to fix,
		// reproduced one level up at the health-check surface.
		expect(outcome).toBe("unverified");
		const metadata = backstopMetadata();
		// Pre-fix this was `killed: 1` — the attempt was the count.
		expect(metadata.killed).toBe(0);
		expect(metadata.killUnverified).toBe(1);
		expect(metadata.unverifiedProcesses).toEqual(["opengrep#5000"]);

		const reasons = reasonsFor("orphan-backstop-kill-unverified");
		expect(reasons).toHaveLength(1);
		expect(reasons[0].subject).toBe("opengrep#5000");
	});

	it("counts a process that is GONE afterwards as a verified kill, with identity", async () => {
		h.state.stdout = enumerationRow({
			pid: 5000,
			parentPid: 4000,
			ageMs: 10 * 60 * 1000,
			command: ORPHAN_COMMAND,
		});
		// Nothing alive: the orphan is gone after the kill attempt.

		const outcome = await sweepUntrackedOrphans(FAST);

		expect(outcome).toBe("reaped");
		const metadata = backstopMetadata();
		expect(metadata.killed).toBe(1);
		expect(metadata.killUnverified).toBe(0);
		// #1857 item 3: counts alone can never answer "which process?".
		expect(metadata.killedProcesses).toEqual(["opengrep#5000"]);
		expect(reasonsFor("orphan-backstop-kill-unverified")).toHaveLength(0);
	});

	it("records a repeatedly-unkillable process through the bounded ledger, not one entry per sweep", async () => {
		h.state.stdout = enumerationRow({
			pid: 5000,
			parentPid: 4000,
			ageMs: 10 * 60 * 1000,
			command: ORPHAN_COMMAND,
		});
		h.state.alivePids = new Set([5000]);

		await sweepUntrackedOrphans(FAST);
		await sweepUntrackedOrphans(FAST);
		await sweepUntrackedOrphans(FAST);

		const group = getDegradationSummary().find(
			(g) => g.kind === "orphan-backstop-kill-unverified",
		);
		expect(group?.count).toBe(3);
		// incrementDegradationCount keeps ONE retained entry per subject.
		expect(group?.latestReasons).toHaveLength(1);
		expect(group?.latestReasons[0].reason).toContain("count: 3");
	});
});

describe("#1864 review F4: the outcome discriminates verified from attempted", () => {
	function rowsFor(pids: number[]): string {
		return pids
			.map((pid) =>
				enumerationRow({
					pid,
					parentPid: 4000,
					ageMs: 10 * 60 * 1000,
					command: ORPHAN_COMMAND,
				}),
			)
			.join("\n");
	}

	it("all kills verified ⇒ reaped", async () => {
		h.state.stdout = rowsFor([5000, 5001]);

		expect(await sweepUntrackedOrphans(FAST)).toBe("reaped");
		expect(backstopMetadata().killed).toBe(2);
		expect(backstopMetadata().killUnverified).toBe(0);
	});

	it("some verified, some survivors ⇒ partial, never reaped", async () => {
		h.state.stdout = rowsFor([5000, 5001]);
		h.state.alivePids = new Set([5001]); // 5001 survives its kill

		expect(await sweepUntrackedOrphans(FAST)).toBe("partial");
		expect(backstopMetadata().killed).toBe(1);
		expect(backstopMetadata().killUnverified).toBe(1);
	});

	it("no kill verified ⇒ unverified, never reaped", async () => {
		h.state.stdout = rowsFor([5000, 5001]);
		h.state.alivePids = new Set([5000, 5001]);

		expect(await sweepUntrackedOrphans(FAST)).toBe("unverified");
		expect(backstopMetadata().killed).toBe(0);
		expect(backstopMetadata().killUnverified).toBe(2);
	});
});

describe("#1864 review F1: concurrent sweeps are mutually exclusive", () => {
	function lockDir(): string {
		return path.join(process.env.PI_LENS_HOME ?? "", "orphan-backstop.lock");
	}

	it("skips with outcome=concurrent while another live process holds the lock", async () => {
		// A lock owned by a LIVE pid (this process) is not stale, so it cannot
		// be reclaimed — exactly the state a mid-sweep peer leaves behind.
		fs.mkdirSync(lockDir(), { recursive: true });
		fs.writeFileSync(
			path.join(lockDir(), "owner.json"),
			JSON.stringify({
				pid: process.pid,
				createdAt: Date.now(),
				token: "peer-sweep",
			}),
		);
		h.state.alivePids = new Set([process.pid]);
		h.state.stdout = enumerationRow({
			pid: 5000,
			parentPid: 4000,
			ageMs: 10 * 60 * 1000,
			command: ORPHAN_COMMAND,
		});

		const outcome = await sweepUntrackedOrphans(FAST);

		expect(outcome).toBe("concurrent");
		// The whole point: the loser does no work at all.
		expect(h.spawns).toHaveLength(0);
	});

	it("two sweeps started together do not both scan", async () => {
		h.state.stdout = "";

		const [first, second] = await Promise.all([
			sweepUntrackedOrphans({ verifyAttempts: 1, verifyIntervalMs: 0 }),
			sweepUntrackedOrphans({ verifyAttempts: 1, verifyIntervalMs: 0 }),
		]);

		// One works, one is turned away — by the lock or by the winner's stamp.
		// Either way exactly one enumeration is paid for. Before the lock, both
		// read "no stamp", both wrote, and both scanned.
		expect(h.state.scannerPids).toHaveLength(1);
		expect([first, second].filter((o) => o === "clean")).toHaveLength(1);
		expect(
			[first, second].filter((o) => o === "concurrent" || o === "cooldown"),
		).toHaveLength(1);
	});

	it("releases the lock, so the next sweep is not locked out forever", async () => {
		h.state.stdout = "";
		await sweepUntrackedOrphans(FAST);

		expect(await sweepUntrackedOrphans(FAST)).toBe("clean");
		expect(h.state.scannerPids).toHaveLength(2);
	});
});

describe("#1864 review F2: a grace-spared candidate is re-examined", () => {
	const FRESH_ROW = () =>
		enumerationRow({
			pid: 5000,
			parentPid: 4000,
			ageMs: 890,
			command: ORPHAN_COMMAND,
		});

	it("arms one follow-up sweep when the grace spared a candidate", async () => {
		h.state.stdout = FRESH_ROW();

		const outcome = await sweepUntrackedOrphans({
			...FAST,
			graceRetryDelayMs: 5,
		});
		const directSweepStart = sweepIndex;

		expect(outcome).toBe("clean");

		// The retry actually runs, and it is NOT blocked by the stamp the first
		// sweep just wrote. Waiting for it here is also the #2669 regression:
		// by the time this resolves, the retry's own `orphan_backstop_reaped`
		// row (it never carries `graceRetryInMs`) is the newest row in the
		// log, so a metadata lookup keyed on "the last row" instead of "the
		// row THIS sweep call logged" deterministically reads the retry's
		// metadata instead of the direct call's.
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(h.state.scannerPids.length).toBeGreaterThanOrEqual(2);

		expect(backstopMetadataForSweep(directSweepStart).tooFresh).toBe(1);
		expect(backstopMetadataForSweep(directSweepStart).graceRetryInMs).toBe(5);
	});

	it("does not arm a follow-up when nothing was spared", async () => {
		h.state.stdout = "";

		const outcome = await sweepUntrackedOrphans({
			...FAST,
			graceRetryDelayMs: 5,
		});

		expect(outcome).toBe("clean");
		expect(backstopMetadata().graceRetryInMs).toBeUndefined();
		await new Promise((resolve) => setTimeout(resolve, 80));
		expect(h.state.scannerPids).toHaveLength(1);
	});

	it("bounds the chain at one: the retry never arms another retry", async () => {
		h.state.stdout = FRESH_ROW();

		// This IS the follow-up sweep — same options the re-arm passes itself.
		const outcome = await sweepUntrackedOrphans({
			...FAST,
			graceRetryDelayMs: 5,
			allowGraceRetry: false,
		});

		expect(outcome).toBe("clean");
		expect(backstopMetadata().tooFresh).toBe(1);
		expect(backstopMetadata().graceRetryInMs).toBeUndefined();
		await new Promise((resolve) => setTimeout(resolve, 80));
		expect(h.state.scannerPids).toHaveLength(1);
	});
});

describe("#1857 item 2: clean, errored, throttled, and disabled are distinguishable", () => {
	it("a scan that ran and found nothing logs outcome=clean", async () => {
		h.state.stdout = "";

		const outcome = await sweepUntrackedOrphans(FAST);

		expect(outcome).toBe("clean");
		// Pre-fix the sweep returned at `processes.length === 0` BEFORE logging,
		// so nothing was emitted at all.
		expect(backstopMetadata().outcome).toBe("clean");
		expect(backstopMetadata().scanned).toBe(0);
		expect(reasonsFor("orphan-backstop-scan-failed")).toHaveLength(0);
	});

	it("a scan that could not spawn logs outcome=error and records the failure", async () => {
		h.state.spawnError = true;

		const outcome = await sweepUntrackedOrphans(FAST);

		expect(outcome).toBe("error");
		expect(backstopMetadata().outcome).toBe("error");
		expect(backstopMetadata().scanStatus).toBe("spawn-error");
		expect(reasonsFor("orphan-backstop-scan-failed")).toHaveLength(1);
	});

	it("a scan that exceeded its timeout logs outcome=error rather than reading as clean", async () => {
		h.state.hang = true;

		const outcome = await sweepUntrackedOrphans({
			...FAST,
			scanTimeoutMs: 20,
		});

		expect(outcome).toBe("error");
		expect(backstopMetadata().scanStatus).toBe("timeout");
		expect(reasonsFor("orphan-backstop-scan-failed")[0]?.reason).toContain(
			"timeout",
		);
	});
});

describe("#1864 review F3: the timeout bounds the CHILD, not just the caller", () => {
	it("tree-kills the timed-out scanner and verifies it, instead of firing one bare signal", async () => {
		h.state.hang = true;

		const outcome = await sweepUntrackedOrphans({
			...FAST,
			scanTimeoutMs: 20,
		});

		expect(outcome).toBe("error");
		const scannerPid = h.state.scannerPids[0];
		expect(scannerPid).toBeDefined();
		// The reaper's own machinery, not `child.kill()`. On Windows that means
		// a taskkill spawn for the scanner's pid; on POSIX a process-group
		// signal. Either way the bare-signal path must NOT have been used.
		expect(h.state.bareKills).not.toContain(scannerPid);
		if (isWindows) {
			const treeKill = h.spawns.find(
				(spawn) =>
					spawn.command.toLowerCase().includes("taskkill") &&
					spawn.args.includes(String(scannerPid)),
			);
			expect(treeKill?.args).toEqual(
				expect.arrayContaining(["/F", "/T", "/PID"]),
			);
		}
		// Verified, and reported — an unverifiable scanner kill must not read
		// the same as a clean one.
		expect(backstopMetadata().scannerKill).toBe("gone");
	});

	it("records the escalation with the scanner's identity", async () => {
		h.state.hang = true;

		await sweepUntrackedOrphans({ ...FAST, scanTimeoutMs: 20 });

		const reasons = reasonsFor("orphan-backstop-scanner-escalated");
		expect(reasons).toHaveLength(1);
		expect(reasons[0].subject).toContain(String(h.state.scannerPids[0]));
		expect(reasons[0].reason).toContain("gone");
	});

	it("reports a scanner that SURVIVED its escalation, rather than claiming success", async () => {
		h.state.hang = true;
		// The scanner outlives the tree kill: an orphan sweep leaking an orphan.
		const outcome = await (async () => {
			const sweep = sweepUntrackedOrphans({ ...FAST, scanTimeoutMs: 200 });
			// The sweep reaches its spawn only after the lock and stamp I/O, so
			// wait for the scanner to exist before marking it unkillable.
			while (h.state.scannerPids.length === 0) {
				await new Promise((resolve) => setImmediate(resolve));
			}
			h.state.alivePids = new Set(h.state.scannerPids);
			return sweep;
		})();

		expect(outcome).toBe("error");
		expect(backstopMetadata().scannerKill).toBe("alive");
		expect(
			reasonsFor("orphan-backstop-scanner-escalated")[0]?.reason,
		).toContain("alive");
	});

	it("a disabled registry logs outcome=disabled and spawns nothing", async () => {
		h.state.enabled = false;

		const outcome = await sweepUntrackedOrphans(FAST);

		expect(outcome).toBe("disabled");
		expect(backstopMetadata().outcome).toBe("disabled");
		expect(h.spawns).toHaveLength(0);
	});
});

describe("#1857 item 4: spawn-grace guard", () => {
	const REGISTRY_FREE: never[] = [];

	function proc(overrides: Partial<OsProcessInfo> = {}): OsProcessInfo {
		return {
			pid: 5000,
			parentPid: 4000,
			command: "opengrep --lsp",
			ageMs: 10 * 60 * 1000,
			...overrides,
		};
	}

	it("a process younger than the grace period is spared, not killed", () => {
		// The 2026-08-20 near miss: spawned 890ms before the sweep, dead-parented
		// because the `.cmd` shim had already exited, and untracked because
		// registration had not landed yet.
		const fresh = proc({ ageMs: 890 });

		const partition = partitionBackstopCandidates(
			[fresh],
			REGISTRY_FREE,
			() => false,
		);

		expect(partition.eligible).toHaveLength(0);
		expect(partition.tooFresh).toEqual([fresh]);
	});

	it("a process older than the grace period stays kill-eligible", () => {
		const old = proc({ ageMs: BACKSTOP_SPAWN_GRACE_MS + 1 });

		const partition = partitionBackstopCandidates(
			[old],
			REGISTRY_FREE,
			() => false,
		);

		expect(partition.eligible).toEqual([old]);
		expect(partition.tooFresh).toHaveLength(0);
	});

	it("a process whose age the OS did not report is spared and bucketed as unknown", () => {
		const ageless = proc({ ageMs: undefined });

		const partition = partitionBackstopCandidates(
			[ageless],
			REGISTRY_FREE,
			() => false,
		);

		expect(partition.eligible).toHaveLength(0);
		expect(partition.unknownAge).toEqual([ageless]);
	});

	it("the sweep records a spared unknown-age candidate instead of silently finding nothing", async () => {
		h.state.stdout = enumerationRow({
			pid: 5000,
			parentPid: 4000,
			ageMs: undefined,
			command: ORPHAN_COMMAND,
		});

		const outcome = await sweepUntrackedOrphans(FAST);

		expect(outcome).toBe("clean");
		expect(backstopMetadata().unknownAge).toBe(1);
		expect(backstopMetadata().killed).toBe(0);
		expect(reasonsFor("orphan-backstop-age-unknown")[0]?.subject).toBe(
			"opengrep#5000",
		);
	});

	it("the sweep does not kill a freshly-spawned orphan candidate", async () => {
		h.state.stdout = enumerationRow({
			pid: 5000,
			parentPid: 4000,
			ageMs: 890,
			command: ORPHAN_COMMAND,
		});

		const outcome = await sweepUntrackedOrphans(FAST);

		expect(outcome).toBe("clean");
		expect(backstopMetadata().tooFresh).toBe(1);
		// Exactly one spawn: the enumeration. No taskkill / no signal.
		expect(h.spawns).toHaveLength(1);
	});
});

describe("#1857: cost containment", () => {
	it("a second sweep inside the cooldown window is throttled and spawns nothing", async () => {
		h.state.stdout = "";
		await sweepUntrackedOrphans({ ...FAST, force: true });
		const spawnsAfterFirst = h.spawns.length;

		const outcome = await sweepUntrackedOrphans({
			verifyAttempts: 1,
			verifyIntervalMs: 0,
			cooldownMs: 60_000,
		});

		expect(outcome).toBe("cooldown");
		expect(backstopMetadata().outcome).toBe("cooldown");
		expect(h.spawns).toHaveLength(spawnsAfterFirst);
	});

	it("the cooldown re-arms by the clock, so a long-lived host keeps reaping", async () => {
		await sweepUntrackedOrphans({ ...FAST, force: true });
		const spawnsAfterFirst = h.spawns.length;

		// Cooldown of 0 means "the window has already elapsed" — the same code
		// path a later session takes, and proof the throttle is not a
		// process-lifetime latch.
		const outcome = await sweepUntrackedOrphans({
			verifyAttempts: 1,
			verifyIntervalMs: 0,
			cooldownMs: 0,
		});

		expect(outcome).toBe("clean");
		expect(h.spawns.length).toBeGreaterThan(spawnsAfterFirst);
	});

	it("scheduleUntrackedOrphanSweep defers the sweep off the caller's critical path", async () => {
		const timer = scheduleUntrackedOrphanSweep(60_000);
		try {
			// Drain the microtask and immediate queues an eagerly-started sweep
			// would have needed to reach its first spawn. Asserting synchronously
			// would pass even against a sweep that WAS started, because the sweep
			// only spawns after several awaits.
			await new Promise((resolve) => setTimeout(resolve, 50));

			// The whole point: nothing ran, so session_start pays nothing.
			expect(h.spawns).toHaveLength(0);
			expect(h.latency).toHaveLength(0);
		} finally {
			clearTimeout(timer);
		}
	});

	it("the deferral timer is unref'd, so a settled one-shot process still exits", () => {
		const timer = scheduleUntrackedOrphanSweep(60_000);
		try {
			expect((timer as unknown as { hasRef?: () => boolean }).hasRef?.()).toBe(
				false,
			);
		} finally {
			clearTimeout(timer);
		}
	});

	it("narrows the image-name superset back to managed binaries in JS", async () => {
		// `node.exe` covers the node-launched servers, so the OS query returns
		// every node process on the machine. An unrelated node process must
		// never become a kill candidate, however dead its parent looks.
		h.state.stdout = [
			enumerationRow({
				pid: 7001,
				parentPid: 4000,
				ageMs: 10 * 60 * 1000,
				command: "node /home/dev/some-unrelated-tool.js",
			}),
			enumerationRow({
				pid: 7002,
				parentPid: 4000,
				ageMs: 10 * 60 * 1000,
				command: "node /opt/lib/typescript-language-server/cli.mjs --stdio",
			}),
		].join("\n");

		const outcome = await sweepUntrackedOrphans(FAST);

		expect(outcome).toBe("reaped");
		expect(backstopMetadata().scanned).toBe(1);
		expect(backstopMetadata().killedProcesses).toEqual([
			"typescript-language-server#7002",
		]);
	});

	// The Windows query string only exists on the Windows branch, so this is
	// declared skipped off-Windows rather than returning early from a test
	// that would otherwise report as passing without asserting anything.
	it.skipIf(!isWindows)(
		"the Windows enumeration filters on image-name equality and computes age in-shell",
		async () => {
			h.state.stdout = "";
			await sweepUntrackedOrphans(FAST);

			const script = h.spawns[0]?.args.at(-1) ?? "";
			expect(script).toContain("Name = 'node.exe'");
			expect(script).not.toContain("CommandLine LIKE");
			// The age must be a delta computed on the PowerShell side.
			// `CreationDate.Ticks` is the LOCAL-time representation, so
			// subtracting the Unix epoch in JS is wrong by the UTC offset —
			// measured as -8358s on a UTC+3 host during the #1857 host probe.
			expect(script).toContain("TotalMilliseconds");
			expect(script).not.toContain("CreationDate.Ticks");
			// A missing CreationDate must not become a two-thousand-year age.
			expect(script).toContain("-is [datetime]");
		},
	);

	it.skipIf(!isWindows)(
		"a negative age column reads as unknown, not as an ancient process",
		async () => {
			h.state.stdout = `5000\t4000\t-8358000\t${ORPHAN_COMMAND}`;

			const outcome = await sweepUntrackedOrphans(FAST);

			expect(outcome).toBe("clean");
			expect(backstopMetadata().unknownAge).toBe(1);
			expect(backstopMetadata().killed).toBe(0);
		},
	);
});

describe("#1857: the managed-binary image list is derived, not hand-maintained", () => {
	it("every managed binary contributes exactly one image name", () => {
		for (const name of MANAGED_BINARY_NAMES) {
			const expected = `${name}.exe`;
			const covered =
				MANAGED_IMAGE_NAMES.includes(expected) ||
				MANAGED_IMAGE_NAMES.includes("node.exe");
			expect(covered, `no image name covers ${name}`).toBe(true);
		}
	});

	it("has no duplicate image names", () => {
		expect(new Set(MANAGED_IMAGE_NAMES).size).toBe(MANAGED_IMAGE_NAMES.length);
	});
});
