/**
 * The LSP crash guard's last-resort crash report.
 *
 * This is intentionally the only raw terminal writer in the LSP client path:
 * a sole process-level crash handler must preserve Node's stack report before
 * terminating through process.exit so the host still gets an actionable
 * failure. The extension terminal-silence sweep admits this file explicitly.
 */
export function writeLspCrashStack(failure: unknown): void {
	process.stderr.write(`${failure}\n`);
}
