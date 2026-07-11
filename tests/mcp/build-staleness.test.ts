/**
 * Warm-build staleness detection (#535) — pure/unit-testable via an injected
 * stat function, no real filesystem or build involved.
 */

import { describe, expect, it } from "vitest";
import {
	checkStaleness,
	computeBuildStamp,
	StalenessGate,
	stalenessCheckEnabled,
	type StatFn,
} from "../../mcp/build-staleness.js";

function fakeStat(mtimeMs: number | undefined): StatFn {
	return () => (mtimeMs === undefined ? undefined : { mtimeMs });
}

describe("computeBuildStamp", () => {
	it("captures the entry path and mtime", () => {
		const stamp = computeBuildStamp("/repo/mcp/server.js", fakeStat(1000));
		expect(stamp).toEqual({ entryPath: "/repo/mcp/server.js", mtimeMs: 1000 });
	});

	it("returns undefined when the entry can't be stat'd", () => {
		const stamp = computeBuildStamp("/repo/mcp/server.js", fakeStat(undefined));
		expect(stamp).toBeUndefined();
	});
});

describe("checkStaleness", () => {
	const stamp = { entryPath: "/repo/mcp/server.js", mtimeMs: 1000 };

	it("is not stale when the on-disk mtime still matches the startup stamp", () => {
		const result = checkStaleness(stamp, fakeStat(1000));
		expect(result.stale).toBe(false);
		expect(result.currentMtimeMs).toBe(1000);
	});

	it("is stale when the on-disk mtime has moved (rebuild/merge landed)", () => {
		const result = checkStaleness(stamp, fakeStat(2000));
		expect(result.stale).toBe(true);
		expect(result.currentMtimeMs).toBe(2000);
	});

	it("treats a failed re-stat as NOT stale (never false-flag from an I/O hiccup)", () => {
		const result = checkStaleness(stamp, fakeStat(undefined));
		expect(result.stale).toBe(false);
		expect(result.currentMtimeMs).toBeUndefined();
	});
});

describe("StalenessGate", () => {
	it("reports fresh when no stamp was captured (e.g. entry unresolvable)", () => {
		const gate = new StalenessGate(undefined, { stat: fakeStat(1000) });
		expect(gate.isStale()).toBe(false);
	});

	it("reports stale once the on-disk mtime diverges from the stamp", () => {
		const stamp = computeBuildStamp("/repo/mcp/server.js", fakeStat(1000));
		const gate = new StalenessGate(stamp, { stat: fakeStat(2000) });
		expect(gate.isStale()).toBe(true);
	});

	it("caches the verdict for checkIntervalMs — a burst of calls costs one stat", () => {
		const stamp = computeBuildStamp("/repo/mcp/server.js", fakeStat(1000));
		let statCalls = 0;
		let currentMtime = 1000;
		const countingStat: StatFn = () => {
			statCalls++;
			return { mtimeMs: currentMtime };
		};
		let nowMs = 0;
		const gate = new StalenessGate(stamp, {
			stat: countingStat,
			now: () => nowMs,
			checkIntervalMs: 1000,
		});

		expect(gate.isStale()).toBe(false);
		expect(statCalls).toBe(1);

		// Build changes mid-window, but we're still within the throttle window —
		// the cached (stale-negative) verdict is reused, no new stat.
		currentMtime = 2000;
		nowMs = 500;
		expect(gate.isStale()).toBe(false);
		expect(statCalls).toBe(1);

		// Past the throttle window — re-stats and picks up the change.
		nowMs = 1500;
		expect(gate.isStale()).toBe(true);
		expect(statCalls).toBe(2);
	});
});

describe("stalenessCheckEnabled", () => {
	it("is enabled by default", () => {
		expect(stalenessCheckEnabled({})).toBe(true);
	});

	it("is disabled by PI_LENS_WARM_STALENESS_CHECK=0 (kill switch)", () => {
		expect(stalenessCheckEnabled({ PI_LENS_WARM_STALENESS_CHECK: "0" })).toBe(
			false,
		);
	});

	it("stays enabled for any other value", () => {
		expect(stalenessCheckEnabled({ PI_LENS_WARM_STALENESS_CHECK: "1" })).toBe(
			true,
		);
		expect(
			stalenessCheckEnabled({ PI_LENS_WARM_STALENESS_CHECK: "false" }),
		).toBe(true);
	});
});
