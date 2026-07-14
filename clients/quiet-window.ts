/**
 * Quiet-window scheduler for pi 0.80.6's `agent_settled` extension event (#483).
 *
 * `agent_settled` fires after the SDK's `_runAgentPrompt` finally-block sets
 * `_isAgentRunActive = false` — i.e. once the whole agent run (including any
 * auto-retry/continue loop) is fully done, on BOTH normal completion and
 * aborts/errors (it lives in a `finally`, not a success-only branch). It
 * fires strictly after `agent_end`/`turn_end` for that run. Unlike
 * `turn_end` — which fires while the next turn may already be looming and
 * therefore bounds its cascade-settle wait tightly — `agent_settled` is a
 * genuine idle window: nothing else is queued behind it until the user
 * types again. That makes it the right home for expensive, deferrable work
 * that would otherwise contend with live per-edit traffic.
 *
 * Feature detection: the SDK's extension registration (`pi.on(event, fn)`)
 * pushes onto a plain `Map<string, handler[]>` keyed by the literal event
 * string, with no allowlist or validation — registering an unknown event
 * name is a silent no-op on older hosts (the emit side only look up
 * handlers for events it actually emits). Registration therefore can't
 * throw; we still wrap it in try/catch defensively, and every task run
 * through this scheduler is independently isolated so a host that never
 * fires the event simply never executes them.
 *
 * The SDK awaits each registered handler in sequence
 * (`core/extensions/runner.js` `emit()`), and that `emit()` call is itself
 * awaited inside `_emitAgentSettled()`, which is awaited inside
 * `_runAgentPrompt`'s `finally`. A slow handler would therefore delay
 * `_runAgentPrompt` returning — so the handler registered here must not
 * await the task chain; it kicks the chain off unawaited (fire-and-forget)
 * and returns immediately.
 */

import {
	type HeartbeatPatch,
	readInstanceRegistry,
	updateHeartbeat,
} from "./instance-registry.js";
import { logLatency } from "./latency-logger.js";
import { sampleProcesses } from "./resource-sampler.js";
import type { RuntimeCoordinator } from "./runtime-coordinator.js";
import { toPositiveFinite } from "./env-utils.js";

export interface QuietWindowTaskResult {
	name: string;
	durationMs: number;
	ok: boolean;
}

export type QuietWindowTask = () => Promise<void> | void;

interface RegisteredTask {
	name: string;
	fn: QuietWindowTask;
}

// Module-level registry so future work (#458 Tier-3 reconcile, #236
// enrichment) can plug into the same scheduler without touching it.
const _tasks: RegisteredTask[] = [];

/**
 * Register a task to run sequentially during the quiet window. Each task is
 * isolated in its own try/catch — one throwing never prevents the rest from
 * running, and no failure propagates out of `runQuietWindow`.
 */
export function registerQuietWindowTask(
	name: string,
	fn: QuietWindowTask,
): void {
	_tasks.push({ name, fn });
}

/** Test-only: clear the task registry between test files/cases. */
export function _resetQuietWindowTasksForTests(): void {
	_tasks.length = 0;
}

// --- Kill switch (lazy, memoized — house style per clients/runtime-config.ts) ---

let _enabledCache: boolean | undefined;

/** `PI_LENS_QUIET_WINDOW=0` disables the whole scheduler (no-op, no logging). */
export function isQuietWindowEnabled(): boolean {
	if (_enabledCache !== undefined) return _enabledCache;
	_enabledCache = process.env.PI_LENS_QUIET_WINDOW !== "0";
	return _enabledCache;
}

/** Test-only: clear the memoized kill-switch read. */
export function _resetQuietWindowEnabledForTests(): void {
	_enabledCache = undefined;
}

const DEFAULT_QUIET_WINDOW_WAIT_MS = 15_000;

/**
 * Bounded wait for the quiet-window's own settle attempts (currently just
 * the carried-over cascade drain). Lazy env read, `Number.isFinite`-guarded
 * so a malformed value falls back to the default instead of poisoning
 * `Math.max`/`setTimeout` with `NaN` (see PR #109).
 */
export function quietWindowWaitMs(): number {
	const raw = toPositiveFinite(process.env.PI_LENS_QUIET_WINDOW_WAIT_MS);
	return raw > 0 ? raw : DEFAULT_QUIET_WINDOW_WAIT_MS;
}

// Re-entrancy guard: agent_settled can fire multiple times per session
// (once per completed/aborted run). If a previous quiet-window run is still
// in flight when the next fires, skip rather than queue/overlap.
let _inProgress = false;

export interface QuietWindowDeps {
	runtime: RuntimeCoordinator;
	dbg: (msg: string) => void;
	cwd?: string;
}

/**
 * Run every registered quiet-window task sequentially, logging a
 * `quiet_window` phase to the latency log. Never throws — every task
 * failure is swallowed and logged; callers should invoke this
 * fire-and-forget (do not await inside an SDK-awaited event handler).
 */
export async function runQuietWindow(deps: QuietWindowDeps): Promise<void> {
	// `runtime` is accepted for API symmetry with turn_end's deps shape and
	// for future built-in tasks that may need it directly; today's built-ins
	// close over `getRuntime` via registerBuiltinQuietWindowTasks instead.
	const { dbg, cwd } = deps;

	if (!isQuietWindowEnabled()) {
		logLatency({
			type: "phase",
			filePath: cwd ?? "<pi-lens>",
			phase: "quiet_window",
			durationMs: 0,
			metadata: { skipped: "disabled" },
		});
		return;
	}

	if (_inProgress) {
		dbg("quiet_window: skipping — a previous run is still in progress");
		logLatency({
			type: "phase",
			filePath: cwd ?? "<pi-lens>",
			phase: "quiet_window",
			durationMs: 0,
			metadata: { skipped: "in-progress" },
		});
		return;
	}

	_inProgress = true;
	const totalStart = Date.now();
	const results: QuietWindowTaskResult[] = [];
	try {
		for (const task of _tasks) {
			const taskStart = Date.now();
			let ok = true;
			try {
				await task.fn();
			} catch (err) {
				ok = false;
				dbg(`quiet_window: task "${task.name}" failed: ${err}`);
			}
			results.push({
				name: task.name,
				durationMs: Date.now() - taskStart,
				ok,
			});
		}
	} finally {
		_inProgress = false;
		logLatency({
			type: "phase",
			filePath: cwd ?? "<pi-lens>",
			phase: "quiet_window",
			durationMs: Date.now() - totalStart,
			metadata: { tasks: results },
		});
	}
}

/**
 * Register the two built-in quiet-window tasks (#483):
 *   1. carried-over cascade settle — a second, more generous attempt at
 *      draining cascade computes still pending after the turn_end cap
 *      (the #450 carry-over set in RuntimeCoordinator).
 *   2. instance-registry heartbeat refresh (#449) — off the turn hot path.
 *
 * Idempotent guard via a module flag so repeated calls (e.g. multiple
 * extension activations in tests) don't double-register.
 */
let _builtinsRegistered = false;

export function registerBuiltinQuietWindowTasks(
	getRuntime: () => RuntimeCoordinator,
): void {
	if (_builtinsRegistered) return;
	_builtinsRegistered = true;

	registerQuietWindowTask("cascade_carry_over_settle", async () => {
		const runtime = getRuntime();
		await runtime.settleCascadeRuns(quietWindowWaitMs());
	});

	registerQuietWindowTask("instance_registry_heartbeat", async () => {
		await updateHeartbeat(await buildHeartbeatResourcePatchBounded());
	});
}

/**
 * #620 sampling can never take longer than this to answer — on Windows it
 * shells out to PowerShell/CIM (via `pidusage`), which is normally fast but
 * has no hard upper bound the way an in-process computation would. Per this
 * repo's "async work needs both bounds" convention (a bulk/background step
 * needs a timeout, not just a happy-path await), a slow/hung sample must
 * still let the quiet-window task — and, transitively, the caller awaiting
 * `runQuietWindow` — return promptly rather than block on it indefinitely.
 */
const HEARTBEAT_SAMPLE_TIMEOUT_MS = 2000;

/** Race `buildHeartbeatResourcePatch` against `HEARTBEAT_SAMPLE_TIMEOUT_MS`;
 *  a timeout resolves to `{}` (same "leave everything untouched" semantics as
 *  any other sampling failure — see the module docstring below). */
async function buildHeartbeatResourcePatchBounded(): Promise<HeartbeatPatch> {
	return Promise.race([
		buildHeartbeatResourcePatch(),
		new Promise<HeartbeatPatch>((resolve) =>
			setTimeout(() => resolve({}), HEARTBEAT_SAMPLE_TIMEOUT_MS),
		),
	]);
}

/**
 * #620: sample this process's host CPU% plus every currently-recorded LSP
 * child's CPU%/RSS, once per heartbeat tick, and shape it into the patch
 * `updateHeartbeat` expects. Lives here (not clients/instance-registry.ts)
 * to keep that module a pure data store with no `pidusage` dependency of its
 * own — this is the one call site that knows both "what's the heartbeat
 * cadence" (quiet-window, off the turn hot path) and "what pids to sample"
 * (this process's own registry entry).
 *
 * Best-effort end to end: any failure (registry read, sampling) resolves to
 * `{}` — an empty patch leaves `updateHeartbeat` free to fall back to its own
 * `process.memoryUsage().rss` default and leaves cpu/child values untouched,
 * never zeroed.
 */
async function buildHeartbeatResourcePatch(): Promise<HeartbeatPatch> {
	try {
		const instances = await readInstanceRegistry();
		const self = instances.find((instance) => instance.pid === process.pid);
		const childPids = self?.lspChildren.map((child) => child.pid) ?? [];
		const usage = await sampleProcesses([process.pid, ...childPids]);

		const childUsage: Record<number, { rssBytes?: number; cpuPercent?: number }> = {};
		for (const pid of childPids) {
			const sample = usage.get(pid);
			if (sample) childUsage[pid] = sample;
		}

		return {
			cpuPercent: usage.get(process.pid)?.cpuPercent,
			childUsage,
		};
	} catch {
		return {};
	}
}

/** Test-only: undo registerBuiltinQuietWindowTasks' idempotency guard. */
export function _resetBuiltinQuietWindowRegistrationForTests(): void {
	_builtinsRegistered = false;
}
