/** A bounded LSP request deadline is distinct from an empty server answer. */
export class LspRequestTimeoutError extends Error {
	readonly method: string;
	readonly timeoutMs: number;
	readonly elapsedMs: number;

	constructor(method: string, timeoutMs: number, elapsedMs: number) {
		super(`LSP request timed out: ${method} after ${elapsedMs}ms`);
		this.name = "LspRequestTimeoutError";
		this.method = method;
		this.timeoutMs = timeoutMs;
		this.elapsedMs = elapsedMs;
	}
}
