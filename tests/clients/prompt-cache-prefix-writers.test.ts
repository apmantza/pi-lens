/**
 * #4687: every pi-lens writer of the prompt-cache prefix, on the REAL host.
 *
 * The defect is not a handler's return value: it is what the PROVIDER receives
 * on the next request, after pi has folded system messages into one head. So
 * each case below starts a real pi `AgentSession` over the built extension
 * (`tests/support/pi-session.ts`, tier 2), drives ONE writer between two
 * consecutive requests, and asserts the two things a provider caches:
 *
 *   - the transcript head pi hands the extension, byte for byte;
 *   - pi-ai's own `collapseSystemMessages` replay of that transcript, which is
 *     the head a model WITHOUT mid-conversation system support receives.
 *
 * The four writers are isolated by the switch that leaves the others inert:
 *
 *   - registration (`pi.registerTool` at load): `--no-lazy-tools` makes the
 *     session-start plan a no-op, so only registration shaped the tool table.
 *   - session-start plan (`applyToolSetPlan`): the default lazy-tools posture
 *     shrinks the host's initial all-active set before the first request.
 *   - activation (`pi_lens_activate_tools`): pi appends the tool delta as a new
 *     system message, which the collapse folds into the head exactly once.
 *   - injection (`context_with_system`): the payload rides the last user
 *     message, so neither head moves.
 *
 * Item 2's causes are red-first through the same real sessions. `fauxProvider`
 * caches the RAW transcript, so its numbers stay healthy even where a
 * collapsing provider would miss; the cases therefore replay the collapse
 * provider the way the issue's investigation did (collapse with pi-ai's own
 * function, then read the price of the common prefix) and feed THAT usage to
 * the production classifier in this process. The records are read back from
 * this process's flushed latency sink, never from a test-side logger double.
 *
 * Item 5 rides the same sink: two unexplained misses record ONE bounded
 * `prompt-cache-miss-unexplained` degradation row, and later ones only count.
 */
import * as fs from "node:fs";
import { describe, expect, it } from "vitest";
import { clearCachePrefixSession } from "../../clients/cache-observability.js";
import {
	logCacheUsage,
	observeCachePrefix,
	resetCachePrefixObservation,
} from "../support/cache-session-scopes.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { getLatencyLogPath } from "../../clients/latency-logger.js";
import { flushAllNdjsonWriters } from "../../clients/ndjson-logger.js";
import { readNdjsonRows } from "../support/ndjson-rows.js";
import { AUTOMATION_FRAMING } from "../../clients/runtime-context.js";
import {
	BLOCKING_FILE,
	CLEAN_FILE,
	endTurn,
	openGuardedSession,
	seed,
	step,
	writeTarget,
} from "../support/pi-session-commit-gate.js";
import {
	fauxAssistantMessage,
	fauxToolCall,
	piAiModule,
	piSessionFixture,
	replayToolNames,
	startPiSession,
} from "../support/pi-session.js";

interface TranscriptReplay {
	collapseSystemMessages(context: { messages: readonly unknown[] }): {
		messages: readonly unknown[];
	};
	normalizeContext(context: { messages: readonly unknown[] }): {
		messages: readonly unknown[];
	};
}

/**
 * pi-ai's transcript replay, through the handle the tier-2 helper already
 * loaded from the certified host's own install (see
 * `tests/clients/context-injection-cache-head.test.ts` for the same rule: no
 * `@earendil-works/pi-ai` import specifier may exist in this tree).
 */
const piAi = piAiModule() as unknown as TranscriptReplay;

const fixture = piSessionFixture();

const LAZY_TOOL = "ast_grep_search";
const ALWAYS_ACTIVE_TOOL = "lens_diagnostics";

/** The head a model WITHOUT mid-conversation system messages receives. */
function collapsedHead(messages: readonly unknown[]): string {
	return JSON.stringify(
		piAi.collapseSystemMessages(
			piAi.normalizeContext({ messages: [...messages] }),
		).messages[0],
	);
}

/**
 * The prompt text a collapsing provider sends: the collapsed transcript,
 * serialized so a byte-identical prefix is a byte-identical string.
 */
function collapsedPrompt(messages: readonly unknown[]): string {
	return piAi
		.collapseSystemMessages(piAi.normalizeContext({ messages: [...messages] }))
		.messages.map((message) => JSON.stringify(message))
		.join("\n\n");
}

/** Characters shared by two prompt strings, from the first difference. */
function commonPrefixChars(left: string, right: string): number {
	const limit = Math.min(left.length, right.length);
	let index = 0;
	while (index < limit && left[index] === right[index]) index += 1;
	return index;
}

/** The documented four-chars-per-token estimate, matching fauxProvider's own. */
function estimatedTokens(chars: number): number {
	return Math.ceil(chars / 4);
}

/** What a collapsing provider would report for one request in a sequence. */
function collapseUsage(
	prompts: readonly string[],
	index: number,
): { cacheRead: number; input: number } {
	const current = prompts[index] ?? "";
	const previous = index > 0 ? (prompts[index - 1] ?? "") : undefined;
	const cacheRead =
		previous === undefined
			? 0
			: estimatedTokens(commonPrefixChars(previous, current));
	return {
		cacheRead,
		input: Math.max(0, estimatedTokens(current.length) - cacheRead),
	};
}

/** Feed one collapsing provider's usage to the production classifier. */
function logCollapseUsage(
	sessionId: string,
	usage: { cacheRead: number; input: number },
	turnIndex: number,
): void {
	logCacheUsage(
		{
			role: "assistant",
			provider: "faux",
			model: "faux-1",
			usage: {
				input: usage.input,
				output: 10,
				cacheRead: usage.cacheRead,
				cacheWrite: 0,
				totalTokens: usage.cacheRead + usage.input + 10,
			},
			stopReason: "stop",
			timestamp: 0,
		},
		undefined,
		{ sessionId, turnIndex },
	);
}

/**
 * Rows this process wrote to its own flushed latency sink. The loaded copy's
 * rows land under the fixture home (`handle.latencyRows()`); these are the
 * records the in-process production classifier emitted.
 */
async function inProcessLatencyRows(): Promise<Array<Record<string, unknown>>> {
	await flushAllNdjsonWriters();
	const read = readNdjsonRows(getLatencyLogPath());
	// Every claim below counts rows in this sink, so a line the reader dropped
	// would make a "no row was written" assertion pass for the wrong reason.
	expect(read.skipped).toBe(0);
	return read.rows;
}

function usageRows(
	rows: ReadonlyArray<Record<string, unknown>>,
	sessionId: string,
): Array<Record<string, unknown>> {
	return rows.flatMap((row) => {
		if (row.phase !== "cache_usage") return [];
		const metadata = row.metadata as Record<string, unknown> | undefined;
		// The sink is file-scoped and holds every earlier case's rows too.
		return metadata?.sessionId === sessionId ? [metadata] : [];
	});
}

/** A fresh project directory for one case, under this file's one fixture. */
function projectDir(segment: string): string {
	return `${fixture.root}/${segment}/proj`;
}

describe("#4687 prefix writers keep the provider's cached head", () => {
	it("registration: the registered tool table is not rewritten by a later request", async () => {
		const handle = await startPiSession({
			root: fixture.root,
			cwd: projectDir("writer-registration"),
			startupMode: "quick",
			// The plan is inert, so registration is the ONLY writer of the tool
			// table: both requests must carry exactly what load registered.
			flags: new Map([["no-lazy-tools", true]]),
			responses: [
				fauxAssistantMessage("first answer"),
				fauxAssistantMessage("second answer"),
			],
		});
		await handle.prompt("first question");
		await handle.prompt("second question");
		const [first, second] = handle.requests;
		if (!first || !second) throw new Error("both turns must send a request");

		// Registration is live in both requests (the plan never shrank them).
		expect(new Set(replayToolNames(first))).toContain(LAZY_TOOL);
		expect(new Set(replayToolNames(second))).toEqual(
			new Set(replayToolNames(first)),
		);
		// Neither head moved: transcript bytes and pi-ai's collapse both agree.
		expect(JSON.stringify(second[0])).toBe(JSON.stringify(first[0]));
		expect(collapsedHead(second)).toBe(collapsedHead(first));
	});

	it("session-start plan: the shrink lands before the first request and is never reapplied", async () => {
		const handle = await startPiSession({
			root: fixture.root,
			cwd: projectDir("writer-plan"),
			startupMode: "quick",
			responses: [
				fauxAssistantMessage("first answer"),
				fauxAssistantMessage("second answer"),
			],
		});
		await handle.prompt("first question");
		await handle.prompt("second question");
		const [first, second] = handle.requests;
		if (!first || !second) throw new Error("both turns must send a request");

		// The plan's effect: the lazy tool is not in the advertised loadout, so
		// the write under test really ran.
		expect(new Set(replayToolNames(first))).not.toContain(LAZY_TOOL);
		expect(new Set(replayToolNames(first))).toContain(ALWAYS_ACTIVE_TOOL);
		expect(JSON.stringify(second[0])).toBe(JSON.stringify(first[0]));
		expect(collapsedHead(second)).toBe(collapsedHead(first));
	});

	it("activation: the tool delta changes the collapsed head exactly once, and the miss names tool-set-changed", async () => {
		// `PI_LENS_TEST_MODE=0` makes the in-process logger write its real sink;
		// the same-function `finally` restores it (the accepted restore shape).
		const previousTestMode = process.env.PI_LENS_TEST_MODE;
		process.env.PI_LENS_TEST_MODE = "0";
		try {
			const handle = await startPiSession({
				root: fixture.root,
				cwd: projectDir("writer-activation"),
				startupMode: "quick",
				responses: [
					fauxAssistantMessage("first answer"),
					fauxAssistantMessage(
						fauxToolCall("pi_lens_activate_tools", { tools: [LAZY_TOOL] }),
					),
					fauxAssistantMessage("activation answer"),
					fauxAssistantMessage("last answer"),
				],
			});
			await handle.prompt("first question");
			await handle.prompt("activate the search tool");
			await handle.prompt("third question");
			const requests = handle.requests;
			if (requests.length !== 4) {
				throw new Error(
					`expected four provider requests, got ${requests.length}`,
				);
			}
			const plain = requests[0];
			if (!plain) throw new Error("the first turn sent no request");

			// The RAW head never moves: pi appends the delta as a system message.
			for (const request of requests) {
				expect(JSON.stringify(request[0])).toBe(JSON.stringify(plain[0]));
			}
			// The collapsed head moves exactly once (`beforeDelta` -> `withDelta`)
			// and then stays put, which is the property a collapsing provider
			// caches on.
			const collapsed = requests.map((request) => collapsedHead(request));
			expect(collapsed[2]).not.toBe(collapsed[1]);
			expect(collapsed[3]).toBe(collapsed[2]);

			// Replay the collapsing provider's price for the same four requests and
			// run the production observer/classifier over them, exactly as the
			// loaded copy does for the raw requests.
			const sessionId = handle.session.sessionManager.getSessionId();
			// The real session start already observed this id; start the replay from
			// the empty state the old whole-table reset gave (#4965: the production
			// per-session clear, which a session's shutdown runs).
			clearCachePrefixSession(sessionId);
			const prompts = requests.map((request) => collapsedPrompt(request));
			const rows: Array<{ cacheRead: number; input: number }> = [];
			for (let index = 0; index < requests.length; index += 1) {
				observeCachePrefix(requests[index] ?? [], index, sessionId);
				const usage = collapseUsage(prompts, index);
				rows.push(usage);
				logCollapseUsage(sessionId, usage, index);
			}
			expect(rows[1]?.cacheRead ?? 0).toBeGreaterThan(rows[2]?.cacheRead ?? 0);

			const verdicts = usageRows(await inProcessLatencyRows(), sessionId);
			expect(verdicts.map((row) => row.cacheMissCause)).toEqual([
				null,
				null,
				"tool-set-changed",
				null,
			]);
		} finally {
			if (previousTestMode === undefined) delete process.env.PI_LENS_TEST_MODE;
			else process.env.PI_LENS_TEST_MODE = previousTestMode;
		}
	});

	it("injection: the payload rides the last user message and neither head moves", async () => {
		// `PI_LENS_TEST_MODE=0` makes the in-process logger write its real sink;
		// the same-function `finally` restores it (the accepted restore shape).
		const previousTestMode = process.env.PI_LENS_TEST_MODE;
		process.env.PI_LENS_TEST_MODE = "0";
		try {
			const { CacheManager } = await import("../../clients/cache-manager.js");
			const handle = await startPiSession({
				root: fixture.root,
				cwd: projectDir("writer-injection"),
				startupMode: "quick",
				responses: [
					fauxAssistantMessage("first answer"),
					fauxAssistantMessage("second answer"),
					fauxAssistantMessage("third answer"),
				],
			});
			await handle.prompt("first question");
			const before = handle.requests.at(-1);
			if (!before) throw new Error("the plain turn sent no request");
			new CacheManager(false).writeCache(
				"session-start-guidance",
				{ content: "INJECTED-GUIDANCE: keep the head stable" },
				handle.cwd,
			);
			await handle.prompt("second question");
			const injecting = handle.requests.at(-1);
			if (!injecting) throw new Error("the injecting turn sent no request");

			// The payload landed, and only the tail moved.
			expect(JSON.stringify(injecting.at(-1))).toContain("INJECTED-GUIDANCE");
			expect(JSON.stringify(injecting[0])).toBe(JSON.stringify(before[0]));
			expect(collapsedHead(injecting)).toBe(collapsedHead(before));

			const sessionId = handle.session.sessionManager.getSessionId();
			// The real session start already observed this id; start the replay from
			// the empty state the old whole-table reset gave (#4965: the production
			// per-session clear, which a session's shutdown runs).
			clearCachePrefixSession(sessionId);
			observeCachePrefix(before, 0, sessionId);
			logCollapseUsage(sessionId, { cacheRead: 0, input: 4_000 }, 0);
			observeCachePrefix(injecting, 1, sessionId);
			logCollapseUsage(sessionId, { cacheRead: 3_990, input: 20 }, 1);
			const verdicts = usageRows(await inProcessLatencyRows(), sessionId);
			expect(verdicts.map((row) => row.cacheMissCause)).toEqual([null, null]);
		} finally {
			if (previousTestMode === undefined) delete process.env.PI_LENS_TEST_MODE;
			else process.env.PI_LENS_TEST_MODE = previousTestMode;
		}
	});

	it("blocker repeat: the repeat rides the new prompt's tail and neither head moves (#5240)", async () => {
		// RECURRENCE GUARDED: #5240 adds a writer, the repeat of an unresolved
		// blocker at a later prompt's first request. A write before the newest
		// message would re-bill the whole conversation (shape #79).
		const { proj, target } = seed(fixture.root, "writer-repeat", CLEAN_FILE);
		const handle = await openGuardedSession(fixture.root, proj, [
			step(writeTarget(target, BLOCKING_FILE), "writing"),
			endTurn("first answer"),
			endTurn("second answer"),
		]);
		await handle.prompt("first question");
		const before = handle.requests.at(-1);
		await handle.prompt("second question");
		const repeating = handle.requests.at(-1);
		if (!before || !repeating)
			throw new Error("both prompts must send a request");

		const serialize = (messages: readonly unknown[]) =>
			messages.map((message) => JSON.stringify(message));
		const injected = (message: unknown) =>
			JSON.stringify(message).includes(AUTOMATION_FRAMING);
		// The payload landed on the new prompt, and only there.
		expect(JSON.stringify(repeating.at(-1))).toContain(
			"Still unresolved from an earlier turn",
		);
		expect(repeating.slice(0, -1).some(injected)).toBe(false);
		// Everything before it is what the previous request sent before ITS own
		// tail injection, byte for byte, and both heads agree.
		expect(serialize(repeating.slice(0, before.length - 1))).toEqual(
			serialize(before.slice(0, -1)),
		);
		expect(JSON.stringify(repeating[0])).toBe(JSON.stringify(before[0]));
		expect(collapsedHead(repeating)).toBe(collapsedHead(before));
		expect(handle.errors).toEqual([]);
	});

	it("reload after AGENTS.md changes names system-prompt-changed, not tool-set-changed", async () => {
		// `PI_LENS_TEST_MODE=0` makes the in-process logger write its real sink;
		// the same-function `finally` restores it (the accepted restore shape).
		const previousTestMode = process.env.PI_LENS_TEST_MODE;
		process.env.PI_LENS_TEST_MODE = "0";
		try {
			const cwd = projectDir("writer-system-prompt");
			fs.mkdirSync(cwd, { recursive: true });
			const handle = await startPiSession({
				root: fixture.root,
				cwd,
				startupMode: "quick",
				responses: [
					fauxAssistantMessage("first answer"),
					fauxAssistantMessage("second answer"),
				],
			});
			await handle.prompt("first question");
			const before = handle.requests.at(-1);
			if (!before) throw new Error("the pre-reload turn sent no request");
			// A reload is the host's own path that rebuilds the system prompt; an
			// AGENTS.md the session had not read joins the transcript as a system
			// message.
			fs.writeFileSync(
				`${cwd}/AGENTS.md`,
				"# Probe rules\n\nALWAYS-SAY-PROBE.\n",
			);
			await handle.restart({ reason: "reload" }, [
				fauxAssistantMessage("second answer"),
			]);
			await handle.prompt("second question");
			const after = handle.requests.at(-1);
			if (!after) throw new Error("the post-reload turn sent no request");

			expect(collapsedHead(after)).toContain("ALWAYS-SAY-PROBE");
			// The tool loadout is unchanged: the only movement is the prompt.
			expect(new Set(replayToolNames(after))).toEqual(
				new Set(replayToolNames(before)),
			);
			expect(JSON.stringify(after[0])).toBe(JSON.stringify(before[0]));

			const sessionId = handle.session.sessionManager.getSessionId();
			// The real session start already observed this id; start the replay from
			// the empty state the old whole-table reset gave (#4965: the production
			// per-session clear, which a session's shutdown runs).
			clearCachePrefixSession(sessionId);
			const prompts = [collapsedPrompt(before), collapsedPrompt(after)];
			observeCachePrefix(before, 0, sessionId);
			// The pre-reload turn is a HEALTHY cached read: the baseline a miss is
			// measured against must be a whole read, not a first-turn zero.
			logCollapseUsage(
				sessionId,
				{
					cacheRead: estimatedTokens(prompts[0]?.length ?? 0),
					input: 1,
				},
				0,
			);
			observeCachePrefix(after, 1, sessionId);
			logCollapseUsage(sessionId, collapseUsage(prompts, 1), 1);
			const verdicts = usageRows(await inProcessLatencyRows(), sessionId);
			expect(verdicts.map((row) => row.cacheMissCause)).toEqual([
				null,
				"system-prompt-changed",
			]);
		} finally {
			if (previousTestMode === undefined) delete process.env.PI_LENS_TEST_MODE;
			else process.env.PI_LENS_TEST_MODE = previousTestMode;
		}
	});
});

async function unexplainedLedgerRows(): Promise<
	Array<Record<string, unknown>>
> {
	const rows = await inProcessLatencyRows();
	return rows.filter((row) => {
		if (row.phase !== "degradation_ledger") return false;
		const metadata = row.metadata as Record<string, unknown> | undefined;
		return metadata?.kind === "prompt-cache-miss-unexplained";
	});
}

describe("#4687 unexplained-miss degradation row", () => {
	it("writes one row on the second unexplained miss and only counts later ones", async () => {
		// `PI_LENS_TEST_MODE=0` makes the in-process logger write its real sink;
		// the same-function `finally` restores it (the accepted restore shape).
		const previousTestMode = process.env.PI_LENS_TEST_MODE;
		process.env.PI_LENS_TEST_MODE = "0";
		try {
			resetCachePrefixObservation();
			resetDegradationLedger();
			const sessionId = "unexplained-miss";
			// Record 1 establishes a healthy baseline. Later records are unknown
			// misses: no request-time stamp, so the classifier fails correlation
			// closed instead of guessing a timing cause.
			logCollapseUsage(sessionId, { cacheRead: 8_000, input: 100 }, 0);

			// The FIRST unexplained miss counts silently: one provider-side gap is
			// noise, not a pattern, and the ledger must not render a warning for it
			// (#4718 review F2).
			logCollapseUsage(sessionId, { cacheRead: 0, input: 9_000 }, 1);
			expect(await unexplainedLedgerRows()).toHaveLength(0);
			expect(
				getDegradationSummary().some(
					(entry) => entry.kind === "prompt-cache-miss-unexplained",
				),
			).toBe(false);

			// The SECOND admits the row.
			logCollapseUsage(sessionId, { cacheRead: 0, input: 9_000 }, 2);
			const afterSecond = await unexplainedLedgerRows();
			expect(afterSecond).toHaveLength(1);
			expect(afterSecond[0]?.metadata).toMatchObject({
				kind: "prompt-cache-miss-unexplained",
				subject: sessionId,
				count: 1,
			});

			// The THIRD only raises the ledger count: no second row, and the count
			// starts at the row's own admission (#4718 review F2).
			logCollapseUsage(sessionId, { cacheRead: 0, input: 9_000 }, 3);
			expect(await unexplainedLedgerRows()).toHaveLength(1);
			const group = getDegradationSummary().find(
				(entry) => entry.kind === "prompt-cache-miss-unexplained",
			);
			expect(group?.count).toBe(2);
		} finally {
			if (previousTestMode === undefined) delete process.env.PI_LENS_TEST_MODE;
			else process.env.PI_LENS_TEST_MODE = previousTestMode;
		}
	});
});
