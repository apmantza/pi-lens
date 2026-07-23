import { afterEach, describe, expect, it } from "vitest";
import { FactStore } from "../../clients/dispatch/fact-store.js";
import { _resetProjectReportBuildGuardForTests } from "../../clients/project-report.js";
import {
	buildOrUpdateGraph,
	clearReviewGraphWorkspaceCache,
} from "../../clients/review-graph/builder.js";
import { createProjectReportTool } from "../../tools/project-report.js";
import { createTempFile, setupTestEnvironment } from "../clients/test-utils.js";

afterEach(() => {
	clearReviewGraphWorkspaceCache();
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
		} finally {
			env.cleanup();
		}
	});

	it("returns a navigable JSON report on a warm graph", async () => {
		const env = setupTestEnvironment("pi-lens-projreport-tool-");
		try {
			createTempFile(env.tmpDir, "clients/hub.ts", "export function hubFn() { return 1; }\n");
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
			const report = JSON.parse(String(result.content[0]?.text));
			expect(report.available).toBe(true);
			expect(report.trust).toBeDefined();
			expect(Array.isArray(report.hubs)).toBe(true);
			expect(result.details.hubs).toBeGreaterThanOrEqual(0);
		} finally {
			env.cleanup();
		}
	});

	it("supports view:compact line-oriented rendering", async () => {
		const env = setupTestEnvironment("pi-lens-projreport-tool-");
		try {
			createTempFile(env.tmpDir, "clients/hub.ts", "export function hubFn() { return 1; }\n");
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
			expect(result.details.view).toBe("compact");
		} finally {
			env.cleanup();
		}
	});
});
