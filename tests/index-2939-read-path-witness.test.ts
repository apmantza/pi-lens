/**
 * #2939 M11 and W3 — the two `index.ts` `tool_result` guards that only exist
 * for the READ-ONLY path, and that PR #2897's verify measured green under
 * mutation because no test drives the registered host handler with a read.
 *
 * Recurrences prevented:
 *
 * - M11: #2897 round 1's `if (!rtMutation) return;` dropped every read/search
 *   result before `handleToolResult`, so native-read registration stopped and
 *   the next edit to a file the agent HAD read was blocked as `zero_read`
 *   (finding F1, rated CRITICAL). Witnessed through the production
 *   `read_pattern` read-guard row the registration emits.
 * - W3: the behaviour seam's `?? getAgentBehaviorClient()` fallback. Before it,
 *   `resident?.agentBehaviorClient?.recordToolCall(...) ?? []` recorded
 *   NOTHING whenever `peekBootstrapClients()` was null — which is every tool
 *   result before an analyzer bootstrap has completed, i.e. the majority of a
 *   session's results and all of them before the first edit. Witnessed
 *   through the real process-wide `agentBehaviorClient`: two reads driven
 *   through the registration make a third, DIRECT call the one that trips the
 *   thrash threshold, so the count asserted is the handler's contribution and
 *   not this test's.
 *
 * Doubles: the host (`createPiMock`), `handleSessionStart` (reduced to the one
 * thing this file needs from it — pointing the runtime at the temp project,
 * the same reduction `tests/index-observed-sweep-no-read-guard.test.ts` uses),
 * the bootstrap module's shared production-faithful seam with a load that
 * never completes (the state W3's fallback exists for; `peekBootstrapClients`
 * answers null exactly as production does, and `getAgentBehaviorClient`
 * returns the real singleton), and the read-guard log EMIT, which production
 * no-ops under `isTestMode()`. The read guard, the runtime coordinator, the
 * behaviour client and `handleToolResult` are all real.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../clients/bootstrap.js", async () => {
	const { bootstrapSeamMock } = await import("./support/bootstrap-mock.js");
	// A load that never completes: `peekBootstrapClients()` stays null, which is
	// what the read-only path sees for real until a first edit finishes loading.
	return bootstrapSeamMock(() => new Promise<never>(() => {}));
});

vi.mock("../clients/runtime-session.js", () => ({
	handleSessionStart: async (deps: {
		runtime: { projectRoot: string };
		ctxCwd?: string;
	}) => {
		if (deps.ctxCwd) deps.runtime.projectRoot = deps.ctxCwd;
	},
}));

const readGuardRows = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock("../clients/read-guard-logger.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../clients/read-guard-logger.js")>();
	return {
		...actual,
		logReadGuardEvent: (entry: Record<string, unknown>) => {
			readGuardRows.push(entry);
		},
	};
});

import { agentBehaviorClient } from "../clients/agent-behavior-client.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../clients/degradation-ledger.js";
import extension from "../index.js";
import { makeSessionStartEvent } from "./support/host-event-factory.js";
import { endMockSessions } from "./support/mock-session-teardown.js";
import { createPiMock, makeCtx, type PiMock } from "./support/pi-mock.js";

let tmpDir: string;
let filePath: string;

/** Activate the extension and point its runtime at the temp project. */
async function activated(): Promise<PiMock> {
	const pi = createPiMock();
	extension(pi.asExtensionAPI());
	await pi.emit(
		"session_start",
		makeSessionStartEvent(),
		makeCtx({ cwd: tmpDir, sessionId: "s-2939" }),
	);
	return pi;
}

const readResult = (id: string) => ({
	toolName: "read",
	toolCallId: id,
	input: { path: filePath },
	content: [{ type: "text", text: "const a = 1;\nconst b = 2;\n" }],
});

beforeEach(() => {
	readGuardRows.length = 0;
	resetDegradationLedger();
	agentBehaviorClient.reset();
	tmpDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-2939-read-")),
	);
	filePath = path.join(tmpDir, "witnessed.ts");
	fs.writeFileSync(filePath, "const a = 1;\nconst b = 2;\n", "utf8");
});

afterEach(async () => {
	// #5146: end the sessions the case started before the fixture root goes.
	await endMockSessions();
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("#2939 M11 — a read result still reaches the full handler", () => {
	it("registers the delivered native-read range through the registration", async () => {
		const pi = await activated();
		readGuardRows.length = 0;
		await pi.emit("tool_result", readResult("rd-1"), makeCtx({ cwd: tmpDir }));

		const patterns = readGuardRows.filter(
			(row) => row.event === "read_pattern" && row.filePath === filePath,
		);
		expect(patterns).toHaveLength(1);
		// The delivered range is the handler's own arithmetic over the file on
		// disk, not anything this test supplied: three lines, from line 1.
		expect(patterns[0]).toMatchObject({
			requestedOffset: 1,
			effectiveOffset: 1,
			effectiveLimit: 3,
		});
		// #2523 AC5, and the other direction of the same `editClass` ternary:
		// the read-only path uses `peekBootstrapClients()` and awaits NO
		// analyzer-bootstrap load, so no bound can have fired on this emit.
		// (The load installed above never completes, so a read that awaited it
		// would be released only by the registration's own 500 ms bound.)
		expect(
			getDegradationSummary().filter(
				(group) => group.kind === "hook-await-exceeded",
			),
		).toEqual([]);
	});
});

describe("#2939 W3 — behaviour history survives an absent resident client", () => {
	it("records read results on the process-wide client when peek is null", async () => {
		const pi = await activated();
		agentBehaviorClient.reset();
		await pi.emit("tool_result", readResult("rd-2"), makeCtx({ cwd: tmpDir }));
		await pi.emit("tool_result", readResult("rd-3"), makeCtx({ cwd: tmpDir }));

		// Those two reads never load bootstrap clients, so the fallback is the
		// only thing that can have recorded them. The third call is this test's,
		// and it is the one the threshold answers.
		expect(agentBehaviorClient.recordToolCall("read", filePath)).toEqual([
			expect.objectContaining({
				type: "thrashing",
				details: expect.objectContaining({ callCount: 3 }),
			}),
		]);
	});
});
