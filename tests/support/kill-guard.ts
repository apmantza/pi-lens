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
// A dependency leaf (no imports of its own), so loading it here, before any
// test file's `vi.mock`, caches nothing a mock could need to replace.
import { getProcessSingleton } from "../../clients/process-singletons.js";

/**
 * Per-worker record cap (bounded observability, AGENTS.md shape 9): a runaway
 * loop must not retain an unbounded list. The first records are the
 * informative ones; the report says how many were dropped.
 */
const MAX_VIOLATIONS = 20;

/**
 * The registry `clients/safe-spawn.ts` keeps in the process-singleton
 * container (`lifetimeState()`). The family, version and initializer must stay
 * equal to production's: this guard is the cell's first creator in a worker, so
 * production adopts the object wrapped here only while they match, and
 * `tests/support/kill-guard-register-arm.test.ts` reds when they drift (shape
 * 25, #5722 review F1: the guard kept wrapping the retired `process` slot and
 * its register arm went dead without one test failing).
 */
const LIFETIME_FAMILY = "safe-spawn-lifetime";
const LIFETIME_VERSION = 1;

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

/**
 * Adopt the descendants a tree kill is about to signal (#4081, #4082 r3).
 *
 * `pids` is one `ps` snapshot of `root`'s tree, taken just before the caller
 * signals it. Ownership is decided here, BEFORE any signal, because after one
 * the kernel keeps no evidence: a killed (or self-exiting) parent's children
 * are reparented at its exit, so a re-read of `/proc` at signal time sees an
 * outside parent and refuses a kill of our own grandchild. The snapshot is
 * the kernel's ancestry at that moment; it is trusted only under a `root` this
 * worker owns by {@link ownsPid}'s own rule, so a fake child carrying a
 * fabricated pid adopts nothing and every signal it leads to is recorded.
 *
 * Test support only (`tests/support/process-tree.ts#killProcessTree`): the
 * production seams this guard polices never call it.
 */
export function adoptProcessTree(root: number, pids: readonly number[]): void {
	if (!ownsPid(root)) return;
	for (const pid of pids)
		if (Number.isInteger(pid) && pid > 0) ownedSeen.set(pid, true);
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

	// Create the registry cell before `clients/safe-spawn.ts` first asks for it
	// (`lifetimeState()` runs per spawn, never at module scope): production's
	// `getProcessSingleton` then adopts the cell wrapped here. A test that calls
	// `_resetProcessSingletonsForTests()` drops the cell and with it this arm
	// for the rest of that file; the kill arm is unaffected.
	const state = getProcessSingleton(LIFETIME_FAMILY, LIFETIME_VERSION, () => ({
		pids: new Set<number>(),
		installed: false,
	}));
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

/**
 * Take this worker's records whose target is in `targets`, in order, and
 * leave every other record for the `afterAll` that fails the file. Only for
 * the guard's own tests, which provoke violations at named pids on purpose.
 */
export function takeKillGuardViolationsForTest(
	targets: readonly number[],
): KillGuardViolation[] {
	const taken = violations.filter((v) => targets.includes(v.target));
	const kept = violations.filter((v) => !targets.includes(v.target));
	violations.splice(0, violations.length, ...kept);
	return taken;
}
