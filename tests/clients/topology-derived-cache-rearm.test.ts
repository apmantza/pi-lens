import * as fs from "node:fs";
import { withResidentBootstrap } from "../support/bootstrap-access.js";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as languageProfile from "../../clients/language-profile.js";
import { detectProjectLanguageProfile } from "../../clients/language-profile.js";
import {
	aliasedImportTargets,
	parseTsconfigPaths,
} from "../../clients/review-graph/tsconfig-paths.js";
import * as startupScan from "../../clients/startup-scan.js";
import { resolveStartupScanContext } from "../../clients/startup-scan.js";
import {
	decideSessionStart,
	_resetSessionLifecycleForTests,
} from "../../clients/session-lifecycle.js";
import { handleSessionStart } from "../../clients/runtime-session.js";
import { resetWorkspaceTopology } from "../../clients/workspace-topology.js";
import { setupTestEnvironment } from "./test-utils.js";

const processGlobals = globalThis as typeof globalThis & {
	__piLensFirstSessionDone?: boolean;
	__piLensWarmupScheduled?: boolean;
};

function sessionDeps(
	cwd: string,
	runtime: Record<string, unknown>,
	dbg: (message: string) => void = () => {},
) {
	return withResidentBootstrap({
		ctxCwd: cwd,
		getFlag: (name: string) => name === "no-lsp",
		notify: () => {},
		dbg,
		log: () => {},
		runtime,
		cacheManager: { writeCache: () => {}, readCache: () => null },
		todoScanner: { scanDirectory: () => ({ items: [] }), scanFile: () => [] },
		astGrepClient: {
			isAvailable: () => false,
			ensureAvailable: async () => false,
		},
		biomeClient: {
			isAvailable: () => false,
			ensureAvailable: async () => false,
		},
		ruffClient: {
			isAvailable: () => false,
			ensureAvailable: async () => false,
		},
		knipClient: {
			isAvailable: () => false,
			ensureAvailable: async () => false,
		},
		jscpdClient: {
			isAvailable: () => false,
			ensureAvailable: async () => false,
		},
		deadCodeClients: [],
		govulncheckClient: {
			isAvailable: () => false,
			ensureAvailable: async () => false,
		},
		gitleaksClient: {
			isAvailable: () => false,
			ensureAvailable: async () => false,
		},
		trivyClient: {
			isAvailable: () => false,
			ensureAvailable: async () => false,
		},
		opengrepClient: {
			isAvailable: () => false,
			ensureAvailable: async () => false,
		},
		depChecker: {
			isAvailable: () => false,
			ensureAvailable: async () => false,
		},
		testRunnerClient: {
			detectRunner: () => null,
			runTestFile: () => ({ failed: 0, error: false }),
		},
		goClient: { isGoAvailableAsync: async () => false },
		rustClient: { isAvailableAsync: async () => false },
		ensureTool: async () => null,
		cleanStaleTsBuildInfo: () => [],
		resetDispatchBaselines: () => {},
		resetLSPService: () => {},
	}) as any;
}

describe("topology-derived cache re-arm (#2263)", () => {
	afterEach(() => {
		delete process.env.PI_LENS_STARTUP_MODE;
		delete process.env.PI_LENS_COLD_START_QUICK;
		delete process.env.PI_LENS_WARMUP_DELAY_MS;
		// decideSessionStart registers on PROCESS state (session-lifecycle.ts
		// :495's own warning, catalog shape 7): without this reset a later
		// caller in this file or worker classifies concurrent-secondary and
		// silently never exercises the session-start reset.
		_resetSessionLifecycleForTests();
	});

	it("re-arms all registered topology caches through a live primary→/new start", async () => {
		// Operator recipe: in an interactive pi session, run `/new`; the host
		// emits the second primary session_start that this test drives below.
		const env = setupTestEnvironment("pi-lens-topology-live-session-", {
			// #4560: this cell asserts the walk has NO root at the fixture yet, so
			// the shared default marker is the one thing it must opt out of.
			rootMarker: false,
		});
		const previousFirst = processGlobals.__piLensFirstSessionDone;
		const previousWarmup = processGlobals.__piLensWarmupScheduled;
		const languageDerive = vi.spyOn(
			languageProfile,
			"detectProjectLanguageProfile",
		);
		const startupDerive = vi.spyOn(startupScan, "resolveStartupScanContext");
		processGlobals.__piLensFirstSessionDone = false;
		processGlobals.__piLensWarmupScheduled = true;
		try {
			fs.writeFileSync(path.join(env.tmpDir, "index.ts"), "export {}\n");
			const sourceDir = path.join(env.tmpDir, "src");
			fs.mkdirSync(sourceDir);
			// #2495: `homeDir` is a SUBDIRECTORY of `env.tmpDir` (never created on
			// disk), not a real ancestor — this only pins the ceiling check, it
			// does not confine the walk. `findNearestProjectRoot` is contractually
			// unbounded (startup-scan.ts's own docstring: a marker at/above $HOME
			// must still be *returned*, with rejection applied by the caller — see
			// tests/clients/startup-scan-home-ceiling.test.ts's "above-home cwd"
			// cases for the same shape), so on a box with a real marker anywhere
			// above `env.tmpDir` (here: `C:\Users\R3LiC\package.json`, the
			// manifest for the user's pi extensions) the walk finds THAT marker
			// and `projectRoot` comes back as that real path, not null — the
			// ceiling only forces `canWarmCaches: false`, it never nulls
			// `projectRoot` for a found-but-rejected root. Asserting the
			// warm-cache verdict (what quick mode actually branches on, per the
			// "quick mode active - skipping" dbg check below) instead of the
			// found root's exact identity is deterministic on every host: since
			// `homeDir` is nested inside `env.tmpDir`, ANY root the walk can find
			// starting from `env.tmpDir` is necessarily at-or-above `homeDir`.
			const homeDir = path.join(env.tmpDir, "home");
			const firstLanguage = languageProfile.detectProjectLanguageProfile(
				env.tmpDir,
			);
			const firstScan = startupScan.resolveStartupScanContext(env.tmpDir, {
				homeDir,
			});
			expect(firstLanguage.configured.jsts).toBeUndefined();
			// No marker exists in env.tmpDir yet (.git/package.json are only
			// written below), so the walk cannot resolve projectRoot to tmpDir
			// itself — it either finds nothing or lands on a real ancestor
			// marker further up the host's filesystem. Asserting `canWarmCaches`
			// here is vacuous: homeDir is nested inside env.tmpDir, so
			// isAtOrAboveHomeDir rejects every reachable root regardless of
			// whether a marker exists at env.tmpDir, making the assertion true
			// both before and after a marker is planted there.
			expect(firstScan.projectRoot).not.toBe(path.resolve(env.tmpDir));
			const tsconfig = path.join(env.tmpDir, "tsconfig.json");
			fs.writeFileSync(
				tsconfig,
				JSON.stringify({ compilerOptions: { paths: { "@old/*": ["old/*"] } } }),
			);
			fs.utimesSync(tsconfig, 946684800, 946684800);
			const firstTsconfig = parseTsconfigPaths(sourceDir);
			expect(firstTsconfig[0]?.pattern).toBe("@old/*");

			const runtime = {
				sessionGeneration: 0,
				complexityBaselines: new Set(),
				resetForSession() {
					(this as { sessionGeneration: number }).sessionGeneration += 1;
				},
				isCurrentSession: () => true,
				markStartupScanInFlight: () => {},
				clearStartupScanInFlight: () => {},
				projectRoot: "",
				projectRulesScan: { hasCustomRules: false, rules: [] },
				cachedExports: new Map(),
				errorDebtBaseline: { testsPassed: true, buildPassed: true },
			} as Record<string, unknown>;
			let firstCtxStale = false;
			const firstCtx = {
				isIdle: () => {
					if (firstCtxStale) throw new Error("stale after session replacement");
				},
			};
			const firstDecision = decideSessionStart(
				firstCtx,
				"session-one",
				env.tmpDir,
			);
			expect(firstDecision.classification).toBe("primary");
			const firstDbg = vi.fn();
			await handleSessionStart(sessionDeps(env.tmpDir, runtime, firstDbg));
			expect(firstDbg).toHaveBeenCalledWith(
				expect.stringContaining("quick mode active - skipping"),
			);
			expect(languageDerive).toHaveBeenCalledTimes(1);
			expect(startupDerive).toHaveBeenCalledTimes(1);

			fs.mkdirSync(path.join(env.tmpDir, ".git"));
			fs.writeFileSync(path.join(env.tmpDir, "package.json"), "{}\n");
			fs.writeFileSync(
				tsconfig,
				JSON.stringify({ compilerOptions: { paths: { "@new/*": ["new/*"] } } }),
			);
			fs.utimesSync(tsconfig, 946684800, 946684800);
			firstCtxStale = true;
			const secondCtx = { isIdle: () => {} };
			const secondDecision = decideSessionStart(
				secondCtx,
				"session-two",
				env.tmpDir,
			);
			expect(secondDecision.classification).toBe("sequential-replacement");
			// #2333's observability criterion: the full path must EMIT its
			// per-phase records, not just do the work.
			const secondDbg = vi.fn();
			await handleSessionStart(sessionDeps(env.tmpDir, runtime, secondDbg));
			expect(secondDbg).toHaveBeenCalledWith(
				expect.stringContaining("session_start phase"),
			);
			expect(languageDerive).toHaveBeenCalledTimes(2);
			expect(startupDerive).toHaveBeenCalledTimes(2);

			// Work-count assertions replace elapsed-time budgets: one production
			// derivation per cache on each full path, and no derivation on quick mode.
			const secondLanguage = languageProfile.detectProjectLanguageProfile(
				env.tmpDir,
			);
			const secondScan = startupScan.resolveStartupScanContext(env.tmpDir, {
				homeDir,
			});
			const secondTsconfig = parseTsconfigPaths(sourceDir);
			expect(secondLanguage.configured.jsts).toBe(true);
			expect(secondScan.projectRoot).toBe(path.resolve(env.tmpDir));
			expect(secondTsconfig[0]?.pattern).toBe("@new/*");
			expect(aliasedImportTargets("@new/value", sourceDir)).toEqual([
				path.join(env.tmpDir, "new/value"),
			]);
		} finally {
			languageDerive.mockRestore();
			startupDerive.mockRestore();
			processGlobals.__piLensFirstSessionDone = previousFirst;
			processGlobals.__piLensWarmupScheduled = previousWarmup;
			env.cleanup();
		}
	}, 30_000);

	it("re-derives startup scan context after topology reset", () => {
		const env = setupTestEnvironment("pi-lens-topology-startup-", {
			// #4560: the `before` assertion below pins a marker-less walk.
			rootMarker: false,
		});
		try {
			// #2495: see the sibling test above — `homeDir` only pins the ceiling
			// check (nested inside `env.tmpDir`, so any found root is necessarily
			// at-or-above it); it does not confine the unbounded upward walk, so
			// `projectRoot` itself can legitimately come back as a real marker
			// found above `env.tmpDir` on this host. `canWarmCaches` is vacuous
			// here for the same reason as the sibling test: no marker exists in
			// env.tmpDir yet (.git is only created below), so the walk cannot
			// land on env.tmpDir itself — assert that directly instead.
			const homeDir = path.join(env.tmpDir, "home");
			const before = resolveStartupScanContext(env.tmpDir, { homeDir });
			expect(before.projectRoot).not.toBe(path.resolve(env.tmpDir));

			fs.mkdirSync(path.join(env.tmpDir, ".git"));
			resetWorkspaceTopology();

			const after = resolveStartupScanContext(env.tmpDir, { homeDir });
			expect(after.projectRoot).toBe(path.resolve(env.tmpDir));
		} finally {
			env.cleanup();
		}
	});

	it("re-derives language profile after topology reset", () => {
		const env = setupTestEnvironment("pi-lens-topology-language-");
		try {
			fs.writeFileSync(path.join(env.tmpDir, "index.ts"), "export {}\n");
			const before = detectProjectLanguageProfile(env.tmpDir);
			expect(before.configured.jsts).toBeUndefined();

			fs.writeFileSync(path.join(env.tmpDir, "package.json"), "{}\n");
			resetWorkspaceTopology();

			const after = detectProjectLanguageProfile(env.tmpDir);
			expect(after.configured.jsts).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("re-derives tsconfig paths after topology reset", () => {
		const env = setupTestEnvironment("pi-lens-topology-tsconfig-");
		try {
			const configPath = path.join(env.tmpDir, "tsconfig.json");
			const sourceDir = path.join(env.tmpDir, "src");
			fs.mkdirSync(sourceDir);
			const initialConfig = JSON.stringify({
				compilerOptions: { baseUrl: ".", paths: { "@old/*": ["old/*"] } },
			});
			fs.writeFileSync(configPath, initialConfig);
			fs.utimesSync(configPath, 946684800, 946684800);
			expect(parseTsconfigPaths(sourceDir)).toEqual([
				expect.objectContaining({ pattern: "@old/*" }),
			]);
			expect(aliasedImportTargets("@old/value", sourceDir)).toEqual([
				path.join(env.tmpDir, "old", "value"),
			]);

			const originalStat = fs.statSync(configPath);
			const replacementConfig = JSON.stringify({
				compilerOptions: { baseUrl: ".", paths: { "@new/*": ["new/*"] } },
			});
			expect(replacementConfig.length).toBe(initialConfig.length);
			fs.writeFileSync(configPath, replacementConfig);
			fs.utimesSync(configPath, originalStat.atime, originalStat.mtime);
			const replacementStat = fs.statSync(configPath);
			expect(replacementStat.size).toBe(originalStat.size);
			expect(replacementStat.mtimeMs).toBe(originalStat.mtimeMs);

			resetWorkspaceTopology();

			expect(parseTsconfigPaths(sourceDir)).toEqual([
				expect.objectContaining({ pattern: "@new/*" }),
			]);
			expect(aliasedImportTargets("@new/value", sourceDir)).toEqual([
				path.join(env.tmpDir, "new/value"),
			]);
		} finally {
			env.cleanup();
		}
	});
});
