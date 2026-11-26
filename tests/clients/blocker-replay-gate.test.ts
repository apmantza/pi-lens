/**
 * #5784: the delivery gate's replay latch for per-write blocker lines
 * (`admitBlockerReplay`), at its two lifecycle edges the write-path witness
 * (`tests/index-4484-unfixed-blocker-witness.test.ts`) does not reach: the
 * session reset and the file bound.
 *
 * It also reads back the `blocker-replay-suppressed` record a held-back line
 * leaves, so a hold that nothing observes cannot ship silently.
 *
 * Recurrences prevented: a latch that outlives its session would hide the
 * first line a new session owes the agent, and a module-level map with no
 * bound grows with every file a long session touches (AGENTS.md shape 46).
 */
import { afterEach, describe, expect, it } from "vitest";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import type { Diagnostic } from "../../clients/dispatch/types.js";
import {
	admitBlockerReplay,
	resetBlockerReplayState,
} from "../../clients/finding-delivery-gate.js";
import { resetSessionScopedState } from "../../clients/runtime-session.js";

/** A blocker a carry kept because its server gave no verdict. */
function unconfirmed(filePath: string, line = 2): Diagnostic {
	return {
		id: `ts:${line}`,
		message: "Cannot find name 'BAD_CALL'.",
		filePath,
		line,
		severity: "error",
		semantic: "blocking",
		tool: "lsp",
		rule: "ts:2304",
		unconfirmedBy: "typescript",
	};
}

const replay = (filePath: string) =>
	admitBlockerReplay({
		surface: "withheld-line",
		filePath,
		blockers: [unconfirmed(filePath)],
	});

afterEach(() => {
	resetBlockerReplayState();
	resetDegradationLedger();
});

describe("admitBlockerReplay lifecycle (#5784)", () => {
	it("records every held-back replay under one counted row per surface and file", () => {
		const file = "/project/src/counted.ts";
		expect(replay(file)).toBe("deliver");
		expect(replay(file)).toBe("suppress");
		expect(replay(file)).toBe("suppress");
		const row = getDegradationSummary().find(
			(group) => group.kind === "blocker-replay-suppressed",
		);
		expect(row?.count).toBe(2);
		expect(row?.latestReasons).toEqual([
			expect.objectContaining({
				subject: expect.stringContaining("withheld-line:"),
			}),
		]);
	});

	it("delivers an unconfirmed line again in a new session", () => {
		const file = "/project/src/reset.ts";
		expect(replay(file)).toBe("deliver");
		expect(replay(file)).toBe("suppress");
		// The production session reset, not the gate's own test seam.
		resetSessionScopedState();
		expect(replay(file)).toBe("deliver");
	});

	it("lets the oldest file's identical replay through once its entry is evicted", () => {
		const first = "/project/src/file-0.ts";
		expect(replay(first)).toBe("deliver");
		expect(replay(first)).toBe("suppress");
		for (let i = 1; i <= 1_000; i += 1) replay(`/project/src/file-${i}.ts`);
		// Evicted: delivered once more, never held back forever by a lost key.
		expect(replay(first)).toBe("deliver");
	});
});
