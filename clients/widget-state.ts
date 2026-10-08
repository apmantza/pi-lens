import { readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { BoundedFifoMap } from "./bounded-cache.js";
import {
	demotePastEofDiagnostics,
	type LineCountCache,
} from "./diagnostic-line-freshness.js";
import { visibleWidth } from "./deps/pi-tui.js";
import { normalizeEphemeralMapKey, normalizeMapKey } from "./path-utils.js";
import { fitLine } from "./tui-fit.js";
import { WriteOrderingGuard } from "./write-ordering-guard.js";
import { collectForwardImportMtimes } from "./blocker-freshness.js";
import { normalizeMessage } from "./finding-identity.js";
import { freshnessFromMtime } from "./freshness.js";
import { PAST_EOF_STALE_MARKER } from "./diagnostic-line-freshness.js";
import { STALE_LINE_MARKER } from "./stale-marker.js";
import type { FormatterOutcomeKind } from "./formatters.js";
import {
	anchorsForDiagnostic,
	applyDispositions,
	getDisposition,
	registerWidgetDispositionReconciler,
	strictAnchorSpan,
	strictAnchorSpansIn,
	type Disposition,
	type DispositionMarkTarget,
} from "./diagnostic-dispositions.js";
import { recordDegradationOnce } from "./degradation-ledger.js";
import { defineSessionStore } from "./session-scope.js";
import { dropStaleFiles } from "./session-state-store.js";

/**
 * Canonical key for the `files` map (and `diagnosticsWriteGuard`) — #1020.
 *
 * The SAME file reaches this module under DIFFERENT path forms in one session:
 * forward-slash (`C:/…/x.ts`) from the LSP client + cascade fold via
 * `normalizeFilePath`, and backslash (`C:\…\x.ts`) from mode=full's reconcile
 * writing `result.filePath` and from `path.resolve`/event inputs on Windows.
 * Keyed raw, those coexisted as two entries: `mode=full` re-keyed on read and
 * the clean entry hid the stale one, but `mode=all`'s `formatAllMode` reads the
 * summaries verbatim and rendered the stale `blocking:1` as a 🔴 (#1020) — a
 * resolved state that replayed as still-broken on every `mode=all`.
 *
 * `normalizeEphemeralMapKey` (slash-fold + win32-lowercase, NO filesystem I/O)
 * is chosen over `normalizeMapKey`/`normalizeFilePath`, which call
 * `realpathSync.native()` — real disk I/O on EVERY diagnostic/runner/formatter
 * write, far too heavy for this hot path. The key only needs to be a stable
 * syntactic fold that collapses `\`↔`/` and Windows drive-letter case, which
 * this does; on-disk canonical casing is irrelevant for merely deduplicating a
 * process-local footer cache. The human-readable path is preserved separately
 * on the record's `filePath` (see `toDisplayPath`) for rendering/summaries.
 */
function fileMapKey(filePath: string): string {
	return normalizeEphemeralMapKey(filePath);
}

// The record keeps a real, human-readable display path in `FileRecord.filePath`
// (drives the widget render, `getFileDiagnosticSummaries`, and diagnostic URIs).
// It is the VERBATIM path the first writer for a given key supplied — never the
// lowercased/normalized `fileMapKey`, which would render an ugly all-lowercase
// path on Windows. Only the MAP KEY is normalized; the display path is
// unchanged from pre-#1020 behavior, so rendering and path-relative math are
// unaffected. First writer wins the display form (later writes for the same
// normalized key reuse the existing record).

// ── Types ────────────────────────────────────────────────────────────────────

export interface WidgetDiagnostic {
	severity: string;
	semantic?: string;
	message: string;
	line?: number;
	col?: number;
	rule?: string;
	tool?: string;
	uri?: string;
	/** Set when a `flagged` disposition (#690) is found for this diagnostic at
	 * merge time — only populated where file content was already available
	 * (mode=full's suppression pass), never computed for mode=all/delta to
	 * keep those cache-only and instant. */
	flagged?: boolean;
	/** Finding retained as an explicit suppressed bucket (#1616). */
	disposition?: "false-positive" | "suppress";
	/**
	 * Wall-clock time this specific diagnostic was OBSERVED (#1186). Per-ENTRY,
	 * not per-record: a merged record (see `reconcileCascadeNeighborLspErrors`)
	 * can hold a freshly-observed preserved entry alongside an incoming entry
	 * replayed from an aging passive snapshot, each with its OWN stamp. The
	 * per-entry stale gate (`reconcileStaleWidgetFiles`) compares THIS stamp to
	 * the file's current mtime, so it drops only the genuinely-stale entries
	 * instead of the whole record. A missing stamp (a pre-#1186 persisted record)
	 * inherits the record's `touchedAt` — a safe, over-conservative default.
	 */
	observedAt?: number;
	/**
	 * Set when a freshness gate demoted this diagnostic. Two gates write it:
	 * #1641's past-EOF gate (the cited `line` exceeds the file's CURRENT
	 * on-disk line count) and #1631's dependency-drift gate
	 * (`reconcileStaleWidgetDependencyBlockers`: a forward import changed on
	 * disk after this diagnostic was observed). Demoted entries stay in the
	 * set — the underlying issue may still be real — but are excluded from
	 * blocking/error/warning tallies (`isBlocking`, `countDiagnostics`) and
	 * rendered with a stale marker in place of a trusted coordinate (#1419
	 * demote-not-drop).
	 *
	 * The past-EOF gate RE-DERIVES this on every read (`applyPastEofGate`),
	 * never a one-way latch: a transient shrink that later restores clears it
	 * back to `false` once the line is back in bounds (#1641 review round F3
	 * — derive, don't latch). The dependency-drift gate likewise re-derives
	 * from current import mtimes each sweep.
	 */
	stale?: boolean;
	/** Which freshness gate demoted this entry: "past-eof" (#1641) or
	 * "dependency-drift" (#1631). Each gate heals only its own demotions. */
	staleReason?: string;
	/**
	 * #2275: how many turn ends have re-served this diagnostic while
	 * `stale && staleReason === "dependency-drift"`. Sibling of
	 * `InlineBlockerRecord.staleDeliveryCount` (#1950) — same cap
	 * (`DEPENDENCY_DRIFT_MAX_DELIVERIES`, `clients/blocker-freshness.ts`),
	 * same "capped, re-run can still confirm" semantics, but tracked in THIS
	 * completely separate store (the widget footer's own `files` map, not
	 * `RuntimeCoordinator`'s inline-blocker map) because the two surfaces
	 * demote independently — see `markWidgetFileBlockersStale`'s doc. Only
	 * ever set for the `"dependency-drift"` reason; the widget's past-EOF
	 * demotion re-derives per render (`applyPastEofGate`) rather than
	 * latching, so it has no equivalent delivery count to cap.
	 *
	 * Counts RENDERS, not turn ends (#2275 review F1): the footer draws one
	 * record per pass (`renderWidget`'s `withBlocking[0]`, its first five
	 * qualifying entries), so a turn that ended without this row on screen
	 * delivered nothing. `renderWidget` marks what it drew;
	 * `runtime-turn.ts`'s turn-end step commits those marks through
	 * `drainRenderedDependencyDriftFilePaths` — the widget-surface analogue
	 * of #1950's own deferred-until-delivered commit.
	 */
	staleDeliveryCount?: number;
	/**
	 * #2275 review F2: this dependency-drift demotion reached its delivery
	 * cap, so the FOOTER stops showing it — the entry itself stays in
	 * `allDiagnostics`.
	 *
	 * Retirement here is hide-from-footer, never drop. `allDiagnostics` is
	 * also what `getFileDiagnosticSummaries` (`lens_diagnostics mode=all`)
	 * and `lens_diagnostic_mark`'s cross-check read; splicing the entry out
	 * would make an unconfirmed LSP error read as CLEAN on those surfaces
	 * and take it out of the error tally #1631 requires it to stay in. The
	 * capped row therefore keeps its `stale`/`staleReason` demotion
	 * everywhere else, and mode=all says in words that the footer stopped
	 * showing it and a re-run can still confirm it. Cleared implicitly by
	 * any later `recordDiagnostics` (which replaces `allDiagnostics`
	 * wholesale), and stripped on session restore alongside `stale`.
	 */
	footerRetired?: boolean;
	/**
	 * #3158: this suppressed row is carried by the store even though the LAST
	 * scan of the file did not report it.
	 *
	 * `recordDiagnostics` (and every other seam that reaches
	 * {@link commitDiagnostics}) REPLACES the file's entries with the list it is
	 * handed, and since #3088 the `lens_diagnostics source=lsp` probe hands it
	 * the post-disposition FILTERED set. A finding the agent marked
	 * `false-positive`/`suppress` is therefore absent from every later scan, so
	 * the tagged row the `suppressed: N` chip counts (`countSuppressedIn`) was
	 * deleted by the first fresh probe and the file stopped contributing. The
	 * retention rule below keeps it and stamps this flag; #2275 is the precedent
	 * (hide, never drop, because `allDiagnostics` also backs
	 * `lens_diagnostics mode=all` and `lens_diagnostic_mark`'s cross-check).
	 *
	 * Lifetime — a retained row is retired by, and ONLY by:
	 * 1. its MARK ceasing to apply to the file's current content (#3183). A row
	 *    carrying an {@link WidgetDiagnostic.anchorSpan} is NOT gated on the
	 *    file's mtime: `reconcileStaleWidgetFiles` asks the anchor instead — the
	 *    row stands while the marked LINE is still somewhere in the file, and
	 *    goes when it is not. Before #3183 this rule was the per-entry
	 *    `mtimeMs > observedAt` gate, which is FILE-scoped where the mark is
	 *    SPAN-scoped: ANY edit retired the row, including one that left the
	 *    marked line byte-identical, and nothing re-created it (later scans
	 *    filter the finding out and `reconcileWidgetDisposition` bails on an
	 *    absent record) — so the chip counted a mark until the file's next edit
	 *    rather than for as long as the mark stood. A row with no span — a
	 *    WEAK-anchored `suppress` mark, which is intent-level and has no line to
	 *    hash, or a row persisted by a pre-#3183 build — keeps the mtime gate
	 *    exactly as before, so neither gains an axis with no content-bound
	 *    retirement at all. Deletion of the file still drops the whole record;
	 * 2. a later scan reporting the same finding again — the incoming entry
	 *    matches by {@link retentionIdentity} and wins, so a row is never both
	 *    retained and live;
	 * 3. its mark ceasing to suppress it. `reconcileWidgetDisposition` drops a
	 *    row carrying this flag rather than re-arming it as a live finding the
	 *    last scan did not report;
	 * 4. {@link MAX_RETAINED_SUPPRESSED_PER_FILE}, the per-file bound on this
	 *    axis — the one axis that can hold rows no live scan reports.
	 *
	 * A retained row is never blocking: `isBlocking` answers `false` for any
	 * `disposition`, so it cannot draw a footer ● row, cannot be hoisted past a
	 * live finding by `capStoredDiagnostics`, and cannot enter the turn-end
	 * blocker sweep (#3158 round 2 F1). It is not a live finding either:
	 * `getFileDiagnosticSummaries` stops projecting every `disposition` row
	 * (#3183), so `mode=all`'s weak-fallback branch — reached exactly when the
	 * file's mtime moved past the observation, and unable to match a STRICT
	 * `false-positive` anchor — can never serve one as live.
	 *
	 * NOT stripped on session restore, unlike `stale`/`footerRetired`: those are
	 * verdicts about one session's disk state, whereas every retirement rule
	 * above outlives a resume — the mark is durable (the `.pi-lens` disposition
	 * store) and the anchor span is content-bound, so a restored row is
	 * re-evaluated by the same gates a live one is.
	 */
	suppressedRetained?: true;
	/**
	 * #3183: the SPAN component of the strict `false-positive` anchor behind this
	 * row — `strictAnchorSpan` (`clients/diagnostic-dispositions.ts`) over the
	 * content the mark was made against, i.e. the `lineContentHash` of the marked
	 * line. Stamped by `reconcileWidgetDisposition`, the one seam that both tags a
	 * row and has the content in hand.
	 *
	 * It is the row's own identity on the only axis that matters for its
	 * lifetime, and it answers two questions no other stored field can:
	 *
	 * - "does the mark still apply?" — `reconcileStaleWidgetFiles` and
	 *   `retainSuppressedRows` check the span against the file's CURRENT content
	 *   (see retirement rule 1 above);
	 * - "is this incoming finding the SAME one?" — see {@link retentionIdentity}.
	 *
	 * Only `false-positive` rows carry it. A `suppress` mark is WEAK-anchored —
	 * `[tool, rule, message]` with no line content at all — so there is no span
	 * to stamp and nothing the file's bytes could invalidate; those rows keep the
	 * pre-#3183 behaviour on both questions. Absent on a row persisted by an
	 * older build, and every reader treats absent as "fall back to the mtime
	 * gate / the coarse identity" rather than as a licence to keep the row.
	 */
	anchorSpan?: string;
}

/**
 * A diagnostic is "blocking" when pi-lens classifies it as a hard stop
 * (`semantic === "blocking"`). Falls back to severity for sources that
 * don't set `semantic` (raw tsc/eslint diagnostics) so the red dot still
 * fires on traditional compile errors.
 *
 * #1561: exported so the blocker-retire decision in `tools/lsp-diagnostics.ts`
 * asks THIS predicate rather than growing a second severity rule that can drift
 * from what the footer counts.
 */
export function isBlocking(d: WidgetDiagnostic): boolean {
	// #3158 round 2 F1: a finding the agent marked `false-positive`/`suppress` is
	// not a hard stop — it is an explicitly dismissed one. Before this line only
	// `countDiagnostics` knew that (it skips tagged entries), so the footer header
	// counted zero errors while every consumer that asks THIS predicate still
	// treated the row as blocking: `renderWidget` drew a red ● row for it,
	// `capStoredDiagnostics` hoisted it ahead of live findings (evicting one at the
	// display cap), and `getWidgetBlockingFilesForSweep`,
	// `markWidgetFileBlockersStale` and `reconcileStaleWidgetDependencyBlockers`
	// admitted it to the turn-end blocker sweep. The mismatch was latent while a
	// tagged row lived only between a mark and the next scan; retention makes it
	// durable, so the predicate has to answer for the tag.
	if (d.disposition) return false;
	// #1631: a dependency-drift-demoted finding is no longer a hard stop. The gate
	// sets `stale` rather than dropping the entry (#1419 demote-not-drop), so every
	// tally and render that asks "is this blocking?" must answer no once demoted.
	if (d.stale) return false;
	if (d.semantic === "blocking") return true;
	if (d.semantic == null && d.severity === "error") return true;
	return false;
}

interface FileRecord {
	filePath: string;
	runners: Map<string, { status: string; count: number; durationMs?: number }>;
	formatters: Map<
		string,
		{ changed: boolean; success: boolean; outcome?: FormatterOutcomeKind }
	>;
	/** Capped to MAX_STORED_DIAGNOSTICS_PER_FILE — drives the TUI widget. */
	diagnostics: WidgetDiagnostic[];
	/**
	 * Full, uncapped diagnostics for this file. The TUI never renders these
	 * (it uses the capped `diagnostics` + its own row limits); they exist so
	 * the lens_diagnostics tool can expose the complete set to the agent without
	 * inheriting the widget's display cap.
	 */
	allDiagnostics: WidgetDiagnostic[];
	diagnosticCounts: {
		blocking: number;
		errors: number;
		warnings: number;
	};
	hasFinalDiagnosticsSnapshot: boolean;
	touchedAt: number;
}

interface LspRecord {
	serverId: string;
	root: string;
	status: "spawning" | "ready" | "failed";
	durationMs?: number;
}

// ── Module state ─────────────────────────────────────────────────────────────

const files = new Map<string, FileRecord>();
let sessionLanguages: string[] = [];
let requestRenderFn: (() => void) | null = null;

/**
 * Guards `recordDiagnostics` writes against the same race class fixed for
 * `clients/lsp/client.ts` in #555: pi-lens allows concurrent pipeline runs
 * for the same file across different same-turn edits, so an older edit's
 * (slower) pipeline can finish its `recordDiagnostics` call AFTER a newer
 * edit's (faster) pipeline already recorded fresher diagnostics for that
 * path. Keyed by `filePath`, tokened by `writeIndex` (see
 * `clients/runtime-tool-result.ts:nextWriteIndex`).
 */
const diagnosticsWriteGuard = new WriteOrderingGuard<string, number>();
/**
 * Runner completions also mutate the shared file record: they mark the
 * diagnostics snapshot pending. Keep that mutation in the same per-file order
 * as the final diagnostic replacement, or an older pipeline can set a newer
 * confirmed-clean record back to `(pending)` (#1198).
 */
const runnerWriteGuard = new WriteOrderingGuard<string, number>();

const MAX_STORED_DIAGNOSTICS_PER_FILE = 12;
/**
 * #3158 / AGENTS.md shape 9: the per-file bound on
 * {@link WidgetDiagnostic.suppressedRetained} rows. Retention is the only rule
 * that lets a record hold findings the latest scan did not report, so it is the
 * only axis of `allDiagnostics` that can grow while the live set shrinks — every
 * other row is replaced wholesale by the next write. Its own constant rather
 * than `MAX_STORED_DIAGNOSTICS_PER_FILE`: that one is the TUI's display cap
 * (`capStoredDiagnostics`) and the two would drift the moment either policy
 * moved. Twelve because the chip is a COUNT, not a list — past a dozen
 * suppressed findings on one unchanged file the exact total stops informing the
 * footer, and the truncation is stated once per file through the ledger rather
 * than dropped silently.
 */
const MAX_RETAINED_SUPPRESSED_PER_FILE = 12;
const MAX_INACTIVE_FILE_RECORDS = 1024;
const ACTIVE_FILE_IDLE_MS = 30 * 60_000;
export const MAX_LSP_SERVER_RECORDS = 128;
const lspServers = new BoundedFifoMap<string, LspRecord>(
	MAX_LSP_SERVER_RECORDS,
);
// Pruning is a cold-size-boundary operation. Do not walk the whole file map
// for every record in a large diagnostics reconciliation; the full-scan path
// can legitimately create thousands of records in one synchronous batch.
let nextInactivePruneSize = MAX_INACTIVE_FILE_RECORDS + 1;

function pruneInactiveFileRecords(now = Date.now()): void {
	if (files.size <= MAX_INACTIVE_FILE_RECORDS) return;
	const victims = [...files.entries()]
		.filter(
			([, rec]) =>
				now - rec.touchedAt > ACTIVE_FILE_IDLE_MS && !hasLiveDiagnostic(rec),
		)
		.sort(([, a], [, b]) => a.touchedAt - b.touchedAt);
	for (const [key] of victims) {
		if (files.size <= MAX_INACTIVE_FILE_RECORDS) break;
		files.delete(key);
	}
}

function maybePruneInactiveFileRecords(): void {
	if (files.size < nextInactivePruneSize) return;
	pruneInactiveFileRecords();
	// A live-heavy map may remain above the soft bound. Do not rescan it for
	// every subsequent file; the next lifecycle starts with a fresh state map.
	nextInactivePruneSize = Number.POSITIVE_INFINITY;
}

// ── Public API ────────────────────────────────────────────────────────────────

export function setRenderCallback(fn: () => void): void {
	requestRenderFn = fn;
}

/** Reconcile a mark through the same apply/count/commit path as dispatch. */
export function reconcileWidgetDisposition(
	cwd: string,
	target: DispositionMarkTarget,
	_disposition: Disposition,
	content?: string,
): void {
	const current = getFileDiagnostics(target.filePath);
	if (!current) {
		recordDegradationOnce({
			kind: "widget-disposition-reconcile-fallback",
			subject: target.filePath,
			reason: "the marked finding's widget record is absent",
		});
		return;
	}
	let source = content ?? target.content;
	if (source === undefined) {
		try {
			source = readFileSync(target.filePath, "utf8");
		} catch {
			recordDegradationOnce({
				kind: "widget-disposition-reconcile-fallback",
				subject: target.filePath,
				reason: "the disposition anchor content could not be read",
			});
			source = "";
		}
	}
	const active = new Set(
		applyDispositions(current, cwd, target.filePath, source),
	);
	const normalized: WidgetDiagnostic[] = current.flatMap((diagnostic) => {
		const { strict, weak } = anchorsForDiagnostic(
			cwd,
			target.filePath,
			diagnostic,
			source,
		);
		const entry = getDisposition(cwd, strict) ?? getDisposition(cwd, weak);
		if (
			!active.has(diagnostic) &&
			(entry?.disposition === "false-positive" ||
				entry?.disposition === "suppress")
		) {
			// #3183: stamp the strict anchor's own SPAN so the row's lifetime can
			// later ask the mark instead of the file's mtime. `source` is the content
			// the anchors above were derived from, so the span is the one the mark
			// itself binds to. Only the STRICT arm has a span — a weak `suppress`
			// mark hashes no line — and re-tagging always re-derives it, so a stale
			// span from an earlier tag can never survive into a new disposition.
			const { anchorSpan: _previousSpan, ...base } = diagnostic;
			const span =
				entry.disposition === "false-positive"
					? strictAnchorSpan(source, diagnostic.line)
					: undefined;
			return [
				{
					...base,
					disposition: entry.disposition,
					flagged: false,
					...(span === undefined ? {} : { anchorSpan: span }),
				},
			];
		}
		// #3158 retirement rule 3: a row the store holds ONLY because it was
		// suppressed (`suppressedRetained`) has no live scan behind it — the last
		// scan of this file did not report it. Once its mark stops suppressing it
		// (a strict `false-positive` anchor whose marked line changed), retire it
		// rather than re-arming it below as a finding the agent would read as
		// currently present.
		if (diagnostic.suppressedRetained) return [];
		const {
			disposition: _disposition,
			flagged: _flagged,
			// #3183: a row that is no longer disposition-tagged has no mark to
			// anchor, so its span goes with the tag — leaving it would exempt a LIVE
			// row from the sweep's mtime gate.
			anchorSpan: _anchorSpan,
			...baseDiagnostic
		} = diagnostic;
		return entry?.disposition === "flagged"
			? [{ ...baseDiagnostic, flagged: true }]
			: [baseDiagnostic];
	});
	const rec = getOrCreate(target.filePath);
	const writeIndex = admitWidgetDiagnosticsWrite(target.filePath);
	if (
		!diagnosticsWriteGuard.shouldWrite(fileMapKey(target.filePath), writeIndex)
	)
		return;
	commitDiagnostics(
		rec,
		target.filePath,
		normalized,
		Date.now(),
		fileMapKey(target.filePath),
		false,
	);
}

/** Reserve a widget write for a producer that has no runtime write index. */
export function admitWidgetDiagnosticsWrite(
	filePath: string,
	writeIndex?: number,
): number {
	const key = fileMapKey(filePath);
	const token = writeIndex ?? diagnosticsWriteGuard.nextToken(key);
	diagnosticsWriteGuard.shouldWrite(key, token);
	runnerWriteGuard.shouldWrite(key, token);
	return token;
}

registerWidgetDispositionReconciler((cwd, target, disposition) =>
	reconcileWidgetDisposition(cwd, target, disposition, target.content),
);

export interface WidgetDispositionEvents {
	events:
		| { on?: (channel: string, handler: (data: unknown) => void) => unknown }
		| undefined;
}

/** Consume the host-side disposition event and refresh the real widget store. */
export function wireWidgetDispositionSubscriber(
	args: WidgetDispositionEvents,
): void {
	args.events?.on?.("pilens:diagnostic:disposition", (data) => {
		if (!data || typeof data !== "object") return;
		const payload = data as Record<string, unknown>;
		if (payload.source !== "pi-lens" || typeof payload.cwd !== "string") return;
		if (
			typeof payload.filePath !== "string" ||
			typeof payload.disposition !== "string"
		)
			return;
		if (typeof payload.message !== "string") return;
		if (
			!(
				["false-positive", "suppress", "defer", "flagged"] as string[]
			).includes(payload.disposition)
		)
			return;
		reconcileWidgetDisposition(
			payload.cwd,
			{
				cwd: payload.cwd,
				filePath: payload.filePath,
				message: typeof payload.message === "string" ? payload.message : "",
				...(typeof payload.tool === "string" ? { tool: payload.tool } : {}),
				...(typeof payload.rule === "string" ? { rule: payload.rule } : {}),
				...(typeof payload.line === "number" ? { line: payload.line } : {}),
			},
			payload.disposition as Disposition,
		);
	});
}

/**
 * #2275 review F1: files whose dependency-drift-demoted rows the footer has
 * ACTUALLY DRAWN since the last turn end — the delivery population
 * `runtime-turn.ts`'s cap step drains.
 *
 * The footer is not a broadcast of the whole store: `renderWidget` picks ONE
 * record (`withBlocking[0]`) and its first five qualifying entries, and it
 * may not be drawn at all (headless, or a turn with no repaint). Counting a
 * delivery per turn end therefore charged the cap for rows the agent never
 * saw, and retired them a delivery early. A Set (not a counter) is the right
 * shape: the widget repaints many times per turn, and all of those repaints
 * are the SAME one delivery.
 */
const renderedDependencyDriftFiles = new Set<string>();

export function clearWidgetState(): void {
	files.clear();
	renderedDependencyDriftFiles.clear();
	lspServers.clear();
	sessionLanguages = [];
	requestRenderFn = null;
	diagnosticsWriteGuard.clear();
	runnerWriteGuard.clear();
	nextInactivePruneSize = MAX_INACTIVE_FILE_RECORDS + 1;
}

// v1 → v2 (#1186): per-entry `WidgetDiagnostic.observedAt`. v2 is a SUPERSET of
// v1 (the field is additive/optional), so `importWidgetState` accepts either and
// migrates a v1 record by inheriting each entry's `observedAt` from the record's
// `touchedAt`. A v1 file must never be rejected (that would silently drop resume
// diagnostics) nor crash.
//
// v2 → v3 (#1631 review F3): a dependency-drift `stale` demotion is a verdict
// about THIS session's disk state — the next session starts with a fresh (and
// possibly different) dependency graph, so a demotion from the last session
// must not outlive it. `exportWidgetState` had been serializing `stale: true`
// verbatim; on restore, a genuine type error stayed non-blocking across a
// resume with the dependency pinned back into the past. Same shape as the
// #1348 failed-formatter precedent one field over: `importWidgetState` strips
// `stale` on every restored entry so a resumed session re-evaluates from
// scratch instead of inheriting a possibly-stale-itself verdict.
export const WIDGET_STATE_VERSION = 3;

/** Serializable snapshot of the per-file diagnostic state (#190). */
export interface PersistedWidgetState {
	version: number;
	sessionLanguages: string[];
	files: Array<{
		filePath: string;
		runners: Array<
			[string, { status: string; count: number; durationMs?: number }]
		>;
		formatters: Array<
			[
				string,
				{ changed: boolean; success: boolean; outcome?: FormatterOutcomeKind },
			]
		>;
		diagnostics: WidgetDiagnostic[];
		allDiagnostics: WidgetDiagnostic[];
		diagnosticCounts: { blocking: number; errors: number; warnings: number };
		hasFinalDiagnosticsSnapshot: boolean;
		touchedAt: number;
	}>;
}

/**
 * Snapshot the per-file widget diagnostics for persistence (#190). Excludes
 * `lspServers` — those are process-bound (servers re-spawn fresh on the next
 * launch), so restoring their "ready" status would be misleading.
 */
export function exportWidgetState(): PersistedWidgetState {
	return {
		version: WIDGET_STATE_VERSION,
		sessionLanguages: [...sessionLanguages],
		files: [...files.values()].map((rec) => ({
			filePath: rec.filePath,
			runners: [...rec.runners.entries()],
			formatters: [...rec.formatters.entries()],
			diagnostics: rec.diagnostics,
			allDiagnostics: rec.allDiagnostics,
			diagnosticCounts: rec.diagnosticCounts,
			hasFinalDiagnosticsSnapshot: rec.hasFinalDiagnosticsSnapshot,
			touchedAt: rec.touchedAt,
		})),
	};
}

/**
 * Restore a {@link PersistedWidgetState} snapshot (#190 resume rehydration).
 * Replaces the in-memory `files` map; ignores snapshots from a different
 * version. Triggers a re-render if a callback is registered.
 */
/**
 * #1186 v1→v2 migration: stamp each entry that lacks a per-entry `observedAt`
 * with the record's `touchedAt` (the single stamp the whole record shared under
 * v1). Non-mutating; entries that already carry a stamp (a v2 record) pass
 * through untouched.
 *
 * #1631 review F3 (v2→v3): also strips `stale` from every entry. A dependency
 * drift demotion is scoped to the session that observed the drift; restoring it
 * verbatim would let a real blocking finding resume as permanently non-blocking
 * (#1348 precedent — see `WIDGET_STATE_VERSION`'s doc comment).
 */
function migrateEntryStamps(
	entries: WidgetDiagnostic[] | undefined,
	recordTouchedAt: number,
): WidgetDiagnostic[] {
	return (entries ?? []).map((d) => {
		// #2275: strip staleDeliveryCount and footerRetired alongside stale — a
		// delivery count (and the footer-hide it earned) without the demotion
		// it counts is meaningless, and a resumed session re-evaluates
		// dependency-drift from scratch (#1631 review F3) same as the `stale`
		// bit itself. A restored footer has shown the row zero times.
		// Fix-round 3 (#2275 review F2): `staleReason` left the round trip
		// unstripped, so a resumed row could carry `staleReason:
		// "dependency-drift"` with `stale` gone — `isDependencyDriftDemoted`
		// reads `stale === true`, so that combination reads as clean today, but
		// the stray reason is still a demotion label with no demotion behind
		// it, the same "meaningless without the bit it counts" shape as the
		// other three fields. Strip it alongside them.
		const {
			stale: _stale,
			staleDeliveryCount: _staleDeliveryCount,
			footerRetired: _footerRetired,
			staleReason: _staleReason,
			...rest
		} = d;
		return rest.observedAt == null
			? { ...rest, observedAt: recordTouchedAt }
			: rest;
	});
}

export function importWidgetState(
	state: PersistedWidgetState | undefined,
): boolean {
	// Accept any known-or-older version and migrate (#1186): reject a missing
	// snapshot, a missing/non-numeric `version` (NaN/undefined/null — the
	// pre-#1186 guard `version !== WIDGET_STATE_VERSION` rejected these, and
	// loosening that would silently admit a malformed/foreign snapshot), or a
	// FUTURE version this build can't understand. Rejecting a v1
	// (pre-per-entry-stamp) file, by contrast, would silently drop all resume
	// diagnostics — so v1..current are accepted and migrated.
	if (
		!state ||
		typeof state.version !== "number" ||
		state.version < 1 ||
		state.version > WIDGET_STATE_VERSION
	) {
		return false;
	}
	files.clear();
	// A resumed session's writeIndex counter starts fresh (#190 rehydration is
	// process-bound like lspServers, see the export above) — any ordering
	// tokens tracked before the restore no longer correspond to anything, so
	// drop them rather than risk a legitimate post-resume write being read as
	// "superseded" against a stale token.
	diagnosticsWriteGuard.clear();
	runnerWriteGuard.clear();
	for (const f of state.files ?? []) {
		// Fold persisted keys through the same normalizer as live writes (#1020),
		// or a persisted forward-slash key stays split from a fresh backslash key
		// across a resumed session — a primary repro condition. Keep a readable
		// display path on the record.
		// #1186 migration: a v1 record's entries have no per-entry `observedAt`.
		// Inherit the record's `touchedAt` (a safe, over-conservative default —
		// the whole record shared that one stamp before), so the per-entry stale
		// gate has a concrete observation time and never treats `undefined` as
		// epoch-0 (which would drop every migrated entry on the first sweep).
		const recordTouchedAt = f.touchedAt ?? Date.now();
		// #1631 review V1: `diagnosticCounts` is DERIVED from `allDiagnostics`
		// everywhere else in this module (see the `countDiagnostics(rec.allDiagnostics)`
		// call sites) — it must be recomputed here too, from the just-migrated
		// (stale-stripped) entries, not restored verbatim from the snapshot. The
		// persisted counts were computed while a finding was still demoted
		// (`blocking: 0`); once F3 strips `stale` so `isBlocking` reports true
		// again, a verbatim count would still say `blocking: 0` for a record
		// whose entries ARE blocking — inverting the one-predicate invariant
		// `isBlocking` exists to hold. Every consumer (`getFileDiagnosticSummaries`,
		// the record-tier classifier, the footer) trusts `diagnosticCounts`, not a
		// live re-scan of the entries, so a derived count out of sync with its own
		// entries is silently wrong everywhere at once.
		const migratedAllDiagnostics = migrateEntryStamps(
			f.allDiagnostics,
			recordTouchedAt,
		);
		files.set(fileMapKey(f.filePath), {
			filePath: f.filePath,
			runners: new Map(f.runners ?? []),
			// Failure entries do NOT survive a session restore (#1348 review):
			// a fmt-failed marker is live advice about THIS session's last
			// attempt; rehydrating one from a snapshot shows a stale failure the
			// current session never observed (and same-mtime fixes would never
			// clear it). Successes rehydrate as before.
			formatters: new Map(
				(f.formatters ?? []).filter(
					([, outcome]) => outcome?.success !== false,
				),
			),
			diagnostics: migrateEntryStamps(f.diagnostics, recordTouchedAt),
			allDiagnostics: migratedAllDiagnostics,
			diagnosticCounts: countDiagnostics(migratedAllDiagnostics),
			hasFinalDiagnosticsSnapshot: f.hasFinalDiagnosticsSnapshot ?? false,
			touchedAt: recordTouchedAt,
		});
	}
	pruneInactiveFileRecords();
	sessionLanguages = state.sessionLanguages ?? [];
	requestRenderFn?.();
	return true;
}

/**
 * The widget's per-file diagnostics as a session store (#190, #3589). The
 * widget is shared by every live session in the process, so it has one cell,
 * this module's state, which outlives the factory re-run: an in-process
 * `/fork`, `/clone` or `/reload` keeps it as the parent left it (#3589 was the
 * fork start clearing it). A resume, a launch and `pi --fork` adopt a
 * sidecar, reconciled with disk first, so a file changed since the save
 * re-scans.
 */
export const widgetStore = defineSessionStore<PersistedWidgetState>({
	name: "widget",
	policy: {
		startup: "adopt",
		new: "reset",
		resume: "adopt",
		fork: "none",
		reload: "none",
	},
	snapshot: () => exportWidgetState(),
	restore: async (_scope, payload, ctx) => {
		clearWidgetState();
		const state = payload as PersistedWidgetState | undefined;
		if (!state?.files) return { itemsIn: 0, itemsKept: 0 };
		// Only a sidecar reaches here (startup, resume), and it carries savedAt.
		const fresh = await dropStaleFiles(state, ctx.savedAt as number);
		importWidgetState(fresh);
		return { itemsIn: state.files.length, itemsKept: fresh.files.length };
	},
	reset: () => clearWidgetState(),
	reason:
		"the diagnostics a conversation's edits produced, which a resume and a relaunch show again",
});

export function setSessionLanguages(langs: string[]): void {
	sessionLanguages = langs;
	requestRender();
}

/** File-kinds detected in use this session (#170 staleness scope). */
export function getSessionLanguages(): string[] {
	return [...sessionLanguages];
}

/**
 * Distinct serverIds with a failed spawn record (#170). Raw — the per-language
 * coverage check (a live sibling) and the in-use staleness filter live in
 * `selectLspStatus`, which joins this against the alive set and session kinds.
 */
export function getFailedLspServerIds(): string[] {
	const ids: string[] = [];
	const seen = new Set<string>();
	for (const rec of lspServers.values()) {
		if (rec.status !== "failed" || seen.has(rec.serverId)) continue;
		seen.add(rec.serverId);
		ids.push(rec.serverId);
	}
	return ids;
}

export function recordFormatter(
	filePath: string,
	formatter: string,
	changed: boolean,
	success: boolean,
	outcome?: FormatterOutcomeKind,
): void {
	const rec = getOrCreate(filePath);
	rec.formatters.set(formatter, { changed, success, outcome });
	rec.touchedAt = Date.now();
	files.set(fileMapKey(filePath), rec);
	requestRender();
}

export function recordRunner(
	filePath: string,
	runnerId: string,
	status: string,
	diagnosticCount: number,
	durationMs?: number,
	writeIndex?: number,
): void {
	const key = fileMapKey(filePath);
	if (!runnerWriteGuard.shouldWrite(key, writeIndex)) return;
	// Advance the final-diagnostics guard too. A runner completion is part of
	// this pipeline's ordered write, even though its immediate effect is only to
	// mark the record pending. This prevents an older final replacement from
	// landing after a newer runner state (and vice versa).
	diagnosticsWriteGuard.shouldWrite(key, writeIndex);
	const rec = getOrCreate(filePath);
	rec.runners.set(runnerId, { status, count: diagnosticCount, durationMs });
	rec.hasFinalDiagnosticsSnapshot = false;
	rec.touchedAt = Date.now();
	files.set(fileMapKey(filePath), rec);
	requestRender();
}

/**
 * Collapse a (possibly multi-line) diagnostic message to a single line.
 * TS2769 / "no overload matches" and many compiler errors are multi-line;
 * embedded newlines/tabs would otherwise render across several widget rows
 * (and break the `L<line>: <message>` inline-blocker format), so flatten all
 * whitespace runs to a single space before storing.
 */
function toSingleLineMessage(message: string | undefined): string {
	return (message ?? "").replace(/\s+/g, " ").trim();
}

/** Build the OSC-8 target used by every stored diagnostic row. */
export function widgetDiagnosticUri(
	filePath: string,
	line?: number,
	column?: number,
): string {
	const base = pathToFileURL(filePath).href;
	return line != null
		? `${base}#L${line}${column != null ? `:${column}` : ""}`
		: base;
}

export function recordDiagnostics(
	filePath: string,
	diagnostics: Array<{
		tool?: string;
		rule?: string;
		id?: string;
		message?: string;
		line?: number;
		column?: number;
		severity?: string;
		semantic?: string;
	}>,
	writeIndex?: number,
	// #1093: when the truth was OBSERVED, not when it's being written. Defaults
	// to `Date.now()` for the per-edit/live path (observed now). A reconcile
	// replaying a CACHED view (e.g. the workspace-diagnostics cache-hit branch in
	// `tools/lsp-diagnostics.ts`) must pass the cache entry's own scan timestamp
	// here — otherwise a repeat "fresh check" that merely re-serves a stale
	// cached view keeps bumping `touchedAt` to now(), permanently disarming
	// `reconcileStaleWidgetFiles`'s `mtimeMs > touchedAt` gate so a resolved
	// finding renders forever (the #1092 touchedAt-re-arming defect).
	observedAt?: number,
): boolean {
	// Drop a write that's superseded by a later same-turn edit to this file
	// whose pipeline finished first (same race class as #555). No cache write,
	// no count/timestamp update, no render trigger — the recorded state must
	// stay exactly as the fresher write left it. `writeIndex` omitted (e.g.
	// the `clients/mcp/analyze.ts` on-demand call site, which has no per-edit
	// ordering token) always proceeds, same as version-less LSP servers in the
	// #555 guard.
	const key = fileMapKey(filePath);
	if (!diagnosticsWriteGuard.shouldWrite(key, writeIndex)) return false;
	// Keep runner state ordered with the final diagnostic replacement. The
	// guards are deliberately advanced in both directions because either verb
	// may be the first completion from a pipeline.
	runnerWriteGuard.shouldWrite(key, writeIndex);

	// Resolve the observation time ONCE (#1186): every incoming entry is stamped
	// with it, and it also seeds the record's `touchedAt`. A fresh write (no
	// `observedAt`) is observed now.
	const observedTs = observedAt ?? Date.now();
	const rec = getOrCreate(filePath, key);
	commitDiagnostics(
		rec,
		filePath,
		normalizeDiagnostics(filePath, diagnostics, observedTs),
		observedTs,
		key,
	);
	return true;
}

/** Map the raw diagnostic shape callers pass into stored {@link WidgetDiagnostic}s.
 * Every produced entry is stamped with `observedTs` (#1186) — the time THIS batch
 * of diagnostics was observed — so the per-entry stale gate can later drop just
 * the entries older than the file's mtime rather than the whole record. */
function normalizeDiagnostics(
	filePath: string,
	diagnostics: Array<{
		tool?: string;
		rule?: string;
		id?: string;
		message?: string;
		line?: number;
		column?: number;
		severity?: string;
		semantic?: string;
	}>,
	observedTs: number,
): WidgetDiagnostic[] {
	return diagnostics.map((d) => {
		const rule = d.rule ?? d.id;
		return {
			severity: d.severity ?? "info",
			semantic: d.semantic,
			message: toSingleLineMessage(d.message),
			line: d.line,
			col: d.column,
			rule,
			tool: d.tool,
			uri: widgetDiagnosticUri(filePath, d.line, d.column),
			observedAt: observedTs,
		} satisfies WidgetDiagnostic;
	});
}

/**
 * The identity a retained suppressed row is matched against a later scan's
 * entries by (#3158), so a scan that reports the finding AGAIN replaces the
 * retained row instead of standing beside it as a duplicate.
 *
 * These are the WEAK ANCHOR's identity parts — `computeWeakAnchor`
 * (`clients/diagnostic-dispositions.ts`) hashes `[tool, rule,
 * normalizeMessage(message)]` over the file — deliberately, because the weak
 * anchor is how the disposition store itself decides which findings a mark
 * covers. Matching at any finer granularity means the store can disagree with
 * the mark that created the row.
 *
 * Round 2 F2: `line` USED to be part of it, and that was the finer granularity
 * the paragraph above forbids. A writer that re-reports the marked finding one
 * line down — `clients/pipeline.ts`'s per-edit `recordDiagnostics`, or
 * `reconcileCascadeNeighborLspErrors`, neither of which runs
 * `reconcileStaleWidgetFiles` — left the retained row standing beside the live
 * one, so a single finding was counted live AND in `suppressed: N`.
 *
 * `computeWeakAnchor` itself is not called here: it needs `cwd` to build its
 * path component, which `commitDiagnostics` does not have and could only get by
 * widening `recordDiagnostics`, `reconcileScanDiagnostics` and
 * `reconcileCorrelatedScanDiagnostics` up through `tools/`. That component is
 * constant across one file record — both sides of this comparison are the same
 * file — so it would discriminate nothing. `normalizeMessage` is the shared
 * derivation from `clients/finding-identity.ts` that the anchor uses, imported
 * rather than re-spelled.
 *
 * #3183: this identity is OCCURRENCE-BLIND, and for a STRICT (`false-positive`)
 * row that is not enough on its own. Two findings of one rule with identical
 * messages on different lines collapse onto it, so a scan reporting only the
 * UNMARKED one matched the marked row and replaced it — the chip lost a mark
 * that was still applying. A collision is therefore resolved by the second half
 * of {@link WidgetDiagnostic.anchorSpan}'s contract, in `retainSuppressedRows`:
 * only a colliding incoming finding sitting ON the marked line is the same
 * finding. That test, not this one, is what keeps the round-2 F2 case above
 * closed — the marked line's TEXT moved, so its span still matches.
 */
function retentionIdentity(d: WidgetDiagnostic): string {
	return JSON.stringify([
		d.tool ?? "",
		d.rule ?? "",
		normalizeMessage(d.message),
	]);
}

/** `filePath`'s current content, or `undefined` when it cannot be read. */
function readContentOrUndefined(filePath: string): string | undefined {
	try {
		return readFileSync(filePath, "utf8");
	} catch {
		// Only reached once this module has established there IS a span-carrying row
		// to ask about, so the record is bounded by that population — and worth
		// making: with no content both callers fall back to the pre-#3183 rules (the
		// per-entry mtime gate, the coarse retention identity), which is the
		// conservative direction but can retire a mark that still stands.
		recordDegradationOnce({
			kind: "widget-mark-anchor-unreadable",
			subject: filePath,
			reason:
				"the marked file could not be read, so its suppressed rows fall back to the file-mtime retirement gate and the footer chip may under-count it",
		});
		return undefined;
	}
}

/**
 * {@link strictAnchorSpansIn} over `filePath`'s current content (#3183), or
 * `undefined` when it cannot be read.
 *
 * Synchronous in both callers, matching `applyCachedDispositions`
 * (`tools/lens-diagnostics.ts`) — the seam that asks the very same question on
 * the very same read path, with `statSync`/`readFileSync`. An async read here
 * would add two unbounded awaits to a module a registered hook handler imports
 * directly (`tests/config/hook-await-bounds.test.ts`) for no behavioural gain.
 */
function readAnchorSpans(filePath: string): Set<string> | undefined {
	const content = readContentOrUndefined(filePath);
	return content === undefined ? undefined : strictAnchorSpansIn(content);
}

/**
 * #3158: carry the record's disposition-tagged rows across a whole-replace
 * write when the incoming set no longer reports them, so a `false-positive` /
 * `suppress` mark keeps contributing to the footer's `suppressed: N` chip. See
 * {@link WidgetDiagnostic.suppressedRetained} for the full lifetime statement.
 *
 * Retained rows are APPENDED after the incoming ones: `capStoredDiagnostics`
 * fills the TUI's display list from the front, so a retained row never evicts a
 * live finding from the rendered set.
 *
 * The tagged-row check comes FIRST so a project with no disposition marks — the
 * overwhelmingly common case, and this runs on the per-edit write path — pays
 * one predicate per stored row and never builds the identity set.
 */
function retainSuppressedRows(
	previous: WidgetDiagnostic[],
	incoming: WidgetDiagnostic[],
	filePath: string,
): WidgetDiagnostic[] {
	const tagged = previous.filter((d) => d.disposition !== undefined);
	if (tagged.length === 0) return incoming;
	const reported = new Map<string, WidgetDiagnostic[]>();
	for (const d of incoming) {
		const id = retentionIdentity(d);
		const bucket = reported.get(id);
		if (bucket) bucket.push(d);
		else reported.set(id, [d]);
	}
	// #3183: the ONE file read on this path, and only for the state the coarse
	// identity genuinely cannot resolve — a strict-anchored row whose identity an
	// incoming finding collides with. Every other write (no marks at all, a mark
	// with no collision, a weak `suppress` mark) stays zero-I/O, which is what
	// keeps this off the per-edit `recordDiagnostics` cost.
	const content = tagged.some(
		(d) => d.anchorSpan !== undefined && reported.has(retentionIdentity(d)),
	)
		? readContentOrUndefined(filePath)
		: undefined;
	const spans =
		content === undefined ? undefined : strictAnchorSpansIn(content);
	const retained = tagged.filter((d) => {
		const collisions = reported.get(retentionIdentity(d));
		// Nothing re-reported this finding, so retention rule 2 has nothing to say.
		if (collisions === undefined) return true;
		// No span to ask (a weak `suppress` mark, or a row from an older build), or
		// the file is unreadable: fall back to the pre-#3183 coarse rule. The safe
		// direction is to UNDER-count, never to leave a phantom duplicate standing
		// beside a live finding.
		if (d.anchorSpan === undefined || spans === undefined) return false;
		// The mark stopped applying — its line is gone from the file — so the
		// colliding finding IS this one, re-reported now that the filter no longer
		// drops it (retirement rule 2, and the same verdict the sweep reaches).
		if (!spans.has(d.anchorSpan)) return false;
		// The mark still applies. Only a collision sitting ON the marked line is
		// the same finding (its line number may have shifted under an edit — #3158
		// round 2 F2); any other is a DIFFERENT occurrence this strict anchor never
		// covered, and replacing the row with it loses a live mark (#3183).
		return !collisions.some(
			(i) => strictAnchorSpan(content, i.line) === d.anchorSpan,
		);
	});
	if (retained.length > MAX_RETAINED_SUPPRESSED_PER_FILE) {
		// Freshest observations win the cap. One record per FILE, never one per
		// dropped row (AGENTS.md "bounded observability"): the chip under-counts
		// by exactly `dropped` for this file until its content changes.
		retained.sort((a, b) => (b.observedAt ?? 0) - (a.observedAt ?? 0));
		recordDegradationOnce({
			kind: "widget-suppressed-retention-capped",
			subject: filePath,
			reason: `${retained.length - MAX_RETAINED_SUPPRESSED_PER_FILE} suppressed row(s) beyond the ${MAX_RETAINED_SUPPRESSED_PER_FILE}-row per-file retention cap are no longer counted by the footer chip`,
		});
		retained.length = MAX_RETAINED_SUPPRESSED_PER_FILE;
	}
	return [
		...incoming,
		...retained.map((d) =>
			d.suppressedRetained ? d : { ...d, suppressedRetained: true as const },
		),
	];
}

/** Store `normalized` as the record's complete diagnostic set: recompute counts,
 * cap the display list, stamp `touchedAt` (at `observedAt` when given, else now
 * — #1093), persist, and re-render. The caller decides what `normalized`
 * contains (a full replace, or a merge — see `reconcileCascadeNeighborLspErrors`). */
function commitDiagnostics(
	rec: FileRecord,
	filePath: string,
	incoming: WidgetDiagnostic[],
	observedAt: number | undefined,
	key = fileMapKey(filePath),
	/**
	 * #3158: apply the suppressed-row retention rule to this write. True for
	 * every seam that hands in a fresh SCAN of the file (`recordDiagnostics` and
	 * both reconciles), false for `reconcileWidgetDisposition`, which re-maps the
	 * record's own current rows and is the seam that RETIRES a retained row —
	 * re-adding what it just dropped would make retirement rule 3 inert.
	 */
	retainSuppressed = true,
): void {
	const normalized = retainSuppressed
		? retainSuppressedRows(rec.allDiagnostics, incoming, filePath)
		: incoming;
	rec.diagnosticCounts = countDiagnostics(normalized);
	rec.diagnostics = capStoredDiagnostics(normalized);
	rec.allDiagnostics = normalized;
	rec.hasFinalDiagnosticsSnapshot = true;
	// Record-level `touchedAt` is the FRESHEST per-entry observation in the merged
	// set (#1186) — drives render recency and the empty-record stale gate. On a
	// merge (`reconcileCascadeNeighborLspErrors`) this is the newest of the
	// preserved + incoming entries, not the (possibly aging) incoming stamp, so a
	// record holding a fresh preserved entry doesn't sort/gate as stale. Empty set
	// falls back to the passed `observedAt` (or now).
	rec.touchedAt = freshestObservation(normalized, observedAt ?? Date.now());
	files.set(key, rec);
	requestRender();
}

/**
 * A diagnostic's compact-count tier (#2414). THE one place every compact
 * finding-count surface classifies severity into a tally bucket — do not
 * re-fold tiers per renderer (widget footer, `lens_diagnostics`' `withIssues`
 * listing/summary, and any future compact surface all import this instead of
 * hand-rolling the same branch).
 *
 * `error`/`warning` are real code defects with a known, bounded
 * false-positive rate (see "Severity policy" in AGENTS.md, #1777) — they
 * drive the footer's ●/! chips and block-worthy counts. `advisory` (`hint` +
 * `info`) is a style opinion: an unaudited authorship rule (complexity,
 * `no-runtime-typeof`, ...) must never present with the same weight as a
 * warning. Before #1777 the dispatch path collapsed all three into
 * `"warning"` at the runner; after #1777 preserved the four LSP/ast-grep
 * tiers end to end, but this classifier still folded `hint`/`info` into the
 * `warnings` tally so a file with only style opinions didn't silently vanish
 * from the footer. #2414 corrects that: advisories no longer inflate
 * `warnings`, but every consumer must still ask "does this file have ANY
 * live finding" via `advisories`, not just `warnings`, so a hint-only file
 * still surfaces in a detailed listing (mode=all's `withIssues`).
 */
export type DiagnosticTier = "error" | "warning" | "advisory";

export function classifyDiagnosticTier(
	d: WidgetDiagnostic,
): DiagnosticTier | undefined {
	if (d.severity === "error") return "error";
	if (d.severity === "warning") return "warning";
	if (d.severity === "hint" || d.severity === "info") return "advisory";
	return undefined;
}

/** Recompute the {blocking, errors, warnings} tally for a diagnostic set.
 * `hint`/`info` tier findings are tallied separately — see
 * {@link classifyDiagnosticTier} and {@link countAdvisories} — and never
 * inflate `warnings` (#2414). */
function countDiagnostics(diags: WidgetDiagnostic[]): {
	blocking: number;
	errors: number;
	warnings: number;
} {
	let blocking = 0;
	let errors = 0;
	let warnings = 0;
	for (const diagnostic of diags) {
		if (diagnostic.disposition) continue;
		if (isBlocking(diagnostic)) blocking++;
		// A past-EOF stale entry keeps its severity for display purposes but is
		// excluded from the error/warning tallies alongside blocking — its cited
		// coordinate is no longer trustworthy, same reasoning as `isBlocking`.
		// A dependency-drift demotion (#1631 criterion 3) is different: the
		// finding itself is still real evidence, only its BLOCKING authority is
		// revoked until re-confirmed, so it stays in the error/warning tally.
		if (
			diagnostic.stale &&
			(diagnostic.staleReason ?? "past-eof") === "past-eof"
		)
			continue;
		const tier = classifyDiagnosticTier(diagnostic);
		if (tier === "error") errors++;
		else if (tier === "warning") warnings++;
		// tier === "advisory" (hint/info): intentionally excluded from the
		// footer's warning tally (#2414) — see `countAdvisories` for the
		// parallel count `getFileDiagnosticSummaries` exposes to
		// `lens_diagnostics` so a hint-only file still shows up as "has issues".
	}
	return { blocking, errors, warnings };
}

/** Count `hint`/`info` tier findings using the same past-EOF exclusion as
 * {@link countDiagnostics} (#2414). Kept as a standalone accessor rather than
 * a new `FileRecord.diagnosticCounts` field — the footer never renders this
 * number, only `getFileDiagnosticSummaries` (mode=all) needs it, to keep a
 * hint-only file from being silently dropped from a detailed listing. */
function countAdvisories(diags: WidgetDiagnostic[]): number {
	let advisories = 0;
	for (const diagnostic of diags) {
		if (
			diagnostic.stale &&
			(diagnostic.staleReason ?? "past-eof") === "past-eof"
		)
			continue;
		if (classifyDiagnosticTier(diagnostic) === "advisory") advisories++;
	}
	return advisories;
}

/**
 * Apply the #1641 past-EOF gate to `rec` in place: demote (never drop) any
 * stored diagnostic whose cited line exceeds the file's CURRENT on-disk line
 * count, then recompute the capped/full diagnostic lists and the counts so
 * every reader (the TUI render loop, `getFileDiagnosticSummaries`,
 * `getFileDiagnostics`) sees one consistent, already-gated record instead of
 * each re-deriving its own verdict. Cheap on the common case: one memoized
 * stat per record (see `getCachedLineCount`), a full recount only when the
 * file's mtime moved since the last check.
 *
 * No `resync` callback here deliberately: this gate runs on the TUI's render
 * path and the bus-publish/mark-tool read accessors, all of which fire far
 * more often than an agent's own edit/tool cadence. Triggering a document
 * resync from every one of those reads would storm the LSP with didOpen calls
 * for a file whose drift hasn't yet been fixed. `tools/lens-diagnostics.ts`'s
 * `formatAllMode` — an explicit, agent-invoked tool call — is the resync
 * trigger point (#1641 criterion 2); this gate still demotes/logs on its own.
 *
 * The gate RE-DERIVES every entry's `stale` flag on every call — it is never
 * a one-way latch. A transient shrink that later restores (truncate-then-
 * write, a formatter pass, a checkout) un-demotes on its own next read, so
 * this always persists the freshly-derived array back into the record, not
 * only when `demotedCount` (which counts RISING edges only, for telemetry)
 * is nonzero.
 */
function applyPastEofGate(
	rec: FileRecord,
	lineCountCache?: LineCountCache,
): void {
	if (rec.allDiagnostics.length === 0) return;
	const { diagnostics } = demotePastEofDiagnostics({
		store: "widget-state",
		cwd: process.cwd(),
		filePath: rec.filePath,
		diagnostics: rec.allDiagnostics,
		lineCountCache,
	});
	rec.allDiagnostics = diagnostics;
	rec.diagnostics = capStoredDiagnostics(diagnostics);
	rec.diagnosticCounts = countDiagnostics(diagnostics);
}

/** The newest per-entry `observedAt` in `diags`, or `fallback` when empty (or no
 * entry carries a stamp). Used as the record-level `touchedAt` (#1186). */
function freshestObservation(
	diags: WidgetDiagnostic[],
	fallback: number,
): number {
	let newest: number | undefined;
	for (const d of diags) {
		if (
			d.observedAt != null &&
			(newest === undefined || d.observedAt > newest)
		) {
			newest = d.observedAt;
		}
	}
	return newest ?? fallback;
}

/**
 * A stored diagnostic that came from a language SERVER (tsserver, pyright, …)
 * AND is an error/blocking finding. `convertLspDiagnostics` tags every
 * language-server diagnostic with `tool: "lsp"` and `retagAuxiliaryDiagnostics`
 * re-tags auxiliary-LSP findings (opengrep/ast-grep/zizmor/typos) to their real
 * tool id, so `tool === "lsp"` uniquely identifies a genuine language-server
 * entry. Used by the cascade merge below to decide which existing entries an
 * errors-only LSP re-check is entitled to replace.
 */
function isLspErrorEntry(d: WidgetDiagnostic): boolean {
	return (
		d.tool === "lsp" && (d.semantic === "blocking" || d.severity === "error")
	);
}

/**
 * Reconcile a CONFIRMED cascade neighbor re-check (#1093) into the footer,
 * MERGING rather than whole-replacing (unlike `recordDiagnostics`).
 *
 * The cascade only re-checks a neighbor through its LANGUAGE SERVER, and only
 * for ERRORS (`severity === 1`; see `clients/dispatch/integration.ts`). A plain
 * full-replace would therefore erase the neighbor's live findings from OTHER
 * sources that the cascade never re-examined — biome/ruff/ast-grep runner
 * findings, and even the language server's own WARNINGS — turning a
 * cross-file-error re-check into a silent false-clean for everything else
 * (#533). So we replace ONLY the existing LSP-error entries
 * (`isLspErrorEntry`) with the cascade's fresh LSP errors and preserve
 * everything else verbatim. A stale LSP warning or biome finding therefore
 * survives an errors-only cascade — correct, because this check never looked at
 * it; it self-corrects on the next per-edit dispatch or a `lens_diagnostics`
 * scan (which DO re-examine every source).
 *
 * Only ever call this for a CONFIRMED result (a valid passive snapshot or a
 * completed, NON-inconclusive active touch — #571). `writeIndex` and
 * `observedAt` behave exactly as in `recordDiagnostics`.
 */
export function reconcileCascadeNeighborLspErrors(
	filePath: string,
	lspErrorDiagnostics: Array<{
		tool?: string;
		rule?: string;
		id?: string;
		message?: string;
		line?: number;
		column?: number;
		severity?: string;
		semantic?: string;
	}>,
	writeIndex?: number,
	observedAt?: number,
): void {
	const key = fileMapKey(filePath);
	if (!diagnosticsWriteGuard.shouldWrite(key, writeIndex)) return;
	runnerWriteGuard.shouldWrite(key, writeIndex);
	// #1186: the INCOMING LSP errors are stamped at THIS observation time
	// (`observedAt`, e.g. an aging passive snapshot's `entry.ts`, or now for a
	// fresh active touch). The PRESERVED entries keep their OWN prior per-entry
	// `observedAt` — a fresh per-edit finding preserved through this errors-only
	// merge is NOT re-aged to the incoming stamp. That per-entry split is exactly
	// what lets `reconcileStaleWidgetFiles` drop the stale incoming entry while
	// keeping the newer preserved one, instead of dropping the whole record.
	const observedTs = observedAt ?? Date.now();
	const rec = getOrCreate(filePath);
	const incoming = normalizeDiagnostics(
		filePath,
		lspErrorDiagnostics,
		observedTs,
	);
	const preserved = rec.allDiagnostics.filter((d) => !isLspErrorEntry(d));
	commitDiagnostics(rec, filePath, [...incoming, ...preserved], observedTs);
}

/**
 * Reconcile a diagnostics result obtained OUTSIDE the per-edit dispatch
 * pipeline — a `lens_diagnostics` mode=full workspace scan, or a standalone
 * `lsp_diagnostics` on-demand check — into the footer cache (#571).
 *
 * `recordDiagnostics` is otherwise only reachable from `pipeline.ts`'s
 * per-edit dispatch, so a file that becomes stale/fresh purely because of a
 * change to some OTHER file it depends on (and is never itself re-edited
 * through pi-lens) has no path to correct the footer — a full scan proves
 * the fresher truth but had nowhere to put it. This is that path, shared by
 * both call sites so there's exactly one place that decides whether a scan
 * result is trustworthy enough to write.
 *
 * `confirmed` MUST be false for any result the caller can't vouch for — a
 * timed-out/inconclusive LSP check (see #570) must never present as
 * "confirmed clean" in the footer, and must not clobber a real prior
 * confirmed-dirty entry either. Non-confirmed results are silently skipped,
 * leaving whatever the footer already had (stale-but-real beats
 * fresh-but-fabricated).
 *
 * `writeIndex` should be a freshly-drawn token from the same monotonic
 * source the per-edit pipeline uses (`RuntimeCoordinator.nextWriteIndex()`)
 * so `recordDiagnostics`'s existing `WriteOrderingGuard` (#555) can tell a
 * scan-originated write apart from a concurrent, genuinely newer per-edit
 * write for the same file — an omitted `writeIndex` always proceeds (same
 * version-less fallback `recordDiagnostics` already documents), which is
 * only safe for callers with no ordering token to give (e.g. tests).
 *
 * `observedAt` (#1093) is the wall-clock time the diagnostics were actually
 * OBSERVED — pass it whenever the reconciled result is a replay of an older
 * CACHED observation (the workspace-diagnostics cache-hit branch), so
 * `touchedAt` records when the truth was seen, not when it was written. Omit
 * it for genuinely fresh observations (a just-completed touch/scan), which are
 * observed now.
 */
export function reconcileScanDiagnostics(
	filePath: string,
	diagnostics: Array<{
		tool?: string;
		rule?: string;
		id?: string;
		message?: string;
		line?: number;
		column?: number;
		severity?: string;
		semantic?: string;
	}>,
	confirmed: boolean,
	writeIndex?: number,
	observedAt?: number,
): boolean {
	if (!confirmed) return false;
	return recordDiagnostics(filePath, diagnostics, writeIndex, observedAt);
}

/**
 * Commit the already-correlated result of a full diagnostics scan.
 *
 * Unlike {@link reconcileScanDiagnostics}, this seam accepts widget diagnostics
 * that have already been merged across producing lanes. `lens_diagnostics`
 * uses it after correlating the confirmed LSP sweep, the cheap project scan,
 * and retained widget rows. This prevents a broken LSP lane from hiding
 * independently-produced `ast-grep-napi` findings in the widget count (#1888).
 * Existing per-entry observation times survive the merge; newly-added project
 * rows inherit the scan's observation time.
 */
export function reconcileCorrelatedScanDiagnostics(
	filePath: string,
	diagnostics: WidgetDiagnostic[],
	writeIndex?: number,
	observedAt?: number,
): void {
	const key = fileMapKey(filePath);
	if (!diagnosticsWriteGuard.shouldWrite(key, writeIndex)) return;
	runnerWriteGuard.shouldWrite(key, writeIndex);
	const observedTs = observedAt ?? Date.now();
	const correlated = diagnostics.map((diagnostic) => ({
		...diagnostic,
		observedAt: diagnostic.observedAt ?? observedTs,
	}));
	commitDiagnostics(
		getOrCreate(filePath, key),
		filePath,
		correlated,
		observedTs,
		key,
	);
}

/**
 * Drop widget entries whose file changed on disk after pi-lens last recorded
 * them (`mtimeMs > touchedAt` → the recorded diagnostics predate the current
 * content → stale) or that no longer exist. Keeps `lens_diagnostics` from
 * surfacing findings the agent already fixed (or that an external edit
 * invalidated). Async with concurrent stats — call on read, never on the typing
 * path. Returns how many entries were dropped (so callers can tell the agent
 * those files changed and need a `mode=full` rescan rather than reading as
 * clean).
 */
export async function reconcileStaleWidgetFiles(): Promise<number> {
	const entries = [...files.entries()];
	const verdicts = await Promise.all(
		// `mapKey` is the normalized `files` key (used for deletion); stat the
		// record's real display path, not the lowercased key (#1020).
		entries.map(async ([mapKey, rec]) => {
			let mtimeMs: number;
			try {
				mtimeMs = (await stat(rec.filePath)).mtimeMs;
			} catch {
				return { mapKey, action: "drop" as const }; // deleted / unreadable → drop
			}
			// A clean record (no findings) has no per-entry stamps to consult —
			// gate it on the record's own `touchedAt` exactly as before, so a ✓
			// entry for a file that changed on disk still drops.
			//
			// #1631 review F11 follow-up: a THIRD site hitting the same Windows
			// mtime-vs-`Date.now()` skew F2 named for `blocker-freshness.ts` and
			// `reconcileStaleWidgetDependencyBlockers` — a file's mtime can lead
			// `Date.now()` by up to ~11.4ms measured (#1491/#1498 precedent), so a
			// record touched immediately after its own write dropped here at +1ms
			// with zero real drift. Found investigating F11: `lens-diagnostics-
			// mode-all-freshness.test.ts`'s "control" case (and its sibling) failed
			// under this gate, not from cross-test state. Same tolerance, same
			// constant, for the same reason.
			if (rec.allDiagnostics.length === 0) {
				return freshnessFromMtime({ mtimeMs, referenceMs: rec.touchedAt })
					.verdict === "stale"
					? { mapKey, action: "drop" as const }
					: { mapKey, action: "keep" as const };
			}
			// #1186 per-ENTRY gate: drop only the entries observed BEFORE the file's
			// current mtime; keep the rest. A merged record can hold a fresh
			// preserved entry beside an entry replayed from an aging snapshot, so a
			// per-RECORD gate over-cleared the whole record (the residual documented
			// at dispatch/integration.ts). A missing per-entry stamp (a migrated
			// pre-#1186 record) inherits the record's `touchedAt`. Tolerance matches
			// the Windows host-clock skew rationale above.
			const mtimeStale = (d: WidgetDiagnostic): boolean =>
				freshnessFromMtime({
					mtimeMs,
					referenceMs: d.observedAt ?? rec.touchedAt,
				}).verdict === "stale";
			// #3183: a disposition-tagged row carrying a strict anchor span is gated
			// on its MARK, not on the file's mtime (retirement rule 1 — see
			// `WidgetDiagnostic.suppressedRetained`): it survives while the marked
			// LINE is still somewhere in the file, and is retired when it is not.
			// The content read is gated on a span-carrying row the mtime gate WOULD
			// have dropped — the only state where reading can change an outcome — so
			// the debounced render sweep stays off the disk both for a file with no
			// marks and for a marked file nothing has touched.
			const spans = rec.allDiagnostics.some(
				(d) => d.anchorSpan !== undefined && mtimeStale(d),
			)
				? readAnchorSpans(rec.filePath)
				: undefined;
			const survivors = rec.allDiagnostics.filter((d) =>
				d.anchorSpan !== undefined && spans !== undefined
					? spans.has(d.anchorSpan)
					: !mtimeStale(d),
			);
			if (survivors.length === rec.allDiagnostics.length) {
				return { mapKey, action: "keep" as const }; // nothing stale
			}
			if (survivors.length === 0) {
				return { mapKey, action: "drop" as const }; // every entry stale → drop record
			}
			return { mapKey, action: "prune" as const, survivors };
		}),
	);
	let dropped = 0;
	for (const v of verdicts) {
		if (v.action === "keep") continue;
		if (v.action === "drop") {
			files.delete(v.mapKey);
			dropped += 1;
			continue;
		}
		// prune: the file changed and shed its stale entries but retains fresher
		// ones — keep the record, recompute counts/cap from the survivors, and
		// still count it as a changed file so the agent is told to rescan.
		const rec = files.get(v.mapKey);
		if (rec) {
			rec.allDiagnostics = v.survivors;
			rec.diagnostics = capStoredDiagnostics(v.survivors);
			rec.diagnosticCounts = countDiagnostics(v.survivors);
		}
		dropped += 1;
	}
	if (dropped > 0) requestRenderFn?.();
	return dropped;
}

/**
 * Dependency-axis freshness gate for the session diagnostics store that feeds
 * `lens_diagnostics mode=all` (and the footer widget) — the second #1631 surface.
 *
 * `reconcileStaleWidgetFiles` (above) already drops a record whose OWN file changed
 * on disk after the diagnostic was observed. It cannot see the cross-file case: the
 * diagnosed file is untouched, but a dependency it imports was fixed out-of-band, so
 * the recorded blocker is stale yet replays on every `mode=all`. This reconcile
 * resolves each blocking record's forward imports and, when one drifted after a
 * blocking diagnostic was observed, demotes that diagnostic (`stale = true`) rather
 * than dropping it (#1419). Own-file staleness stays `reconcileStaleWidgetFiles`'
 * job; the two reconciles are paired at the `mode=all` read site.
 *
 * Scope (#1631 review F4): only demotes findings with `tool === "lsp"`. An
 * ast-grep secret, a govulncheck CVE, or any other non-language-server finding is
 * not invalidated by an import graph changing — its truth doesn't depend on what
 * the file imports — so it stays fully blocking through a dependency edit.
 *
 * Resolution boundary (#1631 review F8): shares `collectForwardImportMtimes` with
 * the inline-blocker sweep, so it shares that module's static-import-only
 * boundary too — see `blocker-freshness.ts`'s module doc for the dynamic
 * `import()`/`require()` gap.
 *
 * Returns per-call counts: `demoted` blocking diagnostics and `truncatedImports`
 * records whose import list exceeded the drift-check cap (#1631 review F7 — see
 * `blocker-freshness.ts`'s `MAX_DRIFT_CHECK_IMPORTS`). Never throws on a
 * per-record failure: an unresolvable import list simply leaves the record
 * untouched.
 */
export interface WidgetDependencyBlockerReconcileResult {
	demoted: number;
	truncatedImports: number;
}

export async function reconcileStaleWidgetDependencyBlockers(
	cwd: string,
	turnIndex?: number,
): Promise<WidgetDependencyBlockerReconcileResult> {
	let demoted = 0;
	let truncatedImports = 0;
	for (const [, rec] of files.entries()) {
		// #1631 review F4: narrow demotion to LSP-sourced findings. The import-closure
		// drift check only knows how to reason about IMPORT graphs — an ast-grep
		// hardcoded-secret or a govulncheck CVE finding doesn't stop being true because
		// a file this diagnostic's file imports changed; only a language-server verdict
		// (`tool === "lsp"`, the same predicate `isLspErrorEntry` above uses) is actually
		// invalidated by that shape of drift. Documented trade: a non-LSP blocking
		// finding on a file with drifted imports stays fully authoritative until its own
		// content changes or it is explicitly re-run.
		if (!rec.allDiagnostics.some((d) => isBlocking(d) && d.tool === "lsp"))
			continue;
		let importMtimes: Array<{ path: string; mtimeMs: number }> = [];
		try {
			const result = await collectForwardImportMtimes(
				cwd,
				rec.filePath,
				undefined,
				turnIndex,
			);
			importMtimes = result.mtimes;
			if (result.truncated) truncatedImports += 1;
		} catch {
			importMtimes = [];
		}
		if (importMtimes.length === 0) continue;
		let changed = false;
		for (const d of rec.allDiagnostics) {
			if (!isBlocking(d) || d.tool !== "lsp") continue;
			const baseline = d.observedAt ?? rec.touchedAt;
			// +50ms tolerance (#1631 review F2): a whole-millisecond `Date.now()`
			// baseline vs. sub-millisecond mtime precision only needs +1ms, but on
			// Windows a file's mtime can LEAD `Date.now()` by up to ~11.4ms (measured
			// across 200 writes; #1491/#1498 precedent for the same host-clock skew).
			// +1ms produced 42 false demotions in 50 runs on Windows; +50ms clears the
			// measured skew while staying far below the gap between real edits.
			if (
				importMtimes.some(
					(im) =>
						freshnessFromMtime({
							mtimeMs: im.mtimeMs,
							referenceMs: baseline,
						}).verdict === "stale",
				)
			) {
				d.stale = true;
				d.staleReason = "dependency-drift";
				changed = true;
				demoted += 1;
			}
		}
		if (changed) {
			rec.diagnosticCounts = countDiagnostics(rec.allDiagnostics);
			rec.diagnostics = capStoredDiagnostics(rec.allDiagnostics);
		}
	}
	if (demoted > 0) requestRenderFn?.();
	return { demoted, truncatedImports };
}

/**
 * #1790: sweep-population feed for `sweepInlineBlockerFreshness` (the turn-end
 * gate in `clients/blocker-freshness.ts`). That sweep's population was built
 * solely from `RuntimeCoordinator`'s inline-blocker map — a live-dispatch-only
 * store. A workspace-diagnostics CACHE HIT never touches that map; it calls
 * `reconcileScanDiagnostics` straight into `files` here (the cache-serve branch
 * in `tools/lsp-diagnostics.ts`), so a cache-served blocking row could render in
 * the widget while the turn-end sweep's `total` count never saw it (the live
 * 2026-08-20 dogfood: `total:1 kept:1` against five stale cache-served blocking
 * rows on screen).
 *
 * One entry per file with at least one CURRENTLY blocking (non-stale),
 * LSP-sourced diagnostic — the same provenance narrowing
 * `reconcileStaleWidgetDependencyBlockers` already applies, so every row this
 * feeds into the sweep is one its `isLspSourced` gate would keep anyway.
 * `recordedAtMs` is the EARLIEST `observedAt` among them: the conservative
 * baseline, since using the latest could hide drift that predates an earlier
 * diagnostic's own observation.
 */
export function getWidgetBlockingFilesForSweep(): Array<{
	filePath: string;
	recordedAtMs: number;
}> {
	const out: Array<{ filePath: string; recordedAtMs: number }> = [];
	for (const rec of files.values()) {
		let earliest: number | undefined;
		for (const d of rec.allDiagnostics) {
			if (!isBlocking(d) || d.tool !== "lsp") continue;
			const observedAt = d.observedAt ?? rec.touchedAt;
			if (earliest === undefined || observedAt < earliest)
				earliest = observedAt;
		}
		if (earliest !== undefined)
			out.push({ filePath: rec.filePath, recordedAtMs: earliest });
	}
	return out;
}

/**
 * #1790: demote every currently-blocking, LSP-sourced diagnostic for `filePath`
 * to stale (#1419 demote-not-drop). Called by the turn-end sweep once its own
 * drift check (`detectDrift`/`collectForwardImportMtimes`, shared with the
 * inline-blocker branch) independently confirms drift for a file that reached
 * the sweep's population through `getWidgetBlockingFilesForSweep` rather than an
 * inline blocker. Same store and same write `reconcileStaleWidgetDependencyBlockers`
 * already performs per-diagnostic — this is the single-file entry point the
 * sweep drives once ITS check (not a second implementation of the check) says
 * to. Returns true iff something changed.
 *
 * #1790 review F4 (latent): unlike `reconcileStaleWidgetDependencyBlockers`, which
 * checks drift per-diagnostic against EACH diagnostic's own `observedAt`, this
 * demotes every currently-blocking LSP diagnostic for the file against the ONE
 * file-level baseline `getWidgetBlockingFilesForSweep` computed (the earliest
 * `observedAt` among them) — because the sweep's `detectDrift` contract is
 * file-level, not per-diagnostic. That is safe ONLY as long as every LSP
 * diagnostic on a `FileRecord` shares (or is more conservative than) that
 * earliest stamp, which holds today because every writer that populates
 * `allDiagnostics` (`recordDiagnostics`, `reconcileCascadeNeighborLspErrors`)
 * replaces the file's LSP errors wholesale with one `observedAt` per write. If a
 * future writer ever merges LSP diagnostics with genuinely MIXED per-entry
 * stamps on one record, this function would over-demote entries observed after
 * the earliest one drifted — re-derive per-diagnostic (mirroring
 * `reconcileStaleWidgetDependencyBlockers`) rather than assume the single
 * baseline still holds.
 */
export function markWidgetFileBlockersStale(
	filePath: string,
	reason: "dependency-drift",
): boolean {
	const rec = files.get(fileMapKey(filePath));
	if (!rec) return false;
	let changed = false;
	for (const d of rec.allDiagnostics) {
		if (!isBlocking(d) || d.tool !== "lsp") continue;
		d.stale = true;
		d.staleReason = reason;
		changed = true;
	}
	if (changed) {
		rec.diagnosticCounts = countDiagnostics(rec.allDiagnostics);
		rec.diagnostics = capStoredDiagnostics(rec.allDiagnostics);
		requestRenderFn?.();
	}
	return changed;
}

/**
 * #2275: a dependency-drift demotion the footer is still allowed to draw —
 * the one predicate the render marker, the delivery counter and the
 * footer-hide all ask, so "which rows does this cap govern" cannot drift
 * apart between them.
 */
function isDependencyDriftDemoted(d: WidgetDiagnostic): boolean {
	return (
		d.stale === true &&
		d.staleReason === "dependency-drift" &&
		d.footerRetired !== true
	);
}

/**
 * #2275 review F1: take (and clear) the files whose dependency-drift
 * demotions the footer actually RENDERED since the last call — the delivery
 * population `runtime-turn.ts`'s per-turn cap step walks at turn end.
 *
 * Deliberately NOT a store-wide query over everything currently demoted.
 * `renderWidget` serves one record per pass, so a store-wide walk charged a
 * delivery to every demoted file every turn — including files the footer had
 * never shown and one demoted moments earlier by the same turn end, which
 * also made the ledger's "capped after N deliveries" overstate N by one.
 * Draining here is what makes many repaints within one turn count as the one
 * delivery they are, and a turn with no repaint count as none.
 */
export function drainRenderedDependencyDriftFilePaths(): string[] {
	const out = [...renderedDependencyDriftFiles];
	renderedDependencyDriftFiles.clear();
	return out;
}

/**
 * #2275: commit one more RENDERED delivery of `filePath`'s
 * dependency-drift-demoted diagnostics. Every qualifying entry on the record
 * advances together — `markWidgetFileBlockersStale` demotes them as one
 * batch per file, so they share one delivery history, mirroring that
 * write's own file-level scope. Returns the new count, or 0 when the file
 * has nothing this cap governs (never demoted, or already footer-retired —
 * a hidden row is delivered no more, so it must stop advancing).
 */
export function incrementWidgetDependencyDriftDelivery(
	filePath: string,
): number {
	const rec = files.get(fileMapKey(filePath));
	if (!rec) return 0;
	let next = 0;
	for (const d of rec.allDiagnostics) {
		if (isDependencyDriftDemoted(d)) {
			next = (d.staleDeliveryCount ?? 0) + 1;
			d.staleDeliveryCount = next;
		}
	}
	return next;
}

/**
 * #2275 review F2: retire every dependency-drift-demoted diagnostic on
 * `filePath` once its delivery cap is reached — by HIDING it from the
 * footer, not by dropping it.
 *
 * `RuntimeCoordinator.retireDemotedDependencyDriftBlocker` can delete its
 * whole `_pendingInlineBlockers` record because that store backs exactly one
 * surface (the turn-end advisory text). This store does not: `allDiagnostics`
 * is also what `getFileDiagnosticSummaries` serves to `lens_diagnostics
 * mode=all` and what `lens_diagnostic_mark` cross-checks to reanchor. Removing
 * the entry there turned an unconfirmed LSP error into a CLEAN read and took
 * it out of the error tally #1631 requires it to stay in. So the cap marks
 * `footerRetired` and leaves everything else — severity, counts, the
 * `stale`/`dependency-drift` demotion — exactly as it was; mode=all carries
 * the "capped, still confirmable" wording in its own note. Returns true iff
 * something changed (idempotent on a second call).
 */
export function retireWidgetDependencyDriftBlockers(filePath: string): boolean {
	const rec = files.get(fileMapKey(filePath));
	if (!rec) return false;
	let changed = false;
	for (const d of rec.allDiagnostics) {
		if (isDependencyDriftDemoted(d)) {
			d.footerRetired = true;
			changed = true;
		}
	}
	if (!changed) return false;
	// The record's severity tallies are unchanged by design (the finding is
	// still an error, still non-blocking) — only what the footer draws moves.
	// Fix-round 3 (#2275 review F1): this delete is live only for the
	// multi-file drain re-render case — `drainRenderedDependencyDriftFilePaths`
	// already clears the whole Set before this loop starts, so by the time a
	// given `wPath` reaches this call its own entry is normally long gone. It
	// only does something when a render for a DIFFERENT file interleaves
	// between the drain and this retire (adding `rec.filePath` back to the
	// Set mid-loop) or a render fires between retirement and the caller's next
	// drain — either way, defensive: it keeps a just-retired file from being
	// double-drained (and double-charged) on the next pass.
	renderedDependencyDriftFiles.delete(rec.filePath);
	requestRenderFn?.();
	return true;
}

/**
 * Keep the TUI honest (#298 follow-up). `reconcileStaleWidgetFiles` drops
 * widget entries whose file changed on disk after they were last recorded
 * (i.e. diagnostics the agent already fixed) — but it was only ever wired
 * into the `lens_diagnostics` tool, so the widget rendered cached diagnostics
 * verbatim and kept showing fixed errors until `lens_diagnostics` was run by
 * hand. This debounced scheduler fires it from the widget render path (see
 * `mountLensWidget` in index.ts) so stale entries self-correct. The debounce
 * collapses the burst of renders that accompany a save into a single sweep.
 */
let staleReconcileTimer: ReturnType<typeof setTimeout> | null = null;
export const STALE_RECONCILE_DEBOUNCE_MS = 1500;
export function scheduleStaleReconcile(): void {
	if (staleReconcileTimer !== null) return;
	staleReconcileTimer = setTimeout(() => {
		staleReconcileTimer = null;
		void reconcileStaleWidgetFiles().catch(() => {});
	}, STALE_RECONCILE_DEBOUNCE_MS);
	// Don't keep the process alive solely for this background sweep.
	staleReconcileTimer?.unref?.();
}

/** Summary of current diagnostic counts across all files in the widget. */
export interface FileDiagnosticSummary {
	filePath: string;
	/** Projected by lens_diagnostics from the shared LSP tool-cwd seam. */
	resolvedCwd?: string;
	blocking: number;
	errors: number;
	warnings: number;
	/** `hint`/`info` tier findings — style opinions, never folded into
	 * `warnings` (#2414). A file whose only findings are advisories still has
	 * `advisories > 0` so it is not silently dropped from a detailed listing. */
	advisories: number;
	hasFinalSnapshot: boolean;
	/**
	 * The full, uncapped LIVE diagnostics for this file (not limited by the TUI's
	 * per-file storage cap). `blocking + errors + warnings` may exceed
	 * `diagnostics.length` because a single diagnostic can be both blocking and
	 * an error — these are the actual records, deduplicated by the runners.
	 *
	 * `disposition`-tagged rows are NOT here (#3183): they are what the
	 * `suppressed: N` chip counts, not findings the last scan reported. See
	 * {@link getFileDiagnosticSummaries}.
	 */
	diagnostics: WidgetDiagnostic[];
}

/**
 * Return current diagnostics for every file pi-lens has seen this session.
 * Used by lens_diagnostics tool (mode: "all"). Exposes the FULL per-file
 * diagnostic set — decoupled from the widget's display cap — so the agent sees
 * everything, not just the 12 the TUI keeps for rendering.
 *
 * #3183: "everything" means every row a live scan stands behind.
 * `disposition`-tagged rows are the store's own bookkeeping for a mark — the
 * scan that produced this record did not report them — and they are excluded
 * here. That is the same predicate `countDiagnostics` and `isBlocking` have
 * always used, so this makes the projected array agree with the counts beside
 * it; before #3183 the array disagreed, and once retirement rule 1 let a row
 * outlive the file's mtime, `applyCachedDispositions` reached it in the
 * WEAK-fallback branch — which can never match a STRICT `false-positive`
 * anchor — and `mode=all` served a marked finding as a live warning (#3158 AC3).
 * The exclusion lives HERE, at the one projection every cache-only surface and
 * the mode=full merge read, rather than as a second disposition rule inside
 * `summarizeDiagnostics`' tally: that tally still skips `stale` only, and the
 * disposition filter still reaches it pre-applied through the shared
 * `applyCachedDispositions` seam.
 *
 * Deliberately NOT applied to {@link getFileDiagnostics}, the per-file read:
 * `reconcileWidgetDisposition` needs the tagged rows to enforce retirement
 * rule 3, and `lens_diagnostic_mark`'s cross-check re-marks through them.
 */
export function getFileDiagnosticSummaries(): FileDiagnosticSummary[] {
	return [...files.values()].map((rec) => {
		applyPastEofGate(rec);
		const live = rec.allDiagnostics.filter((d) => d.disposition === undefined);
		return {
			filePath: rec.filePath,
			blocking: rec.diagnosticCounts.blocking,
			errors: rec.diagnosticCounts.errors,
			warnings: rec.diagnosticCounts.warnings,
			advisories: countAdvisories(live),
			hasFinalSnapshot: rec.hasFinalDiagnosticsSnapshot,
			diagnostics: live.map((d) => ({ ...d })),
		};
	});
}

/**
 * How many {@link WidgetDiagnostic.suppressedRetained} rows this file's record
 * is currently carrying (#3158 round 2 F4).
 *
 * The success-path counterpart of `widget-suppressed-retention-capped`: the
 * ledger only hears about retention when the per-file cap TRUNCATES it, so
 * nothing observed the healthy case. `tools/lsp-diagnostics.ts` folds this into
 * the `lsp_probe_disposition_filter` phase it already emits once per filtered
 * file per scan, so the count is bounded by that record's existing cardinality
 * — never one row per retained finding.
 *
 * Deliberately not {@link getFileDiagnostics}: that applies the past-EOF gate,
 * which can `stat` the file. This is a map lookup plus a count over rows the
 * caller's own scan just filtered, so it adds no I/O to the probe path.
 */
export function countRetainedSuppressedRows(filePath: string): number {
	const rec = files.get(fileMapKey(filePath));
	if (!rec) return 0;
	let n = 0;
	for (const d of rec.allDiagnostics) if (d.suppressedRetained) n += 1;
	return n;
}

/**
 * Return the current FULL (uncapped) diagnostic set for a single file, as
 * last recorded by {@link recordDiagnostics} — the same `allDiagnostics`
 * store `getFileDiagnosticSummaries` exposes per-file, without paying for a
 * whole-session snapshot. Used by the #502 `pilens:diagnostics` bus producer
 * (`clients/bus-publish.ts`), which reads this immediately after
 * `recordDiagnostics` writes it so the emitted event reflects the write
 * batch's FINAL diagnostic state (post-format, post-autofix, post-dispatch —
 * see pipeline.ts call order). Returns `undefined` when the file has never
 * been recorded (caller must not confuse "never seen" with "seen and clean";
 * an explicit `[]` from `recordDiagnostics` is a real empty array here).
 *
 * The `files` map key is normalized through `fileMapKey` (#1020), so any path
 * form of the same file — forward-slash, backslash, or a different Windows
 * drive-letter case — resolves to the same record. This read-side fold MUST
 * stay identical to the write-side fold, or a file recorded under one form
 * would silently read as `undefined` under another (e.g. via bus-publish).
 */
export function getFileDiagnostics(
	filePath: string,
): WidgetDiagnostic[] | undefined {
	const rec = files.get(fileMapKey(filePath));
	if (!rec) return undefined;
	applyPastEofGate(rec);
	return rec.allDiagnostics.map((d) => ({ ...d }));
}

/** @internal Test-only helpers. Do not use in production code. */
export const __testing = {
	getWidgetStateSnapshot(): {
		files: Array<{
			filePath: string;
			storedDiagnostics: number;
			blocking: number;
			errors: number;
			warnings: number;
		}>;
	} {
		return {
			files: [...files.values()].map((rec) => ({
				filePath: rec.filePath,
				storedDiagnostics: rec.diagnostics.length,
				blocking: rec.diagnosticCounts.blocking,
				errors: rec.diagnosticCounts.errors,
				warnings: rec.diagnosticCounts.warnings,
			})),
		};
	},
};

export function recordLsp(
	serverId: string,
	root: string,
	status: "spawn_start" | "spawn_success" | "spawn_failed" | "unavailable",
	durationMs?: number,
): void {
	const normalizedRoot = normalizeMapKey(root);
	const key = `${serverId}@${normalizedRoot}`;
	const mapped =
		status === "spawn_start"
			? "spawning"
			: status === "spawn_success"
				? "ready"
				: "failed";
	lspServers.set(key, { serverId, root, status: mapped, durationMs });
	requestRender();
}

// ── Render ────────────────────────────────────────────────────────────────────

const HORIZONTAL_MIN_WIDTH = 70;

// #3959: compact summary header. The tally is this line's primary datum, so
// the language list gets only the leftover width and is truncated first — a
// whole-line fitLine truncation eats the totals from the tail.
function fitCompactHeader(
	width: number,
	label: string,
	languages: string,
	chip: string,
	summary: string,
): string {
	const tail = chip + (summary ? "  " + summary : "");
	const langBudget = width - visibleWidth(` ${label}`) - visibleWidth(tail);
	const langs =
		languages && langBudget >= 4
			? "  " + fitLine(languages, langBudget - 2, "…")
			: "";
	return fitLine(` ${label}${langs}${tail}`, width);
}

export function renderWidget(
	width: number,
	theme: {
		fg: (color: string, s: string) => string;
	},
	// #3959: one-line summary switch (ui.compactWidget / --lens-compact-widget).
	// An options object instead of a boolean flag parameter, per no-flag-argument.
	opts?: { compact?: boolean },
): string[] {
	const dim = (s: string) => theme.fg("dim", s);
	const red = (s: string) => theme.fg("error", s);
	const yellow = (s: string) => theme.fg("warning", s);
	const green = (s: string) => theme.fg("success", s);
	const cyan = (s: string) => theme.fg("accent", s);
	const w = Math.max(1, width || 80);
	const useHorizontal = w >= HORIZONTAL_MIN_WIDTH;

	if (files.size === 0 && lspServers.size === 0) return [];

	const lines: string[] = [];

	// Header — counts from deduplicated files only
	const deduped = dedupeByBasename([...files.values()]);
	const recencySorted = deduped.filter(shouldRenderFile).slice(0, 5);
	const langStr = sessionLanguages.slice(0, 6).join(" ");
	const totalBlocking = countBlockingIn(deduped);
	const totalErrors = countTotalIn("error", deduped);
	const totalWarnings = countTotalIn("warning", deduped);
	const totalSuppressed = countSuppressedIn(deduped);
	const hasPendingAnalysis = deduped.some(isPendingAnalysis);
	const errorChunk =
		totalErrors > 0
			? (totalBlocking > 0 ? red : yellow)(`●${totalErrors}E`)
			: "";
	const warningChunk = totalWarnings > 0 ? yellow(`!${totalWarnings}W`) : "";
	const summary = errorChunk
		? errorChunk + (warningChunk ? " " + warningChunk : "")
		: warningChunk
			? warningChunk
			: files.size > 0 && !hasPendingAnalysis
				? green("✓ clean")
				: "";

	// LSP spawning — folded into the header in horizontal mode, tail line otherwise
	const spawning = [...lspServers.values()].filter(
		(s) => s.status === "spawning",
	);
	// #3959: compact is a single line, so fold the spawning state into the header
	// for narrow/wide consistency (narrow mode would otherwise drop it silently).
	const lspChip =
		(useHorizontal || opts?.compact) && spawning.length > 0
			? "  " + dim("LSP↑")
			: "";

	// #3959: compact mode stops at the summary header. File rows, the
	// suppressed count and blocker details stay reachable via lens_diagnostics.
	if (opts?.compact) {
		lines.push(
			fitCompactHeader(
				w,
				cyan("pi-lens"),
				langStr ? dim(langStr) : "",
				lspChip,
				summary,
			),
		);
		return lines;
	}

	const header = ` ${cyan("pi-lens")}${langStr ? "  " + dim(langStr) : ""}${lspChip}${summary ? "  " + summary : ""}`;
	lines.push(fitLine(header, w));
	if (totalSuppressed > 0) {
		lines.push(fitLine(` ${dim(`suppressed: ${totalSuppressed}`)}`, w));
	}

	// File list — display order varies by mode
	if (useHorizontal) {
		const displayOrder = sortByTierThenRecency(recencySorted);
		const rowLine = packHorizontalRow(displayOrder, w, theme);
		if (rowLine.length > 0) lines.push(rowLine);
	} else {
		for (const rec of recencySorted) {
			lines.push(fitLine(formatFileRowVertical(rec, theme), w));
		}
	}

	// Diagnostics — blocking (or dependency-drift-demoted) only, from the most
	// recently touched file that has them. Vertical mode keeps the divider/filename
	// context; horizontal already shows the filename on the packed row above, so
	// we drop the extra header noise there.
	//
	// #1631 review F10: `isBlocking` answers false for a demoted (`stale`) finding
	// by design (#1419 demote-not-drop) — but this render loop used that same
	// predicate to pick which findings to SHOW, so a demoted finding vanished from
	// the footer entirely instead of demoting visibly. `isBlockingOrDemoted` keeps
	// it in the list; the per-entry render below distinguishes the two with a
	// dimmed marker instead of the red dot.
	//
	// #2275: a demotion that reached its delivery cap is hidden from THIS
	// surface only (`footerRetired`) — it stays in `allDiagnostics` for
	// mode=all and lens_diagnostic_mark, which is where the agent is told it
	// was capped and can still be confirmed by a re-run.
	const isBlockingOrDemoted = (d: WidgetDiagnostic) =>
		(isBlocking(d) || d.stale === true) && d.footerRetired !== true;
	const withBlocking = recencySorted.filter((r) =>
		r.diagnostics.some(isBlockingOrDemoted),
	);
	if (withBlocking.length > 0) {
		const rec = withBlocking[0];
		// #1641: gate only the ONE record whose line numbers are about to be
		// rendered, not the whole (potentially session-long) `deduped` list the
		// header counts read — one memoized stat per redraw, never a per-file
		// scan of every file pi-lens has touched this session. A past-EOF
		// citation demoted here can leave the header's aggregate blocking count
		// one turn stale; `reconcileStaleWidgetFiles`'s existing debounced sweep
		// (scheduleStaleReconcile) already re-derives that aggregate on its own
		// cadence, so this is a bounded, self-correcting gap, not a silent one.
		applyPastEofGate(rec);
		if (!useHorizontal) {
			lines.push(fitLine(dim("─".repeat(Math.min(w, 60))), w));
			lines.push(fitLine(` ${dim(path.basename(rec.filePath))}`, w));
		}
		const blockers = rec.diagnostics.filter(isBlockingOrDemoted).slice(0, 5);
		// #2275 review F1: THIS is the point where a demoted row is delivered to
		// a human — after the `withBlocking[0]` pick and the top-five slice, not
		// before them. Mark the file so the next turn end can charge exactly one
		// delivery against its cap. File-level, matching
		// `markWidgetFileBlockersStale`'s own file-level demotion batch (all of a
		// file's drift demotions share one delivery history); a file holding more
		// than five demoted rows delivers the visible ones and counts the batch,
		// which is the conservative direction — it retires no LATER than the rows
		// the agent actually read.
		if (blockers.some(isDependencyDriftDemoted)) {
			renderedDependencyDriftFiles.add(rec.filePath);
		}
		for (const d of blockers) {
			// A past-EOF demotion's coordinate is untrustworthy — render the
			// marker instead of the line (#1641); drift demotions keep theirs.
			const pastEof = d.stale && (d.staleReason ?? "past-eof") === "past-eof";
			// No link for a past-EOF demotion: the anchor would carry the same
			// untrustworthy line the marker exists to replace.
			const loc = pastEof
				? PAST_EOF_STALE_MARKER
				: d.line != null
					? osc8(d.uri ?? "", `L${d.line}`)
					: "";
			const rule = d.rule ? dim(` ${d.rule}`) : "";
			const staleTag = d.stale ? dim(` ${STALE_LINE_MARKER}`) : "";
			const prefix = `   ${d.stale ? dim("○") : red("●")} ${loc}${rule}  `;
			const msgWidth = Math.max(
				1,
				w - visibleWidth(prefix) - visibleWidth(staleTag),
			);
			const msg = fitLine(d.message, msgWidth, "…");
			lines.push(fitLine(`${prefix}${msg}${staleTag}`, w));
		}
	}

	// LSP status tail — only in vertical mode; horizontal folds into header
	if (!useHorizontal && spawning.length > 0) {
		const ids = spawning.map((s) => s.serverId).join(" ");
		lines.push(fitLine(` ${dim(`LSP spawning: ${ids}`)}`, w));
	}

	return lines;
}

// ── File row layout ──────────────────────────────────────────────────────────

type FileTier = "blocking" | "warning" | "clean";

function classifyFileTier(rec: FileRecord): FileTier {
	if (rec.diagnosticCounts.blocking > 0) return "blocking";
	if (rec.diagnosticCounts.errors > 0 || rec.diagnosticCounts.warnings > 0) {
		return "warning";
	}
	return "clean";
}

function sortByTierThenRecency(recs: FileRecord[]): FileRecord[] {
	const order: Record<FileTier, number> = {
		blocking: 0,
		warning: 1,
		clean: 2,
	};
	return [...recs].sort((a, b) => {
		const ta = order[classifyFileTier(a)];
		const tb = order[classifyFileTier(b)];
		if (ta !== tb) return ta - tb;
		return b.touchedAt - a.touchedAt;
	});
}

function formatFileRowVertical(
	rec: FileRecord,
	theme: { fg: (color: string, s: string) => string },
): string {
	const dim = (s: string) => theme.fg("dim", s);
	const red = (s: string) => theme.fg("error", s);
	const yellow = (s: string) => theme.fg("warning", s);
	const green = (s: string) => theme.fg("success", s);

	const base = path.basename(rec.filePath);
	const blocking = rec.diagnosticCounts.blocking;
	const errors = rec.diagnosticCounts.errors;
	const warnings = rec.diagnosticCounts.warnings;
	const formatterFailed = hasFailedFormatter(rec);
	// Diagnostic severity outranks formatter failure (#1348 review): a file
	// with blocking diagnostics shows the blocking dot even if a format also
	// failed -- same precedence as the horizontal renderer.
	const dot =
		blocking > 0
			? red("●")
			: formatterFailed
				? red("x")
				: warnings > 0 || errors > 0
					? yellow("!")
					: green("✓");
	const runnerNames = [...rec.runners.entries()]
		.filter(([, r]) => r.status !== "skipped")
		.map(([id]) => id)
		.join(" ");
	const counts =
		errors > 0
			? " " +
				(blocking > 0 ? red : yellow)(`${errors}E`) +
				(warnings > 0 ? " " + yellow(`${warnings}W`) : "")
			: warnings > 0
				? " " + yellow(`${warnings}W`)
				: " " + dim("clean");
	const changedFormatters = [...rec.formatters.entries()]
		.filter(([, f]) => f.changed && f.success)
		.map(([name]) => name);
	const failedFormatters = [...rec.formatters.entries()]
		// An `unavailable` tool is not a code failure (#2413): it never earns a red
		// `fmt-failed` marker. Its result already carries success:true, so this
		// guard is a belt that keeps the intent explicit at the render seam.
		.filter(([, f]) => !f.success && f.outcome !== "unavailable")
		.map(([name]) => name);
	const formatMark =
		(failedFormatters.length > 0
			? red(` fmt-failed:${failedFormatters.join(",")}`)
			: "") +
		(changedFormatters.length > 0
			? dim(` fmt:${changedFormatters.join(",")}`)
			: "");
	return ` ${dot} ${base}  ${dim(runnerNames)}${formatMark}${counts}`;
}

function packHorizontalRow(
	recs: FileRecord[],
	totalWidth: number,
	theme: { fg: (color: string, s: string) => string },
): string {
	if (recs.length === 0) return "";
	const dim = (s: string) => theme.fg("dim", s);
	const indent = "   ";
	const sep = "  ";
	// Reserve worst-case overflow space upfront so the marker always fits.
	// " +NN" — 4 visible chars covers up to two-digit overflow.
	const overflowReserve = 4;
	let used = visibleWidth(indent);
	const parts: string[] = [indent];
	const addedTokenWidths: number[] = [];
	let droppedAt = -1;
	for (let i = 0; i < recs.length; i++) {
		const sepWidth = parts.length > 1 ? visibleWidth(sep) : 0;
		const willOverflow = i < recs.length - 1;
		const reserve = willOverflow ? overflowReserve : 0;
		const remaining = totalWidth - used - sepWidth - reserve;
		if (remaining < 4) {
			droppedAt = i;
			break;
		}
		const token = formatFileTokenHorizontal(recs[i], remaining, theme);
		const tokenWidth = visibleWidth(token);
		if (token.length === 0 || used + sepWidth + tokenWidth > totalWidth) {
			droppedAt = i;
			break;
		}
		if (sepWidth > 0) {
			parts.push(sep);
			used += sepWidth;
		}
		parts.push(token);
		used += tokenWidth;
		addedTokenWidths.push(tokenWidth + sepWidth);
	}
	if (droppedAt >= 0) {
		let dropped = recs.length - droppedAt;
		let overflow = " " + dim(`+${dropped}`);
		// If reservation was insufficient (e.g. last token grew because no
		// reserve was applied), shed accepted tokens until overflow fits.
		while (
			used + visibleWidth(overflow) > totalWidth &&
			addedTokenWidths.length > 0
		) {
			const lastWidth = addedTokenWidths.pop() as number;
			used -= lastWidth;
			parts.pop(); // token
			if (parts.length > 1) parts.pop(); // preceding separator
			dropped++;
			overflow = " " + dim(`+${dropped}`);
		}
		if (used + visibleWidth(overflow) <= totalWidth) {
			parts.push(overflow);
		}
	}
	return fitLine(parts.join(""), totalWidth);
}

function formatFileTokenHorizontal(
	rec: FileRecord,
	remainingWidth: number,
	theme: { fg: (color: string, s: string) => string },
): string {
	const dim = (s: string) => theme.fg("dim", s);
	const red = (s: string) => theme.fg("error", s);
	const yellow = (s: string) => theme.fg("warning", s);

	const blocking = rec.diagnosticCounts.blocking;
	const errors = rec.diagnosticCounts.errors;
	const warnings = rec.diagnosticCounts.warnings;
	const formatterChanged = hasChangedFormatter(rec);
	const formatterFailed = hasFailedFormatter(rec);

	let dotChar: string;
	if (blocking > 0) dotChar = red("●");
	else if (errors > 0 || warnings > 0) dotChar = yellow("!");
	else if (formatterChanged) dotChar = dim("✎");
	else dotChar = dim("·");

	if (formatterFailed && blocking === 0 && errors === 0 && warnings === 0) {
		dotChar = red("x");
	}

	let countsStyled = "";
	if (errors > 0 && warnings > 0) {
		const eColor = blocking > 0 ? red : yellow;
		countsStyled = " " + eColor(`${errors}E`) + yellow(`${warnings}W`);
	} else if (errors > 0) {
		const eColor = blocking > 0 ? red : yellow;
		countsStyled = " " + eColor(`${errors}E`);
	} else if (warnings > 0) {
		countsStyled = " " + yellow(`${warnings}W`);
	}

	const fullBasename = path.basename(rec.filePath);
	const fixedWidth = visibleWidth(dotChar) + 1 + visibleWidth(countsStyled);
	const basenameBudget = remainingWidth - fixedWidth;
	if (basenameBudget < 3) return "";
	const truncated = truncateBasename(fullBasename, basenameBudget);
	const linked = osc8(pathToFileURL(rec.filePath).href, truncated);
	return `${dotChar} ${linked}${countsStyled}`;
}

function truncateBasename(name: string, maxWidth: number): string {
	if (visibleWidth(name) <= maxWidth) return name;
	if (maxWidth < 2) return "…";
	const ext = path.extname(name);
	const stem = name.slice(0, name.length - ext.length);
	const keep = maxWidth - ext.length - 1;
	if (keep < 1) {
		// Extension alone wouldn't fit; truncate the whole name.
		return name.slice(0, maxWidth - 1) + "…";
	}
	return stem.slice(0, keep) + "…" + ext;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function getOrCreate(filePath: string, key = fileMapKey(filePath)): FileRecord {
	maybePruneInactiveFileRecords();
	// Look up by the normalized key so mixed path forms of the same file share
	// ONE record (#1020); keep the caller's verbatim path as the display path.
	return (
		files.get(key) ?? {
			filePath,
			runners: new Map(),
			formatters: new Map(),
			diagnostics: [],
			allDiagnostics: [],
			diagnosticCounts: { blocking: 0, errors: 0, warnings: 0 },
			hasFinalDiagnosticsSnapshot: false,
			touchedAt: Date.now(),
		}
	);
}

function hasChangedFormatter(rec: FileRecord): boolean {
	return [...rec.formatters.values()].some((f) => f.changed && f.success);
}

function hasFailedFormatter(rec: FileRecord): boolean {
	// `unavailable` (#2413) is success:true and must never count as a failure —
	// the explicit guard keeps that true even if a future path mislabels it.
	return [...rec.formatters.values()].some(
		(f) => !f.success && f.outcome !== "unavailable",
	);
}

function shouldRenderFile(rec: FileRecord): boolean {
	return (
		rec.hasFinalDiagnosticsSnapshot ||
		hasChangedFormatter(rec) ||
		hasFailedFormatter(rec)
	);
}

function hasLiveDiagnostic(rec: FileRecord): boolean {
	return rec.hasFinalDiagnosticsSnapshot && rec.diagnostics.length > 0;
}

function isPendingAnalysis(rec: FileRecord): boolean {
	return rec.runners.size > 0 && !rec.hasFinalDiagnosticsSnapshot;
}

function capStoredDiagnostics(
	diagnostics: WidgetDiagnostic[],
): WidgetDiagnostic[] {
	if (diagnostics.length <= MAX_STORED_DIAGNOSTICS_PER_FILE) return diagnostics;
	const blockers = diagnostics.filter(isBlocking);
	if (blockers.length >= MAX_STORED_DIAGNOSTICS_PER_FILE) {
		return blockers.slice(0, MAX_STORED_DIAGNOSTICS_PER_FILE);
	}
	const rest = diagnostics.filter((d) => !isBlocking(d));
	return [
		...blockers,
		...rest.slice(0, MAX_STORED_DIAGNOSTICS_PER_FILE - blockers.length),
	];
}

function countTotalIn(
	severity: "error" | "warning",
	recs: FileRecord[],
): number {
	let n = 0;
	for (const rec of recs) {
		if (severity === "error") n += rec.diagnosticCounts.errors;
		else n += rec.diagnosticCounts.warnings;
	}
	return n;
}

function countSuppressedIn(recs: FileRecord[]): number {
	let n = 0;
	for (const rec of recs) {
		for (const diagnostic of rec.allDiagnostics) {
			if (diagnostic.disposition) n++;
		}
	}
	return n;
}

function countBlockingIn(recs: FileRecord[]): number {
	let n = 0;
	for (const rec of recs) n += rec.diagnosticCounts.blocking;
	return n;
}

function requestRender(): void {
	requestRenderFn?.();
}

function osc8(uri: string, label: string): string {
	if (!uri) return label;
	return `\x1b]8;;${uri}\x1b\\${label}\x1b]8;;\x1b\\`;
}

// Dual-signature truncateToWidth handling lives in tui-fit.ts (shared with the
// turn-summary message renderer, which learned the hard way that pi-tui crashes
// the host on over-width lines — #513).

function dedupeByBasename(recs: FileRecord[]): FileRecord[] {
	const seen = new Map<string, FileRecord>();
	for (const r of [...recs].sort((a, b) => a.touchedAt - b.touchedAt)) {
		seen.set(path.basename(r.filePath), r);
	}
	return [...seen.values()].sort((a, b) => b.touchedAt - a.touchedAt);
}
