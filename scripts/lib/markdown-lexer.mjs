// The one CommonMark reader behind the repository's markdown gates (#4717).
//
// Every question "does the reader see this?" (is this a heading, is this a
// comment, is this code) is answered by `marked`'s lexer, never by a scan of
// our own: four review rounds on #4717 each found one more spelling a
// hand-written comment and code-span scanner missed. This module only places
// the lexer's own tokens back onto the source's offsets.
//
// `marked` is loaded lazily, on the first call, so a script that imports this
// module and never reads markdown structure (`scripts/check-close-keywords.mjs`
// in the `Close-keyword syntax` and `Verify merged PR close keywords` jobs,
// which run with no install) never resolves it. The `PR body (advisory)` job
// installs marked alone, pinned by the lockfile's integrity
// (`.github/workflows/pr-metadata.yml`). A missing install throws: a gate that
// cannot read the body must not read it as clean.
import { createRequire } from "node:module";

// A plain `require` binding, so knip sees the dependency; calling it stays
// lazy.
const require = createRequire(import.meta.url);
let lexMarkdown = null;

function lex(source) {
	if (!lexMarkdown) {
		const { Lexer, getDefaults } = require("marked");
		// A fresh defaults object, so a `marked.use()` elsewhere in the process
		// (pi-tui renders with marked) cannot change what the gate reads.
		lexMarkdown = (text) =>
			new Lexer({ ...getDefaults(), gfm: true }).lex(text);
	}
	return lexMarkdown(source);
}

/** `\r\n` and lone `\r` become `\n`, as the lexer reads them. */
function normalized(text) {
	return String(text ?? "").replace(/\r\n?/g, "\n");
}

/**
 * A token's child tokens as the reader nests them: a list's items, a table's
 * cell contents, any other token's own `tokens`. Empty for a leaf.
 */
export function markdownChildren(token) {
	if (token.type === "list") return token.items;
	if (token.type === "table")
		return [...token.header, ...token.rows.flat()].flatMap(
			(cell) => cell.tokens ?? [],
		);
	return token.tokens ?? [];
}

/**
 * Place `raw` inside `[cursor, limit)` of `source`, line by line: a nested
 * token's raw text has its container's prefix (`> `, a list indent) removed,
 * so each of its lines is found on its own, in order, and never outside the
 * token's parent (#4717 N4). Returns the spans, or null when a line is not
 * found there (a table cell's `\|` reaches the lexer as `|`).
 */
function place(source, raw, cursor, limit) {
	const spans = [];
	let at = cursor;
	for (const piece of raw.split("\n")) {
		if (!piece) continue;
		const index = source.indexOf(piece, at);
		if (index === -1 || index + piece.length > limit) return null;
		spans.push([index, index + piece.length]);
		at = index + piece.length;
	}
	return { spans, end: at };
}

/**
 * The top-level blocks of `source` with their offsets, and every leaf token
 * (one with no children: text, code, html, a code span) in document order
 * with its source spans, or null when it, or a token holding it, cannot be
 * placed. The blocks' raw text covers the source exactly, in order
 * (`tests/scripts/markdown-lexer.test.ts` pins it over every markdown file in
 * the repository). Each token is placed inside its parent's span, before its
 * children, and the cursor then moves past all of it, so text a token holds
 * outside its children (a link's destination) never takes a later token's
 * place.
 */
function layout(source) {
	const blocks = [];
	const leaves = [];
	let offset = 0;
	for (const token of lex(source)) {
		const block = { token, start: offset, end: offset + token.raw.length };
		offset = block.end;
		let cursor = block.start;
		const visit = (node, limit, block) => {
			const placed =
				limit === null ? null : place(source, node.raw ?? "", cursor, limit);
			const kids = markdownChildren(node);
			if (!kids.length)
				leaves.push({ token: node, spans: placed?.spans ?? null, block });
			if (placed) cursor = placed.spans[0]?.[0] ?? cursor;
			for (const kid of kids) visit(kid, placed ? placed.end : null, block);
			if (placed) cursor = placed.end;
		};
		visit(token, block.end, block);
		blocks.push(block);
	}
	return { blocks, leaves };
}

/**
 * The comments in an HTML token's text, as the browser reads them (the HTML
 * tokenizer's comment states, not CommonMark's): `<!-->` and `<!--->` end at
 * once, any other comment at its first `-->` or `--!>`, and one with no end
 * runs to the end of the text, still open. `open` starts the text inside a
 * comment an earlier token left open. Offsets are into `raw`.
 */
function commentRanges(raw, open = false) {
	const ranges = [];
	let at = open ? 0 : raw.indexOf("<!--");
	let body = open ? 0 : at + 4;
	while (at !== -1) {
		let end = -1;
		if (!open && raw.startsWith(">", body)) end = body + 1;
		else if (!open && raw.startsWith("->", body)) end = body + 2;
		else {
			const close = /--!?>/g;
			close.lastIndex = body;
			const match = close.exec(raw);
			if (match) end = match.index + match[0].length;
		}
		ranges.push({
			from: at,
			to: end === -1 ? raw.length : end,
			closed: end !== -1,
		});
		if (end === -1) break;
		open = false;
		at = raw.indexOf("<!--", end);
		body = at + 4;
	}
	return ranges;
}

/** The source spans of `raw`'s range `[from, to)`, through its placed lines. */
function sourceSpans(raw, spans, from, to) {
	const out = [];
	let offset = 0;
	let line = 0;
	for (const piece of raw.split("\n")) {
		if (piece) {
			const low = Math.max(from, offset);
			const high = Math.min(to, offset + piece.length);
			if (low < high)
				out.push([
					spans[line][0] + low - offset,
					spans[line][0] + high - offset,
				]);
			line += 1;
		}
		offset += piece.length + 1;
	}
	return out;
}

/**
 * The source a comment hides past the HTML token that opened it. GitHub
 * passes raw HTML through, so a comment a token leaves open (an unterminated
 * `<!--` in a list item, or after a closed one on a block comment's line)
 * hides everything after it, headings included, until the `-->` or `--!>` of
 * a later raw-HTML token, or to the end of the text (#4717 N6). A `-->` the
 * renderer escapes (text, code) ends nothing.
 */
function carriedComments(leaves, length) {
	const carried = [];
	let open = null;
	for (const { token, spans } of leaves) {
		if (token.type !== "html" || !spans) continue;
		const ranges = commentRanges(token.raw, open !== null);
		if (open !== null) {
			if (!ranges[0].closed) continue;
			const [last] = sourceSpans(
				token.raw,
				spans,
				ranges[0].to - 1,
				ranges[0].to,
			);
			carried.push([open, last[1]]);
			open = null;
		}
		const tail = ranges.at(-1);
		if (tail && !tail.closed)
			open = sourceSpans(token.raw, spans, tail.from, tail.from + 1)[0][0];
	}
	if (open !== null) carried.push([open, length]);
	return carried;
}

// What a mode blanks. `code`: "blocks" (fenced and indented), "fenced"
// (indented code stays text) or false. `html`: "blocks" (every raw-HTML block
// and every inline comment), "comments" (the comments inside raw-HTML blocks,
// and inline comments) or false; either also blanks what a comment left open
// hides past its token. `codeSpans`: true blanks inline code.
function isTarget(token, mode) {
	if (token.type === "code")
		return (
			mode.code === "blocks" ||
			(mode.code === "fenced" && token.codeBlockStyle !== "indented")
		);
	if (token.type === "html") {
		if (token.block)
			return (
				mode.html === "blocks" ||
				(mode.html === "comments" && token.raw.includes("<!--"))
			);
		return Boolean(mode.html) && token.raw.startsWith("<!--");
	}
	if (token.type === "codespan") return Boolean(mode.codeSpans);
	return false;
}

/**
 * The source spans a placed target hides: all of it, except a raw-HTML block
 * under `html: "comments"`, which hides only its comments (GitHub shows the
 * rest of the block, #4565).
 */
function hiddenSpans(token, mode, spans) {
	if (!(token.type === "html" && token.block && mode.html === "comments"))
		return spans;
	return commentRanges(token.raw).flatMap(({ from, to }) =>
		sourceSpans(token.raw, spans, from, to),
	);
}

/**
 * `text` with the regions `mode` names replaced by spaces. Line breaks are
 * kept, and so is every other character, so line numbers and offsets still
 * match the input (`\r\n` included). Fail closed: a target the lexer reports
 * but this module cannot place inside its block blanks the whole block.
 */
export function blankMarkdownRegions(text, mode) {
	const original = String(text ?? "");
	const source = normalized(original);
	const mask = new Uint8Array(source.length);
	const { leaves } = layout(source);
	const unplaced = new Set(
		leaves
			.filter((leaf) => !leaf.spans && isTarget(leaf.token, mode))
			.map((leaf) => leaf.block),
	);
	for (const block of unplaced) mask.fill(1, block.start, block.end);
	for (const leaf of leaves)
		if (leaf.spans && !unplaced.has(leaf.block) && isTarget(leaf.token, mode))
			for (const [from, to] of hiddenSpans(leaf.token, mode, leaf.spans))
				mask.fill(1, from, to);
	if (mode.html)
		for (const [from, to] of carriedComments(leaves, source.length))
			mask.fill(1, from, to);
	return restoreLineEnds(original, apply(source, mask));
}

function apply(source, mask) {
	let out = "";
	for (let index = 0; index < source.length; index += 1)
		out += mask[index] && source[index] !== "\n" ? " " : source[index];
	return out;
}

function restoreLineEnds(original, blanked) {
	if (!original.includes("\r")) return blanked;
	let out = "";
	let j = 0;
	for (let i = 0; i < original.length; i += 1, j += 1) {
		if (original[i] === "\r") {
			out += original[i + 1] === "\n" ? "\r\n" : "\r";
			if (original[i + 1] === "\n") i += 1;
			continue;
		}
		out += blanked[j];
	}
	return out;
}

/**
 * A heading's name as GitHub renders it: the text of its inline tokens, with
 * emphasis, links and code spans read as their text and inline HTML (a
 * comment) dropped (#4717 N7).
 */
function plainText(tokens) {
	return tokens
		.map((token) => {
			if (token.type === "html") return "";
			if (token.tokens) return plainText(token.tokens);
			return token.text ?? "";
		})
		.join("");
}

/**
 * The top-level headings, as the reader sees them: a heading inside a list
 * item, a block quote, a raw-HTML block or a comment (including one an
 * earlier token left open) is not a section of the document, so it is not
 * here. `line` is the heading's first line and `contentLine` the first line
 * after it (a setext underline is part of the heading), both 0-based over
 * `text.split(/\r?\n/)`.
 */
export function markdownHeadings(text) {
	const source = normalized(text);
	const { blocks, leaves } = layout(source);
	const hidden = carriedComments(leaves, source.length);
	const headings = [];
	for (const { token, start } of blocks) {
		if (token.type !== "heading") continue;
		if (hidden.some(([from, to]) => start >= from && start < to)) continue;
		const line = lineOf(source, start);
		headings.push({
			line,
			contentLine: line + token.raw.replace(/\n+$/, "").split("\n").length,
			depth: token.depth,
			text: plainText(token.tokens ?? [])
				.replace(/\s+/g, " ")
				.trim(),
		});
	}
	return headings;
}

/**
 * The lexer's top-level tokens in document order, each with its first line
 * (0-based over `text.split(/\r?\n/)`). A budget reads the whole tree from
 * here instead of scanning the text for the constructs it knows (#5026): a
 * token kind nobody listed is still a token, and the caller counts it.
 */
export function markdownTokens(text) {
	const source = normalized(text);
	let offset = 0;
	return lex(source).map((token) => {
		const line = lineOf(source, offset);
		offset += token.raw.length;
		return { token, line };
	});
}

/**
 * The first line (0-based over `text.split(/\r?\n/)`) of every top-level
 * raw-HTML block that opens with a comment, as the reader sees it: a `<!--`
 * inside a fence, a code span, a list item or an earlier open comment is not
 * one (#4774). A bot that edits a PR body marks its block with such a line.
 */
export function markdownBlockComments(text) {
	const source = normalized(text);
	const { blocks, leaves } = layout(source);
	const hidden = carriedComments(leaves, source.length);
	const lines = [];
	for (const { token, start } of blocks) {
		if (token.type !== "html" || !token.raw.trimStart().startsWith("<!--"))
			continue;
		const at = start + token.raw.length - token.raw.trimStart().length;
		if (hidden.some(([from, to]) => at > from && at < to)) continue;
		lines.push(lineOf(source, at));
	}
	return lines;
}

function lineOf(source, offset) {
	let line = 0;
	for (
		let index = source.indexOf("\n");
		index !== -1 && index < offset;
		index = source.indexOf("\n", index + 1)
	)
		line += 1;
	return line;
}
