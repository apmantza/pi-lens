/**
 * Every pi-lens spawn of a System32 executable names it through `windowsExe`
 * (`scripts/lib/process-scan.mjs`, reached from `clients/` through
 * `clients/process-snapshot.ts`).
 *
 * Recurrence this guards: AGENTS.md shape 83 (a rule re-derived beside its
 * owner). Ten production sites spelled the pin by hand
 * (`${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\<exe>`) next to the
 * seam that already owns it, so the rule had eleven copies. Each cell below
 * drives one former copy through its production caller on a stubbed `win32`
 * platform, with `SystemRoot` spelled the way a raw concatenation would NOT
 * read it (forward slashes, a trailing slash). The seam answers a normalized
 * Windows path; a site that still concatenates answers
 * `Z:/Sentinel Root/\System32\...` and reds. Nothing mocks the seam: only
 * the child-process boundary is doubled, so the string asserted is the one the
 * real `windowsExe` produced inside the real caller.
 *
 * The `killPidTreeSync` copy (safe-spawn's exit-time tree kill) is driven by
 * `tests/clients/safe-spawn-kill-ownership.test.ts`, whose exact-string
 * expectation also holds with the seam in place.
 */
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Spelled so that raw concatenation and the seam's answer differ. */
const SENTINEL_SYSTEM_ROOT = "Z:/Sentinel Root/";
const system32 = (exe: string): string => `Z:\\Sentinel Root\\System32\\${exe}`;

class FakeStream extends EventEmitter {
	write() {
		return true;
	}
	end() {}
	setEncoding() {}
}

class FakeChild extends EventEmitter {
	stdin = new FakeStream();
	stdout = new FakeStream();
	stderr = new FakeStream();
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;
	killed = false;
	kill = vi.fn(() => {
		this.killed = true;
		return true;
	});
	unref() {}
	constructor(public pid: number) {
		super();
	}
}

interface SpawnCall {
	command: string;
	args: readonly string[];
}

const realPlatform = Object.getOwnPropertyDescriptor(process, "platform");
let savedSystemRoot: string | undefined;

function stubPlatform(platform: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", {
		value: platform,
		configurable: true,
	});
}

beforeEach(() => {
	savedSystemRoot = process.env.SystemRoot;
	process.env.SystemRoot = SENTINEL_SYSTEM_ROOT;
});

afterEach(() => {
	if (realPlatform) Object.defineProperty(process, "platform", realPlatform);
	if (savedSystemRoot === undefined) delete process.env.SystemRoot;
	else process.env.SystemRoot = savedSystemRoot;
	vi.doUnmock("node:child_process");
	vi.doUnmock("node:fs");
	vi.resetModules();
});

/**
 * A `node:child_process` double that records every start. `spawn` answers a
 * child per `makeChild`; `spawnSync` answers a clean exit.
 */
function doubleChildProcess(makeChild: (call: SpawnCall) => FakeChild): {
	spawns: SpawnCall[];
	syncs: SpawnCall[];
} {
	const spawns: SpawnCall[] = [];
	const syncs: SpawnCall[] = [];
	vi.doMock("node:child_process", () => ({
		spawn: vi.fn((command: string, args: readonly string[]) => {
			const call = { command, args };
			spawns.push(call);
			return makeChild(call);
		}),
		spawnSync: vi.fn((command: string, args: readonly string[]) => {
			syncs.push({ command, args });
			return { status: 0, stdout: "", stderr: "", pid: 0, signal: null };
		}),
		execSync: vi.fn(() => ""),
		execFileSync: vi.fn(() => ""),
	}));
	return { spawns, syncs };
}

/** `C:\fixture\tool.cmd` and `C:\fixture\tool.exe` exist as files; every other stat is real. */
function doubleFixtureToolsOnDisk(): void {
	vi.doMock("node:fs", async (importOriginal) => {
		const actual = await importOriginal<typeof import("node:fs")>();
		return {
			...actual,
			default: actual,
			statSync: (file: unknown, ...rest: unknown[]) => {
				if (
					file === "C:\\fixture\\tool.cmd" ||
					file === "C:\\fixture\\tool.exe"
				)
					return { isFile: () => true };
				return (actual.statSync as (...args: unknown[]) => unknown)(
					file,
					...rest,
				);
			},
		};
	});
}

/** A child that closes as soon as it is started. */
function closingChild(pid: number): FakeChild {
	const child = new FakeChild(pid);
	setImmediate(() => child.emit("close", 0, null));
	return child;
}

const SHIM_ENV = { PATH: "C:\\fixture", PATHEXT: ".CMD" };
const EXE_ENV = { PATH: "C:\\fixture", PATHEXT: ".EXE" };

async function trustProject(): Promise<void> {
	// #4530: this host reads the Windows-shaped PATH as a relative directory
	// under the session cwd, so the session's trust is adopted.
	const { setProjectTrustState } =
		await import("../../clients/project-trust.js");
	setProjectTrustState("trusted");
}

describe("safe-spawn names its System32 executables through the seam", () => {
	it("pins the UTF-8 code-page switch (chcp.com) in the cmd.exe command line", async () => {
		const { buildWindowsShellCommand } =
			await import("../../clients/safe-spawn.js");
		expect(
			buildWindowsShellCommand("tool", ["a"]).startsWith(
				`${system32("chcp.com")} 65001 >nul 2>&1 & `,
			),
		).toBe(true);
	});

	it("safeSpawnAsync runs a .cmd shim through the pinned cmd.exe, never ComSpec", async () => {
		stubPlatform("win32");
		const { spawns } = doubleChildProcess(() => closingChild(4101));
		doubleFixtureToolsOnDisk();
		const { safeSpawnAsync } = await import("../../clients/safe-spawn.js");
		await trustProject();

		await safeSpawnAsync("tool", ["x"], { env: SHIM_ENV });

		expect(spawns[0]?.command).toBe(system32("cmd.exe"));
		expect(String(spawns[0]?.args[3])).toContain(
			`${system32("chcp.com")} 65001`,
		);
	});

	it("the first direct .exe spawn runs the code-page one-shot through the pinned cmd.exe", async () => {
		stubPlatform("win32");
		const { spawns, syncs } = doubleChildProcess(() => closingChild(4104));
		doubleFixtureToolsOnDisk();
		const { safeSpawnAsync } = await import("../../clients/safe-spawn.js");
		await trustProject();

		await safeSpawnAsync("tool", [], { env: EXE_ENV });

		// ensureUtf8ConsoleCodePageOnce: the first Windows spawn of the process.
		expect(syncs.map((call) => call.command)).toEqual([system32("cmd.exe")]);
		expect(syncs[0]?.args).toEqual(["/d", "/s", "/c", "chcp 65001 >nul 2>&1"]);
		expect(spawns[0]?.command).toBe("C:\\fixture\\tool.exe");
	});

	it("sync safeSpawn runs a .cmd shim through the pinned cmd.exe", async () => {
		stubPlatform("win32");
		const { syncs } = doubleChildProcess(() => new FakeChild(0));
		doubleFixtureToolsOnDisk();
		const { safeSpawn } = await import("../../clients/safe-spawn.js");
		await trustProject();

		safeSpawn("tool", ["x"], { env: SHIM_ENV });

		expect(syncs.map((call) => call.command)).toEqual([system32("cmd.exe")]);
		expect(String(syncs[0]?.args[3])).toContain(
			`${system32("chcp.com")} 65001`,
		);
	});

	it("the async timeout tree-kill spawns the pinned taskkill.exe", async () => {
		stubPlatform("win32");
		const { spawn: realSpawn } =
			await vi.importActual<typeof import("node:child_process")>(
				"node:child_process",
			);
		// A real child of this process: the pid the kill names is one we own.
		const owned = realSpawn(process.execPath, [
			"-e",
			"setTimeout(() => {}, 5000)",
		]);
		const main = new FakeChild(owned.pid ?? 0);
		const { spawns } = doubleChildProcess((call) => {
			if (!call.command.endsWith("taskkill.exe")) return main;
			const killer = new FakeChild(4103);
			setImmediate(() => {
				killer.emit("close", 0, null);
				main.emit("close", null, "SIGKILL");
			});
			return killer;
		});
		doubleFixtureToolsOnDisk();
		try {
			const { safeSpawnAsync } = await import("../../clients/safe-spawn.js");
			await trustProject();

			await safeSpawnAsync("tool", [], { env: SHIM_ENV, timeout: 30 });

			const kill = spawns.find((call) => call.command.endsWith("taskkill.exe"));
			expect(kill?.command).toBe(system32("taskkill.exe"));
			expect(kill?.args).toEqual(["/F", "/T", "/PID", String(owned.pid)]);
		} finally {
			owned.kill("SIGKILL");
		}
	});
});

describe("the LSP teardowns name taskkill.exe through the seam", () => {
	it("killProcessTree (clients/lsp/client.ts) spawns the pinned taskkill.exe", async () => {
		stubPlatform("win32");
		const { spawns } = doubleChildProcess(() => new FakeChild(4201));
		const { killProcessTree } = await import("../../clients/lsp/client.js");
		const proc = { kill: vi.fn(() => true), unref: vi.fn() };

		await killProcessTree(proc, 4242, { fast: true });

		expect(spawns.map((call) => call.command)).toEqual([
			system32("taskkill.exe"),
		]);
		expect(spawns[0]?.args).toEqual(["/F", "/T", "/PID", "4242"]);
	});

	it("stopLSP (clients/lsp/launch.ts) spawns the pinned taskkill.exe", async () => {
		stubPlatform("win32");
		const { spawns } = doubleChildProcess(() => new FakeChild(4301));
		const { stopLSP } = await import("../../clients/lsp/launch.js");
		const process_ = new FakeChild(4343);
		const stopping = stopLSP({
			process: process_,
			pid: 4343,
		} as unknown as Parameters<typeof stopLSP>[0]);
		// The tree kill starts inside stopLSP's synchronous executor, so the spawn
		// is already recorded here.
		process_.emit("exit", 0, null);
		await stopping;

		expect(spawns[0]?.command).toBe(system32("taskkill.exe"));
		expect(spawns[0]?.args).toEqual(["/F", "/T", "/PID", "4343"]);
	});
});

describe("the reaper names taskkill.exe through the seam", () => {
	it("terminateScannerChild tree-kills with the pinned taskkill.exe", async () => {
		stubPlatform("win32");
		const { spawns } = doubleChildProcess(() => closingChild(4401));
		const { terminateScannerChild } =
			await import("../../clients/instance-reaper.js");

		await terminateScannerChild(new FakeChild(2_147_000_001) as never, {
			kind: "orphan-backstop-scanner-escalated",
			timeoutMs: 1,
			verifyAttempts: 1,
			verifyIntervalMs: 0,
		});

		expect(spawns.map((call) => call.command)).toEqual([
			system32("taskkill.exe"),
		]);
		expect(spawns[0]?.args).toEqual(["/F", "/T", "/PID", "2147000001"]);
	});
});
