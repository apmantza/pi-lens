/**
 * Retained context injections (#4743, opt-in `--lens-retain-injections`).
 *
 * pi rebuilds every provider request from its own transcript, and pi-lens's
 * findings ride ONE request: `context_with_system` returns an amended copy and
 * pi's stored messages never change. Request N+1 therefore no longer carries
 * N's injection where it sat, so it is not "N plus new content" and an engine
 * that caches by exact prefix (a local llama.cpp or Qwen server, measured at
 * a ~165k-token re-process per injection) loses everything after that point.
 *
 * The ledger keeps, per session, the rendered bytes each request injected and
 * where they sat, and re-sends them unchanged on later requests. Delivery is
 * untouched: findings are still consumed once, by the request that first
 * carries them. A retained entry is rendered text only; re-sending it reads
 * and writes no cache record.
 *
 * Invariants (the state table is in the #4743 PR body):
 *
 * - An entry is anchored to one message of pi's own transcript by its index
 *   and the rolling digest of the transcript up to it. It is re-sent only
 *   while that digest still matches; any other transcript (a compaction, a
 *   /tree move, another extension's rewrite) deletes it for good.
 * - The partition is the request ctx's stable session id. No id, no entry.
 * - Bounded: {@link MAX_RETAINED_ENTRIES} entries and
 *   {@link MAX_RETAINED_BYTES} rendered bytes per session, and
 *   {@link MAX_RETAINED_SESSIONS} sessions (LRU). At a cap the NEW injection
 *   is delivered once, as without the flag, and not retained: the prefix then
 *   breaks at the newest point, the cheapest one.
 * - Each decline records one `context-injection-retain-declined` degradation
 *   per session and reason.
 */
import { BoundedLruCache } from "./bounded-cache.js";
import {
	type RollingDigests,
	rollingDigestAt,
	rollingMessageDigests,
} from "./cache-observability.js";
import { recordDegradationOnce } from "./degradation-ledger.js";
import { resolveLensToolName } from "./tool-config.js";

export const MAX_RETAINED_ENTRIES = 64;
export const MAX_RETAINED_BYTES = 256 * 1024;
export const MAX_RETAINED_SESSIONS = 32;

/** One message of a provider request, as pi's request hooks carry it. */
export type LedgerMessage = { role: string; content: unknown };

/** Appends injected text to a user prompt's content (index.ts owns the rule). */
export type AppendToUserContent = (
	content: string | unknown[],
	text: string,
) => string | unknown[];

type DeclineReason =
	| "entry-cap"
	| "byte-cap"
	| "no-session-id"
	| "transcript-not-hashable";

type RetainedEntry =
	| {
			kind: "user-text";
			anchor: number;
			prefixDigest: string;
			text: string;
			bytes: number;
	  }
	| {
			kind: "after";
			anchor: number;
			prefixDigest: string;
			messages: ReadonlyArray<LedgerMessage>;
			bytes: number;
	  };

/** What one request's rebuild did, and how to retain its new injection. */
export interface LedgerRebuild {
	/** pi's transcript with every still-valid entry re-applied. */
	readonly messages: LedgerMessage[];
	/** Positions where a re-sent span begins (for the divergence record). */
	readonly retainedPositions: readonly number[];
	readonly reemitted: number;
	readonly reemittedBytes: number;
	readonly pruned: number;
	/** Set when the rebuild could not verify the transcript. */
	readonly declined?: DeclineReason;
	/**
	 * #5240: true when a still-valid retained entry already carries `text`, so
	 * a repeat of it adds nothing a later request does not already re-send.
	 */
	holds(text: string): boolean;
	/**
	 * Add this request's NEW injection, anchored at pi's last transcript
	 * message. Returns the decline reason when it was not retained.
	 */
	retain(
		injection:
			| { kind: "user-text"; text: string }
			| { kind: "after"; messages: ReadonlyArray<LedgerMessage> },
	): DeclineReason | undefined;
}

export interface InjectionLedger {
	/**
	 * Re-apply `sessionId`'s entries to pi's own transcript `raw` (never
	 * mutated). A missing id returns `raw` with a retain that declines.
	 */
	rebuild(
		sessionId: string | undefined,
		raw: ReadonlyArray<LedgerMessage>,
		appendToUserContent: AppendToUserContent,
	): LedgerRebuild;
	/** Forget a session's entries (context injection switched off). */
	clearSession(sessionId: string | undefined): void;
	/** Entries held for a session (test and record seam). */
	size(sessionId: string): number;
}

/**
 * The line every retained injection carries in its ORIGINAL bytes, so the
 * model reading it on a later request knows it is a snapshot.
 */
export function retainedSnapshotLabel(): string {
	const tool = resolveLensToolName("lens_diagnostics", "pi");
	return `[pi-lens snapshot: these findings are as of this turn and repeat unchanged in later requests; ${tool} shows the current state.]`;
}

function textBytes(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

function messagesBytes(messages: ReadonlyArray<LedgerMessage>): number {
	let bytes = 0;
	for (const message of messages)
		bytes += textBytes(
			typeof message.content === "string"
				? message.content
				: (JSON.stringify(message.content) ?? ""),
		);
	return bytes;
}

function recordDecline(sessionId: string, reason: DeclineReason): void {
	// One row per session and reason: the ledger's once-keys reset at the
	// primary session boundary, and the subject carries the session id.
	recordDegradationOnce({
		kind: "context-injection-retain-declined",
		subject: `${reason}:${sessionId}`,
		reason: `retained context injection declined (${reason}); the injection reached one request only`,
		metadata: { reason, sessionId },
	});
}

export function createInjectionLedger(): InjectionLedger {
	const sessions = new BoundedLruCache<string, RetainedEntry[]>(
		MAX_RETAINED_SESSIONS,
	);

	const noSession = (raw: ReadonlyArray<LedgerMessage>): LedgerRebuild => ({
		messages: raw as LedgerMessage[],
		retainedPositions: [],
		reemitted: 0,
		reemittedBytes: 0,
		pruned: 0,
		holds: () => false,
		retain: () => {
			recordDecline("<no-session>", "no-session-id");
			return "no-session-id";
		},
	});

	const rebuild = (
		sessionId: string | undefined,
		raw: ReadonlyArray<LedgerMessage>,
		appendToUserContent: AppendToUserContent,
	): LedgerRebuild => {
		if (!sessionId) return noSession(raw);
		const held = sessions.get(sessionId) ?? [];
		let digests: RollingDigests | undefined;
		const rawDigests = (): RollingDigests => {
			digests ??= rollingMessageDigests(raw);
			return digests;
		};
		let declined: DeclineReason | undefined;
		let valid: RetainedEntry[] = [];
		if (held.length > 0) {
			if (rawDigests().complete) {
				for (const entry of held)
					if (
						rollingDigestAt(rawDigests(), entry.anchor) === entry.prefixDigest
					)
						valid.push(entry);
			} else {
				// Nothing can be verified, so nothing is re-sent, and entries that
				// cannot be re-sent here can never line up again.
				declined = "transcript-not-hashable";
				recordDecline(sessionId, declined);
			}
		}
		const pruned = held.length - valid.length;
		if (pruned > 0) {
			if (valid.length > 0) sessions.set(sessionId, valid);
			else sessions.delete(sessionId);
		}

		const byAnchor = new Map<number, RetainedEntry[]>();
		for (const entry of valid) {
			const list = byAnchor.get(entry.anchor);
			if (list) list.push(entry);
			else byAnchor.set(entry.anchor, [entry]);
		}
		// Nothing to re-send: hand pi's own list back, so the caller can tell
		// "unchanged" by identity and contribute nothing.
		const messages: LedgerMessage[] =
			valid.length === 0 ? (raw as LedgerMessage[]) : [];
		const retainedPositions: number[] = [];
		let reemittedBytes = 0;
		if (valid.length > 0)
			raw.forEach((message, index) => {
				const entries = byAnchor.get(index);
				if (!entries) {
					messages.push(message);
					return;
				}
				let content = message.content;
				let extended = false;
				for (const entry of entries) {
					if (entry.kind !== "user-text") continue;
					content = appendToUserContent(
						content as string | unknown[],
						entry.text,
					);
					extended = true;
					reemittedBytes += entry.bytes;
				}
				if (extended) retainedPositions.push(messages.length);
				// Copy on write: pi's own message object is never changed.
				messages.push(extended ? { ...message, content } : message);
				for (const entry of entries) {
					if (entry.kind !== "after") continue;
					retainedPositions.push(messages.length);
					messages.push(...structuredClone(entry.messages));
					reemittedBytes += entry.bytes;
				}
			});

		const retain: LedgerRebuild["retain"] = (injection) => {
			const anchor = raw.length - 1;
			const prefixDigest = rollingDigestAt(rawDigests(), anchor);
			if (prefixDigest === undefined) {
				const reason = "transcript-not-hashable";
				recordDecline(sessionId, reason);
				return reason;
			}
			const current = sessions.get(sessionId) ?? [];
			const bytes =
				injection.kind === "user-text"
					? textBytes(injection.text)
					: messagesBytes(injection.messages);
			const reason: DeclineReason | undefined =
				current.length >= MAX_RETAINED_ENTRIES
					? "entry-cap"
					: current.reduce((sum, entry) => sum + entry.bytes, 0) + bytes >
						  MAX_RETAINED_BYTES
						? "byte-cap"
						: undefined;
			if (reason) {
				recordDecline(sessionId, reason);
				return reason;
			}
			const entry: RetainedEntry =
				injection.kind === "user-text"
					? {
							kind: "user-text",
							anchor,
							prefixDigest,
							text: injection.text,
							bytes,
						}
					: {
							kind: "after",
							anchor,
							prefixDigest,
							messages: structuredClone(injection.messages),
							bytes,
						};
			sessions.set(sessionId, [...current, entry]);
			return undefined;
		};

		const holds: LedgerRebuild["holds"] = (text) =>
			valid.some((entry) =>
				entry.kind === "user-text"
					? entry.text.includes(text)
					: entry.messages.some(
							(message) =>
								typeof message.content === "string" &&
								message.content.includes(text),
						),
			);

		return {
			messages,
			retainedPositions,
			reemitted: valid.length,
			reemittedBytes,
			pruned,
			...(declined ? { declined } : {}),
			holds,
			retain,
		};
	};

	return {
		rebuild,
		clearSession: (sessionId) => {
			if (sessionId) sessions.delete(sessionId);
		},
		size: (sessionId) => sessions.get(sessionId)?.length ?? 0,
	};
}
