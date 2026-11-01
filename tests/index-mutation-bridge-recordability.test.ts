/**
 * #2465 — the mutation bridge's `index.ts` WIRING, driven through the real
 * extension activation (`tests/support/pi-mock.ts`), not just the
 * `recordMutationThroughSeam` unit tested against a hand-built deps object
 * in `tests/clients/mutation-bridge.test.ts`.
 *
 * That file proves the seam's OWN logic: given `isRecordable` that doesn't
 * consult `no-read-guard` and a `shouldStampReadGuard` that does, the stamp
 * alone is skipped. It does not prove `index.ts` actually WIRES those two
 * closures that way — a wiring bug (e.g. `shouldStampReadGuard` reading the
 * wrong flag name, or `isRecordable` accidentally keeping the old
 * conflated check) would be invisible to it. This file closes that gap by
 * mounting the REAL bridge through `extension()` and driving a write
 * through `getMutationBridge()`, the same producer-side entry point a
 * same-process extension uses.
 *
 * `handleSessionStart` is stubbed (same precedent as `tests/index-wiring.test.ts`)
 * because its real body runs dominant-language scans and LSP bootstrap this
 * test doesn't need — but unlike that file's no-op stub, this one preserves
 * the ONE thing the recordability gate depends on: `runtime.projectRoot` set
 * from the session's cwd.
 */
import * as fs from "node:fs";
import * as os from "node:os";
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
vi.mock("../clients/runtime-session.js", () => ({
	handleSessionStart: async (deps: {
		runtime: { projectRoot: string; resetForSession: () => void };
		ctxCwd?: string;
	}) => {
		// #5146: the real start begins a fresh scope before its first await
		// (runtime-session.ts). Without it a second cell reuses the scope the
		// first cell's shutdown retired, and the bridge refuses the retired scope.
		deps.runtime.resetForSession();
		if (deps.ctxCwd) deps.runtime.projectRoot = deps.ctxCwd;
	},
}));

import { CacheManager } from "../clients/cache-manager.js";
import extension from "../index.js";
import { getMutationBridge } from "../clients/mutation-bridge.js";
import {
	_observedMutationStateForTests,
	resetObservedMutationNet,
} from "../clients/observed-mutation.js";
import { normalizeMapKey } from "../clients/path-utils.js";
import { readChangesSince } from "../clients/project-changes.js";
import { ReadGuard } from "../clients/read-guard.js";
import { _resetSessionLifecycleForTests } from "../clients/session-lifecycle.js";
import { endMockSessions } from "./support/mock-session-teardown.js";
import { createPiMock, makeCtx } from "./support/pi-mock.js";
import { useGlobalConfig } from "./support/global-config.js";
import { removeTempDirSync } from "./clients/test-utils.js";

const setGlobalConfig = useGlobalConfig();

describe("#2465: index.ts's mutation-bridge wiring separates recordability from the no-read-guard stamp", () => {
	let tmp: string;
	let prevDataDir: string | undefined;
	// Each cell activates a fresh session; the lifecycle reset keeps one cell's
	// primary session from making the next cell's session_start a concurrent
	// secondary (the same isolation index-wiring.test.ts uses between its
	// activations).
	beforeEach(() => {
		_resetSessionLifecycleForTests();
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-2465-bridge-wiring-"));
		prevDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(tmp, "data");
		resetObservedMutationNet();
	});

	afterEach(async () => {
		// #5146: end the cell's session before its data dir and root go.
		await endMockSessions();
		_resetSessionLifecycleForTests();
		if (prevDataDir === undefined) delete process.env.PILENS_DATA_DIR;
		else process.env.PILENS_DATA_DIR = prevDataDir;
		resetObservedMutationNet();
		removeTempDirSync(tmp);
	});

	// Review F3: the --no-read-guard cell above cannot fail on the stamp gate by
	// itself (a one-argument toHaveBeenCalledWith never matches the two-argument
	// recordWritten call). This cell is the positive side: with the guard on,
	// the same write stamps the read guard with its path and options.
	it("stamps the read guard for a recordable bridge write when --no-read-guard is not set", async () => {
		const recordWrittenSpy = vi.spyOn(ReadGuard.prototype, "recordWritten");
		setGlobalConfig({});
		const pi = createPiMock();
		extension(pi.asExtensionAPI());
		await pi.emit(
			"session_start",
			{ reason: "startup" },
			makeCtx({ cwd: tmp, sessionId: "s-2465-stamp" }),
		);
		const filePath = path.join(tmp, "stamped.ts");
		fs.writeFileSync(filePath, "export const a = 1;\n");
		const accepted = getMutationBridge()?.recordMutation({
			filePath,
			kind: "write",
			consumer: "probe-2465-stamp",
		});
		expect(accepted).toBe(true);
		expect(recordWrittenSpy).toHaveBeenCalledWith(filePath, expect.anything());
	});

	it("a recordable bridge write under --no-read-guard still gets turn-state, a receipt, and the observed-handled mark, but skips only the read-guard stamp", async () => {
		// The class method every RuntimeCoordinator's lazily-constructed
		// ReadGuard shares — spying on the prototype catches the call
		// regardless of which instance index.ts's closure holds.
		const recordWrittenSpy = vi.spyOn(ReadGuard.prototype, "recordWritten");

		setGlobalConfig({ readGuard: { enabled: false } });
		const pi = createPiMock();
		extension(pi.asExtensionAPI());
		await pi.emit(
			"session_start",
			{ reason: "startup" },
			makeCtx({ cwd: tmp, sessionId: "s-2465-wiring" }),
		);

		const filePath = path.join(tmp, "wiring.ts");
		fs.writeFileSync(filePath, "export const a = 1;\n");

		const bridge = getMutationBridge();
		expect(bridge).toBeDefined();
		const accepted = bridge?.recordMutation({
			filePath,
			kind: "write",
			consumer: "probe-2465",
		});
		expect(accepted).toBe(true);

		// The stamp alone is suppressed under --no-read-guard: no call at all.
		expect(recordWrittenSpy).not.toHaveBeenCalled();

		// Turn-state and the change-log receipt are unaffected by the flag —
		// this is the part that used to be dropped entirely when `isRecordable`
		// itself consulted `no-read-guard`.
		const turnFiles = Object.keys(
			new CacheManager(false).readTurnState(tmp).files ?? {},
		);
		expect(turnFiles.some((f) => f.includes("wiring.ts"))).toBe(true);
		expect(readChangesSince(tmp, 0)).toMatchObject([
			{ source: "agent-tool:probe-2465", filePath },
		]);

		// The observed-mutation handled mark (#2430/#2449) is reached only when
		// `isRecordable` lets the call through the early return.
		expect(_observedMutationStateForTests().handled).toContain(
			normalizeMapKey(path.resolve(filePath)),
		);
	});
});
