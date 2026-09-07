/**
 * Publishes `pilens:format:queued`, `pilens:format:start`, and
 * `pilens:autofix:start` on pi's shared `pi.events` bus (#673, #684).
 *
 * Sibling to `clients/bus-publish.ts` (#482 `pilens:files:touched`) and
 * `clients/diagnostics-publish.ts` (#502 `pilens:diagnostics`) rather than a
 * new export crammed into either file: same emit plumbing shape and the same
 * `PI_LENS_BUS_PUBLISH` kill switch (`isBusPublishEnabled`, imported from
 * bus-publish.ts), but this producer owns its own emit-function singleton
 * (wired separately from index.ts, same as diagnostics-publish.ts does) since
 * it has nothing else in common with either sibling's module state.
 *
 * ## Motivation (#673)
 *
 * `pilens:files:touched` only fires AFTER deferred formatting has completed —
 * it tells a same-process listener what pi-lens just mutated, in the past
 * tense. #673 reported a concrete failure mode this leaves uncovered: another
 * in-process extension (a review/snapshot controller) derives an immutable
 * candidate tree from the live worktree mid-turn, unaware that pi-lens has a
 * file queued for deferred formatting that will still land — silently
 * invalidating the snapshot it just took. There was no bus signal for either
 * of the two moments that matter to that use case:
 *
 *   1. A file NEWLY entering the deferred-format pending queue
 *      (`pilens:format:queued` — one event per file, only on first queue
 *      entry; a file re-touched by a second edit before `agent_end` does NOT
 *      re-emit, to avoid event spam for repeated edits to the same file).
 *   2. The deferred-format phase actually starting at `agent_end`
 *      (`pilens:format:start` — one event per batch, only when there is at
 *      least one queued file to format).
 *
 * This is deliberately visibility-only: it lets a listener know pi-lens MIGHT
 * or IS ABOUT TO mutate specific files via deferred formatting, so it can
 * choose to wait, re-derive, or flag its own snapshot as provisional. It is
 * NOT a synchronous flush/barrier API (a caller cannot block deferred
 * formatting via these events) — that remains a separate, explicitly
 * out-of-scope future feature. Completion is already covered by the existing
 * `pilens:files:touched` (`reason: "format"`) event; these two do not
 * duplicate it.
 *
 * ## `pilens:autofix:start` (#684)
 *
 * Follow-up to #673/#674, applying the identical fix to a sibling race: the
 * `agent_end` actionable-warnings autofix batch (`clients/runtime-agent-end.ts`,
 * gated by `getFlag("lens-actionable-warning-autofix")`) also reads a cached
 * report and applies fixes as a batch well after the edit that produced the
 * warnings — same "runs later, unpredictably" shape as deferred formatting.
 * It only emitted `pilens:files:touched` (`reason: "autofix"`) AFTER the fact.
 * `pilens:autofix:start` fires once per batch, only when the cached
 * actionable-warnings report is fresh (`checkActionableWarningsReportFresh`)
 * AND has at least one autofix-eligible warning to act on — mirroring
 * `pilens:format:start`'s "only when there's genuine work" gate. Note: this is
 * distinct from `pipeline.ts`'s per-edit `runAutofix` (biome/ruff/eslint fixes
 * applied synchronously inside the `tool_result` hook, awaited before the
 * tool result returns) — that path isn't deferred and doesn't have this race,
 * so it doesn't get a `start` event.
 *
 * Versioning policy: frozen-additive per event, same discipline as #482/#502.
 * New optional fields may be added under the same `v: 1` for any of the three
 * events; a breaking change to an existing field's meaning must bump that
 * event's `v` independently (each event versions separately since they're
 * unrelated payloads). `FormatQueuedPayload.kinds` (S3d, #1432 review) is now
 * an always-present required field at `publishFormatQueued`'s call boundary —
 * both in-repo callers already passed it, so the `?? ["format"]` fallback
 * was fabricating data no caller asked for. This is NOT a `v` bump: `kinds`
 * was already part of the v1 payload shape and every wire-format consumer
 * still reads the same field; a v1 emitter built against an older copy of
 * this module that omits `kinds` at the call site now fails to compile
 * rather than silently emitting a guessed value, and any reader written
 * against v1 that still treats `kinds` as possibly-absent remains correct.
 *
 * Fire-and-forget: publishing must never affect the write path's or
 * `agent_end`'s success or latency. Any failure (bus unavailable, emit
 * throws) is swallowed; an optional `dbg` callback is invoked at most once
 * per event type on first failure so a wired caller can log it without
 * spamming.
 */
import { logBusEvent } from "./bus-events-logger.js";
import { isBusPublishEnabled } from "./bus-publish.js";
import { normalizeFilePath } from "./path-utils.js";
import {
	createLiveBusEmitter,
	recordStaleBusFailure,
	resolveLiveBusEmitter,
	type BusEmitFn,
	type BusEmitGetter,
} from "./live-bus-emitter.js";

export const BUS_FORMAT_QUEUED_EVENT = "pilens:format:queued";
export const BUS_FORMAT_QUEUED_VERSION = 1;

export const BUS_FORMAT_START_EVENT = "pilens:format:start";
export const BUS_FORMAT_START_VERSION = 1;

export const BUS_AUTOFIX_START_EVENT = "pilens:autofix:start";
export const BUS_AUTOFIX_START_VERSION = 1;

interface FormatQueuedPayload {
	v: typeof BUS_FORMAT_QUEUED_VERSION;
	source: "pi-lens";
	filePath: string;
	cwd: string;
	tool: "write" | "edit";
	kinds: Array<"autofix" | "format">;
}

interface FormatStartPayload {
	v: typeof BUS_FORMAT_START_VERSION;
	source: "pi-lens";
	cwd: string;
	paths: string[];
	fileCount: number;
	kinds: Array<"autofix" | "format">;
}

interface AutofixStartPayload {
	v: typeof BUS_AUTOFIX_START_VERSION;
	source: "pi-lens";
	cwd: string;
	paths: string[];
	fileCount: number;
	eligibleCount: number;
}

const liveEmitter = createLiveBusEmitter();
let hasLoggedQueuedFailure = false;
let hasLoggedQueuedUnwired = false;
let hasLoggedQueuedDisabled = false;
let hasLoggedStartFailure = false;
let hasLoggedStartUnwired = false;
let hasLoggedStartDisabled = false;
let hasLoggedAutofixStartFailure = false;
let hasLoggedAutofixStartUnwired = false;
let hasLoggedAutofixStartDisabled = false;

/**
 * Wire the emit function from pi's `pi.events` bus. Called once at extension
 * factory time from index.ts, alongside `wireBusEmitter` (#482) and
 * `wireDiagnosticsBusEmitter` (#502) — all three producers share the
 * identical `pi.events.emit` binding, wired separately per producer.
 */
export function wireFormatEventsBusEmitter(
	emitFn: BusEmitFn | undefined,
): void {
	liveEmitter.wire(emitFn);
}

export function wireFormatEventsBusEmitterGetter(
	getter: BusEmitGetter | undefined,
): void {
	liveEmitter.wireGetter(getter);
}

/** Test-only: reset module state between test files. */
export function _resetFormatEventsPublishForTests(): void {
	liveEmitter.reset();
	hasLoggedQueuedFailure = false;
	hasLoggedQueuedUnwired = false;
	hasLoggedQueuedDisabled = false;
	hasLoggedStartFailure = false;
	hasLoggedStartUnwired = false;
	hasLoggedStartDisabled = false;
	hasLoggedAutofixStartFailure = false;
	hasLoggedAutofixStartUnwired = false;
	hasLoggedAutofixStartDisabled = false;
}

export interface PublishFormatQueuedArgs {
	filePath: string;
	cwd: string;
	tool: "write" | "edit";
	// S3d (#1432 review): required, not `?? ["format"]` fabrication — both
	// in-repo call sites (clients/runtime-tool-result.ts) already know and
	// pass the real kind(s) being queued, so a silent "format" default would
	// only ever mask a caller that forgot to pass it.
	kinds: Array<"autofix" | "format">;
	dbg?: (msg: string) => void;
}

/**
 * Publish one `pilens:format:queued` event for a file newly entering the
 * deferred-format pending queue. Callers MUST only invoke this on the
 * NEW-entry branch of `RuntimeCoordinator.deferFormat` (not on a re-touch of
 * an already-queued file) — see `clients/runtime-tool-result.ts`'s call site.
 * Fire-and-forget: never throws, never awaited by the write path.
 */
export function publishFormatQueued(args: PublishFormatQueuedArgs): void {
	if (!isBusPublishEnabled()) {
		if (!hasLoggedQueuedDisabled) {
			hasLoggedQueuedDisabled = true;
			logBusEvent({
				event: BUS_FORMAT_QUEUED_EVENT,
				outcome: "skipped_disabled",
				cwd: normalizeFilePath(args.cwd),
			});
		}
		return;
	}
	const resolution = resolveLiveBusEmitter(liveEmitter, () => ({
		event: BUS_FORMAT_QUEUED_EVENT,
		cwd: normalizeFilePath(args.cwd),
	}));
	if (resolution.outcome === "stale-session") return;
	if (resolution.outcome === "unwired") {
		if (!hasLoggedQueuedUnwired) {
			hasLoggedQueuedUnwired = true;
			logBusEvent({
				event: BUS_FORMAT_QUEUED_EVENT,
				outcome: "skipped_unwired",
				cwd: normalizeFilePath(args.cwd),
			});
		}
		return;
	}
	const busEmit = resolution.emit;

	try {
		const payload: FormatQueuedPayload = {
			v: BUS_FORMAT_QUEUED_VERSION,
			source: "pi-lens",
			filePath: normalizeFilePath(args.filePath),
			cwd: normalizeFilePath(args.cwd),
			tool: args.tool,
			kinds: args.kinds,
		};
		busEmit(BUS_FORMAT_QUEUED_EVENT, payload);
		hasLoggedQueuedFailure = false;
		logBusEvent({
			event: BUS_FORMAT_QUEUED_EVENT,
			outcome: "emitted",
			cwd: payload.cwd,
			fileCount: 1,
		});
	} catch (err) {
		logBusEvent({
			event: BUS_FORMAT_QUEUED_EVENT,
			outcome: "emit_failed",
			cwd: normalizeFilePath(args.cwd),
			error: String(err),
			ctxSource: resolution.ctxSource,
		});
		if (!hasLoggedQueuedFailure) {
			hasLoggedQueuedFailure = true;
			recordStaleBusFailure(BUS_FORMAT_QUEUED_EVENT, err);
			args.dbg?.(
				`format-events-publish: pilens:format:queued emit failed (further failures suppressed): ${err}`,
			);
		}
	}
}

export interface PublishFormatStartArgs {
	cwd: string;
	paths: string[];
	kinds?: Array<"autofix" | "format">;
	dbg?: (msg: string) => void;
}

/**
 * Publish one `pilens:format:start` event when the `agent_end` deferred-
 * format phase begins. Callers MUST only invoke this when `paths.length > 0`
 * — see `clients/runtime-agent-end.ts`'s call site, placed at the same point
 * as the existing `agent_end_deferred_format_start` latency-log phase so both
 * signals represent the identical moment. Fire-and-forget: never throws,
 * never awaited by `agent_end`.
 */
export function publishFormatStart(args: PublishFormatStartArgs): void {
	if (args.paths.length === 0) return;
	if (!isBusPublishEnabled()) {
		if (!hasLoggedStartDisabled) {
			hasLoggedStartDisabled = true;
			logBusEvent({
				event: BUS_FORMAT_START_EVENT,
				outcome: "skipped_disabled",
				cwd: normalizeFilePath(args.cwd),
			});
		}
		return;
	}
	const resolution = resolveLiveBusEmitter(liveEmitter, () => ({
		event: BUS_FORMAT_START_EVENT,
		cwd: normalizeFilePath(args.cwd),
	}));
	if (resolution.outcome === "stale-session") return;
	if (resolution.outcome === "unwired") {
		if (!hasLoggedStartUnwired) {
			hasLoggedStartUnwired = true;
			logBusEvent({
				event: BUS_FORMAT_START_EVENT,
				outcome: "skipped_unwired",
				cwd: normalizeFilePath(args.cwd),
			});
		}
		return;
	}
	const busEmit = resolution.emit;

	try {
		const paths = args.paths.map((p) => normalizeFilePath(p));
		const payload: FormatStartPayload = {
			v: BUS_FORMAT_START_VERSION,
			source: "pi-lens",
			cwd: normalizeFilePath(args.cwd),
			paths,
			fileCount: paths.length,
			kinds: args.kinds ?? ["format"],
		};
		busEmit(BUS_FORMAT_START_EVENT, payload);
		hasLoggedStartFailure = false;
		logBusEvent({
			event: BUS_FORMAT_START_EVENT,
			outcome: "emitted",
			cwd: payload.cwd,
			fileCount: payload.fileCount,
		});
	} catch (err) {
		logBusEvent({
			event: BUS_FORMAT_START_EVENT,
			outcome: "emit_failed",
			cwd: normalizeFilePath(args.cwd),
			error: String(err),
			ctxSource: resolution.ctxSource,
		});
		if (!hasLoggedStartFailure) {
			hasLoggedStartFailure = true;
			recordStaleBusFailure(BUS_FORMAT_START_EVENT, err);
			args.dbg?.(
				`format-events-publish: pilens:format:start emit failed (further failures suppressed): ${err}`,
			);
		}
	}
}

export interface PublishAutofixStartArgs {
	cwd: string;
	paths: string[];
	eligibleCount: number;
	dbg?: (msg: string) => void;
}

/**
 * Publish one `pilens:autofix:start` event when the `agent_end`
 * actionable-warnings autofix batch begins (#684). Callers MUST only invoke
 * this when `paths.length > 0` — i.e. after the cached report has been
 * confirmed fresh (`checkActionableWarningsReportFresh`) AND has at least one
 * autofix-eligible warning to act on, the same "genuine work" gate
 * `publishFormatStart` applies for deferred formatting — see
 * `clients/runtime-agent-end.ts`'s call site, placed immediately before
 * `applyConservativeActionableWarningFixes` is invoked. Fire-and-forget:
 * never throws, never awaited by `agent_end`.
 */
export function publishAutofixStart(args: PublishAutofixStartArgs): void {
	if (args.paths.length === 0) return;
	if (!isBusPublishEnabled()) {
		if (!hasLoggedAutofixStartDisabled) {
			hasLoggedAutofixStartDisabled = true;
			logBusEvent({
				event: BUS_AUTOFIX_START_EVENT,
				outcome: "skipped_disabled",
				cwd: normalizeFilePath(args.cwd),
			});
		}
		return;
	}
	const resolution = resolveLiveBusEmitter(liveEmitter, () => ({
		event: BUS_AUTOFIX_START_EVENT,
		cwd: normalizeFilePath(args.cwd),
	}));
	if (resolution.outcome === "stale-session") return;
	if (resolution.outcome === "unwired") {
		if (!hasLoggedAutofixStartUnwired) {
			hasLoggedAutofixStartUnwired = true;
			logBusEvent({
				event: BUS_AUTOFIX_START_EVENT,
				outcome: "skipped_unwired",
				cwd: normalizeFilePath(args.cwd),
			});
		}
		return;
	}
	const busEmit = resolution.emit;

	try {
		const paths = args.paths.map((p) => normalizeFilePath(p));
		const payload: AutofixStartPayload = {
			v: BUS_AUTOFIX_START_VERSION,
			source: "pi-lens",
			cwd: normalizeFilePath(args.cwd),
			paths,
			fileCount: paths.length,
			eligibleCount: args.eligibleCount,
		};
		busEmit(BUS_AUTOFIX_START_EVENT, payload);
		hasLoggedAutofixStartFailure = false;
		logBusEvent({
			event: BUS_AUTOFIX_START_EVENT,
			outcome: "emitted",
			cwd: payload.cwd,
			fileCount: payload.fileCount,
		});
	} catch (err) {
		logBusEvent({
			event: BUS_AUTOFIX_START_EVENT,
			outcome: "emit_failed",
			cwd: normalizeFilePath(args.cwd),
			error: String(err),
			ctxSource: resolution.ctxSource,
		});
		if (!hasLoggedAutofixStartFailure) {
			hasLoggedAutofixStartFailure = true;
			recordStaleBusFailure(BUS_AUTOFIX_START_EVENT, err);
			args.dbg?.(
				`format-events-publish: pilens:autofix:start emit failed (further failures suppressed): ${err}`,
			);
		}
	}
}
