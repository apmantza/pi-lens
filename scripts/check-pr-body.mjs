import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gitExecFileSync } from "./lib/git-fixture-env.mjs";

const TEMPLATE_PATH = ".github/PULL_REQUEST_TEMPLATE.md";
const TEMPLATE_FILE = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	TEMPLATE_PATH,
);
const REQUIRED_SECTIONS = [
	"Tests",
	"Blast radius",
	"Class sweep",
	"Observability",
];
const HEADING = /^#{2,4}\s+(.+?)\s*$/;
const FLATTENED_BODY_MAX_NEWLINES = 2;
const REPAIR_HEADINGS = [
	"Summary",
	"Tests",
	"Test assessment",
	"Blast radius",
	"Class sweep",
	"Observability",
	"Fix round \\d+",
	"Review round \\d+",
];
const REPAIR_HEADING_PATTERN = REPAIR_HEADINGS.join("|");
const CORRUPTED_HEADING_TAILS = [
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
// Tests. Heading matching is deliberately case-insensitive.
const SECTION_SYNONYMS = new Map([
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
	["observability", "observability"],
	["test assessment", "test assessment"],
]);

function sectionMessage(name, detail) {
	return `PR body ${detail} "## ${name}". See ${TEMPLATE_PATH}.`;
}

function hasSection(heading, section) {
	return Array.isArray(heading?.section)
		? heading.section.includes(section)
		: heading?.section === section;
}

function sourceWithoutFencedBlocks(source) {
	let fenced = false;
	return String(source ?? "")
		.split(/\r?\n/)
		.map((line) => {
			if (/^\s*```/.test(line)) {
				fenced = !fenced;
				return "";
			}
			return fenced ? "" : line;
		})
		.join("\n");
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

function hasRealContent(lines, section, placeholders) {
	const templateLines = placeholders.get(section) ?? new Set();
	return lines.some((line) => {
		const value = line.trim();
		// A nested heading is structure, not content: counting it let an empty
		// "## Tests" pass on the strength of its own "### Test assessment" line
		// (#2124 review F1).
		return (
			value &&
			!HEADING.test(value) &&
			!/^[-*+] \[ \]/.test(value) &&
			!templateLines.has(value)
		);
	});
}

function blankCommentsAndStrings(source) {
	let state = "code";
	let result = "";
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
		if (state !== "code") {
			result += char === "\n" ? "\n" : " ";
			if (char === "\\") {
				if (next === "\n") result += "\n";
				else {
					result += " ";
					index += 1;
				}
			} else if (char === state) state = "code";
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
		} else if (char === "'" || char === '"' || char === "`") {
			result += " ";
			state = char;
		} else result += char;
	}
	return result;
}

function isRuntimeObservabilityPath(name) {
	return (
		/^(?:clients|tools|mcp)\//.test(name) &&
		!/(?:^|\/)__tests__(?:\/|$)/.test(name) &&
		!/\.test\.[^/]+$/.test(name) &&
		!/\.d\.(?:ts|mts)$/.test(name)
	);
}

function runtimeObservabilityFromDiff(diff = "") {
	const records = new Set();
	let runtime = false;
	let added = "";
	let currentRuntime = false;
	for (const line of String(diff).split(/\r?\n/)) {
		const header = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
		if (header) {
			currentRuntime = [header[1], header[2]].some(isRuntimeObservabilityPath);
			runtime ||= currentRuntime;
			continue;
		}
		if (currentRuntime && /^\+(?!\+\+)/.test(line))
			added += `${line.slice(1)}\n`;
	}
	if (!runtime) return { runtime: false, records, failurePath: false };
	const blanked = blankCommentsAndStrings(added);
	return {
		runtime: true,
		records: recordLiteralsFromRuntimeSource(added),
		failurePath:
			/\bcatch\b|\brecordDegradationOnce\b|\bthrow\b|\breturn\s+null\b/.test(
				blanked,
			),
	};
}

function observabilitySectionContent(body, lines, headings) {
	const heading = headings.find((candidate) =>
		hasSection(candidate, "observability"),
	);
	if (!heading) return "";
	const next = headings.find(
		(candidate) =>
			candidate.index > heading.index && candidate.level <= heading.level,
	);
	return lines.slice(heading.index + 1, next?.index ?? lines.length).join("\n");
}

function recordLiteralsFromRuntimeSource(source) {
	return new Set(
		recordLocationsFromRuntimeSource(source).map(({ value }) => value),
	);
}

function recordLocationsFromRuntimeSource(source) {
	const records = [];
	const blanked = blankCommentsAndStrings(source);
	const calls = [
		["recordDegradationOnce", ["kind"]],
		["incrementDegradationCount", ["kind"]],
		["logExtension", ["subsystem", "message"]],
		["logLatency", ["phase", "event", "eventName", "name"]],
		["emitBounded", ["kind", "event", "eventName"]],
	];
	for (const [name, fields] of calls) {
		const callPattern = new RegExp(`${name}\\s*\\(\\s*\\{[\\s\\S]*?\\}`, "g");
		for (const match of blanked.matchAll(callPattern)) {
			const original = source.slice(match.index, match.index + match[0].length);
			for (const field of fields) {
				const fieldMatch = new RegExp(`${field}\\s*:\\s*["']([^"']+)["']`).exec(
					original,
				);
				const value = fieldMatch?.[1];
				if (value) {
					const valueIndex =
						match.index + fieldMatch.index + fieldMatch[0].indexOf(value);
					records.push({
						value,
						line: source.slice(0, valueIndex).split("\n").length,
					});
				}
			}
		}
	}
	return records;
}

const CODE_CITATION = /`([^`\s:]+):((?:~?\d+)(?:-\d+)?)`/g;
const MASTER_CLAIM =
	/pre-existing|red on master|also fails on origin\/master|environment-specific/i;
const headTestCorpusCache = new Map();

function headFileSource(file, options = {}) {
	if (options.headFiles?.has?.(file)) return options.headFiles.get(file);
	if (/(?:^|\/)\.\.(?:\/|$)/.test(file) || isAbsolute(file)) return null;
	if (options.workingTree) {
		try {
			return readFileSync(resolve(options.cwd ?? process.cwd(), file), "utf8");
		} catch {
			return null;
		}
	}
	try {
		return String(
			(options.git ?? gitExecFileSync)(["show", `HEAD:${file}`], {
				cwd: options.cwd ?? process.cwd(),
				encoding: "utf8",
			}),
		);
	} catch {
		return null;
	}
}

function sourceLines(source) {
	return String(source ?? "").split(/\r?\n/);
}

function bodyLinesOutsideFences(body) {
	let fence;
	return String(body ?? "")
		.split(/\r?\n/)
		.map((line) => {
			const marker = line.match(/^\s*(```+)/)?.[1];
			if (marker) {
				if (!fence) fence = marker;
				else if (marker.length >= fence.length) fence = undefined;
				return "";
			}
			return fence ? "" : line;
		});
}

function pathLineReferences(text) {
	return [...String(text ?? "").matchAll(CODE_CITATION)].map((match) => ({
		file: match[1],
		lineText: match[2],
		line: Number(match[2].replace(/^~/, "").split("-", 1)[0]),
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

function isTranscriptQuote(quote) {
	const lines = quote.text.join("\n");
	return (
		/^(?:text|console|shell|sh|bash|output)$/i.test(quote.info) &&
		/^(?:\s*(?:\$|>)\s+(?:git|npm|npx|vitest|tsc)\b|\s*Test Files?\b.*\b(?:failed|passed)\b|\s*Tests?\s+\d+\s+(?:failed|passed)\b|\s*(?:PASS|FAIL)\s+(?:\||$)|\s*npm ERR!|\s*error TS\d+|.*\borigin\/master\b)/im.test(
			lines,
		)
	);
}

function lintCodeCitations(body, options = {}) {
	const errors = [];
	const rawLines = String(body ?? "").split(/\r?\n/);
	const visibleBody = bodyLinesOutsideFences(body).join("\n");
	for (const { file, lineText, line: lineNumber, index } of pathLineReferences(
		visibleBody,
	)) {
		const bodyLine = visibleBody.slice(0, index).split(/\r?\n/).length - 1;
		const key = `${file}:${lineText}`;
		const existingRecordCitation = /covered by existing record\b/.test(
			rawLines[bodyLine] ?? "",
		);
		const source = headFileSource(file, options);
		if (source === null) {
			errors.push(`PR body citation ${key} does not exist in the HEAD tree.`);
			continue;
		}
		const sourceRows = sourceLines(source);
		if (lineNumber < 1 || lineNumber > sourceRows.length) {
			errors.push(`PR body citation ${key} is outside the HEAD tree.`);
			continue;
		}
		if (existingRecordCitation) continue;
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

function lintTestReferences(body, options = {}) {
	const references = [];
	const visibleBody = bodyLinesOutsideFences(body).join("\n");
	for (const match of visibleBody.matchAll(
		/\bit\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
	)) {
		const lineStart = visibleBody.lastIndexOf("\n", match.index) + 1;
		if (!/^\s*\|/.test(visibleBody.slice(lineStart, match.index)))
			references.push(match[1]);
	}
	for (const row of visibleBody.split(/\r?\n/)) {
		if (!/^\s*\|.*\|\s*$/.test(row)) continue;
		for (const cell of row.split("|").map((value) => value.trim())) {
			const match = /^`([^`]+)`$/.exec(cell);
			if (!match) continue;
			const reference = match[1].trim();
			const title = /^it\(\s*["'`]([^"'`]+)["'`]\s*\)$/.exec(reference)?.[1];
			if (title) references.push(title);
			else if (/^[A-Za-z]\d{2,}$/.test(reference)) references.push(reference);
			else if (reference.startsWith("it(") && !/\)\s*$/.test(reference))
				references.push(reference);
			else if (
				reference.split(/\s+/).length >= 3 &&
				/^[\w][\w' -]+$/.test(reference) &&
				!/(?:failed|passed|files?|error|result)\b/i.test(reference)
			)
				references.push(reference);
		}
	}
	const cacheKey = options.headFiles
		? options.headFiles
		: (options.cwd ?? process.cwd());
	let corpus = headTestCorpusCache.get(cacheKey);
	if (corpus === undefined) {
		corpus = options.headFiles
			? [...options.headFiles]
					.filter(([file]) => file.startsWith("tests/"))
					.map(([, source]) => source)
					.join("\n")
			: null;
		headTestCorpusCache.set(cacheKey, corpus);
	}
	const exists = (reference) => {
		if (corpus !== null) return corpus.includes(reference);
		try {
			const args = ["grep", "-I", "-F", "-q", "-e", reference];
			if (!options.workingTree) args.push("HEAD");
			args.push("--", "tests");
			(options.git ?? gitExecFileSync)(args, {
				cwd: options.cwd ?? process.cwd(),
				encoding: "utf8",
			});
			return true;
		} catch {
			return false;
		}
	};
	const defined = new Set(
		[...visibleBody.matchAll(/\b([A-Za-z]\d{2,})\b\s*(?:means|=|:)/g)].map(
			(match) => match[1],
		),
	);
	return [...new Set(references)]
		.filter((reference) => !defined.has(reference))
		.filter((reference) => !exists(reference))
		.map(
			(reference) =>
				`PR body test reference is missing under tests/: ${reference}`,
		);
}

function lintMasterClaims(body) {
	const errors = [];
	const rawLines = bodyLinesOutsideFences(body);
	const original = String(body ?? "");
	const visible = rawLines.join("\n");
	const sentences = String(rawLines.join("\n")).match(/[^.!?]+[.!?]+/g) ?? [];
	for (const sentence of sentences) {
		if (
			!MASTER_CLAIM.test(sentence) ||
			/reviewer\s+(?:wrote|said)/i.test(sentence)
		)
			continue;
		if (/^\s*\|/.test(sentence.trim())) continue;
		const position = visible.indexOf(sentence);
		const after = original.slice(Math.max(0, position + sentence.length));
		if (!/```[\s\S]*origin\/master/i.test(after))
			errors.push(
				`PR body master/environment claim lacks an origin/master transcript: ${sentence.trim()}`,
			);
	}
	return errors;
}

function lintRuntimeObservability(
	body,
	lines,
	headings,
	diff,
	cwd = process.cwd(),
) {
	const observation = runtimeObservabilityFromDiff(diff);
	if (!observation.runtime) return [];
	const content = observabilitySectionContent(body, lines, headings);
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
				isAbsolute(file) ? file : resolve(cwd, file),
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
	if (
		!observation.failurePath &&
		content.includes("No new failure path; no record added.")
	)
		return [];
	if (observation.failurePath)
		return [
			`PR body Observability must name a record literal from the runtime diff${observation.records.size ? ` (${[...observation.records].join(", ")})` : ""}; "No new failure path; no record added." is not valid when the added lines contain a failure path.`,
		];
	return [
		'PR body Observability must name a record literal present in the runtime diff, or state exactly "No new failure path; no record added.".',
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
	return replaceEscapedNewlinesOutsideCodeSpans(source);
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
	return repaired;
}

/** Check the structural PR-body contract, including answered sections. */
export function lintPrBody(body = "", options = {}) {
	const rawLines = String(body ?? "").split(/\r?\n/);
	const lines = sourceWithoutFencedBlocks(body).split(/\r?\n/);
	const headings = [];
	for (let index = 0; index < lines.length; index += 1) {
		const match = HEADING.exec(lines[index]);
		if (match)
			headings.push({
				index,
				name: match[1],
				level: match[0].match(/^#+/)[0].length,
				section: SECTION_SYNONYMS.get(match[1].trim().toLowerCase()),
			});
	}
	const placeholders = templatePlaceholderLines();
	const errors = [];
	const summary = headings.find((heading) => hasSection(heading, "summary"));
	const firstHeading = headings[0]?.index ?? lines.length;
	const nextSectionHeading = (heading) =>
		headings.find(
			(candidate) =>
				candidate.index > heading.index && candidate.level <= heading.level,
		);
	const summaryEnd = summary
		? (nextSectionHeading(summary)?.index ?? lines.length)
		: 0;
	if (
		(!summary ||
			!hasRealContent(
				lines.slice(summary.index + 1, summaryEnd),
				"summary",
				placeholders,
			)) &&
		!hasRealContent(lines.slice(0, firstHeading), "summary", placeholders)
	) {
		errors.push(`PR body is missing a Summary section. See ${TEMPLATE_PATH}.`);
	}

	// Value discipline (AGENTS.md "Test assessment and removal"): a PR that
	// touches tests/ must say, per touched file, what it uniquely pins and
	// what became redundant. Conditional because docs/production-only PRs owe
	// nothing here.
	const requiredSections = options.requireTestAssessment
		? [...REQUIRED_SECTIONS, "Test assessment"]
		: REQUIRED_SECTIONS;

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
			heading.index + 1,
			nextHeading?.index ?? lines.length,
		);
		if (!hasRealContent(rawContent, name.toLowerCase(), placeholders))
			errors.push(
				sectionMessage(name, "has no content before the next heading"),
			);
	}
	if (options.diff)
		errors.push(
			...lintRuntimeObservability(
				body,
				lines,
				headings,
				options.diff,
				options.cwd,
			),
		);
	errors.push(...lintCodeCitations(body, options));
	errors.push(...lintTestReferences(body, options));
	errors.push(...lintMasterClaims(body));
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
	const token = process.env.GITHUB_TOKEN;
	if (!token) throw new Error("GITHUB_TOKEN is not set");
	const apiUrl = process.env.GITHUB_API_URL;
	const repository = process.env.GITHUB_REPOSITORY;
	if (!apiUrl || !repository)
		throw new Error("GITHUB_API_URL or GITHUB_REPOSITORY is missing");
	const response = await fetchImpl(
		`${apiUrl}/repos/${repository}/pulls/${payloadPr.number}`,
		{
			signal: AbortSignal.timeout(10_000),
			headers: {
				Accept: "application/vnd.github+json",
				Authorization: `Bearer ${token}`,
				"X-GitHub-Api-Version": "2022-11-28",
			},
		},
	);
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

/**
 * True when the PR touches any file under tests/. Advisory best-effort: one
 * page of 100 files covers this repo's PR sizes; on any failure (including a
 * PR larger than the page, detected via the Link header) return null so the
 * caller SKIPS the conditional check rather than guessing — a lint that can
 * misfire on fetch trouble teaches people to ignore it.
 */
export async function resolveTouchesTests(
	payloadPr,
	fetchImpl = globalThis.fetch,
) {
	try {
		const token = process.env.GITHUB_TOKEN;
		if (!token) throw new Error("GITHUB_TOKEN is not set");
		const apiUrl = process.env.GITHUB_API_URL;
		const repository = process.env.GITHUB_REPOSITORY;
		if (!apiUrl || !repository)
			throw new Error("GITHUB_API_URL or GITHUB_REPOSITORY is missing");
		const response = await fetchImpl(
			`${apiUrl}/repos/${repository}/pulls/${payloadPr.number}/files?per_page=100`,
			{
				signal: AbortSignal.timeout(10_000),
				headers: {
					Accept: "application/vnd.github+json",
					Authorization: `Bearer ${token}`,
					"X-GitHub-Api-Version": "2022-11-28",
				},
			},
		);
		if (!response.ok) throw new Error(`GitHub API returned ${response.status}`);
		if (/rel="next"/.test(response.headers.get("link") ?? ""))
			throw new Error(
				"PR exceeds one file page; skipping the conditional check",
			);
		const files = await response.json();
		if (!Array.isArray(files))
			throw new Error("GitHub API returned no file list");
		return files.some(
			(file) =>
				(file.filename ?? "").startsWith("tests/") ||
				// A rename OUT of tests/ reports only the new path in filename; a
				// removal PR is exactly what the assessment exists to catch.
				(file.previous_filename ?? "").startsWith("tests/"),
		);
	} catch (error) {
		console.warn(
			`::warning::Could not resolve the PR file list; skipping the Test assessment check (${error instanceof Error ? error.message : error}).`,
		);
		return null;
	}
}

function eventPayload() {
	const eventPath = process.env.GITHUB_EVENT_PATH;
	if (!eventPath) throw new Error("GITHUB_EVENT_PATH is required");
	return JSON.parse(readFileSync(eventPath, "utf8"));
}

/**
 * The full live lint: resolve body and file list, then lint. The tri-state
 * from resolveTouchesTests is consumed HERE: only an affirmative true
 * requires the Test assessment section — null (fetch trouble) and false
 * (no tests/ files) both skip it, so a flaky fetch can never misfire the
 * check (#2124 review F2 pinned this consumption).
 */
export async function lintPullRequestEvent(
	fetchImpl = globalThis.fetch,
	event = eventPayload(),
) {
	const pullRequest = event.pull_request;
	if (!pullRequest || !process.env.GITHUB_REPOSITORY)
		throw new Error("Pull request event and GITHUB_REPOSITORY are required");
	const { body, normalized } = await resolveLivePrBody(pullRequest, fetchImpl);
	const requireTestAssessment =
		(await resolveTouchesTests(pullRequest, fetchImpl)) === true;
	let diff = "";
	try {
		diff = localDiff();
	} catch (error) {
		if (process.env.GITHUB_ACTIONS) {
			const reason = error instanceof Error ? error.message : String(error);
			throw new Error(`diff unavailable: ${reason}`);
		}
		// Local callers may not have an upstream ref. Preserve structural lint
		// outside CI rather than inventing a runtime scope.
	}
	const result = lintPrBody(body, { requireTestAssessment, diff });
	if (result.valid) {
		console.log(`PR body OK: ${pullRequest.number}`);
		return { valid: true, repaired: normalized };
	}
	for (const error of result.errors) console.error(error);
	return { valid: false, repaired: false };
}

export function localDiff(cwd = process.cwd(), git = gitExecFileSync) {
	return git(["diff", "--unified=0", "--no-color", "origin/master...HEAD"], {
		cwd,
		encoding: "utf8",
	});
}

export function localTouchesTests(cwd = process.cwd(), git = gitExecFileSync) {
	let names;
	try {
		names = git(["diff", "--name-only", "origin/master...HEAD"], {
			cwd,
			encoding: "utf8",
		});
	} catch {
		names = git(["diff", "--name-only", "HEAD~1"], {
			cwd,
			encoding: "utf8",
		});
	}
	return names.split(/\r?\n/).some((name) => name.startsWith("tests/"));
}

export function lintLocalPrBody(
	body,
	cwd = process.cwd(),
	git = gitExecFileSync,
) {
	let diff;
	try {
		diff = localDiff(cwd, git);
	} catch {
		// A local preflight must use the same range as CI. If the caller has no
		// upstream ref, retain structural lint rather than inventing scope.
		diff = "";
	}
	return lintPrBody(body, {
		requireTestAssessment: localTouchesTests(cwd, git),
		diff,
		cwd,
		workingTree: true,
	});
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	// Local contract: --lint-local <body-file> remains the preflight form from
	// #2796. The equivalent --body <body-file> --title <title-file> form keeps
	// title validation in check-pr-title.mjs while accepting preflight's inputs.
	const bodyIndex = process.argv.indexOf("--body");
	const titleIndex = process.argv.indexOf("--title");
	if (bodyIndex !== -1) {
		const bodyPath = process.argv[bodyIndex + 1];
		if (!bodyPath) throw new Error("--body requires a file path");
		// --title is accepted for preflight parity. Title validation belongs to
		// check-pr-title.mjs, but preflight passes both local input files.
		if (titleIndex !== -1 && !process.argv[titleIndex + 1])
			throw new Error("--title requires a file path");
		const result = lintLocalPrBody(readFileSync(bodyPath, "utf8"));
		for (const error of result.errors) console.error(error);
		process.exitCode = result.valid ? 0 : 1;
	} else if (process.argv[2] === "--lint-local") {
		const bodyPath = process.argv[3];
		if (!bodyPath) throw new Error("--lint-local requires a file path");
		const result = lintLocalPrBody(readFileSync(bodyPath, "utf8"));
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
