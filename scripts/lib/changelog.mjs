// Shared CHANGELOG.md parsing/extraction helpers (Keep a Changelog format).
//
// One source of truth: the curated CHANGELOG section for a version IS the body
// of its GitHub release. `changelog-extract.mjs` (release workflow),
// `changelog-release.mjs` (bump-time [Unreleased] -> version move), and
// `backfill-github-releases.mjs` (retroactive release-body sync) all build on
// the pure functions here so the parsing rules stay identical everywhere.

/**
 * The per-release heading for `audience: internal` fragments (#3852). CHANGELOG.md
 * keeps the entries (inside a collapsed `<details>`); the release-notes summary
 * drops them and prints only a count.
 */
export const INTERNAL_HEADING = "Internal";

/**
 * The closed list of areas a user fragment belongs to (#5351). A fragment names
 * one id in its `area:` front matter; the release rollup groups each section's
 * entries under a `#### <title>` subheading in this order. Derived from the 98
 * user entries of 4.4.7 to 4.4.9; there is no catch-all, so a change that fits
 * none of them is a decision for the maintainer, not a new `other` entry.
 */
export const CHANGELOG_AREAS = [
	{ id: "lsp", title: "Language servers" },
	{ id: "blockers", title: "Blockers and sessions" },
	{ id: "runners", title: "Runners and scanners" },
	{ id: "rules", title: "Rules" },
	{ id: "tools", title: "Tools and reports" },
	{ id: "config", title: "Configuration and flags" },
	{ id: "install", title: "Install and updates" },
	{ id: "host", title: "Hosts and integrations" },
	{ id: "security", title: "Security" },
];

const AREA_TITLES = new Set(CHANGELOG_AREAS.map((area) => area.title));

/**
 * A section with fewer items than this renders flat in the release summary: an
 * area heading over one or two bullets costs more than it groups. CHANGELOG.md
 * always keeps the headings.
 */
export const AREA_GROUP_MIN_ITEMS = 6;

// Shape limits for `audience: user` fragments (#5351), set from the 98 user
// entries of 4.4.7 to 4.4.9: headline words p10 6, p90 16, max 19; body words
// p50 67, p90 119, max 239.
export const HEADLINE_MIN_WORDS = 4;
export const HEADLINE_MAX_WORDS = 16;
export const HEADLINE_MAX_CHARS = 100;
export const BODY_MAX_WORDS = 120;

/** Internal terms a user entry must not use (#5351); code spans are exempt. */
export const HOUSE_STYLE_BANNED_TERMS = [
	"degradation",
	"projection",
	"metrics table",
	"seam",
	"latch",
	"ledger",
];

/**
 * Verbs a headline must not open with (#5351): a headline states what changed
 * for the user ("X now does Y."), it does not give a command ("Keep X out of
 * Y."). This list is style, not a trust gate, so an unlisted imperative passes
 * and is a review finding. Verbs that double as nouns ("Read notes", "Support
 * for") are left off on purpose.
 */
export const IMPERATIVE_OPENERS = [
	"add",
	"allow",
	"avoid",
	"clean",
	"disable",
	"drop",
	"enable",
	"ensure",
	"fix",
	"handle",
	"improve",
	"keep",
	"let",
	"make",
	"move",
	"prevent",
	"refuse",
	"remove",
	"rename",
	"replace",
	"require",
	"resolve",
	"show",
	"skip",
	"stop",
	"treat",
	"use",
];

const CODE_SPAN = /`[^`]*`/g;
// A code span collapses to one private-use character so it counts as one word
// and its punctuation never reads as the headline's.
const CODE_TOKEN = "\uE000";
// A continuation line of the one-paragraph entry (#5351): two spaces, then the
// first character of running prose. Admitted: a letter; a number (`3.5`,
// `0.86.1`) not followed by a list marker (`1.` or `1)`); a code span (one
// backtick, then a non-backtick, so no fence); an opening quote or parenthesis.
// Every other first character can open a Markdown block (list, quote, table,
// heading, rule, HTML, fence), so it is refused. A deny list missed the
// backtick, tilde and compact forms in turn.
const CONTINUATION_LINE =
	/^ {2}(?:\p{L}|\d+(?:\.\d+)*(?![\d.)])|`[^`]|["'(\u201C\u2018])/u;
const TRAILING_REFS = /\s\(refs #\d+(?:, #\d+)*\)$/;

/**
 * Shape problems of one `audience: user` fragment entry (#5351), or `[]` when
 * it is the known-good form and nothing else:
 *
 *   - **Headline sentence.** One paragraph of body. (refs #N)
 *
 * A bold headline of 4 to 16 words (at most 100 characters) that is one
 * sentence ending in a period, a body that is one short paragraph starting a
 * new sentence, and at most one reference, as the trailing `(refs #N)`.
 * Everything else is refused: nested bullets, extra paragraphs, an em-dash or
 * colon after the headline, any other reference form. The house-style terms
 * and imperative openers are checked on top. Whether a headline states the
 * effect is a review judgment; the shape cannot prove it.
 *
 * @param {string} entry the entry text after the front matter
 * @returns {string[]}
 */
export function userEntryShapeProblems(entry) {
	const lines = entry.split(/\r?\n/);
	const first = lines.findIndex((line) => /^[-*]\s+\S/.test(line));
	if (first < 0) return ["no entry bullet"];
	if (lines.slice(0, first).some((line) => line.trim() !== ""))
		return [
			"the entry must open with its bullet: no heading or other text before it",
		];
	if (!lines[first].startsWith("- "))
		return ["the entry bullet must start with `- `"];
	for (const line of lines.slice(first + 1)) {
		if (!CONTINUATION_LINE.test(line))
			return [
				"the entry must be one paragraph: indent each continuation line by two spaces and start it with a letter, a number, a code span, a quote or an opening parenthesis (no blank line, list, quote, table, heading or fence)",
			];
	}
	const text = [
		lines[first].slice(2),
		...lines.slice(first + 1).map((l) => l.trim()),
	]
		.join(" ")
		.trim();
	if ((text.match(/`/g) ?? []).length % 2 !== 0) return ["unbalanced backtick"];
	// The placeholder below stands for a code span; a literal one is unresolvable.
	if (text.includes(CODE_TOKEN))
		return ["the private-use character U+E000 is not allowed in an entry"];
	const plain = text.replace(CODE_SPAN, CODE_TOKEN);
	const withoutRefs = plain.replace(TRAILING_REFS, "");
	const problems = [];
	if (/#\d|\b(?:issues|pull|discussions)\/\d|\bGH-\d/i.test(withoutRefs))
		problems.push(
			"references take one form: a single trailing `(refs #N)` after the body (several issues as `(refs #N, #M)`)",
		);
	const head = withoutRefs.match(/^\*\*([^*]+)\*\*(?=\s|$)(.*)$/);
	if (!head) {
		problems.push("the entry must open with a bold headline sentence");
		return problems;
	}
	const [, headline, rest] = head;
	if (!headline.endsWith("."))
		problems.push("the bold headline must end with a period");
	const sentence = headline.replace(/\.$/, "");
	if (/[.!?](?=\s|$)|[:;\u2013\u2014]/.test(sentence))
		problems.push(
			"the bold headline must be one sentence, with no colon, semicolon or dash",
		);
	const words = sentence.trim().split(/\s+/);
	if (words.length < HEADLINE_MIN_WORDS || words.length > HEADLINE_MAX_WORDS)
		problems.push(
			`the bold headline must be ${HEADLINE_MIN_WORDS} to ${HEADLINE_MAX_WORDS} words, found ${words.length}`,
		);
	// The cap counts the headline as a reader sees it: each code span back in,
	// its backticks out. `headline` holds a placeholder per span, so measuring it
	// would count a long span as one character.
	const spans = text.match(CODE_SPAN) ?? [];
	let nextSpan = 0;
	const rendered = headline.replaceAll(
		CODE_TOKEN,
		() => spans[nextSpan++]?.slice(1, -1) ?? CODE_TOKEN,
	);
	// The release summary cuts the bold at its first `**`, code span or not.
	if (rendered.includes("**"))
		problems.push(
			"the bold headline must not contain `**`, even inside a code span; move it to the body",
		);
	if (rendered.length > HEADLINE_MAX_CHARS)
		problems.push(
			`the bold headline must be at most ${HEADLINE_MAX_CHARS} characters`,
		);
	if (IMPERATIVE_OPENERS.includes(words[0].toLowerCase()))
		problems.push(
			`the headline states what changed for the user, so it must not open with the imperative "${words[0]}"`,
		);
	const body = rest.trim();
	if (rest !== "" && !/^ \S/.test(rest))
		problems.push("put one space between the headline and the body");
	if (body) {
		if (!new RegExp(`^[A-Z0-9${CODE_TOKEN}]`).test(body))
			problems.push(
				"the body must start a new sentence (no dash or colon after the headline)",
			);
		if (!body.endsWith("."))
			problems.push("the body must end with a period, before any `(refs #N)`");
		const bodyWords = body.split(/\s+/).length;
		if (bodyWords > BODY_MAX_WORDS)
			problems.push(
				`the body must be at most ${BODY_MAX_WORDS} words, found ${bodyWords}`,
			);
	}
	const banned = HOUSE_STYLE_BANNED_TERMS.filter((term) =>
		new RegExp(`\\b${term.replace(" ", "\\s+")}(?:s|es)?\\b`, "i").test(plain),
	);
	if (banned.length)
		problems.push(
			`internal terms do not belong in a user entry: ${banned.join(", ")}`,
		);
	return problems;
}

/** A version heading looks like `## [3.8.60] - 2026-06-21` or `## [Unreleased]`. */
const VERSION_HEADING = /^## \[([^\]]+)\]/;

/**
 * Split a CHANGELOG into ordered sections. Each entry is the bracketed label
 * (e.g. `3.8.60`, `Unreleased`) plus the raw body between this heading and the
 * next `## ` heading (heading line excluded, surrounding blank lines trimmed).
 *
 * Duplicate labels are kept in document order; `extractSection` returns the
 * first, which is what we want for the stray `## [3.7.2] ... (previous)` dupe.
 *
 * @param {string} text full CHANGELOG.md contents
 * @returns {Array<{ label: string, heading: string, body: string }>}
 */
export function parseSections(text) {
	const lines = text.split(/\r?\n/);
	const sections = [];
	let current = null;
	for (const line of lines) {
		const m = line.match(VERSION_HEADING);
		if (m) {
			if (current) sections.push(finalize(current));
			current = { label: m[1].trim(), heading: line, bodyLines: [] };
			continue;
		}
		if (current) current.bodyLines.push(line);
	}
	if (current) sections.push(finalize(current));
	return sections;
}

function finalize(current) {
	return {
		label: current.label,
		heading: current.heading,
		body: current.bodyLines.join("\n").replace(/^\n+/, "").replace(/\s+$/, ""),
	};
}

/**
 * Bucket a section body's top-level entries under their `### ` headings. This is
 * the one parse behind summarizeSection and the user-changelog count line (#5264),
 * so the release notes and the count cannot drift. Same-named headings merge and
 * keep first-seen order; entries before the first heading are skipped; `### Internal`
 * entries are counted, not bucketed. A `#### <area title>` line under a section
 * heading (#5351) names the area of the entries below it: `areas` holds, per
 * section, the area title of each bucket item (`null` before any area heading).
 * Any other `####` line is an ordinary heading, as before.
 *
 * @param {string} body a section body from extractSection()
 * @param {{ maxGist?: number, gist?: boolean }} [opts]
 * @returns {{ order: string[], buckets: Map<string, string[]>, areas: Map<string, Array<string | null>>, internalCount: number }}
 */
export function parseSectionEntries(body, opts = {}) {
	const maxGist = opts.maxGist ?? 220;
	// Bucket entries under canonical subheadings, merging same-named headings
	// (a section may carry two `### Added` blocks) and preserving first-seen order.
	const order = [];
	const buckets = new Map();
	const areas = new Map();
	let heading = null;
	let area = null;
	let internalCount = 0;
	const lines = body.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		let line = lines[i].trimEnd();
		const h = line.match(/^(#{2,4})\s+(.*)$/);
		if (h) {
			const title = h[2].trim();
			if (h[1] === "####" && heading !== null && AREA_TITLES.has(title)) {
				area = title;
				continue;
			}
			heading = title;
			area = null;
			if (!buckets.has(heading)) {
				buckets.set(heading, []);
				areas.set(heading, []);
				order.push(heading);
			}
			continue;
		}
		// Only top-level entries; nested/continuation lines are skipped.
		if (heading === null) continue;
		if (heading === INTERNAL_HEADING) {
			if (/^[-*]\s+\S/.test(line)) internalCount++;
			continue;
		}
		const entry = line.match(/^- (\S.*)$/);
		if (entry) {
			let text = entry[1];
			let next = i + 1;
			while (next < lines.length) {
				const continuation = lines[next].trimEnd();
				if (
					continuation.trim() === "" ||
					/^#{2,4}\s+/.test(continuation) ||
					/^-\s+/.test(continuation) ||
					/^\s+-\s+/.test(continuation)
				)
					break;
				text += ` ${continuation.trim()}`;
				next++;
			}
			i = next - 1;
			line = `- ${text}`;
		}
		const bold = line.match(/^- (\*\*.+?\*\*)\s*(.*)$/);
		if (bold) {
			const gist = opts.gist ? cleanGist(bold[2], maxGist) : "";
			// The shape check moves the reference out of the bold headline to the
			// end of the entry; keep it in the summary so the release body links it.
			let ref = trailingRefs(line);
			if (bold[1].includes(ref.trim())) ref = "";
			buckets
				.get(heading)
				.push(`${gist ? `- ${bold[1]} — ${gist}` : `- ${bold[1]}`}${ref}`);
			areas.get(heading).push(area);
			continue;
		}
		const plain = line.match(/^- (\S.*)$/);
		if (!plain) continue;
		buckets.get(heading).push(`- ${plainGist(plain[1])}`);
		areas.get(heading).push(area);
	}
	return { order, buckets, areas, internalCount };
}

/**
 * Condense a section body into scannable release notes: keep the `### Added/
 * Changed/Fixed` subheadings and every top-level entry, trimmed to a short
 * one-liner. Bold-titled entries (`- **Title** …`) keep the title (plus a
 * short gist when one exists); plain entries (`- perf: …`) keep their whole
 * first sentence — dropping them entirely (the pre-3.8.67 behavior) made a
 * perf-heavy release body show none of its perf work. The full prose stays
 * in CHANGELOG.md; this is what the GitHub release body shows so a release
 * reads as a summary, not a wall of implementation detail. The `### Internal`
 * block (#3852) is not shown: a one-line count replaces it.
 *
 * @param {string} body a section body from extractSection()
 * @param {{ maxGist?: number, gist?: boolean }} [opts]
 * @returns {string}
 */
export function summarizeSection(body, opts = {}) {
	const { order, buckets, areas, internalCount } = parseSectionEntries(
		body,
		opts,
	);
	const out = [];
	for (const h of order) {
		const items = buckets.get(h);
		if (!items.length) continue;
		out.push(`### ${h}`, "");
		const itemAreas = areas.get(h);
		if (
			items.length < AREA_GROUP_MIN_ITEMS ||
			itemAreas.every((a) => a === null)
		) {
			out.push(...items, "");
			continue;
		}
		// Area groups: entries with no area first, then each area in first-seen
		// order, so a bullet never reads as belonging to the heading above it.
		for (const group of [
			null,
			...new Set(itemAreas.filter((a) => a !== null)),
		]) {
			const grouped = items.filter((_, i) => itemAreas[i] === group);
			if (!grouped.length) continue;
			if (group !== null) out.push(`#### ${group}`, "");
			out.push(...grouped, "");
		}
	}
	if (internalCount > 0) {
		out.push(
			`Plus ${internalCount} internal ${internalCount === 1 ? "change" : "changes"}: tests, CI, tooling, and refactors.`,
		);
	}
	return out.join("\n").replace(/^\n+/, "").replace(/\s+$/, "");
}

// The entry's trailing `(refs #N)` group as ` (refs #N)`, or "".
function trailingRefs(line) {
	return line.match(/\s\(refs #\d+(?:, #\d+)*\)$/)?.[0] ?? "";
}

// Condense a plain (non-bold-titled) entry to its whole first sentence.
// Trailing `(#NNN)` refs from the original are re-appended so the release
// still links its issues. Do not cut at clauses or impose a character cap:
// those cuts turned wrapped changelog prose into misleading fragments.
function plainGist(text) {
	const refs = [...text.matchAll(/\((?:refs?|closes?|fixes?)?\s*#\d+\)/gi)].map(
		(m) => m[0],
	);
	const gist = firstSentence(text);
	const missing = refs.filter((r) => !gist.includes(r));
	return missing.length ? `${gist} ${missing.join(" ")}` : gist;
}

function firstSentence(text) {
	let code = false;
	let parentheses = 0;
	for (let i = 0; i < text.length; i++) {
		const char = text[i];
		if (char === "`") {
			code = !code;
			continue;
		}
		if (code) continue;
		if (char === "(") {
			parentheses++;
			continue;
		}
		if (char === ")") {
			parentheses = Math.max(0, parentheses - 1);
			continue;
		}
		if (parentheses > 0 || !/[.!?]/.test(char)) continue;
		if (char === "." && ignoredPeriod(text, i)) continue;
		if (i + 1 === text.length || /\s/.test(text[i + 1])) {
			return text.slice(0, i + 1).trim();
		}
	}
	return text.trim();
}

function ignoredPeriod(text, index) {
	const before = text.slice(0, index + 1);
	if (/(?:^|\s)(?:e\.g|i\.e)\.$/i.test(before)) return true;
	return /(?:^|\s)v?\d+(?:\.\d+)+\.$/i.test(before);
}

// Return a short, clean one-clause gist, or "" if no clean short form exists
// (a truncated wall-of-text with a trailing "…" reads worse than just the
// self-describing title, so we omit it rather than cut mid-sentence).
function cleanGist(rest, maxGist) {
	const text = rest
		.replace(/^\s*\((?:refs?|closes?|fixes?)?\s*#\d+\)\s*/i, "") // leading (#NNN)
		.replace(/^\s*[—–:-]\s*/, "")
		.trim();
	if (!text) return "";
	const period = text.search(/\.\s/);
	const first = period >= 0 ? text.slice(0, period) : text;
	return first.length > 0 && first.length <= maxGist ? first : "";
}

/**
 * Normalize a tag/version to its bare semver form: `v3.8.60` -> `3.8.60`.
 * @param {string} version
 */
export function normalizeVersion(version) {
	return String(version).trim().replace(/^v/i, "");
}

/**
 * Return the curated release-notes body for a version (heading excluded), or
 * `null` if no matching `## [version]` section exists. Accepts `v`-prefixed or
 * bare versions. The match is on the bracket label only, so a ` - <date>`
 * suffix on the heading is ignored.
 *
 * @param {string} text full CHANGELOG.md contents
 * @param {string} version e.g. "3.8.60" or "v3.8.60"
 * @returns {string | null}
 */
export function extractSection(text, version) {
	const want = normalizeVersion(version);
	const section = parseSections(text).find(
		(s) => normalizeVersion(s.label) === want,
	);
	return section ? section.body : null;
}

/** True if the CHANGELOG has a non-empty section for this version. */
export function hasSection(text, version) {
	const body = extractSection(text, version);
	return typeof body === "string" && body.trim().length > 0;
}

/**
 * Lint a section body for entries the release-notes summarizer
 * (`summarizeSection`) would silently mangle. Returns a list of problems; an
 * empty list means clean. Two failure modes, both learned from real broken
 * v3.8.74 release notes:
 *
 *   1. `orphan` — a top-level `- ` entry that appears BEFORE the first `### `
 *      category heading. `summarizeSection` only emits entries under a heading
 *      (it skips lines while `heading === null`), so an orphan entry is dropped
 *      from the release body entirely.
 *   2. `wrapped-title` — a `- **…` entry whose bold title's closing `**` is not
 *      on the same physical line as the opening. `summarizeSection` reads only
 *      the entry's first line and emits only the text inside `**…**`, so a
 *      wrapped title renders truncated AND drops any `(refs #NNN)` that trails
 *      onto the continuation line. The summarizer now joins continuation lines;
 *      this lint remains because wrapped titles are still poor release-note
 *      input.
 *
 * Line numbers are 1-based within the passed body.
 *
 * @param {string} body a section body (e.g. `extractSection(text, "Unreleased")`)
 * @returns {Array<{ kind: "orphan" | "wrapped-title", line: number, text: string }>}
 */
export function lintSectionBody(body) {
	const problems = [];
	if (typeof body !== "string") return problems;
	const lines = body.split(/\r?\n/);
	let seenHeading = false;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trimEnd();
		if (/^#{2,4}\s/.test(line)) {
			seenHeading = true;
			continue;
		}
		// Only column-0 `- ` bullets are top-level entries; indented continuation
		// lines (tab/space + `-`) are part of the preceding entry's prose.
		const entry = line.match(/^-\s+(.*)$/);
		if (!entry) continue;
		if (!seenHeading) {
			problems.push({ kind: "orphan", line: i + 1, text: entry[1] });
		}
		if (entry[1].startsWith("**") && (line.match(/\*\*/g) || []).length < 2) {
			problems.push({ kind: "wrapped-title", line: i + 1, text: entry[1] });
		}
	}
	return problems;
}

/**
 * Lint the `## [Unreleased]` section — the one authors edit per-PR — so a
 * malformed entry is caught at PR time instead of at release. `[]` when clean.
 * See {@link lintSectionBody} for the two problem kinds.
 *
 * @param {string} text full CHANGELOG.md contents
 * @returns {ReturnType<typeof lintSectionBody>}
 */
export function lintUnreleased(text) {
	return lintSectionBody(extractSection(text, "Unreleased"));
}

export const EMPTY_UNRELEASED = [
	"## [Unreleased]",
	"",
	"### Added",
	"",
	"### Changed",
	"",
	"### Deprecated",
	"",
	"### Removed",
	"",
	"### Fixed",
	"",
	"### Security",
].join("\n");
