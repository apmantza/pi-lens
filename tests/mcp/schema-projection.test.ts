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
 *    only when the real strict conversion has no enum unions (#5471).
 *
 * Requires `npm run build` first (both tiers load the compiled twins).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	TOOL_REGISTRY,
	translateGuidanceToolNames,
} from "../../clients/tool-config.js";
import { schemaWithCwd } from "../../mcp/input-schema.js";
import { McpHarness } from "./harness.js";
import { startPiRunner } from "../support/pi-runner.js";

/** The constrained-sampling value retained by strict-safe tools. */
const CONSTRAINED = { type: "json_schema", strict: "prefer" };

/** Strict-safe carriers; required enums remain constrained (#5471). */
const EXPECTED_CONSTRAINED_TOOLS = [
	"lens_diagnostic_mark",
	"pi_lens_activate_tools",
];

// #5506: lsp_navigation keeps object-valued command arguments that pi-ai's
// strict conversion cannot represent, so it deliberately opts out of strict.

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

// #5471: beam-free rejects enum/const unions after pi-ai strict conversion.
// Known schema vocabulary only: an unclassified form is a hit, never a pass.
function unsafeStrictSchema(node: unknown, inUnion = false): boolean {
	if (!node || typeof node !== "object" || Array.isArray(node)) return true;
	const schema = node as Record<string, unknown>;
	const types = Array.isArray(schema.type) ? schema.type : [schema.type];
	if (types.includes("object") && schema.additionalProperties !== false)
		return true;
	if (types.includes("array") && !("items" in schema)) return true;
	const union =
		inUnion ||
		"anyOf" in schema ||
		"oneOf" in schema ||
		Array.isArray(schema.type);
	if (union && ("enum" in schema || "const" in schema)) return true;
	return Object.entries(schema).some(([key, value]) => {
		if (["anyOf", "oneOf", "allOf"].includes(key)) {
			return (
				!Array.isArray(value) ||
				value.length === 0 ||
				value.some((child) => unsafeStrictSchema(child, union))
			);
		}
		if (key === "properties") {
			return (
				!value ||
				typeof value !== "object" ||
				Array.isArray(value) ||
				Object.values(value).some((child) => unsafeStrictSchema(child, union))
			);
		}
		if (key === "items") return unsafeStrictSchema(value, union);
		if (key === "additionalProperties") return value !== false;
		if (key === "type") {
			const types = Array.isArray(value) ? value : [value];
			return (
				types.length === 0 ||
				types.some(
					(type) =>
						![
							"object",
							"array",
							"string",
							"number",
							"integer",
							"boolean",
							"null",
						].includes(type),
				)
			);
		}
		return ![
			"enum",
			"const",
			"required",
			"description",
			"title",
			"default",
			"minimum",
			"maximum",
			"exclusiveMinimum",
			"exclusiveMaximum",
			"multipleOf",
			"minLength",
			"maxLength",
			"pattern",
			"format",
			"minItems",
			"maxItems",
			"uniqueItems",
			"minProperties",
			"maxProperties",
		].includes(key);
	});
}

/** The pi-ai surface the guard drives; pi-ai's own `Tool` is a host type. */
type SamplingTool = { name: string; parameters: unknown };
type ConstrainedSamplingModule = {
	getJsonSchemaToolParameters(
		tool: SamplingTool,
		strict: boolean | undefined,
	): unknown;
	resolveJsonSchemaStrictSampling(
		tool: SamplingTool,
		supportsStrictMode: boolean,
	): boolean | undefined;
};

/**
 * `@earendil-works/pi-ai` is not a dependency of this repo (#4664 F1): it ships
 * inside the host install. The conversion module is loaded at runtime from the
 * host's node_modules, as `tests/support/pi-session.ts` loads pi-ai, never
 * through a static specifier the dependency graph (and knip) would read. A
 * `PI_LENS_PI_HOST_PACKAGE` override is searched from that host's directory.
 */
async function hostConstrainedSampling(): Promise<ConstrainedSamplingModule> {
	const override = process.env.PI_LENS_PI_HOST_PACKAGE;
	const start = override
		? path.resolve(override)
		: path.dirname(fileURLToPath(import.meta.url));
	for (let dir = start; ; dir = path.dirname(dir)) {
		const candidate = path.join(
			dir,
			"node_modules",
			"@earendil-works",
			"pi-ai",
			"dist",
			"api",
			"constrained-sampling.js",
		);
		if (fs.existsSync(candidate))
			return (await import(
				pathToFileURL(candidate).href
			)) as ConstrainedSamplingModule;
		if (path.dirname(dir) === dir)
			throw new Error(
				`no @earendil-works/pi-ai constrained-sampling module is reachable from ${start} (#5471)`,
			);
	}
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

	let sampling: ConstrainedSamplingModule;

	beforeAll(async () => {
		sampling = await hostConstrainedSampling();
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
			// Independently of the wrapper: the wire must carry the pi tool's own
			// `required` list and every pi property, and add only `cwd`. Without
			// this, a `schemaWithCwd` that dropped `required` would match itself.
			const piParams = (piDefinition?.parameters ?? {}) as {
				properties?: Record<string, unknown>;
				required?: string[];
			};
			const wire = (mcpTool?.inputSchema ?? {}) as {
				properties?: Record<string, unknown>;
				required?: string[];
			};
			expect(wire.required ?? []).toEqual(piParams.required ?? []);
			// Recurrence this prevents: the MCP catalog advertising pi-only tool
			// names (`ast_grep_search's`, bare `module_report`) inside property
			// descriptions, which MCP does not serve; only the top-level text went
			// through the translator at first (#5438 review F2).
			for (const [key, value] of Object.entries(piParams.properties ?? {})) {
				const expected = { ...(value as Record<string, unknown>) };
				if (typeof expected.description === "string") {
					expected.description = translateGuidanceToolNames(
						expected.description,
						"mcp",
					);
				}
				expect(wire.properties?.[key], `${mcpName}.${key}`).toEqual(expected);
			}
			expect(
				Object.keys(wire.properties ?? {}).filter(
					(key) => !(key in (piParams.properties ?? {})),
				),
			).toEqual(["cwd"]);
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

	it("names no pi-only tool in the two property descriptions that cited one", () => {
		const properties = (name: string, key: string) => {
			const props = (mcpByName().get(name)?.inputSchema ?? {}) as {
				properties?: Record<string, { description?: string }>;
			};
			return props.properties?.[key]?.description ?? "";
		};
		const lang = properties("pilens_symbol_search", "lang");
		expect(lang).toContain("pilens_ast_grep_search's");
		expect(lang).not.toMatch(/(?<!pilens_)ast_grep_search/);
		const symbol = properties("pilens_read_symbol", "symbol");
		expect(symbol).toContain("pilens_module_report");
		expect(symbol).not.toMatch(/(?<!pilens_)module_report/);
	});

	it("classifies union spellings and refuses unknown schema forms (#5471)", () => {
		const alias = { type: "string", enum: ["a", "b"] };
		const indirect = () => ({ anyOf: [alias, { type: "null" }] });
		const binding = indirect();
		for (const schema of [
			{ oneOf: [alias, { type: "null" }] },
			indirect(),
			binding,
			{ anyOf: [{ type: "string" }, { type: "null" }], enum: ["a"] },
			{ type: ["string", "null"], const: "a" },
			{ anyOf: [{ type: "object", properties: { nested: alias } }] },
			// Review F1: an enum union reached only through array `items`.
			{ type: "array", items: indirect() },
			{ $ref: "#/unknown" },
			{ not: alias },
			null,
		])
			expect(unsafeStrictSchema(schema), JSON.stringify(schema)).toBe(true);
		for (const schema of [
			alias,
			{ type: "array", items: alias },
			{ anyOf: [{ type: "boolean" }, { type: "null" }] },
			{ type: "object", additionalProperties: false },
		])
			expect(unsafeStrictSchema(schema), JSON.stringify(schema)).toBe(false);
	});

	it("registered constrained tools have no enum or const unions after real pi-ai conversion (#5471)", () => {
		const carriers = piDefinitions.filter(carriesConstrainedSampling);
		expect(carriers.length).toBeGreaterThan(0);
		const hits = carriers
			.filter((definition) => {
				const tool = definition as SamplingTool;
				const strict = sampling.resolveJsonSchemaStrictSampling(tool, true);
				return (
					strict !== true ||
					unsafeStrictSchema(sampling.getJsonSchemaToolParameters(tool, strict))
				);
			})
			.map((definition) => definition.name);
		expect(hits).toEqual([]);
	});

	it("retains constrainedSampling on exactly the strict-safe tools", () => {
		const carriers = piDefinitions
			.filter(carriesConstrainedSampling)
			.map((definition) => definition.name)
			.sort();
		expect(carriers).toEqual(EXPECTED_CONSTRAINED_TOOLS);
		for (const definition of piDefinitions.filter(carriesConstrainedSampling)) {
			expect(definition.constrainedSampling, definition.name).toEqual(
				CONSTRAINED,
			);
		}
	});
});
