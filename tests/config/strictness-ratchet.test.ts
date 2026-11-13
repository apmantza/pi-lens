import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	parseDiagnostics,
	REPORT_ROOTS,
	runCheck,
	type StrictnessResult,
} from "../../scripts/strictness-report.mjs";
import { expectPlantedStaleRow } from "../support/baseline-staleness.js";

const ROOT = resolve(import.meta.dirname, "../..");
const {
	reasons,
	outOfScope,
	...baseline
}: {
	reasons: Record<string, string>;
	outOfScope: Record<string, string>;
} & Record<string, Record<string, number>> = JSON.parse(
	readFileSync(
		resolve(import.meta.dirname, "strictness-baseline.json"),
		"utf8",
	),
);
const productionRoots = ["clients", "tools", "mcp", "scripts"];

/**
 * Which buckets the ratchet pins (#4429 review F3). A bucket under a
 * production root is production. A repo-root file is production too (the
 * host adapter `index.ts`, `i18n.ts`, any file added there later), unless the
 * baseline's `outOfScope` map excludes it with a reason. `tests/` is out of
 * the spike's scope. The parser reports every other location as
 * unclassified, so every bucket lands in exactly one class.
 */
function reportRootOf(bucket: string): string | undefined {
	return REPORT_ROOTS.find(
		(root) => bucket === root || bucket.startsWith(`${root}/`),
	);
}

function isProductionBucket(bucket: string): boolean {
	const root = reportRootOf(bucket);
	if (root !== undefined) return productionRoots.includes(root);
	return !Object.hasOwn(outOfScope, bucket);
}

function productionCounts(result: Pick<StrictnessResult, "counts">) {
	return Object.fromEntries(
		Object.entries(result.counts).filter(([bucket]) =>
			isProductionBucket(bucket),
		),
	);
}

function compare(
	result: Pick<StrictnessResult, "counts" | "unclassified">,
	expected: Record<string, number>,
) {
	const actual = productionCounts(result);
	// #4429: a tsc line the parser cannot place in a bucket reds, never skips.
	const problems: string[] = result.unclassified.map(
		(line) => `unclassified spelling: ${line}`,
	);
	for (const directory of new Set([
		...Object.keys(actual),
		...Object.keys(expected),
	])) {
		const before = expected[directory] ?? 0;
		const after = actual[directory] ?? 0;
		if (after > before)
			problems.push(`${directory}: regression (${before} -> ${after})`);
		if (after < before)
			problems.push(
				`${directory}: ratchet down — lower the baseline (${before} -> ${after})`,
			);
	}
	return problems;
}

describe("TypeScript strictness spike ratchets", () => {
	it("pins both scratch configurations without permitting drift", () => {
		const results = [
			runCheck("tsconfig.strict-indexed.json", ROOT),
			runCheck("tsconfig.strict-optional.json", ROOT),
		];
		for (const result of results) {
			expect(result.exitCode).toBe(1);
			expect(result.total).toBeGreaterThan(0);
			expect(compare(result, baseline[result.config])).toEqual([]);
		}
	}, 120_000);

	it("reds on a tsc diagnostic the parser cannot place (#4429)", () => {
		// Recurrence: #4411 review F3, a population scanner that skipped
		// spellings it did not recognise. Line 2 is real tsc 5 output for a
		// missing `types` entry (captured with --pretty false): a global
		// diagnostic with no file location. Line 4 sits outside every root.
		const output = [
			"clients/a.ts(1,2): error TS2532: Object is possibly 'undefined'.",
			"error TS2688: Cannot find type definition file for 'ghost-types'.",
			"  The file is in the program because:",
			"../outside/b.ts(3,4): error TS2322: Type 'string' is not assignable to type 'number'.",
			"index.ts(5,6): error TS2322: Type 'string' is not assignable to type 'number'.",
			"i18n.ts(7,8): error TS2532: Object is possibly 'undefined'.",
			"vitest.config.ts(118,44): error TS2379: Argument of type '{ workerOverride: number | undefined; }' is not assignable.",
		].join("\n");
		// Line 6 is a repo-root runtime file, so it is pinned (at 0) like
		// index.ts; line 7 is the out-of-scope test config, so it is not.
		expect(
			compare(parseDiagnostics(output, ROOT), { clients: 1, "index.ts": 1 }),
		).toEqual([
			"unclassified spelling: error TS2688: Cannot find type definition file for 'ghost-types'.",
			"unclassified spelling: ../outside/b.ts(3,4): error TS2322: Type 'string' is not assignable to type 'number'.",
			"i18n.ts: regression (0 -> 1)",
		]);
	});

	it("reds a planted baseline row the live counts no longer produce (#5072)", () => {
		// The shrink-only direction on a bucket this cell invents: the live scan
		// sees one `clients` diagnostic and nothing in the planted bucket, so the
		// only way the row survives is a verdict that names it.
		const planted = "clients/5072-ghost-bucket";
		const stale = compare(
			parseDiagnostics(
				"clients/a.ts(1,2): error TS2532: Object is possibly 'undefined'.",
				ROOT,
			),
			{ clients: 1, [planted]: 1 },
		);
		expect(stale).toEqual([
			`${planted}: ratchet down — lower the baseline (1 -> 0)`,
		]);
		expectPlantedStaleRow({
			baseline: "tests/config/strictness-baseline.json",
			rowKey: planted,
			verdict: stale,
		});
	});

	it("gives every repo-root row and exclusion a reason in the baseline (#4429)", () => {
		// Shape 38: a baseline row or exclusion carries its reason in a checked
		// file. Recurrence: #4457 review F6, the index.ts rows shipped with a
		// reason only in a code comment.
		const rootRows = new Set(
			Object.values(baseline).flatMap((counts) =>
				Object.keys(counts).filter(
					(bucket) => reportRootOf(bucket) === undefined,
				),
			),
		);
		for (const bucket of rootRows) {
			expect(
				reasons[bucket]?.length ?? 0,
				`reason for ${bucket}`,
			).toBeGreaterThan(40);
		}
		for (const [file, reason] of Object.entries(outOfScope)) {
			expect(reason.length, `reason for ${file}`).toBeGreaterThan(40);
			expect(existsSync(resolve(ROOT, file)), `${file} exists`).toBe(true);
			expect(rootRows.has(file), `${file} is both pinned and excluded`).toBe(
				false,
			);
		}
		expect(
			Object.keys(reasons).filter((bucket) => !rootRows.has(bucket)),
		).toEqual([]);
	});
});
