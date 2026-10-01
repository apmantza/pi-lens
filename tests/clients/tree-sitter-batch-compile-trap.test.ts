/**
 * #3707: the two `compileQueryBatch` compile sites (the per-rule probe and the
 * combined compile) are charged per query source, and a batch built across a
 * trap is not cached.
 *
 * Recurrences these pin (each fails on `origin/master` 1a66d8f31):
 * - a query that traps deterministically on compile spent one budget unit every
 *   time its batch was rebuilt (LRU eviction, a rule edit), so the fourth
 *   rebuild aborted the runtime (the #3605 shape, at the two sites #3706 left
 *   unkeyed);
 * - a trap within budget skipped the rule (or nulled the batch) and
 *   `cacheQueryBatch` then cached that degraded result for the process, so one
 *   transient trap silenced the rule until restart.
 *
 * Every test drives the real client, a real python grammar and a real compiled
 * `Query`; only the trap is injected, at `Query.prototype.patternCount` (the
 * wasm boundary), so the probe and the combined compile can be trapped
 * independently by the captures the compiled query holds.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { loadWebTreeSitter } from "../../clients/deps/web-tree-sitter.js";
import { TreeSitterClient } from "../../clients/tree-sitter-client.js";
import type { TreeSitterQuery } from "../../clients/tree-sitter-query-loader.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

const { WebAssembly } = globalThis as unknown as {
	WebAssembly: { RuntimeError: new (message: string) => Error };
};
const trap = () => new WebAssembly.RuntimeError("table index is out of bounds");

const cleanups: Array<() => void> = [];
beforeEach(() => resetDegradationLedger());
afterEach(() => {
	vi.restoreAllMocks();
	while (cleanups.length) cleanups.pop()?.();
	resetDegradationLedger();
});

function pythonFile(): string {
	const env = setupTestEnvironment("pi-lens-batch-trap-");
	cleanups.push(env.cleanup);
	return createTempFile(env.tmpDir, "m.py", "def f():\n    return 1\n");
}

async function liveClient() {
	const onAbort = vi.fn();
	const client = new TreeSitterClient(false, onAbort);
	expect(await client.init()).toBe(true);
	const internals = client as unknown as {
		queryBatchCache: Map<string, unknown>;
	};
	return { client, onAbort, evict: () => internals.queryBatchCache.clear() };
}

function rule(id: string, capture: string): TreeSitterQuery {
	return {
		id,
		name: id,
		severity: "warning",
		category: "test",
		language: "python",
		message: id,
		query: `(function_definition) @${capture}`,
		metavars: [capture],
		has_fix: false,
		filePath: "",
	};
}

/**
 * Traps a compiled query's `patternCount()` (read by the probe and by the
 * combined compile inside their try blocks) while `state.on(captureNames)` is
 * true. `calls()` counts every `patternCount` call, i.e. every compile.
 */
async function trapPatternCount(state: {
	on: (captureNames: string[]) => boolean;
	/** What the matching compile throws; a wasm trap unless stated. */
	error?: () => Error;
}) {
	const { Query } = await loadWebTreeSitter();
	const realPatternCount = Query.prototype.patternCount;
	let calls = 0;
	vi.spyOn(Query.prototype, "patternCount").mockImplementation(function (
		this: InstanceType<typeof Query>,
	) {
		calls++;
		if (state.on(this.captureNames)) throw (state.error ?? trap)();
		return realPatternCount.call(this);
	});
	return { calls: () => calls };
}

async function countWalks() {
	const { Query } = await loadWebTreeSitter();
	const realMatches = Query.prototype.matches;
	let walks = 0;
	vi.spyOn(Query.prototype, "matches").mockImplementation(function (
		this: InstanceType<typeof Query>,
		...args: Parameters<typeof realMatches>
	) {
		walks++;
		return realMatches.apply(this, args);
	});
	return { walks: () => walks };
}

const ids = (results: Array<{ queryDef: TreeSitterQuery }>): string[] =>
	results.map((r) => r.queryDef.id);

/** The budget left: traps `reportWasmAbort` still absorbs before it reports the abort. */
function remainingBudget(client: TreeSitterClient): number {
	let absorbed = 0;
	while (!client.reportWasmAbort(trap())) absorbed++;
	return absorbed;
}

function wasmTrapReasons(): string[] {
	return (
		getDegradationSummary()
			.find((group) => group.kind === "wasm-trap")
			?.latestReasons.map((row) => row.reason) ?? []
	);
}

describe("a deterministic compile trap on a rebuilt batch (#3707)", () => {
	it("does not abort on a deterministic probe trap across six rebuilds", async () => {
		const { client, onAbort, evict } = await liveClient();
		await trapPatternCount({ on: (names) => names.includes("trap_me") });
		const file = pythonFile();
		const set = [rule("ok", "fn"), rule("poisoned", "trap_me")];

		const seen: string[][] = [];
		for (let round = 0; round < 6; round++) {
			evict();
			seen.push(ids(await client.runQueriesOnFile(set, file, "python")));
		}

		// Master: every rebuild's probe trap spends a unit; the 4th aborts.
		expect(onAbort).not.toHaveBeenCalled();
		expect(seen).toEqual(Array.from({ length: 6 }, () => ["ok"]));
		// One unit for the whole poisoned rule, however often its batch rebuilt;
		// the second trap is recorded as charged to the input.
		expect(wasmTrapReasons().some((r) => r.startsWith("input charged:"))).toBe(
			true,
		);
		expect(remainingBudget(client)).toBe(2);
	});

	it("does not abort on a deterministic combined-compile trap across six rebuilds", async () => {
		const { client, onAbort, evict } = await liveClient();
		await trapPatternCount({
			on: (names) => names.includes("a_cap") && names.includes("b_cap"),
		});
		const file = pythonFile();
		const set = [rule("a", "a_cap"), rule("b", "b_cap")];

		const seen: string[][] = [];
		for (let round = 0; round < 6; round++) {
			evict();
			seen.push(ids(await client.runQueriesOnFile(set, file, "python")));
		}

		// Every probe is healthy and only the combined compile traps, so the
		// per-rule fallback still returns both rules each round.
		expect(onAbort).not.toHaveBeenCalled();
		expect(seen).toEqual(Array.from({ length: 6 }, () => ["a", "b"]));
		expect(remainingBudget(client)).toBe(2);
	});

	it("does not abort when rule edits rebuild batches holding a poisoned rule", async () => {
		const { client, onAbort } = await liveClient();
		await trapPatternCount({ on: (names) => names.includes("trap_me") });
		const file = pythonFile();

		// A rule edit changes the rule set's identity (a new batch key) but not
		// the poisoned rule's own source, so it is one poisoned query source.
		for (let round = 0; round < 6; round++) {
			await client.runQueriesOnFile(
				[rule(`ok-${round}`, "fn"), rule("poisoned", "trap_me")],
				file,
				"python",
			);
		}

		expect(onAbort).not.toHaveBeenCalled();
		expect(remainingBudget(client)).toBe(2);
	});
});

describe("a charged compile is skipped, and its batch cached (#3707)", () => {
	it("stops recompiling a poisoned rule once its probe is charged", async () => {
		const { client } = await liveClient();
		const compiles = await trapPatternCount({
			on: (names) => names.includes("trap_me"),
		});
		const file = pythonFile();
		const set = [rule("ok", "fn"), rule("poisoned", "trap_me")];

		// Build 1 traps (a unit), build 2 traps (charged), build 3 skips the
		// rule without compiling and is the first one cached.
		for (let call = 0; call < 3; call++) {
			await client.runQueriesOnFile(set, file, "python");
		}
		const settled = compiles.calls();
		for (let call = 0; call < 3; call++) {
			await client.runQueriesOnFile(set, file, "python");
		}

		expect(compiles.calls()).toBe(settled);
	});

	it("stops recompiling a combined batch once its compile is charged", async () => {
		const { client } = await liveClient();
		const compiles = await trapPatternCount({
			on: (names) => names.includes("a_cap") && names.includes("b_cap"),
		});
		const file = pythonFile();
		const set = [rule("a", "a_cap"), rule("b", "b_cap")];

		for (let call = 0; call < 3; call++) {
			await client.runQueriesOnFile(set, file, "python");
		}
		const settled = compiles.calls();
		for (let call = 0; call < 3; call++) {
			await client.runQueriesOnFile(set, file, "python");
		}

		expect(compiles.calls()).toBe(settled);
	});
});

describe("a charged batch key belongs to its rule set alone (#3707)", () => {
	it("keeps building the combined batch of a different rule set", async () => {
		const { client, onAbort, evict } = await liveClient();
		await trapPatternCount({
			on: (names) => names.includes("a_cap") && names.includes("b_cap"),
		});
		const walks = await countWalks();
		const file = pythonFile();
		const poisoned = [rule("a", "a_cap"), rule("b", "b_cap")];
		const healthy = [rule("c", "c_cap"), rule("d", "d_cap")];

		// Two traps charge the poisoned set's batch key.
		for (let round = 0; round < 3; round++) {
			evict();
			await client.runQueriesOnFile(poisoned, file, "python");
		}
		const before = walks.walks();
		expect(ids(await client.runQueriesOnFile(healthy, file, "python"))).toEqual(
			["c", "d"],
		);

		// One combined walk: the healthy set's key is its own, so it was not
		// skipped into the two-walk per-rule fallback.
		expect(walks.walks() - before).toBe(1);
		expect(onAbort).not.toHaveBeenCalled();
		// The healthy set's compile did not trap, so it spent nothing.
		expect(remainingBudget(client)).toBe(2);
	});
});

describe("a transient compile trap does not degrade the batch for the process (#3707)", () => {
	it("runs a rule again after a one-off probe trap", async () => {
		const { client, onAbort, evict } = await liveClient();
		const state = { trapping: true };
		await trapPatternCount({
			on: (names) => state.trapping && names.includes("trap_me"),
		});
		const file = pythonFile();
		const set = [rule("ok", "fn"), rule("flaky", "trap_me")];

		// The trap skips the rule for this build.
		expect(ids(await client.runQueriesOnFile(set, file, "python"))).toEqual([
			"ok",
		]);
		state.trapping = false;
		// Master cached that degraded batch: "flaky" never ran again.
		expect(ids(await client.runQueriesOnFile(set, file, "python"))).toEqual([
			"ok",
			"flaky",
		]);

		// A success decayed the rule's entry: the next one-off trap is not
		// charged (a second trap on a stale entry would be), so the rule runs
		// again after it too.
		state.trapping = true;
		evict();
		await client.runQueriesOnFile(set, file, "python");
		state.trapping = false;
		expect(ids(await client.runQueriesOnFile(set, file, "python"))).toEqual([
			"ok",
			"flaky",
		]);
		expect(wasmTrapReasons().some((r) => r.startsWith("input charged:"))).toBe(
			false,
		);
		expect(onAbort).not.toHaveBeenCalled();
	});

	it("builds the combined batch again after a one-off compile trap", async () => {
		const { client, onAbort, evict } = await liveClient();
		const state = { trapping: true };
		await trapPatternCount({
			on: (names) =>
				state.trapping && names.includes("a_cap") && names.includes("b_cap"),
		});
		const walks = await countWalks();
		const file = pythonFile();
		const set = [rule("a", "a_cap"), rule("b", "b_cap")];

		// The trapped combined compile falls back to one walk per rule.
		await client.runQueriesOnFile(set, file, "python");
		expect(walks.walks()).toBe(2);
		state.trapping = false;
		// Master cached the null: two walks again, for the process lifetime.
		await client.runQueriesOnFile(set, file, "python");
		await client.runQueriesOnFile(set, file, "python");
		expect(walks.walks()).toBe(2 + 1 + 1);

		// A success decayed the batch key's entry: the next one-off trap is not
		// charged (it would be on a stale entry), so the batch builds again.
		state.trapping = true;
		evict();
		await client.runQueriesOnFile(set, file, "python");
		state.trapping = false;
		const before = walks.walks();
		await client.runQueriesOnFile(set, file, "python");
		expect(walks.walks() - before).toBe(1);
		expect(wasmTrapReasons().some((r) => r.startsWith("input charged:"))).toBe(
			false,
		);
		expect(onAbort).not.toHaveBeenCalled();
	});
});

describe("batches that did not trap are still cached (#3707)", () => {
	it("caches a healthy batch", async () => {
		const { client } = await liveClient();
		const compiles = await trapPatternCount({ on: () => false });
		const file = pythonFile();
		const set = [rule("a", "a_cap"), rule("b", "b_cap")];

		await client.runQueriesOnFile(set, file, "python");
		const afterFirst = compiles.calls();
		await client.runQueriesOnFile(set, file, "python");
		await client.runQueriesOnFile(set, file, "python");

		expect(afterFirst).toBeGreaterThan(0);
		expect(compiles.calls()).toBe(afterFirst);
	});

	it("caches a batch whose rule does not compile on this grammar", async () => {
		const { client } = await liveClient();
		const compiles = await trapPatternCount({ on: () => false });
		const file = pythonFile();
		// A grammar error is deterministic, not a wasm trap: caching it is right.
		const invalid = { ...rule("invalid", "x"), query: "(no_such_node) @x" };
		const set = [rule("ok", "fn"), invalid];

		expect(ids(await client.runQueriesOnFile(set, file, "python"))).toEqual([
			"ok",
		]);
		const afterFirst = compiles.calls();
		await client.runQueriesOnFile(set, file, "python");

		expect(compiles.calls()).toBe(afterFirst);
	});

	// Recurrence (#3780, #3731 survivor): `classifyTreeSitterWasmError(err) ===
	// "trap"` on the combined-compile catch replaced by `true` left the suite
	// green. Then a deterministic, non-trap failure of the combined compile (a
	// grammar error in the joined source) was never negative-cached, so every
	// scan paid the per-rule probes and the failing combined compile again.
	it("caches a batch whose combined compile fails without a wasm trap", async () => {
		const { client } = await liveClient();
		const compiles = await trapPatternCount({
			on: (names) => names.includes("a_cap") && names.includes("b_cap"),
			error: () => new Error("Query error at position 0"),
		});
		const file = pythonFile();
		const set = [rule("a", "a_cap"), rule("b", "b_cap")];

		// The failed combined compile falls back to one walk per rule.
		expect(ids(await client.runQueriesOnFile(set, file, "python"))).toEqual([
			"a",
			"b",
		]);
		const afterFirst = compiles.calls();
		await client.runQueriesOnFile(set, file, "python");
		await client.runQueriesOnFile(set, file, "python");

		// Two probes and the one combined compile, once.
		expect(afterFirst).toBe(3);
		expect(compiles.calls()).toBe(afterFirst);
	});

	it("hashes no input while a healthy batch builds and hits the cache", async () => {
		const { client, evict } = await liveClient();
		const key = vi.spyOn(
			client as unknown as { wasmInputKey: (input: unknown) => string },
			"wasmInputKey",
		);
		const file = pythonFile();
		const set = [rule("a", "a_cap"), rule("b", "b_cap")];

		await client.runQueriesOnFile(set, file, "python");
		await client.runQueriesOnFile(set, file, "python");
		evict();
		await client.runQueriesOnFile(set, file, "python");

		expect(key).not.toHaveBeenCalled();
	});
});

describe("a single-rule consumer is keyed by rule id and query text (#3678 F4)", () => {
	// Recurrence (#3780, #3706 survivor): the `${id}\0${query}` consumer key
	// of `runQueryOnFile` replaced by the bare rule id left all 29 related test
	// files green. Two rules sharing an id (a project rule overriding a bundled
	// one with an edited query) then shared one consumer identity, so the
	// healthy rule's success decayed the trapping rule's entry. Each trap then
	// looked like a first trap and spent budget until the runtime aborted.
	it("does not let a healthy rule decay a same-id rule's trap entry", async () => {
		const { client, onAbort } = await liveClient();
		const { Query } = await loadWebTreeSitter();
		const realMatches = Query.prototype.matches;
		vi.spyOn(Query.prototype, "matches").mockImplementation(function (
			this: InstanceType<typeof Query>,
			...args: Parameters<typeof realMatches>
		) {
			if (this.captureNames.includes("trap_me")) throw trap();
			return realMatches.apply(this, args);
		});
		const file = pythonFile();
		const poisoned = rule("shared-id", "trap_me");
		const healthy = rule("shared-id", "fn");

		// Round 0: the poisoned query traps, then the healthy one succeeds on the
		// same file and tries to decay the entry that trap left.
		expect(await client.runQueryOnFile(poisoned, file, "python")).toEqual([]);
		expect(await client.runQueryOnFile(healthy, file, "python")).toHaveLength(
			1,
		);
		// Later rounds: the entry survived, so the second trap is charged to the
		// file's content and the parse is skipped from then on (healthy included).
		for (let round = 1; round < 6; round++) {
			await client.runQueryOnFile(poisoned, file, "python");
			await client.runQueryOnFile(healthy, file, "python");
		}

		// One unit for the poisoned query; its later traps are charged to it.
		expect(onAbort).not.toHaveBeenCalled();
		expect(wasmTrapReasons().some((r) => r.startsWith("input charged:"))).toBe(
			true,
		);
		expect(remainingBudget(client)).toBe(2);
	});

	// Recurrence (#3780 verify F2): reducing the consumer key to the bare query
	// text stayed green because the first test shares a capture name, not a
	// query. Two rules with one query text still consume differently when one
	// carries a post_filter: its `applyPostFilter` can trap where the plain
	// rule's consume cannot, and a shared identity lets the plain rule's success
	// decay that trap entry.
	it("does not let a plain rule decay the trap entry of a same-query rule with a post_filter", async () => {
		const { client, onAbort } = await liveClient();
		vi.spyOn(
			client as unknown as { applyPostFilter: () => boolean },
			"applyPostFilter",
		).mockImplementation(() => {
			throw trap();
		});
		const file = pythonFile();
		const filtered = {
			...rule("filtered-id", "fn"),
			post_filter: "any_filter",
		};
		const plain = rule("plain-id", "fn");

		expect(await client.runQueryOnFile(filtered, file, "python")).toEqual([]);
		expect(await client.runQueryOnFile(plain, file, "python")).toHaveLength(1);
		for (let round = 1; round < 6; round++) {
			await client.runQueryOnFile(filtered, file, "python");
			await client.runQueryOnFile(plain, file, "python");
		}

		expect(onAbort).not.toHaveBeenCalled();
		expect(wasmTrapReasons().some((r) => r.startsWith("input charged:"))).toBe(
			true,
		);
		expect(remainingBudget(client)).toBe(2);
	});
});
