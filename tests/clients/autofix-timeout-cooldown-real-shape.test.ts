/**
 * #5376: a real autofix spawn timeout must arm the spawn-timeout cooldown.
 *
 * `detectFileChangedAfterCommand` returned at `if (result.error) return 0;`
 * before its `failure === "timeout"` branch. A real `safeSpawnAsync` timeout
 * carries BOTH `error: Error("Process timed out after ...")` and
 * `failure: "timeout"`, so the cooldown was never armed and every later edit
 * paid another 30 s budget on the wedged tool. The sibling suite
 * `spawn-timeout-cooldown.test.ts` handed the branch `error: null`, a shape
 * the real spawn never returns, so it passed for the wrong reason.
 *
 * This file drives the REAL `safeSpawnAsync` (only `node:child_process` is the
 * `fake-child.ts` double, the established seam of the other safe-spawn suites)
 * under fake timers: the 30 s budget expires on a statement, not on a wall
 * clock, and the result shape is whatever production builds.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeFakeChild } from "../support/fake-child.js";
import { setupTestEnvironment } from "./test-utils.js";

const spawnMock = vi.fn();

vi.mock("node:child_process", () => ({
	spawn: (...args: unknown[]) => spawnMock(...args),
	spawnSync: () => ({ stdout: "", stderr: "", status: 0, error: undefined }),
}));

const { detectFileChangedAfterCommand } =
	await import("../../clients/file-utils.js");
const { isInSpawnTimeoutCooldown, resetSpawnTimeoutCooldowns } =
	await import("../../clients/spawn-timeout-cooldown.js");
const { safeSpawnAsync } = await import("../../clients/safe-spawn.js");

describe("autofix spawn timeout arms the cooldown (#5376)", () => {
	const realPlatform = process.platform;
	let killSpy: ReturnType<typeof vi.spyOn>;
	// The fake child spawned for each pid. On a host without `/proc` (macOS,
	// Windows) safe-spawn's group branch takes the fabricated pid as its own
	// and signals it through `process.kill`; the double below delivers that
	// signal to this child, which then exits the way a real one would (#5376 F1).
	const fakeChildByPid = new Map<number, ReturnType<typeof makeFakeChild>>();

	beforeEach(() => {
		vi.useFakeTimers();
		// POSIX branch: the kill goes through the mocked `process.kill`, never a
		// nested `taskkill` spawn.
		Object.defineProperty(process, "platform", {
			value: "linux",
			configurable: true,
		});
		killSpy = vi.spyOn(process, "kill").mockImplementation(((
			pid: number,
			signal?: string | number,
		) => {
			// Signal 0 is a liveness probe: nothing is delivered.
			if (signal === 0) return true;
			fakeChildByPid.get(Math.abs(pid))?.kill(signal);
			return true;
		}) as typeof process.kill);
		resetSpawnTimeoutCooldowns();
	});

	afterEach(() => {
		fakeChildByPid.delete(4242);
		killSpy.mockRestore();
		Object.defineProperty(process, "platform", {
			value: realPlatform,
			configurable: true,
		});
		vi.useRealTimers();
		spawnMock.mockReset();
		resetSpawnTimeoutCooldowns();
	});

	/** A child that never exits until the teardown signal lands. */
	function wedgedChild() {
		const child = makeFakeChild(4242);
		child.kill = vi.fn(() => {
			child.killed = true;
			queueMicrotask(() => {
				child.emit("exit", null, "SIGTERM");
				child.emit("close", null, "SIGTERM");
			});
			return true;
		});
		fakeChildByPid.set(4242, child);
		return child;
	}

	it("the real timeout result carries error AND failure (the shape the guard must handle)", async () => {
		spawnMock.mockImplementation(() => wedgedChild());
		const pending = safeSpawnAsync(process.execPath, ["-e", ""], {
			timeout: 300,
		});
		await vi.advanceTimersByTimeAsync(5000);
		const result = await pending;
		// Recurrence: a hand-shaped `error: null` timeout fixture hid #5376.
		expect(result.failure).toBe("timeout");
		expect(result.error).toBeInstanceOf(Error);
	});

	it("arms the cooldown after a wedged autofix spawn times out, so the next edit skips the tool", async () => {
		const env = setupTestEnvironment("pi-lens-autofix-timeout-real-shape-");
		try {
			const filePath = path.join(env.tmpDir, "notes.md");
			fs.writeFileSync(filePath, "# hello\n");
			const cmd = process.execPath;
			spawnMock.mockImplementation(() => wedgedChild());

			expect(isInSpawnTimeoutCooldown(cmd)).toBe(false);
			const pending = detectFileChangedAfterCommand(
				filePath,
				cmd,
				["--fix", filePath],
				env.tmpDir,
			);
			await vi.advanceTimersByTimeAsync(31_000);
			expect(await pending).toBe(0);
			expect(isInSpawnTimeoutCooldown(cmd)).toBe(true);

			// Later edit: the wedged tool is skipped without a second spawn.
			spawnMock.mockClear();
			expect(
				await detectFileChangedAfterCommand(
					filePath,
					cmd,
					["--fix", filePath],
					env.tmpDir,
				),
			).toBe(0);
			expect(spawnMock).not.toHaveBeenCalled();
		} finally {
			env.cleanup();
		}
	});
});
