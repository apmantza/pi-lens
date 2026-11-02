/**
 * #1892 witness (ADR 0007) — the SECRETS LANE through the pi HOST entry.
 *
 * The lane extraction (`clients/turn-end/lanes/secrets.ts`) moved every
 * gitleaks/trivy-secrets rendering and disposition rule out of
 * `clients/runtime-turn.ts` with no agent-facing change, so the evidence that
 * matters is a committed artifact of what the agent actually receives. This
 * drives `index.ts`'s real registered `session_start` / `turn_start` /
 * `tool_result` / `turn_end` / `context` handlers and diffs the rendered
 * context message against
 * `tests/fixtures/witness/turn-end-lane-secrets/live-stale-marked.txt`.
 *
 * It covers, in ONE turn, every behaviour the lane owns and the one thing it
 * hands back to the composer:
 *   - a live gitleaks secret, unified with the ast-grep rule that flags the
 *     SAME line, in one 🔴 row with combined provenance (#131 Mode 3);
 *   - a trivy secret from the sibling store in the SAME section — the reason
 *     "gitleaks" is not a separable lane;
 *   - a gitleaks finding whose file was edited after the scan, in the 🔑 tier
 *     with its rule id and no line (#1622 M1/M2);
 *   - a gitleaks finding marked false-positive: gone from both tiers, present
 *     in the one suppressed-by-disposition notice as `gitleaks 1` (#1616);
 *   - the delivered-location set the lane builds: the ast-grep warning on the
 *     SAME line folds into the blocker's provenance, the one three lines down
 *     does not (`[gitleaks + ast-grep]` vs `[gitleaks]` under mutation).
 *
 * What it does NOT witness: the composer's own read of that set (it filters
 * the duplicate ast-grep row out of the actionable-warnings advisory). That
 * advisory renders nothing in this harness — `report.summary.unsuppressed`
 * stays 0 for injected dispatch warnings — so the section cannot appear
 * whether the filter runs or not. Pre-existing gap, named in the PR body, not
 * papered over with a fixture that only looks like a pin.
 *
 * The only doubles are process boundaries: `clients/pipeline.js` (it spawns
 * every configured linter, and is how a dispatch warning reaches the runtime)
 * and the scanner RESULT caches, written through the REAL `CacheManager` into
 * the project's real cache directory — exactly what a session_start scan
 * leaves behind. The cache manager, the coordinator, the freshness gate, the
 * disposition store, the lane and the context injection are all real.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pipeline = vi.hoisted(() => ({ runPipeline: vi.fn() }));
vi.mock("../clients/pipeline.js", () => pipeline);

import { CacheManager } from "../clients/cache-manager.js";
import { markDisposition } from "../clients/diagnostic-dispositions.js";
import type { GitleaksResult } from "../clients/gitleaks-client.js";
import type { TrivyResult } from "../clients/trivy-client.js";
import extension from "../index.js";
import { removeTempDirSync } from "./clients/test-utils.js";
import {
	makeContextWithSystemEvent,
	makeSessionStartEvent,
} from "./support/host-event-factory.js";
import { endMockSessions } from "./support/mock-session-teardown.js";
import { createPiMock, makeCtx } from "./support/pi-mock.js";

const SESSION_ID = "pi-1892-secrets-lane-session";
const SCAN_MS = Date.UTC(2026, 7, 18, 7, 0, 0);
const SCAN_AT = new Date(SCAN_MS).toISOString();

const GOLDEN = path.join(
	import.meta.dirname,
	"fixtures/witness/turn-end-lane-secrets/live-stale-marked.txt",
);

let tmpDir: string;

beforeEach(() => {
	pipeline.runPipeline.mockReset();
	tmpDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-1892-lane-")),
	);
});

afterEach(async () => {
	// #5146: end the sessions the case started before the fixture root goes.
	await endMockSessions();
	removeTempDirSync(tmpDir);
});

/** Write `relative` with `content` and pin its mtime. */
function writeAt(relative: string, content: string, mtimeMs: number): string {
	const file = path.join(tmpDir, relative);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
	fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
	return file;
}

describe("#1892 witness: the turn-end secrets lane through pi", () => {
	it("matches the committed golden delivery", async () => {
		const liveContent =
			"const key = 'AKIAIOSFODNN7EXAMPLE';\nconst a = 1;\nconst pw = 'hunter2';\n";
		const live = writeAt("src/live.ts", liveContent, SCAN_MS - 5_000);
		const edited = writeAt(
			"src/edited.ts",
			"const t = 'ghp_x';\n",
			SCAN_MS + 30_000,
		);
		const markedContent = "const slack = 'xoxb-1';\n";
		const marked = writeAt("src/marked.ts", markedContent, SCAN_MS - 5_000);
		const dep = writeAt("src/dep.ts", "aws_secret = 'z'\n", SCAN_MS - 5_000);

		const cacheManager = new CacheManager(false);
		cacheManager.writeCache(
			"gitleaks",
			{
				success: true,
				scannedAt: SCAN_AT,
				findings: [
					{
						ruleId: "aws-access-token",
						file: live,
						startLine: 1,
						description: "AWS key",
					},
					{ ruleId: "generic-api-key", file: edited, startLine: 1 },
					{ ruleId: "slack-token", file: marked, startLine: 1 },
				],
			} satisfies GitleaksResult,
			tmpDir,
		);
		cacheManager.writeCache(
			"trivy",
			{
				success: true,
				scannedAt: SCAN_AT,
				findings: [],
				secrets: [{ ruleId: "aws-secret-access-key", file: dep, line: 1 }],
				licenses: [],
			} satisfies TrivyResult,
			tmpDir,
		);

		// The agent already judged the third finding, through the identity
		// `gitleaksFindingToProjectDiagnostic` surfaces — the real disposition
		// store, written exactly as `lens_diagnostic_mark` writes it.
		markDisposition(
			tmpDir,
			{
				cwd: tmpDir,
				filePath: marked,
				tool: "gitleaks",
				rule: "gitleaks:slack-token",
				message: "Potential secret: slack-token",
				line: 1,
				content: markedContent,
			},
			"false-positive",
		);

		// Two ast-grep secret warnings on the edited file: one at the line the
		// gitleaks finding cites (folded into the blocker's provenance and
		// suppressed from the advisory), one at another line (advisory only).
		pipeline.runPipeline.mockResolvedValue({
			output: "",
			hasBlockers: false,
			isError: false,
			fileModified: false,
			actionableWarnings: [
				{
					id: "ast-1",
					filePath: live,
					displayPath: "src/live.ts",
					line: 1,
					severity: "warning",
					tool: "ast-grep",
					rule: "ts-hardcoded-secret-assignment",
					message: "Hardcoded secret assigned to a variable",
					actions: [],
					suppressed: false,
				},
				{
					id: "ast-2",
					filePath: live,
					displayPath: "src/live.ts",
					line: 3,
					severity: "warning",
					tool: "ast-grep",
					rule: "ts-hardcoded-password-literal",
					message: "Hardcoded password literal",
					actions: [],
					suppressed: false,
				},
			],
		});

		const pi = createPiMock();
		extension(pi.asExtensionAPI());
		await pi.emit(
			"session_start",
			makeSessionStartEvent(),
			makeCtx({ cwd: tmpDir, sessionId: SESSION_ID }),
		);
		await pi.emit("turn_start", {}, makeCtx({ cwd: tmpDir }));
		await pi.emit(
			"tool_result",
			{
				toolName: "edit",
				input: { path: live },
				// Both warning lines are inside this turn's modified ranges, so the
				// actionable-warnings advisory is delta-eligible for both: the one
				// at line 1 is suppressed because the lane already delivered that
				// location as a blocker, the one at line 3 is not.
				details: { diff: "+  1 alpha();\n+  3 gamma();" },
				content: [{ type: "text", text: "base" }],
			},
			makeCtx({ cwd: tmpDir }),
		);
		await pi.emit("turn_end", {}, makeCtx({ cwd: tmpDir }));
		const injected = (await pi.emit(
			"context_with_system",
			makeContextWithSystemEvent([{ role: "user", content: "keep working" }]),
			makeCtx({ cwd: tmpDir }),
		)) as { messages?: Array<{ role?: string; content: string }> } | undefined;

		// #4631 round 5 (F2): the transcript leads with the host's system head, so the
		// golden records the messages pi-lens APPENDED. The assertion pins that the
		// head is still at index 0: a regression that dropped it would shift this
		// golden instead of slipping through.
		expect((injected?.messages ?? [])[0]?.role).toBe("system");
		const actual = `${[
			"=== context message the agent receives ===",
			(injected?.messages ?? [])
				.slice(1)
				.map((m) => m.content)
				.join("\n\n")
				.replaceAll(tmpDir, "<PROJECT>")
				.trimEnd(),
		].join("\n")}\n`;

		// Regenerate deliberately, never as a side effect of a failing run.
		if (process.env.PI_LENS_WITNESS_UPDATE === "1") {
			fs.mkdirSync(path.dirname(GOLDEN), { recursive: true });
			fs.writeFileSync(GOLDEN, actual);
		}
		expect(actual).toBe(fs.readFileSync(GOLDEN, "utf-8"));
	});
});
