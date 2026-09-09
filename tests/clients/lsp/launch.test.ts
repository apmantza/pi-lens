import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { removeTempDirSync } from "../test-utils.js";

// These launch tests use fake timers and don't exercise Windows Ruby drive-root
// discovery. Stub the #1137 drive-root readers so `buildAugmentedPath`'s async
// `fs.promises.readdir("C:\\")` (real threadpool I/O, not fake-timer driven)
// can't stall the spawn sequence under `vi.useFakeTimers()`. Ruby-dir behavior
// is covered by tests/clients/lsp/ruby-drive-dirs.test.ts.
vi.mock("../../../clients/lsp/ruby-drive-dirs.js", () => ({
	getRubyVersionDirNamesSync: () => [],
	getRubyVersionDirNamesAsync: async () => [],
}));

// Single parameterized fake for the six near-identical `MockChildProcess`
// classes this file used to declare inline, one per `vi.doMock("node:child_
// process", ...)` factory. `vi.doMock` (unlike `vi.mock`) isn't hoisted, so
// its factory can close over a module-scope class like this one.
class MockStream extends EventEmitter {}
class MockChildProcess extends EventEmitter {
	stdin = new MockStream();
	stdout = new MockStream();
	stderr = new MockStream();
	exitCode: number | null = null;
	killed = false;
	constructor(public pid: number) {
		super();
	}
}

describe("lsp launch", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.resetModules();
		vi.clearAllMocks();
	});

	it.runIf(process.platform !== "win32")(
		"spawns LSP servers in their own process group on POSIX",
		async () => {
			const spawnMock = vi.fn(() => new MockChildProcess(2468));

			vi.doMock("node:child_process", () => ({
				execSync: vi.fn(() => ""),
				spawn: spawnMock,
			}));

			const { launchLSP } = await import("../../../clients/lsp/launch.js");
			await launchLSP("vscode-html-language-server", ["--stdio"], {
				cwd: "/tmp/project",
			});

			expect(spawnMock).toHaveBeenCalledWith(
				"vscode-html-language-server",
				["--stdio"],
				expect.objectContaining({ detached: true }),
			);
		},
	);

	it("redacts secrets in crash-adjacent session-start writes", async () => {
		const tempDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-launch-log-"),
		);
		const token = `ghp_${"a".repeat(36)}`;
		const command = path.join(
			tempDir,
			process.platform === "win32" ? "server.exe" : "server",
		);

		vi.doMock("node:child_process", () => ({
			execFileSync: vi.fn(() => ""),
			spawn: vi.fn(() => new MockChildProcess(8642)),
		}));
		vi.doMock("../../../clients/env-utils.js", () => ({
			isTestMode: () => false,
		}));
		vi.doMock("../../../clients/file-utils.js", () => ({
			getGlobalPiLensDir: () => tempDir,
		}));
		// #2506: sessionstart.log resolves through the LOG dir, so the double
		// must move that too — the assertion below reads
		// `<tempDir>/sessionstart.log`, which is only where launch.ts writes if
		// this resolver points at tempDir as well. #2516 round 2 moved the log
		// resolver off `file-utils.ts` onto the cycle-free `probe-home-state.ts`
		// leaf, so this doubles THAT module; doubling file-utils.js alone leaves
		// launch.ts writing to the real (vitest-pinned) log root.
		vi.doMock("../../../clients/probe-home-state.js", () => ({
			getGlobalPiLensLogDir: () => tempDir,
		}));

		try {
			const { launchLSP } = await import("../../../clients/lsp/launch.js");
			await launchLSP(command, [token], {
				cwd: tempDir,
				startupFailureWindowMs: 1,
			});

			const log = fs.readFileSync(
				path.join(tempDir, "sessionstart.log"),
				"utf8",
			);
			expect(log).not.toContain(token);
			expect(log).toContain("[REDACTED:github-token]");
		} finally {
			vi.doUnmock("../../../clients/env-utils.js");
			vi.doUnmock("../../../clients/file-utils.js");
			vi.doUnmock("../../../clients/probe-home-state.js");
			removeTempDirSync(tempDir);
		}
	});

	it("leaves probe-home-state.js un-truncated for later cases in this file", async () => {
		// Regression for the previous test's `vi.doMock("../../../clients/
		// probe-home-state.js", ...)` double, which stubbed only
		// `getGlobalPiLensLogDir`. `vi.resetModules()` in `afterEach` clears the
		// real-module cache but NOT the doMock registry, so a missing
		// `vi.doUnmock` for that module leaves every later dynamic import of it
		// (direct, or transitive through degradation-ledger.js) seeing the
		// truncated fake instead of the real module.
		const probeHomeState = await import("../../../clients/probe-home-state.js");
		expect(typeof probeHomeState.getProbeHomeRedirectEvent).toBe("function");
		expect(typeof probeHomeState.getProbeHomeResolution).toBe("function");
	});

	// lane: windows-vitest
	it.runIf(process.platform === "win32")(
		"treats delayed shell-backed startup failure as launch failure",
		async () => {
			vi.useFakeTimers();

			vi.doMock("node:child_process", () => {
				return {
					execSync: vi.fn(() => ""),
					spawn: vi.fn(() => {
						const proc = new MockChildProcess(4321);
						setTimeout(() => {
							proc.exitCode = 1;
							proc.emit("exit", 1, null);
							proc.emit("close", 1, null);
						}, 120);
						return proc;
					}),
				};
			});

			const { launchLSP } = await import("../../../clients/lsp/launch.js");
			const launchPromise = launchLSP(
				"C:\\fake\\bash-language-server.cmd",
				["start"],
				{
					cwd: "C:\\fake",
				},
			);
			const rejection = expect(launchPromise).rejects.toThrow(
				/exited immediately with code 1/i,
			);

			await vi.advanceTimersByTimeAsync(150);

			await rejection;
		},
	);

	// lane: windows-vitest
	it.runIf(process.platform === "win32")(
		"resolves bare commands through where before spawning",
		async () => {
			const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-launch-"));
			const resolvedBinary = path.join(tempDir, "taplo.exe");
			fs.writeFileSync(resolvedBinary, "");
			vi.doMock("node:child_process", () => {
				return {
					execSync: vi.fn((command: string) => {
						if (command === "where taplo") {
							return `${resolvedBinary}\r\n`;
						}
						return "";
					}),
					spawn: vi.fn(() => new MockChildProcess(9876)),
				};
			});

			const { launchLSP } = await import("../../../clients/lsp/launch.js");
			const launched = await launchLSP("taplo", ["lsp", "stdio"], {
				cwd: "C:\\fake",
			});

			expect(launched.pid).toBe(9876);
		},
	);

	describe("isCmdShimValid", () => {
		it("returns true when the shim target exists", async () => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-shim-"));
			const shimDir = path.join(dir, "bin");
			fs.mkdirSync(shimDir, { recursive: true });
			const shim = path.join(shimDir, "test.cmd");
			const target = path.join(shimDir, "..", "pkg", "bin", "cli.js");
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.writeFileSync(target, "");
			fs.writeFileSync(shim, `@"%~dp0\\..\\pkg\\bin\\cli.js" %*`);

			const { isCmdShimValid } = await import("../../../clients/lsp/launch.js");
			expect(isCmdShimValid(shim)).toBe(true);
		});

		it("returns false when the shim target is missing", async () => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-shim-"));
			const shimDir = path.join(dir, "bin");
			fs.mkdirSync(shimDir, { recursive: true });
			const shim = path.join(shimDir, "test.cmd");
			fs.writeFileSync(shim, `@"%~dp0\\..\\pkg\\bin\\cli.js" %*`);

			const { isCmdShimValid } = await import("../../../clients/lsp/launch.js");
			expect(isCmdShimValid(shim)).toBe(false);
		});

		it("returns true for non-npm shims", async () => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-shim-"));
			const shimDir = path.join(dir, "bin");
			fs.mkdirSync(shimDir, { recursive: true });
			const shim = path.join(shimDir, "test.cmd");
			fs.writeFileSync(shim, `@echo off\necho hello`);

			const { isCmdShimValid } = await import("../../../clients/lsp/launch.js");
			expect(isCmdShimValid(shim)).toBe(true);
		});

		it("returns true when the file cannot be read", async () => {
			const { isCmdShimValid } = await import("../../../clients/lsp/launch.js");
			expect(
				isCmdShimValid(path.join(os.tmpdir(), "nonexistent-shim.cmd")),
			).toBe(true);
		});

		it("handles .mjs targets", async () => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-shim-"));
			const shimDir = path.join(dir, "bin");
			fs.mkdirSync(shimDir, { recursive: true });
			const shim = path.join(shimDir, "test.cmd");
			const target = path.join(shimDir, "..", "pkg", "bin", "cli.mjs");
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.writeFileSync(target, "");
			fs.writeFileSync(shim, `@"%~dp0\\..\\pkg\\bin\\cli.mjs" %*`);

			const { isCmdShimValid } = await import("../../../clients/lsp/launch.js");
			expect(isCmdShimValid(shim)).toBe(true);
		});
	});

	// lane: windows-vitest
	it.runIf(process.platform === "win32")(
		"rejects immediately for an invalid .cmd shim without spawning",
		async () => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-shim-"));
			const shimDir = path.join(dir, "bin");
			fs.mkdirSync(shimDir, { recursive: true });
			const shim = path.join(shimDir, "test.cmd");
			fs.writeFileSync(shim, `@"%~dp0\\..\\pkg\\bin\\cli.js" %*`);

			const spawnSpy = vi.fn(() => {
				throw new Error("spawn should not be called");
			});
			vi.doMock("node:child_process", () => {
				return {
					execSync: vi.fn(() => ""),
					spawn: spawnSpy,
				};
			});

			const { launchLSP } = await import("../../../clients/lsp/launch.js");
			await expect(launchLSP(shim, ["start"], { cwd: dir })).rejects.toThrow(
				/LSP \.cmd shim target not found/i,
			);
			expect(spawnSpy).not.toHaveBeenCalled();
		},
	);

	// lane: windows-vitest
	it.runIf(process.platform === "win32")(
		"bypasses .ps1 to .cmd sibling on Windows",
		async () => {
			vi.useFakeTimers();
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-ps1-"));
			const ps1 = path.join(dir, "test.ps1");
			const cmd = path.join(dir, "test.cmd");
			fs.writeFileSync(ps1, `"$basedir/../pkg/bin/cli.js" "$@"`);
			fs.writeFileSync(cmd, `@"%~dp0\\..\\pkg\\bin\\cli.js" %*`);

			let spawnedCommand: string | undefined;
			vi.doMock("node:child_process", () => {
				return {
					execSync: vi.fn(() => ""),
					spawn: vi.fn((command: string) => {
						spawnedCommand = command;
						return new MockChildProcess(1234);
					}),
				};
			});

			const { launchLSP } = await import("../../../clients/lsp/launch.js");
			const launchPromise = launchLSP(ps1, ["start"], { cwd: dir });
			await vi.advanceTimersByTimeAsync(600);
			const result = await launchPromise;

			expect(spawnedCommand).toContain("test.cmd");
			expect(result.pid).toBe(1234);
		},
	);

	// lane: windows-vitest
	it.runIf(process.platform === "win32")(
		"bypasses .ps1 to direct node execution when .cmd sibling is missing",
		async () => {
			vi.useFakeTimers();
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-ps1-"));
			const ps1 = path.join(dir, "test.ps1");
			const jsTarget = path.join(dir, "..", "pkg", "bin", "cli.js");
			fs.mkdirSync(path.dirname(jsTarget), { recursive: true });
			fs.writeFileSync(jsTarget, "console.log('hello')");
			fs.writeFileSync(ps1, `"$basedir/../pkg/bin/cli.js" "$@"`);

			let spawnedCommand: string | undefined;
			let spawnedArgs: string[] | undefined;
			vi.doMock("node:child_process", () => {
				return {
					execSync: vi.fn(() => ""),
					spawn: vi.fn((command: string, args: string[]) => {
						spawnedCommand = command;
						spawnedArgs = args;
						return new MockChildProcess(5678);
					}),
				};
			});

			const { launchLSP } = await import("../../../clients/lsp/launch.js");
			const launchPromise = launchLSP(ps1, ["start"], { cwd: dir });
			await vi.advanceTimersByTimeAsync(100);
			const result = await launchPromise;

			expect(spawnedCommand).toBe(process.execPath);
			expect(spawnedArgs).toContain(jsTarget);
			expect(spawnedArgs).toContain("start");
			expect(result.pid).toBe(5678);
		},
	);
});
