import { writeSync } from "node:fs";
import { logExtension } from "../extension-log.js";

/** The most crash-report bytes written to stderr. A stack is a few KiB; a
 *  huge message keeps its head, so a slow terminal drains at most this. */
const CRASH_STACK_MAX_BYTES = 16 * 1024;
/** How long a dying host waits for a full stderr pipe to drain. */
const CRASH_WRITE_DEADLINE_MS = 1_000;
const CRASH_WRITE_RETRY_MS = 10;

/**
 * The LSP crash guard's last-resort crash report.
 *
 * This is intentionally the only raw terminal writer in the LSP client path:
 * a sole process-level crash handler must preserve Node's stack report before
 * terminating through process.exit so the host still gets an actionable
 * failure. The extension terminal-silence sweep admits this file explicitly.
 *
 * It must never hold the dying host (#5746 r4): it writes at most
 * {@link CRASH_STACK_MAX_BYTES}, and stops at EPIPE or once a full pipe has
 * not drained within {@link CRASH_WRITE_DEADLINE_MS}.
 */
export function writeLspCrashStack(failure: unknown): void {
	let text: string;
	try {
		text =
			failure instanceof Error
				? String(failure.stack ?? failure.message ?? failure.name)
				: String(failure);
	} catch {
		// none: the host is already terminating; preserve a bounded fallback
		text = "[lsp-crash] unprintable failure";
	}
	try {
		logExtension({
			subsystem: "lsp-crash",
			message: "crash guard terminating",
		});
	} catch {
		// none: the crash report must not depend on the log sink
		// The crash report must remain independent of the log sink.
	}
	try {
		// Reading process.stderr opens a pipe through libuv, which sets
		// O_NONBLOCK on fd 2: a full pipe then answers EAGAIN, which the
		// deadline bounds, instead of blocking writeSync forever. Node keeps a
		// TTY (and a Windows pipe) blocking; the byte cap bounds those.
		void process.stderr;
		const output = boundedReport(text);
		const deadline = Date.now() + CRASH_WRITE_DEADLINE_MS;
		let offset = 0;
		while (offset < output.byteLength) {
			let written: number;
			try {
				written = writeSync(2, output, offset, output.byteLength - offset);
			} catch (writeFailure) {
				// none: terminal stderr failure is non-recoverable
				const code = (writeFailure as NodeJS.ErrnoException).code;
				if (code !== "EAGAIN" && code !== "EWOULDBLOCK") break;
				if (Date.now() >= deadline) break;
				Atomics.wait(
					new Int32Array(new SharedArrayBuffer(4)),
					0,
					0,
					CRASH_WRITE_RETRY_MS,
				);
				continue;
			}
			if (written <= 0) break;
			offset += written;
		}
	} catch {
		// none: the host is already crashing; stderr failure cannot be surfaced
		// The host is already crashing; a closed stderr must not replace the
		// original failure with a second uncaught exception.
	}
}

/** The report's bytes: the whole text, or its first
 *  {@link CRASH_STACK_MAX_BYTES} bytes and a line saying it was cut. */
function boundedReport(text: string): Buffer {
	const head = Buffer.from(text.slice(0, CRASH_STACK_MAX_BYTES));
	if (
		text.length <= CRASH_STACK_MAX_BYTES &&
		head.byteLength <= CRASH_STACK_MAX_BYTES
	)
		return Buffer.from(`${text}\n`);
	return Buffer.concat([
		head.subarray(0, CRASH_STACK_MAX_BYTES),
		Buffer.from(
			`\n[lsp-crash] crash report truncated at ${CRASH_STACK_MAX_BYTES} bytes\n`,
		),
	]);
}
