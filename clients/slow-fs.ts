/**
 * Slow-filesystem detection (#462).
 *
 * On WSL 9p mounts (`/mnt/c/...`), synchronous file-tree walks freeze the pi
 * TUI: each `stat`/`readdir` costs ~1.3ms over 9p vs ~17µs native (measured
 * anchor on a Windows host running WSL2 — a 75x slowdown). A 5,000-file sync
 * walk on 9p costs ~6.5s of stat time alone, all on the event loop.
 *
 * This module classifies the workspace by MEASUREMENT, not path shape (no
 * `/mnt/` string-sniffing — that misses drvfs/NFS/SMB and false-positives on
 * fast 9p configurations). A cheap latency probe times a handful of
 * `fs.statSync` calls under the project root at session start; if the median
 * exceeds a threshold, the workspace is flagged "slow FS" for the rest of the
 * process, and callers route sync tree walks to reduced caps / async
 * collectors instead.
 *
 * Escape hatches:
 *   - `PI_LENS_ALLOW_SLOW_FS_SCAN=1` — disable slow-FS mode entirely (full
 *     normal behavior even when the probe would flag the FS as slow).
 *   - `PI_LENS_FORCE_SLOW_FS=1` — force slow-FS mode on regardless of the
 *     probe (testing/CI, or a user who knows their FS is slow but the probe
 *     under-fires).
 *   - `PI_LENS_SLOW_FS_THRESHOLD_US` — override the median-microseconds
 *     threshold (default 500).
 *
 * Follows the lazy-memoized-config house style (see `runtime-config.ts`): env
 * values are read lazily at call time, not module load, and `Number(...)` is
 * gated through `Number.isFinite` before use.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { toPositiveFinite } from "./env-utils.js";
import { normalizeFilePath } from "./path-utils.js";

/** Default median-stat threshold (microseconds) above which a workspace is
 * classified as slow FS. Measured anchor: 9p ≈ 1300µs/stat, native NTFS/ext4
 * < 200µs/stat — 500µs sits well between the two. */
export const DEFAULT_SLOW_FS_THRESHOLD_US = 500;

/** Cap on how many entries the probe stats — keeps the probe itself cheap
 * (15 stats x ~1.3ms worst case is still well under 50ms). */
const PROBE_SAMPLE_CAP = 15;

export interface SlowFsProbeResult {
	slow: boolean;
	medianStatMicros: number;
	samples: number;
}

function resolveThresholdMicros(): number {
	const envValue = toPositiveFinite(process.env.PI_LENS_SLOW_FS_THRESHOLD_US);
	return envValue > 0 ? envValue : DEFAULT_SLOW_FS_THRESHOLD_US;
}

function median(values: number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0
		? (sorted[mid - 1] + sorted[mid]) / 2
		: sorted[mid];
}

/**
 * Time up to `PROBE_SAMPLE_CAP` `fs.statSync` calls on entries directly under
 * `rootDir` and return the median per-stat cost in microseconds. Wrapped
 * entirely in try/catch: any failure (missing dir, permission error, empty
 * dir) yields `slow: false` — a probe failure must never itself degrade
 * behavior.
 */
export function probeSlowFs(rootDir: string): SlowFsProbeResult {
	try {
		const resolvedRoot = path.resolve(rootDir);
		const entries = fs.readdirSync(resolvedRoot).slice(0, PROBE_SAMPLE_CAP);
		if (entries.length === 0) {
			return { slow: false, medianStatMicros: 0, samples: 0 };
		}

		const samplesMicros: number[] = [];
		for (const entry of entries) {
			const fullPath = path.join(resolvedRoot, entry);
			const startedAt = process.hrtime.bigint();
			try {
				fs.statSync(fullPath);
			} catch {
				continue; // vanished / permission-denied entry — skip, don't count
			}
			const elapsedNs = process.hrtime.bigint() - startedAt;
			samplesMicros.push(Number(elapsedNs) / 1000);
		}

		if (samplesMicros.length === 0) {
			return { slow: false, medianStatMicros: 0, samples: 0 };
		}

		const medianStatMicros = median(samplesMicros);
		const threshold = resolveThresholdMicros();
		return {
			slow: medianStatMicros > threshold,
			medianStatMicros,
			samples: samplesMicros.length,
		};
	} catch {
		return { slow: false, medianStatMicros: 0, samples: 0 };
	}
}

/** Process-lifetime memo of the slow-FS verdict, keyed by normalized cwd so
 * `/` vs `\` inputs share one entry (see path-key invariant tests). */
const slowFsVerdictCache = new Map<string, SlowFsProbeResult>();

/**
 * Resolve (and memoize) the slow-FS verdict for `cwd`. Resolution order:
 *   1. `PI_LENS_ALLOW_SLOW_FS_SCAN=1` — kill switch, always false.
 *   2. `PI_LENS_FORCE_SLOW_FS=1` — always true, probe skipped entirely.
 *   3. Measured probe (memoized per cwd for the process lifetime).
 */
export function getSlowFsVerdict(cwd: string): SlowFsProbeResult {
	if (process.env.PI_LENS_ALLOW_SLOW_FS_SCAN === "1") {
		return { slow: false, medianStatMicros: 0, samples: 0 };
	}
	if (process.env.PI_LENS_FORCE_SLOW_FS === "1") {
		return { slow: true, medianStatMicros: 0, samples: 0 };
	}

	const key = normalizeFilePath(path.resolve(cwd));
	const cached = slowFsVerdictCache.get(key);
	if (cached) return cached;

	const result = probeSlowFs(cwd);
	slowFsVerdictCache.set(key, result);
	return result;
}

/** Convenience predicate for call sites that only need the boolean verdict. */
export function isSlowFs(cwd: string): boolean {
	return getSlowFsVerdict(cwd).slow;
}

/** Test-only: clear the memoized verdict cache so a subsequent call re-probes
 * (or re-reads the env kill switches). */
export function _resetSlowFsForTests(): void {
	slowFsVerdictCache.clear();
}

/** Reduced sync `maxFiles` cap applied in slow-FS mode (env override is
 * deliberately NOT supported per #462's design — this is a safety clamp, not
 * a tuning knob). */
export const SLOW_FS_REDUCED_MAX_FILES = 500;

/** Human-readable degradation notice surfaced once per session when slow-FS
 * mode engages, so a user never sees a silently-empty scan result. */
export function slowFsDegradationNotice(): string {
	return "slow filesystem detected (set PI_LENS_ALLOW_SLOW_FS_SCAN=1 to override)";
}
