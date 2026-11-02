import { installBusSinkReader } from "../support/bus-sink-reader.js";
import {
	createBusPublisher,
	createLiveBusEmitter,
} from "../../clients/live-bus-emitter.js";
import { afterEach, describe, expect, it } from "vitest";
import {
	emitBusEventRollupAtSessionEnd,
	getBusEventRollupCounts,
	resetBusEventRollupCounts,
} from "../../clients/bus-event-rollup.js";

const { latencyRows } = installBusSinkReader();

// Exercise the private writer through its real publish owner, never a writer double.
function publish(entry: {
	event: "pilens:files:touched" | "pilens:diagnostics";
	outcome: string;
	cwd: string;
	level?: string;
	error?: string;
}) {
	const emitter = createLiveBusEmitter();
	if (entry.outcome === "skipped_stale_session") {
		emitter.wireGetter(() => ({
			emit: () => {},
			ctx: {
				isIdle: () => {
					throw new Error(
						"This extension ctx is stale after session replacement",
					);
				},
			},
		}));
	} else if (entry.outcome !== "skipped_unwired") {
		emitter.wire(() => {
			if (entry.outcome === "emit_failed") throw new Error(entry.error);
		});
	}
	createBusPublisher(emitter, { module: "rollup-test" }).publish({
		event: entry.event,
		cwd: entry.cwd,
		enabled: entry.outcome !== "skipped_disabled",
		build: () => ({}),
	});
}

// S2d (gap 5, #1432 review): a session-end rollup — {emitted,
// skipped_stale_session, emit_failed} per event name — counted at this
// shared seam (every producer + resolveLiveBusEmitter's own
// skipped_stale_session write go through `logBusEvent`) rather than
// instrumenting each producer individually.
describe("bus-event-rollup session-end rollup (S2d gap 5, #1432 review)", () => {
	afterEach(() => {
		resetBusEventRollupCounts();
	});

	it("counts emitted, skipped_stale_session, and emit_failed per event name", () => {
		publish({
			event: "pilens:files:touched",
			outcome: "emitted",
			cwd: "/repo",
		});
		publish({
			event: "pilens:files:touched",
			outcome: "emitted",
			cwd: "/repo",
		});
		publish({
			event: "pilens:files:touched",
			outcome: "skipped_stale_session",
			level: "info",
			cwd: "/repo",
		});
		publish({
			event: "pilens:diagnostics",
			outcome: "emit_failed",
			cwd: "/repo",
			error: "boom",
		});

		expect(getBusEventRollupCounts()).toEqual({
			"pilens:files:touched": {
				emitted: 2,
				skipped_stale_session: 1,
				emit_failed: 0,
			},
			"pilens:diagnostics": {
				emitted: 0,
				skipped_stale_session: 0,
				emit_failed: 1,
			},
		});
	});

	it("ignores outcomes outside the three rolled-up ones", () => {
		publish({
			event: "pilens:files:touched",
			outcome: "skipped_unwired",
			cwd: "/repo",
		});
		publish({
			event: "pilens:files:touched",
			outcome: "skipped_disabled",
			cwd: "/repo",
		});

		expect(getBusEventRollupCounts()).toEqual({});
	});

	it("resetBusEventRollupCounts clears the rollup", () => {
		publish({
			event: "pilens:files:touched",
			outcome: "emitted",
			cwd: "/repo",
		});
		expect(getBusEventRollupCounts()).not.toEqual({});
		resetBusEventRollupCounts();
		expect(getBusEventRollupCounts()).toEqual({});
	});

	it("emitBusEventRollupAtSessionEnd logs one row per active event name, then resets", async () => {
		publish({
			event: "pilens:files:touched",
			outcome: "emitted",
			cwd: "/repo",
		});
		publish({
			event: "pilens:diagnostics",
			outcome: "emit_failed",
			cwd: "/repo",
			error: "x",
		});

		emitBusEventRollupAtSessionEnd("/repo");
		expect(
			(await latencyRows())
				.filter((row) => row.phase === "session_end_bus_rollup")
				.map((row) => row.metadata),
		).toEqual([
			{
				event: "pilens:files:touched",
				emitted: 1,
				skipped_stale_session: 0,
				emit_failed: 0,
			},
			{
				event: "pilens:diagnostics",
				emitted: 0,
				skipped_stale_session: 0,
				emit_failed: 1,
			},
		]);
		expect(getBusEventRollupCounts()).toEqual({});
	});

	it("logs nothing when nothing was published this session (no-noise shape)", async () => {
		// Sanity: resetBusEventRollupCounts leaves an empty map, and
		// emitBusEventRollupAtSessionEnd iterates it — zero entries means zero
		// logLatency calls from THIS function (other subsystems may still log
		// independently, so assert on the rollup phase specifically).
		emitBusEventRollupAtSessionEnd("/repo");
		expect(
			(await latencyRows()).filter(
				(row) => row.phase === "session_end_bus_rollup",
			),
		).toEqual([]);
	});
});
