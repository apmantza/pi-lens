/**
 * #1201 adversarial-review gap: the only tests that actually fail on a
 * revert of the `options.env` plumbing into Windows command resolution
 * (`safeSpawnAsync`'s `resolveWindowsCommand(command, ..., spawnEnv)` call
 * and its sync `safeSpawn` twin) sit under
 * `describe.runIf(process.platform === "win32")` in
 * tests/clients/safe-spawn-windows-command.test.ts — they SKIP on Linux CI.
 * tests/clients/safe-spawn-windows-resolution.test.ts runs cross-platform,
 * but only exercises the pure `resolveWindowsCommandForEnvironment` export
 * directly; it says nothing about whether the *dispatch* functions
 * (`safeSpawnAsync`/`safeSpawn`) actually feed the caller's `env` into that
 * resolver rather than the ambient `process.env`. Net: reverting the
 * plumbing at the `resolveWindowsCommand(...)` call sites would turn
 * NOTHING red on the CI OS.
 *
 * This suite closes that gap by forcing `process.platform` to "win32" (the
 * same technique already used by
 * tests/clients/safe-spawn-kill-escalation-timer.test.ts and
 * tests/clients/lsp/kill-process-tree.test.ts to exercise Windows-only
 * branches on any host OS, including Linux CI) and mocking both
 * `node:fs`'s `statSync` (so resolution runs in pure JS, no real Windows
 * filesystem needed) and `node:child_process`'s `spawn` (so no real OS
 * process is ever started — we only need to observe what safe-spawn.ts
 * decided to spawn and with what `env`).
 */

import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeFakeChild } from "../support/fake-child.js";

const statSyncMock = vi.hoisted(() => vi.fn());
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, statSync: statSyncMock };
});

// Typed with the real call shape (command, args, options) — not a bare
// `vi.fn()` — so `.mock.calls[n]` carries a proper 3-tuple type instead of
// TS inferring `[]` from a zero-arg implementation. That inferred-`[]` trap
// is exactly what broke this file's original spawnSync destructure: casting
// an actually-empty tuple type to a 3-tuple is a genuinely unsafe `as`, and
// tsc (correctly) refused it.
const spawnMock = vi.hoisted(() =>
	vi.fn(
		(
			_command: string,
			_args: string[],
			_options: { env?: NodeJS.ProcessEnv } & Record<string, unknown>,
		): unknown => {
			throw new Error("spawnMock: no return value configured for this call");
		},
	),
);
const spawnSyncMock = vi.hoisted(() =>
	vi.fn(
		(
			_command: string,
			_args: string[],
			_options: { env?: NodeJS.ProcessEnv } & Record<string, unknown>,
		) => ({
			stdout: Buffer.from(""),
			stderr: Buffer.from(""),
			status: 0,
			error: undefined,
		}),
	),
);
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return { ...actual, spawn: spawnMock, spawnSync: spawnSyncMock };
});

const { safeSpawnAsync, safeSpawn, resetSafeSpawnWindowsCommandCache } =
	await import("../../clients/safe-spawn.js");

function markFilesAsPresent(...files: string[]): void {
	const present = new Set(files);
	statSyncMock.mockImplementation((candidate: unknown) => {
		if (present.has(String(candidate))) return { isFile: () => true };
		throw new Error("ENOENT");
	});
}

describe("Windows resolution honors the CALLER's env, not just ambient process.env (#1201)", () => {
	const realPlatform = process.platform;

	beforeEach(() => {
		resetSafeSpawnWindowsCommandCache();
		statSyncMock.mockReset();
		spawnMock.mockReset();
		Object.defineProperty(process, "platform", {
			value: "win32",
			configurable: true,
		});
	});

	afterEach(() => {
		Object.defineProperty(process, "platform", {
			value: realPlatform,
			configurable: true,
		});
		vi.restoreAllMocks();
	});

	it("safeSpawnAsync resolves the command from options.env.PATH, not ambient process.env.PATH", async () => {
		const managedBin = "C:\\__pi_lens_env_plumbing__\\managed\\bin";
		const managedTool = path.win32.join(managedBin, "widget-tool.cmd");
		markFilesAsPresent(managedTool);
		spawnMock.mockReturnValue(makeFakeChild(4242));

		// If safeSpawnAsync fed ambient `process.env` (which almost certainly
		// doesn't contain this fabricated directory) into the resolver instead
		// of the merged caller env, resolution fails closed, `spawn()` is never
		// called, and the assertions below fail.
		const resultPromise = safeSpawnAsync("widget-tool", ["--version"], {
			cwd: "C:\\workspace",
			env: { PATH: managedBin, PATHEXT: ".CMD" },
			timeout: 5000,
		});

		// Let the promise chain past the synchronous resolution step.
		await Promise.resolve();
		await Promise.resolve();

		// Resource-usage sampling (#620) also spawns a diagnostic process
		// (Get-CimInstance on real Windows) through the same mocked
		// `node:child_process`. Find OUR call specifically rather than
		// asserting an exact call count.
		const ourCall = spawnMock.mock.calls.find((call) =>
			String(call[1]).includes("widget-tool"),
		);
		if (!ourCall) {
			throw new Error(
				`expected a spawn() call mentioning "widget-tool", got: ${JSON.stringify(
					spawnMock.mock.calls,
				)}`,
			);
		}
		const [spawnCmd, spawnArgs, spawnOptions] = ourCall;
		// .cmd resolves through the pinned cmd.exe wrapper — the resolved
		// managed path must appear in the wrapper's command line.
		expect(spawnCmd).toMatch(/cmd\.exe$/i);
		expect(spawnArgs.join(" ")).toContain(managedTool);
		// The env actually handed to the child must be the MERGED environment
		// (ambient process.env plus the override), not a bare replacement —
		// e.g. it still carries the override's PATHEXT.
		expect(spawnOptions.env?.PATHEXT).toBe(".CMD");

		// Resolve the fake child so the pending promise doesn't leak into the
		// next test.
		const child = spawnMock.mock.results[0]?.value as ReturnType<
			typeof makeFakeChild
		>;
		// #1656: safeSpawnAsync now finalizes off "exit" (then waits for the
		// pipes to go idle), not "close" — a real Node child always emits both
		// (exit first), so the fixture must too.
		child.emit("exit", 0, null);
		child.emit("close", 0, null);
		await resultPromise;
	});

	it("sync safeSpawn resolves the command from options.env.PATH, not ambient process.env.PATH", () => {
		const managedBin = "C:\\__pi_lens_env_plumbing_sync__\\managed\\bin";
		const managedTool = path.win32.join(managedBin, "widget-tool.cmd");
		markFilesAsPresent(managedTool);
		spawnSyncMock.mockClear();

		const result = safeSpawn("widget-tool", ["--version"], {
			cwd: "C:\\workspace",
			env: { PATH: managedBin, PATHEXT: ".CMD" },
		});

		// A resolution failure would never call spawnSync at all — it returns a
		// synthesized ENOENT before reaching it.
		expect(result.error).toBeUndefined();
		expect(spawnSyncMock).toHaveBeenCalledTimes(1);
		const call = spawnSyncMock.mock.calls[0];
		if (!call) {
			throw new Error("expected spawnSync to have been called at least once");
		}
		const [spawnCmd, spawnArgs, spawnOptions] = call;
		expect(spawnCmd).toMatch(/cmd\.exe$/i);
		expect(spawnArgs.join(" ")).toContain(managedTool);
		expect(spawnOptions.env?.PATHEXT).toBe(".CMD");
	});

	// #1201: a cwd this module cannot CANONICALIZE is not the same thing as a
	// bad cwd. `D:work` is drive-relative, and Node never surfaces the `=D:`
	// per-drive entry that would let us resolve it (see
	// `getValidatedPerDriveCwd`), so our provenance is missing — but Windows
	// resolves it natively. Failing the spawn before ever attempting it turned
	// a working call into a synthesized ENOENT, which downstream call sites
	// (sg-runner, lsp/launch) read as "tool not installed" and answer with a
	// reinstall — the #1199 loop. The command itself still resolves only from
	// a fully-qualified PATH entry, so nothing is validated against a
	// directory the child won't run in.
	it("passes an uncanonicalizable drive-relative cwd through instead of failing closed", () => {
		const bin = "C:\\__pi_lens_cwd_passthrough__\\bin";
		const tool = path.win32.join(bin, "widget-tool.exe");
		markFilesAsPresent(tool);
		spawnSyncMock.mockClear();

		const result = safeSpawn("widget-tool", ["--version"], {
			cwd: "D:work",
			env: { PATH: bin, PATHEXT: ".EXE" },
		});

		expect(result.error).toBeUndefined();
		// A direct .exe spawn also triggers the one-shot `chcp 65001` helper
		// through the same mocked spawnSync, so find OUR call rather than
		// asserting an exact count.
		const call = spawnSyncMock.mock.calls.find(
			(candidate) => candidate[0] === tool,
		);
		if (!call) {
			throw new Error(
				`expected a spawnSync call for ${tool}, got: ${JSON.stringify(
					spawnSyncMock.mock.calls.map((c) => c[0]),
				)}`,
			);
		}
		const [spawnCmd, , spawnOptions] = call;
		expect(spawnCmd).toBe(tool);
		// The raw caller value reaches the child verbatim — not silently
		// rewritten to the host process's cwd.
		expect(spawnOptions.cwd).toBe("D:work");
	});
});
