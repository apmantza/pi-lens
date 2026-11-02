// mutation-lane: exclude
/**
 * #1892 witness (ADR 0007) — the pi HOST entry, not the engine seam.
 *
 * The fold tests in `tests/clients/runtime-turn-scanner-freshness-fold.test.ts`
 * call `handleTurnEnd` directly. This drives `index.ts`'s real registered
 * `session_start` / `turn_start` / `tool_result` / `turn_end` / `context`
 * handlers through the host mock and commits what the agent would actually
 * receive — plus the bounded freshness decision rows the turn wrote — as a
 * golden artifact under `tests/fixtures/witness/scanner-freshness/`.
 *
 * The only doubles are process boundaries: `clients/pipeline.js` (it spawns
 * every configured linter) and the scanner RESULT caches, which are written
 * through the REAL `CacheManager` into the project's real cache directory —
 * exactly what a session_start scan leaves behind and what turn_end reads. The
 * cache manager, the coordinator, the freshness gate, the disposition store and
 * the context injection are all real.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const logLatency = vi.hoisted(() => vi.fn());
vi.mock("../clients/latency-logger.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../clients/latency-logger.js")>()),
	logLatency,
}));

const pipeline = vi.hoisted(() => ({ runPipeline: vi.fn() }));
vi.mock("../clients/pipeline.js", () => pipeline);

import { CacheManager } from "../clients/cache-manager.js";
import { getDegradationSummary } from "../clients/degradation-ledger.js";
import type { GitleaksResult } from "../clients/gitleaks-client.js";
import type { GovulncheckResult } from "../clients/govulncheck-client.js";
import type { TrivyResult } from "../clients/trivy-client.js";
import extension from "../index.js";
import { removeTempDirSync } from "./clients/test-utils.js";
import {
	makeContextWithSystemEvent,
	makeSessionStartEvent,
} from "./support/host-event-factory.js";
import { endMockSessions } from "./support/mock-session-teardown.js";
import { createPiMock, makeCtx } from "./support/pi-mock.js";

const SESSION_ID = "pi-1892-witness-session";
const SCAN_MS = Date.UTC(2026, 7, 18, 7, 0, 0);
const SCAN_AT = new Date(SCAN_MS).toISOString();

const GOLDEN = path.join(
	import.meta.dirname,
	"fixtures/witness/scanner-freshness/turn-end-delivery.txt",
);

let tmpDir: string;

beforeEach(() => {
	logLatency.mockReset();
	pipeline.runPipeline.mockReset();
	pipeline.runPipeline.mockResolvedValue({
		output: "",
		hasBlockers: false,
		isError: false,
		fileModified: false,
	});
	tmpDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-1892-witness-")),
	);
});

afterEach(async () => {
	// #5146: end the sessions the case started before the fixture root goes.
	await endMockSessions();
	removeTempDirSync(tmpDir);
});

function writeAt(relative: string, mtimeMs: number): string {
	const file = path.join(tmpDir, relative);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, "const k = 'AKIA...';\n");
	fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
	return file;
}

/** The freshness decisions this turn wrote, normalized for the golden. */
function freshnessRows(): string[] {
	return logLatency.mock.calls
		.map((call) => call[0] as Record<string, unknown>)
		.filter(
			(entry) =>
				entry.phase === "finding_dead_path_drop" ||
				entry.phase === "finding_stale_line_demote",
		)
		.map((entry) => `${entry.phase} ${JSON.stringify(entry.metadata)}`);
}

describe("#1892 witness: pi turn_end → context, scanner freshness", () => {
	it("matches the committed golden delivery and decision rows", async () => {
		// One file both secret stores cite, edited after gitleaks' scan but
		// before trivy's; one deleted file both govulncheck and gitleaks cite.
		const shared = writeAt("src/shared.ts", SCAN_MS + 30_000);
		const gone = writeAt("gone/main.go", SCAN_MS - 5_000);
		const edited = writeAt("src/edited.ts", SCAN_MS - 5_000);

		const cacheManager = new CacheManager(false);
		cacheManager.writeCache(
			"gitleaks",
			{
				success: true,
				scannedAt: SCAN_AT,
				findings: [
					{
						ruleId: "aws-access-token",
						file: shared,
						startLine: 397,
						description: "AWS key",
					},
					{
						ruleId: "generic-api-key",
						file: gone,
						startLine: 1341,
						description: "Detected a Generic API Key",
					},
				],
			} satisfies GitleaksResult,
			tmpDir,
		);
		cacheManager.writeCache(
			"trivy",
			{
				success: true,
				scannedAt: new Date(SCAN_MS + 60_000).toISOString(),
				findings: [],
				secrets: [{ ruleId: "aws-access-key-id", file: shared, line: 234 }],
				licenses: [],
			} satisfies TrivyResult,
			tmpDir,
		);
		cacheManager.writeCache(
			"govulncheck",
			{
				success: true,
				scannedAt: SCAN_AT,
				findings: [
					{
						osv: "GO-2026-1234",
						module: "example.com/mod",
						fixedVersion: "v1.2.3",
						trace: [{ filename: gone, line: 88 }],
					},
				],
			} satisfies GovulncheckResult,
			tmpDir,
		);
		fs.rmSync(path.dirname(gone), { recursive: true, force: true });

		const pi = createPiMock();
		extension(pi.asExtensionAPI());
		// One ctx for the whole session, as pi hands each event its session's
		// own ctx. A turn ctx with no session id named a session nobody started,
		// so its turn-end write was dropped and counted (#4965).
		const ctx = makeCtx({ cwd: tmpDir, sessionId: SESSION_ID });
		await pi.emit("session_start", makeSessionStartEvent(), ctx);
		await pi.emit("turn_start", {}, ctx);
		await pi.emit(
			"tool_result",
			{
				toolName: "edit",
				input: { path: edited },
				details: { diff: "+  1 alpha();" },
				content: [{ type: "text", text: "base" }],
			},
			ctx,
		);
		await pi.emit("turn_end", {}, ctx);
		const injected = (await pi.emit(
			"context_with_system",
			makeContextWithSystemEvent([{ role: "user", content: "keep working" }]),
			ctx,
		)) as { messages?: Array<{ role?: string; content: string }> } | undefined;

		// #4631 round 5 (F2): the transcript leads with the host's system head, so the
		// golden records the messages pi-lens APPENDED. The assertion pins that the
		// head is still at index 0: a regression that dropped it would shift this
		// golden instead of slipping through.
		expect((injected?.messages ?? [])[0]?.role).toBe("system");
		const actual = [
			"=== context message the agent receives ===",
			(injected?.messages ?? [])
				.slice(1)
				.map((m) => m.content)
				.join("\n\n")
				.replaceAll(tmpDir, "<PROJECT>")
				.trimEnd(),
			"",
			"=== bounded freshness decision rows ===",
			...freshnessRows().map((row) => row.replaceAll(tmpDir, "<PROJECT>")),
			"",
			"=== degradation ledger ===",
			...getDegradationSummary()
				// #4530: npm and npx put the checkout's own `node_modules/.bin` on
				// the runner's PATH, and under untrusted trust the spawn seam drops
				// that entry with one record. That row describes how vitest was
				// launched, not this flow, so the golden leaves it out.
				.filter(
					(row) =>
						!(
							row.kind === "trust-refusal" &&
							row.latestReasons.every((entry) =>
								entry.subject.startsWith("project-path-entry:"),
							)
						),
				)
				.map((row) => row.kind),
			"",
		].join("\n");

		// Regenerate deliberately, never as a side effect of a failing run.
		if (process.env.PI_LENS_WITNESS_UPDATE === "1") {
			fs.mkdirSync(path.dirname(GOLDEN), { recursive: true });
			fs.writeFileSync(GOLDEN, actual);
		}
		expect(actual).toBe(fs.readFileSync(GOLDEN, "utf-8"));
	});
});
