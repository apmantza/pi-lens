/**
 * #3780 (survivor audit of #3706). Recurrence: replacing `if (entry)` in the
 * import provider's static-import loop by `true` pushed the null that
 * `parseStaticImport` returns for an `import x = require("x")` statement, and
 * `review-graph/builder.ts` then read `entry.source` off null in its imports
 * loop, so one such file threw out of the whole graph build. The provider-level
 * pin lives in tests/clients/dispatch/import-facts.test.ts; this one drives the
 * real graph build over the real providers and real tree-sitter.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { FactStore } from "../../../clients/dispatch/fact-store.js";
import "../../../clients/dispatch/integration.js"; // registers providers
import { normalizeMapKey } from "../../../clients/path-utils.js";
import {
	buildOrUpdateGraph,
	clearReviewGraphWorkspaceCache,
} from "../../../clients/review-graph/builder.js";
import { setupTestEnvironment } from "../test-utils.js";

describe("review graph over an `import x = require()` file (#3780)", () => {
	it("builds the graph and records the file with its other imports", async () => {
		const env = setupTestEnvironment("pi-lens-3780-require-clause-");
		try {
			const file = path.join(env.tmpDir, "a.ts");
			fs.writeFileSync(
				file,
				'import fs = require("fs");\nimport { b } from "./b.js";\nexport const a = b;\n',
			);
			fs.writeFileSync(path.join(env.tmpDir, "b.ts"), "export const b = 1;\n");
			clearReviewGraphWorkspaceCache();

			const graph = await buildOrUpdateGraph(
				env.tmpDir,
				[file],
				new FactStore("3780-require-clause"),
			);

			const normalized = normalizeMapKey(file);
			expect(graph.nodes.has(`file:${normalized}`)).toBe(true);
			expect(
				graph.edges
					.filter(
						(edge) =>
							edge.from === `file:${normalized}` && edge.kind === "imports",
					)
					.map((edge) => edge.to),
			).toEqual([`file:${normalizeMapKey(path.join(env.tmpDir, "b.ts"))}`]);
		} finally {
			env.cleanup();
		}
	});
});
