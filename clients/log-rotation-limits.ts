/**
 * The log rotation threshold, in its own leaf (#5702).
 *
 * This module deliberately imports NOTHING: every `*-logger.ts` module reads
 * this value at module load, and those modules are imported from everywhere —
 * including by `clients/log-cleanup.ts`'s own graph (its retention sweep
 * reaches `file-utils.ts`, `mcp/ipc.ts` and `session-state-store.ts`, whose
 * graphs reach the loggers back). Keeping the threshold here breaks the
 * `loggers -> log-cleanup -> owners -> loggers` cycle at its thinnest edge,
 * the same shape `clients/bounded-cache.ts` and the other declared leaves
 * exist for (#2504): a heavyweight importer reaches a small shared primitive
 * without dragging the primitive's owner's graph along.
 */

/** Rotation threshold for every active `~/.pi-lens/*.log`, in MB. */
export function getMaxLogSizeMB(): number {
	return Math.max(
		1,
		Number.parseInt(process.env.PI_LENS_MAX_LOG_SIZE_MB ?? "10", 10) || 10,
	);
}
