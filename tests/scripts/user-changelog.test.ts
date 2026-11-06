// #5198: drive the release emitter and pi's actual changelog reader.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { extractSection, parseSections } from "../../scripts/lib/changelog.mjs";
import * as rollup from "../../scripts/rollup-changelog.mjs";
const {
	getNewEntries,
	parseChangelog,
}: {
	getNewEntries(
		entries: Array<{ patch: number; content: string }>,
		lastVersion: string,
	): Array<{ patch: number; content: string }>;
	parseChangelog(file: string): Array<{ patch: number; content: string }>;
} = await import(
	new URL(
		"./utils/changelog.js",
		import.meta.resolve("@earendil-works/pi-coding-agent"),
	).href
);

const roots: string[] = [];
afterEach(() =>
	roots
		.splice(0)
		.forEach((root) => fs.rmSync(root, { recursive: true, force: true })),
);
function fixture() {
	const root = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-lens-user-changelog-"),
	);
	roots.push(root);
	fs.mkdirSync(path.join(root, ".changelog"));
	fs.writeFileSync(
		path.join(root, "CHANGELOG.md"),
		"# Changelog\n\n## [Unreleased]\n\n### Added\n\n- **Unreleased feature** is pending.\n\n" +
			Array.from(
				{ length: 7 },
				(_, i) =>
					`## [1.0.${7 - i}] - 2026-01-01\n\n### Added\n\n- **Public ${7 - i}** [guide](docs/usage.md), [root](/docs/root.md), [anchor](#usage), [external](https://example.com/guide), [cdn](//example.com/a).\n\n### Internal\n\n<details>\n<summary>private</summary>\n\n- secret ${i}\n\n</details>\n\n### Fixed\n\n- **Visible fix** works.\n\n`,
			).join(""),
	);
	for (const audience of ["user", "internal"])
		fs.writeFileSync(
			path.join(root, ".changelog", `${audience}.md`),
			`---\nsection: Added\naudience: ${audience}\narea: tools\n---\n\n- **Pending ${audience} entries are counted, never listed.** Detail.\n`,
		);
	return root;
}
it("emits five release summaries readable by pi across a version jump", () => {
	const root = fixture();
	rollup.writeUserChangelog({ rootDir: root });
	const file = path.join(root, "CHANGELOG-USER.md");
	const text = fs.readFileSync(file, "utf8");
	expect(text).not.toMatch(
		/secret|<details>|<summary>|### Internal|Pending internal/,
	);
	expect(text).not.toMatch(/Pending|Unreleased/);
	expect(text).not.toContain("### Deprecated");
	expect(text).toContain(
		"Full notes: https://github.com/apmantza/pi-lens/releases/tag/v1.0.7",
	);
	const entries = parseChangelog(file);
	expect(entries.map((entry) => entry.patch)).toEqual([7, 6, 5, 4, 3]);
	// pi's own filter for the two-release jump from 1.0.5 keeps the 1.0.7 and 1.0.6 sections.
	const newEntries = getNewEntries(entries, "1.0.5");
	expect(newEntries.map((entry) => entry.patch)).toEqual([7, 6]);
	// #5264: pi prints each section whole, so it reads the heading, one count line and the link.
	expect(entries[0].content).toBe(
		"## [1.0.7] - 2026-01-01\n\n1 feature, 1 fix.\n\nFull notes: https://github.com/apmantza/pi-lens/releases/tag/v1.0.7",
	);
	// pi's interactive-mode joins the new entries' contents with a blank line.
	expect(newEntries.map((entry) => entry.content).join("\n\n")).toBe(
		"## [1.0.7] - 2026-01-01\n\n1 feature, 1 fix.\n\nFull notes: https://github.com/apmantza/pi-lens/releases/tag/v1.0.7\n\n## [1.0.6] - 2026-01-01\n\n1 feature, 1 fix.\n\nFull notes: https://github.com/apmantza/pi-lens/releases/tag/v1.0.6",
	);
});
it("ignores pending fragments and checks released-file drift", () => {
	const root = fixture();
	rollup.writeUserChangelog({ rootDir: root });
	expect(() => rollup.checkUserChangelog({ rootDir: root })).not.toThrow();
	fs.appendFileSync(
		path.join(root, ".changelog/user.md"),
		"  more user detail\n",
	);
	expect(() => rollup.checkUserChangelog({ rootDir: root })).not.toThrow();
	const source = path.join(root, "CHANGELOG.md");
	fs.writeFileSync(
		source,
		// #5264: the released edit must change a count, because the shipped file holds counts only.
		fs
			.readFileSync(source, "utf8")
			.replace(
				"### Fixed\n\n- **Visible fix** works.",
				"### Fixed\n\n- **Visible fix** works.\n\n- **Released fix** works.",
			),
	);
	expect(() => rollup.checkUserChangelog({ rootDir: root })).toThrow(
		/CHANGELOG-USER.md/,
	);
	rollup.writeUserChangelog({ rootDir: root });
	fs.appendFileSync(path.join(root, "CHANGELOG-USER.md"), "drift\n");
	expect(() => rollup.checkUserChangelog({ rootDir: root })).toThrow(
		/CHANGELOG-USER.md/,
	);
});
it("release rollup refreshes the user file after consuming audience fragments", () => {
	const root = fixture();
	rollup.rollupChangelog("1.0.8", { rootDir: root });
	fs.unlinkSync(path.join(root, "CHANGELOG-USER.md"));
	rollup.rollupChangelog("1.0.8", { rootDir: root });
	const text = fs.readFileSync(path.join(root, "CHANGELOG-USER.md"), "utf8");
	expect(text).toContain("## [1.0.8]");
	// #5264: the user fragment is counted (with the Unreleased feature), never listed by title.
	expect(text).toContain("2 features.");
	expect(text).not.toContain("Pending user");
	expect(text).not.toContain("Pending internal");
	expect(() => rollup.checkUserChangelog({ rootDir: root })).not.toThrow();
});

// #5198: npm's changelog:check must actually call the emitter's drift check.
it("the check CLI rejects a stale user changelog", async () => {
	const root = fixture();
	rollup.writeUserChangelog({ rootDir: root });
	fs.appendFileSync(path.join(root, "CHANGELOG-USER.md"), "stale\n");
	fs.mkdirSync(path.join(root, "scripts/lib"), { recursive: true });
	for (const file of [
		"rollup-changelog.mjs",
		"lib/changelog.mjs",
		"lib/is-main-module.mjs",
	])
		fs.copyFileSync(
			path.resolve("scripts", file),
			path.join(root, "scripts", file),
		);
	const cli = path.join(root, "scripts/rollup-changelog.mjs");
	const argv = process.argv;
	const exitCode = process.exitCode;
	try {
		process.argv = [process.execPath, cli, "--check"];
		process.exitCode = 0;
		await import(cli);
		expect(process.exitCode).toBe(1);
		// The repair command printed by the stale-file error must really refresh it.
		const repairCli = path.join(root, "scripts/rollup-user.mjs");
		fs.copyFileSync(cli, repairCli);
		process.argv = [process.execPath, repairCli, "--user"];
		process.exitCode = 0;
		await import(repairCli);
		expect(process.exitCode).toBe(0);
		expect(fs.readFileSync(path.join(root, "CHANGELOG-USER.md"), "utf8")).toBe(
			rollup.renderUserChangelog({ rootDir: root }),
		);
	} finally {
		process.argv = argv;
		process.exitCode = exitCode;
	}
});

// #5202: shipped notes must equal the release sections. #5264: each section is its count line.
it("the shipped user changelog equals the last five release counts", () => {
	const source = fs.readFileSync("CHANGELOG.md", "utf8");
	const releases = parseSections(source)
		.filter((section) => /^\d+\.\d+\.\d+$/.test(section.label))
		.slice(0, 5);
	const expected =
		"# User changelog\n\n" +
		releases
			.map(
				(section) =>
					`${section.heading}\n\n${rollup.userCountLine(extractSection(source, section.label)!)}\n\nFull notes: https://github.com/apmantza/pi-lens/releases/tag/v${section.label}`,
			)
			.join("\n\n") +
		"\n";
	expect(fs.readFileSync("CHANGELOG-USER.md", "utf8")).toBe(expected);
	expect(() => rollup.checkUserChangelog()).not.toThrow();
});

// #5264 recurrence: pi's Extension Updates view printed every headline of every
// new section. This pins the count line of a real release section, so a change
// to the mapping or the parse moves a literal instead of passing silently. The
// counts were taken by hand with awk over CHANGELOG.md's 4.4.8 section: Added 1,
// Changed 6, Fixed 28. Internal (32) is not user-facing and is not counted.
it("pins the 4.4.8 count line from the real CHANGELOG.md section", () => {
	const source = fs.readFileSync("CHANGELOG.md", "utf8");
	expect(rollup.userCountLine(extractSection(source, "4.4.8")!)).toBe(
		"1 feature, 28 fixes, 6 other changes.",
	);
});

// #5264 recurrence: the count line must read as a sentence in pi's view, so
// singular forms, zero-category omission, the Deprecated bucket and the empty
// release each need a fixture. The real 4.4.8 section has none of them.
it("counts user-facing entries per release with singular forms and no zero terms", () => {
	const root = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-lens-user-changelog-"),
	);
	roots.push(root);
	fs.writeFileSync(
		path.join(root, "CHANGELOG.md"),
		[
			"## [2.0.3] - 2026-03-03",
			"",
			"### Added",
			"",
			"- **Lone feature** works.",
			"",
			"### Deprecated",
			"",
			"- **Old flag** is gone.",
			"",
			"### Internal",
			"",
			"<details>",
			"<summary>1 internal change</summary>",
			"",
			"- **Hidden** work.",
			"",
			"</details>",
			"",
			"## [2.0.2] - 2026-02-02",
			"",
			"### Added",
			"",
			"- **Two** works.",
			"- **Three** works.",
			"",
			"### Changed",
			"",
			"- **Four** changed.",
			"",
			"### Security",
			"",
			"- **Five** patched.",
			"",
			"### Fixed",
			"",
			"- **Six** fixed.",
			"",
			"## [2.0.1] - 2026-01-01",
			"",
			"### Internal",
			"",
			"<details>",
			"<summary>1 internal change</summary>",
			"",
			"- **Only internal** work.",
			"",
			"</details>",
			"",
		].join("\n"),
	);
	const text = rollup.renderUserChangelog({ rootDir: root });
	const link = (label: string) =>
		`Full notes: https://github.com/apmantza/pi-lens/releases/tag/v${label}`;
	expect(text).toContain(
		`## [2.0.3] - 2026-03-03\n\n1 feature, 1 other change.\n\n${link("2.0.3")}`,
	);
	expect(text).toContain(
		`## [2.0.2] - 2026-02-02\n\n2 features, 1 fix, 2 other changes.\n\n${link("2.0.2")}`,
	);
	expect(text).toContain(
		`## [2.0.1] - 2026-01-01\n\nNo user-facing changes.\n\n${link("2.0.1")}`,
	);
	expect(text).not.toMatch(/\b0 (features?|fixes?|other changes?)\b/);
});
