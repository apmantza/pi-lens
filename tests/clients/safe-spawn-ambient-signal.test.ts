/**
 * #197 — `safeSpawnAsync` defaults to the ambient turn abort signal.
 *
 * The lifecycle handlers publish pi's `ctx.signal` via `setAmbientAbortSignal`,
 * so dispatches that don't thread their own signal still cancel when the agent
 * is interrupted. These tests pin the defaulting/precedence/clearing behaviour
 * via the deterministic early-abort path (an already-aborted signal resolves
 * without spawning a real process).
 */

import { afterEach, describe, expect, it } from "vitest";
import {
	safeSpawnAsync,
	setAmbientAbortSignal,
} from "../../clients/safe-spawn.js";
import {
	killedForOutputCap,
	truncatedByOutputCap,
} from "../../clients/spawn-output-cap.js";
import { capKilledSpawnResult } from "../support/spawn-shapes.js";

// A trivial, immediately-exiting node invocation — guaranteed to exist on every
// CI platform via process.execPath.
const NODE = process.execPath;
const EXIT_OK = ["-e", "process.exit(0)"];

afterEach(() => setAmbientAbortSignal(undefined));

describe("safeSpawnAsync ambient abort signal (#197)", () => {
	it("aborts when the ambient signal is already aborted and no explicit signal is passed", async () => {
		setAmbientAbortSignal(AbortSignal.abort());

		const result = await safeSpawnAsync(NODE, EXIT_OK);

		expect(result.status).toBeNull();
		expect(result.error?.message ?? "").toMatch(/aborted before start/i);
	});

	// `status !== null` means the child actually ran to an exit code rather than
	// being short-circuited by the early-abort path (which yields status null +
	// an "aborted before start" error). The exit code itself is irrelevant here.
	it("does not abort once the ambient signal is cleared", async () => {
		setAmbientAbortSignal(AbortSignal.abort());
		setAmbientAbortSignal(undefined); // cleared in the handler's finally

		const result = await safeSpawnAsync(NODE, EXIT_OK);

		expect(result.error?.message ?? "").not.toMatch(/aborted before start/i);
		expect(result.status).not.toBeNull();
	});

	it("an explicit signal takes precedence over the ambient one", async () => {
		// Ambient is aborted, but the call passes its own live signal — the
		// explicit option wins (`options.signal ?? ambient`), so it still runs.
		setAmbientAbortSignal(AbortSignal.abort());
		const live = new AbortController();

		const result = await safeSpawnAsync(NODE, EXIT_OK, { signal: live.signal });

		expect(result.error?.message ?? "").not.toMatch(/aborted before start/i);
		expect(result.status).not.toBeNull();
	});

	it("with no ambient and no explicit signal, the spawn runs normally", async () => {
		const result = await safeSpawnAsync(NODE, EXIT_OK);

		expect(result.error?.message ?? "").not.toMatch(/aborted before start/i);
		expect(result.status).not.toBeNull();
	});

	it("ignoreAmbientSignal opts out of an aborted ambient signal (installs run to completion)", async () => {
		setAmbientAbortSignal(AbortSignal.abort());

		const result = await safeSpawnAsync(NODE, EXIT_OK, {
			ignoreAmbientSignal: true,
		});

		expect(result.error?.message ?? "").not.toMatch(/aborted before start/i);
		expect(result.status).not.toBeNull();
	});

	it("kills a noisy child when the retained output reaches its byte cap", async () => {
		const result = await safeSpawnAsync(
			NODE,
			[
				"-e",
				"process.stdout.write('x'.repeat(100000)); setTimeout(() => {}, 10000);",
			],
			{ timeout: 5000, maxOutputBytes: 1024 },
		);

		expect(result.outputTruncated).toBe(true);
		expect(
			Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr),
		).toBeLessThanOrEqual(1024);
		// #2100: POSIX and Windows disagree on the exit shape. The cross-platform
		// contract is that safe-spawn capped output, started ending the child, and
		// the child did not self-report a successful exit.
		expect(result.killedForOutputCap).toBe(true);
		expect(result.status).not.toBe(0);
		expect(capKilledSpawnResult({ stdout: result.stdout })).toMatchObject({
			outputTruncated: result.outputTruncated,
			killedForOutputCap: result.killedForOutputCap,
		});
		expect(truncatedByOutputCap(result)).toBe(true);
		expect(killedForOutputCap(result)).toBe(true);
	});

	// #2100 review F2: `outputTruncated` is spread into EVERY resolve branch, and
	// `timedOut`/`aborted` are set unconditionally — so a run that hit the cap and
	// then timed out (or was interrupted) carries the flag under a timeout/abort
	// failure. Those endings own their own classification; only the cap's own
	// SIGTERM (or a tool that beat it out the door) is a truncation verdict.
	//
	// #2225: the two "capped-then-timeout"/"capped-then-aborted" cases that used
	// to live here raced a real child's stdout against a real 300ms timer —
	// flaky under CPU load (5/8 concurrent runs failing). They now live in
	// safe-spawn-cap-race.test.ts, mocked so the cap trips before the
	// timeout/abort by construction instead of by timing. That move drops
	// real-process coverage for THOSE two interleavings specifically (cap
	// racing a timeout, cap racing an abort) — the mock never spawns an OS
	// process at all. The rest of this file's real-child coverage is
	// unaffected: "kills a noisy child..." above (line 82) and "retains late
	// output..." below (line 129) still spawn real children and assert
	// against their real completion, with no competing timer to race — that's
	// the #2100/#2197-class flush/late-output behavior this file still pins
	// end to end against a real process.

	// The child ignores SIGTERM for the same reason the noisy-child test above
	// does (line 82): the cap's kill must not settle it before it emits its
	// last line. On POSIX a child's writes to a pipe are asynchronous (they
	// are synchronous only on
	// Windows), so the 100 KB of filler is still queued in the child when the
	// cap trips on the parent's first read. A child that takes the default
	// SIGTERM disposition dies with that queue unflushed, and `late-rescue`
	// never leaves it. Ignoring SIGTERM lets the child finish; safe-spawn's
	// 1-second SIGKILL escalation still bounds the run.
	it("retains late output in the tail after an output-cap kill", async () => {
		const result = await safeSpawnAsync(
			NODE,
			[
				"-e",
				"process.on('SIGTERM', () => {}); process.stdout.write('h'.repeat(100000)); process.stdout.write('late-rescue');",
			],
			{ timeout: 5000, maxOutputBytes: 1024 },
		);

		expect(result.outputTruncated).toBe(true);
		expect(`${result.stdout}\n${result.stderr}`).toContain("late-rescue");
		expect(
			Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr),
		).toBeLessThanOrEqual(1024);
	});
});
// flake-shape: real-process-spawn — the real child signal boundary is the ambient-abort contention under test
