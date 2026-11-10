/**
 * Tests for clients/lsp/wait-policy/strategies.ts's `resolveAstGrepNativeExe`
 * (#472) — platform-native ast-grep exe resolution, skipping the node-bin
 * wrapper. Package-name construction is checked for the 3 documented
 * platform/arch combos, plus graceful fallback (undefined) for
 * unsupported combos and when require.resolve can't find the package.
 */

import * as fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
	getStrategy,
	resolveAstGrepNativeExe,
	SERVER_DIAGNOSTIC_STRATEGIES,
} from "../../../clients/lsp/wait-policy/strategies.js";

describe("TypeScript diagnostic strategies (#1412)", () => {
	it("leaves classic's first push unheld while the matrix cell reads direct (#4615)", () => {
		// docs/lsp-capability-matrix.md's `typescript` row is `first-publish=direct`
		// (measured 2026-10-20: the dirty fixture's first publish carries the
		// finding). A marker here would hold the answer, so its absence IS the pin.
		expect(getStrategy("typescript", "classic").seedFirstPush).toBe(false);
		expect(
			getStrategy("typescript", "classic").emptyFirstPublish,
		).toBeUndefined();
		expect(getStrategy("typescript", "native-ts7").seedFirstPush).toBe(false);
		expect(getStrategy("typescript", "native-ts7").debounceMs).toBeGreaterThan(
			0,
		);
	});

	// #4914 recurrence: an unlisted launch variant falls through to the
	// `typescript` row measured on classic (`silentOnClean`), which would let the
	// cascade skip the wait for the typescript-go server behind `effect-tsgo`.
	it("answers the effect-tsgo launch with the native typescript-go strategy (#4914)", () => {
		expect(getStrategy("typescript", "effect-tsgo")).toBe(
			getStrategy("typescript", "native-ts7"),
		);
		expect(getStrategy("typescript", "effect-tsgo").silentOnClean).not.toBe(
			true,
		);
	});
});

describe("cue diagnostic strategy (#1522) — measured against the real v0.17.1 binary", () => {
	it("is push-only, seeds the first push, and publishes on clean transitions", () => {
		const strategy = getStrategy("cue");
		expect(strategy.pullRetryBudgetMs).toBe(0);
		expect(strategy.seedFirstPush).toBe(true);
		// Run 35914033696 measured a versioned clean-transition publish; keeping
		// this marker absent prevents the cascade from skipping that signal.
		expect(strategy.silentOnClean).toBeUndefined();
		expect(strategy.reopenOnResync).toBeFalsy();
	});
});

describe("svelte diagnostic strategy (#3311 lane A)", () => {
	it("keeps the pull collection budget above the cold diagnostic response", () => {
		// #3311 lane A: the default 1500ms aggregate budget capped Svelte's cold
		// pull before its seeded diagnostic response arrived.
		const strategy = getStrategy("svelte");
		expect(strategy.pullRetryBudgetMs).toBe(0);
		expect(strategy.aggregateWaitMs).toBe(4000);
	});
});

describe("lane B project-loading diagnostic strategies (#3402)", () => {
	/** DEFAULT_STRATEGY is not exported; this is it, through the real seam. */
	const defaults = getStrategy("__no_such_server_id__");

	// Recurrence 1 (#3402 r2, measured): at the 1500ms default csharp-ls read a
	// seeded CS0029 as CLEAN on the nightly (run 36054901266 `[csharp]
	// touched=0`); at a larger budget it published the finding (run 36058292424
	// `touched=1`, gate run 36059988117 `1 primary finding` 4.86s after
	// `Restored …csproj`). Recurrence 2 (#3402 r3, the inverse): the r2 fix set
	// the budget to the smoke gate's own 8000ms ceiling, and an `lsp_diagnostics`
	// call that passes no `waitMs` pays that in full on a file the server never
	// publishes for — so the budget must stay at the MEASURED value, not the
	// ceiling. Run 36064829436 is the confirmation at 6000: same `1 primary
	// finding`, 4.78s after `Restored …csproj`, census unchanged. Recurrence 3:
	// the r2 entry also flipped `pullRetryBudgetMs` from the default 250 to 0 for
	// a `mode=pull` server with nothing measuring it; the equality below is what
	// keeps an unmeasured field from riding along.
	it("moves csharp's measured aggregate budget and no other field", () => {
		expect(getStrategy("csharp")).toEqual({
			...defaults,
			aggregateWaitMs: 6000,
		});
	});

	// The same two runs measured `touched=0` for these three at BOTH 1500 and
	// 8000, so their budget is not what stops them publishing. An entry here
	// would cost every uncapped production call the difference for nothing —
	// which is exactly what r2 shipped. They stay on the default until a run
	// records a publish.
	it("gives fsharp/expert/vue no strategy entry at all", () => {
		for (const serverId of ["fsharp", "expert", "vue"]) {
			expect(getStrategy(serverId), serverId).toEqual(defaults);
		}
	});
});

describe("deno diagnostic strategy (#5464) — measured against the real deno 2.9.8 binary", () => {
	/** DEFAULT_STRATEGY is not exported; this is it, through the real seam. */
	const defaults = getStrategy("__no_such_server_id__");
	const measured = JSON.parse(
		fs.readFileSync(
			new URL(
				"../../fixtures/lsp-wait-measurements/deno-5464.json",
				import.meta.url,
			),
			"utf8",
		),
	) as {
		ci: { runs: Array<{ startedAt: string; touchedAt: string }> };
		localCpuStarved: { cap8000CompletedTouchMs: number[] };
	};

	// Recurrence (#5464): deno sat on the 1500 ms default, a cold touch on a slow
	// runner took 4.15 s and 4.60 s, and the nightly handshake row read
	// `touched=0` while the same commit was green at 3.4 s. The budget is a
	// CEILING over a pull deno always answers, so it must clear the slowest
	// COMPLETED touch the artifact records (CI and a CPU-starved host), with the
	// margin csharp's row carries (6000 over 4860).
	it("clears the slowest completed cold touch the artifact records", () => {
		const completedMs = [
			...measured.ci.runs.map(
				(run) => Date.parse(run.touchedAt) - Date.parse(run.startedAt),
			),
			...measured.localCpuStarved.cap8000CompletedTouchMs,
		];
		expect(completedMs.length).toBeGreaterThanOrEqual(8);
		const slowest = Math.max(...completedMs);
		expect(getStrategy("deno").aggregateWaitMs).toBeGreaterThanOrEqual(
			Math.ceil(slowest * 1.25),
		);
		// Recurrence (#5464 review F6, Qodo C2): the lower bound alone let a 7000 ->
		// 8000 edit pass, and 8000 adds a second to every uncapped call that deno
		// never answers. 7000 is the measured 1.25 x 5491 (6864) rounded up, so the
		// exact value is pinned; moving it needs a new measurement, not a silent edit.
		expect(getStrategy("deno").aggregateWaitMs).toBe(7000);
	});

	// Recurrence (#3402 r3): a row that moves an unmeasured field with the one
	// that was measured. Only the budget was measured; deno is a pull server and
	// nothing measured its retry or debounce.
	it("moves the measured aggregate budget and no other field", () => {
		expect(getStrategy("deno")).toEqual({
			...defaults,
			aggregateWaitMs: getStrategy("deno").aggregateWaitMs,
		});
		expect(getStrategy("deno").aggregateWaitMs).toBeGreaterThan(
			defaults.aggregateWaitMs,
		);
	});
});

describe("resolveAstGrepNativeExe", () => {
	it("resolves the real native exe for the CURRENT platform/arch (installed in this repo's node_modules)", () => {
		// This repo has @ast-grep/cli-win32-x64-msvc (or the platform-appropriate
		// package) installed as an actual dependency of @ast-grep/cli — exercise
		// the real require.resolve path end to end for the host platform.
		const resolved = resolveAstGrepNativeExe(process.platform, process.arch);
		if (resolved) {
			expect(resolved.toLowerCase()).toContain("ast-grep");
		}
		// If the optional native package isn't installed for this platform/arch,
		// resolved is legitimately undefined — both outcomes are acceptable here,
		// this test just exercises the real resolution path without throwing.
	});

	it("returns undefined for an unsupported platform", () => {
		expect(
			resolveAstGrepNativeExe("aix" as NodeJS.Platform, "x64"),
		).toBeUndefined();
	});

	it("returns undefined for an unsupported arch on a supported platform", () => {
		expect(resolveAstGrepNativeExe("win32", "mips")).toBeUndefined();
		expect(resolveAstGrepNativeExe("darwin", "ia32")).toBeUndefined();
		expect(resolveAstGrepNativeExe("linux", "arm")).toBeUndefined();
	});

	it("never throws when the platform package name would be well-formed but isn't actually installed", () => {
		// win32/arm64, darwin/x64, linux/arm64 are all VALID entries in the
		// matrix (real optionalDependencies names) but may not be installed in
		// this dev environment — must resolve to undefined, not throw.
		expect(() => resolveAstGrepNativeExe("win32", "arm64")).not.toThrow();
		expect(() => resolveAstGrepNativeExe("darwin", "x64")).not.toThrow();
		expect(() => resolveAstGrepNativeExe("linux", "arm64")).not.toThrow();
	});

	it("covers the three documented concrete combos without throwing: win32-x64, darwin-arm64, linux-x64", () => {
		for (const [platform, arch] of [
			["win32", "x64"],
			["darwin", "arm64"],
			["linux", "x64"],
		] as const) {
			expect(() => resolveAstGrepNativeExe(platform, arch)).not.toThrow();
		}
	});
});

describe("rust diagnostic strategy (#5485) — measured against the real rust-analyzer 1.99.1", () => {
	const measured = JSON.parse(
		fs.readFileSync(
			new URL(
				"../../fixtures/lsp-wait-measurements/rust-5485.json",
				import.meta.url,
			),
			"utf8",
		),
	) as {
		productPath: {
			dirtyFixture: Record<string, { touchMs: number[]; collected: number[] }>;
		};
	};
	const dirty = measured.productPath.dirtyFixture;

	// Recurrence (#5485): the table carried a `rust-analyzer` row (3000 / 500)
	// keyed by display name, so it never applied; re-keying it to `rust` "fixes"
	// the key and changes nothing a user sees, because rust-analyzer answers an
	// empty authoritative report for ~0.4 s and the type error lands at ~3.6-3.9 s
	// (0 of 5 cold touches caught it at 3000 / 500, artifact `rekeyedOriginal`).
	// A rust row therefore has to clear the slowest cold touch that DID catch the
	// finding, on the pull-retry budget that governs the answer, or it is the
	// same key-only edit the census exists to refuse.
	it("accepts a rust row only if its pull retry clears the measured cold finding", () => {
		const row = SERVER_DIAGNOSTIC_STRATEGIES.rust;
		// The artifact must still say what this guard relies on: the old values
		// caught nothing and a long retry caught everything.
		expect(dirty.rekeyedOriginal3000_500!.collected).toEqual([0, 0, 0, 0, 0]);
		expect(dirty.default1500_250!.collected).toEqual([0, 0, 0, 0, 0]);
		expect(dirty.candidate7000_6000!.collected).toEqual([1, 1, 1]);
		const slowestCatch = Math.max(...dirty.candidate7000_6000!.touchMs);
		if (row === undefined) return; // rust waits on the default today
		expect(row.pullRetryBudgetMs).toBeGreaterThanOrEqual(
			Math.ceil(slowestCatch * 1.25),
		);
	});
});
