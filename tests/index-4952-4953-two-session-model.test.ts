/**
 * Two-session state model over the real pi host: #4952 and #4953.
 *
 * Recurrence it prevents (shape 72, process-global last-write-wins session
 * field). Two sessions in one pi process (an in-process subagent, #473) share
 * the module-scope `RuntimeCoordinator`, so a field it holds once answers for
 * whichever session wrote last:
 *
 * - #4952 (refs #4941): the commit gate read the process's blocker latch, so a
 *   secondary committing in repository B was refused for a blocker the primary
 *   wrote in repository A. The key the gate needed was the tree, not the
 *   session.
 * - #4953 (refs #4943): `handleToolResult` stamped every session's write with
 *   `runtime.telemetrySessionId`, the primary's id, so a subagent's edit was
 *   logged in `change-log.jsonl` under the primary.
 *
 * The hand tests (`index-4941-commit-gate-by-repo.test.ts`,
 * `index-4943-telemetry-session-stamp.test.ts`) pin one hand-picked order each.
 * This file replaces the order with a model: writers P (the coordinator's
 * session) and S (the concurrent secondary), actions write-bad, write-clean and
 * commit, generated as sequences, run through the BUILT extension in real pi
 * `AgentSession`s (tier 2, #4632) with the model scripted at the provider
 * boundary. Nothing is seeded into a store, and the sessions share one process
 * so the coordinator really is shared. The model is the whole oracle: each
 * property compares what the host emitted with what the model says it owes.
 *
 * Out of the model on purpose: S raising a blocker in its OWN repository and
 * then committing there. A secondary's own-repo refusal is by design for
 * adopted/none roots (the census of 2026-11-07), so the cell is not a rule the
 * model can state.
 *
 * Out of the #4953 model too: the out-of-band bulk stamp (`recordProjectMutations`
 * with source `external`, called from `clients/disk-changes.ts`) is not a tool
 * call, so its rows are not asserted by the change-log case below.
 *
 * Lane: ubuntu Unit tests. fast-check runs a bounded `numRuns` under a fixed
 * seed, so CI generates the same sequences every time; the `examples` entries
 * are the minimal counterexamples the parent commits fail on, so the red does
 * not depend on the generator reaching them.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { getProjectChangeLogPath } from "../clients/project-changes.js";
import { readNdjsonRows } from "./support/ndjson-rows.js";
import {
	BLOCKING_FILE,
	CLEAN_FILE,
	GATE_BLOCK,
	GUARDED_FLAGS,
	RAN_MARKER,
	commitAttempt,
	endTurn,
	step,
	toolResults,
	writeTarget,
} from "./support/pi-session-commit-gate.js";
import {
	type PiFauxReply,
	piSessionFixture,
	startPiSession,
} from "./support/pi-session.js";

const fixture = piSessionFixture();

/** Two real pi sessions per run, several runs: budgeted above the 60 s of the hand files. */
const MODEL_TIMEOUT_MS = 120_000;
const SEED = 5370;

type Who = "P" | "S";
type Op =
	| { who: Who; kind: "bad" | "clean"; file: number }
	| { who: Who; kind: "commit" };

/** The primary's file one op names; the secondary's own files never collide with it. */
function fileFor(dir: string, who: Who, file: number): string {
	return path.join(dir, "src", `${who.toLowerCase()}${file}.ts`);
}

/**
 * One scripted reply list per session: each op of that session is one tool
 * round trip and one turn end, in the order the model drives them.
 */
function script(
	ops: readonly Op[],
	who: Who,
	dir: string,
	contentFor: (op: Op & { kind: "bad" | "clean" }) => string,
): PiFauxReply[] {
	return [
		...ops
			.filter((op) => op.who === who)
			.flatMap((op): PiFauxReply[] =>
				op.kind === "commit"
					? [step(commitAttempt(), "committing"), endTurn("c")]
					: [
							step(
								writeTarget(fileFor(dir, who, op.file), contentFor(op)),
								"writing",
							),
							endTurn("w"),
						],
			),
		endTurn("idle"),
	];
}

/**
 * What a commit attempt came back as. A refusal by a blocker names the blocking
 * file's finding; the gate's fail-closed `unknown` answer carries the same
 * prefix, so the prefix alone would let a gate that stopped reading blockers
 * pass by refusing for the wrong reason. A refused call never reaches the
 * shell, so the marker is present exactly when the commit ran.
 */
type Verdict = "blocker" | "ran" | `other: ${string}`;

function verdictOf(text: string): Verdict {
	if (text.includes(GATE_BLOCK)) {
		return text.includes("Debugger statement") && !text.includes(RAN_MARKER)
			? "blocker"
			: `other: ${text.slice(0, 200)}`;
	}
	return text.includes(RAN_MARKER) ? "ran" : `other: ${text.slice(0, 200)}`;
}

let cell = 0;

/**
 * A project directory per run. `git` marks it a checkout the way the gate
 * resolves one (`.git/HEAD`; the gate spawns no git).
 */
function project(name: string, git: boolean): string {
	const dir = path.join(fixture.root, name, "proj");
	fs.mkdirSync(path.join(dir, "src"), { recursive: true });
	fs.writeFileSync(path.join(dir, "src", "seed.ts"), CLEAN_FILE);
	if (git) {
		fs.mkdirSync(path.join(dir, ".git"));
		fs.writeFileSync(path.join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
	}
	return dir;
}

describe("two sessions in one process: a model of writers P and S", () => {
	it(
		"refuses a commit, naming the blocker, iff its own repository holds an unresolved blocker (#4952)",
		{ timeout: MODEL_TIMEOUT_MS },
		async () => {
			// RECURRENCE GUARDED: #4952. P raises a blocker in repository A; S
			// commits in repository B and was told COMMIT BLOCKED with A's file.
			// P writes bad/clean files and commits; S writes clean files and
			// commits (its own repository never holds a blocker).
			const opArb: fc.Arbitrary<Op> = fc.oneof(
				fc.record({
					who: fc.constant<Who>("P"),
					kind: fc.constantFrom<"bad" | "clean">("bad", "clean"),
					file: fc.integer({ min: 0, max: 1 }),
				}),
				fc.record({
					who: fc.constant<Who>("S"),
					kind: fc.constant<"clean">("clean"),
					file: fc.integer({ min: 0, max: 1 }),
				}),
				fc.record({
					who: fc.constantFrom<Who>("P", "S"),
					kind: fc.constant<"commit">("commit"),
				}),
			);
			await fc.assert(
				fc.asyncProperty(
					fc.array(opArb, { minLength: 1, maxLength: 7 }),
					async (ops) => {
						const n = cell++;
						const dirs: Record<Who, string> = {
							P: project(`a${n}`, true),
							S: project(`b${n}`, true),
						};
						const contentFor = (op: Op & { kind: "bad" | "clean" }): string =>
							op.kind === "bad" ? BLOCKING_FILE : CLEAN_FILE;
						const primary = await startPiSession({
							root: fixture.root,
							cwd: dirs.P,
							flags: new Map(GUARDED_FLAGS),
							responses: script(ops, "P", dirs.P, contentFor),
						});
						const secondary = await startPiSession({
							root: fixture.root,
							cwd: dirs.S,
							flags: new Map(GUARDED_FLAGS),
							responses: script(ops, "S", dirs.S, contentFor),
						});
						const handle = { P: primary, S: secondary };

						// The model: per writer, the files holding an unresolved blocker in
						// ITS repository. A commit owes a refusal iff that set is non-empty.
						const bad: Record<Who, Set<number>> = {
							P: new Set(),
							S: new Set(),
						};
						const owed: Record<Who, Verdict[]> = { P: [], S: [] };
						for (const op of ops) {
							if (op.kind === "bad") bad[op.who].add(op.file);
							else if (op.kind === "clean") bad[op.who].delete(op.file);
							else owed[op.who].push(bad[op.who].size > 0 ? "blocker" : "ran");
							await handle[op.who].prompt(op.kind);
						}

						const refused: Record<Who, Verdict[]> = { P: [], S: [] };
						for (const who of ["P", "S"] as const) {
							const results = toolResults(
								(handle[who].requests.at(-1) ?? []) as Parameters<
									typeof toolResults
								>[0],
								"bash",
							);
							refused[who] = results.map((r) => verdictOf(r.text));
						}
						expect(primary.errors).toEqual([]);
						expect(secondary.errors).toEqual([]);
						await secondary.dispose();
						await primary.dispose();
						expect({ ops, refused }).toEqual({ ops, refused: owed });
					},
				),
				{
					numRuns: 6,
					seed: SEED,
					examples: [
						// The cross-repository refusal itself.
						[
							[
								{ who: "P", kind: "bad", file: 0 },
								{ who: "S", kind: "commit" },
							],
						],
						// The other direction: a blocker still refuses a commit in its own
						// repository, and a rewritten clean file lifts the refusal.
						[
							[
								{ who: "P", kind: "bad", file: 0 },
								{ who: "P", kind: "commit" },
								{ who: "P", kind: "clean", file: 0 },
								{ who: "P", kind: "commit" },
							],
						],
					],
				},
			);
		},
	);

	it(
		"stamps every write-tool change-log row with the session that wrote the file (#4953)",
		{ timeout: MODEL_TIMEOUT_MS },
		async () => {
			// RECURRENCE GUARDED: #4953. S edits a file in the primary's project and
			// its change-log row carried P's id. Both writers share one project (the
			// shape a cwd filter passes); each owns the files named with its letter.
			const opArb = fc.record({
				who: fc.constantFrom<Who>("P", "S"),
				kind: fc.constant<"clean">("clean"),
				file: fc.integer({ min: 0, max: 2 }),
			});
			await fc.assert(
				fc.asyncProperty(
					fc.array(opArb, { minLength: 1, maxLength: 6 }),
					async (ops) => {
						const shared = project(`pa${cell++}`, false);
						const contentFor = (op: Op & { kind: "bad" | "clean" }): string =>
							`${CLEAN_FILE}// ${op.who}${op.file}\n`;
						const primary = await startPiSession({
							root: fixture.root,
							cwd: shared,
							responses: script(ops, "P", shared, contentFor),
						});
						const secondary = await startPiSession({
							root: fixture.root,
							cwd: shared,
							responses: script(ops, "S", shared, contentFor),
						});
						const handle = { P: primary, S: secondary };
						for (const op of ops) await handle[op.who].prompt("go");
						const ids: Record<Who, string> = {
							P: primary.session.sessionManager.getSessionId(),
							S: secondary.session.sessionManager.getSessionId(),
						};
						expect(primary.errors).toEqual([]);
						expect(secondary.errors).toEqual([]);
						await secondary.dispose();
						await primary.dispose();

						const logPath = getProjectChangeLogPath(shared);
						const { rows, skipped } = readNdjsonRows<{
							sessionId?: string;
							filePath: string;
						}>(logPath);
						expect(skipped).toBe(0);

						// The model: a row's file name starts with the letter of the session
						// that wrote it, so the owner is read off the file the row names.
						const ownerOf = (filePath: string): Who =>
							path.basename(filePath).startsWith("p") ? "P" : "S";
						const wrongStamp = rows
							.map((row) => ({
								file: path.basename(row.filePath),
								owner: ownerOf(row.filePath),
								stamp:
									row.sessionId === ids.P
										? "P"
										: row.sessionId === ids.S
											? "S"
											: row.sessionId,
							}))
							.filter((row) => row.stamp !== row.owner);
						// Every writer's distinct files reach the log, under its own stamp. A
						// write whose append is dropped leaves its set short, which the stamp
						// check cannot see because a missing row stamps nothing wrong.
						const loggedBy = (who: Who): string[] =>
							[
								...new Set(
									rows
										.filter((row) => ownerOf(row.filePath) === who)
										.map((row) => path.basename(row.filePath)),
								),
							].sort();
						const writtenBy = (who: Who): string[] =>
							[
								...new Set(
									ops
										.filter((op) => op.who === who)
										.map((op) => `${who.toLowerCase()}${op.file}.ts`),
								),
							].sort();
						expect({
							ops,
							wrongStamp,
							logged: { P: loggedBy("P"), S: loggedBy("S") },
						}).toEqual({
							ops,
							wrongStamp: [],
							logged: { P: writtenBy("P"), S: writtenBy("S") },
						});
					},
				),
				{
					numRuns: 6,
					seed: SEED,
					examples: [[[{ who: "S", kind: "clean", file: 0 }]]],
				},
			);
		},
	);
});
