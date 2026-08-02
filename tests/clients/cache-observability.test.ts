import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LatencyEntry } from "../../clients/latency-logger.js";

const latencyEntries = vi.hoisted(() => [] as LatencyEntry[]);
vi.mock("../../clients/latency-logger.js", () => ({
	logLatency: (entry: LatencyEntry) => latencyEntries.push(entry),
}));

import {
	clearCachePrefixSession,
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
					cacheRead: 8000,
					cacheWrite: 512,
					input: 1200,
					output: 340,
					cost: 0.037,
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
			prefixObservation: "baseline",
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
				prefixObservation: "baseline",
				prefixBaseline: true,
				firstMessageChanged: false,
			},
		});
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
				injectionSources: [
					"session-guidance",
					"turn-findings",
					"test-findings",
					"agent-nudge",
				],
				injectedMessages: [{ role: "user", content: "injected" }],
				existingMessages: existing,
				resultMessages: result,
				placement,
				prefixObservation: "unchanged",
			});
			const metadata = latencyEntries[0].metadata;
			expect(metadata?.placement).toBe(placement);
			expect(metadata?.injectionSources).toEqual([
				"session-guidance",
				"turn-findings",
				"test-findings",
				"agent-nudge",
			]);
			expect(metadata?.injectedMessageCount).toBe(1);
			expect(metadata?.existingMessageCount).toBe(existing.length);
			expect(metadata?.resultMessageCount).toBe(result.length);
		},
	);

	it("distinguishes a prefix baseline from a later actual first-message change", () => {
		const first = { role: "user", content: "first" };
		const changed = { role: "user", content: "changed" };
		const baseline = observeCachePrefix([first], 0, "s");
		observeCacheContext({
			sessionId: "s",
			turnIndex: 0,
			injectionEnabled: false,
			existingMessages: [first],
			prefixObservation: baseline,
		});
		const actualChange = observeCachePrefix([changed], 1, "s");
		observeCacheContext({
			sessionId: "s",
			turnIndex: 1,
			injectionEnabled: false,
			existingMessages: [changed],
			prefixObservation: actualChange,
		});

		const observations = latencyEntries.filter(
			(entry) => entry.phase === "cache_context",
		);
		expect(observations[0].metadata).toMatchObject({
			prefixObservation: "baseline",
			prefixBaseline: true,
		});
		expect(observations[1].metadata).toMatchObject({
			prefixObservation: "changed",
			prefixBaseline: false,
			firstMessageChanged: false,
		});
		// The existing signal remains the provider-independent local change signal.
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
			injectionSources: ["turn-findings"],
			injectedMessages: [{ role: "user", content: privateText }],
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

	it("reports unknown rather than unchanged when the bounded first-message hash truncates a suffix", () => {
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
			prefixObservation: "unchanged",
		});

		const metadata = latencyEntries[0].metadata;
		expect(metadata).toMatchObject({
			observedStage: "pi-lens-context-handler",
			firstMessageChanged: null,
			firstMessageChange: "unknown",
			firstMessageHashTruncated: true,
			sequenceContentHashTruncated: true,
			prefixHashTruncated: true,
			prefixContentHashTruncated: true,
			prefixObservation: "unknown",
			prefixObservationUnknown: true,
			prefixBaseline: null,
		});
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
