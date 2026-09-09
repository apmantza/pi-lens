/**
 * Shared fault-injection primitives for tests (#1838).
 *
 * The highest-value findings of the 2026-08 window came from bespoke fault
 * probes reviewers built by hand, each once: a genuinely wedged child pipe
 * (#1811), a snapshot save racing inside a stall window (#1807), a budget
 * starved by CPU scheduling (#1785), a session reset fired from inside a
 * mocked spawn (#1746 R2-F1). Every one of those is the same primitive with a
 * different costume. This module is where they live from now on, so catalog
 * shapes 1/3/9 (latch re-arm, teardown liveness, session-straddling writes)
 * are cheap to probe in every fixer's red-first pass instead of
 * reviewer-only heroics.
 *
 * Composition: `suspendAt` (`tests/clients/interleaving-kit.ts`) parks a seam
 * INDEFINITELY until released; `delayInside` resolves it after a bounded
 * delay; `fireResetAt` lets it side-effect mid-flight. `gatedPromise` is the
 * building block all three are built from when a test needs direct control.
 *
 * Every primitive here carries its own fidelity test next door
 * (fault-injection.test.ts) — the #1673 lesson: an inert double is worse than
 * none, and a kit that quietly degrades into one must go red in CI, not in
 * review.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { onTestFinished, vi } from "vitest";

const FIXTURE_DIR = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../fixtures",
);

// ---------------------------------------------------------------------------
// gatedPromise — the shared building block
// ---------------------------------------------------------------------------

export interface GatedPromise<T> {
	promise: Promise<T>;
	/** Resolve the gate; subsequent calls are no-ops. */
	resolve: (value: T) => void;
	/** Reject the gate; subsequent calls are no-ops. */
	reject: (reason?: unknown) => void;
	/** True once resolve or reject has run. Never resets. */
	settled: () => boolean;
}

/**
 * An externally-resolvable promise with settled-state visibility.
 *
 * Use it to hold a seam open while some OTHER concurrent event must be proven
 * to happen first (a budget dying, a reset firing, a timer winning a race).
 */
export function gatedPromise<T>(): GatedPromise<T> {
	let settle!: (v: T) => void;
	let boom!: (r?: unknown) => void;
	let isSettled = false;
	const promise = new Promise<T>((res, rej) => {
		settle = res;
		boom = rej;
	});
	return {
		promise,
		resolve: (value: T) => {
			if (isSettled) return;
			isSettled = true;
			settle(value);
		},
		reject: (reason?: unknown) => {
			if (isSettled) return;
			isSettled = true;
			boom(reason);
		},
		settled: () => isSettled,
	};
}

// ---------------------------------------------------------------------------
// delayInside — deterministic completion delay for a mocked async seam
// ---------------------------------------------------------------------------

/**
 * Wrap an existing mocked async seam so every call resolves at least `ms`
 * later than it otherwise would, preserving the original implementation's
 * return value. Real timers — the guarantee is ordering (the caller's
 * continuation runs strictly after the delay), which `setTimeout` provides on
 * every OS; do not assert tight upper bounds against it under load (#1920).
 *
 * Mutates the mock in place; keep using the original seam reference:
 *
 * ```ts
 * delayInside(spawnMock, 25);
 * // spawnMock(...) now completes ≥25ms late, same return value.
 * ```
 *
 * For indefinite suspension until a test releases the seam, use
 * interleaving-kit's `suspendAt` instead.
 */
export function delayInside<T extends (...args: any[]) => Promise<unknown>>(
	mock: {
		mockImplementation(implementation: T): unknown;
		getMockImplementation(): T | undefined;
	},
	ms: number,
): void {
	const original = mock.getMockImplementation() as T | undefined;
	mock.mockImplementation((async (...args: Parameters<T>): Promise<unknown> => {
		await new Promise((resolve) => setTimeout(resolve, ms));
		return original ? original(...args) : undefined;
	}) as T);
}

// ---------------------------------------------------------------------------
// fireResetAt — fire a lifecycle hook from INSIDE a mocked seam
// ---------------------------------------------------------------------------

export interface FireResetAtOptions<
	T extends (...args: any[]) => Promise<unknown> = (
		...args: any[]
	) => Promise<unknown>,
> {
	/**
	 * Which call of the mock fires the hook (1-based). Calls before it never
	 * fire; calls after it proceed normally without firing again.
	 * Default 1.
	 */
	atCall?: number;
	/**
	 * Restrict firing to calls whose arguments match. Combined with
 `atCall`, the Nth MATCHING call fires. With a multi-purpose seam
	 * (one spawn mock serving version probes and updates), this targets the
	 * interesting call without hard-coding its positional index.
	 */
	when?: (...args: Parameters<T>) => boolean;
}

/**
 * Re-wire a mocked seam so `hook` fires from inside its implementation —
 * between the caller entering the await and the seam resolving — exactly once
 * at call `atCall`. This is the #1746-R2-F1 shape: a session start landing
 * while a 120s spawn is still running, generalized to any hook and any seam.
 *
 * The hook fires BEFORE the original implementation runs, so a test can prove
 * ordering: whatever state the hook re-arms must already hold when the seam's
 * own result is consumed.
 */
export function fireResetAt<T extends (...args: any[]) => Promise<unknown>>(
	mock: {
		mockImplementation(implementation: T): unknown;
		getMockImplementation(): T | undefined;
	},
	hook: () => void,
	options?: FireResetAtOptions<T>,
): void {
	const atCall = options?.atCall ?? 1;
	const matches = options?.when;
	const original = mock.getMockImplementation() as T | undefined;
	let call = 0;
	let fired = false;
	mock.mockImplementation((async (...args: Parameters<T>): Promise<unknown> => {
		if (matches && !matches(...args))
			return original ? original(...args) : undefined;
		call += 1;
		if (call === atCall && !fired) {
			fired = true;
			hook();
		}
		return original ? original(...args) : undefined;
	}) as T);
}

// ---------------------------------------------------------------------------
// starveBudget — the tiny-budget env pattern as one call
// ---------------------------------------------------------------------------

/**
 * Point an env-configured budget at a value small enough that any gated or
 * delayed work deterministically exceeds it. The #1785 repro pattern
 * (`PI_LENS_LSP_NOTIFY_BUDGET_MS=5` + a never-settling notify) reduced to its
 * env half; pair with `gatedPromise`/`delayInside` holding the guarded seam
 * open past the budget:
 *
 * ```ts
 * starveBudget("PI_LENS_SEQUENCE_READ_BUDGET_MS");
 * readLatestProjectSequenceAsyncMock.mockReturnValue(gate.promise); // never settles
 * ```
 *
 * Uses `vi.stubEnv`, so `vi.unstubAllEnvs()` restores the previous value.
 */
export function starveBudget(envVar: string, ms = 5): void {
	vi.stubEnv(envVar, String(ms));
}

// ---------------------------------------------------------------------------
// spawnWedgedChild — a REAL child whose stdin pipe is genuinely full
// ---------------------------------------------------------------------------

/** Comfortably past what #1811's probe measured as sufficient (~1-2MB) to exhaust an anonymous pipe's OS buffer on Windows and Linux CI. */
const DEFAULT_PADDING_MB = 12;

export interface WedgedChild {
	child: import("node:child_process").ChildProcess;
	pid: number | undefined;
	/**
	 * Fire ~`mb` megabytes of unawaited writes into the child's stdin so the
	 * OS pipe buffer is exhausted and SUBSEQUENT writes stop settling. The
	 * writes already queued never resolve either; that is what a wedge is.
	 */
	padStdin(mb?: number): void;
	/**
	 * Kill the child and wait for exit (or a generous timeout — a wedged
	 * child still dies to SIGKILL-class termination). Safe to call twice.
	 */
	kill(): Promise<void>;
}

/**
 * Spawn a real Node child that pauses its stdin immediately and stays alive
 * without draining (`tests/fixtures/wedged-stdin-child.mjs`). After
 * `padStdin()`, any further stdin write's callback stops firing entirely —
 * the genuine "peer not reading" failure mode that connection doubles can
 * only simulate.
 *
 * Fidelity contract (asserted in fault-injection.test.ts, and worth
 * re-asserting if you fork this): the wedge must make writes HANG, not fail
 * fast. A fixture whose keepalive is missing exits within milliseconds and
 * turns every later write into EPIPE/EOF — a fast rejection that makes the
 * consuming test pass for the wrong reason (#1811).
 */
export async function spawnWedgedChild(): Promise<WedgedChild> {
	const child = spawn(
		process.execPath,
		[path.join(FIXTURE_DIR, "wedged-stdin-child.mjs")],
		{ stdio: ["pipe", "ignore", "ignore"] },
	);
	// Writes into a dead child's pipe emit EPIPE asynchronously; swallow them
	// so cleanup-order races don't surface as unhandled 'error' events.
	child.stdin?.on("error", () => {});

	// #2436 class-sweep: `wedged-stdin-child.mjs` never reads stdin and never
	// exits on its own by design — the caller alone decides its lifetime via
	// `kill()`. A caller-owned `.kill()` that never runs (an assertion throws
	// first, the test times out) leaked exactly like the unrelated
	// fake-lsp-server.mjs orphan this issue fixed. Register a guaranteed
	// backstop kill through the held `child` handle (no spawned `taskkill` —
	// AGENTS.md's Windows teardown note) so a call site cannot reintroduce
	// that leak by omission; a caller's own explicit `kill()` still runs
	// first and this becomes a no-op once the process has already exited.
	onTestFinished(() => {
		if (child.exitCode !== null || child.signalCode !== null) return;
		try {
			child.kill();
		} catch {
			/* already gone */
		}
	});

	let exited: Promise<void> | undefined;
	const whenExited = (): Promise<void> => {
		exited ??= new Promise<void>((resolve) => {
			if (child.exitCode !== null || child.signalCode !== null) {
				resolve();
				return;
			}
			child.once("exit", () => resolve());
		});
		return exited;
	};

	return {
		child,
		pid: child.pid,
		padStdin(mb: number = DEFAULT_PADDING_MB) {
			const chunk = Buffer.alloc(1024 * 1024, 0x78);
			for (let i = 0; i < mb; i++) {
				// Deliberately unawaited — these writes never settle either.
				void child.stdin?.write(chunk);
			}
		},
		async kill() {
			if (child.exitCode !== null || child.signalCode !== null) return;
			child.kill();
			// A wedged-but-alive child dies promptly to SIGTERM; the timeout is
			// only a teardown failsafe so a broken fixture cannot hang the suite.
			await Promise.race([
				whenExited(),
				new Promise<void>((resolve) => setTimeout(resolve, 5000)),
			]);
		},
	};
}
// flake-shape: raw-timer-wait — fault injection must model real timer and child teardown timing; fake timers cannot reproduce the boundary
