/**
 * Publishes `pilens:format:queued`, `pilens:format:start`, `pilens:format:done`, and
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
 * out-of-scope future feature. `pilens:format:done` closes the pre/post pair
 * and carries an empty `paths` array when formatting ran but changed no bytes.
 * It is emitted after formatter-owned work settles, or as an explicit
 * `settled: false` terminal when the bounded formatter drain gives up.
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
import { isBusPublishEnabled } from "./bus-publish.js";
import { normalizeFilePath } from "./path-utils.js";
import {
	createBusPublisher,
	createLiveBusEmitter,
	type BusEmitFn,
	type BusEmitGetter,
} from "./live-bus-emitter.js";

export const BUS_FORMAT_QUEUED_EVENT = "pilens:format:queued";
export const BUS_FORMAT_QUEUED_VERSION = 1;

export const BUS_FORMAT_START_EVENT = "pilens:format:start";
export const BUS_FORMAT_START_VERSION = 1;

export const BUS_FORMAT_DONE_EVENT = "pilens:format:done";
export const BUS_FORMAT_DONE_VERSION = 1;

export const BUS_AUTOFIX_START_EVENT = "pilens:autofix:start";
export const BUS_AUTOFIX_START_VERSION = 1;

interface FormatQueuedPayload {
	v: typeof BUS_FORMAT_QUEUED_VERSION;
	source: "pi-lens";
	filePath: string;
	cwd: string;
	tool: "write" | "edit";
	kinds: Array<"autofix" | "format">;
	ownerSessionId?: string;
	turnIndex?: number;
	batchId?: string;
}

interface FormatStartPayload {
	v: typeof BUS_FORMAT_START_VERSION;
	source: "pi-lens";
	cwd: string;
	paths: string[];
	fileCount: number;
	kinds: Array<"autofix" | "format">;
	ownerSessionId?: string;
	turnIndex?: number;
	batchId?: string;
}

interface FormatDonePayload {
	v: typeof BUS_FORMAT_DONE_VERSION;
	source: "pi-lens";
	cwd: string;
	paths: string[];
	fileCount: number;
	kinds: Array<"autofix" | "format">;
	ownerSessionId?: string;
	turnIndex?: number;
	batchId?: string;
	settled?: boolean;
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
const queuedPublisher = createBusPublisher(liveEmitter, {
	module: "format-events-publish",
});
const startPublisher = createBusPublisher(liveEmitter, {
	module: "format-events-publish",
});
const donePublisher = createBusPublisher(liveEmitter, {
	module: "format-events-publish",
});
const autofixStartPublisher = createBusPublisher(liveEmitter, {
	module: "format-events-publish",
});

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
	queuedPublisher.reset();
	startPublisher.reset();
	donePublisher.reset();
	autofixStartPublisher.reset();
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
	/** The queued record identity, when published from the runtime seam. */
	ownerSessionId?: string;
	turnIndex?: number;
	batchId?: string;
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
	queuedPublisher.publish<FormatQueuedPayload>({
		event: BUS_FORMAT_QUEUED_EVENT,
		enabled: isBusPublishEnabled(),
		cwd: args.cwd,
		build: (cwd) => ({
			v: BUS_FORMAT_QUEUED_VERSION,
			source: "pi-lens",
			filePath: normalizeFilePath(args.filePath),
			cwd,
			tool: args.tool,
			kinds: args.kinds,
			...(args.ownerSessionId === undefined
				? {}
				: { ownerSessionId: args.ownerSessionId }),
			...(args.turnIndex === undefined ? {} : { turnIndex: args.turnIndex }),
			...(args.batchId === undefined ? {} : { batchId: args.batchId }),
		}),
		emittedFields: () => ({ fileCount: 1 }),
		dbg: args.dbg,
	});
}

export interface PublishFormatStartArgs {
	cwd: string;
	paths: string[];
	kinds?: Array<"autofix" | "format">;
	dbg?: (msg: string) => void;
	ownerSessionId?: string;
	turnIndex?: number;
	batchId?: string;
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
	startPublisher.publish<FormatStartPayload>({
		event: BUS_FORMAT_START_EVENT,
		enabled: isBusPublishEnabled(),
		cwd: args.cwd,
		build: (cwd) => {
			const paths = args.paths.map((p) => normalizeFilePath(p));
			return {
				v: BUS_FORMAT_START_VERSION,
				source: "pi-lens",
				cwd,
				paths,
				fileCount: paths.length,
				kinds: args.kinds ?? ["format"],
				...(args.ownerSessionId === undefined
					? {}
					: { ownerSessionId: args.ownerSessionId }),
				...(args.turnIndex === undefined ? {} : { turnIndex: args.turnIndex }),
				...(args.batchId === undefined ? {} : { batchId: args.batchId }),
			};
		},
		emittedFields: (payload) => ({ fileCount: payload.fileCount }),
		dbg: args.dbg,
	});
}

export interface PublishFormatDoneArgs {
	cwd: string;
	paths: string[];
	kinds?: Array<"autofix" | "format">;
	dbg?: (msg: string) => void;
	ownerSessionId?: string;
	turnIndex?: number;
	batchId?: string;
	settled?: boolean;
}

/**
 * Publish after the deferred-format batch has finished, including any
 * formatter-owned late-write resync. This is emitted for every non-empty
 * batch, including a batch whose formatter changed no bytes; that case is
 * represented by `paths: []`. Fire-and-forget, like the other format events.
 */
export function publishFormatDone(args: PublishFormatDoneArgs): void {
	donePublisher.publish<FormatDonePayload>({
		event: BUS_FORMAT_DONE_EVENT,
		enabled: isBusPublishEnabled(),
		cwd: args.cwd,
		build: (cwd) => {
			const paths = args.paths.map((p) => normalizeFilePath(p));
			return {
				v: BUS_FORMAT_DONE_VERSION,
				source: "pi-lens",
				cwd,
				paths,
				fileCount: paths.length,
				kinds: args.kinds ?? ["format"],
				...(args.ownerSessionId === undefined
					? {}
					: { ownerSessionId: args.ownerSessionId }),
				...(args.turnIndex === undefined ? {} : { turnIndex: args.turnIndex }),
				...(args.batchId === undefined ? {} : { batchId: args.batchId }),
				...(args.settled === undefined ? {} : { settled: args.settled }),
			};
		},
		emittedFields: (payload) => ({ fileCount: payload.fileCount }),
		dbg: args.dbg,
	});
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
	autofixStartPublisher.publish<AutofixStartPayload>({
		event: BUS_AUTOFIX_START_EVENT,
		enabled: isBusPublishEnabled(),
		cwd: args.cwd,
		build: (cwd) => {
			const paths = args.paths.map((p) => normalizeFilePath(p));
			return {
				v: BUS_AUTOFIX_START_VERSION,
				source: "pi-lens",
				cwd,
				paths,
				fileCount: paths.length,
				eligibleCount: args.eligibleCount,
			};
		},
		emittedFields: (payload) => ({ fileCount: payload.fileCount }),
		dbg: args.dbg,
	});
}
