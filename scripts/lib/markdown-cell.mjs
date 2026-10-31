// One Markdown table-cell escaper for every generated or issue-body table (#4490).
// Escape the backslash FIRST, then the pipe: a literal `\` in the input must not
// combine with the pipe escape (`a\|b` would otherwise render as `a\\|b`, and
// GFM reads the second backslash as the escape, so the pipe splits the cell).
// Dependency-free. Callers keep their own whitespace, newline and truncation
// handling; this only escapes.

/**
 * @param {unknown} text
 * @returns {string}
 */
export function escapeMarkdownCell(text) {
	return String(text).replaceAll("\\", "\\\\").replaceAll("|", "\\|");
}

/**
 * The reading side of `escapeMarkdownCell`: split one pipe-table row into its
 * trimmed cells the way GitHub does. A backslash escapes the next character, so
 * `\|` stays inside its cell (and cells keep their escapes, so a row can be
 * rendered back unchanged). A backtick code span does NOT protect a pipe: GFM
 * splits on every unescaped pipe, code span or not, so `` `1 failed | 2 passed` ``
 * is two cells on GitHub and must be two here (a code-span-aware split would
 * hide the exact rows GitHub renders broken, #5070). One leading and one
 * trailing unescaped pipe are the row's borders, not cells.
 * @param {string} line
 * @returns {string[]}
 */
export function splitMarkdownRow(line) {
	const cells = [];
	let cell = "";
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (ch === "\\" && i + 1 < line.length) {
			cell += ch + line[++i];
		} else if (ch === "|") {
			cells.push(cell);
			cell = "";
		} else {
			cell += ch;
		}
	}
	cells.push(cell);
	if (cells[0].trim() === "") cells.shift();
	if (cells.length > 0 && cells.at(-1).trim() === "") cells.pop();
	return cells.map((c) => c.trim());
}
