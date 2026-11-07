import { afterEach, describe, expect, it } from "vitest";
import { FactStore } from "../../clients/dispatch/fact-store.js";
import {
	_resetProjectReportBuildGuardForTests,
	projectReport,
	renderTextProjectReport,
} from "../../clients/project-report.js";
import {
	_setReviewGraphEntryBudgetForTests,
	buildOrUpdateGraph,
	clearReviewGraphWorkspaceCache,
} from "../../clients/review-graph/builder.js";
import { createProjectReportTool } from "../../tools/project-report.js";
import { createTempFile, setupTestEnvironment } from "../clients/test-utils.js";

afterEach(() => {
	clearReviewGraphWorkspaceCache();
	_setReviewGraphEntryBudgetForTests();
	_resetProjectReportBuildGuardForTests();
});

describe("project_report tool", () => {
	it("returns available:false with a hint on a cold cache without blocking", async () => {
		const env = setupTestEnvironment("pi-lens-projreport-tool-");
		try {
			createTempFile(env.tmpDir, "a.ts", "export const a = 1;\n");
			const tool = createProjectReportTool(() => env.tmpDir);
			const result = await tool.execute("1", {}, undefined, null, {
				cwd: env.tmpDir,
			});
			expect(result.isError).toBe(true);
			expect(result.details.available).toBe(false);
			expect(result.details.hint).toBeTruthy();
			// Cold cache is the text cell too (#5150): one text block, the
			// renderer's own unavailable layout, and no fenced JSON sidecar.
			expect(result.content).toHaveLength(1);
			const text = String(result.content[0]?.text);
			expect(text).toContain("project_report — unavailable");
			expect(text).toContain(result.details.hint);
			expect(text).not.toContain("```json");
		} finally {
			env.cleanup();
		}
	});

	it("returns the default TEXT report on a warm graph", async () => {
		const env = setupTestEnvironment("pi-lens-projreport-tool-");
		try {
			createTempFile(
				env.tmpDir,
				"clients/hub.ts",
				"export function hubFn() { return 1; }\n",
			);
			createTempFile(
				env.tmpDir,
				"clients/consumer.ts",
				"import { hubFn } from './hub';\nexport function run() { return hubFn(); }\n",
			);
			await buildOrUpdateGraph(env.tmpDir, [], new FactStore());

			const tool = createProjectReportTool(() => env.tmpDir);
			const result = await tool.execute("1", {}, undefined, null, {
				cwd: env.tmpDir,
			});
			expect(result.isError).toBeFalsy();
			// Default is the text cell, not JSON: the payload must not parse.
			const text = String(result.content[0]?.text);
			expect(() => JSON.parse(text)).toThrow();
			expect(text).toContain("TRUST:");
			expect(text).toContain("UNRENDERED:");
			expect(result.details.view).toBe("default");
			expect(result.details.hubs).toBeGreaterThanOrEqual(0);
		} finally {
			env.cleanup();
		}
	});

	it("reports an entry-budget-truncated graph as partial", async () => {
		const env = setupTestEnvironment("pi-lens-projreport-entry-budget-");
		try {
			createTempFile(env.tmpDir, "src/a.ts", "export const a = 1;\n");
			createTempFile(env.tmpDir, "src/b.ts", "export const b = 2;\n");
			_setReviewGraphEntryBudgetForTests(2);
			await buildOrUpdateGraph(env.tmpDir, [], new FactStore());

			const tool = createProjectReportTool(() => env.tmpDir);
			const result = await tool.execute(
				"1",
				{ view: "json" },
				undefined,
				null,
				{
					cwd: env.tmpDir,
				},
			);
			const report = JSON.parse(String(result.content[0]?.text));
			expect(result.isError).toBeFalsy();
			expect(report.trust.persistCoverage.sourceFilesTruncated).toBe(true);
			expect(report.trust.notes.join(" ")).toContain("Partial source walk");
		} finally {
			env.cleanup();
		}
	});

	it("#921: describes a capped graph without fabricating the sentinel as an exact file count", async () => {
		const env = setupTestEnvironment("pi-lens-projreport-tool-");
		const previous = process.env.PI_LENS_REVIEW_GRAPH_MAX_FILES;
		process.env.PI_LENS_REVIEW_GRAPH_MAX_FILES = "2";
		try {
			createTempFile(env.tmpDir, "a.ts", "export const a = 1;\n");
			createTempFile(env.tmpDir, "b.ts", "export const b = 2;\n");
			createTempFile(env.tmpDir, "c.ts", "export const c = 3;\n");
			await buildOrUpdateGraph(env.tmpDir, [], new FactStore());

			const tool = createProjectReportTool(() => env.tmpDir);
			const result = await tool.execute("1", {}, undefined, null, {
				cwd: env.tmpDir,
			});

			expect(result.isError).toBe(true);
			expect(result.details.hint).toBe(
				"review graph disabled: project has more than 2 files (cap 2) — " +
					"raise maxProjectFiles in .pi-lens.json or set " +
					"PI_LENS_REVIEW_GRAPH_MAX_FILES; for CI/cron, run npx pi-lens " +
					"build-graph after configuring the cap",
			);
			expect(result.details.hint).not.toContain("project has 3 files");
		} finally {
			if (previous === undefined)
				delete process.env.PI_LENS_REVIEW_GRAPH_MAX_FILES;
			else process.env.PI_LENS_REVIEW_GRAPH_MAX_FILES = previous;
			env.cleanup();
		}
	});

	it("falls through to the default text cell on a legacy compact view", async () => {
		const env = setupTestEnvironment("pi-lens-projreport-tool-");
		try {
			createTempFile(
				env.tmpDir,
				"clients/hub.ts",
				"export function hubFn() { return 1; }\n",
			);
			createTempFile(
				env.tmpDir,
				"clients/consumer.ts",
				"import { hubFn } from './hub';\nexport function run() { return hubFn(); }\n",
			);
			await buildOrUpdateGraph(env.tmpDir, [], new FactStore());

			const tool = createProjectReportTool(() => env.tmpDir);
			const result = await tool.execute(
				"1",
				{ view: "compact" },
				undefined,
				null,
				{ cwd: env.tmpDir },
			);
			expect(result.isError).toBeFalsy();
			const text = String(result.content[0]?.text);
			expect(text).toContain("TRUST:");
			// No enum: "compact" is an unknown view and falls through to text.
			const plain = await tool.execute("1", {}, undefined, null, {
				cwd: env.tmpDir,
			});
			expect(text).toBe(String(plain.content[0]?.text));
			expect(result.details.view).toBe("default");
		} finally {
			env.cleanup();
		}
	});

	it("#5150 R2: view:json hatch returns the byte-identical JSON document", async () => {
		const env = setupTestEnvironment("pi-lens-projreport-tool-");
		try {
			createTempFile(
				env.tmpDir,
				"clients/hub.ts",
				"export function hubFn() { return 1; }\n",
			);
			createTempFile(
				env.tmpDir,
				"clients/consumer.ts",
				"import { hubFn } from './hub';\nexport function run() { return hubFn(); }\n",
			);
			await buildOrUpdateGraph(env.tmpDir, [], new FactStore());

			const tool = createProjectReportTool(() => env.tmpDir);
			const result = await tool.execute(
				"1",
				{ view: "json" },
				undefined,
				null,
				{
					cwd: env.tmpDir,
				},
			);
			expect(result.isError).toBeFalsy();
			// The hatch is the engine document itself: same bytes, same keys,
			// no reformatting. The engine data path is untouched by the flip.
			const report = JSON.parse(String(result.content[0]?.text));
			expect(report.available).toBe(true);
			expect(String(result.content[0]?.text)).toBe(
				JSON.stringify(await projectReport(env.tmpDir)),
			);
			expect(result.details.view).toBe("json");
			// And the default cell is the same report through the one renderer.
			const text = await tool.execute("1", {}, undefined, null, {
				cwd: env.tmpDir,
			});
			expect(String(text.content[0]?.text)).toBe(
				renderTextProjectReport(await projectReport(env.tmpDir)),
			);
		} finally {
			env.cleanup();
		}
	});

	// Guards #5372: the tool rejected the `*-json` preset names the
	// module_report family accepts and silently served the text cell for them.
	it("serves the JSON document for any *-json view (#5372)", async () => {
		const env = setupTestEnvironment("pi-lens-projreport-tool-");
		try {
			createTempFile(
				env.tmpDir,
				"clients/hub.ts",
				"export function hubFn() { return 1; }\n",
			);
			createTempFile(
				env.tmpDir,
				"clients/consumer.ts",
				"import { hubFn } from './hub';\nexport function run() { return hubFn(); }\n",
			);
			await buildOrUpdateGraph(env.tmpDir, [], new FactStore());

			const tool = createProjectReportTool(() => env.tmpDir);
			for (const view of ["json", "full-json", "summary-json"]) {
				const result = await tool.execute("1", { view }, undefined, null, {
					cwd: env.tmpDir,
				});
				expect(result.isError).toBeFalsy();
				const doc = JSON.parse(String(result.content[0]?.text));
				expect(doc.available).toBe(true);
				expect(result.details.view).toBe("json");
			}
			// Old values keep working: a non-`*-json` name is still the text cell
			// (the sibling legacy-compact case pins its content).
			const textResult = await tool.execute(
				"2",
				{ view: "summary-text" },
				undefined,
				null,
				{ cwd: env.tmpDir },
			);
			expect(() => JSON.parse(String(textResult.content[0]?.text))).toThrow();
			expect(textResult.details.view).toBe("default");
		} finally {
			env.cleanup();
		}
	});

	// Guards #5372 review r1 F1: the hatch predicate was an open suffix match,
	// so `view:"foo-json"` served the full JSON document while the same name
	// on module_report served the text cell. The #5150 contract — unknown
	// views never reach JSON — requires the gate to admit known JSON view
	// names only (shape #83: a verdict gate admitting an open spelling).
	it("serves the text cell for unknown *-json-shaped views (#5372 r1 F1)", async () => {
		const env = setupTestEnvironment("pi-lens-projreport-tool-");
		try {
			createTempFile(
				env.tmpDir,
				"clients/hub.ts",
				"export function hubFn() { return 1; }\n",
			);
			createTempFile(
				env.tmpDir,
				"clients/consumer.ts",
				"import { hubFn } from './hub';\nexport function run() { return hubFn(); }\n",
			);
			await buildOrUpdateGraph(env.tmpDir, [], new FactStore());

			const tool = createProjectReportTool(() => env.tmpDir);
			for (const view of ["foo-json", "-json"]) {
				const result = await tool.execute("1", { view }, undefined, null, {
					cwd: env.tmpDir,
				});
				expect(result.isError).toBeFalsy();
				// The text cell, not the JSON document: it stays unparsable and
				// carries the renderer's own heading.
				expect(() => JSON.parse(String(result.content[0]?.text))).toThrow();
				expect(String(result.content[0]?.text)).toContain("project_report —");
				expect(result.details.view).toBe("default");
			}
		} finally {
			env.cleanup();
		}
	});
});
