/**
 * #5792 review F3: a session start that is superseded while it awaits
 * publishes no guidance record.
 *
 * The write is the last publish of `handleSessionStart`'s awaits, and it
 * stamps `runtime.telemetrySessionId` as read at write time. A successor that
 * pinned its own id in between would have its id stamped on this start's
 * guidance, and the successor would consume content it did not produce.
 * Every other post-await publish in the handler is gated on
 * `isCurrentSession(sessionGeneration)`; this one must be too.
 *
 * The real `handleSessionStart` runs on a real `RuntimeCoordinator` and a real
 * `CacheManager`. The supersession is a `resetForSession` (a later start) landing
 * inside the Go availability await that precedes the write.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { CacheManager } from "../../clients/cache-manager.js";
import { getProjectDataDir } from "../../clients/file-utils.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { handleSessionStart } from "../../clients/runtime-session.js";
import { withResidentBootstrap } from "../support/bootstrap-access.js";
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

/** Run a full start; `duringAwait` runs inside the await before the write. */
async function fullStart(duringAwait: (runtime: RuntimeCoordinator) => void) {
	const env = setupTestEnvironment("pi-lens-5792-superseded-");
	const runtime = new RuntimeCoordinator();
	const cacheManager = new CacheManager(false);
	await handleSessionStart(
		withResidentBootstrap({
			ctxCwd: env.tmpDir,
			startupModeOverride: "full",
			getFlag: () => false,
			notify: () => {},
			dbg: () => {},
			log: () => {},
			runtime,
			cacheManager,
			todoScanner: { scanDirectory: () => ({ items: [] }) },
			astGrepClient: {
				isAvailable: () => false,
				ensureAvailable: async () => false,
				scanExports: async () => new Map(),
			},
			biomeClient: {
				isAvailable: () => false,
				ensureAvailable: async () => false,
			},
			ruffClient: {
				isAvailable: () => false,
				ensureAvailable: async () => false,
			},
			knipClient: {
				isAvailable: () => false,
				ensureAvailable: async () => false,
				analyze: async () => EMPTY_KNIP_RESULT,
			},
			jscpdClient: {
				isAvailable: () => false,
				ensureAvailable: async () => false,
			},
			deadCodeClients: [],
			depChecker: {
				isAvailable: () => false,
				ensureAvailable: async () => false,
			},
			testRunnerClient: { detectRunner: () => null, runTestFile: () => ({}) },
			goClient: {
				isGoAvailableAsync: async () => {
					duringAwait(runtime);
					return false;
				},
			},
			rustClient: { isAvailableAsync: async () => false },
			ensureTool: async () => null,
			cleanStaleTsBuildInfo: () => [],
			resetDispatchBaselines: () => {},
			resetLSPService: () => {},
		}) as never,
	);
	return {
		record: path.join(
			getProjectDataDir(env.tmpDir),
			"cache",
			"session-start-guidance.json",
		),
		runtime,
	};
}

describe("#5792 F3: the guidance write follows the session-generation guard", () => {
	it("writes the stamped record when the start is still current", async () => {
		const { record, runtime } = await fullStart(() => {});
		const stored = JSON.parse(fs.readFileSync(record, "utf8"));
		expect(stored.sessionId).toBe(runtime.telemetrySessionId);
		expect(stored.content).toContain("pi-lens active");
	});

	it("writes no record when a later start superseded this one during its awaits", async () => {
		// RECURRENCE GUARDED: #5792 review F3 (shapes 22 and 19), a superseded
		// start published guidance stamped with the successor's id.
		const { record } = await fullStart((runtime) => runtime.resetForSession());
		expect(fs.existsSync(record)).toBe(false);
	});
});
