/**
 * Slice 5 of #4632: session identity on the REAL host.
 *
 * Moved here from three files that drove the hand-built pi double
 * (`tests/support/pi-mock.ts`): `tests/index-4554-last-member-teardown.test.ts`
 * (5 cases), `tests/index-multi-root-session-start.test.ts` (5 cases) and
 * `tests/index-config-resolved-session-wiring.test.ts` (all 5). Every case
 * below starts a real pi `AgentSession` over the BUILT extension
 * (`tests/support/pi-session.ts`, tier 2): pi loads `index.js` with its own
 * loader, emits every event, and mints every session id. A case therefore
 * reads the state the loaded copy wrote into the PROCESS (`getActiveSessionId`,
 * `getActivePrimaryRoot`, `getSecondarySessionCount`, the instance registry)
 * or the rows its own writers queued, never a value this file supplied.
 *
 * WHAT EACH CASE ASSERTS. Every case names its claim as `processing` (what pi
 * and the loaded copy do across a session's lifecycle) or `shape` (the state
 * the process holds afterwards).
 *
 * STATE TABLE — the cells each case covers. `reason` is the pi reason its
 * `session_start`/`session_shutdown` carries; `roots` is what lives under
 * this file's ONE fixture root; `config` is which config source the case
 * writes; `reads` is the record it asserts.
 *
 * | case | reason | roots | config | reads |
 * |---|---|---|---|---|
 * | primary last | startup ×4, quit ×4 | one primary + 3 siblings | none | primary registration, instances.json, `session_teardown_last_member` (absent) |
 * | non-last secondary leave | startup ×2, quit ×1 | primary + 1 sibling | none | primary registration, root set |
 * | sequential replacement | startup, new, quit | one root | none | both pi ids, primary registration, root |
 * | same-root second activation | startup ×2 | one root, two live sessions | none | secondary count, primary registration, root set |
 * | different-root decline | startup ×2 | two roots | none | secondary count, root set |
 * | decline another root | startup ×2 | two roots | none | classification, primary root, root set |
 * | secondary's own root | startup ×2 | two roots | none | root set |
 * | same-root secondary | startup ×2 | one root | none | root set |
 * | declined root registers | startup ×2 | two roots | none | root set order |
 * | declined same-root adds nothing | startup ×2 | one root | none | root set length |
 * | one config row | startup (quick) | one root | project `.pi-lens.json` | `config_resolved` |
 * | second quick session | startup, new (quick) | one root | project `.pi-lens.json` | `config_resolved`, `config_resolution_pending` |
 * | second minimal session | startup, new (minimal) | one root | project `.pi-lens.json` | `config_resolved`, `config_resolution_pending` |
 * | row/mark session id | startup (quick) | one root | project `.pi-lens.json` | `config_resolved.metadata.sessionId`, mark `session=` |
 * | row/mark root | startup (quick) | one root | project `.pi-lens.json` | `config_resolved.filePath`, mark `root=` |
 *
 * WHAT STAYS ON THE DOUBLE, with the probe that keeps it there (the PR body
 * carries the transcripts):
 *
 * - The one-activation-multi-member cells (#4554`runs the shared teardown once
 *   when the last session to leave is a secondary`, `records the one teardown a
 *   session classified secondary ran for`, `never releases a sibling's registry
 *   root when the primary leaves first`, `counts a re-delivered session_start`,
 *   and `r5 old activation…`). CLASS: `internal-seam` — the double pins the
 *   CLOSURE LOGIC of the teardown decision (which member of one activation is
 *   last, what that activation releases), never a production topology. pi
 *   1.3.0 runs the extension FACTORY once per session load
 *   (`dist/core/extensions/loader.js` `initializeExtension`), so a second live
 *   session is a SECOND activation and `startPiSession` cannot put two
 *   sessions on one activation; the host shape those cells model is #4704,
 *   where a primary's leave clears a live sibling's registry root. The double
 *   is the only seam that can drive the membership array itself, which is why
 *   the decision is pinned there and the outcome is pinned by #4704's own
 *   witness. Probe: with a primary and two siblings live under that double,
 *   the primary's own leave clears the sibling's registry root, because that
 *   activation's membership array holds only its own session.
 * - The late-shutdown cells (`r5 reconciles the superseded primary`,
 *   `r6 a superseded primary's delayed shutdown…`, the reload-gap cells).
 *   pi's `AgentSessionRuntime.teardownCurrent` AWAITS `session_shutdown`
 *   before `dispose()` invalidates the ctx, so a start beside a stale-but-live
 *   prior ctx is a payload the host never produces.
 * - The cases that interpose on a pi-lens module through `vi.mock`
 *   (`defineSessionStore` is a module-scope map a test-side definition cannot
 *   put into the loaded copy; `RuntimeCoordinator.prototype` spies, the
 *   `clients/lsp/capabilities` reset spy, the cache-attribution map, and the
 *   session sidecar readers).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { flushAllNdjsonWriters } from "../clients/ndjson-logger.js";
import { normalizeFilePath } from "../clients/path-utils.js";
import {
	_resetSessionLifecycleForTests,
	getActivePrimaryRoot,
	getActiveSessionId,
	getSecondarySessionCount,
} from "../clients/session-lifecycle.js";
import {
	_settleRegistryMutationsForTests,
	deregisterInstance,
	getInstanceRoots,
	readInstanceRegistry,
} from "../clients/instance-registry.js";
import { readNdjsonRows } from "./support/ndjson-rows.js";
import {
	fauxAssistantMessage,
	fauxText,
	piSessionFixture,
	startPiSession,
} from "./support/pi-session.js";

const fixture = piSessionFixture();

/** The scripted provider answer every start below uses. */
const READY = fauxAssistantMessage(fauxText("ready"));

/** The project root for one case: a fresh cwd UNDER this file's one fixture. */
function projectRoot(...segments: string[]): string {
	return path.join(fixture.root, ...segments, "proj");
}

/** A project root carrying its own `.pi-lens.json` (the config-source cell). */
function configuredRoot(...segments: string[]): string {
	const cwd = projectRoot(...segments);
	fs.mkdirSync(cwd, { recursive: true });
	fs.writeFileSync(
		path.join(cwd, ".pi-lens.json"),
		JSON.stringify({ lsp: { disabledServers: ["go"] } }),
	);
	return cwd;
}

/**
 * A fixture path in the form the loaded copy STORES it: the instance registry
 * writes `normalizeFilePath(projectRoot)` and the latency logger writes
 * `normalizeLoggedPath(filePath)`, both of which fold `\` to `/` and adopt the
 * filesystem's casing. A native `fs.realpathSync` or `path.resolve` returns
 * backslashes on win32 and never compares equal to either (#2129 child paths).
 */
function realRoot(cwd: string): string {
	return normalizeFilePath(cwd);
}

/** The process's active primary root, in the form the copy stores it. Throws
 *  rather than comparing `undefined`, so a missing registration can never read
 *  as a passing identity. */
function activePrimaryRoot(): string {
	const root = getActivePrimaryRoot();
	if (root === undefined) throw new Error("no active primary root");
	return normalizeFilePath(root);
}

/**
 * The rows the LOADED copy's latency writer queued. `flushAllNdjsonWriters()`
 * reaches the same process-global writer map from this side, and the shared
 * reader sits inside this helper with no await between the flush and the read
 * (AGENTS.md shape 67). A line the reader cannot parse is REPORTED, never
 * dropped, and each caller asserts `skipped` is zero.
 */
async function latencyRows() {
	await flushAllNdjsonWriters();
	return readNdjsonRows(
		path.join(process.env.PI_LENS_HOME ?? "", "latency.log"),
	);
}

/**
 * One `key=` token from a `config_resolution_pending` mark. Token equality,
 * never `includes`: a mutation that narrows the mark's root to a child of the
 * row's root still CONTAINS it as a substring, so a substring assertion cannot
 * see that drift (found by the slice-5 mutation run).
 */
function markToken(line: string, key: string): string | undefined {
	return line.split(`${key}=`)[1]?.split(" ")[0];
}

/** The `config_resolution_pending` marks the loaded copy's writer queued. */
async function pendingMarks(): Promise<string[]> {
	return (await sessionStartLines()).filter((line) =>
		line.includes("config_resolution_pending"),
	);
}

/** The `sessionstart.log` lines the loaded copy's writer queued. */
async function sessionStartLines(): Promise<string[]> {
	await flushAllNdjsonWriters();
	const file = path.join(process.env.PI_LENS_HOME ?? "", "sessionstart.log");
	if (!fs.existsSync(file)) return [];
	return fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
}

/**
 * The roots THIS process's registry entry holds, after joining the loaded
 * copy's queued registry mutations: #2146 keys that tail on `globalThis`, so
 * this join reaches the copy's own writes rather than racing them.
 */
async function registryRoots(): Promise<string[]> {
	await _settleRegistryMutationsForTests();
	const entry = (await readInstanceRegistry()).find(
		(candidate) => candidate.pid === process.pid,
	);
	return entry ? getInstanceRoots(entry) : [];
}

/** The phase rows a case's own root owns (every row is path-attributed). */
async function phaseRowsAt(
	phase: string,
	cwd: string,
): Promise<Array<Record<string, unknown>>> {
	const read = await latencyRows();
	expect(
		read.skipped,
		"a torn line would shorten the trace this case reads",
	).toBe(0);
	return read.rows.filter(
		(row) => row.phase === phase && row.filePath === realRoot(cwd),
	);
}

/**
 * Each case starts from the process state a fresh process would have: the
 * helper disposed every handle of the previous case, so the registrations ARE
 * gone; this reset is the one seam that also proves it, and it keeps a failing
 * case from cascading into the next one (`_resetSessionLifecycleForTests` is a
 * process-singleton reset, so the loaded copy sees it too). The registry
 * entry is keyed by pid, so the cleanup must name the home the CASES read:
 * `registryPath()` resolves `getGlobalPiLensDir()` from the live env, and
 * `startPiSession` pins `<fixture>/home` for the case. Pin that same value
 * here, then put the caller's value back.
 */
beforeEach(async () => {
	_resetSessionLifecycleForTests();
	// This cleanup WRITES a producer's registry (`deregisterInstance`), so it
	// must not run against the run-shared home (`tests/clients/
	// pi-lens-home-hermeticity.test.ts`, #3042): pin this file's own fixture
	// home for the hook — the same one `startPiSession` pins for the case —
	// then put the caller's value back. The helper's own `savedEnv` therefore
	// records the caller's home, not this one.
	const callerHome = process.env.PI_LENS_HOME;
	process.env.PI_LENS_HOME = path.join(fixture.root, "home");
	try {
		await _settleRegistryMutationsForTests();
		deregisterInstance();
		await _settleRegistryMutationsForTests();
	} finally {
		if (callerHome === undefined) delete process.env.PI_LENS_HOME;
		else process.env.PI_LENS_HOME = callerHome;
	}
});

describe("#4632 slice 5: session identity on the real host", () => {
	describe("shared-infra teardown (#4554)", () => {
		it("releases the primary registration when the primary is the last session to leave", async () => {
			// Processing: the primary is the LAST member of the process to leave,
			// and the shared teardown must run for it. Shape: every registration it
			// held is gone afterwards.
			const primaryCwd = projectRoot("primary-last");
			const primary = await startPiSession({
				root: fixture.root,
				cwd: primaryCwd,
				responses: [READY],
			});
			const primaryId = primary.session.sessionManager.getSessionId();
			const siblings = [];
			for (const suffix of ["s1", "s2", "s3"]) {
				siblings.push(
					await startPiSession({
						root: fixture.root,
						cwd: projectRoot(`primary-last-${suffix}`),
						responses: [READY],
					}),
				);
			}
			expect(getActiveSessionId()).toBe(primaryId);
			expect(getSecondarySessionCount()).toBe(3);
			expect(await registryRoots()).toContain(realRoot(primaryCwd));

			for (const sibling of siblings) await sibling.dispose();
			expect(getSecondarySessionCount()).toBe(0);
			// A sibling's leave is local-only: the primary still owns the entry.
			expect(getActiveSessionId()).toBe(primaryId);
			expect(await registryRoots()).toContain(realRoot(primaryCwd));

			await primary.dispose();

			expect(getActiveSessionId()).toBeUndefined();
			expect(getActivePrimaryRoot()).toBeUndefined();
			expect(getSecondarySessionCount()).toBe(0);
			expect(await registryRoots()).not.toContain(realRoot(primaryCwd));
			// The shared branch ran on the primary's behalf, so it recorded no
			// `session_teardown_last_member` row: that record names a SECONDARY's
			// last leave (the case below the sibling one covers its presence).
			expect(
				await phaseRowsAt("session_teardown_last_member", primaryCwd),
			).toHaveLength(0);
		}, 60_000);

		it("leaves the shared infrastructure alone when a secondary leaves while the primary is live", async () => {
			// Processing: a secondary's leave is local-only. Shape: the primary's
			// registration and root survive it.
			const primaryCwd = projectRoot("non-last-primary");
			const secondaryCwd = projectRoot("non-last-secondary");
			const primary = await startPiSession({
				root: fixture.root,
				cwd: primaryCwd,
				responses: [READY],
			});
			const primaryId = primary.session.sessionManager.getSessionId();
			const secondary = await startPiSession({
				root: fixture.root,
				cwd: secondaryCwd,
				responses: [READY],
			});
			expect(getSecondarySessionCount()).toBe(1);

			await secondary.dispose();

			expect(getActiveSessionId()).toBe(primaryId);
			expect(getSecondarySessionCount()).toBe(0);
			expect(await registryRoots()).toContain(realRoot(primaryCwd));
			// Its own root is gone; the primary's is not.
			expect(await registryRoots()).not.toContain(realRoot(secondaryCwd));
			expect(
				await phaseRowsAt("session_teardown_last_member", secondaryCwd),
			).toHaveLength(0);

			await primary.dispose();
			expect(getActiveSessionId()).toBeUndefined();
		}, 60_000);

		it("admits a new-session replacement as the primary after the old primary leaves", async () => {
			// Processing: pi's own `/new` replays shutdown(new) then start(new).
			// Shape: the old id is released, the successor owns the registration
			// and the root, and it is not counted as a secondary.
			const cwd = projectRoot("sequential-replacement");
			const first = await startPiSession({
				root: fixture.root,
				cwd,
				responses: [READY],
			});
			const firstId = first.session.sessionManager.getSessionId();
			expect(getActiveSessionId()).toBe(firstId);

			const next = await first.restart({ reason: "new" }, [READY]);
			const nextId = next.session.sessionManager.getSessionId();

			expect(nextId).not.toBe(firstId);
			expect(getActiveSessionId()).toBe(nextId);
			expect(getSecondarySessionCount()).toBe(0);
			expect(activePrimaryRoot()).toBe(realRoot(cwd));
			expect(await registryRoots()).toContain(realRoot(cwd));

			await next.dispose();
			expect(getActiveSessionId()).toBeUndefined();
		}, 60_000);

		it("keeps a second activation's same-root secondary session local-only", async () => {
			// Processing: two live sessions in ONE root; the second is a
			// concurrent secondary. Shape: its leave drops no shared state.
			const cwd = projectRoot("same-root-activation");
			const host = await startPiSession({
				root: fixture.root,
				cwd,
				responses: [READY],
			});
			const hostId = host.session.sessionManager.getSessionId();
			const secondary = await startPiSession({
				root: fixture.root,
				cwd,
				responses: [READY],
			});
			expect(getSecondarySessionCount()).toBe(1);
			expect(getActiveSessionId()).toBe(hostId);

			await secondary.dispose();

			expect(getActiveSessionId()).toBe(hostId);
			expect(getSecondarySessionCount()).toBe(0);
			// The same directory added nothing, so its leave removes nothing.
			expect(await registryRoots()).toEqual([realRoot(cwd)]);

			await host.dispose();
			expect(getActiveSessionId()).toBeUndefined();
			expect(await registryRoots()).toEqual([]);
		}, 60_000);

		it("keeps a different-root start's decline local-only", async () => {
			// Processing: a start in another root behind a live primary is
			// declined, and adds its root. Shape: its leave removes only that root.
			const hostCwd = projectRoot("decline-host");
			const secondaryCwd = projectRoot("decline-secondary");
			const host = await startPiSession({
				root: fixture.root,
				cwd: hostCwd,
				responses: [READY],
			});
			const hostId = host.session.sessionManager.getSessionId();
			const secondary = await startPiSession({
				root: fixture.root,
				cwd: secondaryCwd,
				responses: [READY],
			});
			expect(getSecondarySessionCount()).toBe(1);
			expect(await registryRoots()).toEqual(
				expect.arrayContaining([realRoot(hostCwd), realRoot(secondaryCwd)]),
			);

			await secondary.dispose();

			expect(getActiveSessionId()).toBe(hostId);
			expect(getSecondarySessionCount()).toBe(0);
			expect(await registryRoots()).toEqual([realRoot(hostCwd)]);

			await host.dispose();
			expect(getActiveSessionId()).toBeUndefined();
			expect(await registryRoots()).toEqual([]);
		}, 60_000);
	});

	describe("per-root session_start classification (#2129/#2130)", () => {
		it("declines a start in another root behind a live primary", async () => {
			// Processing: root identity decides; the newcomer is a
			// concurrent-secondary and never becomes the advertised root.
			const hostCwd = projectRoot("root-identity-host");
			const otherCwd = projectRoot("root-identity-other");
			const host = await startPiSession({
				root: fixture.root,
				cwd: hostCwd,
				responses: [READY],
			});
			const hostId = host.session.sessionManager.getSessionId();
			const other = await startPiSession({
				root: fixture.root,
				cwd: otherCwd,
				responses: [READY],
			});

			expect(getSecondarySessionCount()).toBe(1);
			expect(getActiveSessionId()).toBe(hostId);
			expect(activePrimaryRoot()).toBe(realRoot(hostCwd));
			expect(activePrimaryRoot()).not.toBe(realRoot(otherCwd));

			await other.dispose();
			await host.dispose();
		}, 60_000);

		it("a secondary's shutdown drops only its OWN root", async () => {
			// Shape: the root set after a secondary's leave is the host's alone.
			const hostCwd = projectRoot("own-root-host");
			const secondaryCwd = projectRoot("own-root-secondary");
			const host = await startPiSession({
				root: fixture.root,
				cwd: hostCwd,
				responses: [READY],
			});
			const secondary = await startPiSession({
				root: fixture.root,
				cwd: secondaryCwd,
				responses: [READY],
			});
			expect(await registryRoots()).toHaveLength(2);

			await secondary.dispose();

			const roots = await registryRoots();
			expect(roots).toHaveLength(1);
			expect(roots[0]).toBe(realRoot(hostCwd));
			await host.dispose();
		}, 60_000);

		it("a secondary sharing the host's root drops nothing", async () => {
			// Shape: a same-root secondary adds no root, so its leave removes none.
			const cwd = projectRoot("shared-root");
			const host = await startPiSession({
				root: fixture.root,
				cwd,
				responses: [READY],
			});
			const secondary = await startPiSession({
				root: fixture.root,
				cwd,
				responses: [READY],
			});
			expect(getSecondarySessionCount()).toBe(1);
			expect(await registryRoots()).toEqual([realRoot(cwd)]);

			await secondary.dispose();

			expect(await registryRoots()).toEqual([realRoot(cwd)]);
			await host.dispose();
		}, 60_000);

		it("a declined root still registers itself, behind the primary", async () => {
			// Shape: a declined start adds its root (the shared-checkout guard and
			// warm attach need to see it), and the host root stays index 0.
			const hostCwd = projectRoot("declined-registers-host");
			const declinedCwd = projectRoot("declined-registers-other");
			const host = await startPiSession({
				root: fixture.root,
				cwd: hostCwd,
				responses: [READY],
			});
			const declined = await startPiSession({
				root: fixture.root,
				cwd: declinedCwd,
				responses: [READY],
			});

			const roots = await registryRoots();
			expect(roots).toHaveLength(2);
			expect(roots[0]).toBe(realRoot(hostCwd));
			expect(roots[1]).toBe(realRoot(declinedCwd));

			await declined.dispose();
			await host.dispose();
		}, 60_000);

		it("a declined same-root start adds nothing to the set", async () => {
			// Shape: the root add runs for any readable cwd; the dedupe is what
			// makes a same-root bind a no-op.
			const cwd = projectRoot("same-root-decline");
			const host = await startPiSession({
				root: fixture.root,
				cwd,
				responses: [READY],
			});
			const secondary = await startPiSession({
				root: fixture.root,
				cwd,
				responses: [READY],
			});

			expect(await registryRoots()).toHaveLength(1);
			await secondary.dispose();
			await host.dispose();
		}, 60_000);
	});

	describe("config resolution at the session boundary (#2526 R2/#2552)", () => {
		it("writes exactly the session's one config_resolved row", async () => {
			// Shape: ONE row per (session, root), describing THIS project's config.
			const cwd = configuredRoot("config-one-row");
			const handle = await startPiSession({
				root: fixture.root,
				cwd,
				startupMode: "quick",
				responses: [READY],
			});

			const rows = await phaseRowsAt("config_resolved", cwd);
			expect(rows).toHaveLength(1);
			const metadata = rows[0]?.metadata as
				| { deniedServers?: number }
				| undefined;
			expect(metadata?.deniedServers).toBe(1);
			await handle.dispose();
		}, 60_000);

		it("a second quick-mode session for the same root schedules no load: no mark, no row", async () => {
			// Processing: the process-lifetime cwd memo short-circuits the second
			// session's ensure, and quick mode schedules nothing else. Shape: the
			// one (session, root) row and mark are the first session's.
			const cwd = configuredRoot("config-second-quick");
			const first = await startPiSession({
				root: fixture.root,
				cwd,
				startupMode: "quick",
				responses: [READY],
			});
			expect(await phaseRowsAt("config_resolved", cwd)).toHaveLength(1);
			const root = realRoot(cwd);
			const marksBefore = (await pendingMarks()).filter(
				(line) => markToken(line, "root") === root,
			);
			expect(marksBefore).toHaveLength(1);

			const second = await first.restart({ reason: "new" }, [READY]);

			expect(await phaseRowsAt("config_resolved", cwd)).toHaveLength(1);
			const marksAfter = (await pendingMarks()).filter(
				(line) => markToken(line, "root") === root,
			);
			expect(marksAfter).toHaveLength(1);
			expect(getActiveSessionId()).toBe(
				second.session.sessionManager.getSessionId(),
			);
			await second.dispose();
		}, 90_000);

		it("a second minimal-mode session for the same root schedules no load: no mark, no row", async () => {
			// Processing: in minimal mode the ONLY resolution path is the ensure,
			// and the same cwd memo covers it. Shape: still one row and one mark.
			const cwd = configuredRoot("config-second-minimal");
			const first = await startPiSession({
				root: fixture.root,
				cwd,
				startupMode: "minimal",
				responses: [READY],
			});
			expect(await phaseRowsAt("config_resolved", cwd)).toHaveLength(1);
			const root = realRoot(cwd);

			const second = await first.restart({ reason: "new" }, [READY]);

			expect(await phaseRowsAt("config_resolved", cwd)).toHaveLength(1);
			expect(
				(await pendingMarks()).filter(
					(line) => markToken(line, "root") === root,
				),
			).toHaveLength(1);
			await second.dispose();
		}, 90_000);

		it("the row's session id matches the pending mark's", async () => {
			// Shape: the mark and the row are stamped from one session-record read.
			const cwd = configuredRoot("config-session-id");
			const handle = await startPiSession({
				root: fixture.root,
				cwd,
				startupMode: "quick",
				responses: [READY],
			});
			const rows = await phaseRowsAt("config_resolved", cwd);
			expect(rows).toHaveLength(1);
			const metadata = rows[0]?.metadata as { sessionId?: unknown } | undefined;
			const sessionId = metadata?.sessionId;
			expect(typeof sessionId).toBe("string");
			expect(
				(await pendingMarks()).filter(
					(line) => markToken(line, "session") === String(sessionId),
				),
			).toHaveLength(1);
			await handle.dispose();
		}, 60_000);

		it("the row's filePath matches the pending mark's root", async () => {
			// Shape: `configResolutionKey` gives the mark and the row one root.
			const cwd = configuredRoot("config-row-root");
			const handle = await startPiSession({
				root: fixture.root,
				cwd,
				startupMode: "quick",
				responses: [READY],
			});
			const rows = await phaseRowsAt("config_resolved", cwd);
			expect(rows).toHaveLength(1);
			expect(rows[0]?.filePath).toBe(realRoot(cwd));
			const marks = (await pendingMarks())
				.map((line) => markToken(line, "root"))
				.filter((token) => token !== undefined);
			expect(marks.filter((token) => token === rows[0]?.filePath)).toHaveLength(
				1,
			);
			await handle.dispose();
		}, 60_000);
	});
});
