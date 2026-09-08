import { describe, expect, it } from "vitest";
import { isProductionMutationFile } from "../../scripts/lib/stryker-diff.mjs";

describe("stryker diff production-file filter", () => {
	it("keeps only mutable production sources from a fake diff list", () => {
		// Recurrence: a diff runner must not hand tests, fixtures, declarations, or
		// compiled JavaScript to Stryker as production mutation targets.
		const diff = [
			"clients/file-utils.ts",
			"scripts/lib/ci-failure-classifier.mjs",
			"tests/scripts/example.test.ts",
			"tests/fixtures/example.ts",
			"clients/types.d.mts",
			"clients/types.d.ts",
			"clients/file-utils.js",
		];
		expect(diff.filter(isProductionMutationFile)).toEqual([
			"clients/file-utils.ts",
			"scripts/lib/ci-failure-classifier.mjs",
		]);
	});
});
