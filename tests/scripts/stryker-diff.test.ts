import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	capMutationFiles,
	formatCapNotice,
	formatVitestCommand,
	isSourceMutationFile,
	isScriptMutationFile,
	mapRelatedTests,
} from "../../scripts/lib/stryker-diff.mjs";
import {
	STRYKER_ALIAS_EXCLUSIONS,
	strykerSourceAlias,
} from "../../vitest.stryker.config.js";

const config = readFileSync(
	resolve(import.meta.dirname, "../../stryker.config.mjs"),
	"utf8",
);

describe("stryker diff selection", () => {
	it.each([
		["extensionless", 'import "../../scripts/lib/ci-checks"'],
		["javascript extension", 'import "../../scripts/lib/ci-checks.js"'],
		["module extension", 'import "../../scripts/lib/ci-checks.mjs"'],
		["side-effect", 'import "../../scripts/lib/ci-checks"'],
		["dynamic", 'await import("../../scripts/lib/ci-checks")'],
	])("maps %s relative imports to the changed script", (_form, source) => {
		// Recurrence: extension spelling and import form must not hide a related
		// test from the incremental mutation lane.
		const result = mapRelatedTests(["scripts/lib/ci-checks.mjs"], {
			testFiles: ["tests/scripts/related.test.ts"],
			readFile: () => source,
		});

		expect(result.related.get("scripts/lib/ci-checks.mjs")).toEqual(
			new Set(["tests/scripts/related.test.ts"]),
		);
	});

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

	it("maps a compiled client import to its TypeScript mutation target", () => {
		// Recurrence: tests importing clients/x.js otherwise execute the stale
		// sibling and leave mutants in clients/x.ts with no coverage.
		const result = mapRelatedTests(["clients/file-utils.ts"], {
			testFiles: ["tests/clients/file-utils.test.ts"],
			readFile: () =>
				'import { isTestFile } from "../../clients/file-utils.js"',
		});

		expect(result.related.get("clients/file-utils.ts")).toEqual(
			new Set(["tests/clients/file-utils.test.ts"]),
		);
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

	it("caps the mutation population alphabetically and names skipped files", () => {
		// Recurrence: an unbounded changed-script population can turn the
		// advisory lane into an unbounded CI cost.
		const result = capMutationFiles(
			["scripts/z.mjs", "scripts/a.mjs", "scripts/m.mjs"],
			2,
		);

		expect(result.selected).toEqual(["scripts/a.mjs", "scripts/m.mjs"]);
		expect(result.skipped).toEqual(["scripts/z.mjs"]);
		expect(formatCapNotice(2, 3, result.skipped)).toBe(
			"capped: 2 of 3 changed scripts mutated; skipped: scripts/z.mjs",
		);
	});

	it("keeps the mutation population on scripts mjs files", () => {
		// Recurrence: mutating compiled clients or test sources produces vacuous
		// mutants because this lane activates the built runtime in memory.
		expect(isScriptMutationFile("scripts/hooks/guard-bash.mjs")).toBe(true);
		expect(isScriptMutationFile("scripts/example.test.mjs")).toBe(false);
		expect(isScriptMutationFile("clients/runtime.ts")).toBe(false);
		expect(isSourceMutationFile("clients/runtime.ts")).toBe(true);
		expect(isSourceMutationFile("clients/runtime.d.ts")).toBe(false);
		expect(isSourceMutationFile("tests/fixtures/client.ts")).toBe(false);
		expect(config).toContain('testRunner: "command"');
		expect(config).toContain(
			'command: "node_modules/.bin/vitest run --configLoader runner"',
		);
		expect(config).toContain('"scripts/**/*.mjs"');
		expect(config).toContain('"!scripts/**/*.test.mjs"');
		expect(config).toContain('coverageAnalysis: "off"');
		expect(config).not.toContain("vitest:");
		// Spike 2026-09-09: TypeScript 7 lacks the API Stryker's sandbox tsconfig
		// preprocessor calls, so the lane mutates in place; the in-place reset
		// drops compiled clients/*.js, so one build runs before the dry run.
		// Neither implies a per-mutant rebuild: the population is .mjs run directly.
		expect(config).toContain('buildCommand: "npm run build"');
		expect(config).toContain("inPlace: true");
		expect(config).toContain("clients/**/*.ts");
		expect(config).toContain("disableTypeChecks: true");
	});

	it("uses the source resolver only for client mutation commands", () => {
		// Recurrence: the generated command must opt into the alias config when a
		// selected source target is loaded through a compiled .js specifier.
		expect(
			formatVitestCommand(["tests/clients/file-utils.test.ts"], true),
		).toBe(
			"node_modules/.bin/vitest run --config vitest.stryker.config.ts --configLoader runner 'tests/clients/file-utils.test.ts'",
		);
	});

	it("redirects existing compiled imports and preserves intentional consumers", () => {
		const plugin = strykerSourceAlias();
		const resolveId = plugin.resolveId as (
			source: string,
			importer: string,
		) => string | undefined;
		expect(
			resolveId(
				"../../clients/file-utils.js",
				"tests/clients/file-utils.test.ts",
			),
		).toMatch(/clients\/file-utils\.ts$/);
		for (const [testFile, reason] of Object.entries(STRYKER_ALIAS_EXCLUSIONS)) {
			expect(reason).toMatch(/compiled|dist/);
			expect(
				resolveId("../../clients/file-utils.js", testFile),
			).toBeUndefined();
		}
	});
});
