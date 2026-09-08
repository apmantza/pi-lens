/**
 * Reset-interleaving explorer (#1840).
 *
 * The session-straddling class (catalog shapes 1/9 in AGENTS.md) is the
 * repo's most recurrent defect shape: an async path holds intermediate state
 * across an `await`, a `handleSessionStart` reset fires while it is
 * suspended, and the path resumes as if nothing happened — a write lands in
 * the wrong session, a budget re-arms mid-run, a latch survives past its
 * owning session. #1746 R2-F1, #1801 F1, #1785, #1805 F4, and #1807's capture
 * lifecycle are five instances of this ONE shape in one review window, and
 * every one shipped before review caught it: a reviewer picked ONE await
 * point by hand and fired the reset there. This module makes that systematic
 * — every await point, not the one a reviewer happened to guess.
 *
 * ## Mechanism: explicit yield taps, not a tick-counting scheduler
 *
 * Two mechanisms were prototyped before choosing this one.
 *
 * (a) A wrapping scheduler that counts microtask ticks and fires the reset at
 * the Nth tick, with no code changes to the path under test. This was
 * spiked against `runManagedToolRefresh` by patching `global.Promise` to
 * count `.then` continuations reached during one run. The tick count was NOT
 * stable across two runs of the identical code path with identical mocked
 * inputs: `fs/promises`, the mocked `safeSpawnAsync`, and `JSON.parse`
 * chains inside the installer each contribute their own internal
 * `.then` hops, and the count of those hops depends on V8 internals (how
 * many microtask turns a given native promise resolution takes), not on the
 * number of `await` keywords in the source. Two identical runs produced tick
 * counts that differed by 1-2 depending on unrelated GC/scheduling noise in
 * spike runs. A mechanism whose address space ("the Nth tick") is not
 * reproducible cannot honor "run once per await point" — it cannot even
 * promise the SAME point twice, let alone every point once. Rejected.
 *
 * (b) Explicit yield taps: the path under test accepts an optional `tap`
 * callback and `await`s it at each point a reset could plausibly land. This
 * needs a one-line seam in the path under test (`await tap()`), but the
 * address space is then exactly what the caller wrote — deterministic,
 * reviewable, and immune to unrelated internal `.then` hops. Chosen.
 *
 * ## Cost
 *
 * N tap points cost N+1 full executions of `run` (one baseline pass to count
 * the tap points, one per tap point to fire the reset there). `maxTapPoints`
 * (default 50) caps this — a path exposing more than that is refused rather
 * than silently spending minutes per test run; raise the cap deliberately if
 * a real path needs more.
 *
 * ## Usage
 *
 * ```ts
 * import { exploreInterleavings } from "../../support/reset-explorer.js";
 *
 * await exploreInterleavings({
 *   run: (tap) => runManagedToolRefreshForExploration(NOW, tap),
 *   reset: () => resetManagedToolRefreshSession(),
 *   invariant: ({ tapIndex, result }) => {
 *     // Runs after the baseline pass (tapIndex === null) AND after every
 *     // reset-at-tap-N pass. Throw/expect() to fail.
 *     expect(updateCalls().length).toBeLessThanOrEqual(1);
 *   },
 * });
 * ```
 *
 * The path under test owns what counts as a tap point — this module has no
 * opinion on which `await`s matter, only that whatever set the caller wired
 * up gets visited exactly once each, deterministically.
 */

/** A yield point the path under test exposes for reset injection. */
export type Tap = () => void | Promise<void>;

interface ExploreOutcome<T> {
	/** `null` for the baseline pass; the 0-based tap index for a reset pass. */
	tapIndex: number | null;
	/** The value `run` resolved to, when it didn't throw. */
	result?: T;
	/** What `run` threw, when it did. */
	error?: unknown;
}

export interface ExploreInterleavingsOptions<T> {
	/**
	 * Executes the path under test once. Must `await tap()` at every point a
	 * reset could plausibly land — the explorer visits each call to `tap`
	 * exactly once across the full exploration, in call order.
	 */
	run: (tap: Tap) => Promise<T>;
	/** Fires the reset hook under test (e.g. `resetForSession`). */
	reset: () => void;
	/**
	 * Checked after the baseline pass AND after every reset-at-tap-N pass.
	 * Throw (or use `expect()`) to fail the exploration at that point.
	 */
	invariant: (outcome: ExploreOutcome<T>) => void;
	/**
	 * Refuses to run when the path exposes more tap points than this. Each
	 * point costs one full execution of `run`; raise deliberately. Default 50.
	 */
	maxTapPoints?: number;
}

export interface ExploreResult {
	/** How many tap points the baseline pass counted. */
	tapPointCount: number;
	/** Total executions of `run`: `tapPointCount + 1`. */
	executions: number;
}

const DEFAULT_MAX_TAP_POINTS = 50;

/**
 * Run `run` once per await point it exposes via `tap`, firing `reset` at
 * that exact point each time, and checking `invariant` after every run
 * (including an untouched baseline pass). See the file header for the
 * mechanism rationale and cost model.
 */
export async function exploreInterleavings<T>(
	options: ExploreInterleavingsOptions<T>,
): Promise<ExploreResult> {
	const maxTapPoints = options.maxTapPoints ?? DEFAULT_MAX_TAP_POINTS;

	// Baseline pass: count the tap points and check the invariant with no
	// reset fired at all. This is itself one of the interleavings — "no reset
	// lands mid-run" must hold too.
	let tapPointCount = 0;
	const countingTap: Tap = () => {
		tapPointCount += 1;
	};
	const baseline = await runOnce(options.run, countingTap);
	options.invariant({ tapIndex: null, ...baseline });

	if (tapPointCount === 0) {
		// A path with zero tap points is either trivially safe or the caller
		// forgot to wire `tap` into it. Either way there is nothing further to
		// explore, and the baseline invariant already ran.
		return { tapPointCount: 0, executions: 1 };
	}

	if (tapPointCount > maxTapPoints) {
		throw new Error(
			`reset-explorer: path under test exposed ${tapPointCount} tap points, ` +
				`over the maxTapPoints cap of ${maxTapPoints}. Each point costs one ` +
				`full execution of \`run\` — raise maxTapPoints deliberately, or ` +
				`reduce how many taps the path exposes.`,
		);
	}

	let executions = 1;
	for (let target = 0; target < tapPointCount; target += 1) {
		let seen = 0;
		let fired = false;
		const targetedTap: Tap = () => {
			if (seen === target) {
				fired = true;
				options.reset();
			}
			seen += 1;
		};
		const outcome = await runOnce(options.run, targetedTap);
		executions += 1;
		if (!fired) {
			// The path's tap sequence differs between the baseline pass and this
			// pass — nondeterministic under identical inputs. The explorer's
			// address space ("the Nth tap") is only meaningful when the sequence
			// is stable; a caller hitting this needs to make the path under test
			// deterministic (mock time/IO) before this tool can help.
			throw new Error(
				`reset-explorer: internal error — tap point ${target} was never ` +
					`reached on its targeted run (the baseline pass saw ` +
					`${tapPointCount} tap points; this run saw ${seen} before ` +
					`finishing). The path under test's tap sequence must be ` +
					`deterministic across runs with identical inputs.`,
			);
		}
		options.invariant({ tapIndex: target, ...outcome });
	}

	return { tapPointCount, executions };
}

async function runOnce<T>(
	run: (tap: Tap) => Promise<T>,
	tap: Tap,
): Promise<{ result?: T; error?: unknown }> {
	try {
		const result = await run(tap);
		return { result };
	} catch (error) {
		return { error };
	}
}
