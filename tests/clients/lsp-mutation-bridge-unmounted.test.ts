/**
 * #2450 review round 2 (F4) — the MCP server process shape.
 *
 * `mcp/server.ts` builds `lsp_navigation` with NO `mutationDeps` (`clients/lsp-mutation.ts`'s
 * `LspMutationContext` carries neither `runtime` nor `cacheManager` there), and
 * that process never calls `registerMutationBridge` (that only happens inside
 * pi's own in-process extension activation, `index.ts`). Before this round,
 * `getMutationBridge()` returning `undefined` there was a silent no-op: the
 * write landed on disk, but its bookkeeping (read-guard stamp, turn-state
 * entry, change-log receipt) vanished with no trace at all.
 *
 * This file deliberately registers NO bridge (unlike its sibling
 * `mutation-bridge.test.ts`/`lsp-mutation-bridge-equivalence.test.ts`, which
 * mount one), so `getMutationBridge()` is guaranteed `undefined` here —
 * vitest's default per-file worker isolation gives this file its own
 * `globalThis`, so an earlier test file's registration cannot leak in.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { getMutationBridge } from "../../clients/mutation-bridge.js";
import {
	resetLspMutationNoBridgeDbgLatch,
	type LspMutationContext,
	recordLspMutation,
} from "../../clients/lsp-mutation.js";
import { removeTempDirSync } from "./test-utils.js";

function resultFor(filePath: string) {
	return [
		{
			descriptions: [],
			files: [filePath],
			operationTotal: 1,
			appliedOperationTotal: 1,
			appliedOperationIndexes: [0],
			operationCounts: { textEdits: 1, create: 0, rename: 0, delete: 0 },
			fileDetails: [
				{ filePath, range: { start: 1, end: 1 }, importsChanged: false },
			],
		},
	];
}

describe("lsp-mutation bridge fallback with no bridge mounted (#2450 review round 2, F4)", () => {
	it("dbg's the drop and records a bounded once-per-session degradation, instead of a silent no-op", () => {
		expect(getMutationBridge()).toBeUndefined();
		resetDegradationLedger();
		resetLspMutationNoBridgeDbgLatch();

		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-lsp-nomedge-"),
		);
		try {
			const fileA = path.join(tmpDir, "a.ts");
			const fileB = path.join(tmpDir, "b.ts");
			fs.writeFileSync(fileA, "hello world\n");
			fs.writeFileSync(fileB, "hello world\n");

			const dbgMessages: string[] = [];
			const context: LspMutationContext = {
				cwd: tmpDir,
				correlationId: "no-bridge-mounted",
				tool: "lsp_navigation:executeCommand",
				source: "lsp-execute-command",
				emitSummary: false,
				dbg: (message) => dbgMessages.push(message),
			};

			// No runtime/cacheManager on the context — forces the bridge
			// fallback, which finds no bridge mounted.
			recordLspMutation(context, { results: resultFor(fileA) });

			expect(
				dbgMessages.some((message) => message.includes("bridge unavailable")),
			).toBe(true);

			const summaryAfterFirst = getDegradationSummary();
			const groupAfterFirst = summaryAfterFirst.find(
				(group) => group.kind === "lsp-mutation-bridge-unmounted",
			);
			expect(groupAfterFirst).toBeDefined();
			expect(groupAfterFirst!.count).toBe(1);

			// A SECOND LSP-applied edit, DIFFERENT tool value (round 3 minor: the
			// degradation-ledger `subject` used to be `context.tool`, which
			// varies per LSP operation — this second call deliberately uses a
			// different one, "...rename" vs the first call's "...executeCommand"
			// — so a subject that still varied per tool would show up here as a
			// SECOND durable record, not a bounded count of 1). Also proves the
			// dbg line is gated once per SESSION, not once per (tool, file): the
			// second call touches a different file (`fileB`) but must not add a
			// second "bridge unavailable" dbg message.
			const secondContext: LspMutationContext = {
				...context,
				tool: "lsp_navigation:rename",
				correlationId: "no-bridge-mounted-2",
			};
			recordLspMutation(secondContext, { results: resultFor(fileB) });
			const summaryAfterSecond = getDegradationSummary();
			const groupAfterSecond = summaryAfterSecond.find(
				(group) => group.kind === "lsp-mutation-bridge-unmounted",
			);
			expect(groupAfterSecond!.count).toBe(1);
			expect(
				dbgMessages.filter((message) => message.includes("bridge unavailable"))
					.length,
			).toBe(1);
		} finally {
			removeTempDirSync(tmpDir);
		}
	});
});
