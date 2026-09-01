/**
 * Cross-platform CPU/RSS sampling (#620), used two ways:
 *
 * 1. **Long-lived processes** (this host process + the LSP children recorded
 *    in clients/instance-registry.ts): `sampleProcesses` takes a snapshot of
 *    a pid set at heartbeat cadence (clients/quiet-window.ts /
 *    clients/runtime-turn.ts already call `updateHeartbeat` at that cadence —
 *    this module doesn't own a timer of its own).
 * 2. **Transient analyzer children** (jscpd/knip/madge/gitleaks/etc., spawned
 *    via clients/safe-spawn.ts's `safeSpawnAsync`): `SpawnUsageSampler`
 *    brackets a single spawn with a short-interval poll (started right after
 *    `spawn()`, stopped at `child.on("close", ...)`), tracking peak/average
 *    CPU% and RSS for that one invocation.
 *
 * On **Linux/macOS** it uses `pidusage` (procfs on Linux, `ps` on macOS) — a
 * small pure-JS package (one transitive dep, `safe-buffer`) that bundles like
 * the repo's other pure-JS runtime deps (minimatch, js-yaml) rather than
 * needing an EXTERNAL entry in scripts/bundle-dist.mjs.
 *
 * On **Windows** it does NOT use `pidusage`: pidusage's Windows path shells out
 * to `gwmi` via an internal `spawn(..., { shell: "powershell.exe" })` that has
 * NO try/catch, and it runs that spawn from inside a ChildProcess `close`
 * callback (a detached async context). Under real Windows handle/commit
 * pressure that `spawn()` can throw `spawn UNKNOWN` (errno -4094)
 * **synchronously in that detached callback**, which no `try { await pidusage }
 * catch {}` at the call site can catch → uncaughtException → the pi host
 * crashes (#620, #533). pidusage 4.0.1 exposes no option to avoid the gwmi
 * path. So on Windows this module runs its OWN fully guarded
 * `Get-CimInstance Win32_Process` query (see `sampleProcessesWindows`),
 * mirroring `findDescendantPidsWindows`'s guard pattern, and computes CPU%
 * from the same KernelModeTime/UserModeTime delta-over-elapsed formula gwmi
 * uses — so a spawn failure can only ever lose a data point, never throw.
 *
 * Every export here is best-effort: a sampling failure (pid already exited,
 * `pidusage` throwing, permission denied, etc.) must never throw into the
 * caller and must never block/slow the operation it's measuring — this
 * module only ever "loses a data point", matching the repo's existing
 * instrumentation-must-never-fail-the-operation-it-measures convention (see
 * clients/latency-logger.ts's fire-and-forget `logLatency` calls).
 *
 * The accumulation math (peak/average over a stream of samples) is split out
 * as a PURE class (`UsageAccumulator`) so it's unit-testable without any real
 * process/pidusage involvement — mirrors the pure/impure split in
 * clients/instance-reaper.ts (`decideOrphanReaping` vs `sweepOrphans`).
 */

import pidusage from "pidusage";
import { spawnCollectStdoutResult } from "./child-unref.js";
import { recordDegradationOnce } from "./degradation-ledger.js";
import { terminateScannerChild, windowsExe } from "./instance-reaper.js";

export const RESOURCE_SAMPLE_QUERY_TIMEOUT_MS = 2_000;

function recordQueryFailure(
	subject: string,
	status: string,
	exitCode?: number | null,
): void {
	const exitReason =
		status === "exit-error" ? ` (exit code ${exitCode ?? "unknown"})` : "";
	recordDegradationOnce({
		kind: "resource-sampler-query-failed",
		subject,
		reason: `process-table query ${status}${exitReason}`,
	});
}

// Read the platform live (not a module-load const) so both the Windows and the
// POSIX sampling paths are exercisable in unit tests regardless of the host OS.
function runningOnWindows(): boolean {
	return process.platform === "win32";
}

export interface ProcessUsage {
	rssBytes: number;
	cpuPercent: number;
}

/**
 * PURE BFS over a (pid, parentPid) snapshot: every live descendant of
 * `rootPid`, however deep. Split out from `findDescendantPidsWindows` so the
 * tree-walk itself is unit-testable with a fake pid/ppid table — no real CIM
 * query/spawn involved (mirrors clients/instance-reaper.ts's pure/impure
 * split). Cycle-guarded (`visited`) in case a malformed/racy snapshot ever
 * produced a loop — a live process tree never actually has one, but a
 * best-effort sampler must not hang if the data is ever wrong.
 */
export function walkDescendantPids(
	rootPid: number,
	pairs: Array<[number, number]>,
): number[] {
	const childrenByParent = new Map<number, number[]>();
	for (const [pid, ppid] of pairs) {
		const list = childrenByParent.get(ppid);
		if (list) list.push(pid);
		else childrenByParent.set(ppid, [pid]);
	}

	const descendants: number[] = [];
	const queue = [rootPid];
	const visited = new Set<number>([rootPid]);
	while (queue.length > 0) {
		const current = queue.shift() as number;
		for (const child of childrenByParent.get(current) ?? []) {
			if (visited.has(child)) continue;
			visited.add(child);
			descendants.push(child);
			queue.push(child);
		}
	}
	return descendants;
}

/**
 * Windows-only descendant-pid resolution (best-effort; `[]` on any failure).
 *
 * WHY THIS EXISTS: `clients/safe-spawn.ts` spawns with `shell: true` on
 * Windows (needed for `.cmd`-shimmed tools like pyright/biome — see its
 * `buildWindowsShellCommand` docstring), so `child.pid` there is `cmd.exe`'s
 * pid, not the real tool's. `cmd.exe` itself does almost no work — sampling
 * only its pid would report ~0% CPU / minimal RSS for the entire spawn,
 * which is a misleading answer on the platform this repo primarily runs on.
 * Resolving the live descendant tree (cmd.exe's children, and THEIR
 * children — covers e.g. `npx` re-spawning `node`) via one CIM query per poll
 * tick lets the sampler aggregate the pids that are actually doing the work.
 * Mirrors the identity-verification CIM queries in clients/instance-reaper.ts.
 */
async function findDescendantPidsWindows(
	rootPid: number,
): Promise<number[] | null> {
	if (!runningOnWindows() || !Number.isFinite(rootPid) || rootPid <= 0)
		return [];
	// One WQL query pulls every process's (pid, parentPid) pair; walk the BFS
	// in JS rather than issuing N queries for N tree levels.
	const psScript =
		"Get-CimInstance Win32_Process " +
		"| Select-Object -Property ProcessId,ParentProcessId " +
		'| ForEach-Object { "$($_.ProcessId),$($_.ParentProcessId)" }';
	const powershell = windowsExe("WindowsPowerShell\\v1.0\\powershell.exe");
	// Fire-and-forget, per-poll-tick spawn (#1155): `spawnCollectStdout` unrefs
	// the child AND its piped stdout so this one-shot CIM query can never keep
	// a settled `pi --print` process alive past its own close — mirrors the
	// reaper's identical spawn→collect plumbing (#1153/#1160). Sampling still
	// works normally in an interactive/long-lived session: unref only means
	// "don't hold the loop open FOR this alone," the collected stdout is still
	// delivered whenever `close` fires. The result status keeps a failed query
	// distinct from a successful empty process table.
	const result = await spawnCollectStdoutResult(
		powershell,
		["-NoProfile", "-NonInteractive", "-Command", psScript],
		{ shell: false, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
		{
			timeoutMs: RESOURCE_SAMPLE_QUERY_TIMEOUT_MS,
			onTimeout: (child) => terminateScannerChild(child, {}),
		},
	);
	if (result.status !== "ok") {
		recordQueryFailure(
			"windows-descendant-process-table",
			result.status,
			result.exitCode,
		);
		return null;
	}
	const pairs: Array<[number, number]> = [];
	for (const line of result.stdout.split(/\r?\n/)) {
		const [pidStr, ppidStr] = line.split(",");
		const pid = Number(pidStr);
		const ppid = Number(ppidStr);
		if (Number.isFinite(pid) && Number.isFinite(ppid)) {
			pairs.push([pid, ppid]);
		}
	}

	return walkDescendantPids(rootPid, pairs);
}

/**
 * Per-pid CPU-time history for the Windows CIM sampler. CPU% is a rate, so it
 * needs two observations: `cpuMs` = cumulative kernel+user CPU time (ms) and
 * `ts` = the wall clock (Date.now, ms) of that observation. The next sample
 * computes `cpu% = ΔcpuMs / ΔwallMs * 100`, exactly as pidusage's gwmi does
 * (it divides both to seconds first; the ratio is identical). Entries older
 * than `CPU_HISTORY_MAX_AGE_MS` are pruned each tick so the map can't grow
 * without bound as pids come and go.
 */
interface WindowsCpuHistoryEntry {
	processIdentity: string;
	cpuMs: number;
	ts: number;
}
const windowsCpuHistory = new Map<string, WindowsCpuHistoryEntry>();
const CPU_HISTORY_MAX_AGE_MS = 60_000;
const CPU_HISTORY_MAX_ENTRIES = 4_096;

/**
 * TEST-ONLY: clear the Windows CPU%-history so a test's two-sample CPU%
 * assertion starts from a known-empty state (module-level state otherwise
 * persists across tests in the same worker).
 */
export function __resetWindowsCpuHistoryForTests(): void {
	windowsCpuHistory.clear();
}

export function __windowsCpuHistorySizeForTests(): number {
	return windowsCpuHistory.size;
}

export function __windowsCpuHistoryHasForTests(
	pid: number,
	processIdentity: string,
): boolean {
	return windowsCpuHistory.has(`${pid}:${processIdentity}`);
}

/**
 * Windows-only CPU%/RSS sampling via a FULLY GUARDED `Get-CimInstance
 * Win32_Process` query (mirrors `findDescendantPidsWindows`): a synchronous
 * throw from `spawn` (the `spawn UNKNOWN` crash vector, #620), a `child`
 * `error` event, or a non-zero/garbage exit all resolve to an errored/absent
 * map — this function can NEVER throw or reject. Deliberately does NOT call
 * `pidusage`, whose unguarded internal `gwmi` spawn is the crash we're fixing.
 *
 * RSS comes from `WorkingSetSize`; CPU% from `KernelModeTime`+`UserModeTime`
 * (both in 100 ns units → ms via `/1e4`) differenced against this pid's prior
 * sample over the elapsed wall time — the same computation pidusage's gwmi
 * path uses. The first time a pid is seen it has no prior sample, so CPU% is
 * reported as 0 for that tick and a real rate lands on the next one.
 */
async function sampleProcessesWindows(
	valid: number[],
): Promise<Map<number, ProcessUsage> | null> {
	const samples = new Map<number, ProcessUsage>();
	if (valid.length === 0) return samples;

	// pids are pre-validated finite positive integers, so this WQL filter is
	// injection-safe. One line per pid: "pid,workingSet,kernel100ns,user100ns,creationDate".
	const filter = valid.map((p) => `ProcessId=${p}`).join(" or ");
	const psScript =
		`Get-CimInstance Win32_Process -Filter "${filter}" ` +
		"| Select-Object -Property ProcessId,WorkingSetSize,KernelModeTime,UserModeTime,CreationDate " +
		'| ForEach-Object { "$($_.ProcessId),$($_.WorkingSetSize),$($_.KernelModeTime),$($_.UserModeTime),$($_.CreationDate)" }';

	const powershell = windowsExe("WindowsPowerShell\\v1.0\\powershell.exe");
	// Fire-and-forget, per-poll-tick spawn (#1155): `spawnCollectStdout` unrefs
	// the child AND its piped stdout so this one-shot CIM query can never keep
	// a settled `pi --print` process alive past its own close — mirrors the
	// reaper's identical spawn→collect plumbing (#1153/#1160). It also absorbs
	// both failure modes this function used to guard inline — a synchronous
	// `spawn` throw (the `spawn UNKNOWN` crash vector, #620) and an async
	// `error` event, or a non-zero exit — the result status keeps failure distinct
	// map. Sampling still works normally in an interactive/long-lived
	// session: unref only means "don't hold the loop open FOR this alone."
	const query = await spawnCollectStdoutResult(
		powershell,
		["-NoProfile", "-NonInteractive", "-Command", psScript],
		{ shell: false, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
		{
			timeoutMs: RESOURCE_SAMPLE_QUERY_TIMEOUT_MS,
			onTimeout: (child) => terminateScannerChild(child, {}),
		},
	);
	if (query.status !== "ok") {
		recordQueryFailure("windows-process-table", query.status, query.exitCode);
		return null;
	}
	try {
		const now = Date.now();
		const seen = new Set<number>();
		for (const line of query.stdout.split(/\r?\n/)) {
			const parts = line.split(",");
			if (parts.length < 5) continue;
			if (parts.slice(0, 5).some((part) => part.trim().length === 0)) continue;
			const pid = Number(parts[0]);
			const workingSet = Number(parts[1]);
			const kernel100ns = Number(parts[2]);
			const user100ns = Number(parts[3]);
			const processIdentity = parts.slice(4).join(",").trim();
			if (!Number.isFinite(pid) || pid <= 0) continue;
			if (
				!Number.isFinite(workingSet) ||
				workingSet < 0 ||
				!Number.isFinite(kernel100ns) ||
				kernel100ns < 0 ||
				!Number.isFinite(user100ns) ||
				user100ns < 0 ||
				processIdentity.length === 0
			)
				continue;

			const cpuMs = Math.round(kernel100ns / 1e4) + Math.round(user100ns / 1e4);
			const historyKey = `${pid}:${processIdentity}`;
			// A reused PID must start a fresh rate window. Drop every prior identity
			// for this PID before looking up the current one.
			for (const [key, prior] of windowsCpuHistory) {
				if (
					prior.processIdentity !== processIdentity &&
					key.startsWith(`${pid}:`)
				) {
					windowsCpuHistory.delete(key);
				}
			}
			const prev = windowsCpuHistory.get(historyKey);
			if (prev && cpuMs < prev.cpuMs) {
				// A counter reset is not a flat sample. Retire the baseline so the
				// next valid observation starts a new rate window.
				windowsCpuHistory.delete(historyKey);
				continue;
			}
			let cpuPercent = 0;
			if (prev) {
				const wallMs = now - prev.ts;
				if (wallMs > 0) {
					cpuPercent = ((cpuMs - prev.cpuMs) / wallMs) * 100;
					if (!Number.isFinite(cpuPercent) || cpuPercent < 0) cpuPercent = 0;
				}
			}
			windowsCpuHistory.set(historyKey, { processIdentity, cpuMs, ts: now });
			seen.add(pid);
			samples.set(pid, { rssBytes: workingSet, cpuPercent });
		}
		// Prune stale history so pids that have gone away don't accumulate.
		for (const [key, entry] of windowsCpuHistory) {
			const pid = Number(key.slice(0, key.indexOf(":")));
			if (!seen.has(pid) && now - entry.ts > CPU_HISTORY_MAX_AGE_MS) {
				windowsCpuHistory.delete(key);
			}
		}
		while (windowsCpuHistory.size > CPU_HISTORY_MAX_ENTRIES) {
			let oldestKey: string | undefined;
			let oldestTs = Number.POSITIVE_INFINITY;
			for (const [key, entry] of windowsCpuHistory) {
				if (entry.ts < oldestTs) {
					oldestKey = key;
					oldestTs = entry.ts;
				}
			}
			if (oldestKey === undefined) break;
			windowsCpuHistory.delete(oldestKey);
		}
	} catch {
		// Parsing must never throw into the caller; best-effort.
	}
	return samples;
}

/**
 * Sample CPU%/RSS for a set of pids. Best-effort: a pid that can't be resolved
 * (already exited, permission denied, spawn failed, etc.) is simply absent
 * from the returned map — callers MUST treat "absent" as "unsampled this
 * tick", never as zero usage.
 *
 * On Windows this uses a guarded CIM query (`sampleProcessesWindows`) and
 * never touches `pidusage`, whose unguarded internal spawn could crash the
 * host (#620, #533). On Linux/macOS it uses `pidusage`.
 */
export async function sampleProcesses(
	pids: number[],
): Promise<Map<number, ProcessUsage> | null> {
	const result = new Map<number, ProcessUsage>();
	const valid = [...new Set(pids.filter((p) => Number.isFinite(p) && p > 0))];
	if (valid.length === 0) return result;

	if (runningOnWindows()) {
		// Fully guarded; cannot throw/reject.
		return await sampleProcessesWindows(valid);
	}

	try {
		const stats = await pidusage(valid);
		for (const pid of valid) {
			const stat = stats[String(pid)];
			if (!stat) continue; // pidusage couldn't resolve this pid — leave absent
			if (
				!Number.isFinite(stat.cpu) ||
				stat.cpu < 0 ||
				!Number.isFinite(stat.memory) ||
				stat.memory < 0
			)
				continue;
			result.set(pid, {
				rssBytes: stat.memory,
				cpuPercent: stat.cpu,
			});
		}
	} catch {
		recordQueryFailure("posix-pidusage-process-table", "spawn-error");
		// Best-effort: sampling failure loses this tick's data for every pid in
		// the batch, but must never throw into the heartbeat/spawn path.
		return null;
	}
	return result;
}

/**
 * PURE peak/average accumulator over a stream of {cpuPercent, rssBytes}
 * samples. No I/O, no timers — unit-testable by feeding it samples directly.
 */
export class UsageAccumulator {
	private sampleCount = 0;
	private cpuSum = 0;
	private rssSum = 0;
	private cpuPeak = 0;
	private rssPeak = 0;

	addSample(usage: ProcessUsage): void {
		this.sampleCount++;
		this.cpuSum += usage.cpuPercent;
		this.rssSum += usage.rssBytes;
		if (usage.cpuPercent > this.cpuPeak) this.cpuPeak = usage.cpuPercent;
		if (usage.rssBytes > this.rssPeak) this.rssPeak = usage.rssBytes;
	}

	get count(): number {
		return this.sampleCount;
	}

	summarize(): {
		sampleCount: number;
		avgCpuPercent: number;
		peakCpuPercent: number;
		avgRssBytes: number;
		peakRssBytes: number;
	} | null {
		if (this.sampleCount === 0) return null;
		return {
			sampleCount: this.sampleCount,
			avgCpuPercent: this.cpuSum / this.sampleCount,
			peakCpuPercent: this.cpuPeak,
			avgRssBytes: this.rssSum / this.sampleCount,
			peakRssBytes: this.rssPeak,
		};
	}
}

export interface SpawnUsageSummary {
	sampleCount: number;
	avgCpuPercent: number;
	peakCpuPercent: number;
	avgRssBytes: number;
	peakRssBytes: number;
}

/**
 * Brackets one transient spawn with a short-interval poll. Usage:
 *
 *   const sampler = startSpawnUsageSampler(child.pid);
 *   child.on("close", () => {
 *     const usage = sampler.stop(); // null if never got a single sample
 *   });
 *
 * `intervalMs` defaults to 750ms — inside the issue's suggested 500ms-1s
 * band, cheap enough not to become a new source of measurable overhead for
 * the (usually sub-few-second) analyzer children this brackets. Best-effort:
 * a poll tick that throws (pid already gone, sampling error) is silently
 * skipped — it never stops the timer or the spawn early, and `stop()` is
 * always safe to call even if zero samples ever landed.
 *
 * Windows note: `clients/safe-spawn.ts` spawns with `shell: true` on Windows,
 * so `pid` here is `cmd.exe`'s pid, not the real tool's — sampling it alone
 * would report near-zero usage for the whole invocation. Each Windows tick
 * resolves `pid`'s live descendant tree (`findDescendantPidsWindows`) and
 * sums usage across `pid` + every descendant, so a `node`/`npx`-wrapped tool
 * (or one that re-execs itself) is actually captured. POSIX spawns are
 * unwrapped (`shell: false`), so `pid` there is already the real tool.
 */
export interface ProcessTreeCpuSample {
	/** True when the process tree burned CPU above the liveness floor. */
	busy: boolean;
	/** True when at least one CPU sample resolved (a real measurement). */
	measured: boolean;
	/** Highest summed CPU% across pid + descendants, or null when unmeasurable. */
	cpuPercent: number | null;
}

/**
 * #2358: sample a live process tree twice across a short window and answer
 * whether it burned CPU above `floorPercent`.
 *
 * The notify-stall breaker uses this to tell a BUSY server (burning a core
 * while it drains a burst) from a genuinely DEAD input path (flat CPU), and
 * only tears the latter down. It reuses the same platform machinery as
 * `startSpawnUsageSampler`: on Windows the direct child may be a `cmd`/`.cmd`
 * shim that does no work itself, so the live descendant tree resolves once per
 * read and CPU% is summed across it.
 *
 * Best-effort like every other export here: a failed query loses a data point,
 * it never throws, and it never blocks for longer than the query timeouts plus
 * `windowMs`. The target itself must resolve for `measured` to be true;
 * missing descendants are partial but valid evidence. An unmeasurable target
 * answers `{ busy: false, measured: false }` for the caller to classify.
 */
export async function sampleProcessTreeCpuPercent(
	pid: number | undefined,
	windowMs = 1200,
	floorPercent = 10,
): Promise<ProcessTreeCpuSample> {
	if (!Number.isFinite(pid) || (pid as number) <= 0) {
		return { busy: false, measured: false, cpuPercent: null };
	}
	const targetPid = pid as number;
	const readOnce = async (): Promise<{
		cpuPercent: number;
		measured: boolean;
	} | null> => {
		try {
			const descendants = runningOnWindows()
				? await findDescendantPidsWindows(targetPid)
				: [];
			if (descendants === null) return null;
			const pids = runningOnWindows()
				? [targetPid, ...descendants]
				: [targetPid];
			const usageByPid = await sampleProcesses(pids);
			if (usageByPid === null) return null;
			const targetUsage = usageByPid.get(targetPid);
			if (!targetUsage) return { cpuPercent: 0, measured: false };
			let cpuPercent = 0;
			for (const usage of usageByPid.values()) cpuPercent += usage.cpuPercent;
			return { cpuPercent, measured: true };
		} catch {
			return null;
		}
	};
	// The FIRST read populates the per-pid CPU history on Windows (a fresh pid
	// reports 0%; the rate lands on the next read), so the second read is the
	// one that carries the liveness verdict. Both reads must retain the target;
	// disappearance or query failure is explicitly unmeasured, never flat.
	const first = await readOnce();
	const second = await new Promise<{
		cpuPercent: number;
		measured: boolean;
	} | null>((resolve) => {
		const timer = setTimeout(() => {
			void readOnce().then(resolve);
		}, windowMs);
		timer.unref?.();
	});
	if (first === null && second === null) {
		return { busy: false, measured: false, cpuPercent: null };
	}
	if (
		first === null ||
		second === null ||
		!first.measured ||
		!second.measured
	) {
		return { busy: false, measured: false, cpuPercent: null };
	}
	const observed = Math.max(first.cpuPercent, second.cpuPercent);
	return {
		busy: observed > floorPercent,
		measured: true,
		cpuPercent: observed,
	};
}

export function startSpawnUsageSampler(
	pid: number | undefined,
	intervalMs = 750,
): { stop: () => SpawnUsageSummary | null } {
	if (!Number.isFinite(pid) || (pid as number) <= 0) {
		return { stop: () => null };
	}
	const targetPid = pid as number;
	const accumulator = new UsageAccumulator();
	let stopped = false;

	const tick = async () => {
		if (stopped) return;
		try {
			const descendants = runningOnWindows()
				? await findDescendantPidsWindows(targetPid)
				: [];
			if (descendants === null) return;
			const pids = runningOnWindows()
				? [targetPid, ...descendants]
				: [targetPid];
			const usageByPid = await sampleProcesses(pids);
			if (usageByPid === null) return;
			if (stopped || usageByPid.size === 0) return;
			let rssBytes = 0;
			let cpuPercent = 0;
			for (const usage of usageByPid.values()) {
				rssBytes += usage.rssBytes;
				cpuPercent += usage.cpuPercent;
			}
			accumulator.addSample({ rssBytes, cpuPercent });
		} catch {
			// Best-effort: a failed poll tick just misses one sample.
		}
	};

	// Fire one tick immediately (short-lived children can exit before the
	// first interval elapses) plus a recurring poll.
	void tick();
	const timer = setInterval(() => {
		void tick();
	}, intervalMs);
	// Never let this timer keep the process alive on its own.
	timer.unref?.();

	return {
		stop(): SpawnUsageSummary | null {
			if (stopped) return accumulator.summarize();
			stopped = true;
			clearInterval(timer);
			return accumulator.summarize();
		},
	};
}
