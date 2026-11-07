// #5351: release highlights have a home. Recurrence: v4.4.10 shipped its
// highlights through a hand `gh release edit` / `relnotes-regen.sh --highlights`
// because nothing in the repo carried them, and the first draft of the release
// doc pointed them at CHANGELOG-USER.md, which stays count-only (#5264). The
// input is `.changelog/highlights/<version>.md`; `changelog-extract --summary`
// (what release.yml passes) prepends it, `--check` refuses a malformed one.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readHighlights } from "../../scripts/lib/changelog.mjs";
import {
	renderUserChangelog,
	rollupChangelog,
	validateChangelogEntries,
} from "../../scripts/rollup-changelog.mjs";

const GOOD = [
	"### Highlights",
	"",
	"- Rules now report their fix hint.",
	"- Install updates show counts.",
	"- Groovy is a file kind.",
	"",
].join("\n");
const SECTION =
	"### Fixed\n\n- **Stop reading stale files.** Body text here. (refs #1)\n";
const CHANGELOG = `# Changelog\n\n## [Unreleased]\n\n## [2.0.0] - 2026-01-01\n\n${SECTION}`;

const roots: string[] = [];
afterEach(() =>
	roots
		.splice(0)
		.forEach((root) => fs.rmSync(root, { recursive: true, force: true })),
);
function rootWith(files: Record<string, string>) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-highlights-"));
	roots.push(root);
	fs.writeFileSync(path.join(root, "CHANGELOG.md"), CHANGELOG);
	for (const [name, text] of Object.entries(files)) {
		fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
		fs.writeFileSync(path.join(root, name), text);
	}
	return root;
}
const highlights = (text: string, version = "2.0.0") => ({
	[`.changelog/highlights/${version}.md`]: text,
});

describe("readHighlights", () => {
	it("returns the approved block, for a bare or v-prefixed version", () => {
		const root = rootWith(highlights(GOOD));
		expect(readHighlights(root, "2.0.0")).toBe(GOOD.trimEnd());
		expect(readHighlights(root, "v2.0.0")).toBe(GOOD.trimEnd());
	});

	it("returns null when the version has no file, or is not a plain x.y.z", () => {
		const root = rootWith(highlights(GOOD));
		expect(readHighlights(root, "2.0.1")).toBeNull();
		// A version is never joined into a path unless it is x.y.z: this one would
		// otherwise read the fixture's own CHANGELOG.md as a highlights file.
		expect(readHighlights(root, "../../CHANGELOG")).toBeNull();
		expect(readHighlights(root, "Unreleased")).toBeNull();
	});

	it.each([
		["a wrong first line", GOOD.replace("### Highlights", "## Highlights")],
		["two bullets", "### Highlights\n\n- One.\n- Two.\n"],
		["six bullets", `### Highlights\n\n${"- Bullet.\n".repeat(6)}`],
		[
			"prose between bullets",
			GOOD.replace("\n- Groovy", "\nSome prose.\n- Groovy"),
		],
		["an empty bullet", GOOD.replace("- Groovy is a file kind.", "- ")],
		["CRLF line endings", GOOD.replaceAll("\n", "\r\n")],
	])("refuses %s", (_name, text) => {
		const root = rootWith(highlights(text));
		expect(() => readHighlights(root, "2.0.0")).toThrow(
			/must be "### Highlights" then 3 to 5/,
		);
	});

	it("accepts exactly 3 and exactly 5 bullets", () => {
		for (const n of [3, 5]) {
			const root = rootWith(
				highlights(`### Highlights\n\n${"- Bullet.\n".repeat(n)}`),
			);
			expect(readHighlights(root, "2.0.0")).toMatch(/^### Highlights/);
		}
	});
});

describe("--check (validateChangelogEntries)", () => {
	it("accepts a well-formed highlights file", () => {
		const root = rootWith(highlights(GOOD));
		expect(() => validateChangelogEntries({ rootDir: root })).not.toThrow();
	});

	it("refuses a malformed file, naming it", () => {
		const root = rootWith(highlights("### Highlights\n\n- Only one.\n"));
		expect(() => validateChangelogEntries({ rootDir: root })).toThrow(
			/highlights\/2\.0\.0\.md must be/,
		);
	});

	it.each([["notes.md"], ["v2.0.0.md"], ["2.0.0.txt"], ["README.md"]])(
		"refuses %s: only <x.y.z>.md files belong there",
		(name) => {
			const root = rootWith({ [`.changelog/highlights/${name}`]: GOOD });
			expect(() => validateChangelogEntries({ rootDir: root })).toThrow(
				/expected a file named <x\.y\.z>\.md/,
			);
		},
	);

	it("refuses a subdirectory", () => {
		const root = rootWith({ ".changelog/highlights/1.0.0.md/x": GOOD });
		expect(() => validateChangelogEntries({ rootDir: root })).toThrow(
			/expected a file named/,
		);
	});
});

describe("the roll", () => {
	it("leaves .changelog/highlights/ alone and does not read it as a fragment", () => {
		const root = rootWith({
			...highlights(GOOD, "3.0.0"),
			".changelog/a.md":
				"---\nsection: Fixed\naudience: user\narea: lsp\n---\n\n- **A fragment still rolls into its release.** Body. (refs #2)\n",
		});
		const result = rollupChangelog("3.0.0", {
			rootDir: root,
			date: "2026-02-02",
		});
		expect(result.files).toHaveLength(1);
		expect(fs.existsSync(path.join(root, ".changelog/a.md"))).toBe(false);
		expect(
			fs.readFileSync(
				path.join(root, ".changelog/highlights/3.0.0.md"),
				"utf8",
			),
		).toBe(GOOD);
	});

	it("keeps CHANGELOG-USER.md count-only: no highlight text reaches it", () => {
		const root = rootWith(highlights(GOOD));
		expect(renderUserChangelog({ rootDir: root })).not.toContain("Groovy");
	});
});
