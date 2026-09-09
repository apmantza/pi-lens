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
 *      for every `context` call, describing pi-lens's own before/after message
 *      transformation, placement, injection sources, and privacy-preserving
 *      hashes. This is what pi-lens observed locally, not the final provider
 *      request after other context handlers have run and not a provider cache
 *      result. #1938: this record used to also carry a `prefixObservation` /
 *      `firstMessageChange` pair derived from a SEPARATE bounded hash of the
 *      pre-injection prefix (capped at `MAX_HASHED_MESSAGES` messages /
 *      `MAX_HASHED_CONTENT_CHARS` chars). Every real session's transcript
 *      exceeds that cap almost immediately, so the pair reported "unknown" on
 *      97% of records — dead weight in every record, answering nothing. The
 *      pair is removed; signal 3 below (`cache_prefix_break`) already covers
 *      first-message stability with an unbounded hash and never truncates.
 *
 *   3. Request-side prefix stability (`cache_prefix_break`) — a content hash of
 *      `messages[0]` observed on every `context` call. After #1016 the first
 *      message must stay byte-stable across a whole session; a logged CHANGE
 *      flags that something (pi-lens or otherwise) broke the cache prefix. This
 *      remains a local observation, never a provider cache-miss claim.
 *
 * #1071 adds miss ATTRIBUTION on top of those three. Each `cache_usage` record
 * carries the inter-turn gap and a `cacheMissCause` verdict, and each
 * `cache_context` record splits a mixed injection payload by contributing
 * source. #1996 makes every unexplained miss name the absent/conflicting
 * evidence and emits one fixed-key `cache_usage_summary` at session shutdown.
 * Heuristic causes require complete request hashing and full provider/model
 * identity evidence. Identity comparison uses SHA-256 over the full normalized
 * value while logs retain only a bounded display prefix; malformed numeric
 * usage is sanitized before it reaches JSON metadata.
 * The per-turn records still ride events that already fire once per turn, and
 * all attribution derives from bounded in-process state — nothing reads
 * latency.log back or serializes transcript content.
 *
 * All paths are defensive: `usage` (and its fields) may be absent on older
 * hosts or non-assistant messages, so every access is guarded and the handlers
 * never throw — on error they `dbg(...)` and no-op, like the other index.ts
 * event handlers.
 */
import { createHash } from "node:crypto";
import { BoundedFifoMap, BoundedLruCache } from "./bounded-cache.js";
import { lazyEnvNumber } from "./env-utils.js";
import { logLatency } from "./latency-logger.js";
import { compareOrdinal } from "./string-utils.js";

interface AssistantMessageLike {
	role?: unknown;
	provider?: unknown;
	model?: unknown;
	responseModel?: unknown;
	usage?: unknown;
}

type CacheContextInjectionSource =
	| "session-guidance"
	| "turn-findings"
	| "test-findings"
	| "agent-nudge";
type InjectedByteSource =
	| "sessionGuidance"
	| "turnFindings"
	| "testFindings"
	| "agentNudge"
	| "turnEndAdvisory"
	| "other";
export type InjectedBytes = Record<InjectedByteSource, number>;
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

/**
 * Why a turn read less from the provider prompt cache than the turn before it
 * (#1071, 2026-08-21 investigation). A verdict is an ATTRIBUTION of a locally
 * observable cause, never a provider statement: the provider reports token
 * counts only, so `unknown` is a real and expected answer.
 */
type CacheMissCause =
	| "ttl-expired"
	| "prefix-broke"
	| "partial-eviction"
	| "model-provider-changed"
	| "unknown";

/** Why a miss could not be assigned a local cause (#1996). */
type CacheMissUnknownReason =
	| "no-prior-sample"
	| "cache-read-unavailable"
	| "malformed-provider-usage"
	| "request-correlation-unavailable"
	| "request-evidence-incomplete"
	| "sequence-hash-truncated"
	| "model-provider-unavailable"
	| "provider-reported-zero-stable-prefix"
	| "provider-reported-low-read-stable-prefix"
	| "no-local-explanation";

/** Which shape of shortfall triggered the verdict. */
type CacheMissKind = "zero-read" | "low-read";

type ContextMessageLike = { role?: unknown; content?: unknown };

/** One source's share of a mixed injection payload (#1071). */
export interface CacheContextInjectionSlice {
	source: CacheContextInjectionSource;
	messages: ReadonlyArray<ContextMessageLike>;
}

interface CacheUsageContext {
	sessionId?: string;
	sessionRole?: "primary" | "concurrent-secondary";
	turnIndex?: number;
}

interface CacheUsageSessionSummary {
	usageRecords: number;
	cacheHits: number;
	missObservations: number;
	cacheMissCauses: Record<CacheMissCause, number>;
	unknownEvidenceReasons: Record<CacheMissUnknownReason, number>;
}

/** RuntimeCoordinator's counter is process-global when sessions share a host. */
const PROCESS_TURN_SCOPE = "process-global-runtime" as const;
const SECONDARY_TURN_SCOPE = "unavailable-concurrent-secondary" as const;

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

/**
 * Documented deterministic char→token estimate. Four characters per token is
 * the same ratio #1071's issue body used to size the sampled injections. It is
 * an ESTIMATE: never present a value derived from it as provider-measured
 * usage.
 */
const CHARS_PER_ESTIMATED_TOKEN = 4;

/**
 * Idle gap after which a provider prompt cache entry is assumed expired.
 *
 * The gap this is compared against is measured to REQUEST time, not to the
 * `message_end` that follows it — see {@link resolveInterTurnGap}. The provider
 * looks the cache up when the request arrives, so the response's own generation
 * time is not idle time and must not count toward expiry.
 *
 * Evidence (2026-08-21 KV-cache investigation, 63 sessions, 2,288 turns): the
 * 34 zero-`cacheRead` turns had a MEDIAN inter-turn gap of 166s, against 9s for
 * every other turn. Those 34 turns carried 6.96M fresh input tokens, 35.1% of
 * all fresh input in the window. 60s sits between the two populations and
 * matches the documented 5-minute-minus-safety-margin behavior of the shortest
 * provider TTL tier we run against. Override with
 * `PI_LENS_PROVIDER_CACHE_TTL_MS` when a provider's TTL differs.
 */
export const DEFAULT_PROVIDER_CACHE_TTL_MS = 60_000;
const _providerCacheTtl = lazyEnvNumber(
	"PI_LENS_PROVIDER_CACHE_TTL_MS",
	DEFAULT_PROVIDER_CACHE_TTL_MS,
);
const getProviderCacheTtlMs = _providerCacheTtl.get;
export const _resetProviderCacheTtlForTests = _providerCacheTtl._resetForTests;

/**
 * A turn counts as "anomalously low" when it reads back less than half of what
 * the previous turn read. The investigation's partial-break population (90
 * turns, upper-bounded at 2.7M tokens) was selected by exactly this shape: a
 * non-zero `cacheRead` well below the prior turn's, which a zero-read filter
 * misses entirely.
 */
const LOW_CACHE_READ_RATIO = 0.5;

/**
 * Fresh input must exceed the estimated new content by this factor before a
 * shortfall reads as provider-side eviction rather than as our own payload.
 * The investigation upper-bounds a whole session's injections at ~2.7 tokens
 * per turn, so fresh input several times the measured new content cannot be
 * explained by what pi-lens added.
 */
const PARTIAL_EVICTION_INPUT_FACTOR = 4;

/**
 * Floor for the same rule, so a turn with almost no new content does not read
 * as eviction on a handful of tokens.
 */
const PARTIAL_EVICTION_MIN_FRESH_TOKENS = 512;

/**
 * Cap on the per-session character accumulators used for attribution, and on a
 * single transcript-growth measurement feeding them.
 *
 * This is deliberately NOT `MAX_INJECTED_CHARS`. That 16 KiB cap exists to keep
 * the reported injection size small, and pi-lens injections average about 2.7
 * estimated tokens per turn, so it is never reached in practice. Transcript
 * growth is a different population: one ordinary tool result can add 20,000
 * characters in a single turn. Measuring growth through the injection cap
 * latched `attributionCharsCapped` on a routine turn and suppressed the
 * `partial-eviction` verdict, which made the verdict near-unreachable (#1071
 * review round 1, F2).
 */
const MAX_ATTRIBUTION_CHARS = 262_144;

/** Byte companion to {@link MAX_ATTRIBUTION_CHARS}, at four bytes per char. */
const MAX_ATTRIBUTION_BYTES = 1_048_576;

/**
 * Per-session state that turns two independent records into one verdict: the
 * `context` observations describe what pi-lens added, and the `message_end`
 * usage describes what the provider charged. Both already run per turn, so
 * attribution rides them rather than adding a phase.
 */
interface SessionAttributionState {
	/** `Date.now()` of the previous `cache_usage` record for this session. */
	lastUsageAtMs?: number;
	/**
	 * `Date.now()` of the most recent `context` observation since that record.
	 * This is REQUEST time, the moment the provider performs its cache lookup.
	 * Cleared at every usage record, so a turn whose request pi-lens never saw
	 * cannot inherit an earlier turn's request timestamp.
	 */
	lastContextAtMs?: number;
	/** Previous record's `cacheRead`, the baseline a shortfall is measured against. */
	lastCacheRead?: number;
	/** A `cache_prefix_break` CHANGE fired since the previous usage record. */
	prefixBrokeSinceLastUsage: boolean;
	/** A prefix baseline or unchanged observation was seen since the usage record. */
	prefixStableSinceLastUsage: boolean;
	/** A bounded context sequence hash lost content or message coverage. */
	sequenceHashTruncatedSinceLastUsage: boolean;
	/** Request hashing encountered cycles, throwing getters, or unreadable data. */
	requestEvidenceIncompleteSinceLastUsage: boolean;
	/** Characters pi-lens injected since the previous usage record. */
	injectedCharsSinceLastUsage: number;
	/** Characters of transcript growth observed since the previous usage record. */
	newTranscriptCharsSinceLastUsage: number;
	/** Either accumulator hit a bound, so the estimate is a floor, not a total. */
	attributionCharsCapped: boolean;
	injectedBytes: InjectedBytes;
	injectedFindingsRepeated: number;
	readonly findingIdentities: Set<string>;
	findingIdentityCapRecorded: boolean;
	turnEndAdvisoryBytes: number;
	/** Transcript length at the previous `context` observation. */
	lastObservedMessageCount?: number;
	/** Full-identity SHA-256 evidence from the previous usage record. */
	lastProviderIdentityHash?: string;
	lastModelIdentityHash?: string;
	/** Bounded process-local session summary, emitted at session shutdown. */
	summary: CacheUsageSessionSummary;
}

function emptyCacheMissCauses(): Record<CacheMissCause, number> {
	return {
		"ttl-expired": 0,
		"prefix-broke": 0,
		"partial-eviction": 0,
		"model-provider-changed": 0,
		unknown: 0,
	};
}

function emptyUnknownEvidenceReasons(): Record<CacheMissUnknownReason, number> {
	return {
		"no-prior-sample": 0,
		"cache-read-unavailable": 0,
		"malformed-provider-usage": 0,
		"request-correlation-unavailable": 0,
		"request-evidence-incomplete": 0,
		"sequence-hash-truncated": 0,
		"model-provider-unavailable": 0,
		"provider-reported-zero-stable-prefix": 0,
		"provider-reported-low-read-stable-prefix": 0,
		"no-local-explanation": 0,
	};
}

function newCacheUsageSummary(): CacheUsageSessionSummary {
	return {
		usageRecords: 0,
		cacheHits: 0,
		missObservations: 0,
		cacheMissCauses: emptyCacheMissCauses(),
		unknownEvidenceReasons: emptyUnknownEvidenceReasons(),
	};
}

// Shared cap for every per-session bounded map in this module (also used by
// `prefixHashBySession` below) — a long-lived process cycling through many
// sessions cannot grow any of them without limit.
export const MAX_TRACKED_SESSIONS = 32;
const attributionBySession = new BoundedLruCache<
	string,
	SessionAttributionState
>(MAX_TRACKED_SESSIONS);

function newAttributionState(): SessionAttributionState {
	return {
		prefixBrokeSinceLastUsage: false,
		prefixStableSinceLastUsage: false,
		sequenceHashTruncatedSinceLastUsage: false,
		requestEvidenceIncompleteSinceLastUsage: false,
		injectedCharsSinceLastUsage: 0,
		newTranscriptCharsSinceLastUsage: 0,
		attributionCharsCapped: false,
		injectedBytes: emptyInjectedBytes(),
		injectedFindingsRepeated: 0,
		findingIdentities: new Set(),
		findingIdentityCapRecorded: false,
		turnEndAdvisoryBytes: 0,
		summary: newCacheUsageSummary(),
	};
}

const MAX_FINDING_IDENTITIES = 2_000;

function emptyInjectedBytes(): InjectedBytes {
	return {
		sessionGuidance: 0,
		turnFindings: 0,
		testFindings: 0,
		agentNudge: 0,
		turnEndAdvisory: 0,
		other: 0,
	};
}

function sourceKey(source: CacheContextInjectionSource): InjectedByteSource {
	return {
		"session-guidance": "sessionGuidance",
		"turn-findings": "turnFindings",
		"test-findings": "testFindings",
		"agent-nudge": "agentNudge",
	}[source] as InjectedByteSource;
}

/** Best-effort, language-neutral identity extraction from rendered findings. */
function findingIdentities(text: string): string[] {
	const out: string[] = [];
	for (const line of text.split(/\r?\n/)) {
		const location = line.match(/(?:^|\s)([^\s:]+):(\d+)(?::\d+)?/);
		if (!location) continue;
		const rule =
			line.match(/(?:rule|code)\s*[:=]\s*([\w./-]+)/i)?.[1] ??
			line.match(/\(([\w./-]+)\)\s*$/)?.[1] ??
			line.match(/:\d+(?::\d+)?\s+([\w./-]+)/)?.[1];
		if (rule) out.push(`${location[1]}:${location[2]}:${rule}`);
	}
	return out;
}

/**
 * Fetch (creating if absent) one session's attribution state, refreshing LRU
 * recency and evicting the oldest entries past the cap — same bounding as
 * {@link recordSessionHash}, so a long-lived process cycling through sessions
 * cannot grow this map without limit.
 */
function attributionFor(key: string): SessionAttributionState {
	const existing = attributionBySession.get(key);
	const state = existing ?? newAttributionState();
	// `get` above already moved an existing entry to MRU; `set` below also
	// refreshes recency on a create, so every fetch counts as a touch.
	attributionBySession.set(key, state);
	return state;
}

/**
 * Fold one `context` observation into the session's attribution state: how much
 * pi-lens injected, and how much the transcript itself grew since the previous
 * observation. The transcript delta is what the "far above the injected and new
 * content" rule measures fresh input against. The first observation in a
 * session only anchors the message-count baseline, because there is no earlier
 * point to measure growth from.
 */
function recordContextAttribution(
	key: string,
	existingMessages: ReadonlyArray<ContextMessageLike>,
	injectedSize: { chars: number; capped: boolean },
): void {
	const state = attributionFor(key);
	const baseline = Math.min(
		state.lastObservedMessageCount ?? existingMessages.length,
		existingMessages.length,
	);
	const grown = measureTranscriptGrowth(existingMessages.slice(baseline));
	state.injectedCharsSinceLastUsage = Math.min(
		MAX_ATTRIBUTION_CHARS,
		state.injectedCharsSinceLastUsage + injectedSize.chars,
	);
	state.newTranscriptCharsSinceLastUsage = Math.min(
		MAX_ATTRIBUTION_CHARS,
		state.newTranscriptCharsSinceLastUsage + grown.chars,
	);
	if (
		injectedSize.capped ||
		grown.capped ||
		state.injectedCharsSinceLastUsage >= MAX_ATTRIBUTION_CHARS ||
		state.newTranscriptCharsSinceLastUsage >= MAX_ATTRIBUTION_CHARS
	) {
		// The accumulators are now floors, not totals. The verdict rules must not
		// treat a floor as a measured value.
		state.attributionCharsCapped = true;
	}
	state.lastObservedMessageCount = existingMessages.length;
	// #1071 review round 1, F1: this handler runs at REQUEST time, which is when
	// the provider looks the prompt cache up. Stamping it here is what lets the
	// gap exclude the response's own generation time.
	state.lastContextAtMs = Date.now();
}

/**
 * Which clock the reported gap was measured to.
 *
 * `request-time` is the accurate basis: the provider looks the prompt cache up
 * when the request arrives, so idle time ends at the `context` call.
 * `message-end-fallback` means no `context` observation arrived for this turn,
 * so the only available endpoint was this record itself, and the value INCLUDES
 * the response's own generation time. `no-prior-turn` means there is no earlier
 * record to measure from.
 */
type CacheGapBasis = "request-time" | "message-end-fallback" | "no-prior-turn";

/**
 * Idle milliseconds before this turn's provider request.
 *
 * Measuring `message_end` to `message_end` would fold the response's own
 * generation time into the gap, and generation dominates: over a real corpus
 * the median generation time is 7,407 ms against a median true idle of 228 ms,
 * a factor of 30. At the 60s threshold, 8.7% of consecutive pairs measure over
 * on the message-end basis while only 3.3% were truly idle over. That is a 3.4x
 * inflation of `ttl-expired`, which would have confirmed the investigation's
 * hypothesis by construction (#1071 review round 1, F1).
 */
function resolveInterTurnGap(
	state: SessionAttributionState,
	nowMs: number,
): { gapMs: number | null; basis: CacheGapBasis } {
	if (state.lastUsageAtMs === undefined) {
		return { gapMs: null, basis: "no-prior-turn" };
	}
	if (state.lastContextAtMs !== undefined) {
		return {
			gapMs: Math.max(0, state.lastContextAtMs - state.lastUsageAtMs),
			basis: "request-time",
		};
	}
	return {
		gapMs: Math.max(0, nowMs - state.lastUsageAtMs),
		basis: "message-end-fallback",
	};
}

function estimateTokens(chars: number): number {
	return Math.ceil(chars / CHARS_PER_ESTIMATED_TOKEN);
}

function readableTokenCount(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? value
		: undefined;
}

type NumericEvidenceStatus = "available" | "absent" | "malformed";

interface NumericEvidence {
	value?: number;
	status: NumericEvidenceStatus;
}

function readNumericEvidence(
	record: Record<string, unknown>,
	key: string,
): NumericEvidence {
	let raw: unknown;
	try {
		raw = record[key];
	} catch {
		return { status: "malformed" };
	}
	if (raw === undefined) return { status: "absent" };
	const value = readableTokenCount(raw);
	return value === undefined
		? { status: "malformed" }
		: { status: "available", value };
}

const MAX_LOGGED_IDENTITY_CHARS = 200;

interface IdentityEvidence {
	display?: string;
	hash?: string;
	status: "complete" | "truncated" | "unavailable";
}

/**
 * Keep the human-readable identity bounded while comparing a SHA-256 digest of
 * the FULL normalized value. Comparing the display prefix would make two long
 * provider/model ids that differ after the cap collide (#1996 review).
 */
function identityEvidence(value: unknown): IdentityEvidence {
	if (typeof value !== "string") return { status: "unavailable" };
	const normalized = value.trim();
	if (!normalized) return { status: "unavailable" };
	const truncated = normalized.length > MAX_LOGGED_IDENTITY_CHARS;
	return {
		display: normalized.slice(0, MAX_LOGGED_IDENTITY_CHARS),
		hash: createHash("sha256").update(normalized).digest("hex"),
		status: truncated ? "truncated" : "complete",
	};
}

interface CacheMissVerdict {
	kind: CacheMissKind;
	cause: CacheMissCause;
	unknownReason?: CacheMissUnknownReason;
}

/**
 * Classify a turn's prompt-cache shortfall. Returns `null` when no comparable
 * miss exists: no prior readable usage record or a healthy read. The caller
 * separately records why an unreadable/first zero sample could not be
 * classified, so those evidence gaps remain visible in the session summary.
 *
 * Rules, in the order they are applied, each stated with the evidence behind
 * it (2026-08-21 investigation, 63 sessions, 2,288 turns, 94.2% overall hit
 * rate):
 *
 *   1. `prefix-broke` — a `cache_prefix_break` CHANGE fired in this session
 *      since the previous usage record. This is a DIRECT local observation of
 *      the cause, so it outranks the timing heuristics below. The window was
 *      byte-stable throughout, so this verdict should stay rare; if it does
 *      not, #1016's fix has regressed.
 *   2. `model-provider-changed` — both adjacent identities were present and
 *      differ. This is direct local evidence and outranks timing heuristics.
 *   3. Evidence gates — heuristic causes require a REQUEST-time observation,
 *      a complete bounded sequence hash, adjacent full provider/model identity,
 *      and well-formed provider usage numbers.
 *      Missing evidence returns a specific unknown reason; it never lets a
 *      plausible but unproved heuristic win.
 *   4. `ttl-expired` — a REQUEST-time gap reached the configured provider TTL.
 *      A message-end fallback includes generation time and cannot prove this.
 *   5. `partial-eviction` — a non-zero but low read, where fresh input runs far
 *      above the new content we measured. pi-lens injections average ~2.7
 *      estimated tokens per turn, so they cannot account for a multiple of the
 *      measured content; the remainder is provider-side eviction, typically at
 *      a context limit. Suppressed when the character accumulators were capped,
 *      because a floor estimate would manufacture the verdict.
 *   6. `unknown` — a real shortfall with no local explanation. A bounded
 *      `cacheMissUnknownReason` names the missing or conflicting evidence;
 *      provider behavior is never guessed.
 */
function classifyCacheMiss(args: {
	cacheRead: number | undefined;
	input: number;
	priorCacheRead: number | undefined;
	interTurnGapMs: number | null;
	gapBasis: CacheGapBasis;
	ttlMs: number;
	prefixBroke: boolean;
	prefixStable: boolean;
	sequenceHashTruncated: boolean;
	requestEvidenceIncomplete: boolean;
	stableSessionIdentity: boolean;
	modelProviderChanged: boolean;
	modelProviderEvidenceAvailable: boolean;
	providerUsageMalformed: boolean;
	estimatedNewTokens: number;
	attributionCharsCapped: boolean;
}): CacheMissVerdict | null {
	const cacheRead = readableTokenCount(args.cacheRead);
	if (cacheRead === undefined) return null;
	// No baseline turn in this session: a first turn reads zero because nothing
	// is cached yet, not because anything went wrong.
	const priorCacheRead = readableTokenCount(args.priorCacheRead);
	if (priorCacheRead === undefined) {
		return null;
	}
	let kind: CacheMissKind;
	if (cacheRead === 0) {
		kind = "zero-read";
	} else if (
		priorCacheRead > 0 &&
		cacheRead < priorCacheRead * LOW_CACHE_READ_RATIO
	) {
		kind = "low-read";
	} else {
		return null;
	}

	// A missing stable session id makes every cross-event baseline ambiguous. Do
	// not let the shared fallback bucket turn another session's evidence into a
	// cause claim (#1996 concurrent primary/secondary invariant).
	if (!args.stableSessionIdentity) {
		return {
			kind,
			cause: "unknown",
			unknownReason: "request-correlation-unavailable",
		};
	}
	if (args.prefixBroke) return { kind, cause: "prefix-broke" };
	if (args.modelProviderChanged) {
		return { kind, cause: "model-provider-changed" };
	}
	// TTL and transcript-growth claims need the request-side context observation.
	// A response-time fallback includes generation and can only explain why the
	// verdict stayed unknown; it cannot establish cache expiry.
	if (args.gapBasis !== "request-time") {
		return {
			kind,
			cause: "unknown",
			unknownReason: "request-correlation-unavailable",
		};
	}
	// TTL and eviction are heuristics. They are only evidence-backed if the
	// bounded request observation is complete and both adjacent usage records
	// identify the same provider/model. Otherwise an unseen prompt or identity
	// change remains a competing explanation, so classification must fail closed.
	if (args.requestEvidenceIncomplete) {
		return {
			kind,
			cause: "unknown",
			unknownReason: "request-evidence-incomplete",
		};
	}
	if (args.sequenceHashTruncated) {
		return {
			kind,
			cause: "unknown",
			unknownReason: "sequence-hash-truncated",
		};
	}
	if (args.providerUsageMalformed) {
		return {
			kind,
			cause: "unknown",
			unknownReason: "malformed-provider-usage",
		};
	}
	if (!args.modelProviderEvidenceAvailable) {
		return {
			kind,
			cause: "unknown",
			unknownReason: "model-provider-unavailable",
		};
	}
	if (args.interTurnGapMs !== null && args.interTurnGapMs >= args.ttlMs) {
		return { kind, cause: "ttl-expired" };
	}
	if (
		kind === "low-read" &&
		!args.attributionCharsCapped &&
		args.input >
			Math.max(
				PARTIAL_EVICTION_MIN_FRESH_TOKENS,
				args.estimatedNewTokens * PARTIAL_EVICTION_INPUT_FACTOR,
			)
	) {
		return { kind, cause: "partial-eviction" };
	}
	if (args.prefixStable) {
		return {
			kind,
			cause: "unknown",
			unknownReason:
				kind === "zero-read"
					? "provider-reported-zero-stable-prefix"
					: "provider-reported-low-read-stable-prefix",
		};
	}
	return {
		kind,
		cause: "unknown",
		unknownReason: "no-local-explanation",
	};
}

function recordCacheUsageSummary(args: {
	state: SessionAttributionState;
	cacheRead: number | undefined;
	priorCacheRead: number | undefined;
	verdict: CacheMissVerdict | null;
	unknownReason?: CacheMissUnknownReason;
}): void {
	const summary = args.state.summary;
	summary.usageRecords += 1;
	let unknownReasonRecorded = false;
	if (args.unknownReason === "malformed-provider-usage") {
		summary.unknownEvidenceReasons["malformed-provider-usage"] += 1;
		unknownReasonRecorded = true;
	}
	if (args.cacheRead === undefined) {
		if (!unknownReasonRecorded) {
			summary.unknownEvidenceReasons["cache-read-unavailable"] += 1;
		}
		return;
	}
	if (args.priorCacheRead === undefined) {
		if (args.cacheRead === 0) {
			summary.missObservations += 1;
			if (!unknownReasonRecorded) {
				summary.unknownEvidenceReasons["no-prior-sample"] += 1;
			}
		} else {
			summary.cacheHits += 1;
		}
		return;
	}
	if (!args.verdict) {
		summary.cacheHits += 1;
		return;
	}
	summary.missObservations += 1;
	summary.cacheMissCauses[args.verdict.cause] += 1;
	if (
		args.verdict.cause === "unknown" &&
		args.unknownReason &&
		!unknownReasonRecorded
	) {
		summary.unknownEvidenceReasons[args.unknownReason] += 1;
	}
}

interface BoundedHashState {
	contentTruncated: boolean;
	incomplete: boolean;
}

function boundedHashScalar(value: unknown, state: BoundedHashState): string {
	if (value === null) return "null";
	if (value === undefined) return "undefined";
	if (typeof value === "string") {
		const truncated = value.length > MAX_HASHED_CONTENT_CHARS;
		if (truncated) state.contentTruncated = true;
		const suffix = truncated ? ":content-truncated" : "";
		return `string:${value.length}:${value.slice(0, MAX_HASHED_CONTENT_CHARS)}${suffix}`;
	}
	if (
		typeof value === "number" ||
		typeof value === "boolean" ||
		typeof value === "bigint"
	) {
		return `${typeof value}:${String(value)}`;
	}
	return typeof value;
}

function boundedHashArray(
	value: unknown[],
	depth: number,
	seen: Set<object>,
	state: BoundedHashState,
): string {
	if (value.length > 12) state.contentTruncated = true;
	const items = value
		.slice(0, 12)
		.map((item) => boundedHashValue(item, depth + 1, seen, state));
	return `array:${value.length}:[${items.join(",")}]`;
}

function boundedHashObject(
	value: Record<string, unknown>,
	depth: number,
	seen: Set<object>,
	state: BoundedHashState,
): string {
	const keys = Object.keys(value).sort((left, right) =>
		compareOrdinal(left, right),
	);
	if (keys.length > 24) state.contentTruncated = true;
	const fields = keys
		.slice(0, 24)
		.map(
			(key) => `${key}:${boundedHashValue(value[key], depth + 1, seen, state)}`,
		);
	return `object:${keys.length}:{${fields.join(",")}}`;
}

function boundedHashValue(
	value: unknown,
	depth = 0,
	seen = new Set<object>(),
	state?: BoundedHashState,
): string {
	const hashState = state ?? { contentTruncated: false, incomplete: false };
	if (value === null || typeof value !== "object") {
		return boundedHashScalar(value, hashState);
	}
	if (depth >= 3) {
		hashState.contentTruncated = true;
		return "[depth-limit]";
	}
	if (seen.has(value)) {
		hashState.incomplete = true;
		return "[cycle]";
	}
	seen.add(value);
	try {
		if (Array.isArray(value)) {
			return boundedHashArray(value, depth, seen, hashState);
		}
		return boundedHashObject(
			value as Record<string, unknown>,
			depth,
			seen,
			hashState,
		);
	} catch {
		hashState.incomplete = true;
		return "[unreadable]";
	} finally {
		seen.delete(value);
	}
}

function hashMessageSequence(messages: ReadonlyArray<ContextMessageLike>): {
	hash: string;
	truncated: boolean;
	contentTruncated: boolean;
	incomplete: boolean;
} {
	const hash = createHash("sha256");
	const state: BoundedHashState = {
		contentTruncated: false,
		incomplete: false,
	};
	let messageCount: number;
	try {
		messageCount = messages.length;
		if (!Number.isSafeInteger(messageCount) || messageCount < 0) {
			throw new Error("invalid message count");
		}
	} catch {
		state.incomplete = true;
		hash.update("message-count:[unreadable];");
		return {
			hash: hash.digest("hex"),
			truncated: false,
			contentTruncated: false,
			incomplete: true,
		};
	}
	hash.update(`message-count:${messageCount};`);
	const sampled = Math.min(messageCount, MAX_HASHED_MESSAGES);
	for (let i = 0; i < sampled; i++) {
		const seen = new Set<object>();
		let role: unknown;
		let content: unknown;
		try {
			const message = messages[i];
			role = message?.role;
			content = message?.content;
		} catch {
			state.incomplete = true;
			role = "[unreadable]";
			content = "[unreadable]";
		}
		hash.update(
			`${i}|role:${boundedHashValue(role, 0, seen, state)}|content:${boundedHashValue(content, 0, seen, state)};`,
		);
	}
	const truncated = messageCount > sampled;
	if (truncated) hash.update(`truncated-after:${sampled};`);
	return {
		hash: hash.digest("hex"),
		truncated,
		contentTruncated: state.contentTruncated,
		incomplete: state.incomplete,
	};
}

/** Per-measurement bounds, so the caller picks the population's own cap. */
interface MeasureLimits {
	maxChars: number;
	maxBytes: number;
}

/** Bounds for reporting an injected payload's size in the record. */
const INJECTED_LIMITS: MeasureLimits = {
	maxChars: MAX_INJECTED_CHARS,
	maxBytes: MAX_INJECTED_BYTES,
};

/** Bounds for the transcript-growth accumulator that feeds the verdict. */
const TRANSCRIPT_LIMITS: MeasureLimits = {
	maxChars: MAX_ATTRIBUTION_CHARS,
	maxBytes: MAX_ATTRIBUTION_BYTES,
};

function messageTextSize(
	content: unknown,
	limits: MeasureLimits,
): { chars: number; bytes: number } {
	if (typeof content === "string") {
		const chars = Math.min(content.length, limits.maxChars);
		return {
			chars,
			bytes: Math.min(
				Buffer.byteLength(content.slice(0, chars), "utf8"),
				limits.maxBytes,
			),
		};
	}
	const bounded = boundedHashValue(content, 0, new Set<object>(), {
		contentTruncated: false,
		incomplete: false,
	});
	return {
		chars: Math.min(bounded.length, limits.maxChars),
		bytes: Math.min(
			Buffer.byteLength(bounded.slice(0, limits.maxChars), "utf8"),
			limits.maxBytes,
		),
	};
}

function measureMessages(
	messages: ReadonlyArray<ContextMessageLike>,
	limits: MeasureLimits,
): {
	chars: number;
	bytes: number;
	capped: boolean;
} {
	let chars = 0;
	let bytes = 0;
	const measuredCount = Math.min(messages.length, MAX_REPORTED_MESSAGES);
	for (let i = 0; i < measuredCount; i++) {
		const message = messages[i];
		const size = messageTextSize(message?.content, limits);
		chars = Math.min(limits.maxChars, chars + size.chars);
		bytes = Math.min(limits.maxBytes, bytes + size.bytes);
		if (chars === limits.maxChars || bytes === limits.maxBytes) break;
	}
	return {
		chars,
		bytes,
		capped: chars >= limits.maxChars || bytes >= limits.maxBytes,
	};
}

/** Size of an injected payload, bounded for reporting. */
function measureInjectedMessages(messages: ReadonlyArray<ContextMessageLike>): {
	chars: number;
	bytes: number;
	capped: boolean;
} {
	return measureMessages(messages, INJECTED_LIMITS);
}

/**
 * Size of the transcript's own growth, bounded far higher. A routine tool
 * result is an order of magnitude past the injection cap, and measuring it
 * through that cap made `partial-eviction` near-unreachable (#1071 review
 * round 1, F2).
 */
function measureTranscriptGrowth(messages: ReadonlyArray<ContextMessageLike>): {
	chars: number;
	bytes: number;
	capped: boolean;
} {
	return measureMessages(messages, TRANSCRIPT_LIMITS);
}

function sessionKey(sessionId?: string): string {
	return sessionId?.trim() ? sessionId.trim() : NO_SESSION_KEY;
}

/**
 * A stable host session id is the only safe cross-event identity. When it is
 * absent, keep primary and concurrent-secondary observations in separate
 * buckets and let classification fail closed instead of allowing a secondary
 * to overwrite the primary's baseline.
 */
function attributionKey(
	sessionId?: string,
	sessionRole?: "primary" | "concurrent-secondary",
): string {
	const key = sessionKey(sessionId);
	if (key !== NO_SESSION_KEY) return key;
	return `${sessionRole ?? "unknown"}:${key}`;
}

/**
 * Log one bounded request-side observation for every `context` call. This is
 * deliberately a separate phase from `cache_prefix_break`: it describes the
 * messages pi-lens saw and returned from its own context handler, not the final
 * provider request after other context handlers and not whether a provider
 * reused or missed a prompt cache. `observationId` is local to this process; the
 * host currently exposes no request id on ContextEvent/MessageEndEvent. A
 * RuntimeCoordinator turn is process-global, so it is explicitly scoped as
 * such and is omitted for concurrent secondary sessions.
 */
export function observeCacheContext(args: {
	existingMessages?: ReadonlyArray<ContextMessageLike>;
	resultMessages?: ReadonlyArray<ContextMessageLike>;
	sessionId?: string;
	sessionRole?: "primary" | "concurrent-secondary";
	turnIndex: number;
	injectionEnabled: boolean;
	/**
	 * The payload, split by contributing source. This is the SINGLE source of
	 * truth for the record's `injectionSources`, counts, and sizes: the flat
	 * message list and the source-name list are both derived here, so a caller
	 * cannot report a source it did not actually contribute (#1071).
	 */
	injectionSlices?: ReadonlyArray<CacheContextInjectionSlice>;
	placement?: CacheContextPlacement;
	dbg?: (msg: string) => void;
}): void {
	try {
		const existingMessages = args.existingMessages ?? [];
		const resultMessages = args.resultMessages ?? existingMessages;
		// Drop empty slices before deriving anything: a source that contributed
		// no message is not a contributor, and listing it would overstate the
		// payload's provenance.
		const injectionSlices = (args.injectionSlices ?? []).filter(
			(slice) => slice.messages.length > 0,
		);
		const injectedMessages = injectionSlices.flatMap((slice) => slice.messages);
		const placement = args.placement ?? "none";
		const beforeSequence = hashMessageSequence(existingMessages);
		const afterSequence = hashMessageSequence(resultMessages);
		const sizes = measureInjectedMessages(injectedMessages);
		// Per-source split of a mixed payload (#1071 AC 2). The old record named
		// which sources fired but attributed cost by CALL, so a turn carrying
		// turn-findings plus an agent nudge was one undivided number.
		const sourceBreakdown = injectionSlices.map((slice) => {
			const sliceSize = measureInjectedMessages(slice.messages);
			return {
				source: slice.source,
				messageCount: Math.min(slice.messages.length, MAX_REPORTED_MESSAGES),
				chars: sliceSize.chars,
				bytes: sliceSize.bytes,
				estimatedTokens: estimateTokens(sliceSize.chars),
				countsCapped: sliceSize.capped,
			};
		});
		const state = attributionFor(
			attributionKey(args.sessionId, args.sessionRole),
		);
		for (const slice of injectionSlices) {
			const key = sourceKey(slice.source);
			const bytes = measureInjectedMessages(slice.messages).bytes;
			state.injectedBytes[key] += bytes;
			for (const message of slice.messages) {
				for (const identity of findingIdentities(
					typeof message.content === "string" ? message.content : "",
				)) {
					if (state.findingIdentities.has(identity)) {
						state.injectedFindingsRepeated += 1;
						continue;
					}
					if (state.findingIdentities.size >= MAX_FINDING_IDENTITIES) {
						if (!state.findingIdentityCapRecorded) {
							state.findingIdentityCapRecorded = true;
							logLatency({
								type: "phase",
								filePath: "<pi-lens>",
								phase: "injected_finding_identity_cap",
								durationMs: 0,
								metadata: { cap: MAX_FINDING_IDENTITIES },
							});
						}
						continue;
					}
					state.findingIdentities.add(identity);
				}
			}
		}
		const messageCountCapped =
			existingMessages.length > MAX_REPORTED_MESSAGES ||
			resultMessages.length > MAX_REPORTED_MESSAGES;
		recordContextAttribution(
			attributionKey(args.sessionId, args.sessionRole),
			existingMessages,
			sizes,
		);
		state.sequenceHashTruncatedSinceLastUsage ||=
			beforeSequence.truncated ||
			beforeSequence.contentTruncated ||
			afterSequence.truncated ||
			afterSequence.contentTruncated;
		state.requestEvidenceIncompleteSinceLastUsage ||=
			beforeSequence.incomplete || afterSequence.incomplete;

		logLatency({
			type: "phase",
			filePath: "<pi-lens>",
			phase: "cache_context",
			durationMs: 0,
			metadata: {
				version: 1,
				observedStage: "pi-lens-context-handler",
				observationId: `ctx-${(++contextObservationCounter).toString(36)}`,
				sessionId: sessionKey(args.sessionId),
				sessionRole: args.sessionRole,
				...(args.sessionRole === "concurrent-secondary"
					? { turnScope: SECONDARY_TURN_SCOPE }
					: { turnIndex: args.turnIndex, turnScope: PROCESS_TURN_SCOPE }),
				injectionEnabled: args.injectionEnabled,
				injectionSources: sourceBreakdown.map((entry) => entry.source),
				injectionSourceBreakdown: sourceBreakdown,
				injectionOccurred: injectedMessages.length > 0,
				injectedMessageCount: Math.min(
					injectedMessages.length,
					MAX_REPORTED_MESSAGES,
				),
				injectedMessageCountCapped:
					injectedMessages.length > MAX_REPORTED_MESSAGES,
				injectedChars: sizes.chars,
				injectedBytes: sizes.bytes,
				injectedBytesBySource: Object.fromEntries(
					sourceBreakdown.map((entry) => [
						sourceKey(entry.source),
						entry.bytes,
					]),
				),
				injectedEstimatedTokens: estimateTokens(sizes.chars),
				injectedTokenBasis: "chars-per-token-4-estimate-not-provider-measured",
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
				beforeSequenceHash: beforeSequence.hash,
				afterSequenceHash: afterSequence.hash,
				sequenceHashTruncated:
					beforeSequence.truncated ||
					afterSequence.truncated ||
					beforeSequence.contentTruncated ||
					afterSequence.contentTruncated,
				sequenceMessageCountTruncated:
					beforeSequence.truncated || afterSequence.truncated,
				sequenceContentHashTruncated:
					beforeSequence.contentTruncated || afterSequence.contentTruncated,
				sequenceHashIncomplete:
					beforeSequence.incomplete || afterSequence.incomplete,
			},
		});
	} catch (err) {
		// The context event still occurred at request time. Preserve that clock but
		// fail the evidence closed so a later usage row cannot infer TTL/eviction
		// from an observation whose hashing/measurement never completed.
		try {
			const state = attributionFor(
				attributionKey(args.sessionId, args.sessionRole),
			);
			state.lastContextAtMs = Date.now();
			state.requestEvidenceIncompleteSinceLastUsage = true;
		} catch {
			// The outer contract is no-throw; there is no safe attribution key left.
		}
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
		// SAFETY: `usage` is verified non-null object above; widening to an
		// indexable record is only so the numeric-evidence readers can probe
		// each field defensively. Every read re-validates its own type.
		const usageRecord = usage as unknown as Record<string, unknown>;
		// #1071: attribute the shortfall in-process, from state this module already
		// keeps, so nothing re-reads latency.log.
		const stateKey = attributionKey(context?.sessionId, context?.sessionRole);
		const state = attributionFor(stateKey);
		const nowMs = Date.now();
		const gap = resolveInterTurnGap(state, nowMs);
		const interTurnGapMs = gap.gapMs;
		const ttlMs = getProviderCacheTtlMs();
		const inputEvidence = readNumericEvidence(usageRecord, "input");
		const outputEvidence = readNumericEvidence(usageRecord, "output");
		const cacheReadEvidence = readNumericEvidence(usageRecord, "cacheRead");
		const cacheWriteEvidence = readNumericEvidence(usageRecord, "cacheWrite");
		let costEvidence: NumericEvidence;
		try {
			const cost = usageRecord.cost;
			costEvidence =
				cost === undefined
					? { status: "absent" }
					: cost && typeof cost === "object"
						? readNumericEvidence(cost as Record<string, unknown>, "total")
						: { status: "malformed" };
		} catch {
			costEvidence = { status: "malformed" };
		}
		const usageEvidenceFields: ReadonlyArray<
			readonly [string, NumericEvidence]
		> = [
			["input", inputEvidence],
			["output", outputEvidence],
			["cacheRead", cacheReadEvidence],
			["cacheWrite", cacheWriteEvidence],
			["cost.total", costEvidence],
		];
		const malformedProviderUsageFields = usageEvidenceFields
			.filter(([, evidence]) => evidence.status === "malformed")
			.map(([field]) => field);
		const providerUsageMalformed = malformedProviderUsageFields.length > 0;
		const cacheRead = cacheReadEvidence.value;
		const priorCacheReadValue = readableTokenCount(state.lastCacheRead);
		// SAFETY: `msg` passed the AssistantMessageLike role check above; the
		// record view backs only the guarded identity-field probes below, each
		// re-validated by `identityEvidence` at its own boundary.
		const messageRecord = msg as unknown as Record<string, unknown>;
		const safeMessageField = (key: string): IdentityEvidence => {
			try {
				return identityEvidence(messageRecord[key]);
			} catch {
				return { status: "unavailable" };
			}
		};
		const currentProvider = safeMessageField("provider");
		const responseModel = safeMessageField("responseModel");
		const currentModel =
			responseModel.hash !== undefined
				? responseModel
				: safeMessageField("model");
		const modelProviderEvidenceAvailable = Boolean(
			currentProvider.hash &&
			currentModel.hash &&
			state.lastProviderIdentityHash &&
			state.lastModelIdentityHash,
		);
		const modelProviderChanged = Boolean(
			modelProviderEvidenceAvailable &&
			(currentProvider.hash !== state.lastProviderIdentityHash ||
				currentModel.hash !== state.lastModelIdentityHash),
		);
		const estimatedNewTokens = estimateTokens(
			state.injectedCharsSinceLastUsage +
				state.newTranscriptCharsSinceLastUsage,
		);
		const verdict = classifyCacheMiss({
			cacheRead,
			// Missing/malformed input cannot prove fresh-input pressure. The explicit
			// malformed gate below also keeps every heuristic fail-closed.
			input: inputEvidence.value ?? 0,
			priorCacheRead: priorCacheReadValue,
			interTurnGapMs,
			gapBasis: gap.basis,
			ttlMs,
			prefixBroke: state.prefixBrokeSinceLastUsage,
			prefixStable: state.prefixStableSinceLastUsage,
			sequenceHashTruncated: state.sequenceHashTruncatedSinceLastUsage,
			requestEvidenceIncomplete: state.requestEvidenceIncompleteSinceLastUsage,
			stableSessionIdentity: sessionKey(context?.sessionId) !== NO_SESSION_KEY,
			modelProviderChanged,
			modelProviderEvidenceAvailable,
			providerUsageMalformed,
			estimatedNewTokens,
			attributionCharsCapped: state.attributionCharsCapped,
		});
		const unknownReason: CacheMissUnknownReason | undefined =
			providerUsageMalformed
				? "malformed-provider-usage"
				: cacheRead === undefined
					? "cache-read-unavailable"
					: priorCacheReadValue === undefined && cacheRead === 0
						? "no-prior-sample"
						: verdict?.unknownReason;
		recordCacheUsageSummary({
			state,
			cacheRead,
			priorCacheRead: priorCacheReadValue,
			verdict,
			unknownReason,
		});
		const priorCacheRead = priorCacheReadValue ?? null;
		const injectedCharsSinceLastTurn = state.injectedCharsSinceLastUsage;
		const newTranscriptCharsSinceLastTurn =
			state.newTranscriptCharsSinceLastUsage;
		const attributionCharsCapped = state.attributionCharsCapped;
		const injectedBytes = {
			...state.injectedBytes,
			turnEndAdvisory:
				state.turnEndAdvisoryBytes + state.injectedBytes.turnEndAdvisory,
		};
		const injectedFindingsRepeated = state.injectedFindingsRepeated;
		// This record is the turn boundary: reset the per-turn accumulators and
		// re-arm the prefix-break flag so the next verdict describes the NEXT gap.
		state.lastUsageAtMs = nowMs;
		// A record whose `cacheRead` is absent or non-finite carries no baseline.
		// Clear the stored one rather than keeping it: the next turn's gap would be
		// one turn long while its baseline was two turns old, and a verdict built
		// on that mismatch is worse than no verdict (#1071 review round 1, F4).
		state.lastCacheRead = cacheRead;
		state.lastProviderIdentityHash = currentProvider.hash;
		state.lastModelIdentityHash = currentModel.hash;
		state.prefixBrokeSinceLastUsage = false;
		state.prefixStableSinceLastUsage = false;
		state.sequenceHashTruncatedSinceLastUsage = false;
		state.requestEvidenceIncompleteSinceLastUsage = false;
		state.injectedCharsSinceLastUsage = 0;
		state.newTranscriptCharsSinceLastUsage = 0;
		state.attributionCharsCapped = false;
		state.injectedBytes = emptyInjectedBytes();
		state.injectedFindingsRepeated = 0;
		state.turnEndAdvisoryBytes = 0;
		// Clear the request stamp too: the next turn measures from ITS request, and
		// a turn whose `context` call pi-lens never saw must fall back rather than
		// reuse this one.
		state.lastContextAtMs = undefined;
		logLatency({
			type: "phase",
			filePath: "<pi-lens>",
			phase: "cache_usage",
			durationMs: 0,
			metadata: {
				provider: currentProvider.display,
				model: currentModel.display,
				providerIdentityHash: currentProvider.hash,
				modelIdentityHash: currentModel.hash,
				providerIdentityStatus: currentProvider.status,
				modelIdentityStatus: currentModel.status,
				providerIdentityTruncated: currentProvider.status === "truncated",
				modelIdentityTruncated: currentModel.status === "truncated",
				cacheRead: cacheReadEvidence.value ?? null,
				cacheWrite: cacheWriteEvidence.value ?? null,
				input: inputEvidence.value ?? null,
				output: outputEvidence.value ?? null,
				// `Usage.cost` is a breakdown object; the total is the headline number.
				cost: costEvidence.value ?? null,
				providerUsageMalformedFields: malformedProviderUsageFields,
				// Idle milliseconds before this turn's request, or null for the first
				// record in the session. This is the field the 2026-08-21
				// investigation had to reconstruct by hand-joining timestamps.
				interTurnGapMs,
				gapBasis: gap.basis,
				// null means "nothing to explain", not "cause unknown"; `unknown` is
				// the explicit no-local-explanation verdict.
				cacheMissCause: verdict?.cause ?? null,
				cacheMissKind: verdict?.kind ?? null,
				cacheMissUnknownReason: unknownReason ?? null,
				modelProviderChanged,
				cacheTtlThresholdMs: ttlMs,
				priorCacheRead,
				injectedCharsSinceLastTurn,
				newTranscriptCharsSinceLastTurn,
				attributionCharsCapped,
				injectedBytes,
				injectedFindingsRepeated,
				...(context
					? {
							// MessageEndEvent has no request/context id in the host API. These
							// fields permit session correlation without inventing an exact
							// provider-request linkage. The process-global turn is omitted
							// for a concurrent secondary session.
							sessionId: sessionKey(context.sessionId),
							...(context.sessionRole === "concurrent-secondary"
								? { turnScope: SECONDARY_TURN_SCOPE }
								: {
										turnIndex: context.turnIndex,
										turnScope: PROCESS_TURN_SCOPE,
									}),
							contextCorrelation: context.sessionId
								? "session-only-no-request-id"
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
 * Bounded as insertion-ordered FIFO (evict oldest-inserted past the cap,
 * refreshed on every WRITE by {@link recordSessionHash}'s delete+set — a
 * plain read never reorders) so a long-lived process cycling through many
 * sessions can't grow this unbounded. Shares {@link MAX_TRACKED_SESSIONS}
 * with `attributionBySession` above.
 */
const prefixHashBySession = new BoundedFifoMap<string, string>(
	MAX_TRACKED_SESSIONS,
);

/**
 * Reported key used when no session id is available (undefined/empty). Internal
 * attribution additionally separates primary and concurrent-secondary roles;
 * neither role may overwrite the other's baseline when stable identity is
 * absent.
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
 * parent and subagent onto one baseline.) If the host does NOT supply a stable
 * id, primary and secondary roles still use separate fallback buckets, but
 * multiple same-role sessions cannot be correlated. Miss attribution therefore
 * fails closed with `request-correlation-unavailable`.
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
		const key = attributionKey(sessionId, sessionRole);
		const reportedSessionId = sessionKey(sessionId);
		const currentHash = hashFirstMessage(first);
		const previousHash = prefixHashBySession.get(key);
		const state = attributionFor(key);
		if (previousHash === undefined) {
			// Baseline: record this session's starting prefix so a later break has a
			// reference point in the log. `previousHash: null` marks the baseline.
			recordSessionHash(key, currentHash);
			state.prefixStableSinceLastUsage = true;
			logLatency({
				type: "phase",
				filePath: "<pi-lens>",
				phase: "cache_prefix_break",
				durationMs: 0,
				metadata: {
					...(sessionRole === "concurrent-secondary"
						? { turnScope: SECONDARY_TURN_SCOPE }
						: { turnIndex, turnScope: PROCESS_TURN_SCOPE }),
					previousHash: null,
					currentHash,
					baseline: true,
					sessionId: reportedSessionId,
					sessionRole,
				},
			});
			return "baseline";
		}
		if (currentHash !== previousHash) {
			// #1071: arm the direct-cause flag the next `cache_usage` verdict reads.
			// A locally observed prefix change outranks the timing heuristics.
			state.prefixBrokeSinceLastUsage = true;
			state.prefixStableSinceLastUsage = false;
			logLatency({
				type: "phase",
				filePath: "<pi-lens>",
				phase: "cache_prefix_break",
				durationMs: 0,
				metadata: {
					...(sessionRole === "concurrent-secondary"
						? { turnScope: SECONDARY_TURN_SCOPE }
						: { turnIndex, turnScope: PROCESS_TURN_SCOPE }),
					previousHash,
					currentHash,
					sessionId: reportedSessionId,
					sessionRole,
				},
			});
		}
		if (currentHash === previousHash) {
			state.prefixStableSinceLastUsage = true;
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
 * Drop a single session's prefix baseline and attribution state. Called from
 * both role-specific `session_shutdown` paths so an ended conversation is
 * reclaimed promptly rather than only when the LRU evicts it. Idempotent and
 * never throws.
 */
export function clearCachePrefixSession(
	sessionId?: string,
	sessionRole?: "primary" | "concurrent-secondary",
): void {
	const key = attributionKey(sessionId, sessionRole);
	prefixHashBySession.delete(key);
	// The miss-attribution state has the same lifetime and the same reason to be
	// reclaimed at session end; leaving it would let a reused session id inherit
	// a stale gap baseline and a stale prefix-break flag.
	attributionBySession.delete(key);
}

/** Record the exact quiet-window summary content handed to pi.sendMessage. */
export function recordTurnEndAdvisoryBytes(
	sessionId: string | undefined,
	bytes: number,
	sessionRole: "primary" | "concurrent-secondary" = "primary",
): void {
	const state = attributionFor(attributionKey(sessionId, sessionRole));
	state.turnEndAdvisoryBytes = Math.min(
		MAX_INJECTED_BYTES,
		state.turnEndAdvisoryBytes + Math.max(0, bytes),
	);
}

/**
 * Emit one bounded session summary and retire its attribution state. The
 * summary contains fixed-key counters only; it never serializes transcript or
 * context content. A session with no usage records emits nothing.
 */
export function emitCacheUsageSummaryAtSessionEnd(
	sessionId?: string,
	sessionRole?: "primary" | "concurrent-secondary",
): void {
	const key = attributionKey(sessionId, sessionRole);
	const state = attributionBySession.get(key);
	if (!state || state.summary.usageRecords === 0) return;
	logLatency({
		type: "phase",
		filePath: "<pi-lens>",
		phase: "cache_usage_summary",
		durationMs: 0,
		metadata: {
			version: 1,
			sessionId: sessionKey(sessionId),
			sessionRole,
			usageRecords: state.summary.usageRecords,
			cacheHits: state.summary.cacheHits,
			missObservations: state.summary.missObservations,
			cacheMissCauses: { ...state.summary.cacheMissCauses },
			unknownEvidenceReasons: {
				...state.summary.unknownEvidenceReasons,
			},
		},
	});
	attributionBySession.delete(key);
}

/**
 * Clear all per-session prefix hashes and miss-attribution state. For tests and
 * session boundaries. Both maps are cleared together so a test can never start
 * with a half-reset session.
 */
export function resetCachePrefixObservation(): void {
	prefixHashBySession.clear();
	attributionBySession.clear();
}

export function resetCacheFindingIdentitiesSession(
	sessionId?: string,
	sessionRole?: "primary" | "concurrent-secondary",
): void {
	const state = attributionBySession.get(attributionKey(sessionId, sessionRole));
	if (!state) return;
	state.findingIdentities.clear();
	state.findingIdentityCapRecorded = false;
}

export function _attributionBySessionHasForTests(key: string): boolean {
	return attributionBySession.has(key);
}
export function _prefixHashBySessionHasForTests(key: string): boolean {
	return prefixHashBySession.has(key);
}
/** #2442 test-only: drive attributionFor's fetch-or-create touch directly
 *  (every call refreshes LRU recency, matching production — see
 *  attributionFor's own doc comment). */
export function _touchAttributionForTests(key: string): void {
	attributionFor(key);
}
/** #2442 test-only: drive recordSessionHash's write-refresh directly. */
export function _recordSessionHashForTests(key: string, hash: string): void {
	recordSessionHash(key, hash);
}
/**
 * #2442 test-only: the exact `prefixHashBySession.get(key)` that
 * `observeCachePrefix` performs to fetch a session's previous hash. A
 * `.has()` reorders nothing on either bounded class, so only a real `get`
 * can pin FIFO-vs-LRU behavior (#2442 review F4).
 */
export function _prefixHashBySessionGetForTests(
	key: string,
): string | undefined {
	return prefixHashBySession.get(key);
}
