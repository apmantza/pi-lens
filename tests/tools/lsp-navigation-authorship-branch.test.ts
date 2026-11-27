/**
 * #5405: an `lsp_navigation` rename records write authorship under the tool
 * call's id, and `/tree`, `/fork` and reload re-import that authorship against
 * the session branch, whose `toolResult` ids are read through
 * `sanitizeCorrelationId`. pi-ai's OpenAI Responses ids carry a pipe
 * (`call_a|fc_b`), so a record stored under the raw host id matched no branch
 * id and was dropped on import: the model then had to re-read a file it had
 * just renamed through before the next edit.
 *
 * The tool, its apply, the LSP mutation writer, the read guard and pi's real
 * `SessionManager` are the real ones; the `LSPService` is a double at that
 * one boundary, as in tests/tools/lsp-navigation-rename-staleness.test.ts.
 *
 * State table (id spelling at the writer x what the branch holds):
 *
 *  | host call id    | branch toolResult id | expected import       |
 *  |-----------------|----------------------|-----------------------|
 *  | call_a|fc_b     | call_a|fc_b           | imported, edit allowed |
 *  | toolu_01ABC     | toolu_01ABC          | imported, edit allowed |
 *  | (not on branch) | other                | dropped, edit blocked  |
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
	SessionManager,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CacheManager } from "../../clients/cache-manager.js";
import { setHostFileMutationQueueLoader } from "../../clients/file-mutation-queue.js";
import { createReadGuard } from "../../clients/read-guard.js";
import { branchToolResultIds } from "../../clients/read-guard-branch.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";
import { installLspService } from "../support/lsp-service-seam.js";
import { setupTestEnvironment } from "../clients/test-utils.js";

const lsp = vi.hoisted(() => ({ service: undefined as unknown }));
import { createLspNavigationTool } from "../../tools/lsp-navigation.js";

let env: ReturnType<typeof setupTestEnvironment>;
let file: string;
let previousDataDir: string | undefined;

beforeEach(() => {
	env = setupTestEnvironment("pi-lens-lsp-nav-authorship-");
	previousDataDir = process.env.PILENS_DATA_DIR;
	process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
	file = path.join(env.tmpDir, "a.ts");
	fs.writeFileSync(file, "const = 1;\nline2\nline3\n");
	setHostFileMutationQueueLoader(async () => ({ withFileMutationQueue }));
});

afterEach(() => {
	lsp.service = undefined;
	vi.restoreAllMocks();
	setHostFileMutationQueueLoader(undefined);
	if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
	else process.env.PILENS_DATA_DIR = previousDataDir;
	env.cleanup();
});

/** Runs an applied `lsp_navigation rename` under the host call id `callId`. */
async function renameAs(callId: string): Promise<RuntimeCoordinator> {
	const runtime = new RuntimeCoordinator();
	runtime.projectRoot = env.tmpDir;
	runtime.beginTurn();
	lsp.service = installLspService(
		makeLspServiceDouble({
			supportsLSP: () => true,
			hasLSP: async () => true,
			rename: async () => ({
				changes: {
					[pathToFileURL(file).href]: [
						{
							range: {
								start: { line: 0, character: 0 },
								end: { line: 0, character: 5 },
							},
							newText: "let",
						},
					],
				},
			}),
		}),
	);
	const tool = createLspNavigationTool((flag) => flag === "lens-lsp", {
		runtime,
		cacheManager: new CacheManager(false),
		readGuard: runtime.readGuard,
	});
	await tool.execute(
		callId,
		{
			operation: "rename",
			path: file,
			line: 1,
			character: 1,
			newName: "let",
			apply: true,
		},
		new AbortController().signal,
		null,
		{ cwd: env.tmpDir },
	);
	expect(fs.readFileSync(file, "utf8")).toBe("let = 1;\nline2\nline3\n");
	return runtime;
}

/** A session whose branch holds `toolResult` entries stored verbatim by pi. */
function branchWith(...resultIds: string[]): SessionManager {
	const sm = SessionManager.inMemory(env.tmpDir);
	sm.appendMessage({ role: "user", content: "p1", timestamp: 1 } as never);
	for (const toolCallId of resultIds)
		sm.appendMessage({
			role: "toolResult",
			toolCallId,
			toolName: "lsp_navigation",
			content: [],
			isError: false,
			timestamp: Date.now(),
		} as never);
	return sm;
}

/** `/tree`, `/fork` and reload: a fresh guard imports against the branch. */
function importOnto(runtime: RuntimeCoordinator, sm: SessionManager) {
	const payload = JSON.parse(
		JSON.stringify(runtime.readGuard.exportAuthorship()),
	);
	const resumed = createReadGuard("resumed-5405");
	const result = resumed.importAuthorship(payload, branchToolResultIds(sm).ids);
	return { resumed, result };
}

/** Rename under `callId`, move the branch to hold `callId`'s result, import. */
async function importedAfterRename(callId: string) {
	const runtime = await renameAs(callId);
	return importOnto(runtime, branchWith(callId));
}

describe("#5405 lsp_navigation authorship survives branch import", () => {
	it("imports the authorship of a rename whose host id carries a pipe, and allows the next edit", async () => {
		const { resumed, result } = await importedAfterRename("call_a|fc_b");

		// Pre-fix: {imported: 0, dropped: 1} and the edit below is blocked
		// "Edit without read": an extra read after /tree or /fork.
		expect(result).toEqual({ imported: 1, dropped: 0 });
		expect(resumed.checkEdit(file, [1, 1]).action).toBe("allow");
	});

	it("imports the authorship of a rename whose host id needs no sanitizing, and allows the next edit", async () => {
		const { resumed, result } = await importedAfterRename("toolu_01ABC");

		expect(result).toEqual({ imported: 1, dropped: 0 });
		expect(resumed.checkEdit(file, [1, 1]).action).toBe("allow");
	});

	it("drops the authorship when the rename's result is not on the branch", async () => {
		const runtime = await renameAs("call_a|fc_b");

		const { resumed, result } = importOnto(runtime, branchWith("call_other"));

		expect(result).toEqual({ imported: 0, dropped: 1 });
		expect(resumed.checkEdit(file, [1, 1]).action).toBe("block");
	});
});
