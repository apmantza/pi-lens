// Shared CHANGELOG.md parsing/extraction helpers (Keep a Changelog format).
//
// One source of truth: the curated CHANGELOG section for a version IS the body
// of its GitHub release. `changelog-extract.mjs` (release workflow),
// `changelog-release.mjs` (bump-time [Unreleased] -> version move), and
// `backfill-github-releases.mjs` (retroactive release-body sync) all build on
// the pure functions here so the parsing rules stay identical everywhere.

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
 * Changed/Fixed` subheadings and each entry's bold title, but trim the entry to
 * a single short gist (first sentence, length-capped). The full prose stays in
 * CHANGELOG.md; this is what the GitHub release body shows so a release reads as
 * a summary, not a wall of implementation detail.
 *
 * @param {string} body a section body from extractSection()
 * @param {{ maxGist?: number }} [opts]
 * @returns {string}
 */
export function summarizeSection(body, opts = {}) {
  const maxGist = opts.maxGist ?? 130;
  // Bucket entries under canonical subheadings, merging same-named headings
  // (a section may carry two `### Added` blocks) and preserving first-seen order.
  const order = [];
  const buckets = new Map();
  let heading = null;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const h = line.match(/^#{2,4}\s+(.*)$/);
    if (h) {
      heading = h[1].trim();
      if (!buckets.has(heading)) {
        buckets.set(heading, []);
        order.push(heading);
      }
      continue;
    }
    // Only top-level entries (`- **Title** …`); skip nested/continuation lines.
    const m = line.match(/^- (\*\*.+?\*\*)\s*(.*)$/);
    if (!m || heading === null) continue;
    const gist = opts.gist ? cleanGist(m[2], maxGist) : "";
    buckets.get(heading).push(gist ? `- ${m[1]} — ${gist}` : `- ${m[1]}`);
  }
  const out = [];
  for (const h of order) {
    const items = buckets.get(h);
    if (!items.length) continue;
    out.push(`### ${h}`, "", ...items, "");
  }
  return out.join("\n").replace(/^\n+/, "").replace(/\s+$/, "");
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

/** True if the `## [Unreleased]` body has at least one bullet entry. */
export function unreleasedHasEntries(text) {
  const body = extractSection(text, "Unreleased");
  return body !== null && /^\s*[-*]\s/m.test(body);
}

const EMPTY_UNRELEASED = [
  "## [Unreleased]",
  "",
  "### Added",
  "",
  "### Changed",
  "",
  "### Fixed",
  "",
].join("\n");

/**
 * Promote `## [Unreleased]` to a dated `## [version] - date` heading and open a
 * fresh empty `## [Unreleased]` above it. Pure: returns the new CHANGELOG text.
 * Throws on the precondition failures (no Unreleased, no entries, version
 * already present) so callers surface a clear message and exit non-zero.
 *
 * @param {string} text full CHANGELOG.md contents
 * @param {string} version bare semver, e.g. "3.8.61"
 * @param {string} date ISO date, e.g. "2026-06-25"
 * @returns {string}
 */
export function promoteUnreleased(text, version, date) {
  if (extractSection(text, "Unreleased") === null)
    throw new Error("No `## [Unreleased]` section found.");
  if (!unreleasedHasEntries(text))
    throw new Error("`## [Unreleased]` has no entries to release.");
  if (extractSection(text, version) !== null)
    throw new Error(`CHANGELOG already has a section for ${version}.`);

  const replaced = text.replace(
    /^## \[Unreleased\][^\n]*$/m,
    `${EMPTY_UNRELEASED}\n## [${version}] - ${date}`,
  );
  if (replaced === text)
    throw new Error("Failed to locate the `## [Unreleased]` heading.");
  return replaced;
}
