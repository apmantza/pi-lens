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
		text = "[lsp-crash] unprintable failure";
	}
	try {
		logExtension({
			subsystem: "lsp-crash",
			message: "crash guard terminating",
		});
	} catch {
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
				const code = (writeFailure as NodeJS.ErrnoException).code;
				if (code === "EAGAIN" || code === "EWOULDBLOCK") continue;
				break;
			}
			if (written <= 0) break;
			offset += written;
		}
	} catch {
		// The host is already crashing; a closed stderr must not replace the
		// original failure with a second uncaught exception.
	}
}
