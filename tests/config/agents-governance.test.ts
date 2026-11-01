import * as fs from "node:fs";
import * as path from "node:path";
import { minimatch } from "minimatch";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";
import {
	blankMarkdown,
	parseDefectShapes,
} from "../../scripts/lib/defect-shapes.mjs";
import { assertNonEmptyScan, stripSource } from "../support/sweep-kit.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

function agentsText(): string {
	return fs.readFileSync(
		process.env.PI_LENS_AGENTS_PATH ?? path.join(REPO_ROOT, "AGENTS.md"),
		"utf8",
	);
}

/** The numbered catalog (#4361): AGENTS.md keeps only the trigger-grouped index. */
function catalogText(): string {
	return fs.readFileSync(path.join(REPO_ROOT, "docs/defect-shapes.md"), "utf8");
}

/** A screen states a rule: it ends a sentence, so it cannot be empty or cut. */
const SENTENCE_END = /[.!?]$/;

function shapeNumbers(text: string): number[] {
	const source = stripSource(blankMarkdown(text), { strings: "blank" });
	return [...source.matchAll(/^(\d+)\. \*\*/gm)].map((match) =>
		Number(match[1]),
	);
}

describe("AGENTS.md trigger-block governance (#3259)", () => {
	// The trigger wrappers are the loaded file's, so these two cases read
	// AGENTS.md even though docs/defect-shapes.md keeps the same wrappers around
	// the entries it owns.
	it("keeps every trigger marker standalone and paired (#3265)", () => {
		const text = agentsText();
		const literalOpenings = [...text.matchAll(/<important if=/g)].length;
		const anchoredOpenings = [...text.matchAll(/^<important if="[^"]*">$/gm)]
			.length;
		const anchoredClosings = [...text.matchAll(/^<\/important>$/gm)].length;
		expect(literalOpenings).toBe(anchoredOpenings);
		expect(anchoredOpenings).toBe(anchoredClosings);
	});

	it("gives every important block one unique non-empty trigger", () => {
		const triggers = [
			...agentsText().matchAll(/^<important if="([^"]*)">$/gm),
		].map((match) => match[1].trim());
		expect(triggers.length).toBeGreaterThan(0);
		expect(triggers.every(Boolean)).toBe(true);
		expect(new Set(triggers).size).toBe(triggers.length);
	});

	it("keeps every numbered defect shape exactly once", () => {
		const numbers = shapeNumbers(catalogText());
		expect(numbers).toHaveLength(88);
		expect(new Set(numbers).size).toBe(88);
		expect(numbers.sort((a, b) => a - b)).toEqual(
			Array.from({ length: 88 }, (_, index) => index + 1),
		);
	});

	it("does not count a counterfeit shape hidden in an HTML comment (#3265)", () => {
		// Prevents a comment counterfeit from replacing a real catalog member.
		const counterfeit = catalogText()
			.replace(/^1\. \*\*.*$/m, "")
			.concat("\n<!--\n1. **Counterfeit shape:** hidden comment\n-->\n");
		expect(shapeNumbers(counterfeit)).toHaveLength(87);
		expect(shapeNumbers(counterfeit)).not.toContain(1);
	});

	// #4361: AGENTS.md's index is a hand-kept mirror of the catalog, so an entry
	// added, renumbered or dropped on one side alone makes the loaded file and
	// the entry disagree (shape 12, a mirror refreshed outside its guard). Each
	// index line carries its entry's number, name AND screen: the two
	// populations must match on all three. The screen is the rule a dispatch
	// reads, so a hand edit that keeps the number and the name while rewording
	// the rule must red too (review 4883 F2: it did not).
	it("keeps the AGENTS.md index in step with the catalog", () => {
		const catalog = [...parseDefectShapes(catalogText())];
		const index = [...parseDefectShapes(agentsText())];
		const names = (entries: [number, string][]) =>
			entries
				.map(([number, entry]) => [
					number,
					/^\d+\. \*\*(.+?):\*\*/.exec(entry.replace(/\s+/g, " "))?.[1],
				])
				.sort((a, b) => Number(a[0]) - Number(b[0]));
		const screens = (entries: [number, string][]) =>
			new Map(
				entries.map(([number, entry]) => [
					number,
					entry
						.replace(/^\d+\. \*\*[^*]+?\*\*/, "")
						.replace(/\s+/g, " ")
						.trim(),
				]),
			);
		expect(index.length).toBe(catalog.length);
		expect(names(index)).toEqual(names(catalog));
		const catalogScreens = screens(catalog);
		const drifted = [...screens(index)]
			.filter(
				([number, screen]) => !catalogScreens.get(number)?.includes(screen),
			)
			.map(([number, screen]) => `#${number}: ${screen}`);
		// Containment is true of a whole sentence and of nothing at all, because
		// every string contains "", so the containment filter above cannot see a
		// deleted or truncated screen (review 4883 F9; the CodeRabbit thread on
		// this line). The screen is the rule a dispatch reads, so it must end a
		// sentence: an index line kept for its number and name but emptied of
		// its rule reds here.
		const silent = [...screens(index)]
			.filter(([, screen]) => !SENTENCE_END.test(screen))
			.map(([number, screen]) => `#${number}: ${JSON.stringify(screen)}`);
		// A dead comparison passes everything: the population must be read.
		expect(catalogScreens.size).toBeGreaterThan(80);
		expect(drifted, "index screens missing from their catalog entry").toEqual(
			[],
		);
		expect(silent, "index screens that state no rule").toEqual([]);
	});

	it("keeps issue and PR references in AGENTS.md from growing", () => {
		// Recurrence: PR #4270's first draft put three incident numbers into an
		// AGENTS.md rule. Maintainer, 2026-10-10: AGENTS.md stays lean and
		// HISTORY.md carries issues, PRs and examples. Lower the baseline when a
		// reference moves to HISTORY.md. The one raise (113 -> 119) is the two
		// catalog shapes the maintainer approved on 2026-10-17 (#4565); each
		// instance number is what makes a shape recognisable. The 2026-10-20
		// shapes 76-78 cite no instance number: each entry names its guard's
		// test path, and each instance date lives in `HISTORY.md` under a
		// heading naming the shape, so this pin does not move. Shape 78's guard
		// shipped (#4679), so its entry names the running path instead of a
		// branch, which adds no reference either. Shape 79 (approved by the
		// maintainer on 2026-10-20) is the second raise, 119 -> 120: its guard is
		// unbuilt, so the entry names the tracker (#4687) instead of a path, and
		// the instances stay in `HISTORY.md`. The 2026-10-21 retro adds the third
		// raise, 120 -> 121: shape 66 names the issue that drives its
		// `in-process-mock` census down (#4709), because a census without its
		// tracker names nothing a reader can act on.
		// The 2026-10-24 maintainer decision on #4682 adds the fourth raise, 121 ->
		// 124: shape 84 names its three instance issues (#4293, #4294, #4682), the
		// wording the maintainer set for the lazy axis.
		// The 2026-10-25 maintainer decision adds the fifth raise, 124 -> 125:
		// shape 86 names its unbuilt detector's tracker (#4865), as shape 79 did.
		// #4361 moves it 125 -> 55: the numbered entries, with their instance
		// numbers, now live in `docs/defect-shapes.md`, and AGENTS.md keeps an
		// index of screen sentences. The guard still ratchets what a rule line
		// adds to the loaded file.
		expect(issueRefs(agentsText())).toBeLessThanOrEqual(55);
	});

	it("counts a reference and not a heading anchor", () => {
		// Recurrence: the #4565 digest links heading anchors such as
		// `docs/engineering-principles.md#1-building`, which `#\d+\b` read as
		// twelve issue references and inflated the ratchet above its pin.
		expect(issueRefs("fixed in #4554 and #4563.")).toBe(2);
		expect(issueRefs("([§1](docs/engineering-principles.md#1-building))")).toBe(
			0,
		);
		expect(issueRefs("https://github.com/o/r/pull/4565")).toBe(1);
	});

	// #4361: the two reviewer bots are configured readers, not prose. Before the
	// split both loaded AGENTS.md alone; after it AGENTS.md carries one screen
	// line per shape and the entries, with their enforcers and censuses, live in
	// `docs/defect-shapes.md` and `docs/invariants/*.md`. A bot still told to
	// review "the section of AGENTS.md" enforces 87 screens and none of the 738
	// lines behind them (review 4883 F1).
	it("keeps every reviewer bot loading the catalog and every invariant file", () => {
		const required = [
			"AGENTS.md",
			"docs/defect-shapes.md",
			...fs
				.readdirSync(path.join(REPO_ROOT, "docs/invariants"))
				.filter((name) => name.endsWith(".md"))
				.sort()
				.map((name) => `docs/invariants/${name}`),
		];
		const bots = botCorpus();
		const gaps: string[] = [];
		for (const bot of bots) {
			// Fail closed on a dead input: a pattern that matches no file loads
			// nothing, and would still read as coverage of the paths it spells.
			assertNonEmptyScan(`${bot.file} configured inputs`, bot.inputs.length, 1);
			for (const pattern of bot.inputs)
				if (fs.globSync(pattern, { cwd: REPO_ROOT }).length === 0)
					gaps.push(`${bot.file}: "${pattern}" loads no file`);
			for (const file of required)
				if (!bot.inputs.some((pattern) => minimatch(file, pattern)))
					gaps.push(`${bot.file}: does not load ${file}`);
			if (
				!bot.instructions.some((text) => text.includes("docs/defect-shapes.md"))
			)
				gaps.push(`${bot.file}: no instruction names docs/defect-shapes.md`);
		}
		// Two bots, nine contract documents: an empty table or a short one passes
		// every loop above without reading anything.
		assertNonEmptyScan("reviewer bots parsed", bots.length, 2);
		assertNonEmptyScan("contract documents required", required.length, 9);
		expect(gaps).toEqual([]);
	});
});

/** One JSON/YAML object, or an empty one: the configs are parsed, not trusted. */
function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: {};
}

function asList(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function asStrings(value: unknown): string[] {
	return asList(value).filter(
		(item): item is string => typeof item === "string",
	);
}

/**
 * The files each reviewer bot is configured to read. CodeRabbit spells them as
 * glob patterns (`knowledge_base.code_guidelines.filePatterns`); Greptile
 * spells one path per `customContext.files` entry, and its documented syntax
 * has no glob for those (only its PR filters take globs).
 */
function botCorpus(): {
	bot: string;
	file: string;
	inputs: string[];
	instructions: string[];
}[] {
	const codeRabbit = asRecord(
		yaml.load(
			fs.readFileSync(path.join(REPO_ROOT, ".coderabbit.yaml"), "utf8"),
		),
	);
	const greptile = asRecord(
		yaml.load(fs.readFileSync(path.join(REPO_ROOT, "greptile.json"), "utf8")),
	);
	const guidelines = asRecord(
		asRecord(codeRabbit.knowledge_base).code_guidelines,
	);
	return [
		{
			bot: "CodeRabbit",
			file: ".coderabbit.yaml",
			inputs: asStrings(guidelines.filePatterns),
			instructions: asList(asRecord(codeRabbit.reviews).path_instructions).map(
				(row) => String(asRecord(row).instructions ?? ""),
			),
		},
		{
			bot: "Greptile",
			file: "greptile.json",
			inputs: asList(asRecord(greptile.customContext).files).map((row) =>
				String(asRecord(row).path ?? ""),
			),
			instructions: [String(greptile.instructions ?? "")],
		},
	];
}

function issueRefs(text: string): number {
	// `#N` of any length, and issue/PR URLs, which carry no `#` (review F-4272-1).
	// A markdown heading anchor (`#1-building`) is a fragment, not a reference.
	return [
		...blankMarkdown(text).matchAll(
			/#\d+\b(?!-[A-Za-z_])|\/(?:issues|pull)\/\d+\b/g,
		),
	].length;
}
