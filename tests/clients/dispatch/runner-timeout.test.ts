/**
 * Tests for per-runner timeoutMs and timer cleanup in runRunner.
 *
 * Covers:
 * - runner.timeoutMs overrides the global 30 s default
 * - a runner that finishes quickly is never cut off
 * - both outcomes (success and throw) complete without hanging
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { observeTimerRelease } from "../../support/timer-release.js";
import {
	clearCoverageNoticeState,
	clearLatencyReports,
	createDispatchContext,
	getLatencyReports,
	RunnerRegistry,
	dispatchForFile as runDispatchForFile,
} from "../../../clients/dispatch/dispatcher.js";
import { FactStore } from "../../../clients/dispatch/fact-store.js";
import type {
	RunnerGroup,
	RunnerResult,
} from "../../../clients/dispatch/types.js";
import {
	getCurrentPhase,
	getPhaseForWindow,
	type PhaseWindowAttribution,
	resetCurrentPhaseForSession,
} from "../../../clients/latency-logger.js";

describe("runRunner timeout behavior", () => {
	let registry: RunnerRegistry;

	function dispatchForFile(
		ctx: Parameters<typeof runDispatchForFile>[0],
		groups: RunnerGroup[],
	) {
		return runDispatchForFile(ctx, groups, registry);
	}

	function createMockContext(filePath: string) {
		return createDispatchContext(
			filePath,
			"/project",
			{ getFlag: () => false },
			new FactStore(),
		);
	}

	beforeEach(() => {
		registry = new RunnerRegistry();
		clearCoverageNoticeState();
	});

	it("fires at runner-level timeoutMs, not the 30 s global default", async () => {
		// runner never resolves — only the dispatcher timeout can settle this
		registry.register({
			id: "slow-tool",
			appliesTo: ["jsts"],
			priority: 10,
			timeoutMs: 30,
			async run(): Promise<RunnerResult> {
				return new Promise(() => {});
			},
		});

		const ctx = createMockContext("test.ts");
		const result = await dispatchForFile(ctx, [
			{ mode: "all", runnerIds: ["slow-tool"] },
		]);

		// timed out → no diagnostics, no blockers
		expect(result.diagnostics).toHaveLength(0);
		expect(result.hasBlockers).toBe(false);
	}, 500);

	it("does not cut off a runner that finishes before its timeoutMs", async () => {
		registry.register({
			id: "fast-tool",
			appliesTo: ["jsts"],
			priority: 10,
			timeoutMs: 5_000,
			async run(): Promise<RunnerResult> {
				return {
					status: "succeeded",
					diagnostics: [
						{
							id: "fast-warn",
							message: "warning from fast-tool",
							filePath: "test.ts",
							severity: "warning",
							semantic: "warning",
							tool: "fast-tool",
						},
					],
					semantic: "warning",
				};
			},
		});

		const ctx = createMockContext("test.ts");
		const result = await dispatchForFile(ctx, [
			{ mode: "all", runnerIds: ["fast-tool"] },
		]);

		expect(result.diagnostics).toHaveLength(1);
		expect(result.diagnostics[0].id).toBe("fast-warn");
	});

	it("returns failed/empty when the runner throws before its timeoutMs", async () => {
		registry.register({
			id: "exploding",
			appliesTo: ["jsts"],
			priority: 10,
			timeoutMs: 5_000,
			async run(): Promise<RunnerResult> {
				throw new Error("runner blew up");
			},
		});

		const ctx = createMockContext("test.ts");
		const result = await dispatchForFile(ctx, [
			{ mode: "all", runnerIds: ["exploding"] },
		]);

		expect(result.diagnostics).toHaveLength(0);
		expect(result.hasBlockers).toBe(false);
	});

	it("slow runner times out while fast runner in the same group still returns its diagnostics", async () => {
		// slow-a never resolves — times out at 30 ms
		registry.register({
			id: "slow-a",
			appliesTo: ["jsts"],
			priority: 10,
			timeoutMs: 30,
			async run(): Promise<RunnerResult> {
				return new Promise(() => {});
			},
		});

		// fast-b resolves immediately
		registry.register({
			id: "fast-b",
			appliesTo: ["jsts"],
			priority: 11,
			timeoutMs: 5_000,
			async run(): Promise<RunnerResult> {
				return {
					status: "succeeded",
					diagnostics: [
						{
							id: "b-warn",
							message: "from fast-b",
							filePath: "test.ts",
							severity: "warning",
							semantic: "warning",
							tool: "fast-b",
						},
					],
					semantic: "warning",
				};
			},
		});

		const ctx = createMockContext("test.ts");
		const result = await dispatchForFile(ctx, [
			// mode "all" runs both; slow-a times out, fast-b succeeds
			{ mode: "all", runnerIds: ["slow-a", "fast-b"] },
		]);

		expect(result.diagnostics.map((d) => d.id)).toEqual(["b-warn"]);
	}, 500);
});

// Shape 4 (an unreleased timer): the runner's budget is one `withBudget` race in
// `runRunner`. A hand-rolled copy of that race leaves its losing timer REF'd
// for the rest of the budget (#1097/#1109). The timeout arm's `failureKind` is
// read back in coverage-notice-runner-outcome.test.ts.
describe("runRunner budget timer release", () => {
	const BUDGET_MS = 7_777;
	let registry: RunnerRegistry;

	function context() {
		return createDispatchContext(
			"test.ts",
			"/project",
			{ getFlag: () => false },
			new FactStore(),
		);
	}

	beforeEach(() => {
		registry = new RunnerRegistry();
		clearCoverageNoticeState();
		clearLatencyReports();
	});
	it("releases the runner's budget timer when the runner finishes first", async () => {
		const observer = observeTimerRelease(BUDGET_MS);
		try {
			registry.register({
				id: "fast-tool",
				appliesTo: ["jsts"],
				priority: 10,
				timeoutMs: BUDGET_MS,
				async run(): Promise<RunnerResult> {
					return { status: "succeeded", diagnostics: [], semantic: "none" };
				},
			});
			await runDispatchForFile(
				context(),
				[{ mode: "all", runnerIds: ["fast-tool"] }],
				registry,
			);
			expect(observer.armed()).toHaveLength(1);
			expect(observer.unreleased()).toEqual([]);
		} finally {
			observer.restore();
		}
	});

	it("releases the budget timer when the runner throws", async () => {
		const observer = observeTimerRelease(BUDGET_MS);
		try {
			registry.register({
				id: "exploding",
				appliesTo: ["jsts"],
				priority: 10,
				timeoutMs: BUDGET_MS,
				async run(): Promise<RunnerResult> {
					throw new Error("runner blew up");
				},
			});
			await runDispatchForFile(
				context(),
				[{ mode: "all", runnerIds: ["exploding"] }],
				registry,
			);
			expect(observer.armed()).toHaveLength(1);
			expect(observer.unreleased()).toEqual([]);
			const row = getLatencyReports()[0].runners.find(
				(r) => r.runnerId === "exploding",
			);
			expect(row?.failureKind).toBe("exception");
		} finally {
			observer.restore();
		}
	});
});

// #1723: runRunner is the hot dispatch path a synchronous CPU hog (ast-grep,
// tree-sitter) blocks the loop from inside — recentPhases only ever names a
// phase that already FINISHED, so a synchronous block never gets to log its
// own completion before a loop_block sample can see it. Bracketing the runner
// call with phaseStarted/phaseFinished (clients/latency-logger.ts) fixes
// that; these tests pin the bracket's lifecycle at the dispatcher seam.
describe("runRunner in-flight phase attribution (#1723)", () => {
	let registry: RunnerRegistry;

	function dispatchForFile(
		ctx: Parameters<typeof runDispatchForFile>[0],
		groups: RunnerGroup[],
	) {
		return runDispatchForFile(ctx, groups, registry);
	}

	function createMockContext(filePath: string) {
		return createDispatchContext(
			filePath,
			"/project",
			{ getFlag: () => false },
			new FactStore(),
		);
	}

	beforeEach(() => {
		registry = new RunnerRegistry();
		clearCoverageNoticeState();
		resetCurrentPhaseForSession();
	});

	it("names the runner as the in-flight phase while its run() is still executing", async () => {
		let observedDuringRun: string | undefined;
		registry.register({
			id: "astgrep-scan",
			appliesTo: ["jsts"],
			priority: 10,
			async run(): Promise<RunnerResult> {
				// Read the slot mid-flight — this is the synthetic stand-in for a
				// loop_block sample landing while the runner is still running.
				observedDuringRun = getCurrentPhase()?.phase;
				return { status: "succeeded", diagnostics: [], semantic: "warning" };
			},
		});

		const ctx = createMockContext("test.ts");
		await dispatchForFile(ctx, [{ mode: "all", runnerIds: ["astgrep-scan"] }]);

		expect(observedDuringRun).toBe("astgrep-scan");
	});

	it("clears the slot once a successful runner returns", async () => {
		registry.register({
			id: "fast-tool",
			appliesTo: ["jsts"],
			priority: 10,
			async run(): Promise<RunnerResult> {
				return { status: "succeeded", diagnostics: [], semantic: "warning" };
			},
		});

		const ctx = createMockContext("test.ts");
		await dispatchForFile(ctx, [{ mode: "all", runnerIds: ["fast-tool"] }]);

		expect(getCurrentPhase()).toBeUndefined();
	});

	// The slot must clear on every exit path, not just the happy one — a
	// throwing or timed-out runner is exactly the shape most likely to leave a
	// stale slot if `phaseFinished` weren't in a `finally`.
	it("clears the slot when the runner throws", async () => {
		registry.register({
			id: "exploding",
			appliesTo: ["jsts"],
			priority: 10,
			timeoutMs: 5_000,
			async run(): Promise<RunnerResult> {
				throw new Error("runner blew up");
			},
		});

		const ctx = createMockContext("test.ts");
		await dispatchForFile(ctx, [{ mode: "all", runnerIds: ["exploding"] }]);

		expect(getCurrentPhase()).toBeUndefined();
	});

	it("clears the slot when the runner times out", async () => {
		registry.register({
			id: "slow-tool",
			appliesTo: ["jsts"],
			priority: 10,
			timeoutMs: 30,
			async run(): Promise<RunnerResult> {
				return new Promise(() => {});
			},
		});

		const ctx = createMockContext("test.ts");
		await dispatchForFile(ctx, [{ mode: "all", runnerIds: ["slow-tool"] }]);

		expect(getCurrentPhase()).toBeUndefined();
	}, 500);
});

// #1723 review round: the earlier single-slot design was probe-proven wrong
// against the REAL dispatcher, not just in the abstract. `dispatchForFile`
// runs its runner groups in PARALLEL (`Promise.all`, dispatcher.ts:853) — two
// runners in DIFFERENT groups genuinely overlap; two runners in the SAME
// group run sequentially (runGroup's own for-loop), so this test deliberately
// puts the hog and the idle runner in separate groups.
describe("runRunner in-flight phase attribution against real parallel groups (#1723 review F1/F2)", () => {
	let registry: RunnerRegistry;

	function dispatchForFile(
		ctx: Parameters<typeof runDispatchForFile>[0],
		groups: RunnerGroup[],
	) {
		return runDispatchForFile(ctx, groups, registry);
	}

	function createMockContext(filePath: string) {
		return createDispatchContext(
			filePath,
			"/project",
			{ getFlag: () => false },
			new FactStore(),
		);
	}

	beforeEach(() => {
		registry = new RunnerRegistry();
		clearCoverageNoticeState();
		resetCurrentPhaseForSession();
	});

	// #1723 review round 3, N1 (blocker): the reviewer flipped ONLY the
	// dispatch group order (idle-first vs. hog-first) and got "innocent-idle"
	// again — the round-2 tie-break fell back to scan/insertion order on an
	// overlap tie, which is not a real signal. This runs the SAME scenario in
	// BOTH group orders and asserts via `getPhaseForWindow` — the actual
	// production read path (`index.ts`'s `turn_end`, not the test-only
	// `getCurrentPhase` seam) — so the fix is proven at the call site
	// `turn_end` really uses.
	async function runParallelHogAndIdle(
		groupOrder: readonly ["cpu-hog", "idle"] | readonly ["idle", "cpu-hog"],
	): Promise<{
		duringHog: PhaseWindowAttribution | undefined;
		afterHog: PhaseWindowAttribution | undefined;
	}> {
		let hogResolve!: (r: RunnerResult) => void;
		const hogPromise = new Promise<RunnerResult>((resolve) => {
			hogResolve = resolve;
		});

		registry.register({
			id: "cpu-hog",
			appliesTo: ["jsts"],
			priority: 10,
			timeoutMs: 5_000,
			async run(): Promise<RunnerResult> {
				return hogPromise;
			},
		});
		registry.register({
			id: "idle",
			appliesTo: ["jsts"],
			priority: 11,
			async run(): Promise<RunnerResult> {
				return { status: "succeeded", diagnostics: [], semantic: "warning" };
			},
		});

		const ctx = createMockContext("test.ts");
		const dispatchStartMs = Date.now();
		const dispatchPromise = dispatchForFile(
			ctx,
			groupOrder.map((runnerId) => ({
				mode: "all" as const,
				runnerIds: [runnerId],
			})),
		);

		// Flush a REAL macrotask (50ms, not 0) so the idle group's whole
		// promise chain (run() → Promise.race → .finally → phaseFinished) has
		// fully settled and cpu-hog's own elapsedMs clears the N4 plausibility
		// floor, while cpu-hog's run() is still deliberately unresolved.
		await new Promise((resolve) => setTimeout(resolve, 50));
		const sampledAtMs = Date.now();
		const duringHog = getPhaseForWindow(dispatchStartMs, sampledAtMs);

		hogResolve({ status: "succeeded", diagnostics: [], semantic: "warning" });
		await dispatchPromise;
		const afterHog = getPhaseForWindow(dispatchStartMs, Date.now());

		return { duringHog, afterHog };
	}

	it("names the CPU hog via getPhaseForWindow when the hog's group is listed first", async () => {
		const { duringHog, afterHog } = await runParallelHogAndIdle([
			"cpu-hog",
			"idle",
		]);
		expect(duringHog?.phase).toBe("cpu-hog");
		expect(duringHog?.stillRunning).toBe(true);
		// Once the hog also finishes, it is still the right answer — now as
		// a CLOSED bracket rather than a live one (the closed-ring half of
		// getPhaseForWindow, not just the live-map half).
		expect(afterHog?.phase).toBe("cpu-hog");
		expect(afterHog?.stillRunning).toBe(false);
	}, 2_000);

	it("names the CPU hog via getPhaseForWindow when the IDLE runner's group is listed first (flipped order)", async () => {
		const { duringHog, afterHog } = await runParallelHogAndIdle([
			"idle",
			"cpu-hog",
		]);
		expect(duringHog?.phase).toBe("cpu-hog");
		expect(duringHog?.stillRunning).toBe(true);
		expect(afterHog?.phase).toBe("cpu-hog");
		expect(afterHog?.stillRunning).toBe(false);
	}, 2_000);

	it("getCurrentPhase (test seam) agrees with getPhaseForWindow while the hog is still live", async () => {
		let hogResolve!: (r: RunnerResult) => void;
		const hogPromise = new Promise<RunnerResult>((resolve) => {
			hogResolve = resolve;
		});
		registry.register({
			id: "cpu-hog",
			appliesTo: ["jsts"],
			priority: 10,
			timeoutMs: 5_000,
			async run(): Promise<RunnerResult> {
				return hogPromise;
			},
		});
		registry.register({
			id: "idle",
			appliesTo: ["jsts"],
			priority: 11,
			async run(): Promise<RunnerResult> {
				return { status: "succeeded", diagnostics: [], semantic: "warning" };
			},
		});

		const ctx = createMockContext("test.ts");
		const dispatchPromise = dispatchForFile(ctx, [
			{ mode: "all", runnerIds: ["cpu-hog"] },
			{ mode: "all", runnerIds: ["idle"] },
		]);
		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(getCurrentPhase()?.phase).toBe("cpu-hog");

		hogResolve({ status: "succeeded", diagnostics: [], semantic: "warning" });
		await dispatchPromise;
		expect(getCurrentPhase()).toBeUndefined();
	}, 2_000);

	// #1723 review round 4, N1 (E1-real): the LOAD-BEARING dispatcher-level
	// reproduction. Round 3's flipped-order tests above never actually
	// exercised the N1-resid failure mode — by the time either sample ran,
	// nothing else was still LIVE to compete with the (already closed) hog.
	//
	// #1723 review round 5 note, CORRECTED in round 6: an earlier version of
	// this comment called round 5's co-started construction "an artifact of
	// the test's shape, not a real gap in the fix." Round 6's review
	// disproved that: co-starting is the NORMAL production path, not an edge
	// case — `dispatchForFile` launches its runner groups via `Promise.all`,
	// and a runner's `when` precondition awaits only microtasks, so two
	// brackets opening with the identical `startedAt` millisecond string is
	// routine. The co-started shape is restored below as its OWN dedicated
	// test (`E1-real (co-started)`) rather than folded back into this one, so
	// each test's failure mode stays legible on its own. This version keeps
	// the OTHER real production shape — a long-lived innocent bracket that
	// started well before the block window opens — which is what made the
	// round-4 sampling-lag fix distinguishable in the first place: a
	// genuinely long-lived bracket has a bigger `elapsedMs` denominator,
	// which dilutes its fraction relative to a culprit whose lifetime
	// roughly IS the window. The hog runs for a real, meaningfully long
	// duration (300ms) relative to the real sampling lag that follows it
	// (~15ms) — production-realistic proportions (an 18s block sampled a few
	// ms late is a <0.1% gap).
	it("E1-real: getPhaseForWindow names the hog over a still-live innocent runner that started well before the block window", async () => {
		let innocentResolve!: (r: RunnerResult) => void;
		const innocentPromise = new Promise<RunnerResult>((resolve) => {
			innocentResolve = resolve; // deliberately NOT resolved until cleanup
		});
		registry.register({
			id: "innocent-parked-runner",
			appliesTo: ["jsts"],
			priority: 10,
			timeoutMs: 5_000,
			async run(): Promise<RunnerResult> {
				return innocentPromise;
			},
		});

		let hogResolve!: (r: RunnerResult) => void;
		const hogPromise = new Promise<RunnerResult>((resolve) => {
			hogResolve = resolve;
		});
		registry.register({
			id: "cpu-hog",
			appliesTo: ["jsts"],
			priority: 11,
			timeoutMs: 5_000,
			async run(): Promise<RunnerResult> {
				return hogPromise;
			},
		});

		const ctx = createMockContext("test.ts");

		// The innocent runner starts FIRST and stays live well before the
		// block window opens. Fire-and-forget: its own dispatch never
		// resolves during this test's assertion window.
		void dispatchForFile(ctx, [
			{ mode: "all", runnerIds: ["innocent-parked-runner"] },
		]);
		await new Promise((resolve) => setTimeout(resolve, 100));

		// The block window begins here — matching index.ts's own
		// `[now - loopMaxMs, now]`, sized to the hog's own duration.
		const windowStartMs = Date.now();
		const hogDispatchPromise = dispatchForFile(ctx, [
			{ mode: "all", runnerIds: ["cpu-hog"] },
		]);
		await new Promise((resolve) => setTimeout(resolve, 300));
		hogResolve({ status: "succeeded", diagnostics: [], semantic: "warning" });
		await hogDispatchPromise;

		// Real, unforced sampling lag after the hog's own runRunner
		// `finally` — never zero, and small relative to the hog's own
		// 300ms run.
		await new Promise((resolve) => setTimeout(resolve, 15));
		const sampledAtMs = Date.now();

		const attribution = getPhaseForWindow(windowStartMs, sampledAtMs);
		expect(attribution?.phase).toBe("cpu-hog");
		expect(attribution?.stillRunning).toBe(false);

		innocentResolve({
			status: "succeeded",
			diagnostics: [],
			semantic: "warning",
		});
	}, 3_000);

	// #1723 review round 6, R4 (process finding): round 5 REMOVED this
	// construction and called co-starting "an artifact of the test's shape"
	// — the reviewer's probes disproved that. Co-starting IS the production
	// shape: `dispatchForFile` launches its runner groups via `Promise.all`,
	// and a runner's `when` precondition awaits only microtasks, so an
	// innocent bracket and the hog opening with the identical `startedAt`
	// millisecond string is routine, not rare. Restored as its own test
	// alongside R3's epsilon-band tie-break fix — the closed-form math (see
	// `getPhaseForWindow`'s doc comment) shows the gap between a co-started
	// innocent bracket and a real culprit is order `(lag/W)^2`, which at
	// production scale (W = 18 270ms, lag = 5ms) is ~7e-8 — far below
	// `Date.now()`'s millisecond resolution, so the tie-break must treat a
	// NEAR fraction tie the same as an exact one, or this test reds again.
	// Standing lesson this round encoded: when a test reds after a fix, the
	// first hypothesis is the fix is incomplete, not the test.
	//
	// Fake timers, real dispatcher: a genuine sub-millisecond-scale near-tie
	// cannot be constructed reliably with REAL wall-clock timing at
	// test-suite speed — `Date.now()` truncates to whole milliseconds, and
	// the real async overhead of a fast test (a few real ms between steps)
	// is itself LARGER than the ~7e-8-scale gap this fix targets, so a
	// real-timer version of this test would either always pass for the wrong
	// reason (its own overhead dwarfing the genuine mathematical gap) or flake
	// under CI load. `vi.useFakeTimers()` gives exact control over
	// `phaseStarted`'s `Date.now()` calls while still exercising the REAL
	// `dispatchForFile`/`runRunner` code path — the runner promises are
	// resolved manually (no reliance on a real timer firing), so only
	// microtask resolution is needed to settle each `await`, which fake
	// timers do not block.
	it("E1-real (co-started): getPhaseForWindow names the hog over a still-live innocent runner co-started in the SAME Promise.all as the hog", async () => {
		vi.useFakeTimers();
		try {
			const t0 = new Date("2026-08-19T20:03:22.575Z").getTime();
			vi.setSystemTime(t0);

			let hogResolve!: (r: RunnerResult) => void;
			const hogPromise = new Promise<RunnerResult>((resolve) => {
				hogResolve = resolve;
			});
			let innocentResolve!: (r: RunnerResult) => void;
			const innocentPromise = new Promise<RunnerResult>((resolve) => {
				innocentResolve = resolve; // deliberately NOT resolved until cleanup
			});

			registry.register({
				id: "cpu-hog",
				appliesTo: ["jsts"],
				priority: 10,
				timeoutMs: 60_000, // generous — never meant to fire, resolved manually
				async run(): Promise<RunnerResult> {
					return hogPromise;
				},
			});
			registry.register({
				id: "innocent-co-started-runner",
				appliesTo: ["jsts"],
				priority: 11,
				timeoutMs: 60_000,
				async run(): Promise<RunnerResult> {
					return innocentPromise;
				},
			});

			const ctx = createMockContext("test.ts");
			// Both groups start HERE, in the SAME dispatchForFile call — the
			// exact production shape (dispatcher.ts:853's Promise.all). `.map()`
			// invokes each group's runGroup synchronously up to its own first
			// await, so both runners' phaseStarted calls fire within this one
			// synchronous call, before this line returns. Do NOT await this
			// promise: the innocent runner's group never resolves during the
			// assertion window, so dispatchForFile's own Promise.all would hang
			// forever.
			void dispatchForFile(ctx, [
				{ mode: "all", runnerIds: ["innocent-co-started-runner"] },
				{ mode: "all", runnerIds: ["cpu-hog"] },
			]);
			const coStartMs = t0;

			// The hog's TRUE duration is loopMaxMs (what the event-loop monitor
			// will report as the block's size) — it closes exactly loopMaxMs
			// after co-starting.
			const loopMaxMs = 18_270;
			vi.setSystemTime(coStartMs + loopMaxMs);
			hogResolve({ status: "succeeded", diagnostics: [], semantic: "warning" });
			// The hog's own `runRunner` promise chain resolves via microtasks
			// only (no real timer involved once `hogResolve` has fired) — a
			// handful of microtask turns is enough for its `finally`
			// (`phaseFinished`) to have run, without waiting on the whole
			// (still-pending, innocent-blocked) `dispatchPromise`.
			for (let i = 0; i < 10; i++) {
				await Promise.resolve();
			}

			// turn_end samples lag=5ms AFTER the hog actually closed — this is
			// what makes windowStart = now - loopMaxMs land AFTER the hog's own
			// startedAt, not exactly on it (see getPhaseForWindow's doc comment
			// for the closed form this reproduces).
			const lagMs = 5;
			const sampledAtMs = coStartMs + loopMaxMs + lagMs;
			vi.setSystemTime(sampledAtMs);

			const attribution = getPhaseForWindow(
				sampledAtMs - loopMaxMs,
				sampledAtMs,
			);
			expect(attribution?.phase).toBe("cpu-hog");
			expect(attribution?.stillRunning).toBe(false);

			innocentResolve({
				status: "succeeded",
				diagnostics: [],
				semantic: "warning",
			});
		} finally {
			vi.useRealTimers();
		}
	});
});
