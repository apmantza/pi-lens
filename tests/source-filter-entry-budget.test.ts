import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	collectSourceFiles,
	collectSourceFilesAsync,
	collectSourceFilesWithBudget,
	collectSourceFilesWithBudgetAsync,
	DEFAULT_MAX_SCAN_ENTRIES,
} from "../clients/source-filter.js";

/**
 * Entry-budget bound for the collect walks (#760, the #758 escape class).
 *
 * `maxFiles` caps results FOUND — a mixed tree with few source files but a
 * huge pile of non-source files never trips it and gets a full-tree walk.
 * `maxScanEntries` caps entries VISITED (including ignored/skipped ones), so
 * the walk's work is bounded even when its results are few.
 */

const cleanups: Array<() => void> = [];

afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
});

/**
 * Deterministic mixed-tree fixture: a handful of real source files buried in
 * a pile of non-source data files (the reporter's ~300-scripts-among-~84k-
 * data-files shape, scaled down). Data files outnumber source files enough
 * that any small entry budget trips long before the walk completes.
 */
function createMixedTree(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "source-filter-budget-"));
	cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));

	fs.writeFileSync(path.join(dir, "main.ts"), "export const a = 1;\n");
	for (let d = 0; d < 4; d++) {
		const sub = path.join(dir, `data-${d}`);
		fs.mkdirSync(sub, { recursive: true });
		fs.writeFileSync(path.join(sub, `script-${d}.ts`), `export const s${d} = ${d};\n`);
		for (let i = 0; i < 25; i++) {
			fs.writeFileSync(path.join(sub, `blob-${i}.dat`), "not source\n");
		}
	}
	return dir;
}

describe("collect walk entry budget (#760)", () => {
	it("trips on a mixed tree with a small budget and returns a truncated best-effort list", () => {
		const dir = createMixedTree();
		const full = collectSourceFiles(dir);
		expect(full.length).toBe(5); // fixture sanity: 1 root + 4 buried scripts

		const result = collectSourceFilesWithBudget(dir, { maxScanEntries: 10 });
		expect(result.entryBudgetExceeded).toBe(true);
		expect(result.files.length).toBeLessThan(full.length);
		// Best-effort truncation, not garbage: everything kept is a real result.
		for (const f of result.files) expect(full).toContain(f);
	});

	it("collects normally under a generous budget (no false positives)", () => {
		const dir = createMixedTree();
		const plain = collectSourceFiles(dir);
		const result = collectSourceFilesWithBudget(dir, {
			maxScanEntries: 100_000,
		});
		expect(result.entryBudgetExceeded).toBe(false);
		expect(result.files.sort()).toEqual(plain.sort());
	});

	it("defaults to a finite budget (DEFAULT_MAX_SCAN_ENTRIES) when unset or invalid", () => {
		expect(DEFAULT_MAX_SCAN_ENTRIES).toBe(200_000);
		const dir = createMixedTree();
		// Omitted, non-finite, and non-positive all resolve to the finite default
		// — never an unbounded walk (the #250/#747/#760 bug class).
		for (const bad of [undefined, Number.POSITIVE_INFINITY, 0, -5]) {
			const result = collectSourceFilesWithBudget(dir, {
				maxScanEntries: bad,
			});
			expect(result.entryBudgetExceeded).toBe(false);
			expect(result.files.length).toBe(5);
		}
	});

	it("sync and async agree on the truncation flag, and on files for complete walks", async () => {
		const dir = createMixedTree();
		const full = collectSourceFiles(dir);
		for (const maxScanEntries of [10, 100_000]) {
			const sync = collectSourceFilesWithBudget(dir, { maxScanEntries });
			const async = await collectSourceFilesWithBudgetAsync(dir, {
				maxScanEntries,
			});
			expect(async.entryBudgetExceeded).toBe(sync.entryBudgetExceeded);
			if (!sync.entryBudgetExceeded) {
				// Complete walks are set-identical (shared classifyEntry); visit
				// ORDER differs (recursive vs stack-based walk), so compare sorted.
				expect([...async.files].sort()).toEqual([...sync.files].sort());
			} else {
				// Truncated walks stop at the same budget but visit in different
				// orders (recursive vs stack-based), so the best-effort lists may
				// differ — each must still be a subset of the full enumeration.
				for (const f of sync.files) expect(full).toContain(f);
				for (const f of async.files) expect(full).toContain(f);
			}
		}
	});

	it("keeps the existing maxFiles results cap independent and unchanged", async () => {
		const dir = createMixedTree();
		// A results cap under a generous entry budget trims on COUNT, and is not
		// reported as an entry-budget truncation — the two bounds are independent.
		const capped = collectSourceFilesWithBudget(dir, { maxFiles: 2 });
		expect(capped.files.length).toBe(2);
		expect(capped.entryBudgetExceeded).toBe(false);

		const cappedAsync = await collectSourceFilesWithBudgetAsync(dir, {
			maxFiles: 2,
		});
		expect(cappedAsync.files.length).toBe(2);
		expect(cappedAsync.entryBudgetExceeded).toBe(false);

		// The plain string[] collectors keep their existing contract verbatim.
		expect(collectSourceFiles(dir, { maxFiles: 2 }).length).toBe(2);
		expect((await collectSourceFilesAsync(dir, { maxFiles: 2 })).length).toBe(2);
	});

	it("plain collectors return the same (possibly truncated) list as the budget core", async () => {
		const dir = createMixedTree();
		const budgeted = collectSourceFilesWithBudget(dir, { maxScanEntries: 10 });
		expect(collectSourceFiles(dir, { maxScanEntries: 10 })).toEqual(
			budgeted.files,
		);
		expect(await collectSourceFilesAsync(dir, { maxScanEntries: 10 })).toEqual(
			(await collectSourceFilesWithBudgetAsync(dir, { maxScanEntries: 10 }))
				.files,
		);
	});
});
