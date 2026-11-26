/**
 * #5784: the delivery gate's replay decision (`admitBlockerReplay`) and its
 * wording (`unconfirmedBlockerNote`), at the edges the write-path witness
 * (`tests/index-4484-unfixed-blocker-witness.test.ts`) does not reach: the
 * session reset, the file bound, the commit-only latch, the turn-end caps and
 * a mixed server and runner set.
 *
 * It also reads back the `blocker-replay-suppressed` record a held-back line
 * leaves, so a hold that nothing observes cannot ship silently.
 *
 * Recurrences prevented: a latch that outlives its session would hide the
 * first line a new session owes the agent, and a module-level map with no
 * bound grows with every file a long session touches (AGENTS.md shape 46).
 * #5788 review: a latch written at render hid a line the agent never got
 * (F4), the turn-end caps were decided outside the gate (F3), and a mixed set
 * promised the LSP probe for a runner's blocker (C2).
 */
import { afterEach, describe, expect, it } from "vitest";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import type { Diagnostic } from "../../clients/dispatch/types.js";
import {
	admitBlockerReplay,
	BLOCKER_FULL_DELIVERY_CAP,
	commitBlockerReplay,
	DEPENDENCY_DRIFT_MAX_DELIVERIES,
	resetBlockerReplayState,
	SELF_DRIFT_MAX_DELIVERIES,
	unconfirmedBlockerNote,
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

const decide = (filePath: string) =>
	admitBlockerReplay({
		surface: "withheld-line",
		filePath,
		blockers: [unconfirmed(filePath)],
	});

/** A per-write decision whose line reached the agent: committed. */
const replay = (filePath: string) => {
	const decision = decide(filePath);
	if (decision.commit !== undefined) commitBlockerReplay(decision.commit);
	return decision.shown;
};

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

describe("admitBlockerReplay commits only on delivery (#5788 review F4)", () => {
	it("delivers again when the first line was rendered but never delivered", () => {
		const file = "/project/src/abandoned.ts";
		expect(decide(file).shown).toBe("deliver");
		expect(decide(file).shown).toBe("deliver");
		expect(replay(file)).toBe("deliver");
		expect(replay(file)).toBe("suppress");
	});

	it("re-arms the file on a verdict once that write is delivered", () => {
		const file = "/project/src/verdict.ts";
		expect(replay(file)).toBe("deliver");
		const verdict = admitBlockerReplay({
			surface: "withheld-line",
			filePath: file,
			blockers: [{ ...unconfirmed(file), unconfirmedBy: undefined }],
		});
		expect(verdict.shown).toBe("deliver");
		commitBlockerReplay(verdict.commit!);
		expect(replay(file)).toBe("deliver");
	});
});

describe("admitBlockerReplay turn-end caps (#5788 review F3)", () => {
	it("collapses the turn-end replay once the full section reached the cap", () => {
		const at = (fullDeliveries: number) =>
			admitBlockerReplay({ surface: "turn-end-replay", fullDeliveries }).shown;
		expect(at(BLOCKER_FULL_DELIVERY_CAP - 1)).toBe("deliver");
		expect(at(BLOCKER_FULL_DELIVERY_CAP)).toBe("collapse");
	});

	it("adds the retirement note on the delivery that reaches each drift cap", () => {
		const at = (
			axis: "dependency-drift" | "self-drift",
			staleDeliveries: number,
		) =>
			admitBlockerReplay({
				surface: "turn-end-demoted",
				axis,
				staleDeliveries,
			}).shown;
		expect(at("dependency-drift", DEPENDENCY_DRIFT_MAX_DELIVERIES - 2)).toBe(
			"deliver",
		);
		expect(at("dependency-drift", DEPENDENCY_DRIFT_MAX_DELIVERIES - 1)).toBe(
			"retire-note",
		);
		expect(at("self-drift", SELF_DRIFT_MAX_DELIVERIES - 2)).toBe("deliver");
		expect(at("self-drift", SELF_DRIFT_MAX_DELIVERIES - 1)).toBe("retire-note");
	});
});

describe("unconfirmedBlockerNote settle paths (#5788 review C2, F2)", () => {
	const server: Diagnostic = {
		...unconfirmed("/p/a.ts"),
		serverId: "typescript",
	};
	const runner: Diagnostic = {
		...unconfirmed("/p/a.ts", 4),
		tool: "ast-grep",
		runnerId: "ast-grep-napi",
		unconfirmedBy: "ast-grep-napi",
	};

	it("names the LSP probe for the server's blocker and a write for the runner's", () => {
		const note = unconfirmedBlockerNote([server, runner], "a.ts");
		expect(note).toContain("source=lsp path=a.ts");
		expect(note).toContain("only a later write its check answers");
		expect(note).toMatch(/settles it\b/);
	});

	it("never offers the LSP probe for a runner-only set", () => {
		const note = unconfirmedBlockerNote([runner], "a.ts");
		expect(note).toContain("only a later write its check answers");
		expect(note).not.toContain("source=lsp");
	});

	it("says a re-check is running, never that fixing cannot retire it", () => {
		const note = unconfirmedBlockerNote(
			[{ ...runner, recheckInFlight: true }],
			"a.ts",
		);
		expect(note).toContain("re-check is still running");
		expect(note).not.toContain("cannot retire");
	});
});
