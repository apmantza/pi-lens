/**
 * Slice 7 of #4632: the `turn_end` smells cadence on the REAL host.
 *
 * Moved from `tests/index-smells-rollup-wiring.test.ts` (all 5 cases). The
 * claim is an ORDERING one: `turn_end` re-checks the bounded smell tail-scan at
 * most once per `SMELLS_TURN_CHECK_INTERVAL` turns, and each smell notifies the
 * user at most once per session. The double could only assert that a mocked
 * `countRecentSmells` had been CALLED with the session's start time; a case
 * here seeds the copy's own `<PI_LENS_HOME>/bus-events.log` and reads the
 * notification the copy asked pi's UI to show (`PiSessionOptions.captureUi`),
 * so the interval, the threshold, the session boundary and the once-per-session
 * gate are all observed end to end.
 *
 * The two logs are the only input: `clients/smells-rollup.ts` reads a bounded
 * tail of `bus-events.log` (stale-ctx `emit_failed`) and `latency.log`
 * (opengrep respawns), admits a row only when its own `ts` is at or after the
 * session start, and notifies only at or above `SMELLS_THRESHOLDS`. A case
 * therefore writes real rows in the shape the real producers write, and never
 * substitutes a counter.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type { BusEventLogEntry } from "../clients/bus-event-rollup.js";
import { endTurn } from "./support/pi-session-commit-gate.js";
import {
	type PiFauxReply,
	type PiNotification,
	piSessionFixture,
	startPiSession,
} from "./support/pi-session.js";

const fixture = piSessionFixture();

/** The copy's own log directory: `getGlobalPiLensLogDir()` under a pinned home. */
const logDir = path.join(fixture.root, "home");
const BUS_EVENTS = path.join(logDir, "bus-events.log");

/**
 * One `bus-events.log` row, in the shape `logBusEvent`
 * (`clients/live-bus-emitter.ts`) writes when a producer's publish throws the
 * SDK's stale-ctx error (for example `clients/bus-publish.ts`'s `catch`).
 * `event`, `outcome` and `cwd` are required by `BusEventLogEntry`; `error` and
 * `ctxSource` are the emit_failed detail.
 */
function staleCtxRow(at: number, cwd: string): string {
	// Typed as the writer's own record: a field `BusEventLogEntry` gains (or the
	// rollup starts reading) reds this fixture at `npm run lint` instead of
	// leaving a row shape the real producers never write.
	const row: BusEventLogEntry & { error: string } = {
		ts: new Date(at).toISOString(),
		event: "pilens:files:touched",
		outcome: "emit_failed",
		cwd,
		error:
			"This extension ctx is stale after session replacement or reload (assertActive)",
		ctxSource: "global-fallback",
	};
	return `${JSON.stringify(row)}\n`;
}

/** Append `count` rows stamped `stamp` to the copy's bus-events log. */
function seedRows(count: number, stamp: number, cwd: string): void {
	fs.mkdirSync(logDir, { recursive: true });
	fs.appendFileSync(BUS_EVENTS, staleCtxRow(stamp, cwd).repeat(count));
}

function smellNotes(
	notifications: readonly PiNotification[],
): PiNotification[] {
	return notifications.filter((entry) =>
		entry.message.startsWith("pi-lens smell:"),
	);
}

/**
 * Drive `count` real turns and return the notification the smells rollup
 * raised, if any. Every turn is a prompt with a text-only reply, so no tool
 * runs and nothing but the cadence decides whether the rollup fires.
 */
async function driveTurns(
	slug: string,
	count: number,
	seed: { rows: number; stamp: "fresh" | "before-session" },
): Promise<readonly PiNotification[]> {
	const cwd = path.join(fixture.root, slug, "proj");
	const responses: PiFauxReply[] = Array.from({ length: count }, (_, index) =>
		endTurn(`turn ${index + 1}`),
	);
	const handle = await startPiSession({
		root: fixture.root,
		cwd,
		captureUi: true,
		responses,
	});
	// Seeded AFTER the session started, so a "fresh" row is genuinely inside
	// this session's window while an old one is inside the 24h fallback only —
	// which is exactly the difference the S3c case pins.
	seedRows(
		seed.rows,
		seed.stamp === "fresh" ? Date.now() : Date.now() - 60 * 60_000,
		cwd,
	);
	for (let index = 0; index < count; index += 1) {
		await handle.prompt(`turn ${index + 1}`);
	}
	const notes = smellNotes(handle.notifications);
	// A tui notify renders; a suppressed one would have logged instead, and the
	// recorder would stay empty — so an empty list here is a real absence.
	expect(handle.errors, "every handler resolved").toEqual([]);
	return notes;
}

describe("turn_end smells cadence on the real host (#1123 item 3)", () => {
	it("checks nothing before the interval (turn 19)", async () => {
		const notes = await driveTurns("before-interval", 19, {
			rows: 99,
			stamp: "fresh",
		});
		expect(notes).toEqual([]);
	}, 180_000);

	it("notifies once when a smell is at/above threshold on the check turn (20)", async () => {
		const notes = await driveTurns("check-turn", 20, {
			rows: 5,
			stamp: "fresh",
		});
		expect(notes).toHaveLength(1);
		expect(notes[0]?.message).toContain("stale-ctx emit_failed");
		expect(notes[0]?.type).toBe("warning");
	}, 180_000);

	it("admits a row by the session start, not the 24h fallback", async () => {
		// The row is real, over the threshold and inside the rolling window; only
		// its timestamp is older than this session. The 24h fallback would notify.
		const notes = await driveTurns("session-boundary", 20, {
			rows: 5,
			stamp: "before-session",
		});
		expect(notes).toEqual([]);
	}, 180_000);

	it("does not notify again on turn 40 for a smell already notified this session", async () => {
		const notes = await driveTurns("once-per-session", 40, {
			rows: 5,
			stamp: "fresh",
		});
		expect(notes).toHaveLength(1);
	}, 240_000);

	it("does not notify when every count stays below threshold", async () => {
		const notes = await driveTurns("below-threshold", 20, {
			rows: 1,
			stamp: "fresh",
		});
		expect(notes).toEqual([]);
	}, 180_000);
});
