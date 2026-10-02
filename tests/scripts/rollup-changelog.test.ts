import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	extractSection,
	summarizeSection,
} from "../../scripts/lib/changelog.mjs";
import {
	CHANGELOG_SECTIONS,
	parseEntry,
	rollupChangelog,
} from "../../scripts/rollup-changelog.mjs";

const tempDirs: string[] = [];
afterEach(() =>
	tempDirs
		.splice(0)
		.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })),
);

function fixtureRoot() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-changelog-"));
	tempDirs.push(root);
	fs.mkdirSync(path.join(root, ".changelog"));
	fs.writeFileSync(
		path.join(root, "CHANGELOG.md"),
		"# Changelog\n\n## [Unreleased]\n\n### Added\n\n- old unreleased\n  continuation text\n  - nested detail\n\n### Security\n\n* existing security note.\n\n## [1.0.0] - 2026-01-01\n\n### Fixed\n\n- prior\n",
	);
	return root;
}

describe("per-entry changelog rollup", () => {
	it("inserts the new version below Unreleased", () => {
		const root = fixtureRoot();
		rollupChangelog("2.0.0", { rootDir: root, date: "2026-08-13" });
		const output = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
		expect(output.indexOf("## [Unreleased]")).toBeLessThan(
			output.indexOf("## [2.0.0] - 2026-08-13"),
		);
		expect(output).not.toContain("### Security\n\n\n## [2.0.0]");
	});

	it("promotes existing Unreleased content into the new version", () => {
		const root = fixtureRoot();
		rollupChangelog("2.0.0", { rootDir: root, date: "2026-08-13" });
		const output = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
		const released = output.slice(output.indexOf("## [2.0.0]"));
		expect(released).toContain(
			"- old unreleased\n  continuation text\n  - nested detail",
		);
		expect(released).toContain("* existing security note.");
	});

	it("places the version below Unreleased, folds its content, preserves multiline entries, and deletes files", () => {
		const root = fixtureRoot();
		fs.writeFileSync(
			path.join(root, ".changelog", "b.md"),
			"---\nsection: Fixed\naudience: user\n---\n\n* **B.** fixed.\n  Hard-wrapped continuation.\n  - nested consequence\n",
		);
		fs.writeFileSync(
			path.join(root, ".changelog", "a.md"),
			"---\nsection: Deprecated\naudience: user\n---\n\n- Plain deprecated entry without bold\n",
		);
		rollupChangelog("2.0.0", { rootDir: root, date: "2026-08-13" });
		const output = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
		expect(output.indexOf("## [Unreleased]")).toBeLessThan(
			output.indexOf("## [2.0.0] - 2026-08-13"),
		);
		expect(output).toContain(
			"### Added\n\n- old unreleased\n  continuation text\n  - nested detail",
		);
		expect(output).toContain(
			"### Deprecated\n\n- Plain deprecated entry without bold",
		);
		expect(output).toContain(
			"### Fixed\n\n* **B.** fixed.\n  Hard-wrapped continuation.\n  - nested consequence",
		);
		expect(output).toContain("### Security\n\n* existing security note.");
		expect(fs.readdirSync(path.join(root, ".changelog"))).toEqual([]);
	});

	it("merges idempotently when the version heading already exists", () => {
		const root = fixtureRoot();
		fs.writeFileSync(
			path.join(root, ".changelog", "a.md"),
			"---\nsection: Changed\naudience: user\n---\n\n- **A** — changed\n",
		);
		rollupChangelog("2.0.0", { rootDir: root, date: "2026-08-13" });
		const once = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
		expect(() =>
			rollupChangelog("2.0.0", { rootDir: root, date: "2026-08-13" }),
		).not.toThrow();
		expect(fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8")).toBe(once);
		expect(once.match(/^## \[2\.0\.0\]/gm)).toHaveLength(1);
	});

	it("reports malformed entries clearly without changing the changelog", () => {
		const root = fixtureRoot();
		fs.writeFileSync(
			path.join(root, ".changelog", "bad.md"),
			"---\nsection: Nope\naudience: user\n---\n\n- bad\n",
		);
		expect(() => rollupChangelog("2.0.0", { rootDir: root })).toThrow(
			/bad\.md: section must be/,
		);
		expect(
			fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8"),
		).not.toContain("2.0.0");
	});

	it.each([
		["wrapped-title.md", /wrapped-title/],
		["orphan-bullet.md", /orphan/],
	])("rejects the real-bug guard fixture %s", (file, problem) => {
		const fixture = path.resolve("tests/fixtures/changelog-entries", file);
		expect(() => parseEntry(fs.readFileSync(fixture, "utf8"), file)).toThrow(
			problem,
		);
	});

	it.each([
		["Added", "- **Bold** — em dash"],
		["Changed", "* **Bold.** period style"],
		["Deprecated", "- plain entry"],
		["Removed", "* plain star entry."],
		["Fixed", "- **Bold** plain separator"],
		["Security", "- security fix"],
	])("accepts %s entries in repository styles", (section, entry) => {
		expect(
			parseEntry(`---\nsection: ${section}\naudience: user\n---\n\n${entry}`),
		).toEqual({ section, audience: "user", entry });
	});

	it("covers the full Keep a Changelog section order", () => {
		expect(CHANGELOG_SECTIONS).toEqual([
			"Added",
			"Changed",
			"Deprecated",
			"Removed",
			"Fixed",
			"Security",
		]);
	});
});

// Recurrence: v4.3.0 rolled 106 fragments, most of them CI/tests/orchestration,
// into one release body a user could not read (#3852). The audience field is the
// only thing separating the two populations, so each direction is pinned.
describe("fragment audience (#3852)", () => {
	const fragment = (
		audience: string | null,
		title: string,
		section = "Fixed",
	) =>
		`---\nsection: ${section}\n${audience === null ? "" : `audience: ${audience}\n`}---\n\n- **${title}** - detail.\n`;

	function rollMixed() {
		const root = fixtureRoot();
		const dir = path.join(root, ".changelog");
		fs.writeFileSync(path.join(dir, "a.md"), fragment("user", "User fix"));
		fs.writeFileSync(
			path.join(dir, "b.md"),
			fragment("internal", "CI shard", "Changed"),
		);
		fs.writeFileSync(
			path.join(dir, "c.md"),
			fragment("internal", "Test flake"),
		);
		rollupChangelog("2.0.0", { rootDir: root, date: "2026-08-13" });
		const output = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
		return { root, output, released: extractSection(output, "2.0.0") ?? "" };
	}

	it("keeps internal entries out of the release-notes summary and counts them", () => {
		const { released } = rollMixed();
		const summary = summarizeSection(released);
		expect(summary).toContain("- **User fix**");
		expect(summary).not.toContain("CI shard");
		expect(summary).not.toContain("Test flake");
		expect(summary).not.toContain("### Internal");
		expect(summary.split("\n").at(-1)).toBe(
			"Plus 2 internal changes: tests, CI, tooling, and refactors.",
		);
	});

	it("keeps every internal entry in CHANGELOG.md, in a collapsed Internal block, and no user entry there", () => {
		const { released } = rollMixed();
		const internal = released.slice(released.indexOf("### Internal"));
		expect(internal).toContain(
			"<details>\n<summary>2 internal changes: tests, CI, tooling, and refactors</summary>",
		);
		expect(internal).toContain("- **CI shard** - detail.");
		expect(internal).toContain("- **Test flake** - detail.");
		expect(internal).toContain("</details>");
		expect(internal).not.toContain("User fix");
		const user = released.slice(0, released.indexOf("### Internal"));
		expect(user).toContain("- **User fix** - detail.");
		expect(user).not.toContain("CI shard");
		expect(user).not.toContain("Test flake");
	});

	it("re-rolling a version that already has an Internal block does not change it", () => {
		const { root, output } = rollMixed();
		fs.writeFileSync(
			path.join(root, ".changelog", "d.md"),
			fragment("user", "Late user fix"),
		);
		rollupChangelog("2.0.0", { rootDir: root, date: "2026-08-13" });
		const again = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
		const released = extractSection(again, "2.0.0") ?? "";
		expect(released).toContain("- **Late user fix**");
		expect(released.match(/<details>/g)).toHaveLength(1);
		expect(released).toContain("<summary>2 internal changes");
		expect(again.replace("- **Late user fix** - detail.\n\n", "")).toBe(output);
	});

	it("a release with one internal entry says 'change', and none prints no count", () => {
		expect(
			summarizeSection("### Fixed\n\n- **A**\n\n### Internal\n\n- **B**"),
		).toMatch(/\nPlus 1 internal change: tests, CI, tooling, and refactors\.$/);
		expect(summarizeSection("### Fixed\n\n- **A**")).toBe(
			"### Fixed\n\n- **A**",
		);
	});

	it("rejects a fragment with no audience and says exactly what to add", () => {
		expect(() => parseEntry(fragment(null, "T"), "x.md")).toThrow(
			/x\.md: missing audience marker; add `audience: user` or `audience: internal` to the front matter next to `section:` \(user = .*internal = /,
		);
	});

	it("rejects an unknown audience value", () => {
		expect(() => parseEntry(fragment("public", "T"), "x.md")).toThrow(
			/x\.md: audience must be one of user, internal/,
		);
	});

	it("reads audience from the front matter only, in either order", () => {
		const bodyOnly =
			"---\nsection: Fixed\n---\n\n- **T** - audience: user\n\naudience: user\n";
		expect(() => parseEntry(bodyOnly, "x.md")).toThrow(/missing audience/);
		expect(
			parseEntry("---\naudience: internal\nsection: Fixed\n---\n\n- **T**\n")
				.audience,
		).toBe("internal");
	});

	it("rollup refuses a missing audience without touching the changelog", () => {
		const root = fixtureRoot();
		fs.writeFileSync(
			path.join(root, ".changelog", "a.md"),
			fragment(null, "T"),
		);
		const before = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
		expect(() => rollupChangelog("2.0.0", { rootDir: root })).toThrow(
			/a\.md: missing audience marker/,
		);
		expect(fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8")).toBe(
			before,
		);
	});

	// Edge shapes that a naive marker regex or wrapper strip would mangle.
	it("accepts audience with no space and with trailing whitespace, and rejects a half-marker line", () => {
		expect(
			parseEntry("---\nsection: Fixed\naudience:user\n---\n\n- **T**\n", "x.md")
				.audience,
		).toBe("user");
		expect(
			parseEntry(
				"---\nsection: Fixed\naudience: internal  \n---\n\n- **T**\n",
				"x.md",
			).audience,
		).toBe("internal");
		expect(() =>
			parseEntry(
				"---\nsection: Fixed\naudience: user extra\n---\n\n- **T**\n",
				"x.md",
			),
		).toThrow(/missing audience marker/);
		expect(() =>
			parseEntry(
				"---\nsection: Fixed\nxaudience: user\n---\n\n- **T**\n",
				"x.md",
			),
		).toThrow(/missing audience marker/);
	});

	it("counts only column-0 Internal bullets and tolerates extra spaces", () => {
		const body =
			"### Fixed\n\n- **A**\n\n### Internal\n\n-  **B**\n\n  - nested under Internal\n";
		expect(summarizeSection(body)).toBe(
			"### Fixed\n\n- **A**\n\nPlus 1 internal change: tests, CI, tooling, and refactors.",
		);
	});

	it("a roll of one internal entry says 'change' in its summary", () => {
		const root = fixtureRoot();
		fs.writeFileSync(
			path.join(root, ".changelog", "a.md"),
			fragment("internal", "Only internal"),
		);
		rollupChangelog("2.0.0", { rootDir: root, date: "2026-08-13" });
		const released =
			extractSection(
				fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8"),
				"2.0.0",
			) ?? "";
		expect(released).toContain(
			"<summary>1 internal change: tests, CI, tooling, and refactors</summary>",
		);
	});

	it("omits a section heading with no entries", () => {
		const root = fixtureRoot();
		fs.writeFileSync(
			path.join(root, ".changelog", "a.md"),
			fragment("user", "Only fixed"),
		);
		rollupChangelog("2.0.0", { rootDir: root, date: "2026-08-13" });
		const released =
			extractSection(
				fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8"),
				"2.0.0",
			) ?? "";
		expect(released).not.toContain("### Deprecated");
		expect(released).not.toContain("### Removed");
	});

	it("does not strip a bare <details> line from a user section", () => {
		const root = fixtureRoot();
		fs.writeFileSync(
			path.join(root, ".changelog", "a.md"),
			"---\nsection: Fixed\naudience: user\n---\n\n- **U** - uses HTML.\n\n<details>\n\n<summary>user html</summary>\n",
		);
		rollupChangelog("2.0.0", { rootDir: root, date: "2026-08-13" });
		const released =
			extractSection(
				fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8"),
				"2.0.0",
			) ?? "";
		expect(released).toContain("<details>\n\n<summary>user html</summary>");
	});

	it("re-rolls an Internal block with whitespace-padded wrappers and wrapper-like prose", () => {
		const root = fixtureRoot();
		const rolled = [
			"# Changelog",
			"",
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
			"",
			"## [2.0.0] - 2026-08-01",
			"",
			"### Internal",
			"",
			"<details> ",
			"<summary>1 internal change: tests, CI, tooling, and refactors</summary>",
			"",
			"- **Old internal**",
			"",
			"<details>kept as prose",
			"",
			"trailing prose</details>",
			"",
			"</details>",
			"",
		].join("\n");
		fs.writeFileSync(path.join(root, "CHANGELOG.md"), rolled);
		fs.writeFileSync(
			path.join(root, ".changelog", "n.md"),
			fragment("internal", "New internal"),
		);
		rollupChangelog("2.0.0", { rootDir: root, date: "2026-08-02" });
		const released =
			extractSection(
				fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8"),
				"2.0.0",
			) ?? "";
		expect(released).toContain("<details>kept as prose");
		expect(released).toContain("trailing prose</details>");
		expect(released).not.toContain("<details> \n");
		expect(released).toContain(
			"<summary>2 internal changes: tests, CI, tooling, and refactors</summary>",
		);
		expect(released).toMatch(/\n\n- \*\*New internal\*\*/);
	});
});
