import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createAvailabilityChecker,
	createCwdCachedProbe,
	createVenvFinder,
	findManagedNodeToolBinary,
	getSgCommand,
	isSgAvailableAsync,
	lspPrimaryCoversFile,
	resolveCommandArgsWithInstallFallback,
	resolveCommandWithInstallFallback,
	resolveAvailableOrInstall,
	resolveLocalFirstAsync,
	resolveNodeToolCommand,
	resolveToolCommand,
	resolveToolCommandWithInstallFallback,
	resetDispatchAvailabilityState,
	resolveVendorToolCommand,
	_setThisDirForTests,
} from "../../../../clients/dispatch/runners/utils/runner-helpers.js";
import type { DispatchContext } from "../../../../clients/dispatch/types.js";
import { findGlobalBinary } from "../../../../clients/package-manager.js";
import { setupTestEnvironment } from "../../test-utils.js";

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

vi.mock("../../../../clients/latency-logger.js", () => ({
	logLatency: logLatencySpy,
	getLastLoggedPhase: () => undefined,
}));

const availabilityDecisions = () =>
	logLatencySpy.mock.calls
		.map((call) => call[0])
		.filter((entry) => entry?.phase === "availability_decision");

/** #2544 round 4 F4: F1's own-install-vs-project class, visible in latency.log. */
const toolBinResolutions = () =>
	logLatencySpy.mock.calls
		.map((call) => call[0])
		.filter((entry) => entry?.phase === "tool_bin_resolved");

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

	it("resolves installed command after version check fallback", async () => {
		const installerMod = await import("../../../../clients/installer/index.js");
		vi.mocked(installerMod.isSpawnableCommand).mockResolvedValueOnce(false);
		vi.mocked(installerMod.ensureTool).mockResolvedValue("stylelint");

		const resolved = await resolveCommandWithInstallFallback(
			"stylelint",
			"stylelint",
			process.cwd(),
		);

		expect(installerMod.ensureTool).toHaveBeenCalledWith("stylelint");
		expect(resolved).toBe("stylelint");
	});

	it("preserves existing command args when project command verifies", async () => {
		const safeSpawnMod = await import("../../../../clients/safe-spawn.js");
		vi.mocked(safeSpawnMod.safeSpawnAsync).mockResolvedValueOnce({
			stdout: "rubocop 1.0.0",
			stderr: "",
			status: 0,
		});

		const resolved = await resolveCommandArgsWithInstallFallback(
			{ cmd: "bundle", args: ["exec", "rubocop"] },
			"rubocop",
			process.cwd(),
			["--version"],
			10000,
		);

		expect(resolved).toEqual({ cmd: "bundle", args: ["exec", "rubocop"] });
		expect(
			vi.mocked(safeSpawnMod.safeSpawnAsync).mock.calls[0]?.[2],
		).toMatchObject({
			input: "",
		});
	});

	it("closes stdin on the fallback verification probe", async () => {
		const safeSpawnMod = await import("../../../../clients/safe-spawn.js");
		const installerMod = await import("../../../../clients/installer/index.js");
		vi.mocked(installerMod.isSpawnableCommand).mockResolvedValue(true);
		vi.mocked(safeSpawnMod.safeSpawnAsync)
			.mockResolvedValueOnce({ stdout: "", stderr: "rejected", status: 1 })
			.mockResolvedValueOnce({ stdout: "tool 1.0.0", stderr: "", status: 0 });

		await expect(
			resolveCommandArgsWithInstallFallback(
				{ cmd: "tool", args: [] },
				"tool",
				process.cwd(),
			),
		).resolves.toEqual({ cmd: "tool", args: [] });
		expect(
			vi.mocked(safeSpawnMod.safeSpawnAsync).mock.calls[1]?.[2],
		).toMatchObject({
			input: "",
		});
	});

	it("does not auto-install config-first tools", async () => {
		const safeSpawnMod = await import("../../../../clients/safe-spawn.js");
		const installerMod = await import("../../../../clients/installer/index.js");
		vi.mocked(safeSpawnMod.safeSpawnAsync).mockResolvedValueOnce({
			stdout: "",
			stderr: "not found",
			status: 1,
		});

		const resolved = await resolveCommandWithInstallFallback(
			"eslint",
			"eslint",
			process.cwd(),
		);
		const resolvedByToolId = await resolveToolCommandWithInstallFallback(
			process.cwd(),
			"eslint",
		);

		expect(installerMod.ensureTool).not.toHaveBeenCalled();
		expect(resolved).toBeNull();
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

	/**
	 * #2514 / #2544 review F1, through the real availability sweep.
	 *
	 * `buildSgLocalBins` collected its bin roots with a private
	 * `findNodeBinRoots` climb that had NO home ceiling and ran to the
	 * filesystem root, so on any box with a home-level `node_modules` (the
	 * pi-extensions manifest installs its own bins) `$HOME` itself came back as
	 * a bin root and an unrelated ast-grep was probed — and, if it answered,
	 * used — as though it were this project's own. The reviewer's probe
	 * reproduced exactly this against the maintainer's real home.
	 */
	it("never probes an ast-grep planted at HOME (#2514)", async () => {
		const env = setupTestEnvironment("pi-lens-sg-home-ceiling-");
		const originalHome = process.env.HOME;
		const originalUserProfile = process.env.USERPROFILE;
		const originalCwd = process.cwd();
		try {
			const fakeHome = env.tmpDir;
			const project = path.join(fakeHome, "project");
			fs.mkdirSync(project, { recursive: true });
			const homeBinDir = path.join(fakeHome, "node_modules", ".bin");
			fs.mkdirSync(homeBinDir, { recursive: true });
			const planted = ["ast-grep", "ast-grep.cmd", "ast-grep.exe", "sg"].map(
				(name) => path.join(homeBinDir, name),
			);
			for (const bin of planted) fs.writeFileSync(bin, "#!/bin/sh\nexit 0\n");

			process.env.HOME = fakeHome;
			process.env.USERPROFILE = fakeHome;
			process.chdir(project);
			resetDispatchAvailabilityState();

			const safeSpawnMod = await import("../../../../clients/safe-spawn.js");
			vi.mocked(safeSpawnMod.safeSpawnAsync).mockReset();
			vi.mocked(safeSpawnMod.safeSpawnAsync).mockResolvedValue({
				stdout: "",
				stderr: "missing",
				status: 1,
			});

			expect(await isSgAvailableAsync()).toBe(false);

			const probed = vi
				.mocked(safeSpawnMod.safeSpawnAsync)
				.mock.calls.map((call) => call[0]);
			for (const bin of planted) expect(probed).not.toContain(bin);
		} finally {
			process.chdir(originalCwd);
			if (originalHome === undefined) delete process.env.HOME;
			else process.env.HOME = originalHome;
			if (originalUserProfile === undefined) delete process.env.USERPROFILE;
			else process.env.USERPROFILE = originalUserProfile;
			resetDispatchAvailabilityState();
			env.cleanup();
		}
	});

	/**
	 * #2544 round 4 F1. The ceiling above stops the PROJECT walk (from
	 * `process.cwd()`) at HOME — correctly. But `buildSgLocalBins` ALSO walks
	 * from `_thisDir`, pi-lens's own install directory, to find its OWN
	 * bundled `@ast-grep/cli` shim. `pi install npm:pi-lens` installs into the
	 * HOME-level manifest (`~/package.json` -> `~/node_modules/pi-lens`), so
	 * that shim can sit AT `~/node_modules/.bin/ast-grep` — exactly the
	 * directory the ceiling exists to stop the PROJECT walk at. Applying the
	 * same ceiling to the own-install walk made it return nothing for this
	 * layout: PATH, `findGlobalBinary` and npx do not cover this location
	 * either, so ast-grep silently went unavailable on a box installed this
	 * way. `_setThisDirForTests` places the own-install walk's start directory
	 * under a synthetic HOME (real `_thisDir` cannot be relocated without
	 * writing into this process's actual shared `node_modules`).
	 */
	it("resolves pi-lens's OWN bundled ast-grep even when its install tree sits AT HOME (#2544 round 4 F1)", async () => {
		const env = setupTestEnvironment("pi-lens-sg-own-install-home-");
		const cwdEnv = setupTestEnvironment("pi-lens-sg-own-install-cwd-");
		const originalHome = process.env.HOME;
		const originalUserProfile = process.env.USERPROFILE;
		const originalCwd = process.cwd();
		try {
			const fakeHome = env.tmpDir;
			// `pi install npm:pi-lens`'s layout: the running file sits deep under
			// the HOME-level node_modules install, e.g.
			// ~/node_modules/pi-lens/dist/clients/dispatch/runners/utils/....js
			const ownInstallThisDir = path.join(
				fakeHome,
				"node_modules",
				"pi-lens",
				"dist",
				"clients",
				"dispatch",
				"runners",
				"utils",
			);
			fs.mkdirSync(ownInstallThisDir, { recursive: true });
			const homeBinDir = path.join(fakeHome, "node_modules", ".bin");
			fs.mkdirSync(homeBinDir, { recursive: true });
			const ext = process.platform === "win32" ? ".cmd" : "";
			const homeShim = path.join(homeBinDir, `ast-grep${ext}`);
			fs.writeFileSync(homeShim, "#!/bin/sh\nexit 0\n");

			process.env.HOME = fakeHome;
			process.env.USERPROFILE = fakeHome;
			process.chdir(cwdEnv.tmpDir);
			_setThisDirForTests(ownInstallThisDir);
			resetDispatchAvailabilityState();
			logLatencySpy.mockClear();

			const safeSpawnMod = await import("../../../../clients/safe-spawn.js");
			vi.mocked(safeSpawnMod.safeSpawnAsync).mockReset();
			vi.mocked(safeSpawnMod.safeSpawnAsync).mockImplementation(async (cmd) => {
				if (String(cmd) === homeShim) {
					return { stdout: "ast-grep 0.1.0", stderr: "", status: 0 };
				}
				return { stdout: "", stderr: "missing", status: 1 };
			});

			expect(await isSgAvailableAsync()).toBe(true);
			expect(getSgCommand().cmd).toBe(homeShim);

			// #2544 round 4 F4: the own-install/project distinction F1 fixed is
			// now visible in latency.log, not only inferable from a bin's
			// absence.
			const resolutions = toolBinResolutions();
			expect(resolutions).toHaveLength(1);
			expect(resolutions[0]?.metadata).toMatchObject({
				tool: "ast-grep",
				source: "own-install",
				ceilingApplied: false,
			});
		} finally {
			_setThisDirForTests(undefined);
			process.chdir(originalCwd);
			if (originalHome === undefined) delete process.env.HOME;
			else process.env.HOME = originalHome;
			if (originalUserProfile === undefined) delete process.env.USERPROFILE;
			else process.env.USERPROFILE = originalUserProfile;
			resetDispatchAvailabilityState();
			env.cleanup();
			cwdEnv.cleanup();
		}
	});

	/**
	 * #2544 round 4 F4, the other half: a match from the PROJECT walk
	 * (`process.cwd()`) logs `source: "project"` / `ceilingApplied: true`, so
	 * the two branches of F1's fix are distinguishable in latency.log rather
	 * than looking identical.
	 */
	it("logs source: project, ceilingApplied: true for a project-local ast-grep match (#2544 round 4 F4)", async () => {
		const cwdEnv = setupTestEnvironment("pi-lens-sg-project-bin-");
		const originalCwd = process.cwd();
		try {
			const projectBinDir = path.join(cwdEnv.tmpDir, "node_modules", ".bin");
			fs.mkdirSync(projectBinDir, { recursive: true });
			const ext = process.platform === "win32" ? ".cmd" : "";
			const projectBin = path.join(projectBinDir, `ast-grep${ext}`);
			fs.writeFileSync(projectBin, "#!/bin/sh\nexit 0\n");

			process.chdir(cwdEnv.tmpDir);
			resetDispatchAvailabilityState();
			logLatencySpy.mockClear();

			const safeSpawnMod = await import("../../../../clients/safe-spawn.js");
			vi.mocked(safeSpawnMod.safeSpawnAsync).mockReset();
			vi.mocked(safeSpawnMod.safeSpawnAsync).mockImplementation(async (cmd) => {
				if (String(cmd) === projectBin) {
					return { stdout: "ast-grep 0.1.0", stderr: "", status: 0 };
				}
				return { stdout: "", stderr: "missing", status: 1 };
			});

			expect(await isSgAvailableAsync()).toBe(true);
			expect(getSgCommand().cmd).toBe(projectBin);

			const resolutions = toolBinResolutions();
			expect(resolutions).toHaveLength(1);
			expect(resolutions[0]?.metadata).toMatchObject({
				tool: "ast-grep",
				source: "project",
				ceilingApplied: true,
			});
		} finally {
			process.chdir(originalCwd);
			resetDispatchAvailabilityState();
			cwdEnv.cleanup();
		}
	});

	it("resets the shared ast-grep availability memo at session start", async () => {
		const safeSpawnMod = await import("../../../../clients/safe-spawn.js");
		const installerMod = await import("../../../../clients/installer/index.js");
		vi.mocked(safeSpawnMod.safeSpawnAsync).mockResolvedValue({
			stdout: "",
			stderr: "missing",
			status: 1,
		});
		expect(await isSgAvailableAsync()).toBe(false);
		vi.mocked(installerMod.resetPathWalkMemo).mockClear();
		resetDispatchAvailabilityState();
		expect(installerMod.resetPathWalkMemo).toHaveBeenCalledOnce();
		vi.mocked(safeSpawnMod.safeSpawnAsync).mockResolvedValue({
			stdout: "ast-grep 0.40.0",
			stderr: "",
			status: 0,
		});
		expect(await isSgAvailableAsync()).toBe(true);
		expect(getSgCommand().cmd).toContain("ast-grep");
	});

	/**
	 * In-flight ABA release (#1968, kit-driven white-box probe).
	 *
	 * Unlike dead-code-client's/knip-client's LATENT sibling (needs a future
	 * second writer to reach), this one is LIVE today: `ensureCurrentSgGeneration`
	 * IS the second writer. A session-boundary reset (`resetDispatchAvailabilityState`)
	 * bumps the generation; the NEXT caller's `ensureCurrentSgGeneration` nulls
	 * `sgAvailableInFlight` and starts a fresh flight B. Pre-fix, A's own bare
	 * `sgAvailableInFlight = null` in its `.finally` clobbers that slot when A
	 * later settles, even though B is still running — so a caller right after
	 * shares nothing and starts a redundant THIRD probe.
	 */
	it("a late-settling probe does not evict its mid-flight successor across a reset (#1968)", async () => {
		const safeSpawnMod = await import("../../../../clients/safe-spawn.js");
		// This worktree's real node_modules/.bin carries local ast-grep/sg
		// binaries, so each flight probes SEVERAL candidates in sequence, not
		// just one. A's gated candidate REJECTS rather than resolves, so its
		// sweep throws immediately instead of trying further candidates and
		// recording a durable verdict — that write would otherwise race the
		// shared `sgLatch` ahead of B's own (newer-generation) verdict, which is
		// a separate concern from the in-flight MAP identity this test pins.
		const gates: Array<{
			resolve: (value: {
				stdout: string;
				stderr: string;
				status: number;
			}) => void;
			reject: (err: Error) => void;
		}> = [];
		let calls = 0;
		vi.mocked(safeSpawnMod.safeSpawnAsync).mockImplementation((async () => {
			calls += 1;
			if (calls <= 2) {
				return new Promise((resolve, reject) => {
					gates.push({ resolve, reject });
				});
			}
			return { stdout: "", stderr: "missing", status: 1 };
		}) as never);

		const buildA = isSgAvailableAsync(); // A in flight, call #1 pending
		buildA.catch(() => {}); // rejection is asserted below; suppress Node's warning
		expect(calls).toBe(1);

		// The second writer: a session boundary lands mid-flight.
		resetDispatchAvailabilityState();

		const buildB = isSgAvailableAsync(); // generation mismatch supersedes A
		expect(calls).toBe(2); // B started its OWN probe rather than sharing A's

		// A settles late (rejects, never reaching a latch write).
		gates[0]!.reject(new Error("probe blew up"));
		await expect(buildA).rejects.toThrow("probe blew up");

		// A THIRD caller in the same (B's) generation must share B's flight —
		// not start a fresh probe, which is what the bare unconditional clear
		// breaks (pre-fix: `sgAvailableInFlight` is null here, so this call
		// starts a THIRD safeSpawnAsync invocation instead of joining B). Every
		// `isSgAvailableAsync` call gets its OWN promise wrapper (it is an
		// `async function`, so even `return sgAvailableInFlight` is re-wrapped),
		// so "shared" is proven by the absence of a new probe call below, not by
		// promise identity.
		const buildC = isSgAvailableAsync();
		expect(calls).toBe(2); // no new call: C joined B's flight

		// Release B's own gated candidate as a match, so its sweep settles true.
		gates[1]!.resolve({ stdout: "ast-grep 0.40.0", stderr: "", status: 0 });
		expect(await buildB).toBe(true);
		expect(await buildC).toBe(true);
	});

	it("does not re-serve a retained ast-grep winner this sweep just proved durably missing (#1593)", async () => {
		const safeSpawnMod = await import("../../../../clients/safe-spawn.js");
		try {
			vi.useFakeTimers({ toFake: ["Date"] });
			vi.setSystemTime(new Date(1_700_000_000_000));

			// Sweep 1: every earlier tier stalls (transient); npx answers, so the
			// win is provisional and memoized as `cmd: "npx"`.
			vi.mocked(safeSpawnMod.safeSpawnAsync).mockImplementation(((
				cmd: string,
			) => {
				if (cmd === "npx") {
					return Promise.resolve({
						stdout: "ast-grep 0.40.0",
						stderr: "",
						status: 0,
					});
				}
				return Promise.resolve({
					stdout: "",
					stderr: "",
					status: null,
					failure: "timeout",
					spawnFailure: { kind: "timeout" },
				});
			}) as never);
			expect(await isSgAvailableAsync()).toBe(true);
			expect(getSgCommand().cmd).toBe("npx");

			// Let the provisional cooldown expire so the next call re-sweeps
			// instead of serving the memoized verdict straight from the latch.
			vi.setSystemTime(new Date(Date.now() + 301_000));

			// Sweep 2: the memoized winner (npx) now ENOENTs — durably missing —
			// while an unrelated earlier tier merely stalls again. The retained
			// arm must NOT re-serve the dead `npx` command just because a sibling
			// stalled in the same sweep.
			vi.mocked(safeSpawnMod.safeSpawnAsync).mockImplementation(((
				cmd: string,
			) => {
				if (cmd === "npx") {
					return Promise.resolve({
						stdout: "",
						stderr: "",
						status: null,
						error: Object.assign(new Error("npx ENOENT"), {
							code: "ENOENT",
						}),
						failure: "spawn",
						spawnFailure: { kind: "tool-not-found" },
					});
				}
				return Promise.resolve({
					stdout: "",
					stderr: "",
					status: null,
					failure: "timeout",
					spawnFailure: { kind: "timeout" },
				});
			}) as never);
			expect(await isSgAvailableAsync()).toBe(false);
		} finally {
			vi.useRealTimers();
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

	it("lspPrimaryCoversFile: true when the named server is the file's primary (#233)", () => {
		const ctx = {
			filePath: "/proj/config.toml",
			pi: { getFlag: () => false },
		} as unknown as DispatchContext;
		// the `toml` LSP server (taplo lsp) is the sole primary for .toml
		expect(lspPrimaryCoversFile(ctx, "toml")).toBe(true);
		const sh = {
			filePath: "/proj/deploy.sh",
			pi: { getFlag: () => false },
		} as unknown as DispatchContext;
		expect(lspPrimaryCoversFile(sh, "bash")).toBe(true);
	});

	it("lspPrimaryCoversFile: false when no-lsp kills the runner (#233)", () => {
		const ctx = {
			filePath: "/proj/config.toml",
			pi: { getFlag: (f: string) => f === "no-lsp" },
		} as unknown as DispatchContext;
		expect(lspPrimaryCoversFile(ctx, "toml")).toBe(false);
	});

	it("lspPrimaryCoversFile: false when the server is not this file's primary (#233)", () => {
		// a .py file's primary is the python server, not toml — so the taplo CLI
		// must NOT self-skip on it.
		const ctx = {
			filePath: "/proj/main.py",
			pi: { getFlag: () => false },
		} as unknown as DispatchContext;
		expect(lspPrimaryCoversFile(ctx, "toml")).toBe(false);
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
			// EXT-OUTER / DIR-INNER — the same order `formatters.ts`'s
			// `findInVenv` always used, and the right one on Windows, where the
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
			expect(resolved).toBe(toolPath);
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
				expect(resolved).toBe(managedBin);
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
			expect(resolved).toBe(managedBin);
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
			expect(resolved).toBe(venvBin);
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

			expect(await createVenvFinder("ruff", ".exe")(pkg)).toBe("ruff");
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
			expect(await createVenvFinder("homeonlytool", ".exe")(project)).toBe(
				"homeonlytool",
			);
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
			expect(resolved).toBe("totally-unknown-tool");
		} finally {
			env.cleanup();
		}
	});
});

/**
 * #1636 — third #1606-family site: `resolveToolCommandWithInstallFallback` and
 * `resolveCommandArgsWithInstallFallback` recover a tool after a checker
 * already latched it `unavailable`, but wrote no compensating `available` row.
 * markdownlint hit this in production: the durable log kept saying the lane
 * was off while it ran and succeeded (#1636 evidence).
 *
 * These reuse the SAME row constructor #1612/#1615 landed for
 * `resolveAvailableOrInstall` (`emitCompensatingAvailableRow`), so the once-
 * per-correction memo and evidence derivation are exercised identically —
 * proven by the shared "once per correction" test below.
 */
describe("resolveToolCommandWithInstallFallback / resolveCommandArgsWithInstallFallback compensating row (#1636)", () => {
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

	it("resolveToolCommandWithInstallFallback: probe-ENOENT-then-fallback-success logs two rows, last available", async () => {
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

		// The runner's own checker probes first (mirrors markdownlint.ts:113-116)
		// and latches "unavailable" — row 1.
		const checker = createAvailabilityChecker("stylelint");
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
		expect(await checker.isAvailableAsync(process.cwd())).toBe(false);

		// The runner then falls back to the install-repair helper, which must
		// recover AND log the compensating row — pre-fix, this second row never
		// fired, leaving the durable log stuck on "unavailable".
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

	it("resolveCommandArgsWithInstallFallback: probe-then-install-success logs the compensating row", async () => {
		const installerMod = await import("../../../../clients/installer/index.js");
		const safeSpawnMod = await import("../../../../clients/safe-spawn.js");
		vi.mocked(installerMod.isSpawnableCommand).mockResolvedValue(false);
		vi.mocked(installerMod.ensureTool).mockResolvedValue(
			"/managed/bin/rubocop",
		);
		vi.mocked(installerMod.getInstallAttempt).mockReturnValue({
			outcome: "succeeded",
			at: Date.now(),
		});
		vi.mocked(installerMod.getToolInstallStrategy).mockReturnValue("github");
		// The caller's own probe (both the initial safeSpawnAsync inside
		// resolveCommandArgsWithInstallFallback AND verifyOrInstallCommand's own
		// version check) must miss to reach the install path.
		vi.mocked(safeSpawnMod.safeSpawnAsync).mockResolvedValue({
			stdout: "",
			stderr: "not found",
			status: 1,
		});

		const resolved = await resolveCommandArgsWithInstallFallback(
			{ cmd: "bundle", args: ["exec", "rubocop"] },
			"rubocop",
			process.cwd(),
		);

		expect(resolved).toEqual({ cmd: "/managed/bin/rubocop", args: [] });
		const available = availabilityDecisions().filter(
			(record) => record.metadata.verdict === "available",
		);
		expect(available).toHaveLength(1);
		expect(available[0].metadata.evidence).toMatchObject({
			install: "succeeded",
			binary: "rubocop",
			source: "github-release",
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
 * memo. `verifyOrInstallCommand` emits through the same seam with NO latched
 * row behind it: biome-check and oxlint call
 * `resolveToolCommandWithInstallFallback` directly, with no checker probe of
 * their own, so nothing has been latched when the installer resolves the tool.
 *
 * Burning the shared memo on that no-op emission silenced the NEXT genuine
 * latch-then-recover for the same (cwd, toolId) — the #1606 defect reachable
 * again through the #1612 seam, one tool registration away from being live.
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

	it("a no-latch emission does not silence the later genuine latch-then-recover", async () => {
		const installerMod = await import("../../../../clients/installer/index.js");
		const safeSpawnMod = await import("../../../../clients/safe-spawn.js");
		vi.mocked(installerMod.isSpawnableCommand).mockResolvedValue(false);
		vi.mocked(installerMod.ensureTool).mockResolvedValue(
			"/managed/bin/stylelint",
		);
		vi.mocked(installerMod.getInstallAttempt).mockReturnValue({
			outcome: "succeeded",
			at: Date.now(),
		});
		const cwd = process.cwd();

		// (a) The biome-check/oxlint shape: straight to the install seam, no
		// probe, so nothing is latched. The row it emits corrects nothing.
		await resolveToolCommandWithInstallFallback(cwd, "stylelint");

		// (b) A genuine latch: the checker probes, misses, and writes a latched
		// `unavailable` row. The installer then brings the tool back.
		vi.mocked(safeSpawnMod.safeSpawnAsync).mockResolvedValue(missingProbe);
		const checker = createAvailabilityChecker("stylelint");
		await resolveAvailableOrInstall(checker, "stylelint", cwd);

		const verdicts = availabilityDecisions().map(
			(record) => record.metadata.verdict,
		);
		// Pre-fix this ended at "unavailable": step (a) burned the memo, so the
		// real recovery was swallowed and the durable log kept saying the tool
		// was off while it ran.
		expect(verdicts).toEqual(["available", "unavailable", "available"]);
		expect(verdicts.at(-1)).toBe("available");
	});

	it("repeat no-latch emissions still log at most one row per pair", async () => {
		const installerMod = await import("../../../../clients/installer/index.js");
		vi.mocked(installerMod.isSpawnableCommand).mockResolvedValue(false);
		vi.mocked(installerMod.ensureTool).mockResolvedValue(
			"/managed/bin/stylelint",
		);
		vi.mocked(installerMod.getInstallAttempt).mockReturnValue(undefined);
		const cwd = process.cwd();

		await resolveToolCommandWithInstallFallback(cwd, "stylelint");
		await resolveToolCommandWithInstallFallback(cwd, "stylelint");
		await resolveToolCommandWithInstallFallback(cwd, "stylelint");

		// The uncorrected scope dedupes on its own: a runner that reaches this
		// seam on every dispatch must not re-log the same non-correction.
		expect(availabilityDecisions()).toHaveLength(1);
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
	 * #1674 review F4 — both rows say `verdict: "available"`, and only the
	 * evidence can tell a reader which one cleared a latched row.
	 */
	it("records on the row itself whether it corrected a latched row", async () => {
		const installerMod = await import("../../../../clients/installer/index.js");
		const safeSpawnMod = await import("../../../../clients/safe-spawn.js");
		vi.mocked(installerMod.isSpawnableCommand).mockResolvedValue(false);
		vi.mocked(installerMod.ensureTool).mockResolvedValue(
			"/managed/bin/stylelint",
		);
		vi.mocked(installerMod.getInstallAttempt).mockReturnValue(undefined);
		const cwd = process.cwd();

		await resolveToolCommandWithInstallFallback(cwd, "stylelint");
		vi.mocked(safeSpawnMod.safeSpawnAsync).mockResolvedValue(missingProbe);
		await resolveAvailableOrInstall(
			createAvailabilityChecker("stylelint"),
			"stylelint",
			cwd,
		);

		const available = availabilityDecisions().filter(
			(record) => record.metadata.verdict === "available",
		);
		expect(available).toHaveLength(2);
		expect(available[0].metadata.evidence).toMatchObject({
			correctsLatchedRow: false,
		});
		expect(available[1].metadata.evidence).toMatchObject({
			correctsLatchedRow: true,
		});
	});

	/**
	 * #1674 review F3 — a latch record must not outlive the row it describes.
	 * An `available` probe verdict clears it, so a later install-seam emission
	 * cannot read the stale entry as a correction it did not make.
	 */
	it("clears the latch record when a probe reports the tool available", async () => {
		const installerMod = await import("../../../../clients/installer/index.js");
		const safeSpawnMod = await import("../../../../clients/safe-spawn.js");
		vi.mocked(installerMod.isSpawnableCommand).mockResolvedValue(false);
		vi.mocked(installerMod.ensureTool).mockResolvedValue(
			"/managed/bin/stylelint",
		);
		vi.mocked(installerMod.getInstallAttempt).mockReturnValue(undefined);
		const cwd = process.cwd();
		const checker = createAvailabilityChecker("stylelint");

		// Probe misses: a latched `unavailable` row now stands.
		vi.mocked(safeSpawnMod.safeSpawnAsync).mockResolvedValue(missingProbe);
		expect(await checker.isAvailableAsync(cwd)).toBe(false);
		// Probe recovers on its own, with no install seam involved. The latched
		// row is gone, so nothing is left for a later emission to "correct".
		vi.mocked(safeSpawnMod.safeSpawnAsync).mockResolvedValue({
			stdout: "1.0.0",
			stderr: "",
			status: 0,
		});
		checker.reset();
		expect(await checker.isAvailableAsync(cwd)).toBe(true);

		await resolveToolCommandWithInstallFallback(cwd, "stylelint");

		const available = availabilityDecisions().filter(
			(record) => record.metadata.verdict === "available",
		);
		// Two: the probe's own recovery, then the install-seam row — which must
		// report itself as correcting nothing.
		expect(available).toHaveLength(2);
		expect(available[1].metadata.evidence).toMatchObject({
			correctsLatchedRow: false,
		});
	});

	/**
	 * #1674 delta F6(a) — the latch lives under whatever name its writer used.
	 * A checker built on a resolved path records THAT string, so an install-seam
	 * row keyed on the toolId alone would miss the very row it is correcting.
	 */
	it("finds a latch recorded under the checker's command, not the toolId", async () => {
		const installerMod = await import("../../../../clients/installer/index.js");
		const safeSpawnMod = await import("../../../../clients/safe-spawn.js");
		const command = path.join(path.sep, "usr", "local", "bin", "stylelint");
		vi.mocked(installerMod.isSpawnableCommand).mockResolvedValue(false);
		vi.mocked(installerMod.ensureTool).mockResolvedValue(
			"/managed/bin/stylelint",
		);
		vi.mocked(installerMod.getInstallAttempt).mockReturnValue(undefined);
		vi.mocked(safeSpawnMod.safeSpawnAsync).mockResolvedValue(missingProbe);
		const cwd = process.cwd();

		// The checker's own name IS the resolved path, so the latched row is
		// recorded under that path — never under "stylelint".
		expect(await createAvailabilityChecker(command).isAvailableAsync(cwd)).toBe(
			false,
		);
		await resolveCommandWithInstallFallback(command, "stylelint", cwd);

		const available = availabilityDecisions().filter(
			(record) => record.metadata.verdict === "available",
		);
		expect(available).toHaveLength(1);
		expect(available[0].metadata.evidence).toMatchObject({
			correctsLatchedRow: true,
		});
	});

	/**
	 * #1674 delta F6(b) — `createCwdCachedProbe` is the second latched-row
	 * producer, and its `available` verdict must clear the record too.
	 */
	it("clears the latch record on the shared cwd probe's available verdict", async () => {
		const installerMod = await import("../../../../clients/installer/index.js");
		vi.mocked(installerMod.isSpawnableCommand).mockResolvedValue(false);
		vi.mocked(installerMod.ensureTool).mockResolvedValue(
			"/managed/bin/stylelint",
		);
		vi.mocked(installerMod.getInstallAttempt).mockReturnValue(undefined);
		const cwd = process.cwd();

		let missing = true;
		const probe = createCwdCachedProbe(
			async () =>
				missing
					? {
							status: null,
							error: Object.assign(new Error("missing"), { code: "ENOENT" }),
							failure: "spawn" as const,
							spawnFailure: missingSpawnFailure(),
						}
					: { status: 0 },
			{ tool: "stylelint" },
		);

		expect(await probe(cwd)).toBe(false);
		missing = false;
		probe.reset();
		expect(await probe(cwd)).toBe(true);

		await resolveToolCommandWithInstallFallback(cwd, "stylelint");

		const available = availabilityDecisions().filter(
			(record) => record.metadata.verdict === "available",
		);
		expect(available).toHaveLength(2);
		expect(available[1].metadata.evidence).toMatchObject({
			correctsLatchedRow: false,
		});
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
				expect(resolved).toBe("brokentool");
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
				expect(resolved).toBe(shim);
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
				expect(await finder(cwdWithNoVenv.tmpDir)).toBe(shim);
				expect(await finder(cwdWithNoVenv.tmpDir)).toBe(shim);
				expect(await finder(cwdWithNoVenv.tmpDir)).toBe(shim);
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
					expect(await finder(cwdWithNoVenv.tmpDir)).toBe(shim);
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
				expect(await finder(cwdWithNoVenv.tmpDir)).toBe(shim);
				// A stall is not a durable verdict, so the cooldown must expire —
				// otherwise one slow first touch pins "cannot verify" all session.
				const later = realNow() + 61_000;
				vi.spyOn(Date, "now").mockImplementation(() => later);
				expect(await finder(cwdWithNoVenv.tmpDir)).toBe(shim);
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
			expect(await racer).toBe(shim);
			expect(installerMod.verifyToolBinary).toHaveBeenCalledTimes(1);
		} finally {
			vi.mocked(installerMod.verifyToolBinary).mockReset();
			vi.mocked(installerMod.verifyToolBinary).mockResolvedValue(true);
			env.cleanup();
		}
	});
});
