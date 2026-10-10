import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";
import { extractVitestFailureBlock } from "../../scripts/extract-vitest-failures.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const WORKFLOW = resolve(ROOT, ".github/workflows/tool-smoke.yml");

function loadWorkflow(): any {
	return yaml.load(readFileSync(WORKFLOW, "utf8"));
}

describe("nightly LSP capability refresh contract (#4277)", () => {
	it("runs every matrix census before the refresh PR step", () => {
		const workflow = loadWorkflow();
		const smoke = workflow.jobs["tool-smoke"];
		const censusIndex = smoke.steps.findIndex(
			(step: any) => step.id === "lsp_census",
		);
		const diffIndex = smoke.steps.findIndex(
			(step: any) => step.id === "docs_diff",
		);
		const census = smoke.steps[censusIndex];
		const refresh = workflow.jobs["tool-smoke-prs"].steps.find(
			(step: any) => step.with?.branch === "bot/lsp-docs-refresh",
		);

		expect(censusIndex).toBeGreaterThan(diffIndex);
		expect(census["continue-on-error"]).toBe(true);
		for (const file of [
			"tests/config/lsp-first-publish-census.test.ts",
			"tests/config/lsp-clean-behavior-census.test.ts",
			"tests/config/lsp-idle-eviction-measurement.test.ts",
			"tests/scripts/lsp-matrix-refresh-expiry.test.ts",
		])
			expect(census.run).toContain(file);
		expect(census.run).toContain(
			'tee "$RUNNER_TEMP/lsp-capability-census.log"',
		);
		expect(refresh.if).toContain(
			"needs.tool-smoke.outputs.census == 'success'",
		);
	});

	it("routes every non-success outcome to the separately titled tracker", () => {
		const workflow = loadWorkflow();
		const smoke = workflow.jobs["tool-smoke"];
		const notify = workflow.jobs["tool-smoke-notify"];
		const tracker = notify.steps.find((step: any) =>
			step.name?.includes("LSP capability census"),
		);
		const run = String(tracker.run);

		expect(tracker.if).toBe("always()");
		expect(run).toContain("TITLE='nightly: LSP capability census drift'");
		expect(run).toContain("scripts/upsert-tracking-issue.mjs");
		expect(run).toContain('--body-file "$body"');
		expect(run).toContain("--clean --close-when-clean");
		expect(run).toContain(
			'node scripts/extract-vitest-failures.mjs "$CENSUS_LOG"',
		);
		expect(notify.needs).toBe("tool-smoke");

		for (const [output, variable] of [
			["census", "CENSUS_OUTCOME"],
			["seed_matrix", "SEED_OUTCOME"],
			["lsp_matrix", "MATRIX_OUTCOME"],
			["clean_signal", "CLEAN_OUTCOME"],
			["server_capabilities", "CAPABILITIES_OUTCOME"],
			["idle_measurement", "IDLE_OUTCOME"],
			["idle_promote", "PROMOTE_OUTCOME"],
			["docs_diff", "DIFF_OUTCOME"],
		]) {
			expect(smoke.outputs[output]).toBeDefined();
			expect(run).toContain(`$${variable}`);
		}
		expect(run).toContain("$JOB_STATUS");
	});

	it("keeps coloured census diagnostics in the tracking issue body", () => {
		const coloured = [
			"\u001b[41m\u001b[1m FAIL \u001b[22m\u001b[49m \u001b[30m\u001b[42m default \u001b[49m\u001b[39m tests/config/lsp-first-publish-census.test.ts\u001b[2m > \u001b[22m#3310 first-publish census",
			"\u001b[31m\u001b[1mAssertionError\u001b[22m: expected [ Array(1) ] to deeply equal []\u001b[39m",
			'\u001b[31m+   "typescript (typescript-language-server): measured empty-first but wait-policy/strategies.ts has no emptyFirstPublish marker for \\"typescript\\""\u001b[39m',
			" Test Files  1 failed | 3 passed (4)",
		].join("\n");
		const body = extractVitestFailureBlock(coloured);
		expect(body).toContain("tests/config/lsp-first-publish-census.test.ts");
		expect(body).toContain("typescript-language-server");
		expect(body).toContain("emptyFirstPublish marker");
	});

	it("keeps every coloured failure block, including non-census failures", () => {
		const coloured = [
			"\u001b[41m\u001b[1m FAIL \u001b[22m\u001b[49m default tests/config/lsp-first-publish-census.test.ts > first",
			"first census detail",
			" Test Files  1 failed (1)",
			"\u001b[41m\u001b[1m FAIL \u001b[22m\u001b[49m default tests/config/lsp-clean-behavior-census.test.ts > second",
			"second census detail",
			" Test Files  2 failed (2)",
			"\u001b[41m\u001b[1m FAIL \u001b[22m\u001b[49m default tests/clients/unrelated.test.ts > third",
			"third unrelated detail",
			" Test Files  3 failed (3)",
		].join("\n");
		const body = extractVitestFailureBlock(coloured);
		expect(body).toContain("tests/config/lsp-first-publish-census.test.ts");
		expect(body).toContain("tests/config/lsp-clean-behavior-census.test.ts");
		expect(body).toContain("tests/clients/unrelated.test.ts");
	});

	it("bounds failure details with an explicit omitted-block count", () => {
		const output = Array.from({ length: 20 }, (_, index) =>
			[
				` FAIL default tests/config/failure-${index}.test.ts > case`,
				"x".repeat(1_000),
			].join("\n"),
		).join("\n");
		const body = extractVitestFailureBlock(output);
		expect(body.length).toBeLessThanOrEqual(12_000);
		expect(body).toMatch(/\(\d+ more failures truncated\)$/);
	});

	it("gates only the refresh PR, while preserving the independent promotion PR", () => {
		const workflow = loadWorkflow();
		const prs = workflow.jobs["tool-smoke-prs"].steps.filter((step: any) =>
			step.uses?.startsWith("peter-evans/create-pull-request"),
		);
		const refresh = prs.find(
			(step: any) => step.with?.branch === "bot/lsp-docs-refresh",
		);
		const promotion = prs.find(
			(step: any) => step.with?.branch === "bot/lsp-idle-evict-promote",
		);

		expect(refresh.if).toContain(
			"needs.tool-smoke.outputs.docs_changed == 'true'",
		);
		expect(refresh.if).toContain(
			"needs.tool-smoke.outputs.census == 'success'",
		);
		expect(promotion.if).toBe("needs.tool-smoke.outputs.promoted == 'true'");
	});
});
