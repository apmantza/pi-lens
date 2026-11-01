/**
 * #2129 wiring. `tests/clients/session-start-total-classification.test.ts`
 * proves `handleSessionStart` logs `deps.sessionStartClassification`/
 * `sessionStartSameRoot` alongside `session_start_total`'s `mode` field. It
 * cannot prove index.ts's `session_start` handler actually SUPPLIES those
 * deps from `decideSessionStart`'s own decision — drop the two fields from
 * the call site and that unit test still passes. This file drives the real
 * handler, so a call site that stops threading the decision through reds here.
 *
 * #4632 slice 9 moved three of the four decisions onto tier 2: the sessions are
 * pi's own (a real `AgentSession` over the built extension), the dead prior ctx
 * is `ExtensionRunner.invalidate()` — the call `AgentSession.dispose()` makes —
 * and the rows are read from the home the LOADED copy pinned. What each case
 * claims:
 *
 * - a fresh start is `primary` with `sameRoot: "unknown"` (processing: the
 *   classifier's decision reaches the row through pi's own start);
 * - a start after a dead prior ctx in the SAME root is `sequential-replacement`,
 *   `sameRoot: true` (the row a start with no `session_shutdown` produces);
 * - a start in ANOTHER root after a dead prior ctx is refused as
 *   `secondary-root` (`sameRoot: false` in the `concurrent_session_bind` row,
 *   no `session_start_total` row) — the arm #2129 added for root identity.
 *
 * Neither moved case is pi's replacement entry point, and neither claims to be:
 * probed on host 1.3.0, `AgentSessionRuntime.newSession()` emits
 * `session_shutdown` before it disposes (`agent-session-runtime.js`
 * `teardownCurrent`), so pi-lens releases the primary and the successor
 * classifies `primary` with `basis: "no-prior-primary"`. The cases below pin
 * the classifier's prior-ctx-dead arm, which a start with NO
 * `session_shutdown` reaches (review F2 on #4702).
 *
 * The last case stays on the double: it needs a start whose cwd is a
 * `pi-agent-*` staging root under the real tmpdir that no checkout owns, and
 * the tier-2 helper keeps every cwd under its own fixture (which plants `.git`,
 * making an owned root). See the case for the class.
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
import { makeSessionStartEvent } from "./support/host-event-factory.js";
import { readNdjsonRows } from "./support/ndjson-rows.js";
import { endMockSessions } from "./support/mock-session-teardown.js";
import { createPiMock, makeCtx } from "./support/pi-mock.js";
import {
	fauxAssistantMessage,
	fauxText,
	piSessionFixture,
	startPiSession,
} from "./support/pi-session.js";
import { removeTempDirSync } from "./clients/test-utils.js";

type SessionStartTotalRecord = {
	phase: "session_start_total";
	metadata: {
		mode: string;
		classification?: string;
		sameRoot: boolean | "unknown";
	};
};

type Row = Record<string, unknown>;

/**
 * Every row a sink holds. A line this read cannot parse is a red with its
 * count: every claim here is an exact row count, and a torn line would hide the
 * very row it counts (`tests/support/ndjson-rows.ts`).
 */
function rowsAt(filePath: string): Row[] {
	const read = readNdjsonRows(filePath);
	expect(read.skipped).toBe(0);
	return read.rows;
}

/** The `session_start_total` rows among `rows`, with `sameRoot` type-checked. */
function sessionStartTotals(rows: Row[]): SessionStartTotalRecord[] {
	return rows
		.filter((entry) => entry.phase === "session_start_total")
		.map((entry) => {
			const metadata = entry.metadata;
			if (!metadata || typeof metadata !== "object") {
				throw new Error("session_start_total metadata is missing");
			}
			const typed = metadata as Record<string, unknown>;
			if (
				typed.sameRoot !== true &&
				typed.sameRoot !== false &&
				typed.sameRoot !== "unknown"
			) {
				throw new Error("session_start_total sameRoot is not explicit");
			}
			return {
				phase: "session_start_total",
				metadata,
			} as SessionStartTotalRecord;
		});
}

/**
 * The `session_start_total` rows one project directory's start wrote, read from
 * the log the LOADED copy pinned (`latencyRows()` drains first: the writer map
 * is process-global, shape 67). The row's own `filePath` is the start's cwd, so
 * a claim is scoped to its session even though the fixture home is shared with
 * every other case in this file.
 */
async function totalsForStart(
	handle: Awaited<ReturnType<typeof startPiSession>>,
	cwd: string,
): Promise<SessionStartTotalRecord[]> {
	const read = await handle.latencyRows();
	expect(read.skipped).toBe(0);
	return sessionStartTotals(read.rows.filter((row) => row.filePath === cwd));
}

const fixture = piSessionFixture();

describe("index session_start wiring — classification logged with mode (#2129)", () => {
	let hostRoot: string;
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
		hostRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-host-root-"));
	});

	afterEach(async () => {
		// #5146: end the sessions the case started before the log is flushed.
		await endMockSessions();
		await flushLatencyLog();
		_resetSessionLifecycleForTests();
		if (previousStartupMode === undefined) {
			delete process.env.PI_LENS_STARTUP_MODE;
		} else {
			process.env.PI_LENS_STARTUP_MODE = previousStartupMode;
		}
		if (previousTestMode === undefined) delete process.env.PI_LENS_TEST_MODE;
		else process.env.PI_LENS_TEST_MODE = previousTestMode;
		removeTempDirSync(hostRoot);
	});

	it("a fresh primary start's session_start_total carries classification=primary", async () => {
		// Tier 2 (#4632): a REAL pi session at this fixture's root, so the
		// `session_start` the row describes is the host's own start with pi's
		// own ctx and session manager, not a hand-built event. The row is read
		// from the home the loaded copy pinned, after `dispose()` emitted
		// `session_shutdown` and pi awaited the copy's writer drain.
		//
		// The shape is QUICK: the mode a real process's FIRST `session_start`
		// takes (the cold-start heuristic in `clients/runtime-session.ts`), so
		// the row asserts `mode: "quick"` exactly as the double-based version of
		// this case did. The helper opts the quick mode's warmup timer out (its
		// persist has no test-side drain); the START shape is what this case
		// pins (#4664 F3).
		const cwd = path.join(fixture.root, "primary", "proj");
		const handle = await startPiSession({
			root: fixture.root,
			cwd,
			responses: [fauxAssistantMessage(fauxText("ready"))],
			startupMode: "quick",
		});
		await handle.prompt("hello");
		await handle.dispose();
		expect(handle.errors).toEqual([]);

		const totals = await totalsForStart(handle, cwd);
		expect(totals).toHaveLength(1);
		expect(totals[0].metadata).toMatchObject({
			mode: "quick",
			classification: "primary",
			sameRoot: "unknown",
		});
	}, 30_000);

	it("a start after a dead prior ctx in the same root carries classification + sameRoot:true", async () => {
		// Tier 2 (#4632 slice 9): the prior primary's ctx is invalidated by pi
		// and never reaches `session_shutdown`, the crash/kill path index.ts
		// documents ("on the sequential-replacement path (prior primary never
		// reached session_shutdown)"). The successor is pi's own second session in
		// the SAME root, so the classifier compares two real roots.
		const cwd = path.join(fixture.root, "replacement", "proj");
		const first = await startPiSession({
			root: fixture.root,
			cwd,
			responses: [fauxAssistantMessage(fauxText("first"))],
			startupMode: "quick",
		});
		await first.prompt("hello");
		first.session.extensionRunner.invalidate();
		const second = await startPiSession({
			root: fixture.root,
			cwd,
			responses: [fauxAssistantMessage(fauxText("second"))],
			startupMode: "quick",
		});
		await second.prompt("again");

		// Both starts are this cwd's: the first `primary`, the replacement
		// `sequential-replacement`.
		const totals = await totalsForStart(second, cwd);
		expect(totals).toHaveLength(2);
		expect(totals[0].metadata.classification).toBe("primary");
		expect(totals[1].metadata).toMatchObject({
			mode: "quick",
			classification: "sequential-replacement",
			sameRoot: true,
		});
	}, 60_000);

	it("a replacement in a different root is refused with sameRoot:false", async () => {
		// Tier 2 (#4632 slice 9): a start in ANOTHER root after a dead prior
		// primary is refused by the #2129 root rule — `secondary-root`, not the
		// full start — and that refusal is the row that carries `sameRoot:false`.
		// The double-based version of this case re-announced the SAME ctx object
		// with a mutated cwd, a state pi never produces (pi builds a fresh ctx
		// per emit and invalidates every getter on the old runner), and pi's own
		// replacement emits `session_shutdown` first, so neither is used here: a
		// dead prior ctx plus a second root is the state the rule answers.
		const first = await startPiSession({
			root: fixture.root,
			cwd: path.join(fixture.root, "root-a", "proj"),
			responses: [fauxAssistantMessage(fauxText("first"))],
			startupMode: "quick",
		});
		await first.prompt("hello");
		const firstCwd = first.cwd;
		const secondCwd = path.join(fixture.root, "root-b", "proj");

		first.session.extensionRunner.invalidate();
		const declined = await startPiSession({
			root: fixture.root,
			cwd: secondCwd,
			responses: [fauxAssistantMessage(fauxText("second"))],
			startupMode: "quick",
		});

		const read = await declined.latencyRows();
		// The row names the root it compared against, so a sibling case's refusal
		// in another root is not this one's.
		const binds = read.rows
			.filter((row) => row.phase === "concurrent_session_bind")
			.map((row) => row.metadata as Record<string, unknown>)
			.filter((metadata) => metadata.primaryRoot === firstCwd);
		expect(binds).toEqual([
			expect.objectContaining({
				classification: "secondary-root",
				sameRoot: false,
			}),
		]);
		// A refused start never reaches `handleSessionStart`, so it writes no
		// total row. That absence is the claim: the root rule ran.
		expect(
			sessionStartTotals(read.rows.filter((row) => row.filePath === secondCwd)),
		).toEqual([]);
	}, 60_000);

	it("a declined temp-root start never reaches session_start_total", async () => {
		// STAYS on the double (#4632 slice 9): class `unproducible-payload`.
		// The decline needs a start whose cwd is a `pi-agent-*` staging root
		// under the real tmpdir that no checkout owns; the tier-2 helper keeps
		// every cwd under its own fixture root, and that root carries the
		// harness's `.git` marker, so a directory under it is an owned root and
		// never declines. Writing the staging root outside the fixture would
		// put an unowned entry at the shared tmp root, which the tmp-fixture
		// hygiene census owns.
		const pi = createPiMock();
		extension(pi.asExtensionAPI());
		clearLatencyLog();
		await flushLatencyLog();
		const tempWorktree = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-pi-agent-worktree-"),
		);
		try {
			const hostCtx = makeCtx({ cwd: hostRoot, sessionId: "host-session" });
			await pi.emit("session_start", makeSessionStartEvent(), hostCtx);
			// Make the host ctx read as invalidated, the way the SDK does after a
			// session replacement, so the second start is a replacement decision.
			Object.defineProperty(hostCtx as object, "isIdle", {
				configurable: true,
				get() {
					throw new Error(
						"This extension ctx is stale after session replacement or reload.",
					);
				},
			});
			await pi.emit(
				"session_start",
				makeSessionStartEvent(),
				makeCtx({ cwd: tempWorktree, sessionId: "subagent-session" }),
			);
			await flushLatencyLog();

			// Only the host's own start reached the full body; the declined
			// temp-root start returned before handleSessionStart ever ran.
			expect(sessionStartTotals(rowsAt(getLatencyLogPath()))).toHaveLength(1);
		} finally {
			removeTempDirSync(tempWorktree);
		}
	}, 30_000);
});
