/**
 * Tests for scripts/lib/changelog.mjs — the CHANGELOG section parser that backs
 * the release-notes pipeline (changelog-extract.mjs / changelog-release.mjs /
 * backfill-github-releases.mjs).
 *
 * Also exercises the real repo CHANGELOG.md so the contract — "every released
 * tag has a non-empty curated section" — is regression-guarded, plus the
 * changelog-extract.mjs CLI end-to-end.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  parseSections,
  normalizeVersion,
  extractSection,
  hasSection,
  unreleasedHasEntries,
  promoteUnreleased,
  summarizeSection,
} from "../../scripts/lib/changelog.mjs";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const EXTRACT_CLI = path.join(REPO_ROOT, "scripts/changelog-extract.mjs");
const CHANGELOG = fs.readFileSync(
  path.join(REPO_ROOT, "CHANGELOG.md"),
  "utf8",
);

const SAMPLE = [
  "# Changelog",
  "",
  "## [Unreleased]",
  "",
  "### Added",
  "",
  "- **New thing** — does a thing.",
  "",
  "## [3.8.60] - 2026-06-21",
  "",
  "### Fixed",
  "",
  "- **A fix** — fixes it.",
  "",
  "## [3.7.2] - 2026-04-05",
  "",
  "- First 3.7.2 (the real one).",
  "",
  "## [3.7.2] - 2026-04-05 (previous)",
  "",
  "- Stale duplicate that must be ignored.",
  "",
].join("\n");

describe("changelog lib — parsing", () => {
  it("normalizes v-prefixed and bare versions", () => {
    expect(normalizeVersion("v3.8.60")).toBe("3.8.60");
    expect(normalizeVersion("3.8.60")).toBe("3.8.60");
    expect(normalizeVersion("  V3.8.60  ")).toBe("3.8.60");
  });

  it("splits sections in document order and trims bodies", () => {
    const sections = parseSections(SAMPLE);
    expect(sections.map((s) => s.label)).toEqual([
      "Unreleased",
      "3.8.60",
      "3.7.2",
      "3.7.2",
    ]);
    expect(sections[1].body).toBe("### Fixed\n\n- **A fix** — fixes it.");
  });

  it("extracts by exact label, ignoring the ` - <date>` suffix", () => {
    expect(extractSection(SAMPLE, "3.8.60")).toContain("- **A fix**");
    expect(extractSection(SAMPLE, "v3.8.60")).toContain("- **A fix**");
  });

  it("returns the FIRST section for a duplicated label", () => {
    expect(extractSection(SAMPLE, "3.7.2")).toBe(
      "- First 3.7.2 (the real one).",
    );
  });

  it("returns null for a missing version", () => {
    expect(extractSection(SAMPLE, "9.9.9")).toBeNull();
    expect(hasSection(SAMPLE, "9.9.9")).toBe(false);
    expect(hasSection(SAMPLE, "3.8.60")).toBe(true);
  });
});

describe("changelog lib — promoteUnreleased", () => {
  it("moves Unreleased to a dated section and opens a fresh empty one", () => {
    const next = promoteUnreleased(SAMPLE, "3.8.61", "2026-06-25");
    // New empty Unreleased on top, with no bullets yet.
    expect(unreleasedHasEntries(next)).toBe(false);
    // The old entries now live under the dated version.
    expect(extractSection(next, "3.8.61")).toContain("- **New thing**");
    expect(next).toContain("## [3.8.61] - 2026-06-25");
    // Older sections are untouched.
    expect(extractSection(next, "3.8.60")).toContain("- **A fix**");
  });

  it("refuses when Unreleased has no entries", () => {
    const emptyUnreleased = SAMPLE.replace(
      "- **New thing** — does a thing.",
      "",
    );
    expect(() =>
      promoteUnreleased(emptyUnreleased, "3.8.61", "2026-06-25"),
    ).toThrow(/no entries/i);
  });

  it("refuses to overwrite an existing version section", () => {
    expect(() => promoteUnreleased(SAMPLE, "3.8.60", "2026-06-25")).toThrow(
      /already has a section/i,
    );
  });
});

describe("changelog lib — summarizeSection", () => {
  const VERBOSE = [
    "### Added",
    "",
    "- **First feature (#10)** — a long-winded explanation that goes on. And on. And on with detail.",
    "  - a nested continuation line that must be dropped",
    "",
    "### Fixed",
    "",
    "- **A fix (#20)** — short.",
    "",
    "### Added",
    "",
    "- **Second feature** — more detail here.",
    "",
  ].join("\n");

  it("keeps titles, drops prose, and merges same-named subheadings", () => {
    const s = summarizeSection(VERBOSE);
    // Two `### Added` blocks merge into one, in first-seen order before Fixed.
    expect(s.match(/### Added/g)).toHaveLength(1);
    expect(s.indexOf("### Added")).toBeLessThan(s.indexOf("### Fixed"));
    expect(s).toContain("- **First feature (#10)**");
    expect(s).toContain("- **Second feature**");
    expect(s).toContain("- **A fix (#20)**");
    // Default is titles-only: the prose and nested lines are gone.
    expect(s).not.toContain("long-winded");
    expect(s).not.toContain("nested continuation");
  });

  it("includes a short clean gist when opts.gist is set", () => {
    const s = summarizeSection(VERBOSE, { gist: true });
    expect(s).toContain("- **A fix (#20)** — short");
  });
});

describe("repo CHANGELOG.md contract", () => {
  it("has an Unreleased section with pending entries", () => {
    expect(unreleasedHasEntries(CHANGELOG)).toBe(true);
  });

  // The CHANGELOG begins at the 3.x line; pre-3.x tags predate it (the backfill
  // script skips them). Guard the era the CHANGELOG actually covers: no v3.*
  // tag may be missing a curated section.
  it("every v3.* git tag has a non-empty CHANGELOG section", () => {
    const tags = execFileSync("git", ["tag", "--list", "v3.*"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    })
      .split(/\r?\n/)
      .map((t) => t.trim())
      .filter(Boolean);
    // CI checks out shallow with no tags fetched, so the tag list is empty
    // there — this contract is a local pre-push guard; skip when no tags exist
    // (the release workflow's "Verify changelog entry exists" step covers the
    // real risk of a tagged version missing its section).
    if (tags.length === 0) return;
    const missing = tags.filter((t) => !hasSection(CHANGELOG, t));
    expect(missing).toEqual([]);
  });

  it("changelog-extract.mjs CLI prints the curated section", () => {
    const out = execFileSync("node", [EXTRACT_CLI, "3.8.60"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    expect(out).toContain("### Added");
    expect(out.trim().length).toBeGreaterThan(0);
  });

  it("changelog-extract.mjs CLI exits non-zero for a missing version", () => {
    expect(() =>
      execFileSync("node", [EXTRACT_CLI, "9.9.9"], {
        cwd: REPO_ROOT,
        stdio: "pipe",
      }),
    ).toThrow();
  });
});
