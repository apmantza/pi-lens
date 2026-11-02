// mutation-lane: exclude
// flake-shape: raw-timer-wait — poll the real MCP child's background review-graph build
/**
 * project_report text-first parity (#5150 R2) — real stdio smoke: the pi tool
 * and `pilens_project_report` render the default text through one renderer
 * (`renderTextProjectReport`), and the explicit `view:"json"` hatch serves a
 * parseable engine document on both surfaces.
 *
 * Each surface builds its own review graph from the same fixture files (the
 * harness child cannot share the test process's in-memory graph or its
 * per-process attempt rows), so volatile stamps — ISO timestamps and process
 * build ids — are normalized before the byte comparison. Everything else is
 * deterministic graph content.
 *
 * Requires `npm run build` first (resolves mcp/server.js next to its source).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FactStore } from "../../clients/dispatch/fact-store.js";
import {
	_resetProjectReportBuildGuardForTests,
	projectReport,
} from "../../clients/project-report.js";
import {
	_resetReviewGraphBuildAttemptsForTests,
	buildOrUpdateGraph,
	clearReviewGraphWorkspaceCache,
} from "../../clients/review-graph/builder.js";
import { createProjectReportTool } from "../../tools/project-report.js";
import { createTempFile, setupTestEnvironment } from "../clients/test-utils.js";
import { scaledTestTimeout } from "../support/test-timeout-scale.js";
import { McpHarness } from "./harness.js";

type ToolResult = {
	content?: { type: string; text?: string }[];
	isError?: boolean;
};

/** Drop the gate's stamped contract footer, keeping the tool payload. */
function stripFooter(text: string): string {
	return text
		.replace(
			/\nresult (?:ok|error)\n(?:diag severity=.*\n)?usage tokens=\d+ elapsed-ms=\d+ bytes=\d+ truncated=(?:true|false)$/,
			"",
		)
		.replace(/\n$/, "");
}

/** Normalize the stamps each surface's independent build assigns. */
function normalizeVolatile(text: string): string {
	return text
		.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "<timestamp>")
		.replace(/\(build \d+\)/g, "(build #)");
}

/** The hatch document with its volatile stamps normalized for comparison. */
function normalizeHatch(text: string): string {
	return JSON.stringify(JSON.parse(text), (key, value: unknown) =>
		key === "graphBuiltAt" || key === "when"
			? "<timestamp>"
			: key === "buildId"
				? 0
				: (value as unknown),
	);
}

describe("project_report pi/MCP text parity (#5150 R2)", { retry: 2 }, () => {
	let env: ReturnType<typeof setupTestEnvironment>;
	let harness: McpHarness;

	beforeAll(async () => {
		env = setupTestEnvironment("pi-lens-preport-parity-");
		createTempFile(
			env.tmpDir,
			"clients/hub.ts",
			[
				"export function hubFn(x) {",
				"  if (x > 0) {",
				"    return 1;",
				"  } else {",
				"    return 0;",
				"  }",
				"}",
			].join("\n"),
		);
		createTempFile(
			env.tmpDir,
			"clients/consumer.ts",
			"import { hubFn } from './hub';\nexport function run() { return hubFn(1); }\n",
		);
		createTempFile(
			env.tmpDir,
			"entry/main.ts",
			"import { run } from '../clients/consumer';\nexport function main() { return run(); }\n",
		);
		createTempFile(
			env.tmpDir,
			"dirA/a.ts",
			"import { b } from '../dirB/b';\nexport const a = b;\n",
		);
		createTempFile(
			env.tmpDir,
			"dirB/b.ts",
			"import { a } from '../dirA/a';\nexport const b = a;\n",
		);
		// Warm this process's graph for the pi surface below.
		await buildOrUpdateGraph(env.tmpDir, [], new FactStore());

		// The warm-code-stale advisory (`warmCodeStale: true` + prose,
		// `withStaleWarning` in mcp/server.ts) is appended by the MCP wrapper
		// AFTER the tool's own text when this child serves a stale warm build —
		// only for a `WARN_ONLY_STALE_TOOLS` member whose result is not an error
		// (`mcp/server.ts:2030-2033`). It is an accepted residual for
		// `pilens_project_report` (#5158) and is not part of the tool cell this
		// test compares, so disable the gate for this child — the same wrapper
		// layer the gate's contract footer is stripped from below. Without this
		// the byte-identity guard is conditionally wrong: a stale warm build reds
		// it with the advisory rather than with any rendering divergence.
		harness = new McpHarness({
			cwd: env.tmpDir,
			env: { PI_LENS_WARM_STALENESS_CHECK: "0" },
		});
		const init = await harness.request(1, "initialize", {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "preport-parity", version: "0" },
		});
		expect((init.result as { protocolVersion: string }).protocolVersion).toBe(
			"2025-06-18",
		);
		harness.notify("notifications/initialized");
		// Warm the child's own graph: the first call triggers its background
		// build and reports unavailable; poll the JSON hatch until it serves.
		// The bound is a real-clock deadline (shape 86), not a turn count: the
		// same 40 x 500 ms budget, widened by the lane's scale, so a loaded
		// runner spends the budget on the build instead of running out of rounds.
		const until = Date.now() + scaledTestTimeout(20_000);
		let id = 10;
		let warm = false;
		while (!warm && Date.now() < until) {
			const res = await harness.request(id++, "tools/call", {
				name: "pilens_project_report",
				arguments: { view: "json" },
			});
			const result = res.result as ToolResult;
			if (!result.isError) {
				const doc = JSON.parse(stripFooter(result.content?.[0]?.text ?? ""));
				warm = doc.available === true;
			}
			if (!warm) await new Promise((r) => setTimeout(r, 500));
		}
		expect(warm).toBe(true);
	});

	afterAll(() => {
		harness.dispose();
		clearReviewGraphWorkspaceCache();
		_resetReviewGraphBuildAttemptsForTests();
		_resetProjectReportBuildGuardForTests();
		env.cleanup();
	});

	it("serves byte-identical default text on both surfaces", async () => {
		const tool = createProjectReportTool(() => env.tmpDir);
		const piResult = (await tool.execute("1", {}, undefined, null, {
			cwd: env.tmpDir,
		})) as ToolResult;
		expect(piResult.isError).toBeFalsy();

		const res = await harness.request(100, "tools/call", {
			name: "pilens_project_report",
			arguments: {},
		});
		const mcpResult = res.result as ToolResult;
		expect(mcpResult.isError).toBeFalsy();
		// One text block, no fenced JSON sidecar: the payload is the cell.
		expect(mcpResult.content).toHaveLength(1);
		// The wire still stamps the gate's universal contract footer onto that
		// block, which is what stripFooter above exists for; pin it rather than
		// assume it.
		expect(mcpResult.content?.[0]?.text).toMatch(
			/result ok\nusage tokens=\d+ elapsed-ms=\d+ bytes=\d+ truncated=(?:true|false)$/,
		);
		expect(mcpResult.content?.[0]?.text).not.toContain("```json");
		expect(
			normalizeVolatile(stripFooter(mcpResult.content?.[0]?.text ?? "")),
		).toBe(normalizeVolatile(String(piResult.content?.[0]?.text)));
	}, 60_000);

	it("serves the same parseable JSON document behind view:json", async () => {
		const tool = createProjectReportTool(() => env.tmpDir);
		const piResult = (await tool.execute(
			"1",
			{ view: "json" },
			undefined,
			null,
			{ cwd: env.tmpDir },
		)) as ToolResult;
		expect(piResult.isError).toBeFalsy();

		const res = await harness.request(101, "tools/call", {
			name: "pilens_project_report",
			arguments: { view: "json" },
		});
		const mcpResult = res.result as ToolResult;
		expect(mcpResult.isError).toBeFalsy();
		const mcpPayload = stripFooter(mcpResult.content?.[0]?.text ?? "");
		// Hatch stays a single parseable document on the wire.
		const doc = JSON.parse(mcpPayload);
		expect(doc.available).toBe(true);
		expect(normalizeHatch(mcpPayload)).toBe(
			normalizeHatch(String(piResult.content?.[0]?.text)),
		);
		// Same keys the engine document carried before the flip (no renames).
		const engineDoc = await projectReport(env.tmpDir);
		expect(Object.keys(doc).sort()).toEqual(
			Object.keys(JSON.parse(JSON.stringify(engineDoc))).sort(),
		);
	}, 60_000);

	it("serves the cold-cache text cell on MCP, not a fenced JSON copy", async () => {
		// A sibling fixture with its own project marker, so the child has no
		// graph for it (a subdirectory would resolve to this fixture's root and
		// inherit its cached graph).
		const coldEnv = setupTestEnvironment("pi-lens-preport-parity-cold-");
		try {
			createTempFile(coldEnv.tmpDir, "a.ts", "export const a = 1;\n");
			const res = await harness.request(102, "tools/call", {
				name: "pilens_project_report",
				arguments: { cwd: coldEnv.tmpDir },
			});
			const result = res.result as ToolResult;
			expect(result.isError).toBe(true);
			// One text block, no fenced JSON sidecar: a cold cache is still the
			// text cell (#5150), and its unavailable layout is the renderer's.
			expect(result.content).toHaveLength(1);
			const text = stripFooter(result.content?.[0]?.text ?? "");
			expect(text).not.toContain("```json");
			expect(text).toContain("project_report — unavailable");
			expect(text).toContain("LAST BUILD:");
		} finally {
			coldEnv.cleanup();
		}
	}, 60_000);
});
