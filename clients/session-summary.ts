/**
 * Session Summary — generates turn_end and session-end summaries
 */

export interface SlopScoreSummary {
	totalRuleDiagnostics: number;
	totalKlocWritten: number;
	scorePerKloc: number;
	ruleCounts: Array<{ ruleId: string; count: number }>;
}

export function formatSlopScoreSummary(summary: SlopScoreSummary): string {
	if (summary.totalRuleDiagnostics === 0 || summary.totalKlocWritten <= 0) {
		return "";
	}

	const topRules = summary.ruleCounts.slice(0, 3);
	const detail =
		topRules.length > 0
			? "  (" +
				topRules.map((entry) => entry.ruleId + " ×" + entry.count).join(", ") +
				")"
			: "";

	return `Slop score: ${summary.scorePerKloc.toFixed(1)}/KLOC${detail}`;
}
