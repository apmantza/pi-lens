/**
 * Effect-TS Service Infrastructure for pi-lens
 * 
 * Simplified implementation focusing on:
 * - Concurrent runner execution
 * - Timeout handling
 * - Error recovery
 * 
 * Reference: https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/lsp/index.ts
 */

import { Effect } from "effect";

// --- Error Types ---

export class RunnerError {
	readonly _tag = "RunnerError";
	constructor(
		readonly runnerId: string,
		readonly cause: unknown,
	) {}
}

export class TimeoutError {
	readonly _tag = "TimeoutError";
	constructor(
		readonly operation: string,
		readonly timeoutMs: number,
	) {}
}

// --- Result Types ---

export interface RunnerResult {
	diagnostics: Array<{
		id: string;
		message: string;
		severity: "error" | "warning" | "info" | "hint";
	}>;
	durationMs: number;
	error?: string;
}

export interface ConcurrentRunnerResult {
	runnerId: string;
	status: "success" | "failure" | "skipped";
	diagnostics: Array<{
		id: string;
		message: string;
		severity: "error" | "warning" | "info" | "hint";
	}>;
	durationMs: number;
	error?: string;
}

// --- Concurrent Execution Helper ---

/**
 * Run multiple runners concurrently with Effect
 * 
 * Features:
 * - Parallel execution with Effect.all
 * - Per-runner timeout handling
 * - Graceful error recovery (individual failures don't stop others)
 * - Automatic resource cleanup
 */
export function runRunnersConcurrent(
	filePath: string,
	runnerIds: string[],
	runSingle: (filePath: string, runnerId: string) => Promise<RunnerResult>,
	timeoutMs = 30_000
): Effect.Effect<ConcurrentRunnerResult[], never, never> {
	return Effect.gen(function* () {
		const startTime = Date.now();

		// Run all runners in parallel
		const results = yield* Effect.all(
			runnerIds.map((runnerId) =>
				Effect.gen(function* () {
					const runnerStart = Date.now();

					// Execute with timeout and error handling
					const result = yield* Effect.tryPromise({
						try: () => runSingle(filePath, runnerId),
						catch: (err) => err,
					}).pipe(
						Effect.timeout(timeoutMs),
						Effect.catchAll((err) =>
							Effect.succeed({
								diagnostics: [],
								durationMs: Date.now() - runnerStart,
								error: String(err),
							})
						)
					);

					const isError = "error" in result;

					return {
						runnerId,
						status: isError ? "failure" as const : "success" as const,
						diagnostics: isError ? [] : result.diagnostics,
						durationMs: isError ? result.durationMs : result.durationMs,
						error: isError ? result.error : undefined,
					};
				})
			),
			{ concurrency: "unbounded" }
		);

		return results;
	});
}

/**
 * Run a single runner with timeout and error handling
 */
export function runRunnerWithTimeout(
	filePath: string,
	runnerId: string,
	runSingle: (filePath: string, runnerId: string) => Promise<RunnerResult>,
	timeoutMs = 30_000
): Effect.Effect<RunnerResult, RunnerError | TimeoutError, never> {
	return Effect.gen(function* () {
		const startTime = Date.now();

		const result = yield* Effect.tryPromise({
			try: () => runSingle(filePath, runnerId),
			catch: (err) => new RunnerError(runnerId, err),
		}).pipe(
			Effect.timeout(timeoutMs),
			Effect.mapError((err) => {
				if (err instanceof RunnerError) return err;
				return new TimeoutError(`runner:${runnerId}`, timeoutMs);
			})
		);

		return {
			diagnostics: result.diagnostics,
			durationMs: Date.now() - startTime,
		};
	});
}

// --- Execution Helpers ---

/**
 * Execute Effect and get result
 */
export function executeEffect<T>(
	effect: Effect.Effect<T, never, never>
): Promise<T> {
	return Effect.runPromise(effect);
}

/**
 * Execute Effect with error handling
 */
export function executeEffectWithError<T, E>(
	effect: Effect.Effect<T, E, never>,
	onError: (err: E) => T
): Promise<T> {
	return Effect.runPromise(
		Effect.catchAll(effect, (err) => Effect.succeed(onError(err)))
	);
}

// --- Error Formatting ---

export function formatError(err: RunnerError | TimeoutError): string {
	switch (err._tag) {
		case "RunnerError":
			return `Runner ${err.runnerId} failed: ${err.cause}`;
		case "TimeoutError":
			return `Operation ${err.operation} timed out after ${err.timeoutMs}ms`;
		default:
			return "Unknown error";
	}
}
