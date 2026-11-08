/**
 * #197 — `safeSpawnAsync` defaults to the ambient turn abort signal.
 *
 * The lifecycle handlers publish pi's `ctx.signal` via `setAmbientAbortSignal`,
 * so dispatches that don't thread their own signal still cancel when the agent
 * is interrupted. These tests pin the defaulting/precedence/clearing behaviour
 * via the deterministic early-abort path (an already-aborted signal resolves
 * without spawning a real process).
 */

import { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getAmbientAbortSignal,
	spawnAbortScope,
	safeSpawnAsync,
	setAmbientAbortSignal,
} from "../../clients/safe-spawn.js";
import { createSingleFlight } from "../../clients/single-flight.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import {
	DEFAULT_MAX_OUTPUT_BYTES,
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

		// #4543: scoped cancellation reaches runners with explicit options;
		// the next unscoped iteration proves async-context isolation.
		for (const scoped of [AbortSignal.abort(), undefined]) {
			const result = await spawnAbortScope.run(scoped as AbortSignal, () =>
				safeSpawnAsync(NODE, EXIT_OK, { signal: live.signal }),
			);
			if (scoped) expect(result.failure).toBe("aborted");
			else {
				expect(result.error?.message ?? "").not.toMatch(
					/aborted before start/i,
				);
				expect(result.status).not.toBeNull();
			}
		}
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

	// #5097: a tool call's scope made the opt-out leaky: the 16 install sites
	// set `ignoreAmbientSignal`, yet an Esc inside the call killed them.
	it("ignoreAmbientSignal also opts out of an aborted tool-call scope (#5097)", async () => {
		const result = await spawnAbortScope.run(AbortSignal.abort(), () =>
			safeSpawnAsync(NODE, EXIT_OK, { ignoreAmbientSignal: true }),
		);

		expect(result.error?.message ?? "").not.toMatch(/aborted before start/i);
		expect(result.status).toBe(0);
	});

	// #5097: lsp_navigation's requests default to this getter, and a tool call
	// only sets the scope, so without the preference Esc never reached them.
	it("getAmbientAbortSignal answers with the tool-call scope over the hook slot (#5097)", () => {
		const hook = new AbortController().signal;
		const call = new AbortController().signal;
		setAmbientAbortSignal(hook);

		expect(spawnAbortScope.run(call, () => getAmbientAbortSignal())).toBe(call);
		expect(getAmbientAbortSignal()).toBe(hook);
	});

	// #5097: a single flight serves every caller that joins it, so the caller
	// that started it must not cancel it. An Esc during a cold ast-grep
	// availability sweep left the tool reported missing for the 30 s cooldown.
	it("a single flight's spawn runs to completion when the starting call's scope is aborted (#5097)", async () => {
		const flight = createSingleFlight<number | null>();

		const status = await spawnAbortScope.run(AbortSignal.abort(), () =>
			flight.run(
				"probe",
				async () => (await safeSpawnAsync(NODE, EXIT_OK)).status,
			),
		);

		expect(status).toBe(0);
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

	// #3375: the acceptance case from the field report, at the real process
	// boundary. A child that writes past the cap on BOTH pipes with NO
	// `maxOutputBytes` used to grow one unbounded JS string in `appendOutput`
	// until V8 threw `RangeError: Invalid string length` inside the `data`
	// handler, where no caller `try`/`catch` can reach it — it left Pi 0.86.1 as
	// an uncaught exception and terminated the host (2026-09-22).
	//
	// Real spawn, not the mocked child of `safe-spawn-default-output-cap.test.ts`:
	// what is under test here is that the HOST SURVIVES a real OS pipe
	// delivering tens of megabytes, which is exactly the part an
	// `EventEmitter.emit("data", ...)` issued by the test cannot witness —
	// a synchronous emit raises the throw on the test's own stack, while a real
	// chunk raises it on Node's stream machinery, which is what made it uncaught.
	// Reaching any assertion below IS the host-survival proof.
	it("caps and kills an uncapped noisy child at the module default (#3375)", async () => {
		const result = await safeSpawnAsync(
			NODE,
			[
				"-e",
				"const c='x'.repeat(1024*1024);" +
					"for(let i=0;i<20;i++){process.stdout.write(c);process.stderr.write(c);}" +
					"setTimeout(() => {}, 10000);",
			],
			{ timeout: 30000 },
		);

		expect(result.outputTruncated).toBe(true);
		expect(result.killedForOutputCap).toBe(true);
		expect(truncatedByOutputCap(result)).toBe(true);
		expect(killedForOutputCap(result)).toBe(true);
		expect(result.status).not.toBe(0);
		// Bounded by the module default, and by nothing the caller supplied.
		expect(
			Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr),
		).toBeLessThanOrEqual(DEFAULT_MAX_OUTPUT_BYTES);
		// Both pipes are represented, whatever order the OS delivered them in:
		// the child wrote 20 MiB to each, so neither can reach the 32 MiB
		// ceiling alone — each must have contributed at least 12 MiB. Asserting
		// a MARKER at the head of each stream instead would be delivery-order
		// dependent (it failed under load): once truncation splits head and
		// tail, whichever stream the parent drained first fills the head and the
		// other keeps only its tail.
		expect(Buffer.byteLength(result.stdout)).toBeGreaterThan(0);
		expect(Buffer.byteLength(result.stderr)).toBeGreaterThan(0);
		// The reporter observed NUL bytes in the interrupted run's files; byte
		// slicing at a truncation boundary never produces one.
		expect(result.stdout).not.toContain("\u0000");
		expect(result.stderr).not.toContain("\u0000");
	}, 60000);
});

/**
 * #3375 round 3 (review finding M3384-2) — the POSIX process-group teardown arm,
 * proven with a REAL child because nothing else reaches it.
 *
 * `killTree` picks its group branch on `posixProcessGroup && ownsChildPid`, and
 * `ownsChildPid` is `isOwnLiveChild(child.pid, …)`, which reads
 * `/proc/<pid>/status` and compares `PPid` to this process. A fabricated pid can
 * never satisfy that, so the mocked-child suites
 * (`safe-spawn-kill-failure.test.ts`) exercise only the NON-group branch: the
 * group `SIGTERM` send, its direct-child fallback, and the group escalation are
 * unreachable there. Measured before this test was written — a real child on
 * this host takes the group branch and the first send really is
 * `process.kill(-pid, "SIGTERM")`.
 *
 * Both kill seams are spied to refuse, so the child must be one that ENDS ON ITS
 * OWN: it writes past the cap and exits, and nothing here can leave a process
 * running even though every signal fails.
 */
describe("safeSpawnAsync POSIX group teardown whose signals are refused (#3375 M3384-2)", () => {
	let processKillSpy: ReturnType<typeof vi.spyOn>;
	let childKillSpy: ReturnType<typeof vi.spyOn>;
	let negativePidSends: number[];
	let leaked: string[];
	let onLeak: (reason: unknown) => void;

	beforeEach(() => {
		negativePidSends = [];
		processKillSpy = vi.spyOn(process, "kill").mockImplementation(((
			pid: number,
			signal?: string | number,
		) => {
			// The liveness probe must stay answerable; every real signal is refused.
			if (signal === 0) return true;
			if (pid < 0) negativePidSends.push(pid);
			throw new Error("injected group send refusal");
		}) as typeof process.kill);
		childKillSpy = vi
			.spyOn(ChildProcess.prototype, "kill")
			.mockImplementation(() => {
				throw new Error("injected child send refusal");
			});
		leaked = [];
		onLeak = (reason) => {
			leaked.push(String((reason as Error)?.message ?? reason));
		};
		process.on("unhandledRejection", onLeak);
		resetDegradationLedger();
	});

	afterEach(() => {
		process.off("unhandledRejection", onLeak);
		processKillSpy.mockRestore();
		childKillSpy.mockRestore();
		resetDegradationLedger();
	});

	it("reports one failed teardown when the group signal and its child fallback are both refused", async () => {
		const result = await safeSpawnAsync(
			NODE,
			["-e", "process.stdout.write('x'.repeat(4096));"],
			{ timeout: 5000, maxOutputBytes: 1024, resourceLabel: "group-refusing" },
		);

		// The branch under test really is the group one: a NEGATIVE pid was
		// signalled. Without this the case could silently drift onto the
		// non-group arm the mocked suites already cover.
		expect(negativePidSends.length).toBeGreaterThan(0);
		expect(result.outputTruncated).toBe(true);
		expect(result.killedForOutputCap).toBe(true);
		expect(result.killFailed).toBe(true);
		expect(leaked).toEqual([]);
		const rows = getDegradationSummary().find(
			(group) => group.kind === "spawn-kill-failed",
		);
		expect(rows?.count).toBe(1);
		expect(rows?.latestReasons[0]?.subject).toBe("group-refusing");
		expect(rows?.latestReasons[0]?.reason).toContain("output-cap teardown");
	}, 30000);
});
// flake-shape: real-process-spawn — real children receive ambient abort signals through the OS boundary, not an in-process double
