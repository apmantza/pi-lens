/**
 * #3246 review round 2 (R3247-1) — the pi host ADAPTER, not the shared engine
 * seam.
 *
 * Round 1's delivery case called `handleTurnEnd` directly, so the pi hook
 * chain that actually reaches an agent — `tool_result` recording the inline
 * blocker, `turn_end` composing the findings, `context` injecting them — was
 * never exercised. This drives all three of `index.ts`'s real registered
 * handlers through the host mock, and asserts on the message the agent would
 * receive.
 *
 * The one double is `clients/pipeline.js`'s `runPipeline`, a true process
 * boundary (it spawns every configured linter/formatter). Its result is shaped
 * exactly as the real pipeline shapes it: the summary is rendered with
 * `formatDiagnostics(blockers, "blocking")` — `clients/dispatch/dispatcher.ts`'s
 * own expression — from the same array handed to `inlineBlockerDiagnostics`, so
 * the double cannot make the fix look green by disagreeing with itself.
 * `handleToolResult`, `handleTurnEnd`, the `RuntimeCoordinator` index.ts owns,
 * the durable disposition store and `consumeTurnEndFindings` are all REAL.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pipeline = vi.hoisted(() => ({ runPipeline: vi.fn() }));
vi.mock("../clients/pipeline.js", () => pipeline);

import { markDisposition } from "../clients/diagnostic-dispositions.js";
import type { Diagnostic } from "../clients/dispatch/types.js";
import { formatDiagnostics } from "../clients/dispatch/utils/format-utils.js";
import extension from "../index.js";
import { removeTempDirSync } from "./clients/test-utils.js";
import {
	makeContextWithSystemEvent,
	makeSessionStartEvent,
} from "./support/host-event-factory.js";
import { endMockSessions } from "./support/mock-session-teardown.js";
import { createPiMock, makeCtx } from "./support/pi-mock.js";

const SESSION_ID = "pi-3246-delivery-session";
let tmpDir: string;

beforeEach(() => {
	pipeline.runPipeline.mockReset();
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-3246-pi-hook-"));
});

afterEach(async () => {
	// #5146: end the sessions the case started before the fixture root goes.
	await endMockSessions();
	removeTempDirSync(tmpDir);
});

function blockingDiagnostic(
	filePath: string,
	line: number,
	message: string,
): Diagnostic {
	return {
		id: `ast-grep:${path.basename(filePath)}:${line}`,
		message,
		filePath,
		line,
		severity: "error",
		semantic: "blocking",
		tool: "ast-grep",
		rule: "no-eval",
	};
}

/** The `PipelineResult` the real pipeline builds for a blocking run. */
function blockingPipelineResult(blockers: Diagnostic[]) {
	const summary = formatDiagnostics(blockers, "blocking").trim();
	return {
		output: summary,
		hasBlockers: true,
		isError: false,
		fileModified: false,
		inlineBlockerSummary: summary,
		inlineBlockerSources: ["ast-grep"],
		inlineBlockerLines: blockers.map((d) => d.line),
		inlineBlockerDiagnostics: blockers,
	};
}

/** A clean run — what every file other than the target gets. */
const CLEAN_PIPELINE_RESULT = {
	output: "",
	hasBlockers: false,
	isError: false,
	fileModified: false,
};

/** Blockers for the target file only, exactly as a real dispatch would. */
function stubPipeline(target: string, blockers: Diagnostic[]): void {
	const blocking = blockingPipelineResult(blockers);
	pipeline.runPipeline.mockImplementation(async (ctx: { filePath: string }) =>
		path.resolve(ctx.filePath) === path.resolve(target)
			? blocking
			: CLEAN_PIPELINE_RESULT,
	);
}

/**
 * Everything the agent would be shown by this turn's context injection.
 *
 * `alsoEdit` exists to defeat the turn-end signature dedupe, NOT to decorate
 * the scenario: that memo silences a turn whose touched-file set AND rendered
 * content both repeat, so a second turn identical to the first is suppressed
 * for a reason that has nothing to do with the policy under test — which would
 * make the pre-fix run red for the wrong reason (round 2: it did). Editing one
 * extra file on the later turn changes the file set, so what the agent sees is
 * decided by the policy and nothing else. It is also the reported shape: "it
 * came back on a turn where I touched something else".
 */
async function driveTurn(
	pi: ReturnType<typeof createPiMock>,
	filePath: string,
	alsoEdit?: string,
): Promise<string> {
	await pi.emit("turn_start", {}, makeCtx({ cwd: tmpDir }));
	for (const edited of alsoEdit ? [filePath, alsoEdit] : [filePath]) {
		await pi.emit(
			"tool_result",
			{
				toolName: "edit",
				input: { path: edited },
				details: { diff: "+  1 alpha();" },
				content: [{ type: "text", text: "base" }],
			},
			makeCtx({ cwd: tmpDir }),
		);
	}
	await pi.emit("turn_end", {}, makeCtx({ cwd: tmpDir }));
	const injected = (await pi.emit(
		"context_with_system",
		makeContextWithSystemEvent([{ role: "user", content: "keep working" }]),
		makeCtx({ cwd: tmpDir }),
	)) as { messages?: Array<{ content: string }> } | undefined;
	return (injected?.messages ?? []).map((m) => m.content).join("\n\n");
}

describe("pi turn_end → context delivery honors inline-blocker dispositions (#3246)", () => {
	it("injects only the unmarked blocker after a false-positive mark", async () => {
		const filePath = path.join(tmpDir, "shared.ts");
		const unrelated = path.join(tmpDir, "notes.ts");
		fs.writeFileSync(filePath, "alpha();\nbeta();\n");
		fs.writeFileSync(unrelated, "export const note = 1;\n");
		const blockers = [
			blockingDiagnostic(filePath, 1, "alpha is unsafe"),
			blockingDiagnostic(filePath, 2, "beta is unsafe"),
		];
		stubPipeline(filePath, blockers);

		const pi = createPiMock();
		extension(pi.asExtensionAPI());
		await pi.emit(
			"session_start",
			makeSessionStartEvent(),
			makeCtx({ cwd: tmpDir, sessionId: SESSION_ID }),
		);

		// Baseline: unmarked, the agent is shown both blockers.
		const before = await driveTurn(pi, filePath);
		expect(before).toContain("Unresolved from this turn");
		expect(before).toContain("L1: alpha is unsafe");
		expect(before).toContain("L2: beta is unsafe");

		// The agent marks the first one false-positive, exactly as
		// `lens_diagnostic_mark` does.
		markDisposition(
			tmpDir,
			{
				cwd: tmpDir,
				filePath,
				tool: "ast-grep",
				rule: "no-eval",
				message: "alpha is unsafe",
				line: 1,
				content: fs.readFileSync(filePath, "utf8"),
			},
			"false-positive",
		);

		const after = await driveTurn(pi, filePath, unrelated);
		expect(after).toContain("L2: beta is unsafe");
		expect(after).not.toContain("alpha is unsafe");
		expect(after).toContain("suppressed by disposition: 1 finding(s)");
	});

	it("injects no blocker section at all once every blocker is marked", async () => {
		const filePath = path.join(tmpDir, "all-marked.ts");
		const unrelated = path.join(tmpDir, "notes.ts");
		fs.writeFileSync(filePath, "alpha();\n");
		fs.writeFileSync(unrelated, "export const note = 1;\n");
		const blockers = [blockingDiagnostic(filePath, 1, "alpha is unsafe")];
		stubPipeline(filePath, blockers);

		const pi = createPiMock();
		extension(pi.asExtensionAPI());
		await pi.emit(
			"session_start",
			makeSessionStartEvent(),
			makeCtx({ cwd: tmpDir, sessionId: SESSION_ID }),
		);

		expect(await driveTurn(pi, filePath)).toContain("🔴 STOP");

		markDisposition(
			tmpDir,
			{
				cwd: tmpDir,
				filePath,
				tool: "ast-grep",
				rule: "no-eval",
				message: "alpha is unsafe",
				line: 1,
				content: fs.readFileSync(filePath, "utf8"),
			},
			"false-positive",
		);

		const after = await driveTurn(pi, filePath, unrelated);
		expect(after).not.toContain("Unresolved from this turn");
		expect(after).not.toContain("🔴 STOP");
		expect(after).not.toContain("alpha is unsafe");
	});
});
