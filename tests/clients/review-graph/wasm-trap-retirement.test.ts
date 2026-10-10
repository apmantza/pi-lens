/**
 * #4010 through the real review-graph builder: two distinct python files whose
 * extraction traps once each retire the python grammar. Retirement counts
 * distinct inputs on their FIRST trap, because a per-edit surface parses fresh
 * bytes and never retries a file. The build still completes (no `build_failed`),
 * the process is not aborted, and the retirement is recorded once. The per-input
 * cases live in tests/clients/tree-sitter-wasm-trap.test.ts; this file drives
 * the process-wide shared client, so it has its own budget and trap state.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { getDegradationSummary } from "../../../clients/degradation-ledger.js";
import { loadWebTreeSitter } from "../../../clients/deps/web-tree-sitter.js";
import { FactStore } from "../../../clients/dispatch/fact-store.js";
import {
	buildOrUpdateGraph,
	clearReviewGraphWorkspaceCache,
	flushReviewGraphPersistsForTests,
} from "../../../clients/review-graph/builder.js";
import { logReviewGraph } from "../../../clients/review-graph-logger.js";
import { getSharedTreeSitterClient } from "../../../clients/tree-sitter-shared.js";
import { createTempFile, setupTestEnvironment } from "../test-utils.js";

vi.mock("../../../clients/lsp-document-symbols.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../../clients/lsp-document-symbols.js")
	>()),
	getOpenDocumentSymbols: vi.fn().mockResolvedValue(null),
}));
vi.mock("../../../clients/review-graph-logger.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../../clients/review-graph-logger.js")
	>()),
	logReviewGraph: vi.fn(),
	flushReviewGraphLogSync: vi.fn(),
}));

const { WebAssembly } = globalThis as unknown as {
	WebAssembly: { RuntimeError: new (message: string) => Error };
};

const cleanups: Array<() => void> = [];
afterEach(() => {
	vi.restoreAllMocks();
	flushReviewGraphPersistsForTests();
	clearReviewGraphWorkspaceCache();
	while (cleanups.length) cleanups.pop()?.();
});

function pythonProject(b: string): { tmpDir: string; files: string[] } {
	const env = setupTestEnvironment("pi-lens-wasm-retire-");
	cleanups.push(env.cleanup);
	return {
		tmpDir: env.tmpDir,
		files: [
			createTempFile(env.tmpDir, "a.py", "def alpha_fn():\n    return 1\n"),
			createTempFile(env.tmpDir, "b.py", b),
		],
	};
}

const count = (kind: string) =>
	getDegradationSummary().find((group) => group.kind === kind)?.count;

describe("review-graph build retires a grammar after two distinct trapping files (#4010)", () => {
	it("retires python at the second trapped file, completes both builds, and does not abort", async () => {
		const first = pythonProject("def trap_here_fn():\n    return 21\n");
		const second = pythonProject("def trap_here_fn():\n    return 22\n");
		const { Query } = await loadWebTreeSitter();
		const realMatches = Query.prototype.matches;
		vi.spyOn(Query.prototype, "matches").mockImplementation(function (
			this: InstanceType<typeof Query>,
			...args: Parameters<typeof realMatches>
		) {
			if (args[0].text.includes("trap_here")) {
				throw new WebAssembly.RuntimeError("table index is out of bounds");
			}
			return realMatches.apply(this, args);
		});

		await buildOrUpdateGraph(first.tmpDir, first.files, new FactStore());
		expect(count("grammar-blocked")).toBeUndefined();
		expect(getSharedTreeSitterClient()?.getLanguage("python")).not.toBeNull();
		await buildOrUpdateGraph(second.tmpDir, second.files, new FactStore());

		expect(count("grammar-blocked")).toBe(1);
		expect(count("wasm-abort")).toBeUndefined();
		expect(getSharedTreeSitterClient()?.getLanguage("python")).toBeNull();
		expect(
			vi
				.mocked(logReviewGraph)
				.mock.calls.filter(([entry]) => entry.phase === "build_failed"),
		).toEqual([]);
	});
});
