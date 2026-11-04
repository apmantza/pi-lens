/**
 * #2504 — the turn-state ownership gate.
 *
 * A persisted OWNERLESS `.pi-lens/turn-state.json` (the resting shape written
 * by `clearTurnState` before this fix) was read back by the NEXT session as
 * "owned", so the stale-owner eviction in `runtime-turn.ts` never fired and a
 * model-switch turn with zero tool calls adopted 154 historical paths as
 * "modified this turn" — firing the test runner and the LSP warning sweep and
 * holding the terminal for 191 s.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CacheManager } from "../../clients/cache-manager.js";
import { getProjectDataDir } from "../../clients/file-utils.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { handleTurnEnd } from "../../clients/runtime-turn.js";
import { setupTestEnvironment } from "./test-utils.js";

const EMPTY_KNIP_RESULT = {
	success: true,
	issues: [],
	unusedExports: [],
	unusedFiles: [],
	unusedDeps: [],
	unlistedDeps: [],
	summary: "skipped",
};

let env: { tmpDir: string; cleanup: () => void };

beforeEach(() => {
	env = setupTestEnvironment("pi-lens-2504-gate-");
});

afterEach(() => {
	env.cleanup();
});

function writeTurnStateFile(cwd: string, state: unknown): void {
	const dir = getProjectDataDir(cwd);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, "turn-state.json"),
		JSON.stringify(state, null, 2),
	);
}

function staleOwnerlessState(fileKeys: string[], ageMs: number): unknown {
	const lastEdit = new Date(Date.now() - ageMs).toISOString();
	const files: Record<string, unknown> = {};
	for (const key of fileKeys) {
		files[key] = {
			modifiedRanges: [{ start: 1, end: 10 }],
			importsChanged: true,
			lastEdit,
		};
	}
	return { files, turnCycles: 0, maxCycles: 3, lastUpdated: lastEdit };
}

describe("#2504 AC1 — getTurnStateAccess on an ownerless persisted state", () => {
	it("reports 'available' when lastUpdated predates the current session start", () => {
		writeTurnStateFile(
			env.tmpDir,
			staleOwnerlessState(["src/a.ts", "src/b.ts"], 2 * 60 * 60 * 1000),
		);
		const cacheManager = new CacheManager(false);
		expect(
			cacheManager.getTurnStateAccess(env.tmpDir, {
				kind: "pi",
				id: "lens-fresh-session",
				sessionStartedAt: Date.now(),
			}),
		).toBe("available");
	});

	it("still reports 'owned' for an ownerless state this session just wrote", () => {
		const sessionStartedAt = Date.now() - 60_000;
		writeTurnStateFile(env.tmpDir, staleOwnerlessState(["src/a.ts"], 0));
		const cacheManager = new CacheManager(false);
		expect(
			cacheManager.getTurnStateAccess(env.tmpDir, {
				kind: "pi",
				id: "lens-current",
				sessionStartedAt,
			}),
		).toBe("owned");
	});
});

// Recurrence this prevents (#4907): the turn-state copy read a pid above 2^31-1
// as "owner gone" (`process.kill` throws ERR_INVALID_ARG_TYPE), so a live
// worklist went to the next writer. The seam reads it alive.
describe("#4907 — a turn-state owner pid above 2^31-1 reads alive", () => {
	it("keeps the worklist away from the next writer", () => {
		const lastEdit = new Date().toISOString();
		writeTurnStateFile(env.tmpDir, {
			files: {
				"src/a.ts": {
					modifiedRanges: [{ start: 1, end: 3 }],
					importsChanged: false,
					lastEdit,
				},
			},
			turnCycles: 0,
			maxCycles: 3,
			lastUpdated: lastEdit,
			sessionId: "lens-other",
			owner: {
				kind: "pi",
				id: "lens-other",
				pid: 3_000_000_000,
				lastSeen: lastEdit,
			},
		});
		expect(
			new CacheManager(false).getTurnStateAccess(env.tmpDir, {
				kind: "pi",
				id: "lens-next",
			}),
		).toBe("foreign-live");
	});
});

describe("#2504 AC1 — clearTurnState stamps the clearing owner", () => {
	it("records kind/id/pid so the next session can judge liveness", () => {
		const cacheManager = new CacheManager(false);
		cacheManager.addModifiedRange(
			path.join(env.tmpDir, "src", "a.ts"),
			{ start: 1, end: 4 },
			false,
			env.tmpDir,
			"lens-session-1",
		);
		expect(
			cacheManager.clearTurnState(env.tmpDir, {
				kind: "pi",
				id: "lens-session-1",
			}),
		).toBe(true);
		const state = cacheManager.readTurnState(env.tmpDir);
		expect(Object.keys(state.files)).toEqual([]);
		expect(state.owner).toBeDefined();
		expect(state.owner?.kind).toBe("pi");
		expect(state.owner?.id).toBe("lens-session-1");
		expect(state.owner?.pid).toBe(process.pid);
	});

	it("leaves an empty stamped worklist claimable by a different writer", () => {
		const cacheManager = new CacheManager(false);
		cacheManager.clearTurnState(env.tmpDir, { kind: "pi", id: "lens-pi" });
		// An MCP writer in another process must still be able to register work
		// against an EMPTY worklist — an empty list has nothing to protect.
		expect(
			cacheManager.getTurnStateAccess(env.tmpDir, {
				kind: "mcp",
				id: "mcp-999",
			}),
		).not.toBe("foreign-live");
		cacheManager.addModifiedRange(
			path.join(env.tmpDir, "src", "m.ts"),
			{ start: 1, end: 2 },
			false,
			env.tmpDir,
			"mcp-999",
			"mcp",
		);
		expect(Object.keys(cacheManager.readTurnState(env.tmpDir).files)).toEqual([
			"src/m.ts",
		]);
	});
});

describe("#2504 AC1 — addModifiedRange rejects paths outside cwd", () => {
	it("drops an absolute path from outside the project root", () => {
		const cacheManager = new CacheManager(false);
		const outside = path.join(path.dirname(env.tmpDir), "elsewhere", "x.md");
		cacheManager.addModifiedRange(
			outside,
			{ start: 1, end: 3 },
			false,
			env.tmpDir,
			"lens-session-1",
		);
		expect(Object.keys(cacheManager.readTurnState(env.tmpDir).files)).toEqual(
			[],
		);
	});

	it("drops a ../ escape", () => {
		const cacheManager = new CacheManager(false);
		cacheManager.addModifiedRange(
			"../outside.ts",
			{ start: 1, end: 3 },
			false,
			env.tmpDir,
			"lens-session-1",
		);
		expect(Object.keys(cacheManager.readTurnState(env.tmpDir).files)).toEqual(
			[],
		);
	});

	it("does not let a rejected foreign path claim ownership of the worklist", () => {
		const cacheManager = new CacheManager(false);
		const outside = path.join(path.dirname(env.tmpDir), "elsewhere", "x.md");
		cacheManager.addModifiedRange(
			outside,
			{ start: 1, end: 3 },
			false,
			env.tmpDir,
			"lens-session-1",
		);
		expect(cacheManager.readTurnState(env.tmpDir).owner).toBeUndefined();
	});

	it("still records an in-project path recorded in one separator form and read in the other", () => {
		const cacheManager = new CacheManager(false);
		// Read-guard path-key rule: record with the native separator, read back
		// through the opposite form.
		cacheManager.addModifiedRange(
			path.join(env.tmpDir, "src", "deep", "a.ts"),
			{ start: 2, end: 5 },
			false,
			env.tmpDir,
			"lens-session-1",
		);
		const state = cacheManager.readTurnState(env.tmpDir);
		expect(Object.keys(state.files)).toEqual(["src/deep/a.ts"]);
		expect(
			cacheManager.getTurnFileState(
				`${env.tmpDir.replace(/\\/g, "/")}/src/deep/a.ts`,
				env.tmpDir,
			),
		).toBeDefined();
		expect(
			cacheManager.getTurnFileState(
				path.join(env.tmpDir, "src", "deep", "a.ts"),
				env.tmpDir,
			),
		).toBeDefined();
	});
});

describe("#2504 AC1 — a zero-tool-call turn does no work", () => {
	it("evicts the stale ownerless worklist and runs neither the test runner nor the warning sweep", async () => {
		// Two historical entries, one of them a path that no longer exists —
		// exactly the reported shape.
		writeTurnStateFile(
			env.tmpDir,
			staleOwnerlessState(
				["src/deleted.ts", "src/also-deleted.ts"],
				3 * 60 * 60 * 1000,
			),
		);
		const runtime = new RuntimeCoordinator();
		const cacheManager = new CacheManager(false);
		const getTestRunTarget = vi.fn(() => null);

		await handleTurnEnd({
			ctxCwd: env.tmpDir,
			// Warning sweep on; LSP code actions off so the sweep needs no server.
			getFlag: (name: string) => name === "lens-actionable-warnings",
			dbg: () => {},
			runtime,
			cacheManager,
			knipClient: {
				ensureAvailable: async () => false,
				analyze: async () => EMPTY_KNIP_RESULT,
			},
			deadCodeClients: [],
			depChecker: { ensureAvailable: async () => false },
			testRunnerClient: { getTestRunTarget },
			resetLSPService: () => {},
			resetFormatService: () => {},
			// biome-ignore lint/suspicious/noExplicitAny: minimal turn_end deps
		} as any);

		expect(Object.keys(cacheManager.readTurnState(env.tmpDir).files)).toEqual(
			[],
		);
		expect(getTestRunTarget).not.toHaveBeenCalled();
		expect(
			cacheManager.readCache("actionable-warnings", env.tmpDir),
		).toBeNull();
	});
});
