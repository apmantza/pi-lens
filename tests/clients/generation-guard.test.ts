/**
 * The GenerationGuard primitive's semantics, tested once (#1754).
 *
 * Every hand-rolled copy of this pattern needed a review round to get right,
 * and two reached review VACUOUS — the guard was there, but nothing could
 * make it fire. So each test here is written to red when the guard it covers
 * is deleted or neutered, not merely to pass when it is present.
 */

import { beforeEach, describe, expect, it } from "vitest";

import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import {
	createGenerationMap,
	createGenerationSource,
	listDeclaredGenerationSources,
	withGeneration,
} from "../../clients/generation-guard.js";

function staleWrites(): Array<{ subject: string; reason: string }> {
	const group = getDegradationSummary().find(
		(entry) => entry.kind === "generation-guard-stale-write",
	);
	return group?.latestReasons ?? [];
}

function staleWriteCount(): number {
	return (
		getDegradationSummary().find(
			(entry) => entry.kind === "generation-guard-stale-write",
		)?.count ?? 0
	);
}

beforeEach(() => resetDegradationLedger());

describe("GenerationSource — straddle", () => {
	it("drops a write whose generation was bumped mid-flight", async () => {
		const source = createGenerationSource("straddle-store");
		const store = new Map<string, string>();

		const inFlight = withGeneration(source, async (handle) => {
			await Promise.resolve();
			source.bump(); // the session reset lands while the producer is awaited
			return handle.guardedWrite("tool-a", () => {
				store.set("tool-a", "late");
				return "wrote";
			});
		});

		await expect(inFlight).resolves.toBeUndefined();
		expect(store.has("tool-a")).toBe(false);
	});

	it("records exactly one bounded entry naming the dropped write", async () => {
		const source = createGenerationSource("straddle-store");
		const handle = source.capture();
		source.bump();

		handle.guardedWrite("tool-a", () => "x");

		const reasons = staleWrites();
		expect(reasons).toHaveLength(1);
		expect(reasons[0]?.subject).toBe("straddle-store:tool-a");
		expect(reasons[0]?.reason).toContain("captured generation 0");
		expect(reasons[0]?.reason).toContain("current 1");
	});

	it("keeps repeats bounded to one retained entry while counting them all", () => {
		const source = createGenerationSource("straddle-store");
		const handles = Array.from({ length: 5 }, () => source.capture());
		source.bump();

		for (const handle of handles) handle.guardedWrite("tool-a", () => "x");

		expect(staleWrites()).toHaveLength(1);
		expect(staleWriteCount()).toBe(5);
	});

	it("keeps the discriminating identity when different writes are dropped", () => {
		const source = createGenerationSource("straddle-store");
		const first = source.capture();
		const second = source.capture();
		source.bump();

		first.guardedWrite("tool-a", () => "x");
		second.guardedWrite("tool-b", () => "x");

		expect(
			staleWrites()
				.map((entry) => entry.subject)
				.sort(),
		).toEqual(["straddle-store:tool-a", "straddle-store:tool-b"]);
	});
});

describe("GenerationSource — no bump", () => {
	it("lands the write and returns its value when nothing reset", async () => {
		const source = createGenerationSource("quiet-store");
		const store = new Map<string, string>();

		const result = await withGeneration(source, async (handle) => {
			await Promise.resolve();
			return handle.guardedWrite("tool-a", () => {
				store.set("tool-a", "fresh");
				return "wrote";
			});
		});

		expect(result).toBe("wrote");
		expect(store.get("tool-a")).toBe("fresh");
		expect(staleWriteCount()).toBe(0);
	});

	it("lets a write land after an unrelated source bumps", () => {
		const mine = createGenerationSource("mine");
		const theirs = createGenerationSource("theirs");
		const handle = mine.capture();

		theirs.bump();

		expect(handle.guardedWrite("k", () => "wrote")).toBe("wrote");
	});

	it("distinguishes a dropped write from a write that returned undefined", () => {
		const source = createGenerationSource("undef-store");
		const handle = source.capture();
		// A live write returning undefined must not look like a drop: the ledger
		// is the discriminator, and it must stay silent here.
		expect(handle.guardedWrite("k", () => undefined)).toBeUndefined();
		expect(staleWriteCount()).toBe(0);
	});
});

describe("GenerationSource — double bump", () => {
	it("still drops after two bumps and reports the observed generation", () => {
		const source = createGenerationSource("double-store");
		const handle = source.capture();

		source.bump();
		source.bump();

		expect(handle.isCurrent()).toBe(false);
		expect(handle.guardedWrite("k", () => "wrote")).toBeUndefined();
		expect(staleWrites()[0]?.reason).toContain("current 2");
	});

	it("does not let a handle captured between bumps be resurrected", () => {
		const source = createGenerationSource("double-store");
		source.bump();
		const mid = source.capture();
		source.bump();

		expect(mid.isCurrent()).toBe(false);
		// The counter is monotonic: there is no path back to generation 1.
		expect(source.bump()).toBe(3);
		expect(mid.isCurrent()).toBe(false);
	});
});

describe("GenerationSource — eviction direction (#1674's second half)", () => {
	it("a stale completion does not clear a successor's in-flight entry", async () => {
		const source = createGenerationSource("in-flight-store");
		const inFlight = new Map<string, string>();

		// Old session starts a probe.
		const oldHandle = source.capture();
		inFlight.set("shim", "old-probe");

		// Session reset clears the map and bumps.
		inFlight.clear();
		source.bump();

		// New session immediately starts a replacement probe for the same key.
		inFlight.set("shim", "new-probe");

		// The old probe now settles and runs its eviction guard.
		oldHandle.guardedWrite("shim", () => inFlight.delete("shim"));

		expect(inFlight.get("shim")).toBe("new-probe");
		expect(staleWrites()[0]?.subject).toBe("in-flight-store:shim");
	});

	it("a current completion does clear its own entry", () => {
		const source = createGenerationSource("in-flight-store");
		const inFlight = new Map<string, string>([["shim", "probe"]]);
		const handle = source.capture();

		handle.guardedWrite("shim", () => inFlight.delete("shim"));

		expect(inFlight.has("shim")).toBe(false);
		expect(staleWriteCount()).toBe(0);
	});
});

describe("GenerationMap — keyed independence", () => {
	it("bumping one key does not invalidate another key's handle", () => {
		const map = createGenerationMap("keyed-store");
		const a = map.capture("/repo/a");
		const b = map.capture("/repo/b");

		map.bump("/repo/a");

		expect(a.isCurrent()).toBe(false);
		expect(b.isCurrent()).toBe(true);
		expect(a.guardedWrite("entry", () => "wrote")).toBeUndefined();
		expect(b.guardedWrite("entry", () => "wrote")).toBe("wrote");
	});

	it("names the key in the ledger subject", () => {
		const map = createGenerationMap("keyed-store");
		const handle = map.capture("/repo/a");
		map.bump("/repo/a");

		handle.guardedWrite("entry", () => "x");

		expect(staleWrites()[0]?.subject).toBe("keyed-store[/repo/a]:entry");
	});

	it("applies the caller's key normalizer to both capture and bump", () => {
		const map = createGenerationMap("keyed-store", {
			normalizeKey: (key) => key.toLowerCase(),
		});
		const handle = map.capture("/Repo/A");

		map.bump("/repo/a");

		expect(handle.isCurrent()).toBe(false);
	});

	it("stamps are unique across keys, so no key inherits another's", () => {
		const map = createGenerationMap("keyed-store");
		map.capture("/repo/a");
		map.capture("/repo/b");
		map.bump("/repo/a");
		map.bump("/repo/b");

		const stamps = ["/repo/a", "/repo/b"].map((key) => map.current(key));
		expect(new Set(stamps).size).toBe(2);
		// 0 is reserved for "holds no stamp" and must never be issued.
		expect(stamps).not.toContain(0);
	});

	it("forget drops the key and STALES its outstanding handles", () => {
		const map = createGenerationMap("keyed-store");
		const dropped = map.capture("/repo/a");
		const kept = map.capture("/repo/b");
		expect(dropped.isCurrent()).toBe(true);

		map.forget("/repo/a");

		// The fail-open hole this design closes: with a per-key counter the
		// forgotten key would read 0 again, which is exactly what a first-use
		// handle held, so this handle would read CURRENT and its stale write
		// would land. `forget` is the documented path for `retirePullSource`.
		expect(map.current("/repo/a")).toBe(0);
		expect(dropped.isCurrent()).toBe(false);
		expect(dropped.guardedWrite("entry", () => "wrote")).toBeUndefined();
		expect(kept.isCurrent()).toBe(true);
	});

	it("a key re-captured after forget never reuses the dropped stamp", () => {
		const map = createGenerationMap("keyed-store");
		const dropped = map.capture("/repo/a");
		map.forget("/repo/a");

		const revived = map.capture("/repo/a");

		expect(revived.generation).not.toBe(dropped.generation);
		expect(revived.isCurrent()).toBe(true);
		expect(dropped.isCurrent()).toBe(false);
	});

	it("bounds retained keys and fails CLOSED on eviction", () => {
		const map = createGenerationMap("keyed-store", { maxKeys: 2 });
		// The reviewer's probe. A first-use capture is the common case, and it
		// is exactly the case a per-key counter got wrong: `hot` would read 0
		// after eviction, matching a generation-0 handle, and the stale write
		// would land.
		const hot = map.capture("/repo/hot");
		expect(hot.isCurrent()).toBe(true);

		map.bump("/repo/b");
		map.bump("/repo/c");

		expect(map.size()).toBe(2);
		expect(map.current("/repo/hot")).toBe(0);
		expect(hot.isCurrent()).toBe(false);
		expect(hot.guardedWrite("entry", () => "wrote")).toBeUndefined();
	});

	it("an eviction driven by CAPTURE alone still stales the evicted handle", () => {
		// Eviction can happen with no bump at all: three first-use captures on a
		// two-key map push the oldest out. The handle's fast path must notice,
		// or it keeps answering from the stamp it cached at capture time and
		// reports current for a key the map no longer holds.
		const map = createGenerationMap("keyed-store", { maxKeys: 2 });
		const hot = map.capture("/repo/hot");
		map.capture("/repo/b");
		map.capture("/repo/c");

		expect(map.size()).toBe(2);
		expect(map.current("/repo/hot")).toBe(0);
		expect(hot.isCurrent()).toBe(false);
		expect(hot.guardedWrite("entry", () => "wrote")).toBeUndefined();
	});

	it("a current() read never reorders eviction order (red on an accidental LRU substitution)", () => {
		// #2442 review F4: the eviction tests above only ever read a key AFTER
		// it was evicted, so they passed whether the underlying BoundedFifoMap
		// was FIFO or LRU. `current(key)` is a real production read —
		// `stamps.get(normalizedKey)` — so reading the OLDEST key before the
		// overflow write is what discriminates the two.
		const map = createGenerationMap("keyed-store", { maxKeys: 2 });
		map.bump("/repo/oldest");
		map.bump("/repo/newer");

		// The production read, on the oldest key, before the overflow.
		expect(map.current("/repo/oldest")).toBeGreaterThan(0);

		map.bump("/repo/overflow");

		expect(map.size()).toBe(2);
		// FIFO: the read did not promote /repo/oldest, so it is still the one
		// evicted and now reads the reserved 0. Under an LRU substitution both
		// assertions flip — /repo/oldest survives and /repo/newer is evicted.
		expect(map.current("/repo/oldest")).toBe(0);
		expect(map.current("/repo/newer")).toBeGreaterThan(0);
	});

	it("fails closed for an evicted key that was bumped before eviction too", () => {
		const map = createGenerationMap("keyed-store", { maxKeys: 2 });
		map.capture("/repo/hot");
		map.bump("/repo/hot");
		const live = map.capture("/repo/hot");
		expect(live.isCurrent()).toBe(true);

		map.bump("/repo/b");
		map.bump("/repo/c");

		expect(live.isCurrent()).toBe(false);
		expect(live.guardedWrite("entry", () => "wrote")).toBeUndefined();
	});
});

describe("GenerationMap — whole-store clear", () => {
	it("clear drops every key and stales every outstanding handle", () => {
		const map = createGenerationMap("cleared-store");
		const a = map.capture("/repo/a");
		const b = map.capture("/repo/b");
		map.bump("/repo/c");
		expect(map.size()).toBe(3);

		map.clear();

		// #2777 round 5: `clear()` shipped with no direct test, and a
		// compile-valid no-op mutation (`void stamps` instead of
		// `stamps.clear()`) left this suite and tests/clients/tool-cwd.test.ts
		// green. These assertions pin the whole-store reset: every stamp
		// gone, every outstanding handle stale, the map reusable after.
		expect(map.size()).toBe(0);
		expect(map.current("/repo/a")).toBe(0);
		expect(map.current("/repo/b")).toBe(0);
		expect(map.current("/repo/c")).toBe(0);
		expect(a.isCurrent()).toBe(false);
		expect(b.isCurrent()).toBe(false);
		expect(a.guardedWrite("entry", () => "wrote")).toBeUndefined();
		expect(b.guardedWrite("entry", () => "wrote")).toBeUndefined();

		// A capture after clear is fresh and its writes land: the reset seam
		// empties the map, it does not break it.
		const fresh = map.capture("/repo/a");
		expect(fresh.isCurrent()).toBe(true);
		expect(fresh.guardedWrite("entry", () => "wrote")).toBe("wrote");
	});
});

describe("GenerationMap — a normalizer whose answer moves", () => {
	// #1754 review F3. `normalizeMapKey` runs `realpathSync.native`, so a key
	// that does not exist yet normalizes differently once it does. Normalizing
	// ONCE at capture and never again would let a bump land on the new
	// spelling while the handle kept reading the old one — reporting current,
	// and landing a write the bump was supposed to drop.
	function movingNormalizer(): {
		normalizeKey: (key: string) => string;
		settle: () => void;
	} {
		let settled = false;
		return {
			normalizeKey: (key) => (settled ? key.toLowerCase() : key),
			settle: () => {
				settled = true;
			},
		};
	}

	it("re-derives the key after an invalidation, so the bump still stales it", () => {
		const moving = movingNormalizer();
		const map = createGenerationMap("moving-store", {
			normalizeKey: moving.normalizeKey,
		});
		const handle = map.capture("/Repo/NewRoot");
		expect(handle.isCurrent()).toBe(true);

		// The path comes into existence; the normalizer now answers differently.
		moving.settle();
		map.bump("/Repo/NewRoot");

		expect(handle.isCurrent()).toBe(false);
		expect(handle.guardedWrite("entry", () => "wrote")).toBeUndefined();
	});

	it("does not re-run the normalizer while nothing has been invalidated", () => {
		let calls = 0;
		const map = createGenerationMap("counting-store", {
			normalizeKey: (key) => {
				calls += 1;
				return key;
			},
		});
		const handle = map.capture("/repo/a");
		const afterCapture = calls;

		for (let i = 0; i < 50; i++) expect(handle.isCurrent()).toBe(true);

		// The hot path: an uninterrupted sweep pays the normalizer once, not
		// once per file. This is the realpath syscall the migration removed.
		expect(calls).toBe(afterCapture);
	});
});

describe("declaration registry", () => {
	it("registers by construction, so a store cannot guard without declaring", () => {
		createGenerationSource("declared-a");
		createGenerationMap("declared-b");

		const declared = listDeclaredGenerationSources();
		expect(declared).toContain("declared-a");
		expect(declared).toContain("declared-b");
	});

	it("rejects an unnamed source", () => {
		expect(() => createGenerationSource("  ")).toThrow(/non-empty name/);
	});
});
