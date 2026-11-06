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

	it("refuses an entry that is more than one paragraph", () => {
		for (const entry of [
			`- ${H} Body.\n\n  Second paragraph.`,
			`- ${H} Body.\n  - nested.`,
			`- ${H} Body\n\tcontinues.`,
			`- ${H} Body.\n- Second.`,
			`- ${H} Body.\n  \`\`\`\n  x\n  \`\`\``,
		])
			expect(userEntryShapeProblems(entry).join("; ")).toMatch(/one paragraph/);
	});

	it("refuses a tilde fence as it refuses a backtick fence", () => {
		// Recurrence: `  ~~~text` between two paragraphs returned [] while the
		// backtick form was refused.
		for (const fence of ["~~~", "~~~text", "~~~~"])
			expect(
				userEntryShapeProblems(
					`- ${H} Body.\n  ${fence}\n  x\n  ${fence}`,
				).join("; "),
			).toMatch(/one paragraph/);
	});

	// Recurrence: a heading line before the bullet was admitted, so `### Internal`
	// shipped a user change as internal and `### Fixed` detached the area. The
	// first line of a user entry is the bullet; every other line before it is
	// unrecognized, including spellings nobody planned for.
	it.each([
		["a section heading", "### Internal"],
		["another section heading", "### Fixed"],
		["an area heading", "#### Rules"],
		["a level-one heading", "# Fixed"],
		["a setext heading", "Fixed\n====="],
		["an HTML comment", "<!-- Internal -->"],
		["plain text", "Note for the release."],
		["a heading with trailing text", "### Internal changes"],
		["a zero-width character", "\u200b"],
	])("refuses %s before the entry bullet", (_name, before) => {
		for (const gap of ["", "\n"])
			expect(
				userEntryShapeProblems(`${before}\n${gap}- ${H} Body.`).join("; "),
			).toMatch(/open with its bullet/);
	});

	it("admits blank lines before the bullet", () => {
		expect(userEntryShapeProblems(`\n\n- ${H} Body.`)).toEqual([]);
	});

	// Recurrence: the 100-character cap re-matched the raw text with a stricter
	// class than the shape check, so a `*` inside a code span threw a TypeError
	// out of `--check`, and `**` in a code span measured a 5-character prefix.
	describe("headline length is measured as a reader sees it", () => {
		const entry = (headline: string) => `- **${headline}** Body.`;

		it.each([
			[
				"a glob star",
				"The `*.enabled` config keys now switch each server off.",
			],
			["a double star glob", "The `**/*.ts` files now get checked again."],
			["a bare double star", "The `**` option now reads clean here."],
			["a lone star", "The `*` option now reads clean here."],
		])("does not throw on %s inside a code span", (_name, headline) => {
			expect(() => userEntryShapeProblems(entry(headline))).not.toThrow();
			expect(userEntryShapeProblems(entry(headline))).toEqual([]);
		});

		it.each([
			"**",
			"****",
			"**.**",
			"** **",
			"**`**`",
			"**`*.ts`**",
			"**a*b.**",
			"**`a` `b` `c` `d`**",
		])("never throws on the odd headline %s", (headline) => {
			expect(() => userEntryShapeProblems(`- ${headline} Body.`)).not.toThrow();
			expect(userEntryShapeProblems(`- ${headline} Body.`)).not.toEqual([]);
		});

		it("counts a code span in full: 20 collapsed characters can render 109", () => {
			const span = `\`${"x".repeat(84)}\``;
			const headline = `The ${span} option now reads clean.`;
			expect(userEntryShapeProblems(entry(headline)).join("; ")).toMatch(
				/at most 100 characters/,
			);
		});

		it("counts the rendered text, not the backticks around a code span", () => {
			// 100 characters rendered, 102 with the backticks: admitted. One more: refused.
			const exact = `The \`${"x".repeat(72)}\` option now reads clean.`;
			expect(exact.replace(/`/g, "")).toHaveLength(100);
			expect(userEntryShapeProblems(entry(exact))).toEqual([]);
			const over = `The \`${"x".repeat(73)}\` option now reads clean.`;
			expect(userEntryShapeProblems(entry(over)).join("; ")).toMatch(
				/at most 100 characters/,
			);
		});

		// Recurrence guard: the collapse placeholder is a private-use character; an
		// entry that carries it literally would read as a code span that is not there.
		it("refuses the collapse placeholder written literally", () => {
			expect(
				userEntryShapeProblems(
					"- **The \uE000 option now reads clean.** Body.",
				).join("; "),
			).toMatch(/U\+E000/);
		});

		it("refuses a `*` outside a code span as it refuses any non-headline", () => {
			expect(
				userEntryShapeProblems(
					"- **The *.enabled keys now switch off.** Body.",
				).join("; "),
			).toMatch(/bold headline/);
		});

		it("reports the file, not a TypeError, through --check", () => {
			const root = rootWith({
				"star.md":
					"---\nsection: Fixed\naudience: user\narea: config\n---\n\n- **The `*.enabled` config keys now switch each server off.** Body.\n",
			});
			expect(validateChangelogEntries({ rootDir: root })).toHaveLength(1);
		});
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

describe("the release rollup applies the shape check", () => {
	// Recurrence: a fragment first added in the release PR never met the PR-time
	// check, and `rollupChangelog` consumed it as written.
	it.each([
		[
			"a heading before the bullet",
			"### Internal\n\n- **Servers now restart on crash always.** Body. (refs #1)\n",
		],
		[
			"a closes reference",
			"- **Servers now restart on crash always.** Body. (closes #1)\n",
		],
		["a plain opening", "- Servers restart on crash.\n"],
	])("refuses %s and leaves CHANGELOG.md alone", (_name, entry) => {
		const root = rootWith({
			"a.md": `---\nsection: Fixed\naudience: user\narea: lsp\n---\n\n${entry}`,
		});
		const before = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
		expect(() =>
			rollupChangelog("2.0.0", { rootDir: root, date: "2026-11-06" }),
		).toThrow(/Invalid changelog entry a\.md: /);
		expect(fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8")).toBe(
			before,
		);
		expect(fs.existsSync(path.join(root, ".changelog", "a.md"))).toBe(true);
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
		// The unarea'd entry renders first, under no heading of its own.
		expect(
			grouped.startsWith(
				"### Fixed\n\n- legacy entry first (refs #1)\n\n#### Language servers",
			),
		).toBe(true);
		expect(grouped).not.toContain("#### null");
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

	// Recurrence guard: a hand-edited Internal block that holds an area title
	// line must stay Internal, not open a bucket that lists its bullets as user
	// entries in the release body.
	it("keeps the bullets under an area title line inside the Internal block internal", () => {
		const body =
			"### Fixed\n\n- **A.** Body.\n\n### Internal\n\n<details>\n\n#### Language servers\n\n- **Hidden.** Body.\n\n</details>\n";
		const { order, internalCount } = parseSectionEntries(body);
		expect(order).toEqual(["Fixed", "Internal"]);
		expect(internalCount).toBe(1);
		expect(summarizeSection(body)).not.toContain("Hidden");
	});

	it("still treats any other #### line as an ordinary heading", () => {
		const body =
			"### Fixed\n\n- **A**\n\n#### Removed - Deprecated Commands\n\n- **B**\n";
		const { order, areas } = parseSectionEntries(body);
		expect(order).toEqual(["Fixed", "Removed - Deprecated Commands"]);
		expect(areas.get("Fixed")).toEqual([null]);
	});

	// Recurrence: this test read the live CHANGELOG.md, so the first release roll
	// (it writes `#### <area>` headings) reddened the release PR on valid output.
	// The snapshot is sections 4.4.9 to 4.4.7 as released, before area headings.
	it("parses every legacy section with no area, as before", () => {
		const text = fs.readFileSync(
			path.join(fixtureDir, "legacy-sections.md"),
			"utf8",
		);
		const sections = parseSections(text);
		expect(sections.map(({ label }) => label)).toEqual([
			"4.4.9",
			"4.4.8",
			"4.4.7",
		]);
		let entries = 0;
		for (const { body } of sections)
			for (const items of parseSectionEntries(body).areas.values()) {
				entries += items.length;
				expect(items.every((area) => area === null)).toBe(true);
			}
		expect(entries).toBeGreaterThan(60);
	});
});
