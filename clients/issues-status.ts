/**
 * Footer issues-status text for the `pi-lens-issues` extension status key.
 *
 * A projection of the widget header's tallies ({@link WidgetSummary}), never a
 * second counter (#1892): the same errors, warnings, unchecked files and clean
 * gate the widget draws become one plain-text line. Plain text, not theme
 * colors: the key is read by hosts and bridges that render the raw string, so
 * ANSI would leak into their own footer.
 */

import type { WidgetSummary } from "./widget-state.js";

/**
 * `●<N>E`, `!<N>W`, both side by side, `⚠ <N> unchecked`, `✓ clean`, or
 * `undefined` when no analyzed file has a state to report.
 */
export function formatIssuesStatus(summary: WidgetSummary): string | undefined {
	if (!summary.hasFiles) return undefined;
	const errors =
		summary.totalErrors > 0 ? `●${summary.totalErrors}E` : undefined;
	const warnings =
		summary.totalWarnings > 0 ? `!${summary.totalWarnings}W` : undefined;
	if (errors && warnings) return `${errors} ${warnings}`;
	if (errors) return errors;
	if (warnings) return warnings;
	if (summary.uncheckedCount > 0) {
		return `⚠ ${summary.uncheckedCount} unchecked`;
	}
	if (summary.hasRenderableCheckedFile && !summary.hasPendingAnalysis) {
		return "✓ clean";
	}
	return undefined;
}
