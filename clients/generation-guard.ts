/**
 * Capture-generation-before-await, check-after — as one primitive (#1754).
 *
 * The shape: a write that follows an `await` must prove the world it captured
 * still exists. A session reset, a cache refresh, or a newer request for the
 * same key can land while the write's producer is in flight, and the late
 * write then publishes an answer the caller no longer wants — or, in the
 * eviction direction, deletes an entry a SUCCESSOR already installed.
 *
 * This module was extracted after the pattern was hand-rolled four times and
 * its absence was a review finding twice:
 *
 * - `clients/dispatch/runners/utils/runner-helpers.ts` held the guarded form
 *   at one site and the unguarded form at another IN THE SAME FILE; #1674's
 *   F5 round copied the guard by hand to three more write sites.
 * - `clients/lsp/client.ts`'s per-(path, identifier) pull sequences (#1682),
 *   whose first guard was vacuous until a review round bound it.
 * - `clients/lsp/workspace-diagnostics-cache.ts`'s per-cwd epochs (#1669),
 *   where the epoch guarded `persist()` but not `lookup()`.
 * - `clients/review-graph/builder.ts`'s workspace-cache epoch, the shape the
 *   one above was modelled on.
 *
 * Two things every one of those needed and at least one got wrong:
 *
 * 1. The check must run at WRITE time, not only at capture time.
 * 2. The stale branch must be OBSERVABLE. A silently dropped write looks
 *    exactly like a write that never happened, which is why the vacuous
 *    guards survived review. `guardedWrite` emits one bounded degradation
 *    record per (source, subject) with the count of repeats, so a dogfood
 *    session can tell "the guard is working" from "the guard never fires".
 *
 * ## Scope and lifetime
 *
 * A `GenerationSource` is a plain counter owned by the RESETTING SEAM — the
 * function that already clears the state the generation protects. This module
 * holds no session state of its own: sources live in the modules that create
 * them, and their reset policy is that module's declaration in
 * `tests/support/session-state-registry.ts`. The only module-level state here
 * is the name registry below, which exists so the #1754 sweep can ask "which
 * stores declare a generation" instead of guessing from identifier names.
 *
 * ## Cost
 *
 * `isCurrent()` on an unkeyed source is a field read and a compare. On a
 * keyed map it is a compare while nothing has been invalidated, and a
 * normalize plus one `Map.get` once something has. The hand-rolled form it
 * replaces normalized on EVERY call, and this repo's normalizer runs
 * `realpathSync.native` on Windows, so an uninterrupted sweep pays that
 * syscall once rather than once per file. See
 * `GenerationMapOptions.normalizeKey` for the correctness reason the slow
 * path exists at all.
 */

import { BoundedFifoMap } from "./bounded-cache.js";
import { incrementDegradationCount } from "./degradation-ledger.js";

/**
 * Names of every generation-carrying store created through this module.
 *
 * Registration is by CONSTRUCTION: you cannot make a `GenerationSource`
 * without appearing here. `tests/clients/generation-guard-sweep.test.ts`
 * reads this to enforce the ratchet — a file that hand-rolls the pattern
 * instead of declaring it here must carry an explicit exemption reason.
 *
 * Process-lifetime and bounded: names are compile-time literals from module
 * initialization, so this cannot grow with workload.
 */
const declaredSources = new Set<string>();

const MAX_DECLARED_SOURCES = 128;

function declare(name: string): string {
	if (!name.trim()) {
		throw new Error("generation source needs a non-empty name");
	}
	if (declaredSources.size < MAX_DECLARED_SOURCES) declaredSources.add(name);
	return name;
}

/** Every generation-carrying store name declared this process. */
export function listDeclaredGenerationSources(): string[] {
	return [...declaredSources].sort((a, b) => a.localeCompare(b));
}

/**
 * A handle on one captured generation.
 *
 * Created before the await; consulted after it. `isCurrent()` is the raw
 * question; `guardedWrite` is the answer plus the telemetry, and is what
 * write sites should use unless they need to branch on staleness for some
 * reason other than skipping the write.
 */
export interface GenerationHandle {
	/** The generation observed at capture time. */
	readonly generation: number;
	/** True while the source has not advanced past the captured generation. */
	isCurrent(): boolean;
	/**
	 * Run `write` only if the captured generation is still current.
	 *
	 * Returns the write's value, or `undefined` when the write was dropped.
	 * A drop is recorded once per (source, subject) with a repeat count —
	 * `subject` must therefore identify WHAT was dropped (the cwd, the tool,
	 * the file), never a bare constant, or the ledger loses the discriminating
	 * identity that makes it useful.
	 */
	guardedWrite<T>(subject: string, write: () => T): T | undefined;
}

/** A single monotonic counter owned by one resetting seam. */
export interface GenerationSource {
	readonly name: string;
	/** The current generation. */
	current(): number;
	/** Advance the generation, invalidating every outstanding handle. */
	bump(): number;
	/** Capture the current generation for a write that follows an await. */
	capture(): GenerationHandle;
}

/**
 * A per-key family of generation stamps, for stores whose invalidation is
 * scoped to one cwd, one document, or one (path, source) pair rather than the
 * whole process.
 *
 * ## Stamps, not per-key counters
 *
 * A stamp is drawn from ONE monotonic ticket counter shared by every key, so
 * no two keys ever hold the same stamp and no stamp is issued twice. That is
 * what makes dropping a key safe. A per-key counter starting at 0 fails OPEN:
 * drop the key and it reads 0 again, which is exactly the value a first-use
 * handle holds, so that handle reads current and its stale write lands. With
 * map-wide tickets, a forgotten or evicted key reads 0, and 0 is a stamp no
 * live handle can hold, so every outstanding handle for that key reports
 * stale.
 *
 * Treat the number as OPAQUE. It orders nothing and counts nothing; the only
 * meaningful operation is equality against a captured stamp.
 *
 * ## Bounded, and fail-closed at the bound
 *
 * Eviction drops the oldest key. Its outstanding handles then read 0 and drop
 * their writes, the same outcome a real invalidation produces, so the bound
 * costs correctness nothing and only costs work.
 */
export interface GenerationMap {
	readonly name: string;
	/** The key's current stamp, or 0 when it holds none. Opaque; compare only. */
	current(key: string): number;
	/** Issue the key a fresh stamp, invalidating every outstanding handle. */
	bump(key: string): number;
	/** Capture the key's stamp for a write that follows an await. */
	capture(key: string): GenerationHandle;
	/**
	 * Drop a key entirely, invalidating its outstanding handles.
	 *
	 * For stores that RETIRE a key rather than invalidating it, and that need
	 * the memory back. `retirePullSource` in `clients/lsp/client.ts` is the
	 * shape. This ships ahead of its first production caller: `lsp/client.ts`
	 * is the named next migration and this is the operation it needs, so the
	 * primitive carries it now rather than growing an API under merge pressure.
	 */
	forget(key: string): void;
	/**
	 * Drop every key, invalidating all outstanding handles.
	 *
	 * Use this when the owning seam has a whole-store reset boundary rather
	 * than a per-key invalidation.
	 */
	clear(): void;
	/** Number of keys currently retained, for tests and bound assertions. */
	size(): number;
}

function recordStaleWrite(
	sourceName: string,
	subject: string,
	captured: number,
	observed: number,
): void {
	incrementDegradationCount({
		kind: "generation-guard-stale-write",
		subject: `${sourceName}:${subject}`,
		reason: `write dropped: captured generation ${captured}, current ${observed}`,
	});
}

function makeHandle(
	sourceName: string,
	generation: number,
	read: () => number,
): GenerationHandle {
	return {
		generation,
		isCurrent(): boolean {
			return read() === generation;
		},
		guardedWrite<T>(subject: string, write: () => T): T | undefined {
			const observed = read();
			if (observed !== generation) {
				recordStaleWrite(sourceName, subject, generation, observed);
				return undefined;
			}
			return write();
		},
	};
}

/**
 * Create a counter for a store invalidated as a whole.
 *
 * `name` appears in the stale-write ledger subject and in the sweep's
 * declaration list, so it must name the STORE, not the module.
 */
export function createGenerationSource(name: string): GenerationSource {
	declare(name);
	let generation = 0;
	const read = (): number => generation;
	return {
		name,
		current: read,
		bump(): number {
			generation += 1;
			return generation;
		},
		capture(): GenerationHandle {
			return makeHandle(name, generation, read);
		},
	};
}

const DEFAULT_MAX_KEYS = 512;

export interface GenerationMapOptions {
	/**
	 * Normalize keys before use. Pass the same normalizer the guarded store
	 * uses for its own map, or two spellings of one cwd get two stamps.
	 *
	 * The normalizer MAY consult the filesystem, and the repo's does:
	 * `normalizeMapKey` runs `realpathSync.native` on Windows, which answers
	 * differently once a path that did not exist comes into existence. A
	 * handle therefore re-runs the normalizer whenever the map has been
	 * invalidated since that handle was captured, and skips it otherwise.
	 *
	 * The common sweep — capture once, check per file, no refresh — pays the
	 * normalizer exactly once instead of once per file. A sweep that IS
	 * invalidated pays it on every check from that point on. That is the right
	 * trade: correctness is not negotiable, and an invalidated sweep is about
	 * to stop serving from this store anyway.
	 */
	normalizeKey?: (key: string) => string;
	/**
	 * Retained-key ceiling. Eviction drops the oldest key and fails CLOSED:
	 * its handles read 0, a stamp no live handle holds. See `GenerationMap`.
	 */
	maxKeys?: number;
}

/**
 * Create a per-key family of counters.
 *
 * Use this when invalidation is scoped: a cache refresh for ONE cwd must not
 * drop an in-flight write for another, and a newer pull request for one
 * (path, source) pair must not invalidate a different pair's.
 */
export function createGenerationMap(
	name: string,
	options: GenerationMapOptions = {},
): GenerationMap {
	declare(name);
	const normalize = options.normalizeKey ?? ((key: string): string => key);
	const maxKeys = Math.max(1, options.maxKeys ?? DEFAULT_MAX_KEYS);
	// Insertion-ordered: the oldest key is evicted first. Re-stamping a key
	// refreshes its position so a hot cwd is not evicted by a burst of
	// one-shot ones.
	const stamps = new BoundedFifoMap<string, number>(maxKeys);
	// ONE ticket counter for the whole map. See GenerationMap's doc comment:
	// per-key counters starting at 0 make eviction and forget() fail OPEN.
	// 0 is reserved for "this key holds no stamp" and is never issued.
	let nextTicket = 0;
	// Counts every mutation that can change what a key's stamp reads: a bump,
	// a forget, an eviction. A handle records this at capture and re-derives
	// its key only when it has moved. See normalizeKey's doc comment.
	let invalidations = 0;

	const read = (key: string): number => stamps.get(key) ?? 0;

	function issue(key: string): number {
		nextTicket += 1;
		stamps.delete(key);
		const evicted = stamps.set(key, nextTicket);
		invalidations += evicted.length;
		return nextTicket;
	}

	return {
		name,
		current(key: string): number {
			return read(normalize(key));
		},
		bump(key: string): number {
			invalidations += 1;
			return issue(normalize(key));
		},
		capture(key: string): GenerationHandle {
			const normalized = normalize(key);
			// A first-use capture ISSUES a stamp rather than reading 0. A handle
			// holding 0 would be indistinguishable from one whose key was later
			// forgotten or evicted, which is the fail-open hole this closes.
			const stamp = read(normalized) || issue(normalized);
			const capturedInvalidations = invalidations;
			return makeHandle(`${name}[${normalized}]`, stamp, () => {
				// Fast path: nothing has been invalidated since capture, so no key
				// can have changed stamps and the normalizer need not run again.
				if (invalidations === capturedInvalidations) return stamp;
				// Something moved. Re-derive the key from the ORIGINAL string: a
				// normalizer that consults the filesystem can resolve the same
				// input to a different key once the path exists, and a stamp read
				// under the stale spelling would falsely read current.
				return read(normalize(key));
			});
		},
		forget(key: string): void {
			invalidations += 1;
			stamps.delete(normalize(key));
		},
		clear(): void {
			invalidations += 1;
			stamps.clear();
		},
		size(): number {
			return stamps.size;
		},
	};
}

/**
 * Capture the generation, run `fn`, and hand it the handle.
 *
 * Sugar for the common `const handle = source.capture(); ... await ...;
 * handle.guardedWrite(...)` sequence. Use `capture()` directly when the
 * handle must outlive the function that made it — an eviction guard in a
 * `.finally()` is the usual case, and it is what both #1754 migrations do.
 *
 * This ships ahead of its first production caller. Both migrated sites need
 * the handle to outlive its producer, so neither uses this form; it exists
 * because the issue specifies it and because the sites still to migrate
 * (`runtime-coordinator.ts`, `runtime-turn.ts`) write inside the async
 * function that captured. Said plainly rather than left for a reader to
 * discover by grep.
 */
export async function withGeneration<T>(
	source: Pick<GenerationSource, "capture">,
	fn: (handle: GenerationHandle) => Promise<T>,
): Promise<T> {
	return fn(source.capture());
}
