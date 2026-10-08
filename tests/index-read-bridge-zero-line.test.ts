/**
 * #3654 F1: the v1 read shim's zero-line read through the REAL `index.ts`
 * activation (`tests/support/pi-mock.ts`). In a pi-lens process the shim runs
 * the v2 bridge body; it used to spell `requestedLimit: 0` as the range
 * `[1, 0]`, which v2 rejects as malformed, so a zero-line read of an empty
 * file was dropped and the next edit blocked (a #3652 regression). Unit tests
 * that mounted the v1 shim alone ran a fallback body production never
 * reached, so they stayed green.
 *
 * Its own file: the bridges are first-wins process singletons whose deps
 * close over the FIRST activation's runtime, so one activation per file is
 * the only one whose project root the bridge sees. `handleSessionStart` is
 * stubbed as in `tests/index-mutation-bridge-recordability.test.ts`, keeping
 * only `runtime.projectRoot` from the session's cwd.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

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
vi.mock("../clients/runtime-session.js", () => ({
	handleSessionStart: async (deps: {
		runtime: { projectRoot: string };
		ctxCwd?: string;
	}) => {
		if (deps.ctxCwd) deps.runtime.projectRoot = deps.ctxCwd;
	},
}));

import extension from "../index.js";
import { READ_BRIDGE_KEY, type ReadBridge } from "../clients/read-bridge.js";
import { ReadGuard } from "../clients/read-guard.js";
import { createPiMock, makeCtx } from "./support/pi-mock.js";
import { removeTempDirSync } from "./clients/test-utils.js";

describe("#3654 F1: index.ts's read shim records a v1 zero-line read through v2", () => {
	let tmp: string;
	let prevDataDir: string | undefined;
	let readBridge: ReadBridge;

	beforeAll(async () => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-3654-zero-line-"));
		prevDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(tmp, "data");
		const pi = createPiMock({});
		extension(pi.asExtensionAPI());
		await pi.emit(
			"session_start",
			{ reason: "startup" },
			makeCtx({ cwd: tmp, sessionId: "s-3654-zero-line" }),
		);
		readBridge = (globalThis as Record<symbol, ReadBridge>)[READ_BRIDGE_KEY];
	});

	afterAll(() => {
		vi.restoreAllMocks();
		if (prevDataDir === undefined) delete process.env.PILENS_DATA_DIR;
		else process.env.PILENS_DATA_DIR = prevDataDir;
		removeTempDirSync(tmp);
	});

	it("credits whole-file coverage for an empty file, so the next edit is allowed", () => {
		const recordReadSpy = vi.spyOn(ReadGuard.prototype, "recordRead");
		const empty = path.join(tmp, "empty.ts");
		fs.writeFileSync(empty, "");

		readBridge.recordRead({
			filePath: empty,
			requestedOffset: 1,
			requestedLimit: 0,
			consumer: "probe-3654",
		});

		expect(recordReadSpy).toHaveBeenCalledTimes(1);
		const guard = recordReadSpy.mock.contexts[0] as ReadGuard;
		expect(
			guard
				.getReadHistory(empty)
				.map((r) => [r.effectiveOffset, r.effectiveLimit, r.source]),
		).toEqual([[1, Number.MAX_SAFE_INTEGER, "bridge:probe-3654"]]);
		expect(guard.checkEdit(empty, [1, 1]).action).toBe("allow");
		recordReadSpy.mockRestore();
	});

	it("records nothing for a zero-line read of a non-empty file", () => {
		const recordReadSpy = vi.spyOn(ReadGuard.prototype, "recordRead");
		const full = path.join(tmp, "full.ts");
		fs.writeFileSync(full, "export const a = 1;\n");

		readBridge.recordRead({
			filePath: full,
			requestedOffset: 1,
			requestedLimit: 0,
			consumer: "probe-3654",
		});

		expect(recordReadSpy).not.toHaveBeenCalled();
		recordReadSpy.mockRestore();
	});
});
