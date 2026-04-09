/**
 * Session Summary — generates turn_end and session-end summaries
 */

import type { SessionStats } from "./diagnostic-tracker.js";

export interface SlopScoreSummary {
	totalRuleDiagnostics: number;
	totalKlocWritten: number;
	scorePerKloc: number;
	ruleCounts: Array<{ ruleId: string; count: number }>;
}

export function formatSessionSummary(stats: SessionStats): string {
	if (stats.totalShown === 0) return "";

	const lines = [
		"## Diagnostic Summary",
		"",
		`Shown to agent: ${stats.totalShown}`,
		`Auto-fixed: ${stats.totalAutoFixed} (${pct(stats.totalAutoFixed, stats.totalShown)}%)`,
		`Fixed by agent: ${stats.totalAgentFixed} (${pct(stats.totalAgentFixed, stats.totalShown)}%)`,
		"",
	];

	if (stats.topViolations.length > 0) {
		lines.push("Top violations:");
		for (const { ruleId, count } of stats.topViolations.slice(0, 5)) {
			lines.push(`  - ${ruleId} (${count}x)`);
		}
	}

	return lines.join("\n");
}

function pct(part: number, total: number): string {
	if (total === 0) return "0";
	return Math.round((part / total) * 100).toString();
}

export function formatSlopScoreSummary(summary: SlopScoreSummary): string {
	if (summary.totalRuleDiagnostics === 0 || summary.totalKlocWritten <= 0) {
		return "";
	}

	const topRules = summary.ruleCounts.slice(0, 3);
	const detail =
		topRules.length > 0
			? `  (${topRules.map((entry) => `${entry.ruleId} ×${entry.count}`).join(", ")})`
			: "";

	return `Slop score: ${summary.scorePerKloc.toFixed(1)}/KLOC${detail}`;
}
