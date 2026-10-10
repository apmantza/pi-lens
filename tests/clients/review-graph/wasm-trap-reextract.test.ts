/**
 * #3605 review F2: a file a one-off web-tree-sitter trap cost must be
 * re-extracted by the next build, whichever path that build takes. Round 1
 * committed the trapped file as zero symbols, and the seq fast path, a restart
 * from the persisted graph and a resumed checkpoint all reused it while the
 * file was unchanged. The in-memory path is pinned in
 * wasm-trap-containment.test.ts. These cases live in their own file because
 * each trap spends one unit of the process budget (`WASM_TRAP_BUDGET`, 3),
 * and vitest gives each file a fresh process.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadWebTreeSitter } from "../../../clients/deps/web-tree-sitter.js";
import { FactStore } from "../../../clients/dispatch/fact-store.js";
import {
	buildOrUpdateGraph,
	clearGraphCache,
	clearReviewGraphWorkspaceCache,
	flushReviewGraphPersistsForTests,
	getGraphBuildInfoForGraph,
} from "../../../clients/review-graph/builder.js";
import { createTempFile, setupTestEnvironment } from "../test-utils.js";

vi.mock("../../../clients/lsp-document-symbols.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../../clients/lsp-document-symbols.js")
	>()),
	getOpenDocumentSymbols: vi.fn().mockResolvedValue(null),
}));

const { WebAssembly } = globalThis as unknown as {
	WebAssembly: { RuntimeError: new (message: string) => Error };
};

const cleanups: Array<() => void> = [];
beforeEach(() => {
	// Persist only when a test flushes.
	process.env.PI_LENS_GRAPH_PERSIST_DEBOUNCE_MS = "3600000";
});
afterEach(() => {
	vi.restoreAllMocks();
	delete process.env.PI_LENS_GRAPH_CHECKPOINT_TEST_STOP_AFTER;
	delete process.env.PI_LENS_GRAPH_PERSIST_DEBOUNCE_MS;
	flushReviewGraphPersistsForTests();
	clearReviewGraphWorkspaceCache();
	clearGraphCache();
	while (cleanups.length) cleanups.pop()?.();
});

/**
 * A trap is charged to its input, so each test gives b.py its own content.
 * `restartRoot` below is a Go project: grammar retirement (#4010)
 * counts distinct trapped inputs per language, so two trapped python files
 * alive at once would retire python and nothing could be re-extracted. A
 * second language keeps the "other workspace's trapped file is not pulled
 * in" assertion without a second live python trap.
 */
function project(
	tag: number,
	lang: "py" | "go" = "py",
): { tmpDir: string; files: string[] } {
	const env = setupTestEnvironment("pi-lens-wasm-reextract-");
	cleanups.push(env.cleanup);
	const files = [
		createTempFile(env.tmpDir, `a.${lang}`, source(lang, "alpha_fn", 1)),
		createTempFile(env.tmpDir, `b.${lang}`, source(lang, "trap_here_fn", tag)),
		createTempFile(env.tmpDir, `c.${lang}`, source(lang, "gamma_fn", 3)),
	];
	return { tmpDir: env.tmpDir, files };
}

function source(lang: "py" | "go", name: string, n: number): string {
	return lang === "py"
		? `def ${name}():\n    return ${n}\n`
		: `package main\n\nfunc ${name}() int {\n\treturn ${n}\n}\n`;
}

/** Trap a b.py symbol query at the production throw site while `shouldTrap()`. */
async function trapWhile(shouldTrap: () => boolean): Promise<void> {
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

describe("a file a one-off trap cost is re-extracted (#3605 F2)", () => {
	it("re-extracts it on a seq fast-path build that names no change, and after a restart", async () => {
		// Two workspaces, each with a one-off trapped file: `seqRoot` is built
		// with a seq hint, `restartRoot` is retried after a restart.
		const seqRoot = project(22);
		const restartRoot = project(21, "go");
		const seqHint = {
			projectSeq: () => 0,
			getFilesChangedSince: (): string[] => [],
		};
		let traps = 2;
		await trapWhile(() => traps-- > 0);
		const trappedFirst = await buildOrUpdateGraph(
			restartRoot.tmpDir,
			restartRoot.files,
			new FactStore(),
		);
		// The go file really trapped, so the restart check below is not vacuous.
		expect(symbolNames(trappedFirst)).not.toContain("trap_here_fn");
		await buildOrUpdateGraph(
			seqRoot.tmpDir,
			seqRoot.files,
			new FactStore(),
			seqHint,
		);

		const next = await buildOrUpdateGraph(
			seqRoot.tmpDir,
			[],
			new FactStore(),
			seqHint,
		);
		expect(getGraphBuildInfoForGraph(next).mode).toBe("seq-fastpath");
		expect(symbolNames(next)).toContain("trap_here_fn");
		// The other workspace's trapped file is not pulled into this graph.
		expect(next.fileNodes.size).toBe(seqRoot.files.length);

		flushReviewGraphPersistsForTests();
		clearReviewGraphWorkspaceCache();
		const restarted = await buildOrUpdateGraph(
			restartRoot.tmpDir,
			[],
			new FactStore(),
		);
		expect(getGraphBuildInfoForGraph(restarted).mode).toBe("incremental");
		expect(symbolNames(restarted)).toContain("trap_here_fn");
	});

	it("re-extracts it when a killed build resumes from its checkpoint", async () => {
		const { tmpDir, files } = project(23);
		let traps = 1;
		await trapWhile(() => traps-- > 0);
		process.env.PI_LENS_GRAPH_CHECKPOINT_TEST_STOP_AFTER = String(files.length);
		await expect(
			buildOrUpdateGraph(tmpDir, files, new FactStore()),
		).rejects.toThrow(/checkpoint_test_abort/);

		delete process.env.PI_LENS_GRAPH_CHECKPOINT_TEST_STOP_AFTER;
		clearReviewGraphWorkspaceCache();
		clearGraphCache();
		const resumed = await buildOrUpdateGraph(tmpDir, [], new FactStore());

		expect(symbolNames(resumed)).toContain("trap_here_fn");
	});
});
