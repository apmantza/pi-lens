/** Governance sweep for #2671's hand-kept Vitest lane registries. */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createVitest } from "vitest/node";
import { toPosix } from "../../clients/path-utils.js";
import {
	assertNonEmptyScan,
	assertSortedRegistry,
	listSourceFiles,
} from "../support/sweep-kit.js";
import { TREE_WALK_TIMEOUT_MS } from "../support/test-timeout-scale.js";

const CONFIG = path.join(process.cwd(), "vitest.config.ts");
const ROOT = process.cwd();

/** Vitest's own default `include` shape: what an author means by a test file. */
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

/**
 * Test files on the head that `vitest.config.ts` excludes on purpose, each with
 * the reason. A new `*.test.ts` under `tests/fixtures/**` or any other
 * `sharedExclude` tree is collected by no lane and never runs, so the only way
 * to hold one is a row here (#5805).
 */
const DELIBERATELY_UNCOLLECTED: Readonly<Record<string, string>> = {
	"tests/fixtures/native-ts7-vitest/provider-cache.test.ts":
		"input of the native-TS7 live suite: copied out and run by the fixture's own vitest (#1412)",
};

/**
 * The verdict, apart from the two real inputs: a head file is uncollected unless
 * vitest collected it or a row exempts it; a row for a file that is collected
 * or gone is stale. Anything not in `collected` counts as uncollected, so a
 * lane that cannot be resolved fails closed.
 */
function collectionVerdict(input: {
	population: readonly string[];
	collected: ReadonlySet<string>;
	exempt: Readonly<Record<string, string>>;
}): { uncollected: string[]; staleExemptions: string[] } {
	const onHead = new Set(input.population);
	return {
		uncollected: input.population.filter(
			(file) => !input.collected.has(file) && !(file in input.exempt),
		),
		staleExemptions: Object.keys(input.exempt).filter(
			(file) => !onHead.has(file) || input.collected.has(file),
		),
	};
}

/**
 * Every test file under `tests/` on the head, with no vitest exclude applied.
 * `native-ts7-live-*` is skipped because the live suite creates it and
 * `.gitignore` keeps it off the head; the walker skips the other trees
 * `.gitignore` or `node_modules` keep off the head (`RUNTIME_SCRATCH_DIRS`).
 */
function headTestFiles(): string[] {
	return listSourceFiles(path.join(ROOT, "tests"), {
		extensions: [".ts", ".mts", ".cts", ".tsx", ".js", ".mjs", ".cjs", ".jsx"],
		skipDeclarations: false,
		exclude: (relative) => relative.startsWith("native-ts7-live-"),
	})
		.map((absolute) => toPosix(path.relative(ROOT, absolute)))
		.filter((file) => TEST_FILE.test(file));
}

/**
 * The files `npm test` collects, from Vitest's own resolver: every project's
 * include and exclude, so no lane's glob is re-derived here. CI runs
 * `npm test`; the lifecycle name is pinned because the config subtracts
 * `integrationInclude` under `test:unit` (a local-only lane).
 */
async function ciCollectedFiles(): Promise<Set<string>> {
	vi.stubEnv("npm_lifecycle_event", "test");
	try {
		const ctx = await createVitest("test", {
			root: ROOT,
			watch: false,
			run: false,
			configLoader: "runner",
		});
		try {
			const specs = await ctx.globTestSpecifications();
			return new Set(
				specs.map((spec) => toPosix(path.relative(ROOT, spec.moduleId))),
			);
		} finally {
			await ctx.close();
		}
	} finally {
		vi.unstubAllEnvs();
	}
}

function laneEntries(name: string): string[] {
	const source = fs.readFileSync(CONFIG, "utf8");
	const body = source.match(
		new RegExp(`const ${name} = \\[([\\s\\S]*?)\\n\\];`),
	)?.[1];
	expect(body, `${name} must remain a literal registry`).toBeDefined();
	return [...(body ?? "").matchAll(/^\s*"([^"]+)"/gm)].map((match) => match[1]);
}

describe("Vitest lane registries (#2671)", () => {
	it("rejects unsorted entries and keeps every lane sorted", () => {
		// Recurrence: parallel PRs inserted adjacent lane rows in arbitrary order,
		// creating avoidable conflicts and leaving declaration order unstable.
		expect(() => assertSortedRegistry("fixture", ["b", "a"])).toThrow(
			"first out-of-order key is b",
		);
		for (const name of [
			"integrationInclude",
			"grammarHeavyInclude",
			"timingSensitiveInclude",
			"lspSpawnHeavyInclude",
			"wallClockBudgetInclude",
			"tmpFixtureHygieneInclude",
		]) {
			assertSortedRegistry(name, laneEntries(name));
		}
	});
	it("keeps every test file in at most one lane registry (#5182)", () => {
		// Recurrence: fixture-shape and outside-root sat in both
		// realHarnessInclude and wallClockBudgetInclude, so vitest collected and
		// ran each twice, once per maxWorkers-1 project.
		// integrationInclude is omitted: it only feeds unitOnlyExclude (a
		// subtraction from the wall-clock lane), not a project of its own.
		const owners = new Map<string, string[]>();
		for (const name of [
			"realHarnessInclude",
			"grammarHeavyInclude",
			"timingSensitiveInclude",
			"lspSpawnHeavyInclude",
			"wallClockBudgetInclude",
			"tmpFixtureHygieneInclude",
		]) {
			for (const file of laneEntries(name)) {
				owners.set(file, [...(owners.get(file) ?? []), name]);
			}
		}
		const duplicated = [...owners]
			.filter(([, lanes]) => lanes.length > 1)
			.map(([file, lanes]) => `${file}: ${lanes.join(" + ")}`);
		expect(duplicated, "a file in two lanes runs once per project").toEqual([]);
	});

	it(
		"collects every test file on the head in some CI lane (#5805)",
		async () => {
			// Recurrence: a `*.test.ts` that no lane collects never runs and nothing
			// reds, so a PR's red-first transcript can be the only run it ever has.
			// Vitest's `sharedExclude` trees (`tests/fixtures/**`,
			// `native-ts7-live-*`, `dist`, dot-cache dirs) are the live hole: a
			// test file placed there is skipped by every project.
			const population = headTestFiles();
			const collected = await ciCollectedFiles();
			assertNonEmptyScan("head test files", population.length, 1000);
			assertNonEmptyScan("vitest-collected test files", collected.size, 1000);
			const { uncollected, staleExemptions } = collectionVerdict({
				population,
				collected,
				exempt: DELIBERATELY_UNCOLLECTED,
			});
			expect(
				uncollected,
				"collected by no lane: move the file out of the excluded tree, or add a reasoned row to DELIBERATELY_UNCOLLECTED",
			).toEqual([]);
			expect(
				staleExemptions,
				"DELIBERATELY_UNCOLLECTED rows for a file that is gone or now collected",
			).toEqual([]);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it("reads a planted file under an excluded tree, or an unresolved lane, as uncollected", () => {
		// Recurrence (#5805): the verdict must be derived from what vitest
		// collected, never from where a file sits, and must fail closed.
		const collected = new Set(["tests/a.test.ts"]);
		const planted = "tests/fixtures/plant/x.test.ts";
		expect(
			collectionVerdict({
				population: ["tests/a.test.ts", planted],
				collected,
				exempt: {},
			}).uncollected,
		).toEqual([planted]);
		// Nothing resolved: every file is uncollected rather than vacuously fine.
		expect(
			collectionVerdict({
				population: ["tests/a.test.ts"],
				collected: new Set(),
				exempt: {},
			}).uncollected,
		).toEqual(["tests/a.test.ts"]);
		// An exemption excuses only its own file, and goes stale when the file is
		// gone or has become collected.
		expect(
			collectionVerdict({
				population: ["tests/a.test.ts", planted],
				collected,
				exempt: { [planted]: "why", "tests/gone.test.ts": "why" },
			}),
		).toEqual({ uncollected: [], staleExemptions: ["tests/gone.test.ts"] });
		expect(
			collectionVerdict({
				population: ["tests/a.test.ts"],
				collected,
				exempt: { "tests/a.test.ts": "why" },
			}).staleExemptions,
		).toEqual(["tests/a.test.ts"]);
	});
});
