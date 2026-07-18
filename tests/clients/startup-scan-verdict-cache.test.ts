/**
 * #699 — a persisted `too-many-source-files` verdict must be TTL-gated so a
 * later session can safely reuse it (skip the walk) without trusting it
 * forever. Unit-level coverage for the TTL getter + `isStartupScanVerdictFresh`
 * + the `computedAt` stamp added to `StartupScanContext`.
 *
 * The full "cache actually skips the walk in session_start" behavior is
 * covered at the integration level in
 * tests/clients/runtime-session-scan-cache.test.ts.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
	_resetStartupScanVerdictTtlForTests,
	countSourceFilesWithinLimit,
	getStartupScanVerdictTtlMs,
	isStartupScanVerdictFresh,
	type StartupScanContext,
	resolveStartupScanContext,
	resolveStartupScanContextAsync,
} from "../../clients/startup-scan.js";
import { setupTestEnvironment } from "./test-utils.js";
import * as fs from "node:fs";
import * as path from "node:path";

afterEach(() => {
	delete process.env.PI_LENS_STARTUP_SCAN_VERDICT_TTL_MS;
	_resetStartupScanVerdictTtlForTests();
});

function makeVerdict(
	overrides: Partial<StartupScanContext> = {},
): StartupScanContext {
	return {
		cwd: "/proj",
		scanRoot: "/proj",
		projectRoot: "/proj",
		canWarmCaches: false,
		reason: "too-many-source-files",
		sourceFileCount: 5000,
		computedAt: Date.now(),
		...overrides,
	};
}

describe("getStartupScanVerdictTtlMs", () => {
	it("defaults to 24h", () => {
		expect(getStartupScanVerdictTtlMs()).toBe(24 * 60 * 60 * 1000);
	});

	it("honours PI_LENS_STARTUP_SCAN_VERDICT_TTL_MS", () => {
		process.env.PI_LENS_STARTUP_SCAN_VERDICT_TTL_MS = "1000";
		_resetStartupScanVerdictTtlForTests();
		expect(getStartupScanVerdictTtlMs()).toBe(1000);
	});

	it("ignores a non-finite/negative override and falls back to the default", () => {
		process.env.PI_LENS_STARTUP_SCAN_VERDICT_TTL_MS = "not-a-number";
		_resetStartupScanVerdictTtlForTests();
		expect(getStartupScanVerdictTtlMs()).toBe(24 * 60 * 60 * 1000);
	});

	it("memoizes until reset", () => {
		expect(getStartupScanVerdictTtlMs()).toBe(24 * 60 * 60 * 1000);
		process.env.PI_LENS_STARTUP_SCAN_VERDICT_TTL_MS = "1000";
		// No reset yet — still the memoized default.
		expect(getStartupScanVerdictTtlMs()).toBe(24 * 60 * 60 * 1000);
		_resetStartupScanVerdictTtlForTests();
		expect(getStartupScanVerdictTtlMs()).toBe(1000);
	});
});

describe("isStartupScanVerdictFresh", () => {
	it("is fresh when computedAt is within the TTL", () => {
		const verdict = makeVerdict({ computedAt: Date.now() - 1000 });
		expect(isStartupScanVerdictFresh(verdict)).toBe(true);
	});

	it("is stale once computedAt is past the TTL", () => {
		const verdict = makeVerdict({
			computedAt: Date.now() - (24 * 60 * 60 * 1000 + 1),
		});
		expect(isStartupScanVerdictFresh(verdict)).toBe(false);
	});

	it("respects an explicit `now` for deterministic testing", () => {
		const computedAt = 1_000_000;
		const verdict = makeVerdict({ computedAt });
		expect(isStartupScanVerdictFresh(verdict, computedAt + 1)).toBe(true);
		expect(
			isStartupScanVerdictFresh(verdict, computedAt + 24 * 60 * 60 * 1000 + 1),
		).toBe(false);
	});

	it("fails closed when computedAt is missing (pre-#699 / hand-built fixture)", () => {
		const verdict = makeVerdict();
		delete verdict.computedAt;
		expect(isStartupScanVerdictFresh(verdict)).toBe(false);
	});

	it("never TTLs a home-dir verdict, however old", () => {
		const verdict = makeVerdict({
			reason: "home-dir",
			computedAt: Date.now() - 365 * 24 * 60 * 60 * 1000,
		});
		expect(isStartupScanVerdictFresh(verdict)).toBe(true);
	});

	it("never TTLs a no-project-root verdict, however old", () => {
		const verdict = makeVerdict({
			reason: "no-project-root",
			projectRoot: null,
			computedAt: Date.now() - 365 * 24 * 60 * 60 * 1000,
		});
		expect(isStartupScanVerdictFresh(verdict)).toBe(true);
	});

	it("never TTLs a canWarmCaches:true verdict (no reason), however old", () => {
		const verdict = makeVerdict({
			canWarmCaches: true,
			reason: undefined,
			computedAt: Date.now() - 365 * 24 * 60 * 60 * 1000,
		});
		expect(isStartupScanVerdictFresh(verdict)).toBe(true);
	});
});

describe("countSourceFilesWithinLimit early exit (investigation for #699)", () => {
	// The counting walk already early-exits as soon as the running count
	// exceeds `limit` (see `if (count > limit) return count;` in both the
	// sync and async loops) — this predates #699. What #699 actually measured
	// (17s on a real monorepo) is the walk reaching that limit+1st matching
	// file only after touching a huge amount of non-matching directory/file
	// structure first (ignoreMatcher cost, directory count), not a failure to
	// early-exit. This test pins the early-exit contract so a future
	// regression (e.g. someone "optimizing" the loop to finish enumerating
	// for an accurate total) is caught immediately.
	it("stops at limit+1 rather than enumerating every matching file", () => {
		const env = setupTestEnvironment("pi-lens-early-exit-");
		try {
			const limit = 3;
			// 10 matching files, well past the limit.
			for (let i = 0; i < 10; i++) {
				fs.writeFileSync(path.join(env.tmpDir, `file${i}.ts`), "export {};\n");
			}
			const count = countSourceFilesWithinLimit(env.tmpDir, limit);
			expect(count).toBe(limit + 1);
		} finally {
			env.cleanup();
		}
	});

	it("returns the exact count when under the limit (still consumed by the success path)", () => {
		const env = setupTestEnvironment("pi-lens-exact-count-");
		try {
			for (let i = 0; i < 3; i++) {
				fs.writeFileSync(path.join(env.tmpDir, `file${i}.ts`), "export {};\n");
			}
			const count = countSourceFilesWithinLimit(env.tmpDir, 10);
			expect(count).toBe(3);
		} finally {
			env.cleanup();
		}
	});
});

describe("computedAt stamping", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		while (cleanups.length) cleanups.pop()?.();
	});

	it("resolveStartupScanContext stamps computedAt close to now", () => {
		const env = setupTestEnvironment("pi-lens-scan-stamp-");
		cleanups.push(env.cleanup);
		fs.mkdirSync(path.join(env.tmpDir, ".git"));
		const before = Date.now();
		const ctx = resolveStartupScanContext(env.tmpDir, {
			homeDir: path.join(env.tmpDir, "unrelated-home"),
		});
		const after = Date.now();
		expect(ctx.computedAt).toBeGreaterThanOrEqual(before);
		expect(ctx.computedAt).toBeLessThanOrEqual(after);
	});

	it("resolveStartupScanContextAsync stamps computedAt close to now", async () => {
		const env = setupTestEnvironment("pi-lens-scan-stamp-async-");
		cleanups.push(env.cleanup);
		fs.mkdirSync(path.join(env.tmpDir, ".git"));
		const before = Date.now();
		const ctx = await resolveStartupScanContextAsync(env.tmpDir, {
			homeDir: path.join(env.tmpDir, "unrelated-home"),
		});
		const after = Date.now();
		expect(ctx.computedAt).toBeGreaterThanOrEqual(before);
		expect(ctx.computedAt).toBeLessThanOrEqual(after);
	});
});
