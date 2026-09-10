import * as fs from "node:fs";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";
import { DRIFT_ISSUE_LABEL } from "../../scripts/lib/drift-issue.mjs";
import { assertNonEmptyScan } from "../support/sweep-kit.js";
import { docsSectionLines } from "../support/docs-section.js";

/**
 * `.github/workflows/labels.yml` runs `micnncim/action-label-syncer` with
 * `prune: true`, dispatched on every merge-train post-merge
 * (`repository_dispatch: merge-train-post-merge`), against
 * `.github/labels.yml`. Prune means the manifest is the label set: any live
 * label absent from it is DELETED on the next sync. #2553's manifest never
 * listed `priority:p1`/`p2`/`p3`, so every sync silently stripped the
 * priority label off every open issue (run 34042925533's log, verbatim:
 * "label: priority:p3 deleted from: apmantza/pi-lens", then p1, p2).
 *
 * This sweep is the backstop: it fails loud, before the syncer ever runs,
 * whenever the manifest drops a label one of this repo's own written rules
 * requires to exist.
 *
 * #2553 review round 1 F1: the first cut of this sweep only derived 19 of
 * the manifest's 30 labels (the AREA set plus a HAND-COPIED
 * `REQUIRED_NON_AREA_LABELS` list) — removing `bug` (AGENTS.md's mandatory
 * TYPE label) or `help wanted` (AGENTS.md's "reuse GitHub defaults" list)
 * left it green while the syncer would still delete either on the next
 * sync (shape 38: a guard whose admission a convenient omission satisfies
 * away). The fix derives EVERY required label from the text and tooling
 * that actually reference it, rather than hand-copying a second list that
 * can silently drift from what those sources say — the TYPE, AREA and
 * "reuse GitHub defaults" labels come from AGENTS.md's own
 * "Issue triage & labels" section, and the merge-train warden's labels
 * come from grepping the merge-train skill, its `scripts/lib/merge-train-*`
 * modules, and every `.github/workflows/*.yml` file for their literal
 * label strings.
 */

const REPO_ROOT = resolve(import.meta.dirname, "../..");

interface LabelEntry {
	name: string;
	color?: string;
	description?: string;
}

function readFile(relPath: string): string {
	return readFileSync(resolve(REPO_ROOT, relPath), "utf8");
}

function readLabelManifest(): { raw: string; labels: LabelEntry[] } {
	const raw = readFile(".github/labels.yml");
	const labels = yaml.load(raw) as LabelEntry[];
	return { raw, labels };
}

// ── AGENTS.md's "Issue triage & labels" section, block-parsed ──────────────
//
// #2553 review F2: the first cut read the AREA line with `indexOf` + a
// SINGLE `line.slice(markerIndex, nextNewline)` — a list that wrapped onto a
// second physical line would silently lose everything after the wrap, with
// no failure. Every block below is instead collected line-by-line from its
// start marker until a line that does not belong to it, so a wrap grows the
// block instead of truncating it.

const ISSUE_TRIAGE_HEADING = "## Issue triage & labels";

/**
 * The lines of AGENTS.md's "Issue triage & labels" section, heading
 * excluded. Shares `docsSectionLines` with the docs-membership guard
 * (`tests/docs/features-counts.test.ts`); the `/\n## /` boundary is that
 * section's own rule, not the default any-ATX-heading one.
 */
function issueTriageSectionLines(agentsMd: string): string[] {
	return docsSectionLines(agentsMd, ISSUE_TRIAGE_HEADING, /\n## /);
}

/**
 * Collect `lines[startsWith...]` plus every immediately following line
 * `continues` still accepts. Not a single line, and not an unbounded
 * lookahead either — the block ends at the first line that breaks the
 * predicate, which is what lets a wrapped continuation line join the block
 * while the NEXT bullet point (which the predicate must reject) ends it.
 */
function collectBlock(
	lines: readonly string[],
	blockName: string,
	startsWith: (line: string) => boolean,
	continues: (line: string) => boolean,
): string[] {
	const startIndex = lines.findIndex(startsWith);
	if (startIndex === -1) {
		throw new Error(
			`${blockName}: expected block start not found in AGENTS.md's ` +
				`"${ISSUE_TRIAGE_HEADING}" section — did the doc get reworded? ` +
				"Update this sweep's marker to match.",
		);
	}
	const block = [lines[startIndex]];
	for (let i = startIndex + 1; i < lines.length; i++) {
		if (!continues(lines[i])) break;
		block.push(lines[i]);
	}
	return block;
}

/** Every backtick-quoted, lowercase, label-shaped token in `text`. */
function labelShapedBacktickTokens(text: string): string[] {
	return [...text.matchAll(/`([a-z][a-z0-9_: -]*)`/g)].map((m) => m[1]);
}

/** The four TYPE labels, from the "- **TYPE (pick one):**" sub-bullet list. */
function typeLabelsFromSection(lines: readonly string[]): string[] {
	const block = collectBlock(
		lines,
		"TYPE block",
		(line) => line.trim() === "- **TYPE (pick one):**",
		// Only the label sub-bullets (`  - \`name\` — ...`) continue the block;
		// the trailing "Litmus, feature vs enhancement: ..." sub-bullet does
		// NOT start with a backtick and correctly ends it.
		(line) => /^\s*- `/.test(line),
	);
	return labelShapedBacktickTokens(block.slice(1).join("\n"));
}

/** The AREA labels, from the "- **AREA (one or more...):**" bullet. */
function areaLabelsFromSection(lines: readonly string[]): string[] {
	const block = collectBlock(
		lines,
		"AREA block",
		(line) => line.trim().startsWith("- **AREA (one or more"),
		(line) => line.trim() !== "" && !line.trim().startsWith("- "),
	);
	const names = [...block.join(" ").matchAll(/`(area:[a-z-]+)`/g)].map(
		(m) => m[1],
	);
	assertNonEmptyScan(
		"label-manifest-coverage: AGENTS.md AREA labels",
		names.length,
	);
	return names;
}

/** The GitHub-default labels named on the "Reuse GitHub defaults" bullet. */
function reuseDefaultLabelsFromSection(lines: readonly string[]): string[] {
	const block = collectBlock(
		lines,
		"Reuse-GitHub-defaults block",
		(line) => line.trim().startsWith("- Reuse GitHub defaults"),
		(line) => line.trim() !== "" && !line.trim().startsWith("- "),
	);
	return labelShapedBacktickTokens(block.join(" "));
}

// ── Merge-train label literals ──────────────────────────────────────────────
//
// Enumerated by directory scan, not a hand-typed file list, so a new
// `scripts/lib/merge-train-*.mjs` module or `.github/workflows/*.yml`
// workflow is swept in automatically rather than needing this test updated
// in lockstep (the same single-source-of-truth reasoning as the AREA list).

function filesMatching(dir: string, pattern: RegExp): string[] {
	return fs
		.readdirSync(resolve(REPO_ROOT, dir))
		.filter((name) => pattern.test(name))
		.map((name) => `${dir}/${name}`)
		.sort();
}

const MERGE_TRAIN_LITERAL_SOURCE_FILES = [
	".claude/skills/merge-train/SKILL.md",
	...filesMatching("scripts/lib", /^merge-train-.*\.mjs$/),
	...filesMatching(".github/workflows", /\.ya?ml$/),
];

/**
 * Every `train:*`, `red-ci`, `conflict` and `priority:*` label literal named
 * in the merge-train skill doc, its `scripts/lib/merge-train-*.mjs` seams,
 * or any workflow file. `priority:p1|p2|p3` is the skill doc's own
 * pipe-alternation shorthand for three labels, not one — expanded here
 * rather than mis-read as a single literal string.
 */
function mergeTrainLabelLiterals(): string[] {
	const names = new Set<string>();
	for (const relPath of MERGE_TRAIN_LITERAL_SOURCE_FILES) {
		const text = readFile(relPath);
		for (const m of text.matchAll(/\btrain:[a-z]+\b/g)) names.add(m[0]);
		for (const m of text.matchAll(/\bred-ci\b/g)) names.add(m[0]);
		for (const m of text.matchAll(/\bconflict\b/g)) names.add(m[0]);
		for (const m of text.matchAll(/\bpriority:((?:p\d+)(?:\|p\d+)*)\b/g)) {
			for (const alt of m[1].split("|")) names.add(`priority:${alt}`);
		}
	}
	assertNonEmptyScan(
		"label-manifest-coverage: merge-train label literals",
		names.size,
	);
	return [...names];
}

/**
 * Every label name this repo's own written rules and tooling require to
 * exist: AGENTS.md's TYPE, AREA and "reuse GitHub defaults" labels, plus
 * every merge-train label literal. No hand-copied list sits alongside these
 * derivations (#2553 review F1's `REQUIRED_NON_AREA_LABELS` is gone) — a
 * label that stops being referenced anywhere in these sources simply stops
 * being required, which is the correct direction: this sweep polices drift
 * FROM the sources, not an opinion frozen at write time.
 */
function requiredLabels(): string[] {
	const sectionLines = issueTriageSectionLines(readFile("AGENTS.md"));
	const required = new Set([
		...typeLabelsFromSection(sectionLines),
		...areaLabelsFromSection(sectionLines),
		...reuseDefaultLabelsFromSection(sectionLines),
		...mergeTrainLabelLiterals(),
		// #2723 review F1: `notify-tool-smoke-red.mjs`'s `gh issue create
		// --label nightly-drift,area:tests` 404'd on this exact label because
		// nothing required its existence here -- the manifest is the ONLY
		// place a label may be added (this file's own module doc), so a
		// consumer importing DRIFT_ISSUE_LABEL is a real requirement on it,
		// derived from the source rather than hand-typed a second time.
		DRIFT_ISSUE_LABEL,
	]);
	return [...required];
}

describe("label manifest coverage (#2553)", () => {
	it("contains every label this repo's rules require to exist", () => {
		const { labels } = readLabelManifest();
		// Floor kept near the manifest's current size (30): a scan that
		// silently read a truncated or empty YAML file must not pass as
		// "nothing missing" just because nothing was required of it either.
		assertNonEmptyScan(
			"label-manifest-coverage: manifest entries",
			labels.length,
			25,
		);
		const names = new Set(labels.map((l) => l.name));

		const required = requiredLabels();
		// Same reasoning, for the derived requirement side: today's derived
		// set is 28 labels (4 TYPE + 12 AREA + 5 reuse-defaults + 7
		// merge-train literals) — a floor near that catches the derivation
		// itself silently collapsing, not just a manifest that dropped one.
		assertNonEmptyScan(
			"label-manifest-coverage: derived required labels",
			required.length,
			25,
		);
		const missing = required.filter((name) => !names.has(name));

		expect(missing).toEqual([]);
	});

	it("documents the syncer's prune behavior above the priority block", () => {
		const { raw } = readLabelManifest();
		const lines = raw.split("\n");
		const priorityIndex = lines.findIndex((line) =>
			/^-\s*name:\s*priority:p1\s*$/.test(line.trim()),
		);
		expect(priorityIndex).toBeGreaterThan(-1);

		// The documenting comment must sit ABOVE the priority block (so the
		// next person adding a label by hand sees it before they skip this
		// file), and must name both "prune" and the issue that found the gap
		// (#2553) — a comment naming neither is not documentation, just prose.
		const commentBlockAbove = lines
			.slice(0, priorityIndex)
			.filter((line) => /^\s*#/.test(line));
		const commentText = commentBlockAbove.join("\n");
		expect(commentText).toMatch(/prune/i);
		expect(commentText).toMatch(/#2553/);
	});
});
