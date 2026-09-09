/**
 * Shared builder for the session-start payload pi-lens's tests fire through
 * `PiMock.emit(eventName, payload, ctx)` — #1681 acceptance criterion 3.
 *
 * The builder's field set is derived from the pinned host contract (see
 * `host-event-shape-scan.ts`'s doc comment for the file:line citations into
 * `packages/coding-agent/src/core/extensions/types.ts`), so a call site that
 * only ever goes through these cannot drift into a host-unfaithful shape.
 * These are optional, not mandatory: existing tests may keep constructing a
 * payload literal by hand (the scan in `host-event-shape-scan.ts` still
 * catches a drift either way), but a suite should prefer this over a
 * hand-rolled literal.
 *
 * `sessionId`/`provider`/`model` are deliberately not parameters here — the
 * host never puts them on this event. A test that needs one
 * passes it to `makeCtx({ sessionId, model })` (`tests/support/pi-mock.ts`)
 * instead, which is where the host actually carries it.
 */

export interface SessionStartEventFixture {
	reason: "startup" | "reload" | "new" | "resume" | "fork";
	previousSessionFile?: string;
}

/** `SessionStartEvent` — `types.ts:561-568`. Defaults to a fresh "startup". */
export function makeSessionStartEvent(
	overrides: Partial<SessionStartEventFixture> = {},
): SessionStartEventFixture {
	const event: SessionStartEventFixture = {
		reason: overrides.reason ?? "startup",
	};
	if (overrides.previousSessionFile !== undefined) {
		event.previousSessionFile = overrides.previousSessionFile;
	}
	return event;
}
