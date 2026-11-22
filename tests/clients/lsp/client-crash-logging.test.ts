// flake-shape: real-process-spawn — a child that dies unprompted must emit a real exit signal and close event; a stub never exits on its own
// flake-shape: raw-timer-wait — the late reader of a full stderr pipe must start after the crash writer met EAGAIN and before its 1 s deadline; the writer exposes no event for that moment, so a bounded real delay is the only way to place the reader (#5746 r4).
/**
 * #615-followup dogfooding: an ast-grep client died 5 times mid-sweep in a real
 * project and NOTHING in latency.log recorded why — no exit code, no signal,
 * no stderr. Root cause: the `lsp_server_unexpected_exit` log in
 * `setupConnectionLifecycle` (client.ts) was gated on `wasConnected`, captured
 * at the moment the process `exit` event fires. For a crash where the JSON-RPC
 * transport tears down first (`connection.onClose`/`onError`, which already
 * flip `isConnected` to false and run synchronously off the closing stdio
 * pipe), that flag is already false by the time `exit` fires — so the log
 * silently never ran, indistinguishable from an intentional `shutdown()`.
 *
 * The fix swaps the gate to an explicit `state.shutdownRequested` flag set
 * ONLY by `clientShutdown()`, and adds the exit signal + a stderr tail to the
 * log. This test kills the fake server's real child process out from under a
 * live client (no `shutdown()` call first) and confirms the crash IS logged
 * with a real exit code/signal — the exact case that went dark before.
 */

import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logLatency } from "../../../clients/latency-logger.js";
import { spawnFakeLspServer } from "../../support/fake-lsp-server.js";
import { setupTestEnvironment } from "../test-utils.js";

/** The crash report's byte cap and the line that ends a capped report: the
 *  #5746 r4 bound, pinned here as numbers so a changed cap is a visible edit. */
const CRASH_STACK_MAX_BYTES = 16 * 1024;
const TRUNCATION_LINE = "\n[lsp-crash] crash report truncated at 16384 bytes\n";
/** How long the late reader waits after the child starts its report: past
 *  the writer's first write, and a quarter of its 1 s deadline. */
const LATE_READER_MS = 250;

vi.mock("../../../clients/latency-logger.js", async (importActual) => ({
	...(await importActual<
		typeof import("../../../clients/latency-logger.js")
	>()),
	logLatency: vi.fn(),
}));

describe("LSP client — crash exit is logged, not silently swallowed", () => {
	async function runCrashGuardProbe(
		mode:
			| "crash"
			| "rejection"
			| "large-rejection"
			| "hostile-rejection"
			| "hostile-stack"
			| "closed-stderr"
			| "duplicate"
			| "preexisting"
			| "ignorable"
			| "other",
	): Promise<{ code: number | null; stdout: string; stderr: string }> {
		const launch = pathToFileURL(path.resolve("clients/lsp/launch.js")).href;
		const clientModule = pathToFileURL(
			path.resolve("clients/lsp/client.js"),
		).href;
		const fixture = path.resolve("tests/fixtures/stubborn-lsp-server.mjs");
		const source = `
const { launchLSP } = await import(${JSON.stringify(launch)});
const { createLSPClient } = await import(${JSON.stringify(clientModule)});
const lsp = await launchLSP(process.execPath, [${JSON.stringify(fixture)}]);
if (${JSON.stringify(mode)} === "preexisting") {
  process.once("uncaughtException", () => { process.stdout.write("PREEXISTING_LISTENER"); setTimeout(() => process.exit(0), 50); });
}
await createLSPClient({ serverId: "probe", process: lsp, root: process.cwd() });
let lsp2;
if (${JSON.stringify(mode)} === "duplicate") {
  const second = await import(${JSON.stringify(clientModule)} + "?reloaded");
  lsp2 = await launchLSP(process.execPath, [${JSON.stringify(fixture)}]);
  await second.createLSPClient({ serverId: "probe-2", process: lsp2, root: process.cwd() });
}
process.once("exit", () => {
  for (const child of [lsp, lsp2]) { try { child?.process.kill("SIGKILL"); } catch {} }
  process.stdout.write("EXIT_MARKER");
});
if (${JSON.stringify(mode)} === "ignorable") {
  process.emit("uncaughtException", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
  setTimeout(() => process.exit(0), 50);
} else if (${JSON.stringify(mode)} === "other") {
  process.once("uncaughtException", () => { process.stdout.write("OTHER_LISTENER"); setTimeout(() => process.exit(0), 50); });
  setTimeout(() => { throw new Error("PROBE delegated crash"); }, 50);
} else if (${JSON.stringify(mode)} === "rejection") {
  Promise.reject(new Error("PROBE non-LSP rejection"));
} else if (${JSON.stringify(mode)} === "hostile-rejection") {
  Promise.reject(Object.create(null));
} else if (${JSON.stringify(mode)} === "hostile-stack") {
  const error = new Error("PROBE hostile stack");
  Object.defineProperty(error, "stack", { get() { throw new Error("stack getter"); } });
  setTimeout(() => { throw error; }, 50);
} else if (${JSON.stringify(mode)} === "large-rejection") {
  const error = new Error("PROBE large rejection");
  error.stack = "large-crash-stack:" + "x".repeat(1024 * 1024);
  Promise.reject(error);
} else {
  setTimeout(() => { throw new Error("PROBE non-LSP crash"); }, 50);
}`;
		return await new Promise((resolve, reject) => {
			const child = spawn(
				process.execPath,
				["--input-type=module", "-e", source],
				{
					cwd: process.cwd(),
					stdio: ["ignore", "pipe", "pipe"],
				},
			);
			let stdout = "";
			let stderr = "";
			child.stdout.setEncoding("utf8");
			child.stderr.setEncoding("utf8");
			child.stdout.on("data", (chunk: string) => (stdout += chunk));
			child.stderr.on("data", (chunk: string) => (stderr += chunk));
			// The child's stderr then has no reader: its crash report fails EPIPE.
			if (mode === "closed-stderr") child.stderr.destroy();
			child.once("error", reject);
			child.once("exit", (code) => resolve({ code, stdout, stderr }));
		});
	}
	let client:
		| Awaited<
				ReturnType<
					typeof import("../../../clients/lsp/client.js").createLSPClient
				>
		  >
		| undefined;
	let proc: Awaited<ReturnType<typeof spawnFakeLspServer>> | undefined;

	beforeEach(() => {
		(logLatency as ReturnType<typeof vi.fn>).mockReset();
	});

	afterEach(async () => {
		if (client) {
			try {
				await client.shutdown();
			} catch {
				/* ignore */
			}
			client = undefined;
		}
		proc = undefined;
	});

	it("logs lsp_server_unexpected_exit with a real exit signal when the child dies unprompted", async () => {
		const { createLSPClient } = await import("../../../clients/lsp/client.js");
		proc = await spawnFakeLspServer({ cwd: process.cwd() });
		client = await createLSPClient({
			serverId: "fake",
			process: proc,
			root: process.cwd(),
		});
		expect(client.isAlive()).toBe(true);

		// Kill the real child directly — no clientShutdown() call, so
		// shutdownRequested stays false, mirroring a genuine crash (not us
		// intentionally tearing the client down).
		proc.process.kill("SIGKILL");

		await vi.waitFor(() => {
			const calls = (logLatency as ReturnType<typeof vi.fn>).mock.calls;
			const hit = calls.find(
				([entry]) => entry?.phase === "lsp_server_unexpected_exit",
			);
			expect(hit).toBeDefined();
		});

		const calls = (logLatency as ReturnType<typeof vi.fn>).mock.calls;
		const [entry] = calls.find(
			([e]) => e?.phase === "lsp_server_unexpected_exit",
		)!;
		expect(entry.metadata.serverId).toBe("fake");
		expect(entry.metadata.exitSignal).toBe("SIGKILL");
		expect(typeof entry.metadata.stderrTail).toBe("string");
	}, 10_000);

	it("does NOT log lsp_server_unexpected_exit for an intentional shutdown()", async () => {
		const { createLSPClient } = await import("../../../clients/lsp/client.js");
		proc = await spawnFakeLspServer({ cwd: process.cwd() });
		client = await createLSPClient({
			serverId: "fake",
			process: proc,
			root: process.cwd(),
		});

		await client.shutdown();
		client = undefined;

		// Give the process a moment to actually exit and its 'exit' handler to run.
		await new Promise((resolve) => setTimeout(resolve, 300));

		const calls = (logLatency as ReturnType<typeof vi.fn>).mock.calls;
		const hit = calls.find(
			([entry]) => entry?.phase === "lsp_server_unexpected_exit",
		);
		expect(hit).toBeUndefined();
	}, 10_000);

	it("completes the exit transition for non-LSP process failures", async () => {
		const crash = await runCrashGuardProbe("crash");
		const rejection = await runCrashGuardProbe("rejection");
		expect(crash).toMatchObject({ code: 1 });
		expect(crash.stdout).toContain("EXIT_MARKER");
		expect(crash.stderr).toContain("PROBE non-LSP crash");
		expect(rejection).toMatchObject({ code: 1 });
		expect(rejection.stdout).toContain("EXIT_MARKER");
		expect(rejection.stderr).toContain("PROBE non-LSP rejection");
	}, 20_000);

	it("survives a re-evaluated client module and hostile rejection reason", async () => {
		const duplicate = await runCrashGuardProbe("duplicate");
		const hostile = await runCrashGuardProbe("hostile-rejection");
		// #5746 r4: the guard read a thrown Error's `stack` outside the
		// writer's catch, so a throwing getter threw inside the handler and
		// Node exited 7 with no exit listener run.
		const hostileStack = await runCrashGuardProbe("hostile-stack");
		expect(duplicate).toMatchObject({ code: 1 });
		expect(duplicate.stdout).toContain("EXIT_MARKER");
		expect(hostile).toMatchObject({ code: 1 });
		expect(hostile.stdout).toContain("EXIT_MARKER");
		expect(hostile.stderr).toContain("[lsp-crash] unprintable failure");
		expect(hostileStack).toMatchObject({ code: 1 });
		expect(hostileStack.stdout).toContain("EXIT_MARKER");
		expect(hostileStack.stderr).toContain("[lsp-crash] unprintable failure");
	}, 30_000);

	// #5746 r4 F1: a 1 MiB stack reaches stderr as its head and one
	// truncation line, so a slow terminal or a full pipe never takes more
	// than the cap.
	it("caps a large crash stack through a piped stderr", async () => {
		const result = await runCrashGuardProbe("large-rejection");
		expect(result).toMatchObject({ code: 1 });
		expect(result.stdout).toContain("EXIT_MARKER");
		expect(result.stderr).toContain("large-crash-stack:");
		expect(result.stderr.endsWith(TRUNCATION_LINE)).toBe(true);
		expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(
			CRASH_STACK_MAX_BYTES + Buffer.byteLength(TRUNCATION_LINE),
		);
	}, 20_000);

	// The closed-pipe row of the #5746 r4 state table: EPIPE ends the report
	// at once, and the exit listeners still run.
	it("exits through the exit listeners when stderr is closed", async () => {
		const result = await runCrashGuardProbe("closed-stderr");
		expect(result).toMatchObject({ code: 1 });
		expect(result.stdout).toContain("EXIT_MARKER");
	}, 20_000);

	it("keeps ignorable stream failures and delegates to another listener", async () => {
		const ignorable = await runCrashGuardProbe("ignorable");
		const other = await runCrashGuardProbe("other");
		expect(ignorable).toMatchObject({ code: 0, stderr: "" });
		expect(ignorable.stdout).toContain("EXIT_MARKER");
		expect(other).toMatchObject({ code: 0 });
		expect(other.stdout).toContain("OTHER_LISTENER");
	}, 20_000);

	it("lets a pre-existing once listener own the crash decision", async () => {
		const result = await runCrashGuardProbe("preexisting");
		expect(result).toMatchObject({ code: 0 });
		expect(result.stdout).toContain("PREEXISTING_LISTENER");
	}, 20_000);

	it("closeDocument sends didClose and clears document lifecycle state", async () => {
		const { createLSPClient } = await import("../../../clients/lsp/client.js");
		const filePath = path.join(process.cwd(), "client-close-document.ts");
		const fileUri = pathToFileURL(filePath).href;

		proc = await spawnFakeLspServer({ cwd: process.cwd() });
		client = await createLSPClient({
			serverId: "fake",
			process: proc,
			root: process.cwd(),
		});
		const sendNotification = vi.spyOn(client.connection, "sendNotification");

		await client.notify.open(
			filePath,
			"const broken = true;",
			"typescript",
			false,
			true,
		);
		await client.notify.change(filePath, "const changed = true;");
		await client.waitForDiagnostics(filePath, 1_000, { pullOnly: true });
		expect(client.isDocumentOpen(filePath)).toBe(true);
		expect(client.getDiagnostics(filePath)).toHaveLength(1);
		expect(client.getTrackedDiagnosticPaths()).toContain(filePath);

		await client.closeDocument(filePath);

		expect(sendNotification).toHaveBeenCalledWith("textDocument/didClose", {
			textDocument: { uri: fileUri },
		});
		expect(client.isDocumentOpen(filePath)).toBe(false);
		expect(client.getDiagnostics(filePath)).toEqual([]);
		expect(client.getTrackedDiagnosticPaths()).not.toContain(filePath);

		await client.notify.open(
			filePath,
			"const reopened = true;",
			"typescript",
			false,
			true,
		);
		const reopenCalls = sendNotification.mock.calls.filter(
			([method]) => method === "textDocument/didOpen",
		);
		const reopen = reopenCalls[reopenCalls.length - 1];
		expect(reopen?.[1]).toMatchObject({
			textDocument: { uri: fileUri, version: 0 },
		});

		await client.closeDocument(filePath);
		const closeCount = sendNotification.mock.calls.filter(
			([method]) => method === "textDocument/didClose",
		).length;
		await client.closeDocument(filePath);
		expect(
			sendNotification.mock.calls.filter(
				([method]) => method === "textDocument/didClose",
			).length,
		).toBe(closeCount);
	}, 10_000);
});

// #5746 r4 F1: the crash report's time bound on a full stderr pipe. A FIFO
// stands in for stderr because it is a real kernel pipe whose fill the test
// controls: the test fills it through its own non-blocking write end, then
// hands the child a separately opened, blocking write end, the state a pipe
// is in before anything in the process reads `process.stderr`. The child
// loads only the writer module, so nothing else in its graph has made fd 2
// non-blocking. POSIX only: Windows has no FIFO, and Node keeps Windows pipes
// blocking (the state table's stated residual).
describe.runIf(process.platform !== "win32")(
	"LSP crash report on a full stderr pipe (#5746 r4)",
	() => {
		const children: ChildProcess[] = [];
		const cleanups: Array<() => void> = [];

		afterEach(() => {
			for (const child of children.splice(0)) {
				if (child.exitCode === null && child.signalCode === null)
					child.kill("SIGKILL");
			}
			for (const cleanup of cleanups.splice(0)) cleanup();
		});

		/** A FIFO filled until a non-blocking write fails EAGAIN, and its
		 *  read end, which nothing reads until the test says so. */
		function fullFifo(): {
			fifo: string;
			readFd: number;
			home: string;
			filled: number;
		} {
			const env = setupTestEnvironment("lsp-crash-fifo-");
			cleanups.push(env.cleanup);
			const fifo = path.join(env.tmpDir, "stderr.fifo");
			expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
			const readFd = fs.openSync(
				fifo,
				fs.constants.O_RDONLY | fs.constants.O_NONBLOCK,
			);
			const fillFd = fs.openSync(
				fifo,
				fs.constants.O_WRONLY | fs.constants.O_NONBLOCK,
			);
			const chunk = Buffer.alloc(4096, ".");
			let filled = 0;
			try {
				for (;;) filled += fs.writeSync(fillFd, chunk);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EAGAIN") throw error;
			} finally {
				fs.closeSync(fillFd);
			}
			return { fifo, readFd, home: path.join(env.tmpDir, "home"), filled };
		}

		/** A child that writes a 100 MiB crash stack through the built writer
		 *  into the FIFO as its stderr, and reports on stdout around it. */
		function writeReportInto(fifo: string, home: string): ChildProcess {
			const writer = pathToFileURL(
				path.resolve("clients/lsp/crash-output.js"),
			).href;
			const source = `
import { writeSync } from "node:fs";
const { writeLspCrashStack } = await import(${JSON.stringify(writer)});
const error = new Error("PROBE full pipe");
error.stack = "fifo-crash-stack:" + "x".repeat(100 * 1024 * 1024);
writeSync(1, "WRITING\\n");
writeLspCrashStack(error);
writeSync(1, "RETURNED\\n");`;
			const stderrFd = fs.openSync(fifo, fs.constants.O_WRONLY);
			try {
				const child = spawn(
					process.execPath,
					["--input-type=module", "-e", source],
					{
						stdio: ["ignore", "pipe", stderrFd],
						env: { ...process.env, PI_LENS_HOME: home },
					},
				);
				children.push(child);
				return child;
			} finally {
				fs.closeSync(stderrFd);
			}
		}

		function settle(
			child: ChildProcess,
		): Promise<{ code: number | null; stdout: string }> {
			let stdout = "";
			child.stdout?.setEncoding("utf8");
			child.stdout?.on("data", (chunk: string) => (stdout += chunk));
			return new Promise((resolve, reject) => {
				child.once("error", reject);
				child.once("close", (code) => resolve({ code, stdout }));
			});
		}

		// The reviewer's F1 probe: before the bound, writeSync blocked on the
		// full pipe and the dying host never reached process.exit.
		it("returns within its deadline when stderr is a full pipe nobody reads", async () => {
			const { fifo, readFd, home } = fullFifo();
			try {
				const result = await settle(writeReportInto(fifo, home));
				expect(result).toEqual({ code: 0, stdout: "WRITING\nRETURNED\n" });
			} finally {
				fs.closeSync(readFd);
			}
		}, 20_000);

		// The slow-reader row: the report waits for a reader that starts only
		// after the writer met the full pipe, and arrives whole, capped.
		it("delivers the capped report to a reader that drains a full pipe late", async () => {
			const { fifo, readFd, home, filled } = fullFifo();
			const child = writeReportInto(fifo, home);
			const outcome = settle(child);
			await new Promise<void>((resolve) =>
				child.stdout?.once("data", () => resolve()),
			);
			// The reader starts well after the writer met the full pipe, and
			// well inside its 1 s deadline: a writer that gave up at its first
			// EAGAIN has delivered nothing by then.
			await new Promise((resolve) => setTimeout(resolve, LATE_READER_MS));
			const reader = new net.Socket({
				fd: readFd,
				readable: true,
				writable: false,
			});
			const chunks: Buffer[] = [];
			reader.on("data", (chunk: Buffer) => chunks.push(chunk));
			const drained = new Promise<void>((resolve) =>
				reader.once("close", () => resolve()),
			);
			const result = await outcome;
			await drained;
			const report = Buffer.concat(chunks).subarray(filled).toString("utf8");
			expect(result).toEqual({ code: 0, stdout: "WRITING\nRETURNED\n" });
			expect(report.startsWith("fifo-crash-stack:")).toBe(true);
			expect(report.endsWith(TRUNCATION_LINE)).toBe(true);
		}, 20_000);
	},
);
