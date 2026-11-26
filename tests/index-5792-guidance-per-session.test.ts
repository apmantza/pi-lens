/**
 * #5792: the session-start guidance record answers to the session that wrote
 * it.
 *
 * The defect: a full `session_start` writes the guidance to the per-project
 * `session-start-guidance` record, and the `context` hook of the next request
 * consumed it (`consumeSessionStartGuidance`, `clients/runtime-context.ts`)
 * with no reader identity. Two sessions in one workspace (an in-process
 * subagent, #473) share that record: whichever session prompted first took
 * it, and the session that wrote it received nothing.
 *
 * Tier 2 (#4632): the BUILT extension in real pi `AgentSession`s. The second
 * session starts while the first is live, so its `session_start` is declined
 * as a concurrent secondary (#4704) and writes no guidance of its own; the
 * primary's record is the only one, and only the primary may take it.
 *
 * Lane: ubuntu Unit tests.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { CacheManager } from "../clients/cache-manager.js";
import { getProjectDataDir } from "../clients/file-utils.js";
import {
	_resetMcpSessionContext,
	runSessionStart,
} from "../clients/mcp/session.js";
import {
	fauxAssistantMessage,
	fauxText,
	piSessionFixture,
	startPiSession,
	type PiSession,
} from "./support/pi-session.js";

const fixture = piSessionFixture();

/** Two real pi sessions; the other two-session files budget 60 s. */
const TWO_SESSION_TIMEOUT_MS = 60_000;

/** The header every rendered guidance opens with (`renderSessionStartGuidance`). */
const GUIDANCE = "pi-lens active";

const READY = fauxAssistantMessage(fauxText("ready"));

function project(name: string): string {
	const proj = path.join(fixture.root, name, "proj");
	fs.mkdirSync(path.join(proj, "src"), { recursive: true });
	fs.writeFileSync(path.join(proj, "src", "seed.ts"), "export const a = 1;\n");
	return proj;
}

/** The text of the provider request at `index`, as its JSON. */
function requestText(handle: PiSession, index: number): string {
	return JSON.stringify(handle.requests[index]);
}

function recordPath(proj: string): string {
	return path.join(
		getProjectDataDir(proj),
		"cache",
		"session-start-guidance.json",
	);
}

async function twoSessions(
	proj: string,
): Promise<{ primary: PiSession; secondary: PiSession }> {
	const primary = await startPiSession({
		root: fixture.root,
		cwd: proj,
		startupMode: "full",
		responses: [READY, READY],
	});
	const secondary = await startPiSession({
		root: fixture.root,
		cwd: proj,
		startupMode: "full",
		responses: [READY, READY],
	});
	return { primary, secondary };
}

describe("#5792: the session-start guidance reaches only the session that wrote it", () => {
	it(
		"keeps the primary's guidance from a secondary that prompts first, and hands it to the primary",
		{ timeout: TWO_SESSION_TIMEOUT_MS },
		async () => {
			// RECURRENCE GUARDED: #5792. The secondary's request consumed the
			// primary's guidance from the shared per-project record, and the
			// primary's own first request got none.
			const proj = project("secondary-first");
			const { primary, secondary } = await twoSessions(proj);
			const stored = JSON.parse(fs.readFileSync(recordPath(proj), "utf8"));
			expect(stored.content).toContain(GUIDANCE);
			// RECURRENCE GUARDED: #5792, a record with no owner. The stamp is the
			// writing session's id as the host reports it.
			expect(stored.sessionId).toBe(
				primary.session.sessionManager.getSessionId(),
			);

			await secondary.prompt("secondary goes first");
			expect(requestText(secondary, 0)).not.toContain(GUIDANCE);
			// The skipped read leaves the record where it was.
			expect(JSON.parse(fs.readFileSync(recordPath(proj), "utf8"))).toEqual(
				stored,
			);

			await primary.prompt("primary goes second");
			expect(requestText(primary, 0)).toContain(GUIDANCE);

			expect(primary.errors).toEqual([]);
			expect(secondary.errors).toEqual([]);
			await secondary.dispose();
			await primary.dispose();
		},
	);

	it(
		"hands the primary its guidance when it prompts first, and the secondary none",
		{ timeout: TWO_SESSION_TIMEOUT_MS },
		async () => {
			const { primary, secondary } = await twoSessions(
				project("primary-first"),
			);

			await primary.prompt("primary goes first");
			expect(requestText(primary, 0)).toContain(GUIDANCE);
			await secondary.prompt("secondary goes second");
			expect(requestText(secondary, 0)).not.toContain(GUIDANCE);

			expect(primary.errors).toEqual([]);
			expect(secondary.errors).toEqual([]);
			await secondary.dispose();
			await primary.dispose();
		},
	);

	it(
		"hands a record written before #5792 (no session field) to the primary only",
		{ timeout: TWO_SESSION_TIMEOUT_MS },
		async () => {
			// RECURRENCE GUARDED: an upgrade leaves the old `{ content }` record on
			// disk. It has no owner, so only the coordinator session (the one the
			// old writer always was) may take it; the secondary leaves it.
			const proj = project("old-record");
			const { primary, secondary } = await twoSessions(proj);
			new CacheManager(false).writeCache(
				"session-start-guidance",
				{ content: "OLD-RECORD guidance from before the session field" },
				proj,
			);

			await secondary.prompt("secondary goes first");
			expect(requestText(secondary, 0)).not.toContain("OLD-RECORD");
			await primary.prompt("primary goes second");
			expect(requestText(primary, 0)).toContain("OLD-RECORD");

			await secondary.dispose();
			await primary.dispose();
		},
	);

	it(
		"keeps working across a /reload: the reloaded session still receives its guidance",
		{ timeout: TWO_SESSION_TIMEOUT_MS },
		async () => {
			const primary = await startPiSession({
				root: fixture.root,
				cwd: project("reload"),
				startupMode: "full",
				responses: [READY],
			});
			const reloaded = await primary.restart({ reason: "reload" }, [READY]);
			await reloaded.prompt("after reload");
			expect(requestText(reloaded, 0)).toContain(GUIDANCE);
			expect(reloaded.errors).toEqual([]);
			await reloaded.dispose();
		},
	);

	it(
		"hands the MCP host the guidance its own session start wrote",
		{ timeout: TWO_SESSION_TIMEOUT_MS },
		async () => {
			// RECURRENCE GUARDED: #5792, the MCP caller of the same consumer. It
			// writes and reads in one call as one identity; a reader id that
			// differs from the stamp drops the orientation the host asked for.
			const proj = project("mcp");
			const primary = await startPiSession({
				root: fixture.root,
				cwd: proj,
				startupMode: "full",
				responses: [READY],
			});
			_resetMcpSessionContext();
			try {
				const outcome = await runSessionStart(proj);
				expect(outcome.guidance).toContain(GUIDANCE);
			} finally {
				_resetMcpSessionContext();
			}
			await primary.dispose();
		},
	);
});
