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
	const maxGist = opts.maxGist ?? 220;
	// Bucket entries under canonical subheadings, merging same-named headings
	// (a section may carry two `### Added` blocks) and preserving first-seen order.
	const order = [];
	const buckets = new Map();
	let heading = null;
	let internalCount = 0;
	const lines = body.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		let line = lines[i].trimEnd();
		const h = line.match(/^#{2,4}\s+(.*)$/);
		if (h) {
			heading = h[1].trim();
			if (!buckets.has(heading)) {
				buckets.set(heading, []);
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
			buckets
				.get(heading)
				.push(gist ? `- ${bold[1]} — ${gist}` : `- ${bold[1]}`);
			continue;
		}
		const plain = line.match(/^- (\S.*)$/);
		if (!plain) continue;
		buckets.get(heading).push(`- ${plainGist(plain[1])}`);
	}
	const out = [];
	for (const h of order) {
		const items = buckets.get(h);
		if (!items.length) continue;
		out.push(`### ${h}`, "", ...items, "");
	}
	if (internalCount > 0) {
		out.push(
			`Plus ${internalCount} internal ${internalCount === 1 ? "change" : "changes"}: tests, CI, tooling, and refactors.`,
		);
	}
	return out.join("\n").replace(/^\n+/, "").replace(/\s+$/, "");
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
