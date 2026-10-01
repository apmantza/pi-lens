/**
 * #2526 round 2, F1: the `config_resolved` claim must be re-armed at the
 * SESSION BOUNDARY index.ts owns, not inside `handleSessionStart`.
 *
 * `tests/clients/config-resolved-phase.test.ts` drives
 * `loadLSPConfig -> handleSessionStart -> loadLSPConfig`, an ordering index.ts
 * never performs. The real closure is:
 *
 *   index.ts   ensureLSPConfigInitialized(ctx.cwd)   -> loadLSPConfig -> ROW
 *   index.ts   handleSessionStart(...)               -> (re-arm lived here)
 *
 * so a re-arm inside the handler fires BETWEEN the session's own two config
 * resolutions and the first session of a process writes TWO rows while every
 * later session — whose `ensureLSPConfigInitialized` is short-circuited by the
 * process-lifetime `_lspConfigInitializedCwds` memo — writes one. A smell that
 * counts rows per session cannot survive that.
 *
 * This file replays index.ts's own ordering through the pi mock, so a re-arm
 * that drifts back inside the handler reds here.
 *
 * ## Round 3, S1: no more hand-calling `loadLSPConfig` under quick mode
 *
 * The previous version of this file simulated "the deferred load" as a direct
 * `loadLSPConfig(cwd)` call after each emit, framed as standing in for
 * `runtime-session.ts`'s full-mode-only `setImmediate(() => loadLSPConfig(cwd))`.
 * That framing was WRONG under the `PI_LENS_STARTUP_MODE=quick` this file
 * forces in `beforeEach`: `allowBootstrapTasks = startupMode === "full"` gates
 * that `setImmediate` — under quick mode it is never scheduled at all, so the
 * hand-call exercised a code path that does not correspond to anything
 * production quick-mode sessions actually do. It also PAPERED OVER the real
 * defect the reviewer's own probe found: under quick (or minimal) mode, a
 * SECOND session in the same process for the SAME root schedules NO
 * resolution anywhere — `ensureLSPConfigInitialized`'s process-lifetime
 * `_lspConfigInitializedCwds` memo short-circuits the ensure, and neither the
 * quick-mode warm-up (gated on the ALREADY-tripped `__piLensWarmupScheduled`
 * process latch) nor the full-mode `setImmediate` (gated on `allowBootstrapTasks`,
 * false for quick/minimal) ever fires — so that session gets no
 * `config_resolution_pending` mark and no row, and the OLD `expected=true`
 * PREDICTION (deleted this round) called that session a defect every time.
 *
 * The tests below drive the REAL closure with no hand-calls standing in for
 * anything: a second quick-mode (and separately, minimal-mode) session in the
 * same process gets NEITHER a mark NOR a row, which is what makes the
 * analyzer's pending-mark join correctly exclude it. Forcing full startup mode
 * to get the real `setImmediate` deferred load would drag the whole scan
 * bootstrap (knip/jscpd/dep) into a wiring test for no added fidelity — the
 * "pending mark survives a resolution that fails mid-flight" case is instead
 * covered at the `loadLSPConfig` unit level
 * (`tests/clients/config-resolved-phase.test.ts`) and the "smell fires on a
 * pending mark with no row" case at the analyzer level
 * (`tests/scripts/analyze-config-resolution-smell.test.ts`), where mode is
 * irrelevant to what is under test.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import extension from "../index.js";
import {
	clearLatencyLog,
	flushLatencyLog,
	getLatencyLogPath,
} from "../clients/latency-logger.js";
import { _resetSessionLifecycleForTests } from "../clients/session-lifecycle.js";
import {
	flushSessionStartLog,
	SESSIONSTART_LOG_FILE,
} from "../clients/sessionstart-logger.js";
import { makeSessionStartEvent } from "./support/host-event-factory.js";
import { createPiMock, makeCtx } from "./support/pi-mock.js";
import { removeTempDirSync } from "./clients/test-utils.js";

// This file drives real session_starts with test mode off: each appends a
// `config_resolved` row to latency.log and `config resolved` lines to
// sessionstart.log, and beforeEach truncates latency.log. The harness's
// per-worker PI_LENS_HOME (#3721) keeps those writes off every other worker's
// sink; the loggers bind their paths at load, so the home is the harness's.

interface ConfigResolvedRow {
	filePath: string;
	metadata: { sessionId?: string; documents?: unknown[]; recordCount?: number };
}

async function configResolvedRows(): Promise<ConfigResolvedRow[]> {
	await flushLatencyLog();
	const file = getLatencyLogPath();
	const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
	return text
		.split(/\r?\n/)
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>)
		.filter((entry) => entry.phase === "config_resolved")
		.map((entry) => ({
			filePath: String(entry.filePath ?? ""),
			metadata: (entry.metadata ?? {}) as ConfigResolvedRow["metadata"],
		}));
}

function sessionStartOffset(): number {
	return fs.existsSync(SESSIONSTART_LOG_FILE)
		? fs.statSync(SESSIONSTART_LOG_FILE).size
		: 0;
}

async function sessionStartLinesSince(
	offset: number,
	needle: string,
): Promise<string[]> {
	await flushSessionStartLog();
	if (!fs.existsSync(SESSIONSTART_LOG_FILE)) return [];
	const buffer = fs.readFileSync(SESSIONSTART_LOG_FILE);
	const tail = buffer.length < offset ? buffer : buffer.subarray(offset);
	return tail
		.toString("utf8")
		.split(/\r?\n/)
		.filter((line) => line.includes(needle));
}

const roots: string[] = [];
let previousStartupMode: string | undefined;
let previousTestMode: string | undefined;

beforeEach(async () => {
	_resetSessionLifecycleForTests();
	previousStartupMode = process.env.PI_LENS_STARTUP_MODE;
	process.env.PI_LENS_STARTUP_MODE = "quick";
	previousTestMode = process.env.PI_LENS_TEST_MODE;
	process.env.PI_LENS_TEST_MODE = "0";
	clearLatencyLog();
	await flushLatencyLog();
});

afterEach(async () => {
	await flushLatencyLog();
	_resetSessionLifecycleForTests();
	if (previousStartupMode === undefined) {
		delete process.env.PI_LENS_STARTUP_MODE;
	} else {
		process.env.PI_LENS_STARTUP_MODE = previousStartupMode;
	}
	if (previousTestMode === undefined) delete process.env.PI_LENS_TEST_MODE;
	else process.env.PI_LENS_TEST_MODE = previousTestMode;
	const { resetLSPConfigStateForTests } =
		await import("../clients/lsp/config.js");
	resetLSPConfigStateForTests();
	for (const dir of roots.splice(0)) removeTempDirSync(dir);
});

/** A fresh workspace, so index.ts's process-lifetime cwd memo cannot skip it. */
function freshRoot(): string {
	const dir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-cfgres-wiring-")),
	);
	roots.push(dir);
	fs.writeFileSync(
		path.join(dir, ".pi-lens.json"),
		JSON.stringify({ lsp: { disabledServers: ["gopls"] } }),
	);
	return dir;
}

describe("index.ts session_start: ONE config_resolved row per session (#2526 R2 F1)", () => {
	it("ensure -> session_start writes exactly the session's one row", async () => {
		const root = freshRoot();
		const pi = createPiMock();
		extension(pi.asExtensionAPI());
		clearLatencyLog();
		await flushLatencyLog();

		// index.ts's own ordering: `ensureLSPConfigInitialized` resolves config
		// BEFORE `handleSessionStart` runs, both inside this one emit.
		await pi.emit(
			"session_start",
			makeSessionStartEvent(),
			makeCtx({ cwd: root, sessionId: "host-session-1" }),
		);
		expect(
			await configResolvedRows(),
			"the session_start ensure must write the session's row",
		).toHaveLength(1);
	}, 30000);

	/**
	 * #2526 review round 3, S1 — the reviewer's exact probe. The SAME root
	 * across two sessions, deliberately: index.ts's process-lifetime
	 * `_lspConfigInitializedCwds` memo short-circuits session 2's ensure, and
	 * under quick mode NOTHING else in `handleSessionStart` reaches
	 * `loadLSPConfig` either (the warm-up timer's own `__piLensWarmupScheduled`
	 * process latch is already tripped by session 1, and the full-mode-only
	 * `setImmediate` deferred load never applies). So session 2 gets neither a
	 * `config_resolution_pending` mark nor a `config_resolved` row — which is
	 * the CORRECT, healthy outcome the analyzer's pending-mark join must
	 * silently exclude, not the false "expected and missing" the deleted
	 * `expected=true` prediction used to report for every such session.
	 */
	it("a second quick-mode session in the same process schedules no load: no mark, no row", async () => {
		const root = freshRoot();
		const pi = createPiMock();
		extension(pi.asExtensionAPI());
		clearLatencyLog();
		await flushLatencyLog();

		await pi.emit(
			"session_start",
			makeSessionStartEvent(),
			makeCtx({ cwd: root, sessionId: "host-session-1" }),
		);
		expect(await configResolvedRows()).toHaveLength(1);

		const offset = sessionStartOffset();
		_resetSessionLifecycleForTests();
		await pi.emit(
			"session_start",
			makeSessionStartEvent({ reason: "new" }),
			makeCtx({ cwd: root, sessionId: "host-session-2" }),
		);

		expect(
			await configResolvedRows(),
			"a second quick-mode session for the same root must not add a row",
		).toHaveLength(1);
		expect(
			await sessionStartLinesSince(offset, "config_resolution_pending"),
			"a second quick-mode session for the same root must publish no pending mark",
		).toHaveLength(0);
	}, 30000);

	/**
	 * #2526 review round 3, S1 fixture: minimal mode behaves the same way as
	 * quick mode here, for a different reason — `allowBootstrapTasks` (gates the
	 * full-mode deferred load) and `quickMode` (gates the warm-up timer) are
	 * BOTH false for `startupMode === "minimal"`, so `handleSessionStart` never
	 * reaches `loadLSPConfig` at all, on ANY session. Only
	 * `ensureLSPConfigInitialized`'s first-session-per-cwd path in index.ts ever
	 * resolves config in minimal mode.
	 */
	it("a second minimal-mode session in the same process schedules no load: no mark, no row", async () => {
		const root = freshRoot();
		process.env.PI_LENS_STARTUP_MODE = "minimal";
		const pi = createPiMock();
		extension(pi.asExtensionAPI());
		clearLatencyLog();
		await flushLatencyLog();

		await pi.emit(
			"session_start",
			makeSessionStartEvent(),
			makeCtx({ cwd: root, sessionId: "host-session-1" }),
		);
		expect(await configResolvedRows()).toHaveLength(1);

		const offset = sessionStartOffset();
		_resetSessionLifecycleForTests();
		await pi.emit(
			"session_start",
			makeSessionStartEvent({ reason: "new" }),
			makeCtx({ cwd: root, sessionId: "host-session-2" }),
		);

		expect(
			await configResolvedRows(),
			"a second minimal-mode session for the same root must not add a row",
		).toHaveLength(1);
		expect(
			await sessionStartLinesSince(offset, "config_resolution_pending"),
			"a second minimal-mode session for the same root must publish no pending mark",
		).toHaveLength(0);
	}, 30000);

	it("the row's session id matches the pending mark's", async () => {
		const root = freshRoot();
		const pi = createPiMock();
		extension(pi.asExtensionAPI());
		clearLatencyLog();
		await flushLatencyLog();
		const offset = sessionStartOffset();

		await pi.emit(
			"session_start",
			makeSessionStartEvent(),
			makeCtx({ cwd: root, sessionId: "host-session-1" }),
		);

		const rows = await configResolvedRows();
		expect(rows).toHaveLength(1);
		const rowSessionId = rows[0].metadata.sessionId;
		expect(typeof rowSessionId, "the row must carry a session id").toBe(
			"string",
		);

		const lines = await sessionStartLinesSince(
			offset,
			"config_resolution_pending",
		);
		expect(
			lines,
			"ensureLSPConfigInitialized's loadLSPConfig call must publish this session's pending mark",
		).toHaveLength(1);
		expect(lines[0]).toContain(`session=${rowSessionId}`);
	}, 30000);

	/**
	 * #2552 review round 4, MEDIUM. The pending mark's `root=` must match the
	 * row's own `filePath` — the value the analyzer's (session, root) join
	 * compares. `freshRoot()` is already `realpathSync`-canonicalized, so it
	 * equals `normalizeFilePath`'s output on both hosts without this test
	 * re-deriving the normalization itself.
	 */
	it("the row's filePath matches the pending mark's root", async () => {
		const root = freshRoot();
		const pi = createPiMock();
		extension(pi.asExtensionAPI());
		clearLatencyLog();
		await flushLatencyLog();
		const offset = sessionStartOffset();

		await pi.emit(
			"session_start",
			makeSessionStartEvent(),
			makeCtx({ cwd: root, sessionId: "host-session-2" }),
		);

		const rows = await configResolvedRows();
		expect(rows).toHaveLength(1);

		const lines = await sessionStartLinesSince(
			offset,
			"config_resolution_pending",
		);
		expect(lines).toHaveLength(1);
		expect(
			lines[0],
			"the pending mark's root must be the row's own filePath",
		).toContain(`root=${rows[0].filePath}`);
	}, 30000);
});
