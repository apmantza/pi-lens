import { beforeEach, describe, expect, it, vi } from "vitest";

const writerLog = vi.hoisted(() => vi.fn());

vi.mock("../../clients/env-utils.js", () => ({ isTestMode: () => false }));
vi.mock("../../clients/ndjson-logger.js", () => ({
	createNdjsonLogger: () => ({
		log: writerLog,
		append: vi.fn(),
		truncate: vi.fn(),
		flush: vi.fn().mockResolvedValue(undefined),
		flushSync: vi.fn(),
	}),
}));

import {
	_closedBracketsStorageLengthForTest,
	_recentPhasesStorageLengthForTest,
	_setRecentPhasesForTest,
	CLOSED_BRACKET_CAP,
	getCurrentPhase,
	getLastLoggedPhase,
	getPhaseForWindow,
	getRecentLoggedPhases,
	logLatency,
	type PhaseWindowAttribution,
	phaseFinished,
	phaseStarted,
	RECENT_PHASE_CAP,
	resetCurrentPhaseForSession,
} from "../../clients/latency-logger.js";
import { normalizeFilePath } from "../../clients/path-utils.js";

describe("latency-logger", () => {
	beforeEach(() => {
		writerLog.mockClear();
	});

	// #2219 (the #2141 class): module-report.ts feeds `logLatency` a raw
	// `path.resolve()` result while dispatcher.ts-derived call sites already
	// pass a normalized `ctx.filePath`.
	it("normalizes a backslash-supplied absolute filePath to the canonical slash form (#2141 class)", () => {
		logLatency({
			type: "phase",
			phase: "test",
			filePath: "C:\\Users\\dev\\pi-free\\src\\a.ts",
			durationMs: 5,
		});

		expect(writerLog.mock.calls[0][0].filePath).toBe(
			normalizeFilePath("C:\\Users\\dev\\pi-free\\src\\a.ts"),
		);
	});

	// Several call sites deliberately use `filePath` for a non-path label
	// (bounded-telemetry.ts's own comment on the field), a shell command
	// (spawn-timeout-cooldown.ts), or an empty placeholder
	// (safe-spawn.ts/lens-diagnostics.ts). None of these may be resolved
	// against the process cwd — only a genuine fully-qualified path is the
	// #2141 defect.
	it.each(["<pi-lens>", "", "git", "npm run build"])(
		"leaves the non-path label %j untouched",
		(label) => {
			logLatency({
				type: "phase",
				phase: "test",
				filePath: label,
				durationMs: 5,
			});
			expect(writerLog.mock.calls[0][0].filePath).toBe(label);
		},
	);

	it("owns process and timestamp attribution instead of trusting caller fields", () => {
		logLatency({
			type: "phase",
			phase: "test",
			filePath: "fixture.ts",
			durationMs: 10,
			pid: -1,
			ts: "2000-01-01T00:00:00.000Z",
		});

		expect(writerLog).toHaveBeenCalledTimes(1);
		expect(writerLog.mock.calls[0][0]).toEqual(
			expect.objectContaining({
				phase: "test",
				pid: process.pid,
				ts: expect.not.stringContaining("2000-01-01"),
			}),
		);
	});
});

describe("getLastLoggedPhase (loop_block attribution, #1122/#1123)", () => {
	it("tracks the most recent phase entry", () => {
		logLatency({
			type: "phase",
			phase: "graph_build",
			filePath: "<x>",
			durationMs: 5,
		});
		const last = getLastLoggedPhase();
		expect(last?.phase).toBe("graph_build");
		expect(last?.ts).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/));
	});

	it("does not record loop_block itself as the last phase (no self-attribution)", () => {
		logLatency({
			type: "phase",
			phase: "word_index_build",
			filePath: "<x>",
			durationMs: 5,
		});
		logLatency({
			type: "phase",
			phase: "loop_block",
			filePath: "<pi-lens>",
			durationMs: 9000,
		});
		expect(getLastLoggedPhase()?.phase).toBe("word_index_build");
	});

	it("does not let an availability decision win block attribution (#1467)", () => {
		logLatency({
			type: "phase",
			phase: "knip",
			filePath: "<x>",
			durationMs: 5,
		});
		logLatency({
			type: "phase",
			phase: "availability_decision",
			filePath: "<pi-lens>",
			durationMs: 5528,
			metadata: { tool: "knip", cause: "host-stall" },
		});
		expect(getLastLoggedPhase()?.phase).toBe("knip");
	});

	it("ignores non-phase entries", () => {
		logLatency({
			type: "phase",
			phase: "cascade",
			filePath: "<x>",
			durationMs: 1,
		});
		logLatency({
			type: "runner",
			filePath: "a.ts",
			durationMs: 1,
			runnerId: "biome",
		});
		expect(getLastLoggedPhase()?.phase).toBe("cascade");
	});

	// #1412 L3: the classic-TS first-open project-identity probe is a detached,
	// best-effort telemetry sample, not genuine work — it must not win
	// lastPhase and overwrite the real stall attribution for a loop_block that
	// happens to land right after a first open.
	it("does not record lsp_typescript_project_identity as the last phase (no probe self-attribution)", () => {
		logLatency({
			type: "phase",
			phase: "word_index_build",
			filePath: "<x>",
			durationMs: 5,
		});
		logLatency({
			type: "phase",
			phase: "lsp_typescript_project_identity",
			filePath: "/repo/src/app.ts",
			durationMs: 12,
		});
		expect(getLastLoggedPhase()?.phase).toBe("word_index_build");
	});

	// #1458 S5: lsp_aux_wait_outcome carries a REAL wait duration (unlike its
	// zero-duration LAST_PHASE_EXCLUDED siblings above) but is still a wait-
	// OUTCOME record, not the stall itself — pin its exclusion so a future edit
	// can't drop the entry and silently start misattributing loop_block stalls
	// to this summary row.
	it("does not record lsp_aux_wait_outcome as the last phase despite its real duration", () => {
		logLatency({
			type: "phase",
			phase: "word_index_build",
			filePath: "<x>",
			durationMs: 5,
		});
		logLatency({
			type: "phase",
			phase: "lsp_aux_wait_outcome",
			filePath: "/repo/src/app.ts",
			durationMs: 1800,
		});
		expect(getLastLoggedPhase()?.phase).toBe("word_index_build");
	});

	it("does not let the cache usage session summary own stall attribution (#1996)", () => {
		logLatency({
			type: "phase",
			phase: "provider_request",
			filePath: "<pi-lens>",
			durationMs: 5,
		});
		logLatency({
			type: "phase",
			phase: "cache_usage_summary",
			filePath: "<pi-lens>",
			durationMs: 0,
		});
		expect(getLastLoggedPhase()?.phase).toBe("provider_request");
	});

	it("does not let failed-target decision telemetry own stall attribution (#2044)", () => {
		logLatency({
			type: "phase",
			phase: "turn_end_tests",
			filePath: "<pi-lens>",
			durationMs: 5,
		});
		logLatency({
			type: "phase",
			phase: "test_runner_failed_target_state",
			filePath: "/repo/stale.test.ts",
			durationMs: 0,
		});
		expect(getLastLoggedPhase()?.phase).toBe("turn_end_tests");
	});

	// #2249/#2312 review F3: `concurrent_session_bind_rollup` is a zero-duration
	// session-end summary, the same shape as `session_end_bus_rollup` and
	// `path_attribution_verified_rollup` above — it must not win lastPhase
	// attribution for a loop_block that happens to land right after it. Pins
	// the `LAST_PHASE_EXCLUDED` entry so deleting it reds here instead of
	// surviving unnoticed.
	it("does not let the concurrent-session-bind rollup own stall attribution (#2249)", () => {
		logLatency({
			type: "phase",
			phase: "provider_request",
			filePath: "<pi-lens>",
			durationMs: 5,
		});
		logLatency({
			type: "phase",
			phase: "concurrent_session_bind_rollup",
			filePath: "<pi-lens>",
			durationMs: 0,
		});
		expect(getLastLoggedPhase()?.phase).toBe("provider_request");
	});

	it("does not let a busy notify decision own stall attribution (#2358)", () => {
		logLatency({
			type: "phase",
			phase: "provider_request",
			filePath: "<pi-lens>",
			durationMs: 5,
		});
		logLatency({
			type: "phase",
			phase: "lsp_notify_stall_cpu_busy",
			filePath: "server:root",
			durationMs: 1000,
		});
		expect(getLastLoggedPhase()?.phase).toBe("provider_request");
	});
});

describe("getRecentLoggedPhases (#1723: bounded attribution ring)", () => {
	it("returns the most recent phases newest-first", () => {
		logLatency({
			type: "phase",
			phase: "phase_a",
			filePath: "<x>",
			durationMs: 1,
		});
		logLatency({
			type: "phase",
			phase: "phase_b",
			filePath: "<x>",
			durationMs: 1,
		});
		logLatency({
			type: "phase",
			phase: "phase_c",
			filePath: "<x>",
			durationMs: 1,
		});
		const recent = getRecentLoggedPhases();
		expect(recent.map((p) => p.phase).slice(0, 3)).toEqual([
			"phase_c",
			"phase_b",
			"phase_a",
		]);
	});

	it("bounds the ring regardless of how many phases were logged (no unbounded growth)", () => {
		for (let i = 0; i < 50; i++) {
			logLatency({
				type: "phase",
				phase: `flood_${i}`,
				filePath: "<x>",
				durationMs: 1,
			});
		}
		// A caller can never pull more than the cap out, even if it asks for more —
		// this is the volume bound: a jittery session cannot inflate a single
		// loop_block record's attribution payload past a fixed size.
		expect(getRecentLoggedPhases(1000).length).toBeLessThanOrEqual(5);
		expect(getRecentLoggedPhases()[0].phase).toBe("flood_49");
	});

	it("excludes the same phases as getLastLoggedPhase (loop_block, availability_decision, ...)", () => {
		logLatency({
			type: "phase",
			phase: "real_work",
			filePath: "<x>",
			durationMs: 1,
		});
		logLatency({
			type: "phase",
			phase: "loop_block",
			filePath: "<pi-lens>",
			durationMs: 9000,
		});
		logLatency({
			type: "phase",
			phase: "availability_decision",
			filePath: "<pi-lens>",
			durationMs: 5,
		});
		const recent = getRecentLoggedPhases();
		expect(recent.map((p) => p.phase)).not.toContain("loop_block");
		expect(recent.map((p) => p.phase)).not.toContain("availability_decision");
		expect(recent[0].phase).toBe("real_work");
	});

	it("a caller can request fewer than the cap", () => {
		logLatency({ type: "phase", phase: "one", filePath: "<x>", durationMs: 1 });
		logLatency({ type: "phase", phase: "two", filePath: "<x>", durationMs: 1 });
		expect(getRecentLoggedPhases(1)).toHaveLength(1);
		expect(getRecentLoggedPhases(1)[0].phase).toBe("two");
	});

	// Follow-up from review: "bounds the ring" above only observes OUTPUT
	// length through getRecentLoggedPhases, which is a compensating pair —
	// the write-side `.slice(0, RECENT_PHASE_CAP)` in logLatency and the
	// read-side `Math.min(limit, RECENT_PHASE_CAP)` clamp in
	// getRecentLoggedPhases each independently bound that output, so deleting
	// EITHER ONE ALONE still leaves the other masking it and the existing
	// test green. These two tests isolate each guard so a mutant that removes
	// either one reds on its own, not just in combination.
	it("write-side guard: storage itself never exceeds the cap, independent of the read-side clamp (#1723 review)", () => {
		for (let i = 0; i < RECENT_PHASE_CAP + 7; i++) {
			logLatency({
				type: "phase",
				phase: `storage_flood_${i}`,
				filePath: "<x>",
				durationMs: 1,
			});
		}
		// Bypasses getRecentLoggedPhases (and so its read-side clamp) entirely —
		// if logLatency's `.slice(0, RECENT_PHASE_CAP)` were deleted, storage
		// would grow to RECENT_PHASE_CAP + 7 and this reds regardless of what
		// the read side does.
		expect(_recentPhasesStorageLengthForTest()).toBe(RECENT_PHASE_CAP);
	});

	it("read-side guard: an oversized limit is clamped even when storage already holds more than the cap (#1723 review)", () => {
		// Seed storage directly, past the cap, bypassing logLatency's write-side
		// slice entirely — a state the normal write path can never produce. This
		// isolates the read-side clamp: if Math.min(limit, RECENT_PHASE_CAP)
		// were deleted from getRecentLoggedPhases, requesting an oversized limit
		// against this over-capacity ring would return more than the cap.
		const overCapacity = Array.from(
			{ length: RECENT_PHASE_CAP + 10 },
			(_, i) => ({
				phase: `seed_${i}`,
				ts: new Date().toISOString(),
			}),
		);
		_setRecentPhasesForTest(overCapacity);
		expect(getRecentLoggedPhases(1000)).toHaveLength(RECENT_PHASE_CAP);
	});
});

describe("phaseStarted/phaseFinished/getCurrentPhase (#1723 in-flight attribution)", () => {
	beforeEach(() => {
		resetCurrentPhaseForSession();
	});

	it("names the phase as current once started", () => {
		phaseStarted("astgrep_scan");
		expect(getCurrentPhase()?.phase).toBe("astgrep_scan");
	});

	it("clears the slot once the matching finish call fires", () => {
		const token = phaseStarted("astgrep_scan");
		phaseFinished(token);
		expect(getCurrentPhase()).toBeUndefined();
	});

	// Mutation-proof for the clearing guard itself: if `phaseFinished` were a
	// no-op (a "never-cleared slot" bug), the assertion above alone wouldn't
	// distinguish it from a broken implementation that ALSO didn't set
	// anything — this pins that a phase started BEFORE the finish call is
	// gone afterward, which only holds if the clear genuinely ran.
	it("a stale (never-cleared) slot would mis-attribute a later, unrelated block", () => {
		const token = phaseStarted("full_scan_18s");
		phaseFinished(token);
		// A second, unrelated phase starts and finishes quickly.
		const secondToken = phaseStarted("word_index_build");
		phaseFinished(secondToken);
		// If the first finish had failed to clear (or had cleared the WRONG
		// slot), getCurrentPhase() here could still read "full_scan_18s" long
		// after it ended, or nothing at all despite word_index_build's own
		// finish having already run — either way the assertion below is the
		// one a stale-slot regression breaks.
		expect(getCurrentPhase()).toBeUndefined();
	});

	// Identity-token semantics: an EARLIER phase's finish (arriving after a
	// LATER phase has already started) must not clear the later phase's
	// still-live slot. Guards the exact overlap `phaseFinished`'s doc comment
	// calls out — without token comparison, a bare "clear unconditionally"
	// finish would wipe the wrong phase.
	it("an out-of-order finish for an earlier phase does not clear a later phase's slot", () => {
		const earlierToken = phaseStarted("lsp_workspace_diagnostics_touch");
		const laterToken = phaseStarted("astgrep_scan");
		// The earlier phase's async tail resolves last and calls its own finish.
		phaseFinished(earlierToken);
		expect(getCurrentPhase()?.phase).toBe("astgrep_scan");
		phaseFinished(laterToken);
		expect(getCurrentPhase()).toBeUndefined();
	});

	it("getCurrentPhase carries startedAt for elapsed-time computation", () => {
		const before = Date.now();
		phaseStarted("full_scan_18s");
		const current = getCurrentPhase();
		expect(current?.startedAt).toEqual(
			expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
		);
		expect(Date.parse(current!.startedAt)).toBeGreaterThanOrEqual(before);
	});

	// #1723 session-boundary backstop (catalog: state that must re-arm at
	// session_start cannot hide behind a process-lifetime latch). Without
	// this reset, a phase abandoned by a torn-down activation would survive
	// into the next session and keep mis-attributing every loop_block there.
	it("resetCurrentPhaseForSession clears a leaked in-flight phase", () => {
		phaseStarted("full_scan_18s"); // never finished — simulates an abandoned phase
		expect(getCurrentPhase()).toBeDefined();
		resetCurrentPhaseForSession();
		expect(getCurrentPhase()).toBeUndefined();
	});
});

// #1723 review round (redesign of the slot mechanism, probe-proven against the
// real dispatcher): a single slot broke two ways once overlap is the NORMAL
// case (dispatchForFile runs runner groups in PARALLEL, dispatcher.ts:853),
// plus a third, decisive gap for the motivating synchronous case. This block
// rebuilds the reviewer's three probes as regression tests, all reproducible
// at the latency-logger unit level (a dispatcher-level version of F1/F2 lives
// in tests/clients/dispatch/runner-timeout.test.ts).
describe("getCurrentPhase/getPhaseForWindow: overlap and window attribution (#1723 review)", () => {
	beforeEach(() => {
		resetCurrentPhaseForSession();
	});

	// F1: a single slot held only the LAST starter — a cheap idle runner
	// starting after a CPU hog would win outright, naming the innocent runner
	// while the hog stayed anonymous. The Map-based live set instead surfaces
	// the OLDEST still-open bracket, which is the hog.
	it("F1: names the CPU hog, not an idle runner that started after it, while both are live", () => {
		phaseStarted("cpu-hog");
		phaseStarted("idle"); // starts AFTER the hog, while the hog is still open
		expect(getCurrentPhase()?.phase).toBe("cpu-hog");
	});

	// F2: a quick sibling that starts second but finishes FIRST used to clear
	// the single slot out from under the still-running long phase. Per-token
	// map entries mean a sibling's finish can only ever remove ITS OWN entry.
	it("F2: an idle runner finishing first does not clear the still-running long phase's bracket", () => {
		const hogToken = phaseStarted("cpu-hog");
		const idleToken = phaseStarted("idle");
		phaseFinished(idleToken); // idle finishes quickly...
		// ...but the hog is still open, and still names as current.
		expect(getCurrentPhase()?.phase).toBe("cpu-hog");
		phaseFinished(hogToken);
		expect(getCurrentPhase()).toBeUndefined();
	});

	// F3 (decisive): phaseFinished runs inside a `finally`, which resumes as a
	// MICROTASK. turn_end is scheduled as a MACROTASK. Microtasks always fully
	// drain before the next macrotask runs, so a genuinely SYNCHRONOUS phase —
	// the motivating 18s case — has ALREADY closed (and so left liveBrackets)
	// by the time anything reads it. This is the real, unmocked JS scheduling
	// order (no fake timers): the phase's own try/finally resolves entirely
	// before the setTimeout callback below ever runs.
	it("F3: a macrotask sample after a synchronous phase's microtask-scheduled finish still attributes it via window overlap", async () => {
		const blockStartMs = Date.now();
		const token = phaseStarted("full_scan_18s");
		const doSynchronousWork = async () => {
			try {
				// Real synchronous (blocking) work, kept short for test speed.
				const busyUntil = Date.now() + 30;
				while (Date.now() < busyUntil) {
					/* busy-wait, mimicking a CPU-bound scan */
				}
			} finally {
				phaseFinished(token); // exactly like runRunner's finally
			}
		};
		await doSynchronousWork();

		// By now the bracket has already closed — liveBrackets is empty. This
		// is exactly what made the old single-slot design (and getCurrentPhase
		// alone) miss the synchronous case.
		expect(getCurrentPhase()).toBeUndefined();

		// Simulate turn_end firing as a macrotask AFTER the phase's finally.
		const attribution = await new Promise<ReturnType<typeof getPhaseForWindow>>(
			(resolve) => {
				setTimeout(() => {
					const blockEndMs = Date.now();
					resolve(getPhaseForWindow(blockStartMs, blockEndMs));
				}, 0);
			},
		);

		expect(attribution?.phase).toBe("full_scan_18s");
		expect(attribution?.stillRunning).toBe(false);
		expect(attribution?.elapsedMs).toBeGreaterThanOrEqual(30);
	});

	// Deterministic companion to the real-scheduling F3 test above: fake
	// timers pin the exact overlap arithmetic, including that a live bracket
	// (still running, no closedAt yet) is attributed too, not just closed ones.
	it("F3b: getPhaseForWindow attributes a still-open bracket against an exact window (fake timers)", () => {
		vi.useFakeTimers();
		try {
			const t0 = new Date("2026-08-19T20:03:22.575Z").getTime();
			vi.setSystemTime(t0);
			phaseStarted("full_scan_18s");
			vi.setSystemTime(t0 + 18_270); // block ends exactly when the probe samples
			const attribution = getPhaseForWindow(t0, t0 + 18_270);
			expect(attribution?.phase).toBe("full_scan_18s");
			expect(attribution?.stillRunning).toBe(true);
			expect(attribution?.elapsedMs).toBe(18_270);
		} finally {
			vi.useRealTimers();
		}
	});

	// #1723 review round 3, N2: an earlier version of this test pinned a
	// dedicated `overlapMs <= 0` early-return guard that turned out to be
	// PROVABLY DEAD CODE — with `bestOverlapMs` seeded at 0 and the accept
	// condition requiring `overlapMs > bestOverlapMs` (a tie only ever refines
	// an EXISTING best), a zero-or-negative overlap can never win regardless
	// of whether that guard exists. The old test could not fail under any
	// mutation of it (catalog shape 7 — a vacuous test). The guard was
	// deleted; this test is its discriminating replacement: it pins the
	// INTRINSIC behavior (zero overlap never wins) against a genuine
	// positive-overlap INCUMBENT, so a real regression — e.g. loosening the
	// accept condition to `>=`, letting a tie silently overturn a correct
	// answer — has something to break.
	it("a bracket with exactly zero overlap against the window never overturns a genuine positive-overlap incumbent", () => {
		vi.useFakeTimers();
		try {
			const t0 = new Date("2026-08-19T20:03:22.575Z").getTime();
			vi.setSystemTime(t0);
			const incumbentToken = phaseStarted("genuine_incumbent");
			vi.setSystemTime(t0 + 5000);
			phaseFinished(incumbentToken); // elapsedMs 5000, fully inside the window below

			// Starts exactly when the window ends (zero overlap, not negative);
			// long enough on its own to clear the N4 plausibility floor, so
			// this candidate is excluded by the OVERLAP check specifically, not
			// incidentally by the floor.
			const zeroOverlapToken = phaseStarted("zero_overlap_candidate");
			vi.setSystemTime(t0 + 5000 + 6000);
			phaseFinished(zeroOverlapToken);

			const attribution = getPhaseForWindow(t0, t0 + 5000);
			expect(attribution?.phase).toBe("genuine_incumbent");
		} finally {
			vi.useRealTimers();
		}
	});

	// Mutation-proof: ring unbounded (#1723 review, mirrors the existing
	// recentPhases write-side guard test). If phaseFinished's
	// `.slice(0, CLOSED_BRACKET_CAP)` were deleted, storage would grow past
	// the cap.
	it("mutation-proof: the closed-bracket ring never exceeds CLOSED_BRACKET_CAP", () => {
		for (let i = 0; i < CLOSED_BRACKET_CAP + 7; i++) {
			const token = phaseStarted(`closed_flood_${i}`);
			phaseFinished(token);
		}
		expect(_closedBracketsStorageLengthForTest()).toBe(CLOSED_BRACKET_CAP);
	});

	// Mutation-proof: a never-deleted live entry (phaseFinished's `Map.delete`
	// silently made a no-op) would leave a phantom bracket "open" forever,
	// permanently winning getCurrentPhase's oldest-wins tie-break over every
	// later, genuinely-running phase.
	it("mutation-proof: a correctly finished phase never lingers as the oldest open bracket", () => {
		const staleToken = phaseStarted("should_have_closed");
		phaseFinished(staleToken);
		phaseStarted("genuinely_running_now");
		expect(getCurrentPhase()?.phase).toBe("genuinely_running_now");
	});
});

// #1723 review round 3: N1 (blocker), N3, N4 — three findings against the
// round-2 redesign, each proven with a controlled fake-timer scenario so the
// exact numbers are reproducible instead of racing real wall-clock ms.
describe("getPhaseForWindow tie-break and plausibility floor (#1723 review round 3)", () => {
	beforeEach(() => {
		resetCurrentPhaseForSession();
	});

	// #1723 review round 4 note: this test constructs an EXACT overlap tie,
	// which round 4 found does not occur in production — a live bracket's end
	// is always `nowMs` (the window's own end), so it always scores the
	// MAXIMUM possible raw overlap, and a closed culprit can only match that
	// by closing at the exact sample instant, which `turn_end` never does.
	// Kept anyway: it is still a genuine (if synthetic) property of
	// `getPhaseForWindow` — a real fraction tie must still fall back to
	// elapsedMs, not insertion order — and it still passes under fraction
	// ranking (fraction happens to strictly favor the hog here too, so this
	// is no longer testing the TIE branch specifically). The LOAD-BEARING
	// regression test for the actual production failure mode is
	// "N1-resid" below.
	//
	// N1 (blocker) + N3: the round-2 tie-break kept "whichever candidate was
	// found first" (live brackets scanned oldest-first, i.e. Map insertion
	// order). Two brackets can tie in overlap while genuinely differing in
	// elapsedMs (a phase whose lifetime roughly IS the window, vs. one that
	// merely CONTAINS it) — insertion order is not a real signal for which is
	// the culprit, and the reviewer demonstrated that flipping which one
	// started first (equivalently: dispatcher.ts group order) flipped the
	// named culprit for an IDENTICAL scenario. This constructs the same exact
	// tie in BOTH insertion orders (via fake-timer time travel, so the two
	// brackets' `startedAt` values are identical across both runs — only
	// which `phaseStarted` call happens first differs) and asserts
	// `getPhaseForWindow` — the production read path (index.ts's `turn_end`)
	// — names the smaller-elapsedMs bracket (the real culprit) either way.
	it("N1/N3: an exact overlap tie between two live brackets is decided by elapsedMs, never by insertion order", () => {
		const t0 = new Date("2026-08-19T20:03:22.575Z").getTime();
		const hogStartMs = t0 + 1000;
		const longLivedStartMs = t0; // started well before the window
		const windowStartMs = hogStartMs;
		const windowEndMs = hogStartMs + 18_270;
		const queryNowMs = windowEndMs + 500; // both still running past the window

		const runScenario = (
			hogInsertedFirst: boolean,
		): PhaseWindowAttribution | undefined => {
			resetCurrentPhaseForSession();
			vi.useFakeTimers();
			try {
				if (hogInsertedFirst) {
					vi.setSystemTime(hogStartMs);
					phaseStarted("cpu_hog");
					vi.setSystemTime(longLivedStartMs); // time-travel backward
					phaseStarted("innocent_long_lived");
				} else {
					vi.setSystemTime(longLivedStartMs);
					phaseStarted("innocent_long_lived");
					vi.setSystemTime(hogStartMs);
					phaseStarted("cpu_hog");
				}
				vi.setSystemTime(queryNowMs);
				return getPhaseForWindow(windowStartMs, windowEndMs);
			} finally {
				vi.useRealTimers();
			}
		};

		const hogFirst = runScenario(true);
		const longLivedFirst = runScenario(false);

		// Both scenarios describe the IDENTICAL tie (same overlap, 18 270ms,
		// for both brackets) — only insertion order differs. cpu_hog's own
		// elapsedMs (18 770ms: it started at the window edge) is smaller than
		// innocent_long_lived's (19 770ms: it started 1000ms earlier), so the
		// hog must win regardless of which order it was inserted in.
		expect(hogFirst?.phase).toBe("cpu_hog");
		expect(longLivedFirst?.phase).toBe("cpu_hog");
		expect(hogFirst?.elapsedMs).toBe(18_770);
		expect(longLivedFirst?.elapsedMs).toBe(18_770);
	});

	// #1723 review round 4, N1 — the LOAD-BEARING regression test. Raw overlap
	// is capped at the window's own length, and a LIVE bracket's end is always
	// `nowMs` — the window's own end — so a long-lived, still-running innocent
	// bracket ALWAYS scores the maximum possible raw overlap. A genuine CLOSED
	// culprit can only match that by closing at the exact sample instant,
	// which `turn_end` never does: it samples milliseconds AFTER the
	// culprit's own `finally` runs (a microtask; `turn_end` is a macrotask —
	// see the F3 note above). Under raw-overlap ranking the culprit's overlap
	// is therefore ALWAYS slightly short of the window's full length, and the
	// innocent bracket wins every time — not a tie, an outright loss, exactly
	// as the reviewer's probe demonstrated (18 270ms block sampled 5ms late:
	// innocent wins 18270 vs 18265). Containment FRACTION fixes this
	// structurally: the culprit's fraction stays close to 1.0 regardless of a
	// few milliseconds of sampling lag, while the innocent bracket's fraction
	// is diluted by its own much longer `elapsedMs` denominator.
	it("N1-resid: a culprit sampled 5ms after its own finally still beats a still-live innocent bracket that merely contains the window", () => {
		vi.useFakeTimers();
		try {
			const t0 = new Date("2026-08-19T20:03:22.575Z").getTime();
			vi.setSystemTime(t0);
			// Innocent: starts well before the block window, stays live through
			// and past it (e.g. a long-poll subprocess runner parked waiting on
			// I/O — genuinely running, genuinely innocent).
			phaseStarted("innocent_parked_runner");

			const cullStartMs = t0 + 1000;
			vi.setSystemTime(cullStartMs);
			const culpritToken = phaseStarted("full_scan_18s");
			const loopMaxMs = 18_270;
			const culpritClosedAtMs = cullStartMs + loopMaxMs;
			vi.setSystemTime(culpritClosedAtMs);
			phaseFinished(culpritToken); // the culprit's own `finally` runs HERE

			// turn_end samples 5ms LATER — never zero, since the finally is a
			// microtask and turn_end is scheduled as a macrotask.
			const sampleLagMs = 5;
			const nowMs = culpritClosedAtMs + sampleLagMs;
			vi.setSystemTime(nowMs);

			const attribution = getPhaseForWindow(nowMs - loopMaxMs, nowMs);
			expect(attribution?.phase).toBe("full_scan_18s");
			expect(attribution?.stillRunning).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	// N3: a bracket leaked by a torn-down concurrent secondary (no age/size
	// cap on `liveBrackets` itself — see `phaseFinished`'s doc comment) is old
	// by construction, so it ties in overlap with a REAL later culprit for
	// any window the leak fully contains. Confirms the N1 tie-break demotes
	// it: the real culprit's smaller elapsedMs wins even though the leaked
	// bracket has been "open" for 78 seconds.
	it("N3: a 78s leaked bracket does not beat a real, smaller-elapsedMs culprit on an overlap tie", () => {
		vi.useFakeTimers();
		try {
			const t0 = new Date("2026-08-19T20:03:22.575Z").getTime();
			vi.setSystemTime(t0);
			phaseStarted("leaked_from_torn_down_secondary"); // never finished — the leak

			const cullStartMs = t0 + 78_000;
			vi.setSystemTime(cullStartMs);
			const culpritToken = phaseStarted("full_scan_18s");
			vi.setSystemTime(cullStartMs + 18_270);
			phaseFinished(culpritToken);

			vi.setSystemTime(cullStartMs + 18_270 + 500); // sample shortly after
			const attribution = getPhaseForWindow(cullStartMs, cullStartMs + 18_270);

			expect(attribution?.phase).toBe("full_scan_18s");
			expect(attribution?.stillRunning).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	// N4: the closed-bracket ring is bounded (`CLOSED_BRACKET_CAP`) — sibling
	// churn can evict the real culprit before `turn_end` ever samples. Without
	// a plausibility floor, whatever tiny bracket is left with SOME positive
	// overlap would be reported as a confident (and wrong) answer. This
	// evicts an 18 270ms culprit with `CLOSED_BRACKET_CAP` later closes and
	// leaves a single 2ms bracket with a genuine 2ms overlap against the
	// culprit's own window — the floor must reject it, returning `undefined`
	// (absent-but-honest) rather than naming the 2ms blip.
	it("N4: sibling churn evicting the real culprit off the ring does not produce a confident wrong answer", () => {
		vi.useFakeTimers();
		try {
			const t0 = new Date("2026-08-19T20:03:22.575Z").getTime();
			vi.setSystemTime(t0);
			const culpritToken = phaseStarted("full_scan_18s");
			const culpritEndMs = t0 + 18_270;
			vi.setSystemTime(culpritEndMs);
			phaseFinished(culpritToken); // ring: [culprit]

			// CLOSED_BRACKET_CAP - 1 filler siblings, entirely AFTER the window
			// (zero/negative overlap on their own) — just occupy ring capacity.
			for (let i = 0; i < CLOSED_BRACKET_CAP - 1; i++) {
				const fillerToken = phaseStarted(`filler_${i}`);
				vi.setSystemTime(culpritEndMs + 100 + i);
				phaseFinished(fillerToken);
			}

			// The CAP-th close evicts the culprit. This one straddles the
			// window's tail by exactly 2ms — real, positive overlap, but far
			// too small to plausibly explain an 18 270ms block.
			vi.setSystemTime(culpritEndMs - 2);
			const tinyToken = phaseStarted("tiny_unrelated_blip");
			vi.setSystemTime(culpritEndMs);
			phaseFinished(tinyToken);

			expect(_closedBracketsStorageLengthForTest()).toBe(CLOSED_BRACKET_CAP);

			const attribution = getPhaseForWindow(t0, culpritEndMs);
			expect(attribution).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});

	// #1723 review round 4: explicit proof that N4's floor FILTERS candidates
	// and N1's fraction ranking only RANKS the survivors — not the other way
	// around. A 1ms bracket whose entire (tiny) lifetime sits inside the
	// window scores a PERFECT containment fraction (1.0) — strictly higher
	// than any real, partially-overlapping candidate could ever score — so if
	// fraction ranking ran before the floor, this blip would always win. It
	// must not: the floor rejects it outright before its fraction is ever
	// compared against anything.
	it("N4+N1 interaction: the plausibility floor filters candidates before fraction ranking sees them", () => {
		vi.useFakeTimers();
		try {
			const t0 = new Date("2026-08-19T20:03:22.575Z").getTime();
			const windowStartMs = t0;
			const windowEndMs = t0 + 18_270; // floor = 5% of 18 270 = 913.5ms

			// Real candidate: starts before the window, closes partway through
			// it. Genuine, plausible, but an IMPERFECT (0.882) fraction.
			vi.setSystemTime(t0 - 2_000);
			const genuineToken = phaseStarted("genuine_partial_overlap");
			vi.setSystemTime(t0 + 15_000);
			phaseFinished(genuineToken); // elapsedMs 17 000, overlap 15 000

			// Blip: 1ms lifetime, entirely INSIDE the window — a PERFECT (1.0)
			// containment fraction, the best score any candidate could get.
			vi.setSystemTime(t0 + 9_000);
			const blipToken = phaseStarted("perfect_fraction_but_implausibly_short");
			vi.setSystemTime(t0 + 9_001);
			phaseFinished(blipToken); // elapsedMs 1, fraction 1.0 — but under the floor

			const attribution = getPhaseForWindow(windowStartMs, windowEndMs);
			// If fraction ranking ran BEFORE the floor, the 1.0-fraction blip
			// would win here regardless of its implausible size. It doesn't:
			// the floor removes it from consideration entirely.
			expect(attribution?.phase).toBe("genuine_partial_overlap");
		} finally {
			vi.useRealTimers();
		}
	});

	// #1723 review round 5, R1 (blocker) — the reviewer's "F-edge2" shape.
	// A bare `elapsedMs` denominator gives a bracket wholly INSIDE the
	// window a perfect, undeserved fraction of 1.0 (`overlapMs === elapsedMs`
	// whenever nothing spills past either window edge) — and the N4 floor
	// does not catch it: at 1000ms against an 18 270ms window (5% floor =
	// 913.5ms), 1000 > 913.5 clears the floor easily. Meanwhile a REAL
	// culprit whose own bracket is 19 270ms — 1000ms LONGER than the window,
	// because it started before the window opened — could only ever reach
	// 18270/19270 ≈ 0.948 under the bare-elapsedMs formula, losing to the
	// blip's 1.0. Dividing by `max(elapsedMs, windowLengthMs)` instead caps
	// the blip's fraction at `1000/18270 ≈ 0.055` (the window, not its own
	// tiny lifetime, sets the denominator once a bracket is no bigger than
	// the window), while the culprit's fraction is unaffected (its own
	// `elapsedMs` already exceeds the window). The culprit must win.
	it("R1 (F-edge2): a 1s innocent bracket wholly inside the window does not beat a 19.27s culprit that spills past it", () => {
		vi.useFakeTimers();
		try {
			const t0 = new Date("2026-08-19T20:03:22.575Z").getTime();
			const windowStartMs = t0;
			const windowLengthMs = 18_270;
			const windowEndMs = t0 + windowLengthMs;

			// Culprit: started 1000ms BEFORE the window opened, closes exactly
			// at the window's end. elapsedMs 19 270ms; overlap capped at the
			// full window (18 270ms) since it started outside the window.
			vi.setSystemTime(windowStartMs - 1_000);
			const culpritToken = phaseStarted("full_scan_19270ms");
			vi.setSystemTime(windowEndMs);
			phaseFinished(culpritToken);

			// Innocent: 1000ms lifetime, wholly INSIDE the window (500ms of
			// clearance on the near side) — passes the N4 floor (1000 > 913.5)
			// and, under a bare-elapsedMs denominator, would score a PERFECT
			// 1.0 fraction purely by virtue of never spilling past either edge.
			vi.setSystemTime(t0 + 9_000);
			const innocentToken = phaseStarted("innocent_wholly_inside");
			vi.setSystemTime(t0 + 10_000);
			phaseFinished(innocentToken);

			const attribution = getPhaseForWindow(windowStartMs, windowEndMs);
			expect(attribution?.phase).toBe("full_scan_19270ms");
		} finally {
			vi.useRealTimers();
		}
	});

	// #1723 review round 5, R2: the round-3 elapsedMs tie-break stays
	// reachable under fraction ranking — this constructs a genuine one. Two
	// brackets can share the SAME `overlapMs` against the window while
	// differing in `elapsedMs`, as long as NEITHER exceeds the window's own
	// length (both then divide by the same `windowLengthMs` denominator, so
	// equal overlap means equal fraction). The smaller-`elapsedMs` bracket —
	// a phase whose lifetime more tightly matches its own overlap, i.e. spent
	// less of itself OUTSIDE the window — must still win the tie.
	it("R2: a genuine fraction tie (equal overlap, differing elapsedMs, both ≤ window length) still falls back to the smaller elapsedMs", () => {
		vi.useFakeTimers();
		try {
			const t0 = new Date("2026-08-19T20:03:22.575Z").getTime();
			const windowStartMs = t0;
			const windowEndMs = t0 + 18_270;

			// A: starts 1000ms before the window, closes 9000ms in. elapsedMs
			// 10 000ms, overlap 9000ms (capped at its own close point).
			vi.setSystemTime(windowStartMs - 1_000);
			const aToken = phaseStarted("tighter_fit");
			vi.setSystemTime(windowStartMs + 9_000);
			phaseFinished(aToken);

			// B: starts 6000ms before the window, closes at the SAME instant as
			// A. elapsedMs 15 000ms, overlap ALSO 9000ms (same close point, and
			// still capped at the window's start on the near side) — an exact
			// overlap tie with A, but a longer lifetime.
			vi.setSystemTime(windowStartMs - 6_000);
			const bToken = phaseStarted("looser_fit");
			vi.setSystemTime(windowStartMs + 9_000);
			phaseFinished(bToken);

			// Both elapsedMs (10 000, 15 000) are ≤ the window length (18 270),
			// so both divide by the SAME windowLengthMs denominator — an exact
			// fraction tie (9000/18270 for each). The tie-break must pick A.
			const attribution = getPhaseForWindow(windowStartMs, windowEndMs);
			expect(attribution?.phase).toBe("tighter_fit");
			expect(attribution?.elapsedMs).toBe(10_000);
		} finally {
			vi.useRealTimers();
		}
	});

	// #1723 review round 7, S1 (blocker) — the reviewer's "C1" three-candidate
	// chain. A SINGLE-PASS streaming comparison chains: each accepted
	// candidate becomes the new `bestFraction`, including a tie-win, and
	// "near" is not transitive. Three candidates with adjacent fraction gaps
	// INSIDE the epsilon band but an OUTER gap (first-to-last) OUTSIDE it let
	// the running best walk across the whole band one hop at a time, so a
	// single-pass implementation's answer depends on SCAN ORDER. The
	// two-pass fix (find the true maximum first, then rank only the
	// candidates within the band OF THAT MAXIMUM) is order-independent by
	// construction — this test constructs the identical three candidates
	// with the SAME startedAt/closedAt values in two DIFFERENT close orders
	// (which flips their position in the closedBracket ring, and so the scan
	// order `getPhaseForWindow` sees them in) and asserts both orders name
	// the SAME winner.
	//
	// #1723 review round 8, T1: the FIRST version of this test (elapsedMs
	// 15 000/14 000/16 000 over an 18 270ms window) passed under the correct
	// two-pass code AND under an actual round-6-style chaining revert — its
	// numbers happened to land on the same winner (candidateB) either way,
	// so it pinned the elapsedMs discriminator but never actually exercised
	// the chaining defect it was written to catch. Replaced with the
	// reviewer's discriminating set: under CORRECT two-pass selection both
	// scan orders name Y; under a CHAINED single-pass revert, ascending scan
	// order (X, Y, Z) yields Z and descending order (Z, Y, X) yields X — two
	// different wrong answers, proving this version genuinely discriminates
	// (see the round-8 red-proof run in the PR body / session report).
	it("R1/S1 (C1 chain): a three-candidate near-tie chain is decided by the global maximum, not scan order", () => {
		const t0 = new Date("2026-08-19T20:03:22.575Z").getTime();
		const windowStartMs = t0;
		const windowLengthMs = 1_000_000;
		const windowEndMs = t0 + windowLengthMs;

		// Fractions 0.600000 / 0.600080 / 0.600160 — adjacent gaps (8e-5) sit
		// INSIDE FRACTION_TIE_EPSILON (1e-4); the outer gap (X to Z, 1.6e-4)
		// sits OUTSIDE it. All three elapsedMs values are ≤ windowLengthMs, so
		// all three share the same windowLengthMs denominator.
		// X: overlap 600 000, elapsedMs 600 000 (fraction 0.600000) — its gap
		//   from the TRUE maximum (Z, 0.600160) is 1.6e-4, OUTSIDE the epsilon
		//   band — must be EXCLUDED under correct two-pass selection.
		// Y: overlap 600 080, elapsedMs 700 000 (fraction 0.600080) — within
		//   the epsilon band of the TRUE maximum (Z), and the smaller of the
		//   two elapsedMs values in that band — the correct winner in BOTH
		//   scan orders.
		// Z: overlap 600 160, elapsedMs 800 000 (fraction 0.600160) — the true
		//   maximum fraction, but not the winner: Y is within its band and has
		//   a smaller elapsedMs.
		const candidates = [
			{ name: "X", overlapMs: 600_000, elapsedMs: 600_000 },
			{ name: "Y", overlapMs: 600_080, elapsedMs: 700_000 },
			{ name: "Z", overlapMs: 600_160, elapsedMs: 800_000 },
		];

		const runInCloseOrder = (
			closeOrder: readonly number[],
		): ReturnType<typeof getPhaseForWindow> => {
			resetCurrentPhaseForSession();
			vi.useFakeTimers();
			try {
				// Start ALL three first (order doesn't matter for live brackets
				// here — only close order determines closedBracket ring position).
				const tokens = candidates.map(({ name, overlapMs, elapsedMs }) => {
					vi.setSystemTime(windowStartMs - (elapsedMs - overlapMs));
					return phaseStarted(name);
				});
				for (const index of closeOrder) {
					vi.setSystemTime(windowStartMs + candidates[index].overlapMs);
					phaseFinished(tokens[index]);
				}
				return getPhaseForWindow(windowStartMs, windowEndMs);
			} finally {
				vi.useRealTimers();
			}
		};

		const ascendingOrder = runInCloseOrder([0, 1, 2]); // X, Y, Z
		const descendingOrder = runInCloseOrder([2, 1, 0]); // Z, Y, X

		// Sanity: the fraction ladder is shaped as designed.
		const fractionOf = (overlapMs: number) => overlapMs / windowLengthMs;
		expect(
			Math.abs(fractionOf(600_080) - fractionOf(600_160)),
		).toBeLessThanOrEqual(1e-4);
		expect(Math.abs(fractionOf(600_000) - fractionOf(600_160))).toBeGreaterThan(
			1e-4,
		);

		expect(ascendingOrder?.phase).toBe("Y");
		expect(ascendingOrder?.elapsedMs).toBe(700_000);
		expect(descendingOrder?.phase).toBe("Y");
		expect(descendingOrder?.elapsedMs).toBe(700_000);
	});

	// #1723 review round 7, S2 — round 6's `best === undefined` branch (now
	// pass 2's `best === undefined` check) and the `fraction <= 0` guard are
	// both load-bearing per the reviewer's probes, but neither had a
	// dedicated regression test: neutering either one leaves the round-6
	// suite (51/51) green. Pinning both here.

	// The "hatch": a LONE candidate whose fraction is itself within
	// FRACTION_TIE_EPSILON of the seeded 0 baseline (an extremely thin
	// sliver of overlap that still clears the N4 floor) must still be
	// attributed — it is the only, and therefore correct, candidate. Without
	// pass 2's `best === undefined` escape, this candidate would read as
	// "near" a best that doesn't exist yet and be silently dropped.
	it("S2 (hatch): a lone candidate whose fraction is itself near the seeded zero baseline still attributes", () => {
		vi.useFakeTimers();
		try {
			const t0 = new Date("2026-08-19T20:03:22.575Z").getTime();
			const windowStartMs = t0;
			const windowEndMs = t0 + 18_270; // floor = 913.5ms

			// elapsedMs 1000 clears the floor; overlap 1ms gives a fraction of
			// 1/18270 ≈ 5.47e-5 — positive, but within 1e-4 of 0.
			vi.setSystemTime(windowStartMs - 999);
			const token = phaseStarted("faint_but_real_signal");
			vi.setSystemTime(windowStartMs + 1);
			phaseFinished(token);

			const attribution = getPhaseForWindow(windowStartMs, windowEndMs);
			expect(attribution?.phase).toBe("faint_but_real_signal");
			expect(attribution?.elapsedMs).toBe(1_000);
		} finally {
			vi.useRealTimers();
		}
	});

	// The zero-guard: a LONE candidate with EXACTLY zero overlap must NOT
	// attribute, even though it is the only candidate present and even
	// though its `elapsedMs` clears the N4 floor.
	it("S2 (zero-guard): a lone candidate with exactly zero overlap does not attribute", () => {
		vi.useFakeTimers();
		try {
			const t0 = new Date("2026-08-19T20:03:22.575Z").getTime();
			const windowStartMs = t0;
			const windowEndMs = t0 + 18_270;

			// Starts exactly when the window ends; elapsedMs 1000 clears the
			// floor, but the bracket touches the window at a single instant —
			// zero overlap, not negative.
			vi.setSystemTime(windowEndMs);
			const token = phaseStarted("touches_the_edge_only");
			vi.setSystemTime(windowEndMs + 1_000);
			phaseFinished(token);

			expect(getPhaseForWindow(windowStartMs, windowEndMs)).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});

	// The zero-guard's negative-overlap sibling: a LONE candidate entirely
	// OUTSIDE the window (closed before the window even opened) must not
	// attribute either.
	it("S2 (zero-guard): a lone candidate with negative overlap does not attribute", () => {
		vi.useFakeTimers();
		try {
			const t0 = new Date("2026-08-19T20:03:22.575Z").getTime();
			const windowStartMs = t0;
			const windowEndMs = t0 + 18_270;

			// Starts and closes entirely before the window opens.
			vi.setSystemTime(windowStartMs - 2_000);
			const token = phaseStarted("finished_before_the_window_opened");
			vi.setSystemTime(windowStartMs - 1_000);
			phaseFinished(token);

			expect(getPhaseForWindow(windowStartMs, windowEndMs)).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});
});
