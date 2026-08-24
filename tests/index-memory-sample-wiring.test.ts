import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPiMock } from "./support/pi-mock.js";

// Wiring guard for the #1123 item 2 periodic memory sample: turn_end MUST
// emit exactly one `memory_sample` latency.log phase every
// MEMORY_SAMPLE_TURN_INTERVAL turns (runtime.turnIndex, bumped by turn_start's
// beginTurn()), never on turns in between and never on turn 0. This lives at
// the index.ts wiring seam (not clients/memory-sampler.ts's own unit tests)
// because the fact under test is "turn_end actually calls
// shouldEmitMemorySample/buildMemorySample/logLatency together at the right
// cadence" — a fact only observable by driving the real turn_start/turn_end
// handlers index.ts registers.

const latencyCalls: Array<Record<string, unknown>> = [];
vi.mock("../clients/latency-logger.js", async (importActual) => {
	const actual =
		await importActual<typeof import("../clients/latency-logger.js")>();
	return {
		...actual,
		logLatency: (entry: Record<string, unknown>) => {
			latencyCalls.push(entry);
		},
	};
});

// Heavy turn_end tail is separately tested; stub to keep this a wiring check.
vi.mock("../clients/bootstrap.js", () => ({
	loadBootstrapClients: async () => ({
		metricsClient: { reset: () => {} },
		knipClient: { isAvailable: () => false },
		depChecker: { isAvailable: () => false },
		testRunnerClient: { detectRunner: () => null },
		deadCodeClients: [],
	}),
}));
vi.mock("../clients/runtime-turn.js", () => ({
	handleTurnEnd: vi.fn(async () => undefined),
	cancelLSPIdleReset: vi.fn(),
}));

const memorySamples = () =>
	latencyCalls.filter((e) => e.phase === "memory_sample");

const turnCtx = {
	cwd: process.cwd(),
	ui: {
		notify: vi.fn(),
		setStatus: () => {},
		theme: { fg: (_c: string, s: string) => s },
	},
};

async function driveTurns(count: number) {
	const { default: registerExtension } = await import("../index.js");
	const mock = createPiMock({ "lens-lsp": true });
	registerExtension(mock.asExtensionAPI() as never);
	const turnStart = mock.getHandlers("turn_start")[0];
	const turnEnd = mock.getHandlers("turn_end")[0];
	expect(turnStart).toBeTypeOf("function");
	expect(turnEnd).toBeTypeOf("function");
	for (let i = 0; i < count; i++) {
		await turnStart?.({}, turnCtx as never);
		await turnEnd?.({}, turnCtx as never);
	}
	return mock;
}

// #1778: each case drives `driveTurns`, which pays a COLD
// `import("../index.js")` after `vi.resetModules()` in `beforeEach` —
// deliberate, not accidental. index.ts carries turn-scoped module state
// (runtime.turnIndex), which is exactly what this wiring guard checks
// (cadence across turns). Sharing one import across cases would defeat the
// isolation the tests exist to prove, so the fix is a timeout budget, not a
// hoisted import (matching #1772/#1779's index-loop-block-wiring fix and
// this repo's HEAVY_IO_TIMEOUT_MS convention,
// tests/clients/ast-grep-rule-precedence-followups.test.ts:210).
const MEMORY_SAMPLE_WIRING_TIMEOUT_MS = 30_000;

describe(
	"index turn_end memory_sample wiring (#1123 item 2)",
	{
		timeout: MEMORY_SAMPLE_WIRING_TIMEOUT_MS,
	},
	() => {
		beforeEach(() => {
			vi.resetModules();
			latencyCalls.length = 0;
		});
		afterEach(() => {
			vi.clearAllMocks();
		});

		it("emits nothing before turn 10 (runtime.turnIndex bumped by turn_start)", async () => {
			await driveTurns(9);
			expect(memorySamples()).toHaveLength(0);
		});

		it("emits exactly one memory_sample on turn 10, with process + subsystems metadata", async () => {
			await driveTurns(10);
			const samples = memorySamples();
			expect(samples).toHaveLength(1);
			expect(samples[0].durationMs).toBe(0);
			const metadata = samples[0].metadata as Record<string, unknown>;
			expect(metadata.turnIndex).toBe(10);
			expect(metadata.process).toBeDefined();
			expect(metadata.subsystems).toBeDefined();
			const proc = metadata.process as Record<string, number>;
			expect(proc.rssBytes).toBeGreaterThan(0);
			// #1999: session-age + turn-count ridealong for growth-vs-age curves.
			const session = metadata.session as Record<string, number>;
			expect(session.sessionAgeMs).toBeGreaterThanOrEqual(0);
			expect(session.turnCount).toBe(10);
		});

		it("emits again on turn 20 but not on turns 11-19 (cadence, not a one-shot)", async () => {
			await driveTurns(20);
			const samples = memorySamples();
			expect(samples).toHaveLength(2);
			expect((samples[0].metadata as Record<string, unknown>).turnIndex).toBe(
				10,
			);
			expect((samples[1].metadata as Record<string, unknown>).turnIndex).toBe(
				20,
			);
		});
	},
);
