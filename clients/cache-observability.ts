/**
 * Prompt-cache observability (#1018).
 *
 * Two provider-independent signals, both sinking into ~/.pi-lens/latency.log
 * via {@link logLatency} (matching the neighboring `type: "phase"` records):
 *
 *   1. Response-side cache usage (`cache_usage`) — on each assistant
 *      `message_end`, record the provider-reported token/cost breakdown so a
 *      session's actual cacheRead/cacheWrite behavior is queryable after the
 *      fact. This is what the provider DID, not what we hoped it would do.
 *
 *   2. Request-side context observations (`cache_context`) — one bounded record
 *      for every `context` call, describing local before/after message counts,
 *      placement, injection sources, and privacy-preserving hashes. This is what
 *      pi-lens changed locally, not a provider cache result.
 *
 *   3. Request-side prefix stability (`cache_prefix_break`) — a content hash of
 *      `messages[0]` observed on every `context` call. After #1016 the first
 *      message must stay byte-stable across a whole session; a logged CHANGE
 *      flags that something (pi-lens or otherwise) broke the cache prefix. This
 *      remains a local observation, never a provider cache-miss claim.
 *
 * All paths are defensive: `usage` (and its fields) may be absent on older
 * hosts or non-assistant messages, so every access is guarded and the handlers
 * never throw — on error they `dbg(...)` and no-op, like the other index.ts
 * event handlers.
 */
import { createHash } from "node:crypto";
import { logLatency } from "./latency-logger.js";

/** Shape we defensively read off an assistant `AgentMessage` (see pi-ai types). */
interface AssistantUsageLike {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cacheWrite1h?: number;
	reasoning?: number;
	totalTokens?: number;
	cost?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		total?: number;
	};
}

interface AssistantMessageLike {
	role?: unknown;
	provider?: unknown;
	model?: unknown;
	responseModel?: unknown;
	usage?: unknown;
}

export type CacheContextInjectionSource =
	| "session-guidance"
	| "turn-findings"
	| "test-findings"
	| "agent-nudge";
export type CacheContextPlacement =
	| "prepend"
	| "insert-before-final"
	| "append"
	| "none";
export type CachePrefixObservation =
	| "baseline"
	| "unchanged"
	| "changed"
	| "empty";

type ContextMessageLike = { role?: unknown; content?: unknown };

interface CacheUsageContext {
	sessionId?: string;
	turnIndex?: number;
}

/**
 * Keep context telemetry bounded even when a tool result or user message is
 * unexpectedly large. This is a hash input only; none of the sampled text is
 * written to the log.
 */
const MAX_HASHED_MESSAGES = 64;
const MAX_HASHED_CONTENT_CHARS = 2048;
const MAX_REPORTED_MESSAGES = 10_000;
const MAX_INJECTED_CHARS = 16_384;
const MAX_INJECTED_BYTES = 65_536;
let contextObservationCounter = 0;

function boundedHashValue(
	value: unknown,
	depth = 0,
	seen = new Set<object>(),
): string {
	if (value === null) return "null";
	if (value === undefined) return "undefined";
	if (typeof value === "string") {
		return `string:${value.length}:${value.slice(0, MAX_HASHED_CONTENT_CHARS)}`;
	}
	if (
		typeof value === "number" ||
		typeof value === "boolean" ||
		typeof value === "bigint"
	) {
		return `${typeof value}:${String(value)}`;
	}
	if (typeof value === "function" || typeof value === "symbol") {
		return typeof value;
	}
	if (depth >= 3) return Object.prototype.toString.call(value);
	if (typeof value !== "object") return typeof value;
	if (seen.has(value)) return "[cycle]";
	seen.add(value);
	try {
		if (Array.isArray(value)) {
			const items = value
				.slice(0, 12)
				.map((item) => boundedHashValue(item, depth + 1, seen));
			return `array:${value.length}:[${items.join(",")}]`;
		}
		const keys = Object.keys(value).sort();
		const fields = keys
			.slice(0, 24)
			.map(
				(key) =>
					`${key}:${boundedHashValue((value as Record<string, unknown>)[key], depth + 1, seen)}`,
			);
		return `object:${keys.length}:{${fields.join(",")}}`;
	} catch {
		return "[unreadable]";
	} finally {
		seen.delete(value);
	}
}

function hashMessageSequence(messages: ReadonlyArray<ContextMessageLike>): {
	hash: string;
	truncated: boolean;
} {
	const hash = createHash("sha256");
	hash.update(`message-count:${messages.length};`);
	const sampled = Math.min(messages.length, MAX_HASHED_MESSAGES);
	for (let i = 0; i < sampled; i++) {
		const message = messages[i];
		hash.update(
			`${i}|role:${boundedHashValue(message?.role)}|content:${boundedHashValue(message?.content)};`,
		);
	}
	const truncated = messages.length > sampled;
	if (truncated) hash.update(`truncated-after:${sampled};`);
	return { hash: hash.digest("hex"), truncated };
}

function messageTextSize(content: unknown): { chars: number; bytes: number } {
	if (typeof content === "string") {
		const chars = Math.min(content.length, MAX_INJECTED_CHARS);
		return {
			chars,
			bytes: Math.min(
				Buffer.byteLength(content.slice(0, chars), "utf8"),
				MAX_INJECTED_BYTES,
			),
		};
	}
	const bounded = boundedHashValue(content);
	return {
		chars: Math.min(bounded.length, MAX_INJECTED_CHARS),
		bytes: Math.min(
			Buffer.byteLength(bounded.slice(0, MAX_INJECTED_CHARS), "utf8"),
			MAX_INJECTED_BYTES,
		),
	};
}

function measureInjectedMessages(messages: ReadonlyArray<ContextMessageLike>): {
	chars: number;
	bytes: number;
	capped: boolean;
} {
	let chars = 0;
	let bytes = 0;
	for (const message of messages) {
		const size = messageTextSize(message?.content);
		chars = Math.min(MAX_INJECTED_CHARS, chars + size.chars);
		bytes = Math.min(MAX_INJECTED_BYTES, bytes + size.bytes);
		if (chars === MAX_INJECTED_CHARS || bytes === MAX_INJECTED_BYTES) break;
	}
	return {
		chars,
		bytes,
		capped: chars >= MAX_INJECTED_CHARS || bytes >= MAX_INJECTED_BYTES,
	};
}

function sessionKey(sessionId?: string): string {
	return sessionId?.trim() ? sessionId.trim() : NO_SESSION_KEY;
}

/**
 * Log one bounded request-side observation for every `context` call. This is
 * deliberately a separate phase from `cache_prefix_break`: it describes what
 * pi-lens saw and returned locally, not whether a provider reused or missed a
 * prompt cache. `observationId` is local to this process; the host currently
 * exposes no request id on ContextEvent/MessageEndEvent, so response records
 * are correlated by session and turn only when those are available.
 */
export function observeCacheContext(args: {
	existingMessages?: ReadonlyArray<ContextMessageLike>;
	resultMessages?: ReadonlyArray<ContextMessageLike>;
	sessionId?: string;
	sessionRole?: "primary" | "concurrent-secondary";
	turnIndex: number;
	injectionEnabled: boolean;
	injectionSources?: ReadonlyArray<CacheContextInjectionSource>;
	injectedMessages?: ReadonlyArray<ContextMessageLike>;
	placement?: CacheContextPlacement;
	prefixObservation?: CachePrefixObservation;
	dbg?: (msg: string) => void;
}): void {
	try {
		const existingMessages = args.existingMessages ?? [];
		const resultMessages = args.resultMessages ?? existingMessages;
		const injectedMessages = args.injectedMessages ?? [];
		const placement = args.placement ?? "none";
		const beforeSequence = hashMessageSequence(existingMessages);
		const afterSequence = hashMessageSequence(resultMessages);
		const beforePrefixLength =
			placement === "insert-before-final"
				? Math.max(0, existingMessages.length - 1)
				: placement === "prepend"
					? 0
					: existingMessages.length;
		const afterPrefixLength = Math.min(
			beforePrefixLength,
			resultMessages.length,
		);
		const beforePrefix = hashMessageSequence(
			existingMessages.slice(0, beforePrefixLength),
		);
		const afterPrefix = hashMessageSequence(
			resultMessages.slice(0, afterPrefixLength),
		);
		const beforeFirst = existingMessages.length
			? hashMessageSequence([existingMessages[0]]).hash
			: null;
		const afterFirst = resultMessages.length
			? hashMessageSequence([resultMessages[0]]).hash
			: null;
		const prefixObservation = args.prefixObservation ?? "empty";
		const sizes = measureInjectedMessages(injectedMessages);
		const messageCountCapped =
			existingMessages.length > MAX_REPORTED_MESSAGES ||
			resultMessages.length > MAX_REPORTED_MESSAGES;

		logLatency({
			type: "phase",
			filePath: "<pi-lens>",
			phase: "cache_context",
			durationMs: 0,
			metadata: {
				version: 1,
				observationId: `ctx-${(++contextObservationCounter).toString(36)}`,
				sessionId: sessionKey(args.sessionId),
				sessionRole: args.sessionRole,
				turnIndex: args.turnIndex,
				injectionEnabled: args.injectionEnabled,
				injectionSources: Array.from(args.injectionSources ?? []),
				injectedMessageCount: Math.min(
					injectedMessages.length,
					MAX_REPORTED_MESSAGES,
				),
				injectedMessageCountCapped:
					injectedMessages.length > MAX_REPORTED_MESSAGES,
				injectedChars: sizes.chars,
				injectedBytes: sizes.bytes,
				injectedCountsCapped: sizes.capped,
				existingMessageCount: Math.min(
					existingMessages.length,
					MAX_REPORTED_MESSAGES,
				),
				resultMessageCount: Math.min(
					resultMessages.length,
					MAX_REPORTED_MESSAGES,
				),
				messageCountCapped,
				placement,
				prefixObservation,
				prefixBaseline:
					prefixObservation === "baseline"
						? true
						: prefixObservation === "empty"
							? null
							: false,
				firstMessageChanged: beforeFirst !== afterFirst,
				beforeFirstMessageHash: beforeFirst,
				afterFirstMessageHash: afterFirst,
				beforeSequenceHash: beforeSequence.hash,
				afterSequenceHash: afterSequence.hash,
				beforePrefixHash: beforePrefix.hash,
				afterPrefixHash: afterPrefix.hash,
				sequenceHashTruncated:
					beforeSequence.truncated || afterSequence.truncated,
				prefixHashTruncated: beforePrefix.truncated || afterPrefix.truncated,
			},
		});
	} catch (err) {
		args.dbg?.(`cache-context: failed to log context observation: ${err}`);
	}
}

/**
 * Part 1 — log one `cache_usage` record for an assistant `message_end` that
 * carries a `usage`. Provider/model come straight off the message itself
 * (`AssistantMessage.provider` / `.model` in pi-ai) — no dependency on the
 * runtime telemetry identity. Skips silently (no record) when the message is
 * not an assistant message or has no usage; never logs a zeros-only record for
 * a message that simply lacks usage.
 */
export function logCacheUsage(
	message: unknown,
	dbg?: (msg: string) => void,
	context?: CacheUsageContext,
): void {
	try {
		if (!message || typeof message !== "object") return;
		const msg = message as AssistantMessageLike;
		// Only assistant messages carry LLM usage; tool-result / user messages
		// (and unknown custom AgentMessage variants) are skipped.
		if (msg.role !== "assistant") return;
		const usage = msg.usage;
		if (!usage || typeof usage !== "object") return;
		const u = usage as AssistantUsageLike;
		logLatency({
			type: "phase",
			filePath: "<pi-lens>",
			phase: "cache_usage",
			durationMs: 0,
			metadata: {
				provider: typeof msg.provider === "string" ? msg.provider : undefined,
				model: typeof msg.model === "string" ? msg.model : undefined,
				cacheRead: u.cacheRead,
				cacheWrite: u.cacheWrite,
				input: u.input,
				output: u.output,
				// `Usage.cost` is a breakdown object; the total is the headline number.
				cost: u.cost?.total,
				...(context
					? {
							// MessageEndEvent has no request/context id in the host API. These
							// fields permit session/turn correlation without inventing an
							// exact provider-request linkage.
							sessionId: sessionKey(context.sessionId),
							turnIndex: context.turnIndex,
							contextCorrelation: context.sessionId
								? "session-turn-only"
								: "no-stable-session-id",
						}
					: {}),
			},
		});
	} catch (err) {
		dbg?.(`cache-usage: failed to log message_end usage: ${err}`);
	}
}

/**
 * Content hash of the first transcript message. Stable for identical content
 * (role + content are serialized in a fixed order), so a changing hash means
 * `messages[0]` actually changed byte-for-byte.
 */
function hashFirstMessage(first: {
	role?: unknown;
	content?: unknown;
}): string {
	// Keep the original full local hash semantics for the existing
	// `cache_prefix_break` signal. The new `cache_context` hashes above are the
	// bounded hashes; this signal must not silently miss a suffix-only change.
	const serialized = JSON.stringify({
		role: first.role,
		content: first.content,
	});
	return createHash("sha256").update(serialized).digest("hex");
}

/**
 * Per-session baseline hash of `messages[0]`, keyed by the STABLE pi session id
 * (`ctx.sessionManager.getSessionId()`). A single module-scoped var was wrong:
 * in ONE process, multiple logical conversations touch this module, and they
 * must not share a baseline —
 *   - new / fork / a concurrent in-process subagent (#473) is a DIFFERENT id →
 *     its OWN independent baseline, never compared against another id's (else a
 *     benign session boundary logs a spurious `cache_prefix_break`, and a
 *     concurrent subagent + its parent stomp each other's baseline, each
 *     emitting a false positive — fatal for a signal whose value is trust);
 *   - an IN-PROCESS reload / resume reuses the SAME id → the baseline is still in
 *     this map, so a genuine break is caught (no blinding reset). NOTE: a full
 *     process restart (quit → `pi --session <id>`) starts a NEW process with an
 *     empty map, so the first post-restart `context` re-anchors a fresh baseline
 *     rather than comparing across the restart. That's acceptable here — this is a
 *     pure observability signal (at worst a missed `cache_prefix_break` log on the
 *     first post-restart turn, never a user-facing action) — unlike genuine
 *     session state (read guard #1041, widget #190) which IS rehydrated from the
 *     sidecar.
 *
 * Bounded as an insertion-ordered LRU (evict oldest-inserted past the cap) so a
 * long-lived process cycling through many sessions can't grow this unbounded.
 */
const MAX_TRACKED_SESSIONS = 32;
const prefixHashBySession = new Map<string, string>();

/**
 * Bucket key used when no session id is available (undefined/empty). Degrades
 * gracefully to the old single-var semantics — one shared baseline — rather than
 * throwing or dropping the signal.
 */
const NO_SESSION_KEY = "<no-session>";

/**
 * Store `hash` for `key`, refreshing its LRU recency (re-insert moves it to the
 * newest position since `Map` preserves insertion order) and evicting the
 * oldest-inserted entries once the cap is exceeded.
 */
function recordSessionHash(key: string, hash: string): void {
	prefixHashBySession.delete(key);
	prefixHashBySession.set(key, hash);
	while (prefixHashBySession.size > MAX_TRACKED_SESSIONS) {
		const oldest = prefixHashBySession.keys().next().value;
		if (oldest === undefined) break;
		prefixHashBySession.delete(oldest);
	}
}

/**
 * Part 2 — observe `messages[0]` stability turn-over-turn, keyed by session id.
 * Logs a baseline the first time it sees a non-empty transcript FOR A GIVEN
 * session id, then logs a `cache_prefix_break` whenever that same session's
 * first-message hash changes. Pure observation: it never inspects or mutates
 * anything but its own per-session hash map, and never throws.
 *
 * `sessionId` should be pi's STABLE id (`ctx.sessionManager.getSessionId()`),
 * which uniquely identifies the CURRENTLY-firing session: a concurrent
 * in-process subagent runs its own `AgentSession`/`sessionManager`, so its
 * `context` calls carry a DIFFERENT id than the parent's and get their own
 * baseline. (`runtime.telemetrySessionId` cannot be used here: per the #473
 * guard a concurrent secondary skips `updateRuntimeIdentityFromEvent`, so that
 * process-global singleton stays pinned to the PARENT — it would collapse
 * parent and subagent onto one baseline.) Residual limitation: if the host ever
 * does NOT supply a stable id, all such sessions collapse onto `NO_SESSION_KEY`
 * and behave like the old single-var (a concurrent subagent could then still
 * cross-contaminate) — accepted as graceful degradation, not silently perfect.
 *
 * Does nothing on an empty transcript (nothing to anchor a prefix to yet).
 */
export function observeCachePrefix(
	messages: ReadonlyArray<{ role?: unknown; content?: unknown }> | undefined,
	turnIndex: number,
	sessionId?: string,
	sessionRole?: "primary" | "concurrent-secondary",
	dbg?: (msg: string) => void,
): CachePrefixObservation {
	try {
		if (!messages || messages.length === 0) return "empty";
		const first = messages[0];
		if (!first || typeof first !== "object") return "empty";
		const key = sessionKey(sessionId);
		const currentHash = hashFirstMessage(first);
		const previousHash = prefixHashBySession.get(key);
		if (previousHash === undefined) {
			// Baseline: record this session's starting prefix so a later break has a
			// reference point in the log. `previousHash: null` marks the baseline.
			recordSessionHash(key, currentHash);
			logLatency({
				type: "phase",
				filePath: "<pi-lens>",
				phase: "cache_prefix_break",
				durationMs: 0,
				metadata: {
					turnIndex,
					previousHash: null,
					currentHash,
					baseline: true,
					sessionId: key,
					sessionRole,
				},
			});
			return "baseline";
		}
		if (currentHash !== previousHash) {
			logLatency({
				type: "phase",
				filePath: "<pi-lens>",
				phase: "cache_prefix_break",
				durationMs: 0,
				metadata: {
					turnIndex,
					previousHash,
					currentHash,
					sessionId: key,
					sessionRole,
				},
			});
		}
		// Refresh recency (and update the stored hash after a break) so an active
		// session stays warm in the LRU and isn't evicted while still in use.
		recordSessionHash(key, currentHash);
		return currentHash === previousHash ? "unchanged" : "changed";
	} catch (err) {
		dbg?.(`cache-prefix: failed to observe messages[0]: ${err}`);
		return "empty";
	}
}

/**
 * Drop a single session's prefix baseline. Called from the `session_shutdown`
 * handler (primary path only — the concurrent-secondary guard there returns
 * first, and the LRU cap backstops any secondary entry left behind) so an ended
 * conversation's entry is reclaimed promptly rather than only when the LRU
 * evicts it. Idempotent and never throws.
 */
export function clearCachePrefixSession(sessionId?: string): void {
	const key = sessionKey(sessionId);
	prefixHashBySession.delete(key);
}

/** Clear all per-session prefix hashes. For tests / session boundaries. */
export function resetCachePrefixObservation(): void {
	prefixHashBySession.clear();
}
