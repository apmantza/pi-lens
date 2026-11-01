import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	moduleReport,
	projectModuleReport,
	renderCompactModuleReport,
	resolveModuleReportPreset,
} from "../../clients/module-report.js";
import { FactStore } from "../../clients/dispatch/fact-store.js";
import { buildOrUpdateGraph } from "../../clients/review-graph/builder.js";
import { createModuleReportTool } from "../../tools/module-report.js";
import { createTempFile, setupTestEnvironment } from "../clients/test-utils.js";

const HUB_SOURCE = [
	"export function a(): number {",
	"  return 1;",
	"}",
	"export function b(): number {",
	"  return 2;",
	"}",
	"export function c(): number {",
	"  return 3;",
	"}",
	"export function d(): number {",
	"  return 4;",
	"}",
	"/** Hub calls everything. */",
	"export function hub(): number {",
	"  return a() + b() + c() + d();",
	"}",
	"export function run(ctx: any) {",
	"  return { resetLSPService: () => ctx.ui.setStatus('x') };",
	"}",
].join("\n");

const WIDGET_SOURCE = [
	"export class Widget {",
	"  render(): number {",
	"    return this.size() + 1;",
	"  }",
	"  size(): number {",
	"    return 2;",
	"  }",
	"}",
	"export function build(): Widget {",
	"  return new Widget();",
	"}",
].join("\n");

const CALLER_SOURCE = [
	"import { hub } from './hub';",
	"export function caller(): number {",
	"  return hub();",
	"}",
].join("\n");

async function makeWarmEnv(prefix: string) {
	const env = setupTestEnvironment(prefix);
	createTempFile(env.tmpDir, "hub.ts", HUB_SOURCE);
	createTempFile(env.tmpDir, "caller.ts", CALLER_SOURCE);
	await buildOrUpdateGraph(env.tmpDir, [], new FactStore());
	return env;
}

describe("module_report presets (#5137)", () => {
	it("default preset returns lossless text, not JSON", async () => {
		const env = await makeWarmEnv("pi-lens-preset-default-");
		try {
			const tool = createModuleReportTool(() => env.tmpDir);
			const result = await tool.execute(
				"1",
				{ path: "hub.ts" },
				undefined,
				null,
				{
					cwd: env.tmpDir,
				},
			);
			const text = String(result.content[0]?.text);
			expect(text.startsWith("{")).toBe(false);
			expect(text).toContain("API:");
			expect(result.details.view).toBe("summary-text");
		} finally {
			env.cleanup();
		}
	});

	it("summary projection drops metrics and keeps callbacks", async () => {
		const env = await makeWarmEnv("pi-lens-preset-sum-");
		try {
			const tool = createModuleReportTool(() => env.tmpDir);
			const result = await tool.execute(
				"1",
				{ path: "hub.ts" },
				undefined,
				null,
				{
					cwd: env.tmpDir,
				},
			);
			const text = String(result.content[0]?.text);
			// The summary promise is field-token absence: no `used-by:` lines, no
			// `cx:`/`fan:` metric suffixes. It is NOT "metrics never appear in
			// prose": RECOMMENDED reasons are ranked from unprojected entries
			// and may still cite counts (e.g. "used by 3").
			expect(text).not.toContain("used-by:");
			expect(text).not.toContain("cx:");
			expect(text).not.toContain("fan:");
			expect(text).toContain("CALLBACKS:");
		} finally {
			env.cleanup();
		}
	});

	it("full-text renders metrics and flags", async () => {
		const env = await makeWarmEnv("pi-lens-preset-fulltext-");
		try {
			const tool = createModuleReportTool(() => env.tmpDir);
			const result = await tool.execute(
				"1",
				{ path: "hub.ts", view: "full-text" },
				undefined,
				null,
				{ cwd: env.tmpDir },
			);
			const text = String(result.content[0]?.text);
			expect(text).toContain("used-by:");
			expect(text).toContain("cx:");
			expect(text).toContain("fan:");
			expect(text).toContain("[high fanout]");
		} finally {
			env.cleanup();
		}
	});

	it("full-json is byte-identical to the artifact", async () => {
		const env = await makeWarmEnv("pi-lens-preset-fulljson-");
		try {
			const tool = createModuleReportTool(() => env.tmpDir);
			const result = await tool.execute(
				"1",
				{ path: "hub.ts", view: "full-json" },
				undefined,
				null,
				{ cwd: env.tmpDir },
			);
			const text = String(result.content[0]?.text);
			const absFile = path.join(env.tmpDir, "hub.ts");
			const artifact = await moduleReport(absFile, env.tmpDir, {});
			expect(text).toBe(JSON.stringify(artifact));
			expect(JSON.parse(text)).not.toHaveProperty("view");
		} finally {
			env.cleanup();
		}
	});

	it("summary-json drops metrics, keeps callbacks and callback provenance", async () => {
		const env = await makeWarmEnv("pi-lens-preset-sumjson-");
		try {
			const tool = createModuleReportTool(() => env.tmpDir);
			const result = await tool.execute(
				"1",
				{ path: "hub.ts", view: "summary-json" },
				undefined,
				null,
				{ cwd: env.tmpDir },
			);
			const parsed = JSON.parse(String(result.content[0]?.text)) as {
				api: Array<{
					usedBy?: unknown;
					fanout?: unknown;
					complexity?: unknown;
				}>;
				callbacks: unknown[];
				provenance: { callbacks: string };
			};
			expect(parsed.api[0].usedBy).toBeUndefined();
			expect(parsed.api[0].fanout).toBeUndefined();
			expect(parsed.api[0].complexity).toBeUndefined();
			expect(parsed.callbacks.length).toBeGreaterThan(0);
			expect(parsed.provenance.callbacks).not.toBe("none");
		} finally {
			env.cleanup();
		}
	});

	it("maxRefsPerSymbol promotes the projection and keeps the format", async () => {
		const env = await makeWarmEnv("pi-lens-preset-promote-");
		try {
			const tool = createModuleReportTool(() => env.tmpDir);
			const promoted = await tool.execute(
				"1",
				{ path: "hub.ts", maxRefsPerSymbol: 3 },
				undefined,
				null,
				{ cwd: env.tmpDir },
			);
			expect(String(promoted.content[0]?.text)).toContain("cx:");
			expect(promoted.details.view).toBe("full-text");
			const kept = await tool.execute(
				"2",
				{ path: "hub.ts", maxRefsPerSymbol: 3, view: "summary-json" },
				undefined,
				null,
				{ cwd: env.tmpDir },
			);
			const parsed = JSON.parse(String(kept.content[0]?.text)) as {
				api: Array<{ usedBy?: unknown }>;
			};
			expect(parsed.api[0].usedBy).toBeDefined();
			expect(kept.details.view).toBe("full-json");
		} finally {
			env.cleanup();
		}
	});

	it("stale view value falls through to the default", async () => {
		const env = await makeWarmEnv("pi-lens-preset-stale-");
		try {
			const tool = createModuleReportTool(() => env.tmpDir);
			const baseline = await tool.execute(
				"0",
				{ path: "hub.ts" },
				undefined,
				null,
				{
					cwd: env.tmpDir,
				},
			);
			for (const stale of ["compact", "default"]) {
				const result = await tool.execute(
					"1",
					{ path: "hub.ts", view: stale },
					undefined,
					null,
					{ cwd: env.tmpDir },
				);
				expect(result.isError).toBe(false);
				expect(result.details.view).toBe("summary-text");
				expect(String(result.content[0]?.text)).toBe(
					String(baseline.content[0]?.text),
				);
			}
			void projectModuleReport;
			void renderCompactModuleReport;
			void resolveModuleReportPreset;
		} finally {
			env.cleanup();
		}
	});

	it("prototype-chain names fall through to the default (no throw)", async () => {
		const env = await makeWarmEnv("pi-lens-preset-proto-");
		try {
			const tool = createModuleReportTool(() => env.tmpDir);
			const baseline = await tool.execute(
				"0",
				{ path: "hub.ts" },
				undefined,
				null,
				{
					cwd: env.tmpDir,
				},
			);
			// `view in PRESET_AXES` walks the prototype chain: "constructor",
			// "toString" and "__proto__" all hit and resolve to a non-axes
			// value. They must fall through to summary-text like any unknown view.
			for (const proto of ["constructor", "toString", "__proto__"]) {
				const result = await tool.execute(
					"1",
					{ path: "hub.ts", view: proto },
					undefined,
					null,
					{ cwd: env.tmpDir },
				);
				expect(result.isError).toBe(false);
				expect(result.details.view).toBe("summary-text");
				expect(String(result.content[0]?.text)).toBe(
					String(baseline.content[0]?.text),
				);
			}
		} finally {
			env.cleanup();
		}
	});

	it("discloses the omitted metrics on the summary text cell", async () => {
		const env = await makeWarmEnv("pi-lens-preset-omitted-");
		try {
			const tool = createModuleReportTool(() => env.tmpDir);
			const summary = await tool.execute(
				"1",
				{ path: "hub.ts" },
				undefined,
				null,
				{ cwd: env.tmpDir },
			);
			const full = await tool.execute(
				"2",
				{ path: "hub.ts", view: "full-text" },
				undefined,
				null,
				{ cwd: env.tmpDir },
			);
			// A missing `used-by:` line must not read as "nothing uses this".
			expect(String(summary.content[0]?.text)).toContain(
				"metrics=omitted (view=full-text)",
			);
			expect(String(full.content[0]?.text)).not.toContain("metrics=omitted");
		} finally {
			env.cleanup();
		}
	});

	it("keeps a callback-only module's handles on the default text cell", async () => {
		const env = setupTestEnvironment("pi-lens-preset-callback-only-");
		try {
			createTempFile(
				env.tmpDir,
				"only-callbacks.ts",
				"setTimeout(() => cleanup(), 100);\n",
			);
			const tool = createModuleReportTool(() => env.tmpDir);
			const result = await tool.execute(
				"1",
				{ path: "only-callbacks.ts" },
				undefined,
				null,
				{ cwd: env.tmpDir },
			);
			const text = String(result.content[0]?.text);
			// No named entry and no graph node, so the report is unavailable, but
			// the handle the old JSON default carried still renders.
			expect(result.isError).toBe(true);
			expect(text).toContain("unavailable");
			expect(text).toContain("CALLBACKS:");
			expect(text).toContain("setTimeout");
		} finally {
			env.cleanup();
		}
	});

	// Recurrence: `stripEntryMetrics` stripped only the top-level entries, so a
	// class's methods kept `cx:`, `fan:` and `used-by:` in the summary text. Leaving
	// `entry.members` unstripped survived the whole suite (verify r1 F7).
	it("summary-text shows no member metrics on a class's methods", async () => {
		const env = setupTestEnvironment("pi-lens-preset-members-");
		try {
			createTempFile(env.tmpDir, "widget.ts", WIDGET_SOURCE);
			await buildOrUpdateGraph(env.tmpDir, [], new FactStore());
			const tool = createModuleReportTool(() => env.tmpDir);
			const summary = await tool.execute(
				"1",
				{ path: "widget.ts" },
				undefined,
				null,
				{ cwd: env.tmpDir },
			);
			const full = await tool.execute(
				"2",
				{ path: "widget.ts", view: "full-text" },
				undefined,
				null,
				{ cwd: env.tmpDir },
			);
			const summaryText = String(summary.content[0]?.text);
			// Controls: the methods render, and the full cell gives them metrics, so the
			// summary's absence below is the projection, not a missing member.
			expect(String(full.content[0]?.text)).toMatch(
				/method\s+render\(\)\s+cx:\d+/,
			);
			expect(summaryText).toMatch(/method\s+render\(\)/);
			expect(summaryText).not.toContain("used-by:");
			expect(summaryText).not.toContain("cx:");
			expect(summaryText).not.toContain("fan:");
		} finally {
			env.cleanup();
		}
	});
});
