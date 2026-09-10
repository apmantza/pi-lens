import { describe, expect, it } from "vitest";
import vitestConfig, { realHarnessInclude } from "../../vitest.config.ts";

describe("real harness lane admission", () => {
	it("contains every real-harness test and excludes it from the default lane", () => {
		const projects = (vitestConfig.test?.projects ?? []) as Array<{
			test?: { name?: string; include?: string[]; exclude?: string[] };
		}>;
		const real = projects.find(
			(project) => project.test?.name === "real-harness",
		)?.test;
		const defaultProject = projects.find(
			(project) => project.test?.name === "default",
		)?.test;
		expect(real).toBeDefined();
		const expected = [
			"tests/real-harness/fixture-shape.test.ts",
			"tests/real-harness/negative.test.ts",
			"tests/real-harness/child-exit.test.ts",
			"tests/real-harness/scenario-1.test.ts",
			"tests/real-harness/scenario-3.test.ts",
			"tests/real-harness/tools-enabled.test.ts",
			"tests/real-harness/diagnostic-provenance.test.ts",
		];
		expect(realHarnessInclude).toEqual(expect.arrayContaining(expected));
		expect(realHarnessInclude).toHaveLength(expected.length);
		expect(real?.include).toEqual(expect.arrayContaining(expected));
		expect(defaultProject?.exclude).toEqual(expect.arrayContaining(expected));
	});
});
