import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	isScriptMutationFile,
	mapRelatedTests,
} from "../../scripts/lib/stryker-diff.mjs";

const config = readFileSync(
	resolve(import.meta.dirname, "../../stryker.config.mjs"),
	"utf8",
);

describe("stryker diff selection", () => {
	it("maps changed scripts to imported and conventional sibling tests", () => {
		// Recurrence: the mutation lane must run tests that import the changed
		// script, including scripts without a same-path test mirror.
		const result = mapRelatedTests(
			["scripts/lib/ci-checks.mjs", "scripts/guard-bash.mjs"],
			{
				testFiles: [
					"tests/scripts/ci-verdict.test.ts",
					"tests/scripts/guard-bash.test.ts",
				],
				readFile: (file) =>
					file.includes("ci-verdict")
						? 'import checks from "../../scripts/lib/ci-checks.mjs"'
						: "",
			},
		);

		expect(result.related.get("scripts/lib/ci-checks.mjs")).toEqual(
			new Set(["tests/scripts/ci-verdict.test.ts"]),
		);
		expect(result.related.get("scripts/guard-bash.mjs")).toEqual(
			new Set(["tests/scripts/guard-bash.test.ts"]),
		);
		expect(result.tests).toEqual([
			"tests/scripts/ci-verdict.test.ts",
			"tests/scripts/guard-bash.test.ts",
		]);
	});

	it("reports changed scripts with no covering test instead of silently selecting none", () => {
		// Recurrence: a changed mutation target without a related test must be a
		// review finding, not an accidental green mutation run.
		const result = mapRelatedTests(["scripts/uncovered.mjs"], {
			testFiles: ["tests/scripts/other.test.ts"],
			readFile: () => "",
		});

		expect(result.uncovered).toEqual(["scripts/uncovered.mjs"]);
		expect(result.covered).toEqual([]);
		expect(result.tests).toEqual([]);
	});

	it("keeps the mutation population on scripts mjs files", () => {
		// Recurrence: mutating compiled clients or test sources produces vacuous
		// mutants because this lane activates the built runtime in memory.
		expect(isScriptMutationFile("scripts/hooks/guard-bash.mjs")).toBe(true);
		expect(isScriptMutationFile("scripts/example.test.mjs")).toBe(false);
		expect(isScriptMutationFile("clients/runtime.ts")).toBe(false);
		expect(config).toContain('testRunner: "command"');
		expect(config).toContain(
			'command: "node_modules/.bin/vitest run --configLoader runner"',
		);
		expect(config).toContain('"scripts/**/*.mjs", "!scripts/**/*.test.mjs"');
		expect(config).toContain('coverageAnalysis: "off"');
		expect(config).not.toContain("vitest:");
		// Spike 2026-09-09: TypeScript 7 lacks the API Stryker's sandbox tsconfig
		// preprocessor calls, so the lane mutates in place; the in-place reset
		// drops compiled clients/*.js, so one build runs before the dry run.
		// Neither implies a per-mutant rebuild: the population is .mjs run directly.
		expect(config).toContain('buildCommand: "npm run build"');
		expect(config).toContain("inPlace: true");
		expect(config).not.toContain("clients/");
	});
});
