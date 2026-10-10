/**
 * Registered-or-fail sweep: every `pi.on(...)` registration in `index.ts`
 * either goes through the central stale-ctx wrapper, or names the reason it
 * does not (#1925).
 *
 * #1924 guarded `agent_settled` inline. #1925 found four siblings with the
 * same shape, because nothing forced the next handler author to think about
 * an invalidated ctx. Prose in a module doc cannot force it; this sweep can.
 * A NEW `pi.on` registration now reds until its author either wraps it or
 * writes down why the handler cannot be reached by a dead ctx.
 *
 * The scan is CALL-SHAPED (the #1692 lesson, via `tests/support/sweep-kit.ts`).
 * It strips comments, finds `on("<event>"` and `on?.("<event>"` calls, reads
 * their balanced argument text, and asks whether that text wraps the SAME
 * event name. A copy-pasted wrapper naming a different event would mislabel
 * the ledger subject, so it fails too.
 *
 * The declared floor of 12 is the second half of the emptiness guard. index.ts
 * registers 12 handlers today. A regex that stops matching one of them, the
 * way the first draft missed the `on?.()` form, drops the count and reds here
 * instead of quietly excusing the handler it can no longer see.
 *
 * #1929 moved `session_start` and `context` out of the exemption table and into
 * the wrapper, so seven registrations are wrapped and five carry a reason. The
 * registration count is unchanged: neither handler was added or removed.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
	assertNonEmptyScan,
	auditRegistry,
	matchingCloseIndex,
	stripSource,
} from "../support/sweep-kit.js";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

/**
 * Handlers that deliberately stay unwrapped, each with the mechanism that
 * makes a stale ctx a non-event for it. An exemption whose site stops
 * matching is reported as stale, so a deleted or migrated handler cannot
 * leave a lie behind.
 */
const UNWRAPPED_HANDLER_REASONS: Readonly<Record<string, string>> = {
	resources_discover:
		"The handler takes `_event, _ctx` and reads neither, so there is no accessor for the SDK to invalidate.",
	tool_execution_end:
		"The handler takes only the event and reads no ctx property: it releases a read capture by the event's own call id (#4185 round 4), so there is no accessor for the SDK to invalidate.",
	tool_call:
		"Delegates straight to handleToolCall, which already owns a total guard recording `tool-call-handler-throw` (clients/runtime-tool-call.ts); the registration body itself reads no ctx property.",
	session_shutdown:
		"The stable-id read is inside a try/catch; activation-owned role decides every post-start shutdown, and the pre-start fallback remains behind noteSessionShutdown's probe. A known secondary returns before shared teardown, while an inconclusive pre-start fallback still tears down to avoid leaking the LSP fleet.",
	message_end:
		"The handler body is a total try/catch, and its only ctx reader is getStableSessionId (its own try/catch); activation-owned role classification reads closure state and its pre-session fallback is probe-based. Nothing throws and nothing is skipped: a stale ctx degrades the cache_usage row to an unattributed sessionId instead. Wrapping it would DROP a row whose `message` payload is still valid, so the handler records the attribution loss as a bounded `cache-usage-attribution-stale` ledger entry (subject `message_end`) when `probeCtxActive` confirms the stale ctx, while the row keeps writing. (#1956)",
};

/** One `pi.on("<event>", ...)` registration found in index.ts. */
interface Registration {
	event: string;
	line: number;
	wrapped: boolean;
}

/**
 * Argument text between `(` at `openIndex` and its matching `)` — or, when
 * unbalanced, the rest of `source` from just past `openIndex`. #3134: the
 * depth count is `sweep-kit.ts`'s `matchingCloseIndex`; the
 * unbalanced-to-rest-of-source fallback stays local, byte-for-byte the same
 * copy `bounded-telemetry-scan.ts` carries.
 */
function readBalancedArgs(source: string, openIndex: number): string {
	const close = matchingCloseIndex(source, openIndex, "(", ")");
	return close === -1
		? source.slice(openIndex + 1)
		: source.slice(openIndex + 1, close);
}

function scanRegistrations(): Registration[] {
	// Strings kept: the event name IS a string literal, so blanking contents
	// would blind the scan to the very thing it reads.
	const source = stripSource(
		fs.readFileSync(path.join(REPO_ROOT, "index.ts"), "utf8"),
		{ strings: "keep" },
	);
	const found: Registration[] = [];
	// The optional-call form matters, not just `on(`. index.ts registers newer
	// host events as `(pi as any).on?.("message_end", …)`, and the comment above
	// that site recommends the idiom for the next one. A scan that only saw
	// `on(` would let every future defensive registration through unseen, which
	// is the exact gap this sweep exists to close.
	const opener = /(?<![A-Za-z0-9_$])on\s*(?:\?\.)?\s*\(\s*"([a-z_]+)"/g;
	let match = opener.exec(source);
	while (match !== null) {
		const event = match[1];
		const args = readBalancedArgs(source, source.indexOf("(", match.index));
		found.push({
			event,
			line: source.slice(0, match.index).split("\n").length,
			// The wrapper must name the SAME event, or the ledger subject lies.
			// Both entry points count (#1929): `wrapSessionEventHandlerWithResult`
			// is the same policy with a stated stale-path value, for a handler
			// whose return the host consumes. Matched with a regex rather than a
			// substring because the formatter puts the event name on its own line
			// once the call gets long enough.
			wrapped: new RegExp(
				`wrapSessionEventHandler(?:WithResult)?\\s*\\(\\s*"${event}"`,
			).test(args),
		});
		match = opener.exec(source);
	}
	return found;
}

describe("session-event stale-ctx guard sweep (#1925)", () => {
	const registrations = scanRegistrations();

	it("finds the real registrations, so a broken scan cannot pass vacuously", () => {
		assertNonEmptyScan(
			"session-event registration scan",
			registrations.length,
			12,
		);
		expect(registrations.map((entry) => entry.event)).toContain("turn_end");
	});

	it("every pi.on registration is wrapped or has a stated reason", () => {
		const audit = auditRegistry({
			sweepName: "session-event stale-ctx guard sweep",
			flagged: registrations
				.filter((entry) => !entry.wrapped)
				.map((entry) => entry.event),
			registered: registrations
				.filter((entry) => entry.wrapped)
				.map((entry) => entry.event),
			exemptions: UNWRAPPED_HANDLER_REASONS,
			scannedCount: registrations.length,
			minScanned: 12,
			remediation:
				"Wrap it with wrapSessionEventHandler(<event>, handler, { dbg }) from clients/session-event-guard.ts — or wrapSessionEventHandlerWithResult(<event>, handler, { dbg, onStaleResult }) when the host consumes the handler's return value — or add the event to UNWRAPPED_HANDLER_REASONS with the mechanism that makes a stale ctx unreachable for it.",
		});
		expect(audit.problems).toEqual([]);
	});

	it("keeps the seven known-reachable handlers wrapped", () => {
		// The population #1925 fixed plus the two #1929 added, pinned by name: an
		// unwrap shows up here even if someone also adds a reason for it.
		const wrapped = new Set(
			registrations
				.filter((entry) => entry.wrapped)
				.map((entry) => entry.event),
		);
		for (const event of [
			"tool_result",
			"turn_start",
			"agent_end",
			"turn_end",
			"agent_settled",
			"session_start",
			"context",
		]) {
			expect(wrapped, `${event} lost its stale-ctx wrapper`).toContain(event);
		}
	});
});
