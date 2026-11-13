/**
 * #5072 bullet 3: every checked-in baseline has an owner test that can prove it
 * fails on a stale row.
 *
 * The check itself lives in `tests/support/baseline-owner-check.ts`: it
 * discovers the baseline-shaped population, classifies it, and reports every
 * ledger with no owner test or no planted-stale-row cell. This file is that
 * check's owner. It runs the check over the repo and holds the cells that prove
 * the check reddens when its own rows go stale — including this file's own
 * ledger, the admission map in
 * `tests/support/baseline-owner-admissions.ts`.
 *
 * The shape a cell has to take, and why a comment does not count, are documented
 * at `expectPlantedStaleRow` in `tests/support/baseline-staleness.ts`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { walkFiles } from "../../scripts/lib/walk-files.mjs";
import { assertNonEmptyScan, relativePosix } from "../support/sweep-kit.js";
import { expectPlantedStaleRow } from "../support/baseline-staleness.js";
import {
	BASELINE_OWNER_ADMISSIONS,
	type BaselineOwnerAdmission,
	SEAM_TEST_CALL_FILES,
} from "../support/baseline-owner-admissions.js";
import {
	baselineGovernanceFindings,
	baselineGovernanceReport,
	classifyBaselines,
	type BaselineCandidate,
} from "../support/baseline-owner-check.js";
import { TREE_WALK_TIMEOUT_MS } from "../support/test-timeout-scale.js";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
);

interface TreeSources {
	readonly sources: Map<string, string>;
	readonly walkedTestFiles: number;
}

let tree: TreeSources | undefined;

/** Top-level entries the census never walks: dependencies and build output. */
const UNWALKED_TOP_LEVEL = new Set(["node_modules", "dist"]);

/**
 * Read the repo once: every file the census can classify, plus every
 * `*.test.ts` the owner search reads. The population is the whole repository —
 * a ledger can sit anywhere, and an exported row table can sit in a file with no
 * "baseline" in its name — so the entry filter drops only what cannot be either.
 * Descent is entered one top-level directory at a time because `walkFiles`
 * recurses every directory it is not told to skip a file in: handed the repo
 * root, it would walk a real `node_modules` (a symlink here, so this checkout
 * would not show it) and call a third party's `*-baseline.json` ours.
 */
function readRepoSources(): TreeSources {
	if (tree) return tree;
	const isCandidate = (name: string): boolean => {
		const ext = path.extname(name);
		return ext === ".ts" || ext === ".tsx" || ext === ".json";
	};
	const walked: string[] = [];
	for (const entry of fs.readdirSync(REPO_ROOT, { withFileTypes: true })) {
		if (
			entry.name.startsWith(".") ||
			UNWALKED_TOP_LEVEL.has(entry.name) ||
			entry.isSymbolicLink()
		)
			continue;
		const absolute = path.join(REPO_ROOT, entry.name);
		if (entry.isDirectory()) {
			for (const found of walkFiles(
				absolute,
				(file) => isCandidate(file.name),
				() => {
					// A directory that vanished mid-walk is out of the population (#3082).
				},
			)) {
				walked.push(relativePosix(REPO_ROOT, found));
			}
		} else if (isCandidate(entry.name)) {
			walked.push(entry.name);
		}
	}
	const sources = new Map<string, string>();
	for (const repoPath of walked) {
		try {
			sources.set(
				repoPath,
				fs.readFileSync(path.join(REPO_ROOT, repoPath), "utf-8"),
			);
		} catch {
			// A file a concurrent worker removed is out of the population (#3082).
		}
	}
	tree = {
		sources,
		walkedTestFiles: walked.filter((repoPath) =>
			/\.test\.[cm]?ts$/.test(repoPath),
		).length,
	};
	return tree;
}

function censusLines(candidates: readonly BaselineCandidate[]): string[] {
	const byClass = new Map<string, BaselineCandidate[]>();
	for (const candidate of candidates) {
		const list = byClass.get(candidate.cls) ?? [];
		list.push(candidate);
		byClass.set(candidate.cls, list);
	}
	return [...byClass.entries()]
		.sort((a, b) => a[0].localeCompare(b[0]))
		.map(
			([cls, list]) =>
				`${cls} (${list.length}): ${list.map((c) => c.id).join(", ")}`,
		);
}

/** A test file whose only content is one planted cell naming `baseline`. */
function cellOwner(baseline: string): string {
	return [
		'import { it } from "vitest";',
		'import { expectPlantedStaleRow } from "../support/baseline-staleness.js";',
		'it("plants a row no scan produces", () => {',
		"  expectPlantedStaleRow({",
		`    baseline: ${JSON.stringify(baseline)},`,
		'    rowKey: "tests/clients/ghost.test.ts",',
		'    direction: "extra-row",',
		'    verdict: ["tests/clients/ghost.test.ts: no live member"],',
		"  });",
		"});",
		"",
	].join("\n");
}

describe("every checked-in baseline has an owner test with a planted-stale-row cell (#5072)", () => {
	it(
		"discovers the repo's baselines and classifies every one of them",
		() => {
			const { sources, walkedTestFiles } = readRepoSources();
			const candidates = classifyBaselines(sources);
			assertNonEmptyScan("baseline-shaped files", candidates.length, 25);
			assertNonEmptyScan("test files read for owners", walkedTestFiles, 500);
			expect(
				candidates.filter((c) => c.cls === "unclassified").map((c) => c.id),
				censusLines(candidates).join("\n"),
			).toEqual([]);
			// The census floor per class, so a walk that lost a whole class reds
			// instead of narrowing the population silently.
			const count = (cls: string) =>
				candidates.filter((c) => c.cls === cls).length;
			expect(
				count("ledger"),
				censusLines(candidates).join("\n"),
			).toBeGreaterThanOrEqual(12);
			expect(count("fixture-input")).toBeGreaterThanOrEqual(1);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it("reds for a baseline no test file reads", () => {
		const findings = baselineGovernanceFindings(
			new Map([
				["tests/config/orphan-baseline.json", '{"tests/clients/a.test.ts": 1}'],
			]),
			{},
		);
		expect(
			findings.map((f) => `${f.id}: ${f.problem}`),
			JSON.stringify(findings),
		).toEqual(
			expect.arrayContaining([
				expect.stringContaining(
					"orphan-baseline.json: no *.test.ts file reads it",
				),
			]),
		);
		// A file nothing reads also has no cell, and the check says both.
		expect(findings).toHaveLength(2);
	});

	it("counts a planted-stale-row cell for the ledger its baseline literal names", () => {
		const findings = baselineGovernanceFindings(
			new Map([
				["tests/config/owned-baseline.json", '{"tests/clients/a.test.ts": 1}'],
				[
					"tests/config/owned-baseline.test.ts",
					cellOwner("tests/config/owned-baseline.json"),
				],
			]),
			{},
		);
		expect(findings).toEqual([]);
	});

	it("reds for a ledger whose owner reads it but never falsifies a row", () => {
		const owner = [
			'import { it } from "vitest";',
			'import baseline from "../support/unplanted-baseline.json";',
			'it("keeps the live scan inside the ledger", () => {',
			"  expect(liveScan().length).toBeLessThanOrEqual(Object.keys(baseline).length);",
			"});",
			"",
		].join("\n");
		const findings = baselineGovernanceFindings(
			new Map([
				[
					"tests/support/unplanted-baseline.json",
					'{"tests/clients/a.test.ts": 1}',
				],
				["tests/config/unplanted-baseline.test.ts", owner],
			]),
			{},
		);
		expect(
			findings.map((f) => `${f.id}: ${f.problem}`),
			JSON.stringify(findings),
		).toEqual(
			expect.arrayContaining([
				expect.stringContaining(
					"unplanted-baseline.json: no planted-stale-row cell",
				),
			]),
		);
		// The file has no reader at all, so the unowned finding rides with the
		// unowned-cell one: one row for a file nobody reads, both reasons.
		expect(findings).toHaveLength(2);
	});

	it("reds a cell that names a baseline the check does not discover", () => {
		const findings = baselineGovernanceFindings(
			new Map([
				[
					"tests/config/stray-cell.test.ts",
					cellOwner("tests/support/made-up-baseline.json"),
				],
			]),
			{},
		);
		expect(
			findings.map((f) => `${f.id}: ${f.problem}`),
			JSON.stringify(findings),
		).toEqual([
			expect.stringContaining("names a baseline the check does not discover"),
		]);
	});

	it("reds a registration that is not inside a live it() or test()", () => {
		const owner = [
			'import { expectPlantedStaleRow } from "../support/baseline-staleness.js";',
			"expectPlantedStaleRow({",
			'  baseline: "tests/support/module-scope-baseline.json",',
			'  rowKey: "x",',
			'  direction: "extra-row",',
			'  verdict: "x",',
			"});",
			"",
		].join("\n");
		const findings = baselineGovernanceFindings(
			new Map([
				["tests/support/module-scope-baseline.json", "{}"],
				["tests/config/module-scope-baseline.test.ts", owner],
			]),
			{},
		);
		expect(
			findings.map((f) => `${f.id}: ${f.problem}`),
			JSON.stringify(findings),
		).toEqual(
			expect.arrayContaining([
				expect.stringContaining("is not inside a live it()/test()"),
				expect.stringContaining("no planted-stale-row cell"),
			]),
		);
		expect(findings).toHaveLength(2);
	});

	it("does not count a registration inside a comment or a string", () => {
		const owner = [
			'import { it } from "vitest";',
			'// expectPlantedStaleRow({ baseline: "tests/support/commented-baseline.json", rowKey: "x", direction: "extra-row", verdict: "x" })',
			'it("documents a commented plant", () => {',
			'  expect(typeof expectPlantedStaleRowPlaceholder).toBe("function");',
			"});",
			"",
		].join("\n");
		const findings = baselineGovernanceFindings(
			new Map([
				["tests/support/commented-baseline.json", "{}"],
				["tests/config/commented-baseline.test.ts", owner],
			]),
			{},
		);
		expect(
			findings
				.filter((f) => f.problem.includes("no planted-stale-row cell"))
				.map((f) => f.id),
			JSON.stringify(findings),
		).toEqual(["tests/support/commented-baseline.json"]);
	});

	it("bounds the seam-test allowance to a file that really calls the seam", () => {
		// The seam's own unit points at ledgers outside the repository, so it is
		// allowed a call with no baseline literal. The allowance must not leak: the
		// same call in any other file is still reported, and a file on the list that
		// stopped calling the seam is dead weight.
		const call = (baselineExpr: string): string =>
			[
				'import { it } from "vitest";',
				'import { expectPlantedStaleRow } from "../support/baseline-staleness.js";',
				'const LEDGER = "tests/support/allowance-baseline.json";',
				'it("falsifies a temporary ledger", () => {',
				`  expectPlantedStaleRow({ baseline: ${baselineExpr}, rowKey: "x", direction: "extra-row", verdict: ["x"] });`,
				"});",
				"",
			].join("\n");
		const ledger = "tests/support/allowance-baseline.json";
		const exempt = SEAM_TEST_CALL_FILES[0]!;
		const exemptFindings = baselineGovernanceFindings(
			new Map([
				[ledger, "{}"],
				[exempt, call('fsTempLedger("rows.json")')],
			]),
			{},
		);
		expect(exemptFindings, JSON.stringify(exemptFindings)).toHaveLength(1);
		expect(exemptFindings[0]!.id).toBe(ledger);
		expect(exemptFindings[0]!.problem).toContain("no planted-stale-row cell");

		const ordinary = baselineGovernanceFindings(
			new Map([
				[ledger, "{}"],
				[
					"tests/config/allowance-baseline.test.ts",
					call('fsTempLedger("rows.json")'),
				],
			]),
			{},
		);
		expect(
			ordinary.map((f) => f.problem).join("\n"),
			JSON.stringify(ordinary),
		).toContain("omits its baseline literal");
	});

	it("keeps every seam-test allowance a file the repo has that calls the seam", () => {
		const { sources } = readRepoSources();
		expect(SEAM_TEST_CALL_FILES.length).toBeGreaterThan(0);
		for (const repoPath of SEAM_TEST_CALL_FILES) {
			const raw = sources.get(repoPath);
			expect(
				raw,
				`${repoPath} is allowed but the census never reads it`,
			).toBeDefined();
			expect(raw ?? "", repoPath).toContain("expectPlantedStaleRow({");
		}
	});

	it("reds an unclassifiable baseline-shaped file", () => {
		const findings = baselineGovernanceFindings(
			new Map([["tests/support/mystery-baseline.csv", "a,b\n1,2\n"]]),
			{},
		);
		expect(
			findings.map((f) => `${f.id}: ${f.problem}`),
			JSON.stringify(findings),
		).toEqual([
			expect.stringContaining(
				"mystery-baseline.csv: baseline-shaped file the check cannot classify",
			),
		]);
	});

	it("reds a dead admission and an admission whose owner does not read the ledger", () => {
		const admissions: Record<string, BaselineOwnerAdmission> = {
			"tests/support/golden-baseline.json": {
				owner: "tests/config/other.test.ts",
				reason:
					"a golden output compared with toEqual, so a row that no longer matches reds on its own",
			},
			"tests/support/gone-baseline.json": {
				owner: "tests/config/gone.test.ts",
				reason:
					"the ledger was deleted and nobody dropped the row that excused it from the census",
			},
		};
		const findings = baselineGovernanceFindings(
			new Map([
				["tests/support/golden-baseline.json", '{"q": [1]}'],
				[
					"tests/config/golden-baseline.test.ts",
					'import b from "../support/golden-baseline.json";',
				],
			]),
			admissions,
		);
		const problems = findings.map((f) => `${f.id}: ${f.problem}`);
		expect(
			problems.some((p) =>
				p.includes("admission names a baseline the check does not discover"),
			),
			JSON.stringify(findings),
		).toBe(true);
		expect(
			problems.some((p) =>
				p.includes("as its owner, but that test does not read the ledger"),
			),
			JSON.stringify(findings),
		).toBe(true);
	});

	it("reds an admission whose reason is a label rather than a sentence", () => {
		const findings = baselineGovernanceFindings(
			new Map([
				["tests/support/short-reason-baseline.json", '{"q": [1]}'],
				[
					"tests/config/short-reason-baseline.test.ts",
					'import b from "../support/short-reason-baseline.json";',
				],
			]),
			{
				"tests/support/short-reason-baseline.json": {
					owner: "tests/config/short-reason-baseline.test.ts",
					reason: "golden",
				},
			},
		);
		expect(
			findings.map((f) => f.problem).join("\n"),
			JSON.stringify(findings),
		).toContain("carries a sentence of at least");
	});

	// ── The check's own ledger ───────────────────────────────────────────────

	// A test that reads a ledger and carries no plant: the shape an admission must
	// point at, since an admission excuses a missing cell.
	function readerOwner(baseline: string, id = "owned"): string {
		return [
			`import rows from "./${baseline.split("/").pop()}";`,
			`import { it } from "vitest";`,
			`it("${id} reads the rows it is pinned to", () => {`,
			`  expect(rows).toBeDefined();`,
			`});`,
			"",
		].join("\n");
	}

	it("reds its own admission map on a row whose owner never reads the ledger (#5072)", () => {
		// The admission map is a ledger like any other: a row that stops being
		// checked is a silent free pass. The plant is an admission naming an owner
		// test that never opens the file — over a tree that is otherwise clean, so
		// the only thing the check can be reporting is the planted row.
		const plantedLedger = "tests/support/5072-admission-drift-baseline.json";
		const plantedOwner = "tests/config/5072-nonowner.test.ts";
		const sources = new Map([
			[plantedLedger, '{"rows": []}'],
			["tests/config/5072-owner.test.ts", readerOwner(plantedLedger)],
		]);
		// With no admission the ledger reports its missing cell; with a correct one
		// it is clean; with the planted one it reports the dead owner.
		expect(
			baselineGovernanceFindings(sources, {})
				.map((f) => f.problem)
				.join("\n"),
		).toContain("no planted-stale-row cell");
		const verdict = baselineGovernanceFindings(sources, {
			[plantedLedger]: {
				owner: plantedOwner,
				reason:
					"a two-sided golden comparison reddens a row the run no longer produces",
			},
		});
		const problems = verdict.map((f) => `${f.id}: ${f.problem}`);
		expect(
			problems.some(
				(p) =>
					p.includes(plantedLedger) && p.includes("does not read the ledger"),
			),
			JSON.stringify(verdict),
		).toBe(true);
		expectPlantedStaleRow({
			baseline:
				"tests/support/baseline-owner-admissions.ts#BASELINE_OWNER_ADMISSIONS",
			rowKey: plantedLedger,
			direction: "extra-row",
			verdict: problems,
		});
	});

	it("keeps every checked-in admission a live row of its own census", () => {
		// The admissions map has no owner test reading it except this one, so its
		// rows are checked here: an admission whose ledger the census does not
		// discover is dead weight, and the ratchet says so with no plant needed.
		const { sources } = readRepoSources();
		const census = classifyBaselines(sources);
		const ledgerIds = new Set(
			census.filter((c) => c.cls === "ledger").map((c) => c.id),
		);
		const dead = Object.keys(BASELINE_OWNER_ADMISSIONS).filter(
			(id) => !ledgerIds.has(id),
		);
		expect(dead, censusLines(census).join("\n")).toEqual([]);
	});

	it("reds a planted admission row whose ledger the census does not discover (#5072)", () => {
		// The admission map is a ledger like any other and this file is its owner: a
		// row naming no ledger is a free pass with a sentence of justification
		// attached, so the plant here is a row kept past the file it excused.
		const planted = "tests/support/5072-unapproved-baseline.json";
		const findings = baselineGovernanceFindings(
			new Map([
				[
					"tests/config/5072-reader.test.ts",
					'import rows from "../support/x.json";\nit("reads", () => expect(rows).toEqual({}));\n',
				],
			]),
			{
				[planted]: {
					owner: "tests/config/5072-reader.test.ts",
					reason:
						"an admission row kept after the ledger it excused was renamed away",
				},
			},
		);
		const verdict = findings.map((f) => `${f.id}: ${f.problem}`);
		expect(verdict).toEqual(
			expect.arrayContaining([expect.stringContaining(planted)]),
		);
		expectPlantedStaleRow({
			baseline:
				"tests/support/baseline-owner-admissions.ts#BASELINE_OWNER_ADMISSIONS",
			rowKey: planted,
			direction: "extra-row",
			verdict,
		});
	});

	// ── The repo ─────────────────────────────────────────────────────────────

	it(
		"keeps the repo's baselines owned, planted, or admitted with a reason",
		() => {
			const { sources } = readRepoSources();
			const { findings, counts } = baselineGovernanceReport(sources);
			console.log(
				`[baseline-owners] ledgers=${counts.ledgers} planted=${counts.planted} ` +
					`admitted=${counts.admitted} unplanted=${counts.unplanted} ` +
					`unowned=${counts.unowned} unclassified=${counts.unclassified} ` +
					`verdict=${findings.length === 0 ? "clean" : `${findings.length} findings`}`,
			);
			// Every ledger lands in exactly one state, so none escapes the census.
			expect(counts.planted + counts.admitted + counts.unplanted).toBe(
				counts.ledgers,
			);
			expect(
				findings.map((f) => `${f.id}: ${f.problem}`),
				censusLines(classifyBaselines(sources)).join("\n"),
			).toEqual([]);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it("reds the admitted ledgers when their admissions are withdrawn", () => {
		// Proves the admissions are what keep those ledgers green rather than the
		// census quietly missing them: drop the rows and the check names each one.
		const { sources } = readRepoSources();
		const admitted = Object.keys(BASELINE_OWNER_ADMISSIONS);
		expect(admitted.length).toBeGreaterThan(0);
		const stripped = baselineGovernanceFindings(sources, {});
		const named = admitted.filter((id) =>
			stripped.some(
				(f) => f.id === id && f.problem.includes("no planted-stale-row cell"),
			),
		);
		expect(named, JSON.stringify(stripped)).toEqual(admitted);
	});
});
