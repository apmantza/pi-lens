/**
 * Shared atomic tmp+rename file writer (closes #762).
 *
 * The `${target}.tmp-${process.pid}` + `renameSync` shape was independently
 * hand-rolled in five places (`instance-registry.ts`, `session-state-store.ts`,
 * `recent-touches.ts`, `review-graph/builder.ts`, `diagnostic-dispositions.ts`)
 * as each one picked up the need for a cross-process reader to never observe a
 * partially-written file: `rename()` replaces the destination atomically on
 * both POSIX and Windows (libuv uses `MOVEFILE_REPLACE_EXISTING`), so a
 * concurrent reader always sees either the fully-old or fully-new file, never
 * a torn write. Five independent copies of the same shape invite drift (e.g.
 * forgetting the tmp-file cleanup on the failure path) — this module is the
 * single implementation the rest re-use.
 *
 * Per-write-site error policy varies and is NOT a detail this helper should
 * paper over:
 *
 *   - `bestEffort: true` (the default, and the majority of today's sites): a
 *     write or rename failure just means this update is lost — swallow it,
 *     after a best-effort tmp-file cleanup. Appropriate for observability
 *     substrate (instance registry, recent-touches, review-graph cache,
 *     session widget state) where a dropped write is, at worst, a stale/
 *     missing sample.
 *   - `bestEffort: false`: rethrow the failure (after the same best-effort tmp
 *     cleanup). This is `clients/diagnostic-dispositions.ts`'s policy (#757):
 *     unlike the writers above, a disposition mark is functionally
 *     load-bearing — a silently lost mark is a correctness bug, not a dropped
 *     observability sample — so callers must see the failure rather than have
 *     it swallowed. See the #757 CHANGELOG entry for the full reasoning.
 */

import * as fs from "node:fs";

export interface WriteFileAtomicOptions {
	/**
	 * `true` (default): swallow write/rename failures after best-effort tmp
	 * cleanup — the update is simply lost. `false`: rethrow the failure after
	 * the same best-effort cleanup (the #757 disposition-store policy).
	 */
	bestEffort?: boolean;
}

/**
 * Synchronous atomic write: `fs.writeFileSync` to `${targetPath}.tmp-${pid}`,
 * then `fs.renameSync` over `targetPath`. On any failure (from either step),
 * attempts a best-effort `fs.rmSync(tmp, { force: true })` cleanup, then
 * either swallows (default) or rethrows per `options.bestEffort`.
 *
 * Does not create the parent directory — callers that need one must
 * `mkdirSync` before calling this (matches every existing call site, which
 * already does its own mkdir as a separate step).
 */
export function writeFileAtomic(
	targetPath: string,
	data: string,
	options?: WriteFileAtomicOptions,
): void {
	const bestEffort = options?.bestEffort ?? true;
	const tmpPath = `${targetPath}.tmp-${process.pid}`;
	try {
		fs.writeFileSync(tmpPath, data, "utf-8");
		fs.renameSync(tmpPath, targetPath);
	} catch (err) {
		try {
			fs.rmSync(tmpPath, { force: true });
		} catch {
			// ignore — best-effort cleanup of our own tmp file
		}
		if (!bestEffort) throw err;
	}
}

/**
 * Async counterpart of {@link writeFileAtomic}, built on `fs.promises` instead
 * of the sync `fs` API — for call sites that must not block the event loop
 * (e.g. writes on a hot per-turn/per-touch path). Same tmp-naming, cleanup,
 * and `bestEffort` semantics.
 */
export async function writeFileAtomicAsync(
	targetPath: string,
	data: string,
	options?: WriteFileAtomicOptions,
): Promise<void> {
	const bestEffort = options?.bestEffort ?? true;
	const tmpPath = `${targetPath}.tmp-${process.pid}`;
	try {
		await fs.promises.writeFile(tmpPath, data, "utf-8");
		await fs.promises.rename(tmpPath, targetPath);
	} catch (err) {
		try {
			await fs.promises.rm(tmpPath, { force: true });
		} catch {
			// ignore — best-effort cleanup of our own tmp file
		}
		if (!bestEffort) throw err;
	}
}
