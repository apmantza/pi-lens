/**
 * Writes the `pi-lens-ignore` suppression comment that inline-suppressions.ts
 * already knows how to read (#690's `suppress` disposition). The reader
 * accepts either `//` or `#` on any line regardless of language, but the
 * WRITER must pick the syntactically valid comment character for the target
 * file — an errant `#` line breaks parsing in a `//`-comment language and
 * vice versa.
 */

import * as path from "node:path";
import { lineEndingAtLine } from "../host-edit-normalize.js";
import {
	parseInlineSuppressionRuleIds,
	splitInlineSuppressionPayload,
} from "./inline-suppressions.js";

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
	// Split on "\n" only, so each line keeps its own "\r" (CRLF) and the
	// split/join round-trips the file's line endings exactly (#5686).
	const lines = content.split("\n");
	if (line < 1 || line > lines.length) {
		throw new Error(
			`line ${line} is out of range (file has ${lines.length} lines)`,
		);
	}
	const prefix = commentPrefixFor(filePath);
	const aboveIdx = line - 2; // 0-based index of the line immediately above
	const existingAbove = aboveIdx >= 0 ? lines[aboveIdx] : undefined;
	const suppressRe = /((?:\/\/|#)\s*pi-lens-ignore:\s*)(.+)$/;
	if (existingAbove !== undefined) {
		// A CRLF line carries a trailing "\r" the suppression regex cannot
		// match across, so the match runs against the line without its ending
		// and the ending is written back verbatim (#5686).
		const hasCarriageReturn = existingAbove.endsWith("\r");
		const aboveText = hasCarriageReturn
			? existingAbove.slice(0, -1)
			: existingAbove;
		const match = suppressRe.exec(aboveText);
		if (match) {
			const commentPrefix = match[1];
			const payload = match[2];
			if (commentPrefix === undefined || payload === undefined) return content;
			const { ruleList, trailingReason } =
				splitInlineSuppressionPayload(payload);
			const rules = ruleList
				.split(",")
				.map((r) => r.trim())
				.filter(Boolean);
			const ruleIds = parseInlineSuppressionRuleIds(ruleList);
			if (!ruleIds.includes(rule)) rules.push(rule);
			lines[aboveIdx] =
				aboveText.slice(0, match.index) +
				commentPrefix +
				rules.join(", ") +
				trailingReason +
				(hasCarriageReturn ? "\r" : "");
			return lines.join("\n");
		}
	}
	// Match the indentation of the flagged line so the inserted comment lines
	// up rather than sitting at column 0.
	const targetLine = lines[line - 1] ?? "";
	const indent = /^\s*/.exec(targetLine)?.[0] ?? "";
	// The new line takes the ending of the line it is inserted above (the
	// flagged line), per the host's per-range rule (#5686): on an unterminated
	// last line `lineEndingAtLine` answers the line before it.
	const ending = lineEndingAtLine(lines, line - 1) === "\r\n" ? "\r" : "";
	lines.splice(
		line - 1,
		0,
		`${indent}${prefix} pi-lens-ignore: ${rule}${ending}`,
	);
	return lines.join("\n");
}
