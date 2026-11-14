/**
 * #2523 AC2: `bounded()` cannot be called with one bound, and firing the
 * signal settles it without waiting the deadline out.
 *
 * The compile-time half is the load-bearing one. Every earlier attempt at
 * this discipline was a convention — "remember to pass the signal too" — and
 * conventions are what #2523's sweep found 187 exceptions to. A missing bound
 * has to be a type error, so the `@ts-expect-error` cases below are assertions
 * about the TYPE, checked by the repo's lint/typecheck gate: if `bounded`
 * ever accepts one bound, `@ts-expect-error` becomes an UNUSED suppression
 * and `tsc` fails on it. That is the direction that matters — the test cannot
 * silently stop guarding.
 */

import { getEventListeners } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bounded } from "../../clients/deadline-utils.js";
import { spawnAbortScope } from "../../clients/spawn-abort-scope.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";

/** A promise that never settles: the wedged dependency #2523 measured. */
function wedged<T>(): Promise<T> {
	return new Promise<T>(() => {});
}

function summaryFor(kind: string) {
	return getDegradationSummary().find((group) => group.kind === kind);
}

/**
 * How many COMPOSITE signals `signal` is keeping alive, or `undefined` when
 * none has ever been registered on it.
 *
 * `AbortSignal.any([source, ...])` does NOT add an `abort` listener to
 * `source` — it appends the composite to an internal dependant list on it, so
 * `getEventListeners(source, "abort")` stays 0 forever and a
 * `removeEventListener` on the COMPOSITE (which is what the round-1
 * implementation's `finally` did) removes nothing from the source. The list is
 * reachable only through the internal symbol, so {@link dependantCount} reads
 * it by description — and every test that uses it arms a POSITIVE CONTROL
 * first, so a Node release that renames the symbol makes the probe fail loudly
 * instead of passing blind (#1755 F4's "a scan that finds nothing is dead, not
 * clean").
 */
function dependantCount(signal: AbortSignal): number | undefined {
	const symbol = Object.getOwnPropertySymbols(signal).find((s) =>
		String(s).includes("kDependantSignals"),
	);
	if (!symbol) return undefined;
	const list = (signal as unknown as Record<symbol, unknown>)[symbol];
	// Duck-typed on `size`, NOT `instanceof Set`: Node stores this in a
	// `SafeSet` from its primordials, whose prototype chain is deliberately
	// detached from the global `Set`, so `instanceof` is false and an
	// `instanceof` probe reports "no list" on a list that is really there.
	const size = (list as { size?: unknown } | undefined)?.size;
	if (typeof size === "number") return size;
	return Array.isArray(list) ? list.length : undefined;
}

/**
 * Never CALLED — only type-checked. `@ts-expect-error` is a compile-time
 * assertion, and executing a one-bound call would run code the type forbids
 * (a `ms: undefined` reaches `AbortSignal.timeout(NaN)`), which is a property
 * of its own and is asserted separately below.
 */
async function _oneBoundCallsDoNotTypeCheck(
	signal: AbortSignal,
): Promise<void> {
	// @ts-expect-error #2523 AC2: `signal` is required — a deadline alone
	// leaves Escape unable to release the hook (measured: still blocked
	// 30011ms after the abort fired).
	await bounded(Promise.resolve(1), {
		ms: 5,
		hook: "turn_end",
		label: "deadline-only",
	});
	// @ts-expect-error #2523 AC2: `ms` is required — a signal alone leaves a
	// dependency that wedges with nobody pressing Escape running forever
	// (measured: 400000ms, the harness ceiling).
	await bounded(Promise.resolve(1), {
		signal,
		hook: "turn_end",
		label: "signal-only",
	});
}

describe("#2523 AC2 bounded() requires BOTH bounds", () => {
	beforeEach(() => {
		resetDegradationLedger();
	});
	afterEach(() => {
		resetDegradationLedger();
	});

	it("accepts the both-bounds call, and only that one", () => {
		// The compile-time half of this assertion lives in
		// `_oneBoundCallsDoNotTypeCheck` above: if `bounded` ever accepts one
		// bound, its `@ts-expect-error` comments become unused suppressions and
		// the typecheck gate fails. This case pins the positive direction.
		const controller = new AbortController();
		expect(typeof _oneBoundCallsDoNotTypeCheck).toBe("function");
		expect(
			bounded(Promise.resolve(1), {
				ms: 5,
				signal: controller.signal,
				hook: "turn_end",
				label: "both",
			}),
		).toBeInstanceOf(Promise);
	});

	it("settles immediately on a non-finite budget instead of throwing", async () => {
		// The runtime companion to the type assertion: a JS caller can still
		// hand over `undefined`, and `AbortSignal.timeout(NaN)` throws
		// ERR_OUT_OF_RANGE. A helper whose job is keeping a hook from blowing up
		// must not blow up inside one.
		const controller = new AbortController();
		await expect(
			bounded(Promise.resolve("never seen"), {
				ms: undefined as unknown as number,
				signal: controller.signal,
				hook: "turn_end",
				label: "non-finite-budget",
			}),
		).resolves.toBeUndefined();
		expect(summaryFor("hook-await-exceeded")?.count).toBe(1);
	});

	it("treats a missing `signal` as never-aborting instead of throwing", async () => {
		// #2530 round 3 F5. `ms` is guarded with `Number.isFinite` before use
		// (the case above), but `signal.aborted` is read unguarded a few lines
		// later. The type marks `signal` required, same as `ms`, but a JS caller
		// — or a caller that only checked the compiler on `ms` — can still hand
		// over `undefined`, and `bounded(p, { ms, hook, label })` throws
		// `Cannot read properties of undefined (reading 'aborted')` before the
		// budget or the work ever gets a chance to settle it.
		await expect(
			bounded(Promise.resolve("answer"), {
				ms: 1000,
				signal: undefined as unknown as AbortSignal,
				hook: "turn_end",
				label: "no-signal",
			}),
		).resolves.toBe("answer");
		// And the deadline half of the same call still works with no signal.
		await expect(
			bounded(wedged<string>(), {
				ms: 20,
				signal: undefined as unknown as AbortSignal,
				hook: "turn_end",
				label: "no-signal-deadline",
			}),
		).resolves.toBeUndefined();
	});

	it("returns the value when the work settles inside both bounds", async () => {
		const controller = new AbortController();
		await expect(
			bounded(Promise.resolve("answer"), {
				ms: 1000,
				signal: controller.signal,
				hook: "turn_end",
				label: "fast",
			}),
		).resolves.toBe("answer");
		expect(summaryFor("hook-await-exceeded")).toBeUndefined();
	});

	it("settles on the SIGNAL without waiting the deadline out", async () => {
		const controller = new AbortController();
		const startedAt = Date.now();
		const pending = bounded(wedged<string>(), {
			// A deadline far beyond any plausible test runtime: if the abort leg
			// were missing, this test would time out rather than pass late, so a
			// regression cannot hide behind a generous assertion.
			ms: 60_000,
			signal: controller.signal,
			hook: "turn_end",
			label: "escape",
		});
		controller.abort();
		await expect(pending).resolves.toBeUndefined();
		expect(Date.now() - startedAt).toBeLessThan(5_000);
	});

	it("records NOTHING when the caller's own signal aborts", async () => {
		// Review round 2 (F1). The caller's signal IS Escape / turn cancel — a
		// deliberate user action, not a degraded environment. Round 1 recorded
		// `hook-await-exceeded` (warning tier, a `⚠` line in `pilens_health`)
		// on BOTH causes, which is the exact inversion clients/bootstrap.ts
		// already documents as fixed: `if (unavailableReason !== "aborted")`
		// exists because writing a deliberate cancel to the ledger made it
		// indistinguishable from an unhealthy analyzer graph. `bounded()` is
		// meant to become THE bound primitive at 187 sites, so shipping the
		// inversion here would ship it everywhere.
		const controller = new AbortController();
		const pending = bounded(wedged<string>(), {
			ms: 60_000,
			signal: controller.signal,
			hook: "turn_end",
			label: "escape",
		});
		controller.abort();
		await expect(pending).resolves.toBeUndefined();
		expect(summaryFor("hook-await-exceeded")).toBeUndefined();
		expect(summaryFor("hook-await-abandoned")).toBeUndefined();
		expect(getDegradationSummary()).toEqual([]);
	});

	it("records an INFORMATIONAL row when the shutdown signal fires", async () => {
		// The third cause, modelled on `abandonedError`
		// (clients/bootstrap.ts): teardown is neither a budget blow-out nor a
		// user cancel. It is a tally — the same reasoning that put
		// `log-sink-rotated` in `INFORMATIONAL_DEGRADATION_KINDS` rather than
		// giving a designed-for event the marker a real degradation gets.
		const caller = new AbortController();
		const shutdown = new AbortController();
		const startedAt = Date.now();
		const pending = bounded(wedged<string>(), {
			// Small enough that the PRE-FIX implementation (which ignores
			// `shutdownSignal` entirely) reds on the assertion after ~1s rather
			// than hanging the suite out to the vitest ceiling.
			ms: 1_000,
			signal: caller.signal,
			shutdownSignal: shutdown.signal,
			hook: "session_shutdown",
			label: "drainPendingWrites",
		});
		shutdown.abort();
		await expect(pending).resolves.toBeUndefined();
		// Settles on the shutdown signal, it does not wait the budget out.
		expect(Date.now() - startedAt).toBeLessThan(500);
		expect(summaryFor("hook-await-exceeded")).toBeUndefined();
		const group = summaryFor("hook-await-abandoned");
		expect(group?.count).toBe(1);
		expect(group?.latestReasons.at(-1)?.subject).toBe(
			"session_shutdown:drainPendingWrites",
		);
	});

	it("names the CALLER's abort ahead of both other causes", async () => {
		// `abandonedError`'s precedence, kept exactly so `bounded()` is a true
		// superset of `awaitWithinBounds`: caller, then shutdown, then the
		// deadline. A turn cancelled while the session also happens to be
		// tearing down is still a cancel, and still records nothing.
		const caller = new AbortController();
		const shutdown = new AbortController();
		caller.abort();
		shutdown.abort();
		await expect(
			bounded(wedged<void>(), {
				ms: 0,
				signal: caller.signal,
				shutdownSignal: shutdown.signal,
				hook: "turn_end",
				label: "precedence",
			}),
		).resolves.toBeUndefined();
		expect(getDegradationSummary()).toEqual([]);
	});

	it("names the CALLER's abort ahead of shutdown when both fire AFTER the call, in the same tick", async () => {
		// #2530 round 3 F4. The case above pre-aborts BOTH signals before
		// `bounded()` is even called, which only exercises the two
		// `if (...aborted)` PRE-checks at the top of the abandon race — never
		// the listener path below them, and never the `cause ??= reason`
		// first-fire-wins guard that path depends on (with only one signal
		// ever pre-aborted, `fire()` is never called twice, so first-wins vs
		// last-wins cannot be told apart). Here both signals are still LIVE
		// when `bounded()` starts, and both fire after it, in the same tick —
		// caller first, then shutdown — so the caller's abort must still win
		// and nothing must reach the ledger.
		const caller = new AbortController();
		const shutdown = new AbortController();
		const pending = bounded(wedged<void>(), {
			ms: 60_000,
			signal: caller.signal,
			shutdownSignal: shutdown.signal,
			hook: "turn_end",
			label: "post-call-precedence",
		});
		caller.abort();
		shutdown.abort();
		await expect(pending).resolves.toBeUndefined();
		expect(getDegradationSummary()).toEqual([]);
	});

	it("settles on the DEADLINE when nothing aborts, naming the budget", async () => {
		const controller = new AbortController();
		await expect(
			bounded(wedged<string>(), {
				ms: 20,
				signal: controller.signal,
				hook: "session_start",
				label: "dropStaleFiles",
			}),
		).resolves.toBeUndefined();
		const group = summaryFor("hook-await-exceeded");
		expect(group?.latestReasons.at(-1)?.subject).toBe(
			"session_start:dropStaleFiles",
		);
		expect(group?.latestReasons.at(-1)?.reason).toContain("20ms budget");
	});

	it("records ONE rising-edge row per (hook, label), not one per exceedance", async () => {
		// AC7: exceedance must be visible without flooding. A hook that blows
		// its budget on every turn of a long session writes one row.
		const controller = new AbortController();
		for (let i = 0; i < 5; i++) {
			await bounded(wedged<void>(), {
				ms: 5,
				signal: controller.signal,
				hook: "turn_end",
				label: "sweepInlineBlockerFreshness",
			});
		}
		expect(summaryFor("hook-await-exceeded")?.count).toBe(1);
		// A DIFFERENT await under the same hook is its own subject, so the
		// ledger still answers which await is slow, not merely that one is.
		await bounded(wedged<void>(), {
			ms: 5,
			signal: controller.signal,
			hook: "turn_end",
			label: "readCachedDiagnosticsForServers",
		});
		expect(summaryFor("hook-await-exceeded")?.count).toBe(2);
	});

	it("distinguishes `no answer inside the bound` from a value of undefined", async () => {
		// Defect shape 10: a bound that fired must not read like a clean answer.
		// `undefined` is the return either way — the LEDGER is what separates
		// them, which is why the exceeded path records and the resolved path
		// does not.
		const controller = new AbortController();
		await expect(
			bounded(Promise.resolve(undefined), {
				ms: 1000,
				signal: controller.signal,
				hook: "turn_end",
				label: "legitimately-undefined",
			}),
		).resolves.toBeUndefined();
		expect(summaryFor("hook-await-exceeded")).toBeUndefined();
	});

	it("propagates the work's own rejection instead of swallowing it", async () => {
		const controller = new AbortController();
		await expect(
			bounded(Promise.reject(new Error("runner blew up")), {
				ms: 1000,
				signal: controller.signal,
				hook: "agent_end",
				label: "runAutofix",
			}),
		).rejects.toThrow("runner blew up");
		expect(summaryFor("hook-await-exceeded")).toBeUndefined();
	});

	it("suppresses a LATE rejection from work the bound already abandoned", async () => {
		// Without this, every timed-out hook await would surface as an
		// unhandled rejection a few hundred ms after the hook returned — a
		// process-level crash risk introduced by the very helper meant to make
		// hooks safe.
		const controller = new AbortController();
		let rejectLate: ((error: Error) => void) | undefined;
		const late = new Promise<void>((_resolve, reject) => {
			rejectLate = reject;
		});
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			await expect(
				bounded(late, {
					ms: 10,
					signal: controller.signal,
					hook: "turn_end",
					label: "late-rejector",
				}),
			).resolves.toBeUndefined();
			rejectLate?.(new Error("too late"));
			// Two macrotask turns: `unhandledRejection` fires at the end of a
			// microtask checkpoint, so one turn is enough, and the second is
			// slack against a slow CI host.
			await new Promise((resolve) => setTimeout(resolve, 0));
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	it("leaves neither a listener nor a composite behind on the hook signal", async () => {
		// Review round 2 (F2). The hook's signal outlives one await by a whole
		// turn, so a handler that awaits N times must leave NOTHING behind on
		// it. Round 1's version of this test asserted on
		// `signal.listenerCount`, which does not exist on Node 24 (`typeof` is
		// `"undefined"`), so its one assertion sat inside an `if` that never
		// ran and deleting the cleanup left it 12/12 green — while the real
		// leak grew unobserved: `AbortSignal.any` appends its composite to the
		// SOURCE signal's dependant list, and the `finally` removed a listener
		// from the throwaway composite instead.
		const controller = new AbortController();
		const signal = controller.signal;

		// POSITIVE CONTROL, first: this probe must be able to SEE the mechanism
		// it goes on to assert the absence of. If a Node release renames the
		// internal list, these two lines red rather than letting the assertions
		// below pass vacuously — the failure mode that made round 1's test
		// worthless.
		expect(dependantCount(signal)).toBeUndefined();
		// Node 24 adds a composite to its sources' list only once the composite
		// has an abort listener; Node 22 adds it on creation.
		AbortSignal.any([signal, new AbortController().signal]).addEventListener(
			"abort",
			() => {},
		);
		expect(dependantCount(signal)).toBe(1);

		const listenersBefore = getEventListeners(signal, "abort").length;
		const dependantsBefore = dependantCount(signal);

		const calls = 200;
		for (let i = 0; i < calls; i++) {
			await bounded(Promise.resolve(i), {
				ms: 1000,
				signal,
				hook: "session_start",
				label: "loop",
			});
		}

		// Measured on the round-1 implementation: 200 calls took the dependant
		// list from 1 to 201, one permanent entry per call, and 20 000 calls on
		// one hook signal took it to 20 000.
		expect(dependantCount(signal)).toBe(dependantsBefore);
		expect(getEventListeners(signal, "abort").length).toBe(listenersBefore);
	});

	it("arms exactly ONE setTimeout per call, through the real global timer", async () => {
		// #2530 round 3 F1. `tests/config/hook-await-bounds.test.ts` used to pin
		// "one timer" with a SOURCE-SHAPE assertion — counting `setTimeout(`
		// occurrences in the text of `bounded()`'s own body, sliced from its
		// `export async function bounded<T>(` marker to end-of-file. That slice
		// is blind to a helper hoisted ABOVE the marker: a second timer armed by
		// a function `bounded()` calls, defined earlier in the same file, never
		// appears in the counted text at all — measured, that mutation left the
		// structural assertion at 24/24 green. `clients/deadline-utils.js` calls
		// the bare global `setTimeout` (not a wrapped one), so a real runtime
		// probe exists after all: `vi.spyOn(globalThis, "setTimeout")` sees
		// every timer `bounded()` actually arms, regardless of which function in
		// the file armed it. The structural case is deleted; this replaces it.
		const spy = vi.spyOn(globalThis, "setTimeout");
		try {
			const controller = new AbortController();
			await bounded(Promise.resolve("value"), {
				ms: 1000,
				signal: controller.signal,
				hook: "turn_end",
				label: "single-timer",
			});
			expect(spy).toHaveBeenCalledTimes(1);
		} finally {
			spy.mockRestore();
		}
	});

	it("removes its abort listener when the WORK wins the race", async () => {
		// The mutation target for the `finally`: with the listener now
		// registered on the SOURCE signal, dropping the cleanup makes the
		// count grow with the loop instead of returning to baseline. Kept
		// separate from the composite assertion above so the two failure modes
		// do not share a message.
		const controller = new AbortController();
		const signal = controller.signal;
		const before = getEventListeners(signal, "abort").length;
		for (let i = 0; i < 50; i++) {
			await bounded(Promise.resolve(i), {
				ms: 60_000,
				signal,
				shutdownSignal: new AbortController().signal,
				hook: "turn_end",
				label: "cleanup",
			});
		}
		expect(getEventListeners(signal, "abort").length).toBe(before);
	});

	it("settles immediately, and records, when the budget is zero", async () => {
		// `turn_start`, `context`, `session_shutdown` and `session_before_fork`
		// carry a 0ms budget in clients/hook-budgets.ts: "may not await at
		// all". A zero budget must therefore settle without waiting, and must
		// still be visible rather than silently returning nothing.
		const controller = new AbortController();
		await expect(
			bounded(Promise.resolve("never seen"), {
				ms: 0,
				signal: controller.signal,
				hook: "turn_start",
				label: "anything",
			}),
		).resolves.toBeUndefined();
		expect(summaryFor("hook-await-exceeded")?.count).toBe(1);
	});

	it("settles immediately when the signal is ALREADY aborted", async () => {
		// A hook entered after Escape was pressed must not spend its budget
		// discovering that.
		const controller = new AbortController();
		controller.abort();
		const startedAt = Date.now();
		await expect(
			bounded(wedged<void>(), {
				ms: 60_000,
				signal: controller.signal,
				hook: "agent_settled",
				label: "already-aborted",
			}),
		).resolves.toBeUndefined();
		expect(Date.now() - startedAt).toBeLessThan(5_000);
		// Entering a hook after Escape was pressed is still the caller
		// cancelling, so it is still not a degradation (F1).
		expect(getDegradationSummary()).toEqual([]);
	});
});

/**
 * #5550: the thunk form. `bounded((signal) => work, opts)` runs the work
 * itself, inside `spawnAbortScope`, and a bound that fires aborts it. The rows
 * are the state table's (STATE_TABLE.md in the PR): each case names the row it
 * pins and the recurrence it prevents. Every spawn and LSP request reads the
 * scope through `getAmbientAbortSignal()` / `safeSpawnAsync`, so the fakes here
 * read the same seam instead of faking a child.
 */
describe("#5550 bounded() thunk form cancels the work it abandons", () => {
	beforeEach(() => {
		resetDegradationLedger();
	});
	afterEach(() => {
		resetDegradationLedger();
	});

	/** A thunk that records what it was handed and the scope's signal, then wedges. */
	function wedgedThunk() {
		const seen: { arg?: AbortSignal; scope?: AbortSignal } = {};
		const thunk = (signal: AbortSignal) => {
			seen.arg = signal;
			seen.scope = spawnAbortScope.getStore();
			return wedged<string>();
		};
		return { seen, thunk };
	}

	// Row 2a. Recurrence: the deadline audit's 8 sites started work, the bound
	// gave up, and nothing told the work (pre-fix: a function passed here is
	// not even a promise, so the whole form is red).
	it("aborts the work's signal when the DEADLINE fires, and records it once", async () => {
		const { seen, thunk } = wedgedThunk();
		await expect(
			bounded(thunk, {
				ms: 20,
				signal: new AbortController().signal,
				hook: "turn_end",
				label: "thunk-deadline",
			}),
		).resolves.toBeUndefined();
		expect(seen.arg?.aborted).toBe(true);
		// The scope carries the same signal, which is how an un-threaded spawn
		// or LSP request under the thunk finds it.
		expect(seen.scope).toBe(seen.arg);
		expect(summaryFor("hook-await-exceeded")?.count).toBe(1);
	});

	// Row 3. The caller's abort is Esc: the work stops, the ledger stays empty.
	it("aborts the work's signal when the CALLER aborts, and records nothing", async () => {
		const { seen, thunk } = wedgedThunk();
		const controller = new AbortController();
		const pending = bounded(thunk, {
			ms: 60_000,
			signal: controller.signal,
			hook: "turn_end",
			label: "thunk-escape",
		});
		expect(seen.arg?.aborted).toBe(false);
		controller.abort();
		await expect(pending).resolves.toBeUndefined();
		expect(seen.arg?.aborted).toBe(true);
		expect(getDegradationSummary()).toEqual([]);
	});

	// Row 2b.
	it("aborts the work's signal when SHUTDOWN fires, recording the informational row", async () => {
		const { seen, thunk } = wedgedThunk();
		const shutdown = new AbortController();
		const pending = bounded(thunk, {
			ms: 60_000,
			signal: new AbortController().signal,
			shutdownSignal: shutdown.signal,
			hook: "session_shutdown",
			label: "thunk-shutdown",
		});
		shutdown.abort();
		await expect(pending).resolves.toBeUndefined();
		expect(seen.arg?.aborted).toBe(true);
		expect(summaryFor("hook-await-abandoned")?.count).toBe(1);
	});

	// Row 1. Recurrence a naive fold would ship: aborting in `finally` kills
	// background work a thunk detached on purpose, and reports a clean success
	// as a cancel.
	it("leaves the signal UNABORTED when the work settles inside the bounds", async () => {
		const controller = new AbortController();
		let given: AbortSignal | undefined;
		await expect(
			bounded(
				async (signal) => {
					given = signal;
					return "answer";
				},
				{
					ms: 60_000,
					signal: controller.signal,
					hook: "turn_end",
					label: "thunk-fast",
				},
			),
		).resolves.toBe("answer");
		// A later abort of the hook's signal must not reach finished work either.
		controller.abort();
		expect(given?.aborted).toBe(false);
		expect(getDegradationSummary()).toEqual([]);
	});

	// Row 3b. A bound that has already elapsed still runs the thunk, with a
	// signal that is aborted from its first line, so a spawn under it never
	// forks a child.
	it("hands an ALREADY-aborted signal to the thunk when the bound has elapsed at entry", async () => {
		const controller = new AbortController();
		controller.abort();
		const startedWith: boolean[] = [];
		await expect(
			bounded(
				(signal) => {
					startedWith.push(signal.aborted);
					return wedged<void>();
				},
				{
					ms: 60_000,
					signal: controller.signal,
					hook: "turn_end",
					label: "thunk-pre-aborted",
				},
			),
		).resolves.toBeUndefined();
		expect(startedWith).toEqual([true]);
		await expect(
			bounded(
				(signal) => {
					startedWith.push(signal.aborted);
					return wedged<void>();
				},
				{
					ms: 0,
					signal: undefined,
					hook: "turn_end",
					label: "thunk-zero-budget",
				},
			),
		).resolves.toBeUndefined();
		expect(startedWith).toEqual([true, true]);
	});

	// Row 4. A throw before the first await is a rejection at the await, where
	// the promise form's caller-side throw surfaced too, never an escape.
	it("turns a synchronous throw from the thunk into a rejection, and propagates a rejection inside the bounds", async () => {
		await expect(
			bounded(
				() => {
					throw new Error("thunk threw");
				},
				{
					ms: 60_000,
					signal: undefined,
					hook: "turn_end",
					label: "thunk-throws",
				},
			),
		).rejects.toThrow("thunk threw");
		await expect(
			bounded(async () => Promise.reject(new Error("work rejected")), {
				ms: 60_000,
				signal: undefined,
				hook: "turn_end",
				label: "thunk-rejects",
			}),
		).rejects.toThrow("work rejected");
	});

	// Row 4b + invariant I1: cancelling makes the work reject (an abort error),
	// and that rejection must neither replace the bound's `undefined` nor
	// surface as unhandled. Recurrence prevented: aborting BEFORE the race is
	// decided lets the abort rejection win and the caller sees a throw for a
	// timeout.
	it("returns undefined, not the abort rejection the cancel causes", async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			await expect(
				bounded(
					(signal) =>
						new Promise<string>((_resolve, reject) => {
							signal.addEventListener(
								"abort",
								() => reject(new Error("aborted")),
								{
									once: true,
								},
							);
						}),
					{
						ms: 20,
						signal: undefined,
						hook: "turn_end",
						label: "thunk-abort-rejects",
					},
				),
			).resolves.toBeUndefined();
			await new Promise((resolve) => setTimeout(resolve, 0));
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	// Invariants I2/I3 for the thunk form: the hook's signal outlives the call
	// by a turn, so every settle path releases its listener and the thunk's own
	// signal is never composed onto it (#2530's dependant-list leak).
	it("leaves no listener and no composite on the hook signal, on every settle path", async () => {
		const hook = new AbortController();
		const before = dependantCount(hook.signal) ?? 0;
		const options = {
			ms: 60_000,
			signal: hook.signal,
			hook: "turn_end",
		} as const;
		for (let i = 0; i < 25; i += 1) {
			await bounded(async () => i, { ...options, label: "thunk-settles" });
		}
		await expect(
			bounded(
				() => {
					throw new Error("thunk threw");
				},
				{ ...options, label: "thunk-throws-sync" },
			),
		).rejects.toThrow("thunk threw");
		await bounded(() => wedged<void>(), {
			...options,
			ms: 5,
			label: "thunk-times-out",
		});
		expect(getEventListeners(hook.signal, "abort")).toHaveLength(0);
		expect(dependantCount(hook.signal) ?? 0).toBe(before);
	});
});
