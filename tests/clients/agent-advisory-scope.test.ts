/**
 * #3748 item 1: the agent advisory queue is drained per session scope.
 *
 * The recurrence this prevents: `queueAgentAdvisory`'s queue is process-global
 * and carried no session tag, so ANY `context` call drained it. A secondary
 * or resumed session could receive, or drain, another session's advisory (the
 * #3741 fix-run loss notice), and the cap of 8 dropped the overflow with no
 * record.
 *
 * Scopes are real: the primary's is a real `RuntimeCoordinator`'s (S1, #3611),
 * a secondary's comes from `beginScope`, and a retired scope is the one
 * `resetForSession` retires. The producer side is pinned end to end in
 * `tests/clients/fix-run-restore.test.ts`.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
	_resetAgentNudgeForTests,
	consumeAgentNudge,
	queueAgentAdvisory,
} from "../../clients/agent-nudge.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { beginScope } from "../../clients/session-scope.js";

function dropped(): Array<{ subject: string; reason: string }> {
	return getDegradationSummary()
		.filter((group) => group.kind === "agent-advisory-dropped")
		.flatMap((group) => group.latestReasons);
}

function texts(result: ReturnType<typeof consumeAgentNudge>): string[] {
	return (result?.messages ?? []).map((message) => message.content);
}

beforeEach(() => {
	_resetAgentNudgeForTests();
	resetDegradationLedger();
});

describe("#3748 agent advisory queue is drained per scope", () => {
	it("does not drain the primary's advisory on a secondary's context call", () => {
		const runtime = new RuntimeCoordinator();
		queueAgentAdvisory("lost edit in a.rs", runtime.captureSessionGeneration());
		const secondary = beginScope({ role: "secondary" });

		expect(consumeAgentNudge(undefined, secondary)).toBeUndefined();
		expect(texts(consumeAgentNudge(undefined, runtime.sessionScope))).toEqual([
			expect.stringContaining("lost edit in a.rs"),
		]);
	});

	it("gives each scope only its own advisory", () => {
		const first = new RuntimeCoordinator();
		const second = new RuntimeCoordinator();
		queueAgentAdvisory("for first", first.captureSessionGeneration());
		queueAgentAdvisory("for second", second.captureSessionGeneration());

		expect(texts(consumeAgentNudge(undefined, second.sessionScope))).toEqual([
			expect.stringContaining("for second"),
		]);
		expect(texts(consumeAgentNudge(undefined, first.sessionScope))).toEqual([
			expect.stringContaining("for first"),
		]);
	});

	it("drains no advisory for a call that has no scope yet", () => {
		const runtime = new RuntimeCoordinator();
		queueAgentAdvisory("lost edit", runtime.captureSessionGeneration());

		expect(consumeAgentNudge()).toBeUndefined();
		expect(
			texts(consumeAgentNudge(undefined, runtime.sessionScope)),
		).toHaveLength(1);
	});

	it("drops and counts an advisory whose scope retired, and never delivers it to the next scope", () => {
		const runtime = new RuntimeCoordinator();
		const retiring = runtime.captureSessionGeneration();
		queueAgentAdvisory("old conversation", retiring);
		runtime.resetForSession();

		expect(consumeAgentNudge(undefined, runtime.sessionScope)).toBeUndefined();
		expect(dropped()).toEqual([
			expect.objectContaining({
				subject: `scope-retired:${retiring.scopeId}`,
				reason: expect.stringContaining("session scope retired"),
			}),
		]);
	});

	// #3780 (#3757 survivors): the queue entry leaves on delivery, so a second
	// `context` call of the same scope does not repeat the advisory.
	it("delivers an advisory once: a second context call of the scope gets nothing", () => {
		const runtime = new RuntimeCoordinator();
		queueAgentAdvisory("lost edit", runtime.captureSessionGeneration());

		expect(
			texts(consumeAgentNudge(undefined, runtime.sessionScope)),
		).toHaveLength(1);
		expect(consumeAgentNudge(undefined, runtime.sessionScope)).toBeUndefined();
	});

	it("does not let a retired scope's advisories occupy the cap", () => {
		const runtime = new RuntimeCoordinator();
		const old = runtime.captureSessionGeneration();
		for (let i = 0; i < 8; i++) queueAgentAdvisory(`old ${i}`, old);
		runtime.resetForSession();

		queueAgentAdvisory("new", runtime.captureSessionGeneration());

		expect(texts(consumeAgentNudge(undefined, runtime.sessionScope))).toEqual([
			expect.stringContaining("new"),
		]);
	});

	it("drops and counts an advisory queued by a scope that already retired", () => {
		const runtime = new RuntimeCoordinator();
		const stale = runtime.captureSessionGeneration();
		runtime.resetForSession();

		queueAgentAdvisory("late drain", stale);

		expect(consumeAgentNudge(undefined, runtime.sessionScope)).toBeUndefined();
		expect(dropped()).toEqual([
			expect.objectContaining({
				subject: `scope-retired:${stale.scopeId}`,
				reason: expect.stringContaining("session scope retired"),
			}),
		]);
	});

	it("counts each advisory dropped at the cap of 8", () => {
		const runtime = new RuntimeCoordinator();
		const scope = runtime.captureSessionGeneration();
		for (let i = 0; i < 10; i++) queueAgentAdvisory(`advisory ${i}`, scope);

		expect(
			texts(consumeAgentNudge(undefined, runtime.sessionScope)),
		).toHaveLength(8);
		expect(dropped()).toEqual([
			expect.objectContaining({
				subject: `cap:${scope.scopeId}`,
				reason: expect.stringContaining("(count: 2)"),
			}),
		]);
		// The cap row says why it fired (not the retired-scope wording).
		expect(dropped()[0]?.reason).toContain("8 were already queued");
		expect(dropped()[0]?.reason).not.toContain("session scope retired");
	});
});
