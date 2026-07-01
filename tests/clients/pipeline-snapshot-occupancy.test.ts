/**
 * Event-loop occupancy guard for the tool_result autofix side-effect walk
 * (#361/#368, follow-up to #192). `snapshotProjectFiles` runs on the
 * `tool_result` pipeline path — after a formatter/fixer touches a file, pi-lens
 * snapshots the tree (before/after) to detect side-effect changes. It walks up
 * to `AUTOFIX_CHANGED_FILE_SCAN_LIMIT` files and **chunk-yields** every
 * `SNAPSHOT_YIELD_EVERY` (#368), so even at the cap it must not hold the loop
 * (and the TUI) for more than a short stretch.
 *
 * We measure occupancy (longest sync block), NOT wall-clock duration. At the
 * ~5k-file cap this asserts the walk yields: a chunk is ~tens of ms while the
 * pre-#368 non-yielding walk was ~130ms+ (2-4x under CI load). The guard trips
 * if the walk stops yielding, or if a regression explodes its cost:
 *   - directory excludes break and the walk descends `node_modules`/ignored
 *     dirs (the walk-confinement invariant), exploding the file count;
 *   - the scan cap is removed/raised so the walk no longer self-limits;
 *   - a per-file synchronous cost is added (e.g. a `readFileSync` per entry).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { snapshotProjectFiles } from "../../clients/pipeline.js";
import {
	generateSourceTree,
	measureMaxSyncBlockMs,
} from "../support/perf-harness.js";

// The pre-#368 non-yielding walk at the cap was ~130ms local / 300-500ms CI; the
// yielding walk holds the loop only for one ~500-file chunk (~tens of ms). 100ms
// clears the yielding impl with margin while tripping a revert to a sync walk.
const MAX_SYNC_BLOCK_MS = 100;
// Cap-representative: enough files to reach AUTOFIX_CHANGED_FILE_SCAN_LIMIT and
// span several yield chunks, so a non-yielding regression blows the budget.
const TREE_SIZE = 5000;

let tmpDir: string;

beforeAll(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-snapshot-occupancy-"));
	generateSourceTree(tmpDir, TREE_SIZE);
}, 60_000);

afterAll(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe(`tool_result snapshot walk occupancy (~${TREE_SIZE} files)`, () => {
	it(
		"snapshotProjectFiles chunk-yields and stays under the sync-block budget",
		{ retry: 2, timeout: 30_000 },
		async () => {
			let size = 0;
			const maxBlock = await measureMaxSyncBlockMs(async () => {
				size = (await snapshotProjectFiles(tmpDir)).size;
			});
			expect(size).toBeGreaterThan(0);
			expect(maxBlock).toBeLessThan(MAX_SYNC_BLOCK_MS);
		},
	);

	it("excludes node_modules so the walk stays bounded", async () => {
		const snapshot = await snapshotProjectFiles(tmpDir);
		const descended = [...snapshot.keys()].some((p) =>
			p.split(path.sep).includes("node_modules"),
		);
		// generateSourceTree seeds node_modules/pkg/*.js noise; if the walk
		// descended it, the count (and the sync block above) would balloon.
		expect(descended).toBe(false);
	});
});
