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
		descriptionTotal: number;
		total: number;
		tools: Record<string, number>;
	};
	mcp: {
		descriptionTotal: number;
		total: number;
		tools: Record<string, number>;
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
	return bytes(tool.description ?? "") + bytes(tool.promptSnippet ?? "");
}

function schemaBytes(tool: ListedTool): number {
	return bytes(
		tool.inputSchema ??
			(tool as ListedTool & { parameters?: unknown }).parameters ??
			{},
	);
}

function surfaceBytes(tool: ListedTool): number {
	return descriptionBytes(tool) + schemaBytes(tool);
}

function report(
	surface: string,
	actual: number,
	expected: number,
	tools: Record<string, number>,
): string {
	const rows = Object.entries(tools)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([name, size]) => `${name.padEnd(30)} ${size}`)
		.join("\n");
	return `${surface}: ${actual} bytes (baseline ${expected}); per-tool:\n${rows}`;
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
		const tools = Object.fromEntries(
			piTools.map((tool) => [tool.name, surfaceBytes(tool)]),
		);
		const descriptionTotal = piTools.reduce(
			(sum, tool) => sum + descriptionBytes(tool),
			0,
		);
		const total = Object.values(tools).reduce((sum, size) => sum + size, 0);
		const detail = `${report("pi", total, baseline.pi.total, tools)}\nAbove baseline = regression; below baseline = ratchet down.`;
		expect(descriptionTotal, detail).toBeLessThanOrEqual(8_000);
		expect(descriptionTotal, detail).toBe(baseline.pi.descriptionTotal);
		expect(total, detail).toBe(baseline.pi.total);
		expect(tools, detail).toEqual(baseline.pi.tools);
	});

	it("keeps the MCP tools/list roster within its two-sided baseline", () => {
		const tools = Object.fromEntries(
			mcpTools.map((tool) => [tool.name, surfaceBytes(tool)]),
		);
		const descriptionTotal = mcpTools.reduce(
			(sum, tool) => sum + descriptionBytes(tool),
			0,
		);
		const total = Object.values(tools).reduce((sum, size) => sum + size, 0);
		const detail = `${report("mcp", total, baseline.mcp.total, tools)}\nAbove baseline = regression; below baseline = ratchet down.`;
		expect(descriptionTotal, detail).toBeLessThanOrEqual(8_000);
		expect(descriptionTotal, detail).toBe(baseline.mcp.descriptionTotal);
		expect(total, detail).toBe(baseline.mcp.total);
		expect(tools, detail).toEqual(baseline.mcp.tools);
	});
});
