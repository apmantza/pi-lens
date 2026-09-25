import {
	type ChildProcessByStdio,
	execFileSync,
	spawn,
} from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const wrapper = path.join(repoRoot, "scripts/with-memory-watch.mjs");

interface Run {
	code: number | null;
	stdout: string;
	stderr: string;
}

/**
 * A private, per-call sample-file path under the real TMPDIR, never the
 * wrapper's own default (`<tmpdir>/pi-lens-mem-watch-samples.log`, a single
 * shared name every unpinned run would collide on and leak).
 */
function makeSampleFile(): string {
	return path.join(
		os.tmpdir(),
		`pi-lens-mem-watch-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.log`,
	);
}

/**
 * Run the wrapper and collect everything it wrote.
 *
 * `throttleMs` starves the stdout reader: each chunk pauses the stream and
 * resumes it after the delay, so the OS pipe backs up while the wrapped command
 * is still producing output. That is the state the wrapper is in when a CI log
 * collector falls behind, and it is where an asynchronously queued write is
 * lost to `process.exit`.
 *
 * `extraEnv` (round-2 review F4) merges over the inherited environment --
 * folded in here rather than kept as a second, near-duplicate spawn helper
 * (the net-count rule: `runWrapperWithEnv` repeated 18 of this function's 24
 * lines for one added `env` key).
 *
 * `onFirstStdoutChunk` (#3097) hands the live child to the caller once the
 * wrapper has written its first line, which is the only moment at which a test
 * can kill the READ end of the pipe out from under a wrapper that is already
 * running. Folded in here for the same net-count reason as `extraEnv`.
 *
 * #3115: every case here runs the real wrapper, which falls back to a single
 * shared `<tmpdir>/pi-lens-mem-watch-samples.log` whenever
 * `PI_LENS_MEM_WATCH_SAMPLE_FILE` is unset -- only 2 of the file's 12 cases
 * pinned it, so the other 10 leaked that fixed name into the shared TMPDIR,
 * redding `tmp-fixture-hygiene` in a shared batch. Pinned here, once, for
 * every caller that does not already want a specific path to read back; the
 * file is removed once the wrapper has exited so a caller that DOES pass its
 * own `PI_LENS_MEM_WATCH_SAMPLE_FILE` (to inspect it afterwards) keeps sole
 * ownership of its cleanup.
 */
function runWrapper(
	args: string[],
	throttleMs = 0,
	extraEnv: Record<string, string> = {},
	onFirstStdoutChunk?: (
		child: ChildProcessByStdio<null, Readable, Readable>,
	) => void,
): Promise<Run> {
	const ownsSampleFile = extraEnv.PI_LENS_MEM_WATCH_SAMPLE_FILE === undefined;
	const sampleFile = ownsSampleFile
		? makeSampleFile()
		: extraEnv.PI_LENS_MEM_WATCH_SAMPLE_FILE;
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [wrapper, ...args], {
			cwd: repoRoot,
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...process.env,
				PI_LENS_MEM_WATCH_SAMPLE_FILE: sampleFile,
				...extraEnv,
			},
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		let sawFirstChunk = false;
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
			if (!sawFirstChunk) {
				sawFirstChunk = true;
				onFirstStdoutChunk?.(child);
			}
			if (throttleMs > 0) {
				child.stdout.pause();
				setTimeout(() => child.stdout.resume(), throttleMs);
			}
		});
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.on("close", (code) => {
			if (ownsSampleFile) fs.rmSync(sampleFile, { force: true });
			resolve({ code, stdout, stderr });
		});
	});
}

// The wrapper spawns through a shell on Windows (it has to: `npm` is not
// executable there), and `shell: true` concatenates arguments without escaping
// them. `process.execPath` is `C:\Program Files\nodejs\node.exe` on a default
// install, so the space would split the command. Use the bare name off PATH
// there, and keep every `-e` script free of spaces for the same reason. This is
// the limitation the wrapper's own comment warns about, met first-hand.
const nodeCmd = process.platform === "win32" ? "node" : process.execPath;

/** A child that exits with `code` after writing nothing. */
const exitWith = (code: number) => [
	"--",
	nodeCmd,
	"-e",
	`process.exitCode=${code}`,
];

describe("with-memory-watch exit forwarding (#2042)", () => {
	it("forwards a non-zero child exit code", async () => {
		// The wrapper must never soften a failure into a pass. A killed suite has
		// to keep failing the job.
		const run = await runWrapper(exitWith(3));
		expect(run.code).toBe(3);
	});

	it("forwards a clean child exit", async () => {
		const run = await runWrapper(exitWith(0));
		expect(run.code).toBe(0);
		expect(run.stdout).toContain("[mem-watch] done.");
	});

	it("names the stdio shape it writes through on the startup line (#3141)", async () => {
		// spawn's `stdio: "pipe"` hands the wrapper UNIX sockets, which the
		// private-description fix cannot reopen; the line must say so.
		const run = await runWrapper(exitWith(0));
		expect(run.stdout).toMatch(
			/^\[mem-watch\] host [^\n]* stdio=stdout:socket\/inherited,stderr:socket\/inherited\n/,
		);
	});

	it("rejects a usage error with 2", async () => {
		// No `--` separator: nothing to run.
		const run = await runWrapper([]);
		expect(run.code).toBe(2);
		expect(run.stderr).toContain("usage:");
	});

	it("reports a command it cannot spawn with 1", async () => {
		const run = await runWrapper([
			"--",
			"pi-lens-no-such-binary-2042",
			"--version",
		]);
		expect(run.code).toBe(1);
	});
});

describe("with-memory-watch verdict durability (#2042)", () => {
	it("routes every record through a blocking write", () => {
		// The behavioural case below is the real proof, but it can only FAIL on
		// Linux. Windows discards pipe-buffered bytes at process teardown even
		// after `fs.writeSync` reports a complete write (#2093 verify: `ok
		// bytes=86 of 86`, nothing at the reader), so no write mechanism makes
		// the loss reproducible-then-fixed there. CI is Linux, which is exactly
		// where the fix holds and where nobody is watching.
		//
		// So pin the mechanism too, on every platform: no record may go out
		// through `process.stdout.write` or `process.stderr.write`, whose queued
		// bytes `process.exit` discards on Linux. Reverting any `emit(...)` call
		// to a stream write reds here regardless of OS. On a dev box this text
		// pin is the only thing holding the ratchet.
		const source = fs.readFileSync(wrapper, "utf8");
		const offending = source
			.split("\n")
			.map((line, index) => ({ line: line.trim(), number: index + 1 }))
			.filter(
				(entry) =>
					/process\.std(out|err)\.write/.test(entry.line) &&
					!entry.line.startsWith("*") &&
					!entry.line.startsWith("//"),
			);
		expect(
			offending,
			"use emit() (fs.writeSync) so process.exit cannot discard the record",
		).toEqual([]);
	});

	it("writes the verdict even when the log reader has fallen behind", async () => {
		// 4 MB through a 64 KB pipe against a reader that stalls 20ms per chunk:
		// by the time the child exits, the pipe is full, so an asynchronously
		// queued `process.stdout.write` is still pending when `process.exit`
		// discards it. The #2093 review reproduced that 3/3 on Linux — correct
		// exit code, no verdict line — losing the record in exactly the
		// memory-pressured run this wrapper exists to explain. A blocking
		// `fs.writeSync(1, ...)` survives on Linux. This case cannot fail on
		// Windows at these parameters, and a heavier probe (18 MB, 4 KB reads)
		// fails there even WITH the fix (teardown discard, see the mechanism
		// guard) — if a Windows unit-test leg is ever added, expect this case to
		// flake for reasons unrelated to the code.
		const run = await runWrapper(
			["--", nodeCmd, "-e", "process.stdout.write('x'.repeat(4194304))"],
			20,
		);
		expect(run.code, run.stderr).toBe(0);
		expect(run.stdout).toContain("[mem-watch] done.");
		expect(run.stdout).toContain("lowWaterAvailableMb=");
	}, 60_000);

	it("survives a sampler tick that fires while the full pipe is non-blocking", async () => {
		// Recurrence guarded: #3097, CI run 35067086859 job 104699844872 --
		// `Error: EAGAIN ... at emit (with-memory-watch.mjs:77) at
		// Timeout._onTimeout (with-memory-watch.mjs:130)`, wrapper exit 1.
		//
		// The CHILD flips fd 1 to non-blocking, not the wrapper: `stdio:
		// "inherit"` gives both processes one shared open file description, and
		// libuv sets O_NONBLOCK on it the moment the child initialises its own
		// `process.stdout` on a pipe. From then on the wrapper's blocking-write
		// durability mechanism (#2093) is not blocking at all -- every
		// `fs.writeSync(1, ...)` throws EAGAIN while the reader has let the
		// 64 KB pipe fill, and a throw inside the `setInterval` callback has
		// nothing to catch it. That is the wrapper dying under exactly the
		// backpressure it exists to survive.
		//
		// 20 ms ticks with every sample forced to print puts a tick inside the
		// window the 4 MB / 20 ms-stall reader holds the pipe full; the shipped
		// 2000 ms cadence is only why it was a 3-of-4 flake rather than a
		// constant. Pre-fix this case is exit 1 with the stack above.
		const run = await runWrapper(
			["--", nodeCmd, "-e", "process.stdout.write('x'.repeat(4194304))"],
			20,
			{
				PI_LENS_MEM_WATCH_INTERVAL_MS: "20",
				PI_LENS_MEM_WATCH_LOW_MB: "999999999",
			},
		);
		expect(run.code, run.stderr).toBe(0);
		expect(
			run.stderr,
			"an EAGAIN must never reach the top level",
		).not.toContain("EAGAIN");
		expect(run.stdout).toContain("[mem-watch] done.");
	}, 60_000);

	it("degrades a write failure that is not EAGAIN to one stderr note", async () => {
		// Recurrence guarded: #3097 again, the other half. A retry loop that
		// only ever retries would spin forever on a permanent failure, and a
		// wrapper that rethrows it still kills the job it was wrapping. Killing
		// the READ end mid-run makes every later `emit` fail with EPIPE:
		// the wrapper must still forward the child's code, and must record the
		// loss exactly ONCE however many ticks hit the dead pipe (~20 here at a
		// 20 ms cadence) -- the bounded-observability rule, and the reason the
		// note is latched rather than printed per occurrence.
		const run = await runWrapper(
			["--", nodeCmd, "-e", "setTimeout(()=>{},400)"],
			0,
			{
				PI_LENS_MEM_WATCH_INTERVAL_MS: "20",
				PI_LENS_MEM_WATCH_LOW_MB: "999999999",
			},
			(child) => child.stdout.destroy(),
		);
		expect(run.code, run.stderr).toBe(0);
		expect(
			run.stderr.match(/\[mem-watch\] record dropped:/g)?.length ?? 0,
			run.stderr,
		).toBe(1);
		expect(run.stderr).toContain("record dropped: EPIPE");
	}, 30_000);

	it("still writes the failure note when stderr is merely full, not dead", async () => {
		// #3110, from the #3106 review: the case above kills stdout while
		// stderr stays a healthy pipe the test reads immediately, so the
		// wrapper's raw `fs.writeSync(2, ...)` note-write always had room and
		// always succeeded there. It does NOT cover fd 2 being a live but
		// FULL pipe -- a slow reader on stderr, not a dead one -- which is
		// EAGAIN, not EPIPE, on the write. A bare `try { writeSync } catch {}`
		// around that write drops the note for good on that path: reproduced
		// 3/3 with this exact scenario before the fix (see PR body).
		//
		// Bypasses `runWrapper`'s single stdout throttle: this needs stdout
		// DESTROYED (dead) and stderr merely BACKED UP (full) at the same
		// time, which needs independent control of both streams. The
		// grandchild floods stderr continuously (not stdout) so the pipe
		// wrapper and grandchild share via `stdio: "inherit"` backs up while
		// this test's own stderr reader is paused; stdout is destroyed once
		// there has been time for that backpressure to build, so the next
		// tick's normal stdout write throws EPIPE and the resulting note-write
		// attempt on stderr lands while stderr is still full.
		//
		// Round-2 review F3: a fixed 100ms stderr-resume cadence from the
		// START left room in the pipe often enough that the 150ms stdout kill
		// could land on a write that just succeeds -- measured 1 lap in 5
		// green on PRE-FIX code (the raw `fs.writeSync` + bare catch), which
		// proves nothing. Resuming on a SLOW 400ms cadence until stdout is
		// confirmed dead keeps the pipe reliably full at the moment that
		// matters; only once `stdoutDead` flips does the reader speed back up
		// to 100ms, which is what lets a FIXED wrapper's note through.
		const sampleFile = makeSampleFile();
		const grandchildScript =
			"const iv=setInterval(()=>{process.stderr.write('x'.repeat(65536));},2);" +
			"setTimeout(()=>{clearInterval(iv);process.exit(0);},600);";
		const run = await new Promise<Run>((resolve, reject) => {
			const child = spawn(
				process.execPath,
				[wrapper, "--", nodeCmd, "-e", grandchildScript],
				{
					cwd: repoRoot,
					stdio: ["ignore", "pipe", "pipe"],
					env: {
						...process.env,
						PI_LENS_MEM_WATCH_INTERVAL_MS: "20",
						PI_LENS_MEM_WATCH_LOW_MB: "999999999",
						PI_LENS_MEM_WATCH_SAMPLE_FILE: sampleFile,
					},
				},
			);
			let stdout = "";
			let stderr = "";
			let stdoutDead = false;
			child.stdout.setEncoding("utf8");
			child.stderr.setEncoding("utf8");
			child.stdout.on("data", (chunk: string) => {
				stdout += chunk;
			});
			child.stderr.on("data", (chunk: string) => {
				stderr += chunk;
				child.stderr.pause();
				setTimeout(() => child.stderr.resume(), stdoutDead ? 100 : 400);
			});
			setTimeout(() => {
				try {
					child.stdout.destroy();
				} catch {
					// already gone
				}
				stdoutDead = true;
			}, 150);
			child.on("error", reject);
			child.on("close", (code) => resolve({ code, stdout, stderr }));
		});
		try {
			expect(run.code, run.stderr.slice(-2000)).toBe(0);
			expect(
				run.stderr.match(/\[mem-watch\] record dropped:/g)?.length ?? 0,
				run.stderr.slice(-2000),
			).toBe(1);
			expect(run.stderr).toContain("record dropped: EPIPE");
		} finally {
			fs.rmSync(sampleFile, { force: true });
		}
	}, 30_000);

	it("bounds the note-write retry so a permanently full stderr cannot hang the wrapper", async () => {
		// Round-2 review F1: routing the once-only note through the retrying
		// `emit()` inherits its UNBOUNDED EAGAIN park. With stdout dead and
		// stderr live but NEVER drained at all (the reader here attaches no
		// listener, so the OS pipe fills and stays full), the note-write
		// retry loop parks inside the sampler's `setInterval` callback and
		// blocks the event loop forever: `child.on("exit")` never runs, and a
		// CI job sees a timeout with no exit status at all -- worse than the
		// dropped note #3110 fixes. Reproduced 3/3 on the round-1 fix (an
		// uncapped `emit()`): no close within 8s. A capped retry gives up and
		// lets the wrapper forward the child's exit code.
		//
		// Deliberately does NOT attach any `data` listener to `child.stderr`
		// -- attaching one, even to just discard chunks, switches the stream
		// into flowing mode and drains the underlying pipe, which is exactly
		// the condition this case must NOT have.
		const sampleFile = makeSampleFile();
		const grandchildScript =
			"const iv=setInterval(()=>{process.stderr.write('x'.repeat(65536));},2);" +
			"setTimeout(()=>{clearInterval(iv);process.exit(7);},3000);";
		try {
			const run = await new Promise<{
				code: number | null;
				timedOut: boolean;
			}>((resolve, reject) => {
				const child = spawn(
					process.execPath,
					[wrapper, "--", nodeCmd, "-e", grandchildScript],
					{
						cwd: repoRoot,
						stdio: ["ignore", "pipe", "pipe"],
						env: {
							...process.env,
							PI_LENS_MEM_WATCH_INTERVAL_MS: "20",
							PI_LENS_MEM_WATCH_LOW_MB: "999999999",
							PI_LENS_MEM_WATCH_SAMPLE_FILE: sampleFile,
						},
					},
				);
				child.stdout.on("data", () => {
					// Drained (unlike stderr): destroying it below is what forces
					// the wrapper's regular ticks into the EPIPE/note-write path.
				});
				setTimeout(() => {
					try {
						child.stdout.destroy();
					} catch {
						// already gone
					}
				}, 150);
				child.on("error", reject);
				child.on("close", (code) => resolve({ code, timedOut: false }));
				setTimeout(() => {
					child.kill("SIGKILL");
					resolve({ code: null, timedOut: true });
				}, 8_000);
			});
			expect(run.timedOut, "wrapper did not exit within 8s -- hung").toBe(
				false,
			);
			expect(run.code).toBe(7);
		} finally {
			fs.rmSync(sampleFile, { force: true });
		}
	}, 15_000);

	it("still forwards the child's exit code when stdout and stderr die together", async () => {
		// Round-2 review F2: the recursion-termination claim in
		// `noteWriteFailureOnce`'s docstring ("writeFailureNoted set BEFORE
		// calling emit") had no test -- swapping the two lines (compile-valid)
		// left every existing case green, because every existing case kills
		// at most ONE of the two fds. With BOTH fds dead, every `emit` call --
		// the tick's own AND the note's -- throws EPIPE; the latch-after-call
		// order lets `noteWriteFailureOnce` re-enter itself before the latch
		// is set, recursing once per tick until the call stack overflows and
		// an uncaught `RangeError` kills the wrapper with Node's default exit
		// code 1 instead of forwarding the child's real exit code (the #3097
		// failure mode). Measured on the mutation: 3/3 runs close at ~120ms
		// with code 1, never 7.
		const sampleFile = makeSampleFile();
		const grandchildScript = "setTimeout(()=>{process.exit(7);},300);";
		try {
			const run = await new Promise<Run>((resolve, reject) => {
				const child = spawn(
					process.execPath,
					[wrapper, "--", nodeCmd, "-e", grandchildScript],
					{
						cwd: repoRoot,
						stdio: ["ignore", "pipe", "pipe"],
						env: {
							...process.env,
							PI_LENS_MEM_WATCH_INTERVAL_MS: "20",
							PI_LENS_MEM_WATCH_LOW_MB: "999999999",
							PI_LENS_MEM_WATCH_SAMPLE_FILE: sampleFile,
						},
					},
				);
				let stdout = "";
				let stderr = "";
				let sawFirstChunk = false;
				child.stdout.setEncoding("utf8");
				child.stderr.setEncoding("utf8");
				child.stdout.on("data", (chunk: string) => {
					stdout += chunk;
					if (!sawFirstChunk) {
						sawFirstChunk = true;
						try {
							child.stdout.destroy();
						} catch {
							// already gone
						}
						try {
							child.stderr.destroy();
						} catch {
							// already gone
						}
					}
				});
				child.stderr.on("data", (chunk: string) => {
					stderr += chunk;
				});
				child.on("error", reject);
				child.on("close", (code) => resolve({ code, stdout, stderr }));
			});
			expect(run.code).toBe(7);
		} finally {
			fs.rmSync(sampleFile, { force: true });
		}
	}, 15_000);
});

/**
 * #3141: once the wrapped command has exited, its libuv teardown restores the
 * blocking flag on the stdout/stderr description it shared via `stdio:
 * "inherit"`, so the wrapper's next `writeSync` to a full pipe blocks outright
 * and the note's 400 ms cap never gets a turn. Two probes from the #3129
 * round-2 verify, both hanging on master:
 *
 * - the child exits while the note retry is still parked (child exits at
 *   300 ms, stdout reader dies at 150 ms, stderr never read);
 * - no periodic line (`LOW_MB=1`, the healthy-memory CI shape), so the verdict
 *   line at child exit is the first write after stdout dies.
 *
 * The wrapper's stdout/stderr here are real FIFOs, the shape a CI runner gives
 * the Unit tests step. `spawn`'s own `stdio: "pipe"` hands the wrapper UNIX
 * SOCKETS instead, which the fix does not cover (see the wrapper's
 * `ownWriteFd` comment), so the helper above cannot stage this. POSIX only:
 * `mkfifo` and `/proc` reopening are Linux mechanics, and the authoritative
 * Unit tests lane is ubuntu.
 */
// Flake-shape note (real-process-spawn, covered by this file's admission):
// `mkfifo` builds the real kernel FIFO the wrapper writes into; the defect is
// a kernel fd-flag reset no double has.
describe.skipIf(process.platform === "win32")(
	"with-memory-watch writes through its own pipe description (#3141)",
	() => {
		async function runOverFifos(
			exitMs: number,
			lowMb: string,
		): Promise<{ code: number | null; timedOut: boolean }> {
			const dir = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-mem-watch-test-"),
			);
			const outFifo = path.join(dir, "out");
			const errFifo = path.join(dir, "err");
			execFileSync("mkfifo", [outFifo, errFifo]);
			// Read ends first (non-blocking), so opening the write ends cannot park.
			const outRead = fs.openSync(
				outFifo,
				fs.constants.O_RDONLY | fs.constants.O_NONBLOCK,
			);
			const errRead = fs.openSync(
				errFifo,
				fs.constants.O_RDONLY | fs.constants.O_NONBLOCK,
			);
			const outWrite = fs.openSync(outFifo, "w");
			const errWrite = fs.openSync(errFifo, "w");
			const grandchildScript =
				"const iv=setInterval(()=>{process.stderr.write('x'.repeat(65536));},2);" +
				`setTimeout(()=>{clearInterval(iv);process.exit(7);},${exitMs});`;
			try {
				return await new Promise((resolve, reject) => {
					const child = spawn(
						process.execPath,
						[wrapper, "--", nodeCmd, "-e", grandchildScript],
						{
							cwd: repoRoot,
							stdio: ["ignore", outWrite, errWrite],
							env: {
								...process.env,
								PI_LENS_MEM_WATCH_INTERVAL_MS: "20",
								PI_LENS_MEM_WATCH_LOW_MB: lowMb,
								PI_LENS_MEM_WATCH_SAMPLE_FILE: path.join(dir, "samples.log"),
							},
						},
					);
					fs.closeSync(outWrite);
					fs.closeSync(errWrite);
					// The stdout reader dies; the stderr reader never reads.
					setTimeout(() => fs.closeSync(outRead), 150);
					const deadline = setTimeout(() => {
						child.kill("SIGKILL");
						resolve({ code: null, timedOut: true });
					}, 8_000);
					child.on("error", reject);
					child.on("close", (code) => {
						clearTimeout(deadline);
						resolve({ code, timedOut: false });
					});
				});
			} finally {
				fs.closeSync(errRead);
				fs.rmSync(dir, { recursive: true, force: true });
			}
		}

		it("keeps writing through the inherited fd when stdout is a regular file", async () => {
			// Reopening a regular file would open a second, independent offset:
			// the wrapper's lines and the child's would overwrite each other.
			const dir = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-mem-watch-test-"),
			);
			const outFile = path.join(dir, "out.log");
			const out = fs.openSync(outFile, "w");
			try {
				const code = await new Promise<number | null>((resolve, reject) => {
					const child = spawn(
						process.execPath,
						[
							wrapper,
							"--",
							nodeCmd,
							"-e",
							"for(let i=0;i<50;i++)console.log('child-line-'+i);",
						],
						{
							cwd: repoRoot,
							stdio: ["ignore", out, "ignore"],
							env: {
								...process.env,
								PI_LENS_MEM_WATCH_SAMPLE_FILE: path.join(dir, "samples.log"),
							},
						},
					);
					fs.closeSync(out);
					child.on("error", reject);
					child.on("close", resolve);
				});
				expect(code).toBe(0);
				const text = fs.readFileSync(outFile, "utf8");
				expect(text.startsWith("[mem-watch] host ")).toBe(true);
				expect(text).toMatch(/ stdio=stdout:file\/inherited,stderr:/);
				expect(text).toContain("child-line-0\nchild-line-1\n");
				expect(text).toContain("child-line-49\n");
				expect(text).toMatch(/\[mem-watch\] done\. exitCode=0 /);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		}, 15_000);

		it("still delivers the verdict through a slow pipe reader (#2093 on the private description)", async () => {
			const dir = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-mem-watch-test-"),
			);
			const outFifo = path.join(dir, "out");
			execFileSync("mkfifo", [outFifo]);
			// A non-blocking read end lets the write end open without parking; a
			// blocking read end then opens at once (a writer exists) and backs the
			// stream, and the placeholder closes.
			const placeholder = fs.openSync(
				outFifo,
				fs.constants.O_RDONLY | fs.constants.O_NONBLOCK,
			);
			const outWrite = fs.openSync(outFifo, "w");
			const reader = fs.createReadStream("", {
				fd: fs.openSync(outFifo, "r"),
				encoding: "utf8",
			});
			fs.closeSync(placeholder);
			let text = "";
			reader.on("data", (chunk) => {
				text += chunk;
				reader.pause();
				setTimeout(() => reader.resume(), 20);
			});
			try {
				const code = await new Promise<number | null>((resolve, reject) => {
					const child = spawn(
						process.execPath,
						[
							wrapper,
							"--",
							nodeCmd,
							"-e",
							"process.stdout.write('y'.repeat(1<<20));",
						],
						{
							cwd: repoRoot,
							stdio: ["ignore", outWrite, "ignore"],
							env: {
								...process.env,
								PI_LENS_MEM_WATCH_SAMPLE_FILE: path.join(dir, "samples.log"),
							},
						},
					);
					fs.closeSync(outWrite);
					child.on("error", reject);
					child.on("close", resolve);
				});
				await new Promise((resolve) => reader.on("close", resolve));
				expect(code).toBe(0);
				expect(text).toMatch(/\[mem-watch\] done\. exitCode=0 /);
				// #3141: the startup line says the private description engaged.
				expect(text).toMatch(/ stdio=stdout:pipe\/private,stderr:/);
			} finally {
				reader.destroy();
				fs.rmSync(dir, { recursive: true, force: true });
			}
		}, 30_000);

		it("forwards the exit code when the child exits while the note retry is parked", async () => {
			const run = await runOverFifos(300, "999999999");
			expect(run.timedOut, "wrapper did not exit within 8s -- hung").toBe(
				false,
			);
			expect(run.code).toBe(7);
		}, 15_000);

		it("forwards the exit code when the verdict is the first write after stdout dies", async () => {
			const run = await runOverFifos(600, "1");
			expect(run.timedOut, "wrapper did not exit within 8s -- hung").toBe(
				false,
			);
			expect(run.code).toBe(7);
		}, 15_000);
	},
);

/**
 * Round-2 review N1. Both fields the verdict reads are set by the WRAPPER, and
 * both were pinned only at the formatter. Delete `intervalMs,` from the watch
 * object and every formatter test stays green: the shipped verdict silently
 * loses its cadence caveat and nothing notices. Same for the spawned pid, which
 * is what makes the kernel's "Killed process <pid>" line attributable.
 *
 * These are source-text pins for the same reason the durability mechanism above
 * is one: the behaviour they guard only appears in a real CI kill, which no
 * unit test can stage.
 *
 * #3108: the mutation (advisory) lane mutates this file in place and runs
 * these tests against the INSTRUMENTED copy — same path, same repo root
 * (stryker.config.mjs sets `inPlace: true`, so there is no separate sandbox
 * directory to resolve away from), but every expression Stryker's
 * switch-mutant technique touches gets rewritten to
 * `stryMutAct_<ns>("<id>") ? <mutant> : (stryCov_<ns>("<id>"), <original>)`
 * even with no mutant active (the dry run). A strict adjacency match only
 * ever sees the real fragment in the un-instrumented file, so it false-reds
 * the dry run on every PR that touches this file (#3108: PR #3061, PR #3106).
 * `strykerTolerant` swallows that OPTIONAL wrapper so the pin reads the same
 * real fragment in both lanes; it still cannot find the fragment when the
 * fragment itself is genuinely gone (a plain, non-wrapped deletion), so the
 * pins keep catching that.
 */
describe("with-memory-watch verdict wiring (#2042)", () => {
	const source = (): string => fs.readFileSync(wrapper, "utf8");

	/**
	 * Builds a regex source fragment that optionally swallows Stryker's
	 * switch-mutant scaffolding immediately in front of a real fragment, so a
	 * text pin built from it matches the same fragment whether or not the
	 * mutation lane instrumented the file (#3108). `truePattern` is the regex
	 * source for what Stryker puts in the mutant (kept) branch, bounded to one
	 * line so it can never swallow the fragment being pinned itself; the
	 * mutant id is captured and back-referenced into the coverage-tracking
	 * call so the wrapper only matches its OWN ternary, not an unrelated one.
	 */
	function strykerTolerant(truePattern: string): string {
		return `(?:stryMutAct_\\w+\\("(\\d+)"\\)\\s*\\?\\s*${truePattern}\\s*:\\s*\\(stryCov_\\w+\\("\\1"\\),\\s*)?`;
	}

	it("hands the sampling cadence to the verdict", () => {
		const watchLiteral = new RegExp(
			`const watch = ${strykerTolerant("\\{\\}")}\\{([\\s\\S]*?)\\n\\}\\)?;`,
		);
		const literal = watchLiteral.exec(source());
		expect(literal, "the wrapper's `watch` object literal").not.toBeNull();
		expect(
			literal?.[2],
			"watch.intervalMs feeds formatVerdict's cadence caveat",
		).toMatch(/^\s*intervalMs\b/m);
	});

	it("records the pid it spawned, so the kernel's victim is nameable", () => {
		const childPidPin = new RegExp(
			`watch\\.childPid\\s*=\\s*${strykerTolerant("[^\\n]*?")}child\\.pid`,
		);
		expect(
			source(),
			"watch.childPid must be set from the spawned child",
		).toMatch(childPidPin);
	});
});

// flake-shape: raw-timer-wait — the poll loop below waits for the wrapper's
// OWN real setInterval sampling tick to reach disk, which cannot be faked
// from the test process (a separate real child process); a fixed sleep here
// flaked under concurrent vitest workers, so this waits for the actual
// condition (file exists) instead. Round-2 review S1: the file's other raw
// timer waits are the same non-fakeable shape from a different angle -- a
// slow-reader's resume cadence (stderr backpressure a real OS pipe has to
// actually drain) and a fixed grace delay before a real, separately spawned
// process is expected to have exited (`stdout`/`stderr` destroy timing and
// the note-write cap's own bound) -- not the sample-tail poll this comment
// originally named.
/**
 * #2042 2026-09-15 diagnosis, section A: the cheapest probe. End-to-end
 * through the real wrapper, not the library functions directly, so the wiring
 * between the interval tick and the on-disk file is what is under test.
 */
describe("with-memory-watch sample tail (#2042 2026-09-15)", () => {
	// Round-2 review F2: replaces the old ring-buffer "never grows past the
	// cap" case. The sampler no longer caps anything it writes -- an
	// append-only file can never lose an earlier line to a rewrite, which is
	// exactly what a fixed ring did on the real 2026-09-15 CI run (the tail
	// covered only the run's last 60s, 21:10:04-21:11:04, while the actual
	// low-water event -- what a kill would land near -- was at 21:02:18,
	// already scrolled out). What has to hold instead: one line per tick, in
	// order, never truncated, growing linearly with elapsed ticks.
	it("appends exactly one line per tick, in order, never truncating earlier lines", async () => {
		const sampleFile = makeSampleFile();
		try {
			await runWrapper(["--", nodeCmd, "-e", "setTimeout(() => {}, 250)"], 0, {
				PI_LENS_MEM_WATCH_INTERVAL_MS: "30",
				PI_LENS_MEM_WATCH_SAMPLE_FILE: sampleFile,
			});
			const lines = fs
				.readFileSync(sampleFile, "utf8")
				.split("\n")
				.filter(Boolean);
			// ~250ms / 30ms: at least 5 ticks fired, and NONE were trimmed --
			// the old ring, fed the same parameters, would have capped this at 2.
			expect(lines.length).toBeGreaterThanOrEqual(5);
			for (const line of lines) {
				expect(line).toMatch(
					/^\[mem-sample\] \d\d:\d\d:\d\d\.\d\d\d availableMb=\d+ totalMb=\d+ /,
				);
				expect(line).toMatch(/memCurrentMb=(\?|\d+) memPeakMb=(\?|\d+)/);
				expect(line).toMatch(/pids=(\?|\d+)/);
			}
			// Strictly increasing millisecond stamps: every tick's line survives,
			// none overwritten, none reordered.
			const stamps = lines.map(
				(line) => /\[mem-sample\] (\d\d:\d\d:\d\d\.\d\d\d)/.exec(line)?.[1],
			);
			const sorted = [...stamps].sort();
			expect(stamps).toEqual(sorted);
		} finally {
			fs.rmSync(sampleFile, { force: true });
		}
	}, 15_000);

	it("still leaves the sample file behind when the wrapper's own process is the one killed", async () => {
		// The master 1701d01 red: no verdict line, because the wrapper itself
		// died, not its child. That is exactly the case the file has to survive
		// -- proven here by killing the WRAPPER (not the child) mid-run and
		// checking the file anyway. Waits for the FIRST tick's write rather than
		// a fixed sleep, so this stays reliable under a loaded, contended box
		// (a fixed short sleep flaked here under concurrent vitest workers: the
		// wrapper's own process start can take longer than the sleep on a busy
		// host, which would make the kill land before the first tick and turn a
		// real fix into a flaky test).
		const sampleFile = makeSampleFile();
		try {
			const child = spawn(
				process.execPath,
				[wrapper, "--", nodeCmd, "-e", "setTimeout(() => {}, 30000)"],
				{
					cwd: repoRoot,
					stdio: "ignore",
					env: {
						...process.env,
						PI_LENS_MEM_WATCH_INTERVAL_MS: "30",
						PI_LENS_MEM_WATCH_SAMPLE_FILE: sampleFile,
					},
				},
			);
			const deadline = Date.now() + 10_000;
			while (!fs.existsSync(sampleFile)) {
				if (Date.now() > deadline) {
					child.kill("SIGKILL");
					throw new Error("sample file never appeared before the deadline");
				}
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			child.kill("SIGKILL");
			// One more tick's worth of grace for the write that was already
			// in-flight when the kill landed to finish reaching disk.
			await new Promise((resolve) => setTimeout(resolve, 100));
			expect(fs.existsSync(sampleFile)).toBe(true);
			const lines = fs
				.readFileSync(sampleFile, "utf8")
				.split("\n")
				.filter(Boolean);
			expect(lines.length).toBeGreaterThan(0);
		} finally {
			fs.rmSync(sampleFile, { force: true });
		}
	}, 15_000);
});
