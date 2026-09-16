/**
 * Per-worker guard against signalling a pid this process does not own (#2042).
 *
 * Named recurrence: `tests/clients/lsp/launch.test.ts` mocked
 * `node:child_process` with a fake child whose pid was the literal `2468`.
 * Production code under test (`launchLSP` -> `package-manager.isAvailable` ->
 * `probeToolAsync` -> `safeSpawnAsync("which")`) took that fake at face value
 * and registered 2468 in the REAL lifetime registry; the fake never emitted
 * `close`, so nothing removed it, and at fork teardown
 * `installLifetimeCleanup()` fired `process.kill(-2468, "SIGKILL")` then
 * `process.kill(2468, "SIGKILL")`. On ~10 % of GitHub runners pid 2468 was one
 * of the job's OWN long-lived processes: `Killed npm test`, exit 137, no
 * failing assertion, no kernel record. Five weeks of "infra kill" reruns were
 * reruns of our own SIGKILL.
 *
 * Two runtime observations, never a source scan (defect shape 33):
 *
 *  - `process.kill` is wrapped. A real (non-zero) signal at a pid this process
 *    does not own is RECORDED and NOT DELIVERED — the guard also protects the
 *    developer's own desktop, where pids 1234/2468/5678/9876 are live daemons.
 *  - the lifetime registry's `pids.add` is wrapped, at REGISTRATION time. That
 *    is the race-free checkpoint: a pid production has just spawned is alive
 *    with `PPid == our pid`, while a fabricated one is not, and the check
 *    happens inside the test rather than in the exit handler that fires after
 *    the last `afterAll` has already passed.
 *
 * The `afterAll` in `vitest-setup.ts` fails the FILE with the pid, the site,
 * and the stack. Known limit, stated rather than implied: a signal fired from
 * a test's own `process.on("exit")` handler is still swallowed and printed to
 * stderr, but cannot fail that file — the registry arm is what covers the one
 * exit-time route this repo has.
 *
 * The ownership oracle here is deliberately INDEPENDENT of
 * `clients/safe-spawn.ts#resolvePidOwnership`: a detector that imports the
 * predicate it polices goes green the moment that predicate breaks.
 */
import * as fs from "node:fs";

import { BoundedFifoMap } from "../../clients/bounded-cache.js";

/**
 * Per-worker record cap (bounded observability, AGENTS.md shape 9): a runaway
 * loop must not retain an unbounded list. The first records are the
 * informative ones; the report says how many were dropped.
 */
const MAX_VIOLATIONS = 20;

/** The registry `clients/safe-spawn.ts` keeps on the process object. */
const LIFETIME_STATE_KEY = Symbol.for("pi-lens.safe-spawn.lifetime-state");

export interface KillGuardViolation {
	/** "kill" = a signal was attempted; "register" = a pid entered the registry. */
	site: "kill" | "register";
	target: number;
	detail: string;
	stack: string;
}

const violations: KillGuardViolation[] = [];
let dropped = 0;

/**
 * Pids this worker has already SEEN as its own live child.
 *
 * A POSIX group kill legitimately outlives its leader: `safeSpawnAsync`
 * SIGTERMs the group, the direct child dies, and the 1 s escalation SIGKILLs
 * the group again to reach a SIGTERM-hardy grandchild (#2026/#2027). By then
 * `/proc/<leader>` is gone, which `/proc` alone cannot tell apart from a
 * fabricated pid — so ownership is remembered from the moment it was
 * verifiable, exactly as production resolves it at spawn time.
 *
 * FIFO-bounded rather than cleared wholesale (#3091 F5): a worker that spawns
 * more than the cap and then group-kills an earlier, already-dead leader would
 * get a FALSE violation from a wholesale clear — a flake shape inside the
 * detector itself.
 */
const MAX_OWNED_SEEN = 512;
const ownedSeen = new BoundedFifoMap<number, true>(MAX_OWNED_SEEN);

/**
 * Ownership, read from the kernel.
 *
 * `/proc/<pid>/status` is authoritative on Linux, the lane that gates this
 * repo. A pid with no `/proc` entry does not exist — it is not ours either,
 * and it still counts: in ~90 % of the #2042 runs pid 2468 was already dead
 * and the SIGKILL merely missed. A detector that forgave the miss would be
 * green on exactly the runs that were one pid away from killing the job.
 */
function ownsPid(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	if (pid === process.pid) return true;
	if (ownedSeen.has(pid)) return true;
	let status: string;
	try {
		status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
	} catch {
		return false;
	}
	const match = /^PPid:\s*(\d+)$/m.exec(status);
	if (!match || Number(match[1]) !== process.pid) return false;
	ownedSeen.set(pid, true);
	return true;
}

function record(site: "kill" | "register", target: number, detail: string) {
	if (violations.length >= MAX_VIOLATIONS) {
		dropped++;
		return;
	}
	violations.push({
		site,
		target,
		detail,
		stack: (new Error("kill-guard").stack ?? "")
			.split("\n")
			.slice(2, 7)
			.map((line) => line.trim())
			.join(" | "),
	});
	// Printed as well as collected: an exit-handler violation lands after the
	// `afterAll` that would have failed the file, and swallowing it silently
	// there would be defect shape 10 (silencing as fixing).
	console.error(
		`[kill-guard] ${site} of unowned pid ${target} (${detail}) — see #2042`,
	);
}

/** `process.kill(pid, 0)` delivers nothing — a liveness probe, always allowed. */
function isLivenessProbe(signal: string | number | undefined): boolean {
	return signal === 0 || signal === "0";
}

/**
 * Install both arms in a worker fork. Linux only: the oracle needs `/proc`,
 * so on any other platform the guard is inert rather than wrong.
 */
export function installKillGuard(): void {
	if (process.platform !== "linux") return;

	const originalKill = process.kill.bind(process);
	process.kill = ((pid: number, signal?: string | number) => {
		if (!isLivenessProbe(signal) && !ownsPid(Math.abs(pid))) {
			record("kill", pid, String(signal ?? "SIGTERM"));
			return true;
		}
		return originalKill(pid, signal as never);
	}) as typeof process.kill;

	// Seed the registry before `clients/safe-spawn.ts` is imported: its module
	// scope does `process[KEY] ?? (process[KEY] = {...})`, so the object placed
	// here is the one production writes to.
	const host = process as typeof process & {
		[LIFETIME_STATE_KEY]?: { pids: Set<number>; installed: boolean };
	};
	const state = (host[LIFETIME_STATE_KEY] ??= {
		pids: new Set<number>(),
		installed: false,
	});
	const originalAdd = state.pids.add.bind(state.pids);
	state.pids.add = (pid: number) => {
		if (!ownsPid(pid)) record("register", pid, "lifetime-registry");
		return originalAdd(pid);
	};
}

/** The report for this worker's test file, or `undefined` when it behaved. */
export function killGuardReport(): string | undefined {
	if (violations.length === 0) return undefined;
	const lines = violations.map(
		(violation) =>
			`  ${violation.site} pid ${violation.target} (${violation.detail})\n    ${violation.stack}`,
	);
	const extra = dropped > 0 ? `\n  ... and ${dropped} more` : "";
	return (
		`#2042: this file handed ${violations.length} pid(s) it does not own to production kill/spawn code:\n` +
		`${lines.join("\n")}${extra}\n` +
		"A fabricated pid registered with the real lifetime registry is SIGKILLed at fork " +
		"teardown, which is how the Unit lane killed its own npm. Give the fake a pid this " +
		"process really owns (`process.pid`), or keep it out of the production seam."
	);
}
