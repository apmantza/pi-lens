/**
 * Shared formatting utilities for the dispatch system.
 */

import { isCrossFileBlocker } from "../../inline-blocker-fields.js";
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
 * The file a rendered row names before its line: the diagnostic's own file
 * when it cites another file than the one the block is rendered for, else
 * nothing. A runner that follows imports (mypy) attributes an error to the
 * module it names, and a bare `L<n>` under the edited file reads as that
 * file's line, so the agent marks it against the wrong file. A row that opens
 * with its path also stays out of `demoted-finding-render.ts`' `L<n>` matcher,
 * which treats every `L<n>` row as a line of the record's own file.
 */
export function crossFileRowLabel(
	d: Diagnostic,
	editedFile: string | undefined,
	root?: string,
): string {
	return editedFile !== undefined && isCrossFileBlocker(d, editedFile, root)
		? `${d.filePath} `
		: "";
}

/** The file a block is rendered for, and the project root its rows' relative
 *  paths resolve against (the inline-blocker policy's root). */
export interface RenderedFor {
	editedFile: string;
	root?: string | undefined;
}

/**
 * Format a single diagnostic for display
 */
function formatDiagnostic(d: Diagnostic, renderedFor?: RenderedFor): string {
	const line = d.line ? `L${d.line}: ` : "";
	const indented = d.message.split("\n").join("\n  ");
	const fix = d.fixSuggestion ? `\n    💡 Fix: ${d.fixSuggestion}` : "";
	const label = renderedFor
		? crossFileRowLabel(d, renderedFor.editedFile, renderedFor.root)
		: "";
	return `  ${label}${line}${indented}${fix}`;
}

/**
 * #3218: why a delta-promoted unused finding blocks. The promotion seam
 * (`promoteDeltaUnusedToBlockers`) stamps this on the promoted diagnostic as
 * `Diagnostic.promotionNote`; the STOP renderers collect it through
 * {@link formatPromotionNotes}.
 *
 * It lives here, beside the renderer, because the demotion path
 * (`clients/demoted-finding-render.ts`) must recognize the exact rendered row
 * to DROP it (#3748 item 3): once the record is demoted it no longer blocks,
 * so the note's tier argument is false and must not ride along.
 */
export const DELTA_UNUSED_PROMOTION_NOTE =
	"new in this edit → blocks in delta mode; pre-existing unused declarations only advise.";

/**
 * #3218: the one-line rationale beneath a STOP block when the delta-mode
 * promotion seam raised at least one finding to `blocking`. Several promoted
 * findings share one note, so the reason renders once, never as per-item
 * boilerplate. The seam owns the text (`Diagnostic.promotionNote`); this helper
 * only collects it, so no renderer re-detects which findings were promoted.
 */
export function formatPromotionNotes(diagnostics: Diagnostic[]): string {
	const notes = new Set<string>();
	for (const d of diagnostics) {
		if (d.promotionNote) notes.add(d.promotionNote);
	}
	if (notes.size === 0) return "";
	return [...notes].map((note) => `  ℹ️ ${note}\n`).join("");
}

/**
 * Format a group of diagnostics with semantic header
 */
export function formatDiagnostics(
	diagnostics: Diagnostic[],
	semantic: OutputSemantic | string,
	maxDisplay = 10,
	/** The file the block is rendered for; rows citing another file name it. */
	renderedFor?: RenderedFor,
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
		output += `${formatDiagnostic(d, renderedFor)}\n`;
	}

	if (diagnostics.length > maxDisplay) {
		output += `  ... and ${diagnostics.length - maxDisplay} more\n`;
	}

	// #3218: promotion notes ride only on blocking diagnostics (the promotion
	// seam sets one with `semantic: "blocking"`), so there is no semantic guard
	// to make; collecting unconditionally is the same output for every
	// reachable input and one fewer unreachable branch.
	output += formatPromotionNotes(diagnostics);

	return output;
}
