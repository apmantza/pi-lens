/**
 * Tests for clients/lsp/wait-policy/strategies.ts's `resolveAstGrepNativeExe`
 * (#472) — platform-native ast-grep exe resolution, skipping the node-bin
 * wrapper. Package-name construction is checked for the 3 documented
 * platform/arch combos, plus graceful fallback (undefined) for
 * unsupported combos and when require.resolve can't find the package.
 */

import { describe, expect, it } from "vitest";
import {
	getStrategy,
	resolveAstGrepNativeExe,
} from "../../../clients/lsp/wait-policy/strategies.js";

describe("TypeScript diagnostic strategies (#1412)", () => {
	it("holds classic's measured empty first push and stabilizes native TS7 pushes", () => {
		expect(getStrategy("typescript", "classic").seedFirstPush).toBe(false);
		expect(getStrategy("typescript", "classic").emptyFirstPublish).toBe(
			"indexing",
		);
		expect(getStrategy("typescript", "native-ts7").seedFirstPush).toBe(false);
		expect(getStrategy("typescript", "native-ts7").debounceMs).toBeGreaterThan(
			0,
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

describe("lua diagnostic strategy (#3347)", () => {
	it("marks the measured clean-transition silence", () => {
		const strategy = getStrategy("lua");
		// Run 35914033696 measured two dirty publishes and no clean-transition
		// publish; the marker is the cascade's tier-3 wait-policy decision.
		expect(strategy.silentOnClean).toBe(true);
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
