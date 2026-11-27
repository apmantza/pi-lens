/**
 * #5550 r1 (B2): the turn_end persistent re-verify gets the bound's abort.
 *
 * Recurrence: `handleTurnEnd` runs the pass as
 * `bounded((signal) => runPersistentReverify({... signal}))`, and replacing
 * that `signal` with `undefined` left every test green: a turn Esc'd mid-pass
 * abandoned a re-verify whose own touch bound still ran to its wall budget
 * (`bounded()`'s thunk form is what is supposed to cancel it). The pass runs
 * through the real `handleTurnEnd`, the real `bounded()` and the real
 * persistent-reverify touch bound; the LSP service is the one double (a host
 * process boundary) and reads the signal the way `navRequest` does.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ActionableWarningsReport } from "../../clients/actionable-warnings.js";
import { CacheManager } from "../../clients/cache-manager.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import {
	handleTurnEnd,
	cancelLSPIdleReset,
} from "../../clients/runtime-turn.js";
import {
	getAmbientAbortSignal,
	setAmbientAbortSignal,
} from "../../clients/safe-spawn.js";
import { installLspServiceDouble } from "../support/lsp-service-seam.js";
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

let env: ReturnType<typeof setupTestEnvironment>;

beforeEach(() => {
	env = setupTestEnvironment("pi-lens-5550-reverify-");
});

afterEach(() => {
	setAmbientAbortSignal(undefined);
	cancelLSPIdleReset();
	env.cleanup();
});

function carriedReport(filePath: string): ActionableWarningsReport {
	const stamp = new Date().toISOString();
	return {
		generatedAt: stamp,
		scope: "turn_delta",
		sessionId: "s1",
		turnIndex: 1,
		deltaOnly: true,
		includeLspCodeActions: false,
		files: [
			{
				filePath,
				displayPath: "a.ts",
				origin: "deferred",
				generatedAt: stamp,
				warnings: [
					{
						id: "w1",
						filePath,
						displayPath: "a.ts",
						line: 1,
						severity: "warning",
						tool: "typescript",
						source: "ts",
						code: "6133",
						rule: "ts:6133",
						message: "'x' is declared but its value is never read.",
						actions: [],
						suppressed: false,
						origin: "lsp",
					},
				],
			},
		],
		summary: {
			warnings: 1,
			unsuppressed: 1,
			suppressed: 0,
			files: 1,
			actions: 0,
			autoFixEligible: 0,
		},
	};
}

describe("turn_end persistent re-verify (#5550)", () => {
	it("hands the abandoned re-verify the bound's abort, so its touch is cancelled", async () => {
		const filePath = path.join(env.tmpDir, "a.ts");
		fs.writeFileSync(filePath, "const x = 1;\n");
		const past = new Date(Date.now() - 60_000);
		fs.utimesSync(filePath, past, past);
		// Built BEFORE the turn's file is recorded: a worklist older than the
		// session's start is not the session's work.
		const runtime = new RuntimeCoordinator();
		const cacheManager = new CacheManager(false);
		cacheManager.writeCache(
			"actionable-warnings",
			carriedReport(filePath),
			env.tmpDir,
		);

		// The turn must have touched a file, or `handleTurnEnd` returns early.
		cacheManager.addModifiedRange(
			filePath,
			{ start: 1, end: 1 },
			false,
			env.tmpDir,
		);

		const escape = new AbortController();
		setAmbientAbortSignal(escape.signal);
		let seen: AbortSignal | undefined;
		let releaseTouch!: () => void;
		await installLspServiceDouble({
			touchFile: () => {
				seen = getAmbientAbortSignal();
				// Esc lands while the touch is pending: the turn's bound fires.
				queueMicrotask(() => escape.abort());
				return new Promise((resolve) => {
					releaseTouch = () => resolve({ diags: [] });
				});
			},
		} as never);

		await handleTurnEnd({
			ctxCwd: env.tmpDir,
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
			testRunnerClient: { getTestRunTarget: () => null },
			resetLSPService: () => {},
			resetFormatService: () => {},
		} as never);

		expect(seen).toBeDefined();
		// The re-verify's touch bound is cancelled by the outer bound's abort
		// through the signal the thunk handed down, not by its own wall budget.
		await new Promise((resolve) => setImmediate(resolve));
		await new Promise((resolve) => setImmediate(resolve));
		expect(seen?.aborted).toBe(true);
		releaseTouch();
	});
});
