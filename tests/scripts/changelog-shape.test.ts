// #5351: area grouping, the fail-closed user-entry shape, and the house-style
// list. Recurrence: the v4.4.9 release body shipped "**Pi 1.5 is supported:**"
// and "**Shorter extension update notes**" as headlines, 29 Fixed entries in
// one flat list, and four reference spellings, because nothing at fragment time
// or release time held the fragments to one shape.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	CHANGELOG_AREAS,
	extractSection,
	parseSectionEntries,
	parseSections,
	summarizeSection,
	userEntryShapeProblems,
} from "../../scripts/lib/changelog.mjs";
import {
	parseEntry,
	rollupChangelog,
	userCountLine,
	validateChangelogEntries,
} from "../../scripts/rollup-changelog.mjs";

const fixtureDir = path.resolve("tests/fixtures/changelog-entries");
const fixture = (name: string) =>
	fs.readFileSync(path.join(fixtureDir, name), "utf8");

const roots: string[] = [];
afterEach(() =>
	roots
		.splice(0)
		.forEach((root) => fs.rmSync(root, { recursive: true, force: true })),
);
function rootWith(
	fragments: Record<string, string>,
	changelog = "# Changelog\n\n## [Unreleased]\n\n## [1.0.0] - 2026-01-01\n\n### Fixed\n\n- prior\n",
) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-shape-"));
	roots.push(root);
	fs.mkdirSync(path.join(root, ".changelog"));
	fs.writeFileSync(path.join(root, "CHANGELOG.md"), changelog);
	for (const [name, text] of Object.entries(fragments))
		fs.writeFileSync(path.join(root, ".changelog", name), text);
	return root;
}

describe("area front matter", () => {
	it("refuses a user fragment with no area and names the closed list", () => {
		expect(() => parseEntry(fixture("missing-area.md"), "x.md")).toThrow(
			/x\.md: missing area marker; add `area: <id>`.*lsp, blockers, runners/,
		);
	});

	it("refuses an unknown area", () => {
		expect(() => parseEntry(fixture("unknown-area.md"), "x.md")).toThrow(
			/x\.md: area must be one of lsp, blockers/,
		);
	});

	it("reads the area from the front matter only", () => {
		const bodyOnly =
			"---\nsection: Fixed\naudience: user\n---\n\n- **T.** area: lsp\n";
		expect(() => parseEntry(bodyOnly, "x.md")).toThrow(/missing area marker/);
		expect(parseEntry(fixture("known-good.md"), "x.md").area).toBe("lsp");
	});

	it("does not require an area on an internal fragment, but validates one it carries", () => {
		const internal = (extra: string) =>
			`---\nsection: Fixed\naudience: internal\n${extra}---\n\n- CI shard.\n`;
		expect(parseEntry(internal(""), "x.md").area).toBeUndefined();
		expect(parseEntry(internal("area: rules\n"), "x.md").area).toBe("rules");
		expect(() => parseEntry(internal("area: misc\n"), "x.md")).toThrow(
			/area must be one of/,
		);
	});

	it("fails --check on a missing area and an unknown area", () => {
		for (const name of ["missing-area.md", "unknown-area.md"])
			expect(() =>
				validateChangelogEntries({
					rootDir: rootWith({ [name]: fixture(name) }),
				}),
			).toThrow(/Invalid changelog entry/);
	});
});

describe("user entry shape", () => {
	it("admits the known-good fragment", () => {
		expect(
			userEntryShapeProblems(parseEntry(fixture("known-good.md")).entry),
		).toEqual([]);
	});

	it.each([
		["colon-headline.md", /must end with a period/],
		["noun-phrase-headline.md", /must end with a period/],
		["imperative-headline.md", /must not open with the imperative "Keep"/],
		["closes-reference.md", /references take one form/],
		["banned-term.md", /internal terms.*projection/],
	])("refuses the real v4.4.9 shape %s", (name, problem) => {
		const root = rootWith({ [name]: fixture(name) });
		expect(() => validateChangelogEntries({ rootDir: root })).toThrow(problem);
	});

	const H = "**Headless sessions exit after an LSP server stops mid-message.**";
	const refused: Array<[string, string, RegExp]> = [
		[
			"a plain opening",
			"- Headless sessions exit after a stop.",
			/bold headline/,
		],
		[
			"underscore bold",
			"- __Headless sessions exit after a stop.__ Body.",
			/bold headline/,
		],
		["a star bullet", `* ${H} Body.`, /must start with `- `/],
		[
			"a full-width period",
			"- **Headless sessions exit after a stop。** Body.",
			/end with a period/,
		],
		[
			"two sentences",
			"- **Sessions exit. Servers stop mid-message too.** Body.",
			/one sentence/,
		],
		[
			"a colon inside",
			"- **Sessions exit: servers stop mid-message.** Body.",
			/one sentence/,
		],
		[
			"an em dash inside",
			"- **Sessions exit — servers stop mid-message.** Body.",
			/one sentence/,
		],
		[
			"three words",
			"- **Sessions exit cleanly.** Body.",
			/4 to 16 words, found 3/,
		],
		[
			"seventeen words",
			`- **${Array.from({ length: 17 }, () => "word").join(" ")}.** Body.`,
			/4 to 16 words, found 17/,
		],
		[
			"an em dash after the headline",
			`- ${H} — body text.`,
			/start a new sentence/,
		],
		["no space after the headline", `- ${H}Body.`, /bold headline/],
		["a non-breaking space", `- ${H} Body.`, /one space between/],
		["a lowercase body", `- ${H} body text.`, /start a new sentence/],
		[
			"a body with no period",
			`- ${H} Body text`,
			/body must end with a period/,
		],
		[
			"a closes reference",
			`- ${H} Body. (closes #4)`,
			/references take one form/,
		],
		[
			"a capitalised reference",
			`- ${H} Body. (Refs #4)`,
			/references take one form/,
		],
		["a bare reference", `- ${H} Body (#4).`, /references take one form/],
		[
			"a reference in the headline",
			"- **Sessions exit after a stop (refs #4).** Body.",
			/references take one form/,
		],
		[
			"a reference mid-body",
			`- ${H} Body (refs #4) goes on.`,
			/references take one form/,
		],
		[
			"an issue URL",
			`- ${H} See https://github.com/apmantza/pi-lens/issues/4 for it.`,
			/references take one form/,
		],
		["a GH- reference", `- ${H} Fixed in GH-4.`, /references take one form/],
		[
			"a second paragraph",
			`- ${H} Body.\n\n  Second paragraph.`,
			/one paragraph/,
		],
		["a nested bullet", `- ${H} Body.\n  - nested.`, /one paragraph/],
		[
			"a tab-indented continuation",
			`- ${H} Body\n\tcontinues.`,
			/one paragraph/,
		],
		["a second bullet", `- ${H} Body.\n- Second.`, /one paragraph/],
		[
			"a fenced block",
			`- ${H} Body.\n  \`\`\`\n  x\n  \`\`\``,
			/one paragraph/,
		],
		["an unbalanced backtick", `- ${H} Body \`text.`, /unbalanced backtick/],
		[
			"a banned term",
			`- ${H} The degradation record names it.`,
			/internal terms.*degradation/,
		],
		[
			"a banned term, spaced and capitalised",
			`- ${H} The Metrics   Table shows it.`,
			/metrics table/,
		],
		["a plural banned term", `- ${H} Two seams share it.`, /seam/],
	];
	it.each(refused)("refuses %s", (_name, entry, problem) => {
		expect(userEntryShapeProblems(entry).join("; ")).toMatch(problem);
	});

	it("refuses a headline over 100 characters even within 16 words", () => {
		const long = `${"x".repeat(26)} ${"y".repeat(26)} ${"z".repeat(26)} ${"w".repeat(26)}.`;
		expect(userEntryShapeProblems(`- **${long}** Body.`).join("; ")).toMatch(
			/at most 100 characters/,
		);
	});

	it("refuses a body over 120 words and admits one of exactly 120", () => {
		const body = (n: number) =>
			`${Array.from({ length: n }, () => "word").join(" ")}.`.replace(
				/^w/,
				"W",
			);
		expect(userEntryShapeProblems(`- ${H} ${body(121)}`).join("; ")).toMatch(
			/at most 120 words, found 121/,
		);
		expect(userEntryShapeProblems(`- ${H} ${body(120)}`)).toEqual([]);
	});

	it("admits a headline-only entry, a trailing reference list, and wrapped continuation lines", () => {
		expect(userEntryShapeProblems(`- ${H}`)).toEqual([]);
		expect(userEntryShapeProblems(`- ${H} (refs #4)`)).toEqual([]);
		expect(userEntryShapeProblems(`- ${H} Body. (refs #4, #5)`)).toEqual([]);
		expect(
			userEntryShapeProblems(
				`- ${H} Body wraps\n  onto a second line. (refs #4)`,
			),
		).toEqual([]);
	});

	it("exempts code spans from the house-style terms and the headline punctuation", () => {
		expect(
			userEntryShapeProblems(
				"- **The `degradation: seam` option now reads clean.** Body about `metrics table` rows.",
			),
		).toEqual([]);
	});

	it("opens no gate for an internal fragment in the old style", () => {
		const root = rootWith({
			"i.md":
				"---\nsection: Changed\naudience: internal\n---\n\n- **The seam fold (closes #4)** — old style, with a seam.\n",
		});
		expect(validateChangelogEntries({ rootDir: root })).toHaveLength(1);
	});

	it("never reads a released section: an old-style CHANGELOG.md passes --check", () => {
		const root = rootWith(
			{},
			"# Changelog\n\n## [Unreleased]\n\n## [1.0.0] - 2026-01-01\n\n### Fixed\n\n- **Pi 1.5 is supported:** old style (closes #1)\n",
		);
		expect(validateChangelogEntries({ rootDir: root })).toEqual([]);
	});
});

describe("area grouping in the rollup and the release summary", () => {
	const user = (section: string, area: string, headline: string) =>
		`---\nsection: ${section}\naudience: user\narea: ${area}\n---\n\n- **${headline}** Body. (refs #9)\n`;
	function roll(fragments: Record<string, string>) {
		const root = rootWith(
			fragments,
			"# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- legacy unreleased entry\n\n## [1.0.0] - 2026-01-01\n\n### Fixed\n\n- prior\n",
		);
		rollupChangelog("2.0.0", { rootDir: root, date: "2026-11-06" });
		return (
			extractSection(
				fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8"),
				"2.0.0",
			) ?? ""
		);
	}

	it("groups a section's entries by area in the closed list's order, files in order within an area", () => {
		const released = roll({
			"a.md": user("Fixed", "tools", "Tools entry one reads fine."),
			"b.md": user("Fixed", "lsp", "Server entry one reads fine."),
			"c.md": user("Fixed", "tools", "Tools entry two reads fine."),
			"d.md": user("Added", "config", "Config entry reads fine here."),
		});
		const fixed = released.slice(released.indexOf("### Fixed"));
		expect(fixed.indexOf("#### Language servers")).toBeLessThan(
			fixed.indexOf("#### Tools and reports"),
		);
		expect(fixed.match(/#### Tools and reports/g)).toHaveLength(1);
		expect(fixed.indexOf("Tools entry one")).toBeLessThan(
			fixed.indexOf("Tools entry two"),
		);
		expect(fixed.indexOf("Server entry one")).toBeLessThan(
			fixed.indexOf("#### Tools and reports"),
		);
		expect(released).toContain("### Added\n\n#### Configuration and flags");
		// A legacy entry with no area keeps its place above every area heading.
		expect(fixed.indexOf("legacy unreleased entry")).toBeLessThan(
			fixed.indexOf("#### Language servers"),
		);
	});

	// Recurrence guard: re-rolling a version folds a late fragment in; without the
	// merge it opened a second `#### Language servers` heading in the same section.
	it("folds a late fragment into the area heading a re-roll already has", () => {
		const root = rootWith({
			"a.md": user("Fixed", "lsp", "Server entry one reads fine."),
		});
		rollupChangelog("2.0.0", { rootDir: root, date: "2026-11-06" });
		fs.writeFileSync(
			path.join(root, ".changelog", "b.md"),
			user("Fixed", "lsp", "Server entry two reads fine."),
		);
		rollupChangelog("2.0.0", { rootDir: root, date: "2026-11-06" });
		const released =
			extractSection(
				fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8"),
				"2.0.0",
			) ?? "";
		expect(released.match(/#### Language servers/g)).toHaveLength(1);
		expect(released).toContain("Server entry one");
		expect(released).toContain("Server entry two");
	});

	it("keeps the Internal block free of area headings", () => {
		const released = roll({
			"i.md":
				"---\nsection: Fixed\naudience: internal\narea: lsp\n---\n\n- CI shard.\n",
		});
		expect(released).not.toContain("####");
	});

	// One legacy entry with no area first, then `count - 1` entries alternating
	// between two areas: exactly `count` bullets in the section.
	const bodyWithAreas = (count: number) => {
		const titles = CHANGELOG_AREAS.slice(0, 2).map(({ title }) => title);
		const entry = (i: number) =>
			`- **Area ${i % 2} entry ${i} reads fine.** Body. (refs #${i})`;
		const under = (a: number) =>
			Array.from({ length: count - 1 }, (_, i) => i + 1)
				.filter((i) => i % 2 === a)
				.map(entry);
		return [
			"### Fixed",
			"",
			"- legacy entry first (refs #1)",
			"",
			...[0, 1].flatMap((a) => [`#### ${titles[a]}`, "", ...under(a), ""]),
		].join("\n");
	};

	it("renders area headings in the summary from 6 items, flat below", () => {
		const grouped = summarizeSection(bodyWithAreas(6));
		expect(grouped).toContain("#### Language servers");
		expect(grouped).toContain("#### Blockers and sessions");
		// The unarea'd entry renders first, before any heading.
		expect(grouped.indexOf("legacy entry first")).toBeLessThan(
			grouped.indexOf("#### Language servers"),
		);
		const flat = summarizeSection(bodyWithAreas(5));
		expect(flat).not.toContain("####");
		expect(flat).toContain("- **Area 1 entry 1 reads fine.** (refs #1)");
	});

	it("leaves the count line and the buckets unchanged by area headings", () => {
		const body = bodyWithAreas(7);
		const { buckets, areas } = parseSectionEntries(body);
		expect([...buckets.keys()]).toEqual(["Fixed"]);
		expect(buckets.get("Fixed")).toHaveLength(areas.get("Fixed")?.length ?? -1);
		expect(userCountLine(body)).toBe(`${buckets.get("Fixed")?.length} fixes.`);
	});

	it("keeps the trailing reference in the summary, once", () => {
		expect(
			summarizeSection(
				"### Fixed\n\n- **Sessions exit cleanly now.** Body. (refs #7)",
			),
		).toBe("### Fixed\n\n- **Sessions exit cleanly now.** (refs #7)");
		expect(
			summarizeSection(
				"### Fixed\n\n- **Sessions exit (refs #7)** — Body. (refs #7)",
			),
		).toBe("### Fixed\n\n- **Sessions exit (refs #7)**");
	});

	it("still treats any other #### line as an ordinary heading", () => {
		const body =
			"### Fixed\n\n- **A**\n\n#### Removed - Deprecated Commands\n\n- **B**\n";
		const { order, areas } = parseSectionEntries(body);
		expect(order).toEqual(["Fixed", "Removed - Deprecated Commands"]);
		expect(areas.get("Fixed")).toEqual([null]);
	});

	it("parses every released section of CHANGELOG.md with no area, as before", () => {
		const text = fs.readFileSync(path.resolve("CHANGELOG.md"), "utf8");
		const sections = parseSections(text);
		expect(sections.length).toBeGreaterThan(100);
		for (const { body } of sections)
			for (const items of parseSectionEntries(body).areas.values())
				expect(items.every((area) => area === null)).toBe(true);
	});
});
