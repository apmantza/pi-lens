// flake-shape: real-process-spawn — the trigger gate's population is git's own
// tracked list (`git ls-files`), and only real git answers which paths a PR
// diff can produce: a filesystem walk admits a directory, a gitignored build
// twin and a path outside the checkout, each of which matches no diff (review
// 5754 F3).
import * as fs from "node:fs";
import * as path from "node:path";
import { minimatch } from "minimatch";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";
import { DELIVERY_SURFACES } from "../../clients/finding-delivery-gate.js";
import {
	blankMarkdown,
	parseDefectShapes,
	sourceWithoutFencedBlocks,
} from "../../scripts/lib/defect-shapes.mjs";
import { gitExecFileSync } from "../support/git-fixture-env.js";
import { assertNonEmptyScan, stripSource } from "../support/sweep-kit.js";
import { TREE_WALK_TIMEOUT_MS } from "../support/test-timeout-scale.js";

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

/** Issue and PR references `docs/defect-shapes.md` may carry; shrink-only (#4361). */
const CATALOG_REF_CEILING = 47;

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
		// The pairing is `blockTagProblems`', not a second count: two totals agree
		// with a closer before its opener and with a nested opener (review 5754
		// r3), so this case reads the same tag scan the catalog does.
		expect(blockTagProblems(agentsText().split("\n"))).toEqual([]);
	});

	it("gives every important block one unique non-empty trigger", () => {
		const triggers = [
			...agentsText().matchAll(/^<important if="([^"]*)">$/gm),
		].map((match) => match[1].trim());
		expect(triggers.length).toBeGreaterThan(0);
		expect(triggers.every(Boolean)).toBe(true);
		expect(new Set(triggers).size).toBe(triggers.length);
	});

	// #5753 item 1: the orchestrator's brief generators inject only the blocks a
	// diff matches, so a block with no machine trigger (or one whose globs match
	// no file) would silently never load, or always load. Recurrence this
	// prevents: a block added or retitled without its trigger line, a glob typo
	// that reads as coverage while matching nothing, a block quoted in a code
	// fence or commented out, and an opener spelled any way the gate cannot read
	// (review 5754 F1).
	it(
		"gives every catalog block a machine-readable trigger line (#5753)",
		() => {
			const raw = catalogText();
			// Blanked: a fenced example or a commented-out opener is prose, so it
			// neither counts as a block nor hides the one it replaced.
			const blanked = blankMarkdown(raw).split("\n");
			// Fenced-code-blanked only: the trigger line IS an HTML comment, so the
			// blanking the opener read needs would erase the line it names.
			const withComments = sourceWithoutFencedBlocks(raw).split("\n");
			const problems = blockTagProblems(blanked);
			let blocks = 0;
			blanked.forEach((line, index) => {
				if (!/^<important if="[^"]*">$/.test(line)) return;
				blocks += 1;
				for (const problem of triggerProblems(withComments[index + 1] ?? ""))
					problems.push(`line ${index + 1} (${line}): ${problem}`);
			});
			assertNonEmptyScan("catalog blocks with a trigger", blocks, 7);
			expect(problems).toEqual([]);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it("refuses a catalog block opener it cannot classify (#5753)", () => {
		// Review 5754 F1: the scan skipped every opener that was not the anchored
		// form, so an unclassified spelling shipped with no trigger line while
		// the other blocks satisfied the floor. A commented-out or fenced example
		// is the mirror case: it must not stand in for a block either.
		expect(
			refuseBlockTags(
				'<important if="a">\n<!-- trigger: {"always": true} -->\n</important>\n',
			),
		).toBe("");
		for (const opener of [
			"<important if='a'>",
			'<important if="a"> ',
			'  <important if="a">',
			'<important when="a">',
			"<important>",
		])
			expect(refuseBlockTags(`${opener}\n</important>\n`), opener).toMatch(
				/standalone/,
			);
		// A fenced or commented example is prose, and the reader sees no block.
		expect(refuseBlockTags('```\n<important if="example">\n```\n')).toBe("");
		expect(refuseBlockTags('<!--\n<important if="hidden">\n-->\n')).toBe("");
		expect(refuseBlockTags('<important if="a">\n')).toMatch(/closers/);
		expect(refuseBlockTags("</important>\n")).toMatch(/never opened/);
	});

	// Review 5754 r3: `blockTagProblems` compared opener and closer totals, so
	// every case below balanced and passed while the reader saw a broken tag
	// tree (shape 43: a gate matches structure, not a count).
	it("refuses a closer that arrives before its opener (#5753)", () => {
		expect(refuseBlockTags('</important>\n<important if="a">\n')).toMatch(
			/never opened/,
		);
	});

	it("refuses an opener nested inside an open block (#5753)", () => {
		expect(
			refuseBlockTags(
				'<important if="a">\n<!-- trigger: {"always": true} -->\n<important if="b">\n</important>\n</important>\n',
			),
		).toMatch(/inside an unclosed block/);
	});

	it("refuses a block left unclosed at the end (#5753)", () => {
		expect(
			refuseBlockTags(
				'<important if="a">\n<!-- trigger: {"always": true} -->\n',
			),
		).toMatch(/never closed/);
	});

	it("refuses a closer spelling it cannot classify (#5753)", () => {
		for (const closer of [
			" </important>",
			"</important> ",
			"</important >",
			"</important foo>",
			"x</important>",
		])
			expect(
				refuseBlockTags(`<important if="a">\n${closer}\n`),
				closer,
			).toMatch(/standalone/);
	});

	// #5753 item 1: block 3 governs the delivery surfaces and lanes, so its paths
	// must reach every surface the registry names. `DELIVERY_SURFACES` in
	// `clients/finding-delivery-gate.ts` IS that registry; a hand-kept path list
	// drifted from it and left 12 of 22 surfaces loading no block (review 5754
	// F4).
	it("covers every registered delivery surface in the lane block (#5753)", () => {
		const lane = catalogTriggers().get("a delivery surface or lane");
		expect(
			lane,
			"a catalog block named `a delivery surface or lane` with a trigger",
		).toBeDefined();
		const paths = asStrings(asRecord(lane).paths);
		const files = [
			...new Set([
				...Object.values(DELIVERY_SURFACES).map((surface) => surface.file),
				// Shape 10's screen names `unansweredPrimaries`, defined here.
				"clients/lsp/index.ts",
			]),
		].sort();
		assertNonEmptyScan("registered delivery surfaces", files.length, 22);
		expect(
			files.filter(
				(file) => !paths.some((glob) => minimatch(file, glob, { dot: true })),
			),
			"delivery surfaces the lane block's paths do not reach",
		).toEqual([]);
	});

	it(
		"refuses a trigger line the gate cannot read (#5753)",
		() => {
			// Recurrence: a gate that passes a trigger it cannot resolve. Each planted
			// line is one spelling the catalog test above must red on.
			const refused = (line: string) => triggerProblems(line).join("; ");
			expect(refused("")).toMatch(/no `<!-- trigger/);
			expect(refused('<!-- trigger: {"paths": []} -->')).toMatch(/non-empty/);
			expect(
				refused('<!-- trigger: {"paths": ["no/such/dir/**"]} -->'),
			).toMatch(/matches no tracked file/);
			expect(refused('<!-- trigger: {"always": false} -->')).toMatch(/always/);
			expect(
				refused('<!-- trigger: {"always": true, "diff": "x"} -->'),
			).toMatch(/always/);
			expect(refused('<!-- trigger: {"glob": ["a"]} -->')).toMatch(/unknown/);
			expect(refused("<!-- trigger: {} -->")).toMatch(/no path/);
			expect(refused("<!-- trigger: {oops} -->")).toMatch(/parse/);
			expect(refused('<!-- trigger: {"diff": "("} -->')).toMatch(/compile/);
			// Review 5754 F2: every guard in `triggerProblems` reds under a hand
			// mutation, so every one of them carries a plant. A guard no plant can
			// red is a guard that does not need to exist.
			expect(refused("<!-- trigger: [] -->")).toMatch(/not an object/);
			expect(refused("<!-- trigger: null -->")).toMatch(/not an object/);
			expect(refused('<!-- trigger: {"paths": "index.ts"} -->')).toMatch(
				/non-empty list of globs/,
			);
			expect(refused('<!-- trigger: {"paths": [""]} -->')).toMatch(
				/non-empty list of globs/,
			);
			expect(refused('<!-- trigger: {"diff": ""} -->')).toMatch(
				/non-empty regex string/,
			);
			expect(refused('<!-- trigger: {"diff": 1} -->')).toMatch(
				/non-empty regex string/,
			);
			// Review 5754 F3: an empty alternation branch makes a regex match every
			// added line of every diff, so it is `{"always": true}` respelled.
			expect(refused('<!-- trigger: {"diff": "foo|"} -->')).toMatch(
				/matches the empty string/,
			);
			expect(refused('<!-- trigger: {"diff": "^"} -->')).toMatch(
				/matches the empty string/,
			);
			// Review 5754 F3: the population is git's tracked set, so a selector that
			// only reaches a directory or a gitignored build twin is dead in every
			// real diff, and one outside the checkout is never in one.
			for (const glob of ["clients/lsp", "clients/path-*.js"])
				expect(
					refused(`<!-- trigger: {"paths": ["${glob}"]} -->`),
					`${glob} selects no tracked file`,
				).toMatch(/matches no tracked file/);
			expect(
				refused('<!-- trigger: {"paths": ["/etc/hosts"]} -->'),
				"a path outside the checkout is never in a diff",
			).toMatch(/is not relative to the repo/);
			// Review 5754 F1: a `-->` inside the JSON ends the comment before it ends.
			expect(refused('<!-- trigger: {"diff": "a-->b"} -->')).toMatch(
				/ends the comment/,
			);
			expect(refused('<!-- trigger: {"always": true} -->')).toBe("");
			expect(
				refused('<!-- trigger: {"paths": ["index.ts"], "diff": "x"} -->'),
			).toBe("");
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it("keeps every numbered defect shape exactly once", () => {
		const numbers = shapeNumbers(catalogText());
		expect(numbers).toHaveLength(94);
		expect(new Set(numbers).size).toBe(94);
		expect(numbers.sort((a, b) => a - b)).toEqual(
			Array.from({ length: 94 }, (_, index) => index + 1),
		);
	});

	it("does not count a counterfeit shape hidden in an HTML comment (#3265)", () => {
		// Prevents a comment counterfeit from replacing a real catalog member.
		const counterfeit = catalogText()
			.replace(/^1\. \*\*.*$/m, "")
			.concat("\n<!--\n1. **Counterfeit shape:** hidden comment\n-->\n");
		expect(shapeNumbers(counterfeit)).toHaveLength(93);
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

	// #4361: the retro contract (`docs/pi-lens-retro.md` step 4) keeps a shape's
	// issues, PRs, rounds and dated sweeps in HISTORY.md under a heading that
	// names the shape, so a catalog entry stays a lean screen. Before this pin
	// the ratchet above read AGENTS.md alone, and `docs/defect-shapes.md` grew
	// 75 references and nine dated sweeps ("Sweep 2026-10-07 ...", "On
	// 2026-10-18 five detector PRs took two to six rounds ...", "Three rounds
	// on the read guard's authorship seam (#4187 ...)") that no check read.
	// A reference that names a guard's tracker or a census stays; a story moves.
	it("keeps incident stories out of docs/defect-shapes.md (#4361)", () => {
		const catalog = catalogText();
		const dated = [
			...blankMarkdown(catalog).matchAll(/\b20\d\d-\d\d-\d\d\b/g),
		].map((match) => match[0]);
		expect(
			dated,
			"a dated sweep or incident belongs in HISTORY.md under a heading naming the shape",
		).toEqual([]);
		expect(issueRefs(catalog)).toBeLessThanOrEqual(CATALOG_REF_CEILING);
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
			"docs/ci.md",
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

/**
 * What is wrong with the line after a catalog block's opener (#5753): it must
 * be `<!-- trigger: {...} -->` whose JSON is `{"always": true}` alone, or names
 * `paths` (a non-empty list of repo-relative globs that each select a
 * git-tracked file) and/or `diff` (a regex that compiles and does not match the
 * empty string, i.e. every added line of every diff). Anything else, including
 * an unknown key, is a problem: the gate admits the known forms and refuses
 * the rest.
 */
function triggerProblems(line: string): string[] {
	const match = /^<!-- trigger: (.*) -->$/.exec(line);
	if (!match)
		return ["no `<!-- trigger: {...} -->` line directly after the opener"];
	// A JSON string holding `-->` ends the HTML comment before its own end, so
	// the reader sees a truncated object and the tail as prose (review 5754 F1).
	if (match[1].includes("-->"))
		return ["trigger carries `-->` inside its JSON, which ends the comment"];
	let trigger: unknown;
	try {
		trigger = JSON.parse(match[1]);
	} catch {
		return ["trigger JSON does not parse"];
	}
	if (typeof trigger !== "object" || trigger === null || Array.isArray(trigger))
		return ["trigger JSON is not an object"];
	const record = trigger as Record<string, unknown>;
	const keys = Object.keys(record);
	const problems: string[] = [];
	const unknown = keys.filter(
		(key) => !["always", "paths", "diff"].includes(key),
	);
	if (unknown.length > 0)
		problems.push(`unknown trigger key ${unknown.join(", ")}`);
	if (record.always !== undefined) {
		if (record.always !== true || keys.length !== 1)
			problems.push('"always" is `{"always": true}` alone');
		return problems;
	}
	if (record.paths === undefined && record.diff === undefined)
		problems.push("trigger names no path, diff or always key");
	if (record.paths !== undefined) {
		const paths = record.paths;
		if (
			!Array.isArray(paths) ||
			paths.length === 0 ||
			!paths.every((glob) => typeof glob === "string" && glob.length > 0)
		)
			problems.push('"paths" is not a non-empty list of globs');
		else
			for (const glob of paths) {
				// The population is the tracked set `git diff --name-only` draws from,
				// never the working tree: a directory, a gitignored build twin and a path
				// outside the checkout all match something on disk and nothing in a diff
				// (review 5754 F3).
				if (path.isAbsolute(glob) || /(^|\/)\.\.(\/|$)/.test(glob))
					problems.push(`glob "${glob}" is not relative to the repo`);
				else if (
					!trackedFiles().some((file) => minimatch(file, glob, { dot: true }))
				)
					problems.push(`glob "${glob}" matches no tracked file`);
			}
	}
	if (record.diff !== undefined) {
		if (typeof record.diff !== "string" || record.diff.length === 0)
			problems.push('"diff" is not a non-empty regex string');
		else {
			let regex: RegExp | undefined;
			try {
				regex = new RegExp(record.diff);
			} catch {
				problems.push('"diff" does not compile as a RegExp');
			}
			// A regex that matches the empty string fires on every added line of
			// every diff, which is `{"always": true}` respelled (review 5754 F3).
			if (regex?.test("")) problems.push('"diff" matches the empty string');
		}
	}
	return problems;
}

/** `blockTagProblems` over one markdown document, joined for one assertion. */
function refuseBlockTags(markdown: string): string {
	return blockTagProblems(blankMarkdown(markdown).split("\n")).join("; ");
}

/**
 * Problems with the `AGENTS.md` and catalog `<important` tags, read from
 * markdown-blanked lines (#5753 review 5754 F1, r3). Every tag must be the
 * standalone form this gate reads, and a block must open before it closes:
 * an opener spelled any other way would ship with no trigger line while the
 * other blocks satisfied the floor, a commented-out opener would hide its
 * block from the reader while still counting here, and a count of openers
 * against closers accepts a closer before its opener and an opener nested in
 * an open block. The depth is tracked in source order for that reason
 * (AGENTS.md shapes 43 and 69: a detector matches code, not prose, and fails
 * closed on what it does not recognize).
 */
function blockTagProblems(blankedLines: readonly string[]): string[] {
	const problems: string[] = [];
	// The line of the open block, or 0 at depth 0: nesting is refused, so the
	// depth never exceeds one and the opener's line is what a later problem
	// needs to name.
	let openedAt = 0;
	blankedLines.forEach((line, index) => {
		const at = `line ${index + 1}`;
		if (line.includes("<important")) {
			if (!/^<important if="[^"]*">$/.test(line))
				problems.push(
					`${at}: ${JSON.stringify(line.trim())} is not the standalone \`<important if="...">\` opener`,
				);
			else if (openedAt > 0)
				problems.push(
					`${at}: ${JSON.stringify(line.trim())} is an opener inside an unclosed block (line ${openedAt})`,
				);
			else openedAt = index + 1;
		}
		// The closer rule mirrors the opener rule: a `</important` spelling this
		// gate cannot read is refused, never counted as an opener's partner.
		if (line.includes("</important")) {
			if (!/^<\/important>$/.test(line))
				problems.push(
					`${at}: ${JSON.stringify(line.trim())} is not the standalone \`</important>\` closer`,
				);
			else if (openedAt === 0)
				problems.push(
					`${at}: \`</important>\` closes a block that was never opened`,
				);
			else openedAt = 0;
		}
	});
	if (openedAt > 0)
		problems.push(
			`\`</important>\` closers are missing: the block opened at line ${openedAt} is never closed`,
		);
	return problems;
}

/** The catalog's block names, each with the trigger JSON after its opener. */
function catalogTriggers(): Map<string, unknown> {
	const blanked = blankMarkdown(catalogText()).split("\n");
	const withComments = sourceWithoutFencedBlocks(catalogText()).split("\n");
	const triggers = new Map<string, unknown>();
	blanked.forEach((line, index) => {
		const opener = /^<important if="([^"]*)">$/.exec(line);
		if (!opener) return;
		const trigger = /^<!-- trigger: (.*) -->$/.exec(
			withComments[index + 1] ?? "",
		);
		if (trigger) triggers.set(opener[1], JSON.parse(trigger[1]));
	});
	return triggers;
}

/** `git ls-files` of this checkout, read once: the population a diff draws from. */
let trackedFileList: string[] | undefined;
function trackedFiles(): string[] {
	trackedFileList ??= gitExecFileSync("git", ["ls-files", "-z"], {
		cwd: REPO_ROOT,
		encoding: "utf8",
	})
		.split("\0")
		.filter(Boolean);
	return trackedFileList;
}

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
