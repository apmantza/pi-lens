/**
 * #1651 — the lifecycle-smoke lane's phase 5 pinned outcome "missing" for a
 * genuinely-absent `gh` binary, and passed on Windows but got "non-installable"
 * on Linux CI. Root cause: Node's own docs say the 'error' and 'close' event
 * ORDER for a child that never started (ENOENT) is unspecified — "the 'exit'
 * event may or may not fire after an error has occurred" — and Linux's real
 * shape closes a never-started child with `code = -errno` (e.g. `-2` for
 * ENOENT, `-4058` on Windows), never `null`.
 *
 * Round 1 of this fix re-checked an identity flag after a single microtask
 * `await` — a same-microtask guard that still loses when 'error' lands a
 * TICK later (`setImmediate`/`process.nextTick`), and pinned a `close(null,
 * null)` shape production never actually produces. Review round 2 (F2/F3)
 * moved the fix to be SHAPE-based instead of timing-based: `close`'s own
 * handler now decides straight from `code === null || code < 0` — a
 * completed process never exits with either — independent of whether/when
 * 'error' ever fires. F4 additionally requires this NOT invert a healthy
 * run: a `close(0, null)` followed by a late, unrelated 'error' (e.g. a
 * post-exit `kill()` failing with EPERM) must stay a clean success, never
 * get downgraded.
 *
 * Windows rarely hits the missing-tool race at all: `resolveWindowsCommand`
 * fails closed on an unresolvable bare command BEFORE any real `spawn()`
 * call, synthesizing a clean ENOENT deterministically. Linux (and any
 * Windows command that resolves but is later removed) always goes through
 * the raw event path — these tests mock `spawn()` directly so every shape
 * reproduces regardless of which platform runs the suite.
 */
import { describe, expect, it, vi } from "vitest";
import { makeFakeChild } from "../support/fake-child.js";

const enoentError = Object.assign(new Error("spawn gh ENOENT"), {
	code: "ENOENT",
	syscall: "spawn gh",
	path: "gh",
});

const epermKillError = Object.assign(new Error("kill EPERM"), {
	code: "EPERM",
	syscall: "kill",
});

const spawnMock = vi.fn();

vi.mock("node:child_process", () => ({
	spawn: (...args: unknown[]) => spawnMock(...args),
	// Harmless no-op: the Windows chcp one-shot and taskkill paths call this.
	spawnSync: () => ({ stdout: "", stderr: "", status: 0, error: undefined }),
}));

vi.mock("../../clients/resource-sampler.js", () => ({
	startSpawnUsageSampler: () => ({ stop: () => null }),
}));

vi.mock("../../clients/latency-logger.js", () => ({
	logLatency: () => {},
}));

const { safeSpawnAsync } = await import("../../clients/safe-spawn.js");

// An absolute, real path so Windows command resolution succeeds and every
// test reaches the mocked `spawn()` on every platform, exactly like a bare
// `gh` does on Linux (no pre-resolution step at all there).
const REAL_ABSOLUTE_COMMAND = process.execPath;

function nextTick(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("safeSpawnAsync decides from the close-event SHAPE, not event timing (#1651)", () => {
	it("classifies close(-2, null) as tool-not-found even when 'error' lands a tick later — the real Linux/ENOENT shape", async () => {
		const child = makeFakeChild();
		spawnMock.mockImplementation(() => {
			queueMicrotask(async () => {
				// Real Node/Linux shape: `close` fires with the negated errno
				// BEFORE 'error', and 'error' lands a full tick later (not the
				// same microtask) — the exact ordering a same-microtask re-check
				// (round 1 of this fix) still loses against.
				child.emit("close", -2, null);
				await nextTick();
				child.emit("error", enoentError);
			});
			return child;
		});

		const result = await safeSpawnAsync(REAL_ABSOLUTE_COMMAND, ["--version"]);

		expect(result.status).toBe(-2);
		expect(result.error).toBeInstanceOf(Error);
		expect(result.spawnFailure?.kind).toBe("tool-not-found");
	});

	it("classifies close(-2, null) as tool-not-found even when 'error' never fires at all", async () => {
		const child = makeFakeChild();
		spawnMock.mockImplementation(() => {
			queueMicrotask(() => {
				// No 'error' event at all — the shape alone must be enough.
				child.emit("close", -2, null);
			});
			return child;
		});

		const result = await safeSpawnAsync(REAL_ABSOLUTE_COMMAND, ["--version"]);

		expect(result.status).toBe(-2);
		expect(result.error).toBeInstanceOf(Error);
		expect(result.spawnFailure?.kind).toBe("tool-not-found");
	});

	it("classifies close(null, null) as tool-not-found (the null shape some platforms also use)", async () => {
		const child = makeFakeChild();
		spawnMock.mockImplementation(() => {
			queueMicrotask(() => {
				child.emit("close", null, null);
				child.emit("error", enoentError);
			});
			return child;
		});

		const result = await safeSpawnAsync(REAL_ABSOLUTE_COMMAND, ["--version"]);

		expect(result.status).toBeNull();
		expect(result.error).toBeInstanceOf(Error);
		expect(result.spawnFailure?.kind).toBe("tool-not-found");
	});

	it("never downgrades a healthy close(0, null) run when a late, unrelated 'error' follows (#1651 review F4)", async () => {
		const child = makeFakeChild();
		spawnMock.mockImplementation(() => {
			queueMicrotask(async () => {
				child.stdout?.emit("data", "ok");
				// A real, non-negative exit code: the process genuinely ran and
				// answered. This must settle the result immediately.
				child.emit("close", 0, null);
				// #1673 review F1: land the late error INSIDE the post-close
				// idle-pipe wait window (EXIT_PIPE_IDLE_GRACE_MS = 100ms), not
				// merely a tick later. A same-microtask/same-tick re-check isn't
				// what's being guarded here — #1656 widened the gap between
				// "outcome decided" and "promise resolved" to the whole
				// (bounded, up to 2s) idle wait, so the regression only
				// reproduces with an error landing inside that wider window.
				await delay(10);
				// An unrelated failure arriving AFTER a clean exit (e.g. a
				// post-exit kill() attempt that itself failed) must never
				// overwrite the already-decided clean verdict.
				child.emit("error", epermKillError);
			});
			return child;
		});

		const result = await safeSpawnAsync(REAL_ABSOLUTE_COMMAND, ["--version"]);

		expect(result.status).toBe(0);
		expect(result.error).toBeUndefined();
		expect(result.spawnFailure).toBeUndefined();
	});

	it("preserves a streaming match on the error resolve path", async () => {
		const child = makeFakeChild();
		spawnMock.mockImplementation(() => {
			queueMicrotask(() => {
				child.stderr?.emit("data", "crea");
				child.stderr?.emit("data", "teConnection");
				child.emit("error", new Error("stream failed"));
			});
			return child;
		});

		const result = await safeSpawnAsync(REAL_ABSOLUTE_COMMAND, [], {
			matchWhileStreaming: /createConnection/,
		});

		expect(result.streamingMatch).toBe(true);
		expect(result.error?.message).toBe("stream failed");
	});

	it("never downgrades a healthy exit(0) run when 'close' never fires and a late, unrelated 'error' follows (#1673 review round 4, F1)", async () => {
		const child = makeFakeChild();
		spawnMock.mockImplementation(() => {
			queueMicrotask(async () => {
				child.stdout?.emit("data", "ok");
				// The production shape the verdict-latch race actually matters
				// for: a daemonized descendant inherits our stdout/stderr pipe
				// and never releases it, so 'close' never fires at all — only
				// 'exit' does. Every other fixture in this file emits 'close',
				// which (with the #1673 F2 closeSeen fast-path) makes
				// waitForPipeIdle resolve instantly and never actually
				// exercises the F1 latch — this fixture is exit-only so the
				// full idle-grace window runs with the promise still undecided.
				child.emit("exit", 0, null);
				// Land the late error INSIDE the post-exit idle-pipe wait
				// window (EXIT_PIPE_IDLE_GRACE_MS = 100ms), same as the F4
				// close-based fixture above.
				await delay(10);
				// An unrelated failure arriving AFTER a clean exit (e.g. a
				// post-exit kill() attempt that itself failed) must never
				// overwrite the already-decided clean verdict.
				child.emit("error", epermKillError);
			});
			return child;
		});

		const result = await safeSpawnAsync(REAL_ABSOLUTE_COMMAND, ["--version"]);

		expect(result.status).toBe(0);
		expect(result.error).toBeUndefined();
		expect(result.spawnFailure).toBeUndefined();
	});
});
