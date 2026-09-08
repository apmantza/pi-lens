/**
 * #1656 — `safeSpawnAsync` adopts pi's post-exit pipe-idle wait construction
 * instead of waiting on Node's "close" event (clients/safe-spawn.ts, the
 * `finalize`/`waitForPipeIdle` pair wired off `child.on("exit", ...)`).
 *
 * "close" only fires once every stdio fd referencing the child has been
 * released. A daemonized descendant that inherited our stdout/stderr pipe
 * (the Windows no-job-object case pi-host's audit flagged) can hold that fd
 * open forever — "close" then never fires even though the child we spawned
 * is long dead, hanging the caller. A naive fix (resolve a fixed N ms after
 * "exit", ignoring further data) avoids the hang but truncates a child whose
 * output is still draining from the OS pipe buffer when "exit" fires. The
 * chosen construction does neither: wait for the pipes to go IDLE (no data
 * for EXIT_PIPE_IDLE_GRACE_MS, re-armed on every chunk), capped at
 * EXIT_PIPE_IDLE_MAX_WAIT_MS so a pathological never-quiet descendant can't
 * extend the caller's budget unboundedly.
 *
 * These tests use a fully mocked `node:child_process` `spawn` (same pattern
 * as tests/clients/safe-spawn-kill-escalation-timer.test.ts) so no real OS
 * process or pipe is involved — the fake child's "exit"/"data" events are
 * driven directly, which makes the fixtures identical on every host OS
 * (Windows, Linux, macOS) rather than depending on host-specific pipe or
 * process-tree semantics (AGENTS.md's OS-agnostic discipline).
 *
 * Red-first evidence (see PR body / report for the exact commands run): all
 * three tests fail on pre-fix `safe-spawn.ts` (HEAD before this branch) —
 * none of these fixtures ever emit "close", so pre-fix's close-wait never
 * settles and every `expect(settled).toBe(true)` assertion stays false even
 * after advancing fake time far past both the idle-grace window and the
 * overall spawn timeout. The second and third tests additionally guard the
 * construction's OTHER failure mode — a naive fix that resolves a fixed N ms
 * after "exit" without re-arming on new data would truncate the chunks these
 * fixtures stream after "exit" fires; the re-arm-on-data logic here is what
 * makes them pass post-fix instead of merely swapping one bug for the other.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeFakeChild } from "../support/fake-child.js";

const spawnMock = vi.fn();
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return { ...actual, spawn: spawnMock };
});

const { safeSpawnAsync, setAmbientAbortSignal } =
	await import("../../clients/safe-spawn.js");

describe("safeSpawnAsync post-exit pipe-idle wait (#1656)", () => {
	const realPlatform = process.platform;

	beforeEach(() => {
		spawnMock.mockReset();
		// Force the non-Windows direct-spawn path so the mocked `spawn` is
		// reached without going through safe-spawn's Windows PATH/PATHEXT
		// resolver first (same technique as
		// tests/clients/safe-spawn-kill-escalation-timer.test.ts) — this makes
		// the fixture run identically on every host OS instead of depending on
		// whether "fake-cmd" happens to resolve on the machine running it.
		Object.defineProperty(process, "platform", {
			value: "linux",
			configurable: true,
		});
		vi.useFakeTimers();
	});

	afterEach(() => {
		Object.defineProperty(process, "platform", {
			value: realPlatform,
			configurable: true,
		});
		setAmbientAbortSignal(undefined);
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it("releases promptly after exit even when close never fires (daemonized descendant)", async () => {
		const child = makeFakeChild(4242);
		spawnMock.mockReturnValue(child);

		const resultPromise = safeSpawnAsync("fake-cmd", [], {
			timeout: 30_000,
		});

		let settled = false;
		void resultPromise.then(() => {
			settled = true;
		});

		// The child process itself has exited, but a descendant inherited our
		// stdout/stderr pipe and never released it — "close" is intentionally
		// never emitted for the rest of this test, simulating the Windows
		// no-job-object daemonized-descendant case.
		child.emit("exit", 0, null);

		// Nothing but the idle-grace timer (100ms) should be pending. Advance
		// well past it — and well past the 30s overall spawn timeout too, to
		// confirm this isn't merely waiting on the timeout/escalation path.
		await vi.advanceTimersByTimeAsync(5_000);

		expect(settled).toBe(true);
		const result = await resultPromise;
		expect(result.status).toBe(0);
		expect(result.failure).toBeUndefined();
	});

	it("stays pending past the idle-grace window while the pipe is still actively written (bounded by the overall cap)", async () => {
		const child = makeFakeChild(4242);
		spawnMock.mockReturnValue(child);

		const resultPromise = safeSpawnAsync("fake-cmd", [], {
			timeout: 30_000,
		});

		let settled = false;
		void resultPromise.then(() => {
			settled = true;
		});

		child.emit("exit", 0, null);

		// Keep re-arming the 100ms grace timer with fresh chunks every 60ms —
		// each well inside the grace window, so a naive "wait a fixed N ms
		// after exit, ignore new data" implementation would already have cut
		// this stream off after the first ~100ms and resolved with only the
		// first chunk or two.
		for (const chunk of ["a", "b", "c", "d", "e"]) {
			await vi.advanceTimersByTimeAsync(60);
			expect(settled).toBe(false);
			child.stdout.emit("data", chunk);
		}

		// Let the pipe actually fall idle now (no more chunks) and confirm the
		// idle-grace timer fires and everything streamed is present.
		await vi.advanceTimersByTimeAsync(200);
		expect(settled).toBe(true);

		const result = await resultPromise;
		expect(result.stdout).toBe("abcde");
	});

	it("caps the total post-exit wait so a never-quiet descendant can't extend the budget unboundedly", async () => {
		const child = makeFakeChild(4242);
		spawnMock.mockReturnValue(child);

		const resultPromise = safeSpawnAsync("fake-cmd", [], {
			timeout: 30_000,
		});

		let settled = false;
		void resultPromise.then(() => {
			settled = true;
		});

		child.emit("exit", 0, null);

		// A pathological descendant that never goes quiet: emit a chunk every
		// 60ms forever. Each chunk re-arms the 100ms grace timer, so without an
		// overall cap this would never settle. Drive it well past the 2s cap.
		for (let i = 0; i < 40; i++) {
			await vi.advanceTimersByTimeAsync(60);
			child.stdout.emit("data", "x");
		}

		expect(settled).toBe(true);
	});

	it("settles right after 'close' instead of paying out the full idle-grace window when nothing holds the child's stdio open (#1673 review F2)", async () => {
		const child = makeFakeChild(4242);
		spawnMock.mockReturnValue(child);

		const resultPromise = safeSpawnAsync("fake-cmd", [], {
			timeout: 30_000,
		});

		let settled = false;
		void resultPromise.then(() => {
			settled = true;
		});

		// #1673 review round 3 (F2b): "exit" and "close" fire in the SAME
		// synchronous turn for a real Node child — Node's own measurements put
		// the gap at ~0.01-0.03ms, well under one microtask, let alone a timer
		// tick. An earlier version of this test inserted an
		// `await vi.advanceTimersByTimeAsync(0)` between the two emits "to let
		// finalize progress past its `await killPromise`" — that gap is
		// exactly what real Node does NOT give: by the time any awaited
		// microtask resumes, `close` has already fired. A listener that only
		// exists to catch `close` after such a gap (the round-2 fix) attaches
		// to an event that already happened, so it never fires — every real
		// spawn kept paying the full grace window. Emitting both events back
		// to back, with no await between them, is what actually matches
		// production and is what makes this test a faithful regression check
		// for the fix (capturing `closeSeen` synchronously at spawn time,
		// before `finalize` ever awaits anything).
		child.emit("exit", 0, null);
		child.emit("close", 0, null);

		// Advance far LESS than the 100ms grace window. This is an
		// event-order assertion, not a wall-clock race: without the "close"
		// early-out, only the still-armed grace timer would eventually flip
		// `settled`, ~100ms later — so if the early-out isn't wired up,
		// `settled` is deterministically still false at this point, every
		// run, on every host.
		await vi.advanceTimersByTimeAsync(5);

		expect(settled).toBe(true);
	});
});
