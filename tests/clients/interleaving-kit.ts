/** Small, deterministic coordination helpers for concurrency tests. */

import { inspect } from "node:util";

type SpyLike<T extends (...args: any[]) => any> = {
	mockImplementation(implementation: T): unknown;
	mockRestore(): void;
};

export type Suspension = {
	admitted: Promise<void>;
	completed: Promise<void>;
	release: () => void;
	restore: () => void;
};

export type WaitForOptions = {
	timeoutMs?: number;
	intervalMs?: number;
	yieldControl?: () => Promise<void>;
};

/**
 * The wall-budget multiplier CI sets on a loaded runner (#4437). Parsed like
 * `tests/clients/bounded-pid-file-lock.test.ts` and `tests/mcp/harness.ts`;
 * read per call so a probe can stub the env.
 */
function testTimeoutScale(): number {
	const parsed = Number(process.env.PI_LENS_TEST_TIMEOUT_SCALE ?? "1");
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function budgetNote(budgetMs: number, unscaledMs: number, scale: number) {
	return `budget ${budgetMs}ms = ${unscaledMs}ms x PI_LENS_TEST_TIMEOUT_SCALE ${scale}`;
}

/** The first stack frame outside this file, as `path:line:col`. */
function callerFrame(): string {
	const frames = (new Error().stack ?? "").split("\n").slice(1);
	for (const frame of frames) {
		const location = /\(?([^\s()]+:\d+:\d+)\)?$/.exec(frame.trim())?.[1];
		if (location && !/interleaving-kit\.[jt]s:/.test(location)) {
			return location.replace(/^file:\/\//, "");
		}
	}
	return "an unknown caller";
}

/**
 * Poll until a condition is ready, bounded by wall time.
 *
 * `timeoutMs` (the default, or a caller's) is multiplied by
 * `PI_LENS_TEST_TIMEOUT_SCALE`, so the budget is a backstop that a slow runner
 * can stretch. An exhausted wait names its caller and the elapsed time.
 *
 * The default timer yield is safe for progress made by another thread or
 * process. A custom tick yield (for example `setImmediate`) is only safe when
 * the condition is guaranteed to advance on this event loop; never use one to
 * wait for worker-thread or child-process progress.
 */
export async function waitFor<T>(
	read: () => T,
	ready: (value: T) => boolean,
	{
		timeoutMs = 10_000,
		intervalMs = 10,
		yieldControl = () => delay(intervalMs),
	}: WaitForOptions = {},
): Promise<T> {
	const caller = callerFrame();
	const scale = testTimeoutScale();
	const budgetMs = timeoutMs * scale;
	const started = Date.now();
	const deadline = started + budgetMs;
	let value = read();
	while (!ready(value) && Date.now() < deadline) {
		await yieldControl();
		value = read();
	}
	if (ready(value)) return value;
	throw new Error(
		`waitFor exhausted after ${Date.now() - started}ms at ${caller} (${budgetNote(budgetMs, timeoutMs, scale)}); last observed value: ${inspect(value, { depth: 4 })}`,
	);
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Park calls entering a mocked seam until release is called.
 *
 * `admitted` resolves after the first call has reached the seam. Additional
 * calls remain blocked on the same release, which makes the helper useful for
 * both one yield point and a group of concurrent writers.
 */
export function suspendAt<T extends (...args: any[]) => any>(
	seamSpy: SpyLike<T>,
	implementation?: T,
	options: { calls?: number; admissionTimeoutMs?: number } = {},
): Suspension {
	let admit!: () => void;
	let rejectAdmission!: (error: Error) => void;
	let complete!: () => void;
	let unblock!: () => void;
	const admitted = new Promise<void>((resolve, reject) => {
		admit = resolve;
		rejectAdmission = reject;
	});
	const completed = new Promise<void>((resolve) => {
		complete = resolve;
	});
	const released = new Promise<void>((resolve) => {
		unblock = resolve;
	});
	const admissionTimeoutMs = options.admissionTimeoutMs ?? 10_000;
	const scale = testTimeoutScale();
	const budgetMs = admissionTimeoutMs * scale;
	const caller = callerFrame();
	const started = Date.now();
	const admissionTimer = setTimeout(() => {
		rejectAdmission(
			new Error(
				`suspendAt seam was not admitted within ${budgetMs}ms at ${caller} (elapsed ${Date.now() - started}ms; ${budgetNote(budgetMs, admissionTimeoutMs, scale)})`,
			),
		);
	}, budgetMs);
	let first = true;
	let calls = 0;

	seamSpy.mockImplementation((async (...args: Parameters<T>) => {
		if (first) {
			first = false;
			clearTimeout(admissionTimer);
			admit();
		}
		calls++;
		const callNumber = calls;
		if (callNumber <= (options.calls ?? Number.POSITIVE_INFINITY))
			await released;
		try {
			return implementation ? await implementation(...args) : undefined;
		} finally {
			if (callNumber === 1) complete();
		}
	}) as T);

	return {
		admitted,
		completed,
		release: unblock,
		restore: () => {
			clearTimeout(admissionTimer);
			unblock();
			seamSpy.mockRestore();
		},
	};
}
