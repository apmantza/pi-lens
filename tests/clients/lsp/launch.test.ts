import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("lsp launch", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.resetModules();
		vi.clearAllMocks();
	});

	it.runIf(process.platform !== "win32")(
		"spawns LSP servers in their own process group on POSIX",
		async () => {
			const spawnMock = vi.fn(() => {
				class MockStream extends EventEmitter {}
				class MockChildProcess extends EventEmitter {
					stdin = new MockStream();
					stdout = new MockStream();
					stderr = new MockStream();
					pid = 2468;
					exitCode: number | null = null;
					killed = false;
				}
				return new MockChildProcess();
			});

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

	it.runIf(process.platform === "win32")(
		"treats delayed shell-backed startup failure as launch failure",
		async () => {
			vi.useFakeTimers();

			vi.doMock("node:child_process", () => {
				class MockStream extends EventEmitter {}
				class MockChildProcess extends EventEmitter {
					stdin = new MockStream();
					stdout = new MockStream();
					stderr = new MockStream();
					pid = 4321;
					exitCode: number | null = null;
					killed = false;
				}

				return {
					execSync: vi.fn(() => ""),
					spawn: vi.fn(() => {
						const proc = new MockChildProcess();
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

	it.runIf(process.platform === "win32")(
		"resolves bare commands through where before spawning",
		async () => {
			const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-launch-"));
			const resolvedBinary = path.join(tempDir, "taplo.exe");
			fs.writeFileSync(resolvedBinary, "");
			vi.doMock("node:child_process", () => {
				class MockStream extends EventEmitter {}
				class MockChildProcess extends EventEmitter {
					stdin = new MockStream();
					stdout = new MockStream();
					stderr = new MockStream();
					pid = 9876;
					exitCode: number | null = null;
					killed = false;
				}

				return {
					execSync: vi.fn((command: string) => {
						if (command === "where taplo") {
							return `${resolvedBinary}\r\n`;
						}
						return "";
					}),
					spawn: vi.fn(() => new MockChildProcess()),
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
				class MockStream extends EventEmitter {}
				class MockChildProcess extends EventEmitter {
					stdin = new MockStream();
					stdout = new MockStream();
					stderr = new MockStream();
					pid = 1234;
					exitCode: number | null = null;
					killed = false;
				}

				return {
					execSync: vi.fn(() => ""),
					spawn: vi.fn((command: string) => {
						spawnedCommand = command;
						return new MockChildProcess();
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
				class MockStream extends EventEmitter {}
				class MockChildProcess extends EventEmitter {
					stdin = new MockStream();
					stdout = new MockStream();
					stderr = new MockStream();
					pid = 5678;
					exitCode: number | null = null;
					killed = false;
				}

				return {
					execSync: vi.fn(() => ""),
					spawn: vi.fn((command: string, args: string[]) => {
						spawnedCommand = command;
						spawnedArgs = args;
						return new MockChildProcess();
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
