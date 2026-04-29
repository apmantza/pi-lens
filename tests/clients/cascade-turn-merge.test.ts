import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { CacheManager } from "../../clients/cache-manager.js";
import type { CascadeResult } from "../../clients/cascade-types.js";
import type { Diagnostic } from "../../clients/dispatch/types.js";
import { consumeTurnEndFindings } from "../../clients/runtime-context.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { handleTurnEnd } from "../../clients/runtime-turn.js";
import { setupTestEnvironment } from "./test-utils.js";

function diagnostic(filePath: string, message: string, line = 1): Diagnostic {
	return {
		id: `lsp:test:${line}`,
		message,
		filePath,
		line,
		column: 1,
		severity: "error",
		semantic: "blocking",
		tool: "lsp",
		rule: "cascade:test",
	};
}

function cascade(
	primary: string,
	neighbor: string,
	message: string,
): CascadeResult {
	const neighborBase = path.basename(neighbor);
	return {
		filePath: primary,
		impact: {
			filePath: primary,
			changedSymbols: [],
			directImporters: [neighbor],
			directCallers: [],
			neighborFiles: [neighbor],
			riskFlags: [],
		},
		neighbors: [
			{
				filePath: neighbor,
				reason: "imports",
				diagnostics: [diagnostic(neighbor, message)],
				lspTouched: false,
			},
		],
		formatted: `Cascade errors in 1 dependent file\n${neighborBase}: ${message}`,
	};
}

describe("cascade turn-end merge", () => {
	it("deduplicates cascade diagnostics by neighbor file with last writer winning", async () => {
		const env = setupTestEnvironment("cascade-turn-merge-");
		try {
			const runtime = new RuntimeCoordinator();
			const cacheManager = new CacheManager(false);
			const primaryA = path.join(env.tmpDir, "a.ts");
			const primaryB = path.join(env.tmpDir, "b.ts");
			const sharedNeighbor = path.join(env.tmpDir, "shared.ts");
			fs.writeFileSync(primaryA, "export const a = 1;\n");
			fs.writeFileSync(primaryB, "export const b = 1;\n");
			fs.writeFileSync(sharedNeighbor, "export const shared = 1;\n");

			cacheManager.addModifiedRange(
				primaryA,
				{ start: 1, end: 1 },
				false,
				env.tmpDir,
			);
			cacheManager.addModifiedRange(
				primaryB,
				{ start: 1, end: 1 },
				false,
				env.tmpDir,
			);

			runtime.appendCascadeResult(
				cascade(primaryA, sharedNeighbor, "old error"),
			);
			runtime.appendCascadeResult(
				cascade(primaryB, sharedNeighbor, "new error"),
			);

			await handleTurnEnd({
				ctxCwd: env.tmpDir,
				getFlag: () => false,
				dbg: () => {},
				runtime,
				cacheManager,
				jscpdClient: { ensureAvailable: async () => false },
				knipClient: { ensureAvailable: async () => false },
				depChecker: { ensureAvailable: async () => false },
				testRunnerClient: { getTestRunTarget: () => null },
				resetLSPService: () => {},
				resetFormatService: () => {},
			} as any);

			const findings = consumeTurnEndFindings(cacheManager, env.tmpDir);
			const content = findings?.messages[0]?.content ?? "";
			expect(content).toContain("Cascade errors in 1 dependent file");
			expect(content).toContain("shared.ts");
			expect(content).toContain("new error");
			expect(content).not.toContain("old error");
		} finally {
			env.cleanup();
		}
	});
});
