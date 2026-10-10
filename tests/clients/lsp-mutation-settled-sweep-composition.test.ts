/**
 * #2465 — composition of #2449's observational mutation net with #2450's
 * `workspace/applyEdit` bridge fallback.
 *
 * Each PR is correct alone. Composed, two hand-off rules decide whether the
 * `agent_settled` sweep tells the truth about an LSP-applied write:
 *
 * 1. `recordMutationThroughSeam`'s `noteMutationHandled(filePath)` must sit
 *    OUTSIDE the `if (entry.deferAutofix !== false)` guard. The LSP bridge
 *    fallback passes `deferAutofix: false` — not because the write is
 *    unimportant, but because formatting an LSP-applied edit is not that
 *    seam's job. Fold the mark into the guard and every fallback write
 *    becomes drift no tool call explains.
 * 2. `bookkeepLspMutation`'s DIRECT (deps-threaded) branch must call
 *    `noteMutationHandled` itself. It bypasses the bridge entirely, so it
 *    inherits nothing from rule 1, and without it every `lsp_navigation`
 *    rename is reported as drift.
 *
 * Both are invisible to either PR's own tests: #2449's suite never drives an
 * LSP write, and #2450's suite never runs the sweep. So this file drives the
 * REAL production write path (`applyWorkspaceEdit`, which writes the bytes
 * AND bookkeeps through `recordLspMutation`) and then the REAL
 * `runObservedSettledSweep`, wired with the same `isRecordable` helper
 * `index.ts`'s `runObservedSettledSweepSafely` threads.
 *
 * ## Why every case carries a CONTROL file
 *
 * "The sweep reported zero drift" is worthless on its own — a sweep that
 * never ran, or one whose ledger was never seeded, reports zero for
 * everything. Each case therefore tracks a SECOND file that nothing recorded,
 * rewritten by the same amount in the same window, and asserts the same sweep
 * pass DID report it. Zero for the LSP file is only meaningful next to one for
 * the control.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";

import { CacheManager } from "../../clients/cache-manager.js";
import { isRecordableProjectPath } from "../../clients/file-utils.js";
import { applyWorkspaceEdit } from "../../clients/lsp/edits.js";
import type { LspMutationContext } from "../../clients/lsp-mutation.js";
import { registerMutationBridge } from "../../clients/mutation-bridge.js";
import {
	type ObservedReplayEntry,
	resetObservedMutationNet,
	runObservedSettledSweep,
} from "../../clients/observed-mutation.js";
import { countFileLines } from "../../clients/read-guard-tool-lines.js";
import { readChangesSince } from "../../clients/project-changes.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { setupTestEnvironment } from "./test-utils.js";

const FIXTURE_LINES = [
	"export const a = 1;",
	"export const b = 2;",
	"export const c = 3;",
	"export const d = 4;",
	"export const e = 5;",
	"export const f = 6;",
	"export const oldName = 7;",
	"export const h = 8;",
];

/**
 * The rename lands on line 7 (1-based), never line 1: a line-1 edit's real
 * range collides with the `{1,1}` whole-file default, which would let this
 * pass even with the range plumbing broken (#2450 review round 2, F2).
 */
const EDIT_LINE_0BASED = 6;
const OLD_NAME = "oldName";
const NEW_NAME = "renamedSymbolWithALongerName";

/**
 * The bridge is a process-global, first-wins singleton. Vitest's forks pool
 * gives this file its own process, so it is mounted ONCE over mutable holders
 * the individual cases swap — the same live-getter discipline `index.ts` uses.
 */
let liveRuntime: RuntimeCoordinator | undefined;
let liveCacheManager: CacheManager | undefined;
let liveRoot = "";

registerMutationBridge({
	getRuntime: () => liveRuntime as never,
	getCacheManager: () => liveCacheManager as never,
	getProjectRoot: () => liveRoot,
	getDispatchCwd: () => liveRoot,
	countFileLines,
	isRecordable: () => true,
	dbg: () => {},
});

beforeEach(() => {
	resetObservedMutationNet();
});

function writeFixture(filePath: string): void {
	fs.writeFileSync(filePath, `${FIXTURE_LINES.join("\n")}\n`, "utf-8");
}

/**
 * A real `workspace/applyEdit` payload: a symbol rename expressed as a text
 * edit, exactly the shape `lsp_navigation`'s rename flow and a server's own
 * `workspace/applyEdit` both produce. `applyWorkspaceEdit` writes these bytes
 * to disk itself, so the sweep afterwards is looking at a genuine change.
 */
function renameEdit(filePath: string): {
	changes: Record<string, unknown[]>;
} {
	return {
		changes: {
			[pathToFileURL(filePath).href]: [
				{
					range: {
						start: { line: EDIT_LINE_0BASED, character: 13 },
						end: {
							line: EDIT_LINE_0BASED,
							character: 13 + OLD_NAME.length,
						},
					},
					newText: NEW_NAME,
				},
			],
		},
	};
}

function sweepRecorder(): {
	record: (entry: ObservedReplayEntry) => boolean;
	entries: ObservedReplayEntry[];
} {
	const entries: ObservedReplayEntry[] = [];
	return {
		entries,
		record: (entry) => {
			entries.push(entry);
			return true;
		},
	};
}

interface Scenario {
	root: string;
	lspFile: string;
	controlFile: string;
	runtime: RuntimeCoordinator;
	cacheManager: CacheManager;
	tracked: () => string[];
}

function makeScenario(root: string, sessionId: string): Scenario {
	const lspFile = path.join(root, "renamed.ts");
	const controlFile = path.join(root, "control.ts");
	writeFixture(lspFile);
	writeFixture(controlFile);
	const runtime = new RuntimeCoordinator();
	runtime.projectRoot = root;
	runtime.setTelemetryIdentity({ sessionId });
	runtime.beginTurn();
	return {
		root,
		lspFile,
		controlFile,
		runtime,
		cacheManager: new CacheManager(false),
		tracked: () => [lspFile, controlFile],
	};
}

/**
 * Seed the ledger. A file pi-lens has never seen has no baseline, so its first
 * drift only seeds and is never reported — the documented limitation in
 * #2430's third acceptance criterion. Both files must therefore be baselined
 * BEFORE the write, or the whole comparison is vacuous.
 */
async function seedLedger(scenario: Scenario): Promise<void> {
	const seed = sweepRecorder();
	const first = await runObservedSettledSweep({
		turnIndex: 1,
		getTrackedPaths: scenario.tracked,
		record: seed.record,
		isRecordable: (candidate) =>
			isRecordableProjectPath(candidate, scenario.root),
	});
	expect(first.drifted).toEqual([]);
	expect(seed.entries).toEqual([]);
}

/** Run the settle exactly as `index.ts` wires it, and report what it saw. */
async function settle(
	scenario: Scenario,
): Promise<{ drifted: string[]; unverifiable: string[]; replayed: number }> {
	const sink = sweepRecorder();
	const result = await runObservedSettledSweep({
		turnIndex: 2,
		getTrackedPaths: scenario.tracked,
		record: sink.record,
		isRecordable: (candidate) =>
			isRecordableProjectPath(candidate, scenario.root),
	});
	return {
		drifted: result.drifted,
		unverifiable: result.unverifiable,
		replayed: result.replayed,
	};
}

/** `drifted`/`unverifiable` are normalized map keys; compare on the basename. */
function names(paths: string[]): string[] {
	return paths.map((entry) => path.basename(entry)).sort();
}

describe("#2465 — the settled sweep does not report an LSP-applied write as drift", () => {
	it("marks a net-zero multi-edit batch authorship unknown (#4210 N4)", async () => {
		const env = setupTestEnvironment("pi-lens-4210-lsp-net-zero-");
		try {
			const filePath = path.join(env.tmpDir, "net-zero.ts");
			fs.writeFileSync(
				filePath,
				Array.from({ length: 60 }, (_, index) => `line${index + 1}`).join(
					"\n",
				) + "\n",
			);
			const applied = await applyWorkspaceEdit(
				{
					changes: {
						[pathToFileURL(filePath).href]: [
							{
								range: {
									start: { line: 2, character: 0 },
									end: { line: 2, character: 0 },
								},
								newText: "inserted\n",
							},
							{
								range: {
									start: { line: 50, character: 0 },
									end: { line: 51, character: 0 },
								},
								newText: "",
							},
						],
					},
				},
				env.tmpDir,
			);
			expect(applied.fileDetails[0].authorshipUnknown).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("reports ZERO drift for a DIRECT-path rename (runtime/cacheManager threaded), while still reporting the untouched control", async () => {
		const env = setupTestEnvironment("pi-lens-2465-direct-");
		try {
			const scenario = makeScenario(env.tmpDir, "s-2465-direct");
			await seedLedger(scenario);

			// The direct branch: a context carrying runtime AND cacheManager,
			// exactly how tools/lsp-navigation.ts builds it for a rename. This
			// branch never touches the mutation bridge, so it must call
			// noteMutationHandled itself.
			const directContext: LspMutationContext = {
				cwd: scenario.root,
				correlationId: "sweep-direct",
				tool: "lsp_navigation:rename",
				source: "lsp-rename",
				runtime: scenario.runtime as never,
				cacheManager: scenario.cacheManager,
				readGuard: scenario.runtime.readGuard,
				emitSummary: false,
			};
			const applied = await applyWorkspaceEdit(
				renameEdit(scenario.lspFile),
				scenario.root,
				{ mutationContext: directContext },
			);
			// `applied.files` carries the URI-normalized spelling
			// (`uriToPath` → `normalizeFilePath`, which case-folds on win32), so
			// compare on the basename — the same reason `names()` exists.
			expect(names(applied.files)).toEqual(["renamed.ts"]);
			expect(fs.readFileSync(scenario.lspFile, "utf-8")).toContain(NEW_NAME);
			const turnState = scenario.cacheManager.readTurnState(scenario.root);
			const renamedEntry = Object.entries(turnState.files ?? {}).find(([key]) =>
				key.endsWith("renamed.ts"),
			)?.[1];
			expect(renamedEntry?.modifiedRanges).toEqual([
				{ start: EDIT_LINE_0BASED + 1, end: EDIT_LINE_0BASED + 1 },
			]);
			expect(readChangesSince(scenario.root, 0)).toMatchObject([
				{
					filePath: scenario.lspFile,
					changedRange: {
						start: EDIT_LINE_0BASED + 1,
						end: EDIT_LINE_0BASED + 1,
					},
				},
			]);

			// Something else moved the control file — nothing recorded it, so the
			// sweep SHOULD report it. This is what makes the zero above mean
			// something.
			fs.writeFileSync(
				scenario.controlFile,
				`${FIXTURE_LINES.join("\n")}\nexport const drifted = 9;\n`,
				"utf-8",
			);

			const seen = await settle(scenario);
			expect(names(seen.drifted)).toEqual(["control.ts"]);
			expect(names(seen.unverifiable)).toEqual([]);
			expect(seen.replayed).toBe(1);
		} finally {
			env.cleanup();
		}
	});

	it("keeps the resource-rename bookkeeping sentinel while authorship stays unknown (#4210 LSP receipt)", async () => {
		const env = setupTestEnvironment("pi-lens-4210-lsp-resource-rename-");
		try {
			const source = path.join(env.tmpDir, "source.ts");
			const destination = path.join(env.tmpDir, "destination.ts");
			fs.writeFileSync(source, "export const source = 1;\n", "utf-8");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setTelemetryIdentity({ sessionId: "s-4210-resource-rename" });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);
			await applyWorkspaceEdit(
				{
					documentChanges: [
						{
							kind: "rename",
							oldUri: pathToFileURL(source).href,
							newUri: pathToFileURL(destination).href,
						},
					],
				},
				env.tmpDir,
				{
					mutationContext: {
						cwd: env.tmpDir,
						correlationId: "resource-rename",
						tool: "lsp_navigation:rename",
						source: "lsp-rename",
						runtime: runtime as never,
						cacheManager,
						readGuard: runtime.readGuard,
						emitSummary: false,
					},
				},
			);
			const entry = Object.entries(
				cacheManager.readTurnState(env.tmpDir).files ?? {},
			).find(([key]) => key.endsWith("destination.ts"))?.[1];
			expect(entry?.modifiedRanges).toEqual([{ start: 1, end: 1 }]);
			expect(
				readChangesSince(env.tmpDir, 0).filter(
					(change) => change.filePath === destination,
				),
			).toMatchObject([
				{ filePath: destination, changedRange: { start: 1, end: 1 } },
			]);
		} finally {
			env.cleanup();
		}
	});

	it("reports ZERO drift for a BRIDGE-FALLBACK applyEdit (deferAutofix:false), while still reporting the untouched control", async () => {
		const env = setupTestEnvironment("pi-lens-2465-bridge-");
		try {
			const scenario = makeScenario(env.tmpDir, "s-2465-bridge");
			liveRuntime = scenario.runtime;
			liveCacheManager = scenario.cacheManager;
			liveRoot = scenario.root;
			await seedLedger(scenario);

			// The fallback branch: NEITHER runtime NOR cacheManager on the
			// context — the shape clients/lsp/client.ts synthesizes for a
			// server-initiated workspace/applyEdit — driven against the REAL
			// registered bridge. bookkeepLspMutation sends this through the
			// bridge with deferAutofix:false, so the handled mark must not be
			// gated on that flag.
			const fallbackContext: LspMutationContext = {
				cwd: scenario.root,
				correlationId: "sweep-bridge",
				tool: "lsp_navigation:executeCommand",
				source: "lsp-execute-command",
				emitSummary: false,
			};
			const applied = await applyWorkspaceEdit(
				renameEdit(scenario.lspFile),
				scenario.root,
				{ mutationContext: fallbackContext },
			);
			// `applied.files` carries the URI-normalized spelling
			// (`uriToPath` → `normalizeFilePath`, which case-folds on win32), so
			// compare on the basename — the same reason `names()` exists.
			expect(names(applied.files)).toEqual(["renamed.ts"]);
			expect(fs.readFileSync(scenario.lspFile, "utf-8")).toContain(NEW_NAME);

			fs.writeFileSync(
				scenario.controlFile,
				`${FIXTURE_LINES.join("\n")}\nexport const drifted = 9;\n`,
				"utf-8",
			);

			const seen = await settle(scenario);
			expect(names(seen.drifted)).toEqual(["control.ts"]);
			expect(names(seen.unverifiable)).toEqual([]);
			expect(seen.replayed).toBe(1);
		} finally {
			liveRuntime = undefined;
			liveCacheManager = undefined;
			liveRoot = "";
			env.cleanup();
		}
	});
});
