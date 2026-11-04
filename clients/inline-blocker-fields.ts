/**
 * The derived fields of an inline-blocker record, from the blocking diagnostics
 * it was rendered from (#1561 F1, #1641 F2).
 *
 * Two writers build `InlineBlockerRecord`s: the pipeline's per-edit verdict
 * (`clients/pipeline.ts`) and the collect-later merge
 * (`RuntimeCoordinator.recordDeferredInlineBlockers`, #3814). The deferred
 * writer once re-derived `lines` without the own-file filter, and a foreign line
 * number retired the whole record at the past-EOF sweep (AGENTS.md shape 24: a
 * second writer that skipped the first writer's normalization). Both writers
 * call these two functions instead.
 */

import type { Diagnostic } from "./dispatch/types.js";
import { normalizeEphemeralMapKey } from "./path-utils.js";

/**
 * #1561 F1: the source id ONE blocking diagnostic is attributed to. The single
 * derivation `inlineBlockerSources` and the per-source row retirement
 * (`retireInlineBlockerOnConfirmedClean`, #4990) both read, so a verdict's
 * coverage and a row's provenance cannot drift apart.
 */
export function inlineBlockerSourceOf(diagnostic: Diagnostic): string {
	return diagnostic.tool?.trim() || "unknown";
}

/**
 * #1561 F1: taken from the very diagnostics the record's text was rendered
 * from, so the provenance can never disagree with the text it guards. An
 * untagged diagnostic contributes the literal "unknown", which no verdict
 * claims coverage for — it pins the entry rather than silently widening what an
 * LSP check is allowed to clear.
 */
export function inlineBlockerSources(
	blockers: readonly Diagnostic[],
): string[] {
	return [...new Set(blockers.map(inlineBlockerSourceOf))];
}

/**
 * #1641 review F2: the blocker array is NOT guaranteed to be scoped to THIS
 * file — a chart-wide runner (helm-lint, helm-render) reports blocking
 * diagnostics against other files in the chart (e.g. `values.yaml`) alongside
 * `filePath`. The precedent every per-file runner already follows
 * (dotnet-build.ts, javac.ts) is to drop cross-file rows before they reach a
 * per-file record. Without the filter, a cross-file line count gets attributed
 * to THIS file's past-EOF check and can demote an in-bounds, fully valid
 * blocker for content the diagnostic never described.
 *
 * #1641 review round 2 (LOW): `path.resolve` equality doesn't fold case, and an
 * LSP-sourced diagnostic's `filePath` is stamped with realpath canonical casing
 * (dispatch/runners/lsp.ts -> normalizeMapKey) while `filePath` can arrive
 * lowercase-drive on Windows — the drive-letter class from #1139/#1150. A bare
 * `path.resolve` equality then drops EVERY LSP blocker line and the record
 * silently skips the past-EOF gate. `normalizeEphemeralMapKey` slash-folds and
 * (on win32) lowercase-folds both sides with no filesystem I/O — cheap enough
 * for this per-blocker hot-path filter. `pathsEqual` was deliberately NOT used:
 * it calls `realpathSync` per comparison.
 */
export function inlineBlockerLines(
	blockers: readonly Diagnostic[],
	filePath: string,
): number[] {
	return inlineBlockerPlaces(blockers, filePath).map((place) => place.line);
}

/**
 * #5020: whether a blocker row cites a file other than `filePath`: the one
 * own-file test, shared by the record's line list (`inlineBlockerPlacement`)
 * and the retire seams that treat such a row as another file's claim. The two
 * read it the same way, so a row the line list calls "no line in this file" is
 * the row a retire may judge by its cited file.
 *
 * TOTAL over the rows a record holds: a row with no `filePath` is the record's
 * own, never another file's claim, so no caller needs a `d.filePath &&` guard
 * in front of it. `Diagnostic.filePath` is required, so such a row reaches a
 * record only from outside the type system (a persisted or foreign row, which
 * `InlineBlockerRecord.diagnostics` holds as `Diagnostic[]`); without this
 * clause the `normalizeEphemeralMapKey` below dereferences the absent path
 * (`TypeError: Cannot read properties of undefined (reading 'includes')`), so
 * every caller that can see one would have to repeat the guard (AGENTS.md
 * shape 83: one owner per rule).
 *
 * The widget store (`clients/widget-state.ts`) stamps the same answer on its
 * rows (`WidgetDiagnostic.citedFile`), so it asks this function too, with the
 * raw row it is handed: hence the structural parameter.
 */
export function isCrossFileBlocker(
	d: { filePath?: string | undefined },
	filePath: string,
): boolean {
	return (
		!!d.filePath &&
		normalizeEphemeralMapKey(d.filePath) !== normalizeEphemeralMapKey(filePath)
	);
}

/** One place a blocker is cited in `filePath`: the line, and the rule that
 *  reported it. */
export interface InlineBlockerPlace {
	line: number;
	rule: string;
}

/**
 * #5008 review r3 (F6): the counted blockers these bytes cannot place, split by
 * WHY. Both causes have a line; only the first one has it in THIS file.
 */
export interface UnplacedBlockerCounts {
	/** Carried from older bytes of this file: the line exists, but not here. */
	movedLine: number;
	/** Another file's row (a chart-wide runner naming `values.yaml` while the
	 *  template is processed), or a blocker with no line at all. */
	noLineInThisFile: number;
}

/**
 * #5008: the places a blocker set is cited at, one per blocker that HAS a place
 * in these bytes, plus the counted remainder by cause. `inlineBlockerLines` is
 * the places' line column, so the record's line list and the agent-facing
 * `Still unfixed` line cannot disagree about which blockers are placeable, and
 * the rendered count cannot disagree with the list it counts (AGENTS.md shape
 * 83: one owner per rule).
 *
 * `rule` falls back to the same source id `inlineBlockerSourceOf` derives, so an
 * untagged blocker reads as `unknown` rather than citing an empty rule.
 */
export function inlineBlockerPlacement(
	blockers: readonly Diagnostic[],
	filePath: string,
): { places: InlineBlockerPlace[]; unplaced: UnplacedBlockerCounts } {
	const places: InlineBlockerPlace[] = [];
	let movedLine = 0;
	for (const d of blockers) {
		// Another file's row (#1641) and a blocker with no line are both "no line
		// in this file"; only a stale carry of THIS file has a line to report.
		// A row that cites no file at all is this record's own (`isCrossFileBlocker`
		// is total), so it is placed when it carries a line.
		if (isCrossFileBlocker(d, filePath)) continue;
		if (typeof d.line !== "number") continue;
		if (d.positionStale) {
			// #4509 (N3): a stale entry's line is from older bytes, so it cites
			// none: the past-EOF sweep would retire the whole record on it.
			movedLine += 1;
			continue;
		}
		places.push({
			line: d.line,
			rule: d.rule?.trim() || inlineBlockerSourceOf(d),
		});
	}
	return {
		places,
		unplaced: {
			movedLine,
			noLineInThisFile: blockers.length - places.length - movedLine,
		},
	};
}

export function inlineBlockerPlaces(
	blockers: readonly Diagnostic[],
	filePath: string,
): InlineBlockerPlace[] {
	return inlineBlockerPlacement(blockers, filePath).places;
}
