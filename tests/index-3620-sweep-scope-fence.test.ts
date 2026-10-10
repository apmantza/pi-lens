/**
 * #3620 (S3 of #3609): the `agent_settled` sweep replays drifted files through
 * the mutation bridge after its own scan and range awaits, and `/new` can land
 * in between. The replay then stamped the NEW session's read guard, so a file
 * that session never read counted as authored and its first edit was allowed
 * (the G10 review's NS-RACE probe). #3709 is the same write at an equal epoch
 * value: the branch epoch restarts at 0 per scope, so the epoch alone cannot
 * refuse it.
 *
 * This drives index.ts' own replay closure against the real bridge, the real
 * coordinator and its real read guard. Only the sweep's scan is held: the
 * double hands back the production `record` closure, and the case calls it
 * after the transition, where the real sweep's replay lands.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../clients/bootstrap.js", async () => {
	const { bootstrapSeamMock } = await import("./support/bootstrap-mock.js");
	return bootstrapSeamMock(async () => ({
		metricsClient: { reset: () => {} },
		todoScanner: {},
		biomeClient: { isAvailable: () => false },
		ruffClient: { isAvailable: () => false },
		knipClient: {
			isAvailable: () => false,
			analyze: async () => ({
				success: false,
				summary: "unavailable",
				issues: [],
			}),
		},
		jscpdClient: { isAvailable: () => false },
		depChecker: { isAvailable: () => false },
		testRunnerClient: { detectRunner: () => null },
		goClient: { isGoAvailableAsync: async () => false },
		rustClient: { isAvailableAsync: async () => false },
		agentBehaviorClient: {
			recordToolCall: () => {},
			formatWarnings: () => "",
		},
		complexityClient: {
			isSupportedFile: () => false,
			analyzeFile: () => null,
		},
	}));
});
// The production session start resets the coordinator
// (`clients/runtime-session.ts` `runtime.resetForSession`); the rest of it is
// not this file's concern.
vi.mock("../clients/runtime-session.js", () => ({
	handleSessionStart: async (deps: {
		runtime: { projectRoot: string; resetForSession(): void };
		ctxCwd?: string;
	}) => {
		deps.runtime.resetForSession();
		if (deps.ctxCwd) deps.runtime.projectRoot = deps.ctxCwd;
	},
}));
const held = vi.hoisted(() => ({
	record: undefined as undefined | ((entry: unknown) => boolean),
	runtime: undefined as
		| undefined
		| {
				readGuard: {
					checkEdit(
						filePath: string,
						lines: [number, number],
					): {
						action: string;
					};
				};
		  },
}));
vi.mock("../clients/observed-mutation.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../clients/observed-mutation.js")>()),
	runObservedSettledSweep: vi.fn(
		async (args: { record: (entry: unknown) => boolean }) => {
			held.record = args.record;
			return {
				scanned: 0,
				notReachedThisPass: 0,
				cursor: 0,
				drifted: [],
				unverifiable: [],
				replayed: 0,
			};
		},
	),
}));
vi.mock("../clients/runtime-agent-end.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../clients/runtime-agent-end.js")>()),
	handleAgentEnd: vi.fn(async (deps: { runtime: typeof held.runtime }) => {
		held.runtime = deps.runtime;
	}),
}));

import extension from "../index.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../clients/degradation-ledger.js";
import { resetObservedMutationNet } from "../clients/observed-mutation.js";
import { _resetSessionLifecycleForTests } from "../clients/session-lifecycle.js";
import { createPiMock, makeCtx } from "./support/pi-mock.js";
import {
	cleanupTestEnvironmentsDrained,
	setupTestEnvironment,
} from "./clients/test-utils.js";

describe("#3620 the settled sweep's replay is fenced by the settle's scope", () => {
	let env: ReturnType<typeof setupTestEnvironment>;
	let prevDataDir: string | undefined;

	beforeEach(() => {
		_resetSessionLifecycleForTests();
		resetDegradationLedger();
		env = setupTestEnvironment("pi-lens-3620-sweep-");
		prevDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		resetObservedMutationNet();
		held.record = undefined;
		held.runtime = undefined;
	});

	afterEach(async () => {
		if (prevDataDir === undefined) delete process.env.PILENS_DATA_DIR;
		else process.env.PILENS_DATA_DIR = prevDataDir;
		resetObservedMutationNet();
		_resetSessionLifecycleForTests();
		env.cleanup();
		await cleanupTestEnvironmentsDrained("pi-lens-3620-sweep-");
	});

	for (const replaced of [true, false]) {
		it(
			replaced
				? "a sweep replay that lands after /new does not let the new session edit an unread file"
				: "a sweep replay in its own session still credits its write",
			async () => {
				const pi = createPiMock({ "no-lsp": true });
				extension(pi.asExtensionAPI());
				const ctx = makeCtx({ cwd: env.tmpDir, sessionId: "s-3620" });
				await pi.emit("session_start", { reason: "startup" }, ctx);
				const filePath = path.join(env.tmpDir, "drifted.ts");
				fs.writeFileSync(filePath, "export const a = 2;\n");
				// Aged, so only an explicit credit can allow an edit.
				const longAgo = new Date("2000-01-01T00:00:00Z");
				fs.utimesSync(filePath, longAgo, longAgo);

				await pi.emit("agent_settled", {}, ctx);
				// pi-mock bound: this lifecycle assertion does not re-run the factory or reproduce host ordering.
				if (replaced) await pi.simulateSessionShutdownAndRebuild("new", ctx);
				// The replay the sweep makes for a drifted file (observed-mutation.ts
				// runObservedSettledSweep), through index.ts' closure.
				held.record?.({
					filePath,
					kind: "edit",
					touchedLines: [1, 1],
					consumer: "settled-sweep",
					provenance: "settled-sweep",
				});

				expect({
					verdict: held.runtime?.readGuard.checkEdit(filePath, [1, 1]).action,
					falseBlocks: getDegradationSummary()
						.find((group) => group.kind === "session-scope-read-dropped")
						?.latestReasons.map((r) => r.subject),
				}).toEqual(
					replaced
						? { verdict: "block", falseBlocks: ["new:settled-sweep"] }
						: { verdict: "block", falseBlocks: undefined },
				);
			},
		);
	}
});
