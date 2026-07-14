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

import { spawn as nodeSpawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { getGlobalPiLensDir } from "./file-utils.js";
import {
	type InstanceEntry,
	isInstanceRegistryEnabled,
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
			out.markerSearches.push({ marker: child.marker, serverId: child.serverId });
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
			classifyDeadInstanceChildren(instance, isPidAlive, matchProcess, liveMarkers, {
				childrenToKill,
				markerSearches,
			});
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

function windowsExe(name: string): string {
	return path.join(process.env.SystemRoot ?? String.raw`C:\Windows`, "System32", name);
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

/** Search running processes whose command line contains `marker` (Windows,
 *  via CIM/WQL). Returns matching pids. Best-effort: any failure ⇒ []. */
async function findPidsByMarkerWindows(marker: string): Promise<number[]> {
	if (!isWindows || !marker) return [];
	const escaped = escapeWqlLikeValue(marker);
	// $PID exclusion: the query's own powershell.exe command line embeds the
	// marker string, so it would match itself.
	const psScript =
		`Get-CimInstance Win32_Process -Filter "CommandLine LIKE '%${escaped}%'" ` +
		`| Where-Object { $_.ProcessId -ne $PID } ` +
		`| Select-Object -ExpandProperty ProcessId`;
	return new Promise((resolve) => {
		try {
			const powershell = windowsExe(
				"WindowsPowerShell\\v1.0\\powershell.exe",
			);
			const child = nodeSpawn(
				powershell,
				["-NoProfile", "-NonInteractive", "-Command", psScript],
				{ shell: false, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
			);
			let out = "";
			child.stdout?.on("data", (chunk) => {
				out += chunk.toString();
			});
			child.once("error", () => resolve([]));
			child.once("close", () => {
				const pids = out
					.split(/\r?\n/)
					.map((line) => Number(line.trim()))
					.filter((n) => Number.isFinite(n) && n > 0);
				resolve(pids);
			});
		} catch {
			resolve([]);
		}
	});
}

/** Fetch command lines for a set of pids in one query (Windows: CIM; POSIX:
 *  `ps`). Returns a pid → command-line map; pids that can't be resolved are
 *  simply absent (the caller treats absent as "identity unverifiable — do not
 *  kill by pid"). Best-effort: any failure ⇒ empty map. */
async function queryCommandLines(pids: number[]): Promise<Map<number, string>> {
	const valid = [...new Set(pids.filter((p) => Number.isFinite(p) && p > 0))];
	const map = new Map<number, string>();
	if (valid.length === 0) return map;
	if (isWindows) {
		const filter = valid.map((p) => `ProcessId=${p}`).join(" OR ");
		const psScript =
			`Get-CimInstance Win32_Process -Filter "${filter}" ` +
			`| ForEach-Object { "$($_.ProcessId)\t$($_.CommandLine)" }`;
		return new Promise((resolve) => {
			try {
				const powershell = windowsExe(
					"WindowsPowerShell\\v1.0\\powershell.exe",
				);
				const child = nodeSpawn(
					powershell,
					["-NoProfile", "-NonInteractive", "-Command", psScript],
					{ shell: false, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
				);
				let out = "";
				child.stdout?.on("data", (chunk) => {
					out += chunk.toString();
				});
				child.once("error", () => resolve(map));
				child.once("close", () => {
					for (const line of out.split(/\r?\n/)) {
						const tab = line.indexOf("\t");
						if (tab <= 0) continue;
						const pid = Number(line.slice(0, tab).trim());
						if (Number.isFinite(pid) && pid > 0) map.set(pid, line.slice(tab + 1));
					}
					resolve(map);
				});
			} catch {
				resolve(map);
			}
		});
	}
	return new Promise((resolve) => {
		try {
			const child = nodeSpawn(
				posixPsPath(),
				["-p", valid.join(","), "-o", "pid=,args="],
				{ shell: false, stdio: ["ignore", "pipe", "ignore"] },
			);
			let out = "";
			child.stdout?.on("data", (chunk) => {
				out += chunk.toString();
			});
			child.once("error", () => resolve(map));
			child.once("close", () => {
				for (const line of out.split(/\r?\n/)) {
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
					while (j < trimmed.length && (trimmed[j] === " " || trimmed[j] === "\t")) j++;
					const pid = Number(pidStr);
					if (Number.isFinite(pid) && pid > 0) map.set(pid, trimmed.slice(j));
				}
				resolve(map);
			});
		} catch {
			resolve(map);
		}
	});
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

/** Force-kill a pid's full process tree. Windows: `taskkill /F /T`. POSIX:
 *  mirror killProcessTree's process-group kill, falling back to a direct
 *  signal. Best-effort: swallow all errors. */
async function killPidTree(pid: number): Promise<void> {
	if (!Number.isFinite(pid) || pid <= 0) return;
	if (isWindows) {
		try {
			const taskkill = windowsExe("taskkill.exe");
			const killer = nodeSpawn(taskkill, ["/F", "/T", "/PID", String(pid)], {
				shell: false,
				windowsHide: true,
				stdio: "ignore",
			});
			await new Promise<void>((resolve) => {
				killer.once("close", () => resolve());
				killer.once("error", () => resolve());
			});
		} catch {
			// best-effort
		}
		return;
	}
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
export const MANAGED_BINARY_NAMES: readonly string[] = [
	"ast-grep",
	"opengrep-core",
	"opengrep",
	"marksman",
	"zizmor",
	"typos-lsp",
	"yaml-language-server",
	"typescript-language-server",
];

/** One OS process snapshot row, as enumerated independently of the instance
 *  registry (#658). */
export interface OsProcessInfo {
	pid: number;
	parentPid: number;
	command: string;
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
): OsProcessInfo[] {
	const trackedPids = new Set<number>();
	for (const instance of registry) {
		for (const child of instance.lspChildren) trackedPids.add(child.pid);
	}

	const out: OsProcessInfo[] = [];
	for (const proc of processes) {
		if (trackedPids.has(proc.pid)) continue; // owned by the registry-driven reaper
		if (!Number.isFinite(proc.parentPid) || proc.parentPid <= 0) continue; // unverifiable
		if (proc.parentPid === proc.pid) continue; // malformed data guard
		if (isPidAlive(proc.parentPid)) continue; // live parent — never kill
		out.push(proc);
	}
	return out;
}

/** Enumerate live OS processes whose command line contains one of
 *  `MANAGED_BINARY_NAMES` (#658), independent of the instance registry.
 *  Windows: one batched CIM/WQL query (mirrors `findPidsByMarkerWindows`'s
 *  query pattern). POSIX: `ps -eo pid=,ppid=,args=`, filtered in JS. Returns
 *  `{pid, parentPid, command}` rows. Best-effort: any failure ⇒ []. */
async function enumerateManagedProcesses(): Promise<OsProcessInfo[]> {
	if (isWindows) {
		const clauses = MANAGED_BINARY_NAMES.map(
			(name) => `CommandLine LIKE '%${escapeWqlLikeValue(name)}%'`,
		).join(" OR ");
		const psScript =
			`Get-CimInstance Win32_Process -Filter "${clauses}" ` +
			`| ForEach-Object { "$($_.ProcessId)\t$($_.ParentProcessId)\t$($_.CommandLine)" }`;
		return new Promise((resolve) => {
			try {
				const powershell = windowsExe("WindowsPowerShell\\v1.0\\powershell.exe");
				const child = nodeSpawn(
					powershell,
					["-NoProfile", "-NonInteractive", "-Command", psScript],
					{ shell: false, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
				);
				let out = "";
				child.stdout?.on("data", (chunk) => {
					out += chunk.toString();
				});
				child.once("error", () => resolve([]));
				child.once("close", () => {
					const results: OsProcessInfo[] = [];
					for (const line of out.split(/\r?\n/)) {
						const firstTab = line.indexOf("\t");
						if (firstTab <= 0) continue;
						const secondTab = line.indexOf("\t", firstTab + 1);
						if (secondTab <= 0) continue;
						const pid = Number(line.slice(0, firstTab).trim());
						const parentPid = Number(line.slice(firstTab + 1, secondTab).trim());
						const command = line.slice(secondTab + 1);
						if (Number.isFinite(pid) && pid > 0) {
							results.push({ pid, parentPid, command });
						}
					}
					resolve(results);
				});
			} catch {
				resolve([]);
			}
		});
	}
	// POSIX: enumerate everything, filter in JS by managed-name substring —
	// there is no single-query WQL-style server-side filter available.
	return new Promise((resolve) => {
		try {
			const child = nodeSpawn(posixPsPath(), ["-eo", "pid=,ppid=,args="], {
				shell: false,
				stdio: ["ignore", "pipe", "ignore"],
			});
			let out = "";
			child.stdout?.on("data", (chunk) => {
				out += chunk.toString();
			});
			child.once("error", () => resolve([]));
			child.once("close", () => {
				const results: OsProcessInfo[] = [];
				for (const line of out.split(/\r?\n/)) {
					// Linear parse (S8786/S6594): "  pid ppid args here".
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
					let m = j;
					while (m < rest.length && (rest[m] === " " || rest[m] === "\t")) m++;
					const args = rest.slice(m);
					if (!Number.isFinite(pid) || pid <= 0) continue;
					const lowerArgs = args.toLowerCase();
					if (MANAGED_BINARY_NAMES.some((name) => lowerArgs.includes(name.toLowerCase()))) {
						results.push({ pid, parentPid, command: args });
					}
				}
				resolve(results);
			});
		} catch {
			resolve([]);
		}
	});
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
 * Kill-attempt retry: deliberately NO separate retry-tracking state. If
 * `killPidTree` fails silently, the process stays alive, untracked, and its
 * parent stays dead — so it stays classified as backstop-kill-eligible and
 * this exact sweep simply tries again at the next `session_start`, with zero
 * extra bookkeeping. This only breaks if the orphan's *parent* pid gets
 * reused by a live process in the interim (closes the window), which is the
 * same residual risk `decideOrphanReaping`'s registry path already accepts.
 * A future hardening (making `killPidTree` return a success signal so a
 * failed kill can be logged distinctly from "already gone") is a reasonable
 * follow-up, not required for correctness here.
 *
 * Never throws — every step is wrapped so a reap failure cannot block or
 * crash the caller (session_start).
 */
export async function sweepUntrackedOrphans(): Promise<void> {
	if (!isInstanceRegistryEnabled()) return;
	const startedAt = Date.now();
	try {
		const [registry, processes] = await Promise.all([
			readInstanceRegistry(),
			enumerateManagedProcesses(),
		]);
		if (processes.length === 0) return;

		const candidates = decideBackstopOrphanReaping(processes, registry, realIsPidAlive);

		let killedCount = 0;
		for (const proc of candidates) {
			await killPidTree(proc.pid);
			killedCount++;
		}

		try {
			logLatency({
				type: "phase",
				phase: "orphan_backstop_reaped",
				filePath: "",
				durationMs: Date.now() - startedAt,
				metadata: {
					scanned: processes.length,
					killed: killedCount,
				},
			});
		} catch {
			// best-effort logging only
		}
	} catch {
		// The sweep must never throw out of session_start.
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

		const decision = decideOrphanReaping(registry, realIsPidAlive, matchProcess);

		let killedCount = 0;
		const killedServerIds: string[] = [];

		for (const child of decision.childrenToKill) {
			await killPidTree(child.pid);
			killedCount++;
			killedServerIds.push(child.serverId);
		}

		for (const search of decision.markerSearches) {
			try {
				const pids = await findPidsByMarkerWindows(search.marker);
				for (const pid of pids) {
					await killPidTree(pid);
					killedCount++;
					killedServerIds.push(search.serverId);
				}
			} catch {
				// best-effort — a failed marker search just misses that orphan this sweep
			}
		}

		// Entry removal covers BOTH sets: pid-dead instances AND stale-heartbeat
		// (pid-alive) instances — the latter is record cleanup only (#525);
		// nothing belonging to a stale instance was killed above.
		if (decision.deadInstances.length > 0 || decision.staleInstances.length > 0) {
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
 *  to narrow — not eliminate — the last-writer-wins race already accepted for
 *  slice 1's read-modify-write model. */
async function pruneDeadInstances(deadPids: Set<number>): Promise<void> {
	const target = path.join(getGlobalPiLensDir(), "instances.json");
	try {
		const raw = await fs.promises.readFile(target, "utf-8");
		const parsed = JSON.parse(raw);
		if (!parsed || !Array.isArray(parsed.instances)) return;
		const remaining = parsed.instances.filter(
			(entry: InstanceEntry) => !deadPids.has(entry.pid),
		);
		if (remaining.length === parsed.instances.length) return;
		const tmpPath = `${target}.tmp-${process.pid}`;
		await fs.promises.mkdir(getGlobalPiLensDir(), { recursive: true });
		await fs.promises.writeFile(
			tmpPath,
			JSON.stringify({ instances: remaining }),
			"utf-8",
		);
		await fs.promises.rename(tmpPath, target);
	} catch {
		// best-effort
	}
}
