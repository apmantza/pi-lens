import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FactStore } from "../../../clients/dispatch/fact-store.js";
import { getProjectDataDir } from "../../../clients/file-utils.js";
import {
	_resetReviewGraphStageSweepForTests,
	buildOrUpdateGraph,
	clearReviewGraphWorkspaceCache,
	flushReviewGraphPersistsForTests,
	resetReviewGraphPersistWorkerForTests,
	waitForReviewGraphPersistsForTests,
} from "../../../clients/review-graph/builder.js";
import { waitFor } from "../interleaving-kit.js";
import { createTempFile, setupTestEnvironment } from "../test-utils.js";

// #1206: sweepStaleStageFiles runs over the SHARED project cache dir. It used
// to match the generic `<target>.tmp-<pid>` shape that clients/atomic-write.ts
// produces for EVERY durable store, so a review-graph persist deleted other
// modules' in-flight staging files between their write and their rename —
// ENOENT out of markDisposition for bestEffort:false stores, a silently
// dropped update for bestEffort:true ones.

const cleanups: Array<() => void> = [];

afterEach(async () => {
	flushReviewGraphPersistsForTests();
	await waitForReviewGraphPersistsForTests();
	resetReviewGraphPersistWorkerForTests();
	while (cleanups.length) cleanups.pop()?.();
	clearReviewGraphWorkspaceCache();
	_resetReviewGraphStageSweepForTests();
	process.env.PI_LENS_GRAPH_PERSIST_DEBOUNCE_MS = "0";
});

/**
 * Probe the real OS pid table for a pid that is definitively gone (ESRCH),
 * rather than branching on process.platform or assuming a pid_max. EPERM and
 * any other errno mean "exists / ambiguous", matching realIsPidAlive's own
 * conservative contract.
 */
function findDeadPid(): number {
	for (let candidate = 999_983; candidate > 1000; candidate -= 7919) {
		try {
			process.kill(candidate, 0);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ESRCH") return candidate;
		}
	}
	throw new Error("could not find a dead pid to test with");
}

/**
 * Wait for the sweep to remove a staged file. Shape 86 (#4865): this was a
 * 40 x 25 ms turn count, which holds idle and runs out under CPU load; the same
 * wall clock is now a `waitFor` deadline that follows
 * `PI_LENS_TEST_TIMEOUT_SCALE`.
 *
 * It keeps the helper's boolean contract instead of letting `waitFor` throw:
 * `waitFor` names its caller FRAME, and inside the `for` loop every stage file
 * shares that frame, so an exhausted wait redacted the assertion's
 * `expected swept: <name>` message -- the one line that says WHICH staging file
 * the sweep left behind (#4865 r1 F6).
 */
async function waitForGone(p: string, timeoutMs = 1_000): Promise<boolean> {
	try {
		return await waitFor(() => !fs.existsSync(p), Boolean, {
			timeoutMs,
			intervalMs: 25,
		});
	} catch {
		return false;
	}
}

describe("review-graph stale stage sweep scoping (#1206)", () => {
	it("never deletes other modules' in-flight atomic-write staging files", async () => {
		const env = setupTestEnvironment("pi-lens-stage-sweep-");
		cleanups.push(env.cleanup);
		process.env.PI_LENS_GRAPH_PERSIST_DEBOUNCE_MS = "0";
		_resetReviewGraphStageSweepForTests();

		const cacheDir = path.join(getProjectDataDir(env.tmpDir), "cache");
		fs.mkdirSync(cacheDir, { recursive: true });

		const deadPid = findDeadPid();

		// Foreign in-flight staging files: another process is between its
		// writeFileSync and its renameSync. These belong to unrelated stores and
		// must survive the review graph's garbage collection regardless of
		// whether their owner is alive (dead pid is the harsher case — the old
		// predicate deleted them either way).
		const foreign = [
			path.join(cacheDir, `diagnostic-dispositions.json.tmp-${deadPid}`),
			path.join(cacheDir, `project-snapshot.json.tmp-${deadPid}`),
			path.join(cacheDir, `scanner-data.json.tmp-${process.pid}`),
			// #1205 changes atomic-write's staging name to a per-call-unique
			// `<target>.tmp-<pid>-<seq>`. Cover that shape too so this regression
			// guard keeps its teeth once that lands — the fix matches neither,
			// because it keys on the review-graph prefix, not on `.tmp-`.
			path.join(cacheDir, `diagnostic-dispositions.json.tmp-${deadPid}-7`),
		];
		for (const p of foreign) fs.writeFileSync(p, "in-flight");

		// The review graph's OWN leftovers from a dead process: the staged
		// snapshot, the staged checkpoint, and the persist worker's tmp for a
		// stage file. All three must still be swept.
		const ownStale = [
			path.join(cacheDir, `review-graph.json.gz.stage-${deadPid}-1`),
			path.join(cacheDir, `review-graph.json.stage-${deadPid}-1`),
			path.join(cacheDir, `review-graph.checkpoint.json.gz.stage-${deadPid}-2`),
			path.join(
				cacheDir,
				`review-graph.json.gz.stage-${deadPid}-3.tmp-${deadPid}`,
			),
		];
		for (const p of ownStale) fs.writeFileSync(p, "leftover");

		// A review-graph stage file owned by a LIVE process (us) is a concurrent
		// healthy owner's in-flight write and must not be swept.
		const liveOwned = path.join(
			cacheDir,
			`review-graph.json.gz.stage-${process.pid}-9999`,
		);
		fs.writeFileSync(liveOwned, "live");

		// #1207 review F1: `pid === process.pid` short-circuits the liveness
		// check for our own stage file, so `liveOwned` above never exercises
		// `realIsPidAlive`. Seed a review-graph stage file owned by a LIVE
		// FOREIGN pid — this is the cross-process case the liveness probe
		// actually exists for (process B mid-persist, process A's sweep must
		// not destroy B's not-yet-promoted stage file). `process.ppid` is
		// alive, non-zero, and never equal to `process.pid`, with no
		// platform branch needed.
		const liveForeign = path.join(
			cacheDir,
			`review-graph.json.gz.stage-${process.ppid}-4242`,
		);
		fs.writeFileSync(liveForeign, "live-foreign");

		createTempFile(env.tmpDir, "a.ts", "export const a = 1;\n");
		await buildOrUpdateGraph(
			env.tmpDir,
			[path.join(env.tmpDir, "a.ts")],
			new FactStore(),
		);
		flushReviewGraphPersistsForTests();
		await waitForReviewGraphPersistsForTests();

		// Await the async readdir + async rm the sweep schedules.
		for (const p of ownStale) {
			expect(await waitForGone(p), `expected swept: ${path.basename(p)}`).toBe(
				true,
			);
		}

		for (const p of foreign) {
			expect(
				fs.existsSync(p),
				`#1206: review-graph sweep destroyed ${path.basename(p)}`,
			).toBe(true);
		}
		expect(fs.existsSync(liveOwned)).toBe(true);
		expect(
			fs.existsSync(liveForeign),
			"#1206: review-graph sweep destroyed a live foreign owner's stage file",
		).toBe(true);
	});
});
