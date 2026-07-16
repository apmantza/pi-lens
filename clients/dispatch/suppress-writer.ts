/**
 * Writes the `pi-lens-ignore` suppression comment that inline-suppressions.ts
 * already knows how to read (#690's `suppress` disposition). The reader
 * accepts either `//` or `#` on any line regardless of language, but the
 * WRITER must pick the syntactically valid comment character for the target
 * file — an errant `#` line breaks parsing in a `//`-comment language and
 * vice versa.
 */

import * as path from "node:path";

const HASH_COMMENT_EXTENSIONS = new Set([
	".py",
	".rb",
	".sh",
	".bash",
	".zsh",
	".yml",
	".yaml",
	".toml",
	".r",
	".pl",
	".pm",
	".ex",
	".exs",
	".elixir",
	".dockerfile",
	".gitignore",
	".conf",
	".cfg",
	".ini",
]);

function commentPrefixFor(filePath: string): "#" | "//" {
	const ext = path.extname(filePath).toLowerCase();
	return HASH_COMMENT_EXTENSIONS.has(ext) ? "#" : "//";
}

/**
 * Insert a `pi-lens-ignore: <rule>` comment on the line immediately above
 * `line` (1-based), matching inline-suppressions.ts's "same line or line
 * above" read semantics. If the line above already carries a pi-lens-ignore
 * comment, the rule is appended to its list instead of adding a duplicate
 * comment line. Returns the updated content; throws if `line` is out of range.
 */
export function insertSuppressComment(
	content: string,
	filePath: string,
	line: number,
	rule: string,
): string {
	const lines = content.split(/\r?\n/);
	if (line < 1 || line > lines.length) {
		throw new Error(`line ${line} is out of range (file has ${lines.length} lines)`);
	}
	const prefix = commentPrefixFor(filePath);
	const aboveIdx = line - 2; // 0-based index of the line immediately above
	const existingAbove = aboveIdx >= 0 ? lines[aboveIdx] : undefined;
	const suppressRe = /((?:\/\/|#)\s*pi-lens-ignore:\s*)(.+)$/;
	const match = existingAbove !== undefined ? suppressRe.exec(existingAbove) : null;
	if (match && existingAbove !== undefined) {
		const rules = match[2]
			.split(",")
			.map((r) => r.trim())
			.filter(Boolean);
		if (!rules.includes(rule)) rules.push(rule);
		lines[aboveIdx] = existingAbove.slice(0, match.index) + match[1] + rules.join(", ");
		return lines.join("\n");
	}
	// Match the indentation of the flagged line so the inserted comment lines
	// up rather than sitting at column 0.
	const targetLine = lines[line - 1] ?? "";
	const indent = /^\s*/.exec(targetLine)?.[0] ?? "";
	lines.splice(line - 1, 0, `${indent}${prefix} pi-lens-ignore: ${rule}`);
	return lines.join("\n");
}
