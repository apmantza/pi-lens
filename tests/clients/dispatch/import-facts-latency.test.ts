/**
 * #3780 (survivor audit of #3706): the `call_graph_facts` latency record the
 * import provider emits for a file with dynamic imports or re-exports had no
 * assertion, so 18 mutants of its emit condition, type, metadata and counts
 * stayed green. `logLatency` no-ops in test mode, so the module is mocked with
 * the original spread in (governed by vi-mock-export-sweep), the same pattern
 * as `tests/source-filter-skip-observability.test.ts`. The provider itself runs
 * on real web-tree-sitter; only the record sink is collected.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LatencyEntry } from "../../../clients/latency-logger.js";

const latencyEntries = vi.hoisted(() => [] as LatencyEntry[]);
vi.mock("../../../clients/latency-logger.js", async (importOriginal) => ({
	...(await importOriginal()),
	logLatency: (entry: LatencyEntry) => latencyEntries.push(entry),
}));

import { FactStore } from "../../../clients/dispatch/fact-store.js";
import { importFactProvider } from "../../../clients/dispatch/facts/import-facts.js";

beforeEach(() => {
	latencyEntries.length = 0;
});

/** The call_graph_facts records one provider run emitted for `filePath`. */
async function callGraphRecords(content: string): Promise<LatencyEntry[]> {
	const filePath = "/tmp/latency-facts.ts";
	const facts = new FactStore();
	facts.setFileFact(filePath, "file.content", content);
	await importFactProvider.run({ filePath } as never, facts);
	return latencyEntries.filter(
		(entry) => (entry.type as string) === "call_graph_facts",
	);
}

describe("importFactProvider call_graph_facts record (#3780)", () => {
	// Recurrence: the emit condition (`||` to `&&`, either side to false, `>` to
	// `>=`/`<=`, the whole test to a constant) was never observed, so a file with
	// only one kind of evidence could silently stop being measured, or every
	// plain file could start logging.
	it.each([
		["a file with only static imports", `import { a } from "./a.js";\n`],
		["a file with no imports at all", `export const a = 1;\n`],
	])("emits no record for %s", async (_label, content) => {
		expect(await callGraphRecords(content)).toEqual([]);
	});

	it("emits one record for a file with only dynamic imports", async () => {
		const records = await callGraphRecords(
			`const m = await import("./d.js");\n`,
		);
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({
			type: "call_graph_facts",
			filePath: "/tmp/latency-facts.ts",
			durationMs: 0,
			metadata: {
				moduleType: "unknown",
				staticImports: 0,
				dynamicImports: 1,
				reexports: 0,
				starReexports: 0,
			},
		});
	});

	it("emits one record for a file with only a re-export", async () => {
		const records = await callGraphRecords(`export * from "./a.js";\n`);
		expect(records).toHaveLength(1);
		expect(records[0].metadata).toEqual({
			moduleType: "esm",
			staticImports: 0,
			dynamicImports: 0,
			reexports: 1,
			starReexports: 1,
		});
	});

	// Recurrence: the count expressions (`imports.length - dynamicCount`,
	// `dynamicCount++`, the star filter) were replaced without a red, so the
	// telemetry that validates the graph's coverage could report wrong numbers.
	it("counts static, dynamic and require entries apart", async () => {
		const records = await callGraphRecords(
			`import { a } from "./a.js";\nconst r = require("./r.js");\nconst m = await import("./d.js");\n`,
		);
		expect(records).toHaveLength(1);
		expect(records[0].metadata).toEqual({
			moduleType: "esm",
			staticImports: 1,
			dynamicImports: 2,
			reexports: 0,
			starReexports: 0,
		});
	});

	it("counts star re-exports apart from named ones", async () => {
		const records = await callGraphRecords(
			`export * from "./a.js";\nexport { x } from "./b.js";\nexport { y } from "./c.js";\n`,
		);
		expect(records).toHaveLength(1);
		expect(records[0].metadata).toEqual({
			moduleType: "esm",
			staticImports: 0,
			dynamicImports: 0,
			reexports: 3,
			starReexports: 1,
		});
	});
});
