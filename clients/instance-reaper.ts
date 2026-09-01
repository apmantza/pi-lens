/**
 * Orphaned LSP process reaper (#472), built on the instance registry (#449
 * slice 1).
 *
 * Split into a PURE decision function (`decideOrphanReaping`) and an IMPURE
 * sweep (`sweepOrphans`) so the decision logic is unit-testable with fake
 * pid tables — no real process spawns/kills in tests.
 *
 * Why the registry reaper, not EOF/processId alone (see issue #472): both are
 * best-effort hints a well-behaved server may honor (typescript-language-server
 * does; ast-grep's native exe does not — an upstream LSP-spec violation). The
 * registry reaper works regardless of why a stdin pipe write-end stayed open
 * after the parent died (Windows handle-inheritance capture) — it identifies
 * dead-parent instances directly and kills the full recorded child tree, with
 * a command-line marker fallback for the case where the pid itself was
 * recycled or the mid-tree pid link is broken (e.g. a dead node-wrapper whose
 * native-exe grandchild is still alive under a different, unrecorded pid).
 *
 * #525 root cause: a parent instance was ONLY ever considered dead via
 * `isPidAlive(instance.pid)` — a raw `process.kill(pid, 0)` check. Unlike
 * child pids (which get a command-line/marker identity check via
 * `matchProcess` to guard against a recycled pid), the PARENT pid had no
 * identity verification at all, because `InstanceEntry` never recorded the
 * parent's own command line. Windows recycles pids far more aggressively than
 * POSIX (no zombie/wait-reaping semantics holding a dead pid "reserved"), so
 * over a long enough window (observed: ~13h) a dead parent's pid is very
 * plausibly reassigned to a live, unrelated process — `isPidAlive` then
 * (correctly, per its own conservative contract) reports "alive", and the
 * stale instance is never reaped, no matter how old its heartbeat is.
 *
 * The #525 fix is deliberately ASYMMETRIC by consequence:
 *
 * - **Heartbeat staleness (`STALE_HEARTBEAT_MS`) cleans REGISTRY ENTRIES,
 *   never kills.** A stale-heartbeat-but-pid-alive instance goes into
 *   `staleInstances` (entry dropped from instances.json) with ZERO process
 *   kills and its children still marker-protected. Why: the heartbeat call
 *   sites are runtime-turn.ts (per turn end) and quiet-window.ts (per run
 *   settle) ONLY — no timer exists. A pi session left OPEN but UNUSED
 *   overnight fires neither, so its heartbeat legitimately goes >6h stale
 *   while the session and its warm LSP fleet are genuinely alive. Killing on
 *   staleness would take that fleet down under the idle session — and
 *   `matchProcess` would NOT save it (its children really ARE that
 *   instance's LSP servers; identity verification guards against pid reuse,
 *   not against misclassifying a live parent). Removing just the entry is
 *   safe: the idle session's next turn re-registers via `registerInstance`.
 * - **Process kills require a pid-confirmed-DEAD parent** (`deadInstances`),
 *   exactly as before #525. Only then are its children classified for
 *   kill/marker-search.
 *
 * This still fixes both observed #525 cases: the 13h-stale test-fixture
 * entry AND the recycled-parent-pid case (a dead parent whose pid now
 * belongs to an unrelated live process — `isPidAlive` lies, but the stale
 * heartbeat gets the ENTRY dropped, which is all the pollution fix needs).
 */

/**
 * A pid-ALIVE instance whose heartbeat is older than this gets its registry
 * ENTRY removed — it is NEVER kill-eligible on staleness alone (see the
 * module docstring's asymmetry note: an overnight-idle-but-alive session
 * legitimately exceeds this threshold because heartbeats only fire at turn
 * end / run settle, so staleness must clean records, not kill processes).
 * 6 hours comfortably catches the observed 13h-stale pollution case.
 */
export const STALE_HEARTBEAT_MS = 6 * 60 * 60 * 1000;

import type { ChildProcess } from "node:child_process";
import { spawn as nodeSpawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { writeFileAtomicAsync } from "./atomic-write.js";
import {
	type AtomicStageSweepResult,
	sweepOwnStagingFiles,
} from "./atomic-write-staging.js";
import { acquireQuarantinePidFileLock } from "./bounded-pid-file-lock.js";
import {
	type SpawnCollectResult,
	type SpawnCollectStatus,
	type SpawnTimeoutKill,
	spawnCollectStdoutResult,
	unrefChildAndPipes,
} from "./child-unref.js";
import {
	incrementDegradationCount,
	recordDegradationOnce,
} from "./degradation-ledger.js";
import { getGlobalPiLensDir } from "./file-utils.js";
import {
	type InstanceEntry,
	isInstanceRegistryEnabled,
	pruneDeadInstances as pruneDeadRegistryInstances,
	readInstanceRegistry,
} from "./instance-registry.js";
import { logLatency } from "./latency-logger.js";

const isWindows = process.platform === "win32";

export interface ChildToKill {
	pid: number;
	serverId: string;
	command: string;
}

export interface MarkerSearch {
	marker: string;
	serverId: string;
}

export interface OrphanReapDecision {
	/** Registry entries whose owning pid is confirmed DEAD — kill-eligible:
	 *  their children are classified into `childrenToKill`/`markerSearches`,
	 *  and the entry is dropped from the registry. */
	deadInstances: InstanceEntry[];
	/** Registry entries whose pid is ALIVE but whose heartbeat is stale
	 *  beyond `STALE_HEARTBEAT_MS` (#525) — RECORD cleanup ONLY: the entry is
	 *  dropped from instances.json, but NOTHING is ever killed on staleness
	 *  (the parent may be an overnight-idle-but-alive session; see the module
	 *  docstring). Their children stay marker-protected. */
	staleInstances: InstanceEntry[];
	/** Live-pid LSP children belonging to a dead-parent instance — kill these. */
	childrenToKill: ChildToKill[];
	/** Children whose pid is ALSO dead (or already gone) but that carried a
	 *  marker — surfaced so the caller can command-line-search for a live
	 *  process still holding that marker (broken pid chain: e.g. a dead
	 *  node-wrapper whose exec'd native child kept a different, unrecorded pid). */
	markerSearches: MarkerSearch[];
}

/**
 * KILL eligibility: pid-confirmed-dead ONLY. Heartbeat staleness must never
 * make an instance kill-eligible — an overnight-idle-but-alive session
 * legitimately goes >STALE_HEARTBEAT_MS stale (heartbeats fire only at turn
 * end / run settle; no timer exists), and killing its genuine live LSP
 * children would pass `matchProcess` identity verification (they really are
 * that instance's servers — the matcher guards against pid reuse, not
 * against misclassifying a live parent). See the module docstring (#525).
 */
function isInstanceKillEligible(
	instance: InstanceEntry,
	isPidAlive: (pid: number) => boolean,
): boolean {
	return !isPidAlive(instance.pid);
}

/**
 * REGISTRY-ENTRY staleness: heartbeat older than `STALE_HEARTBEAT_MS` (or
 * unparseable — missing data must never keep a polluted entry alive
 * forever). Drives entry removal ONLY, never kills (#525). This is what
 * cleans the recycled-parent-pid case: `isPidAlive` lies for a long-dead
 * parent whose pid the OS reassigned to an unrelated live process, but the
 * stale heartbeat still gets the ENTRY dropped.
 */
function isInstanceEntryStale(instance: InstanceEntry, now: number): boolean {
	const heartbeatMs = Date.parse(instance.heartbeatAt);
	if (Number.isNaN(heartbeatMs)) return true;
	return now - heartbeatMs > STALE_HEARTBEAT_MS;
}

/**
 * Markers claimed by any pid-ALIVE instance's children. A marker search
 * kills by command-line match, so a marker that a live session also uses
 * must never be searched — killing it would take down the live session's
 * server. Protection is deliberately keyed on pid-liveness ALONE, regardless
 * of heartbeat staleness (#525): a stale-heartbeat-but-alive instance (e.g.
 * overnight-idle) must keep its children protected — protection stays
 * conservative even where entry cleanup does not.
 * Markers are per-process-unique by construction (sgconfig.ts embeds the
 * pid), so this is defense in depth against non-unique markers ever
 * reappearing (#472: the original shared baseline.sgconfig.yml would have
 * made the fallback kill every live ast-grep on the machine).
 */
function collectLiveMarkers(
	registry: InstanceEntry[],
	isPidAlive: (pid: number) => boolean,
): Set<string> {
	const liveMarkers = new Set<string>();
	for (const instance of registry) {
		if (!isPidAlive(instance.pid)) continue;
		for (const child of instance.lspChildren) {
			if (child.marker) liveMarkers.add(child.marker);
		}
	}
	return liveMarkers;
}

/**
 * Classify one dead-parent instance's children into kills / marker-searches,
 * appending onto the shared `out` accumulator. Extracted from
 * `decideOrphanReaping` to keep cognitive complexity in check — no behavior
 * change, just the per-instance inner loop pulled out.
 */
function classifyDeadInstanceChildren(
	instance: InstanceEntry,
	isPidAlive: (pid: number) => boolean,
	matchProcess:
		| ((pid: number, expected: { command: string; marker?: string }) => boolean)
		| undefined,
	liveMarkers: Set<string>,
	out: { childrenToKill: ChildToKill[]; markerSearches: MarkerSearch[] },
): void {
	for (const child of instance.lspChildren) {
		const childAlive = isPidAlive(child.pid);
		if (childAlive) {
			const identityOk = matchProcess
				? matchProcess(child.pid, {
						command: child.command,
						marker: child.marker,
					})
				: true;
			if (identityOk) {
				out.childrenToKill.push({
					pid: child.pid,
					serverId: child.serverId,
					command: child.command,
				});
				continue;
			}
		}
		// Child pid is dead, or alive-but-identity-mismatched (recycled pid) —
		// if we have a marker, surface it so the caller can find a live
		// process (e.g. the native exe grandchild) by command-line match.
		// Never surface a marker a live instance also claims (see above).
		if (child.marker && !liveMarkers.has(child.marker)) {
			out.markerSearches.push({
				marker: child.marker,
				serverId: child.serverId,
			});
		}
	}
}

/**
 * Pure decision function: given the registry state and injectable liveness /
 * identity predicates, decide what to kill. Performs zero I/O.
 *
 * @param isPidAlive - `process.kill(pid, 0)`-style liveness check. Must be
 *   CONSERVATIVE: only pid-confirmed-dead (ESRCH) counts as dead. Any
 *   ambiguous result (EPERM, or the caller's fake table saying "unknown")
 *   must be treated as alive — never kill on an ambiguous signal-check.
 * @param matchProcess - optional identity verification (e.g. confirm the
 *   live pid's command line still matches what we recorded) to guard against
 *   a recycled pid coincidentally matching. If omitted, liveness alone is used.
 * @param now - epoch ms "now", for heartbeat-staleness comparison (#525).
 *   Injectable for deterministic tests; defaults to `Date.now()`. The two
 *   signals are ASYMMETRIC by consequence: pid-confirmed-dead ⇒
 *   `deadInstances` (kill-eligible + entry removal); pid-alive but heartbeat
 *   older than `STALE_HEARTBEAT_MS` ⇒ `staleInstances` (entry removal ONLY —
 *   never kills, never loses marker protection; the parent may be an
 *   overnight-idle-but-alive session). See the module docstring.
 */
export function decideOrphanReaping(
	registry: InstanceEntry[],
	isPidAlive: (pid: number) => boolean,
	matchProcess?: (
		pid: number,
		expected: { command: string; marker?: string },
	) => boolean,
	now: number = Date.now(),
): OrphanReapDecision {
	const deadInstances: InstanceEntry[] = [];
	const staleInstances: InstanceEntry[] = [];
	const childrenToKill: ChildToKill[] = [];
	const markerSearches: MarkerSearch[] = [];

	// Marker protection is pid-liveness ONLY — a stale-heartbeat-but-alive
	// instance keeps its children protected (conservative on the kill side).
	const liveMarkers = collectLiveMarkers(registry, isPidAlive);

	for (const instance of registry) {
		if (isInstanceKillEligible(instance, isPidAlive)) {
			// pid-confirmed-dead: entry removal + children classified for kills.
			deadInstances.push(instance);
			classifyDeadInstanceChildren(
				instance,
				isPidAlive,
				matchProcess,
				liveMarkers,
				{
					childrenToKill,
					markerSearches,
				},
			);
		} else if (isInstanceEntryStale(instance, now)) {
			// pid-alive but stale heartbeat: record cleanup only — NO kills.
			staleInstances.push(instance);
		}
		// else: alive + fresh heartbeat — leave it alone entirely.
	}

	return { deadInstances, staleInstances, childrenToKill, markerSearches };
}

// --- Impure liveness / identity / kill helpers ---

/** `process.kill(pid, 0)` liveness check: ESRCH ⇒ dead, anything else
 *  (EPERM, or no error thrown at all) ⇒ conservatively alive. Exported so
 *  other registry consumers (clients/lsp-budget.ts, #449 slice 2) reuse this
 *  exact liveness check rather than inventing a second one. */
export function realIsPidAlive(pid: number): boolean {
	if (!Number.isFinite(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true; // no throw — process exists and we can signal it
	} catch (err) {
		const code = (err as NodeJS.ErrnoException)?.code;
		if (code === "ESRCH") return false; // definitively dead
		// EPERM (exists, no permission) or any other/unknown errno: ambiguous —
		// never treat as dead.
		return true;
	}
}

/** Maximum number of directory entries inspected by one staging sweep. */
export const ATOMIC_STAGE_SWEEP_MAX_ENTRIES = 512;

export type { AtomicStageSweepResult } from "./atomic-write-staging.js";

export interface AtomicStageSweepOptions {
	/** Test-only cap override; production callers use the default cap. */
	maxEntries?: number;
	/** Injectable only for deterministic tests; defaults to the shared probe. */
	isPidAlive?: (pid: number) => boolean;
}

/**
 * Remove orphaned generic atomic-write staging files from pi-lens-owned
 * directories. This is deliberately a directory-entry sweep, not a watcher:
 * it runs from session_start, reads at most `maxEntries` entries per directory,
 * and never creates a process-lifetime handle.
 *
 * Safety invariants:
 * - only the three atomic-write `.tmp-<pid>[-<thread>[-<seq>]]` shapes match;
 * - directories and symlinks are never removed;
 * - this process's pid is always protected, and every foreign pid is checked
 *   through the reaper's conservative ESRCH-only liveness seam;
 * - every I/O failure is best-effort and cannot fail session_start.
 */
export async function sweepAtomicWriteStages(
	directories: readonly string[],
	options: AtomicStageSweepOptions = {},
): Promise<AtomicStageSweepResult> {
	const requestedMax = options.maxEntries ?? ATOMIC_STAGE_SWEEP_MAX_ENTRIES;
	const maxEntries = Number.isFinite(requestedMax)
		? Math.max(1, Math.floor(requestedMax))
		: ATOMIC_STAGE_SWEEP_MAX_ENTRIES;
	const isPidAlive = options.isPidAlive ?? realIsPidAlive;
	return sweepOwnStagingFiles(directories, { maxEntries, isPidAlive });
}

export function windowsExe(name: string): string {
	return path.join(
		process.env.SystemRoot ?? String.raw`C:\Windows`,
		"System32",
		name,
	);
}

/** Resolve an absolute path to `ps` (S4036: never spawn via bare PATH lookup).
 *  Prefers `/bin/ps` (present on virtually every POSIX system), falls back to
 *  `/usr/bin/ps`, and defaults back to `/bin/ps` if neither probe succeeds
 *  (spawn will then fail closed rather than silently resolving via PATH). */
function posixPsPath(): string {
	if (fs.existsSync("/bin/ps")) return "/bin/ps";
	if (fs.existsSync("/usr/bin/ps")) return "/usr/bin/ps";
	return "/bin/ps";
}

/** Escape a value for embedding in a WQL LIKE clause: WQL uses `'` as the
 *  string delimiter (doubled to escape) and `%`/`_` as wildcards — the marker
 *  is an opaque path string, so escape all three before interpolating. */
function escapeWqlLikeValue(value: string): string {
	return value.replaceAll("'", "''").replaceAll(/[%_]/g, (ch) => `[${ch}]`);
}

/** Escape a value for a WQL EQUALITY comparison: only the string delimiter
 *  needs escaping — `%`/`_` are literal outside `LIKE`. */
function escapeWqlStringValue(value: string): string {
	return value.replaceAll("'", "''");
}

/** Search running processes whose command line contains `marker` (Windows,
 *  via CIM/WQL). Returns matching pids. Best-effort: any failure ⇒ [], but a
 *  failure is RECORDED (#1857 class sweep) — "the search found no orphan" and
 *  "the search never ran" produce the same empty array, and only the record
 *  tells them apart. */
async function findPidsByMarkerWindows(marker: string): Promise<number[]> {
	if (!isWindows || !marker) return [];
	const escaped = escapeWqlLikeValue(marker);
	// $PID exclusion: the query's own powershell.exe command line embeds the
	// marker string, so it would match itself.
	const psScript =
		`Get-CimInstance Win32_Process -Filter "CommandLine LIKE '%${escaped}%'" ` +
		`| Where-Object { $_.ProcessId -ne $PID } ` +
		`| Select-Object -ExpandProperty ProcessId`;
	const powershell = windowsExe("WindowsPowerShell\\v1.0\\powershell.exe");
	const result = await spawnCollectStdoutResult(
		powershell,
		["-NoProfile", "-NonInteractive", "-Command", psScript],
		{ shell: false, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
		{ timeoutMs: BACKSTOP_SCAN_TIMEOUT_MS },
	);
	if (result.status !== "ok") {
		recordDegradationOnce({
			kind: "orphan-backstop-scan-failed",
			subject: "marker-search",
			reason: `marker command-line search ${result.status}`,
		});
	}
	return result.stdout
		.split(/\r?\n/)
		.map((line) => Number(line.trim()))
		.filter((n) => Number.isFinite(n) && n > 0);
}

/** Fetch command lines for a set of pids in one query (Windows: CIM; POSIX:
 *  `ps`). Returns a pid → command-line map; pids that can't be resolved are
 *  simply absent (the caller treats absent as "identity unverifiable — do not
 *  kill by pid").
 *
 *  Best-effort: any failure ⇒ empty map, RECORDED (#1857 class sweep). An
 *  errored query makes every recorded child unverifiable at once, which
 *  suppresses the entire registry-driven reap — and reads exactly like a
 *  registry whose children have all already exited. Only the record separates
 *  the two. */
async function queryCommandLines(pids: number[]): Promise<Map<number, string>> {
	const valid = [...new Set(pids.filter((p) => Number.isFinite(p) && p > 0))];
	const map = new Map<number, string>();
	if (valid.length === 0) return map;
	const noteFailure = (status: SpawnCollectStatus) => {
		if (status === "ok") return;
		recordDegradationOnce({
			kind: "orphan-backstop-scan-failed",
			subject: "identity-query",
			reason: `command-line identity query ${status}; reap suppressed this sweep`,
		});
	};
	if (isWindows) {
		const filter = valid.map((p) => `ProcessId=${p}`).join(" OR ");
		const psScript =
			`Get-CimInstance Win32_Process -Filter "${filter}" ` +
			`| ForEach-Object { "$($_.ProcessId)\t$($_.CommandLine)" }`;
		const powershell = windowsExe("WindowsPowerShell\\v1.0\\powershell.exe");
		const result = await spawnCollectStdoutResult(
			powershell,
			["-NoProfile", "-NonInteractive", "-Command", psScript],
			{ shell: false, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
			{ timeoutMs: BACKSTOP_SCAN_TIMEOUT_MS },
		);
		noteFailure(result.status);
		for (const line of result.stdout.split(/\r?\n/)) {
			const tab = line.indexOf("\t");
			if (tab <= 0) continue;
			const pid = Number(line.slice(0, tab).trim());
			if (Number.isFinite(pid) && pid > 0) map.set(pid, line.slice(tab + 1));
		}
		return map;
	}
	const result = await spawnCollectStdoutResult(
		posixPsPath(),
		["-p", valid.join(","), "-o", "pid=,args="],
		{ shell: false, stdio: ["ignore", "pipe", "ignore"] },
		{ timeoutMs: BACKSTOP_SCAN_TIMEOUT_MS },
	);
	// `ps -p` exits nonzero when NONE of the pids exist, which is a legitimate
	// clean result here, so only spawn/timeout failures are recorded. The
	// shared collector calls that an exit failure, but this caller's command
	// contract makes that status the expected empty-table result.
	if (result.status !== "exit-error") noteFailure(result.status);
	for (const line of result.stdout.split(/\r?\n/)) {
		// Linear parse (S8786/S6594: avoid regex backtracking on
		// attacker-lengthenable ps output) — trim leading whitespace,
		// then split on the first whitespace run: "  1234 args here".
		const trimmed = line.trimStart();
		if (!trimmed) continue;
		let i = 0;
		while (i < trimmed.length && trimmed[i] >= "0" && trimmed[i] <= "9") i++;
		if (i === 0) continue;
		const pidStr = trimmed.slice(0, i);
		let j = i;
		while (j < trimmed.length && (trimmed[j] === " " || trimmed[j] === "\t"))
			j++;
		const pid = Number(pidStr);
		if (Number.isFinite(pid) && pid > 0) map.set(pid, trimmed.slice(j));
	}
	return map;
}

/**
 * Build a `matchProcess` identity predicate from a pid → command-line map
 * (as produced by `queryCommandLines`). PURE — exported for unit testing.
 *
 * Semantics (guarding pid kills against pid recycling):
 * - pid absent from the map ⇒ false: identity is UNVERIFIABLE, so never kill
 *   by pid (the marker-search fallback may still catch a real orphan).
 * - marker recorded and present in the command line ⇒ match (strongest
 *   signal — markers are per-spawn-unique).
 * - else: the recorded command's basename appears (case-insensitive) in the
 *   command line ⇒ match. Empty basename never matches (guard against a
 *   recorded empty/odd command matching everything via `includes("")`).
 */
export function buildIdentityMatcher(
	cmdlines: Map<number, string>,
): (pid: number, expected: { command: string; marker?: string }) => boolean {
	return (pid, expected) => {
		const cmdline = cmdlines.get(pid);
		if (cmdline === undefined) return false; // unverifiable ⇒ never kill by pid
		if (expected.marker && cmdline.includes(expected.marker)) return true;
		const basename = path.basename(expected.command ?? "").toLowerCase();
		if (!basename) return false;
		return cmdline.toLowerCase().includes(basename);
	};
}

/**
 * Result of one kill attempt (#1857 item 1). `gone` is VERIFIED: the pid was
 * observed dead after the attempt. `alive` means the attempt was made and the
 * pid is still there — a kill that did not happen. `invalid` means the pid was
 * never well-formed enough to attempt.
 *
 * Before #1857 `killPidTree` returned `void`, so both sweeps incremented a
 * `killed` counter unconditionally: `killed: 4` could mean four failures, and
 * a permanently unkillable process read exactly like a successful reap while
 * paying the full sweep cost every session.
 */
export type KillOutcome = "gone" | "alive" | "invalid";

/** Post-kill liveness poll budget. `taskkill /F /T` returns before the kernel
 *  has finished tearing the tree down, so a single immediate check would
 *  report false `alive`s. */
export const KILL_VERIFY_ATTEMPTS = 5;
export const KILL_VERIFY_INTERVAL_MS = 100;

/** `setTimeout` as an awaitable, with the timer unref'd so a settled one-shot
 *  `pi --print` never waits on best-effort kill verification. */
function sleepUnref(ms: number): Promise<void> {
	return new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, ms);
		timer.unref();
	});
}

export interface KillPidTreeOptions {
	isPidAlive?: (pid: number) => boolean;
	verifyAttempts?: number;
	verifyIntervalMs?: number;
}

/**
 * Force-kill a pid's full process tree, then VERIFY. Windows: `taskkill /F
 * /T`. POSIX: mirror killProcessTree's process-group kill, falling back to a
 * direct signal. The kill itself stays best-effort (all errors swallowed) —
 * what changed in #1857 is that the caller now learns the outcome, so an
 * unverified kill can be recorded with identity instead of being counted as
 * a success.
 *
 * Verification direction is conservative in the safe direction: a recycled
 * pid now belonging to an unrelated live process reports `alive`, so a real
 * reap can be under-reported, but a failed reap is never reported as done.
 */
async function killPidTree(
	pid: number,
	options: KillPidTreeOptions = {},
): Promise<KillOutcome> {
	if (!Number.isFinite(pid) || pid <= 0) return "invalid";
	if (isWindows) {
		try {
			const taskkill = windowsExe("taskkill.exe");
			const killer = nodeSpawn(taskkill, ["/F", "/T", "/PID", String(pid)], {
				shell: false,
				windowsHide: true,
				stdio: "ignore",
			});
			unrefChildAndPipes(killer);
			await new Promise<void>((resolve) => {
				killer.once("close", () => resolve());
				killer.once("error", () => resolve());
			});
		} catch {
			// best-effort
		}
	} else {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// best-effort — process may already be gone
			}
		}
	}
	return await verifyPidGone(pid, options);
}

/** Poll `isPidAlive` for a short budget after a kill attempt. */
async function verifyPidGone(
	pid: number,
	options: KillPidTreeOptions = {},
): Promise<KillOutcome> {
	const isPidAlive = options.isPidAlive ?? realIsPidAlive;
	const attempts = Math.max(1, options.verifyAttempts ?? KILL_VERIFY_ATTEMPTS);
	const intervalMs = Math.max(
		0,
		options.verifyIntervalMs ?? KILL_VERIFY_INTERVAL_MS,
	);
	for (let attempt = 0; attempt < attempts; attempt++) {
		let alive: boolean;
		try {
			alive = isPidAlive(pid);
		} catch {
			// An unreadable liveness probe is not evidence of death.
			alive = true;
		}
		if (!alive) return "gone";
		if (attempt < attempts - 1) await sleepUnref(intervalMs);
	}
	return "alive";
}

/**
 * #658: known pi-lens-managed LSP/scanner binary names (clients/lsp/server.ts
 * spawn candidates), used by the registry-INDEPENDENT backstop sweep below.
 * `opengrep-core` is opengrep's own native subprocess (not spawned directly by
 * pi-lens, but still part of the tree we manage). `yaml-language-server` and
 * `typescript-language-server` are node-launched — their OS image name is
 * `node`/`node.exe`, so matching is done against the full command line
 * (script path), not the process image name, exactly like the existing
 * marker-search's WQL LIKE query below.
 */
export const MANAGED_BINARIES: readonly ManagedBinary[] = [
	{ name: "ast-grep", launcher: "native" },
	{ name: "opengrep-core", launcher: "native" },
	{ name: "opengrep", launcher: "native" },
	{ name: "marksman", launcher: "native" },
	{ name: "zizmor", launcher: "native" },
	{ name: "typos-lsp", launcher: "native" },
	{ name: "yaml-language-server", launcher: "node" },
	{ name: "typescript-language-server", launcher: "node" },
];

/**
 * One managed binary and how it reaches the OS process table. `launcher`
 * exists so the Windows IMAGE-name set below can be DERIVED rather than
 * hand-maintained beside this list (single-source-of-truth rule): a
 * `native` entry runs as `<name>.exe`, a `node` entry runs as `node.exe`
 * with the script path on its command line.
 */
export interface ManagedBinary {
	name: string;
	launcher: "native" | "node";
}

/** Derived, never hand-written: the command-line substrings every platform
 *  matches against. */
export const MANAGED_BINARY_NAMES: readonly string[] = MANAGED_BINARIES.map(
	(binary) => binary.name,
);

/**
 * Derived Windows `Win32_Process.Name` values for the enumeration pre-filter
 * (#1857). Equality on `Name` replaces eight leading-wildcard `CommandLine
 * LIKE '%…%'` clauses; the node-launched entries collapse to `node.exe`, so
 * the query returns a SUPERSET that JS then narrows by the same
 * `MANAGED_BINARY_NAMES` substring test POSIX already uses. Identical
 * semantics, one filtering rule.
 */
export const MANAGED_IMAGE_NAMES: readonly string[] = [
	...new Set(
		MANAGED_BINARIES.map((binary) =>
			binary.launcher === "node" ? "node.exe" : `${binary.name}.exe`,
		),
	),
];

/** One OS process snapshot row, as enumerated independently of the instance
 *  registry (#658). */
export interface OsProcessInfo {
	pid: number;
	parentPid: number;
	command: string;
	/**
	 * Milliseconds since this process started, or `undefined` when the OS
	 * snapshot did not report a usable creation time (#1857 item 4). Feeds the
	 * spawn-grace guard: a process whose age is unknown is never
	 * kill-eligible, because "recently spawned and not yet registered" cannot
	 * be ruled out.
	 */
	ageMs?: number;
}

/**
 * PURE decision function for the #658 registry-independent backstop: given a
 * live OS-process snapshot (already filtered to known managed binary names)
 * and the current registry snapshot, decide which processes are backstop-
 * kill-eligible. Zero I/O — unit-testable with fake data, mirroring
 * `decideOrphanReaping`.
 *
 * A process is eligible ONLY when ALL of:
 * - its pid is NOT already tracked in any instance's `lspChildren[]` (tracked
 *   pids stay owned by the registry-driven `decideOrphanReaping` path above —
 *   this backstop must never race or duplicate that logic);
 * - its reported parent pid is a verifiable, well-formed pid (finite,
 *   positive, and not equal to its own pid) — an unresolvable/malformed
 *   parent pid is UNVERIFIABLE, never treated as "confirmed dead" (this is a
 *   stricter contract than `realIsPidAlive`'s own conservatism, because here
 *   an invalid value means "the OS couldn't tell us", not "confirmed gone");
 * - `isPidAlive(parentPid)` reports the parent as dead.
 *
 * Note the direction of the ambiguity guard: if `parentPid` itself was
 * recycled onto an unrelated live process, `isPidAlive` conservatively
 * reports "alive" and the process is (safely) left alone — a false negative,
 * never a false positive kill. Binary name alone is never sufficient (name
 * matching only decides which processes are candidates for this check at
 * all); a live parent is never overridden "however unfamiliar" the process.
 */
export function decideBackstopOrphanReaping(
	processes: OsProcessInfo[],
	registry: InstanceEntry[],
	isPidAlive: (pid: number) => boolean,
	options: BackstopDecisionOptions = {},
): OsProcessInfo[] {
	return partitionBackstopCandidates(processes, registry, isPidAlive, options)
		.eligible;
}

/**
 * Minimum process age before a name-matching, dead-parent process becomes
 * backstop-kill-eligible (#1857 item 4).
 *
 * The hazard: LSP servers launch through `.cmd` shims with `shell: true`, so
 * the pid registered in `lspChildren[]` is the shim's. Between the real
 * server's spawn and its registration there is a window in which the server
 * is name-matching and untracked. The 2026-08-20 session measured that window
 * at ~890ms (spawn 10:54:00.602, registration 10:54:01.492) with a sweep
 * ending at 10:53:59.996 — a near miss saved only by the parent-alive guard,
 * which is a guard about the PARENT and therefore does not cover a shim whose
 * parent is briefly unresolvable.
 *
 * 60s is roughly 67x the observed window and costs nothing against real
 * orphans, which are minutes-to-hours old by the time any sweep sees them.
 */
export const BACKSTOP_SPAWN_GRACE_MS = 60_000;

export interface BackstopDecisionOptions {
	/** Override `BACKSTOP_SPAWN_GRACE_MS` (tests). */
	graceMs?: number;
}

/** Full classification behind `decideBackstopOrphanReaping`, including the
 *  two REJECTED-BY-AGE buckets the sweep reports so a suppressed kill is
 *  visible rather than silent. */
export interface BackstopPartition {
	eligible: OsProcessInfo[];
	/** Dead-parent, untracked, but younger than the spawn grace period. */
	tooFresh: OsProcessInfo[];
	/** Dead-parent, untracked, but the OS reported no usable creation time,
	 *  so "recently spawned" could not be ruled out. */
	unknownAge: OsProcessInfo[];
}

/**
 * The single implementation of the backstop decision. Returns the eligible
 * set plus the two age-rejected sets, so `sweepUntrackedOrphans` can record
 * WHY a candidate was spared instead of losing it into an unexplained count.
 */
export function partitionBackstopCandidates(
	processes: OsProcessInfo[],
	registry: InstanceEntry[],
	isPidAlive: (pid: number) => boolean,
	options: BackstopDecisionOptions = {},
): BackstopPartition {
	const graceMs = Math.max(0, options.graceMs ?? BACKSTOP_SPAWN_GRACE_MS);
	const trackedPids = new Set<number>();
	for (const instance of registry) {
		for (const child of instance.lspChildren) trackedPids.add(child.pid);
	}

	const partition: BackstopPartition = {
		eligible: [],
		tooFresh: [],
		unknownAge: [],
	};
	for (const proc of processes) {
		if (trackedPids.has(proc.pid)) continue; // owned by the registry-driven reaper
		if (!Number.isFinite(proc.parentPid) || proc.parentPid <= 0) continue; // unverifiable
		if (proc.parentPid === proc.pid) continue; // malformed data guard
		if (isPidAlive(proc.parentPid)) continue; // live parent — never kill
		// Spawn-grace guard, applied LAST so the buckets only ever contain
		// processes that passed every other eligibility test.
		if (graceMs > 0) {
			const ageMs = proc.ageMs;
			if (typeof ageMs !== "number" || !Number.isFinite(ageMs)) {
				partition.unknownAge.push(proc);
				continue;
			}
			if (ageMs < graceMs) {
				partition.tooFresh.push(proc);
				continue;
			}
		}
		partition.eligible.push(proc);
	}
	return partition;
}

/** Enumerate live OS processes whose command line contains one of
 *  `MANAGED_BINARY_NAMES` (#658), independent of the instance registry.
 *  Windows: one batched CIM/WQL query (mirrors `findPidsByMarkerWindows`'s
 *  query pattern). POSIX: `ps -eo pid=,ppid=,args=`, filtered in JS. Returns
 *  `{pid, parentPid, command}` rows. Best-effort: any failure ⇒ []. */
async function enumerateManagedProcesses(
	options: {
		timeoutMs?: number;
		verifyAttempts?: number;
		verifyIntervalMs?: number;
	} = {},
): Promise<ManagedProcessScan> {
	const timeoutMs = options.timeoutMs ?? BACKSTOP_SCAN_TIMEOUT_MS;
	const collect = {
		timeoutMs,
		onTimeout: (child: ChildProcess) => terminateScannerChild(child, options),
	};
	if (isWindows) {
		// #1857: `Name = '…'` equality replaces eight leading-wildcard
		// `CommandLine LIKE '%…%'` clauses, and the query now also projects
		// `CreationDate` so the spawn-grace guard has an age to work with. The
		// image-name set is DERIVED from MANAGED_BINARIES (MANAGED_IMAGE_NAMES),
		// so adding a managed binary cannot leave a stale parallel list behind.
		const clauses = MANAGED_IMAGE_NAMES.map(
			(name) => `Name = '${escapeWqlStringValue(name)}'`,
		).join(" OR ");
		// The age column is computed IN PowerShell as a millisecond delta, not
		// exported as `CreationDate.Ticks`. `Ticks` is the LOCAL-time
		// representation, so subtracting the Unix epoch in JS produced an age
		// wrong by the machine's UTC offset — measured on a UTC+3 host as
		// -8358s for a process started 40 minutes earlier. A delta computed on
		// one side of the boundary has no timezone to get wrong. The explicit
		// `[datetime]` test matters: `(Get-Date) - $null` yields a two-thousand
		// year TimeSpan, which would read as "ancient" and defeat the grace
		// guard exactly where the data is missing.
		const psScript =
			`Get-CimInstance -Query "SELECT ProcessId,ParentProcessId,CreationDate,CommandLine FROM Win32_Process WHERE ${clauses}" ` +
			`| ForEach-Object { $age = if ($_.CreationDate -is [datetime]) { [int64]((Get-Date) - $_.CreationDate).TotalMilliseconds } else { '' }; ` +
			`"$($_.ProcessId)\t$($_.ParentProcessId)\t$age\t$($_.CommandLine)" }`;
		const powershell = windowsExe("WindowsPowerShell\\v1.0\\powershell.exe");
		const result = await spawnCollectStdoutResult(
			powershell,
			["-NoProfile", "-NonInteractive", "-Command", psScript],
			{ shell: false, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
			collect,
		);
		const processes: OsProcessInfo[] = [];
		for (const line of result.stdout.split(/\r?\n/)) {
			const firstTab = line.indexOf("\t");
			if (firstTab <= 0) continue;
			const secondTab = line.indexOf("\t", firstTab + 1);
			if (secondTab <= 0) continue;
			const thirdTab = line.indexOf("\t", secondTab + 1);
			if (thirdTab <= 0) continue;
			const pid = Number(line.slice(0, firstTab).trim());
			const parentPid = Number(line.slice(firstTab + 1, secondTab).trim());
			const ageMs = parseNonNegativeMs(line.slice(secondTab + 1, thirdTab));
			const command = line.slice(thirdTab + 1);
			if (!Number.isFinite(pid) || pid <= 0) continue;
			processes.push({ pid, parentPid, command, ageMs });
		}
		return narrowToManagedBinaries(processes, result);
	}
	// POSIX: enumerate everything, filter in JS by managed-name substring —
	// there is no single-query WQL-style server-side filter available.
	// `etime` is the POSIX-standard elapsed-time column (Linux and macOS both
	// support it; `etimes` is Linux-only), and supplies the spawn-grace age.
	const result = await spawnCollectStdoutResult(
		posixPsPath(),
		[...POSIX_PS_ARGS],
		{ shell: false, stdio: ["ignore", "pipe", "ignore"] },
		collect,
	);
	const processes: OsProcessInfo[] = [];
	for (const line of result.stdout.split(/\r?\n/)) {
		// Linear parse (S8786/S6594): "  pid ppid etime args here".
		const trimmed = line.trimStart();
		if (!trimmed) continue;
		let i = 0;
		while (i < trimmed.length && trimmed[i] >= "0" && trimmed[i] <= "9") i++;
		if (i === 0) continue;
		const pid = Number(trimmed.slice(0, i));
		let rest = trimmed.slice(i);
		let k = 0;
		while (k < rest.length && (rest[k] === " " || rest[k] === "\t")) k++;
		rest = rest.slice(k);
		let j = 0;
		while (j < rest.length && rest[j] >= "0" && rest[j] <= "9") j++;
		if (j === 0) continue;
		const parentPid = Number(rest.slice(0, j));
		rest = rest.slice(j);
		let m = 0;
		while (m < rest.length && (rest[m] === " " || rest[m] === "\t")) m++;
		rest = rest.slice(m);
		// etime token: a non-whitespace run of digits, ':' and '-'.
		let e = 0;
		while (e < rest.length && rest[e] !== " " && rest[e] !== "\t") e++;
		const ageMs = ageMsFromPosixEtime(rest.slice(0, e));
		let n = e;
		while (n < rest.length && (rest[n] === " " || rest[n] === "\t")) n++;
		const args = rest.slice(n);
		if (!Number.isFinite(pid) || pid <= 0) continue;
		processes.push({ pid, parentPid, command: args, ageMs });
	}
	return narrowToManagedBinaries(processes, result);
}

/**
 * The ONE place a raw OS-process snapshot is narrowed to managed binaries.
 * Both platforms over-collect for their own reason — Windows because
 * `node.exe` is a superset image name covering every node process on the
 * machine, POSIX because `ps -e` has no server-side filter — so the narrowing
 * lives at a single call site rather than being repeated per branch, where one
 * copy could rot or be dropped unnoticed.
 */
function narrowToManagedBinaries(
	processes: OsProcessInfo[],
	result: SpawnCollectResult,
): ManagedProcessScan {
	return {
		processes: processes.filter((proc) => matchesManagedBinary(proc.command)),
		status: result.status,
		timeoutKill: result.timeoutKill,
	};
}

/** Outcome of one OS-process enumeration. `status` exists so an empty
 *  `processes` array can be told apart from a scan that never produced
 *  output (#1857 item 2); `timeoutKill` reports the fate of a scanner child
 *  that had to be terminated (#1864 review F3). */
interface ManagedProcessScan {
	processes: OsProcessInfo[];
	status: SpawnCollectStatus;
	timeoutKill?: SpawnTimeoutKill;
}

/**
 * Terminate a scanner child that blew the scan timeout, using the reaper's
 * OWN tree-kill-and-verify machinery (#1864 review F3).
 *
 * The previous handler sent one bare signal to the direct child and resolved
 * in the same tick. On Windows that signal reaches only the `powershell.exe`
 * we spawned, never a CIM worker beneath it, and nothing checked whether it
 * died. An orphan sweep that leaks its own scanner is the defect the sweep
 * exists to fix, so the scanner now gets exactly what an orphan gets:
 * `taskkill /F /T` or a POSIX group kill, then a verified liveness poll. The
 * escalation is recorded with the scanner's identity, never swallowed.
 */
export async function terminateScannerChild(
	child: ChildProcess,
	options: { verifyAttempts?: number; verifyIntervalMs?: number },
): Promise<SpawnTimeoutKill> {
	const pid = child.pid;
	const outcome =
		typeof pid === "number" && pid > 0
			? await killPidTree(pid, {
					verifyAttempts: options.verifyAttempts,
					verifyIntervalMs: options.verifyIntervalMs,
				})
			: "invalid";
	incrementDegradationCount({
		kind: "orphan-backstop-scanner-escalated",
		subject: `${isWindows ? "win32-cim" : "posix-ps"}#${pid ?? "no-pid"}`,
		reason: `scan exceeded its timeout; tree kill reported ${outcome}`,
	});
	return outcome;
}

/** Hard bound on the enumeration child. The 2026-08-20 incident measured the
 *  Windows CIM query at 9344ms under session_start contention; this caps the
 *  worst case rather than trusting the median. */
export const BACKSTOP_SCAN_TIMEOUT_MS = 5_000;

/** The one command-line match rule, shared by both platforms' parsers. */
function matchesManagedBinary(command: string): boolean {
	const lower = command.toLowerCase();
	return MANAGED_BINARY_NAMES.some((name) =>
		lower.includes(name.toLowerCase()),
	);
}

/**
 * Parse the Windows age column: a non-negative integer millisecond count, or
 * anything else. A negative or malformed value is `undefined`, not zero and
 * not a clamp — a nonsensical age means the age is UNKNOWN, and the grace
 * guard must spare an unknown-age process rather than reason from a number it
 * cannot trust. That rule is what surfaced the local-time tick bug during the
 * host probe instead of silently sparing everything.
 */
function parseNonNegativeMs(raw: string): number | undefined {
	const token = raw.trim();
	if (!/^\d+$/.test(token)) return undefined;
	const value = Number(token);
	return Number.isFinite(value) ? value : undefined;
}

/**
 * POSIX enumeration columns. Exported so a real-`ps` test can assert this
 * exact argument vector is accepted by the host's `ps` — a rejected column
 * would make the whole backstop silently return zero rows, and this is the
 * one part of the fix that cannot be checked from a Windows dev machine.
 */
export const POSIX_PS_ARGS: readonly string[] = [
	"-eo",
	"pid=,ppid=,etime=,args=",
];

/** Parse `ps -o etime` output: `[[dd-]hh:]mm:ss`. Returns undefined for any
 *  shape the column did not produce (a `ps` without the column emits the
 *  command line where the token was expected). */
export function ageMsFromPosixEtime(raw: string): number | undefined {
	const token = raw.trim();
	if (!/^(?:\d+-)?(?:\d+:)?\d+:\d+$/.test(token)) return undefined;
	let days = 0;
	let rest = token;
	const dash = rest.indexOf("-");
	if (dash >= 0) {
		days = Number(rest.slice(0, dash));
		rest = rest.slice(dash + 1);
	}
	const parts = rest.split(":").map(Number);
	if (parts.some((part) => !Number.isFinite(part))) return undefined;
	const [hours, minutes, seconds] =
		parts.length === 3 ? parts : [0, parts[0], parts[1]];
	return ((days * 24 + hours) * 60 * 60 + minutes * 60 + seconds) * 1000;
}

/**
 * Fire-and-forget REGISTRY-INDEPENDENT backstop sweep (#658): finds
 * pi-lens-managed LSP/scanner processes the registry-driven `sweepOrphans`
 * can never see again once their registry trace is lost (a stale-heartbeat
 * entry removal, or a `killPidTree` call that failed silently) — enumerates
 * live OS processes by known binary name, and kills any that are both
 * untracked and have a confirmed-dead parent. A strictly ADDITIVE second
 * layer: `sweepOrphans`'s registry-driven path is untouched and remains the
 * cheap, correct common case.
 *
 * Kill-attempt retry: deliberately NO separate retry-tracking state. A
 * process that survives its kill stays alive, untracked, and dead-parented,
 * so the next sweep re-classifies it as eligible and tries again. #1857 added
 * the missing half of that story: the survivor is now RECORDED, by identity,
 * through `incrementDegradationCount`, instead of being counted as a reap.
 *
 * Cost and cadence (#1857): the sweep is deferred off the session_start
 * critical path by `scheduleUntrackedOrphanSweep`, its enumeration child has
 * a hard `BACKSTOP_SCAN_TIMEOUT_MS` timeout, and a machine-wide wall-clock
 * cooldown stops every session from paying for it. The cooldown is a
 * TIMESTAMP FILE, not a process-lifetime latch: it re-arms by the clock, so a
 * long-lived host whose sessions keep starting keeps reaping, and a session
 * that outlives the cooldown is no worse off than before, when the sweep ran
 * exactly once at its start.
 *
 * Mutual exclusion (#1864 review F1): the cooldown check and the stamp write
 * were a read-check-write, and an atomic rename makes each WRITE atomic
 * without making the PAIR exclusive — two sessions starting together both read
 * "no stamp", both wrote, and both swept. The claim now runs under
 * `acquireQuarantinePidFileLock` (clients/bounded-pid-file-lock.ts:179), the
 * repo's existing async cross-process lock for work that spans awaited I/O.
 * The lock is taken FIRST and there is exactly ONE cooldown read, inside it,
 * so check and claim are a single serialized step rather than a pair with a
 * window between them. A contended sweep skips rather than waits: the loser
 * has nothing useful to do, and blocking would put a best-effort background
 * sweep back on somebody's clock.
 *
 * Never throws — every step is wrapped so a reap failure cannot block or
 * crash the caller (session_start).
 */
export async function sweepUntrackedOrphans(
	options: BackstopSweepOptions = {},
): Promise<BackstopSweepOutcome> {
	const startedAt = Date.now();
	if (!isInstanceRegistryEnabled()) {
		return logBackstopOutcome("disabled", startedAt, {});
	}
	const cooldownMs = Math.max(0, options.cooldownMs ?? BACKSTOP_COOLDOWN_MS);
	let release: (() => Promise<void>) | null = null;
	try {
		// LOCK FIRST, then read the stamp. The ORDER is the fix. A cooldown
		// check outside the lock followed by a stamp write inside it is still a
		// read-check-write: two processes both pass the outside check before
		// either acquires. Keeping a second check inside the lock as well would
		// leave the outside one doing nothing a mutation could detect, so there
		// is exactly ONE check and it lives inside the lock — check and claim
		// are one serialized step. Locking before an eventual skip costs one
		// mkdir, on a timer that already fired 30 seconds after session start.
		release = await acquireBackstopLock();
		if (release === null) {
			// Another process holds the sweep right now. Not an error, and not a
			// cooldown either — a distinct record, because "somebody else is
			// sweeping" and "we swept recently" have different causes.
			return logBackstopOutcome("concurrent", startedAt, {});
		}

		const throttled = await isWithinCooldown(Date.now(), cooldownMs, options);
		if (throttled !== undefined) {
			return logBackstopOutcome("cooldown", startedAt, {
				sinceLastMs: throttled,
			});
		}

		// Claim the cooldown slot BEFORE the scan, not after: a sweep that dies
		// mid-scan must not re-run at full cost on every retry.
		await writeBackstopStamp(startedAt);

		const [registry, scan] = await Promise.all([
			readInstanceRegistry(),
			enumerateManagedProcesses({
				timeoutMs: options.scanTimeoutMs,
				verifyAttempts: options.verifyAttempts,
				verifyIntervalMs: options.verifyIntervalMs,
			}),
		]);

		if (scan.status !== "ok") {
			// An enumeration that errored or timed out produced an EMPTY result
			// for a reason that is not "nothing to reap" — record it as such.
			recordDegradationOnce({
				kind: "orphan-backstop-scan-failed",
				subject: isWindows ? "win32-cim" : "posix-ps",
				reason: `process enumeration ${scan.status}`,
			});
			return logBackstopOutcome("error", startedAt, {
				scanStatus: scan.status,
				scannerKill: scan.timeoutKill,
				scanned: scan.processes.length,
			});
		}

		const partition = partitionBackstopCandidates(
			scan.processes,
			registry,
			realIsPidAlive,
			{ graceMs: options.graceMs },
		);

		for (const proc of partition.unknownAge) {
			// A spared kill must never be silent: without this the guard would
			// look identical to "found nothing".
			incrementDegradationCount({
				kind: "orphan-backstop-age-unknown",
				subject: describeManagedProcess(proc),
				reason: "OS snapshot reported no usable process creation time",
			});
		}

		const killed: string[] = [];
		const unverified: string[] = [];
		for (const proc of partition.eligible) {
			const identity = describeManagedProcess(proc);
			const outcome = await killPidTree(proc.pid, {
				verifyAttempts: options.verifyAttempts,
				verifyIntervalMs: options.verifyIntervalMs,
			});
			if (outcome === "gone") {
				killed.push(identity);
				continue;
			}
			unverified.push(identity);
			incrementDegradationCount({
				kind: "orphan-backstop-kill-unverified",
				subject: identity,
				reason: `kill attempted, process still ${outcome === "alive" ? "alive" : "unresolvable"}`,
			});
		}

		const retryAt = scheduleGraceRetryIfNeeded(partition, options);

		return logBackstopOutcome(
			classifyKillOutcome(killed.length, unverified.length),
			startedAt,
			{
				scanStatus: scan.status,
				scanned: scan.processes.length,
				eligible: partition.eligible.length,
				tooFresh: partition.tooFresh.length,
				unknownAge: partition.unknownAge.length,
				killed: killed.length,
				killUnverified: unverified.length,
				// Identity of the kill, bounded — #1857 item 3. Counts alone can
				// never answer "which process did we kill?".
				killedProcesses: killed.slice(0, BACKSTOP_IDENTITY_LOG_LIMIT),
				unverifiedProcesses: unverified.slice(0, BACKSTOP_IDENTITY_LOG_LIMIT),
				graceRetryInMs: retryAt,
			},
		);
	} catch (error) {
		// The sweep must never throw out of session_start — but "threw" is now
		// a distinguishable record rather than a silent absence.
		recordDegradationOnce({
			kind: "orphan-backstop-scan-failed",
			subject: "sweep",
			reason: `sweep threw: ${error instanceof Error ? error.message : String(error)}`,
		});
		return logBackstopOutcome("error", startedAt, { threw: true });
	} finally {
		if (release) {
			await release().catch(() => {
				// A lock we cannot release goes stale on its own timer.
			});
		}
	}
}

/**
 * The distinguishable states of one backstop sweep. Before #1857 the only
 * record was a `{scanned, killed}` line emitted on the reaped path, so "ran
 * and found nothing", "never ran", and "threw" were the same absence.
 *
 * `reaped` / `partial` / `unverified` exist because collapsing them (#1864
 * review F4) would reproduce the very defect this work fixes, one level up: a
 * sweep that attempted one kill and verified none reported `reaped`, so a
 * health check reading the outcome saw a success where the metadata said
 * `killed: 0, killUnverified: 1`.
 */
export type BackstopSweepOutcome =
	/** Ran, nothing to kill. */
	| "clean"
	/** Every eligible process is verifiably gone. */
	| "reaped"
	/** Some verified kills, at least one survivor. */
	| "partial"
	/** Kills were attempted and NONE could be verified. */
	| "unverified"
	/** The scan or the sweep itself failed. */
	| "error"
	/** Skipped: swept recently. */
	| "cooldown"
	/** Skipped: another process holds the sweep lock right now. */
	| "concurrent"
	/** Skipped: the instance registry is off. */
	| "disabled";

/** Map verified/unverified kill counts onto the outcome. The only place that
 *  mapping exists. */
function classifyKillOutcome(
	killed: number,
	unverified: number,
): BackstopSweepOutcome {
	if (unverified === 0) return killed > 0 ? "reaped" : "clean";
	return killed > 0 ? "partial" : "unverified";
}

export interface BackstopSweepOptions {
	/** Bypass the wall-clock cooldown (tests, the grace re-arm, and any future
	 *  explicit user-triggered reap). Never bypasses the LOCK. */
	force?: boolean;
	cooldownMs?: number;
	graceMs?: number;
	scanTimeoutMs?: number;
	verifyAttempts?: number;
	verifyIntervalMs?: number;
	/**
	 * Whether a sweep that spared a candidate under the spawn grace may arm one
	 * follow-up sweep. Default true; the follow-up itself passes `false`, which
	 * is what bounds the chain at exactly one retry — no latch, no counter.
	 */
	allowGraceRetry?: boolean;
	/** Override the follow-up delay (tests). */
	graceRetryDelayMs?: number;
}

/**
 * Minimum wall-clock gap between backstop sweeps, machine-wide. The backstop
 * catches processes that are already orphaned and will stay orphaned; it is
 * not time-critical, so paying its cost once per half hour instead of once
 * per session_start removes essentially all of its aggregate cost.
 */
export const BACKSTOP_COOLDOWN_MS = 30 * 60 * 1000;

/** How long after session_start the deferred sweep fires. Chosen to clear the
 *  warmup window it was measured starving: `warmup_total` median 3288ms,
 *  worst on record 5480ms (#1857). */
export const BACKSTOP_START_DELAY_MS = 30_000;

/** Cap on process identities embedded in one latency record. */
const BACKSTOP_IDENTITY_LOG_LIMIT = 10;

/**
 * Extra margin on top of the spawn grace before the follow-up sweep runs, so
 * a candidate that was 1ms too fresh is comfortably past the grace by the
 * time the retry looks at it again.
 */
export const BACKSTOP_GRACE_RETRY_MARGIN_MS = 30_000;

/** How long the sweep lock may be held before another process reclaims it.
 *  Well above the scan timeout plus the kill budget, and irrelevant when the
 *  holder dies — the lock reclaims immediately on a dead owner pid
 *  (clients/bounded-pid-file-lock.ts:90). */
const BACKSTOP_LOCK_STALE_MS = 120_000;

/**
 * Schedule the backstop sweep OFF the session_start critical path. The timer
 * is `unref`'d, so a settled one-shot `pi --print` exits without waiting and
 * the sweep simply does not happen for that invocation — which is correct: a
 * process too short-lived to reach the delay is also too short-lived to be
 * the right place to spend seconds of CIM time.
 */
export function scheduleUntrackedOrphanSweep(
	delayMs: number = BACKSTOP_START_DELAY_MS,
	options: BackstopSweepOptions = {},
): NodeJS.Timeout {
	const timer = setTimeout(
		() => {
			void sweepUntrackedOrphans(options).catch(() => {
				// sweepUntrackedOrphans never rejects; belt-and-braces.
			});
		},
		Math.max(0, delayMs),
	);
	timer.unref();
	return timer;
}

/**
 * Arm ONE follow-up sweep when the spawn grace spared a candidate (#1864
 * review F2).
 *
 * Without it, the grace guard could spare an orphan indefinitely: the sweep
 * runs once per session, a candidate younger than the grace is spared, and a
 * long-lived session never looks again. That is a regression against the old
 * always-at-session-start sweep, which at least re-examined the process every
 * session.
 *
 * The retry passes `force` (the cooldown it would otherwise hit is the stamp
 * this same sweep just wrote) and `allowGraceRetry: false`, so the chain is
 * exactly one deep. It still takes the lock, so it cannot race a concurrent
 * sweep. Residual: if the process exits before the timer fires, the spared
 * candidate waits for the next session's sweep — the retry is unref'd, and a
 * background reap must never hold a settled one-shot open.
 *
 * Returns the delay armed, or undefined when nothing was spared.
 */
function scheduleGraceRetryIfNeeded(
	partition: BackstopPartition,
	options: BackstopSweepOptions,
): number | undefined {
	if (options.allowGraceRetry === false) return undefined;
	if (partition.tooFresh.length === 0) return undefined;
	const graceMs = Math.max(0, options.graceMs ?? BACKSTOP_SPAWN_GRACE_MS);
	const delayMs = Math.max(
		0,
		options.graceRetryDelayMs ?? graceMs + BACKSTOP_GRACE_RETRY_MARGIN_MS,
	);
	scheduleUntrackedOrphanSweep(delayMs, {
		...options,
		force: true,
		allowGraceRetry: false,
	});
	return delayMs;
}

/** Serialize the sweep across processes. Returns null when another process
 *  holds it — the caller skips rather than waits (`waitMs: 0`). */
async function acquireBackstopLock(): Promise<(() => Promise<void>) | null> {
	try {
		return await acquireQuarantinePidFileLock(
			path.join(getGlobalPiLensDir(), "orphan-backstop.lock"),
			{
				waitMs: 0,
				retryMs: 50,
				staleMs: BACKSTOP_LOCK_STALE_MS,
				timeoutMessage: "orphan backstop sweep lock contended",
				onContention: "skip-log",
				logContention: () => {
					// The caller emits the `concurrent` record; nothing to add here.
				},
			},
		);
	} catch {
		// A lock we cannot even attempt (unwritable global dir) must not disable
		// the backstop — fall through unlocked, exactly as before this fix.
		return async () => {};
	}
}

/** Milliseconds since the last sweep when the cooldown is in force, else
 *  undefined. Centralized so the pre-check and the in-lock re-check cannot
 *  drift apart. */
async function isWithinCooldown(
	now: number,
	cooldownMs: number,
	options: BackstopSweepOptions,
): Promise<number | undefined> {
	if (cooldownMs <= 0 || options.force) return undefined;
	const lastSweepAt = await readBackstopStamp();
	if (lastSweepAt === undefined) return undefined;
	const sinceLastMs = now - lastSweepAt;
	return sinceLastMs < cooldownMs ? sinceLastMs : undefined;
}

/** Short, stable identity for one managed process: which binary, which pid.
 *  Full command lines are user paths and can be long, so the record carries
 *  the matched managed-binary name plus the pid. */
function describeManagedProcess(proc: OsProcessInfo): string {
	const lower = proc.command.toLowerCase();
	const matched = MANAGED_BINARY_NAMES.find((name) =>
		lower.includes(name.toLowerCase()),
	);
	return `${matched ?? "unknown"}#${proc.pid}`;
}

function logBackstopOutcome(
	outcome: BackstopSweepOutcome,
	startedAt: number,
	metadata: Record<string, unknown>,
): BackstopSweepOutcome {
	try {
		logLatency({
			type: "phase",
			phase: "orphan_backstop_reaped",
			filePath: "",
			durationMs: Date.now() - startedAt,
			metadata: { outcome, ...metadata },
		});
	} catch {
		// best-effort logging only
	}
	return outcome;
}

/** Machine-wide cooldown stamp. A file, not a module-level flag: the sweep is
 *  machine-scoped (every pi-lens process shares one OS process table), and
 *  process-lifetime state cannot express "30 minutes have passed". */
function backstopStampPath(): string {
	return path.join(getGlobalPiLensDir(), "orphan-backstop.json");
}

async function readBackstopStamp(): Promise<number | undefined> {
	try {
		const raw = await fs.promises.readFile(backstopStampPath(), "utf8");
		const parsed: unknown = JSON.parse(raw);
		const value = (parsed as { lastSweepAt?: unknown } | null)?.lastSweepAt;
		return typeof value === "number" && Number.isFinite(value)
			? value
			: undefined;
	} catch {
		// Absent or unreadable ⇒ no cooldown in force, so the sweep runs. A
		// corrupt stamp must never be able to disable the backstop permanently.
		return undefined;
	}
}

async function writeBackstopStamp(at: number): Promise<void> {
	try {
		await fs.promises.mkdir(getGlobalPiLensDir(), { recursive: true });
		await writeFileAtomicAsync(
			backstopStampPath(),
			JSON.stringify({ lastSweepAt: at }),
		);
	} catch {
		// best-effort — a stamp we cannot persist just means the next session
		// pays for another sweep, never a crash.
	}
}

/**
 * Fire-and-forget orphan sweep: reads the registry, decides what's dead via
 * `decideOrphanReaping`, kills orphaned LSP children (by pid, with a
 * marker-based command-line search fallback), then drops fully-dead
 * instances from the registry. Never throws — every step is wrapped so a
 * reap failure cannot block or crash the caller (session_start).
 */
export async function sweepOrphans(): Promise<void> {
	if (!isInstanceRegistryEnabled()) return;
	const startedAt = Date.now();
	try {
		const registry = await readInstanceRegistry();
		if (registry.length === 0) return;

		// Identity verification before any pid kill (recycled-pid guard): fetch
		// the command lines of every recorded child pid in ONE batched query,
		// then let the pure decision function verify each live child's identity
		// against what was recorded at spawn. A pid whose command line can't be
		// fetched is treated as unverifiable and never killed by pid — the
		// marker-search fallback may still catch it.
		const candidatePids = registry.flatMap((instance) =>
			instance.lspChildren.map((child) => child.pid),
		);
		const cmdlines = await queryCommandLines(candidatePids);
		const matchProcess = buildIdentityMatcher(cmdlines);

		const decision = decideOrphanReaping(
			registry,
			realIsPidAlive,
			matchProcess,
		);

		// #1857 class sweep: the registry-driven path spelled the same
		// attempt-counted-as-kill defect as the backstop, so it gets the same
		// verified accounting and the same bounded, identity-carrying record.
		let killedCount = 0;
		let unverifiedCount = 0;
		const killedServerIds: string[] = [];

		const killAndAccount = async (pid: number, serverId: string) => {
			const outcome = await killPidTree(pid);
			if (outcome === "gone") {
				killedCount++;
				killedServerIds.push(serverId);
				return;
			}
			unverifiedCount++;
			incrementDegradationCount({
				kind: "orphan-reap-kill-unverified",
				subject: `${serverId}#${pid}`,
				reason: `kill attempted, process still ${outcome === "alive" ? "alive" : "unresolvable"}`,
			});
		};

		for (const child of decision.childrenToKill) {
			await killAndAccount(child.pid, child.serverId);
		}

		for (const search of decision.markerSearches) {
			try {
				const pids = await findPidsByMarkerWindows(search.marker);
				for (const pid of pids) {
					await killAndAccount(pid, search.serverId);
				}
			} catch {
				// best-effort — a failed marker search just misses that orphan this sweep
			}
		}

		// Entry removal covers BOTH sets: pid-dead instances AND stale-heartbeat
		// (pid-alive) instances — the latter is record cleanup only (#525);
		// nothing belonging to a stale instance was killed above.
		if (
			decision.deadInstances.length > 0 ||
			decision.staleInstances.length > 0
		) {
			try {
				const prunePids = new Set([
					...decision.deadInstances.map((i) => i.pid),
					...decision.staleInstances.map((i) => i.pid),
				]);
				await pruneDeadInstances(prunePids);
			} catch {
				// best-effort — a stale registry entry is re-evaluated next sweep
			}
		}

		try {
			logLatency({
				type: "phase",
				phase: "orphan_lsp_reaped",
				filePath: "",
				durationMs: Date.now() - startedAt,
				metadata: {
					deadInstances: decision.deadInstances.length,
					staleInstances: decision.staleInstances.length,
					killed: killedCount,
					killUnverified: unverifiedCount,
					serverIds: killedServerIds,
					markerSearches: decision.markerSearches.length,
				},
			});
		} catch {
			// best-effort logging only
		}
	} catch {
		// The sweep must never throw out of session_start.
	}
}

/** Drop dead-parent AND stale-heartbeat (#525, record-cleanup-only)
 *  instances from the registry. Re-reads immediately before
 *  writing (rather than reusing the earlier `readInstanceRegistry()` snapshot)
 *  under the instance-registry lock so the reaper cannot lose a registration
 *  or heartbeat while pruning.
 *
 *  Exported for the #1217 concurrency regression test; `sweepOrphans` is the
 *  only production caller.
 *
 *  #1217: this used to hand-roll `${target}.tmp-${process.pid}` + rename
 *  instead of going through `atomic-write.ts`, so it never inherited the
 *  #1205 fix — two concurrent prunes in one process staged into one shared
 *  inode and the first rename published it while the second was still
 *  writing. That is reachable here rather than theoretical: this store is
 *  machine-global and written fire-and-forget from `instance-registry.ts`'s
 *  `prunePids` as well, and `readInstanceRegistry` degrades a parse failure
 *  to empty, so a tear dropped EVERY registered instance rather than one
 *  entry. `writeFileAtomicAsync` also cleans up its staging file on a failed
 *  rename, which the hand-rolled copy did not, and puts this writer back on
 *  the same scheme as the other writer of this same file. */
export async function pruneDeadInstances(deadPids: Set<number>): Promise<void> {
	try {
		await pruneDeadRegistryInstances(deadPids);
	} catch {
		// best-effort
	}
}
