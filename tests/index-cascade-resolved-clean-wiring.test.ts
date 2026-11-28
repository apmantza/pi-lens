import { afterEach, describe, expect, it } from "vitest";
import { endTurn } from "./support/pi-session-commit-gate.js";
import { piSessionFixture, startPiSession } from "./support/pi-session.js";
import type { Diagnostic } from "../clients/dispatch/types.js";
import { normalizeMapKey } from "../clients/path-utils.js";

/**
 * #4487 wiring guard at the index.ts seam: the late clean answer for a
 * neighbour must clear that neighbour's pending cascade errors.
 *
 * Recurrence: a neighbour the agent fixed between turns, whose clean publish
 * arrived only after the cascade stopped waiting, kept its old errors on
 * every later turn_end's unresolved line. turn_end's peek and the quiet
 * window's reconcile hand that clean answer to whatever `onResolvedClean`
 * index.ts registered; the record forgets the entry only if index.ts wires
 * `forgetCascadePendingNeighbor` there. The cascade-tier tests drive their
 * own callback, so only an activated extension shows the wiring.
 *
 * Tier 2, inline-factory mode (#4937 L6): the extension runs in a real pi
 * session on THIS test graph's modules, so the cascade registries the case
 * seeds and reads below are the ones the extension's wiring writes to. On the
 * path load they would be a second copy and the assertion would see nothing.
 */

const fixture = piSessionFixture();

afterEach(async () => {
	const { resetCascadePendingNeighbors } =
		await import("../clients/cascade-format.js");
	const { _resetOutstandingCascadeTouchesForTests } =
		await import("../clients/lsp/cascade-tier.js");
	resetCascadePendingNeighbors();
	_resetOutstandingCascadeTouchesForTests();
});

describe(
	"index cascade resolved-clean wiring (#4487)",
	{ timeout: 30_000 },
	() => {
		it("a late clean answer clears the neighbour's pending cascade errors", async () => {
			const handle = await startPiSession({
				root: fixture.root,
				responses: [endTurn()],
				inlineFactory: async () => (await import("../index.js")).default,
			});
			expect(handle.errors).toEqual([]);

			const { listCascadePendingNeighbors, recordDeliveredCascadeNeighbor } =
				await import("../clients/cascade-format.js");
			const { peekOutstandingCascadeTouches, recordOutstandingCascadeTouch } =
				await import("../clients/lsp/cascade-tier.js");

			const neighbor = "/repo/src/b.ts";
			const now = Date.now();
			const error = {
				id: "typescript:2322",
				message: "Type 'string' is not assignable to type 'number'.",
				filePath: neighbor,
				line: 2,
				column: 1,
				severity: "error",
				semantic: "blocking",
				tool: "lsp",
			} as Diagnostic;
			recordDeliveredCascadeNeighbor(neighbor, [error], 1, now - 300);

			// The server the touch went to has since published the file clean.
			const client = {
				serverId: "typescript",
				getAllDiagnostics: () =>
					new Map([[normalizeMapKey(neighbor), { diags: [], ts: now - 100 }]]),
			};
			recordOutstandingCascadeTouch({
				filePath: neighbor,
				serverId: "typescript",
				client: new WeakRef(client),
				touchedAt: now - 200,
			});
			expect(listCascadePendingNeighbors().map((e) => e.filePath)).toEqual([
				neighbor,
			]);

			peekOutstandingCascadeTouches();

			expect(listCascadePendingNeighbors()).toEqual([]);
		});

		// Recurrence (#5804 sweep, #5790 review F2's shape): the touch went to the
		// primary server only, so its late clean publish speaks for the rows that
		// server raised. A row an auxiliary server raised was dropped with them,
		// and no later turn end named it.
		it("a late clean answer from the primary keeps the pending rows an auxiliary raised", async () => {
			const handle = await startPiSession({
				root: fixture.root,
				responses: [endTurn()],
				inlineFactory: async () => (await import("../index.js")).default,
			});
			expect(handle.errors).toEqual([]);

			const { listCascadePendingNeighbors, recordDeliveredCascadeNeighbor } =
				await import("../clients/cascade-format.js");
			const { peekOutstandingCascadeTouches, recordOutstandingCascadeTouch } =
				await import("../clients/lsp/cascade-tier.js");

			const neighbor = "/repo/src/b.ts";
			const now = Date.now();
			const row = (tool: string, line: number): Diagnostic =>
				({
					id: `:`,
					message: `finding from `,
					filePath: neighbor,
					line,
					column: 1,
					severity: "error",
					semantic: "blocking",
					tool,
				}) as Diagnostic;
			recordDeliveredCascadeNeighbor(
				neighbor,
				[row("lsp", 2), row("opengrep", 3)],
				1,
				now - 300,
			);
			const client = {
				serverId: "typescript",
				getAllDiagnostics: () =>
					new Map([[normalizeMapKey(neighbor), { diags: [], ts: now - 100 }]]),
			};
			recordOutstandingCascadeTouch({
				filePath: neighbor,
				serverId: "typescript",
				client: new WeakRef(client),
				touchedAt: now - 200,
			});

			peekOutstandingCascadeTouches();

			expect(
				listCascadePendingNeighbors().flatMap((e) =>
					e.errors.map((error) => error.tool),
				),
			).toEqual(["opengrep"]);
		});
	},
);
