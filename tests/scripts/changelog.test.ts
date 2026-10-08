/**
 * Tests for scripts/lib/changelog.mjs — the CHANGELOG section parser that backs
 * the release-notes pipeline (changelog-extract.mjs / changelog-release.mjs /
 * backfill-github-releases.mjs).
 *
 * Also exercises the real repo CHANGELOG.md so the contract — "every released
 * tag has a non-empty curated section" — is regression-guarded, plus the
 * changelog-extract.mjs CLI end-to-end.
 */

import { execFileSync } from "../support/git-fixture-env.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	parseSections,
	normalizeVersion,
	extractSection,
	hasSection,
	summarizeSection,
	lintSectionBody,
	lintUnreleased,
} from "../../scripts/lib/changelog.mjs";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const EXTRACT_CLI = path.join(REPO_ROOT, "scripts/changelog-extract.mjs");
const CHANGELOG = fs.readFileSync(path.join(REPO_ROOT, "CHANGELOG.md"), "utf8");

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

	// Plain (non-bold-titled) bullets were silently dropped before 3.8.67 —
	// a release whose headline was `- perf: …` entries showed none of them.
	const PLAIN = [
		"### Changed",
		"",
		"- perf: cascade diagnostics now run concurrently after each edit instead of blocking the write pipeline (~26% median per-edit latency reduction); settled at turn_end with a bounded wait. (#450)",
		"- perf: short one (#453)",
		"  - nested continuation stays dropped",
		"",
	].join("\n");

	it("keeps plain bullets through their whole first sentence", () => {
		const s = summarizeSection(PLAIN);
		expect(s).toContain("### Changed");
		// The complete first sentence survives; clause tails are not cut away.
		expect(s).toContain(
			"- perf: cascade diagnostics now run concurrently after each edit instead of blocking the write pipeline (~26% median per-edit latency reduction); settled at turn_end with a bounded wait. (#450)",
		);
		expect(s).toContain("- perf: short one (#453)");
		expect(s).not.toContain("nested continuation");
	});

	it("re-appends trailing issue refs cut off by the clause boundary", () => {
		const s = summarizeSection(PLAIN);
		const line = s.split("\n").find((l) => l.includes("cascade diagnostics"));
		expect(line).toContain("(#450)");
	});

	it("joins wrapped plain entries before choosing a complete gist", () => {
		const body = [
			"### Fixed",
			"",
			"- A file with no project marker (no `package.json`, `Cargo.toml` and the like",
			"  above it) no longer re-walks every ancestor directory on each lookup.",
			"",
		].join("\n");
		const line = summarizeSection(body)
			.split("\n")
			.find((candidate) => candidate.startsWith("- A file"));
		expect(line).toBe(
			"- A file with no project marker (no `package.json`, `Cargo.toml` and the like above it) no longer re-walks every ancestor directory on each lookup.",
		);
	});

	it("joins wrapped bold gist text and preserves refs on continuation lines", () => {
		const body = [
			"### Fixed",
			"",
			"- **Wrapped fix (#77)** — The first sentence continues onto",
			"  the next line and remains a complete gist (refs #88). More detail.",
			"",
		].join("\n");
		expect(summarizeSection(body, { gist: true })).toContain(
			"- **Wrapped fix (#77)** — The first sentence continues onto the next line and remains a complete gist (refs #88)",
		);
	});

	it("stops joining at adjacent top-level bullets and headings", () => {
		const body = [
			"### Fixed",
			"",
			"- First entry remains separate.",
			"- Second entry remains separate.",
			"### Added",
			"- A following heading remains reachable.",
		].join("\n");
		const summary = summarizeSection(body);
		expect(summary).toContain("- First entry remains separate.");
		expect(summary).toContain("- Second entry remains separate.");
		expect(summary).toContain("### Added");
		expect(summary).toContain("- A following heading remains reachable.");
	});

	it("summarizes the released 4.4.0 section without physical-line fragments", () => {
		const body = extractSection(CHANGELOG, "4.4.0");
		expect(body).not.toBeNull();
		const summary = summarizeSection(body!);
		// A literal command ellipsis is valid; hard-truncation ellipses are not.
		expect(summary).not.toMatch(/ …|…$/m);
		expect(summary).toContain("re-registers on its next heartbeat");
		for (const fragment of [
			"pi 1.0.x and 1.1.x are now verified release-QA hosts, and the published",
			"A file with no project marker (no `package.json`, `Cargo.toml` and the like",
			"A pi-lens session whose instance-registry entry went missing",
			"The durable-store lock (dispositions and actionable warnings) no longer lets",
			"The shared tools install lock no longer lets two sessions install at once",
			"The quarantine lock (the probe cache, the tool-refresh state and the orphan",
		]) {
			expect(summary.split("\n")).not.toContain(`- ${fragment}`);
		}
		for (const line of summary
			.split("\n")
			.filter((value) => value.startsWith("- "))) {
			expect(line).not.toMatch(
				/(?:and the published|and the like|went missing|no longer lets|at once|the orphan)$/,
			);
		}
	});

	it("keeps an unbroken over-long plain bullet instead of hard-truncating", () => {
		const long = `### Fixed\n\n- ${"word ".repeat(60).trim()} (#99)\n`;
		const s = summarizeSection(long);
		const line = s.split("\n").find((l) => l.startsWith("- word"));
		expect(line).toBeDefined();
		expect(line).toContain("word ".repeat(59));
		expect(line).not.toContain("…");
		expect(line).toContain("(#99)");
	});

	it("keeps a plain entry through an em-dash parenthetical", () => {
		const body = [
			"### Fixed",
			"",
			"- The session registry keeps its identity stable while restarting — including its lock — and now re-registers on its next heartbeat, using its original root.",
			"",
		].join("\n");
		expect(summarizeSection(body)).toContain(
			"- The session registry keeps its identity stable while restarting — including its lock — and now re-registers on its next heartbeat, using its original root.",
		);
	});

	it("ignores periods in code spans, abbreviations, and version numbers", () => {
		const body = [
			"### Fixed",
			"",
			"- The parser keeps the code token `a. b` intact before returning a result. Later details are omitted.",
			"- The parser keeps parenthetical notes (the old path. still works) before returning a result. Later details are omitted.",
			"- The release bumps to 1.2. before continuing with the migration. Later details are omitted.",
			"",
		].join("\n");
		const summary = summarizeSection(body);
		expect(summary).toContain(
			"- The parser keeps the code token `a. b` intact before returning a result.",
		);
		expect(summary).toContain(
			"- The parser keeps parenthetical notes (the old path. still works) before returning a result.",
		);
		expect(summary).toContain(
			"- The release bumps to 1.2. before continuing with the migration.",
		);
	});

	it("keeps the bold gist default below its documented cap", () => {
		const gist = "word ".repeat(35).trim();
		const body = `### Fixed\n\n- **Long title** — ${gist}. More detail.`;
		const summary = summarizeSection(body, { gist: true });
		expect(summary).toContain(`- **Long title** — ${gist}`);
		expect(summary).not.toContain("…");
	});
});

// The linter mirrors the two ways summarizeSection silently mangled the
// v3.8.74 release notes: entries added above the first `### ` heading were
// dropped, and hard-wrapped bold titles rendered truncated without their refs.
describe("changelog lib — lintSectionBody / lintUnreleased", () => {
	it("passes a well-formed section", () => {
		const body = [
			"### Added",
			"",
			"- **A new thing (#10)** — with prose that wraps",
			"  onto a continuation line, which is fine.",
			"",
			"### Fixed",
			"",
			"- **A fix (refs #20, closes #20)** — details.",
			"",
		].join("\n");
		expect(lintSectionBody(body)).toEqual([]);
	});

	it("flags an orphan entry above the first `### ` heading", () => {
		const body = [
			"- **Dropped by the summarizer (#1)** — no heading above it.",
			"",
			"### Fixed",
			"",
			"- **A fix (#2)** — fine.",
			"",
		].join("\n");
		const problems = lintSectionBody(body);
		expect(problems).toHaveLength(1);
		expect(problems[0].kind).toBe("orphan");
		expect(problems[0].text).toContain("Dropped by the summarizer");
	});

	it("flags a bold title whose `**` does not close on the first line", () => {
		const body = [
			"### Fixed",
			"",
			"- **A title that wraps across a line break",
			"  and only closes here (refs #33)** — prose.",
			"",
		].join("\n");
		const problems = lintSectionBody(body);
		expect(problems).toHaveLength(1);
		expect(problems[0].kind).toBe("wrapped-title");
	});

	it("does not flag indented continuation lines that start with `-`", () => {
		const body = [
			"### Changed",
			"",
			"- **Real entry (#4)** — a list follows:",
			"  - an indented sub-bullet, not a top-level entry",
			"  - another one",
			"",
		].join("\n");
		expect(lintSectionBody(body)).toEqual([]);
	});

	it("reports both problem kinds together", () => {
		const body = [
			"- **Orphan and wrapped at once",
			"  closes here (#5)** — prose.",
			"",
			"### Fixed",
			"",
			"- **Clean (#6)** — ok.",
			"",
		].join("\n");
		const kinds = lintSectionBody(body)
			.map((p) => p.kind)
			.sort();
		expect(kinds).toEqual(["orphan", "wrapped-title"]);
	});

	it("treats a null/missing body as clean", () => {
		// extractSection returns null for an absent section.
		expect(lintUnreleased("# Changelog\n\nno sections here")).toEqual([]);
		expect(lintSectionBody(null)).toEqual([]);
	});
});

describe("repo CHANGELOG.md contract", () => {
	it("has an Unreleased section (may be empty right after a release bump)", () => {
		// Existence, not entries: `changelog:release` opens a fresh EMPTY section.
		// `npm run changelog:check` validates PR-authored `.changelog/` entries
		// instead of requiring legacy bullets under [Unreleased].
		expect(extractSection(CHANGELOG, "Unreleased")).not.toBeNull();
	});

	// Regression guard for the v3.8.74 release-notes breakage: new entries must be
	// authored so the summarizer can render them — under a `### ` heading and with
	// a single-line bold title. Fails at PR time on a malformed [Unreleased] entry.
	it("has no [Unreleased] entries the release-notes summarizer would mangle", () => {
		const problems = lintUnreleased(CHANGELOG);
		expect(
			problems,
			`Malformed [Unreleased] entries:\n${problems
				.map((p) => `  [${p.kind}] ${p.text}`)
				.join("\n")}`,
		).toEqual([]);
	});

	// The CHANGELOG begins at the 3.x line; pre-3.x tags predate it (the backfill
	// script skips them). Guard the era the CHANGELOG actually covers: no v3.*
	// tag may be missing a curated section.
	it("every v3.* git tag has a non-empty CHANGELOG section", (ctx) => {
		const tags = execFileSync("git", ["tag", "--list", "v3.*"], {
			cwd: REPO_ROOT,
			encoding: "utf8",
		})
			.split(/\r?\n/)
			.map((t) => t.trim())
			.filter(Boolean);
		// CI checks out shallow with no tags fetched, so the tag list is empty
		// there — this contract is a local pre-push guard. Skip VISIBLY when no
		// tags exist rather than returning, which reports a pass (#2089); the
		// release workflow's "Verify changelog entry exists" step covers the real
		// risk of a tagged version missing its section.
		ctx.skip(
			tags.length === 0,
			"no v3.* tags in this checkout (CI clones shallow, without tags)",
		);
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
