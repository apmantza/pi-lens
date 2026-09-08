// Type declarations for retry.mjs (untyped .mjs imported from .ts tests). #2613.

export type RetryAttemptResult<T> =
	| { ok: true; value: T }
	| { ok: false; reason: string; retryable?: boolean };

export type RetryResult<T> =
	| { ok: true; value: T; attempt: number }
	| { ok: false; reasons: string[] };

export function retryWithBackoff<T>(
	attemptFn: (attempt: number) => Promise<RetryAttemptResult<T>>,
	opts?: {
		attempts?: number;
		backoffMs?: number[];
		sleep?: (ms: number) => Promise<void>;
	},
): Promise<RetryResult<T>>;
