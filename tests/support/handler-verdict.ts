/**
 * Run a pi-lens hook handler and fail the test when the handler THREW and
 * production swallowed it (#3518; recurrence #4182).
 *
 * Why this exists. `handleToolCall` is the one pi-lens hook handler that
 * absorbs every throw: pi's `emitToolCall` has no per-handler catch, so an
 * escaped throw would refuse the user's tool call, and
 * `clients/runtime-tool-call.ts` therefore turns any throw into "no opinion"
 * (`undefined`) plus one `tool-call-handler-throw` degradation record. That
 * is the right production policy and the wrong test property: a test that
 * asserts "the result is undefined" or "the call is not blocked" passes when
 * the handler crashed before it reached the verdict it was meant to judge.
 * #4182's review found exactly that: `observed-mutation-integration.test.ts`
 * mocked `clients/bootstrap.js` without `requestBootstrapClients`,
 * `handleToolCall` threw at the complexity-baseline step, and every "result is
 * undefined / not blocked" assertion in the file passed whatever the read
 * guard would have said.
 *
 * Known limit (#4201 verify R2-1). The helper reads the statically imported
 * ledger and the one the current module graph resolves. A hook registered in
 * an earlier graph and fired after a SECOND `vi.resetModules()` in the same
 * test records into a third instance the helper does not read. No test does
 * that today; a test that needs it must re-import the helper after the reset.
 *
 * What it does. `runHandlerExpectingNoThrow(call)` awaits the handler call
 * and returns its verdict, after checking the production record of a swallowed
 * throw on both sides of the call:
 *
 * - AFTER the call: a watched ledger kind gained a record, so the handler
 *   threw during THIS call. The failure carries the swallowed message.
 * - BEFORE the call: a watched kind already holds a record. The ledger keeps
 *   one record per `(kind, subject)` per session (`recordDegradationOnce`), so
 *   a second throw for the same tool name is invisible to any after-the-call
 *   diff; an earlier swallow therefore fails the next checked call at entry
 *   instead of letting it read an unobservable ledger. Both failures reset the
 *   ledger so one root cause fails one test, not every later test in the file.
 *
 * Which handlers it covers (the ledger kinds in `WATCHED_KINDS`):
 *
 * - `tool-call-handler-throw`: `handleToolCall`'s total guard, the only
 *   handler that swallows a throw into a verdict.
 * - `hook-handler-crash`: `surfaceHandlerCrash` (`clients/session-event-guard.ts`),
 *   which `index.ts`'s session_start, session_tree, agent_end, turn_end,
 *   agent_settled, message_end and observed-sweep catch sites call. Under
 *   vitest it rethrows (#2884), so those handlers fail the awaiting test
 *   anyway; the kind is watched for the two `rethrow: false` sites
 *   (`quiet_window`, the late format resync) and any handler that drops the
 *   rethrow later.
 *
 * `handleToolResult`, `handleAgentEnd`, `handleTurnEnd` and
 * `handleSessionStart` have no whole-handler catch: a throw rejects the
 * awaited call and fails the test without this helper
 * (`tests/clients/handler-verdict-helper.test.ts` pins that).
 *
 * A call that REJECTS rejects here too, unchanged: the helper only adds the
 * failure for the throw production hides.
 *
 * Intentional degradation (a case that makes the handler throw on purpose to
 * test the guard) does not use this helper; it calls the handler directly and
 * is registered, with its reason, in `tests/config/handler-verdict-sweep.test.ts`.
 */

import * as importedLedger from "../../clients/degradation-ledger.js";

/**
 * Both ledger instances a handler can have recorded into (AGENTS.md shape 14).
 * A test that calls `vi.resetModules()` and then imports `index.js` gives the
 * production handler a FRESH `degradation-ledger` instance, while this module
 * and `pi-mock.ts` (imported once) keep the original, which stays empty: the
 * check passed on a crashed handler (#4201 review F1: with
 * `handleToolCallImpl` always throwing, two `tool_call` tests in
 * `tests/index-integration.test.ts` passed and printed no helper message).
 * A dynamic import resolves in the registry that is current when the hook
 * fires, which is the one the test just imported the handler into. A handler
 * the test imported BEFORE a reset still records into the original, so both
 * are read; with no reset they are one instance and it is read once.
 */
async function ledgers(): Promise<
	Array<typeof import("../../clients/degradation-ledger.js")>
> {
	const current = await import("../../clients/degradation-ledger.js");
	return current.getDegradationSummary === importedLedger.getDegradationSummary
		? [importedLedger]
		: [importedLedger, current];
}

/** Ledger kinds that mean "a hook handler threw and production swallowed it". */
const WATCHED_KINDS: ReadonlySet<string> = new Set([
	"tool-call-handler-throw",
	"hook-handler-crash",
]);

interface SwallowedThrow {
	kind: string;
	subject: string;
	reason: string;
}

/** Every swallowed-throw record the ledger holds, newest last. */
async function swallowedThrows(): Promise<{
	total: number;
	retained: SwallowedThrow[];
}> {
	let total = 0;
	const retained: SwallowedThrow[] = [];
	for (const group of (await ledgers()).flatMap((instance) =>
		instance.getDegradationSummary(),
	)) {
		if (!WATCHED_KINDS.has(group.kind)) continue;
		total += group.count;
		for (const entry of group.latestReasons) {
			retained.push({ kind: group.kind, ...entry });
		}
	}
	return { total, retained };
}

function describeSwallowed(found: {
	total: number;
	retained: SwallowedThrow[];
}): string {
	const lines = found.retained.map(
		(entry) => `  ${entry.kind} (${entry.subject}): ${entry.reason}`,
	);
	const omitted = found.total - found.retained.length;
	if (omitted > 0) lines.push(`  (+${omitted} more not retained)`);
	return lines.join("\n");
}

async function resetLedgers(): Promise<void> {
	for (const instance of await ledgers()) instance.resetDegradationLedger();
}

export async function runHandlerExpectingNoThrow<T>(
	call: () => T | Promise<T>,
): Promise<Awaited<T>> {
	const earlier = await swallowedThrows();
	if (earlier.total > 0) {
		await resetLedgers();
		throw new Error(
			`a pi-lens hook handler already threw and production swallowed it before this call, so a repeat throw would be invisible (the ledger keeps one record per handler subject):\n${describeSwallowed(earlier)}`,
		);
	}
	const verdict = await call();
	const during = await swallowedThrows();
	if (during.total > 0) {
		await resetLedgers();
		throw new Error(
			`a pi-lens hook handler threw during this call and production swallowed it, so its verdict is not the handler's judgement:\n${describeSwallowed(during)}`,
		);
	}
	return verdict as Awaited<T>;
}
