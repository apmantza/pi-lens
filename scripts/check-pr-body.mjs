import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gitExecFileSync } from "./lib/git-fixture-env.mjs";
import {
	blankMarkdown,
	blankHtmlComments,
	codeSpanMasked,
	HEADING,
	parseDefectShapes,
	sourceWithoutFencedBlocks,
} from "./lib/defect-shapes.mjs";
import {
	blankMarkdownRegions,
	markdownBlockComments,
	markdownChildren,
	markdownHeadings,
	markdownTokens,
} from "./lib/markdown-lexer.mjs";
import { splitMarkdownRow } from "./lib/markdown-cell.mjs";
import { githubGet, parseOwnerRepoFromGitRemote } from "./lib/github-rest.mjs";
import {
	changedHookAnchors,
	evaluateTlaCoverage,
	loadCoverageMap,
	matchGlob,
	parseChangedFiles,
	withoutDeclaredFamilies,
} from "./lib/tla-coverage.mjs";
import { evaluateWorkflowRunEvidence } from "./lib/workflow-run-evidence.mjs";
import {
	closeKeywordErrors,
	closeKeywordPlacementMessage,
	lintCloseKeywordPlacement,
	lintCloseKeywords,
	parseCloseKeywords,
} from "./lib/close-keywords.mjs";
import { checkProse, proseSections } from "./check-prose.mjs";

const TEMPLATE_PATH = ".github/PULL_REQUEST_TEMPLATE.md";

// #4361: the numbered defect-shape entries live here; AGENTS.md keeps the
// trigger-grouped index. Read from the PR's base commit, never the checkout.
const SHAPE_CATALOG_PATH = "docs/defect-shapes.md";
const TEMPLATE_FILE = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	TEMPLATE_PATH,
);
// The coverage map is a repository artifact, so it resolves from THIS script's
// checkout root, never the caller's cwd: the fixture repos the check-pr-body
// tests build carry no `formal/` tree, and a diff path is repo-relative.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REQUIRED_SECTIONS = [
	"Summary",
	"Notes for the reviewer",
	"Change outline",
	"Proof and checks",
	"Tests",
	"Class sweep",
	"Observability",
	"Fold check",
];
// The one list of alignment families (#5026). The script keeps no copy: the
// names are parsed from this file's table on every lint.
const ALIGNMENT_FAMILIES_PATH = "docs/alignment-families.md";
const ALIGNMENT_NONE_MIN_REASON = 12;
// #5003: what a reader scrolls past. Code holds the required transcripts, so
// it stays out of the character count and is capped by its own lines, width
// and body-wide total instead. Every cap reads the lexer's token tree
// (`lintBodyBudgets`); none is a scan for a spelling.
const SUMMARY_MAX_SENTENCES = 3;
const SUMMARY_MAX_CHARS = 600;
const REVIEWER_NOTES_MAX_BULLETS = 5;
const VISIBLE_BODY_MAX_CHARS = 5000;
const CODE_MAX_LINES = 20;
// A chosen bound, not a pinned measurement: the last 80 merged bodies put the
// p90 of their widest code line at 391 columns, so 400 admits a long test path
// and its title (verify r2 on #5026; 240 refused 28 of the 80).
const CODE_MAX_WIDTH = 400;
const CODE_TOTAL_MAX_LINES = 100;
// The PR footer the template requires (.github/PULL_REQUEST_TEMPLATE.md).
const GENERATED_FOOTER =
	/^🤖 Generated with \[Claude Code\]\(https:\/\/claude\.com\/claude-code\)$/;
const FLATTENED_BODY_MAX_NEWLINES = 2;
// One post-image read bound, shared by the git and working-tree branches of
// `headFileSource`: a file-count bound alone is not a byte bound.
const MAX_SOURCE_BYTES = 16 * 1024 * 1024;
// The unclassifiable-post-image notice names at most this many files, then the
// remainder as a count (#4585 row classification is an agent-facing surface).
const UNCLASSIFIED_REPORT_LIMIT = 5;
const REPAIR_HEADINGS = [
	"Why",
	"Notes for the reviewer",
	"Change outline",
	"Proof and checks",
	"Summary",
	"Tests",
	"Test assessment",
	"Blast radius",
	"Class sweep",
	// #4711: a required section the flattened-body repair does not recognize
	// cannot be recovered, so a flattened body would owe it forever.
	"Fold check",
	"Observability",
	"Fix round \\d+",
	"Review round \\d+",
];
const REPAIR_HEADING_PATTERN = REPAIR_HEADINGS.join("|");
const CORRUPTED_HEADING_TAILS = [
	"hy",
	"otes for the reviewer",
	"hange outline",
	"roof and checks",
	"ummary",
	"ests",
	"est assessment",
	"last radius",
	"lass sweep",
	"bservability",
	"ix round \\d+",
	"eview round \\d+",
];
const CORRUPTED_IDENTIFIER_TAILS = ["etchOpenPullRequests", "px"];

// Fleet census from the review of 11 bodies: ## OBSERVABILITY x5,
// ## what changed x6, ## verification x7, and ## Summary x1. “What changed”
// (with or without “and why”) satisfies Summary; “Verification” satisfies
// Tests. Heading matching is deliberately case-insensitive. #5003: `Why` folded
// into `Summary` and still reads as it, so an open body keeps its structure.
const SECTION_SYNONYMS = new Map([
	["why", "summary"],
	["notes for the reviewer", "notes for the reviewer"],
	["change outline", "change outline"],
	["proof and checks", "proof and checks"],
	["summary", "summary"],
	["problem", "summary"],
	["what changed", "summary"],
	["what changed and why", "summary"],
	["what changed / why", "summary"],
	["what changed / why / verification", ["summary", "tests"]],
	["tests", "tests"],
	["verification", "tests"],
	["blast radius", "blast radius"],
	["class sweep", "class sweep"],
	// #4711: AGENTS.md's fold check is recorded here, so the body lint reads the
	// same heading the maintainer's local script gates on.
	["fold check", "fold check"],
	["behavior equivalence", "behavior equivalence"],
	["observability", "observability"],
	["test assessment", "test assessment"],
	// #4288: required only when the PR closes a bug-labelled issue, so it stays
	// out of REQUIRED_SECTIONS and is added per-request in `lintPrBody`.
	["detection", "detection"],
	// The merge policy calls it a "detection retrospective"; accept that heading
	// so an author following the prose is not answered with the generic message.
	["detection retrospective", "detection"],
]);
const REVIEW_HEADER_REPAIR_PREFIX =
	"## Why\nLegacy body normalized for the required review contract.\n\n" +
	"## Notes for the reviewer\n- None.\n\n" +
	"## Change outline\n- existing body structure\n\n" +
	"## Proof and checks\nThe sections below hold the proof.\n";

function sectionMessage(name, detail) {
	return `PR body ${detail} "## ${name}". See ${TEMPLATE_PATH}.`;
}

function hasSection(heading, section) {
	return Array.isArray(heading?.section)
		? heading.section.includes(section)
		: heading?.section === section;
}

function templatePlaceholderLines() {
	const lines = sourceWithoutFencedBlocks(
		readFileSync(TEMPLATE_FILE, "utf8"),
	).split(/\r?\n/);
	const placeholders = new Map();
	let current;
	for (const line of lines) {
		const heading = HEADING.exec(line);
		if (heading) {
			current = SECTION_SYNONYMS.get(heading[1].trim().toLowerCase());
			continue;
		}
		const value = line.trim();
		// Exact placeholder matching is intentionally advisory: paste-and-tweak
		// residuals can evade it when a contributor changes one word.
		if (current && value && !/^[-*+] \[ \]/.test(value)) {
			if (!placeholders.has(current)) placeholders.set(current, new Set());
			placeholders.get(current).add(value);
		}
	}
	return placeholders;
}

/**
 * Does a section hold content the reader sees? `lines` is a slice of the
 * blanked body starting at absolute line `startLine`, and `structure` maps a
 * heading line's index to its name (`headingLines(...).name`). Structure is
 * answered by the line a heading occupies, in the same reading the slice came
 * from (#4717 F5): a body-wide set of heading *text* both counted a commented
 * heading as content, because the slice is comment-blanked and the heading's
 * raw line is not, and dropped an answer whose words repeat a setext heading's
 * title.
 */
function hasRealContent(
	lines,
	section,
	placeholders,
	structure,
	startLine = 0,
) {
	const templateLines = placeholders.get(section) ?? new Set();
	return lines.some((line, offset) => {
		const value = line.trim();
		// A nested heading is structure, not content: counting it let an empty
		// "## Tests" pass on the strength of its own "### Test assessment" line
		// (#2124 review F1). `structure` is the lexer's heading lines, so a
		// family the `HEADING` regex cannot spell is structure too (#4717 F1).
		return (
			value &&
			!structure.has(startLine + offset) &&
			!/^[-*+] \[ \]/.test(value) &&
			!templateLines.has(value)
		);
	});
}

/**
 * The lines the reader sees as headings, from the lexer (#4717 F1). `name`
 * maps each of a heading's line indices to its text, for a caller scanning the
 * body's rows and for `hasRealContent`, which asks whether a line of its slice
 * is one. A setext heading's underline and an indented ATX heading are
 * structure here exactly as a plain ATX one is, so no reader of a body needs a
 * heading regex of its own.
 */
function headingLines(body, headings = bodyHeadings(body)) {
	const name = new Map();
	for (const heading of headings) {
		for (let line = heading.index; line < heading.contentIndex; line += 1) {
			name.set(line, heading.name);
		}
	}
	return { name };
}

/**
 * Every heading of the body AS THE READER SEES IT, from the lexer (#4717): a
 * heading inside a comment, a raw-HTML block, a list item or a block quote is
 * not a section, a setext or indented ATX heading is one, and a heading's name
 * is its text without closing marks. Every level ends the sections below it;
 * levels 2 to 4 name one (#1844 accepts H3 and H4 section headings). `index`
 * is its first line and `contentIndex` the first line of its section, over
 * `body.split(/\r?\n/)`.
 */
function bodyHeadings(body) {
	return markdownHeadings(body).map((heading) => ({
		index: heading.line,
		contentIndex: heading.contentLine,
		name: heading.text,
		level: heading.depth,
		section:
			heading.depth >= 2 && heading.depth <= 4
				? SECTION_SYNONYMS.get(heading.text.toLowerCase())
				: undefined,
	}));
}

/**
 * The author's text (#4774). A bot that edits a PR body appends its block
 * after the author's last section, so the last section would otherwise run
 * into it: Greptile's "Last reviewed commit" link quotes a commit title that
 * ends `(refs #N)`, and `## Fold check`, the template's last section, read
 * that `#N` as a candidate with no decision. The body ends at the first
 * top-level HTML comment after the last heading the template names; every
 * bot marks its block with one, so no bot is named here and an unknown bot
 * is cut too. A comment the author wrote before a later template heading
 * stays in the body, where the section readers blank it.
 *
 * The direction is NOT fail closed for text the cut drops. The rule cannot
 * tell an author's own top-level comment after the last template heading from
 * a bot marker, so everything behind such a comment is dropped: an author's
 * later undecided `#N` line in `## Fold check` is not read, and the check
 * passes where the full body would refuse (accepted p3 residual, live 0 in
 * the last 200 bodies). A bot block with an author section behind it ends the
 * text at the block the same way.
 *
 * Only a SECTION reader reads the cut text. A reader that owns a GitHub
 * semantic reads `fullBody`, because GitHub acts on the whole body: the
 * closing keywords (`closedIssues`, `resolveBugClosing`, `lintCloseKeywords`,
 * `lintCloseKeywordPlacement`, and the `Closes #N` that `lintFoldCheck`
 * requires of a `folded` candidate) all see the text a bot block precedes.
 */
function authorText(body = "") {
	const source = String(body ?? "");
	const lastAuthored = bodyHeadings(source).findLast(
		(heading) => heading.section !== undefined,
	);
	const cut = markdownBlockComments(source).find(
		(line) => line > (lastAuthored?.index ?? -1),
	);
	return cut === undefined
		? source
		: source.split("\n").slice(0, cut).join("\n");
}

/**
 * The lines the reader sees as a section's text, from its heading to the next
 * heading of the same or a higher level. Every raw-HTML block and inline
 * comment is dropped (fail closed: GitHub renders no section inside one, and
 * an answer written there is not a visible answer). `text` keeps code, because
 * a search command is quoted in one; `visible` blanks code blocks too. `null`
 * when the heading is absent, so the missing-section message stays owned by
 * `lintPrBody`. Every section linter reads a section this way.
 */
function sectionLines(body, headings = bodyHeadings(body)) {
	const text = blankMarkdownRegions(body, { html: "blocks" }).split(/\r?\n/);
	const visible = blankMarkdown(body, { htmlBlocks: true }).split(/\r?\n/);
	const of = (heading) => {
		const next = headings.find(
			(candidate) =>
				candidate.index > heading.index && candidate.level <= heading.level,
		);
		const end = next?.index ?? text.length;
		return {
			start: heading.contentIndex,
			raw: String(body ?? "")
				.split(/\r?\n/)
				.slice(heading.contentIndex, end),
			text: text.slice(heading.contentIndex, end),
			visible: visible.slice(heading.contentIndex, end),
		};
	};
	return { text, visible, of };
}

function sectionContent(body, section) {
	const headings = bodyHeadings(body);
	const heading = headings.find((candidate) => hasSection(candidate, section));
	if (!heading) return null;
	const lines = sectionLines(body, headings).of(heading);
	return {
		start: lines.start,
		raw: lines.raw.join("\n"),
		text: lines.text.join("\n"),
		visible: lines.visible.join("\n"),
	};
}

function blankCommentsAndStrings(source) {
	let state = "code";
	let result = "";
	const strings = [];
	let stringStart = -1;
	let stringPrefixEnd = 0;
	let previousToken = null;
	const prefixEnds = [];
	// ECMAScript's lexical grammar permits a RegularExpressionLiteral where an
	// expression starts. Classify the preceding token by whether it can end an
	// expression; this covers expression-start keywords and punctuators without
	// maintaining a list of individual regex contexts.
	const expressionEndingPunctuation = new Set([")", "]", "}", "++", "--"]);
	const expressionStartKeywords = new Set([
		"await",
		"case",
		"delete",
		"do",
		"else",
		"in",
		"instanceof",
		"new",
		"of",
		"return",
		"throw",
		"typeof",
		"void",
		"yield",
	]);
	const regexMayStart = (token) => {
		if (token === null || expressionStartKeywords.has(token)) return true;
		if (expressionEndingPunctuation.has(token)) return false;
		return !/[$\w]/.test(token);
	};
	const decoded = (value) => value.replace(/\\([\s\S])/g, "$1");
	for (let index = 0; index < source.length; index += 1) {
		const char = source[index];
		const next = source[index + 1];
		if (state === "line-comment") {
			result += char === "\n" ? "\n" : " ";
			if (char === "\n") state = "code";
			continue;
		}
		if (state === "block-comment") {
			result += char === "\n" ? "\n" : " ";
			if (char === "*" && next === "/") {
				result += " ";
				index += 1;
				state = "code";
			}
			continue;
		}
		if (state === "regex" || state === "regex-class") {
			result += char === "\n" ? "\n" : " ";
			if (char === "\\") {
				if (next === "\n") result += "\n";
				else {
					result += " ";
					index += 1;
				}
			} else if (state === "regex" && char === "[") state = "regex-class";
			else if (state === "regex-class" && char === "]") state = "regex";
			else if (state === "regex" && char === "/") {
				state = "code";
				previousToken = "value";
			}
			continue;
		}
		if (state !== "code") {
			result += char === "\n" ? "\n" : " ";
			if (char === "\\") {
				if (next === "\n") result += "\n";
				else {
					result += " ";
					index += 1;
				}
			} else if (char === state) {
				strings.push({
					start: stringStart,
					end: index + 1,
					quote: state,
					text: decoded(source.slice(stringStart + 1, index)),
					prefix: "",
				});
				prefixEnds.push(stringPrefixEnd);
				state = "code";
				previousToken = "value";
			}
			continue;
		}
		if (char === "/" && next === "/") {
			result += "  ";
			index += 1;
			state = "line-comment";
		} else if (char === "/" && next === "*") {
			result += "  ";
			index += 1;
			state = "block-comment";
		} else if (char === "/" && regexMayStart(previousToken)) {
			result += " ";
			state = "regex";
		} else if (char === "'" || char === '"' || char === "`") {
			result += " ";
			stringStart = index;
			stringPrefixEnd = result.length;
			state = char;
			previousToken = "string";
		} else {
			result += char;
			if (/[$\w]/.test(char)) {
				let wordEnd = index + 1;
				while (/[$\w]/.test(source[wordEnd] ?? "")) wordEnd += 1;
				const word = source.slice(index, wordEnd);
				result += word.slice(1);
				index = wordEnd - 1;
				previousToken = word;
			} else if (char === next && (char === "+" || char === "-")) {
				result += next;
				index += 1;
				previousToken = char + next;
			} else if (!/\s/.test(char)) previousToken = char;
		}
	}
	// The 256 blanked characters before each string's opening quote are read
	// from the finished text: slicing `result` inside the loop flattened the
	// whole concatenation per string, quadratic in the file (#4088).
	strings.forEach((string, at) => {
		const end = prefixEnds[at];
		string.prefix = result.slice(Math.max(0, end - 256), end).trimEnd();
	});
	return { text: result, strings };
}

export { blankCommentsAndStrings };

// `index.ts` is the pi host adapter (AGENTS.md's runtime list), so a record it
// adds is as real as one under clients/ (#2915).
function isRuntimeObservabilityPath(name) {
	if (name === "index.ts") return true;
	return (
		/^(?:clients|tools|mcp)\//.test(name) &&
		!/(?:^|\/)__tests__(?:\/|$)/.test(name) &&
		!/\.test\.[^/]+$/.test(name) &&
		!/\.d\.(?:ts|mts)$/.test(name)
	);
}

// #3875: a decision branch on a session, lifecycle or delivery seam is not a
// failure path, so the failure-path test above let `if (adopt) ... else reset`
// pass with "No new failure path; no record added." and the S2/S3 fixes of
// 2026-09-30 shipped with no record to read back (#3873). The seam is every
// row of the checked-in `formal/coverage-map.json` (the lifecycle, timing and
// identity files #3802 maintains), hub and `unmodelled` rows included: the
// 50-PR calibration in the #3875 body flagged nothing extra for them.
const DECISION_BRANCH_G = /\bif\s*\(|\belse\b|\bswitch\s*\(|\bcase\b/g;

// The failure-path tokens the Observability lint counts, by kind. Every spelling
// of one kind is the same kind, so a re-spell of the whitespace between `return`
// and `null` never reads as a new token (#5019).
const FAILURE_TOKEN_G =
	/\b(catch|recordDegradationOnce|throw|return\s+null)\b/g;

// Failure tokens per kind in comment- and string-blanked text, added into
// `counts` when a caller passes one.
function countFailureTokens(text, counts = new Map()) {
	for (const match of text.matchAll(FAILURE_TOKEN_G)) {
		const kind = match[1].replace(/\s+/g, " ");
		counts.set(kind, (counts.get(kind) ?? 0) + 1);
	}
	return counts;
}

function loadSeamMap(cwd = REPO_ROOT) {
	try {
		return loadCoverageMap(cwd);
	} catch {
		// lintTlaCoverage already reports an unreadable map as an error.
		return null;
	}
}

function isSeamFile(file, map) {
	return Object.keys(map?.map ?? {}).some((glob) => matchGlob(glob, file));
}

// `git diff --unified=0` hands a hunk to a lexer without the block-comment
// opener its continuation lines belong to, so prose such as `case` in a JSDoc
// body read as code, a backtick in one opened a template string that hid the
// code after it (#3774), and a prose `recordDegradationOnce(...)` satisfied the
// record check (#3906). The opener cannot be recovered from the hunk: the line
// ` * name(...) {` is lexically identical as a JSDoc continuation and as a JS
// generator head, so no line-local predicate can decide it (#3906 N1).
//
// The harvest therefore carries the post-image identity the diff names — the
// `index <post>` blob oid, read back with `git cat-file -p` — where the
// `/**` opener IS present, lexes it once with `blankCommentsAndStrings`, and
// intersects the evidence it finds with the hunk's added POST-image lines. The
// line numbers come from the hunk's `+start` offset and are checked against the
// post-image text before use, so a renamed or concurrently edited image is
// refused instead of misread (never a false clean, never a wrong
// "no record added"). Carrying the blob oid — not re-reading the working tree —
// is what keeps an unchanged opener outside the diff from flipping the lexical
// state (#3906 r4 R3-A).

// Git quotes a `diff --git` path that holds a non-ASCII byte, a `"`, a `\\`,
// or a control character, and C-escapes it. A quoted runtime path must still be
// read or the harvest silently skips the file (a false clean).
function unquoteGitPath(raw) {
	const value = String(raw);
	if (!value.startsWith('"')) return value;
	// Git C-quotes path bytes, so an octal escape is one UTF-8 byte, not a
	// code point: collect bytes and decode the path once.
	const bytes = [];
	for (let index = 1; index < value.length; index += 1) {
		const char = value[index];
		if (char === '"') break;
		if (char !== "\\") {
			bytes.push(char.charCodeAt(0));
			continue;
		}
		const escaped = value[++index];
		if (escaped === "n") bytes.push(0x0a);
		else if (escaped === "t") bytes.push(0x09);
		else if (escaped === "r") bytes.push(0x0d);
		else if (escaped !== undefined && /[0-7]/.test(escaped)) {
			bytes.push(Number.parseInt(value.slice(index, index + 3), 8));
			index += 2;
		} else if (escaped !== undefined) bytes.push(escaped.charCodeAt(0));
	}
	return Buffer.from(bytes).toString("utf8");
}

function readQuotedPath(source, start) {
	if (source[start] !== '"') return null;
	let raw = '"';
	for (let index = start + 1; index < source.length; index += 1) {
		const char = source[index];
		raw += char;
		if (char === "\\") {
			index += 1;
			if (index < source.length) raw += source[index];
			continue;
		}
		if (char === '"') return { value: unquoteGitPath(raw), end: index + 1 };
	}
	return null;
}

// `diff --git` path pair: two quoted tokens, or `a/<pre> b/<post>`. The
// pre-image path is kept so a rename away from a runtime path still counts.
function gitHeaderPaths(rest) {
	if (rest.startsWith('"')) {
		const first = readQuotedPath(rest, 0);
		if (!first || rest[first.end] !== " ") return null;
		const second = readQuotedPath(rest, first.end + 1);
		if (!second) return null;
		return {
			pre: first.value.replace(/^a\//, ""),
			post: second.value.replace(/^b\//, ""),
		};
	}
	const match = /^a\/(.+) b\/(.+)$/.exec(rest);
	if (!match) return null;
	return { pre: match[1], post: match[2] };
}

// Every file in the diff with the post-image line number of each added line and
// the immutable post-image blob oid the diff names. A real hunk resets the
// cursor from its `+start`; a bare fixture with no `@@` numbers its `+` lines
// from the top. `inHunk` separates the file header (`diff --git`, `index`,
// `rename to`, `--- a/…`, `+++ b/…`) from the hunk body: only in the header is
// a leading `+++`/`---` a file header. Inside a hunk an added code line that
// itself starts with `++` is emitted as `+++…` and must be harvested, not
// skipped (#3906 R3-B), and a removed `--…` line likewise must not advance the
// POST cursor.
//
// Each hunk also records the POST lines it adds and the removed lines it
// deletes, and removals are keyed by the POST line they follow, so a reader can
// pair a hunk's removals against its additions and rebuild the pre-image it
// came from (#5019).
function hunkFor(current) {
	// A bare fixture with no `@@` still gets one hunk, so its added lines are
	// additions with nothing to credit them against.
	if (!current.hunk) {
		current.hunk = { added: [], removed: [] };
		current.hunks.push(current.hunk);
	}
	return current.hunk;
}

export function parseRuntimeHunks(diff) {
	const files = [];
	let current = null;
	let inHunk = false;
	for (const line of String(diff).split(/\r?\n/)) {
		if (line.startsWith("diff --git ")) {
			const paths = gitHeaderPaths(line.slice("diff --git ".length));
			current = {
				pre: paths?.pre ?? "",
				post: paths?.post ?? "",
				postBlob: null,
				postLine: 1,
				added: new Map(),
				deletedAfter: new Set(),
				removed: [],
				removedAfter: new Map(),
				hunks: [],
				hunk: null,
				// The diff states a whole-file removal explicitly. It is the one
				// post-image state that needs no read: there is nothing to classify
				// (#4605 V2).
				deletedFile: false,
			};
			files.push(current);
			inHunk = false;
			continue;
		}
		if (!current) continue;
		if (!inHunk) {
			if (line.startsWith("deleted file mode ") || line === "+++ /dev/null")
				current.deletedFile = true;
			const rename = /^rename to (.+)$/.exec(line);
			if (rename) {
				current.post = unquoteGitPath(rename[1]);
				continue;
			}
			// `index <pre>..<post> [mode]` names the immutable post-image blob.
			const index = /^index ([0-9a-f]+)\.\.([0-9a-f]+)/.exec(line);
			if (index) {
				current.postBlob = index[2];
				continue;
			}
		}
		const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
		if (hunk) {
			current.postLine = Number(hunk[1]);
			inHunk = true;
			current.hunk = { added: [], removed: [] };
			current.hunks.push(current.hunk);
			continue;
		}
		if (!inHunk && (line.startsWith("+++") || line.startsWith("---"))) continue;
		if (line.startsWith("+")) {
			const postLine = current.postLine;
			current.added.set(postLine, line.slice(1));
			hunkFor(current).added.push(postLine);
			current.postLine += 1;
		} else if (line.startsWith(" ")) current.postLine += 1;
		else if (inHunk && line.startsWith("-")) {
			// A deletion sits between post-image lines `postLine - 1` and `postLine`.
			const after = current.postLine - 1;
			const index = current.removed.length;
			current.deletedAfter.add(after);
			current.removed.push(line.slice(1));
			hunkFor(current).removed.push(index);
			const bucket = current.removedAfter.get(after) ?? [];
			bucket.push(index);
			current.removedAfter.set(after, bucket);
		}
	}
	return files;
}

// Records are harvested from the post-image the diff names, because under
// `--unified=0` a call's closing brace may be unchanged and the opener may be
// outside the hunk (#2915, #3906). Only a call whose span contains an added
// POST-image line counts, so an untouched record never passes as new. The
// seam-branch scan reads the added lines alone; the failure-path scan credits a
// hunk's removals of a token kind against that hunk's additions of the same
// kind, because a re-spelled line is not a new failure path (#5019). The credit
// is per hunk and per kind, never per file, so one hunk's removal cannot excuse
// another hunk's or another file's addition, and a removed line is lexed as the
// pre-image it came from so a token inside a comment or a string credits
// nothing. A file whose post-image is missing, unreadable, oversize, or does not
// match the diff's own added text is reported `indeterminate` (visibly
// inconclusive), never classified from the ambiguous hunk.
function runtimeObservabilityFromDiff(diff, seamMap, options = {}) {
	const files = parseRuntimeHunks(diff);
	const runtimeTouched = files.some(
		(file) =>
			isRuntimeObservabilityPath(file.post) ||
			isRuntimeObservabilityPath(file.pre),
	);
	const addedRuntime = files.filter(
		(file) =>
			file.added.size > 0 &&
			(isRuntimeObservabilityPath(file.post) ||
				isRuntimeObservabilityPath(file.pre)),
	);
	if (!addedRuntime.length)
		return {
			runtime: runtimeTouched,
			records: new Set(),
			failurePath: false,
			seamBranches: [],
			indeterminate: [],
		};
	const records = new Set();
	let failurePath = false;
	const branchesByFile = new Map();
	const indeterminate = [];
	for (const file of addedRuntime) {
		// The post-image is the blob the diff's `index <post>` names, never the
		// caller's citation `ref` (a base revision for `--ref` path checks) and
		// never a mutable working tree the diff does not mention. When the diff
		// names no blob (a hand-built hunk), `headFileSource` falls back to the
		// caller-supplied image, HEAD, or the working tree.
		const source = headFileSource(file.post, {
			headFiles: options.headFiles,
			workingTree: options.workingTree,
			cwd: options.cwd,
			git: options.git,
			postBlob: file.postBlob,
		});
		if (typeof source !== "string") {
			indeterminate.push({ file: file.post, line: null });
			continue;
		}
		const rows = sourceLines(source);
		let mismatch = false;
		for (const [postLine, text] of file.added) {
			if (rows[postLine - 1] !== text) {
				indeterminate.push({ file: file.post, line: postLine });
				mismatch = true;
				break;
			}
		}
		if (mismatch) continue;
		const blanked = blankCommentsAndStrings(source).text;
		const blankedRows = blanked.split("\n");
		for (const {
			value,
			startLine,
			endLine,
		} of recordLocationsFromRuntimeSource(source, blanked)) {
			for (let line = startLine; line <= endLine; line += 1) {
				if (file.added.has(line)) {
					records.add(value);
					break;
				}
			}
		}
		// The pre-image the diff removed these lines from: the post-image with its
		// added lines dropped and its removed lines restored in diff order. Lexing
		// it, not the removed text alone, keeps a removed JSDoc continuation or
		// string from crediting a token it never carried as code (#5019). A file
		// with no removed line builds none of it.
		const preRows = [];
		const preLineOfRemoved = [];
		if (file.removed.length) {
			for (let postLine = 1; postLine <= rows.length; postLine += 1) {
				for (const removed of file.removedAfter.get(postLine - 1) ?? []) {
					preLineOfRemoved[removed] = preRows.length;
					preRows.push(file.removed[removed]);
				}
				if (!file.added.has(postLine)) preRows.push(rows[postLine - 1]);
			}
			for (const removed of file.removedAfter.get(rows.length) ?? []) {
				preLineOfRemoved[removed] = preRows.length;
				preRows.push(file.removed[removed]);
			}
		}
		const preBlankedRows = file.removed.length
			? blankCommentsAndStrings(preRows.join("\n")).text.split("\n")
			: [];
		for (const hunk of file.hunks) {
			const credited = new Map();
			for (const removed of hunk.removed)
				countFailureTokens(
					preBlankedRows[preLineOfRemoved[removed]] ?? "",
					credited,
				);
			for (const postLine of hunk.added) {
				for (const [kind, count] of countFailureTokens(
					blankedRows[postLine - 1] ?? "",
				)) {
					const left = (credited.get(kind) ?? 0) - count;
					credited.set(kind, Math.max(0, left));
					if (left < 0) failurePath = true;
				}
			}
		}
		if (isSeamFile(file.post, seamMap)) {
			let count = 0;
			for (const postLine of file.added.keys())
				count +=
					(blankedRows[postLine - 1] ?? "").match(DECISION_BRANCH_G)?.length ??
					0;
			if (count)
				branchesByFile.set(
					file.post,
					(branchesByFile.get(file.post) ?? 0) + count,
				);
		}
	}
	return {
		runtime: true,
		records,
		failurePath,
		seamBranches: [...branchesByFile].map(([file, count]) => ({
			file,
			count,
		})),
		indeterminate,
	};
}

function observabilitySectionContent(lines, headings) {
	const heading = headings.find((candidate) =>
		hasSection(candidate, "observability"),
	);
	if (!heading) return "";
	const next = headings.find(
		(candidate) =>
			candidate.index > heading.index && candidate.level <= heading.level,
	);
	return lines
		.slice(heading.contentIndex, next?.index ?? lines.length)
		.join("\n");
}

function lineAt(source, index) {
	return source.slice(0, index).split("\n").length;
}

// Index of the `)` closing the `(` at `open`, over comment- and
// string-blanked text; -1 when the call runs past the end of the source.
function closeBracketIndex(blanked, open, opener = "(", closer = ")") {
	let depth = 0;
	for (let index = open; index < blanked.length; index++) {
		if (blanked[index] === opener) depth++;
		else if (blanked[index] === closer && --depth === 0) return index;
	}
	return -1;
}

function closeParenIndex(blanked, open) {
	return closeBracketIndex(blanked, open);
}

function recordLocationsFromRuntimeSource(source, blankedText) {
	const records = [];
	// `blankedText` is the caller's single whole-post-image lex; the fallback
	// keeps the exported-free helper usable on its own. Line numbers index the
	// source itself, so a record's span still maps back to the diff's added
	// POST-image lines.
	const blanked = blankedText ?? blankCommentsAndStrings(source).text;
	const push = (value, valueIndex, start, end, field) =>
		records.push({
			value,
			field,
			line: lineAt(source, valueIndex),
			startLine: lineAt(source, start),
			endLine: lineAt(source, end),
		});
	const calls = [
		["recordDegradationOnce", ["kind"]],
		["incrementDegradationCount", ["kind"]],
		// #2915: the ledger's single-record entry point takes the same
		// `{ kind }` object as its Once/Count siblings.
		["recordDegradation", ["kind"]],
		["logExtension", ["subsystem", "message"]],
		["logLatency", ["phase", "event", "eventName", "name"]],
		// The pi event bus NDJSON sink is the bounded record for bus
		// publications, including format lifecycle observations.
		["logBusEvent", ["event", "outcome"]],
		// #3168 F12: `logCascade` (clients/cascade-logger.ts) is a
		// `createNdjsonLogger` sink with the same `phase` discriminator as
		// `logLatency`, so a PR whose only new bounded record goes to
		// cascade.log could not state it in any of the three accepted forms —
		// the honest section was refused and the only passing wording was the
		// false "no record added." sentence.
		["logCascade", ["phase"]],
		["emitBounded", ["kind", "event", "eventName"]],
		// #3721: a read-time fold row (`getDegradationSummary()`'s
		// `summary.push({ kind: ... })`, the `log-sink-*` and
		// `process-singleton-reset` kinds) is a record by design, written nowhere
		// because it is pulled from in-memory state. Without this entry a PR that
		// adds one could name it in no accepted form and the only passing wording
		// was the false "no record added." sentence.
		["summary\\.push", ["kind"]],
	];
	for (const [name, fields] of calls) {
		const callPattern = new RegExp(
			`\\b${name}\\s*\\(\\s*\\{[\\s\\S]*?\\}`,
			"g",
		);
		for (const match of blanked.matchAll(callPattern)) {
			const original = source.slice(match.index, match.index + match[0].length);
			for (const field of fields) {
				const fieldMatch = new RegExp(`${field}\\s*:\\s*["']([^"']+)["']`).exec(
					original,
				);
				const value = fieldMatch?.[1];
				if (value)
					push(
						value,
						match.index + fieldMatch.index + fieldMatch[0].indexOf(value),
						match.index,
						match.index + match[0].length,
						field,
					);
			}
		}
	}
	// #2915: `emitBounded(phase, identity, payload, options)` is positional
	// (clients/bounded-telemetry.ts), so the object-literal form above never
	// sees a real call. Its record literals are the phase string and the
	// ledger kind in the options object.
	for (const match of blanked.matchAll(/\bemitBounded\s*\(/g)) {
		const open = match.index + match[0].length - 1;
		const close = closeParenIndex(blanked, open);
		const end = close === -1 ? source.length : close + 1;
		const call = source.slice(open + 1, end);
		const phase = /^\s*(["'`])([^"'`$]+)\1/.exec(call);
		if (phase)
			push(
				phase[2],
				open + 1 + phase.index + phase[0].indexOf(phase[2]),
				match.index,
				end,
				"phase",
			);
		const ledgerKind = /\bledgerKind\s*:\s*["']([^"']+)["']/.exec(call);
		if (ledgerKind)
			push(
				ledgerKind[1],
				open + 1 + ledgerKind.index + ledgerKind[0].indexOf(ledgerKind[1]),
				match.index,
				end,
				"kind",
			);
	}
	return records;
}

const CODE_CITATION = /`([^`\s:]+):((?:~?\d+)(?:-\d+)?)`/g;
const MASTER_CLAIM =
	/pre-existing|red on master|also fails on origin\/master|environment-specific/i;

// One post-image read per changed runtime file, bounded by the same byte
// ceiling on every branch: `git cat-file -p` for the diff's own blob,
// `git show` for a ref or HEAD, and a stat-gated working-tree read. A
// file-count bound alone is not a byte bound.
//
// The `index <post>` blob is the identity carried from the diff producer to
// the reader. Reading exactly that object means an unchanged line the diff
// never mentions (a block-comment opener) cannot flip the lexical state even
// when the working tree has drifted from the diff's post-image (#3906 r4
// R3-A). A named-but-unreadable blob declines (null → `indeterminate`); it
// never falls through to a mutable source that would look authoritative.
function headFileSource(file, options = {}) {
	if (options.headFiles?.has?.(file)) return options.headFiles.get(file);
	if (/(?:^|\/)\.\.(?:\/|$)/.test(file) || isAbsolute(file)) return null;
	if (options.postBlob && !/^0+$/.test(options.postBlob)) {
		try {
			return String(
				(options.git ?? gitExecFileSync)(["cat-file", "-p", options.postBlob], {
					cwd: options.cwd ?? process.cwd(),
					encoding: "utf8",
					maxBuffer: MAX_SOURCE_BYTES,
				}),
			);
		} catch {
			return null;
		}
	}
	if (options.ref) {
		try {
			return String(
				(options.git ?? gitExecFileSync)(["show", `${options.ref}:${file}`], {
					cwd: options.cwd ?? process.cwd(),
					encoding: "utf8",
					maxBuffer: MAX_SOURCE_BYTES,
				}),
			);
		} catch {
			return null;
		}
	}
	if (options.workingTree) {
		try {
			const path = resolve(options.cwd ?? process.cwd(), file);
			if (statSync(path).size > MAX_SOURCE_BYTES) return null;
			return readFileSync(path, "utf8");
		} catch {
			return null;
		}
	}
	try {
		return String(
			(options.git ?? gitExecFileSync)(["show", `HEAD:${file}`], {
				cwd: options.cwd ?? process.cwd(),
				encoding: "utf8",
				maxBuffer: MAX_SOURCE_BYTES,
			}),
		);
	} catch {
		return null;
	}
}

function citedRefFailure(file, options = {}) {
	if (!options.ref) return `does not exist in the HEAD tree`;
	const git = options.git ?? gitExecFileSync;
	try {
		git(["rev-parse", "--verify", `${options.ref}^{commit}`], {
			cwd: options.cwd ?? process.cwd(),
			encoding: "utf8",
		});
	} catch {
		return `revision ${options.ref} does not exist or is not a commit`;
	}
	try {
		git(["cat-file", "-e", `${options.ref}:${file}`], {
			cwd: options.cwd ?? process.cwd(),
			encoding: "utf8",
		});
	} catch {
		return `file ${file} does not exist in revision ${options.ref}`;
	}
	return `file ${file} could not be read from revision ${options.ref}`;
}

// Local preflight reads the working tree, which also holds files git will
// never commit (#2904 item 4). CI resolves the same citation with
// `git show HEAD:<file>`, so an ignored path passes locally and can never
// pass there. `git check-ignore` exits 0 for an ignored path and 1 for a
// path git would track; anything else (no repository) leaves the answer to
// the working-tree read, as before.
function isGitIgnoredPath(file, options = {}) {
	try {
		(options.git ?? gitExecFileSync)(["check-ignore", "-q", "--", file], {
			cwd: options.cwd ?? process.cwd(),
			stdio: "ignore",
		});
		return true;
	} catch {
		return false;
	}
}

function sourceLines(source) {
	return String(source ?? "").split(/\r?\n/);
}

const HEAD_TEST_CORPUS_CACHE_LIMIT = 8;
const headTestCorpusCache = new Map();

export function testCorpus(options = {}) {
	const cwd = options.cwd ?? process.cwd();
	let cacheKey;
	if (!options.workingTree) {
		try {
			const revision = String(
				(options.git ?? gitExecFileSync)(["rev-parse", "HEAD"], {
					cwd,
					encoding: "utf8",
				}),
			).trim();
			if (revision) cacheKey = `${cwd}:${revision}`;
		} catch {
			// A failed revision lookup must not turn a mutable tree into a cache hit.
		}
	}
	if (cacheKey) {
		const cached = headTestCorpusCache.get(cacheKey);
		if (cached) return cached;
	}
	let files = [];
	try {
		const tracked = String(
			(options.git ?? gitExecFileSync)(["ls-files", "--", "tests"], {
				cwd,
				encoding: "utf8",
			}),
		);
		files = tracked.split(/\r?\n/).filter(Boolean);
		if (options.workingTree) {
			const untracked = String(
				(options.git ?? gitExecFileSync)(
					["ls-files", "--others", "--exclude-standard", "--", "tests"],
					{ cwd, encoding: "utf8" },
				),
			)
				.split(/\r?\n/)
				.filter(Boolean);
			files = [...new Set([...files, ...untracked])];
		}
	} catch {
		const visit = (directory) => {
			for (const entry of readdirSync(directory, { withFileTypes: true })) {
				const path = resolve(directory, entry.name);
				if (entry.isDirectory()) visit(path);
				else if (path.endsWith(".ts") || path.endsWith(".tsx"))
					files.push(path.slice(cwd.length + 1).replaceAll("\\", "/"));
			}
		};
		try {
			visit(resolve(cwd, "tests"));
		} catch {
			files = [];
		}
	}
	const paths = new Set(
		// #3013 (defect shape 47): PR-body fixtures live under the scanned
		// tests/ root, so without this filter the corpus would resolve a
		// fixture's own fabricated ids and accept the body under test.
		files.filter((file) => !file.startsWith("tests/fixtures/ci-pr-bodies/")),
	);
	const titles = new Set();
	for (const file of files) {
		if (
			file.startsWith("tests/fixtures/ci-pr-bodies/") ||
			!/\.(?:[cm]?[jt]sx?)$/.test(file)
		)
			continue;
		// The checker test contributes only its declaration titles. Its fixture
		// strings and arbitrary prose never enter this corpus.
		let source;
		try {
			source = readFileSync(resolve(cwd, file), "utf8");
		} catch {
			continue;
		}
		const lexed = blankCommentsAndStrings(source);
		for (const string of lexed.strings) {
			const prefix = string.prefix;
			const opening = prefix.lastIndexOf("(");
			if (opening < 0) continue;
			const beforeOpening = prefix.slice(0, opening).trimEnd();
			const direct = /\b(?:it|test|describe)\s*$/.test(beforeOpening);
			let depth = 0;
			let matchingOpening = -1;
			for (let index = beforeOpening.length - 1; index >= 0; index -= 1) {
				if (beforeOpening[index] === ")") depth += 1;
				else if (beforeOpening[index] === "(" && --depth === 0) {
					matchingOpening = index;
					break;
				}
			}
			const each =
				(matchingOpening >= 0 &&
					/\b(?:it|test|describe)\s*\.each\s*$/.test(
						beforeOpening.slice(0, matchingOpening).trimEnd(),
					)) ||
				/\b(?:it|test|describe)\s*\.each\s*(?:[\s\S]*\)|`[\s\S]*`)$/.test(
					beforeOpening,
				);
			if (!direct && !each) continue;
			const title = string.text;
			if (title.trim()) titles.add(title.trim());
		}
	}
	const corpus = { paths, titles };
	if (cacheKey) {
		if (headTestCorpusCache.size >= HEAD_TEST_CORPUS_CACHE_LIMIT)
			headTestCorpusCache.delete(headTestCorpusCache.keys().next().value);
		headTestCorpusCache.set(cacheKey, corpus);
	}
	return corpus;
}

// `tilde` reads CommonMark's `~~~` fences too. The citation and test-reference
// lints keep the backtick-only view on purpose (master's behavior, pinned by
// the "nested bullets and tilde fences" case), while the diff-keyed compliance
// rows read every fence a reader sees (#4605 F5).
function markdownBlocks(body, { tilde = false } = {}) {
	const lines = String(body ?? "").split(/\r?\n/);
	const blocks = [];
	let current = null;
	let fence = null;
	const fenceMarker = tilde ? /^\s*(`{3,}|~{3,})/ : /^\s*(`{3,})/;
	const flush = () => {
		if (current?.lines.length) blocks.push(current);
		current = null;
	};
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		const marker = fenceMarker.exec(line)?.[1];
		if (marker || fence) {
			if (marker && !fence && current && current.lines.length) flush();
			if (!current) current = { lines: [], start: index, fence: true };
			current.lines.push(line);
			if (marker && !fence) fence = marker;
			else if (
				fence &&
				marker &&
				marker[0] === fence[0] &&
				marker.length >= fence.length
			) {
				fence = null;
				flush();
			}
			continue;
		}
		if (!line.trim()) {
			flush();
			continue;
		}
		if (/^\s*\|/.test(line) && current && !/^\s*\|/.test(current.lines[0]))
			flush();
		if (!current) current = { lines: [], start: index, fence: false };
		current.lines.push(line);
	}
	flush();
	return blocks.map((block) => ({
		...block,
		text: block.lines.join("\n"),
		table: !block.fence && block.lines.every((line) => /^\s*\|/.test(line)),
	}));
}

function endsSentence(text, index, original = text) {
	const char = text[index];
	if (!".!?".includes(char)) return false;
	if (char === "." && (text[index - 1] === "." || text[index + 1] === "."))
		return false;
	const next = text[index + 1] ?? "";
	if (next && !/\s/.test(next)) return false;
	const remainder = original.slice(index + 1);
	const following = remainder.match(/\S/)?.[0];
	if (following === undefined || /[A-Z]/.test(following)) return true;
	const afterWhitespace = remainder.replace(/^\s+/, "");
	if (afterWhitespace.startsWith("`")) return true;
	return /^\d/.test(afterWhitespace);
}

function splitMarkdownSentences(text) {
	const sentences = [];
	let start = 0;
	const masked = codeSpanMasked(text);
	for (let index = 0; index < text.length; index += 1) {
		if (endsSentence(masked, index, text)) {
			sentences.push({ text: text.slice(start, index + 1), start });
			start = index + 1;
		}
	}
	if (text.slice(start).trim())
		sentences.push({ text: text.slice(start), start });
	return sentences;
}

function countSentenceTerminators(lines) {
	let count = 0;
	const masked = codeSpanMasked(lines.join("\n").trim());
	for (let index = 0; index < masked.length; index += 1) {
		if (endsSentence(masked, index, lines.join("\n").trim())) count += 1;
	}
	return count;
}

export function splitMarkdownUnits(body = "") {
	const units = [];
	for (const block of markdownBlocks(body)) {
		if (block.fence) {
			units.push({ kind: "fence", text: block.text });
			continue;
		}
		if (/^\s*#{1,6}\s/.test(block.lines[0])) {
			units.push({ kind: "heading", text: block.text });
			continue;
		}
		if (/^\s*[-*+]\s+/.test(block.lines[0])) {
			units.push({ kind: "list", text: block.text });
			continue;
		}
		if (block.table) {
			for (const line of block.lines) units.push({ kind: "table", text: line });
			continue;
		}
		for (const sentence of splitMarkdownSentences(block.text))
			units.push({ kind: "sentence", text: sentence.text.trim() });
	}
	return units;
}

// `commonMark` also treats `~~~` fences and 4-space or tab indented lines as
// code; only the garble lint asks for it. The citation and test-reference
// lints keep the backtick-only view, so a citation in a nested bullet is still
// checked (#3795 verify r3).
function bodyLinesOutsideFences(body, { commonMark = false } = {}) {
	let fence;
	const fenceMarker = commonMark ? /^\s*(`{3,}|~{3,})/ : /^\s*(```+)/;
	return String(body ?? "")
		.split(/\r?\n/)
		.map((line) => {
			if (commonMark && !fence && /^(?: {4}|\t)/.test(line)) return "";
			const marker = line.match(fenceMarker)?.[1];
			if (marker) {
				if (!fence) fence = marker;
				else if (marker[0] === fence[0] && marker.length >= fence.length)
					fence = undefined;
				return "";
			}
			return fence ? "" : line;
		});
}

// #3795: `gh pr edit --body "... `name` ..."` runs the backtick as a command
// substitution, so the name disappears and the raw `npm run lint` output
// (the `> pkg@version script` banner and the oxlint command line) lands in the
// body outside any fence. Two worker bodies shipped this way and the
// structural lint accepted both.
function lintShellExpansionGarble(body) {
	const errors = [];
	for (const line of bodyLinesOutsideFences(body, { commonMark: true })) {
		const text = line.trim();
		if (!text) continue;
		const emptySpan = /(`+)([\s\S]*?)\1/g;
		for (const match of text.matchAll(emptySpan)) {
			if (match[2].trim() === "") {
				errors.push(
					`PR body has an empty inline code span outside a fenced block ("${text}"); a shell-expanded name left nothing between the backticks -- restore the name or drop the backticks.`,
				);
				break;
			}
		}
		const masked = codeSpanMasked(text).trim();
		if (!masked) continue;
		if (/^>\s*[^\s@]+@\d+\.\d+\.\d+\s+\S/.test(masked))
			errors.push(
				`PR body pastes an npm-script banner outside a fenced block ("${masked}"); wrap tool output in a \`\`\`text fence.`,
			);
		else if (/\boxlint\b/.test(masked) && /--deny-warnings/.test(masked))
			errors.push(
				`PR body pastes an oxlint command line outside a fenced block ("${masked}"); wrap tool output in a \`\`\`text fence.`,
			);
	}
	return errors;
}

function pathLineReferences(text) {
	return [...String(text ?? "").matchAll(CODE_CITATION)].map((match) => ({
		file: match[1],
		lineText: match[2],
		line: Number(match[2].replace(/^~/, "").split("-", 1)[0]),
		end: match[2].includes("-")
			? Number(match[2].replace(/^~/, "").split("-", 2)[1])
			: undefined,
		index: match.index,
	}));
}

function sourceQuoteAfter(lines, bodyLine) {
	let index = bodyLine + 1;
	while (index < lines.length && !lines[index].trim()) index += 1;
	const opener = lines[index]?.match(/^\s*(```+)(.*)$/);
	if (!opener) return null;
	const fence = opener[1];
	const end = lines.findIndex(
		(row, rowIndex) =>
			rowIndex > index && new RegExp(`^\\s*${fence}\\s*$`).test(row),
	);
	if (end === -1) return null;
	const text = lines.slice(index + 1, end).filter((row) => row.trim());
	return { end, info: opener[2].trim(), text };
}

// A transcript fence is tagged with one of the output info strings or left
// bare: an author who pastes a red into an untagged fence has still quoted it,
// and requiring a tag is an enumerated detector that misses the next spelling.
// A named language (`typescript`, `json`) marks an example, not a run.
const TRANSCRIPT_INFO = /^(?:(?:text|console|shell|sh|bash|output))?$/i;
// #4585 row 1: what makes a fence a red. A Vitest failure list (`× title`, with
// or without a run prefix) and a count (`2 failed`) are as much a quoted red as
// `FAIL` or an assertion dump.
const FAILURE_MARKER =
	/\b(?:[1-9]\d* failed|AssertionError|failed test titles|error TS\d+)\b|^\s*FAIL\b|[×✗✕]\s+\S/m;
// A red a body quotes inline, in a backticked span (a mutation table's cell).
const BACKTICKED_RED =
	/`[^`]*(?:[×✗✕]\s+\S|[1-9]\d* failed|AssertionError|failed test titles|error TS\d+)[^`]*`/;

/** One visible fence that quotes a failing run of its own. */
function isFailureQuote(quote) {
	const text = quote.text.join("\n");
	if (!TRANSCRIPT_INFO.test(quote.info)) return false;
	// A declared exit code decides the verdict: a green mutation run quotes no
	// red, whatever its titles still print.
	const exit = /exit code: (\d+)/.exec(text);
	if (exit?.[1] === "0") return false;
	return FAILURE_MARKER.test(text);
}

function isTranscriptQuote(quote) {
	const lines = quote.text.join("\n");
	return (
		/^(?:text|console|shell|sh|bash|output)$/i.test(quote.info) &&
		/^(?:\s*(?:\$|>)\s+(?:git|npm|npx|vitest|tsc)\b|\s*Test Files?\b.*\b(?:failed|passed)\b|\s*Tests?\s+\d+\s+(?:failed|passed)\b|\s*(?:PASS|FAIL)\s+(?:\||$)|\s*npm ERR!|\s*error TS\d+)/im.test(
			lines,
		)
	);
}

function lintCodeCitations(body, options = {}) {
	const errors = [];
	const rawLines = String(body ?? "").split(/\r?\n/);
	const visibleBody = bodyLinesOutsideFences(body).join("\n");
	for (const {
		file,
		lineText,
		line: lineNumber,
		end,
		index,
	} of pathLineReferences(visibleBody)) {
		const bodyLine = visibleBody.slice(0, index).split(/\r?\n/).length - 1;
		const key = `${file}:${lineText}`;
		if (end !== undefined && end < lineNumber) {
			errors.push(`PR body citation ${key} has a malformed backwards range.`);
			continue;
		}
		const source = headFileSource(file, options);
		if (source === null) {
			errors.push(`PR body citation ${key} ${citedRefFailure(file, options)}.`);
			continue;
		}
		if (options.workingTree && isGitIgnoredPath(file, options)) {
			errors.push(
				`PR body citation ${key} names a git-ignored path; CI resolves citations with \`git show HEAD:<file>\`, so it can never pass there.`,
			);
			continue;
		}
		const sourceRows = sourceLines(source);
		if (lineNumber < 1 || lineNumber > sourceRows.length) {
			errors.push(
				`PR body citation ${key} is outside the ${options.ref ?? "HEAD"} tree.`,
			);
			continue;
		}
		const quote = sourceQuoteAfter(rawLines, bodyLine);
		if (!quote) continue;
		if (isTranscriptQuote(quote)) continue;
		const start = Math.max(0, lineNumber - 1 - 20);
		const finish = Math.min(sourceRows.length, lineNumber + 20);
		const window = sourceRows.slice(start, finish).join("\n");
		if (!quote.text.length || !window.includes(quote.text.join("\n")))
			errors.push(
				`PR body quote after citation ${key} does not match HEAD source within ±20 lines.`,
			);
	}
	return errors;
}

// Positive test-reference recognition (#3013): prose outside a test column
// only names a test through a recognisable form — an it("…") call, a
// concrete tests/ path, or a short id. A backticked shell invocation is
// never a test title. The discriminator is semantic (catalog shape 34): a
// leading argv-like word plus invocation evidence (a flag, a quoted word,
// an assignment, or a shell metacharacter) reads as a command, not a title.
// This replaces the four-prefix command allowlist, which missed the next
// spelling every time. A bare `argv path…` span stays a citation, so a
// missing tests/ path there still reds.
function isArgvLike(word) {
	return (
		/^(?:\.{1,2}\/)?[A-Za-z0-9_.$~][A-Za-z0-9_.+:@$-]*$/.test(word) ||
		/^[A-Za-z_][A-Za-z0-9_]*=[^\s]*$/.test(word)
	);
}

function isInvocationEvidence(word) {
	return (
		word.startsWith("-") ||
		/^\/[A-Za-z]/.test(word) ||
		/^(['"]).*\1$/.test(word) ||
		/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) ||
		/[=|$><;&*?`]/.test(word)
	);
}

function isCommandLikeSpan(value) {
	const words = String(value ?? "")
		.split(/\s+/)
		.filter(Boolean);
	return (
		words.length >= 2 &&
		isArgvLike(words[0]) &&
		words.slice(1).some(isInvocationEvidence)
	);
}

// A tests/ token that cannot name a file (a glob, a brace expansion, or a
// quoted/bracketed paste) is never a file reference (#3013).
function isConcreteTestPathToken(token) {
	return !/[{}[\]*?"'()<>|&;`]/.test(token);
}

function extractTestPathTokens(value) {
	const tokens = [];
	for (const raw of String(value ?? "").split(/\s+/)) {
		const token = raw
			.replace(/^(['"([{<]+)/, "")
			.replace(/([.,;:!?)\]}'"]+)$/, "");
		if (token.startsWith("tests/")) tokens.push(token);
	}
	return tokens;
}

function lintTestReferences(body, options = {}) {
	const references = [];
	const visibleBody = bodyLinesOutsideFences(body).join("\n");
	// The corpus is a full `git ls-files` plus a read-and-lex of every test
	// file. A body with no test reference never needs it, so compute it on
	// first use: a plain prose body no longer pays for the scan (#3902).
	let corpus;
	const getCorpus = () =>
		(corpus ??= options.testCorpus ?? testCorpus(options));
	const isExistingDirectory = (pathToken) => {
		try {
			return statSync(
				resolve(options.cwd ?? process.cwd(), pathToken),
			).isDirectory();
		} catch {
			return false;
		}
	};
	const pushMissingPathTokens = (value) => {
		for (const pathToken of extractTestPathTokens(value)) {
			// A trailing slash names a suite directory, never a file.
			if (pathToken.endsWith("/")) continue;
			if (!isConcreteTestPathToken(pathToken)) continue;
			const { paths, titles } = getCorpus();
			if (
				paths.has(pathToken) ||
				titles.has(pathToken) ||
				paths.has(pathToken.match(/^(tests\/[^:]+):\d+$/)?.[1] ?? "")
			)
				continue;
			// A slash-less directory (tests/config) names a suite too.
			if (isExistingDirectory(pathToken)) continue;
			references.push(pathToken);
		}
	};
	const addToken = (raw, strict = false, testColumn = false) => {
		const token = raw.trim();
		const wrapped = /^it\(\s*(["'])(.*?)\1\s*\)(?:\s*\([^)]*\))?$/.exec(token);
		const value = wrapped
			? wrapped[2].replace(/\s*\([^)]*\)\s*$/, "").trim()
			: token;
		// Short IDs are references only in an explicitly named test column.
		// A bare ID in prose is not evidence of a test and must remain inert.
		if ((/^[A-Z]\d+$/.test(value) && testColumn) || wrapped) {
			references.push(value);
			return;
		}
		if (strict) {
			// Test-column placement recognises the reference, so even a
			// command-shaped span is checked, exactly as before. Pipe lines
			// outside a valid table share this strictness: without the
			// separator that makes columns meaningful, a broken separator
			// must not hide a fabricated reference.
			if (/\s/.test(value) || value.startsWith("tests/"))
				references.push(value);
			return;
		}
		if (isCommandLikeSpan(value)) return;
		// Prose, bullets, and non-test cells: positive recognition only —
		// anything without a concrete tests/ path is not a test reference
		// and is never asserted to exist.
		pushMissingPathTokens(value);
	};
	const lines = visibleBody.split(/\r?\n/);
	let tableHeaders = null;
	const isValidSeparator = (line, headers) => {
		if (!headers) return false;
		if (!/^\s*\|.*\|\s*$/.test(line)) return false;
		const cells = splitMarkdownRow(line);
		return (
			cells.length === headers.length &&
			cells.every((cell) => /^:?-{3,}:?$/.test(cell))
		);
	};
	for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
		const line = lines[lineIndex];
		const isBullet = /^\s*[-*+]\s+/.test(line);
		const table = /^\s*\|.*\|\s*$/.test(line);
		if (!table) tableHeaders = null;
		if (
			table &&
			lineIndex + 1 < lines.length &&
			isValidSeparator(lines[lineIndex + 1], splitMarkdownRow(line))
		) {
			tableHeaders = splitMarkdownRow(line);
			continue;
		}
		const inTable = table && tableHeaders !== null;
		if (inTable && isValidSeparator(line, tableHeaders)) continue;
		// A table row is read cell by cell, the way GitHub splits it: a code
		// span cannot hold an unescaped pipe, so it never spans two cells.
		const segments = inTable
			? splitMarkdownRow(line).map((cell, index) => [cell, index])
			: [[line, -1]];
		for (const [segment, cellIndex] of segments)
			for (const match of segment.matchAll(/`([^`]+)`/g)) {
				const inTestColumn = Boolean(
					// Word-boundary match (#3013): a bare "id" substring qualified
					// every "Evidence" column as a test column, so claim-matrix
					// evidence cells holding commands and code read as missing test
					// references. A column names tests only when it says so as a
					// word ("Test", "Test id", "Case").
					inTable &&
					/\b(?:test|probe|case|witness|id)\b/i.test(
						tableHeaders[cellIndex] ?? "",
					),
				);
				addToken(match[1], inTestColumn || (table && !inTable), inTestColumn);
			}
		for (const match of line.matchAll(/\bit\(\s*(["'])(.*?)\1\s*\)/g))
			if (isBullet || !inTable) addToken(match[0]);
	}
	const exists = (reference) => {
		const path = reference.match(/^(tests\/[^:]+):\d+$/)?.[1];
		const { paths, titles } = getCorpus();
		return (
			paths.has(reference) ||
			paths.has(path ?? reference) ||
			titles.has(reference)
		);
	};
	return [...new Set(references)]
		.filter((reference) => !exists(reference))
		.map(
			(reference) =>
				`PR body test reference is missing under tests/: ${reference}`,
		);
}

function lintMasterClaims(body) {
	const errors = [];
	const units = splitMarkdownUnits(body);
	for (let index = 0; index < units.length; index += 1) {
		const unit = units[index];
		if (
			unit.kind === "fence" ||
			unit.kind === "table" ||
			!MASTER_CLAIM.test(unit.text) ||
			/reviewer\s+(?:wrote|said)/i.test(unit.text)
		)
			continue;
		const next = units[index + 1];
		if (next?.kind === "fence" && /origin\/master/i.test(next.text)) continue;
		errors.push(
			`PR body master/environment claim lacks an origin/master transcript: ${unit.text.trim()}`,
		);
	}
	return errors;
}

function lintRuntimeObservability(lines, headings, diff, options = {}) {
	const observation = runtimeObservabilityFromDiff(
		diff,
		loadSeamMap(),
		options,
	);
	if (!observation.runtime) return [];
	// A post-image the reader could not obtain or match leaves the added lines
	// unclassifiable. Refuse visibly: never a false clean, never a wrong
	// "no record added". The author can re-run with the changed files present.
	if (observation.indeterminate.length) {
		const shown = observation.indeterminate
			.slice(0, 5)
			.map(({ file, line }) => (line ? `${file}:${line}` : file));
		const extra =
			observation.indeterminate.length > shown.length
				? ` (+${observation.indeterminate.length - shown.length} more)`
				: "";
		return [
			`PR body Observability could not classify the added lines of ${shown.join(", ")}${extra}: the post-image is missing, could not be read, or does not match the diff, so a record or a decision branch cannot be confirmed. Re-run with the changed files present, or name the record on a line the diff adds.`,
		];
	}
	const content = observabilitySectionContent(lines, headings);
	if ([...observation.records].some((record) => content.includes(record)))
		return [];
	const existingRecordCitation = pathLineReferences(content).find(
		(reference) => {
			const prefix = content.slice(0, reference.index);
			return /covered by existing record `[^`]+` at\s*$/.test(prefix);
		},
	);
	const existingRecordPrefix = existingRecordCitation
		? content
				.slice(0, existingRecordCitation.index)
				.match(/covered by existing record `([^`]+)` at\s*$/)
		: null;
	if (
		existingRecordCitation &&
		existingRecordPrefix &&
		!/(?:^|\/)\.\.(?:\/|$)/.test(existingRecordCitation.file) &&
		isRuntimeObservabilityPath(existingRecordCitation.file)
	) {
		const [, kind] = existingRecordPrefix;
		const { file, line: lineNumber } = existingRecordCitation;
		try {
			const source = readFileSync(
				isAbsolute(file) ? file : resolve(options.cwd ?? process.cwd(), file),
				"utf8",
			);
			if (
				recordLocationsFromRuntimeSource(source).some(
					({ value, line }) =>
						value === kind && Math.abs(line - lineNumber) <= 20,
				)
			)
				return [];
		} catch {
			// Fall through to the existing strict error.
		}
	}
	if (observation.failurePath)
		return [
			`PR body Observability must name a record literal from the runtime diff${observation.records.size ? ` (${[...observation.records].join(", ")})` : ""}; "No new failure path; no record added." is not valid when the added lines contain a failure path.`,
		];
	// #3875: `none: <reason>` is valid for any diff without a failure path; the
	// exact no-record sentence is valid only while the diff adds no decision
	// branch on a seam either.
	if (
		hasNoRecordReason(
			content,
			observation.seamBranches.map(({ file }) => file),
		)
	)
		return [];
	if (observation.seamBranches.length)
		return [
			`PR body Observability must name the record of each new decision branch (${observation.seamBranches.map(({ file, count }) => `${file}: ${count}`).join(", ")}) as a record literal from the diff or \`covered by existing record <kind> at <file>:<line>\`, or write \`none: <reason>\` naming each file above by basename; "No new failure path; no record added." is not valid when the added lines contain a decision branch on a session, lifecycle or delivery seam.`,
		];
	if (content.includes("No new failure path; no record added.")) return [];
	return [
		'PR body Observability must name a record literal present in the runtime diff, or state exactly "No new failure path; no record added.".',
	];
}

// A reason made only of these words says nothing (`none: not applicable
// here`). Anchored at both ends: an honest reason that merely starts or ends
// with one (`none of ...`, `... is not applicable here`) stays valid.
const PLACEHOLDER_REASON =
	/^(?:(?:n\/?a|none|not|applicable|tbd|todo|here|later|ok)\b[\s.,;:!-]*)+$/i;

// `none: <reason>` lines: each reason is at least three words, not the
// template's `<reason>`, not placeholder words only. Together they must name
// every flagged file by basename, so the line answers each file, not the PR
// once (#3905 r1 F2). Records are deliberately not bound to files.
function hasNoRecordReason(content, files) {
	const reasons = [];
	for (const line of content.split("\n")) {
		const reason = /^\s*(?:[-*+]\s+)?\**none:\**\s*(\S.*)$/i
			.exec(line)?.[1]
			?.trim();
		if (
			reason &&
			reason.split(/\s+/).length >= 3 &&
			!reason.includes("<reason>") &&
			!PLACEHOLDER_REASON.test(reason)
		)
			reasons.push(reason);
	}
	// R-a (#3905 r2): a plain substring let `lsp-server.ts` satisfy a flagged
	// `clients/lsp/server.ts`. Match the basename as its own path component:
	// the character before it must not continue it (`[\w.-]`) and the one
	// after it must not extend it (`\w`), so `lsp-server.ts`,
	// `tree-sitter-client.ts` and `rootindex.ts` do not satisfy `server.ts`,
	// `client.ts` and `index.ts`.
	const text = reasons.join("\n");
	return (
		reasons.length > 0 &&
		files.every((file) => {
			const base = basename(file).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			return new RegExp(`(?<![\\w.-])${base}(?!\\w)`).test(text);
		})
	);
}

// --- #4597: a named record must be read back by a test ---------------------
//
// `docs/pi-lens-fixer.md:117` requires every record the `## Observability`
// section names to be asserted by a test, and nothing checked it: the audit of
// the 53 `fix` PRs merged 2026-10-11..2026-10-18 found 3 of 29 record-naming
// bodies whose record no test reads (`cascade_pending_rendered`,
// `blocker-position-unaligned`, and #4527's `savedServerIds` claim). The rule
// is its own function with one call site, beside `lintRuntimeObservability`
// (which asks whether a record was named at all), so the diff-keyed rules of
// #4585 land next to it without either change touching the other.
//
// What counts as naming a record: a token of the section with a record's shape
// that the runtime actually emits as a record value, whatever its font — a
// backticked span, a bare word, or the text of a link (F-4597-R2-2). A
// camelCase symbol, a path, a command and a one-word value fail the shape. The
// registry, not the body's formatting, decides: the harvest reads the call
// sites `recordLocationsFromRuntimeSource` names (the
// `logLatency`/`logCascade`/`logBusEvent`/`emitBounded` object forms, the
// ledger's Once/Count/`recordDegradation` kinds, and `summary.push`), so a
// record written through another wrapper — `logReviewGraph`, `logTreeSitter`,
// the `logActionableWarningsEvent` NDJSON row — is outside this rule until that
// wrapper joins the harvest (#3168's `logCascade` precedent). A one-word record
// value (a bare `autofix`) fails the two-segment shape on purpose, so it stays
// outside the rule even where a sink emits it.
const RECORD_LITERAL_SPAN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/;
// A bare mention is read against the fields that identify a record, because a
// bare two-segment compound is also ordinary prose: `ast-grep`, `project-trust`
// and `file-mutation-queue` are `subsystem`/`message` values, not record
// identities. A backticked span is an explicit naming and is read against every
// harvested field, as it was in round 2.
const RECORD_IDENTITY_FIELDS = new Set([
	"phase",
	"kind",
	"event",
	"eventName",
	"outcome",
]);
// The bare spelling's token: the same shape, as its own word of the section.
const RECORD_TOKEN = /(?<![\w$])[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+(?![\w$])/g;
// One lint sends at most this many needles to `git grep`. A section that
// exceeds it is disclosed (`::warning::`) rather than silently half-checked.
const MAX_RECORD_MENTIONS = 400;
// Where a read-back may live (#4597 review round 1: F1, F2, F3; round 2:
// F-4597-R2-1). The rule names the ONE form it admits and refuses everything
// else, so it never enumerates the bypasses it rejects (shape 69):
//
//   an exact occurrence of the literal — as a string inside an assertion
//   expression, an equality operand, a `case` label, a record-keyed object
//   literal, or a containment predicate's argument, or as the identifier the
//   test spells — in the body of a declaration vitest collects and runs.
//
// A test or suite title is not a body position, any other call argument is a
// mention, and a declaration whose modifier the rule cannot prove runs
// (`.skip`, `.todo`, `.skipIf`, a plugin's extension) contributes nothing. A
// position no declaration encloses is not a read position either: "this file
// holds a live test somewhere" was a guess that admitted a dead body.

const COMPARISON_BEFORE = /(?:===|!==|==|!=)\s*$/;
const COMPARISON_AFTER = /^\s*(?:===|!==|==|!=)/;
const CASE_LABEL_BEFORE = /\bcase\s+$/;
// The record key a caller writes: the discriminators the harvest reads at its
// call sites (`phase`, `event`, `eventName`, `kind`, `outcome`).
const RECORD_KEY_BEFORE = /\b(?:phase|event|eventName|kind|outcome)\s*:\s*$/;
const CONTAINMENT_CALL_BEFORE =
	/\.\s*(?:includes|contains|match|matchAll|startsWith|endsWith|indexOf|lastIndexOf|has|some|every|filter|find)\s*\(\s*$/;

// The trees `recordLocationsFromRuntimeSource` harvests from (AGENTS.md's
// runtime observability paths; `scripts/` records are CI annotations, not
// ledger or NDJSON rows, so they carry no harvestable literal).
const RUNTIME_OBSERVABILITY_ROOTS = ["clients", "tools", "mcp", "index.ts"];
// A test source. `tests/fixtures/ci-pr-bodies/*.md` are bodies under test, not
// evidence, and a non-source file cannot be lexed as one.
const TEST_SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/;

/**
 * The span of the call chain that starts at the identifier at `index`:
 * `expect(...)`, `expect.soft(...).toBe(...)`, `assert.equal(...)`,
 * `it.each([...])("title", fn)`, `it["only"]("title", fn)`. Blanked text has
 * no string or comment bracket, so every paren read here is code, and a `[...]`
 * link resolves through the lexer's own string spans. `null` when the chain
 * reaches no argument list (a bare identifier, `expect.only`, `it.todo`).
 * `unproven` reports a link this reader cannot resolve (`it[modifier]`): the
 * declaration rule refuses that form whole instead of guessing.
 */
function callChainAt(code, index, strings = []) {
	if (!/[A-Za-z_$]/.test(code[index] ?? "")) return null;
	let cursor = index;
	while (/[$\w]/.test(code[cursor] ?? "")) cursor += 1;
	const links = [];
	let calls = 0;
	let lastOpen = -1;
	let lastClose = -1;
	let unproven = false;
	for (;;) {
		const at = skipSpaces(code, cursor);
		if (code[at] === ".") {
			MEMBER_LINK.lastIndex = at;
			const link = MEMBER_LINK.exec(code);
			if (!link) break;
			links.push(link[1]);
			cursor = at + link[0].length;
			continue;
		}
		if (code[at] === "[") {
			const link = bracketLinkAt(code, at, strings);
			if (link) {
				links.push(link.name);
				cursor = link.end;
				continue;
			}
			// An index this reader cannot resolve (`it[modifier]`) is a declaration
			// it cannot follow only when the chain goes on to a call; `test[key] !==`
			// is a value, not a declaration form.
			const close = closeBracketIndex(code, at, "[", "]");
			if (
				close !== -1 &&
				/[.([<]/.test(code[skipSpaces(code, close + 1)] ?? "")
			)
				unproven = true;
			break;
		}
		if (code[at] === "<") {
			// A generic argument list (`it.each<NodeJS.Platform>([...])`) is part
			// of the chain; one this reader cannot close is an unmodelled form.
			const close = angleSpanEnd(code, at);
			if (close === -1) {
				unproven = true;
				break;
			}
			cursor = close + 1;
			continue;
		}
		if (code[at] !== "(") break;
		const close = closeParenIndex(code, at);
		// A call this reader cannot close (an unbalanced file) is not a
		// declaration form it misread: the chain simply ends here.
		if (close === -1) break;
		lastOpen = at;
		lastClose = close;
		calls += 1;
		cursor = close + 1;
	}
	if (!calls && !unproven) return null;
	return {
		start: index,
		end: lastClose + 1,
		links,
		lastOpen,
		lastClose,
		calls,
		unproven,
	};
}

/**
 * Whether the text after a declaration name begins a declaration this reader
 * cannot parse at all: an optional call (`it?.(…)`, `it!.(…)`). Every other
 * attempt (`it[...]`, `it <T>`, `it(…)`) is resolved by `callChainAt`, and a
 * value (`test:`, `test,`, `test?.name`, `describe.skip`) holds no body.
 */
function declarationAttemptAt(code, from) {
	const at = skipSpaces(code, from);
	const char = code[at] ?? "";
	if ((char === "?" || char === "!") && code[at + 1] === ".")
		return code[skipSpaces(code, at + 2)] === "(";
	return false;
}

/**
 * The member link a `[...]` holds: `it["skip"]`, `it['each']`, `` it[`for`] ``.
 * The blanker replaces every string with spaces, so the link's name comes from
 * the lexer's own span and an index that is anything else (a variable, an
 * expression, a template with a hole) resolves to nothing.
 */
function bracketLinkAt(code, open, strings) {
	const close = closeBracketIndex(code, open, "[", "]");
	if (close === -1) return null;
	if (code.slice(open + 1, close).trim() !== "") return null;
	const string = strings.find((one) => one.start > open && one.end <= close);
	const name = string?.text.trim() ?? "";
	if (!/^[A-Za-z_$][\w$]*$/.test(name)) return null;
	return { name, end: close + 1 };
}

const MEMBER_LINK = /\.[ \t\r\n]*([A-Za-z_$][\w$]*)/y;

/** The index of the `>` closing the `<` at `open`, or -1 when there is none. */
function angleSpanEnd(code, open) {
	let depth = 0;
	for (let index = open; index < code.length; index += 1) {
		const char = code[index];
		// A function type's arrow is not a closing angle (`<(a) => void>`).
		if (char === "=" && code[index + 1] === ">") {
			index += 1;
			continue;
		}
		if (char === "<") depth += 1;
		else if (char === ">") {
			if (--depth === 0) return index;
		} else if (char === ";" || char === "{" || char === "}") return -1;
	}
	return -1;
}

function skipSpaces(code, index) {
	let cursor = index;
	while (cursor < code.length && /\s/.test(code[cursor])) cursor += 1;
	return cursor;
}

/// The declarations whose body vitest runs, and the links that keep them live.
// `LIVE_TEST_LINKS` is an allowlist: a link it does not name (`.skip`,
// `.todo`, `.skipIf`, `.runIf`, a plugin extension) is a declaration the rule
// cannot prove runs, so its assertions are refused. A hook takes no link.
// A `[...]` link (`it["only"]`) is a member link like any other, and a name
// bound to a declaration (`const t = it`, `const d = it.skipIf(cond)`) is an
// alias that carries the links its chain already applied.
const TEST_HOOKS = new Set([
	"beforeEach",
	"beforeAll",
	"afterEach",
	"afterAll",
]);
const DECLARATION_NAMES = new Set([
	"describe",
	"suite",
	"it",
	"test",
	...TEST_HOOKS,
]);
const LIVE_TEST_LINKS = new Set([
	"only",
	"concurrent",
	"sequential",
	"each",
	"for",
	"fails",
	"live",
]);

// The two vocabulary patterns below escape their own names inline: a named or
// arrow-body helper here would be a second copy of `escapeRegExp`, which
// `tests/config/escape-regexp-fold-sweep.test.ts` forbids outside
// `clients/string-utils.ts` (and this script cannot import, because it runs
// with no build). The sweep's header allows the inline expression.

/**
 * The ranges of `import` statements. An import specifier names the declaration
 * without starting one (`import { it } from "vitest"`), so the declaration scan
 * skips it; a dynamic `import(...)` is an expression and is left alone.
 */
function importStatementRanges(code) {
	const ranges = [];
	for (const match of code.matchAll(/\bimport\b/g)) {
		const before = code[match.index - 1] ?? " ";
		if (before === "." || /[$\w]/.test(before)) continue;
		const at = skipSpaces(code, match.index + match[0].length);
		if (code[at] === "(" || code[at] === ".") continue;
		let depth = 0;
		for (let index = at; index < code.length; index += 1) {
			const char = code[index];
			if (char === "(" || char === "[" || char === "{") depth += 1;
			else if (char === ")" || char === "]" || char === "}") depth -= 1;
			else if ((char === ";" || char === "\n") && depth <= 0) {
				ranges.push([match.index, index]);
				break;
			}
		}
	}
	return ranges;
}

// A binding of a declaration name to another name, and the name it binds.
const BINDING_BEFORE = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*$/;
// The alias's own declaration site (`const t = it`): a name being bound, not a
// declaration used as a value.
const BINDING_TARGET_BEFORE = /\b(?:const|let|var)\s+$/;
// A declaration name destructured into other bindings (`const { skip } = it`)
// hides a declaration behind a binding this reader cannot follow.
const DESTRUCTURE_BEFORE = /\b(?:const|let|var)\s*\{[^{}]*\}\s*=\s*$/;

/**
 * The names that alias a test declaration, with the links the alias already
 * carries (`const d = it.skipIf(cond)` binds `.skipIf`). A bare alias
 * (`const t = it`) is resolved once its own target is known, so an alias of an
 * alias lands too. A binding this reader cannot follow is reported `unproven`.
 */
function declarationAliases(code, strings) {
	const aliases = new Map();
	let unproven = false;
	const bindings = [
		...code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*/g),
	].map((match) => ({
		name: match[1],
		at: match.index + match[0].length,
	}));
	for (let changed = true; changed;) {
		changed = false;
		for (const { name, at } of bindings) {
			if (DECLARATION_NAMES.has(name) || aliases.has(name)) continue;
			const target = /^([A-Za-z_$][\w$]*)/.exec(code.slice(at))?.[1];
			const carried = DECLARATION_NAMES.has(target ?? "")
				? []
				: aliases.get(target ?? "")?.links;
			if (carried === undefined) continue;
			const chain = callChainAt(code, at, strings);
			if (chain?.unproven) {
				unproven = true;
				continue;
			}
			aliases.set(name, {
				links: [...carried, ...(chain?.links ?? [])],
			});
			changed = true;
		}
	}
	return { aliases, unproven };
}

/**
 * Every test-family declaration in a lexed file, with the span its body lives
 * in. The title and the callee chain sit before `bodyStart`, so nothing there
 * can ever read as a read-back: `it("<record>", …)` is a name, not an
 * assertion. `unproven` says the file writes a declaration in a form this
 * reader cannot classify, which makes the whole file contribute nothing
 * (F-4597-R2-1): the rule never falls back to guessing.
 */
function declarationScopes(code, strings = []) {
	const { aliases, unproven: aliasUnproven } = declarationAliases(
		code,
		strings,
	);
	const alternatives = [];
	for (const name of [...DECLARATION_NAMES, ...aliases.keys()])
		alternatives.push(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
	const declarationName = new RegExp(
		`\\b(?:${alternatives.join("|")})\\b`,
		"g",
	);
	const imports = importStatementRanges(code);
	const scopes = [];
	let unproven = aliasUnproven;
	for (const match of code.matchAll(declarationName)) {
		const before = code[match.index - 1] ?? " ";
		if (before === "." || /[$\w]/.test(before)) continue;
		if (
			imports.some(([start, end]) => match.index > start && match.index < end)
		)
			continue;
		const name = match[0];
		const chain = callChainAt(code, match.index, strings);
		if (!chain) {
			// A declaration name bound to another name is the alias pass's business
			// and a bare value (`test:`, `test,`, `describe.skip` as a value) holds
			// no declaration body, so neither can hide one. A name followed by a
			// declaration bracket, a generic list or an optional call IS an attempt
			// this reader cannot resolve: the file is unprovable (F-4597-R2-1).
			const before = code.slice(Math.max(0, match.index - 96), match.index);
			if (
				BINDING_BEFORE.test(before) ||
				BINDING_TARGET_BEFORE.test(before.slice(-32))
			)
				continue;
			if (declarationAttemptAt(code, match.index + name.length))
				unproven = true;
			if (DESTRUCTURE_BEFORE.test(before)) unproven = true;
			continue;
		}
		if (chain.unproven) {
			unproven = true;
			continue;
		}
		const links = [...(aliases.get(name)?.links ?? []), ...chain.links];
		const hook = TEST_HOOKS.has(name);
		const live = hook
			? links.length === 0
			: links.every((link) => LIVE_TEST_LINKS.has(link));
		scopes.push({
			start: chain.start,
			end: chain.end,
			kind: hook
				? "hook"
				: name === "describe" || name === "suite"
					? "suite"
					: "test",
			live,
			bodyStart: hook
				? chain.lastOpen
				: firstArgumentEnd(code, chain.lastOpen, chain.lastClose),
			bodyEnd: chain.lastClose,
		});
	}
	return { scopes, unproven };
}

/** Index of the first top-level `,` inside a call's arguments, or `null`. */
function firstArgumentEnd(code, open, close) {
	let depth = 0;
	for (let index = open + 1; index < close; index++) {
		const char = code[index];
		if (char === "(" || char === "[" || char === "{") depth += 1;
		else if (char === ")" || char === "]" || char === "}") depth -= 1;
		else if (char === "," && depth === 0) return index;
	}
	return null;
}

/**
 * Whether a position is where this file's tests can read a record: in the body
 * of a declaration vitest runs, never in the callee chain or the title of one
 * (a title is a name, not an assertion), and never inside a declaration the
 * rule cannot prove runs — a `describe.skip` refuses everything under it. A
 * position no declaration encloses is not a read position: the rule reads
 * positions, not dataflow, and "the file holds a live test" admitted a dead
 * helper's body (F-4597-R2-1).
 */
function isReadPosition(scopes, position) {
	let inBody = false;
	let inDead = false;
	for (const scope of scopes) {
		if (position < scope.start || position >= scope.end) continue;
		if (!scope.live) {
			inDead = true;
			continue;
		}
		if (
			scope.bodyStart !== null &&
			position > scope.bodyStart &&
			position < scope.bodyEnd
		)
			inBody = true;
	}
	return inBody && !inDead;
}

/** The index of the `;` that ends the statement starting at `from`, or -1. */
function statementEnd(code, from) {
	let depth = 0;
	for (let index = from; index < code.length; index += 1) {
		const char = code[index];
		if (char === "(" || char === "[" || char === "{") depth += 1;
		else if (char === ")" || char === "]" || char === "}") {
			if (depth === 0) return -1;
			depth -= 1;
		} else if (char === ";" && depth === 0) return index;
	}
	return -1;
}

/**
 * The name of the module-scope function that encloses `position`, or null:
 * `function NAME(…) { … }`, `const NAME = (…) => { … }`, `const NAME =
 * function (…) { … }`, and a concise arrow (`const NAME = () => rows(…);`),
 * whose statement is the body. A declaration whose brace comes after its own
 * `;` is not a helper this reader can name.
 */
function enclosingHelperName(code, position) {
	const candidates = [];
	const add = (name, from) => {
		const brace = code.indexOf("{", from);
		if (
			brace !== -1 &&
			brace < position &&
			!code.slice(from, brace).includes(";")
		) {
			const close = closeBracketIndex(code, brace, "{", "}");
			if (close >= position) {
				candidates.push({ name, at: from });
				return;
			}
		}
		const end = statementEnd(code, from);
		if (end >= position) candidates.push({ name, at: from });
	};
	for (const match of code.matchAll(
		/(?<![.$\w])function\s+([A-Za-z_$][\w$]*)\s*\(/g,
	))
		add(match[1], match.index);
	for (const match of code.matchAll(
		/(?<![.$\w])(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^()]*\)\s*=>|function\b|[A-Za-z_$][\w$]*\s*=>)/g,
	))
		add(match[1], match.index);
	if (!candidates.length) return null;
	// The innermost helper is the one whose body holds the position.
	candidates.sort((left, right) => right.at - left.at);
	return candidates[0].name;
}

/**
 * Whether a position no declaration encloses is still a read-back: it sits in a
 * named module-scope helper that a live declaration calls. That is the shape
 * most of this repository's read-backs use (`function availabilityRows() { …
 * phase === "<record>" }`, called from a test body), and it is evidence, not
 * the round-2 guess "this file holds a live test somewhere": the helper's own
 * name has to appear as a call in a live body (F-4597-R2-1).
 */
function helperReadPosition(code, scopes, position) {
	if (scopes.some((scope) => position >= scope.start && position < scope.end))
		return false;
	const name = enclosingHelperName(code, position);
	if (!name) return false;
	const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const call = new RegExp(`(?<![\\w$])${escaped}\\s*\\(`, "g");
	for (const match of code.matchAll(call))
		if (isReadPosition(scopes, match.index)) return true;
	return false;
}

/** Whether a position is where this file's tests can read a record. */
function readPosition(code, scopes, position) {
	return (
		isReadPosition(scopes, position) ||
		helperReadPosition(code, scopes, position)
	);
}

/** The spans of the file's assertion expressions (`expect(...)` chains, `assert*(...)`). */
function assertionSpans(code, strings = []) {
	const spans = [];
	for (const match of code.matchAll(/\b(?:expect|assert)\b/g)) {
		const before = code[match.index - 1] ?? " ";
		if (before === "." || /[$\w]/.test(before)) continue;
		const chain = callChainAt(code, match.index, strings);
		if (chain) spans.push([chain.start, chain.end]);
	}
	return spans;
}

function withinSpans(spans, position) {
	return spans.some(([start, end]) => position >= start && position < end);
}

/**
 * The full name, not a prefix: `lsp_document_drift` never matches a test that
 * reads `lsp_document_drift_cap` (the shape the sibling rule's file-name match
 * already fixed, #3905 r2).
 */
function exactTokenPattern(value) {
	const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(?<![\\w.$-])${escaped}(?![\\w$-])`);
}

/** Whether the position is an operand of an equality comparison. */
function comparisonAt(code, start, end) {
	const before = code.slice(Math.max(0, start - 8), start);
	const after = code.slice(end, end + 8);
	return COMPARISON_BEFORE.test(before) || COMPARISON_AFTER.test(after);
}

/** Whether a string sits where a test asserts, compares or keys on a record. */
function stringIsRead(code, assertions, string) {
	if (withinSpans(assertions, string.start)) return true;
	const before = code.slice(Math.max(0, string.start - 40), string.start);
	return (
		COMPARISON_BEFORE.test(before) ||
		comparisonAt(code, string.start, string.end) ||
		CASE_LABEL_BEFORE.test(before) ||
		RECORD_KEY_BEFORE.test(before) ||
		CONTAINMENT_CALL_BEFORE.test(before)
	);
}

/** Whether an identifier the test spells is read where a record is decided. */
function identifierIsRead(code, scopes, assertions, identifier) {
	const pattern = new RegExp(
		`(?<![\\w$])${identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w$])`,
		"g",
	);
	for (const match of code.matchAll(pattern)) {
		if (!readPosition(code, scopes, match.index)) continue;
		if (withinSpans(assertions, match.index)) return true;
		if (comparisonAt(code, match.index, match.index + match[0].length))
			return true;
	}
	return false;
}

// Vitest's own default `include` (`configDefaults.include` in `vitest/config`),
// which is what the projects that declare no `include` collect — the default
// project here. The lint cannot import it (`lintPrBody` is synchronous, and the
// script runs in lanes with no `npm install`), so the value is pinned against
// the real `configDefaults.include` by the #4597 test file: a vitest upgrade
// that moves the default reds there, and this constant moves with it.
const VITEST_DEFAULT_INCLUDE = ["**/*.{test,spec}.?(c|m)[jt]s?(x)"];
const VITEST_CONFIG = "vitest.config.ts";
// A conditional list's own choice (`process.env.npm_lifecycle_event ===
// "test:unit" ? A : B`), read the way the config module reads it when it
// loads: the lint sees the lists the run sees. `undefined` is "this reader
// cannot decide", and the caller unions both branches.
const ENV_COMPARISON =
	/process\.env(?:\.([A-Za-z_$][\w$]*)|\s*\[\s*["'`]([^"'`]+)["'`]\s*\])\s*(===|==|!==|!=)\s*["'`]([^"'`]*)["'`]/;

function conditionalBranch(condition) {
	const match = ENV_COMPARISON.exec(String(condition ?? ""));
	if (!match) return undefined;
	const actual = process.env[match[1] ?? match[2]] ?? "";
	const equal = actual === match[4];
	return match[3] === "===" || match[3] === "==" ? equal : !equal;
}

/**
 * Whether a repo-relative POSIX path is a file vitest collects, read from the
 * repository's own `vitest.config.ts`: each project's `include`/`exclude` lists
 * (the root `test` block's merge into every project), resolved through the
 * `const` arrays they name or spread. `null` when the config is absent,
 * unreadable, or holds a list this reader cannot resolve, because a guessed
 * answer would either refuse every body or admit every file.
 */
function vitestCollectedPaths(cwd = REPO_ROOT) {
	let source;
	try {
		source = readFileSync(resolve(cwd, VITEST_CONFIG), "utf8");
	} catch {
		return null;
	}
	if (source.length > MAX_SOURCE_BYTES) return null;
	const lexed = blankCommentsAndStrings(source);
	const code = lexed.text;
	// Every `const/let/var NAME = …` initializer, so a list can be named.
	const declarations = new Map();
	for (const match of code.matchAll(
		/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*/g,
	))
		declarations.set(match[1], match.index + match[0].length);
	// The blanked text carries no string, so a list's patterns are read from the
	// lexer's own string spans. A negation (`!pattern`) changes what the list
	// means in a way this reader does not model, so it makes the config
	// unreadable rather than silently absent.
	const elementsOf = (open, close, depth) => {
		if (open === -1 || close === -1 || depth > 12) return null;
		const found = [];
		for (const string of lexed.strings) {
			if (string.start <= open || string.end > close) continue;
			if (string.text.startsWith("!")) return null;
			found.push(string.text);
		}
		const inner = code.slice(open + 1, close);
		for (const match of inner.matchAll(
			/\.\.\.\s*([A-Za-z_$][\w$]*)|([^\s,])/g,
		)) {
			if (match[1] !== undefined) {
				const span = declarations.get(match[1]);
				const spread = span === undefined ? null : resolveList(span, depth + 1);
				if (spread === null) return null;
				found.push(...spread);
				continue;
			}
			// Blanked text holds no strings, so anything else inside the array is an
			// element this reader does not model (an expression, a call, a number).
			if (match[2] !== undefined) return null;
		}
		return found;
	};
	/** `\`?\`` or `\`:\`` at depth 0 before the statement's `;`, or `-1`. */
	const separatorAt = (start, separator) => {
		let depth = 0;
		for (let index = start; index < code.length; index++) {
			const char = code[index];
			if (char === "(" || char === "[" || char === "{") depth += 1;
			else if (char === ")" || char === "]" || char === "}") depth -= 1;
			else if (char === ";" && depth === 0) return -1;
			else if (char === separator && depth === 0) return index;
		}
		return -1;
	};
	// A list is an array literal, a name bound to one, or a conditional over two
	// of them (`process.env.npm_lifecycle_event === "test:unit" ? A : []`). A
	// conditional that compares an environment variable is decided the way the
	// config module decides it when loaded, so the lint sees the lists the run
	// sees; any other condition unions both branches, which errs toward refusing
	// a file rather than admitting one the suite may not run.
	const resolveList = (start, depth) => {
		if (depth > 12) return null;
		const at = skipSpaces(code, start);
		if (code[at] === "[")
			return elementsOf(at, closeBracketIndex(code, at, "[", "]"), depth);
		const question = separatorAt(at, "?");
		if (question !== -1) {
			const colon = separatorAt(question + 1, ":");
			if (colon === -1) return null;
			const whenTrue = () => resolveList(question + 1, depth + 1);
			const whenFalse = () => resolveList(colon + 1, depth + 1);
			const branch = conditionalBranch(source.slice(at, question));
			const first = branch === false ? whenFalse() : whenTrue();
			if (branch !== undefined) return first;
			const second = whenFalse();
			if (first === null || second === null) return null;
			return [...first, ...second];
		}
		const name = /^([A-Za-z_$][\w$]*)/.exec(code.slice(at))?.[1];
		const init = name === undefined ? undefined : declarations.get(name);
		if (init === undefined) return null;
		return resolveList(init, depth + 1);
	};
	const patterns = (kind, open, close) => {
		if (open === -1 || close === -1) return null;
		const found = [];
		const key = new RegExp(`\\b${kind}\\s*:\\s*`, "y");
		let depth = 0;
		for (let index = open + 1; index < close; index++) {
			const char = code[index];
			if (char === "(" || char === "[" || char === "{") depth += 1;
			else if (char === ")" || char === "]" || char === "}") depth -= 1;
			if (depth !== 0) continue;
			key.lastIndex = index;
			const match = key.exec(code);
			if (!match) continue;
			const resolved = resolveList(match.index + match[0].length, 0);
			if (resolved === null) return null;
			found.push(...resolved);
			index = match.index + match[0].length - 1;
		}
		return found;
	};
	// A vitest config collects a file through ONE project: each project's
	// `include` and `exclude` list, plus the root `test` block's, which apply to
	// every project (`tests/support/vitest-collection.ts` reads the same merge).
	// A project that declares neither `include` nor an inherited one collects
	// vitest's default include. This is the twice-verified part of the config: a
	// dedicated project's own files are excluded from the default project
	// (`wallClockBudgetInclude` here), so a union over every exclude list would
	// answer "not collected" for files the suite really runs.
	const blocks = [];
	for (const match of code.matchAll(/\btest\s*:\s*\{/g)) {
		const open = match.index + match[0].length - 1;
		const close = closeBracketIndex(code, open, "{", "}");
		if (close === -1) return null;
		blocks.push({ open, close });
	}
	const root = blocks.find((block) =>
		/\bprojects\s*:/.test(code.slice(block.open, block.close)),
	);
	if (!root) return null;
	const rootLists = {
		include: patterns("include", root.open, root.close),
		exclude: patterns("exclude", root.open, root.close),
	};
	if (rootLists.include === null || rootLists.exclude === null) return null;
	const projects = blocks
		.filter(
			(block) =>
				block !== root && block.open > root.open && block.close < root.close,
		)
		.map((block) => ({
			include: patterns("include", block.open, block.close),
			exclude: patterns("exclude", block.open, block.close),
		}));
	if (!projects.length) projects.push({ include: [], exclude: [] });
	const compiled = [];
	for (const project of projects) {
		if (project.include === null || project.exclude === null) return null;
		const include = [...rootLists.include, ...project.include];
		const exclude = [...rootLists.exclude, ...project.exclude];
		compiled.push({
			include: (include.length ? include : VITEST_DEFAULT_INCLUDE).map(
				(pattern) => globToRegExp(pattern, { directory: false }),
			),
			exclude: exclude.map((pattern) =>
				globToRegExp(pattern, { directory: true }),
			),
		});
	}
	return (path) =>
		compiled.some(
			(project) =>
				project.include.some((matcher) => matcher.test(path)) &&
				!project.exclude.some((matcher) => matcher.test(path)),
		);
}

/** A glob as vitest reads it: `**`, `*`, `?`, `{a,b}`, `?(a|b)`, `[abc]`. */
function globToRegExp(pattern, { directory }) {
	if (!/[*?[\]{}()]/.test(pattern)) {
		const escaped = pattern
			.replace(/\/+$/, "")
			.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		return directory
			? new RegExp(`^(?:${escaped}(?:/.*)?)$`)
			: new RegExp(`^${escaped}$`);
	}
	let out = "^";
	for (let index = 0; index < pattern.length; index++) {
		const char = pattern[index];
		if (char === "*") {
			if (pattern[index + 1] === "*") {
				index += 1;
				if (pattern[index + 1] === "/") {
					index += 1;
					out += "(?:[^/]+/)*";
				} else out += ".*";
			} else out += "[^/]*";
			continue;
		}
		if (char === "?") {
			const group = /^\?\(([^)]*)\)/.exec(pattern.slice(index));
			if (group) {
				out += `(?:${group[1]})?`;
				index += group[0].length - 1;
			} else out += "[^/]";
			continue;
		}
		if (char === "{") {
			const end = pattern.indexOf("}", index);
			if (end !== -1) {
				// One-off call-site escapes, the shape this sweep's header allows for a
				// `scripts/*.mjs` that runs with no `npm install`: no escaping helper.
				const alternatives = [];
				for (const one of pattern.slice(index + 1, end).split(","))
					alternatives.push(one.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
				out += `(?:${alternatives.join("|")})`;
				index = end;
				continue;
			}
		}
		if (char === "[") {
			const end = pattern.indexOf("]", index);
			if (end !== -1) {
				out += pattern.slice(index, end + 1);
				index = end;
				continue;
			}
		}
		out += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`${out}$`);
}

/** The record-shaped mentions of a section, in the order the body makes them. */
function recordMentions(content, families = []) {
	// A `TLA+ unaffected: <family>` line names a family, not a record (#3902).
	const source = withoutDeclaredFamilies(content ?? "", families);
	const mentioned = new Map();
	for (const match of source.matchAll(/`([^`\n]+)`/g)) {
		const span = match[1].trim();
		if (RECORD_LITERAL_SPAN.test(span)) mentioned.set(span, true);
	}
	for (const match of source.matchAll(RECORD_TOKEN))
		if (!mentioned.has(match[0])) mentioned.set(match[0], false);
	const entries = [...mentioned];
	if (entries.length <= MAX_RECORD_MENTIONS)
		return { mentions: entries, truncated: false };
	return {
		mentions: entries.slice(0, MAX_RECORD_MENTIONS),
		truncated: true,
	};
}

/**
 * `git grep -l` for several fixed strings at once: the file list, `[]` for no
 * match (git exits 1, which is not a failure), or `null` when the probe could
 * not run at all. A null is reported, never read as an empty tree.
 */
function grepLiteralFiles(patterns, pathspecs, options = {}) {
	if (!patterns.length) return [];
	let output;
	try {
		output = (options.git ?? gitExecFileSync)(
			[
				"grep",
				"-l",
				// The long form on purpose: the writer-script census reads a bare
				// "-F" as a `gh` field flag (tests/config/workflow-writers-governance).
				"--fixed-strings",
				...patterns.flatMap((pattern) => ["-e", pattern]),
				"--",
				...pathspecs,
			],
			{
				cwd: options.cwd ?? process.cwd(),
				encoding: "utf8",
				maxBuffer: MAX_SOURCE_BYTES,
			},
		);
	} catch (error) {
		if (error?.status === 1) return [];
		return null;
	}
	return String(output ?? "")
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
}

/**
 * The record values the head tree's runtime code emits among the candidates,
 * split by the field they were harvested from: `values` is every record value,
 * `identity` only the ones read from a record-identity field. One grep for
 * every candidate, then one lex per file that mentions any of them: reading the
 * whole runtime tree to answer a handful of needles is the cost this avoids.
 */
function emittedRecordLiterals(candidates, options = {}) {
	const files = grepLiteralFiles(
		candidates,
		RUNTIME_OBSERVABILITY_ROOTS,
		options,
	);
	// `null` is "the probe could not run", never "the tree holds nothing":
	// the caller reports it rather than reading the empty answer as proof.
	if (files === null) return null;
	const values = new Set();
	const identity = new Set();
	for (const file of files) {
		if (!isRuntimeObservabilityPath(file)) continue;
		const source = headFileSource(file, {
			headFiles: options.headFiles,
			workingTree: true,
			cwd: options.cwd,
			git: options.git,
		});
		if (typeof source !== "string") continue;
		for (const record of recordLocationsFromRuntimeSource(source)) {
			values.add(record.value);
			if (RECORD_IDENTITY_FIELDS.has(record.field)) identity.add(record.value);
		}
	}
	return { values, identity };
}

// A record literal can reach a test through a binding (`const PHASE = "x"`,
// then `row.phase === PHASE`), which is still the test reading the record back:
// the binding is one indirection, not a bare mention. The binding counts only
// where an assertion compares it or hands it to a matcher; `notice(PHASE)` is a
// mention, not a read-back.
const LITERAL_BINDING_BEFORE =
	/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*$/;

/**
 * The literals a test reads back, under the two rules above: a position inside a
 * declaration vitest collects and runs, and a string or identifier the test
 * asserts, compares or keys on. One lex per file, so a comment that quotes the
 * literal never counts; one `vitest.config.ts` read per call, so a file the
 * suite never runs never counts either. A probe that cannot run answers
 * `{ skipped }`, never an empty set.
 */
function testedRecordLiterals(literals, options = {}) {
	const files = grepLiteralFiles(literals, ["tests"], options);
	if (files === null)
		return { skipped: "the tests/ search", reason: "git grep failed" };
	const collects = vitestCollectedPaths();
	if (collects === null)
		return {
			skipped: "the vitest config read",
			reason: `${VITEST_CONFIG} could not be read`,
		};
	const tested = new Set();
	const unprovable = [];
	for (const file of files) {
		if (!TEST_SOURCE_FILE.test(file)) continue;
		if (!collects(file)) continue;
		const source = headFileSource(file, {
			headFiles: options.headFiles,
			workingTree: true,
			cwd: options.cwd,
			git: options.git,
		});
		if (typeof source !== "string") continue;
		const lexed = blankCommentsAndStrings(source);
		const code = lexed.text;
		const { scopes, unproven: cannotProve } = declarationScopes(
			code,
			lexed.strings,
		);
		// A declaration this reader cannot classify makes the file unprovable: it
		// contributes no read-back rather than admitting a position on the strength
		// of some other live test (F-4597-R2-1).
		if (cannotProve) {
			unprovable.push(file);
			continue;
		}
		const assertions = assertionSpans(code, lexed.strings);
		const bindings = new Map();
		for (const string of lexed.strings) {
			const identifier = LITERAL_BINDING_BEFORE.exec(string.prefix)?.[1];
			if (!identifier) continue;
			const bound = bindings.get(string.text) ?? [];
			bound.push(identifier);
			bindings.set(string.text, bound);
		}
		for (const literal of literals) {
			if (tested.has(literal)) continue;
			const token = exactTokenPattern(literal);
			const read =
				lexed.strings.some(
					(string) =>
						token.test(string.text) &&
						readPosition(code, scopes, string.start) &&
						stringIsRead(code, assertions, string),
				) ||
				identifierIsRead(code, scopes, assertions, literal) ||
				(bindings.get(literal) ?? []).some((identifier) =>
					identifierIsRead(code, scopes, assertions, identifier),
				);
			if (read) tested.add(literal);
		}
	}
	return { tested, unprovable };
}

/**
 * #4597: every record literal the `## Observability` section names must appear
 * in a test under `tests/` in the head tree, in a declaration vitest collects
 * and runs. `none: <reason>` needs no special case: a body that names no record
 * literal owes no read-back, and the record checks above already refuse an
 * empty answer where the diff adds a failure path. A probe that cannot run is a
 * skipped check and says so (`warnRecordReadBackSkipped`), never silence and
 * never a refusal the author cannot act on. It runs only when a diff was
 * resolved, like the record-naming rule beside it, so the local preflight
 * without an upstream ref keeps structural lint alone.
 */
/**
 * A probe that cannot run is a skipped check, and a skipped check says so: a
 * caller that copied a body outside a checkout must not read the silence as a
 * clean result (shape 10), and refusing would answer a body under test with an
 * error the author cannot act on. The record is the CI annotation below.
 */
function warnRecordReadBackSkipped(step, names, reason = "git grep failed") {
	console.warn(
		`::warning::PR body Observability names ${names
			.map((name) => `\`${name}\``)
			.join(
				", ",
			)}, but ${step} could not run (${reason}), so the #4597 read-back check was skipped for them.`,
	);
}

function lintObservabilityRecordsTested(lines, headings, options = {}) {
	const content = observabilitySectionContent(lines, headings);
	const families = loadSeamMap(options.cwd)?.families ?? [];
	const { mentions, truncated } = recordMentions(content, families);
	if (!mentions.length) return [];
	if (truncated)
		console.warn(
			`::warning::PR body Observability names more than ${MAX_RECORD_MENTIONS} record-shaped tokens, so the #4597 read-back check read the first ${MAX_RECORD_MENTIONS} and did not check the rest.`,
		);
	const candidates = mentions.map(([name]) => name);
	const emitted = emittedRecordLiterals(candidates, options);
	if (emitted === null) {
		warnRecordReadBackSkipped("the runtime record harvest", candidates);
		return [];
	}
	// A backticked span is an explicit naming and is read against every
	// harvested field; a bare token or link text must be a record identity,
	// because a bare two-segment compound is also ordinary prose
	// (F-4597-R2-2).
	const named = mentions
		.filter(
			([name, quoted]) =>
				emitted.values.has(name) && (quoted || emitted.identity.has(name)),
		)
		.map(([name]) => name);
	if (!named.length) return [];
	const result = testedRecordLiterals(named, options);
	if (result.skipped) {
		warnRecordReadBackSkipped(result.skipped, named, result.reason);
		return [];
	}
	const missing = named.filter((name) => !result.tested.has(name));
	if (!missing.length) return [];
	const unprovable = result.unprovable ?? [];
	const shown = unprovable.slice(0, 3);
	const extra =
		unprovable.length > shown.length
			? ` (+${unprovable.length - shown.length} more)`
			: "";
	const unprovableNote = shown.length
		? ` A tests/ file whose declarations this rule cannot prove runs contributes nothing, so name the record in a form it reads: ${shown.join(", ")}${extra}.`
		: "";
	return [
		`PR body Observability names ${missing.map((name) => `\`${name}\``).join(", ")}, which no test under tests/ reads: admit one proven form — the record's full name in an assertion inside a test vitest collects and runs, or where that test compares the observed value with it — because docs/pi-lens-fixer.md:117 requires the record the section names to be asserted by a test (#4597).${unprovableNote}`,
	];
}

/** Detect the high-confidence shape produced when a worker flattens a body. */
export function detectFlattenedBody(body = "") {
	const source = String(body ?? "");
	const newlineCount = (source.match(/\r?\n/g) ?? []).length;
	if (newlineCount > FLATTENED_BODY_MAX_NEWLINES || source.length < 200)
		return false;
	// A flattened body containing these markers has already lost data. It is
	// safer to report the original lint errors than to write a guessed repair.
	if (
		/[\f\t]|\r(?!\n)|\\[ftr]/.test(source) ||
		/\\n/.test(source) ||
		new RegExp(
			`(?:^|[\\s])(?:${CORRUPTED_HEADING_TAILS.join("|")})(?=\\s|$)`,
			"i",
		).test(source) ||
		new RegExp(
			`(?:^|[\\s` +
				"\\\"'" +
				`])(?:${CORRUPTED_IDENTIFIER_TAILS.join("|")})(?=$|[\\s` +
				"\\\"',.)" +
				`])`,
		).test(source)
	)
		return false;
	const inlineHeadings = source.match(
		new RegExp(
			`(?<!^)\\s#{2,4}\\s+(?:${REPAIR_HEADING_PATTERN})(?=\\s|$)`,
			"g",
		),
	);
	return (inlineHeadings?.length ?? 0) >= 2;
}

const ESCAPED_NEWLINE = /\\r\\n|\\n/g;

function escapedNewlineRangesOutsideCodeSpans(source) {
	const protectedRanges = [];
	for (const match of source.matchAll(/(`+)([\s\S]*?)\1/g)) {
		protectedRanges.push([match.index, match.index + match[0].length]);
	}
	return [...source.matchAll(ESCAPED_NEWLINE)]
		.filter(
			({ index }) =>
				!protectedRanges.some(([start, end]) => index >= start && index < end),
		)
		.map(({ index, 0: value }) => ({ index, value }));
}

function replaceEscapedNewlinesOutsideCodeSpans(source) {
	const replacements = escapedNewlineRangesOutsideCodeSpans(source);
	if (!replacements.length) return source;
	let result = "";
	let cursor = 0;
	for (const { index, value } of replacements) {
		result += source.slice(cursor, index) + "\n";
		cursor = index + value.length;
	}
	return result + source.slice(cursor);
}

/**
 * Detect the sibling flattening shape from the #2058-era class: a worker
 * emits the literal two-or-four character sequence "\n" or "\r\n" where a
 * real line break belongs, instead of collapsing real newlines into spaces
 * (the shape #2149 already repairs). Restoring this is unambiguous ONLY
 * when every backslash in the body belongs to one of those joins — a
 * Windows path like "C:\node_modules\pi" contains a genuine "\n" substring
 * that a blind replace would split into "C:" + a real newline +
 * "ode_modules\pi" while still validating (#2145 review F1). Any leftover
 * backslash after the joins are stripped means real content is present, so
 * this refuses, mirroring detectFlattenedBody's own data-loss guard.
 *
 * A fenced block (``` or ~~~, both valid CommonMark that GitHub renders)
 * refuses this repair entirely too. Inside a fence a literal backslash-n
 * can be genuine content, AND a flattened fence's own delimiters can land
 * on the same logical line, which the unrelated line-based fence scanner
 * in lintPrBody cannot parse back apart. Rather than guess, any body
 * carrying a fence is left untouched (fence preservation, issue #2145;
 * true fence repair stays deferred, per the #2149 round-3 decision).
 */
export function detectEscapedNewlineBody(body = "") {
	const source = String(body ?? "");
	if (source.length < 200 || source.includes("```") || source.includes("~~~"))
		return false;
	const realNewlines = (source.match(/\r\n|\n/g) ?? []).length;
	if (realNewlines > FLATTENED_BODY_MAX_NEWLINES) return false;
	const literalNewlines = escapedNewlineRangesOutsideCodeSpans(source);
	if (literalNewlines.length < 2) return false;
	const normalized = replaceEscapedNewlinesOutsideCodeSpans(source);
	const unprotected = source
		.replace(/(`+)([\s\S]*?)\1/g, (span) => " ".repeat(span.length))
		.replace(ESCAPED_NEWLINE, "");
	if (unprotected.includes("\\")) return false;
	const candidateHeadingLines = normalized
		.split("\n")
		.filter((line) =>
			new RegExp(`^\\s*#{2,4}\\s+(?:${REPAIR_HEADING_PATTERN})\\s*$`, "i").test(
				line,
			),
		);
	return candidateHeadingLines.length >= 2;
}

/**
 * Repair only a body already proven to have the escaped-newline shape.
 * detectEscapedNewlineBody already refuses any body carrying a fence, so
 * this plain global replace never runs on fenced content.
 */
export function repairEscapedNewlineBody(body = "") {
	const source = String(body ?? "");
	if (!detectEscapedNewlineBody(source)) return source;
	const repaired = replaceEscapedNewlinesOutsideCodeSpans(source);
	return /^\s*#{2,4}\s+Why\s*$/im.test(repaired)
		? repaired
		: `${REVIEW_HEADER_REPAIR_PREFIX}\n${repaired}`;
}

/**
 * Normalize only for linting. The body remains unchanged on GitHub: workers
 * should fix their own PR text, while this read-only path makes a clear
 * warning when a high-confidence flattened-body repair lets checks proceed.
 */
export function normalizePrBodyForChecking(body = "", pullRequestNumber) {
	const source = String(body ?? "");
	for (const { detect, repair } of [
		{ detect: detectFlattenedBody, repair: repairFlattenedBody },
		{ detect: detectEscapedNewlineBody, repair: repairEscapedNewlineBody },
	]) {
		if (!detect(source)) continue;
		const normalized = repair(source);
		if (normalized === source) continue;
		console.warn(
			`::warning::Normalized flattened PR body for #${pullRequestNumber ?? "?"} for checking only; the original body was not edited.`,
		);
		return { body: normalized, normalized: true };
	}
	return { body: source, normalized: false };
}

/** Repair only a body already proven to have the flattened shape. */
export function repairFlattenedBody(body = "") {
	const source = String(body ?? "");
	if (!detectFlattenedBody(source)) return source;
	let repaired = source.replace(/\r\n?/g, "\n");
	repaired = repaired.replace(
		new RegExp(
			`(^|[.!?])[ \\t]*(#{2,4}\\s+(?:${REPAIR_HEADING_PATTERN}))(?=\\s|$)`,
			"g",
		),
		(_match, sentenceEnd, heading) =>
			sentenceEnd ? `${sentenceEnd}\n\n${heading}\n` : `${heading}\n`,
	);
	const residualInlineHeadings = repaired.match(
		new RegExp(
			`(?<!^)[ \\t]#{2,4}\\s+(?:${REPAIR_HEADING_PATTERN})(?=\\s|$)`,
			"g",
		),
	);
	if (residualInlineHeadings?.length) return source;
	const repairedHeadings = repaired
		.split("\n")
		.map((line) => HEADING.exec(line)?.[1].trim().toLowerCase())
		.filter(Boolean);
	const templateHeadings = repairedHeadings.filter((heading) =>
		new RegExp(`^(?:${REPAIR_HEADING_PATTERN})$`, "i").test(heading),
	);
	const distinctTemplateHeadings = new Set(templateHeadings);
	if (repairedHeadings.length !== distinctTemplateHeadings.size) return source;
	return /^\s*#{2,4}\s+Why\s*$/im.test(repaired)
		? repaired
		: `${REVIEW_HEADER_REPAIR_PREFIX}\n${repaired}`;
}

// #4288 (docs/pi-lens-merge-policy.md, "Detection retrospective on every
// merged bug fix"): a PR that closes a bug-labelled issue states which layer
// caught the bug, which layer should have caught it, and what gap remains.
// The layer vocabulary is ONE exported list so the body lint, the template
// hint, and the orchestrator's ledger copy cannot drift.
export const DETECTION_LAYERS = Object.freeze([
	"external user",
	"reviewer probe",
	"CI unit",
	"governance sweep",
	// #4490: CodeQL code scanning caught a defect no other layer names.
	"static analysis",
	// #4519: the retro (2026-10-16) found 43 TLA+ catches and no word for them,
	// nor for mutation, the pre-push hook or the type/lint gate.
	"TLA+",
	"mutation",
	"pre-push",
	"lint/type check",
	"smoke",
	// `nightly` may carry its workflow as `nightly:<workflow>` (#4519).
	"nightly",
	"dogfood",
	"release gate",
]);
const DETECTION_LAYER_SET = new Set(
	DETECTION_LAYERS.map((layer) => layer.toLowerCase()),
);
// `nightly:<workflow>` is a layer word too; the workflow is a file stem or name.
const NIGHTLY_WORKFLOW_LAYER = /^nightly:\s*[a-z0-9][a-z0-9._-]*$/;
const isDetectionLayer = (normalized) =>
	DETECTION_LAYER_SET.has(normalized) ||
	NIGHTLY_WORKFLOW_LAYER.test(normalized);
// "This layer caught it in time" is a valid detection lesson (issue #4288,
// "Valid verdicts"): the gate must not demand new tests for every bug.
const isDetectionShouldLayer = (normalized) =>
	normalized === "this layer" || isDetectionLayer(normalized);

const DETECTION_LAYER_HINT = `Layers: ${DETECTION_LAYERS.join(", ")}; "nightly:<workflow>" names the workflow. See ${TEMPLATE_PATH}.`;

export const DETECTION_MESSAGE =
	'PR body "## Detection" must state the bug-detection lesson in five lines: ' +
	'"Caught by: <layer>", "Should have been caught by: <layer|this layer>", ' +
	'"Gap: <issue ref> | exists: <path of a test already on master> | none: <reason>", ' +
	'"Shape: #N (a docs/defect-shapes.md number) | new: <name>", ' +
	'and "Enforcer: <tree-wide test path on master> | #N (an issue to build one) | none: judgment-only, <reason>". ' +
	DETECTION_LAYER_HINT;

// #4519: the retro read 139 of 363 closed bugs as "unknown". A bug-closing PR
// owes a layer word and a reason; "unknown", "n/a", "tbd" and "?" are neither.
export const DETECTION_UNKNOWN_MESSAGE =
	'PR body "## Detection" answers "unknown", "n/a", "tbd" or "?" (or a reason that starts with "unknown"), which is not a detection lesson: a PR that closes or references a bug names the layer that caught the bug (and the layer that should have), a real reason after "Gap: none:", the shape name, and the enforcer reason. ' +
	DETECTION_LAYER_HINT;

// A field value is found by its line prefix, never a sentence mention: a
// prose line that merely contains "caught by" is not the field. Leading list
// markers and bold/code emphasis are tolerated because the template sanctions
// them; the value itself is returned raw for per-field validation.
function detectionFieldValue(content, field) {
	for (const raw of String(content ?? "").split(/\r?\n/)) {
		const candidate = raw.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)?/, "").trim();
		const match =
			/^(?:\*\*|__)?([A-Za-z ]+?)(?:\*\*|__)?\s*:(?:\*\*|__)?\s*(.*)$/.exec(
				candidate,
			);
		if (match && match[1].trim().toLowerCase() === field)
			return match[2].trim();
	}
	return null;
}

function normalizeDetectionLayer(value) {
	return String(value ?? "")
		.replace(/[*_`]/g, "")
		.replace(/[\s.,;:!]+$/, "")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();
}

// A placeholder answer: "unknown" opening the text, or a bare "n/a", "tbd" or
// "?". Only free-text answers of a bug-closing PR are screened (#4519).
function isPlaceholderAnswer(value) {
	const text = normalizeDetectionLayer(value);
	return /^unknown\b/.test(text) || /^(?:n\/a|tbd|\?+)$/.test(text);
}

const TABLE_SHAPE_MESSAGE = (expected, actual, row) =>
	`PR body table row has ${actual} cell${actual === 1 ? "" : "s"} but its header has ${expected}: ${row.trim().slice(0, 80)}. GitHub splits a row at every pipe that is not written \\| (a backticked pipe too), so the row renders wrong. Escape the pipe as \\| or reword the cell.`;

const BEHAVIOR_EQUIVALENCE_MESSAGE =
	'PR body "## Behavior equivalence" must contain a markdown table with Site, Before, and After columns and at least one non-placeholder data row.';

function isBehaviorEquivalencePlaceholder(value) {
	const normalized = normalizeDetectionLayer(value);
	return (
		!normalized ||
		isPlaceholderAnswer(normalized) ||
		/^(?:-|—|–|empty)$/.test(normalized)
	);
}

// A pipe-table row's cells, or null when the line is not a bordered table row.
function tableRowCells(line) {
	return /^\s*\|.*\|\s*$/.test(line) ? splitMarkdownRow(line) : null;
}

// A row whose cell count differs from its header's renders wrong on GitHub: an
// unescaped pipe inside a backticked cell splits it, so the Red cell of a
// mutation row showed a stray "`1 failed" and lost the rest (#5070 merged with
// 12 of 15 such rows, and no lint looked). A short row is padded and a long
// one truncated by the renderer, so either is a cell the reader never sees.
function lintTableShape(body) {
	const lines = sourceWithoutFencedBlocks(body).split(/\r?\n/);
	const errors = [];
	for (let index = 0; index + 1 < lines.length; index += 1) {
		const headers = tableRowCells(lines[index]);
		const separator = tableRowCells(lines[index + 1]);
		if (
			!headers ||
			!separator ||
			separator.length !== headers.length ||
			!separator.every((cell) => /^:?-{3,}:?$/.test(cell))
		)
			continue;
		for (let rowIndex = index + 2; rowIndex < lines.length; rowIndex += 1) {
			const row = tableRowCells(lines[rowIndex]);
			if (!row) break;
			if (row.length !== headers.length)
				errors.push(
					TABLE_SHAPE_MESSAGE(headers.length, row.length, lines[rowIndex]),
				);
		}
	}
	return errors;
}

function lintBehaviorEquivalence(body, headings, title) {
	if (!/^\s*refactor(?:\([^)]*\))?!?:/i.test(String(title ?? ""))) return [];
	const heading = headings.find((candidate) =>
		hasSection(candidate, "behavior equivalence"),
	);
	if (!heading) return [BEHAVIOR_EQUIVALENCE_MESSAGE];
	const lines = sourceWithoutFencedBlocks(body).split(/\r?\n/);
	const nextHeading = headings.find(
		(candidate) =>
			candidate.index > heading.index && candidate.level <= heading.level,
	);
	const tableLines = lines.slice(
		heading.contentIndex,
		nextHeading?.index ?? lines.length,
	);
	for (let index = 0; index + 1 < tableLines.length; index += 1) {
		const headers = tableRowCells(tableLines[index]);
		if (!headers) continue;
		const normalizedHeaders = headers.map((header) => header.toLowerCase());
		const site = normalizedHeaders.indexOf("site");
		const before = normalizedHeaders.indexOf("before");
		const after = normalizedHeaders.indexOf("after");
		if (
			site < 0 ||
			before < 0 ||
			after < 0 ||
			!/^\s*\|?(?:\s*:?-+:?\s*\|)+\s*$/.test(tableLines[index + 1])
		)
			continue;
		// The table ends at the first line that is not a table row: a blank line,
		// prose, or the next section. Scanning past it would read a later,
		// unrelated table's cells (even its header) as this table's data row.
		for (
			let rowIndex = index + 2;
			rowIndex < tableLines.length;
			rowIndex += 1
		) {
			const row = tableRowCells(tableLines[rowIndex]);
			if (!row) break;
			if (row.length < headers.length) continue;
			if (
				![site, before, after].some((column) =>
					isBehaviorEquivalencePlaceholder(row[column]),
				)
			)
				return [];
		}
	}
	return [BEHAVIOR_EQUIVALENCE_MESSAGE];
}

// `Gap:` names a follow-up issue, an existing test that now covers the bug, or
// a reasoned `none:`. `exists:` must name a test path (under tests/ or a test
// extension), so "exists: TBD" is refused. When the caller supplies
// `existsOnBase` (#4404), the path must also be a file on the PR's base: a test
// this PR adds is the fix, not a layer that already existed.
const DETECTION_EXISTS_ALTERNATIVES =
	'Give an issue ref (#NNN) or "none: <reason>" instead.';

export const detectionExistsNotOnBaseMessage = (path) =>
	`PR body "## Detection" says "Gap: exists: ${path}", but that file is not on the PR's base commit (git merge-base origin/master HEAD). A test this PR adds is not an existing layer. Name one repo-relative path with forward slashes and no line number. ${DETECTION_EXISTS_ALTERNATIVES}`;

export const DETECTION_EXISTS_BASE_UNRESOLVED_MESSAGE =
	'PR body "## Detection" says "Gap: exists: <path>", but the PR\'s base commit could not be resolved (git merge-base origin/master HEAD failed; run "git fetch origin master", plus "git fetch --unshallow" in a shallow clone), so the path cannot be verified. ' +
	DETECTION_EXISTS_ALTERNATIVES;

/**
 * #4404: the PR's base commit, the merge base `localDiff` already diffs from.
 * `null` when it cannot be resolved (no `origin/master`, a shallow checkout, a
 * git stub that prints nothing).
 */
export function resolvePrBase(cwd = process.cwd(), git = gitExecFileSync) {
	try {
		const sha = String(
			git(["merge-base", "origin/master", "HEAD"], { cwd, encoding: "utf8" }),
		).trim();
		return sha || null;
	} catch {
		return null;
	}
}

/**
 * The `existsOnBase` reader for `lintDetectionSection` and the workflow
 * run-evidence rule: `true` when the path is a file on the PR's base, `false`
 * only when `git ls-tree` CONFIRMS it is absent (empty output) or not a file,
 * `null` when the base cannot be resolved or the read fails. A failed read is
 * unknown, never absent (#4756 F1): the workflow rule relaxes for an absent
 * file, and both consumers read `null` as unresolved, which is an error. The
 * base resolves once, on first use.
 */
export function baseFileReader(cwd = process.cwd(), git = gitExecFileSync) {
	let base;
	return (path) => {
		base ??= resolvePrBase(cwd, git) ?? false;
		if (!base) return null;
		try {
			// `ls-tree <base> -- dir/` lists the directory's entries, so the entry
			// must be the queried path itself and a blob.
			return String(
				git(["ls-tree", "-z", base, "--", path], {
					cwd,
					encoding: "utf8",
					stdio: ["ignore", "pipe", "ignore"],
				}),
			)
				.split("\0")
				.some((entry) => {
					const match = /^\d+ blob \S+\t([\s\S]*)$/.exec(entry);
					return match !== null && match[1] === path;
				});
		} catch {
			return null;
		}
	};
}

function existsGapPath(value) {
	const exists = /^exists\s*:\s*(.+)$/i.exec(String(value ?? "").trim());
	return exists ? exists[1].replace(/[*_`]/g, "").trim() : null;
}

function isDetectionTestPath(testPath) {
	return (
		testPath.startsWith("tests/") ||
		/(?:^|\/)test_[^/]+$/.test(testPath) ||
		/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(testPath) ||
		/_test\.(?:py|go|rs)$/.test(testPath)
	);
}

// The reason after `none:` in a `Gap:` value, or null when it is not a `none:`.
function noneReason(value) {
	const none = /^none\s*:\s*(.+)$/i.exec(String(value ?? "").trim());
	return none ? none[1] : null;
}

function validDetectionGap(value) {
	const text = String(value ?? "").trim();
	if (/(?:^|\s|[(])#\d+\b/.test(text)) return true;
	const testPath = existsGapPath(text);
	if (testPath !== null) return isDetectionTestPath(testPath);
	const reason = noneReason(text);
	// A one-word reason ("none: oversight") is legitimate; the shape only
	// requires a reason to be present (#4288 R5).
	if (reason !== null) return wordCount(reason) >= 1;
	return false;
}

// #4439: a bug fix names the defect SHAPE and the tree-wide enforcer of that
// shape, not only a test for the instance. `Shape:` is a catalog number from
// docs/defect-shapes.md (whose index sits in AGENTS.md "Recurring defect
// shapes") or `new: <name>`; `Enforcer:` is a test path on the base, an issue to
// build one, or `none: judgment-only, <reason>`. With `Shape: #N`, a path
// enforcer must be one the catalog entry for #N names.
// The unresolved-catalog message names the remedy for the transition window: a
// branch cut before the catalog landed has no catalog at its merge base, and
// the honest fix is to merge master in, not to weaken a truthful `Enforcer:`.
export const DETECTION_SHAPE_CATALOG_UNRESOLVED_MESSAGE =
	'PR body "## Detection" says "Shape: #N" with a path "Enforcer:", but the defect-shape catalog could not be read from the base commit of the PR (git show <merge-base>:docs/defect-shapes.md), so the catalog entry cannot be checked. A branch cut before docs/defect-shapes.md landed has no catalog at its merge base: merge master into the branch, so the base commit holds the catalog. Otherwise give an issue ref (#NNN) or "none: judgment-only, <reason>" as the enforcer instead.';

export const detectionUnknownShapeMessage = (number) =>
	`PR body "## Detection" says "Shape: #${number}", but the defect-shape catalog (docs/defect-shapes.md) has no shape ${number}. Use a catalog number, or "Shape: new: <name>" for a shape the catalog lacks.`;

export const detectionEnforcerNotOnBaseMessage = (path) =>
	`PR body "## Detection" says "Enforcer: ${path}", but that file is not on the PR's base commit (git merge-base origin/master HEAD). A test this PR adds is the regression test, not the enforcer of the shape. Name a tree-wide test already on the base, an issue (#NNN) to build one, or "none: judgment-only, <reason>".`;

export const detectionEnforcerNotInCatalogMessage = (path, number) =>
	`PR body "## Detection" says "Shape: #${number}" and "Enforcer: ${path}", but docs/defect-shapes.md shape ${number} does not name that path. Name a test the catalog entry lists, or give an issue (#NNN) to add it, or "none: judgment-only, <reason>".`;

const stripEmphasis = (value) =>
	String(value ?? "")
		.replace(/[*_`]/g, "")
		.trim();

function detectionShape(value) {
	const text = stripEmphasis(value);
	const number = /^#(\d+)\b/.exec(text);
	if (number) return { number: Number(number[1]) };
	const created = /^new\s*:\s*(\S.*)$/i.exec(text);
	return created ? { name: created[1] } : null;
}

function detectionEnforcer(value) {
	const text = stripEmphasis(value);
	if (/^#\d+\b/.test(text)) return { issue: true };
	const none = /^none\s*:\s*(?:judgment|judgement)-only\s*,\s*(.+)$/i.exec(
		text,
	);
	if (none)
		return wordCount(none[1]) >= 3 ? { none: true, reason: none[1] } : null;
	const path = /^\S+/.exec(text)?.[0].replace(/[.,;]+$/, "");
	return path && isDetectionTestPath(path) ? { path } : null;
}

// A path is named when it stands as its own token in the entry: not a prefix
// of a longer file name and not the middle of a longer path.
function entryNamesPath(entry, path) {
	const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(?<![\\w./-])${escaped}(?![\\w/-])(?!\\.\\w)`).test(entry);
}

/**
 * `shapeCatalog` reads the AGENTS.md catalog: a `Map<number, entry text>`, or
 * `null` when AGENTS.md cannot be read. `existsOnBase` is the Gap reader.
 */
function lintShapeAndEnforcer(content, options) {
	const shape = detectionShape(detectionFieldValue(content, "shape"));
	const enforcer = detectionEnforcer(detectionFieldValue(content, "enforcer"));
	if (!shape || !enforcer) return [DETECTION_MESSAGE];
	// #4519: the free text of the record, on the bug-closing seam only.
	if (
		options.requireShape &&
		[shape.name, enforcer.reason].some(isPlaceholderAnswer)
	)
		return [DETECTION_UNKNOWN_MESSAGE];
	let catalog;
	if (
		shape.number !== undefined &&
		typeof options.shapeCatalog === "function"
	) {
		catalog = options.shapeCatalog();
		if (catalog && !catalog.has(shape.number))
			return [detectionUnknownShapeMessage(shape.number)];
	}
	if (!enforcer.path) return [];
	if (typeof options.existsOnBase === "function") {
		const onBase = options.existsOnBase(enforcer.path);
		if (onBase === null) return [DETECTION_EXISTS_BASE_UNRESOLVED_MESSAGE];
		if (!onBase) return [detectionEnforcerNotOnBaseMessage(enforcer.path)];
	}
	if (catalog === null) return [DETECTION_SHAPE_CATALOG_UNRESOLVED_MESSAGE];
	if (catalog && !entryNamesPath(catalog.get(shape.number), enforcer.path))
		return [detectionEnforcerNotInCatalogMessage(enforcer.path, shape.number)];
	return [];
}

/**
 * The `shapeCatalog` reader for `lintDetectionSection`: docs/defect-shapes.md
 * as the PR's base commit has it (the base `baseFileReader` reads the enforcer
 * path from), parsed once on first use. `null` when the base or that file
 * cannot be read; there is no fallback to AGENTS.md, whose index carries only
 * the screen lines. The base, never the checkout: a PR that edits entry N to
 * name its own enforcer must not approve itself (#4439).
 */
export function shapeCatalogReader(cwd = process.cwd(), git = gitExecFileSync) {
	let catalog;
	return () => {
		if (catalog !== undefined) return catalog;
		catalog = null;
		const base = resolvePrBase(cwd, git);
		try {
			catalog = parseDefectShapes(
				String(
					git(["show", `${base}:${SHAPE_CATALOG_PATH}`], {
						cwd,
						encoding: "utf8",
						maxBuffer: 16 * 1024 * 1024,
						stdio: ["ignore", "pipe", "ignore"],
					}),
				),
			);
		} catch {
			// null: a path enforcer under `Shape: #N` fails closed.
		}
		return catalog;
	};
}

/**
 * #4288: the `## Detection` contract. Returns [] when the section is absent
 * (the missing-section error stays owned by `lintPrBody`), otherwise one
 * message when any of the three lines is missing or invalid, and (#4439) the
 * `Shape:` / `Enforcer:` lines when `requireShape` is set or either is
 * present. `ignoreUnfilled`
 * (the local preflight, where the label does not require the section) also
 * returns [] for a section holding only the template's own hint. Parsing runs over
 * the fenced-block-free body, so a quoted example inside a code fence never
 * satisfies the requirement (issue #4288, "Red first").
 */
export function lintDetectionSection(body = "", options = {}) {
	const section = sectionContent(body, "detection");
	if (!section) return [];
	// An HTML comment is not an answer: lines quoted in one never count (#4439).
	const content = section.visible;
	// A non-bug PR may leave the template's optional hint in place; that is an
	// unanswered section, not a malformed answer.
	// The mandatory footer is the last line of the body, so it lands inside
	// this section when Detection is last; it is not the author's content.
	if (
		options.ignoreUnfilled &&
		!hasRealContent(
			// Blank the footer rather than drop it, so every line keeps its index
			// in the section slice `hasRealContent` reads structure by (#4717 F5).
			content
				.split("\n")
				.map((line) => (GENERATED_FOOTER.test(line.trim()) ? "" : line)),
			"detection",
			templatePlaceholderLines(),
			headingLines(body).name,
			section.start,
		)
	)
		return [];
	const caughtBy = detectionFieldValue(content, "caught by");
	const shouldBy = detectionFieldValue(content, "should have been caught by");
	const gap = detectionFieldValue(content, "gap");
	// #4519: only the bug-closing seam (`requireShape`) names "unknown"; a
	// non-bug section that says it stays on the generic refusal below.
	if (
		options.requireShape &&
		[caughtBy, shouldBy, noneReason(gap)].some(isPlaceholderAnswer)
	)
		return [DETECTION_UNKNOWN_MESSAGE];
	if (caughtBy === null || !isDetectionLayer(normalizeDetectionLayer(caughtBy)))
		return [DETECTION_MESSAGE];
	if (
		shouldBy === null ||
		!isDetectionShouldLayer(normalizeDetectionLayer(shouldBy))
	)
		return [DETECTION_MESSAGE];
	if (gap === null || !validDetectionGap(gap)) return [DETECTION_MESSAGE];
	const claimed = existsGapPath(gap);
	if (claimed !== null && typeof options.existsOnBase === "function") {
		const onBase = options.existsOnBase(claimed);
		if (onBase === null) return [DETECTION_EXISTS_BASE_UNRESOLVED_MESSAGE];
		if (!onBase) return [detectionExistsNotOnBaseMessage(claimed)];
	}
	if (
		options.requireShape ||
		detectionFieldValue(content, "shape") !== null ||
		detectionFieldValue(content, "enforcer") !== null
	)
		return lintShapeAndEnforcer(content, options);
	return [];
}

const CLASS_SWEEP_MESSAGE =
	'PR body "## Class sweep" must name the defect shape (Shape:, Defect shape:, ' +
	"Defect class:, or Class:), quote the search command that defines its " +
	"population (rg, grep, git grep, ugrep, ast-grep run, or sg run), and give " +
	'a per-member or fold/stay verdict, or say "none: <reason>" (three words ' +
	"minimum; refused when the diff changes runtime code). " +
	`See ${TEMPLATE_PATH}.`;

// #4273: the shape label, with optional bold or code emphasis. AGENTS.md
// numbers its defect shapes and PR prose cites them as `Defect shape 25` (no
// colon); the repository also writes `Defect class:` and `Class:` for the same
// concept, so the label is a synonym set rather than one literal (#4273 F2).
const CLASS_SWEEP_SHAPE_LABEL =
	/(?:\*\*|__|`)?\b(?:defect\s+shape|defect\s+class|shape|class)\b(?:\s*\d+)?(?:\*\*|__|`)*\s*:/i;
const CLASS_SWEEP_SHAPE_CITATION =
	/(?:\*\*|__|`)?\b(?:defect\s+shape|defect\s+class)\b\s*\d+\b/i;

// The accepted search commands, longest first so `ugrep` beats `grep` and
// `git grep` beats a bare `grep` (#4273 F2/D).
const CLASS_SWEEP_SEARCH_TOOL =
	"git\\s+grep|ast-grep\\s+run|sg\\s+run|ugrep|grep|rg";

// A search command counts when it is quoted in a code span or a fenced block,
// or when it is written as an invocation (a flag or a path-like operand).
function classSweepSearchCommand(text) {
	const source = String(text ?? "");
	const quoted = [
		...source.matchAll(/`+[^`]*`+/g),
		...source.matchAll(
			/^[ \t]*(?:```|~~~)[^\n]*\n([\s\S]*?)^[ \t]*(?:```|~~~)[ \t]*$/gm,
		),
	].map((match) => match[1] ?? match[0]);
	const search = new RegExp(
		`(?:^|\\W)(?:${CLASS_SWEEP_SEARCH_TOOL})(?:\\W|$)`,
		"i",
	);
	if (quoted.some((value) => search.test(value))) return true;
	const invocation = new RegExp(
		`(?:${CLASS_SWEEP_SEARCH_TOOL})\\s+(?:--?[a-z]|['"\`]|\\S*[./*])`,
		"i",
	);
	return source.split(/\r?\n/).some((line) => invocation.test(line));
}

// The per-member line prefixes the template sanctions: a bullet, a numbered
// item, or a markdown table row (#4273 F1).
const CLASS_SWEEP_MEMBER_LINE = /^\s*(?:[-*+]|\d+\.)\s+\S/;
const CLASS_SWEEP_TABLE_ROW = /^\s*\|.*\|\s*$/;

// A verdict is a fold/stay statement, or a per-member line whose outcome is
// observable (an arrow target or a coverage note). The bare word "admitted"
// is deliberately not a verdict: PR #4248 used it while enumerating changed
// files. `unaffected` is excluded because `TLA+ unaffected: <family>` is a
// different governance statement (#4273 F3).
const CLASS_SWEEP_DECISION =
	/\b(?:fold|folds|folded|folding|consolidat\w*|verdict|widen\w*)\b|\b(?:stays?|stayed|staying)\b/i;
const CLASS_SWEEP_OUTCOME =
	/(?:→|->|=>|\bcovered\b|\buncovered\b|\bnot a member\b|\bnot a runtime\b|\bno member\b|\bexcluded\b|\bout of scope\b|\bin scope\b|\bclean\b|\bsame target\b|\bnot found\b)/i;

// #4711: `## Fold check` and `## Class sweep` share ONE verdict parser and its
// `none:` escape, so one body answers both the repository lint and the
// maintainer's local script. Their admitted vocabularies differ, so each branch
// keeps its own tokens. A fold-check decision line names its candidate (`#N`)
// FIRST, then one of the three decisions, then a reason: the local gate
// (`pr-create.sh`'s `fold_gate`) reads the same three facts, in the same order,
// with two words of reason.
//
// It fails closed (#4717 F2/F3/F4/F5/N1): every line in the section that names a
// candidate must be such a line, so a malformed sibling is not excused by a
// well-formed neighbour; the decision is one of the three listed spellings, so
// `not-folded` and `re-sequenced` refuse; and a `folded` candidate is one this
// body closes. The candidate token has one spelling, read as a match and as a
// count.
const FOLD_CHECK_CANDIDATE_SOURCE = "(?:^|[^0-9A-Za-z&])#(\\d+)(?![0-9])";
const FOLD_CHECK_CANDIDATE = new RegExp(FOLD_CHECK_CANDIDATE_SOURCE);
const FOLD_CHECK_CANDIDATE_ALL = new RegExp(FOLD_CHECK_CANDIDATE_SOURCE, "g");
// The three listed spellings, as whole tokens: a hyphenated `not-folded` or
// `re-sequenced` is not one of them, and its `folded`/`sequenced` tail is not a
// decision either.
const FOLD_CHECK_DECISION =
	/(?<![-\w])(?:not\s+folded|folded|sequenced)(?![-\w])/i;
const FOLD_CHECK_FOLDED = /^folded$/i;
const FOLD_CHECK_REASON_WORDS = 2;
// The `none: <reason>` escape both sections accept.
const NONE_LINE = /^\s*none\s*:\s*(.+?)\s*$/im;

/**
 * The issues this body closes, read with the lexer's code structure (#4717
 * N1): a `Closes #N` in a backtick or tilde fence, indented code or a code
 * span closes nothing. `parseCloseKeywords` keeps its own dependency-free
 * reading for the close-keyword jobs, which run with no install.
 */
function closedIssues(body) {
	return parseCloseKeywords(
		blankMarkdownRegions(body, { code: "blocks", codeSpans: true }),
	).issues;
}

// #4968: the detection lesson is owed by any PR that references a bug issue,
// not only one that closes it (the 2026-10-29 audit: 24 bug-linked PRs merged
// with `Refs #N` and no `## Detection`). A reference is a keyword and the
// issue token(s) it names: directly after it (`refs #N`, `Closes: #A, #B`), on
// the rest of a line the keyword opens (`Refs the audit in #N`), or on the
// next line when the keyword or a trailing comma ends the line (a wrapped
// `Refs\n#N`). The reader labels one token spelling, `#N` and `GH-N`; a
// cross-repository token or an issue or pull request URL is returned as
// unrecognised for the gate to refuse, never skipped. Another URL (a comment
// permalink) is prose.
const REFERENCE_KEYWORD = String.raw`(?:close[sd]?|fix(?:e[sd])?|resolv(?:e[sd]?)|refs?|references?)`;
const REFERENCE_TOKEN = String.raw`(?:https?://[^\s)\]>]+|[\w.-]+/[\w.-]+#\d+|(?:#|GH-)\d+(?!\w))`;
const REFERENCE_LIST = String.raw`${REFERENCE_TOKEN}(?:(?:[ \t]*(?:,|&|\band\b)[ \t]*|[ \t]+)${REFERENCE_TOKEN})*`;
const REFERENCE_GAP = String.raw`[ \t:\-\u2013\u2014(\[*_]*`;
const REFERENCE_READABLE = /^(?:#|GH-)(\d+)$/i;
const REFERENCE_ISSUE_URL = /^https?:\/\/.*\/(?:issues|pull)\/\d+\/?$/i;
const REFERENCE_ADJACENT = new RegExp(
	String.raw`\b${REFERENCE_KEYWORD}\b${REFERENCE_GAP}(${REFERENCE_LIST})`,
	"gi",
);
const REFERENCE_LEADING = new RegExp(
	String.raw`^[ \t>]*(?:[-*+]|\d+[.)])?[ \t]*(?:\*\*|__)?${REFERENCE_KEYWORD}\b(.*)$`,
	"i",
);
// A line the keyword ends: its tokens are on the next line.
const REFERENCE_OPEN = new RegExp(
	String.raw`\b${REFERENCE_KEYWORD}\b${REFERENCE_GAP}$`,
	"i",
);
const REFERENCE_CONTINUATION = new RegExp(
	String.raw`^[ \t>*_(\[-]*(${REFERENCE_LIST})`,
);
const REFERENCE_TOKENS = new RegExp(REFERENCE_TOKEN, "gi");
const REFERENCE_WHOLE_TOKEN = new RegExp(`^${REFERENCE_TOKEN}$`, "i");
const LINK_DEFINITION =
	/^ {0,3}\[([^\]\n]{1,200})\]:[ \t]*<?([^\s>]{1,500})>?/gm;
const INLINE_LINK =
	/\[([^\]\n]{0,200})\]\(<?([^)\s>]{0,500})>?(?:[ \t][^)\n]{0,200})?\)/g;
const SHORTCUT_LINK = /\[([^\]\n]{1,200})\](?![[(:])/g;
const REFERENCE_LINK = /\[([^\]\n]{0,200})\]\[([^\]\n]{0,200})\]/g;

// The link patterns are length-bounded: an unbounded scan from every `[` of a
// bracket-only line is quadratic.
// A link names its target by its text when that text is itself an issue token
// (`[#12](url)`), and by its destination otherwise (`[the bug](url)`), whether
// the destination is inline or reached through a definition (`[bug][1]`).
function linkTarget(text, destination) {
	const label = text.trim();
	return REFERENCE_WHOLE_TOKEN.test(label) ? label : (destination ?? "");
}

/**
 * The issues a body references and the tokens it cannot read, from the text
 * outside code. `issues` is in order of first appearance.
 */
export function referencedIssues(body = "") {
	const issues = [];
	const unrecognised = [];
	const note = (token) => {
		const readable = REFERENCE_READABLE.exec(token);
		if (readable) {
			if (!issues.includes(Number(readable[1])))
				issues.push(Number(readable[1]));
			return;
		}
		const shown = token.replace(/[.,;:]+$/, "");
		if (/^https?:/i.test(shown) && !REFERENCE_ISSUE_URL.test(shown)) return;
		if (!unrecognised.includes(shown)) unrecognised.push(shown);
	};
	// Fenced and indented code is quoted material; an inline code span is not
	// (fail closed): `Refs` before a code-spanned number still names the issue.
	const text = blankMarkdownRegions(String(body ?? ""), { code: "blocks" });
	const definitions = new Map(
		[...text.matchAll(LINK_DEFINITION)].map((m) => [m[1].toLowerCase(), m[2]]),
	);
	const lines = text.split(/\r?\n/).map((line) =>
		line
			.replace(INLINE_LINK, (_, label, destination) =>
				linkTarget(label, destination),
			)
			.replace(REFERENCE_LINK, (match, label, key) => {
				const destination = definitions.get((key || label).toLowerCase());
				return destination === undefined
					? match
					: linkTarget(label, destination);
			})
			.replace(SHORTCUT_LINK, (match, label) => {
				const destination = definitions.get(label.toLowerCase());
				return destination === undefined
					? match
					: linkTarget(label, destination);
			}),
	);
	let continues = false;
	for (const line of lines) {
		const spans = [...line.matchAll(REFERENCE_ADJACENT)].map((m) => m[1]);
		const leading = REFERENCE_LEADING.exec(line);
		if (leading) spans.push(leading[1]);
		if (continues) {
			const next = REFERENCE_CONTINUATION.exec(line);
			if (next) spans.push(next[1]);
		}
		for (const span of spans)
			for (const [token] of span.matchAll(REFERENCE_TOKENS)) note(token);
		continues =
			REFERENCE_OPEN.test(line) ||
			(spans.length > 0 && /(?:[,&]|\band)[ \t]*$/i.test(line));
	}
	return { issues, unrecognised };
}

// #4968: the title channel. The template makes the title carry the issue
// (`(refs #NNN)`), a short regular field, so every `#N` in it is a reference
// whatever words the body uses (PR #4924: title `(refs #4532)`, body `Part (a)
// of #4532`). A `#N` glued to a word (`owner/repo#N`) is another repository's.
function titleIssues(title) {
	return [...String(title ?? "").matchAll(/(?<!\w)#(\d+)(?!\w)/g)].map(
		(match) => Number(match[1]),
	);
}

// What the reference rule reads: the author's text (a bot block quoting a
// commit title is not the author's reference) and every `#N` of the title,
// minus the issues the whole body closes, which keep their own `bugClosing`
// route.
function referencedOnly(fullBody, title = "") {
	const closed = closedIssues(fullBody);
	const { issues, unrecognised } = referencedIssues(authorText(fullBody));
	for (const number of titleIssues(title))
		if (!issues.includes(number)) issues.push(number);
	return {
		issues: issues.filter((number) => !closed.includes(number)),
		unrecognised,
	};
}

function sectionVerdict(section, text, { closes = [] } = {}) {
	const source = String(text ?? "");
	if (section === "fold check") {
		const candidates = source
			.split(/\r?\n/)
			.filter((line) => FOLD_CHECK_CANDIDATE.test(line));
		// `none:` says the search listed no candidate, so a line naming one
		// contradicts it whatever that line says (#4717 F4).
		// The contradiction is judged before the reason's length, so a short
		// `none: no` beside a candidate refuses too (#4717 N3).
		const none = NONE_LINE.exec(source);
		if (none) return candidates.length === 0 && wordCount(none[1]) >= 3;
		if (candidates.length === 0) return false;
		return candidates.every((line) => {
			const decision = FOLD_CHECK_DECISION.exec(line);
			if (!decision) return false;
			// The candidate comes first, and it is the only one named before the
			// decision, so the reason and the close rule read one candidate
			// (#4717 F3).
			const named = [
				...line.slice(0, decision.index).matchAll(FOLD_CHECK_CANDIDATE_ALL),
			];
			if (named.length !== 1) return false;
			const reason = line
				.slice(decision.index + decision[0].length)
				.replace(FOLD_CHECK_CANDIDATE_ALL, " ");
			if (
				(reason.match(/[A-Za-z0-9]+/g) ?? []).length < FOLD_CHECK_REASON_WORDS
			)
				return false;
			// A `folded` candidate is one this body closes: the record claims the
			// issue lands here, and the post-merge verifier reads
			// `parseCloseKeywords` (#4717 F5).
			return (
				!FOLD_CHECK_FOLDED.test(decision[0].trim()) ||
				closes.includes(Number(named[0][1]))
			);
		});
	}
	if (CLASS_SWEEP_DECISION.test(source)) return true;
	return source.split(/\r?\n/).some((line) => {
		const perMember =
			CLASS_SWEEP_MEMBER_LINE.test(line) || CLASS_SWEEP_TABLE_ROW.test(line);
		return perMember && CLASS_SWEEP_OUTCOME.test(line);
	});
}

function classSweepShape(text) {
	const source = String(text ?? "");
	return (
		CLASS_SWEEP_SHAPE_LABEL.test(source) ||
		CLASS_SWEEP_SHAPE_CITATION.test(source)
	);
}

// package.json's `files` is the shipped surface (AGENTS.md, "Build, packaging,
// and release"); only its `scripts/**/*.mjs` entries are runtime for the
// `none:` escape. Governance scripts such as this one are not shipped, so a
// diff that edits only them may still say `none:` (#4273 F3). Derived from
// package.json so the list cannot drift, cached because it is per-process
// constant.
let shippedRuntimeScriptsCache;
function shippedRuntimeScripts() {
	if (shippedRuntimeScriptsCache) return shippedRuntimeScriptsCache;
	const paths = new Set();
	try {
		const pkg = JSON.parse(
			readFileSync(resolve(REPO_ROOT, "package.json"), "utf8"),
		);
		for (const entry of pkg.files ?? [])
			if (/^scripts\/.*\.mjs$/.test(entry)) paths.add(entry);
	} catch {
		// An unreadable package.json cannot widen the runtime scope; the
		// `none:` reason check still applies.
	}
	shippedRuntimeScriptsCache = paths;
	return paths;
}

// #4273 F3: a `none:` escape is refused when the diff changes runtime code,
// because a runtime diff with no named shape is almost always an unfound
// population. Runtime scope is `clients/**`, `index.ts`, and the `scripts/`
// modules package.json ships.
function classSweepRuntimeTouched(diff) {
	const shipped = shippedRuntimeScripts();
	return parseChangedFiles(diff).some(
		(file) =>
			file === "index.ts" || file.startsWith("clients/") || shipped.has(file),
	);
}

function wordCount(text) {
	return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * #4273: a `## Class sweep` must take one of two forms. It names the defect
 * shape, quotes the search that defines its population, and gives a verdict
 * per member or a fold/stay verdict; or it says `none: <reason>` for a diff
 * with no shape. A section that only enumerates the files this PR changed is
 * a change list, not a tree-wide sweep, and is refused (PR #4248: its shape
 * population went unfound until #4268). The missing-section and empty-section
 * cases stay owned by `lintPrBody`, so this returns nothing for them.
 *
 * `none:` is bounded (#4273 F3): it needs a reason of at least three words,
 * and it is refused when the diff changes runtime code. Without a diff (a
 * local caller with no upstream ref) only the reason check applies.
 */
export function lintClassSweep(body = "", { diff } = {}) {
	const section = sectionContent(body, "class sweep");
	if (!section) return [];
	const content = section.text.trim();
	if (!content) return [];
	const none = NONE_LINE.exec(content);
	if (none) {
		if (wordCount(none[1]) < 3) return [CLASS_SWEEP_MESSAGE];
		if (diff && classSweepRuntimeTouched(diff)) return [CLASS_SWEEP_MESSAGE];
		return [];
	}
	if (
		classSweepShape(content) &&
		classSweepSearchCommand(content) &&
		sectionVerdict("class sweep", content)
	)
		return [];
	return [CLASS_SWEEP_MESSAGE];
}

const FOLD_CHECK_MESSAGE =
	'PR body "## Fold check" must decide each candidate: `#N` first, then one ' +
	"of folded / not folded / sequenced, then a reason of at least two words " +
	"(issue numbers do not count), and a `folded` candidate's `Closes #N` in the " +
	'body; or say "none: <reason>" (three words minimum) when the search found ' +
	"no candidate. Every line that names a candidate must be a decision line. " +
	`See ${TEMPLATE_PATH}.`;

/**
 * #4711: AGENTS.md's fold check, as a body section. Every candidate issue is
 * decided `folded`, `not folded` or `sequenced` with its reason, or the search
 * found none and the section says `none: <reason>`. The candidate list itself
 * is the maintainer's local script's to compute (it reads the issue tracker);
 * this lint owns the form, so a raw `gh pr create` cannot skip the record. The
 * missing and empty section cases stay owned by `lintPrBody`.
 */
export function lintFoldCheck(body = "", fullBody = body) {
	const section = sectionContent(body, "fold check");
	if (!section) return [];
	// An empty section is `lintPrBody`'s to report. Content that survives only
	// inside a fence or a raw-HTML block is not a decision either, so the
	// blanked copy is judged and an empty one refuses here (#4711).
	if (!section.raw.trim()) return [];
	const content = section.visible.trim();
	// A `folded` candidate must be closed by this body (#4717 F5), so the
	// verdict is judged against the body's own close keywords.
	const closes = closedIssues(fullBody);
	return sectionVerdict("fold check", content, { closes })
		? []
		: [FOLD_CHECK_MESSAGE];
}

// A failing-test line names its own title: a `FAIL`/`❯` line carries a runner
// tag, a file and zero or more suite segments before the title, and a glyph
// line carries the title alone. Vitest appends a duration, which is not part
// of the title. #4585 row 1 matches this line's own title, never a substring of
// another test's evidence (#4605 F3).
const FAILING_ENTRY = /(?:^|\s)(FAIL|❯|[×✗✕])\s+/g;
const RUNNER_TAG = /^\|[^|]*\|\s*/;
const VITEST_DURATION = /\s+\d+(?:\.\d+)?\s*m?s\s*$/;
const UNKNOWN_FILE = /^(?:\.{3}|…)$/;

function failingEntries(quote) {
	const entries = [];
	for (const row of String(quote ?? "").split("\n")) {
		const markers = [...row.matchAll(FAILING_ENTRY)];
		for (const [index, marker] of markers.entries()) {
			const start = (marker.index ?? 0) + marker[0].length;
			const end = markers[index + 1]?.index ?? row.length;
			const body = row.slice(start, end).replace(/[;\s]+$/, "");
			entries.push(failingEntry(marker[1], body));
		}
	}
	return entries;
}

function failingEntry(marker, body) {
	const title = String(body).replace(VITEST_DURATION, "").trim();
	if (marker !== "FAIL" && marker !== "❯")
		return { file: null, titles: [title] };
	const parts = title.replace(RUNNER_TAG, "").split(/\s+>\s+/);
	if (parts.length < 2) return { file: null, titles: [title] };
	// The line carries a file, zero or more suite segments and its own title,
	// and the title itself may contain the ` > ` separator (`blocking > 0`).
	// Offer every suffix of the chain, longest first, so a suite chain still
	// resolves and a title that carries the separator matches at its full
	// length against the declaration's exact title (#4605 F7).
	const segments = parts.slice(1);
	const titles = segments.map((_, start) => segments.slice(start).join(" > "));
	const file = parts[0].trim().replace(/^\.\//, "");
	return { file: file && !UNKNOWN_FILE.test(file) ? file : null, titles };
}

function samePath(left, right) {
	return left.replace(/^\.\//, "") === right.replace(/^\.\//, "");
}

// Row 1 is file-level (#4585 as amended by issuecomment-6252599595): a changed
// test file owes one red-first transcript that names it and shows a failure from
// it, or a Controls row naming it with a reason. Titles, table rows and suite
// chains are not read, so the per-title matcher does not exist.
function transcriptNamesFile(fence, file) {
	if (!fence.failure) return false;
	if (!fence.lines.some((line) => namesFile(line, file))) return false;
	return failingEntries(fence.lines.join("\n")).some(
		(entry) => !entry.file || samePath(entry.file, file),
	);
}

// A Controls row names the file it covers and gives a reason: a `Control: ...`
// line, or a row of a Controls table. A row that names no file, or gives no
// reason, proves nothing.
function controlRows(visibleRows, headingByLine) {
	let inSection = false;
	let controlTable = false;
	const rows = [];
	for (const [index, row] of visibleRows.entries()) {
		const name = headingByLine.get(index);
		if (name !== undefined) {
			inSection = /\bcontrols?\b/i.test(name);
			controlTable = false;
			continue;
		}
		if (/^\s*(?:\*\*)?Controls?\b/i.test(row)) inSection = true;
		if (!row.trim()) {
			controlTable = false;
			continue;
		}
		if (/^\s*\|/.test(row)) {
			// A table whose own header names the column is a Controls table,
			// wherever it sits.
			if (/\bcontrols?\b/i.test(row)) controlTable = true;
			if (inSection || controlTable) rows.push(row);
			continue;
		}
		controlTable = false;
		if (inSection || /\bcontrols?\b/i.test(row)) rows.push(row);
	}
	return rows;
}

function controlsNameFile(rows, file) {
	return rows.some((row) => {
		if (!namesFile(row, file)) return false;
		if (/^\s*\|/.test(row)) {
			const cells = splitMarkdownRow(row).filter(Boolean);
			return cells.length >= 2 && wordCount(cells.join(" ")) >= 2;
		}
		return /(?:—|:|because)\s+[A-Za-z0-9].+/.test(row);
	});
}

// A path token, or a bare filename for a root-level changed file (`index.ts`).
// A bare name never stands in for a nested path: `launch.ts` does not name
// `clients/lsp/launch.ts` (#4605 F4).
const PATH_TOKEN = /[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*/g;
const URL_SPAN = /[a-z][a-z0-9+.-]*:\/\/\S+/gi;

function pathTokens(text) {
	return [...String(text ?? "").matchAll(PATH_TOKEN)].map((match) => match[0]);
}

function namesFile(text, file) {
	const candidates = new Set([file, file.replace(/\.[cm]?ts$/, ".js")]);
	return pathTokens(text).some((token) =>
		candidates.has(token.replace(/^\.\//, "")),
	);
}

// A row that names a file path is evidence about that path, whichever path it
// is, so it can never stand in for a generic Windows read (#4605 F8). A bare
// basename that ends in a source extension names a file too, so it is evidence
// about that path rather than a generic read (#4605 V5). A URL is a link to the
// run, not a path in this repository.
const SOURCE_FILE_TOKEN =
	/^[A-Za-z0-9_][A-Za-z0-9_.-]*\.(?:[cm]?[jt]sx?|mjs|cjs|json|md|ya?ml|toml|py|go|rs|sh)$/i;

function namesAnyPath(text) {
	return pathTokens(String(text ?? "").replace(URL_SPAN, " ")).some(
		(token) => token.includes("/") || SOURCE_FILE_TOKEN.test(token),
	);
}

function namedChangedFiles(text, changedPaths) {
	const found = new Set();
	for (const token of pathTokens(text)) {
		const path = token.replace(/^\.\//, "");
		if (changedPaths.has(path)) found.add(path);
	}
	return found;
}

// A `mutation:` record proves only when it states the run's own result: an
// explicit RED/FAIL line. Round 2 listed the words that mean "did not run", so
// every unlisted spelling (`unable to run`, `n/a`, `did not execute`) passed
// (#4605 V4). The default is inverted: a `mutation:` continuation that carries
// no result word refuses the fence, and the fence must hold a result line.
// The three spellings are listed whole: an optional `(?:ED|…)?` suffix splits
// the tail off as a bare three-letter fragment, which the advisory
// spellchecker reads as a misspelling.
const MUTATION_RESULT =
	/\bRED\b|\b(?:FAIL|FAILED|FAILURE)\b|\b[1-9]\d*\s+failed\b|[×✗✕]\s+\S/;

// The tool prints `mutation: <file> (<find> -> <replace>)`; a hand-written
// header may name the file alone. Any other tail is a claim about the run, so
// it must state a result. That refuses `not run`, `unable to run`, `n/a` and
// every spelling a bad-word list would miss (#4605 V4).
function mutationHeaderProves(header, file) {
	const remaining = String(header)
		.replace(/^(?:\$\s+)?mutation:/i, "")
		.replace(URL_SPAN, " ")
		.split(/\s+/)
		.filter(Boolean)
		.filter((token) => !namesFile(token, file))
		.join(" ");
	return (
		remaining === "" ||
		/^\(.*->.*\)$/.test(remaining) ||
		MUTATION_RESULT.test(remaining)
	);
}

// A table row in the mutation section may name its file in the row, or sit
// under a one-file opener. The label on the last cell lets a row point at a
// failing fence below it, the shape `scripts/mutate.mjs` writes.
function mutationTableRows(visibleRows, headingByLine) {
	let mutationSection = false;
	let mutationScope = "";
	const rows = [];
	for (const [index, row] of visibleRows.entries()) {
		const name = headingByLine.get(index);
		if (name !== undefined) {
			mutationSection = /\bmutations?\b/i.test(name);
			mutationScope = "";
			continue;
		}
		if (/^\s*(?:\*\*)?(?:Hand[- ]mutation|Mutations?)\b/i.test(row)) {
			mutationSection = true;
			mutationScope = row;
			continue;
		}
		if (!mutationSection || !row.trim()) continue;
		if (/^\s*\|/.test(row)) {
			if (/^\s*\|[\s:|-]+\|?\s*$/.test(row)) continue;
			const cells = splitMarkdownRow(row);
			const label = (cells.at(-1) ?? "").replace(/`/g, "").trim();
			rows.push({
				text: row,
				scope: mutationScope,
				label: /^[A-Za-z]*\d+$/.test(label) ? label : null,
			});
			continue;
		}
		mutationScope = row;
	}
	return rows;
}

/** Check the structural PR-body contract, including answered sections. */
// #4585: body evidence answers the changed code, not a generic checklist.
// Row 3 (model fidelity) remains reviewer judgement per issuecomment 6241755363.
function lintDiffCompliance(body, options) {
	const errors = [];
	// A literal `<!--` inside a fence or a code span is quoted text, not a
	// comment opener (#4585 row 1, #4717 V1): the lexer reads it as code, so
	// neither blanker hides what follows it. `visibleRows` hides fenced
	// examples (a quoted heading, control or table is an example, not a
	// claim). `evidenceRows` keeps fence content, because an honest body
	// quotes the Windows advisory row in a fence (#4605 F5).
	const source = String(body);
	const rawRows = blankHtmlComments(source).split(/\r?\n/);
	const visibleRows = blankMarkdown(source).split(/\r?\n/);
	// A row belongs to a section the lexer named (#4717 F1): the heading lines
	// come from the same reader `sectionLines` uses, so a heading family the
	// section list accepts cannot leave a row in the previous section.
	const headingByLine = headingLines(source).name;
	const evidenceRows = rawRows;
	const transcriptFences = [];
	for (const block of markdownBlocks(body, { tilde: true })) {
		if (!block.fence || !rawRows[block.start]?.trim()) continue;
		const opener = /^\s*(`{3,}|~{3,})(.*)$/.exec(block.lines[0]);
		const closer = /^\s*(`{3,}|~{3,})\s*$/.exec(block.lines.at(-1));
		if (!opener || !closer || block.lines.length < 2) continue;
		if (closer[1][0] !== opener[1][0] || closer[1].length < opener[1].length)
			continue;
		const lines = block.lines.slice(1, -1).filter((line) => line.trim());
		if (!lines.length) continue;
		transcriptFences.push({
			start: block.start,
			header: lines[0].trim(),
			lines,
			failure: isFailureQuote({ info: opener[2].trim(), text: lines }),
		});
	}
	// Only a failing fence can vouch for a run, and a fence inside a real
	// comment was removed above.
	const transcripts = transcriptFences.filter((fence) => fence.failure);
	const mutationRows = mutationTableRows(visibleRows, headingByLine);
	const windowsReads = [];
	for (const row of evidenceRows) {
		if (!/\bWindows\b/i.test(row)) continue;
		const reason =
			/\b(?:cannot differ|platform.independent|platform.neutral)\b.*\bbecause\b\s+\S.+/i.test(
				row,
			);
		const run =
			/\b(?:advisory|lane|job)\b/i.test(row) &&
			/\b(?:passed|failed|success|failure)\b/i.test(row) &&
			/\b\d{5,}\b/.test(row) &&
			!/\b(?:cancelled|canceled|skipped|pending|queued|not run|did not run)\b/i.test(
				row,
			);
		if (reason || run) windowsReads.push(row);
	}
	const changedFiles = parseRuntimeHunks(options.diff);
	const changedPaths = new Set();
	for (const file of changedFiles) {
		if (file.pre) changedPaths.add(file.pre);
		if (file.post) changedPaths.add(file.post);
	}
	// A changed `.ts` file also answers to the `.js` specifier a body cites.
	const namedPaths = new Set(changedPaths);
	for (const path of changedPaths)
		namedPaths.add(path.replace(/\.[cm]?ts$/, ".js"));
	const rowFour = [];
	const unclassified = [];
	for (const file of changedFiles) {
		// A whole-file deletion has no post-image: no added declaration, no
		// post-image call to classify. Reading it as an unreadable post-image reded
		// every deleted `clients/` or `scripts/` file with a notice no body
		// evidence could clear (#4605 V2). A hunk that only deletes from a file
		// that still exists is not this state.
		if (file.deletedFile) continue;
		const windowsPath = [file.pre, file.post].some((name) =>
			/^clients\/(?:package-manager\.|lsp\/launch|path-utils\.|safe-spawn\.)/.test(
				name,
			),
		);
		const tests = /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file.post);
		const production =
			/\.[cm]?[jt]sx?$/.test(file.post) &&
			!/\.d\.[cm]?ts$/.test(file.post) &&
			(isRuntimeObservabilityPath(file.post) ||
				file.post.startsWith("scripts/"));
		// A `trySpawn` caller owes row 4 for any hunk it changes, a deletion
		// included, so its post-image is read even when the diff adds nothing to
		// it (#4605 F6). A seam file named by path needs no post-image for row 4.
		const seamCaller = production && !windowsPath;
		if (windowsPath)
			rowFour.push({
				file: file.post,
				read: windowsReads.some((row) => namesFile(row, file.post)),
			});
		if (!tests && !production) continue;
		if (!file.added.size && !seamCaller) continue;
		const source = headFileSource(file.post, {
			...options,
			postBlob: file.postBlob,
		});
		const rows = typeof source === "string" ? sourceLines(source) : [];
		// The post-image identity is what the alias closure and the byte-mapped
		// line numbers need. Without it the added lines still decide row 2 and
		// row 4, and row 1 reads the added lines alone; a declaration that opens
		// there but whose title sits on an unchanged line cannot be classified,
		// so it is refused rather than passed.
		// Every added line must sit at its own line number in the post-image; an
		// unreadable source has no rows, so it fails here without a second guard.
		const exact = [...file.added].every(
			([line, text]) => rows[line - 1] === text,
		);
		// A deletion-only file has no added line to compare, so `exact` alone
		// cannot say the post-image was read; the source itself must be a string.
		const readable = typeof source === "string" && exact;
		const { text } = readable
			? blankCommentsAndStrings(source)
			: { text: [...file.added.values()].join("\n") };
		const addedCode = readable
			? (() => {
					const codeRows = text.split("\n");
					return [...file.added.keys()]
						.map((line) => codeRows[line - 1] ?? "")
						.join("\n");
				})()
			: text;
		const unclassifiable =
			tests && /(?<![\w$.])(?:it|test)\b[^\n;]*?\(/.test(addedCode);
		if (!readable && (unclassifiable || production))
			unclassified.push(file.post);
		if (tests && readable) {
			// Per-occurrence accounting (#4605 V3): a removal credits one addition
			// of the same trimmed line, so a re-indent or a move is not new content
			// while a second identical copy is (#4605 F4, V3).
			const removedCounts = new Map();
			for (const line of file.removed) {
				const trimmed = line.trim();
				if (trimmed)
					removedCounts.set(trimmed, (removedCounts.get(trimmed) ?? 0) + 1);
			}
			const newAddedLine = new Map();
			for (const [line, value] of file.added) {
				const trimmed = value.trim();
				const left = trimmed ? (removedCounts.get(trimmed) ?? 0) : 0;
				if (!trimmed) newAddedLine.set(line, false);
				else if (left > 0) {
					removedCounts.set(trimmed, left - 1);
					newAddedLine.set(line, false);
				} else newAddedLine.set(line, true);
			}
			// Row 1 is file-level (#4585 as amended by issuecomment-6252599595):
			// a changed test file owes one fenced red-first transcript naming it
			// that shows a failure from it, or a Controls row naming it with a
			// reason. A declaration opener on a genuinely new line is what makes
			// the file owe; its title, table and chain are not read. The callees
			// are read from the source: the `it`/`test` names, an alias, and a
			// `vitest` namespace import.
			const names = new Set(["it", "test"]);
			for (const match of text.matchAll(/\b(?:it|test)\s+as\s+(\w+)/g))
				names.add(match[1]);
			for (const match of source.matchAll(
				/import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+["']vitest["']/g,
			))
				names.add(`${match[1]}\\s*\\.\\s*(?:it|test)`);
			let changed = true;
			while (changed) {
				changed = false;
				for (const match of text.matchAll(
					/\b(?:const|let|var)\s+(\w+)\s*=\s*(\w+)\b/g,
				)) {
					if (names.has(match[2]) && !names.has(match[1])) {
						names.add(match[1]);
						changed = true;
					}
				}
			}
			const declarationOpener = new RegExp(
				`(?<![\\w$.])(?:${[...names].join("|")})\\b[^\\n;]*?\\(`,
			);
			const codeRows = text.split("\n");
			const newCode = [...newAddedLine.entries()]
				.filter(
					([line, isNew]) => isNew && line >= 1 && line <= codeRows.length,
				)
				.map(([line]) => codeRows[line - 1] ?? "")
				.join("\n");
			if (declarationOpener.test(newCode)) {
				const proved = transcripts.some((fence) =>
					transcriptNamesFile(fence, file.post),
				);
				const control = controlsNameFile(
					controlRows(visibleRows, headingByLine),
					file.post,
				);
				if (!proved && !control)
					errors.push(
						`PR body compliance row 1: ${file.post} adds or edits test declarations; the body needs one fenced red-first transcript naming that file with a failure from it, or a Controls row naming it with a reason.`,
					);
			}
		}
		if (
			production &&
			/\b(?:if|else|catch|switch|throw)\b|\?(?![.?:])|&&|\|\||\.(?:filter|slice)\s*\(|\bMath\.(?:min|max)\s*\(/.test(
				addedCode,
			)
		) {
			// #4575: a mutation row, or the tool's own `mutation:` transcript,
			// names the file it proves. One file, one red (#4605 F1): a table row
			// binds to the file it names (or to the one-file opener above it),
			// and its red must be in that row or in a labelled failing fence. A
			// `mutation:` fence proves only when it states the mutation's own
			// result: an explicit RED/FAIL line, with every continuation
			// `mutation:` line stating one too (#4605 V4).
			const transcriptProves = transcriptFences.some((fence) => {
				if (!fence.failure) return false;
				if (!/^(?:\$\s+)?mutation:/i.test(fence.header)) return false;
				if (!namesFile(fence.header, file.post)) return false;
				if (!mutationHeaderProves(fence.header, file.post)) return false;
				if (!fence.lines.some((line) => MUTATION_RESULT.test(line)))
					return false;
				return fence.lines
					.filter((line) => /^(?:\$\s+)?mutation:/i.test(line))
					.slice(1)
					.every((line) => MUTATION_RESULT.test(line));
			});
			const rowProves = mutationRows.some((row) => {
				if (!namesFile(row.text, file.post)) {
					const scoped = namedChangedFiles(row.scope, changedPaths);
					if (scoped.size !== 1 || !scoped.has(file.post)) return false;
				}
				if (BACKTICKED_RED.test(row.text)) return true;
				if (!row.label) return false;
				return transcriptFences.some(
					(fence) =>
						fence.failure &&
						namesFile(fence.header, file.post) &&
						new RegExp(`\\b${row.label}\\b`).test(fence.header),
				);
			});
			if (!rowProves && !transcriptProves)
				errors.push(
					`PR body compliance row 2: ${file.post} needs a Mutation section naming that file and a quoted failing mutation transcript.`,
				);
		}
		if (seamCaller && /\btrySpawn\b/.test(text))
			rowFour.push({
				file: file.post,
				read: windowsReads.some((row) => namesFile(row, file.post)),
			});
	}
	// #4605 F4: row 4 is per file. A Windows line that names the file covers it;
	// a generic line covers a diff with exactly one seam file, where it cannot
	// be ambiguous. A row that names any file path is evidence about that path,
	// not a generic read (#4605 F8). A cancelled, skipped or pending run is not
	// a read.
	const genericRead = windowsReads.some(
		(row) =>
			!namesAnyPath(row) && namedChangedFiles(row, namedPaths).size === 0,
	);
	for (const seam of rowFour) {
		if (seam.read || (rowFour.length === 1 && genericRead)) continue;
		errors.push(
			`PR body compliance row 4: ${seam.file} needs a Windows advisory-lane result with run id, or a reason it cannot differ (Windows: cannot differ because ...).`,
		);
	}
	// A post-image the diff names but cannot be read or matched classifies no
	// row, so the body owes the rows it may still hold. One bounded line names
	// them: an unbounded per-file notice grows with the diff, and a silent skip
	// would read as a clean body.
	if (unclassified.length)
		errors.push(
			`PR body compliance: cannot classify rows 1, 2 and 4 for ${unclassified.length} changed file(s) whose post-image is missing, unreadable, or does not match the diff: ${unclassified.slice(0, UNCLASSIFIED_REPORT_LIMIT).join(", ")}${unclassified.length > UNCLASSIFIED_REPORT_LIMIT ? ` (+${unclassified.length - UNCLASSIFIED_REPORT_LIMIT} more)` : ""}.`,
		);
	return errors;
}

// ASCII whitespace only: a no-break space renders as space the reader scrolls past.
const collapsedLength = (text) =>
	String(text ?? "").replace(/[ \t\r\n]+/g, " ").length;
// A link destination is not rendered text, so only what exceeds an ordinary URL is charged.
const LINK_DESTINATION_ALLOWANCE = 200;

/**
 * What the body costs a reader, from the lexer's tokens (#5003, #5026). Known
 * kinds are charged for the text they render: prose and code spans count as
 * visible characters, and a `code` token is measured on its own (lines, widest
 * line, total). Fail closed: a token kind this function does not list, raw
 * HTML (a tag, a comment, a `<details>` block), a reference definition, an
 * image, a hard line break and a rule are charged for their whole `raw`, never
 * for nothing; a link also pays for a long destination and its title. A container whose
 * children the lexer did not place is charged the same way.
 */
function tallyTokens(tokens, tally) {
	for (const token of tokens) {
		switch (token.type) {
			case "space":
				break;
			case "code": {
				const rows = token.raw.replace(/\n+$/, "").split("\n");
				tally.code.push({
					lines: token.text === "" ? 0 : token.text.split("\n").length,
					width: Math.max(...rows.map((row) => row.length)),
				});
				break;
			}
			case "codespan":
			case "escape":
				tally.chars += collapsedLength(token.text);
				break;
			case "text":
			case "paragraph":
			case "heading":
			case "blockquote":
			case "list":
			case "list_item":
			case "table":
			case "strong":
			case "em":
			case "del":
			case "link": {
				const kids = markdownChildren(token);
				if (kids.length) tallyTokens(kids, tally);
				else tally.chars += collapsedLength(token.raw);
				if (token.type === "link")
					tally.chars +=
						Math.max(
							0,
							String(token.href ?? "").length - LINK_DESTINATION_ALLOWANCE,
						) + collapsedLength(token.title);
				break;
			}
			default:
				tally.chars += collapsedLength(token.raw);
		}
	}
	return tally;
}

/** A Summary paragraph as the reader reads it: code spans kept, raw HTML and images dropped. */
function summaryText(tokens) {
	return tokens
		.map((token) => {
			if (token.type === "codespan") return token.raw;
			if (token.type === "br") return " ";
			if (token.type === "html" || token.type === "image") return "";
			const kids = markdownChildren(token);
			return kids.length ? summaryText(kids) : (token.text ?? token.raw ?? "");
		})
		.join("");
}

/**
 * Does a Summary section hold what the template admits: paragraphs only, one
 * to SUMMARY_MAX_SENTENCES sentences, at most SUMMARY_MAX_CHARS characters?
 * Every other token kind refuses (a list, a table, code, raw HTML, a nested
 * heading). The sentence count keeps its abbreviation tolerance (#3262): a
 * sentence that starts in lower case counts with the one before it, so the
 * character cap, not the count, is what bounds a Summary written that way.
 */
function summaryAdmitted(tokens) {
	if (
		!tokens.every(
			(token) => token.type === "paragraph" || token.type === "space",
		)
	)
		return false;
	const sentences = countSentenceTerminators(
		tokens.map((token) => summaryText(token.tokens ?? [])),
	);
	return (
		sentences >= 1 &&
		sentences <= SUMMARY_MAX_SENTENCES &&
		tallyTokens(tokens, { chars: 0, code: [] }).chars <= SUMMARY_MAX_CHARS
	);
}

/**
 * Does the reviewer-notes section hold what the template admits: exactly one
 * list of at most REVIEWER_NOTES_MAX_BULLETS items, each holding text or
 * paragraphs and a task checkbox, nothing nested? Every other token kind
 * refuses, so a spelling nobody listed (a paragraph, `1)`, an indent, a quote,
 * a pipe-less table) is refused too.
 */
function notesAdmitted(tokens) {
	const content = tokens.filter((token) => token.type !== "space");
	if (content.length === 0) return true;
	const [list] = content;
	return (
		content.length === 1 &&
		list.type === "list" &&
		list.items.length <= REVIEWER_NOTES_MAX_BULLETS &&
		list.items.every((item) =>
			item.tokens.every((token) =>
				["text", "paragraph", "space", "checkbox"].includes(token.type),
			),
		)
	);
}

/**
 * The family names of `docs/alignment-families.md`: the text before the first
 * colon in the Family column of its table. A file with no such table throws,
 * so a gate that cannot read the list never reads a body as clean.
 */
function alignmentFamilies() {
	const table = markdownTokens(
		readFileSync(resolve(REPO_ROOT, ALIGNMENT_FAMILIES_PATH), "utf8"),
	)
		.map(({ token }) => token)
		.find((token) => token.type === "table");
	const names = (table?.rows ?? []).map((row) =>
		String(row[1]?.text ?? "")
			.split(":")[0]
			.trim(),
	);
	if (
		table?.header[1]?.text !== "Family" ||
		names.length === 0 ||
		names.some((name) => !name || name.includes(","))
	)
		throw new Error(
			`${ALIGNMENT_FAMILIES_PATH} holds no readable family table`,
		);
	return names;
}

/**
 * `### Class sweep` carries exactly one `Alignment:` line (#5026): the family
 * names the change touches, comma-separated and spelled as in
 * `docs/alignment-families.md`, or `none: <reason>` with a reason of at least
 * ALIGNMENT_NONE_MIN_REASON characters. Fail closed: anything else refuses,
 * a bare `none` and the template's own placeholder included.
 */
function lintAlignmentLine(sweepLines) {
	const found = sweepLines
		.map((line) => /^Alignment:(.*)$/.exec(line.trim())?.[1])
		.filter((value) => value !== undefined);
	const names = alignmentFamilies();
	const message = `PR body "Class sweep" needs exactly one line "Alignment: <family names, comma-separated>" or "Alignment: none: <reason of ${ALIGNMENT_NONE_MIN_REASON}+ characters>". Families: ${names.join("; ")}. See ${ALIGNMENT_FAMILIES_PATH}.`;
	if (found.length !== 1) return [message];
	const value = found[0].trim();
	if (value.startsWith("none:"))
		return value.slice(5).trim().length >= ALIGNMENT_NONE_MIN_REASON
			? []
			: [message];
	const listed = value.split(",").map((name) => name.trim());
	return listed.every((name) => names.includes(name)) ? [] : [message];
}

function lintBodyBudgets(body) {
	const errors = [];
	const blocks = markdownTokens(body);
	const tally = tallyTokens(
		blocks.map(({ token }) => token),
		{ chars: 0, code: [] },
	);
	if (tally.chars > VISIBLE_BODY_MAX_CHARS)
		errors.push(
			`PR body is ${tally.chars} visible characters, over the ${VISIBLE_BODY_MAX_CHARS} cap. Cut narrative and tables; see ${TEMPLATE_PATH}.`,
		);
	const longest = Math.max(0, ...tally.code.map(({ lines }) => lines));
	if (longest > CODE_MAX_LINES)
		errors.push(
			`PR body has a ${longest}-line code fence or block, over the ${CODE_MAX_LINES} cap. Quote only the failing lines; see ${TEMPLATE_PATH}.`,
		);
	const widest = Math.max(0, ...tally.code.map(({ width }) => width));
	if (widest > CODE_MAX_WIDTH)
		errors.push(
			`PR body has a code line of ${widest} characters, over the ${CODE_MAX_WIDTH} cap. Cut it to the failing part; see ${TEMPLATE_PATH}.`,
		);
	const total = tally.code.reduce((sum, { lines }) => sum + lines, 0);
	if (total > CODE_TOTAL_MAX_LINES)
		errors.push(
			`PR body has ${total} code lines in all, over the ${CODE_TOTAL_MAX_LINES} cap. Give each changed test file its failing lines only; see ${TEMPLATE_PATH}.`,
		);
	const headings = bodyHeadings(body);
	const tokensOf = (heading) => {
		const end =
			headings.find(
				(candidate) =>
					candidate.index > heading.index && candidate.level <= heading.level,
			)?.index ?? Number.POSITIVE_INFINITY;
		return blocks
			.filter(({ line }) => line >= heading.contentIndex && line < end)
			.map(({ token }) => token);
	};
	for (const heading of headings)
		if (hasSection(heading, "summary") && !summaryAdmitted(tokensOf(heading)))
			errors.push(
				`PR body "## ${heading.name}" must hold plain paragraphs of one to ${SUMMARY_MAX_SENTENCES} sentences and at most ${SUMMARY_MAX_CHARS} characters, with no list, table, code or HTML. See ${TEMPLATE_PATH}.`,
			);
	for (const heading of headings)
		if (
			hasSection(heading, "notes for the reviewer") &&
			!notesAdmitted(tokensOf(heading))
		)
			errors.push(
				`PR body "## Notes for the reviewer" allows at most ${REVIEWER_NOTES_MAX_BULLETS} bullets in one flat list and nothing else. Move proof under "## Proof and checks"; see ${TEMPLATE_PATH}.`,
			);
	return errors;
}

export function lintPrBody(body = "", options = {}) {
	// The same lexer headings and section text `sectionContent` reads (#4717):
	// a section GitHub hides in a comment or a raw-HTML block is a missing
	// section here too, and text inside one is not content. `rawLines` keeps
	// code (a fenced transcript is content); `lines` blanks it.
	const headings = bodyHeadings(body);
	const { text: rawLines, visible: lines } = sectionLines(body, headings);
	const placeholders = templatePlaceholderLines();
	const structure = headingLines(body, headings).name;
	const errors = options.diff ? lintDiffCompliance(body, options) : [];
	const lead = headings.find((heading) => hasSection(heading, "summary"));
	const firstHeading = headings[0]?.index ?? lines.length;
	const nextSectionHeading = (heading) =>
		headings.find(
			(candidate) =>
				candidate.index > heading.index && candidate.level <= heading.level,
		);
	const leadEnd = lead ? (nextSectionHeading(lead)?.index ?? lines.length) : 0;
	if (
		!options.workingTree &&
		(!lead ||
			!hasRealContent(
				lines.slice(lead.contentIndex, leadEnd),
				"summary",
				placeholders,
				structure,
				lead.contentIndex,
			)) &&
		!hasRealContent(
			lines.slice(0, firstHeading),
			"summary",
			placeholders,
			structure,
		)
	) {
		errors.push(`PR body is missing a Summary section. See ${TEMPLATE_PATH}.`);
	}

	// The exported structural linter is also used by focused tests and historical
	// repair fixtures. The repository-facing local gate is the contract that
	// requires the header sections and the caps; keeping that switch explicit
	// avoids changing the meaning of lower-level parser tests.
	const requiredSections = options.workingTree
		? [...REQUIRED_SECTIONS]
		: ["Tests", "Class sweep", "Observability"];
	// #4288: only a bug-closing PR owes the detection retrospective. The
	// tri-state resolution lives at the callers; `true` is the only value that
	// requires the section, so an unreadable label never blocks.
	if (options.bugClosing) requiredSections.push("Detection");

	for (const name of requiredSections) {
		const heading = headings.find((candidate) =>
			hasSection(candidate, name.toLowerCase()),
		);
		if (!heading) {
			errors.push(sectionMessage(name, "is missing"));
			continue;
		}
		const nextHeading = nextSectionHeading(heading);
		const rawContent = rawLines.slice(
			heading.contentIndex,
			nextHeading?.index ?? lines.length,
		);
		if (
			!hasRealContent(
				rawContent,
				name.toLowerCase(),
				placeholders,
				structure,
				heading.contentIndex,
			)
		)
			errors.push(
				sectionMessage(name, "has no content before the next heading"),
			);
	}
	if (options.workingTree) {
		errors.push(...lintBodyBudgets(body));
		errors.push(...lintTableShape(body));
		const sweep = headings.find((heading) =>
			hasSection(heading, "class sweep"),
		);
		if (sweep)
			errors.push(
				...lintAlignmentLine(
					lines.slice(
						sweep.contentIndex,
						nextSectionHeading(sweep)?.index ?? lines.length,
					),
				),
			);
	}
	if (options.bugClosing)
		errors.push(
			...lintDetectionSection(body, {
				existsOnBase: options.existsOnBase,
				shapeCatalog: options.shapeCatalog,
				requireShape: true,
			}),
		);
	errors.push(...lintBehaviorEquivalence(body, headings, options.title));
	if (options.diff)
		errors.push(
			...lintRuntimeObservability(lines, headings, options.diff, options),
		);
	// #4597: its own rule with its own call site, beside the record-naming
	// check, so a later diff-keyed rule (issue #4585) merges without touching
	// either function.
	if (options.diff)
		errors.push(...lintObservabilityRecordsTested(lines, headings, options));
	errors.push(...lintCodeCitations(body, options));
	errors.push(...lintTestReferences(body, options));
	errors.push(...lintMasterClaims(body));
	errors.push(...lintShellExpansionGarble(body));
	const prose = checkProse(proseSections(body), {
		// Historical structural fixtures call lintPrBody without workingTree.
		// Keep those calls advisory; local and event gates set workingTree and block.
		mode: options.proseMode ?? (options.workingTree ? "block" : "warn"),
	});
	errors.push(...prose.errors.map((error) => `PR body prose ${error}`));
	for (const warning of prose.warnings)
		console.warn(`PR body prose warning: ${warning}`);
	return { valid: errors.length === 0, errors };
}

/**
 * Strict live-body fetch: throws instead of swallowing, on a missing token,
 * a non-2xx response, or a malformed body. `resolveLivePrBody` below wraps
 * this for the advisory body LINTER, where degrading to the stale payload
 * on any hiccup is the right posture. It is the wrong posture for a
 * post-merge verification GATE (#2267 F2): a gate that silently passes on
 * a fetch failure is indistinguishable from a gate that actually checked
 * and found nothing wrong. check-close-keywords.mjs's --verify-merged path
 * calls this directly and fails closed (exitCode=1, ::error::) instead.
 *
 * @param {{ number: number, body?: string | null }} payloadPr
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<{body: string, normalized: boolean, title: string | undefined}>}
 */
export async function fetchLivePrBody(payloadPr, fetchImpl) {
	const response = await githubGet(`/pulls/${payloadPr.number}`, fetchImpl);
	if (!response.ok) throw new Error(`GitHub API returned ${response.status}`);
	const data = await response.json();
	if (data.body !== null && typeof data.body !== "string")
		throw new Error("GitHub API returned no body");
	return {
		...normalizePrBodyForChecking(data.body ?? "", payloadPr.number),
		title: data.title,
	};
}

export async function resolveLivePrBody(
	payloadPr,
	fetchImpl = globalThis.fetch,
) {
	try {
		return await fetchLivePrBody(payloadPr, fetchImpl);
	} catch (error) {
		console.warn(
			`::warning::Could not fetch the live PR body; using the event payload instead (${error instanceof Error ? error.message : error}).`,
		);
		return normalizePrBodyForChecking(payloadPr.body ?? "", payloadPr.number);
	}
}

// #4968: the labels that make an issue owe the detection lesson, for a PR that
// closes it and for one that references it. One list: 17 of 20 nightly-drift
// issues carry no `bug` label, and the issue names both for Closes and Refs.
const DETECTION_BUG_LABELS = ["bug", "nightly-drift"];

/**
 * #4288: does the PR close an issue carrying the `bug` or `nightly-drift` label
 * (#4968)? Returns `true`
 * (some closed issue is so labelled), `false` (no closed issue is), or `null`
 * when the label cannot be read (no API credentials, a non-2xx, or a malformed
 * body). A `null` never blocks the lint: the callers warn and skip the
 * `## Detection` requirement rather than demanding a section they cannot
 * justify (issue #4288, "Detecting the bug label").
 */
export async function resolveBugClosing(body, fetchImpl = globalThis.fetch) {
	const issues = closedIssues(body);
	if (issues.length === 0) return false;
	// A missing env makes githubGet reject, which anyIssueLabelled reads as
	// "cannot read the label" (null), as the old early return did.
	return anyIssueLabelled(
		issues,
		apiIssueReader(fetchImpl),
		DETECTION_BUG_LABELS,
	);
}

/**
 * #4288 remainder: the local preflight reads the same labels through
 * `gh api` (the repository placeholders resolve from `cwd`'s remote), so it
 * agrees with CI instead of skipping the Detection rule offline. `null` when
 * gh is missing, unauthenticated, or fails, exactly as for the CI reader.
 */
export async function resolveBugClosingViaGh(
	body,
	cwd = process.cwd(),
	exec = execFileSync,
) {
	return anyIssueLabelled(
		closedIssues(body),
		ghIssueReader(cwd, exec),
		DETECTION_BUG_LABELS,
	);
}

/**
 * #4968: does the body REFERENCE (Refs, or any close keyword the closing route
 * does not already own) an issue labelled `bug` or `nightly-drift`? `true`,
 * `false`, or `null`. Unlike `resolveBugClosing`, `null` is a refusal at the
 * callers (`lintReferencedBugLabels`): a reference the rule cannot read is not
 * a pass. A reference token it cannot turn into `#N` is `null` without a read.
 * `fullBody` is the whole body; the author's text is cut inside. `title` is the
 * PR title, whose every `#N` is a reference too (`titleIssues`).
 */
export function resolveBugReferenced(
	fullBody,
	fetchImpl = globalThis.fetch,
	title = "",
) {
	return anyReferencedBug(fullBody, apiIssueReader(fetchImpl), title);
}

/** The `gh api` reader of `resolveBugReferenced`, as `resolveBugClosingViaGh`. */
export function resolveBugReferencedViaGh(
	fullBody,
	cwd = process.cwd(),
	exec = execFileSync,
	title = "",
) {
	return anyReferencedBug(fullBody, ghIssueReader(cwd, exec), title);
}

async function anyReferencedBug(fullBody, readIssue, title) {
	const { issues, unrecognised } = referencedOnly(fullBody, title);
	if (unrecognised.length) return null;
	if (issues.length === 0) return false;
	return anyIssueLabelled(issues, readIssue, DETECTION_BUG_LABELS);
}

/**
 * #4968: the refusal for a reference whose label could not be read. `[]` when
 * the read succeeded (`resolved` is true or false) or nothing is referenced.
 * A reference the reader cannot turn into `#N` needs no network and always
 * refuses. An API error refuses in CI, which has the token; the local
 * preflight passes `skipUnreadableLabels` and warns and skips instead, as the
 * closing route does, so an offline sandbox is not reddened (#4968 F2).
 */
export function lintReferencedBugLabels(
	fullBody,
	resolved,
	title = "",
	{ skipUnreadableLabels = false } = {},
) {
	if (resolved !== null) return [];
	const { issues, unrecognised } = referencedOnly(fullBody, title);
	if (unrecognised.length)
		return [
			`PR body "## Detection" cannot be judged: the reference ${unrecognised.join(", ")} is not an issue of this repository written as "#N", so its label cannot be read and the check refuses (#4968). Write each reference as "Refs #N".`,
		];
	if (issues.length === 0) return [];
	const named = issues.map((number) => `#${number}`).join(", ");
	if (skipUnreadableLabels) {
		console.warn(
			`::warning::PR body check could not read the label of ${named} (gh missing, unauthenticated, or failed), so the "## Detection" requirement for a referenced bug was skipped; CI reads it (#4968).`,
		);
		return [];
	}
	return [
		`PR body "## Detection" cannot be judged: the label of ${named} could not be read (an API error), so the check cannot tell whether a detection lesson is owed and refuses (#4968). Retry once the label read works.`,
	];
}

// The label readers the two transports share: `(number) => issue JSON`, or
// null / a throw when the issue cannot be read.
function apiIssueReader(fetchImpl) {
	return async (number) => {
		const response = await githubGet(`/issues/${number}`, fetchImpl);
		return response.ok ? await response.json() : null;
	};
}

function ghIssueReader(cwd, exec) {
	return (number) => {
		const raw = exec("gh", ["api", `repos/{owner}/{repo}/issues/${number}`], {
			cwd,
			encoding: "utf8",
			timeout: 10_000,
			killSignal: "SIGKILL",
			stdio: ["ignore", "pipe", "pipe"],
		});
		// gh output that is not JSON is unreadable label evidence, the same
		// verdict a thrown exec already gets from anyIssueLabelled.
		try {
			return JSON.parse(raw);
		} catch {
			return null;
		}
	};
}

// The one label reader both transports share: `readIssue(number)` returns the
// issue JSON, or null / throws when it cannot be read. `names` are the labels
// that count (`DETECTION_BUG_LABELS`).
async function anyIssueLabelled(issues, readIssue, names) {
	for (const number of issues) {
		let data;
		try {
			data = await readIssue(number);
		} catch {
			return null;
		}
		if (data === null) return null;
		const labels = Array.isArray(data?.labels) ? data.labels : [];
		if (
			labels.some((label) =>
				names.includes(typeof label === "string" ? label : label?.name),
			)
		)
			return true;
	}
	return false;
}

function eventPayload() {
	const eventPath = process.env.GITHUB_EVENT_PATH;
	if (!eventPath) throw new Error("GITHUB_EVENT_PATH is required");
	let raw;
	try {
		raw = readFileSync(eventPath, "utf8");
	} catch (error) {
		throw new Error(
			`cannot read GITHUB_EVENT_PATH: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	try {
		return JSON.parse(raw);
	} catch (error) {
		throw new Error(
			`cannot parse GITHUB_EVENT_PATH: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/** The full live lint: resolve the body and the diff, then lint. */
export async function lintPullRequestEvent(
	fetchImpl = globalThis.fetch,
	event = eventPayload(),
	diffImpl = localDiff,
) {
	const pullRequest = event.pull_request;
	if (!pullRequest || !process.env.GITHUB_REPOSITORY)
		throw new Error("Pull request event and GITHUB_REPOSITORY are required");
	const live = await resolveLivePrBody(pullRequest, fetchImpl);
	const { normalized } = live;
	// Section readers get the cut text; the close-keyword and bug-label readers
	// keep `fullBody`, because GitHub closes what the whole body names (#4778).
	const fullBody = live.body;
	// The title comes from the same live fetch as the body (#2083's seam), so a
	// title edited after a replayed event is judged as it stands; the payload
	// title stands in only when the live fetch fell back (#4976).
	const title = live.title ?? pullRequest.title;
	const body = authorText(fullBody);
	// #4288: a bug-closing PR owes a detection retrospective. The label read is
	// best-effort; an unreadable label warns and skips the requirement.
	let bugClosing = null;
	try {
		bugClosing = await resolveBugClosing(fullBody, fetchImpl);
	} catch {
		bugClosing = null;
	}
	if (bugClosing === null && closedIssues(fullBody).length > 0)
		console.warn(
			'::warning::PR body check could not read the closed issue label(s), so the "## Detection" section is not required (#4288).',
		);
	// #4968: a reference to a bug owes the same lesson. Unlike the closing
	// read above, an unreadable reference refuses (`lintReferencedBugLabels`).
	let bugReferenced = false;
	if (bugClosing !== true)
		try {
			bugReferenced = await resolveBugReferenced(fullBody, fetchImpl, title);
		} catch {
			bugReferenced = null;
		}
	let diff = "";
	try {
		diff = diffImpl();
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`diff unavailable: ${reason}`);
	}
	const result = lintPrBody(body, {
		bugClosing: bugClosing === true || bugReferenced === true,
		existsOnBase: baseFileReader(),
		shapeCatalog: shapeCatalogReader(),
		diff,
		workingTree: true,
		// Existing open bodies were authored before #4280. Set PI_LENS_PROSE_GRACE=1
		// for the transition job; local preflight remains blocking by default.
		proseMode: process.env.PI_LENS_PROSE_GRACE === "1" ? "warn" : "block",
		title,
	});
	const unreadable = lintReferencedBugLabels(fullBody, bugReferenced, title);
	if (unreadable.length) {
		result.valid = false;
		result.errors.push(...unreadable);
	}
	const classSweep = lintClassSweep(body, { diff });
	if (classSweep.length) {
		result.valid = false;
		result.errors.push(...classSweep);
	}
	const foldCheck = lintFoldCheck(body, fullBody);
	if (foldCheck.length) {
		result.valid = false;
		result.errors.push(...foldCheck);
	}
	const coverage = lintTlaCoverage(body, { diff });
	result.errors.push(...coverage.errors);
	if (coverage.errors.length) result.valid = false;
	for (const advisory of coverage.advisories)
		console.warn(`::notice::${advisory}`);
	const workflowEvidence = lintWorkflowRunEvidence(body, {
		diff,
		repository: process.env.GITHUB_REPOSITORY,
	});
	result.errors.push(...workflowEvidence);
	if (workflowEvidence.length) result.valid = false;
	if (result.valid) {
		console.log(`PR body OK: ${pullRequest.number}`);
		return { valid: true, repaired: normalized };
	}
	for (const error of result.errors) console.error(error);
	return { valid: false, repaired: false };
}

export function localDiff(cwd = process.cwd(), git = gitExecFileSync) {
	// The same byte ceiling as a post-image read: a diff keyed to a large change
	// (a captured fixture corpus, a generated file) must not fail as unavailable.
	return git(["diff", "--unified=0", "--no-color", "origin/master...HEAD"], {
		cwd,
		encoding: "utf8",
		maxBuffer: MAX_SOURCE_BYTES,
	});
}

/**
 * #3802 rule 2: a PR that changes a file the checked-in
 * `formal/coverage-map.json` maps to a model family must move that family's
 * `.tla`/`.cfg`, or say `TLA+ unaffected: <family> — <reason>`. `unmodelled`
 * rows stay advisory. The map logic is dependency-free because this script
 * runs with no `npm install` in the PR-body lane.
 */
export function lintTlaCoverage(
	body,
	{ diff, cwd = REPO_ROOT, sourceCwd, headFiles, git } = {},
) {
	if (!diff) return { errors: [], advisories: [] };
	let map;
	try {
		map = loadCoverageMap(cwd);
	} catch (error) {
		return {
			errors: [
				`TLA+ coverage map unavailable: ${error instanceof Error ? error.message : String(error)}`,
			],
			advisories: [],
		};
	}
	const anchors = hookAnchorsFromDiff(diff, map, {
		cwd: sourceCwd,
		headFiles,
		git,
	});
	const result = evaluateTlaCoverage({
		map,
		changedFiles: parseChangedFiles(diff),
		changedAnchors: anchors.fired,
		body,
	});
	return {
		errors: result.errors,
		advisories: [...result.advisories, ...anchors.notes].sort(),
	};
}

/**
 * The `<file>#<hook>` anchors an anchored map row (index.ts, #3878) sees
 * changed. `git diff --unified=0` carries no hook name for a hunk inside a
 * handler, so the hunk's post-image lines are placed against the handler ranges
 * of the post-image the diff names. A post-image that is unreadable or does not
 * carry the diff's added lines cannot place a hunk: every hook of that file
 * counts as changed (the any-of declaration still satisfies it) and one note
 * says so, never a silent pass.
 */
function hookAnchorsFromDiff(diff, map, options) {
	const fired = [];
	const notes = [];
	const rows = Object.entries(map?.map ?? {}).filter(
		([, row]) => row && typeof row === "object" && !Array.isArray(row),
	);
	if (!rows.length) return { fired, notes };
	for (const file of parseRuntimeHunks(diff)) {
		const row = rows.find(([glob]) => matchGlob(glob, file.post))?.[1];
		if (!row?.anchors) continue;
		const names = Object.keys(row.anchors);
		const source = headFileSource(file.post, {
			headFiles: options.headFiles,
			workingTree: true,
			cwd: options.cwd,
			git: options.git,
			postBlob: file.postBlob,
		});
		const hooks =
			typeof source === "string"
				? changedHookAnchors(source, file, names)
				: null;
		if (hooks === null)
			notes.push(
				`TLA+ note: the post-image of ${file.post} could not be read against the diff, so every lifecycle hook counts as changed.`,
			);
		for (const hook of hooks ?? names) fired.push(`${file.post}#${hook}`);
	}
	return { fired, notes };
}

// `owner/repo` of the checkout's `origin`, or `undefined` when it has none or
// it is not a GitHub URL. The local twin of GITHUB_REPOSITORY on the event path.
function originRepository(cwd, git) {
	try {
		return (
			parseOwnerRepoFromGitRemote(
				git(["remote", "get-url", "origin"], {
					cwd,
					encoding: "utf8",
					stdio: ["ignore", "pipe", "ignore"],
				}),
			) ?? undefined
		);
	} catch {
		return undefined;
	}
}

/**
 * #3085 gap 1: a PR that edits a workflow no pull request executes must quote
 * the branch run (`gh workflow run <file> --ref <branch>`) with its run id.
 * The post-image is read from the checkout the lint runs in, which is the PR's
 * own head tree in CI and the working tree locally; `cwd` defaults to the
 * directory `localDiff` diffs, so the diff and the post-image agree. The
 * merge-base image lets the rule verify a comment-only edit and tell an ADDED
 * file (absent on the base), which may quote a push-run URL instead (#4756).
 */
export function lintWorkflowRunEvidence(
	body,
	{ diff, cwd = process.cwd(), repository, git = gitExecFileSync } = {},
) {
	if (!diff) return [];
	const unreadable = [];
	// The merge base is what `localDiff` diffs from. `null` from
	// `readBaseWorkflow` means ADDED (the file is absent on the base) and relaxes
	// the run-evidence rule; a base that cannot be resolved or read (a shallow
	// checkout) answers "" instead, which fails closed: not added, and not a
	// comment-only edit.
	const mergeBase = resolvePrBase(cwd, git);
	const existsOnBase = baseFileReader(cwd, git);
	const errors = evaluateWorkflowRunEvidence({
		changedFiles: parseChangedFiles(diff),
		body,
		repository: repository ?? originRepository(cwd, git),
		readBaseWorkflow: (file) => {
			if (!mergeBase) return "";
			if (existsOnBase(file) === false) return null;
			try {
				return git(["show", `${mergeBase}:${file}`], {
					cwd,
					encoding: "utf8",
				});
			} catch {
				return "";
			}
		},
		readWorkflow: (file) => {
			try {
				return readFileSync(resolve(cwd, file), "utf8");
			} catch (error) {
				if (error?.code === "ENOENT") return null;
				unreadable.push(
					`Changed workflow ${file} could not be read to judge whether a pull request runs it: ${error instanceof Error ? error.message : String(error)}`,
				);
				return null;
			}
		},
	});
	return [...errors, ...unreadable];
}

/**
 * True when the checkout has no `origin/master` at all (a shallow or uncloned
 * base). The diff cannot be read there for a reason the #4404 hint names, and
 * the diff-keyed rows stay unattempted rather than failing the whole preflight.
 */
function missingBaseRef(cwd, git = gitExecFileSync) {
	try {
		git(["rev-parse", "--verify", "origin/master"], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		return false;
	} catch {
		return true;
	}
}

export function lintLocalPrBody(
	fullBody,
	cwd = process.cwd(),
	git = gitExecFileSync,
	options = {},
) {
	// The same split as CI's entry: section readers get the cut text, the
	// close-keyword and bug-label readers keep `fullBody` (#4778).
	const body = authorText(fullBody);
	let diff = "";
	// #4585: a local preflight must judge the same range as CI. An unavailable
	// diff cannot classify the diff-keyed rows, so it fails closed; the rest of
	// the lint still runs, because its own base-resolution message names what to
	// fetch. A clone with no base ref at all keeps the #4404 hint instead: there
	// is no diff to read, and the missing base is what the reader must fix.
	let diffUnavailable = false;
	try {
		diff = localDiff(cwd, git);
	} catch {
		diffUnavailable = !missingBaseRef(cwd, git);
	}
	// #4288: an explicit tri-state (the CLI resolves it through gh before this
	// call) or an injected resolver (tests) wins; otherwise the label is unknown
	// and a body that closes an issue warns that the check was skipped.
	let bugClosing = options.bugClosing;
	if (bugClosing === undefined)
		bugClosing =
			typeof options.resolveBugClosing === "function"
				? options.resolveBugClosing(fullBody)
				: null;
	if (bugClosing === null && closedIssues(fullBody).length > 0)
		console.warn(
			'::warning::PR body check could not read the closed issue label (gh missing, unauthenticated, or failed), so the "## Detection" requirement check was skipped (#4288).',
		);
	// #4968: a reference to a bug owes the lesson too, and an unreadable
	// reference refuses. A closing bug already owes it, so nothing is read.
	let bugReferenced = false;
	if (bugClosing !== true) {
		bugReferenced = options.bugReferenced;
		if (bugReferenced === undefined)
			bugReferenced =
				typeof options.resolveBugReferenced === "function"
					? options.resolveBugReferenced(fullBody, options.title)
					: null;
	}
	const existsOnBase = baseFileReader(cwd, git);
	const shapeCatalog = shapeCatalogReader(cwd, git);
	const result = lintPrBody(body, {
		bugClosing: bugClosing === true || bugReferenced === true,
		existsOnBase,
		shapeCatalog,
		diff,
		cwd,
		workingTree: true,
		ref: options.ref,
		headFiles: options.headFiles,
		git,
		proseMode: options.proseMode,
		title: options.title,
	});
	// #4288: a present section is validated whatever the label, so a prose-form
	// answer reds here instead of at CI. `lintPrBody` already did it for a
	// resolved bug.
	if (bugClosing !== true && bugReferenced !== true) {
		const detection = lintDetectionSection(body, {
			ignoreUnfilled: true,
			existsOnBase,
			shapeCatalog,
		});
		result.errors.push(...detection);
		if (detection.length) result.valid = false;
	}
	const unreadable = lintReferencedBugLabels(
		fullBody,
		bugReferenced,
		options.title,
		{ skipUnreadableLabels: true },
	);
	if (unreadable.length) {
		result.valid = false;
		result.errors.push(...unreadable);
	}
	const classSweep = lintClassSweep(body, { diff });
	if (classSweep.length) {
		result.valid = false;
		result.errors.push(...classSweep);
	}
	const foldCheck = lintFoldCheck(body, fullBody);
	if (foldCheck.length) {
		result.valid = false;
		result.errors.push(...foldCheck);
	}
	const coverage = lintTlaCoverage(body, {
		diff,
		sourceCwd: cwd,
		headFiles: options.headFiles,
		git,
	});
	result.errors.push(...coverage.errors);
	if (coverage.errors.length) result.valid = false;
	for (const advisory of coverage.advisories) console.warn(advisory);
	const workflowEvidence = lintWorkflowRunEvidence(body, { diff, cwd, git });
	result.errors.push(...workflowEvidence);
	if (workflowEvidence.length) result.valid = false;
	const closeSyntax = lintCloseKeywords(fullBody);
	if (!closeSyntax.valid) {
		result.valid = false;
		result.errors.push(...closeKeywordErrors(closeSyntax));
	}
	const placement = lintCloseKeywordPlacement(options.title ?? "", fullBody);
	if (!placement.valid) {
		result.valid = false;
		result.errors.push(
			closeKeywordPlacementMessage(placement.missingBodyIssues),
		);
	}
	if (diffUnavailable) {
		result.valid = false;
		result.errors.push(
			"PR body compliance: diff unavailable; cannot classify rows 1, 2 and 4.",
		);
	}
	return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	// Local contract: --lint-local <body-file> remains the preflight form from
	// #2796. Optional --title text and --ref revision add the CI close-keyword
	// and head-tree citation checks to that same local entry point.
	const bodyIndex = process.argv.indexOf("--body");
	const titleIndex = process.argv.indexOf("--title");
	const refIndex = process.argv.indexOf("--ref");
	// The documented local form also takes the title positionally:
	// `--lint-local <body-file> "<title>"` (docs/pi-lens-subagent.md). Without
	// it a title-gated rule (Behavior equivalence) never fired locally (#4551).
	const positionalTitle =
		process.argv[2] === "--lint-local" &&
		process.argv[4] &&
		!process.argv[4].startsWith("--")
			? process.argv[4]
			: "";
	// With neither, the handoff's commit subject stands in for the title, the
	// proxy check-pr-title.mjs reads too, so pr-preflight and lane-check (which
	// pass only the body) still apply the title-gated rules.
	const commitSubject = () => {
		try {
			return readFileSync("COMMIT_MSG.txt", "utf8").split(/\r?\n/, 1)[0].trim();
		} catch {
			return "";
		}
	};
	const title =
		titleIndex !== -1
			? process.argv[titleIndex + 1]
			: positionalTitle ||
				(process.argv[2] === "--lint-local" ? commitSubject() : "");
	const ref = refIndex === -1 ? undefined : process.argv[refIndex + 1];
	const proseMode = process.argv.includes("--prose-grace") ? "warn" : "block";
	if (titleIndex !== -1 && !title) throw new Error("--title requires text");
	if (refIndex !== -1 && !ref) throw new Error("--ref requires a revision");
	const localBodyPath =
		bodyIndex !== -1
			? process.argv[bodyIndex + 1]
			: process.argv[2] === "--lint-local"
				? process.argv[3]
				: undefined;
	if (bodyIndex !== -1 && !localBodyPath)
		throw new Error("--body requires a file path");
	if (bodyIndex === -1 && process.argv[2] === "--lint-local" && !localBodyPath)
		throw new Error("--lint-local requires a file path");
	if (localBodyPath) {
		// --title is accepted for preflight parity. Title validation belongs to
		// check-pr-title.mjs, but preflight passes both local input files.
		const localBody = readFileSync(localBodyPath, "utf8");
		const bugClosing = await resolveBugClosingViaGh(localBody);
		const result = lintLocalPrBody(localBody, process.cwd(), gitExecFileSync, {
			title,
			ref,
			proseMode,
			bugClosing,
			// #4968: a closing bug already owes the section; skip the extra reads.
			bugReferenced:
				bugClosing === true
					? false
					: await resolveBugReferencedViaGh(
							localBody,
							process.cwd(),
							execFileSync,
							title,
						),
		});
		for (const error of result.errors) console.error(error);
		process.exitCode = result.valid ? 0 : 1;
	} else
		lintPullRequestEvent()
			.then((result) => {
				if (!result.valid) process.exitCode = 1;
			})
			.catch((error) => {
				console.error(error instanceof Error ? error.message : error);
				process.exitCode = 1;
			});
}
