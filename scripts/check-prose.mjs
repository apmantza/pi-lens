import { readFileSync } from "node:fs";
import { blankMarkdown as blankMarkdownShared } from "./lib/defect-shapes.mjs";
import { markdownHeadings } from "./lib/markdown-lexer.mjs";
import { isMainModule } from "./lib/is-main-module.mjs";

const MAX_WORDS = 30;
const FILLER_PATTERNS = [
	"simply",
	"just",
	"obviously",
	"basically",
	"in order to",
	"very",
	"really",
	"please",
];
const PASSIVE_RE =
	/\b(?:is|are|was|were|been|being)\s+(?:\w+ly\s+)?\w+(?:ed|en)\b/gi;
const ABBREVIATIONS = /\b(?:e\.g|i\.e|etc|vs|cf|mr|mrs|dr|no)\./i;

// Trailers, fences, comments and code spans come out first, so the prose
// rules read only text a reader sees. Fences, comments and code spans are the
// shared lexer's (`blankMarkdown`), not a second copy (#4717: this masker
// treated any `<!--` as an opener, so a body quoting the syntax skipped every
// later section of prose instead of judging it).
function blankMarkdown(text) {
	const raw = String(text ?? "").split(/\r?\n/);
	const trailerPattern =
		/^\s*(?:Co-Authored-By|Signed-off-by|Refs|Closes):\s+/i;
	let lastContent = raw.length - 1;
	while (lastContent >= 0 && !raw[lastContent].trim()) lastContent -= 1;
	const trailerLines = new Set();
	for (let index = lastContent; index >= 0; index -= 1) {
		if (!raw[index].trim()) {
			trailerLines.add(index);
			continue;
		}
		if (!trailerPattern.test(raw[index])) break;
		trailerLines.add(index);
	}
	// The line filters read the line as written; the prose rules read it with
	// its code spans blanked, so a line opening with one is not taken for a
	// stack frame (`at …`) or a command.
	const masked = blankMarkdownShared(String(text ?? ""), {
		indentedCode: false,
		codeSpans: true,
	}).split(/\r?\n/);
	return blankMarkdownShared(String(text ?? ""), { indentedCode: false })
		.split(/\r?\n/)
		.map((line, lineIndex) => {
			if (trailerLines.has(lineIndex)) return "";
			if (/^\s*🤖 Generated with \[Claude Code\]\([^)]*\)\s*$/u.test(line))
				return "";
			if (/^\s*>/.test(line) || /^\s*\|/.test(line)) return "";
			if (
				/^\s*(?:\$\s|npm\s|yarn\s|pnpm\s|(?:FAIL|PASS|Tests:|Test Files:|AssertionError|Error:|at\s))/.test(
					line,
				)
			)
				return "";
			return masked[lineIndex]
				.replace(/https?:\/\/\S+/gi, " ")
				.replace(/(^|\s)(?:["'])([^"']+)(?:["'])(?=\s|$)/g, "$1 ");
		})
		.join("\n");
}

function sentenceEnd(text, index) {
	const char = text[index];
	if (!".!?".includes(char) || /[.!?]/.test(text[index - 1] ?? ""))
		return false;
	const next = text[index + 1] ?? "";
	if (next && !/\s/.test(next)) return false;
	const before = text.slice(Math.max(0, index - 8), index + 1);
	if (char === "." && (ABBREVIATIONS.test(before) || /\b\d+$/.test(before)))
		return false;
	return true;
}

function splitSentences(text) {
	const sentences = [];
	let start = 0;
	for (let index = 0; index < text.length; index += 1) {
		if (!sentenceEnd(text, index)) continue;
		sentences.push(text.slice(start, index + 1));
		start = index + 1;
	}
	if (text.slice(start).trim()) sentences.push(text.slice(start));
	return sentences;
}

function wordCount(text) {
	return (text.match(/\b[\p{L}\p{N}][\p{L}\p{N}'’/-]*\b/gu) ?? []).length;
}

function finding(rule, message, line) {
	return `${rule}${line ? ` (line ${line})` : ""}: ${message}`;
}

function proseLines(text) {
	return blankMarkdown(text).split("\n");
}

export function checkProse(text = "", options = {}) {
	const mode = options.mode ?? "block";
	const errors = [];
	const warnings = [];
	const lines = proseLines(text);
	// Headings are the lexer's (#4717 N2): a setext underline and an indented
	// ATX heading are headings, and a `#` line in a comment or code is not.
	const headingAt = new Map();
	for (const heading of markdownHeadings(text))
		for (let line = heading.line; line < heading.contentLine; line += 1)
			headingAt.set(line, line === heading.line ? heading : null);
	// #5110: only heading case blocks. Sentence length, filler and passive
	// voice warn, so wording alone never fails the PR-body lint.
	const addBlock = (message) => {
		(mode === "warn" ? warnings : errors).push(message);
	};
	for (let index = 0; index < lines.length; index += 1) {
		const raw = lines[index];
		if (headingAt.has(index)) {
			const heading = headingAt.get(index);
			if (!heading) continue;
			const title = heading.text;
			if (
				/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/.test(title) ||
				/\b(?:WHY|SUMMARY|NOTES|TESTS)\b/.test(title)
			)
				addBlock(
					finding("heading-case", `use sentence case in "${title}"`, index + 1),
				);
			continue;
		}
		const source = raw.trim();
		if (!source) continue;
		const listMarker = source.match(/^\s*(?:[-*+]|\d+[.)])\s+/);
		const units = listMarker
			? splitSentences(source.slice(listMarker[0].length))
			: splitSentences(source);
		for (const unit of units) {
			if (wordCount(unit) > MAX_WORDS)
				warnings.push(
					finding(
						"sentence-length",
						`use ${MAX_WORDS} words or fewer (found ${wordCount(unit)})`,
						index + 1,
					),
				);
		}
		for (const filler of FILLER_PATTERNS) {
			if (
				new RegExp(`\\b${filler.replaceAll(" ", "\\s+")}\\b`, "i").test(source)
			)
				warnings.push(finding("filler", `remove "${filler}"`, index + 1));
		}
		for (const match of source.matchAll(PASSIVE_RE))
			warnings.push(
				finding(
					"passive-voice",
					`prefer active voice near "${match[0].replace(/\s+/g, " ")}"`,
					index + 1,
				),
			);
	}
	return { valid: errors.length === 0, errors, warnings };
}

/**
 * The prose sections of a PR body (Why, Notes for the reviewer, Summary) with
 * their headings, each up to the next heading of any level. The boundaries are
 * the lexer's (#4717 N2): a setext or indented ATX `Tests` ends `## Summary`,
 * so its prose is not judged as Summary prose.
 */
export function proseSections(body = "") {
	const lines = String(body ?? "").split(/\r?\n/);
	const wanted = new Set(["why", "notes for the reviewer", "summary"]);
	const headings = markdownHeadings(body);
	return headings
		.flatMap((heading, index) =>
			heading.depth >= 2 &&
			heading.depth <= 4 &&
			wanted.has(heading.text.toLowerCase())
				? [
						lines
							.slice(heading.line, headings[index + 1]?.line ?? lines.length)
							.join("\n"),
					]
				: [],
		)
		.join("\n\n");
}

export { FILLER_PATTERNS };

// ---- Comment layout (docs/prose-standard.md "Comment layout", #5558) ----
//
// A posted triage, review, verify or status comment over COMMENT_FOLD_OVER
// non-blank lines shows at most COMMENT_VISIBLE_MAX of them, and puts the rest
// in `<details>` folds whose summary names a model. The gate admits a short
// list of recognised forms and refuses everything else (principles §1, gates
// fail closed): an unrecognised tag, a summary that is not "<Model> (<effort>):
// <what>" or "<Model>: <what>", a nested fold. A `<details>` inside a code
// fence is text, not a fold.
const COMMENT_FOLD_OVER = 12;
const COMMENT_VISIBLE_MAX = 8;
const LONG_OK_MIN_REASON = 12;
// A new model family is a one-line edit here, in the same PR that first uses it.
const MODEL_FAMILIES = [
	"claude",
	"opus",
	"sonnet",
	"haiku",
	"gpt",
	"codex",
	"sol",
	"luna",
	"deepseek",
	"qwen",
	"glm",
	"gemini",
	"muse",
	"kimi",
	"mistral",
	"llama",
	"grok",
];
const VENDOR_PREFIXES = ["claude", "anthropic", "openai", "codex"];
const EFFORT_RE =
	/^(?:thinking\s+)?(?:low|medium|high|xhigh|max|minimal|default)$/i;
const SUMMARY_RE = /^<summary>(.+)<\/summary>$/i;
const SUMMARY_FORM_RE =
	/^(?<model>[^():]+?)(?:\s*\((?<effort>[^()]+)\))?\s*:\s*(?<what>\S.*)$/;

function namesModel(model) {
	const words = model.trim().split(/\s+/);
	if (words.length > 6) return false;
	while (words.length > 1 && VENDOR_PREFIXES.includes(words[0].toLowerCase()))
		if (
			MODEL_FAMILIES.includes(words[1].replace(/[-.\d].*$/, "").toLowerCase())
		)
			words.shift();
		else break;
	if (!words.every((word) => /^[\w.-]+$/.test(word))) return false;
	const family = words[0].toLowerCase();
	return MODEL_FAMILIES.some(
		(name) => family === name || new RegExp(`^${name}[-.\\d]`).test(family),
	);
}

function summaryErrors(inner, at) {
	const form = SUMMARY_FORM_RE.exec(inner.trim());
	if (!form || !namesModel(form.groups.model))
		return [
			`comment-layout (line ${at}): the summary must name a model, as "<Model name> (<effort>): <what is inside>" or "<Model name>: <what is inside>" (found "${inner.trim()}")`,
		];
	if (form.groups.effort && !EFFORT_RE.test(form.groups.effort.trim()))
		return [
			`comment-layout (line ${at}): the summary effort "${form.groups.effort.trim()}" is not low, medium, high, xhigh, max, minimal or default`,
		];
	return [];
}

export function checkCommentLayout(text = "", options = {}) {
	const errors = [];
	const warnings = [];
	const lines = String(text ?? "").split(/\r?\n/);
	const nonBlank = lines.filter((line) => line.trim()).length;
	let fence = null;
	let open = 0;
	let visible = 0;
	let folds = 0;
	for (let index = 0; index < lines.length; index += 1) {
		const at = index + 1;
		const trimmed = lines[index].trim();
		const fenceMark = /^(`{3,}|~{3,})/.exec(trimmed)?.[1];
		if (fence) {
			if (
				fenceMark?.[0] === fence[0] &&
				fenceMark.length >= fence.length &&
				trimmed === fenceMark
			)
				fence = null;
			if (!open && trimmed) visible += 1;
			continue;
		}
		if (fenceMark) {
			fence = fenceMark;
			if (!open) visible += 1;
			continue;
		}
		if (/^<\/details/i.test(trimmed)) {
			if (!/^<\/details>$/i.test(trimmed))
				errors.push(
					`comment-layout (line ${at}): put </details> on a line of its own`,
				);
			else if (!open)
				errors.push(
					`comment-layout (line ${at}): </details> has no opening <details>`,
				);
			open = 0;
			continue;
		}
		if (/^<details/i.test(trimmed)) {
			const tag = /^<details(?:\s+open)?\s*>(.*)$/i.exec(trimmed);
			if (!tag) {
				errors.push(
					`comment-layout (line ${at}): unrecognised <details> tag; write <details> or <details open>`,
				);
				continue;
			}
			if (open) {
				errors.push(
					`comment-layout (line ${at}): nested <details>; use one fold per level`,
				);
				continue;
			}
			open = at;
			folds += 1;
			let summaryAt = index;
			let summaryText = tag[1].trim();
			if (!summaryText) {
				summaryAt = index + 1;
				while (summaryAt < lines.length && !lines[summaryAt].trim())
					summaryAt += 1;
				summaryText = (lines[summaryAt] ?? "").trim();
			}
			const summary = SUMMARY_RE.exec(summaryText);
			if (!summary) {
				errors.push(
					`comment-layout (line ${at}): each <details> needs a one-line <summary>...</summary> after it, with nothing following </summary>`,
				);
				continue;
			}
			errors.push(...summaryErrors(summary[1], summaryAt + 1));
			if ((lines[summaryAt + 1] ?? "x").trim())
				errors.push(
					`comment-layout (line ${summaryAt + 1}): leave a blank line after </summary>, or the Markdown in the fold does not render`,
				);
			index = summaryAt;
			continue;
		}
		if (!open && trimmed) visible += 1;
	}
	if (open)
		errors.push(
			`comment-layout (line ${open}): unclosed <details>; add </details>`,
		);
	const reason = options.longOk?.trim();
	const waived = reason && reason.length >= LONG_OK_MIN_REASON;
	if (options.longOk !== undefined && !waived)
		errors.push(
			`comment-layout: --long-ok needs a reason of ${LONG_OK_MIN_REASON} or more characters`,
		);
	if (nonBlank > COMMENT_FOLD_OVER) {
		const over = [];
		if (!folds) over.push(`no <details> fold`);
		else if (visible > COMMENT_VISIBLE_MAX)
			over.push(
				`the visible part has ${visible} non-blank lines (max ${COMMENT_VISIBLE_MAX})`,
			);
		if (over.length && waived)
			warnings.push(`layout-waived: ${reason} (${over.join("; ")})`);
		else if (over.length)
			errors.push(
				`comment-layout: ${nonBlank} non-blank lines, over ${COMMENT_FOLD_OVER}, with ${over.join("; ")}; fold the detail under <details> (docs/prose-standard.md "Comment layout")`,
			);
	}
	return { errors, warnings };
}

if (isMainModule(import.meta.url)) {
	const fileIndex = process.argv.indexOf("--body-file");
	const json = process.argv.includes("--json");
	const input =
		fileIndex === -1
			? readFileSync(0, "utf8")
			: readFileSync(process.argv[fileIndex + 1], "utf8");
	const result = checkProse(input);
	const longOkIndex = process.argv.indexOf("--long-ok");
	if (process.argv.includes("--comment")) {
		const layout = checkCommentLayout(input, {
			longOk:
				longOkIndex === -1 ? undefined : (process.argv[longOkIndex + 1] ?? ""),
		});
		result.errors.push(...layout.errors);
		result.warnings.push(...layout.warnings);
		result.valid = result.errors.length === 0;
	} else if (longOkIndex !== -1) {
		result.errors.push("--long-ok applies to --comment only");
		result.valid = false;
	}
	if (json) console.log(JSON.stringify(result));
	else {
		for (const error of result.errors) console.error(error);
		for (const warning of result.warnings) console.warn(`warning: ${warning}`);
	}
	process.exitCode = result.valid ? 0 : 1;
}
