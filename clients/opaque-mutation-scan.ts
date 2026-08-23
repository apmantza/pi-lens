/**
 * Opaque-mutation recovery (#2000 phase 2, PR-A).
 *
 * A bash command whose writes are NOT recognized by
 * `extractWrittenPathsFromCommand` (python/node/perl/PowerShell internal
 * writes, restores) previously bypassed dispatch AND read-guard authorship.
 * This module provides the bounded observation seam:
 *
 * - `captureFileStats` snapshots {mtimeMs, size} over the bounded project
 *   source universe BEFORE the command runs (stat-only; cooperative budget);
 * - `diffFileStats` produces the changed-path set AFTER;
 * - `OpaqueSnapshotStore` holds at most ONE pending pre-snapshot per cwd —
 *   a newer bash call replaces an unconsumed one (counted), so the store is
 *   bounded by construction and never grows with session length (shape 9).
 *
 * Budget exhaustion or a missing snapshot yields an explicit UNKNOWN verdict
 * to the caller — never a clean claim (issue invariant 3). All stat keys use
 * normalizeMapKey+resolve, joining the mutation-seam's key form.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { collectSourceFilesWithBudgetAsync } from "./source-filter.js";
import { normalizeMapKey } from "./path-utils.js";

export interface FileStatEntry {
	mtimeMs: number;
	size: number;
}

export type FileStatsSnapshot = Map<string, FileStatEntry>;

/** Hard cap on scanned files — beyond it the verdict is coverage-unknown. */
export const OPAQUE_SCAN_MAX_FILES = 2000;

export interface CaptureOutcome {
	snapshot?: FileStatsSnapshot;
	/** Why no usable snapshot was produced (then snapshot is undefined). */
	unknownReason?: "walk-failed" | "file-cap-exceeded" | "entry-budget-exceeded";
	scannedCount: number;
}

export async function captureFileStats(
	root: string,
	budgetMs = 50,
): Promise<CaptureOutcome> {
	try {
		const walk = await collectSourceFilesWithBudgetAsync(root, {
			maxFiles: OPAQUE_SCAN_MAX_FILES + 1,
			budgetMs,
		});
		const files = walk.files;
		if (walk.entryBudgetExceeded || files.length > OPAQUE_SCAN_MAX_FILES) {
			// A PARTIAL universe must never read as a confident diff (invariant 3):
			// writes in the unvisited tail would silently vanish.
			return {
				unknownReason: walk.entryBudgetExceeded
					? "entry-budget-exceeded"
					: "file-cap-exceeded",
				scannedCount: files.length,
			};
		}
		const snapshot: FileStatsSnapshot = new Map();
		for (const file of files) {
			try {
				const stat = await fs.promises.stat(file);
				snapshot.set(normalizeMapKey(path.resolve(file)), {
					mtimeMs: stat.mtimeMs,
					size: stat.size,
				});
			} catch {
				// Vanished mid-walk: absent from both snapshots = unchanged-by-absence.
			}
		}
		return { snapshot, scannedCount: snapshot.size };
	} catch {
		return { unknownReason: "walk-failed", scannedCount: 0 };
	}
}

/** Paths added or whose size/mtime changed. Deletions are NOT reported. */
export function diffFileStats(
	before: FileStatsSnapshot,
	after: FileStatsSnapshot,
): string[] {
	const changed: string[] = [];
	for (const [key, stat] of after) {
		const prev = before.get(key);
		if (!prev || prev.mtimeMs !== stat.mtimeMs || prev.size !== stat.size) {
			changed.push(key);
		}
	}
	return changed;
}

export class OpaqueSnapshotStore {
	private readonly byCwd = new Map<string, FileStatsSnapshot>();
	private evictions = 0;

	record(cwdKey: string, snapshot: FileStatsSnapshot): void {
		if (this.byCwd.has(cwdKey)) this.evictions += 1;
		this.byCwd.set(cwdKey, snapshot);
	}

	take(cwdKey: string): FileStatsSnapshot | undefined {
		const snap = this.byCwd.get(cwdKey);
		this.byCwd.delete(cwdKey);
		return snap;
	}

	get evictionCount(): number {
		return this.evictions;
	}
}

/** Process-wide store — one pending snapshot per cwd, bounded by construction. */
const globalStoreSymbol = Symbol.for("pi-lens:opaque-snapshot-store");

interface GlobalSlot {
	store?: OpaqueSnapshotStore;
}
const globalSlot = globalThis as typeof globalThis & Record<symbol, GlobalSlot>;

export function getOpaqueSnapshotStore(): OpaqueSnapshotStore {
	const existing = globalSlot[globalStoreSymbol]?.store;
	if (existing) return existing;
	const created = new OpaqueSnapshotStore();
	globalSlot[globalStoreSymbol] = { store: created };
	return created;
}
