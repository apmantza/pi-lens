import { writeSync } from "node:fs";
import { logExtension } from "../extension-log.js";

/**
 * The LSP crash guard's last-resort crash report.
 *
 * This is intentionally the only raw terminal writer in the LSP client path:
 * a sole process-level crash handler must preserve Node's stack report before
 * terminating through process.exit so the host still gets an actionable
 * failure. The extension terminal-silence sweep admits this file explicitly.
 */
export function writeLspCrashStack(failure: unknown): void {
	let text: string;
	try {
		if (failure instanceof Error) {
			text = failure.stack ?? failure.message ?? failure.name;
		} else {
			text = String(failure);
		}
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
		const output = Buffer.from(`${text}\n`);
		let offset = 0;
		while (offset < output.byteLength) {
			let written: number;
			try {
				written = writeSync(2, output, offset, output.byteLength - offset);
			} catch (writeFailure) {
				// none: terminal stderr failure is non-recoverable
				const code = (writeFailure as NodeJS.ErrnoException).code;
				if (code === "EAGAIN" || code === "EWOULDBLOCK") continue;
				break;
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
