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
 * #1561 F1: taken from the very diagnostics the record's text was rendered
 * from, so the provenance can never disagree with the text it guards. An
 * untagged diagnostic contributes the literal "unknown", which no verdict
 * claims coverage for — it pins the entry rather than silently widening what an
 * LSP check is allowed to clear.
 */
export function inlineBlockerSources(
	blockers: readonly Diagnostic[],
): string[] {
	return [...new Set(blockers.map((d) => d.tool?.trim() || "unknown"))];
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
	const own = normalizeEphemeralMapKey(filePath);
	return blockers
		.filter((d) => normalizeEphemeralMapKey(d.filePath) === own)
		.map((d) => d.line)
		.filter((line): line is number => typeof line === "number");
}
