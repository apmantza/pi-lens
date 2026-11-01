/**
 * #1892 witness (ADR 0007) — the GOVULNCHECK LANE through the pi HOST entry.
 *
 * The lane extraction (`clients/turn-end/lanes/govulncheck.ts`) moved every Go
 * CVE freshness, disposition and rendering rule out of
 * `clients/runtime-turn.ts` with no agent-facing change, so the evidence that
 * matters is a committed artifact of what the agent actually receives. This
 * drives `index.ts`'s real registered `session_start` / `turn_start` /
 * `tool_result` / `turn_end` / `context` handlers and diffs the rendered
 * context message against
 * `tests/fixtures/witness/turn-end-lane-govulncheck/advisory-tier.txt`.
 *
 * It covers, in ONE turn, every rule the lane owns:
 *   - a live CVE with its cached call site as `file:line` and its upgrade
 *     target;
 *   - a live CVE with no `fixedVersion` — "no fix yet, track upstream";
 *   - a CVE whose trace carries no filename at all, rendered by its module
 *     (the gate leaves an uncited finding live, so the row must still print);
 *   - a CVE whose call-site file was EDITED after the scan: kept, line
 *     withheld, `[stale — re-run to confirm]` (#1622 sibling sweep);
 *   - a CVE whose call-site file was DELETED after the scan: kept and demoted,
 *     never dropped — `onMissing: "demote"`, because a Go CVE is pinned by
 *     go.mod and not by the call site (#1622 review H1);
 *   - a CVE marked false-positive: gone from the tier, present in the one
 *     suppressed-by-disposition notice as `govulncheck 1` (#1616/#1694 F1);
 *   - the display cap of five, with the `… and 1 more` remainder.
 *
 * The advisory tier itself is the thing the interface amendment added
 * (`TurnEndLaneParts.advisoryParts`), so this golden is also the proof that
 * the composer's tagged push carries a lane's advisory sections to the agent.
 *
 * The only doubles are process boundaries: `clients/pipeline.js` (it spawns
 * every configured linter) and the scanner RESULT cache, written through the
 * REAL `CacheManager` into the project's real cache directory — exactly what a
 * session_start scan leaves behind. The cache manager, the coordinator, the
 * freshness gate, the disposition store, the lane and the context injection are
 * all real.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pipeline = vi.hoisted(() => ({ runPipeline: vi.fn() }));
vi.mock("../clients/pipeline.js", () => pipeline);

import { CacheManager } from "../clients/cache-manager.js";
import { markDisposition } from "../clients/diagnostic-dispositions.js";
import type { GovulncheckResult } from "../clients/govulncheck-client.js";
import extension from "../index.js";
import { removeTempDirSync } from "./clients/test-utils.js";
import {
	makeContextWithSystemEvent,
	makeSessionStartEvent,
} from "./support/host-event-factory.js";
import { endMockSessions } from "./support/mock-session-teardown.js";
import { createPiMock, makeCtx } from "./support/pi-mock.js";

const SESSION_ID = "pi-1892-govulncheck-lane-session";
const SCAN_MS = Date.UTC(2026, 7, 18, 7, 0, 0);
const SCAN_AT = new Date(SCAN_MS).toISOString();

const GOLDEN = path.join(
	import.meta.dirname,
	"fixtures/witness/turn-end-lane-govulncheck/advisory-tier.txt",
);

let tmpDir: string;

beforeEach(() => {
	pipeline.runPipeline.mockReset();
	pipeline.runPipeline.mockResolvedValue({
		output: "",
		hasBlockers: false,
		isError: false,
		fileModified: false,
	});
	tmpDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-1892-gov-lane-")),
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

describe("#1892 witness: the turn-end govulncheck lane through pi", () => {
	it("matches the committed golden advisory tier", async () => {
		const live = writeAt(
			"internal/live.go",
			"package internal\n\nfunc A() {}\n",
			SCAN_MS - 5_000,
		);
		const markedContent = "package cmd\n\nfunc M() {}\n";
		const marked = writeAt("cmd/marked.go", markedContent, SCAN_MS - 5_000);
		const edited = writeAt(
			"internal/edited.go",
			"package internal\n\nfunc B() {}\n",
			SCAN_MS + 30_000,
		);
		const gone = writeAt(
			"internal/gone.go",
			"package internal\n",
			SCAN_MS - 5_000,
		);

		const cacheManager = new CacheManager(false);
		cacheManager.writeCache(
			"govulncheck",
			{
				success: true,
				scannedAt: SCAN_AT,
				findings: [
					{
						osv: "GO-2026-0101",
						module: "example.com/a",
						fixedVersion: "v1.2.3",
						summary: "request smuggling",
						trace: [{ filename: live, line: 12 }],
					},
					{
						osv: "GO-2026-0102",
						module: "example.com/b",
						summary: "unbounded read",
						trace: [{ filename: live, line: 30 }],
					},
					{
						osv: "GO-2026-0103",
						module: "example.com/nofile",
						fixedVersion: "v0.9.1",
						summary: "no reachable source position",
						trace: [],
					},
					{
						osv: "GO-2026-0104",
						module: "example.com/marked",
						fixedVersion: "v2.0.0",
						summary: "already triaged",
						trace: [{ filename: marked, line: 3 }],
					},
					{
						osv: "GO-2026-0105",
						module: "example.com/c",
						fixedVersion: "v3.1.0",
						summary: "edited call site",
						trace: [{ filename: edited, line: 7 }],
					},
					{
						osv: "GO-2026-0106",
						module: "example.com/d",
						fixedVersion: "v4.0.0",
						summary: "deleted call site",
						trace: [{ filename: gone, line: 9 }],
					},
					{
						osv: "GO-2026-0107",
						module: "example.com/e",
						summary: "second edited call site",
						trace: [{ filename: edited, line: 44 }],
					},
				],
			} satisfies GovulncheckResult,
			tmpDir,
		);
		// #1622 H1: the call site is gone, the module pin is not.
		fs.rmSync(gone);

		// The agent already judged GO-2026-0104, through the identity
		// `govulncheckFindingToProjectDiagnostic` surfaces — the real disposition
		// store, written exactly as `lens_diagnostic_mark` writes it.
		markDisposition(
			tmpDir,
			{
				cwd: tmpDir,
				filePath: marked,
				tool: "govulncheck",
				rule: "govulncheck:GO-2026-0104",
				message:
					"Vulnerability GO-2026-0104: already triaged (fixed in v2.0.0)",
				line: 3,
				content: markedContent,
			},
			"false-positive",
		);

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
				input: { path: edited },
				details: { diff: "+  1 alpha();" },
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
