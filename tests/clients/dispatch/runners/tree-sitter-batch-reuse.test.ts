/**
 * #5260: the tree-sitter query batch compiled again on the second dispatch.
 *
 * Recurrence this pins (red on origin/master f11775b35): the first dispatch in
 * a project misses the on-disk RuleCache and feeds the client the loader's
 * full rule objects (description, tags, category, ...); every later dispatch
 * hits the cache and feeds the client the cache's projection, which drops
 * those fields. The client keyed its batch on `JSON.stringify(queryDefs)`, so
 * the same TypeScript rules got two identities and the second dispatch
 * recompiled the batch (about 430 ms of a 972 ms dispatch).
 *
 * Drives the real runner against one project, counting the client's real
 * batch builds; only the review-graph diff is stubbed, as the other
 * real-runner suites do.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import treeSitterRunner from "../../../../clients/dispatch/runners/tree-sitter.js";

const { recordEntitySnapshotDiffMock } = vi.hoisted(() => ({
	recordEntitySnapshotDiffMock: vi.fn(() => ({
		added: [] as string[],
		removed: [] as string[],
		modified: [] as string[],
	})),
}));

vi.mock(
	"../../../../clients/review-graph/service.js",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../../../../clients/review-graph/service.js")
		>()),
		recordEntitySnapshotDiff: recordEntitySnapshotDiffMock,
	}),
);

import {
	_resetSharedTreeSitterClientForTests,
	getSharedTreeSitterClient,
} from "../../../../clients/tree-sitter-shared.js";
import {
	assertGrammarAvailable,
	makeRealRunnerEnv,
} from "../../../support/real-runner-ctx.js";

const SOURCE = "export function f(a: number): number {\n\treturn a + 1;\n}\n";

beforeAll(async () => {
	await assertGrammarAvailable("typescript");
});

afterEach(() => {
	_resetSharedTreeSitterClientForTests();
});

describe("tree-sitter batch reuse across dispatches (#5260)", () => {
	it("builds the TypeScript rule batch once for the first, second and third dispatch", async () => {
		_resetSharedTreeSitterClientForTests();
		const client = getSharedTreeSitterClient();
		if (!client) throw new Error("tree-sitter unavailable");
		const buildBatch = vi.spyOn(
			client as unknown as {
				compileQueryBatchOnce: (...args: unknown[]) => Promise<unknown>;
			},
			"compileQueryBatchOnce",
		);
		const env = makeRealRunnerEnv();
		try {
			const first = env.addFile("src/first.ts", SOURCE);
			const second = env.addFile("src/second.ts", `${SOURCE}// 2\n`);
			const third = env.addFile("src/third.ts", `${SOURCE}// 3\n`);

			// The first run misses the rule cache (loader objects); the rest hit it.
			await treeSitterRunner.run(first.ctx);
			expect(buildBatch).toHaveBeenCalledTimes(1);
			await treeSitterRunner.run(second.ctx);
			await treeSitterRunner.run(third.ctx);
			expect(buildBatch).toHaveBeenCalledTimes(1);
		} finally {
			env.cleanup();
		}
	});
});
