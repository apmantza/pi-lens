// #5351 slice 4: the release roll lists likely duplicate entries for the release
// PR body. Recurrence: the v4.4.9 release body shipped the LSP-timeout fix twice
// ("LSP timeouts now remain visible..." and "LSP navigation now reports request
// timeouts...") and the Groovy language-server row beside "Groovy is a file
// kind", because nothing compared entries at release time. The fixture is the
// verbatim 4.4.9 section of CHANGELOG.md.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	findDuplicateEntries,
	renderDuplicateChecklist,
} from "../../scripts/lib/changelog.mjs";
import { duplicateChecklist } from "../../scripts/rollup-changelog.mjs";

const section449 = fs.readFileSync(
	path.resolve("tests/fixtures/changelog-duplicates/4.4.9-section.txt"),
	"utf8",
);

const LSP_A =
	"- **LSP timeouts now remain visible to navigation consumers instead of appearing as empty results.** Distinguish silent push deadlines from genuine empty answers, disclose partial diagnostics, and persist symbol lookup failures and outer deadlines.";
const LSP_B =
	"- **LSP navigation now reports request timeouts as errors instead of empty results.** Preserve timeout details when tools reuse a service across module evaluations. A definition timeout still tries the local documentSymbol fallback and discloses the timeout when recovery succeeds.";
const DISTINCT = [
	"- **Vulture failures show the exception.** Python dead-code scan summaries and degradation reasons retain the last stderr line instead of the traceback header.",
	"- **`symbol_search` `ext:` filters now match compound suffixes (closes #5136)** — an `ext:` value matches by path suffix.",
	"- **A pytest run with errors beside passes no longer reads as passed (#5270)** — `1 passed, 1 error` was counted as a clean pass.",
];

describe("findDuplicateEntries over the real v4.4.9 section", () => {
	it("flags the LSP-timeout pair and the Groovy pair and nothing else", () => {
		const pairs = findDuplicateEntries(section449);
		expect(
			pairs.map(({ section, headlines }) => [section, ...headlines]),
		).toEqual([
			[
				"Added",
				"Built-in Groovy language server row.",
				"Groovy is a file kind",
			],
			[
				"Fixed",
				"LSP timeouts now remain visible to navigation consumers instead of appearing as empty results.",
				"LSP navigation now reports request timeouts as errors instead of empty results.",
			],
		]);
	});

	it("flags no distinct entry: a sample of three from the same section and area", () => {
		const body = `### Fixed\n\n#### Language servers\n\n${DISTINCT.join("\n\n")}\n`;
		expect(findDuplicateEntries(body)).toEqual([]);
	});
});

describe("scoping", () => {
	const body = (
		aSection: string,
		aArea: string,
		bSection: string,
		bArea: string,
	) =>
		`### ${aSection}\n\n#### ${aArea}\n\n${LSP_A}\n\n### ${bSection}\n\n#### ${bArea}\n\n${LSP_B}\n`;

	it("flags the pair when section and area match", () => {
		expect(
			findDuplicateEntries(
				body("Fixed", "Language servers", "Fixed", "Language servers"),
			),
		).toHaveLength(1);
	});

	it("does not compare entries of two areas of one section", () => {
		expect(
			findDuplicateEntries(
				body("Fixed", "Language servers", "Fixed", "Tools and reports"),
			),
		).toEqual([]);
	});

	it("does not compare entries of two sections", () => {
		expect(
			findDuplicateEntries(
				body("Fixed", "Language servers", "Changed", "Language servers"),
			),
		).toEqual([]);
	});
});

describe("renderDuplicateChecklist", () => {
	it("prints one unchecked box per pair with its area and reason", () => {
		const text = renderDuplicateChecklist(
			"4.4.9",
			findDuplicateEntries(
				`### Fixed\n\n#### Language servers\n\n${LSP_A}\n\n${LSP_B}\n`,
			),
		);
		expect(text).toBe(
			[
				"### Possible duplicate changelog entries (4.4.9)",
				"",
				'- [ ] Fixed / Language servers (headline overlap 0.42): "LSP timeouts now remain visible to navigation consumers instead of appearing as empty results." and "LSP navigation now reports request timeouts as errors instead of empty results."',
			].join("\n"),
		);
	});

	it("says so when there is nothing to check", () => {
		expect(renderDuplicateChecklist("4.5.0", [])).toBe(
			"### Possible duplicate changelog entries (4.5.0)\n\nNone found.",
		);
	});
});

describe("duplicateChecklist (the --duplicates mode)", () => {
	const roots: string[] = [];
	afterEach(() =>
		roots
			.splice(0)
			.forEach((root) => fs.rmSync(root, { recursive: true, force: true })),
	);
	function rootWith(changelog: string) {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-dups-"));
		roots.push(root);
		fs.writeFileSync(path.join(root, "CHANGELOG.md"), changelog);
		return root;
	}

	it("reads one released section and leaves CHANGELOG.md untouched", () => {
		const changelog = `# Changelog\n\n## [Unreleased]\n\n## [4.4.9] - 2026-11-05\n\n${section449}\n\n## [4.4.8] - 2026-11-01\n\n### Fixed\n\n${LSP_A}\n\n${LSP_B}\n`;
		const root = rootWith(changelog);
		const text = duplicateChecklist("4.4.9", { rootDir: root });
		expect(text.match(/^- \[ \]/gm)).toHaveLength(2);
		expect(fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8")).toBe(
			changelog,
		);
	});

	it("refuses a version with no section", () => {
		expect(() =>
			duplicateChecklist("9.9.9", {
				rootDir: rootWith("# Changelog\n\n## [Unreleased]\n"),
			}),
		).toThrow(/no \[9\.9\.9\] section/);
	});
});

// Recurrence: review r1 of this PR mutated `>=` to `>` on each signal and the
// suite stayed green, so a threshold drift (a bar nudged one entry either way)
// would have shipped unseen. Each case sits exactly on the documented bar.
describe("the bars are inclusive", () => {
	const area = (a: string, b: string) =>
		`### Fixed\n\n#### Language servers\n\n- **${a}** Body.\n\n- **${b}** Body.\n`;

	it("flags a headline overlap of exactly 0.40 (2 shared of 5 words)", () => {
		const pairs = findDuplicateEntries(
			area("Alpha beta gamma.", "Alpha beta delta epsilon."),
		);
		expect(pairs.map(({ reason }) => reason)).toEqual([
			"headline overlap 0.40",
		]);
	});

	it("does not flag a headline overlap of 0.33 (2 shared of 6 words)", () => {
		expect(
			findDuplicateEntries(
				area("Alpha beta gamma delta.", "Alpha beta epsilon zeta."),
			),
		).toEqual([]);
	});

	const spans = (n: number) =>
		["`one`", "`two`", "`three`"].slice(0, n).join(" ");
	const withSpans = (n: number) =>
		`### Fixed\n\n#### Language servers\n\n- **Kappa lambda.** ${spans(3)} and mu.\n\n- **Nu xi omicron.** ${spans(n)} and pi.\n`;

	it("flags exactly 3 shared code spans", () => {
		expect(
			findDuplicateEntries(withSpans(3)).map(({ reason }) => reason),
		).toEqual(["3 shared code spans"]);
	});

	it("does not flag 2 shared code spans", () => {
		expect(findDuplicateEntries(withSpans(2))).toEqual([]);
	});
});
