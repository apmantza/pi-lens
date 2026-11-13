// flake-shape: real-process-spawn — the census population is git's own tracked list, which only a real `git ls-files` answers (dot-files and every extension included)
/**
 * #5072 bullet 3: every tracked baseline has an owner test that can prove it
 * fails on a stale row.
 *
 * The census lives in `tests/support/baseline-owner-check.ts`. This file runs
 * it over the tracked tree, and holds one cell per rule that proves the rule
 * reds: each cell drives `baselineGovernanceReport` over a planted source map,
 * the same entry the tree census calls. The shape a planted-stale-row cell has
 * to take is documented at `expectPlantedStaleRow` in
 * `tests/support/baseline-staleness.ts`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { listTrackedFiles } from "../../scripts/ci-shuffle-census.mjs";
import { assertNonEmptyScan } from "../support/sweep-kit.js";
import { expectPlantedStaleRow } from "../support/baseline-staleness.js";
import {
	type BaselineCandidate,
	baselineGovernanceReport,
	NOT_A_BASELINE,
} from "../support/baseline-owner-check.js";
import { TREE_WALK_TIMEOUT_MS } from "../support/test-timeout-scale.js";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
);

let tree: Map<string, string> | undefined;

/**
 * Every tracked path with its text. The population is git's tracked list, so
 * a dot-file, a dot-directory and a file of any extension are all in it, and
 * build output and dependencies are not (#5546 B10). A path git lists but the
 * checkout lacks (a sparse checkout, a submodule) is out of the population.
 */
function trackedSources(): Map<string, string> {
	if (tree) return tree;
	const listed = listTrackedFiles(REPO_ROOT);
	tree = new Map();
	for (const repoPath of listed) {
		try {
			tree.set(
				repoPath,
				fs.readFileSync(path.join(REPO_ROOT, repoPath), "utf-8"),
			);
		} catch {
			// Not a readable file in this checkout; not a member.
		}
	}
	return tree;
}

function censusLines(candidates: readonly BaselineCandidate[]): string {
	const byClass = new Map<string, string[]>();
	for (const c of candidates) {
		byClass.set(c.cls, [...(byClass.get(c.cls) ?? []), c.id]);
	}
	return [...byClass]
		.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
		.map(([cls, ids]) => `${cls} (${ids.length}): ${ids.join(", ")}`)
		.join("\n");
}

/** The census over a planted tree, with no NOT_A_BASELINE rows unless given. */
function census(
	files: Record<string, string>,
	notABaseline: Record<string, string> = {},
) {
	return baselineGovernanceReport(new Map(Object.entries(files)), notABaseline);
}

/** `id: problem` lines, the form every cell reads. */
function problems(files: Record<string, string>, notABaseline = {}): string[] {
	return census(files, notABaseline).findings.map(
		(f) => `${f.id}: ${f.problem}`,
	);
}

/** A member a content-claimed ledger's rows can name. */
const MEMBER = {
	"tests/clients/live.test.ts": 'import { it } from "vitest";\n',
};

/** A test that reads `ledger` through a relative import and plants one cell for `id`. */
function ownerWithCell(
	ledger: string,
	id = ledger,
	testPath = "tests/config/owner.test.ts",
): string {
	const spec = path.posix.relative(path.posix.dirname(testPath), ledger);
	return [
		'import { it } from "vitest";',
		'import { expectPlantedStaleRow } from "../support/baseline-staleness.js";',
		`import rows from "${spec.startsWith(".") ? spec : `./${spec}`}";`,
		'it("plants a row no scan produces", () => {',
		"  expectPlantedStaleRow({",
		`    baseline: ${JSON.stringify(id)},`,
		'    rowKey: "tests/clients/ghost.test.ts",',
		"    verdict: compare(rows),",
		"  });",
		"});",
		"",
	].join("\n");
}

describe("every tracked baseline has an owner test with a planted-stale-row cell (#5072)", () => {
	// ── Population: which entries are candidates, and their class ─────────────

	it("holds a baseline-named file it cannot read rows from as unclassified, whatever its extension", () => {
		// Recurrence (#5546 B10): a .yml, a .csv and a dot-directory entry never
		// reached the r1 class rules, so the census stayed clean with them in it.
		expect(
			problems({
				"tests/support/zz-baseline.yml": "- tests/clients/live.test.ts\n",
				"tests/support/zz-baseline.csv":
					"file,count\ntests/clients/live.test.ts,1\n",
				".zzdir/zz-baseline.toml": 'rows = ["tests/clients/live.test.ts"]\n',
			}),
		).toEqual([
			".zzdir/zz-baseline.toml: a baseline-named file the census cannot read rows from; add a class rule, or a NOT_A_BASELINE row with the reason",
			"tests/support/zz-baseline.csv: a baseline-named file the census cannot read rows from; add a class rule, or a NOT_A_BASELINE row with the reason",
			"tests/support/zz-baseline.yml: a baseline-named file the census cannot read rows from; add a class rule, or a NOT_A_BASELINE row with the reason",
		]);
	});

	it("holds a JSON document under a dot-directory as a ledger that needs an owner and a cell", () => {
		// Recurrence (#5546 B6): the r1 walk skipped every dot entry.
		const ledger = ".zzdir/zz-baseline.json";
		expect(
			problems({ [ledger]: '{"tests/clients/gone.test.ts": 1}' }).map(
				(p) => p.split(" (")[0],
			),
		).toEqual([
			`${ledger}: no planted-stale-row cell`,
			`${ledger}: no test file reads it`,
		]);
		expect(
			problems({
				[ledger]: '{"tests/clients/gone.test.ts": 1}',
				"tests/config/owner.test.ts": ownerWithCell(ledger),
			}),
		).toEqual([]);
	});

	it("holds an unnamed JSON row table keyed by tracked members as a ledger", () => {
		// Recurrence (#5546 F2): .dependency-cruiser-known-violations.json and
		// scripts/shuffle-census-ratchet.json carry no baseline name, so the r1
		// census never saw them. Content decides: rows of one kind, at least one
		// naming a tracked member (here through a compiled .js twin and a
		// tests/-relative tail).
		const { candidates } = census({
			...MEMBER,
			".known-violations.json":
				'// header comment\n[{"from": "tests/clients/live.test.js", "rule": "cycle"}]',
			"scripts/ratchet.json":
				'{"about": "prose", "files": {"clients/live.test.ts": 1}}',
			"config/tools.json": '{"tools": {"ast_grep_search": 1}}',
			"config/mixed.json": '{"rows": ["tests/clients/live.test.ts", 1]}',
		});
		expect(candidates.map((c) => `${c.id}=${c.cls}`)).toEqual([
			".known-violations.json=ledger",
			"scripts/ratchet.json=ledger",
		]);
	});

	it("holds every exported baseline binding whose value is not a scalar literal as a ledger", () => {
		// Recurrence (#5546 F3): a computed table, an alias, an export clause, a
		// camelCase name, a function-typed annotation and a .mjs module were each
		// silent in r1 (no candidate, no finding).
		const module = [
			'export const A_BASELINE = Object.fromEntries([["tests/clients/live.test.ts", 1]]);',
			'const ROWS = { "tests/clients/live.test.ts": 1 };',
			"export const B_BASELINE = ROWS;",
			"export const cBaseline: () => Rows = load;",
			'const OTHER = new Map([["k", 1]]);',
			"export { OTHER as D_BASELINE };",
			'export let E_BASELINE = new Set(["tests/clients/live.test.ts"]);',
			"",
		].join("\n");
		const { candidates } = census({ "scripts/zz-tables.mjs": module });
		expect(candidates.map((c) => `${c.id}=${c.cls}`)).toEqual([
			"scripts/zz-tables.mjs#A_BASELINE=ledger",
			"scripts/zz-tables.mjs#B_BASELINE=ledger",
			"scripts/zz-tables.mjs#D_BASELINE=ledger",
			"scripts/zz-tables.mjs#E_BASELINE=ledger",
			"scripts/zz-tables.mjs#cBaseline=ledger",
		]);
	});

	it("keeps scalar bounds, functions, classes and types out of the ledger population", () => {
		const module = [
			"export const MAX_BASELINE_FILES = 256;",
			'export const BASELINE_MARKER = "| row id |" as const;',
			"export function loadBaseline() { return []; }",
			"export class BaselineStore {}",
			"export type BaselineRow = { file: string };",
			"export const makeBaseline = (rows: string[]) => rows;",
			"",
		].join("\n");
		const { candidates, findings } = census({ "clients/zz-store.ts": module });
		expect(candidates.map((c) => `${c.id}=${c.cls}`)).toEqual([
			"clients/zz-store.ts#BASELINE_MARKER=bound",
			"clients/zz-store.ts#MAX_BASELINE_FILES=bound",
		]);
		expect(findings).toEqual([]);
	});

	it("reds an exported baseline binding with no initializer it can read", () => {
		// An imported name re-exported under a baseline name holds its rows in a
		// module the census may never see as a candidate, so it reds here too.
		expect(
			problems({
				"scripts/zz-late.mjs": "export let F_BASELINE;\n",
				"scripts/zz-relay.mjs":
					'import { rows } from "./zz-rows.mjs";\nexport { rows as G_BASELINE };\n',
			}).map((p) => p.split(" (")[0]),
		).toEqual([
			"scripts/zz-late.mjs#F_BASELINE: an exported binding with no initializer the census can read",
			"scripts/zz-relay.mjs#G_BASELINE: an exported binding with no initializer the census can read",
		]);
	});

	it("reads a baseline-named module's default export, and places a module with none as code", () => {
		const { candidates } = census({
			"tests/support/y-baseline.mjs":
				'export default { "tests/clients/live.test.ts": 1 };\n',
			"tests/support/z-baseline.ts": "export function rows() { return []; }\n",
		});
		expect(candidates.map((c) => `${c.id}=${c.cls}`)).toEqual([
			"tests/support/y-baseline.mjs#default=ledger",
			"tests/support/z-baseline.ts=code",
		]);
	});

	it("places Markdown, TLA+ configs and fixture inputs by their own rule", () => {
		const { candidates, findings } = census({
			"docs/x-baseline.md": "| row id | feature |\n",
			"formal/fam/XBaseline.cfg": "CONSTANTS N = 2\n",
			"tests/fixtures/x/todo-baseline.json": '{"a": 1}',
			"tests/fixtures/x/rows.json": '["tests/fixtures/x/todo-baseline.json"]',
		});
		expect(candidates.map((c) => `${c.id}=${c.cls}`)).toEqual([
			"docs/x-baseline.md=prose",
			"formal/fam/XBaseline.cfg=model",
			"tests/fixtures/x/rows.json=fixture-input",
			"tests/fixtures/x/todo-baseline.json=fixture-input",
		]);
		expect(findings).toEqual([]);
	});

	// ── Owners: what counts as reading a ledger ──────────────────────────────

	it("credits a relative import, a repo-path literal and a basename literal as reads", () => {
		// Recurrence (#5546 B8): a relative import of a ledger was not a read in r1.
		const cell = (id: string) =>
			`it("plants", () => { expectPlantedStaleRow({ baseline: "${id}", rowKey: "x", verdict: compare() }); });\n`;
		expect(
			problems({
				"tests/support/a-baseline.json": "{}",
				"tests/support/b-baseline.json": "{}",
				"tests/support/c-baseline.json": "{}",
				"tests/config/a.test.ts": `import rows from "../support/a-baseline.json";\n${cell("tests/support/a-baseline.json")}`,
				"tests/config/b.test.ts": `const p = path.join(ROOT, "tests/support/b-baseline.json");\n${cell("tests/support/b-baseline.json")}`,
				"tests/config/c.test.ts": `const p = path.join(ROOT, "tests", "support", "c-baseline.json");\n${cell("tests/support/c-baseline.json")}`,
			}),
		).toEqual([]);
	});

	it("does not credit a comment, a sentence, or the cell's own baseline literal as a read", () => {
		// Recurrence (#5546 F6/B1): r1 read raw text, so a comment, an unused
		// sentence, or a stub holding only a cell made a test the owner.
		const ledger = "tests/support/a-baseline.json";
		const stub = [
			`// reads ${ledger}`,
			`const note = "see ${ledger} for the rows";`,
			`it("plants", () => { expectPlantedStaleRow({ baseline: "${ledger}", rowKey: "x", verdict: compare() }); });`,
			"",
		].join("\n");
		expect(
			problems({ [ledger]: "{}", "tests/config/stub.test.ts": stub }).map(
				(p) => p.split(" (")[0],
			),
		).toEqual([`${ledger}: no test file reads it`]);
	});

	it("credits an exported table to a test that imports its module and uses the name", () => {
		const table = "tests/support/t-baseline.ts";
		const declared = `export const T_BASELINE = ["tests/clients/live.test.ts"];\n`;
		const cell = `it("plants", () => { expectPlantedStaleRow({ baseline: "${table}#T_BASELINE", rowKey: "x", verdict: compare() }); });\n`;
		expect(
			problems({
				[table]: declared,
				"tests/config/t.test.ts": `import { T_BASELINE } from "../support/t-baseline.js";\nvoid T_BASELINE;\n${cell}`,
			}),
		).toEqual([]);
		// Importing the module without the name, using the name without importing
		// the module, or declaring the table in a test that never uses it, reads
		// nothing.
		expect(
			problems({
				[table]: declared,
				"tests/config/t.test.ts": `const T_BASELINE = ["other"];\nvoid T_BASELINE;\n${cell}`,
			}).map((p) => p.split(" (")[0]),
		).toEqual([`${table}#T_BASELINE: no test file reads it`]);
		expect(
			problems({
				[table]: declared,
				"tests/config/t.test.ts": `import { other } from "../support/t-baseline.js";\n${cell}`,
			}).map((p) => p.split(" (")[0]),
		).toEqual([`${table}#T_BASELINE: no test file reads it`]);
		expect(
			problems({
				"tests/config/self.test.ts": `export const S_BASELINE = ["tests/clients/live.test.ts"];\n${cell}`,
			}).map((p) => p.split(" (")[0]),
		).toEqual(
			expect.arrayContaining([
				"tests/config/self.test.ts#S_BASELINE: no test file reads it",
			]),
		);
	});

	// ── Cells: what counts as a planted-stale-row cell ───────────────────────

	it("counts only a live it() call that spells its baseline and a rowKey", () => {
		// Each file below holds a call the census must not count, for its own
		// ledger; the last one is the real cell. Plants: comment, string, alias,
		// member call, module scope, skipped test, aliased describe, an
		// expression baseline, no rowKey, and a helper the it() calls.
		const call = (n: number) =>
			`expectPlantedStaleRow({ baseline: "tests/support/n${n}-baseline.json", rowKey: "x", verdict: v })`;
		const files: Record<string, string> = {
			"tests/config/n1.test.ts": `it("c", () => { /* ${call(1)} */ });`,
			"tests/config/n2.test.ts": `it("s", () => { const t = '${call(2)}'; });`,
			"tests/config/n3.test.ts": `const e = expectPlantedStaleRow;\nit("a", () => { ${call(3).replace("expectPlantedStaleRow", "e")} });`,
			"tests/config/n4.test.ts": `it("m", () => { seam.${call(4)}; });`,
			"tests/config/n5.test.ts": `${call(5)};\nit("x", () => {});`,
			"tests/config/n6.test.ts": `it.skip("k", () => { ${call(6)}; });`,
			"tests/config/n7.test.ts": `const d = ok ? describe : describe.skip;\nd("s", () => { it("i", () => { ${call(7)}; }); });`,
			"tests/config/n8.test.ts": `const L = "tests/support/n8-baseline.json";\nit("e", () => { expectPlantedStaleRow({ baseline: L, rowKey: "x", verdict: v }); });`,
			"tests/config/n9.test.ts": `it("r", () => { expectPlantedStaleRow({ baseline: "tests/support/n9-baseline.json", verdict: v }); });`,
			"tests/config/n10.test.ts": `function plant() { ${call(10)}; }\nit("h", () => { plant(); });`,
			"tests/config/n11.test.ts": `it("ok", () => { ${call(11)}; });`,
		};
		for (let n = 1; n <= 11; n++) {
			files[`tests/support/n${n}-baseline.json`] = "{}";
			files[`tests/config/n${n}.test.ts`] =
				`import rows from "../support/n${n}-baseline.json";\n${files[`tests/config/n${n}.test.ts`]}`;
		}
		const { findings, counts } = census(files);
		expect(
			findings.map((f) => f.id),
			JSON.stringify(findings),
		).toEqual(
			[1, 10, 2, 3, 4, 5, 6, 7, 8, 9].map(
				(n) => `tests/support/n${n}-baseline.json`,
			),
		);
		expect(counts.planted).toBe(1);
	});

	it("reads a cell's properties only inside its own call", () => {
		// Recurrence (#5546 B7): a fixed 4000-character window credited a later
		// object's literals to a call whose claim was a variable.
		const ledger = "tests/support/w-baseline.json";
		const owner = [
			`import rows from "../support/w-baseline.json";`,
			`it("w", () => {`,
			"  expectPlantedStaleRow(claim);",
			`  const other = { baseline: "${ledger}", rowKey: "x" };`,
			"});",
			"",
		].join("\n");
		expect(
			problems({ [ledger]: "{}", "tests/config/w.test.ts": owner }).map(
				(p) => p.split(" (")[0],
			),
		).toEqual([`${ledger}: no planted-stale-row cell`]);
	});

	it("reds a cell that names a baseline the census does not hold as a ledger", () => {
		expect(
			problems({
				"tests/fixtures/f/fix-baseline.json": "{}",
				"tests/config/stray.test.ts": [
					`it("a", () => { expectPlantedStaleRow({ baseline: "tests/support/made-up-baseline.json", rowKey: "x", verdict: v }); });`,
					`it("b", () => { expectPlantedStaleRow({ baseline: "tests/fixtures/f/fix-baseline.json", rowKey: "x", verdict: v }); });`,
				].join("\n"),
			}).map((p) => p.split(" names ")[0]),
		).toEqual([
			"tests/fixtures/f/fix-baseline.json: the expectPlantedStaleRow cell at tests/config/stray.test.ts:2",
			"tests/support/made-up-baseline.json: the expectPlantedStaleRow cell at tests/config/stray.test.ts:1",
		]);
	});

	// ── NOT_A_BASELINE, the census's own ledger ──────────────────────────────

	it("excuses a registered row table, and reds a NOT_A_BASELINE row that excuses nothing (#5072)", () => {
		const table = "config/tool-config.json";
		const planted = "config/5072-gone-config.json";
		const files = {
			...MEMBER,
			[table]: '{"ignore": ["tests/clients/live.test.ts"]}',
			"clients/zz.ts": "export const MAX_BASELINE = 3;\n",
		};
		const registry = {
			[table]: "a tool's own configuration, read by the tool",
			[planted]: "a row kept after the file it excused was deleted",
			"clients/zz.ts#MAX_BASELINE": "a bound the class rules already place",
		};
		const { findings, candidates } = census(files, registry);
		expect(candidates.find((c) => c.id === table)?.cls).toBe("registered");
		const verdict = findings.map((f) => `${f.id}: ${f.problem}`);
		expect(verdict.map((v) => v.split(":")[0])).toEqual([
			"clients/zz.ts#MAX_BASELINE",
			planted,
		]);
		expectPlantedStaleRow({
			baseline: "tests/support/baseline-owner-check.ts#NOT_A_BASELINE",
			rowKey: planted,
			verdict,
		});
	});

	it("reds a NOT_A_BASELINE reason under the floor, so a stub reason cannot launder a real ledger (#5546 N1)", () => {
		// Recurrence (#5546 N1): the r1 reason floor was dropped, and a row reading
		// "x" registered a real ledger the census then called clean. The floor is
		// the 20-character minimum the lsp-spawn-heavy-coverage registry enforces.
		const ledger = "tests/support/zz-real-baseline.json";
		const files = { [ledger]: "{}" };
		const under =
			"NOT_A_BASELINE reason is under 20 characters; say why the file is not a baseline";
		expect(problems(files, { [ledger]: "x" })).toEqual([`${ledger}: ${under}`]);
		expect(problems(files, { [ledger]: "x".repeat(19) })).toEqual([
			`${ledger}: ${under}`,
		]);
		expect(problems(files, { [ledger]: "x".repeat(20) })).toEqual([]);
	});

	// ── The tracked tree ─────────────────────────────────────────────────────

	it(
		"reads git's tracked list: dot-files, dot-dirs and every extension",
		() => {
			const sources = trackedSources();
			assertNonEmptyScan("tracked files", sources.size, 5000);
			// Recurrence (#5546 B10): the r1 walk skipped dot entries and kept
			// only .ts/.tsx/.json, so these never reached the class rules.
			expect(sources.has(".dependency-cruiser-known-violations.json")).toBe(
				true,
			);
			expect(sources.has(".github/workflows/ci.yml")).toBe(true);
			expect([...sources.keys()].some((p) => p.endsWith(".mjs"))).toBe(true);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it(
		"keeps the repo's baselines owned and planted",
		() => {
			const sources = trackedSources();
			const { findings, counts, candidates } = baselineGovernanceReport(
				sources,
				NOT_A_BASELINE,
			);
			console.log(
				`[baseline-owners] ledgers=${counts.ledgers} planted=${counts.planted} ` +
					`unplanted=${counts.unplanted} unowned=${counts.unowned} ` +
					`unclassified=${counts.unclassified} registered=${counts.registered} ` +
					`verdict=${findings.length === 0 ? "clean" : `${findings.length} findings`}`,
			);
			assertNonEmptyScan("ledgers", counts.ledgers, 15);
			// Recurrence (#5546 F2): two live ledgers carried no baseline name and
			// stayed outside the r1 census.
			const ledgerIds = candidates
				.filter((c) => c.cls === "ledger")
				.map((c) => c.id);
			expect(ledgerIds).toEqual(
				expect.arrayContaining([
					".dependency-cruiser-known-violations.json",
					"scripts/shuffle-census-ratchet.json",
				]),
			);
			expect(
				findings.map((f) => `${f.id}: ${f.problem}`),
				censusLines(candidates),
			).toEqual([]);
		},
		TREE_WALK_TIMEOUT_MS,
	);
});
