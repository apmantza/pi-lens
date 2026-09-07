// Single source of truth for how many Vitest forks may run at once, and how
// much V8 heap each one gets. `vitest.config.ts` calls this; nothing else
// computes those numbers.
//
// #2042. The suite was OOM-killed on ubuntu-latest (exit 137, SIGKILL, zero
// failing assertions). Two host-specific constants were applied unconditionally
// to CI:
//
//   - `maxWorkers` was left undefined on CI, so Vitest resolved it to
//     `availableParallelism() - 1`. That bounds worker COUNT, which is not the
//     axis that grows.
//   - `--max-old-space-size=4096` was tuned on a 32-core / 68 GB dev host, with
//     the comment "4 GB x workers << host RAM". On a shared CI runner that
//     inequality does not hold.
//
// Measured on 2026-08-25 with a per-file `process.resourceUsage().maxRSS` probe
// over all 740 files of the default project. Peak RSS per file: p50 93 MB, p90
// 389 MB, p99 1405 MB, max 2267 MB, and 42 files above 1 GB. That tail is
// NATIVE memory, not V8 heap -- `tree-sitter-imports.test.ts` peaked at 1601 MB
// RSS while reporting 33 MB heapUsed, because tree-sitter wasm grammar compiles
// and @ast-grep/napi arenas live outside V8's accounting. So
// `--max-old-space-size` cannot bound the growing axis, and `maxWorkers` bounds
// the wrong one. Dividing the host's real memory by a measured per-worker peak
// is the lever that fits.
//
// PROVENANCE OF THOSE NUMBERS, because it matters for how much to trust them:
// they were measured on the DEV host (Windows, 16 cores, 15.6 GB), not on the
// runner. The first `[mem-file]` lines from CI show Linux running roughly three
// times leaner on the same files -- `tree-sitter-imports.test.ts` peaks at
// 580 MB there against 1601 MB here, and 7 files clear 512 MB on CI against 42
// clearing 1 GB on the dev host. So WORKER_PEAK_RSS_BUDGET_MB is conservative
// against the profile it actually governs: it reserves more per worker than a
// CI fork needs, which errs toward fewer workers. That is the safe direction,
// but it is an unvalidated constant on Linux, and it should be re-derived from
// accumulated `[mem-file]` data rather than treated as settled.

/**
 * Per-worker peak-RSS budget, in MB: the measured p99 (1405 MB) rounded up to
 * the next power of two. A worker that exceeds it is a tail file, and the point
 * of the budget is that the host can still hold `maxWorkers` of them at once.
 */
export const WORKER_PEAK_RSS_BUDGET_MB = 2048;

/**
 * Memory the run needs OUTSIDE the forks: Vitest's own main process (it holds
 * the module graph and per-file reporter state for 740 files, measured above
 * 1 GB), npm, and the real tool and LSP child processes the suite spawns, plus
 * OS headroom.
 */
export const NON_WORKER_RESERVE_MB = 3072;

/** Local default, unchanged from the pre-#2042 measured posture. */
const LOCAL_MAX_WORKERS = "50%";

/** Per-fork V8 heap ceiling on a host with room for it (pre-#2042 value). */
export const MAX_WORKER_HEAP_MB = 4096;

/**
 * Floor for the per-fork V8 heap ceiling. NOT a memory-budget number -- it is a
 * correctness constraint: the heaviest file measured 2067 MB of live V8 heap
 * (`tests/monorepo/cross-package-graph.test.ts`), so a ceiling near or below
 * that turns a green suite red. The budget below may never go under it.
 */
export const MIN_WORKER_HEAP_MB = 3072;

/**
 * @param {{ totalMemMb: number, cpus: number, ci: boolean, workerOverride?: number, heapOverride?: number }} host
 * @returns {{ maxWorkers: number | string, heavyMaxWorkers: number, heapMb: number, cpuCap: number, memCap: number }}
 */
export function resolveTestWorkerBudget(host) {
	const { totalMemMb, cpus, ci, workerOverride, heapOverride } = host;

	// Vitest's own default for a non-watch run, reproduced here so the memory
	// budget can only ever LOWER the concurrency, never raise it.
	const cpuCap = Math.max(1, cpus - 1);
	const memCap = Math.max(
		1,
		Math.floor(
			(totalMemMb - NON_WORKER_RESERVE_MB) / WORKER_PEAK_RSS_BUDGET_MB,
		),
	);

	const ciWorkers = Math.min(cpuCap, memCap);
	const maxWorkers = ci ? ciWorkers : workerOverride || LOCAL_MAX_WORKERS;

	// The heavy phase's files each peaked at 1.4-3.9 GB, above the general
	// budget, so on CI it runs at half the general concurrency (floor 1). Locally
	// it stays the plain pre-#2042 literal 2: deriving it from core count bought
	// nothing and silently changed the local posture to 1 on a 1-3 core box.
	const heavyMaxWorkers = ci ? Math.max(1, Math.floor(ciWorkers / 2)) : 2;

	// Per-fork V8 heap ceiling: aim at half the host's memory shared between the
	// concurrent forks, then clamp. The clamp usually wins, and that is the
	// honest picture — one real file holds 2067 MB of live heap, so the floor
	// cannot go much lower without turning a green suite red. What the aim buys
	// is the CI case: a 16 GB runner resolves to 3072 instead of the flat 4096
	// tuned on a 68 GB dev host, which is a quarter off the permitted aggregate
	// and, more usefully, makes a runaway fork die on its OWN heap limit — with
	// Node's report naming the file — before the OS kills the whole run.
	//
	// CI only. A local run keeps the pre-#2042 4096 outright: the dev host it
	// was measured on is the one host where the original reasoning holds, and
	// #2042 is a CI failure that has no business changing what a developer runs.
	const heapMb =
		heapOverride ||
		(ci
			? Math.max(
					MIN_WORKER_HEAP_MB,
					Math.min(MAX_WORKER_HEAP_MB, Math.floor(totalMemMb / 2 / ciWorkers)),
				)
			: MAX_WORKER_HEAP_MB);

	return { maxWorkers, heavyMaxWorkers, heapMb, cpuCap, memCap };
}

/**
 * One line, on CI only, naming the host and the decision. Without it an exit
 * 137 says nothing about what the run was allowed to use.
 *
 * @param {{ totalMemMb: number, cpus: number }} host
 * @param {{ maxWorkers: number | string, heavyMaxWorkers: number, heapMb: number, cpuCap: number, memCap: number }} budget
 * @returns {string}
 */
export function formatTestWorkerBudget(host, budget) {
	return (
		`[test-budget] cpus=${host.cpus} totalMemMb=${host.totalMemMb} ` +
		`cpuCap=${budget.cpuCap} memCap=${budget.memCap} ` +
		`maxWorkers=${budget.maxWorkers} heavyMaxWorkers=${budget.heavyMaxWorkers} ` +
		`workerHeapMb=${budget.heapMb}`
	);
}
