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
 * Uses `pidusage` (not a hand-rolled `/proc` vs `wmic`/perf-counters split):
 * Windows, macOS, and Linux each expose process CPU/RSS differently at the OS
 * level, and pidusage already abstracts that (procfs on Linux, `ps` on macOS,
 * PowerShell `Get-WmiObject`/CIM on Windows — not the deprecated `wmic.exe`
 * binary). It's a small pure-JS package (one transitive dep, `safe-buffer`),
 * so it bundles like the repo's other pure-JS runtime deps (minimatch,
 * js-yaml) rather than needing an EXTERNAL entry in scripts/bundle-dist.mjs.
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

import { spawn as nodeSpawn } from "node:child_process";
import * as path from "node:path";
import pidusage from "pidusage";

const isWindows = process.platform === "win32";

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
async function findDescendantPidsWindows(rootPid: number): Promise<number[]> {
	if (!isWindows || !Number.isFinite(rootPid) || rootPid <= 0) return [];
	// One WQL query pulls every process's (pid, parentPid) pair; walk the BFS
	// in JS rather than issuing N queries for N tree levels.
	const psScript =
		"Get-CimInstance Win32_Process " +
		'| Select-Object -Property ProcessId,ParentProcessId ' +
		'| ForEach-Object { "$($_.ProcessId),$($_.ParentProcessId)" }';
	const pairs = await new Promise<Array<[number, number]>>((resolve) => {
		try {
			const powershell = path.join(
				process.env.SystemRoot ?? String.raw`C:\Windows`,
				"WindowsPowerShell",
				"v1.0",
				"powershell.exe",
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
				const result: Array<[number, number]> = [];
				for (const line of out.split(/\r?\n/)) {
					const [pidStr, ppidStr] = line.split(",");
					const pid = Number(pidStr);
					const ppid = Number(ppidStr);
					if (Number.isFinite(pid) && Number.isFinite(ppid)) {
						result.push([pid, ppid]);
					}
				}
				resolve(result);
			});
		} catch {
			resolve([]);
		}
	});

	return walkDescendantPids(rootPid, pairs);
}

/**
 * Sample CPU%/RSS for a set of pids in one batched `pidusage` call.
 * Best-effort: a pid pidusage can't resolve (already exited, permission
 * denied, etc.) is simply absent from the returned map — callers must treat
 * "absent" as "unsampled this tick", never as zero usage.
 */
export async function sampleProcesses(
	pids: number[],
): Promise<Map<number, ProcessUsage>> {
	const result = new Map<number, ProcessUsage>();
	const valid = [...new Set(pids.filter((p) => Number.isFinite(p) && p > 0))];
	if (valid.length === 0) return result;
	try {
		const stats = await pidusage(valid);
		for (const pid of valid) {
			const stat = stats[String(pid)];
			if (!stat) continue; // pidusage couldn't resolve this pid — leave absent
			result.set(pid, {
				rssBytes: stat.memory,
				cpuPercent: stat.cpu,
			});
		}
	} catch {
		// Best-effort: sampling failure loses this tick's data for every pid in
		// the batch, but must never throw into the heartbeat/spawn path.
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
			const pids = isWindows
				? [targetPid, ...(await findDescendantPidsWindows(targetPid))]
				: [targetPid];
			const usageByPid = await sampleProcesses(pids);
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
