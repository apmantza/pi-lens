import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	runCheck,
	type StrictnessResult,
} from "../../scripts/strictness-report.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const baseline = JSON.parse(
	readFileSync(
		resolve(import.meta.dirname, "strictness-baseline.json"),
		"utf8",
	),
) as Record<string, Record<string, number>>;
const productionRoots = ["clients", "tools", "mcp", "scripts"];

function productionCounts(result: StrictnessResult) {
	return Object.fromEntries(
		Object.entries(result.counts).filter(([directory]) =>
			productionRoots.some(
				(root) => directory === root || directory.startsWith(`${root}/`),
			),
		),
	);
}

function compare(result: StrictnessResult, expected: Record<string, number>) {
	const actual = productionCounts(result);
	const problems: string[] = [];
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
});
