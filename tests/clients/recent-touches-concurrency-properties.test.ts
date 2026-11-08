/**
 * Concurrent recent-touches publishers, by property: #5385 (refs #5377).
 *
 * Recurrence it prevents (shape 93, unlocked async read-modify-write of a
 * shared record). `appendRecentTouches` read `recent-touches.json`, merged its
 * entries in memory and renamed the whole file back with nothing between the
 * read and the rename, so two `publishFilesTouched` calls in one tick each
 * published state computed from the same snapshot and last-rename-wins dropped
 * the other's entries (the state-machine census lost an entry in 5 of 5 runs).
 * #5385 folds the append onto the locked `clients/durable-store.ts` commit and
 * stamps `ts` inside the lock: a stamp taken before the lock wait let a later
 * commit publish first, and a reader that had consumed it moved its cursor
 * past this batch's older `ts`, so the batch never surfaced (r2).
 *
 * The hand test (`recent-touches.test.ts`, "keeps every entry when four
 * publishes land in one tick") pins four callers with one path each. This
 * property generates the caller count (2 to 8) and each caller's file set, and
 * asserts the record's two promises over whatever the callers published:
 *
 * 1. Union: the record holds every entry every caller published, none twice.
 * 2. Commit order: the record's array order is commit order, so `ts` rises
 *    strictly along it, and each caller's batch sits in one contiguous run in
 *    the caller's own path order. A batch stamped before its lock wait, or two
 *    batches interleaved, breaks one of these.
 *
 * Real: `publishFilesTouched` (the production producer seam), the real
 * durable-store lock and the real filesystem; nothing is mocked. The publish is
 * fire-and-forget, so the record is joined on a real-clock deadline (shape 86:
 * the wait ends on the entry count the callers owe, never on a turn count).
 * The totals stay under the 50-entry ring cap, so no entry is cut by design.
 * fast-check runs a bounded `numRuns` under a fixed seed.
 *
 * Lane: ubuntu Unit tests.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { publishFilesTouched } from "../../clients/bus-publish.js";
import {
	_resetProjectDataDirMemoForTests,
	getProjectDataDir,
} from "../../clients/file-utils.js";
import { waitFor } from "./interleaving-kit.js";
import { removeTempDirSync } from "./test-utils.js";

const FAKE_CWD = "/fake/project";
const POOL = ["a", "b", "c", "d", "e", "f"].map((n) => `/fake/project/${n}.ts`);

interface StoredTouch {
	path: string;
	reason: string;
	ts: number;
	pid: number;
	sessionId?: string;
}

interface Caller {
	reason: "format" | "autofix";
	paths: string[];
}

let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-touches-pbt-"));
	vi.stubEnv("PILENS_DATA_DIR", dir);
	_resetProjectDataDirMemoForTests();
});

afterEach(() => {
	vi.unstubAllEnvs();
	_resetProjectDataDirMemoForTests();
	removeTempDirSync(dir);
});

function readEntries(): StoredTouch[] {
	try {
		const parsed = JSON.parse(
			fs.readFileSync(
				path.join(getProjectDataDir(FAKE_CWD), "recent-touches.json"),
				"utf-8",
			),
		);
		return Array.isArray(parsed?.entries)
			? (parsed.entries as StoredTouch[])
			: [];
	} catch {
		return [];
	}
}

const callerArb: fc.Arbitrary<Caller> = fc.record({
	reason: fc.constantFrom<"format" | "autofix">("format", "autofix"),
	paths: fc.array(fc.constantFrom(...POOL), { minLength: 1, maxLength: 3 }),
});

describe("recent-touches under concurrent publishers (#5385)", () => {
	it(
		"holds the union of every publisher's entries, stamped in commit order",
		{ timeout: 60_000 },
		async () => {
			// RECURRENCE GUARDED: #5385 / #5377. The unlocked read-modify-write lost
			// an entry whenever two publishes shared a tick, and a stamp taken
			// before the lock wait broke the order a reader's cursor relies on.
			await fc.assert(
				fc.asyncProperty(
					fc.array(callerArb, { minLength: 2, maxLength: 8 }),
					async (callers) => {
						// A fresh record per run: the previous run's entries must not
						// count toward this one's union.
						fs.rmSync(
							path.join(getProjectDataDir(FAKE_CWD), "recent-touches.json"),
							{ force: true },
						);
						const owed = callers.reduce((sum, c) => sum + c.paths.length, 0);
						// One tick: every publish is issued before the first append can settle.
						callers.forEach((caller, i) => {
							publishFilesTouched({
								cwd: FAKE_CWD,
								reason: caller.reason,
								paths: caller.paths,
								sessionId: `c${i}`,
							});
						});
						// Shape 86: wait on the record for the count the callers owe, under the
						// kit's real-clock budget (scaled by PI_LENS_TEST_TIMEOUT_SCALE).
						const entries = await waitFor(
							readEntries,
							(read) => read.length >= owed,
							{ timeoutMs: 2_000 },
						);

						// Model 1: the multiset of (session, reason, path) the callers owe.
						const label = (e: {
							sessionId?: string;
							reason: string;
							path: string;
						}) => `${e.sessionId}:${e.reason}:${e.path}`;
						const expectedLabels = callers
							.flatMap((caller, i) =>
								caller.paths.map((p) =>
									label({ sessionId: `c${i}`, reason: caller.reason, path: p }),
								),
							)
							.sort();
						expect({ callers, held: entries.map(label).sort() }).toEqual({
							callers,
							held: expectedLabels,
						});

						// Model 2: array order is commit order; ts rises strictly along it.
						const tsRises = entries.every(
							(e, i) => i === 0 || e.ts > entries[i - 1].ts,
						);
						// And each caller's batch is one contiguous run, in its own order.
						const runs: Array<{ sessionId?: string; paths: string[] }> = [];
						for (const e of entries) {
							const last = runs.at(-1);
							if (last && last.sessionId === e.sessionId)
								last.paths.push(e.path);
							else runs.push({ sessionId: e.sessionId, paths: [e.path] });
						}
						const runsMatch =
							runs.length === callers.length &&
							runs.every(
								(run) =>
									JSON.stringify(run.paths) ===
									JSON.stringify(
										callers[Number(run.sessionId?.slice(1))]?.paths,
									),
							);
						expect({
							callers,
							tsRises,
							runsMatch,
						}).toEqual({ callers, tsRises: true, runsMatch: true });
					},
				),
				{ numRuns: 12, seed: 5370 },
			);
		},
	);
});
