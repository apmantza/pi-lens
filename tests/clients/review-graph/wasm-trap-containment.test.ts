/**
 * #3605: a web-tree-sitter runtime trap while one file's symbols were being
 * extracted rejected the whole review-graph build (`build_failed`, reason
 * `table index is out of bounds`), and the per-edit cascade became
 * `cascade_indeterminate` / `error`. The trap is injected where production
 * raises it, `Query.prototype.matches` on the real web-tree-sitter module
 * (`queryMatches` in the symbol extractor), and the build is the real
 * `buildOrUpdateGraph` over real python files and real grammars.
 */
import * as fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDegradationSummary } from "../../../clients/degradation-ledger.js";
import { loadWebTreeSitter } from "../../../clients/deps/web-tree-sitter.js";
import { FactStore } from "../../../clients/dispatch/fact-store.js";
import { getOpenDocumentSymbols } from "../../../clients/lsp-document-symbols.js";
import {
	buildOrUpdateGraph,
	clearReviewGraphWorkspaceCache,
	flushReviewGraphPersistsForTests,
	getGraphBuildInfoForGraph,
	reviewGraphCachePath,
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

/**
 * `b` is b.py's source. A trap is charged to its input (language + content),
 * so each test that traps gives b.py its own content.
 */
function pythonProject(b = "def trap_here_fn():\n    return 2\n"): {
	tmpDir: string;
	files: string[];
} {
	const env = setupTestEnvironment("pi-lens-wasm-trap-");
	cleanups.push(env.cleanup);
	const files = [
		createTempFile(env.tmpDir, "a.py", "def alpha_fn():\n    return 1\n"),
		createTempFile(env.tmpDir, "b.py", b),
		createTempFile(env.tmpDir, "c.py", "def gamma_fn():\n    return 3\n"),
	];
	return { tmpDir: env.tmpDir, files };
}

/** Trap `Query.prototype.matches` on b.py's tree while `shouldTrap()` says so. */
async function trapQueryMatches(shouldTrap: () => boolean): Promise<void> {
	const { Query } = await loadWebTreeSitter();
	const realMatches = Query.prototype.matches;
	vi.spyOn(Query.prototype, "matches").mockImplementation(function (
		this: InstanceType<typeof Query>,
		...args: Parameters<typeof realMatches>
	) {
		if (args[0].text.includes("trap_here") && shouldTrap()) {
			throw new WebAssembly.RuntimeError("table index is out of bounds");
		}
		return realMatches.apply(this, args);
	});
}

function symbolNames(graph: Awaited<ReturnType<typeof buildOrUpdateGraph>>) {
	return [...graph.nodes.values()]
		.map((node) => node.symbolName)
		.filter((name): name is string => name !== undefined);
}

function wasmTrapCount(): number | undefined {
	return getDegradationSummary().find((group) => group.kind === "wasm-trap")
		?.count;
}

function buildFailedRows() {
	return vi
		.mocked(logReviewGraph)
		.mock.calls.map(([entry]) => entry)
		.filter((entry) => entry.phase === "build_failed");
}

describe("review-graph build contains a web-tree-sitter trap to its file (#3605)", () => {
	it("completes the build with the other files' symbols when one file's query traps", async () => {
		const { tmpDir, files } = pythonProject();
		const trappedBefore = wasmTrapCount() ?? 0;
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

		const graph = await buildOrUpdateGraph(tmpDir, files, new FactStore());

		const names = symbolNames(graph);
		expect(names).toContain("alpha_fn");
		expect(names).toContain("gamma_fn");
		expect(names).not.toContain("trap_here_fn");
		// The trapped file is NOT_PARSED-equivalent: zero tree-sitter symbols, so
		// the existing LSP fallback is consulted for it.
		expect(getOpenDocumentSymbols).toHaveBeenCalledWith(files[1]);
		// One trap, reported by both `queryMatches` and `parseFileAndUse`,
		// costs one unit of the budget.
		expect(wasmTrapCount()).toBe(trappedBefore + 1);
		expect(buildFailedRows()).toEqual([]);

		// #4010: grammar retirement counts DISTINCT inputs that trapped and have
		// not healed, for the whole process, and this file shares one client. The
		// trap above must heal before the next test traps another python file,
		// or that second file retires python for a reason it did not cause. The
		// trap is gone (mocks restored), so the next build re-extracts b.py and
		// its own success removes it from the grammar's set.
		vi.restoreAllMocks();
		const healed = await buildOrUpdateGraph(tmpDir, [], new FactStore());
		expect(symbolNames(healed)).toContain("trap_here_fn");
		expect(getSharedTreeSitterClient()?.getLanguage("python")).not.toBeNull();
	});

	it("classifies a trap that escapes to the build's catch as wasm-trap, not a build error", async () => {
		const { tmpDir, files } = pythonProject();
		const client = getSharedTreeSitterClient()!;
		// A trap from a path the per-file containment does not cover.
		vi.spyOn(client, "withParsedTree").mockRejectedValue(
			new WebAssembly.RuntimeError("memory access out of bounds"),
		);

		await expect(
			buildOrUpdateGraph(tmpDir, files, new FactStore()),
		).rejects.toThrow("memory access out of bounds");

		expect(buildFailedRows()).toEqual([
			expect.objectContaining({
				failureClass: "wasm-trap",
				reason: "memory access out of bounds",
			}),
		]);
	});

	it("classifies any other build rejection as error", async () => {
		const { tmpDir, files } = pythonProject();
		const client = getSharedTreeSitterClient()!;
		vi.spyOn(client, "withParsedTree").mockRejectedValue(
			new TypeError("extractor bug"),
		);

		await expect(
			buildOrUpdateGraph(tmpDir, files, new FactStore()),
		).rejects.toThrow("extractor bug");

		expect(buildFailedRows()).toEqual([
			expect.objectContaining({
				failureClass: "error",
				reason: "extractor bug",
			}),
		]);
	});
});

/**
 * #3605 review F2 and F3. Round 1 committed a trapped file as zero symbols,
 * and every later build in the process reused that entry while the file was
 * unchanged, so a one-off trap lost the file's symbols until someone edited
 * it; the cascade then gave its dependents a clean verdict. Every trap below
 * spends one unit of this file's process budget (`WASM_TRAP_BUDGET`, 3), and
 * the first `describe` spends one. Python is retired once two distinct python
 * inputs are trapped and unhealed at the same time (#4010), so the first
 * `describe` heals its input and the tests here trap one input at a time; the
 * persistent trap is last because a charged input never heals.
 */
describe("review graph after a contained trap (#3605 F2, F3)", () => {
	// Persist only when a test flushes, on the main thread.
	beforeEach(() => {
		process.env.PI_LENS_GRAPH_PERSIST_DEBOUNCE_MS = "3600000";
	});
	afterEach(() => {
		delete process.env.PI_LENS_GRAPH_PERSIST_DEBOUNCE_MS;
	});

	it("re-extracts a file a one-off trap cost on the next build", async () => {
		const { tmpDir, files } = pythonProject(
			"def trap_here_fn():\n    return 11\n",
		);
		let traps = 1;
		await trapQueryMatches(() => traps-- > 0);

		const trapped = await buildOrUpdateGraph(tmpDir, files, new FactStore());
		expect(symbolNames(trapped)).not.toContain("trap_here_fn");
		expect(getGraphBuildInfoForGraph(trapped).wasmTrappedFiles).toBe(1);

		// Another workspace neither counts nor stores the trapped file.
		const other = pythonProject("def beta_fn():\n    return 11\n");
		const clean = await buildOrUpdateGraph(
			other.tmpDir,
			other.files,
			new FactStore(),
		);
		expect(getGraphBuildInfoForGraph(clean).wasmTrappedFiles).toBeUndefined();
		const cleanAgain = await buildOrUpdateGraph(
			other.tmpDir,
			[],
			new FactStore(),
		);
		expect(getGraphBuildInfoForGraph(cleanAgain).mode).toBe("cached");

		const next = await buildOrUpdateGraph(tmpDir, [], new FactStore());
		expect(getGraphBuildInfoForGraph(next).mode).toBe("incremental");
		expect(symbolNames(next)).toContain("trap_here_fn");
		expect(getGraphBuildInfoForGraph(next).wasmTrappedFiles).toBeUndefined();

		// Healthy again, so no later build re-extracts it.
		const settled = await buildOrUpdateGraph(tmpDir, [], new FactStore());
		expect(getGraphBuildInfoForGraph(settled).mode).toBe("cached");
	});

	it("charges a file that traps every time, and retries it once per restart", async () => {
		const { tmpDir, files } = pythonProject(
			"def trap_here_fn():\n    return 12\n",
		);
		const trappedBefore = wasmTrapCount() ?? 0;
		await trapQueryMatches(() => true);

		await buildOrUpdateGraph(tmpDir, files, new FactStore());
		const retried = await buildOrUpdateGraph(tmpDir, [], new FactStore());
		expect(getGraphBuildInfoForGraph(retried).mode).toBe("incremental");
		// Charged by its second trap: the process does not re-extract it again.
		const charged = await buildOrUpdateGraph(tmpDir, [], new FactStore());
		expect(getGraphBuildInfoForGraph(charged).mode).toBe("cached");
		expect(getGraphBuildInfoForGraph(charged).wasmTrappedFiles).toBe(1);
		expect(symbolNames(charged)).not.toContain("trap_here_fn");
		// One unit of budget and one charge.
		expect(wasmTrapCount()).toBe(trappedBefore + 2);

		// A restart reads the persisted graph, which marks the charged file, so
		// the new process tries it again.
		flushReviewGraphPersistsForTests();
		clearReviewGraphWorkspaceCache();
		const restarted = await buildOrUpdateGraph(tmpDir, [], new FactStore());
		expect(getGraphBuildInfoForGraph(restarted).mode).toBe("incremental");
		expect(getGraphBuildInfoForGraph(restarted).wasmTrappedFiles).toBe(1);

		// So does a checkpoint a killed full build left behind.
		flushReviewGraphPersistsForTests();
		fs.rmSync(reviewGraphCachePath(tmpDir), { force: true });
		clearReviewGraphWorkspaceCache();
		process.env.PI_LENS_GRAPH_CHECKPOINT_TEST_STOP_AFTER = String(files.length);
		try {
			await expect(
				buildOrUpdateGraph(tmpDir, [], new FactStore()),
			).rejects.toThrow(/checkpoint_test_abort/);
		} finally {
			delete process.env.PI_LENS_GRAPH_CHECKPOINT_TEST_STOP_AFTER;
		}
		clearReviewGraphWorkspaceCache();
		await buildOrUpdateGraph(tmpDir, [], new FactStore());
		const resumedRows = vi
			.mocked(logReviewGraph)
			.mock.calls.map(([entry]) => entry)
			.filter((entry) => entry.phase === "checkpoint_resumed");
		expect(resumedRows).toEqual([
			expect.objectContaining({ reused: 2, stale: 1, remaining: 1 }),
		]);
	});
});
