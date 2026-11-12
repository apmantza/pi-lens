import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { McpHarness } from "../mcp/harness.js";
import { startPiRunner } from "../support/pi-runner.js";

type Tool = {
	name: string;
	parameters?: unknown;
	inputSchema?: unknown;
};

const snapshotPath = path.join(
	process.cwd(),
	"tests/config/parameter-schema-structure.snapshot.json",
);
const trimmedPiNames = [
	"ast_grep_search",
	"lens_diagnostics",
	"lsp_navigation",
];
const trimmedMcpNames = [
	"pilens_ast_grep_search",
	"pilens_diagnostics",
	"pilens_lsp_navigation",
];

function withoutDescriptions(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(withoutDescriptions);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value)
				.filter(([key]) => key !== "description")
				.map(([key, child]) => [key, withoutDescriptions(child)]),
		);
	}
	return value;
}

function selectedSchemas(
	tools: Tool[],
	names: string[],
): Record<string, unknown> {
	return Object.fromEntries(
		names.map((name) => {
			const tool = tools.find((candidate) => candidate.name === name);
			expect(tool, `missing trimmed tool ${name}`).toBeDefined();
			return [name, withoutDescriptions(tool?.inputSchema ?? tool?.parameters)];
		}),
	);
}

type SchemaRecord = Record<string, unknown>;

function untypedSchemaNodes(value: unknown, pathName = "$schema"): string[] {
	if (!value || typeof value !== "object" || Array.isArray(value)) return [];
	const schema = value as SchemaRecord;
	const hasType = "type" in schema;
	const hasTypedAlternative = ["anyOf", "oneOf"].some((key) => {
		const alternatives = schema[key];
		return (
			Array.isArray(alternatives) &&
			alternatives.length > 0 &&
			alternatives.every(
				(alternative) => untypedSchemaNodes(alternative).length === 0,
			)
		);
	});
	const hasTypeCarrier =
		hasType ||
		hasTypedAlternative ||
		"$ref" in schema ||
		"const" in schema ||
		"enum" in schema;
	const hits = hasTypeCarrier ? [] : [pathName];
	const children: string[] = [];
	for (const key of ["anyOf", "oneOf", "allOf"]) {
		const alternatives = schema[key];
		if (Array.isArray(alternatives))
			alternatives.forEach((child, index) => {
				children.push(
					...untypedSchemaNodes(child, `${pathName}/${key}/${index}`),
				);
			});
	}
	if ("items" in schema)
		children.push(...untypedSchemaNodes(schema.items, `${pathName}/items`));
	if (
		schema.properties &&
		typeof schema.properties === "object" &&
		!Array.isArray(schema.properties)
	)
		for (const [key, child] of Object.entries(
			schema.properties as SchemaRecord,
		))
			children.push(
				...untypedSchemaNodes(child, `${pathName}/properties/${key}`),
			);
	return [...hits, ...children];
}

describe("trimmed parameter schema structure (#2800 item 13)", () => {
	let piTools: Tool[];
	let mcp: McpHarness;
	let mcpTools: Tool[];

	beforeAll(async () => {
		// The real host's tool definitions, not the registration arguments (#4632).
		const pi = await startPiRunner();
		piTools = pi.getAllRegisteredTools().map((tool) => tool.definition);
		mcp = new McpHarness();
		const listed = await mcp.request(1, "tools/list");
		mcpTools = ((listed.result as { tools: Tool[] }).tools ?? []) as Tool[];
	});

	afterAll(() => mcp?.dispose());

	it("preserves every accepted argument shape on pi and MCP surfaces", () => {
		const actual = {
			pi: selectedSchemas(piTools, trimmedPiNames),
			mcp: selectedSchemas(mcpTools, trimmedMcpNames),
		};
		if (process.env.UPDATE_PARAMETER_SCHEMA_SNAPSHOT === "1") {
			fs.writeFileSync(snapshotPath, `${JSON.stringify(actual, null, "\t")}\n`);
		}
		const expected = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
		// Recurrence: byte-only pins can bless a narrowed enum or nested schema after regeneration.
		expect(actual).toEqual(expected);
	});

	it("rejects untyped nodes in every registered tool schema", () => {
		const surfaces = [
			["pi", piTools],
			["mcp", mcpTools],
		] as const;
		const violations = surfaces.flatMap(([surface, tools]) =>
			tools.flatMap((tool) =>
				untypedSchemaNodes(tool.inputSchema ?? tool.parameters).map(
					(pathName) =>
						`${surface}.${tool.name}${pathName.slice("$schema".length)}`,
				),
			),
		);
		expect(violations).toEqual([]);
	});

	it("catches aliased, indirect, and rebound untyped nodes", () => {
		const alias = { type: "array", items: {} };
		const indirect = () => ({ type: "array", items: {} });
		const source = { type: "array", items: {} };
		const rebound = source;

		expect(untypedSchemaNodes(alias)).toEqual(["$schema/items"]);
		expect(untypedSchemaNodes(indirect())).toEqual(["$schema/items"]);
		expect(untypedSchemaNodes(rebound)).toEqual(["$schema/items"]);
	});
});
