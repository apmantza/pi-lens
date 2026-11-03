const timeoutBrand = Symbol.for("pi-lens.LspRequestTimeoutError");

/** A bounded LSP request deadline is distinct from an empty server answer. */
export class LspRequestTimeoutError extends Error {
	readonly [timeoutBrand] = true;
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

/** Recognize timeouts carried by the process-shared service across evaluations. */
export function isLspRequestTimeoutError(
	err: unknown,
): err is LspRequestTimeoutError {
	return (
		(err as LspRequestTimeoutError | null | undefined)?.[timeoutBrand] === true
	);
}
