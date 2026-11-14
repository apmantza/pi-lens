// flake-shape: in-process-mock — clients/pipeline stands in for per-file dispatch (it spawns every linter), so the case decides the blocker axis; the handler, store and re-measure are real.
/**
 * #5087 S2: when `tool_result` adds the complexity delta, and when it holds
 * it back.
 *
 * The delta is secondary output: it waits behind blockers (INLINE-CONTRACT.txt
 * rule 2), honours `--no-complexity`, and a held-back edit leaves the file's
 * stored table alone, so the next clean edit still reports the change.
 * `runPipeline` is the one double (it spawns every linter); the handler, the
 * coordinator, its store and the re-measure are real. The fixture repository
 * has no default-branch commit, so the session's first table stands in for main.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../clients/pipeline.js", () => ({
	runPipeline: vi.fn(),
}));

import { CacheManager } from "../../clients/cache-manager.js";
import { ComplexityClient } from "../../clients/complexity-client.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import {
	captureComplexityBaseline,
	complexityBaselineKey,
} from "../../clients/metrics/complexity-baseline.js";
import { runPipeline } from "../../clients/pipeline.js";
import { getSharedTreeSitterClient } from "../../clients/tree-sitter-shared.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import {
	clearLastAnalyzedStateCache,
	handleToolResult,
} from "../../clients/runtime-tool-result.js";
import { installLspServiceDouble } from "../support/lsp-service-seam.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

const CLEAN = {
	output: "",
	hasBlockers: false,
	isError: false,
	fileModified: false,
	checkedClean: false,
};
const BLOCKING = {
	...CLEAN,
	output: "🔴 STOP — 1 issue(s) must be fixed:\n  L1: Debugger statement",
	hasBlockers: true,
};

/** A function of cyclomatic complexity `1 + branches`. */
function fn(name: string, branches: number): string {
	const body = Array.from(
		{ length: branches },
		(_, i) => `\tif (x === ${i}) return ${i};`,
	).join("\n");
	return `export function ${name}(x: number): number {\n${body}\n\treturn -1;\n}\n`;
}

let env: ReturnType<typeof setupTestEnvironment>;
let runtime: RuntimeCoordinator;
let filePath: string;

beforeEach(async () => {
	await installLspServiceDouble();
	env = setupTestEnvironment("pi-lens-5087-tool-result-");
	// V5: the empty .git marker is no repository boundary, so with TMPDIR
	// inside a checkout Git found that checkout's main. Write the layout of an
	// unborn repository (HEAD, objects, refs) so Git stops here and finds no
	// default-branch commit, without spawning `git init`.
	const gitDir = path.join(env.tmpDir, ".git");
	fs.mkdirSync(path.join(gitDir, "objects"), { recursive: true });
	fs.mkdirSync(path.join(gitDir, "refs", "heads"), { recursive: true });
	fs.writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n");
	runtime = new RuntimeCoordinator();
	runtime.projectRoot = env.tmpDir;
	filePath = createTempFile(env.tmpDir, "svc.ts", fn("handle", 3));
});

afterEach(() => {
	env.cleanup();
});

/**
 * The `tool_call` of the file's first touch: the table of the bytes on disk is
 * stored, then the file changes to `next`, as the edit tool does.
 */
async function touchThenWrite(next: string): Promise<void> {
	const analysis = await new ComplexityClient().analyzeFile(filePath);
	runtime.complexityBaselines.set(
		complexityBaselineKey(filePath),
		captureComplexityBaseline(analysis?.measuredFunctions),
	);
	fs.writeFileSync(filePath, next);
}

async function edit(
	result: Record<string, unknown>,
	flags: string[] = [],
	escape?: AbortController,
): Promise<string> {
	vi.mocked(runPipeline).mockReset();
	vi.mocked(runPipeline).mockResolvedValue(result as never);
	// A repeat of the same bytes is otherwise skipped as already analysed.
	runtime.beginTurn();
	clearLastAnalyzedStateCache();
	const out = (await handleToolResult({
		event: {
			toolName: "edit",
			input: { path: filePath },
			content: [{ type: "text", text: "ok" }],
		},
		getFlag: (name: string) => {
			// The handler reads this flag on the line before the delta's bound, so
			// Esc lands exactly there: the bound starts already fired, after the
			// pipeline's own bounds have passed.
			if (name === "no-complexity") escape?.abort();
			return flags.includes(name);
		},
		...(escape === undefined ? {} : { signal: escape.signal }),
		dbg: () => {},
		runtime,
		cacheManager: new CacheManager(false),
		resetLSPService: () => {},
		readGuard: runtime.readGuard,
		agentBehaviorRecord: () => [],
		formatBehaviorWarnings: () => "",
	} as never)) as { content?: Array<{ text?: string }> } | undefined;
	return (out?.content ?? []).map((c) => c.text ?? "").join("\n");
}

describe("#5087 the tool_result complexity delta", () => {
	it("adds the delta to a clean edit", async () => {
		await touchThenWrite(fn("handle", 17));
		expect(await edit(CLEAN)).toContain(
			"⚠ complexity vs session start: handle cc 4→18 (≥15)",
		);
	});

	// A file with no stored entry (evicted, or first written by a bash command)
	// has no `last`: the edit stores its table and names nothing, even a
	// function past the threshold that it did not touch.
	it("names nothing for a file with no stored entry, then judges the next edit", async () => {
		fs.writeFileSync(filePath, fn("handle", 17));
		expect(await edit(CLEAN)).not.toContain("complexity vs");
		expect(
			runtime.complexityBaselines.has(complexityBaselineKey(filePath)),
		).toBe(true);
		fs.writeFileSync(filePath, fn("handle", 18));
		expect(await edit(CLEAN)).toContain("handle cc 18→19 (≥15)");
	});

	it("waits behind blockers, and keeps the stored table for the held-back edit", async () => {
		await touchThenWrite(fn("handle", 17));
		const stored = runtime.complexityBaselines.get(
			complexityBaselineKey(filePath),
		);
		const text = await edit(BLOCKING);
		expect(text).toContain("must be fixed");
		expect(text).not.toContain("complexity vs");
		expect(
			runtime.complexityBaselines.get(complexityBaselineKey(filePath)),
		).toBe(stored);
		// The next clean edit still reports the function.
		expect(await edit(CLEAN)).toContain("handle cc 4→18 (≥15)");
	});

	it("records a delta that throws, and keeps the edit's own output", async () => {
		resetDegradationLedger();
		vi.spyOn(runtime.complexityBaselines, "get").mockImplementation(() => {
			throw new Error("store failed");
		});
		const text = await edit({ ...CLEAN, output: "✓ checked" });
		expect(text).toContain("✓ checked");
		expect(text).not.toContain("complexity vs");
		expect(
			getDegradationSummary().filter(
				(entry) => entry.kind === "complexity-delta-failed",
			),
		).toHaveLength(1);
	});

	// Recurrence (#5550 r1, B2): the delta runs as `bounded((signal) =>
	// adviseOnEdit({... signal}))`, and replacing that `signal` with `undefined`
	// left every test green: the abandoned run, past a fired bound, then judged
	// the edit and stored its table late. The caller's abort fires the bound
	// before the run starts; the run must see the bound's abort, so it reads no
	// stored baseline and writes nothing. The sentinel is the run's own parse:
	// its continuation is queued before the test's, so by the time the test
	// resumes the run has either returned or reached the baseline store.
	it("hands the abandoned delta the bound's abort, so it stores nothing late (#5550)", async () => {
		await touchThenWrite(fn("handle", 17));
		const key = complexityBaselineKey(filePath);
		const stored = runtime.complexityBaselines.get(key);
		const client = getSharedTreeSitterClient();
		if (client === null) throw new Error("no shared tree-sitter client");
		const parses: Array<Promise<unknown>> = [];
		const withParsedTree = client.withParsedTree.bind(client);
		vi.spyOn(client, "withParsedTree").mockImplementation(((
			...args: Parameters<typeof withParsedTree>
		) => {
			const parse = withParsedTree(...args);
			parses.push(parse);
			return parse;
		}) as typeof client.withParsedTree);
		const read = vi.spyOn(runtime.complexityBaselines, "get");
		const set = vi.spyOn(runtime.complexityBaselines, "set");

		const text = await edit(CLEAN, [], new AbortController());

		expect(text).not.toContain("complexity vs");
		// The run is abandoned, not stopped: it still reaches its parse.
		await vi.waitFor(() => expect(parses).toHaveLength(1));
		await parses[0];
		expect(read).not.toHaveBeenCalled();
		expect(set).not.toHaveBeenCalled();
		expect(runtime.complexityBaselines.get(key)).toBe(stored);
	});

	it("honours --no-complexity", async () => {
		await touchThenWrite(fn("handle", 17));
		expect(await edit(CLEAN, ["no-complexity"])).not.toContain("complexity vs");
	});
});
