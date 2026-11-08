/**
 * #5087 S2: when `tool_result` adds the complexity delta, and when it holds
 * it back.
 *
 * The delta is secondary output: it waits behind blockers (INLINE-CONTRACT.txt
 * rule 2), honours `--no-complexity`, and a held-back edit leaves the file's
 * stored table alone, so the next clean edit still reports the change.
 * `runPipeline` is the one double (it spawns every linter); the handler, the
 * coordinator, its store and the re-measure are real. The fixture is no
 * repository, so the session's first table stands in for main.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../clients/pipeline.js", () => ({
	runPipeline: vi.fn(),
}));

import { CacheManager } from "../../clients/cache-manager.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { complexityBaselineKey } from "../../clients/metrics/complexity-baseline.js";
import { runPipeline } from "../../clients/pipeline.js";
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
	runtime = new RuntimeCoordinator();
	runtime.projectRoot = env.tmpDir;
	filePath = createTempFile(env.tmpDir, "svc.ts", fn("handle", 17));
});

afterEach(() => {
	env.cleanup();
});

async function edit(
	result: Record<string, unknown>,
	flags: string[] = [],
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
		getFlag: (name: string) => flags.includes(name),
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
		expect(await edit(CLEAN)).toContain(
			"⚠ complexity vs session start: handle cc new→18 (≥15)",
		);
	});

	it("waits behind blockers, and keeps no table for the held-back edit", async () => {
		const text = await edit(BLOCKING);
		expect(text).toContain("must be fixed");
		expect(text).not.toContain("complexity vs");
		expect(
			runtime.complexityBaselines.has(complexityBaselineKey(filePath)),
		).toBe(false);
		// The next clean edit still reports the function.
		expect(await edit(CLEAN)).toContain("handle cc new→18 (≥15)");
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

	it("honours --no-complexity", async () => {
		expect(await edit(CLEAN, ["no-complexity"])).not.toContain("complexity vs");
	});
});
