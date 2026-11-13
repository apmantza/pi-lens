import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { McpHarness } from "../mcp/harness.js";
import { startPiRunner } from "../support/pi-runner.js";
import {
	expectPlantedStaleRow,
	rowsWithoutLiveMember,
} from "../support/baseline-staleness.js";

type ListedTool = {
	name: string;
	description?: string;
	inputSchema?: unknown;
	promptSnippet?: string;
};

type Baseline = {
	pi: {
		budget: number;
		descriptionTotal: number;
		schemaTotal: number;
		tools: Record<string, { description: number; schema: number }>;
	};
	mcp: {
		budget: number;
		descriptionTotal: number;
		schemaTotal: number;
		tools: Record<string, { description: number; schema: number }>;
	};
};

const baselinePath = path.join(
	process.cwd(),
	"tests/config/tool-roster-budget.baseline.json",
);
const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8")) as Baseline;

function updateBaselineSurface(
	surface: "pi" | "mcp",
	measurement: ReturnType<typeof measure>,
): void {
	if (process.env.UPDATE_TOOL_ROSTER_BASELINE !== "1") return;
	const current = JSON.parse(fs.readFileSync(baselinePath, "utf8")) as Baseline;
	current[surface] = {
		budget: Math.ceil(
			(measurement.descriptionTotal + measurement.schemaTotal) * 1.1,
		),
		descriptionTotal: measurement.descriptionTotal,
		schemaTotal: measurement.schemaTotal,
		tools: measurement.measured,
	};
	baseline[surface] = current[surface];
	fs.writeFileSync(baselinePath, `${JSON.stringify(current, null, "\t")}\n`);
}

function bytes(value: unknown): number {
	return Buffer.byteLength(
		typeof value === "string" ? value : JSON.stringify(value),
	);
}

function descriptionBytes(tool: ListedTool): number {
	return bytes(tool.description ?? "");
}

function schemaBytes(tool: ListedTool): number {
	return bytes(
		tool.inputSchema ??
			(tool as ListedTool & { parameters?: unknown }).parameters ??
			{},
	);
}

function report(
	surface: string,
	descriptionTotal: number,
	schemaTotal: number,
	budget: number,
	tools: Record<string, { description: number; schema: number }>,
): string {
	const rows = Object.entries(tools)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(
			([name, sizes]) =>
				`${name.padEnd(30)} description=${sizes.description} schema=${sizes.schema}`,
		)
		.join("\n");
	return `${surface}: description=${descriptionTotal} schema=${schemaTotal} total=${descriptionTotal + schemaTotal} budget=${budget}; per-tool:\n${rows}`;
}

function measure(tools: ListedTool[]) {
	const measured = Object.fromEntries(
		[...tools]
			.sort((a, b) => a.name.localeCompare(b.name))
			.map((tool) => [
				tool.name,
				{
					description: descriptionBytes(tool),
					schema: schemaBytes(tool),
				},
			]),
	);
	const descriptionTotal = tools.reduce(
		(sum, tool) => sum + descriptionBytes(tool),
		0,
	);
	const schemaTotal = tools.reduce((sum, tool) => sum + schemaBytes(tool), 0);
	return { measured, descriptionTotal, schemaTotal };
}

type ToolRows = Record<string, { description: number; schema: number }>;

/**
 * The roster's two-sided comparison: a ledger row the live roster does not
 * measure (the row-without-producer direction), and a measured tool the
 * ledger does not carry. A row is the tool with both of its byte counts.
 */
function rosterDrift(ledger: ToolRows, measured: ToolRows): string[] {
	const rows = (tools: ToolRows) =>
		new Set(
			Object.entries(tools).map(
				([name, bytes]) =>
					`${name} description=${bytes.description} schema=${bytes.schema}`,
			),
		);
	return [
		...rowsWithoutLiveMember(rows(ledger), rows(measured)).map(
			(row) => `ledger row the roster does not measure: ${row}`,
		),
		...rowsWithoutLiveMember(rows(measured), rows(ledger)).map(
			(row) => `measured tool the ledger does not carry: ${row}`,
		),
	];
}

function expectUniqueNames(tools: ListedTool[]): void {
	const names = tools.map((tool) => tool.name);
	expect(new Set(names).size, `duplicate tool names: ${names.join(", ")}`).toBe(
		names.length,
	);
}

describe("tool roster description budget", () => {
	let piTools: ListedTool[];
	let mcp: McpHarness;
	let mcpTools: ListedTool[];

	beforeAll(async () => {
		// The real host's tool definitions, not the registration arguments (#4632).
		const pi = await startPiRunner();
		piTools = pi.getAllRegisteredTools().map((tool) => tool.definition);

		mcp = new McpHarness();
		const listed = await mcp.request(1, "tools/list");
		mcpTools = (listed.result as { tools: ListedTool[] }).tools ?? [];
	});

	afterAll(() => mcp?.dispose());

	it("keeps the pi roster within its two-sided baseline", () => {
		expectUniqueNames(piTools);
		const { measured, descriptionTotal, schemaTotal } = measure(piTools);
		updateBaselineSurface("pi", { measured, descriptionTotal, schemaTotal });
		const total = descriptionTotal + schemaTotal;
		const detail = report(
			"pi",
			descriptionTotal,
			schemaTotal,
			baseline.pi.budget,
			measured,
		);
		// 2026-09-10: budget is the measured after-trim total plus 10%.
		// #4687 (2026-10-21) re-trimmed the lazy tools' schemas (lsp_navigation,
		// the three ast-grep tools); the exact per-tool pins below are what
		// catches a schema regrowing after that trim.
		// #5136 (2026-11-04): symbol_search's description gained the compound-suffix
		// clause, so the description total and budget grew with the diff.
		// #5506: lsp_navigation's commandArguments schema gained strict-compatible
		// typed items, moving the measured roster by 66 bytes.
		expect(total, detail).toBeLessThanOrEqual(baseline.pi.budget);
		expect(baseline.pi.budget).toBe(
			Math.ceil((descriptionTotal + schemaTotal) * 1.1),
		);
		expect(descriptionTotal, detail).toBe(baseline.pi.descriptionTotal);
		expect(schemaTotal, detail).toBe(baseline.pi.schemaTotal);
		expect(rosterDrift(baseline.pi.tools, measured), detail).toEqual([]);
	});

	it("reds a planted baseline row the live roster never measured (#5072)", () => {
		// The row-without-producer direction of the pi ledger: a tool row no
		// registered tool measures, judged by the comparison the case above runs
		// against the live roster.
		const planted = "pilens_5072_ghost_tool";
		expectPlantedStaleRow({
			baseline: "tests/config/tool-roster-budget.baseline.json",
			rowKey: planted,
			verdict: rosterDrift(
				{ ...baseline.pi.tools, [planted]: { description: 1, schema: 1 } },
				measure(piTools).measured,
			),
		});
	});

	it("keeps the MCP tools/list roster within its two-sided baseline", () => {
		expectUniqueNames(mcpTools);
		const { measured, descriptionTotal, schemaTotal } = measure(mcpTools);
		updateBaselineSurface("mcp", { measured, descriptionTotal, schemaTotal });
		const total = descriptionTotal + schemaTotal;
		const detail = report(
			"mcp",
			descriptionTotal,
			schemaTotal,
			baseline.mcp.budget,
			measured,
		);
		// 2026-09-10: budget is the measured after-trim total plus 10%.
		// #5136 (2026-11-04): pilens_symbol_search now resolves the shared
		// SYMBOL_SEARCH_DESCRIPTION constant, so its total and budget grew.
		// #5506: pilens_lsp_navigation mirrors the typed commandArguments schema,
		// moving the measured roster by 66 bytes.
		expect(total, detail).toBeLessThanOrEqual(baseline.mcp.budget);
		expect(baseline.mcp.budget).toBe(
			Math.ceil((descriptionTotal + schemaTotal) * 1.1),
		);
		expect(descriptionTotal, detail).toBe(baseline.mcp.descriptionTotal);
		expect(schemaTotal, detail).toBe(baseline.mcp.schemaTotal);
		expect(rosterDrift(baseline.mcp.tools, measured), detail).toEqual([]);
	});
});
