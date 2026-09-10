import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import extension from "../../index.js";
import { McpHarness } from "../mcp/harness.js";
import { createPiMock } from "../support/pi-mock.js";

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
		tools.map((tool) => [
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
		// Use the same extension factory and registerTool seam as session_start.
		const pi = createPiMock();
		extension(pi.asExtensionAPI());
		piTools = [...pi.tools.values()] as ListedTool[];

		mcp = new McpHarness();
		const listed = await mcp.request(1, "tools/list");
		mcpTools = (listed.result as { tools: ListedTool[] }).tools ?? [];
	});

	afterAll(() => mcp?.dispose());

	it("keeps the pi roster within its two-sided baseline", () => {
		expectUniqueNames(piTools);
		const { measured, descriptionTotal, schemaTotal } = measure(piTools);
		const total = descriptionTotal + schemaTotal;
		const detail = report(
			"pi",
			descriptionTotal,
			schemaTotal,
			baseline.pi.budget,
			measured,
		);
		// 2026-09-10: budget is the measured after-trim total plus 10%.
		expect(total, detail).toBeLessThanOrEqual(baseline.pi.budget);
		expect(baseline.pi.budget).toBe(
			Math.ceil((descriptionTotal + schemaTotal) * 1.1),
		);
		expect(descriptionTotal, detail).toBe(baseline.pi.descriptionTotal);
		expect(schemaTotal, detail).toBe(baseline.pi.schemaTotal);
		expect(measured, detail).toEqual(baseline.pi.tools);
	});

	it("keeps the MCP tools/list roster within its two-sided baseline", () => {
		expectUniqueNames(mcpTools);
		const { measured, descriptionTotal, schemaTotal } = measure(mcpTools);
		const total = descriptionTotal + schemaTotal;
		const detail = report(
			"mcp",
			descriptionTotal,
			schemaTotal,
			baseline.mcp.budget,
			measured,
		);
		// 2026-09-10: budget is the measured after-trim total plus 10%.
		expect(total, detail).toBeLessThanOrEqual(baseline.mcp.budget);
		expect(baseline.mcp.budget).toBe(
			Math.ceil((descriptionTotal + schemaTotal) * 1.1),
		);
		expect(descriptionTotal, detail).toBe(baseline.mcp.descriptionTotal);
		expect(schemaTotal, detail).toBe(baseline.mcp.schemaTotal);
		expect(measured, detail).toEqual(baseline.mcp.tools);
	});
});
