import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LatencyEntry } from "../../clients/latency-logger.js";

const latencyEntries = vi.hoisted(() => [] as LatencyEntry[]);
vi.mock("../../clients/latency-logger.js", () => ({
	logLatency: (entry: LatencyEntry) => latencyEntries.push(entry),
}));

import {
	_resetProviderCacheTtlForTests,
	clearCachePrefixSession,
	DEFAULT_PROVIDER_CACHE_TTL_MS,
	emitCacheUsageSummaryAtSessionEnd,
	logCacheUsage,
	observeCacheContext,
	observeCachePrefix,
	resetCachePrefixObservation,
} from "../../clients/cache-observability.js";

function assistantMessage(overrides?: Record<string, unknown>) {
	return {
		role: "assistant",
		provider: "anthropic",
		model: "claude-opus-4",
		usage: {
			input: 1200,
			output: 340,
			cacheRead: 8000,
			cacheWrite: 512,
			totalTokens: 9540,
			cost: {
				input: 0.01,
				output: 0.02,
				cacheRead: 0.003,
				cacheWrite: 0.004,
				total: 0.037,
			},
		},
		stopReason: "stop",
		timestamp: 0,
		...overrides,
	};
}

describe("cache-observability — response-side usage (#1018)", () => {
	beforeEach(() => {
		latencyEntries.length = 0;
		// #1071 keeps per-session attribution state in the same module, so a test
		// that logs usage must not leak a gap baseline into the next one.
		resetCachePrefixObservation();
	});

	it("logs one cache_usage record for an assistant message that carries usage", () => {
		logCacheUsage(assistantMessage());

		expect(latencyEntries).toEqual([
			{
				type: "phase",
				filePath: "<pi-lens>",
				phase: "cache_usage",
				durationMs: 0,
				metadata: {
					provider: "anthropic",
					model: "claude-opus-4",
					providerIdentityHash: expect.stringMatching(/^[a-f0-9]{64}$/),
					modelIdentityHash: expect.stringMatching(/^[a-f0-9]{64}$/),
					providerIdentityStatus: "complete",
					modelIdentityStatus: "complete",
					providerIdentityTruncated: false,
					modelIdentityTruncated: false,
					cacheRead: 8000,
					cacheWrite: 512,
					input: 1200,
					output: 340,
					cost: 0.037,
					providerUsageMalformedFields: [],
					interTurnGapMs: null,
					gapBasis: "no-prior-turn",
					cacheMissCause: null,
					cacheMissKind: null,
					cacheMissUnknownReason: null,
					modelProviderChanged: false,
					cacheTtlThresholdMs: DEFAULT_PROVIDER_CACHE_TTL_MS,
					priorCacheRead: null,
					injectedCharsSinceLastTurn: 0,
					newTranscriptCharsSinceLastTurn: 0,
					attributionCharsCapped: false,
					injectedBytes: {
						sessionGuidance: 0,
						turnFindings: 0,
						testFindings: 0,
						agentNudge: 0,
						turnEndAdvisory: 0,
						other: 0,
					},
					injectedFindingsRepeated: 0,
				},
			},
		]);
	});

	it("logs nothing for an assistant message with no usage (does not throw)", () => {
		expect(() =>
			logCacheUsage(assistantMessage({ usage: undefined })),
		).not.toThrow();
		expect(latencyEntries).toHaveLength(0);
	});

	it("logs nothing for a non-assistant (tool_result / user) message", () => {
		logCacheUsage({
			role: "toolResult",
			toolName: "read",
			usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		});
		logCacheUsage({ role: "user", content: "hi" });
		expect(latencyEntries).toHaveLength(0);
	});

	it("never throws on malformed input", () => {
		expect(() => logCacheUsage(undefined)).not.toThrow();
		expect(() => logCacheUsage(null)).not.toThrow();
		expect(() => logCacheUsage("nope")).not.toThrow();
		expect(latencyEntries).toHaveLength(0);
	});
});

describe("cache-observability — context observations (#1018 follow-up)", () => {
	beforeEach(() => {
		latencyEntries.length = 0;
		resetCachePrefixObservation();
	});

	it("logs a no-injection observation with bounded structural metadata", () => {
		observeCacheContext({
			sessionId: "session-alpha",
			turnIndex: 3,
			injectionEnabled: false,
			existingMessages: [{ role: "user", content: "private prompt" }],
		});

		expect(latencyEntries).toHaveLength(1);
		expect(latencyEntries[0]).toMatchObject({
			phase: "cache_context",
			metadata: {
				version: 1,
				sessionId: "session-alpha",
				turnIndex: 3,
				injectionEnabled: false,
				injectionSources: [],
				injectedMessageCount: 0,
				injectedChars: 0,
				injectedBytes: 0,
				existingMessageCount: 1,
				resultMessageCount: 1,
				placement: "none",
			},
		});
		// #1938: the prefix/first-message pair was removed — it always reported
		// "unknown" past 64 messages. `cache_prefix_break` is the surviving
		// first-message stability signal.
		expect(latencyEntries[0].metadata).not.toHaveProperty("prefixObservation");
		expect(latencyEntries[0].metadata).not.toHaveProperty("firstMessageChange");
		expect(latencyEntries[0].metadata?.observationId).toMatch(/^ctx-/);
	});

	it.each([
		["prepend", [], [{ role: "user", content: "injected" }]],
		[
			"insert-before-final",
			[
				{ role: "user", content: "old" },
				{ role: "user", content: "prompt" },
			],
			[
				{ role: "user", content: "old" },
				{ role: "user", content: "injected" },
				{ role: "user", content: "prompt" },
			],
		],
		[
			"append",
			[
				{ role: "user", content: "old" },
				{ role: "toolResult", content: "result" },
			],
			[
				{ role: "user", content: "old" },
				{ role: "toolResult", content: "result" },
				{ role: "user", content: "injected" },
			],
		],
	] as const)(
		"records %s placement and source",
		(placement, existing, result) => {
			observeCacheContext({
				sessionId: "s",
				turnIndex: 1,
				injectionEnabled: true,
				injectionSlices: [
					{
						source: "session-guidance",
						messages: [{ role: "user", content: "injected" }],
					},
					{ source: "turn-findings", messages: [] },
					{ source: "test-findings", messages: [] },
					{ source: "agent-nudge", messages: [] },
				],
				existingMessages: existing,
				resultMessages: result,
				placement,
			});
			const metadata = latencyEntries[0].metadata;
			expect(metadata?.placement).toBe(placement);
			// Empty slices are not contributors: the derived source list names only
			// what actually produced a message (#1071).
			expect(metadata?.injectionSources).toEqual(["session-guidance"]);
			expect(metadata?.injectedMessageCount).toBe(1);
			expect(metadata?.existingMessageCount).toBe(existing.length);
			expect(metadata?.resultMessageCount).toBe(result.length);
		},
	);

	it("cache_prefix_break still distinguishes a baseline from a later first-message change (#1938: cache_context no longer echoes this)", () => {
		const first = { role: "user", content: "first" };
		const changed = { role: "user", content: "changed" };
		const baseline = observeCachePrefix([first], 0, "s");
		expect(baseline).toBe("baseline");
		observeCacheContext({
			sessionId: "s",
			turnIndex: 0,
			injectionEnabled: false,
			existingMessages: [first],
		});
		const actualChange = observeCachePrefix([changed], 1, "s");
		expect(actualChange).toBe("changed");
		observeCacheContext({
			sessionId: "s",
			turnIndex: 1,
			injectionEnabled: false,
			existingMessages: [changed],
		});

		// #1938: cache_context records no longer carry prefixObservation /
		// prefixBaseline — that pair reported "unknown" on 97% of real records.
		const observations = latencyEntries.filter(
			(entry) => entry.phase === "cache_context",
		);
		for (const observation of observations) {
			expect(observation.metadata).not.toHaveProperty("prefixObservation");
			expect(observation.metadata).not.toHaveProperty("prefixBaseline");
		}
		// The surviving signal is the provider-independent local change signal,
		// still emitted directly by observeCachePrefix.
		expect(
			latencyEntries.find(
				(entry) =>
					entry.phase === "cache_prefix_break" &&
					entry.metadata?.baseline === undefined,
			),
		).toBeDefined();
	});

	it("caps counts and hashes without writing prompt or finding contents", () => {
		const privateText = "DO_NOT_LOG_THIS_PROMPT_".repeat(20_000);
		observeCacheContext({
			sessionId: "s",
			turnIndex: 2,
			injectionEnabled: true,
			injectionSlices: [
				{
					source: "turn-findings",
					messages: [{ role: "user", content: privateText }],
				},
			],
			existingMessages: Array.from({ length: 70 }, (_, i) => ({
				role: "user",
				content: `m${i}`,
			})),
			resultMessages: [{ role: "user", content: privateText }],
			placement: "prepend",
		});

		const entry = latencyEntries[0];
		expect(entry.metadata?.injectedChars).toBe(16_384);
		expect(entry.metadata?.injectedBytes).toBeLessThanOrEqual(65_536);
		expect(entry.metadata?.injectedCountsCapped).toBe(true);
		expect(entry.metadata?.sequenceHashTruncated).toBe(true);
		expect(entry.metadata?.beforeSequenceHash).toMatch(/^[a-f0-9]{64}$/);
		expect(entry.metadata?.afterSequenceHash).toMatch(/^[a-f0-9]{64}$/);
		expect(JSON.stringify(entry.metadata)).not.toContain(
			"DO_NOT_LOG_THIS_PROMPT",
		);
	});

	it("still reports an honest sequenceHashTruncated flag for an oversized message, without an unknown prefixObservation/firstMessageChange pair (#1938)", () => {
		const existing = {
			role: "user",
			content: `${"a".repeat(2048)}-suffix-a`,
		};
		const changedSuffix = {
			role: "user",
			content: `${"a".repeat(2048)}-suffix-b`,
		};
		observeCacheContext({
			sessionId: "s",
			turnIndex: 5,
			injectionEnabled: false,
			existingMessages: [existing],
			resultMessages: [changedSuffix],
		});

		const metadata = latencyEntries[0].metadata as Record<string, unknown>;
		expect(metadata).toMatchObject({
			observedStage: "pi-lens-context-handler",
			sequenceContentHashTruncated: true,
		});
		// The removed pair must not resurface under any name.
		expect(metadata).not.toHaveProperty("firstMessageChanged");
		expect(metadata).not.toHaveProperty("firstMessageChange");
		expect(metadata).not.toHaveProperty("firstMessageHashTruncated");
		expect(metadata).not.toHaveProperty("beforeFirstMessageHash");
		expect(metadata).not.toHaveProperty("afterFirstMessageHash");
		expect(metadata).not.toHaveProperty("prefixHashTruncated");
		expect(metadata).not.toHaveProperty("prefixContentHashTruncated");
		expect(metadata).not.toHaveProperty("prefixMessageCountTruncated");
		expect(metadata).not.toHaveProperty("beforePrefixHash");
		expect(metadata).not.toHaveProperty("afterPrefixHash");
		expect(metadata).not.toHaveProperty("prefixObservation");
		expect(metadata).not.toHaveProperty("prefixObservationUnknown");
		expect(metadata).not.toHaveProperty("prefixBaseline");
	});

	it("does not force prefixObservation/firstMessageChange to unknown on a 200-message transcript (#1938)", () => {
		const existingMessages = Array.from({ length: 200 }, (_, i) => ({
			role: i % 2 === 0 ? "user" : "assistant",
			content: `message ${i}`,
		}));
		observeCacheContext({
			sessionId: "s",
			turnIndex: 100,
			injectionEnabled: false,
			existingMessages,
		});

		const metadata = latencyEntries[0].metadata as Record<string, unknown>;
		// Either the field reports a real value (never "unknown"), or it has been
		// removed from the record entirely — both satisfy the #1938 acceptance
		// criterion. What it must never do is silently report "unknown" just
		// because the transcript is long, which is what pre-fix code does past
		// MAX_HASHED_MESSAGES (64) messages. This repo's chosen fix removes the
		// field outright (see the module doc), so assert that directly too.
		if ("prefixObservation" in metadata) {
			expect(metadata.prefixObservation).not.toBe("unknown");
		}
		if ("firstMessageChange" in metadata) {
			expect(metadata.firstMessageChange).not.toBe("unknown");
		}
		expect(metadata).not.toHaveProperty("prefixObservation");
		expect(metadata).not.toHaveProperty("firstMessageChange");
	});

	it("marks a secondary context observation without a session-local turn", () => {
		observeCacheContext({
			sessionId: "secondary",
			sessionRole: "concurrent-secondary",
			turnIndex: 99,
			injectionEnabled: false,
			existingMessages: [{ role: "user", content: "private" }],
		});
		expect(latencyEntries[0].metadata).toMatchObject({
			observedStage: "pi-lens-context-handler",
			sessionRole: "concurrent-secondary",
			turnScope: "unavailable-concurrent-secondary",
		});
		expect(latencyEntries[0].metadata).not.toHaveProperty("turnIndex");
	});

	it("adds only session/turn correlation to cache usage when the host has no request id", () => {
		logCacheUsage(assistantMessage(), undefined, {
			sessionId: "s",
			turnIndex: 4,
		});
		expect(latencyEntries[0].metadata).toMatchObject({
			sessionId: "s",
			turnIndex: 4,
			turnScope: "process-global-runtime",
			contextCorrelation: "session-only-no-request-id",
		});
		expect(latencyEntries[0].metadata).not.toHaveProperty("requestId");
	});

	it("does not present the shared process turn as a secondary session turn", () => {
		logCacheUsage(assistantMessage(), undefined, {
			sessionId: "secondary",
			sessionRole: "concurrent-secondary",
			turnIndex: 99,
		});
		expect(latencyEntries[0].metadata).toMatchObject({
			sessionId: "secondary",
			turnScope: "unavailable-concurrent-secondary",
			contextCorrelation: "session-only-no-request-id",
		});
		expect(latencyEntries[0].metadata).not.toHaveProperty("turnIndex");
	});
});

describe("cache-observability — request-side prefix stability (#1018)", () => {
	beforeEach(() => {
		latencyEntries.length = 0;
		resetCachePrefixObservation();
	});

	const first = { role: "user", content: "the original first user turn" };
	const changed = { role: "user", content: "a DIFFERENT first user turn" };
	const SID = "session-alpha";

	it("logs a baseline on first observation, then a break when messages[0] changes", () => {
		observeCachePrefix(
			[first, { role: "assistant", content: "ok" }],
			0,
			SID,
			"primary",
		);
		expect(latencyEntries).toHaveLength(1);
		const baseline = latencyEntries[0];
		expect(baseline.phase).toBe("cache_prefix_break");
		expect(baseline.metadata?.baseline).toBe(true);
		expect(baseline.metadata?.previousHash).toBeNull();
		expect(baseline.metadata?.sessionId).toBe(SID);
		expect(baseline.metadata?.sessionRole).toBe("primary");
		const baselineHash = baseline.metadata?.currentHash as string;
		expect(typeof baselineHash).toBe("string");

		// messages[0] changed within the SAME session -> one break record.
		observeCachePrefix(
			[changed, { role: "assistant", content: "ok" }],
			1,
			SID,
			"primary",
		);
		expect(latencyEntries).toHaveLength(2);
		const brk = latencyEntries[1];
		expect(brk).toMatchObject({
			type: "phase",
			filePath: "<pi-lens>",
			phase: "cache_prefix_break",
			durationMs: 0,
		});
		expect(brk.metadata?.turnIndex).toBe(1);
		expect(brk.metadata?.previousHash).toBe(baselineHash);
		expect(brk.metadata?.currentHash).not.toBe(baselineHash);
		expect(brk.metadata?.baseline).toBeUndefined();
		expect(brk.metadata?.sessionId).toBe(SID);
	});

	it("logs NOTHING when messages[0] is identical across calls (same session)", () => {
		observeCachePrefix(
			[first, { role: "assistant", content: "turn 1" }],
			0,
			SID,
		);
		expect(latencyEntries).toHaveLength(1); // baseline only

		// Same messages[0] content, different later messages / turnIndex — no break.
		observeCachePrefix(
			[first, { role: "assistant", content: "turn 2 differs" }],
			1,
			SID,
		);
		observeCachePrefix(
			[{ role: "user", content: "the original first user turn" }],
			2,
			SID,
		);
		expect(latencyEntries).toHaveLength(1);
	});

	it("does NOT log a break when a DIFFERENT session id first appears (subagent/new)", () => {
		// Parent session establishes its baseline.
		observeCachePrefix([first], 0, "session-parent", "primary");
		expect(latencyEntries).toHaveLength(1);

		// A concurrent subagent (different id) with a DIFFERENT messages[0] must NOT
		// be compared against the parent — it gets its OWN baseline, no break.
		observeCachePrefix(
			[changed],
			0,
			"session-subagent",
			"concurrent-secondary",
		);
		expect(latencyEntries).toHaveLength(2);
		const sub = latencyEntries[1];
		expect(sub.metadata?.baseline).toBe(true);
		expect(sub.metadata?.previousHash).toBeNull();
		expect(sub.metadata?.sessionId).toBe("session-subagent");
		expect(sub.metadata?.sessionRole).toBe("concurrent-secondary");
		expect(latencyEntries.some((e) => e.metadata?.baseline === undefined)).toBe(
			false,
		); // no break record emitted for either session
	});

	it("keeps two concurrent sessions' baselines independent (no cross-contamination)", () => {
		observeCachePrefix([first], 0, "sid-A", "primary");
		observeCachePrefix([changed], 0, "sid-B", "concurrent-secondary");
		latencyEntries.length = 0;

		// Each session re-observing its OWN unchanged messages[0] => no break.
		observeCachePrefix([first], 1, "sid-A", "primary");
		observeCachePrefix([changed], 1, "sid-B", "concurrent-secondary");
		expect(latencyEntries).toHaveLength(0);
	});

	it("resume: same session id across rounds keeps the baseline and catches a real break", () => {
		observeCachePrefix([first], 0, "resumed-session");
		expect(latencyEntries).toHaveLength(1); // baseline

		// Simulate resume: SAME id observes again; unchanged => still no break.
		observeCachePrefix([first], 1, "resumed-session");
		expect(latencyEntries).toHaveLength(1);

		// A genuine post-resume change to messages[0] IS caught.
		observeCachePrefix([changed], 2, "resumed-session");
		expect(latencyEntries).toHaveLength(2);
		expect(latencyEntries[1].metadata?.baseline).toBeUndefined();
		expect(latencyEntries[1].metadata?.sessionId).toBe("resumed-session");
	});

	it("clearCachePrefixSession drops one session's baseline (re-baselines on next observe)", () => {
		observeCachePrefix([first], 0, "shutdown-session");
		expect(latencyEntries).toHaveLength(1);

		clearCachePrefixSession("shutdown-session");

		// After clearing, the next observation re-logs a baseline (not a break),
		// even with a changed messages[0].
		observeCachePrefix([changed], 1, "shutdown-session");
		expect(latencyEntries).toHaveLength(2);
		expect(latencyEntries[1].metadata?.baseline).toBe(true);
		expect(latencyEntries[1].metadata?.previousHash).toBeNull();
	});

	it("falls back to a single bucket when no session id is given", () => {
		observeCachePrefix([first], 0);
		expect(latencyEntries).toHaveLength(1);
		expect(latencyEntries[0].metadata?.sessionId).toBe("<no-session>");

		// Same fallback bucket, changed messages[0] => a break (old single-var semantics).
		observeCachePrefix([changed], 1);
		expect(latencyEntries).toHaveLength(2);
		expect(latencyEntries[1].metadata?.baseline).toBeUndefined();
		expect(latencyEntries[1].metadata?.sessionId).toBe("<no-session>");
	});

	it("LRU bound evicts oldest sessions past the cap without throwing", () => {
		// Cap is 32; establish 40 distinct sessions, then re-observe the OLDEST.
		for (let i = 0; i < 40; i++) {
			observeCachePrefix([{ role: "user", content: `s${i}` }], 0, `lru-${i}`);
		}
		expect(latencyEntries).toHaveLength(40); // 40 baselines
		latencyEntries.length = 0;

		// lru-0 was evicted; re-observing it re-baselines rather than diffing.
		expect(() =>
			observeCachePrefix([{ role: "user", content: "s0" }], 1, "lru-0"),
		).not.toThrow();
		expect(latencyEntries).toHaveLength(1);
		expect(latencyEntries[0].metadata?.baseline).toBe(true);
	});

	it("does nothing on an empty transcript and never throws", () => {
		expect(() => observeCachePrefix([], 0, SID)).not.toThrow();
		expect(() => observeCachePrefix(undefined, 0, SID)).not.toThrow();
		expect(latencyEntries).toHaveLength(0);
	});
});

describe("cache-observability — miss attribution (#1071)", () => {
	const BASE_MS = 1_700_000_000_000;

	function usageMessage(cacheRead: number, input: number) {
		return assistantMessage({
			usage: { input, output: 10, cacheRead, cacheWrite: 0 },
		});
	}

	function logUsage(cacheRead: number, input: number, sessionId = "attr") {
		logCacheUsage(usageMessage(cacheRead, input), undefined, {
			sessionId,
			turnIndex: 0,
		});
	}

	function lastUsageMetadata(): Record<string, unknown> {
		const usageEntries = latencyEntries.filter(
			(entry) => entry.phase === "cache_usage",
		);
		return (usageEntries[usageEntries.length - 1]?.metadata ?? {}) as Record<
			string,
			unknown
		>;
	}

	/**
	 * Fire a bare `context` observation. This is REQUEST time: the moment the
	 * provider looks the prompt cache up, and the endpoint the gap measures to.
	 */
	function observeRequest(sessionId = "attr") {
		observeCacheContext({
			sessionId,
			turnIndex: 0,
			injectionEnabled: false,
			existingMessages: [{ role: "user", content: "prompt" }],
		});
	}

	/** Feed one `context` observation so the ledger sees real injected content. */
	function observeInjection(chars: number, sessionId = "attr") {
		observeCacheContext({
			sessionId,
			turnIndex: 0,
			injectionEnabled: true,
			existingMessages: [{ role: "user", content: "prompt" }],
			resultMessages: [{ role: "user", content: "prompt" }],
			injectionSlices: [
				{
					source: "turn-findings",
					messages: [{ role: "user", content: "x".repeat(chars) }],
				},
			],
			placement: "insert-before-final",
		});
	}

	beforeEach(() => {
		latencyEntries.length = 0;
		resetCachePrefixObservation();
		_resetProviderCacheTtlForTests();
		delete process.env.PI_LENS_PROVIDER_CACHE_TTL_MS;
		vi.useFakeTimers();
		vi.setSystemTime(BASE_MS);
	});

	afterEach(() => {
		vi.useRealTimers();
		delete process.env.PI_LENS_PROVIDER_CACHE_TTL_MS;
		_resetProviderCacheTtlForTests();
	});

	it("returns no verdict for the first record in a session", () => {
		logUsage(0, 5_000);
		expect(lastUsageMetadata()).toMatchObject({
			interTurnGapMs: null,
			cacheMissCause: null,
			cacheMissKind: null,
			cacheMissUnknownReason: "no-prior-sample",
			priorCacheRead: null,
		});
	});

	it("measures the gap to request time, not to the message_end that follows", () => {
		logUsage(8_000, 100);
		vi.setSystemTime(BASE_MS + 4_000);
		observeRequest();
		// 5s of generation follows the request. It is not idle time.
		vi.setSystemTime(BASE_MS + 9_000);
		logUsage(8_100, 100);
		expect(lastUsageMetadata()).toMatchObject({
			interTurnGapMs: 4_000,
			gapBasis: "request-time",
			priorCacheRead: 8_000,
			cacheMissCause: null,
		});
	});

	it("does not read a short idle plus a long generation as ttl-expired", () => {
		// The reviewer's probe: 10s idle, then 70s of generation. The message-end
		// basis would measure 80s and fire ttl-expired; the request-time basis
		// measures the 10s that actually elapsed before the cache lookup.
		logUsage(8_000, 100);
		vi.setSystemTime(BASE_MS + 10_000);
		observeRequest();
		vi.setSystemTime(BASE_MS + 80_000);
		logUsage(0, 9_000);
		expect(lastUsageMetadata()).toMatchObject({
			interTurnGapMs: 10_000,
			gapBasis: "request-time",
			cacheMissCause: "unknown",
			cacheMissUnknownReason: "no-local-explanation",
		});
	});

	it("reports missing request correlation instead of inferring ttl from message-end time", () => {
		logUsage(8_000, 100);
		vi.setSystemTime(BASE_MS + 70_000);
		logUsage(0, 9_000);
		expect(lastUsageMetadata()).toMatchObject({
			interTurnGapMs: 70_000,
			gapBasis: "message-end-fallback",
			cacheMissCause: "unknown",
			cacheMissUnknownReason: "request-correlation-unavailable",
		});
	});

	it("clears the request stamp at each turn boundary", () => {
		logUsage(8_000, 100);
		vi.setSystemTime(BASE_MS + 1_000);
		observeRequest();
		vi.setSystemTime(BASE_MS + 2_000);
		logUsage(8_000, 100);
		expect(lastUsageMetadata()).toMatchObject({ gapBasis: "request-time" });
		// No context call this turn: the previous turn's stamp must not be reused.
		vi.setSystemTime(BASE_MS + 3_000);
		logUsage(8_000, 100);
		expect(lastUsageMetadata()).toMatchObject({
			gapBasis: "message-end-fallback",
			interTurnGapMs: 1_000,
		});
	});

	it("attributes a zero read after a long idle gap to ttl-expired", () => {
		logUsage(8_000, 100);
		vi.setSystemTime(BASE_MS + 166_000);
		observeRequest();
		vi.setSystemTime(BASE_MS + 170_000);
		logUsage(0, 9_000);
		expect(lastUsageMetadata()).toMatchObject({
			cacheMissCause: "ttl-expired",
			cacheMissKind: "zero-read",
			interTurnGapMs: 166_000,
			gapBasis: "request-time",
			cacheTtlThresholdMs: DEFAULT_PROVIDER_CACHE_TTL_MS,
		});
	});

	it("treats a request-time gap exactly at the threshold as expired and one below it as not", () => {
		logUsage(8_000, 100, "boundary-at");
		vi.setSystemTime(BASE_MS + DEFAULT_PROVIDER_CACHE_TTL_MS);
		observeRequest("boundary-at");
		vi.setSystemTime(BASE_MS + DEFAULT_PROVIDER_CACHE_TTL_MS + 3_000);
		logUsage(0, 9_000, "boundary-at");
		expect(lastUsageMetadata()).toMatchObject({
			cacheMissCause: "ttl-expired",
			gapBasis: "request-time",
			interTurnGapMs: DEFAULT_PROVIDER_CACHE_TTL_MS,
		});

		vi.setSystemTime(BASE_MS);
		logUsage(8_000, 100, "boundary-below");
		vi.setSystemTime(BASE_MS + DEFAULT_PROVIDER_CACHE_TTL_MS - 1);
		observeRequest("boundary-below");
		vi.setSystemTime(BASE_MS + DEFAULT_PROVIDER_CACHE_TTL_MS + 3_000);
		logUsage(0, 100, "boundary-below");
		expect(lastUsageMetadata()).toMatchObject({
			cacheMissCause: "unknown",
			gapBasis: "request-time",
			interTurnGapMs: DEFAULT_PROVIDER_CACHE_TTL_MS - 1,
		});
	});

	it("honors the configured threshold instead of the default", () => {
		process.env.PI_LENS_PROVIDER_CACHE_TTL_MS = "1000";
		_resetProviderCacheTtlForTests();
		logUsage(8_000, 100);
		vi.setSystemTime(BASE_MS + 2_000);
		observeRequest();
		vi.setSystemTime(BASE_MS + 2_500);
		logUsage(0, 9_000);
		expect(lastUsageMetadata()).toMatchObject({
			cacheMissCause: "ttl-expired",
			cacheTtlThresholdMs: 1_000,
		});
	});

	it("attributes a miss after a first-message change to prefix-broke", () => {
		logUsage(8_000, 100);
		observeCachePrefix([{ role: "user", content: "first" }], 0, "attr");
		observeCachePrefix([{ role: "user", content: "rewritten" }], 1, "attr");
		vi.setSystemTime(BASE_MS + 5_000);
		logUsage(0, 9_000);
		expect(lastUsageMetadata()).toMatchObject({
			cacheMissCause: "prefix-broke",
			cacheMissKind: "zero-read",
		});
	});

	it("attributes a shortfall across a provider or model switch", () => {
		logUsage(8_000, 100);
		observeRequest();
		logCacheUsage(usageMessage(0, 9_000), undefined, {
			sessionId: "attr",
			turnIndex: 1,
		});
		// Change the identity on the next request; the preceding zero remains a
		// normal same-provider observation and establishes the comparison point.
		observeRequest();
		logCacheUsage(
			assistantMessage({
				provider: "openai",
				model: "gpt-5",
				usage: { input: 9_000, output: 10, cacheRead: 0, cacheWrite: 0 },
			}),
			undefined,
			{ sessionId: "attr", turnIndex: 2 },
		);
		expect(lastUsageMetadata()).toMatchObject({
			cacheMissCause: "model-provider-changed",
			cacheMissKind: "zero-read",
			modelProviderChanged: true,
		});
	});

	it("keeps a directly observed model switch above truncated request evidence", () => {
		logUsage(8_000, 100);
		observeCacheContext({
			sessionId: "attr",
			turnIndex: 1,
			injectionEnabled: false,
			existingMessages: [{ role: "user", content: "x".repeat(3_000) }],
		});
		logCacheUsage(
			assistantMessage({
				provider: "openai",
				model: "gpt-5",
				usage: { input: 9_000, output: 10, cacheRead: 0, cacheWrite: 0 },
			}),
			undefined,
			{ sessionId: "attr", turnIndex: 1 },
		);
		expect(lastUsageMetadata()).toMatchObject({
			cacheMissCause: "model-provider-changed",
			cacheMissUnknownReason: null,
		});
	});

	it("fails closed when provider/model evidence is unavailable", () => {
		logUsage(8_000, 100);
		observeRequest();
		logCacheUsage(
			assistantMessage({
				provider: undefined,
				model: undefined,
				usage: { input: 9_000, output: 10, cacheRead: 0, cacheWrite: 0 },
			}),
			undefined,
			{ sessionId: "attr", turnIndex: 1 },
		);
		expect(lastUsageMetadata()).toMatchObject({
			cacheMissCause: "unknown",
			cacheMissUnknownReason: "model-provider-unavailable",
		});
	});

	it("does not infer ttl when provider/model identity is unavailable", () => {
		logUsage(8_000, 100);
		vi.setSystemTime(BASE_MS + DEFAULT_PROVIDER_CACHE_TTL_MS);
		observeRequest();
		logCacheUsage(
			assistantMessage({
				provider: undefined,
				model: undefined,
				usage: { input: 9_000, output: 10, cacheRead: 0, cacheWrite: 0 },
			}),
			undefined,
			{ sessionId: "attr", turnIndex: 1 },
		);
		expect(lastUsageMetadata()).toMatchObject({
			cacheMissCause: "unknown",
			cacheMissUnknownReason: "model-provider-unavailable",
		});
	});

	it("does not infer partial eviction when provider/model identity is unavailable", () => {
		logUsage(8_000, 100);
		observeInjection(200);
		logCacheUsage(
			assistantMessage({
				provider: undefined,
				model: undefined,
				usage: {
					input: 20_000,
					output: 10,
					cacheRead: 3_000,
					cacheWrite: 0,
				},
			}),
			undefined,
			{ sessionId: "attr", turnIndex: 1 },
		);
		expect(lastUsageMetadata()).toMatchObject({
			cacheMissCause: "unknown",
			cacheMissUnknownReason: "model-provider-unavailable",
		});
	});

	it("prefers the observed prefix break over the idle-gap heuristic", () => {
		logUsage(8_000, 100);
		observeCachePrefix([{ role: "user", content: "first" }], 0, "attr");
		observeCachePrefix([{ role: "user", content: "rewritten" }], 1, "attr");
		vi.setSystemTime(BASE_MS + 600_000);
		logUsage(0, 9_000);
		expect(lastUsageMetadata()).toMatchObject({
			cacheMissCause: "prefix-broke",
		});
	});

	it("keeps a direct prefix break above missing identity and truncated request evidence", () => {
		logUsage(8_000, 100);
		observeCachePrefix([{ role: "user", content: "first" }], 0, "attr");
		observeCachePrefix([{ role: "user", content: "rewritten" }], 1, "attr");
		observeCacheContext({
			sessionId: "attr",
			turnIndex: 1,
			injectionEnabled: false,
			existingMessages: [{ role: "user", content: "x".repeat(3_000) }],
		});
		logCacheUsage(
			assistantMessage({
				provider: undefined,
				model: undefined,
				usage: { input: 9_000, output: 10, cacheRead: 0, cacheWrite: 0 },
			}),
			undefined,
			{ sessionId: "attr", turnIndex: 1 },
		);
		expect(lastUsageMetadata()).toMatchObject({
			cacheMissCause: "prefix-broke",
			cacheMissUnknownReason: null,
		});
	});

	it("re-arms the prefix-break flag after each usage record", () => {
		logUsage(8_000, 100);
		observeCachePrefix([{ role: "user", content: "first" }], 0, "attr");
		observeCachePrefix([{ role: "user", content: "rewritten" }], 1, "attr");
		logUsage(0, 9_000);
		expect(lastUsageMetadata()).toMatchObject({
			cacheMissCause: "prefix-broke",
		});
		logUsage(0, 9_000);
		expect(lastUsageMetadata()).toMatchObject({ cacheMissCause: "unknown" });
	});

	it("attributes a low read with fresh input far above new content to partial-eviction", () => {
		logUsage(8_000, 100);
		observeInjection(200);
		vi.setSystemTime(BASE_MS + 1_000);
		logUsage(3_000, 20_000);
		expect(lastUsageMetadata()).toMatchObject({
			cacheMissCause: "partial-eviction",
			cacheMissKind: "low-read",
			priorCacheRead: 8_000,
			injectedCharsSinceLastTurn: 200,
			attributionCharsCapped: false,
		});
	});

	it("does not call it eviction when fresh input matches the new content", () => {
		logUsage(8_000, 100);
		observeInjection(8_000);
		vi.setSystemTime(BASE_MS + 1_000);
		logUsage(3_000, 900);
		expect(lastUsageMetadata()).toMatchObject({
			cacheMissCause: "unknown",
			cacheMissKind: "low-read",
			cacheMissUnknownReason: "no-local-explanation",
		});
	});

	it("does not manufacture partial eviction from non-finite provider input", () => {
		logUsage(8_000, 100);
		observeRequest();
		logCacheUsage(
			assistantMessage({
				usage: {
					input: Number.POSITIVE_INFINITY,
					output: 10,
					cacheRead: 3_000,
					cacheWrite: 0,
				},
			}),
			undefined,
			{ sessionId: "attr", turnIndex: 1 },
		);
		expect(lastUsageMetadata()).toMatchObject({
			cacheMissCause: "unknown",
			cacheMissKind: "low-read",
			cacheMissUnknownReason: "malformed-provider-usage",
			input: null,
			providerUsageMalformedFields: ["input"],
		});
	});

	it("distinguishes malformed cacheRead from an absent provider field", () => {
		logCacheUsage(
			assistantMessage({
				usage: {
					input: 100,
					output: 10,
					cacheRead: Number.NaN,
					cacheWrite: 0,
				},
			}),
			undefined,
			{ sessionId: "attr", turnIndex: 0 },
		);
		expect(lastUsageMetadata()).toMatchObject({
			cacheRead: null,
			cacheMissCause: null,
			cacheMissUnknownReason: "malformed-provider-usage",
			providerUsageMalformedFields: ["cacheRead"],
		});
		emitCacheUsageSummaryAtSessionEnd("attr", "primary");
		const summary = latencyEntries.find(
			(entry) => entry.phase === "cache_usage_summary",
		)?.metadata as Record<string, unknown>;
		expect(summary.unknownEvidenceReasons).toMatchObject({
			"malformed-provider-usage": 1,
		});
	});

	it("sanitizes every logged malformed numeric field with a fixed bounded field list", () => {
		logCacheUsage(
			assistantMessage({
				usage: {
					input: Number.POSITIVE_INFINITY,
					output: Number.NaN,
					cacheRead: -1,
					cacheWrite: Number.NEGATIVE_INFINITY,
					cost: { total: Number.NaN },
				},
			}),
			undefined,
			{ sessionId: "attr", turnIndex: 0 },
		);
		const metadata = lastUsageMetadata();
		expect(metadata).toMatchObject({
			input: null,
			output: null,
			cacheRead: null,
			cacheWrite: null,
			cost: null,
			cacheMissUnknownReason: "malformed-provider-usage",
			providerUsageMalformedFields: [
				"input",
				"output",
				"cacheRead",
				"cacheWrite",
				"cost.total",
			],
		});
		expect(JSON.stringify(metadata)).not.toMatch(/Infinity|NaN/);
	});

	it("distinguishes a provider-reported miss despite a stable local prefix", () => {
		logUsage(8_000, 100);
		observeCachePrefix([{ role: "user", content: "first" }], 0, "attr");
		observeRequest();
		logUsage(0, 9_000);
		expect(lastUsageMetadata()).toMatchObject({
			cacheMissCause: "unknown",
			cacheMissKind: "zero-read",
			cacheMissUnknownReason: "provider-reported-zero-stable-prefix",
		});
	});

	it("distinguishes a provider-reported low read despite a stable local prefix", () => {
		logUsage(8_000, 100);
		observeCachePrefix([{ role: "user", content: "first" }], 0, "attr");
		observeRequest();
		logUsage(3_000, 100);
		expect(lastUsageMetadata()).toMatchObject({
			cacheMissCause: "unknown",
			cacheMissKind: "low-read",
			cacheMissUnknownReason: "provider-reported-low-read-stable-prefix",
		});
	});

	it("does not claim stable-prefix evidence when the bounded sequence hash truncated", () => {
		logUsage(8_000, 100);
		observeCacheContext({
			sessionId: "attr",
			turnIndex: 1,
			injectionEnabled: false,
			existingMessages: [{ role: "user", content: "x".repeat(3_000) }],
		});
		logUsage(0, 9_000);
		expect(lastUsageMetadata()).toMatchObject({
			cacheMissCause: "unknown",
			cacheMissUnknownReason: "sequence-hash-truncated",
		});
	});

	it("does not infer ttl when request sequence evidence truncated", () => {
		logUsage(8_000, 100);
		vi.setSystemTime(BASE_MS + DEFAULT_PROVIDER_CACHE_TTL_MS);
		observeCacheContext({
			sessionId: "attr",
			turnIndex: 1,
			injectionEnabled: false,
			existingMessages: [{ role: "user", content: "x".repeat(3_000) }],
		});
		logUsage(0, 9_000);
		expect(lastUsageMetadata()).toMatchObject({
			cacheMissCause: "unknown",
			cacheMissUnknownReason: "sequence-hash-truncated",
		});
	});

	it("does not infer partial eviction when request sequence evidence truncated", () => {
		logUsage(8_000, 100);
		observeCacheContext({
			sessionId: "attr",
			turnIndex: 1,
			injectionEnabled: false,
			existingMessages: [{ role: "user", content: "x".repeat(3_000) }],
		});
		logUsage(3_000, 20_000);
		expect(lastUsageMetadata()).toMatchObject({
			cacheMissCause: "unknown",
			cacheMissUnknownReason: "sequence-hash-truncated",
		});
	});

	const incompleteContextCases = [
		[
			"cyclic content",
			() => {
				const value: Record<string, unknown> = {};
				value.self = value;
				return value;
			},
		],
		[
			"a throwing enumerable getter",
			() => {
				const value: Record<string, unknown> = {};
				Object.defineProperty(value, "secret", {
					enumerable: true,
					get: () => {
						throw new Error("unreadable");
					},
				});
				return value;
			},
		],
		[
			"an unreadable proxy",
			() =>
				new Proxy(
					{},
					{
						ownKeys: () => {
							throw new Error("unreadable");
						},
					},
				),
		],
	] as const;

	it.each(incompleteContextCases)(
		"fails ttl closed when context hashing sees %s",
		(_label, make) => {
			logUsage(8_000, 100);
			vi.setSystemTime(BASE_MS + DEFAULT_PROVIDER_CACHE_TTL_MS);
			observeCacheContext({
				sessionId: "attr",
				turnIndex: 1,
				injectionEnabled: false,
				existingMessages: [{ role: "user", content: make() }],
			});
			const contextMetadata = [...latencyEntries]
				.reverse()
				.find((entry) => entry.phase === "cache_context")?.metadata;
			expect(contextMetadata?.sequenceHashIncomplete).toBe(true);
			logUsage(0, 9_000);
			expect(lastUsageMetadata()).toMatchObject({
				cacheMissCause: "unknown",
				cacheMissUnknownReason: "request-evidence-incomplete",
			});
		},
	);

	it.each(incompleteContextCases)(
		"fails partial eviction closed when context hashing sees %s",
		(_label, make) => {
			logUsage(8_000, 100);
			observeCacheContext({
				sessionId: "attr",
				turnIndex: 1,
				injectionEnabled: false,
				existingMessages: [{ role: "user", content: make() }],
			});
			const contextMetadata = [...latencyEntries]
				.reverse()
				.find((entry) => entry.phase === "cache_context")?.metadata;
			expect(contextMetadata?.sequenceHashIncomplete).toBe(true);
			logUsage(3_000, 20_000);
			expect(lastUsageMetadata()).toMatchObject({
				cacheMissCause: "unknown",
				cacheMissUnknownReason: "request-evidence-incomplete",
			});
		},
	);

	it.each(["provider", "model"] as const)(
		"compares the full %s identity when values differ only after the log cap",
		(field) => {
			const shared = "x".repeat(200);
			const firstIdentity = `${shared}PRIVATE_SUFFIX_A`;
			const secondIdentity = `${shared}PRIVATE_SUFFIX_B`;
			logCacheUsage(
				assistantMessage({
					[field]: firstIdentity,
					usage: { input: 100, output: 10, cacheRead: 8_000, cacheWrite: 0 },
				}),
				undefined,
				{ sessionId: "attr", turnIndex: 0 },
			);
			const first = lastUsageMetadata();
			observeRequest();
			logCacheUsage(
				assistantMessage({
					[field]: secondIdentity,
					usage: { input: 9_000, output: 10, cacheRead: 0, cacheWrite: 0 },
				}),
				undefined,
				{ sessionId: "attr", turnIndex: 1 },
			);
			const second = lastUsageMetadata();
			expect(second).toMatchObject({
				cacheMissCause: "model-provider-changed",
				[`${field}IdentityTruncated`]: true,
			});
			expect(second[field]).toBe(shared);
			expect(second[`${field}IdentityHash`]).toMatch(/^[a-f0-9]{64}$/);
			expect(second[`${field}IdentityHash`]).not.toBe(
				first[`${field}IdentityHash`],
			);
			expect(JSON.stringify(second)).not.toContain("PRIVATE_SUFFIX_B");
		},
	);

	it("separates missing-id primary and secondary buckets and fails correlation closed", () => {
		logCacheUsage(usageMessage(8_000, 100), undefined, {
			sessionRole: "primary",
			turnIndex: 0,
		});
		observeCacheContext({
			sessionRole: "primary",
			turnIndex: 1,
			injectionEnabled: false,
			existingMessages: [{ role: "user", content: "prompt" }],
		});
		logCacheUsage(usageMessage(0, 9_000), undefined, {
			sessionRole: "primary",
			turnIndex: 1,
		});
		expect(lastUsageMetadata()).toMatchObject({
			priorCacheRead: 8_000,
			cacheMissCause: "unknown",
			cacheMissUnknownReason: "request-correlation-unavailable",
		});

		logCacheUsage(usageMessage(0, 9_000), undefined, {
			sessionRole: "concurrent-secondary",
		});
		expect(lastUsageMetadata()).toMatchObject({
			priorCacheRead: null,
			cacheMissCause: null,
			cacheMissUnknownReason: "no-prior-sample",
			turnScope: "unavailable-concurrent-secondary",
		});

		emitCacheUsageSummaryAtSessionEnd(undefined, "primary");
		emitCacheUsageSummaryAtSessionEnd(undefined, "concurrent-secondary");
		const summaries = latencyEntries
			.filter((entry) => entry.phase === "cache_usage_summary")
			.map((entry) => entry.metadata);
		expect(summaries).toEqual([
			expect.objectContaining({ sessionRole: "primary", usageRecords: 2 }),
			expect.objectContaining({
				sessionRole: "concurrent-secondary",
				usageRecords: 1,
			}),
		]);
	});

	it("suppresses the eviction verdict when the char accumulators were capped", () => {
		logUsage(8_000, 100);
		observeInjection(40_000);
		vi.setSystemTime(BASE_MS + 1_000);
		logUsage(3_000, 900_000);
		expect(lastUsageMetadata()).toMatchObject({
			cacheMissCause: "unknown",
			cacheMissKind: "low-read",
			attributionCharsCapped: true,
		});
	});

	it("keeps partial-eviction reachable when a large complete tool-result batch lands", () => {
		// #1071 review round 1, F2: transcript growth used to run through the
		// 16 KiB injection cap, so a routine 20,000-char tool-result batch latched
		// attributionCharsCapped and suppressed the verdict. Split it into bounded
		// messages here so #1996's independent sequence-completeness gate is open.
		logUsage(8_000, 100);
		observeCacheContext({
			sessionId: "attr",
			turnIndex: 0,
			injectionEnabled: true,
			existingMessages: [{ role: "user", content: "prompt" }],
		});
		observeCacheContext({
			sessionId: "attr",
			turnIndex: 1,
			injectionEnabled: true,
			existingMessages: [
				{ role: "user", content: "prompt" },
				...Array.from({ length: 10 }, () => ({
					role: "toolResult",
					content: "t".repeat(2_000),
				})),
			],
			injectionSlices: [
				{
					source: "turn-findings",
					messages: [{ role: "user", content: "f".repeat(200) }],
				},
			],
			placement: "insert-before-final",
		});
		vi.setSystemTime(BASE_MS + 1_000);
		logUsage(3_000, 30_000);
		expect(lastUsageMetadata()).toMatchObject({
			cacheMissCause: "partial-eviction",
			cacheMissKind: "low-read",
			newTranscriptCharsSinceLastTurn: 20_000,
			injectedCharsSinceLastTurn: 200,
			attributionCharsCapped: false,
		});
	});

	it("drops the baseline when a usage record carries no readable cacheRead", () => {
		// The gap would be one turn long while the baseline was two turns old, so
		// the stored baseline is cleared rather than carried (#1071 review, F4).
		logUsage(8_000, 100);
		logCacheUsage(
			assistantMessage({ usage: { input: 100, output: 10, cacheWrite: 0 } }),
			undefined,
			{ sessionId: "attr", turnIndex: 0 },
		);
		expect(lastUsageMetadata()).toMatchObject({
			priorCacheRead: 8_000,
			cacheMissUnknownReason: "cache-read-unavailable",
		});
		vi.setSystemTime(BASE_MS + 600_000);
		logUsage(0, 9_000);
		expect(lastUsageMetadata()).toMatchObject({
			priorCacheRead: null,
			cacheMissCause: null,
			cacheMissKind: null,
			cacheMissUnknownReason: "no-prior-sample",
		});
	});

	it("reports no verdict for a healthy read", () => {
		logUsage(8_000, 100);
		vi.setSystemTime(BASE_MS + 600_000);
		logUsage(7_000, 100);
		expect(lastUsageMetadata()).toMatchObject({
			cacheMissCause: null,
			cacheMissKind: null,
		});
	});

	it("resets the per-turn char accumulators at each usage record", () => {
		logUsage(8_000, 100);
		observeInjection(200);
		logUsage(8_000, 100);
		expect(lastUsageMetadata()).toMatchObject({
			injectedCharsSinceLastTurn: 200,
		});
		logUsage(8_000, 100);
		expect(lastUsageMetadata()).toMatchObject({
			injectedCharsSinceLastTurn: 0,
			newTranscriptCharsSinceLastTurn: 0,
		});
	});

	it("counts transcript growth between context observations", () => {
		logUsage(8_000, 100);
		observeCacheContext({
			sessionId: "attr",
			turnIndex: 0,
			injectionEnabled: false,
			existingMessages: [{ role: "user", content: "1234" }],
		});
		observeCacheContext({
			sessionId: "attr",
			turnIndex: 1,
			injectionEnabled: false,
			existingMessages: [
				{ role: "user", content: "1234" },
				{ role: "user", content: "567890" },
			],
		});
		logUsage(8_000, 100);
		expect(lastUsageMetadata()).toMatchObject({
			newTranscriptCharsSinceLastTurn: 6,
		});
	});

	it("keeps attribution state per session", () => {
		logUsage(8_000, 100, "session-a");
		vi.setSystemTime(BASE_MS + 600_000);
		logUsage(0, 9_000, "session-b");
		expect(lastUsageMetadata()).toMatchObject({
			sessionId: "session-b",
			interTurnGapMs: null,
			cacheMissCause: null,
		});
	});

	it("drops attribution state when a session shuts down", () => {
		logUsage(8_000, 100);
		clearCachePrefixSession("attr");
		vi.setSystemTime(BASE_MS + 600_000);
		logUsage(0, 9_000);
		expect(lastUsageMetadata()).toMatchObject({
			interTurnGapMs: null,
			cacheMissCause: null,
			priorCacheRead: null,
		});
	});

	it("emits one bounded fixed-key summary and retires the session state", () => {
		logUsage(8_000, 100, "summary");
		vi.setSystemTime(BASE_MS + DEFAULT_PROVIDER_CACHE_TTL_MS);
		observeRequest("summary");
		logUsage(0, 9_000, "summary");
		observeCachePrefix([{ role: "user", content: "first" }], 2, "summary");
		observeRequest("summary");
		logUsage(0, 9_000, "summary");

		emitCacheUsageSummaryAtSessionEnd("summary", "primary");
		const summaryEntries = latencyEntries.filter(
			(entry) => entry.phase === "cache_usage_summary",
		);
		expect(summaryEntries).toHaveLength(1);
		expect(summaryEntries[0]?.metadata).toEqual({
			version: 1,
			sessionId: "summary",
			sessionRole: "primary",
			usageRecords: 3,
			cacheHits: 1,
			missObservations: 2,
			cacheMissCauses: {
				"ttl-expired": 1,
				"prefix-broke": 0,
				"partial-eviction": 0,
				"model-provider-changed": 0,
				unknown: 1,
			},
			unknownEvidenceReasons: {
				"no-prior-sample": 0,
				"cache-read-unavailable": 0,
				"malformed-provider-usage": 0,
				"request-correlation-unavailable": 0,
				"request-evidence-incomplete": 0,
				"sequence-hash-truncated": 0,
				"model-provider-unavailable": 0,
				"provider-reported-zero-stable-prefix": 1,
				"provider-reported-low-read-stable-prefix": 0,
				"no-local-explanation": 0,
			},
		});
		expect(JSON.stringify(summaryEntries[0]?.metadata)).not.toContain("first");

		emitCacheUsageSummaryAtSessionEnd("summary", "primary");
		expect(
			latencyEntries.filter((entry) => entry.phase === "cache_usage_summary"),
		).toHaveLength(1);
	});
});

describe("cache-observability — per-source injection attribution (#1071)", () => {
	beforeEach(() => {
		latencyEntries.length = 0;
		resetCachePrefixObservation();
	});

	it("splits a mixed payload by contributing source", () => {
		observeCacheContext({
			sessionId: "mixed",
			turnIndex: 1,
			injectionEnabled: true,
			existingMessages: [{ role: "user", content: "prompt" }],
			resultMessages: [{ role: "user", content: "prompt" }],
			injectionSlices: [
				{
					source: "turn-findings",
					messages: [{ role: "user", content: "12345678" }],
				},
				{
					source: "agent-nudge",
					messages: [
						{ role: "user", content: "abc" },
						{ role: "user", content: "de" },
					],
				},
			],
			placement: "insert-before-final",
		});

		const metadata = latencyEntries[0].metadata as Record<string, unknown>;
		expect(metadata.injectionSourceBreakdown).toEqual([
			{
				source: "turn-findings",
				messageCount: 1,
				chars: 8,
				bytes: 8,
				estimatedTokens: 2,
				countsCapped: false,
			},
			{
				source: "agent-nudge",
				messageCount: 2,
				chars: 5,
				bytes: 5,
				estimatedTokens: 2,
				countsCapped: false,
			},
		]);
		expect(metadata.injectionSources).toEqual(["turn-findings", "agent-nudge"]);
		expect(metadata.injectedChars).toBe(13);
		expect(metadata.injectedEstimatedTokens).toBe(4);
		expect(metadata.injectionOccurred).toBe(true);
	});

	it("labels the token figure as an estimate, never as provider usage", () => {
		observeCacheContext({
			sessionId: "mixed",
			turnIndex: 1,
			injectionEnabled: true,
			injectionSlices: [
				{
					source: "test-findings",
					messages: [{ role: "user", content: "ab" }],
				},
			],
		});
		expect(latencyEntries[0].metadata?.injectedTokenBasis).toBe(
			"chars-per-token-4-estimate-not-provider-measured",
		);
	});

	it("reports no injection and no sources for an empty payload", () => {
		observeCacheContext({
			sessionId: "mixed",
			turnIndex: 2,
			injectionEnabled: true,
			injectionSlices: [{ source: "turn-findings", messages: [] }],
		});
		const metadata = latencyEntries[0].metadata as Record<string, unknown>;
		expect(metadata.injectionOccurred).toBe(false);
		expect(metadata.injectionSources).toEqual([]);
		expect(metadata.injectionSourceBreakdown).toEqual([]);
	});

	it("keeps the per-source split free of injected content", () => {
		observeCacheContext({
			sessionId: "mixed",
			turnIndex: 3,
			injectionEnabled: true,
			injectionSlices: [
				{
					source: "turn-findings",
					messages: [{ role: "user", content: "SECRET_FINDING_TEXT" }],
				},
			],
		});
		expect(JSON.stringify(latencyEntries[0].metadata)).not.toContain(
			"SECRET_FINDING_TEXT",
		);
	});

	it("carries UTF-8 bytes and repeated findings onto the existing turn row", () => {
		const finding = "src/例.ts:7 no-unused-vars";
		const sources = [
			["session-guidance", "src/guidance.ts:1 guidance-rule"],
			["turn-findings", finding],
			["test-findings", "tests/a.py:2 rule=E501"],
			["agent-nudge", "src/nudge.go:3 nudge-rule"],
		] as const;
		for (const [source, content] of sources) {
			observeCacheContext({
				sessionId: "bytes",
				turnIndex: 1,
				injectionEnabled: true,
				injectionSlices: [{ source, messages: [{ role: "user", content }] }],
			});
		}
		logCacheUsage(assistantMessage(), undefined, { sessionId: "bytes" });
		const first = latencyEntries.find((entry) => entry.phase === "cache_usage");
		expect(first?.metadata?.injectedBytes).toEqual({
			sessionGuidance: Buffer.byteLength("src/guidance.ts:1 guidance-rule"),
			turnFindings: Buffer.byteLength(finding),
			testFindings: Buffer.byteLength("tests/a.py:2 rule=E501"),
			agentNudge: Buffer.byteLength("src/nudge.go:3 nudge-rule"),
			turnEndAdvisory: 0,
			other: 0,
		});
		expect(first?.metadata?.injectedFindingsRepeated).toBe(0);

		observeCacheContext({
			sessionId: "bytes",
			turnIndex: 2,
			injectionEnabled: true,
			injectionSlices: [
				{
					source: "turn-findings",
					messages: [{ role: "user", content: finding }],
				},
			],
		});
		logCacheUsage(assistantMessage(), undefined, { sessionId: "bytes" });
		const second = latencyEntries.filter(
			(entry) => entry.phase === "cache_usage",
		)[1];
		expect(second?.metadata?.injectedFindingsRepeated).toBe(1);
	});

	it("writes zero source bytes when context injection is disabled", () => {
		observeCacheContext({
			sessionId: "disabled",
			turnIndex: 1,
			injectionEnabled: false,
		});
		logCacheUsage(assistantMessage(), undefined, { sessionId: "disabled" });
		expect(
			latencyEntries.find((entry) => entry.phase === "cache_usage")?.metadata,
		).toMatchObject({
			injectedBytes: {
				sessionGuidance: 0,
				turnFindings: 0,
				testFindings: 0,
				agentNudge: 0,
				turnEndAdvisory: 0,
				other: 0,
			},
			injectedFindingsRepeated: 0,
		});
	});
});
