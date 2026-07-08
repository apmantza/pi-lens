/**
 * Inline `pi-lens-ignore` suppression — shared between the per-edit dispatch
 * pipeline (`lens_diagnostics mode=all`) and the project-wide `mode=full` sweep so
 * BOTH honor the same comments (#442). Previously this lived privately in the
 * dispatcher, so a site suppressed on the write path reappeared as blocking in the
 * full scan, making `mode=full` unusable as a clean gate.
 *
 * Syntax: `// pi-lens-ignore: rule-id` (JS/TS) or `# pi-lens-ignore: rule-id`
 * (Python/Ruby/…), comma-separated for multiple rules, on the same line as the
 * diagnostic or the line immediately above it.
 */

export interface SuppressibleDiagnostic {
	line?: number;
	rule?: string;
	id?: string;
}

const SUPPRESS_RE = /(?:\/\/|#)\s*pi-lens-ignore:\s*(.+)/;

/**
 * Normalize a rule id to the form a user writes in a `pi-lens-ignore` comment.
 * The napi scan and the ast-grep LSP tag the same rule as `ast-grep:<id>` /
 * `<id>-js` in some surfaces (see `normalizeRuleForDedup` in lens-diagnostics);
 * a user's bare `<id>` must still suppress those, so we match the normalized form
 * as well as the raw one.
 */
function normalizeSuppressRule(ruleId: string): string {
	return ruleId.replace(/^ast-grep:/, "").replace(/-js$/, "");
}

/**
 * Drop diagnostics suppressed by an inline `pi-lens-ignore: <rule[,rule2]>`
 * comment in `content` (the file the diagnostics belong to). A diagnostic is
 * suppressed when its rule id — raw OR normalized — is listed on its own line or
 * the line immediately above. Returns the surviving diagnostics (same array if
 * nothing is suppressed).
 */
export function applyInlineSuppressions<T extends SuppressibleDiagnostic>(
	diagnostics: T[],
	content: string,
): T[] {
	if (!content || !diagnostics.length) return diagnostics;

	// Build the set of (1-based line, rule-id) pairs that are suppressed.
	const suppressed = new Set<string>();
	const lines = content.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const m = SUPPRESS_RE.exec(lines[i]);
		if (!m) continue;
		const rules = m[1]
			.split(",")
			.map((r) => r.trim())
			.filter(Boolean);
		const suppressedLine = i + 1; // same line (1-based)
		const nextLine = i + 2; // next line (1-based)
		for (const ruleId of rules) {
			suppressed.add(`${suppressedLine}:${ruleId}`);
			suppressed.add(`${nextLine}:${ruleId}`);
		}
	}

	if (suppressed.size === 0) return diagnostics;

	return diagnostics.filter((d) => {
		const rawId = d.rule ?? d.id ?? "";
		const line = d.line ?? 1;
		if (suppressed.has(`${line}:${rawId}`)) return false;
		const normId = normalizeSuppressRule(rawId);
		return normId === rawId || !suppressed.has(`${line}:${normId}`);
	});
}
