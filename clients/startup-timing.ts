import { performance } from "node:perf_hooks";
// #1434 S3d: import the constant from the side-effect-free module, not from
// `console-guard-install.ts` — that module installs the console guard as an
// import side effect, so importing it here (for a single constant, from a
// module measuring load time) would have silently installed the guard
// wherever this file is imported, including test-only measurement code that
// has no business flipping a global switch.
import { PI_LENS_EVAL_STARTED_MS } from "./eval-timestamp.js";
import type { LatencyEntry } from "./latency-logger.js";
import {
	getProcessSingleton,
	nextModuleEvaluationOrdinal,
} from "./process-singletons.js";

/**
 * Startup timing for pi-lens.
 *
 * `performance.now()` is measured relative to `performance.timeOrigin`, which
 * is the moment the host pi process started. Capturing it the instant pi-lens
 * has finished loading therefore yields the wall-clock cost of pi loading +
 * (under source mode) jiti-transpiling every pi-lens module before any of our
 * code runs. With the precompiled `dist/` (#182) that transpile cost is gone,
 * so this number is how we verify the startup win instead of guessing at it.
 */

/** "dist" when pi-lens loaded from compiled JS, "source" when jiti-transpiled. */
export const PI_LENS_LOADED_FROM: "dist" | "source" = import.meta.url.endsWith(
	".js",
)
	? "dist"
	: "source";

// `loadMs`/`loadedAtMs` deliberately stay at module scope: they measure THIS
// evaluation's own load cost, so a second evaluation must get its own numbers
// rather than adopt the first's (#2146 class sweep — per-evaluation by design).
let loadMs: number | undefined;
let loadedAtMs: number | undefined;

/**
 * The host-ready anchor is a once-PER-PROCESS latch, so it lives on the shared
 * process singleton (#2146). Left at module scope it was consumed once per
 * module evaluation, which meant a nine-evaluation process could emit the
 * "first session" host-ready delay nine times.
 */
const HOST_READY_ANCHOR_FAMILY = "startup-timing.host-ready-anchor";
const HOST_READY_ANCHOR_VERSION = 1;

function hostReadyAnchorState(): { consumed: boolean } {
	return getProcessSingleton(
		HOST_READY_ANCHOR_FAMILY,
		HOST_READY_ANCHOR_VERSION,
		() => ({ consumed: false }),
	);
}

/**
 * 1-based count of pi-lens module-graph evaluations in this process (#2146).
 *
 * Captured at module scope so it advances exactly once per evaluation, and
 * carried on `host_boot.metadata.evaluationOrdinal` so multi-evaluation hosts
 * are greppable in `latency.log`.
 */
export const PI_LENS_EVALUATION_ORDINAL = nextModuleEvaluationOrdinal();

/**
 * Record the load-complete time. Call once, as the first statement in the
 * extension entry's module body — by then every import has been evaluated, so
 * the full transpile/load cost has been paid. Idempotent: later calls return
 * the first captured value.
 */
export function markPiLensLoaded(): number {
	if (loadMs === undefined) {
		loadedAtMs = performance.now();
		loadMs = Math.round(loadedAtMs);
	}
	return loadMs;
}

/** Monotonic instant when pi-lens finished loading, for cross-hook spans. */
export function getPiLensLoadedAtMs(): number | undefined {
	return loadedAtMs;
}

/** Consume the process-lifetime first-session host-ready anchor exactly once. */
export function consumeHostReadyDelayAnchor(): boolean {
	const state = hostReadyAnchorState();
	if (state.consumed) return false;
	state.consumed = true;
	return true;
}

/** Test seam for the process-lifetime session-state registry probe boundary. */
export function resetHostReadyDelayAnchorForTests(): void {
	hostReadyAnchorState().consumed = false;
}

/** ms from pi process start to pi-lens load-complete, or undefined if unmarked. */
export function getPiLensLoadMs(): number | undefined {
	return loadMs;
}

/** ms from host process start until pi-lens evaluation began. */
export const PI_LENS_HOST_BOOT_MS = Math.round(PI_LENS_EVAL_STARTED_MS);

/** pi-lens module-graph evaluation time once markPiLensLoaded() has run. */
export function getPiLensEvalMs(): number | undefined {
	return loadMs === undefined
		? undefined
		: Math.max(0, loadMs - PI_LENS_HOST_BOOT_MS);
}

/**
 * Build the three startup latency records the extension entry emits at module
 * scope (`extension_loaded`, `host_boot`, `extension_eval`).
 *
 * A builder rather than three inline `logLatency` calls in `index.ts` so the
 * record CONTENT is testable: `logLatency` is a no-op under `PI_LENS_TEST_MODE`,
 * and `index.ts`'s module body cannot be re-run per assertion. `index.ts` maps
 * the returned records straight into `logLatency`, so this is the production
 * shape, not a parallel path.
 *
 * `host_boot` carries `evaluationOrdinal` (#2146): one `host_boot` line is one
 * module-graph evaluation, and the ordinal makes a multi-evaluation host
 * greppable instead of inferable by counting lines per pid.
 */
export function buildStartupTimingRecords(input: {
	loadMs: number;
	evalMs: number;
}): LatencyEntry[] {
	return [
		{
			type: "phase",
			filePath: "<pi-lens>",
			phase: "extension_loaded",
			// Milliseconds since process start (host_boot plus eval): an age (#5379).
			ageMs: input.loadMs,
			metadata: { loadedFrom: PI_LENS_LOADED_FROM },
		},
		{
			type: "phase",
			filePath: "<pi-lens>",
			phase: "host_boot",
			// Milliseconds since process start until evaluation began: an age (#5379).
			ageMs: PI_LENS_HOST_BOOT_MS,
			metadata: {
				loadedFrom: PI_LENS_LOADED_FROM,
				evaluationOrdinal: PI_LENS_EVALUATION_ORDINAL,
			},
		},
		{
			type: "phase",
			filePath: "<pi-lens>",
			phase: "extension_eval",
			durationMs: input.evalMs,
			metadata: { loadedFrom: PI_LENS_LOADED_FROM },
		},
	];
}
