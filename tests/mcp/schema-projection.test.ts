/**
 * #5138 PR 3 — the MCP catalog projects the pi tool definitions.
 *
 * An MCP entry's `inputSchema` is `schemaWithCwd(piTool.parameters)` and its
 * `description` is the pi tool's own `description` routed through the MCP name
 * translator, so no entry hand-restates a schema pi already owns. Both sides are
 * the live production surfaces: the pi definitions come from pi's own
 * `ExtensionRunner` (tier 1) and the MCP entries from the spawned stdio server.
 *
 * Cells:
 *
 * 1. **schema-identity** — one cell per `TOOL_REGISTRY` row that has both a
 *    `piName` and an `mcpName`, so a newly registered tool cannot skip the
 *    projection.
 * 2. **description identity** — the same cell asserts the wire text is the pi
 *    sentence through the translator. Three pre-PR-3 entries still hand-write
 *    their prose; each is admitted with its reason and reds once it joins.
 * 3. **constrained-only-on-declared-set** — a tool carries `constrainedSampling`
 *    iff its own `parameters` declare an `enum`, asserted in both directions.
 *
 * Requires `npm run build` first (both tiers load the compiled twins).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	TOOL_REGISTRY,
	translateGuidanceToolNames,
} from "../../clients/tool-config.js";
import { schemaWithCwd } from "../../mcp/input-schema.js";
import { McpHarness } from "./harness.js";
import { startPiRunner } from "../support/pi-runner.js";

/** The constrained-sampling value every enum-bearing tool declares. */
const CONSTRAINED = { type: "json_schema", strict: "prefer" };

/**
 * The pi-side tools whose schemas carry an `enum` (#5138 PR 3, item 3). Listed
 * explicitly as well as derived from the schemas: if the derivation itself
 * broke, a derived-vs-derived cell would still pass.
 */
const EXPECTED_CONSTRAINED_TOOLS = [
	"ast_grep_outline",
	"ast_grep_replace",
	"ast_grep_search",
	"lens_diagnostic_mark",
	"lens_diagnostics",
	"lsp_navigation",
	"pi_lens_activate_tools",
	"read_enclosing",
];

/**
 * Entries whose `inputSchema` already projects but whose `description` still
 * hand-restates the pi prose. Their wire text differs from the pi sentence only
 * in wording (“code” for “source”), which is a prose change to three shipped
 * tools; the PR-3 brief keeps the four already-projected entries untouched, so
 * this axis is admitted here rather than widened in this PR. Each row reds once
 * the entry joins the projection.
 */
const DESCRIPTION_NOT_PROJECTED: Record<string, string> = {
	pilens_ast_grep_search:
		'MCP says "Search code by AST structure"; pi says "Search source by AST structure".',
	pilens_ast_grep_replace:
		"MCP wording predates the pi sentence; schema already projects.",
	pilens_lsp_navigation:
		"MCP wording predates the pi sentence; schema already projects.",
};

type PiDefinition = {
	name: string;
	description?: string;
	parameters?: unknown;
	constrainedSampling?: unknown;
};

type ListedMcpTool = {
	name: string;
	description?: string;
	inputSchema?: unknown;
};

/** Does this schema declare a non-empty `enum` anywhere in its tree? */
function declaresEnum(node: unknown): boolean {
	if (Array.isArray(node)) return node.some(declaresEnum);
	if (node === null || typeof node !== "object") return false;
	const record = node as Record<string, unknown>;
	if (Array.isArray(record.enum) && record.enum.length > 0) return true;
	return Object.values(record).some(declaresEnum);
}

function carriesConstrainedSampling(definition: PiDefinition): boolean {
	return (
		definition.constrainedSampling !== undefined &&
		definition.constrainedSampling !== false
	);
}

/** Registry rows that have a definition on BOTH surfaces. */
const projectablePopulation = TOOL_REGISTRY.filter(
	(entry) =>
		typeof entry.piName === "string" && typeof entry.mcpName === "string",
);

describe("MCP schema projection (#5138 PR 3)", () => {
	let piDefinitions: PiDefinition[];
	let mcpTools: ListedMcpTool[];
	let harness: McpHarness;

	beforeAll(async () => {
		const pi = await startPiRunner();
		piDefinitions = pi
			.getAllRegisteredTools()
			.map((tool) => tool.definition as PiDefinition);
		harness = new McpHarness();
		const listed = await harness.request(1, "tools/list");
		mcpTools = (listed.result as { tools: ListedMcpTool[] }).tools ?? [];
	});

	afterAll(() => harness?.dispose());

	const piByName = () =>
		new Map(piDefinitions.map((definition) => [definition.name, definition]));
	const mcpByName = () => new Map(mcpTools.map((tool) => [tool.name, tool]));

	it("drives every registry row that exists on both surfaces", () => {
		expect(projectablePopulation).toHaveLength(10);
		const populationNames = projectablePopulation.map((entry) => entry.mcpName);
		for (const admitted of Object.keys(DESCRIPTION_NOT_PROJECTED)) {
			expect(populationNames).toContain(admitted);
		}
		// Every row projects its schema; only the description axis has residue,
		// and it is the three rows above.
		expect(
			projectablePopulation.length -
				Object.keys(DESCRIPTION_NOT_PROJECTED).length,
		).toBe(7);
	});

	for (const entry of projectablePopulation) {
		const mcpName = entry.mcpName as string;
		const piName = entry.piName as string;
		const admittedDescription = DESCRIPTION_NOT_PROJECTED[mcpName];

		it(`${mcpName} projects ${piName}'s parameters and description`, () => {
			const piDefinition = piByName().get(piName);
			const mcpTool = mcpByName().get(mcpName);
			expect(piDefinition, `${piName} is not registered on pi`).toBeDefined();
			expect(
				mcpTool,
				`${mcpName} is not listed by the MCP server`,
			).toBeDefined();
			// Value identity through the shared projection seam, not pointer
			// identity: `schemaWithCwd` builds a fresh object per call.
			expect(mcpTool?.inputSchema).toEqual(
				schemaWithCwd(piDefinition?.parameters),
			);
			if (admittedDescription) {
				expect(admittedDescription.length).toBeGreaterThan(40);
				expect(mcpTool?.description).not.toBe(
					translateGuidanceToolNames(piDefinition?.description ?? "", "mcp"),
				);
			} else {
				expect(mcpTool?.description).toBe(
					translateGuidanceToolNames(piDefinition?.description ?? "", "mcp"),
				);
			}
		});
	}

	it("declares constrainedSampling on exactly the enum-bearing tools", () => {
		const carriers = piDefinitions
			.filter(carriesConstrainedSampling)
			.map((definition) => definition.name)
			.sort();
		const enumBearing = piDefinitions
			.filter((definition) => declaresEnum(definition.parameters))
			.map((definition) => definition.name)
			.sort();

		// Both directions in one comparison: an unlisted carrier and a missing
		// listed tool each red the same cell.
		expect(carriers).toEqual(enumBearing);
		// Pinned against the item-3 list independently of the derivation above.
		expect(carriers).toEqual(EXPECTED_CONSTRAINED_TOOLS);
		for (const definition of piDefinitions.filter(carriesConstrainedSampling)) {
			expect(definition.constrainedSampling, definition.name).toEqual(
				CONSTRAINED,
			);
		}
	});
});
