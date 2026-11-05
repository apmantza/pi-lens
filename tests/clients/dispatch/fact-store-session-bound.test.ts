import { afterEach, describe, it, expect } from "vitest";
import {
	createDispatchContext,
	deltaBaselineFactKey,
	dispatchForFile,
	RunnerRegistry,
} from "../../../clients/dispatch/dispatcher.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../../clients/degradation-ledger.js";
import {
	FactStore,
	getFactStoreEvictionReporter,
	MAX_SESSION_FACT_RECORDS,
	setFactStoreEvictionReporter,
} from "../../../clients/dispatch/fact-store.js";
import type { RunnerGroup } from "../../../clients/dispatch/types.js";
import { createMockRunner } from "../../mocks/runner-factory.js";
import { normalizeMapKey } from "../../../clients/path-utils.js";
import { recordEntitySnapshotDiff } from "../../../clients/review-graph/service.js";
// Side-effect import: loading integration.ts runs its module-scope
// `setFactStoreEvictionReporter(...)` call, wiring the REAL production
// reporter into fact-store's module-scope slot (mirrors fact-store-bound.test.ts).
import "../../../clients/dispatch/integration.js";
const productionEvictionReporter = getFactStoreEvictionReporter();

afterEach(() => setFactStoreEvictionReporter(undefined));

const MAX_SESSION_RECORDS = MAX_SESSION_FACT_RECORDS;

function batchPaths(prefix: string, count: number): string[] {
	return Array.from({ length: count }, (_, i) => `/repo/src/${prefix}-${i}.ts`);
}

describe("FactStore session-fact bound (#2282)", () => {
	// Acceptance criteria 2 & 4: the production dispatch path (dispatcher.ts)
	// now bounds session.baseline growth by reusing #2243's FactStore-level LRU
	// discipline, not a hand-rolled prefix check. The first file and its
	// re-dispatch go through the REAL `dispatchForFile` entry point, and the
	// test observes a purely behavioral signal (`baselineWarningCount`). The
	// filler batch writes the same bounded key the dispatcher writes for each
	// file (`deltaBaselineFactKey`), straight into the store, instead of
	// dispatching every filler file. That still proves the bound: eviction is
	// decided by the store's LRU, not by the dispatch that wrote the key. A
	// full dispatch per filler file cost about 2 ms each, so 4296 of them took
	// about 9 s here and about 30 s on CI, at the timeout (#5307). The test
	// is red on pre-#2282 dispatcher.ts (unbounded `sessionFacts.setSessionFact`)
	// and green after.
	it("stops retaining an early file's delta baseline once a large batch exceeds the session-fact cap", async () => {
		const registry = new RunnerRegistry();
		registry.register(
			createMockRunner({
				id: "reporter",
				appliesTo: ["jsts"],
				runResult: {
					status: "succeeded",
					diagnostics: [
						{
							id: "no-console",
							message: "Unexpected console statement",
							filePath: "irrelevant.ts",
							severity: "warning",
							semantic: "warning",
							tool: "eslint",
						},
					],
					semantic: "warning",
				},
			}),
		);
		const groups: RunnerGroup[] = [{ mode: "all", runnerIds: ["reporter"] }];
		const facts = new FactStore();
		const pi = { getFlag: () => false };
		const cwd = "/project";
		const firstPath = `${cwd}/src/first-touched.ts`;

		// First dispatch of this file: no prior baseline exists yet.
		const firstResult = await dispatchForFile(
			createDispatchContext(firstPath, cwd, pi, facts),
			groups,
			registry,
		);
		expect(firstResult.baselineWarningCount).toBe(0);

		// A several-hundred(+)-file batch touches every OTHER file exactly once —
		// the shape a large merge/checkout dispatch produces. The dispatcher mints
		// one baseline key per file (#2489 dropped the second, relative-fallback
		// key), so the batch must exceed MAX_SESSION_RECORDS on its own to force
		// the eviction this test proves. The batch is the cap plus a margin, so
		// the cap follows MAX_SESSION_FACT_RECORDS if it ever changes.
		for (const p of batchPaths("filler", MAX_SESSION_RECORDS + 200)) {
			facts.setBoundedSessionFact(deltaBaselineFactKey(p), []);
		}

		// Re-dispatch the FIRST file. Pre-#2282, `sessionFacts` never evicts, so
		// its baseline (1 warning, set by the first dispatch) is still there and
		// `baselineWarningCount` reads 1. Post-#2282, the bounded session-fact map
		// evicted it long before the batch finished, so no previous baseline is
		// found and it reads 0 — the same state as a file's first-ever dispatch.
		const secondResult = await dispatchForFile(
			createDispatchContext(firstPath, cwd, pi, facts),
			groups,
			registry,
		);
		expect(secondResult.baselineWarningCount).toBe(0);
	}, 30_000);

	it("caps distinct bounded session-fact records so a large batch cannot retain them all", () => {
		const store = new FactStore();
		const count = MAX_SESSION_RECORDS + 500;
		const paths = batchPaths("cap", count);

		for (const p of paths) store.setBoundedSessionFact(p, "x");

		const retained = paths.filter((p) => store.hasBoundedSessionFact(p)).length;
		expect(retained).toBeLessThanOrEqual(MAX_SESSION_RECORDS);
		expect(store.hasBoundedSessionFact(paths[0])).toBe(false);
		expect(store.hasBoundedSessionFact(paths[count - 1])).toBe(true);
		// Eviction is scoped to the bounded map — fixed-vocabulary session facts
		// on the plain map are untouched.
		store.setSessionFact("session.toolCache.biome", true);
		expect(store.getSessionFact("session.toolCache.biome")).toBe(true);
	});

	it("evicts least-recently-used bounded records, keeping the ones still being read", () => {
		const store = new FactStore();
		const paths = batchPaths("lru", MAX_SESSION_RECORDS);
		for (const p of paths) store.setBoundedSessionFact(p, "x");

		// Re-read the oldest record: an LRU touch must move it off the victim end.
		expect(store.getBoundedSessionFact(paths[0])).toBe("x");

		store.setBoundedSessionFact("/repo/src/lru-overflow.ts", "y");

		expect(store.hasBoundedSessionFact(paths[0])).toBe(true);
		expect(store.hasBoundedSessionFact(paths[1])).toBe(false);
	});

	it("clearAll releases bounded session facts alongside file/session facts", () => {
		const store = new FactStore();
		const paths = batchPaths("clear", 10);
		for (const p of paths) store.setBoundedSessionFact(p, "x");

		store.clearAll();

		expect(store.hasBoundedSessionFact(paths[0])).toBe(false);
		expect(store.getSessionFactEntryCount()).toBe(0);
	});

	it("getSessionFactEntryCount reflects the fixed-vocabulary and bounded maps combined (#2282 Observability)", () => {
		const store = new FactStore();
		expect(store.getSessionFactEntryCount()).toBe(0);

		store.setSessionFact("dispatch:eslint", true);
		expect(store.getSessionFactEntryCount()).toBe(1);

		store.setBoundedSessionFact("session.baseline./repo/a.ts", []);
		expect(store.getSessionFactEntryCount()).toBe(2);

		// Overflow the bounded map: the fixed-vocabulary entry survives (it lives
		// on the OTHER map), and the total stops growing with batch size.
		for (const p of batchPaths("count-overflow", MAX_SESSION_RECORDS + 500))
			store.setBoundedSessionFact(p, []);
		expect(store.getSessionFactEntryCount()).toBeLessThanOrEqual(
			MAX_SESSION_RECORDS + 1,
		);
		expect(store.getSessionFact("dispatch:eslint")).toBe(true);
	});

	it("records one capacity-eviction degradation per session for the session-count axis, naming the evicted key", () => {
		expect(productionEvictionReporter).toBeDefined();
		resetDegradationLedger();
		setFactStoreEvictionReporter(productionEvictionReporter);
		const store = new FactStore("dispatch");
		const paths = batchPaths("evict", MAX_SESSION_RECORDS + 500);
		for (const p of paths) store.setBoundedSessionFact(p, "x");

		const group = getDegradationSummary().find(
			(g) => g.kind === "fact-store-capacity-eviction",
		);
		expect(group).toBeDefined();
		expect(
			group?.latestReasons.some((r) => r.subject === "dispatch:session-count"),
		).toBe(true);
		expect(
			group?.latestReasons.find((r) => r.subject === "dispatch:session-count")
				?.reason,
		).toContain(paths[0]);

		// The file-fact count axis and the session-fact count axis are
		// discriminated so one does not consume the other's once-per-session slot.
		for (const p of paths) store.setFileFact(p, "file.content", "x");
		const subjectsAfterFileEviction = (
			getDegradationSummary().find(
				(g) => g.kind === "fact-store-capacity-eviction",
			)?.latestReasons ?? []
		).map((r) => r.subject);
		expect(subjectsAfterFileEviction).toContain("dispatch:session-count");
		expect(subjectsAfterFileEviction).toContain("dispatch:count");
	});

	// Review round F1: the entity snapshot is the one migrated family whose
	// "absent" branch is not a safe default — an empty previous snapshot puts
	// every entity in `added`, which reads downstream as "the whole file
	// changed" and schedules a blast-radius run for a file nothing touched.
	describe("evicted entity snapshots do not invert to a whole-file change", () => {
		const TARGET = "/repo/src/Target.ts";
		const snapshot = () =>
			new Map([
				["function:alpha", "h1"],
				["function:beta", "h2"],
				["class:Gamma", "h3"],
			]);

		it("reports no diff for a snapshot the cap evicted, not every symbol", () => {
			const store = new FactStore("dispatch");

			expect(recordEntitySnapshotDiff(store, TARGET, snapshot()).added).toEqual(
				["function:alpha", "function:beta", "class:Gamma"],
			);
			expect(recordEntitySnapshotDiff(store, TARGET, snapshot()).added).toEqual(
				[],
			);

			for (const p of batchPaths("snapshot-evict", MAX_SESSION_RECORDS + 500))
				store.setBoundedSessionFact(p, []);

			const afterEviction = recordEntitySnapshotDiff(store, TARGET, snapshot());
			expect(afterEviction).toEqual({ added: [], removed: [], modified: [] });
		});

		it("re-seeds the evicted snapshot so the next real edit still diffs", () => {
			const store = new FactStore("dispatch");
			recordEntitySnapshotDiff(store, TARGET, snapshot());
			for (const p of batchPaths("snapshot-reseed", MAX_SESSION_RECORDS + 500))
				store.setBoundedSessionFact(p, []);
			recordEntitySnapshotDiff(store, TARGET, snapshot());

			const edited = snapshot();
			edited.set("function:beta", "h2-edited");

			expect(recordEntitySnapshotDiff(store, TARGET, edited)).toEqual({
				added: [],
				removed: [],
				modified: ["function:beta"],
			});
		});

		// Review round F3: builder.ts reads this key through normalizeMapKey, so
		// an unnormalized write is a key the reader can never hit. normalizeMapKey
		// leaves a plain POSIX path alone, so the asymmetry only shows on a path
		// it actually rewrites — a backslash-separated one (the #1150 shape).
		it("writes changedSymbols under the key builder.ts reads", () => {
			const store = new FactStore("dispatch");
			const backslashPath = "/repo/src\\nested\\Target.ts";
			expect(normalizeMapKey(backslashPath)).not.toBe(backslashPath);

			recordEntitySnapshotDiff(store, backslashPath, snapshot());

			const readKey = `session.reviewGraph.changedSymbols:${normalizeMapKey(backslashPath)}`;
			expect(store.getBoundedSessionFact<string[]>(readKey)).toEqual([
				"alpha",
				"beta",
				"Gamma",
			]);
		});

		// #2355's own probe shape: `recordEntitySnapshotDiff` is called with the
		// agent-supplied spelling, while builder.ts reads the key under
		// normalizeMapKey. A case-variant PAIR (`src/Target.ts` written, the read
		// arriving as `src/target.ts`) must land on the same normalized key — the
		// same written stone, one lowercase slot. Red on the pre-#2282 raw-path
		// writer: the raw `C:/.../Target.ts` key is unreadable from the lowercase
		// read spelling. Both spellings are win32-shaped and nonexistent, so
		// normalizeMapKey folds them deterministically on every OS (#1150 shape).
		it("serves a changedSymbols write to a case-variant read spelling (closes #2355)", () => {
			const store = new FactStore("dispatch");
			const writeSpelling = "C:/repo/2355/src/Target.ts";
			const readSpelling = "c:/repo/2355/src/target.ts";
			expect(writeSpelling).not.toBe(readSpelling);
			expect(normalizeMapKey(writeSpelling)).toBe(
				normalizeMapKey(readSpelling),
			);

			recordEntitySnapshotDiff(store, writeSpelling, snapshot());

			const readKey = `session.reviewGraph.changedSymbols:${normalizeMapKey(readSpelling)}`;
			expect(store.getBoundedSessionFact<string[]>(readKey)).toEqual([
				"alpha",
				"beta",
				"Gamma",
			]);
		});

		// The entity-snapshot key is the sibling of changedSymbols in the same
		// function, and it was stored raw on both sides. Within one call the pair
		// is self-consistent, so the raw key only bites ACROSS spellings: editing
		// the same file under a second spelling read an empty prior snapshot and
		// inverted every symbol to `added` — the #2282 F1 whole-file-change
		// false positive, re-entered through a different door. The snapshot key
		// must normalize exactly like the changedSymbols key it pairs with.
		it("diffs a re-spelled file against its own snapshot, not an empty one (refs #2355)", () => {
			const store = new FactStore("dispatch");
			const firstSpelling = "C:/repo/2355/src/Target.ts";
			const reSpelling = "c:/repo/2355/src/target.ts";
			expect(normalizeMapKey(firstSpelling)).toBe(normalizeMapKey(reSpelling));

			recordEntitySnapshotDiff(store, firstSpelling, snapshot());

			expect(recordEntitySnapshotDiff(store, reSpelling, snapshot())).toEqual({
				added: [],
				removed: [],
				modified: [],
			});
		});
	});
});

// #4365 rotation batch 1: survivors of the per-module Stryker campaign in the
// eviction-tombstone bookkeeping of `setBoundedSessionFact`.
describe("FactStore eviction tombstone survivors (#4365)", () => {
	it("forgets a tombstone once its key is rewritten, and every tombstone on clearAll", () => {
		// Kills `evictedSessionFactKeys.delete(factId)` removed in
		// setBoundedSessionFact (a rewritten key still read as "evicted", so the
		// entity-snapshot reader skipped a real diff) and `.clear()` removed in
		// clearAll (tombstones outlived the session reset).
		const store = new FactStore();
		const paths = batchPaths("tomb", MAX_SESSION_RECORDS + 10);
		for (const p of paths) store.setBoundedSessionFact(p, "x");
		expect(store.wasBoundedSessionFactEvicted(paths[0])).toBe(true);

		store.setBoundedSessionFact(paths[0], "again");
		expect(store.wasBoundedSessionFactEvicted(paths[0])).toBe(false);

		expect(store.wasBoundedSessionFactEvicted(paths[1])).toBe(true);
		store.clearAll();
		expect(store.wasBoundedSessionFactEvicted(paths[1])).toBe(false);
	});

	it("keeps exactly the tombstone cap of evicted keys, dropping the coldest one past it", () => {
		// Kills the tombstone trim in setBoundedSessionFact: the `while` forced
		// false, its `>` turned `>=`, the loop body emptied, the break guard
		// forced to break at once, and the `.delete(oldestTombstone)` removed.
		// Evicted keys equal inserts minus the record cap, so 2 x cap inserts
		// leave exactly cap tombstones and one more insert pushes the first out.
		const store = new FactStore();
		const paths = batchPaths("tomb-cap", MAX_SESSION_RECORDS * 2 + 1);
		for (const p of paths.slice(0, MAX_SESSION_RECORDS * 2))
			store.setBoundedSessionFact(p, "x");
		expect(store.wasBoundedSessionFactEvicted(paths[0])).toBe(true);
		expect(
			store.wasBoundedSessionFactEvicted(paths[MAX_SESSION_RECORDS - 1]),
		).toBe(true);

		store.setBoundedSessionFact(paths[MAX_SESSION_RECORDS * 2], "x");

		expect(store.wasBoundedSessionFactEvicted(paths[0])).toBe(false);
		expect(store.wasBoundedSessionFactEvicted(paths[1])).toBe(true);
	});
});
