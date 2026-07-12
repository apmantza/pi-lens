/**
 * Publishes `pilens:diagnostics` on pi's shared `pi.events` bus (#502).
 *
 * Sibling to `clients/bus-publish.ts` (the #482 `pilens:files:touched`
 * producer) rather than a new export crammed into that file: the two events
 * share the emit plumbing (`wireBusEmitter`) and the `PI_LENS_BUS_PUBLISH`
 * kill switch, but this producer owns its OWN piece of module state (the
 * previously-reported-paths set for clean-transition tracking, the seq
 * counter) that has nothing to do with files-touched.
 *
 * ## CONSUMER CONTRACT — staleness / replace semantics (2026-07-11 design, #502)
 *
 * Diagnostics are STATE; bus events are point-in-time snapshots of a slice of
 * that state. To guarantee a consumer can always reconstruct the latest
 * known picture from the event stream alone, this producer follows LSP
 * `publishDiagnostics` semantics:
 *
 * 1. **Full-replace per file, never a delta.** Every event carries the
 *    COMPLETE current diagnostic set for each file it mentions. An event
 *    mentioning path P replaces everything a consumer previously held for P
 *    — never merge/append across events for the same path.
 * 2. **Empty array = explicitly clean.** When a previously-reported file's
 *    diagnostics clear, this producer emits `{path, diagnostics: []}` for it
 *    exactly once, on the transition. Silence never means clean (the #240
 *    doctrine, applied here on the producer side) — a consumer that stops
 *    hearing about a path has learned NOTHING about its current state.
 * 3. **Monotonic `seq` + `ts` per emission.** `seq` increments once per
 *    `publishDiagnostics` call (module-level counter, process-lifetime
 *    monotonic — never reset except in tests). Out-of-order receipt resolves
 *    deterministically: higher `seq` always wins, lower is discarded.
 * 4. **`pilens:files:touched` (#482) is an INVALIDATION HINT, not new data.**
 *    Between an edit landing (a files:touched event) and the next
 *    diagnostics batch for that path, a consumer's previously-held
 *    diagnostics for that path are PROVISIONAL — the file has changed on
 *    disk but pi-lens hasn't re-analyzed it yet. Consumers that want to
 *    avoid rendering stale annotations across that window should treat a
 *    files:touched path as "diagnostics pending" until the next
 *    pilens:diagnostics event mentions it (at any seq).
 *
 * Late-joiners are a non-problem in-process: extensions activate at
 * `session_start`, before any turn emits, so v1 is push-only (no
 * request/replay). #478's future `pilens:rpc:diagnostics` pull API reuses
 * this exact `PilensDiagnosticsPayload` shape verbatim — push and pull are
 * two deliveries of the same schema over the same lens-engine seam; #478
 * stays separately gated on #449 registry dogfooding.
 *
 * ## Emission seam
 *
 * `publishDiagnostics` is called once per write batch immediately after
 * `recordDiagnostics` (clients/widget-state.ts) commits the FINAL per-file
 * diagnostic set for that batch — i.e. after format, autofix, and dispatch
 * have all run (see pipeline.ts's phase order). This guarantees the emitted
 * event reflects post-batch latest state, not an intermediate runner result:
 * widget-state's `allDiagnostics` store is exactly what `recordDiagnostics`
 * just wrote, so reading it back at the same call site can't race a later
 * write in the same batch.
 *
 * Versioning policy: frozen-additive, same discipline as #482. New optional
 * fields may be added under `v: 1`; a breaking change to an existing field's
 * meaning must bump `v`.
 */
import { logBusEvent } from "./bus-events-logger.js";
import { normalizeFilePath } from "./path-utils.js";
import { isBusPublishEnabled } from "./bus-publish.js";

export const BUS_DIAGNOSTICS_EVENT = "pilens:diagnostics";
export const BUS_DIAGNOSTICS_VERSION = 1;

/** Max diagnostics carried per file per event — aligned with the widget's own per-file storage cap (`MAX_STORED_DIAGNOSTICS_PER_FILE`, clients/widget-state.ts). */
export const MAX_DIAGNOSTICS_PER_FILE_EVENT = 12;

export interface PilensDiagnosticEntry {
	ruleId?: string;
	severity: "error" | "warning" | "info" | "hint";
	line?: number;
	col?: number;
	message: string;
	tool: string;
	fixable?: boolean;
}

export interface PilensDiagnosticsFileEntry {
	/** Absolute, normalized path (forward slashes, canonical casing — same normalization as #482 `paths`). */
	path: string;
	/** Complete current diagnostic set for this file (full-replace; see CONSUMER CONTRACT above). Empty = explicitly clean. */
	diagnostics: PilensDiagnosticEntry[];
	/** Set when the true diagnostic count exceeded `MAX_DIAGNOSTICS_PER_FILE_EVENT` and this entry was capped. */
	truncated?: boolean;
}

/**
 * Versioned payload for `pilens:diagnostics` (#502). This schema is shared
 * VERBATIM with #478's future `pilens:rpc:diagnostics` pull response — push
 * (this event) and pull (#478) are two deliveries of the same shape over the
 * same lens-engine seam. Do not fork the shape for one delivery mechanism;
 * change it here and both inherit the change.
 *
 * See the module doc comment above for the full staleness/replace contract.
 */
export interface PilensDiagnosticsPayload {
	v: typeof BUS_DIAGNOSTICS_VERSION;
	source: "pi-lens";
	cwd: string;
	/** Monotonic per-emission counter (process-lifetime; NOT persisted). Higher seq always wins on out-of-order receipt. */
	seq: number;
	/** Emission wall-clock time, ms since epoch. */
	ts: number;
	files: PilensDiagnosticsFileEntry[];
}

type BusEmitFn = (channel: string, data: unknown) => void;

let busEmit: BusEmitFn | undefined;
let hasLoggedFailure = false;
let hasLoggedUnwired = false;
let hasLoggedDisabled = false;
let seqCounter = 0;

/** Paths this producer has reported with at least one non-empty diagnostics array, so we know when to fire the one-time clean-transition event. */
const reportedDirtyPaths = new Set<string>();

/**
 * Wire the emit function from pi's `pi.events` bus. Called once at extension
 * factory time from index.ts, same call as `wireBusEmitter` (#482) — both
 * producers share the identical `pi.events.emit` binding.
 */
export function wireDiagnosticsBusEmitter(emitFn: BusEmitFn | undefined): void {
	busEmit = emitFn;
}

/** Test-only: reset module state between test files. */
export function _resetDiagnosticsPublishForTests(): void {
	busEmit = undefined;
	hasLoggedFailure = false;
	hasLoggedUnwired = false;
	hasLoggedDisabled = false;
	seqCounter = 0;
	reportedDirtyPaths.clear();
}

export interface PublishDiagnosticsFileInput {
	/** Absolute path (pre-normalization — this function normalizes). */
	path: string;
	/** Current FULL diagnostic set for this file (this call's complete picture — full-replace semantics). */
	diagnostics: PilensDiagnosticEntry[];
}

export interface PublishDiagnosticsArgs {
	cwd: string;
	files: PublishDiagnosticsFileInput[];
	/** Loop guard, mirrors #482: set when triggered by an ingested bus event. Always false in practice (pi-lens consumes nothing today); exists so a future consumer can't wire a publish -> react -> publish cycle. */
	origin?: "bus";
	dbg?: (msg: string) => void;
}

function capDiagnostics(diagnostics: PilensDiagnosticEntry[]): {
	capped: PilensDiagnosticEntry[];
	truncated: boolean;
} {
	if (diagnostics.length <= MAX_DIAGNOSTICS_PER_FILE_EVENT) {
		return { capped: diagnostics, truncated: false };
	}
	// Prioritize errors first (same "blockers first" spirit as the widget cap).
	const errors = diagnostics.filter((d) => d.severity === "error");
	const rest = diagnostics.filter((d) => d.severity !== "error");
	if (errors.length >= MAX_DIAGNOSTICS_PER_FILE_EVENT) {
		return {
			capped: errors.slice(0, MAX_DIAGNOSTICS_PER_FILE_EVENT),
			truncated: true,
		};
	}
	return {
		capped: [
			...errors,
			...rest.slice(0, MAX_DIAGNOSTICS_PER_FILE_EVENT - errors.length),
		],
		truncated: true,
	};
}

/**
 * Publish one `pilens:diagnostics` event for a write batch's final
 * per-file diagnostic state. Fire-and-forget: never throws, never awaited.
 *
 * Full-replace semantics (see module doc): each `files` entry here is
 * treated as the COMPLETE current set for that path. Additionally, for
 * every path in `reportedDirtyPaths` that is NOT present in this call's
 * `files` list but has gone clean via a prior call in THIS same invocation,
 * callers must pass an explicit `{path, diagnostics: []}` entry — this
 * function does not infer clean transitions for paths it isn't told about.
 * The one caller (the pipeline write-batch seam) always passes the
 * single file it just analyzed, so the common clean-transition path is:
 * dispatch returns zero diagnostics for a file this producer previously
 * reported dirty -> caller passes `{path, diagnostics: []}` -> emitted once,
 * `reportedDirtyPaths` drops the path so a SECOND clean run of the same file
 * does not re-emit (still clean -> silence is fine once the transition
 * itself has been announced).
 */
export function publishDiagnostics(args: PublishDiagnosticsArgs): void {
	if (args.origin === "bus") return;
	if (args.files.length === 0) return;
	if (!isBusPublishEnabled()) {
		if (!hasLoggedDisabled) {
			hasLoggedDisabled = true;
			logBusEvent({
				event: BUS_DIAGNOSTICS_EVENT,
				outcome: "skipped_disabled",
				cwd: normalizeFilePath(args.cwd),
			});
		}
		return;
	}
	if (!busEmit) {
		if (!hasLoggedUnwired) {
			hasLoggedUnwired = true;
			logBusEvent({
				event: BUS_DIAGNOSTICS_EVENT,
				outcome: "skipped_unwired",
				cwd: normalizeFilePath(args.cwd),
			});
		}
		return;
	}

	try {
		const fileEntries: PilensDiagnosticsFileEntry[] = args.files.map((f) => {
			const normPath = normalizeFilePath(f.path);
			const { capped, truncated } = capDiagnostics(f.diagnostics);
			if (capped.length > 0) {
				reportedDirtyPaths.add(normPath);
			} else {
				reportedDirtyPaths.delete(normPath);
			}
			const entry: PilensDiagnosticsFileEntry = {
				path: normPath,
				diagnostics: capped,
			};
			if (truncated) entry.truncated = true;
			return entry;
		});

		seqCounter += 1;
		const payload: PilensDiagnosticsPayload = {
			v: BUS_DIAGNOSTICS_VERSION,
			source: "pi-lens",
			cwd: normalizeFilePath(args.cwd),
			seq: seqCounter,
			ts: Date.now(),
			files: fileEntries,
		};
		busEmit(BUS_DIAGNOSTICS_EVENT, payload);
		logBusEvent({
			event: BUS_DIAGNOSTICS_EVENT,
			outcome: "emitted",
			cwd: payload.cwd,
			fileCount: payload.files.length,
			seq: payload.seq,
		});
	} catch (err) {
		logBusEvent({
			event: BUS_DIAGNOSTICS_EVENT,
			outcome: "emit_failed",
			cwd: normalizeFilePath(args.cwd),
			error: String(err),
		});
		if (!hasLoggedFailure) {
			hasLoggedFailure = true;
			args.dbg?.(
				`diagnostics-publish: pilens:diagnostics emit failed (further failures suppressed): ${err}`,
			);
		}
	}
}

/**
 * Whether `path` was last reported with a non-empty diagnostic set (i.e. a
 * clean run for it now would be a transition worth emitting `[]` for).
 * Exposed for the pipeline call site to decide whether to include a
 * currently-clean file in the batch it passes to `publishDiagnostics`.
 */
export function wasPreviouslyReportedDirty(path: string): boolean {
	return reportedDirtyPaths.has(normalizeFilePath(path));
}
