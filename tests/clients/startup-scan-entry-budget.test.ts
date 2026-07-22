/**
 * #758 — the startup source-count walk must bound the number of directory
 * entries it visits, not just the number of source files it finds.
 *
 * The pre-#758 walk early-exited only when a project had MORE than
 * `MAX_STARTUP_SOURCE_FILES` source files. A repo with FEW source files but a
 * huge pile of non-source files (the reporter's case: ~300 scripts among ~84k
 * data files) never tripped that exit, so the walk traversed the entire tree —
 * one `ignoreMatcher.isIgnored()` call per entry — blocking `session_start`.
 *
 * These tests pin the new `too-many-entries` verdict + the entry-budget knob,
 * driven deterministically with a tiny fixture via `maxScanEntries`.
 */

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	_resetStartupScanMaxEntriesForTests,
	getStartupScanMaxEntries,
	isStartupScanVerdictFresh,
	MAX_STARTUP_SCAN_ENTRIES,
	resolveStartupScanContext,
	resolveStartupScanContextAsync,
	type StartupScanContext,
} from "../../clients/startup-scan.js";
import { setupTestEnvironment } from "./test-utils.js";

afterEach(() => {
	delete process.env.PI_LENS_STARTUP_SCAN_MAX_ENTRIES;
	_resetStartupScanMaxEntriesForTests();
});

/**
 * A project root (`.git` marker) holding a handful of source files buried in a
 * large pile of non-source files — the "mixed large repo" shape from #758.
 */
function makeMixedRepo(prefix: string, nonSourceFiles: number) {
	const env = setupTestEnvironment(prefix);
	fs.mkdirSync(path.join(env.tmpDir, ".git"));
	// A few real source files — well under MAX_STARTUP_SOURCE_FILES.
	for (let i = 0; i < 3; i++) {
		fs.writeFileSync(path.join(env.tmpDir, `script${i}.ts`), "export {};\n");
	}
	// A large pile of non-source files (mod data, etc.).
	const dataDir = path.join(env.tmpDir, "data");
	fs.mkdirSync(dataDir);
	for (let i = 0; i < nonSourceFiles; i++) {
		fs.writeFileSync(path.join(dataDir, `entry${i}.txt`), "x");
	}
	// homeDir must be an unrelated tree (NOT an ancestor of the project root,
	// or the verdict short-circuits to `home-dir`). A sibling temp dir works.
	const homeEnv = setupTestEnvironment(`${prefix}home-`);
	const cleanup = () => {
		env.cleanup();
		homeEnv.cleanup();
	};
	return { env: { tmpDir: env.tmpDir, cleanup }, homeDir: homeEnv.tmpDir };
}

describe("getStartupScanMaxEntries", () => {
	it("defaults to MAX_STARTUP_SCAN_ENTRIES", () => {
		expect(getStartupScanMaxEntries()).toBe(MAX_STARTUP_SCAN_ENTRIES);
	});

	it("honours PI_LENS_STARTUP_SCAN_MAX_ENTRIES", () => {
		process.env.PI_LENS_STARTUP_SCAN_MAX_ENTRIES = "42";
		_resetStartupScanMaxEntriesForTests();
		expect(getStartupScanMaxEntries()).toBe(42);
	});

	it("ignores a non-finite/negative override and falls back to the default", () => {
		process.env.PI_LENS_STARTUP_SCAN_MAX_ENTRIES = "not-a-number";
		_resetStartupScanMaxEntriesForTests();
		expect(getStartupScanMaxEntries()).toBe(MAX_STARTUP_SCAN_ENTRIES);
	});

	it("memoizes until reset", () => {
		expect(getStartupScanMaxEntries()).toBe(MAX_STARTUP_SCAN_ENTRIES);
		process.env.PI_LENS_STARTUP_SCAN_MAX_ENTRIES = "42";
		// No reset yet — still the memoized default.
		expect(getStartupScanMaxEntries()).toBe(MAX_STARTUP_SCAN_ENTRIES);
		_resetStartupScanMaxEntriesForTests();
		expect(getStartupScanMaxEntries()).toBe(42);
	});
});

describe("resolveStartupScanContext entry budget (#758)", () => {
	const cleanups: Array<() => void> = [];
	afterEach(() => {
		while (cleanups.length) cleanups.pop()?.();
	});

	it("warms a mixed repo when the entry budget is generous (few source files)", () => {
		const { env, homeDir } = makeMixedRepo("pi-lens-entry-generous-", 200);
		cleanups.push(env.cleanup);
		const ctx = resolveStartupScanContext(env.tmpDir, {
			homeDir,
			maxScanEntries: 1_000_000,
		});
		// Only 3 source files < MAX_STARTUP_SOURCE_FILES, budget never hit.
		expect(ctx.canWarmCaches).toBe(true);
		expect(ctx.reason).toBeUndefined();
		expect(ctx.sourceFileCount).toBe(3);
	});

	it("flags too-many-entries once the entry budget is exceeded", () => {
		const { env, homeDir } = makeMixedRepo("pi-lens-entry-capped-", 200);
		cleanups.push(env.cleanup);
		const ctx = resolveStartupScanContext(env.tmpDir, {
			homeDir,
			// Far fewer than the ~200+ entries in the tree.
			maxScanEntries: 20,
		});
		expect(ctx.canWarmCaches).toBe(false);
		expect(ctx.reason).toBe("too-many-entries");
	});

	it("is deterministic across repeated calls on the same tree", () => {
		const { env, homeDir } = makeMixedRepo("pi-lens-entry-determ-", 200);
		cleanups.push(env.cleanup);
		const reasons = new Set<StartupScanContext["reason"]>();
		for (let i = 0; i < 5; i++) {
			// Distinct maxScanEntries defeats the process-lifetime memo so each
			// call actually re-walks — the verdict must still be identical.
			const ctx = resolveStartupScanContext(env.tmpDir, {
				homeDir,
				maxScanEntries: 20 + i,
			});
			reasons.add(ctx.reason);
			expect(ctx.canWarmCaches).toBe(false);
		}
		expect([...reasons]).toEqual(["too-many-entries"]);
	});

	it("async path agrees with the sync path", async () => {
		const generous = makeMixedRepo("pi-lens-entry-async-ok-", 200);
		cleanups.push(generous.env.cleanup);
		const okCtx = await resolveStartupScanContextAsync(generous.env.tmpDir, {
			homeDir: generous.homeDir,
			maxScanEntries: 1_000_000,
		});
		expect(okCtx.canWarmCaches).toBe(true);
		expect(okCtx.reason).toBeUndefined();

		const capped = makeMixedRepo("pi-lens-entry-async-cap-", 200);
		cleanups.push(capped.env.cleanup);
		const cappedCtx = await resolveStartupScanContextAsync(capped.env.tmpDir, {
			homeDir: capped.homeDir,
			maxScanEntries: 20,
		});
		expect(cappedCtx.canWarmCaches).toBe(false);
		expect(cappedCtx.reason).toBe("too-many-entries");
	});
});

describe("isStartupScanVerdictFresh — too-many-entries is TTL'd (#758)", () => {
	function verdict(overrides: Partial<StartupScanContext>): StartupScanContext {
		return {
			cwd: "/proj",
			scanRoot: "/proj",
			projectRoot: "/proj",
			canWarmCaches: false,
			reason: "too-many-entries",
			computedAt: 1_000_000,
			...overrides,
		};
	}

	it("is fresh within the TTL and stale past it", () => {
		const v = verdict({ computedAt: 1_000_000 });
		expect(isStartupScanVerdictFresh(v, 1_000_001)).toBe(true);
		expect(
			isStartupScanVerdictFresh(v, 1_000_000 + 24 * 60 * 60 * 1000 + 1),
		).toBe(false);
	});

	it("fails closed when computedAt is missing", () => {
		const v = verdict({});
		delete v.computedAt;
		expect(isStartupScanVerdictFresh(v)).toBe(false);
	});
});
