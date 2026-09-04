/**
 * #1266: resetDispatchAvailabilityState() (runner-helpers.ts) was added by
 * PR #1263 to implement #1222's "install-failure suppression lasts until the
 * next session" — but no production code called it, so a transient install
 * failure suppressed a tool for the rest of the process lifetime instead of
 * just the rest of the session. The existing runner-helpers suite only
 * proved the reset helper itself works when called directly, which is
 * exactly why the missing wiring went unnoticed. This test drives real
 * suppression through the public resolver, starts a new session via
 * `handleSessionStart` (never calling the reset helper directly), and
 * asserts the tool is retried afterward.
 */

import { withResidentBootstrap } from "../support/bootstrap-access.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleSessionStart } from "../../clients/runtime-session.js";
import { removeTempDirSync, setupTestEnvironment } from "./test-utils.js";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";

vi.mock("../../clients/safe-spawn.js", () => ({
	safeSpawn: vi.fn(() => ({ stdout: "", stderr: "", status: 1 })),
	safeSpawnAsync: vi.fn(async () => ({ stdout: "", stderr: "", status: 1 })),
	resetSafeSpawnWindowsCommandCache: vi.fn(),
}));

vi.mock("../../clients/installer/index.js", () => ({
	ensureTool: vi.fn(async () => undefined),
	findManagedToolBinary: vi.fn(async () => undefined),
	resetResolvedPathCache: vi.fn(),
	// Not spawnable — forces resolveCommandWithInstallFallback down the
	// install-fallback path (rather than the --version probe path) where
	// noteInstallFailure/suppression lives.
	isSpawnableCommand: vi.fn(async () => false),
	resetPathWalkMemo: vi.fn(),
}));

vi.mock("../../clients/lsp/config.js", () => ({
	loadLSPConfig: vi.fn().mockResolvedValue({}),
	initLSPConfig: vi.fn().mockResolvedValue(undefined),
	getServerInitOverride: vi.fn().mockReturnValue(undefined),
}));

vi.mock("../../clients/lsp/index.js", () => ({
	getLSPService: vi.fn(() => makeLspServiceDouble()),
}));

function makeDefaultRuntime() {
	return {
		sessionGeneration: 1,
		isCurrentSession: () => true,
		markStartupScanInFlight: () => {},
		clearStartupScanInFlight: () => {},
		complexityBaselines: new Map(),
		resetForSession: () => {},
		projectRoot: "",
		projectRulesScan: { hasCustomRules: false, rules: [] },
		cachedExports: new Map(),
		errorDebtBaseline: { testsPassed: true, buildPassed: true },
	};
}

function makeDeps(ctxCwd: string) {
	return withResidentBootstrap({
		ctxCwd,
		getFlag: () => false,
		notify: vi.fn(),
		dbg: () => {},
		log: () => {},
		runtime: makeDefaultRuntime(),
		metricsClient: { reset: () => {} },
		cacheManager: { writeCache: () => {}, readCache: () => null },
		todoScanner: { scanDirectory: () => ({ items: [] }) },
		astGrepClient: {
			isAvailable: () => false,
			ensureAvailable: async () => false,
			scanExports: async () => new Map(),
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
		depChecker: {
			isAvailable: () => false,
			ensureAvailable: async () => false,
		},
		testRunnerClient: {
			detectRunner: () => ({ runner: "vitest", config: null }),
			runTestFile: () => ({ failed: 1, error: false }),
		},
		goClient: { isGoAvailableAsync: async () => false },
		rustClient: { isAvailableAsync: async () => false },
		ensureTool: vi.fn(async () => null),
		cleanStaleTsBuildInfo: () => [],
		resetDispatchBaselines: () => {},
		resetLSPService: () => {},
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
	}) as any;
}

describe("dispatch availability suppression is reset at session start (#1266)", () => {
	let tmpDir: string;

	beforeEach(() => {
		vi.clearAllMocks();
		tmpDir = setupTestEnvironment("pi-lens-dispatch-reset-").tmpDir;
	});

	afterEach(() => {
		removeTempDirSync(tmpDir);
	});

	it("retries a suppressed tool's install after handleSessionStart, not just after calling the reset helper directly", async () => {
		const { resolveCommandWithInstallFallback } =
			await import("../../clients/dispatch/runners/utils/runner-helpers.js");
		const installerMod = await import("../../clients/installer/index.js");
		const ensureToolMock = vi.mocked(installerMod.ensureTool);
		ensureToolMock.mockResolvedValue(undefined);

		// stylelint is autoInstall-eligible per tool-policy.ts, so the
		// install-fallback branch (not the config-first early return) runs.
		const first = await resolveCommandWithInstallFallback(
			"stylelint",
			"stylelint",
			tmpDir,
		);
		expect(first).toBeNull();
		expect(ensureToolMock).toHaveBeenCalledTimes(1);

		// Same-session retry must stay suppressed: the failed install must not
		// become an install attempt again until the session boundary.
		const second = await resolveCommandWithInstallFallback(
			"stylelint",
			"stylelint",
			tmpDir,
		);
		expect(second).toBeNull();
		expect(ensureToolMock).toHaveBeenCalledTimes(1);

		await handleSessionStart(makeDeps(tmpDir));

		// A new session must clear the suppression and retry the install.
		const third = await resolveCommandWithInstallFallback(
			"stylelint",
			"stylelint",
			tmpDir,
		);
		expect(third).toBeNull();
		expect(ensureToolMock).toHaveBeenCalledTimes(2);
	});

	// #1902 review: session-state-conformance.test.ts only proves the registry
	// KNOWS about resetResolvedPathCache's reset seam (a structural/name check).
	// Nothing asserted that handleSessionStart's call to it actually fires. The
	// wiring test above exercises resetResolvedPathCache only indirectly through
	// ensureTool's mock, so it would stay green even if the
	// `resetResolvedPathCache()` line at runtime-session.ts:2111 were deleted.
	it("calls resetResolvedPathCache directly from handleSessionStart", async () => {
		const installerMod = await import("../../clients/installer/index.js");
		const resetResolvedPathCacheMock = vi.mocked(
			installerMod.resetResolvedPathCache,
		);

		await handleSessionStart(makeDeps(tmpDir));

		expect(resetResolvedPathCacheMock).toHaveBeenCalled();
	});

	it("re-arms direct-LSP negative availability through handleSessionStart", async () => {
		const lspServer = await import("../../clients/lsp/server.js");
		lspServer._markDirectLspCommandUnavailableForTests("appeared-lsp");
		expect(
			lspServer.isDirectLspCommandTemporarilyUnavailable("appeared-lsp"),
		).toBe(true);

		await handleSessionStart(makeDeps(tmpDir));

		expect(
			lspServer.isDirectLspCommandTemporarilyUnavailable("appeared-lsp"),
		).toBe(false);
	});

	// #1895: formatter PATH latches are module-local and therefore are not
	// advanced by resetDispatchAvailabilityState's generation counter. Drive
	// the session reset seam, rather than calling resetWhichLatches directly.
	it("re-probes a latched-missing formatter after handleSessionStart", async () => {
		const { getFormattersForFile } =
			await import("../../clients/formatters.js");
		const filePath = `${tmpDir}/lib.rs`;
		const nextCwd = `${tmpDir}-next`;
		const nextFilePath = `${nextCwd}/lib.rs`;
		const fs = await import("node:fs");
		fs.mkdirSync(nextCwd);
		fs.writeFileSync(filePath, "fn main() {}\n");
		fs.writeFileSync(nextFilePath, "fn main() {}\n");
		const spawnMod = await import("../../clients/safe-spawn.js");
		const spawnMock = vi.mocked(spawnMod.safeSpawnAsync);
		const finder = process.platform === "win32" ? "where" : "which";
		const rustfmtProbes = () =>
			spawnMock.mock.calls.filter(
				(call) =>
					String(call[0]) === finder &&
					(call[1] as string[] | undefined)?.[0] === "rustfmt",
			).length;

		await getFormattersForFile(filePath, tmpDir);
		const afterFirst = rustfmtProbes();
		expect(afterFirst).toBeGreaterThan(0);
		await getFormattersForFile(filePath, tmpDir);
		expect(rustfmtProbes()).toBe(afterFirst);

		await handleSessionStart(makeDeps(tmpDir));

		await getFormattersForFile(nextFilePath, nextCwd);
		expect(rustfmtProbes()).toBeGreaterThan(afterFirst);
	});

	// #1895 review round: the case above uses a NEW cwd, so it never reaches the
	// per-cwd detection cache. A session replacement in the SAME directory does.
	// `getFormattersForFile` returns cached formatter NAMES from `detectionCache`
	// and short-circuits before any `which` probe, so clearing only the which
	// latches leaves the previous session's verdict in force for the one
	// directory the user is actually working in. The session reset has to drop
	// both.
	it("re-probes a latched-missing formatter in the SAME cwd after handleSessionStart", async () => {
		const { clearFormatterCache, getFormattersForFile } =
			await import("../../clients/formatters.js");
		// Arrange only: the module registry is shared across tests in this file,
		// so the preceding case leaves rustfmt latched. Start from a clean slate
		// so the seeding step below genuinely probes.
		clearFormatterCache();
		const filePath = `${tmpDir}/lib.rs`;
		const fs = await import("node:fs");
		fs.writeFileSync(filePath, "fn main() {}\n");
		const spawnMod = await import("../../clients/safe-spawn.js");
		const spawnMock = vi.mocked(spawnMod.safeSpawnAsync);
		const finder = process.platform === "win32" ? "where" : "which";
		const rustfmtProbes = () =>
			spawnMock.mock.calls.filter(
				(call) =>
					String(call[0]) === finder &&
					(call[1] as string[] | undefined)?.[0] === "rustfmt",
			).length;

		// Seed the absent-formatter verdict, and confirm it is genuinely cached:
		// a second lookup in the same cwd must not re-probe.
		await getFormattersForFile(filePath, tmpDir);
		const afterFirst = rustfmtProbes();
		expect(afterFirst).toBeGreaterThan(0);
		await getFormattersForFile(filePath, tmpDir);
		expect(rustfmtProbes()).toBe(afterFirst);

		await handleSessionStart(makeDeps(tmpDir));

		// Same cwd, same file, no config-file edit — the next lookup must probe
		// PATH again rather than replay the previous session's answer.
		await getFormattersForFile(filePath, tmpDir);
		expect(rustfmtProbes()).toBeGreaterThan(afterFirst);
	});

	// #1490: psscriptanalyzer's interpreter and module verdicts live in
	// module-local latches, so `resetDispatchAvailabilityState`'s generation
	// counter — the mechanism every other runner inherits — does not reach them.
	// Without explicit wiring, a PowerShell install done mid-process stayed
	// invisible until the host restarted. Same shape as #1266 above: the helper
	// worked when called directly, and nothing called it.
	it("re-probes PowerShell after handleSessionStart", async () => {
		const spawnMod = await import("../../clients/safe-spawn.js");
		const spawnMock = vi.mocked(spawnMod.safeSpawnAsync);
		const runner = (
			await import("../../clients/dispatch/runners/psscriptanalyzer.js")
		).default;
		const psProbes = () =>
			spawnMock.mock.calls.filter((call) =>
				(call[1] as string[] | undefined)?.includes("-NoProfile"),
			).length;

		const ctx = { cwd: tmpDir, filePath: `${tmpDir}/script.ps1` } as never;
		expect((await runner.run(ctx)).status).toBe("skipped");
		const afterFirst = psProbes();
		expect(afterFirst).toBeGreaterThan(0);

		// Same session: the verdict is latched, so nothing is re-probed.
		expect((await runner.run(ctx)).status).toBe("skipped");
		expect(psProbes()).toBe(afterFirst);

		await handleSessionStart(makeDeps(tmpDir));

		expect((await runner.run(ctx)).status).toBe("skipped");
		expect(psProbes()).toBeGreaterThan(afterFirst);
	});

	// #1497: govulncheck's install-class retry ceiling is terminal for a
	// SESSION, but the latch holding it lives on a process-lived client
	// instance. Same shape a third time — the re-arm helper is proved directly
	// in `install-retry-session-rearm.test.ts`, and this is the only test that
	// fails if nothing on the session_start path calls it.
	it("re-runs an exhausted `go install` after handleSessionStart", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			const spawnMod = await import("../../clients/safe-spawn.js");
			const spawnMock = vi.mocked(spawnMod.safeSpawnAsync);
			const { INSTALL_TRANSIENT_COOLDOWNS_MS } =
				await import("../../clients/dispatch/runners/utils/availability-policy.js");
			spawnMock.mockImplementation((async (cmd: unknown, args: unknown) => {
				const argv = Array.isArray(args) ? args.join(" ") : "";
				if (String(cmd) === "go" && argv.startsWith("version"))
					return { stdout: "go1.22.0", stderr: "", status: 0 };
				if (String(cmd) === "go" && argv.startsWith("install"))
					return {
						stdout: "",
						stderr: "",
						status: null,
						error: new Error("Process timed out after 60000ms"),
						failure: "timeout",
						spawnFailure: { kind: "timeout" },
					};
				return {
					stdout: "",
					stderr: "",
					status: null,
					error: Object.assign(new Error("spawn missing ENOENT"), {
						code: "ENOENT",
					}),
					failure: "spawn",
					spawnFailure: { kind: "tool-not-found" },
				};
			}) as never);
			const installs = () =>
				spawnMock.mock.calls.filter(
					([cmd, args]) =>
						String(cmd) === "go" &&
						Array.isArray(args) &&
						args[0] === "install",
				).length;

			const { GovulncheckClient } =
				await import("../../clients/govulncheck-client.js");
			const client = new GovulncheckClient(false);
			for (const cooldown of [0, ...INSTALL_TRANSIENT_COOLDOWNS_MS]) {
				vi.setSystemTime(new Date(Date.now() + cooldown + 1));
				expect(await client.ensureAvailable()).toBe(false);
			}
			const atCeiling = installs();

			// Ceiling reached: a day of waiting inside the session buys nothing.
			vi.setSystemTime(new Date(Date.now() + 24 * 60 * 60 * 1000));
			expect(await client.ensureAvailable()).toBe(false);
			expect(installs()).toBe(atCeiling);

			await handleSessionStart(makeDeps(tmpDir));

			expect(await client.ensureAvailable()).toBe(false);
			expect(installs()).toBeGreaterThan(atCeiling);
		} finally {
			vi.useRealTimers();
		}
	});

	// #1653: package-manager.ts's `availabilityLatches` map is module-local
	// (keyed by pnpm/yarn/bun/npm), same shape as psscriptanalyzer's latches
	// above — `resetDispatchAvailabilityState`'s generation counter does not
	// reach it, and nothing on the session_start path called the module's own
	// `_resetPackageManagerCache` test hook. A genuine "pnpm is missing"
	// verdict from one session stayed latched into the next: install pnpm mid
	// day, start a fresh session, pi-lens still reports it missing until a
	// process restart. Found by #1652's registry conformance sweep.
	it("re-probes a latched-missing package manager after handleSessionStart", async () => {
		const spawnMod = await import("../../clients/safe-spawn.js");
		const spawnMock = vi.mocked(spawnMod.safeSpawnAsync);
		const finder = process.platform === "win32" ? "where" : "which";
		spawnMock.mockImplementation((async (cmd: unknown, args: unknown) => {
			const argv = Array.isArray(args) ? args : [];
			if (String(cmd) === finder && argv[0] === "pnpm") {
				return { stdout: "", stderr: "", status: 1 };
			}
			return { stdout: "npm\n", stderr: "", status: 0 };
		}) as never);

		const { resolveNodePackageManager } =
			await import("../../clients/package-manager.js");
		const fs = await import("node:fs");
		const path = await import("node:path");
		fs.writeFileSync(path.join(tmpDir, "pnpm-lock.yaml"), "");

		const pnpmProbes = () =>
			spawnMock.mock.calls.filter(
				(call) =>
					String(call[0]) === finder &&
					(call[1] as string[] | undefined)?.[0] === "pnpm",
			).length;

		// pnpm declared, genuinely absent right now: falls back to npm and
		// latches — a second resolve within the session does not re-probe.
		expect(await resolveNodePackageManager(tmpDir)).toBe("npm");
		const afterFirst = pnpmProbes();
		expect(afterFirst).toBeGreaterThan(0);
		expect(await resolveNodePackageManager(tmpDir)).toBe("npm");
		expect(pnpmProbes()).toBe(afterFirst);

		// pnpm gets installed mid-day; a fresh session must re-probe it rather
		// than trusting the previous session's "missing" verdict.
		await handleSessionStart(makeDeps(tmpDir));
		spawnMock.mockImplementation((async (cmd: unknown, args: unknown) => {
			const argv = Array.isArray(args) ? args : [];
			if (String(cmd) === finder && argv[0] === "pnpm") {
				return { stdout: "pnpm\n", stderr: "", status: 0 };
			}
			return { stdout: "npm\n", stderr: "", status: 0 };
		}) as never);

		expect(await resolveNodePackageManager(tmpDir)).toBe("pnpm");
		expect(pnpmProbes()).toBeGreaterThan(afterFirst);
	});
});
