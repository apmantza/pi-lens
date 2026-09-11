import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LatencyEntry } from "../../clients/latency-logger.js";
import { _resetProcessSingletonsForTests } from "../../clients/process-singletons.js";

const latencyEntries = vi.hoisted(() => [] as LatencyEntry[]);
vi.mock("../../clients/latency-logger.js", async (importOriginal) => ({
	...(await importOriginal()),
	logLatency: (entry: LatencyEntry) => latencyEntries.push(entry),
}));

import {
	emitConcurrentSessionBindRollupAtSessionEnd,
	getConcurrentSessionBindRollupCounts,
	logConcurrentSessionBind,
	resetConcurrentSessionBindRollupCounts,
} from "../../clients/session-start-observability.js";

describe("session-start observability", () => {
	beforeEach(() => {
		latencyEntries.length = 0;
		_resetProcessSingletonsForTests();
	});

	it("a concurrent secondary emits only its bind record", () => {
		logConcurrentSessionBind({
			secondaryCount: 1,
			sessionReason: "fork",
			sameCwd: true,
		});

		expect(latencyEntries).toEqual([
			{
				type: "phase",
				filePath: "<pi-lens>",
				phase: "concurrent_session_bind",
				durationMs: 0,
				metadata: {
					secondaryCount: 1,
					sessionReason: "fork",
					sameCwd: true,
				},
			},
		]);
	});
});

// #2249: the rollup is process-singleton backed (AGENTS.md catalog shape 25),
// not a module-scope `let` like session-lifecycle.ts's sibling rollups. These
// tests cover the counting/emission contract; the multi-evaluation describe
// block below covers the specific defect shape 25 exists to prevent.
describe("session-start observability — #2249 declined-bind rollup", () => {
	beforeEach(() => {
		latencyEntries.length = 0;
		_resetProcessSingletonsForTests();
	});

	it("accumulates declined binds by classification and emits one bounded row at session end", () => {
		logConcurrentSessionBind({
			secondaryCount: 1,
			sameCwd: true,
			classification: "concurrent-secondary",
		});
		logConcurrentSessionBind({
			secondaryCount: 2,
			sameCwd: false,
			classification: "concurrent-secondary",
		});
		logConcurrentSessionBind({
			secondaryCount: 3,
			sameCwd: false,
			classification: "secondary-root",
		});
		expect(getConcurrentSessionBindRollupCounts()).toEqual({
			"concurrent-secondary": 2,
			"secondary-root": 1,
			unclassified: 0,
		});

		latencyEntries.length = 0;
		emitConcurrentSessionBindRollupAtSessionEnd("/project");

		expect(latencyEntries).toEqual([
			{
				type: "phase",
				filePath: "/project",
				phase: "concurrent_session_bind_rollup",
				durationMs: 0,
				metadata: {
					"concurrent-secondary": 2,
					"secondary-root": 1,
					unclassified: 0,
				},
			},
		]);
	});

	it("bounds an unrecognized/absent classification into a third fixed bucket", () => {
		// No `classification` at all — the field is optional for older callers
		// (see the doc comment on logConcurrentSessionBind's args).
		logConcurrentSessionBind({ secondaryCount: 1, sameCwd: true });
		expect(getConcurrentSessionBindRollupCounts()).toEqual({
			"concurrent-secondary": 0,
			"secondary-root": 0,
			unclassified: 1,
		});
	});

	it("emits nothing when no bind was declined this session — no noise on an ordinary session", () => {
		emitConcurrentSessionBindRollupAtSessionEnd("/project");
		expect(latencyEntries).toEqual([]);
	});

	it("clears the counters after emitting, so a second session_shutdown call is a no-op", () => {
		logConcurrentSessionBind({
			secondaryCount: 1,
			sameCwd: true,
			classification: "secondary-root",
		});
		latencyEntries.length = 0; // drop the per-bind concurrent_session_bind row
		emitConcurrentSessionBindRollupAtSessionEnd("/project");
		expect(latencyEntries).toHaveLength(1);

		latencyEntries.length = 0;
		emitConcurrentSessionBindRollupAtSessionEnd("/project");
		expect(latencyEntries).toEqual([]);
		expect(getConcurrentSessionBindRollupCounts()).toEqual({
			"concurrent-secondary": 0,
			"secondary-root": 0,
			unclassified: 0,
		});
	});

	// AGENTS.md catalog shape 17: every once-latch answers "what resets it at
	// session_start?". index.ts calls this on the PRIMARY continuation path
	// only, so a crash/kill that skips session_shutdown's own emit-and-reset
	// still cannot leak a prior primary session's tally into the next one.
	it("resetConcurrentSessionBindRollupCounts (session-boundary reset) clears without emitting", () => {
		logConcurrentSessionBind({
			secondaryCount: 1,
			sameCwd: true,
			classification: "concurrent-secondary",
		});
		latencyEntries.length = 0; // drop the per-bind concurrent_session_bind row
		resetConcurrentSessionBindRollupCounts();
		expect(latencyEntries).toEqual([]);
		expect(getConcurrentSessionBindRollupCounts()).toEqual({
			"concurrent-secondary": 0,
			"secondary-root": 0,
			unclassified: 0,
		});

		// Proven a second way: emitting after the reset must also be a no-op —
		// not just that the getter reports zero.
		emitConcurrentSessionBindRollupAtSessionEnd("/project");
		expect(latencyEntries).toEqual([]);
	});
});

// AGENTS.md catalog shape 25's own detection method: evaluate the module
// TWICE (vi.resetModules() + dynamic import) and prove the second evaluation
// sees the first's state. pi evaluates the pi-lens module graph more than
// once per process (#2146 measured one pid emitting host_boot nine times), so
// a module-scope `let` counter here would silently undercount — the second
// evaluation's `let` starts at zero and never sees binds routed through the
// first. Every import below uses the `.js` specifier — the artifact the
// runtime loads (catalog shape 14) — never `.ts`.
describe("session-start observability — #2249 rollup survives module re-evaluation", () => {
	beforeEach(() => {
		latencyEntries.length = 0;
		_resetProcessSingletonsForTests();
	});

	afterEach(() => {
		_resetProcessSingletonsForTests();
	});

	async function freshEvaluation() {
		vi.resetModules();
		return (await import("../../clients/session-start-observability.js")) as typeof import("../../clients/session-start-observability.js");
	}

	it("a second evaluation's bind is counted in the rollup the first evaluation emits", async () => {
		const first = await freshEvaluation();
		first.logConcurrentSessionBind({
			secondaryCount: 1,
			sameCwd: true,
			classification: "concurrent-secondary",
		});

		// pi's SECOND evaluation of the same graph — a fresh module instance,
		// same process, same globalThis.
		const second = await freshEvaluation();
		second.logConcurrentSessionBind({
			secondaryCount: 2,
			sameCwd: false,
			classification: "secondary-root",
		});

		expect(second.getConcurrentSessionBindRollupCounts()).toEqual({
			"concurrent-secondary": 1,
			"secondary-root": 1,
			unclassified: 0,
		});

		latencyEntries.length = 0;
		second.emitConcurrentSessionBindRollupAtSessionEnd("/project");

		expect(latencyEntries).toEqual([
			{
				type: "phase",
				filePath: "/project",
				phase: "concurrent_session_bind_rollup",
				durationMs: 0,
				metadata: {
					"concurrent-secondary": 1,
					"secondary-root": 1,
					unclassified: 0,
				},
			},
		]);
	});
});
