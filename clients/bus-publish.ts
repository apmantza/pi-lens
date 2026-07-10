/**
 * Publishes `pilens:files:touched` on pi's shared `pi.events` bus (#482).
 *
 * This is pi-lens's FIRST `pi.events` broadcast surface: it exists so other
 * extensions in the same session can observe files pi-lens writes
 * autonomously (autofix/format runners) without reverse-engineering us —
 * writes the agent makes itself via its own tool calls are NOT ours to
 * broadcast; the host already knows about those (see the seam audit in
 * AGENTS.md / issue #482).
 *
 * Versioning policy: the payload is frozen-additive. New optional fields may
 * be added under the same `v: 1`; a breaking/incompatible change to an
 * existing field's meaning must bump `v`.
 *
 * Fire-and-forget: publishing must never affect the write path's success or
 * latency. Any failure (bus unavailable, emit throws) is swallowed; a `dbg`
 * callback is invoked at most once on first failure so a wired caller can log
 * it without spamming.
 */
import { normalizeFilePath } from "./path-utils.js";

export const BUS_FILES_TOUCHED_EVENT = "pilens:files:touched";
export const BUS_FILES_TOUCHED_VERSION = 1;

export type FilesTouchedReason = "autofix" | "format";

export interface FilesTouchedPayload {
	v: typeof BUS_FILES_TOUCHED_VERSION;
	source: "pi-lens";
	reason: FilesTouchedReason;
	paths: string[];
	cwd: string;
}

type BusEmitFn = (channel: string, data: unknown) => void;

let busEmit: BusEmitFn | undefined;
let hasLoggedFailure = false;

/**
 * Wire the emit function from pi's `pi.events` bus. Called once at extension
 * factory time from index.ts (module-level singleton, same pattern as
 * `initLensEvents`). Never called ⇒ `publishFilesTouched` no-ops, which is
 * exactly the state unit tests and the MCP server path run in (no pi host,
 * no `pi.events`).
 */
export function wireBusEmitter(emitFn: BusEmitFn | undefined): void {
	busEmit = emitFn;
}

/** Test-only: reset module state between test files. */
export function _resetForTests(): void {
	busEmit = undefined;
	hasLoggedFailure = false;
	_envCache = undefined;
}

let _envCache: boolean | undefined;

/**
 * Lazy env read (house style) so tests can flip `PI_LENS_BUS_PUBLISH` at
 * runtime via `_resetForTests` + re-set the env var. Kill switch: set to `0`
 * to disable publishing outright.
 */
export function isBusPublishEnabled(): boolean {
	if (_envCache === undefined) {
		_envCache = process.env.PI_LENS_BUS_PUBLISH !== "0";
	}
	return _envCache;
}

export interface PublishFilesTouchedArgs {
	reason: FilesTouchedReason;
	paths: string[];
	cwd: string;
	/**
	 * Loop guard: set when the write being reported was itself triggered by
	 * an INGESTED bus event (something pi-lens consumed from `pi.events`).
	 * pi-lens does not consume any events today (see #482 non-goals), so this
	 * is always false in practice — the flag exists so a future consumer
	 * can't accidentally wire a publish -> react -> publish cycle. When true,
	 * this is a structural no-op regardless of the kill switch or wiring.
	 */
	origin?: "bus";
	dbg?: (msg: string) => void;
}

/**
 * Publish one `pilens:files:touched` event for a logical write batch (one
 * event per call site invocation, not per file). Fire-and-forget: never
 * throws, never awaited by the caller's write path.
 */
export function publishFilesTouched(args: PublishFilesTouchedArgs): void {
	if (args.origin === "bus") return;
	if (args.paths.length === 0) return;
	if (!isBusPublishEnabled()) return;
	if (!busEmit) return;

	try {
		const payload: FilesTouchedPayload = {
			v: BUS_FILES_TOUCHED_VERSION,
			source: "pi-lens",
			reason: args.reason,
			paths: args.paths.map((p) => normalizeFilePath(p)),
			cwd: normalizeFilePath(args.cwd),
		};
		busEmit(BUS_FILES_TOUCHED_EVENT, payload);
	} catch (err) {
		if (!hasLoggedFailure) {
			hasLoggedFailure = true;
			args.dbg?.(
				`bus-publish: pilens:files:touched emit failed (further failures suppressed): ${err}`,
			);
		}
	}
}
