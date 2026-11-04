/**
 * #4921: an inline blocker belongs to the session whose write recorded it.
 *
 * The defect: two sessions in one pi process (an in-process subagent, #473)
 * share the module-scope `RuntimeCoordinator`, whose inline-blocker map
 * carried no owner. A concurrent secondary's turn end read the whole map, so
 * a subagent that wrote only clean files was told "Unresolved from this turn"
 * about the primary's file, swept the primary's records against its own cwd,
 * persisted the PRIMARY's session sidecar into its own project's data dir,
 * and stamped its project's `turn-end-findings-last.json` with the primary's
 * id (the reporter's two artifacts).
 *
 * Tier 2 (#4632): the BUILT extension in real pi `AgentSession`s, the model
 * scripted at the provider boundary. The second session starts while the
 * first is live, so `session_start` classifies it a concurrent secondary
 * (#4704). Each session raises what it raises by its own write; nothing is
 * seeded into a store. The same-root case is the one a cwd filter would
 * pass: both sessions work in one project.
 *
 * Lane: ubuntu Unit tests.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { getProjectDataDir } from "../clients/file-utils.js";
import { BLOCKER_REPEAT_HEADING } from "../clients/runtime-context.js";
import {
	BLOCKING_FILE,
	CLEAN_FILE,
	GUARDED_FLAGS,
	endTurn,
	step,
	textBlocks,
	writeTarget,
} from "./support/pi-session-commit-gate.js";
import {
	type PiFauxReply,
	type PiSession,
	piSessionFixture,
	startPiSession,
} from "./support/pi-session.js";

const fixture = piSessionFixture();

/** Two real pi sessions; the other two-session files budget 60 s. */
const TWO_SESSION_TIMEOUT_MS = 60_000;

/** Every `user`-role text the model received, prompts and injections. */
function userTexts(handle: PiSession): string {
	return handle.requests
		.flatMap((request) =>
			request
				.filter((message) => message.role === "user")
				.flatMap((message) => textBlocks(message)),
		)
		.join("\n");
}

/** One turn: write `target` with `content`, then end the turn. */
function writeTurn(target: string, content: string): PiFauxReply[] {
	return [step(writeTarget(target, content), "writing"), endTurn("written")];
}

function project(name: string): string {
	const proj = path.join(fixture.root, name, "proj");
	fs.mkdirSync(path.join(proj, "src"), { recursive: true });
	fs.writeFileSync(path.join(proj, "src", "seed.ts"), CLEAN_FILE);
	return proj;
}

function cacheRecord(proj: string, name: string): { sessionId?: string } {
	const file = path.join(getProjectDataDir(proj), "cache", `${name}.json`);
	if (!fs.existsSync(file)) return {};
	const body = JSON.parse(fs.readFileSync(file, "utf8")) as {
		data?: { sessionId?: string };
		sessionId?: string;
	};
	return body.data ?? body;
}

interface GuardRecord {
	sessionId?: string;
	blockerContent?: string;
	carriedBlockers?: Array<{ sessionId: string; blockerContent: string }>;
}

describe("#4921: a concurrent session's turn end admits only its own inline blockers", () => {
	it(
		"keeps the primary's blocker, sidecar and dedupe stamp out of a secondary in another root",
		{ timeout: TWO_SESSION_TIMEOUT_MS },
		async () => {
			// RECURRENCE GUARDED: #4921 (probe X of the investigation). The
			// subagent in A wrote only clean files, yet its model read the
			// primary's B/src/bbad.ts blocker, A's data dir got the primary's
			// sidecar, and A's dedupe record carried the primary's id.
			const projA = project("xa");
			const projB = project("xb");
			const bad = path.join(projB, "src", "bbad.ts");
			const primary = await startPiSession({
				root: fixture.root,
				cwd: projB,
				responses: [...writeTurn(bad, BLOCKING_FILE), endTurn("primary idle")],
			});
			const secondary = await startPiSession({
				root: fixture.root,
				cwd: projA,
				responses: [
					...writeTurn(path.join(projA, "src", "a1.ts"), CLEAN_FILE),
					...writeTurn(path.join(projA, "src", "a2.ts"), CLEAN_FILE),
					endTurn("secondary idle"),
				],
			});
			const primaryId = primary.session.sessionManager.getSessionId();
			const secondaryId = secondary.session.sessionManager.getSessionId();
			expect(secondaryId).not.toBe(primaryId);

			await primary.prompt("raise a blocker in B");
			for (const turn of ["a1", "a2", "idle"]) await secondary.prompt(turn);

			// The primary still gets its own blocker; the secondary never does.
			expect(userTexts(primary)).toContain(
				`Unresolved from this turn — ${path.join("src", "bbad.ts")}`,
			);
			expect(userTexts(secondary)).not.toContain("bbad.ts");

			// The secondary's turn ends swept none of the primary's records.
			const { rows } = await secondary.latencyRows();
			const sweeps = rows.filter(
				(row) =>
					row.filePath === projA &&
					(row.phase === "blocker_past_eof_sweep" ||
						row.phase === "blocker_freshness_sweep"),
			);
			expect(sweeps.length).toBeGreaterThan(0);
			expect(
				sweeps.map((row) => (row.metadata as { total?: number }).total),
			).toEqual(sweeps.map(() => 0));

			// No record of the primary's lands in A's project data dir.
			expect(
				fs.existsSync(
					path.join(getProjectDataDir(projA), "sessions", `${primaryId}.json`),
				),
			).toBe(false);
			expect(cacheRecord(projA, "turn-end-findings-last").sessionId).not.toBe(
				primaryId,
			);
			// The primary's own sidecar stays where its session lives.
			expect(
				fs.existsSync(
					path.join(getProjectDataDir(projB), "sessions", `${primaryId}.json`),
				),
			).toBe(true);
			expect(primary.errors).toEqual([]);
			expect(secondary.errors).toEqual([]);
			await secondary.dispose();
			await primary.dispose();
		},
	);

	it(
		"keeps the primary's blocker out of a secondary in the same project, and its guard section under its own id",
		{ timeout: TWO_SESSION_TIMEOUT_MS },
		async () => {
			// RECURRENCE GUARDED: #4921's same-root shape, which a cwd filter
			// passes: a subagent in the primary's own project was handed the
			// primary's blocker beside its own. Under --lens-guard its turn end
			// must also file each blocker section under the session that owns it
			// (#4738's partitions), not label its own section with the primary's
			// id and drop the primary's.
			const proj = project("same");
			const mine = path.join(proj, "src", "mine.ts");
			const theirs = path.join(proj, "src", "theirs.ts");
			const primary = await startPiSession({
				root: fixture.root,
				cwd: proj,
				flags: new Map(GUARDED_FLAGS),
				responses: [...writeTurn(mine, BLOCKING_FILE), endTurn("idle")],
			});
			const secondary = await startPiSession({
				root: fixture.root,
				cwd: proj,
				flags: new Map(GUARDED_FLAGS),
				responses: [
					...writeTurn(theirs, BLOCKING_FILE),
					// The same bytes again: the same findings, deduplicated (#4925).
					...writeTurn(theirs, BLOCKING_FILE),
					endTurn("secondary idle"),
				],
			});
			const primaryId = primary.session.sessionManager.getSessionId();
			const secondaryId = secondary.session.sessionManager.getSessionId();

			await primary.prompt("raise a blocker");
			await secondary.prompt("raise another");
			await secondary.prompt("write it again");
			await secondary.prompt("anything else?");

			expect(userTexts(primary)).toContain(
				`Unresolved from this turn — ${path.join("src", "mine.ts")}`,
			);
			// The secondary is told about its own blocker once, and only that one:
			// its dedupe record is its own (`turn-end-findings-last`), so its
			// unchanged second turn is not delivered again. #5240: the two later
			// prompts each open with one repeat of it.
			const theirsHeader = `Unresolved from this turn — ${path.join("src", "theirs.ts")}`;
			expect(userTexts(secondary).split(theirsHeader)).toHaveLength(4);
			expect(userTexts(secondary).split(BLOCKER_REPEAT_HEADING)).toHaveLength(
				3,
			);
			expect(userTexts(secondary)).not.toContain("mine.ts");
			expect(cacheRecord(proj, "turn-end-findings-last").sessionId).toBe(
				secondaryId,
			);

			// Each session's section sits under its own id in the gate record.
			const record = cacheRecord(proj, "turn-end-findings") as GuardRecord;
			const sections = [
				{ sessionId: record.sessionId, blockerContent: record.blockerContent },
				...(record.carriedBlockers ?? []),
			];
			const sectionOf = (id: string) =>
				sections.find((section) => section.sessionId === id)?.blockerContent;
			expect(sectionOf(primaryId)).toContain("mine.ts");
			expect(sectionOf(primaryId)).not.toContain("theirs.ts");
			expect(sectionOf(secondaryId)).toContain("theirs.ts");
			expect(sectionOf(secondaryId)).not.toContain("mine.ts");
			expect(primary.errors).toEqual([]);
			expect(secondary.errors).toEqual([]);
			await secondary.dispose();
			await primary.dispose();
		},
	);
});
