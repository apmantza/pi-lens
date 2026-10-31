// flake-shape: service-double — #5040: a language server cannot be spawned in this lane (the nightly cascade lane runs jdtls live); the review graph, the import resolver, the cascade compute and the neighbour selection are real, and only the server's answer is a double
/**
 * #5040: a Java edit reaches a real cascade.
 *
 * The recurrence: the nightly cascade lane's first jdtls run (tool-smoke run
 * 41027095385) answered every warm touch and the production cascade still
 * returned `skipReason: "non_code"` for every attempt. The review graph already
 * resolved Java imports (`resolveJava` in clients/review-graph/import-resolvers.ts)
 * and built `imports` edges for them, but `CASCADE_GRAPH_KINDS` listed no
 * `java`, so `computeCascadeForFile` ended in its `unsupported_graph_kind`
 * branch before asking for a single importer. A Java agent edit that broke an
 * importer was never told. Every other cascade unit test mocks the graph
 * (`cascade-compute.test.ts`), so none could see a language the graph models
 * but the cascade skips.
 *
 * This drives the real graph over the lane's own Java fixture, so the importer
 * edges come from the production resolver, not from a hand-shaped impact.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestEnvironment } from "./test-utils.js";
import { installLspServiceDouble } from "../support/lsp-service-seam.js";

const FIXTURE = path.resolve(__dirname, "../fixtures/lsp-cascade/java");

const javaError = (message: string) => ({
	severity: 1 as const,
	message,
	range: {
		start: { line: 5, character: 36 },
		end: { line: 5, character: 39 },
	},
	code: "16777216",
	source: "Java",
});

describe("computeCascadeForFile over a real Java import graph (#5040)", () => {
	beforeEach(async () => {
		vi.resetModules();
		const { resetDispatchBaselines } =
			await import("../../clients/dispatch/integration.js");
		resetDispatchBaselines();
	}, 30_000);

	it("cascades a broken Java exporter to the importers the graph resolved, instead of skipping with non_code", async () => {
		const env = setupTestEnvironment("cascade-java-graph-");
		try {
			fs.cpSync(FIXTURE, env.tmpDir, { recursive: true });
			const lib = path.join(env.tmpDir, "src", "lib", "Lib.java");
			const b = path.join(env.tmpDir, "src", "app", "B.java");
			const c = path.join(env.tmpDir, "src", "app", "C.java");
			const touched: string[] = [];
			await installLspServiceDouble({
				// The server's answer for an importer of the broken export.
				touchFile: vi.fn(async (file: string) => {
					touched.push(file);
					return {
						diags: [
							javaError(
								"The method foo(String) in the type Lib is not applicable",
							),
						],
					};
				}),
			});

			const { computeCascadeForFile } =
				await import("../../clients/dispatch/integration.js");
			fs.writeFileSync(
				lib,
				fs
					.readFileSync(lib, "utf8")
					.replace("int foo(int x)", "String foo(String x)"),
			);
			const run = await computeCascadeForFile(lib, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 1,
				projectRoot: env.tmpDir,
			});

			expect(run.skipReason).toBeUndefined();
			expect(touched.map((p) => path.resolve(p)).sort()).toEqual(
				[b, c].map((p) => path.resolve(p)).sort(),
			);
			expect(
				(run.observedNeighborPaths ?? []).map((p) => path.resolve(p)).sort(),
			).toEqual([b, c].map((p) => path.resolve(p)).sort());
			const formatted = run.result?.formatted ?? "";
			expect(formatted).toContain('<diagnostics file="src/app/B.java"');
			expect(formatted).toContain('<diagnostics file="src/app/C.java"');
		} finally {
			env.cleanup();
		}
	}, 60_000);
});
