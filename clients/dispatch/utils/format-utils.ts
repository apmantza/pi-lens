/**
 * Shared formatting utilities for the dispatch system.
 */

import type { Diagnostic, OutputSemantic } from "../types.js";

const EMOJI: Record<string, string> = {
	blocking: "🔴",
	warning: "🟡",
	fixed: "✅",
	info: "ℹ️",
	silent: "📊",
	none: "",
};

/**
 * Format a single diagnostic for display
 */
function formatDiagnostic(d: Diagnostic): string {
	const line = d.line ? `L${d.line}: ` : "";
	const indented = d.message.split("\n").join("\n  ");
	const fix = d.fixSuggestion ? `\n    💡 Fix: ${d.fixSuggestion}` : "";
	return `  ${line}${indented}${fix}`;
}

/**
 * Format a group of diagnostics with semantic header
 */
export function formatDiagnostics(
	diagnostics: Diagnostic[],
	semantic: OutputSemantic | string,
	maxDisplay = 10,
): string {
	if (diagnostics.length === 0) return "";

	const emoji = EMOJI[semantic] ?? EMOJI.warning;
	let output = "";

	if (semantic === "blocking") {
		output += `\n${emoji} STOP — ${diagnostics.length} issue(s) must be fixed:\n`;
	} else if (semantic === "warning") {
		output += `\n${emoji} ${diagnostics.length} warning(s):\n`;
	} else if (semantic === "fixed") {
		output += `\n${emoji} Auto-fixed ${diagnostics.length} issue(s):\n`;
	}

	for (const d of diagnostics.slice(0, maxDisplay)) {
		output += `${formatDiagnostic(d)}\n`;
	}

	if (diagnostics.length > maxDisplay) {
		output += `  ... and ${diagnostics.length - maxDisplay} more\n`;
	}

	return output;
}
