/** Governance sweep for #2671's hand-kept Vitest lane registries. */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { assertSortedRegistry } from "../support/sweep-kit.js";

const CONFIG = path.join(process.cwd(), "vitest.config.ts");

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
});
