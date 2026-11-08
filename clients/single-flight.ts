/**
 * `singleFlight` — at most one execution per key, clear owned by the primitive.
 *
 * Ten sites hand-roll the same five lines: look up a key in a promise map,
 * return the existing promise if there is one, otherwise start the work and
 * delete the key in a `finally`. The class has a measured bug yield, and every
 * bug is in the part the call site wrote rather than the part it meant:
 *
 * - #1690: the `finally`-clear was never exercised, so its regression test
 *   passed with the clear deleted. A memo short-circuit above the in-flight
 *   check meant the second call never reached it.
 * - #1674: the `finally` deleted the key unconditionally, so a probe settling
 *   after a session reset evicted the REPLACEMENT probe a new session had
 *   already started for the same key.
 * - #1687: the trailing-rerun bit shipped unpinned — the test asserted "at most
 *   two passes" one-sidedly, which a coalescer that dropped the rerun entirely
 *   also satisfies.
 * - #1722: an inner latch was vacuous and its own mutation matrix deleted it.
 *
 * This module owns those four guards once. The API is the INTERSECTION of the
 * ten sites, not a superset: share, clear-in-finally, optional trailing-rerun
 * coalescing, optional generation check. Anything a single site needs stays at
 * that site.
 *
 * LIFECYCLE: the primitive owns no module state. `createSingleFlight` returns
 * a closure, so each registry's lifetime is its OWNER's — an instance field
 * lives as long as the instance, a module-level const as long as the process.
 * That keeps the session-state question where it belongs, at the owner, and
 * `clear()` is the seam an owner's reset calls. The two converted sites hold
 * instance fields, exactly as their `ensureInFlight` fields did, so neither
 * one's session-state answer changes.
 *
 * Teardown of a flight that never settles is the owner's question, and neither
 * converted site answers it today: a wedged probe holds its key until the
 * process ends, exactly as its `ensureInFlight` field did on master. This
 * primitive does not make that worse and does not fix it; an owner that needs a
 * deadline wraps `fn` in one before handing it over.
 *
 * The generation hook is deliberately thin — a `() => number` the primitive
 * reads at start and again at completion. The standalone generation-guard
 * primitive is #1754's; when it lands, this stays a callback and composes with
 * it rather than absorbing it.
 */

import { spawnAbortScope } from "./spawn-abort-scope.js";

/** Options for one {@link SingleFlight} instance. */
export interface SingleFlightOptions {
	/**
	 * Read the current generation — a counter a session reset bumps.
	 *
	 * The primitive snapshots it when a flight starts. A later caller whose
	 * generation differs does NOT join that flight; it supersedes it with a
	 * fresh one. That is the whole job: after a reset, the pre-reset answer no
	 * longer applies, so serving it to a post-reset caller is the #1674 defect
	 * read from the sharing side rather than the eviction side.
	 *
	 * It deliberately does NOT also guard eviction. The identity check in
	 * `release` already covers every eviction case on its own, and a second
	 * check that no test can red is the vacuous guard this repo keeps finding.
	 * The mutation matrix in the PR body records that result.
	 *
	 * Omit it and flights live until they settle, which is right for state no
	 * session boundary invalidates.
	 */
	generation?: () => number;
	/**
	 * Coalesce requests that arrive mid-flight into at most ONE trailing rerun.
	 *
	 * Without it, a mid-flight caller shares the running promise and the work
	 * runs once — correct when the work has no input that can go stale. With it,
	 * the primitive re-invokes `fn` once after the current pass finishes, so the
	 * rerun reads a FRESH snapshot rather than the one the burst started with.
	 * An arbitrarily large burst still costs at most two passes (#1687).
	 */
	coalesceTrailing?: boolean;
}

/** A keyed at-most-one-in-flight registry. */
export interface SingleFlight<T> {
	/**
	 * Run `fn` under `key`, sharing with any flight already running for it.
	 *
	 * Every caller — the one that starts the flight and every one that joins —
	 * gets the same promise and therefore the same settled value. With
	 * `coalesceTrailing`, that promise covers the whole chain, so a joiner
	 * resolves with the result of the LAST pass, which is the pass its own
	 * request caused.
	 */
	run(key: string, fn: () => Promise<T>): Promise<T>;
	/** Is a flight currently running for `key`? Test and diagnostic use. */
	has(key: string): boolean;
	/**
	 * Does the running flight of `key` owe a trailing pass (a caller arrived
	 * mid-flight with `coalesceTrailing`)? Test and diagnostic use: a join is
	 * otherwise silent — the joining caller's own closure never runs — so this is
	 * the only way to observe one before the flight settles (#4612 r4).
	 */
	hasPendingRerun(key: string): boolean;
	/** How many flights are running. Test and diagnostic use. */
	size(): number;
	/**
	 * Forget every in-flight entry.
	 *
	 * This does not cancel anything — promises are not cancellable — it drops
	 * the primitive's claim on them. Pair it with a bumped `generation` so the
	 * flights still running cannot evict their successors when they settle.
	 */
	clear(): void;
}

/**
 * One flight's bookkeeping. `promise` is the shared handle; `generation` is the
 * snapshot taken when it started; `rerunRequested` is the coalescing bit.
 */
interface Flight<T> {
	promise: Promise<T>;
	generation: number;
	rerunRequested: boolean;
}

/**
 * Create a keyed single-flight registry.
 *
 * Sites with only one thing to dedupe pass a constant key; the map costs one
 * entry and buys the same four guards a single slot would have to re-derive.
 */
export function createSingleFlight<T>(
	options: SingleFlightOptions = {},
): SingleFlight<T> {
	const { generation: readGeneration, coalesceTrailing = false } = options;
	const flights = new Map<string, Flight<T>>();

	const currentGeneration = (): number => readGeneration?.() ?? 0;

	/**
	 * Release `key`, but ONLY if this exact flight still owns it.
	 *
	 * This is the #1674 eviction direction: a flight that settles late must not
	 * delete the entry a SUCCESSOR already installed under the same key. The
	 * successor may exist because a reset cleared the map and a new caller
	 * arrived, or because the generation moved and `run` superseded the stale
	 * flight. Identity answers both, so identity is the only check here.
	 *
	 * `runner-helpers.ts:1058` writes this as a generation check AND an identity
	 * check. The mutation matrix says the generation half of that pair kills no
	 * test: whenever it would fire, identity has already returned. The pair is
	 * harmless there and not worth churning; it is not worth copying either.
	 */
	const release = (key: string, flight: Flight<T>): void => {
		if (flights.get(key) !== flight) return;
		flights.delete(key);
	};

	const run = (key: string, fn: () => Promise<T>): Promise<T> => {
		const existing = flights.get(key);
		// Sharing requires BOTH a running flight and a matching generation. A
		// flight from an earlier generation answers a question a session reset
		// already invalidated, so this caller falls through and starts a fresh
		// one; the `flights.set` below replaces the stale entry outright, and the
		// stale flight's own `release` then finds a foreign entry and leaves it
		// alone. There is deliberately no explicit delete for the superseded
		// entry: nothing reads the map between here and that `set`, so a delete
		// would be a dead statement dressed as a guard.
		if (existing && existing.generation === currentGeneration()) {
			// A mid-flight request in the SAME generation. With coalescing it earns
			// exactly one trailing pass no matter how many such requests arrive;
			// without it, it shares the running pass. Either way it never starts a
			// second flight.
			if (coalesceTrailing) existing.rerunRequested = true;
			return existing.promise;
		}

		// The shared handle is built BEFORE `fn` runs and BEFORE the map entry is
		// published, so the entry a reentrant caller finds always carries a real
		// pending promise. The hand-rolled sites all publish the entry after
		// starting the work, which leaves a synchronous window where a reentrant
		// call starts a second flight for the same key.
		let settle!: (value: T) => void;
		let fail!: (error: unknown) => void;
		const promise = new Promise<T>((resolve, reject) => {
			settle = resolve;
			fail = reject;
		});
		const flight: Flight<T> = {
			promise,
			generation: currentGeneration(),
			rerunRequested: false,
		};

		// #5097: the flight serves every caller that joins it, so no one caller's
		// abort scope (a tool call's Esc) may cancel its spawns. An aborted
		// availability probe left the tool reported missing for the cooldown.
		const pass = (): Promise<T> => spawnAbortScope.exit(fn);
		const chain = async (): Promise<T> => {
			let result = await pass();
			// KNOWN INTERACTION, `coalesceTrailing` + `generation`: a flight that
			// gets superseded mid-pass with its rerun bit already set still runs
			// that one trailing pass, because the bit lives on the flight and no
			// caller can reach in to clear it. So a reset can cost ONE extra pass
			// of pre-reset work, whose result nothing reads — the superseded
			// promise has no callers left that a live caller depends on.
			//
			// Left as-is rather than fixed blind: no site uses both options today,
			// so any fix would be untested guesswork about which behavior a real
			// caller wants. A reset arguably SHOULD abandon the pending rerun; it
			// arguably should also let a pass that is already half-done finish.
			// The third site to turn this combination on decides, and adds the
			// test that pins whichever answer it picks.
			//
			// Only reruns requested WHILE a pass was running count. Clearing the bit
			// before each pass — never after — is what pins the coalescing to "at
			// most one trailing rerun": a request that arrives during pass 2 sets
			// the bit again and gets pass 3, which is still one trailing pass per
			// burst-that-overlaps-a-pass, not one per request.
			while (flight.rerunRequested) {
				flight.rerunRequested = false;
				result = await pass();
			}
			return result;
		};

		flights.set(key, flight);
		// Release runs on BOTH settlements — a rejected `fn` must not wedge the
		// key, which is #1690's leak. Release and settle happen in the same
		// synchronous step, so their order relative to each other is not
		// observable; what matters is that both run before any awaiting caller's
		// continuation. A rejection also abandons a pending rerun: re-running
		// work that just threw is a retry policy, and a retry policy belongs to
		// the caller that knows what the work was.
		chain().then(
			(value) => {
				release(key, flight);
				settle(value);
			},
			(error) => {
				release(key, flight);
				fail(error);
			},
		);
		return flight.promise;
	};

	return {
		run,
		has: (key) => flights.has(key),
		hasPendingRerun: (key) => flights.get(key)?.rerunRequested ?? false,
		size: () => flights.size,
		clear: () => flights.clear(),
	};
}
