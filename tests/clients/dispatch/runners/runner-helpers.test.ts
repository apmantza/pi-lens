import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createAvailabilityChecker,
	createVenvFinder,
	findManagedNodeToolBinary,
	lspPrimaryCoversFile,
	resolveAvailableOrInstall,
	resolveLocalFirstAsync,
	resolveNodeToolCommand,
	resolveToolCommand,
	resolveToolCommandWithInstallFallback,
	resetDispatchAvailabilityState,
	resolveVendorToolCommand,
} from "../../../../clients/dispatch/runners/utils/runner-helpers.js";
import type { DispatchContext } from "../../../../clients/dispatch/types.js";
import { findGlobalBinary } from "../../../../clients/package-manager.js";
import { setProjectTrustState } from "../../../../clients/project-trust.js";
import { setupTestEnvironment } from "../../test-utils.js";

// This sweep plants project-local rungs on purpose; the trust gate itself is
// exercised by the dedicated witnesses (`package-manager.test.ts`), so the
// resolution suites run trusted.
beforeEach(() => setProjectTrustState("trusted"));

const { logSessionStartSpy, logLatencySpy } = vi.hoisted(() => ({
	logSessionStartSpy: vi.fn(),
	logLatencySpy: vi.fn(),
}));

const missingSpawnFailure = () =>
	({
		kind: "tool-not-found" as const,
		cause: Object.assign(new Error("missing"), { code: "ENOENT" }),
	}) as never;

vi.mock("../../../../clients/sessionstart-logger.js", () => ({
	logSessionStart: logSessionStartSpy,
}));

vi.mock("../../../../clients/latency-logger.js", async (importOriginal) => ({
	...(await importOriginal()),
	logLatency: logLatencySpy,
	getLastLoggedPhase: () => undefined,
}));

const availabilityDecisions = () =>
	logLatencySpy.mock.calls
		.map((call) => call[0])
		.filter((entry) => entry?.phase === "availability_decision");

vi.mock("../../../../clients/safe-spawn.js", () => ({
	safeSpawn: vi.fn(() => ({ stdout: "", stderr: "", status: 1 })),
	safeSpawnAsync: vi.fn(async () => ({ stdout: "", stderr: "", status: 1 })),
}));

vi.mock("../../../../clients/installer/index.js", () => ({
	// #2140: the probe resolver asks the installer for a release-managed
	// binary (`~/.pi-lens/bin`) before falling back to PATH. Undefined is
	// "no managed install", which is what these tests already assumed.
	findManagedToolBinary: vi.fn(async () => undefined),
	ensureTool: vi.fn(async () => null),
	// #1612: resolveAvailableOrInstallUnshared reads these on the install-
	// success path to derive honest evidence rather than asserting "succeeded".
	// Undefined here reads as "no fresh attempt this call" (a cache/discovery
	// resolution), which is what these dedupe/retry tests exercise.
	getInstallAttempt: vi.fn(() => undefined),
	// #1636: the compensating row's `resolved` tag reads this when
	// `getInstallAttempt` is undefined. Undefined here reads as "no known
	// source" and the row constructor falls back to "cache", preserving the
	// #1612 behavior these tests already assert.
	getLastEnsureResolutionSource: vi.fn(() => undefined),
	getToolInstallStrategy: vi.fn(() => undefined),
	// Pass the on-disk pre-check so these tests keep exercising the --version
	// probe path through the mocked safeSpawnAsync.
	isSpawnableCommand: vi.fn(async () => true),
	resetPathWalkMemo: vi.fn(),
	// #1657: the managed-shim resolver runs the installer's own verification
	// instead of a bare existsSync. Default "it runs" keeps every pre-existing
	// managed-dir expectation intact.
	verifyToolBinary: vi.fn(async () => true),
}));

vi.mock("../../../../clients/package-manager.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../../../clients/package-manager.js")
	>()),
	findGlobalBinary: vi.fn(async () => undefined),
}));

describe("runner-helpers availability checker", () => {
	beforeEach(async () => {
		const safeSpawnMod = await import("../../../../clients/safe-spawn.js");
		const installerMod = await import("../../../../clients/installer/index.js");
		vi.mocked(safeSpawnMod.safeSpawn).mockReset();
		vi.mocked(safeSpawnMod.safeSpawnAsync).mockReset();
		vi.mocked(installerMod.ensureTool).mockReset();
		vi.mocked(findGlobalBinary).mockReset();
		vi.mocked(findGlobalBinary).mockResolvedValue(undefined);
		logSessionStartSpy.mockReset();
		resetDispatchAvailabilityState();
	});

	it("resolves local node_modules/.bin commands before global fallback", () => {
		const env = setupTestEnvironment("pi-lens-node-bin-");
		try {
			const localUnix = path.join(env.tmpDir, "node_modules", ".bin", "eslint");
			const localWin = path.join(
				env.tmpDir,
				"node_modules",
				".bin",
				"eslint.cmd",
			);
			fs.mkdirSync(path.dirname(localUnix), { recursive: true });
			fs.writeFileSync(localUnix, "#!/bin/sh\nexit 0\n");
			fs.writeFileSync(localWin, "@echo off\n");

			const resolved = resolveNodeToolCommand(env.tmpDir, "eslint");
			expect(resolved).toContain(path.join("node_modules", ".bin"));
		} finally {
			env.cleanup();
		}
	});

	it("pins the availability-lane cooldown consult and its transient decision (#2309)", async () => {
		const safeSpawnMod = await import("../../../../clients/safe-spawn.js");
		const cooldownMod =
			await import("../../../../clients/spawn-timeout-cooldown.js");
		const command = "cooldown-probe-tool";

		// The shared beforeEach does not reset logLatencySpy, so the
		// toHaveLength(1) below is only valid against a locally cleared
		// history — the same idiom the two later mockReset sites use.
		logLatencySpy.mockReset();
		cooldownMod.resetSpawnTimeoutCooldowns();
		cooldownMod.noteSpawnTimeout({
			tool: command,
			command,
			phase: "availability",
		});

		const checker = createAvailabilityChecker(command);
		expect(await checker.isAvailableAsync(process.cwd())).toBe(false);
		expect(safeSpawnMod.safeSpawnAsync).not.toHaveBeenCalled();
		expect(availabilityDecisions()).toHaveLength(1);
		expect(availabilityDecisions()[0]?.metadata).toMatchObject({
			tool: command,
			verdict: "unavailable",
			outcome: "transient",
			cause: "probe-timeout",
			classifiedBy: "caller",
			evidence: {
				command,
				status: null,
			},
		});
	});

	it("falls back to global command when no local node_modules binary exists", () => {
		const env = setupTestEnvironment("pi-lens-node-bin-global-");
		try {
			expect(resolveNodeToolCommand(env.tmpDir, "eslint")).toBe("eslint");
			expect(resolveToolCommand(env.tmpDir, "eslint")).toBe("eslint");
		} finally {
			env.cleanup();
		}
	});

	it("resolves vendor/bin commands by walking up the directory tree", () => {
		const env = setupTestEnvironment("pi-lens-vendor-bin-");
		try {
			const nested = path.join(env.tmpDir, "src", "Controllers");
			const vendorUnix = path.join(env.tmpDir, "vendor", "bin", "phpstan");
			const vendorWin = path.join(env.tmpDir, "vendor", "bin", "phpstan.bat");
			fs.mkdirSync(path.dirname(vendorUnix), { recursive: true });
			fs.mkdirSync(nested, { recursive: true });
			fs.writeFileSync(vendorUnix, "#!/bin/sh\nexit 0\n");
			fs.writeFileSync(vendorWin, "@echo off\n");

			const resolved = resolveVendorToolCommand(nested, "phpstan", ".bat");
			expect(resolved).toContain(path.join("vendor", "bin"));
		} finally {
			env.cleanup();
		}
	});

	/**
	 * #2514 / #2544 review F1. `resolveVendorToolCommand` was a private,
	 * unceilinged copy of the shared bin walk — the same shape #2514 fixed in
	 * `formatters.ts`'s `findInVendorBin`, left behind in `runner-helpers.ts`.
	 * A `vendor/bin` at or above `$HOME` can never be this project's own
	 * Composer install.
	 */
	it("does not resolve a vendor/bin planted at HOME (#2514)", () => {
		const env = setupTestEnvironment("pi-lens-vendor-bin-home-");
		const originalHome = process.env.HOME;
		const originalUserProfile = process.env.USERPROFILE;
		try {
			const fakeHome = env.tmpDir;
			const nested = path.join(fakeHome, "project", "src");
			fs.mkdirSync(nested, { recursive: true });
			const homeVendorBin = path.join(fakeHome, "vendor", "bin");
			fs.mkdirSync(homeVendorBin, { recursive: true });
			fs.writeFileSync(path.join(homeVendorBin, "phpstan"), "#!/bin/sh\n");
			fs.writeFileSync(path.join(homeVendorBin, "phpstan.bat"), "@echo off\n");
			process.env.HOME = fakeHome;
			process.env.USERPROFILE = fakeHome;

			expect(resolveVendorToolCommand(nested, "phpstan", ".bat")).toBeNull();
		} finally {
			if (originalHome === undefined) delete process.env.HOME;
			else process.env.HOME = originalHome;
			if (originalUserProfile === undefined) delete process.env.USERPROFILE;
			else process.env.USERPROFILE = originalUserProfile;
			env.cleanup();
		}
	});

	it("resolves the installed command after a typed missing probe", async () => {
		const safeSpawnMod = await import("../../../../clients/safe-spawn.js");
		const installerMod = await import("../../../../clients/installer/index.js");
		vi.mocked(safeSpawnMod.safeSpawnAsync).mockResolvedValue({
			stdout: "",
			stderr: "",
			status: null,
			error: Object.assign(new Error("missing"), { code: "ENOENT" }),
			failure: "spawn",
			spawnFailure: missingSpawnFailure(),
		});
		vi.mocked(installerMod.ensureTool).mockResolvedValue("stylelint");

		const resolved = await resolveToolCommandWithInstallFallback(
			process.cwd(),
			"stylelint",
		);

		expect(installerMod.ensureTool).toHaveBeenCalledWith("stylelint");
		expect(resolved).toBe("stylelint");
	});

	it("does not auto-install config-first tools", async () => {
		const safeSpawnMod = await import("../../../../clients/safe-spawn.js");
		const installerMod = await import("../../../../clients/installer/index.js");
		vi.mocked(safeSpawnMod.safeSpawnAsync).mockResolvedValueOnce({
			stdout: "",
			stderr: "not found",
			status: 1,
		});

		const resolvedByToolId = await resolveToolCommandWithInstallFallback(
			process.cwd(),
			"eslint",
		);

		expect(installerMod.ensureTool).not.toHaveBeenCalled();
		expect(resolvedByToolId).toBeNull();
	});

	it("dedupes concurrent missing-tool probe and install transactions", async () => {
		const safeSpawnMod = await import("../../../../clients/safe-spawn.js");
		const installerMod = await import("../../../../clients/installer/index.js");
		vi.mocked(safeSpawnMod.safeSpawnAsync).mockResolvedValue({
			stdout: "",
			stderr: "not found",
			status: 1,
			error: Object.assign(new Error("missing"), { code: "ENOENT" }),
			failure: "spawn",
			spawnFailure: missingSpawnFailure(),
		});
		vi.mocked(installerMod.ensureTool).mockResolvedValue("ruff");
		const checker = createAvailabilityChecker("ruff");

		const results = await Promise.all(
			Array.from({ length: 8 }, () =>
				resolveAvailableOrInstall(checker, "ruff", process.cwd()),
			),
		);

		expect(results).toEqual(Array(8).fill("ruff"));
		expect(installerMod.ensureTool).toHaveBeenCalledTimes(1);
		// Mutation verification: removing the shared resolve/install in-flight map
		// makes this same test observe 8 ensureTool calls; the dedupe extension was
		// temporarily reverted and the test was rerun before restoring the fix.
	});

	it("probes with custom versionArgs (e.g. `zig version`, not `--version`)", async () => {
		// Regression guard for #209: zig rejects `--version` (its version
		// subcommand is `zig version`), so the default probe made zig-check skip on
		// every machine. The checker must forward the override to the spawn.
		const safeSpawnMod = await import("../../../../clients/safe-spawn.js");
		let probedArgs: string[] | undefined;
		vi.mocked(safeSpawnMod.safeSpawnAsync).mockImplementation(
			async (_cmd, args) => {
				probedArgs = args as string[];
				return { stdout: "0.16.0", stderr: "", status: 0 };
			},
		);

		const checker = createAvailabilityChecker("zig", ".exe", ["version"]);
		expect(await checker.isAvailableAsync(process.cwd())).toBe(true);
		expect(probedArgs).toEqual(["version"]);
		expect(
			vi.mocked(safeSpawnMod.safeSpawnAsync).mock.calls.at(-1)?.[2],
		).toMatchObject({
			input: "",
		});
	});

	it("forwards custom verification args to managed-shim verification", async () => {
		const env = setupTestEnvironment("pi-lens-managed-check-args-");
		try {
			const managedHome = path.join(env.tmpDir, "managed-home");
			vi.stubEnv("PI_LENS_HOME", managedHome);
			fs.mkdirSync(path.join(managedHome, "tools", "node_modules", ".bin"), {
				recursive: true,
			});
			const managedBinary = path.join(
				managedHome,
				"tools",
				"node_modules",
				".bin",
				"markdownlint-cli2",
			);
			fs.writeFileSync(managedBinary, "#!/bin/sh\nexit 0\n");
			const installerMod =
				await import("../../../../clients/installer/index.js");
			await createVenvFinder("markdownlint-cli2", ".cmd", ["--no-globs", "-"])(
				env.tmpDir,
			);
			expect(installerMod.verifyToolBinary).toHaveBeenCalledWith(
				managedBinary,
				undefined,
				expect.any(Function),
				expect.any(Number),
				["--no-globs", "-"],
			);
		} finally {
			vi.unstubAllEnvs();
			env.cleanup();
		}
	});

	it("keys the checker flight by code-unit order, not locale (#2155, #2165)", async () => {
		const safeSpawnMod = await import("../../../../clients/safe-spawn.js");
		let releaseProbe!: (value: unknown) => void;
		const pendingProbe = new Promise((resolve) => {
			releaseProbe = resolve;
		});
		vi.mocked(safeSpawnMod.safeSpawnAsync).mockReturnValue(
			pendingProbe as never,
		);

		// Two independent checker instances probing the SAME command in the
		// SAME cwd with the SAME env content share one flight-registry key
		// space (module-scoped `checkerProbeFlights`). Their env objects here
		// carry identical entries, so a locale-independent key must join them
		// into one physical probe regardless of what `localeCompare` says.
		const env = { AAA: "1", BBB: "2" };
		const checkerA = createAvailabilityChecker(
			"dupe-locale-tool",
			"",
			["--version"],
			{ environment: async () => ({ ...env }) },
		);
		const checkerB = createAvailabilityChecker(
			"dupe-locale-tool",
			"",
			["--version"],
			{ environment: async () => ({ ...env }) },
		);

		const realLocaleCompare = String.prototype.localeCompare;
		try {
			// Simulate "locale 1": AAA sorts before BBB.
			String.prototype.localeCompare = function (this: string, that: string) {
				if (this === "AAA" && that === "BBB") return -1;
				if (this === "BBB" && that === "AAA") return 1;
				return realLocaleCompare.call(this, that);
			};
			const first = checkerA.isAvailableAsync(process.cwd());
			await vi.waitFor(() =>
				expect(safeSpawnMod.safeSpawnAsync).toHaveBeenCalledTimes(1),
			);

			// Simulate "locale 2": the same two keys sort in the OPPOSITE order.
			// A real second process under a different OS locale can see exactly
			// this. `env` itself is untouched — only the comparator "moved".
			String.prototype.localeCompare = function (this: string, that: string) {
				if (this === "AAA" && that === "BBB") return 1;
				if (this === "BBB" && that === "AAA") return -1;
				return realLocaleCompare.call(this, that);
			};
			const second = checkerB.isAvailableAsync(process.cwd());
			// Let the second call's async prefix (findCommand's fs walk) settle
			// so it has actually joined the existing flight-registry entry
			// before that entry resolves and is removed below — releasing too
			// early makes checkerB find no flight to join and spawn its own
			// (proven: removing this sleep makes safeSpawnAsync observably
			// called twice). The call-count assertion itself moves below both
			// awaits: checking it here, right after the sleep and before
			// release, only proves "not yet 2" at that instant — a
			// false-green if the prefix were merely slow rather than actually
			// deduped. Asserting after both `first`/`second` have fully
			// settled is deterministic, since nothing can still be pending.
			await new Promise((resolve) => setTimeout(resolve, 100));

			releaseProbe({ stdout: "1.0.0", stderr: "", status: 0 });
			expect(await first).toBe(true);
			expect(await second).toBe(true);
			expect(safeSpawnMod.safeSpawnAsync).toHaveBeenCalledTimes(1);
		} finally {
			String.prototype.localeCompare = realLocaleCompare;
		}
	});

	it("does not let an old in-flight probe delete a newer generation", async () => {
		const safeSpawnMod = await import("../../../../clients/safe-spawn.js");
		let releaseOld!: (value: unknown) => void;
		let releaseNew!: (value: unknown) => void;
		const oldProbe = new Promise((resolve) => {
			releaseOld = resolve;
		});
		const newProbe = new Promise((resolve) => {
			releaseNew = resolve;
		});
		vi.mocked(safeSpawnMod.safeSpawnAsync)
			.mockReturnValueOnce(oldProbe as never)
			.mockReturnValueOnce(newProbe as never);

		const checker = createAvailabilityChecker("generation-tool");
		const oldResult = checker.isAvailableAsync(process.cwd());
		await vi.waitFor(() =>
			expect(safeSpawnMod.safeSpawnAsync).toHaveBeenCalledTimes(1),
		);

		resetDispatchAvailabilityState();
		const newResult = checker.isAvailableAsync(process.cwd());
		await vi.waitFor(() =>
			expect(safeSpawnMod.safeSpawnAsync).toHaveBeenCalledTimes(2),
		);
		releaseOld({ stdout: "", stderr: "", status: 1 });
		await oldResult;

		// If the old finally deleted the new entry, this call would start a third
		// probe instead of sharing the replacement-generation promise.
		void checker.isAvailableAsync(process.cwd());
		expect(safeSpawnMod.safeSpawnAsync).toHaveBeenCalledTimes(2);
		releaseNew({ stdout: "1.0.0", stderr: "", status: 0 });
		await newResult;
	});

	it("defaults versionArgs to --version when not overridden", async () => {
		const safeSpawnMod = await import("../../../../clients/safe-spawn.js");
		let probedArgs: string[] | undefined;
		vi.mocked(safeSpawnMod.safeSpawnAsync).mockImplementation(
			async (_cmd, args) => {
				probedArgs = args as string[];
				return { stdout: "1.0.0", stderr: "", status: 0 };
			},
		);

		const checker = createAvailabilityChecker("sometool");
		expect(await checker.isAvailableAsync(process.cwd())).toBe(true);
		expect(probedArgs).toEqual(["--version"]);
	});

	it("re-probes a cached positive when its resolved command disappears", async () => {
		const safeSpawnMod = await import("../../../../clients/safe-spawn.js");
		const installerMod = await import("../../../../clients/installer/index.js");
		vi.mocked(safeSpawnMod.safeSpawnAsync)
			.mockResolvedValueOnce({ stdout: "1.0.0", stderr: "", status: 0 })
			.mockResolvedValueOnce({
				stdout: "",
				stderr: "missing",
				status: null,
				error: Object.assign(new Error("missing"), { code: "ENOENT" }),
				failure: "spawn",
				spawnFailure: missingSpawnFailure(),
			});
		vi.mocked(installerMod.isSpawnableCommand).mockResolvedValueOnce(false);
		// Scoped count: earlier tests in this file legitimately trigger the
		// session-reset path, which also calls resetPathWalkMemo.
		vi.mocked(installerMod.resetPathWalkMemo).mockClear();
		const checker = createAvailabilityChecker("deleted-tool");
		expect(await checker.isAvailableAsync(process.cwd())).toBe(true);
		expect(await checker.isAvailableAsync(process.cwd())).toBe(false);
		expect(safeSpawnMod.safeSpawnAsync).toHaveBeenCalledTimes(2);
		expect(installerMod.resetPathWalkMemo).toHaveBeenCalledOnce();
	});

	// #5345 r1 F1: the deleted sweep's test was the only pin that the session
	// reset clears the PATH-walk memo. This drives the real installer memo: a
	// walk answers from the memo after its file is gone, and the reset makes
	// the next walk fresh. Deleting the `resetPathWalkMemo()` call in
	// `resetDispatchAvailabilityState` reds the last assertion.
	it("clears the PATH-walk memo at the session boundary (#5345 F1)", async () => {
		const installerMod = await import("../../../../clients/installer/index.js");
		const real = await vi.importActual<
			typeof import("../../../../clients/installer/index.js")
		>("../../../../clients/installer/index.js");
		const env = setupTestEnvironment("pi-lens-path-memo-reset-");
		const savedPath = process.env.PATH;
		const tool = path.join(env.tmpDir, "memo-reset-tool");
		try {
			fs.writeFileSync(tool, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
			process.env.PATH = env.tmpDir;
			real.resetPathWalkMemo();
			expect(await real.isSpawnableCommand("memo-reset-tool")).toBe(true);
			fs.rmSync(tool);
			// The file is gone, but the memo still answers: a hit, not a walk.
			expect(await real.isSpawnableCommand("memo-reset-tool")).toBe(true);
			vi.mocked(installerMod.resetPathWalkMemo).mockImplementation(
				real.resetPathWalkMemo,
			);
			resetDispatchAvailabilityState();
			expect(await real.isSpawnableCommand("memo-reset-tool")).toBe(false);
		} finally {
			vi.mocked(installerMod.resetPathWalkMemo).mockReset();
			if (savedPath === undefined) delete process.env.PATH;
			else process.env.PATH = savedPath;
			env.cleanup();
		}
	});

	it("keeps structural replaceWithRule on the scoped fallback the instance resolved (#4193)", async () => {
		const env = setupTestEnvironment("pi-lens-scoped-rule-");
		try {
			const file = path.join(env.tmpDir, "a.ts");
			fs.writeFileSync(file, "var x = 1;\n");
			const match = {
				file,
				text: "var x = 1;",
				range: { start: { line: 0, column: 0 }, end: { line: 0, column: 10 } },
			};
			vi.stubEnv("PI_LENS_HOME", path.join(env.tmpDir, "pi-lens-home"));
			const scanOptions: Array<{ cwd?: string; stripNpmConfig?: boolean }> = [];
			const safeSpawnMod = await import("../../../../clients/safe-spawn.js");
			vi.mocked(safeSpawnMod.safeSpawnAsync).mockImplementation(
				async (cmd, args, options) => {
					if (
						cmd !== "npx" ||
						!args?.includes("--no") ||
						args[args.indexOf("--package") + 1] !== "@ast-grep/cli"
					) {
						return {
							stdout: "",
							stderr: "unscoped package rejected",
							status: 1,
						};
					}
					if (args.includes("--version")) {
						return { stdout: "ast-grep 0.45.3", stderr: "", status: 0 };
					}
					scanOptions.push(options ?? {});
					return { stdout: JSON.stringify([match]), stderr: "", status: 0 };
				},
			);
			const { AstGrepClient } =
				await import("../../../../clients/ast-grep-client.js");
			const client = new AstGrepClient();
			// The temp scans run the command THIS instance resolved (#5247); the
			// tool handlers sweep first, so the test does too.
			expect(await client.ensureAvailable()).toBe(true);
			const result = await client.replaceWithRule(
				"id: scoped\nlanguage: TypeScript\nrule:\n  pattern: var $X = $Y\nfix: let $X = $Y\n",
				[file],
				false,
			);
			expect(result.error).toBeUndefined();
			expect(result.totalMatches).toBe(1);
			expect(result.matches).toEqual([match]);
			// #4233 V3-HIGH-02: the temp-scan npx child uses the same isolated seam
			// as the exec path, so a hostile project `.npmrc` is never read.
			expect(scanOptions.length).toBeGreaterThan(0);
			for (const options of scanOptions) {
				expect(options.cwd).toBe(
					path.join(env.tmpDir, "pi-lens-home", "tools"),
				);
				expect(options.cwd).not.toBe(env.tmpDir);
				expect(options.stripNpmConfig).toBe(true);
			}
		} finally {
			vi.unstubAllEnvs();
			env.cleanup();
		}
	});

	it("bounds missing-tool installs to one attempt and records the failure", async () => {
		const safeSpawnMod = await import("../../../../clients/safe-spawn.js");
		const installerMod = await import("../../../../clients/installer/index.js");
		vi.mocked(safeSpawnMod.safeSpawnAsync).mockResolvedValue({
			stdout: "",
			stderr: "",
			status: null,
			error: Object.assign(new Error("spawn missing ENOENT"), {
				code: "ENOENT",
			}),
			failure: "spawn",
			spawnFailure: missingSpawnFailure(),
		});
		vi.mocked(installerMod.ensureTool).mockResolvedValue(undefined);

		const checker = createAvailabilityChecker("missing-tool");
		for (let attempt = 0; attempt < 4; attempt += 1) {
			await expect(
				resolveAvailableOrInstall(checker, "ruff", process.cwd()),
			).resolves.toBeNull();
		}

		// The first failed install suppresses same-session re-entry, so the
		// effective retry cap is one attempt per tool and cwd.
		expect(installerMod.ensureTool).toHaveBeenCalledTimes(1);
		expect(logSessionStartSpy).toHaveBeenCalledTimes(1);
		expect(logSessionStartSpy).toHaveBeenCalledWith(
			"dispatch availability ruff: install attempt 1 failed; suppressing retries until the next session or a successful install",
		);

		resetDispatchAvailabilityState();
		await expect(
			resolveAvailableOrInstall(checker, "ruff", process.cwd()),
		).resolves.toBeNull();
		expect(installerMod.ensureTool).toHaveBeenCalledTimes(2);
		expect(logSessionStartSpy).toHaveBeenCalledTimes(2);
		expect(logSessionStartSpy).toHaveBeenLastCalledWith(
			"dispatch availability ruff: install attempt 1 failed; suppressing retries until the next session or a successful install",
		);
	});

	it("allows a later retry after a successful install clears the failure state", async () => {
		const safeSpawnMod = await import("../../../../clients/safe-spawn.js");
		const installerMod = await import("../../../../clients/installer/index.js");
		vi.mocked(safeSpawnMod.safeSpawnAsync).mockResolvedValue({
			stdout: "",
			stderr: "",
			status: null,
			error: Object.assign(new Error("spawn missing ENOENT"), {
				code: "ENOENT",
			}),
			failure: "spawn",
			spawnFailure: missingSpawnFailure(),
		});
		const checker = createAvailabilityChecker("missing-tool-success");

		vi.mocked(installerMod.ensureTool).mockResolvedValueOnce(undefined);
		await expect(
			resolveAvailableOrInstall(checker, "ruff", process.cwd()),
		).resolves.toBeNull();

		// The session reset permits the successful install attempt; the assertion
		// below verifies that noteInstallSuccess removes the prior tool state.
		resetDispatchAvailabilityState();
		vi.mocked(installerMod.ensureTool).mockResolvedValueOnce("/managed/ruff");
		await expect(
			resolveAvailableOrInstall(checker, "ruff", process.cwd()),
		).resolves.toBe("/managed/ruff");

		vi.mocked(installerMod.ensureTool).mockResolvedValueOnce(undefined);
		await expect(
			resolveAvailableOrInstall(checker, "ruff", process.cwd()),
		).resolves.toBeNull();
		expect(installerMod.ensureTool).toHaveBeenCalledTimes(3);
		expect(logSessionStartSpy).toHaveBeenLastCalledWith(
			"dispatch availability ruff: install attempt 1 failed; suppressing retries until the next session or a successful install",
		);
	});

	it("lspPrimaryCoversFile: matches the builtin covers fact for the file's primary (#233, #3968)", () => {
		const ctx = {
			filePath: "/proj/config.toml",
			pi: { getFlag: () => false },
		} as unknown as DispatchContext;
		// the `toml` LSP server (taplo lsp) is the sole primary for .toml, and
		// the fact table maps it onto the taplo RUNNER capability with that
		// binary as the availability gate.
		const taploCover = lspPrimaryCoversFile(ctx, "taplo");
		expect(taploCover?.serverId).toBe("toml");
		expect(taploCover?.gateCommands).toEqual(["taplo"]);
		const sh = {
			filePath: "/proj/deploy.sh",
			pi: { getFlag: () => false },
		} as unknown as DispatchContext;
		const shellCover = lspPrimaryCoversFile(sh, "shellcheck");
		expect(shellCover?.serverId).toBe("bash");
		expect(shellCover?.gateCommands).toEqual(["bash-language-server"]);
	});

	it("lspPrimaryCoversFile: the shuck builtin fact covers shellcheck for .zsh (no-lsp stays kill-switched) (#3968)", () => {
		const ctx = {
			filePath: "/proj/zshrc.zsh",
			pi: { getFlag: () => false },
		} as unknown as DispatchContext;
		// bash's `.zsh` claim narrowed (#3968), so shuck is the lone primary.
		const cover = lspPrimaryCoversFile(ctx, "shellcheck");
		expect(cover?.serverId).toBe("shuck");
		expect(cover?.gateCommands).toEqual(["shuck"]);
	});

	it("lspPrimaryCoversFile: undefined when no-lsp kills the runner (#233)", () => {
		const ctx = {
			filePath: "/proj/config.toml",
			pi: { getFlag: (f: string) => f === "no-lsp" },
		} as unknown as DispatchContext;
		expect(lspPrimaryCoversFile(ctx, "taplo")).toBeUndefined();
	});

	it("lspPrimaryCoversFile: undefined when the covering server is not this file's primary (#233)", () => {
		// a .py file's primary is the python server, not toml — so the taplo CLI
		// must NOT self-skip on it.
		const ctx = {
			filePath: "/proj/main.py",
			pi: { getFlag: () => false },
		} as unknown as DispatchContext;
		expect(lspPrimaryCoversFile(ctx, "taplo")).toBeUndefined();
	});

	it("lspPrimaryCoversFile: undefined when the primary claims no such runner capability (#3968)", () => {
		// a .sh file's primary (bash) covers shellcheck but NOT taplo — the
		// capability question is per-runner, never per-server-id.
		const ctx = {
			filePath: "/proj/deploy.sh",
			pi: { getFlag: () => false },
		} as unknown as DispatchContext;
		expect(lspPrimaryCoversFile(ctx, "taplo")).toBeUndefined();
	});

	it("resolveLocalFirstAsync: local node_modules/.bin wins without any probe", async () => {
		const safeSpawnMod = await import("../../../../clients/safe-spawn.js");
		const env = setupTestEnvironment("pi-lens-local-first-");
		try {
			const isWin = process.platform === "win32";
			const binName = isWin ? "prisma.cmd" : "prisma";
			const local = path.join(env.tmpDir, "node_modules", ".bin", binName);
			fs.mkdirSync(path.dirname(local), { recursive: true });
			fs.writeFileSync(local, isWin ? "@echo off\n" : "#!/bin/sh\n");

			const resolved = await resolveLocalFirstAsync("prisma", env.tmpDir);
			expect(resolved).toEqual({ cmd: local, args: [] });
			// Local hit short-circuits — no global-bin lookup, no PATH spawn.
			expect(findGlobalBinary).not.toHaveBeenCalled();
			expect(safeSpawnMod.safeSpawnAsync).not.toHaveBeenCalled();
		} finally {
			env.cleanup();
		}
	});

	it("resolveLocalFirstAsync: falls to a manager's global bin dir before PATH", async () => {
		const safeSpawnMod = await import("../../../../clients/safe-spawn.js");
		const env = setupTestEnvironment("pi-lens-global-bin-");
		try {
			const globalPath = path.join("/opt/pnpm/bin", "prisma");
			vi.mocked(findGlobalBinary).mockResolvedValueOnce(globalPath);

			const resolved = await resolveLocalFirstAsync("prisma", env.tmpDir);
			expect(resolved).toEqual({ cmd: globalPath, args: [] });
			expect(findGlobalBinary).toHaveBeenCalledWith("prisma", ".cmd");
			// Found via direct file lookup — the PATH `--version` spawn is skipped.
			expect(safeSpawnMod.safeSpawnAsync).not.toHaveBeenCalled();
		} finally {
			env.cleanup();
		}
	});

	it("resolveLocalFirstAsync: PATH probe when no local/global bin, else npx --no", async () => {
		const safeSpawnMod = await import("../../../../clients/safe-spawn.js");
		const env = setupTestEnvironment("pi-lens-path-probe-");
		try {
			vi.mocked(findGlobalBinary).mockResolvedValue(undefined);

			// On PATH: `<tool> --version` exits 0 → run it bare.
			vi.mocked(safeSpawnMod.safeSpawnAsync).mockResolvedValueOnce({
				stdout: "5.0.0",
				stderr: "",
				status: 0,
			});
			expect(await resolveLocalFirstAsync("prisma", env.tmpDir)).toEqual({
				cmd: "prisma",
				args: [],
			});

			// Not on PATH → universal cache-only `npx --no` fallback (no dlx fetch).
			vi.mocked(safeSpawnMod.safeSpawnAsync).mockResolvedValueOnce({
				stdout: "",
				stderr: "not found",
				status: 1,
			});
			expect(await resolveLocalFirstAsync("prisma", env.tmpDir)).toEqual({
				cmd: "npx",
				args: ["--no", "prisma"],
			});
		} finally {
			env.cleanup();
		}
	});

	it("caches availability per cwd (does not leak false across projects)", async () => {
		const safeSpawnMod = await import("../../../../clients/safe-spawn.js");
		const dirA = setupTestEnvironment("pi-lens-a-");
		const dirB = setupTestEnvironment("pi-lens-b-");
		try {
			const ruffBUnix = path.join(dirB.tmpDir, ".venv", "bin", "ruff");
			const ruffBWin = path.join(dirB.tmpDir, ".venv", "Scripts", "ruff.exe");
			fs.mkdirSync(path.dirname(ruffBUnix), { recursive: true });
			fs.mkdirSync(path.dirname(ruffBWin), { recursive: true });
			fs.writeFileSync(ruffBUnix, "#!/bin/sh\nexit 0\n");
			fs.writeFileSync(ruffBWin, "@echo off\n");

			const checker = createAvailabilityChecker("ruff", ".exe");

			vi.mocked(safeSpawnMod.safeSpawnAsync).mockImplementation(async (cmd) => {
				const text = String(cmd);
				if (text.includes(dirB.tmpDir)) {
					return { stdout: "ruff 1.0.0", stderr: "", status: 0 };
				}
				return { stdout: "", stderr: "not found", status: 1 };
			});

			expect(await checker.isAvailableAsync(dirA.tmpDir)).toBe(false);
			expect(await checker.isAvailableAsync(dirB.tmpDir)).toBe(true);
			expect(checker.getCommand(dirA.tmpDir)).toBeNull();
			// Exact path, not toContain: a quote-wrapped path still *contains*
			// tmpDir but is a literal filename under shell:false (#1508).
			//
			// This fixture plants BOTH venv layouts, which no real virtualenv
			// does, so it also pins the candidate ORDER. Since #2544 review F1
			// folded `createVenvFinder` onto the shared walker, that order is
			// EXT-OUTER / DIR-INNER — the order the formatters' venv walk used
			// before #5410, and the right one on Windows, where the
			// `Scripts/*.exe` is the binary `shell: false` can actually spawn and
			// `bin/ruff` would be an unrunnable shell script. The two resolvers
			// used to disagree here; now they cannot.
			expect(checker.getCommand(dirB.tmpDir)).toBe(
				process.platform === "win32" ? ruffBWin : ruffBUnix,
			);
		} finally {
			dirA.cleanup();
			dirB.cleanup();
		}
	});

	it("venv-resolved command path is returned verbatim, never quote-wrapped (#1508)", async () => {
		const env = setupTestEnvironment("pi-lens-venv-quote-");
		try {
			const toolPath = path.join(env.tmpDir, ".venv", "bin", "ruff");
			fs.mkdirSync(path.dirname(toolPath), { recursive: true });
			fs.writeFileSync(toolPath, "#!/bin/sh\nexit 0\n");

			// Every spawn consumer runs shell:false (safe-spawn #817), so a
			// quote-wrapped path is a literal filename that ENOENTs on every
			// platform.
			const resolved = await createVenvFinder("ruff", ".exe")(env.tmpDir);
			expect(resolved).toEqual({ path: toolPath, rung: "venv" });
		} finally {
			env.cleanup();
		}
	});
});

/**
 * #1638 — `createVenvFinder` only checked venv paths, then fell straight to
 * a bare-name PATH probe. A tool installed only into the managed tools dir
 * (`~/.pi-lens/tools/node_modules/.bin/<tool>`, where `ensureTool` puts
 * npm-strategy installs) never resolved here, so every dispatch re-probed
 * PATH, missed, spawned a doomed `--version` process, and only THEN fell
 * through to `ensureTool`'s own cache a few lines later — one wasted spawn
 * per dispatch, for the life of the session (#1638 evidence, #1612 review).
 */
describe("createVenvFinder: managed tools dir (#1638)", () => {
	// `getGlobalPiLensDir` (clients/file-utils.ts) reads `PI_LENS_HOME` before
	// falling back to `os.homedir()/.pi-lens` — the real per-test seam, since
	// `createVenvFinder`/`findManagedNodeToolBinary` read it fresh on every
	// call rather than caching it at module load (deliberately, per
	// `findManagedNodeToolBinary`'s own doc comment).
	const originalPiLensHome = process.env.PI_LENS_HOME;

	afterEach(() => {
		if (originalPiLensHome === undefined) delete process.env.PI_LENS_HOME;
		else process.env.PI_LENS_HOME = originalPiLensHome;
	});

	it("resolves a managed-dir-only tool without touching PATH", async () => {
		const env = setupTestEnvironment("pi-lens-managed-dir-finder-");
		try {
			process.env.PI_LENS_HOME = env.tmpDir;
			const managedBin =
				process.platform === "win32"
					? path.join(
							env.tmpDir,
							"tools",
							"node_modules",
							".bin",
							"pyright.exe",
						)
					: path.join(env.tmpDir, "tools", "node_modules", ".bin", "pyright");
			fs.mkdirSync(path.dirname(managedBin), { recursive: true });
			fs.writeFileSync(managedBin, "#!/bin/sh\nexit 0\n");

			// No cwd venv exists, so pre-fix this falls straight to the bare
			// command name — a PATH lookup that misses for a managed-dir-only
			// install. Post-fix, the managed dir is checked first.
			const cwdWithNoVenv = setupTestEnvironment("pi-lens-no-venv-");
			try {
				const resolved = await createVenvFinder(
					"pyright",
					".exe",
				)(cwdWithNoVenv.tmpDir);
				expect(resolved).toEqual({ path: managedBin, rung: "managed-dir" });
			} finally {
				cwdWithNoVenv.cleanup();
			}
		} finally {
			env.cleanup();
		}
	});

	it("counts zero spawns for a managed-dir-installed tool's availability probe", async () => {
		const env = setupTestEnvironment("pi-lens-managed-dir-spawn-count-");
		try {
			process.env.PI_LENS_HOME = env.tmpDir;
			const managedBin =
				process.platform === "win32"
					? path.join(
							env.tmpDir,
							"tools",
							"node_modules",
							".bin",
							"managedtool.exe",
						)
					: path.join(
							env.tmpDir,
							"tools",
							"node_modules",
							".bin",
							"managedtool",
						);
			fs.mkdirSync(path.dirname(managedBin), { recursive: true });
			fs.writeFileSync(managedBin, "#!/bin/sh\nexit 0\n");

			const safeSpawnMod = await import("../../../../clients/safe-spawn.js");
			vi.mocked(safeSpawnMod.safeSpawnAsync).mockReset();
			// The probe never spawns the resolved command directly in this test
			// (createVenvFinder is a pure path resolver); this asserts the
			// resolver itself never needs a spawn to find the managed binary —
			// unlike the pre-fix bare-name fallback, which only "finds" the tool
			// via a `safeSpawnAsync` round trip that has to fail first.
			const resolved = await createVenvFinder(
				"managedtool",
				".exe",
			)(env.tmpDir);
			expect(resolved).toEqual({ path: managedBin, rung: "managed-dir" });
			expect(safeSpawnMod.safeSpawnAsync).not.toHaveBeenCalled();
		} finally {
			env.cleanup();
		}
	});

	it("still prefers a venv install over the managed dir", async () => {
		const env = setupTestEnvironment("pi-lens-venv-over-managed-");
		try {
			const venvBin = path.join(env.tmpDir, ".venv", "bin", "ruff");
			fs.mkdirSync(path.dirname(venvBin), { recursive: true });
			fs.writeFileSync(venvBin, "#!/bin/sh\nexit 0\n");

			const resolved = await createVenvFinder("ruff")(env.tmpDir);
			expect(resolved).toEqual({ path: venvBin, rung: "venv" });
		} finally {
			env.cleanup();
		}
	});

	/**
	 * #2544 round 4 F2 (reverted). Round 3 folded `createVenvFinder` onto the
	 * shared ANCESTOR walker, reasoning that a monorepo package should find its
	 * repo-root venv the way project-root discovery would — but that was an
	 * unrequested behaviour change with no #2514 defect behind it (#2514 is
	 * about the HOME ceiling, not about climbing ancestors at all), and the
	 * inversion is real: `~/code/app` with no venv of its own would resolve
	 * `~/code/.venv/bin/ruff` — an unrelated SIBLING project's interpreter —
	 * ahead of PATH. Reverted to a fixed lookup at `cwd` only: a venv at a
	 * repo root is invisible from a package subdirectory, and the caller falls
	 * through to the bare command name (PATH) instead.
	 */
	it("does not resolve a venv from an ANCESTOR of cwd (monorepo package, #2544 round 4 F2)", async () => {
		const env = setupTestEnvironment("pi-lens-venv-ancestor-");
		try {
			const repoRoot = path.join(env.tmpDir, "repo");
			const pkg = path.join(repoRoot, "packages", "api");
			fs.mkdirSync(pkg, { recursive: true });
			const venvBin =
				process.platform === "win32"
					? path.join(repoRoot, ".venv", "Scripts", "ruff.exe")
					: path.join(repoRoot, ".venv", "bin", "ruff");
			fs.mkdirSync(path.dirname(venvBin), { recursive: true });
			fs.writeFileSync(venvBin, "#!/bin/sh\nexit 0\n");

			expect(await createVenvFinder("ruff", ".exe")(pkg)).toEqual({
				path: "ruff",
				rung: "path",
			});
		} finally {
			env.cleanup();
		}
	});

	// After #2544 round 4 F2's revert to a fixed `cwd`-only lookup, this holds
	// for a simpler reason than a ceiling: `project` (cwd) and `fakeHome` are
	// different directories, and `findLocalBinsAt` never looks anywhere but
	// `cwd` — the ceiling is moot for a lookup that never climbs.
	it("does not resolve a venv planted at HOME (#2514)", async () => {
		const env = setupTestEnvironment("pi-lens-venv-home-ceiling-");
		const originalHome = process.env.HOME;
		const originalUserProfile = process.env.USERPROFILE;
		try {
			const fakeHome = env.tmpDir;
			const project = path.join(fakeHome, "project");
			fs.mkdirSync(project, { recursive: true });
			const homeVenvBin =
				process.platform === "win32"
					? path.join(fakeHome, ".venv", "Scripts", "homeonlytool.exe")
					: path.join(fakeHome, ".venv", "bin", "homeonlytool");
			fs.mkdirSync(path.dirname(homeVenvBin), { recursive: true });
			fs.writeFileSync(homeVenvBin, "#!/bin/sh\nexit 0\n");
			process.env.HOME = fakeHome;
			process.env.USERPROFILE = fakeHome;

			// Falls through to the bare name (PATH), never to `$HOME`'s venv —
			// which can only be some unrelated user-level virtualenv.
			expect(await createVenvFinder("homeonlytool", ".exe")(project)).toEqual({
				path: "homeonlytool",
				rung: "path",
			});
		} finally {
			if (originalHome === undefined) delete process.env.HOME;
			else process.env.HOME = originalHome;
			if (originalUserProfile === undefined) delete process.env.USERPROFILE;
			else process.env.USERPROFILE = originalUserProfile;
			env.cleanup();
		}
	});

	it("falls back to the bare command when neither venv nor managed dir has it", async () => {
		const env = setupTestEnvironment("pi-lens-no-venv-no-managed-");
		try {
			const resolved = await createVenvFinder("totally-unknown-tool")(
				env.tmpDir,
			);
			expect(resolved).toEqual({ path: "totally-unknown-tool", rung: "path" });
		} finally {
			env.cleanup();
		}
	});
});

/**
 * #1636 — third #1606-family site: `resolveToolCommandWithInstallFallback`
 * recovers a tool after a checker already latched it `unavailable`, but wrote
 * no compensating `available` row.
 * markdownlint hit this in production: the durable log kept saying the lane
 * was off while it ran and succeeded (#1636 evidence).
 *
 * These reuse the SAME row constructor #1612/#1615 landed for
 * `resolveAvailableOrInstall` (`emitCompensatingAvailableRow`), so the once-
 * per-correction memo and evidence derivation are exercised identically —
 * proven by the shared "once per correction" test below.
 */
describe("resolveToolCommandWithInstallFallback compensating row (#1636)", () => {
	beforeEach(async () => {
		const safeSpawnMod = await import("../../../../clients/safe-spawn.js");
		const installerMod = await import("../../../../clients/installer/index.js");
		vi.mocked(safeSpawnMod.safeSpawnAsync).mockReset();
		vi.mocked(installerMod.ensureTool).mockReset();
		vi.mocked(installerMod.getInstallAttempt).mockReset();
		vi.mocked(installerMod.getLastEnsureResolutionSource).mockReset();
		vi.mocked(installerMod.getToolInstallStrategy).mockReset();
		vi.mocked(installerMod.isSpawnableCommand).mockReset();
		logLatencySpy.mockReset();
		resetDispatchAvailabilityState();
	});

	it("resolveToolCommandWithInstallFallback: one probe, then install, logs two rows, last available", async () => {
		const installerMod = await import("../../../../clients/installer/index.js");
		vi.mocked(installerMod.isSpawnableCommand).mockResolvedValue(false);
		vi.mocked(installerMod.ensureTool).mockResolvedValue(
			"/managed/bin/stylelint",
		);
		vi.mocked(installerMod.getInstallAttempt).mockReturnValue({
			outcome: "succeeded",
			at: Date.now(),
		});
		vi.mocked(installerMod.getToolInstallStrategy).mockReturnValue("npm");

		// The resolver's own checker probes (#5410: runners no longer probe a
		// checker of their own first) and latches "unavailable" — row 1.
		const { safeSpawnAsync } =
			await import("../../../../clients/safe-spawn.js");
		vi.mocked(safeSpawnAsync).mockResolvedValue({
			stdout: "",
			stderr: "",
			status: null,
			error: Object.assign(new Error("missing"), { code: "ENOENT" }),
			failure: "spawn",
			spawnFailure: missingSpawnFailure(),
		});

		// The install then recovers the tool AND logs the compensating row —
		// pre-#1636 this second row never fired, leaving the durable log stuck
		// on "unavailable".
		const resolved = await resolveToolCommandWithInstallFallback(
			process.cwd(),
			"stylelint",
		);

		expect(resolved).toBe("/managed/bin/stylelint");
		const records = availabilityDecisions();
		expect(records).toHaveLength(2);
		expect(records[0].metadata).toMatchObject({
			tool: "stylelint",
			verdict: "unavailable",
		});
		expect(records[1].metadata).toMatchObject({
			tool: "stylelint",
			verdict: "available",
			outcome: "success",
			cause: "ok",
			classifiedBy: "caller",
			latched: false,
			evidence: {
				install: "succeeded",
				binary: "stylelint",
				source: "managed-dir",
			},
		});
	});

	it("tags a project-trust-declined resolution as declined, never cache", async () => {
		const installerMod = await import("../../../../clients/installer/index.js");
		vi.mocked(installerMod.isSpawnableCommand).mockResolvedValue(false);
		vi.mocked(installerMod.ensureTool).mockResolvedValue(
			"/managed/bin/stylelint",
		);
		// The trust-gate branch in `ensureTool` records "declined" AFTER its own
		// discovery pass, regardless of what that pass found (installer/index.ts).
		vi.mocked(installerMod.getInstallAttempt).mockReturnValue({
			outcome: "declined",
			reason: "project trust: untrusted workspace",
			at: Date.now(),
		});
		// Even if discovery found the binary on PATH this call, "declined" must
		// win — a policy refusal is not a cache hit (#1636 review carry-over).
		vi.mocked(installerMod.getLastEnsureResolutionSource).mockReturnValue(
			"path",
		);
		vi.mocked(
			(await import("../../../../clients/safe-spawn.js")).safeSpawnAsync,
		).mockResolvedValue({
			stdout: "",
			stderr: "",
			status: null,
			error: Object.assign(new Error("missing"), { code: "ENOENT" }),
			failure: "spawn",
			spawnFailure: missingSpawnFailure(),
		});

		const resolved = await resolveToolCommandWithInstallFallback(
			process.cwd(),
			"stylelint",
		);

		expect(resolved).toBe("/managed/bin/stylelint");
		const available = availabilityDecisions().filter(
			(record) => record.metadata.verdict === "available",
		);
		expect(available).toHaveLength(1);
		expect(available[0].metadata.evidence).toMatchObject({
			install: "not-attempted",
			resolved: "declined",
		});
	});

	it("tags a plain PATH/managed-dir discovery as path, never cache", async () => {
		const installerMod = await import("../../../../clients/installer/index.js");
		vi.mocked(installerMod.isSpawnableCommand).mockResolvedValue(false);
		vi.mocked(installerMod.ensureTool).mockResolvedValue(
			"/managed/bin/stylelint",
		);
		// No attempt recorded (getToolPath found it directly — installer/index.ts's
		// "already installed" branch never calls `noteInstallAttempt`).
		vi.mocked(installerMod.getInstallAttempt).mockReturnValue(undefined);
		vi.mocked(installerMod.getLastEnsureResolutionSource).mockReturnValue(
			"path",
		);
		vi.mocked(
			(await import("../../../../clients/safe-spawn.js")).safeSpawnAsync,
		).mockResolvedValue({
			stdout: "",
			stderr: "",
			status: null,
			error: Object.assign(new Error("missing"), { code: "ENOENT" }),
			failure: "spawn",
			spawnFailure: missingSpawnFailure(),
		});

		await resolveToolCommandWithInstallFallback(process.cwd(), "stylelint");

		const available = availabilityDecisions().filter(
			(record) => record.metadata.verdict === "available",
		);
		expect(available).toHaveLength(1);
		expect(available[0].metadata.evidence).toMatchObject({
			install: "not-attempted",
			resolved: "path",
		});
	});

	it("shares the once-per-correction memo with resolveAvailableOrInstall (#1612 F2)", async () => {
		const installerMod = await import("../../../../clients/installer/index.js");
		const safeSpawnMod = await import("../../../../clients/safe-spawn.js");
		vi.mocked(installerMod.isSpawnableCommand).mockResolvedValue(false);
		vi.mocked(installerMod.ensureTool).mockResolvedValue(
			"/managed/bin/stylelint",
		);
		vi.mocked(installerMod.getInstallAttempt)
			.mockReturnValueOnce({ outcome: "succeeded", at: Date.now() })
			.mockReturnValue(undefined);
		vi.mocked(safeSpawnMod.safeSpawnAsync).mockResolvedValue({
			stdout: "",
			stderr: "",
			status: null,
			error: Object.assign(new Error("missing"), { code: "ENOENT" }),
			failure: "spawn",
			spawnFailure: missingSpawnFailure(),
		});
		const checker = createAvailabilityChecker("stylelint");
		const cwd = process.cwd();

		// Both seams share ONE row constructor and one memo. The first call
		// corrects a latched row through the #1636 seam; the second finds the
		// pair already corrected and stays silent, so a repeat never
		// double-counts one correction.
		await resolveAvailableOrInstall(checker, "stylelint", cwd);
		checker.reset();
		await resolveToolCommandWithInstallFallback(cwd, "stylelint");

		const available = availabilityDecisions().filter(
			(record) => record.metadata.verdict === "available",
		);
		expect(available).toHaveLength(1);
	});
});

/**
 * #1657 — the once-per-correction memo is not a "this pair emitted a row"
 * memo: it burns only on a genuine latch-then-recover. The no-latch emission
 * the bundler-form `resolveCommandArgsWithInstallFallback` made no longer
 * exists (#5410 folded rubocop onto the registry resolver), so every emission
 * through the seam corrects a latched row and the survivors below pin the
 * memo's own lifecycle.
 */
describe("compensating row: the memo burns only on a genuine correction (#1657)", () => {
	const missingProbe = {
		stdout: "",
		stderr: "",
		status: null,
		error: Object.assign(new Error("missing"), { code: "ENOENT" }),
		failure: "spawn" as const,
		spawnFailure: missingSpawnFailure(),
	};

	beforeEach(async () => {
		const safeSpawnMod = await import("../../../../clients/safe-spawn.js");
		const installerMod = await import("../../../../clients/installer/index.js");
		vi.mocked(safeSpawnMod.safeSpawnAsync).mockReset();
		vi.mocked(installerMod.ensureTool).mockReset();
		vi.mocked(installerMod.getInstallAttempt).mockReset();
		vi.mocked(installerMod.getLastEnsureResolutionSource).mockReset();
		vi.mocked(installerMod.getToolInstallStrategy).mockReset();
		vi.mocked(installerMod.isSpawnableCommand).mockReset();
		logLatencySpy.mockReset();
		resetDispatchAvailabilityState();
	});

	it("a genuine correction still suppresses the emissions after it", async () => {
		const installerMod = await import("../../../../clients/installer/index.js");
		const safeSpawnMod = await import("../../../../clients/safe-spawn.js");
		vi.mocked(installerMod.isSpawnableCommand).mockResolvedValue(false);
		vi.mocked(installerMod.ensureTool).mockResolvedValue(
			"/managed/bin/stylelint",
		);
		vi.mocked(installerMod.getInstallAttempt).mockReturnValue(undefined);
		vi.mocked(safeSpawnMod.safeSpawnAsync).mockResolvedValue(missingProbe);
		const checker = createAvailabilityChecker("stylelint");
		const cwd = process.cwd();

		await resolveAvailableOrInstall(checker, "stylelint", cwd);
		await resolveToolCommandWithInstallFallback(cwd, "stylelint");
		await resolveToolCommandWithInstallFallback(cwd, "stylelint");

		const available = availabilityDecisions().filter(
			(record) => record.metadata.verdict === "available",
		);
		expect(available).toHaveLength(1);
	});

	it("re-arms at the session boundary", async () => {
		const installerMod = await import("../../../../clients/installer/index.js");
		const safeSpawnMod = await import("../../../../clients/safe-spawn.js");
		vi.mocked(installerMod.isSpawnableCommand).mockResolvedValue(false);
		vi.mocked(installerMod.ensureTool).mockResolvedValue(
			"/managed/bin/stylelint",
		);
		vi.mocked(installerMod.getInstallAttempt).mockReturnValue(undefined);
		vi.mocked(safeSpawnMod.safeSpawnAsync).mockResolvedValue(missingProbe);
		const cwd = process.cwd();

		await resolveAvailableOrInstall(
			createAvailabilityChecker("stylelint"),
			"stylelint",
			cwd,
		);
		// A new session must correct the new session's own latch, not inherit
		// the last one's verdict.
		resetDispatchAvailabilityState();
		await resolveAvailableOrInstall(
			createAvailabilityChecker("stylelint"),
			"stylelint",
			cwd,
		);

		const available = availabilityDecisions().filter(
			(record) => record.metadata.verdict === "available",
		);
		expect(available).toHaveLength(2);
	});

	it("reset starts a fresh flight instead of joining the stale one", async () => {
		const safeSpawnMod = await import("../../../../clients/safe-spawn.js");
		const releases: Array<(value: unknown) => void> = [];
		vi.mocked(safeSpawnMod.safeSpawnAsync).mockImplementation(
			() =>
				new Promise((resolve) =>
					releases.push(resolve as (value: unknown) => void),
				),
		);
		const checker = createAvailabilityChecker("reset-flight-tool");
		const first = checker.isAvailableAsync(process.cwd());
		await vi.waitFor(() =>
			expect(safeSpawnMod.safeSpawnAsync).toHaveBeenCalledTimes(1),
		);
		checker.reset();
		const second = checker.isAvailableAsync(process.cwd());
		await vi.waitFor(() =>
			expect(safeSpawnMod.safeSpawnAsync).toHaveBeenCalledTimes(2),
		);

		releases[0]?.({ stdout: "", stderr: "", status: 0 });
		releases[1]?.({ stdout: "", stderr: "", status: 0 });
		expect(await Promise.all([first, second])).toEqual([true, true]);
	});

	/**
	 * #1674 delta F6(c) — the #1612 seam records its own latch before emitting,
	 * so the emitter READS that a correction is happening from the same ledger
	 * every caller reads. Without that write, a checker whose command differs
	 * from the toolId leaves the emitter with nothing to find.
	 */
	it("reads its own latch when the checker's command differs from the toolId", async () => {
		const installerMod = await import("../../../../clients/installer/index.js");
		const safeSpawnMod = await import("../../../../clients/safe-spawn.js");
		vi.mocked(installerMod.isSpawnableCommand).mockResolvedValue(false);
		vi.mocked(installerMod.ensureTool).mockResolvedValue(
			"/managed/bin/stylelint",
		);
		vi.mocked(installerMod.getInstallAttempt).mockReturnValue(undefined);
		vi.mocked(safeSpawnMod.safeSpawnAsync).mockResolvedValue(missingProbe);
		const cwd = process.cwd();

		// Checker command "stylelint-bin", toolId "stylelint": the latched row
		// carries the command, and a failed probe leaves `getCommand` null, so
		// only the seam's own record can answer for this correction.
		await resolveAvailableOrInstall(
			createAvailabilityChecker("stylelint-bin"),
			"stylelint",
			cwd,
		);

		const available = availabilityDecisions().filter(
			(record) => record.metadata.verdict === "available",
		);
		expect(available).toHaveLength(1);
		expect(available[0].metadata.evidence).toMatchObject({
			correctsLatchedRow: true,
		});
	});
});

/**
 * #1657 — `findManagedNodeToolBinary` answered from a bare `existsSync` while
 * the installer's own managed-first branch runs `verifyToolBinary` before it
 * returns a managed path. A shim that exists but cannot run therefore won a
 * race it should have lost, and shadowed a working PATH binary for the rest of
 * the session.
 */
describe("managed shim resolution verifies the binary (#1657)", () => {
	const originalPiLensHome = process.env.PI_LENS_HOME;

	afterEach(() => {
		if (originalPiLensHome === undefined) delete process.env.PI_LENS_HOME;
		else process.env.PI_LENS_HOME = originalPiLensHome;
	});

	function writeManagedShim(homeDir: string, tool: string): string {
		const shim =
			process.platform === "win32"
				? path.join(homeDir, "tools", "node_modules", ".bin", `${tool}.cmd`)
				: path.join(homeDir, "tools", "node_modules", ".bin", tool);
		fs.mkdirSync(path.dirname(shim), { recursive: true });
		fs.writeFileSync(shim, "#!/bin/sh\nexit 0\n");
		return shim;
	}

	it("falls through to PATH when the managed shim does not run", async () => {
		const installerMod = await import("../../../../clients/installer/index.js");
		const env = setupTestEnvironment("pi-lens-managed-broken-");
		try {
			process.env.PI_LENS_HOME = env.tmpDir;
			resetDispatchAvailabilityState();
			writeManagedShim(env.tmpDir, "brokentool");
			// The prober ran and the binary rejected `--version`: a real verdict.
			vi.mocked(installerMod.verifyToolBinary).mockResolvedValue(false);

			const cwdWithNoVenv = setupTestEnvironment("pi-lens-managed-broken-cwd-");
			try {
				const resolved = await createVenvFinder(
					"brokentool",
					".exe",
				)(cwdWithNoVenv.tmpDir);
				expect(resolved).toEqual({ path: "brokentool", rung: "path" });
			} finally {
				cwdWithNoVenv.cleanup();
			}
		} finally {
			vi.mocked(installerMod.verifyToolBinary).mockResolvedValue(true);
			env.cleanup();
		}
	});

	it("keeps the managed shim when the verification probe never ran", async () => {
		const installerMod = await import("../../../../clients/installer/index.js");
		const env = setupTestEnvironment("pi-lens-managed-transient-");
		try {
			process.env.PI_LENS_HOME = env.tmpDir;
			resetDispatchAvailabilityState();
			const shim = writeManagedShim(env.tmpDir, "stalledtool");
			// A spawn timeout, not a verdict: an unspawnable prober is never a
			// durable answer, so the on-disk shim keeps the fast path (#1569).
			vi.mocked(installerMod.verifyToolBinary).mockImplementation(
				async (_bin, _onVersion, onTransient) => {
					onTransient?.();
					return false;
				},
			);

			const cwdWithNoVenv = setupTestEnvironment(
				"pi-lens-managed-transient-cwd-",
			);
			try {
				const resolved = await createVenvFinder(
					"stalledtool",
					".exe",
				)(cwdWithNoVenv.tmpDir);
				expect(resolved).toEqual({ path: shim, rung: "managed-dir" });
			} finally {
				cwdWithNoVenv.cleanup();
			}
		} finally {
			vi.mocked(installerMod.verifyToolBinary).mockReset();
			vi.mocked(installerMod.verifyToolBinary).mockResolvedValue(true);
			env.cleanup();
		}
	});

	it("verifies each shim once per session, then answers from the memo", async () => {
		const installerMod = await import("../../../../clients/installer/index.js");
		const env = setupTestEnvironment("pi-lens-managed-memo-");
		try {
			process.env.PI_LENS_HOME = env.tmpDir;
			resetDispatchAvailabilityState();
			const shim = writeManagedShim(env.tmpDir, "memotool");
			vi.mocked(installerMod.verifyToolBinary).mockClear();
			vi.mocked(installerMod.verifyToolBinary).mockResolvedValue(true);

			const finder = createVenvFinder("memotool", ".exe");
			const cwdWithNoVenv = setupTestEnvironment("pi-lens-managed-memo-cwd-");
			try {
				expect(await finder(cwdWithNoVenv.tmpDir)).toEqual({
					path: shim,
					rung: "managed-dir",
				});
				expect(await finder(cwdWithNoVenv.tmpDir)).toEqual({
					path: shim,
					rung: "managed-dir",
				});
				expect(await finder(cwdWithNoVenv.tmpDir)).toEqual({
					path: shim,
					rung: "managed-dir",
				});
				// #1467's no-spawn fast path survives: one verification, then the
				// memo answers.
				expect(installerMod.verifyToolBinary).toHaveBeenCalledTimes(1);
			} finally {
				cwdWithNoVenv.cleanup();
			}
		} finally {
			env.cleanup();
		}
	});

	/**
	 * #1674 review F1 — a verification that timed out returned "unverified"
	 * without recording anything, so every later resolve paid the full budget
	 * again. The reviewer measured real cold shims at just over 2s and 5
	 * resolves triggering 5 verifications. The verdict is now remembered under
	 * a bounded cooldown: the wait is paid once per window, and a shim that
	 * stalled on a cold cache is still re-probed later instead of being pinned
	 * "cannot verify" for the session.
	 */
	it("verifies once per cooldown window after a probe that never ran", async () => {
		const installerMod = await import("../../../../clients/installer/index.js");
		const env = setupTestEnvironment("pi-lens-managed-transient-memo-");
		try {
			process.env.PI_LENS_HOME = env.tmpDir;
			resetDispatchAvailabilityState();
			const shim = writeManagedShim(env.tmpDir, "slowtool");
			vi.mocked(installerMod.verifyToolBinary).mockReset();
			vi.mocked(installerMod.verifyToolBinary).mockImplementation(
				async (_bin, _onVersion, onTransient) => {
					onTransient?.();
					return false;
				},
			);

			const finder = createVenvFinder("slowtool", ".exe");
			const cwdWithNoVenv = setupTestEnvironment(
				"pi-lens-managed-transient-memo-cwd-",
			);
			try {
				for (let i = 0; i < 5; i += 1) {
					expect(await finder(cwdWithNoVenv.tmpDir)).toEqual({
						path: shim,
						rung: "managed-dir",
					});
				}
				expect(installerMod.verifyToolBinary).toHaveBeenCalledTimes(1);
			} finally {
				cwdWithNoVenv.cleanup();
			}
		} finally {
			vi.mocked(installerMod.verifyToolBinary).mockReset();
			vi.mocked(installerMod.verifyToolBinary).mockResolvedValue(true);
			env.cleanup();
		}
	});

	it("re-probes a stalled shim once the cooldown expires", async () => {
		const installerMod = await import("../../../../clients/installer/index.js");
		const env = setupTestEnvironment("pi-lens-managed-cooldown-");
		try {
			process.env.PI_LENS_HOME = env.tmpDir;
			resetDispatchAvailabilityState();
			const shim = writeManagedShim(env.tmpDir, "cooldowntool");
			vi.mocked(installerMod.verifyToolBinary).mockReset();
			vi.mocked(installerMod.verifyToolBinary).mockImplementation(
				async (_bin, _onVersion, onTransient) => {
					onTransient?.();
					return false;
				},
			);

			const finder = createVenvFinder("cooldowntool", ".exe");
			const cwdWithNoVenv = setupTestEnvironment(
				"pi-lens-managed-cooldown-cwd-",
			);
			const realNow = Date.now;
			try {
				expect(await finder(cwdWithNoVenv.tmpDir)).toEqual({
					path: shim,
					rung: "managed-dir",
				});
				// A stall is not a durable verdict, so the cooldown must expire —
				// otherwise one slow first touch pins "cannot verify" all session.
				const later = realNow() + 61_000;
				vi.spyOn(Date, "now").mockImplementation(() => later);
				expect(await finder(cwdWithNoVenv.tmpDir)).toEqual({
					path: shim,
					rung: "managed-dir",
				});
				expect(installerMod.verifyToolBinary).toHaveBeenCalledTimes(2);
			} finally {
				Date.now = realNow;
				cwdWithNoVenv.cleanup();
			}
		} finally {
			vi.mocked(installerMod.verifyToolBinary).mockReset();
			vi.mocked(installerMod.verifyToolBinary).mockResolvedValue(true);
			env.cleanup();
		}
	});

	/**
	 * #1674 review F2 — four concurrent first touches ran four verifiers. The
	 * in-flight share mirrors `resolveInstallInFlightByCwd`: one probe, four
	 * awaiters.
	 */
	/**
	 * #1674 delta F5 — a verification that straddles a session boundary answers
	 * its own caller, but its verdict belongs to the session that asked. Written
	 * into the fresh session, it hands the new session the old one's cooldown,
	 * which is exactly the state `session_start` exists to re-arm.
	 */
	it("does not seed the fresh session from a verification that straddled the reset", async () => {
		const installerMod = await import("../../../../clients/installer/index.js");
		const env = setupTestEnvironment("pi-lens-managed-straddle-");
		try {
			process.env.PI_LENS_HOME = env.tmpDir;
			resetDispatchAvailabilityState();
			const shim = writeManagedShim(env.tmpDir, "straddletool");
			vi.mocked(installerMod.verifyToolBinary).mockReset();
			// The session boundary falls INSIDE the verification, so the ordering
			// is deterministic rather than left to scheduling luck. The stall
			// verdict this call produces belongs to the session that is ending.
			let boundaryCrossed = false;
			vi.mocked(installerMod.verifyToolBinary).mockImplementation(
				async (_bin, _onVersion, onTransient) => {
					if (!boundaryCrossed) {
						boundaryCrossed = true;
						resetDispatchAvailabilityState();
					}
					onTransient?.();
					return false;
				},
			);

			expect(await findManagedNodeToolBinary("straddletool")).toBe(shim);
			// The fresh session starts with no memo and no cooldown, so it probes
			// for itself instead of inheriting the last session's stall.
			expect(await findManagedNodeToolBinary("straddletool")).toBe(shim);
			expect(installerMod.verifyToolBinary).toHaveBeenCalledTimes(2);
		} finally {
			vi.mocked(installerMod.verifyToolBinary).mockReset();
			vi.mocked(installerMod.verifyToolBinary).mockResolvedValue(true);
			env.cleanup();
		}
	});

	it("shares one verification across concurrent first touches", async () => {
		const installerMod = await import("../../../../clients/installer/index.js");
		const env = setupTestEnvironment("pi-lens-managed-inflight-");
		try {
			process.env.PI_LENS_HOME = env.tmpDir;
			resetDispatchAvailabilityState();
			const shim = writeManagedShim(env.tmpDir, "concurrenttool");
			vi.mocked(installerMod.verifyToolBinary).mockReset();
			// The second resolve starts from INSIDE the first verification, so
			// the overlap is guaranteed rather than left to scheduling luck. It
			// is deliberately not awaited here: the whole point is that it joins
			// the probe already running instead of starting a second one.
			let racer: Promise<string | null> | null = null;
			vi.mocked(installerMod.verifyToolBinary).mockImplementation(async () => {
				racer ??= findManagedNodeToolBinary("concurrenttool");
				return true;
			});

			const first = await findManagedNodeToolBinary("concurrenttool");

			expect(first).toBe(shim);
			expect(racer).not.toBeNull();
			expect(await Promise.resolve(racer)).toBe(shim);
			expect(installerMod.verifyToolBinary).toHaveBeenCalledTimes(1);
		} finally {
			vi.mocked(installerMod.verifyToolBinary).mockReset();
			vi.mocked(installerMod.verifyToolBinary).mockResolvedValue(true);
			env.cleanup();
		}
	});
});
