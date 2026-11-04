import { describe, expect, it } from "vitest";
import "../../../../clients/dispatch/integration.js";
import { evaluateRules } from "../../../../clients/dispatch/fact-rule-runner.js";
import { runProviders } from "../../../../clients/dispatch/fact-runner.js";
import { FactStore } from "../../../../clients/dispatch/fact-store.js";
import type { DispatchContext } from "../../../../clients/dispatch/types.js";
import { detectFileKind } from "../../../../clients/file-kinds.js";

// Fourteen `if`s: cyclomatic 15, the rule's default threshold.
const BRANCHES = Array.from(
	{ length: 14 },
	(_, i) => `\tif (v${i} > 0) { return ${i}; }`,
).join("\n");
const JS_SOURCE = `function classify(${Array.from({ length: 14 }, (_, i) => `v${i}`).join(", ")}) {\n${BRANCHES}\n\treturn -1;\n}\n`;

/** The scanner's path: the registered providers, then the registered rules. */
async function highComplexityFindings(filePath: string, content: string) {
	const facts = new FactStore();
	const ctx = {
		filePath,
		cwd: "/tmp",
		kind: detectFileKind(filePath),
		fileRole: "source",
		pi: { getFlag: () => undefined },
		autofix: false,
		deltaMode: false,
		facts,
		hasTool: async () => false,
		log: () => {},
	} as DispatchContext;
	facts.setFileFact(filePath, "file.content", content);
	await runProviders(ctx);
	return evaluateRules(ctx).filter((d) => d.rule === "high-complexity");
}

describe("high-complexity language scope (#5086)", () => {
	it.each([".ts", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"])(
		"flags a cyclomatic-15 function in a %s file",
		async (ext) => {
			const findings = await highComplexityFindings(
				`/tmp/classify${ext}`,
				JS_SOURCE,
			);
			expect(findings.map((d) => d.message)).toEqual([
				"'classify' has cyclomatic complexity 15 — consider breaking it up",
			]);
		},
	);
});
