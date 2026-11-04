/**
 * #4921: an unresolved inline blocker is delivered at turn end once per
 * blocker set, not once per turn in which the agent writes a different file.
 *
 * The defect: `handleTurnEnd` rebuilds the "Unresolved from this turn" section
 * from `runtime.getInlineBlockersSnapshot()` every turn, and its only
 * duplicate suppressor (`turn-end-findings-last`) keyed the sorted file set of
 * THAT TURN plus the rendered content. A turn that wrote another file changed
 * the key, so the unchanged blocker reached the model again on every such turn
 * (investigator probe s9: delivered on turns 1 to 6 while `src/bad.ts` stayed
 * broken; probe s8, the same file each turn, delivered once). With
 * `--lens-guard` the dedupe branch also rewrote the gate record
 * `consumed: false`, so even a repeated key re-delivered.
 *
 * Tier 2 (#4632): the BUILT extension in a real pi `AgentSession`, the model
 * scripted at the provider boundary. Every scripted reply is one pi turn (a
 * tool-call step ends in its own `turn_end`). pi-lens injects a finding into
 * one provider request and pi does not carry it into the next, so one request
 * naming the blocker is one delivery. The commit gate's answer is read from
 * the bash result the model received.
 *
 * Lane: ubuntu Unit tests.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { CacheManager } from "../clients/cache-manager.js";
import {
	AUTOMATION_FRAMING,
	BLOCKER_REPEAT_HEADING,
} from "../clients/runtime-context.js";
import {
	BLOCKING_FILE,
	CLEAN_FILE,
	GATE_BLOCK,
	GUARDED_FLAGS,
	RAN_MARKER,
	commitAttempt,
	endTurn,
	openGuardedSession,
	seed,
	step,
	textBlocks,
	toolResults,
	writeTarget,
} from "./support/pi-session-commit-gate.js";
import {
	type PiFauxReply,
	type PiSession,
	piSessionFixture,
	startPiSession,
} from "./support/pi-session.js";

const fixture = piSessionFixture();

/** Up to a dozen real turns a cell; the other tier-2 files budget 60 s. */
const LONG_SESSION_TIMEOUT_MS = 120_000;

/** The flags of the guarded cells without the commit gate. */
const UNGUARDED_FLAGS: ReadonlyArray<[string, boolean]> = GUARDED_FLAGS.filter(
	([name]) => name !== "lens-guard",
);

/** The header of one blocker section of a turn-end delivery. */
const SECTION = "Unresolved from this turn — ";

/** One scripted turn: write `name` under `src/` and end. */
function write(
	proj: string,
	name: string,
	content = CLEAN_FILE,
): PiFauxReply[] {
	return [
		step(writeTarget(path.join(proj, "src", name), content), "writing"),
		endTurn("turn done"),
	];
}

/** A closing turn that writes nothing, so the last turn end's delivery lands. */
function listen(): PiFauxReply[] {
	return [endTurn("listening")];
}

/**
 * The requests that carry an injected pi-lens message naming `needle`. A
 * repeat of an already-delivered blocker (#5240, the first request of a later
 * prompt) is not a delivery: `tests/index-5240-blocker-repeat.test.ts` counts it.
 */
function injected(handle: PiSession, needle: string): number {
	return handle.requests.filter((request) =>
		request.some((message) =>
			textBlocks(message).some(
				(text) =>
					text.startsWith(AUTOMATION_FRAMING) &&
					text.includes(needle) &&
					!text.includes(BLOCKER_REPEAT_HEADING),
			),
		),
	).length;
}

/** Deliveries of the blocker section for `src/<name>`. */
function sections(handle: PiSession, name: string): number {
	return injected(handle, `${SECTION}${path.join("src", name)}`);
}

async function openCell(
	name: string,
	guard: boolean,
	build: (proj: string) => PiFauxReply[],
): Promise<{ handle: PiSession; proj: string }> {
	const { proj } = seed(fixture.root, name, CLEAN_FILE);
	const responses = build(proj);
	const handle = guard
		? await openGuardedSession(fixture.root, proj, responses)
		: await startPiSession({
				root: fixture.root,
				cwd: proj,
				flags: new Map(UNGUARDED_FLAGS),
				responses,
			});
	return { handle, proj };
}

/** `prompts` prompts; the last one reads what the previous turn end left. */
async function run(handle: PiSession, prompts: number): Promise<void> {
	for (let turn = 1; turn <= prompts; turn++) await handle.prompt(`p${turn}`);
}

describe.each([
	{ guard: false, tag: "plain" },
	{ guard: true, tag: "guard" },
])("#4921: a stuck blocker reaches the model once ($tag)", ({ guard, tag }) => {
	it(
		"delivers it once while the agent writes a different clean file each turn",
		async () => {
			// RECURRENCE GUARDED: #4921 (probe s9): the turn's file set was part of
			// the duplicate key, so each turn that wrote another file delivered the
			// unchanged blocker again (6 deliveries in 6 write turns without
			// `--lens-guard`; with it, also every dedupe-suppressed turn).
			const { handle } = await openCell(`varying-${tag}`, guard, (proj) => [
				...write(proj, "bad.ts", BLOCKING_FILE),
				...[1, 2, 3, 4, 5].flatMap((n) => write(proj, `f${n}.ts`)),
				...listen(),
			]);
			await run(handle, 7);
			expect(sections(handle, "bad.ts")).toBe(1);
			expect(injected(handle, "bad.ts")).toBe(1);
			expect(handle.errors).toEqual([]);
		},
		LONG_SESSION_TIMEOUT_MS,
	);

	it(
		"marks the suppressed turns on turn_end rows and on no other row",
		async () => {
			// RECURRENCE GUARDED: #4921 review F3: a suppressed duplicate turn
			// returned before the turn_end latency row, so the turns the fix
			// silences left no record. The field rides the turn_end row; the case
			// bounds the counts (at least three marked, the field on no other row
			// kind). One row per turn is not pinned here (accepted residual).
			const { handle } = await openCell(`row-${tag}`, guard, (proj) => [
				...write(proj, "bad.ts", BLOCKING_FILE),
				...[1, 2, 3].flatMap((n) => write(proj, `f${n}.ts`)),
				...listen(),
			]);
			await run(handle, 5);
			const read = await handle.latencyRows();
			expect(read.skipped).toBe(0);
			const rows = read.rows.filter((row) => row.toolName === "turn_end");
			// #5240: a duplicate turn that still holds a blocker stages a repeat for
			// the next prompt and carries `blockerRepeat` instead.
			const suppressed = rows.filter((row) => {
				const metadata = row.metadata as Record<string, unknown> | undefined;
				return (
					metadata?.deliverySuppressed === "duplicate" ||
					metadata?.blockerRepeat === true
				);
			});
			// The three clean-file write steps repeat the delivered blocker, and
			// the first write step, which delivered it, carries no field.
			expect(suppressed.length).toBeGreaterThanOrEqual(3);
			expect(rows.length - suppressed.length).toBeGreaterThanOrEqual(1);
			for (const row of suppressed) expect(row.result).toBe("blockers_found");
			// The field lives on the turn_end row alone: no row of another kind
			// (a new phase) carries it.
			expect(
				read.rows.filter((row) => {
					const text = JSON.stringify(row);
					return (
						text.includes("deliverySuppressed") ||
						text.includes("blockerRepeat")
					);
				}).length,
			).toBe(suppressed.length);
			expect(sections(handle, "bad.ts")).toBe(1);
			expect(handle.errors).toEqual([]);
		},
		LONG_SESSION_TIMEOUT_MS,
	);

	it(
		"still delivers it once when the agent rewrites the same clean file each turn",
		async () => {
			// The s8 control: the shape that already worked without the gate must
			// not regress (probe s8: one delivery).
			const { handle } = await openCell(`same-${tag}`, guard, (proj) => [
				...write(proj, "bad.ts", BLOCKING_FILE),
				...[1, 2, 3, 4, 5].flatMap(() => write(proj, "a.ts")),
				...listen(),
			]);
			await run(handle, 7);
			expect(sections(handle, "bad.ts")).toBe(1);
			expect(handle.errors).toEqual([]);
		},
		LONG_SESSION_TIMEOUT_MS,
	);

	it(
		"delivers the set again when a second blocker joins it",
		async () => {
			// The other direction of the dedupe key: a changed blocker set is new
			// content, so suppressing on the first blocker alone would hide
			// `src/second.ts` from the model.
			const { handle } = await openCell(`joined-${tag}`, guard, (proj) => [
				...write(proj, "bad.ts", BLOCKING_FILE),
				...write(proj, "f1.ts"),
				...write(proj, "second.ts", BLOCKING_FILE),
				...write(proj, "f2.ts"),
				...write(proj, "f3.ts"),
				...listen(),
			]);
			await run(handle, 6);
			expect(sections(handle, "second.ts")).toBe(1);
			// The joined set is delivered whole, once: the first blocker rides it.
			expect(sections(handle, "bad.ts")).toBe(2);
			expect(handle.errors).toEqual([]);
		},
		LONG_SESSION_TIMEOUT_MS,
	);

	it(
		"delivers a blocker again once it was resolved and then reintroduced",
		async () => {
			// The other direction again: an identical blocker after a fix is a new
			// event. Suppressing it on the stale key would leave the model blind
			// to a regression it just made.
			const { handle } = await openCell(`again-${tag}`, guard, (proj) => [
				...write(proj, "bad.ts", BLOCKING_FILE),
				...write(proj, "bad.ts", CLEAN_FILE),
				...write(proj, "f1.ts"),
				...write(proj, "bad.ts", BLOCKING_FILE),
				...write(proj, "f2.ts"),
				...listen(),
			]);
			await run(handle, 6);
			expect(sections(handle, "bad.ts")).toBe(2);
			expect(handle.errors).toEqual([]);
		},
		LONG_SESSION_TIMEOUT_MS,
	);
});

describe("#4921: the commit gate does not depend on re-delivery (--lens-guard)", () => {
	it(
		"refuses the commit on a blocker the model was told once and not again",
		async () => {
			// RECURRENCE GUARDED: the fix suppresses the advisory text only. The gate
			// reads the record (#4725, #4738, #4750), and a dedupe that dropped the
			// blocker from it would let `git commit` through on the sixth turn.
			const { handle } = await openCell("gate", true, (proj) => [
				...write(proj, "bad.ts", BLOCKING_FILE),
				...[1, 2, 3].flatMap((n) => write(proj, `f${n}.ts`)),
				step(commitAttempt(), "committing"),
				endTurn("commit done"),
			]);
			await run(handle, 5);
			expect(sections(handle, "bad.ts")).toBe(1);
			const [verdict] = toolResults(handle.requests.at(-1) ?? [], "bash");
			expect(verdict?.text).toContain(GATE_BLOCK);
			// The gate names the blocker it holds, not the file.
			expect(verdict?.text).toMatch(/debugger/i);
			expect(verdict?.text).not.toContain(RAN_MARKER);
			expect(verdict?.isError).toBe(true);
			expect(handle.errors).toEqual([]);
		},
		LONG_SESSION_TIMEOUT_MS,
	);
});

describe("#4921: a dedupe record the previous release wrote still parses", () => {
	it(
		"replaces a 4.4.6 dedupe record with the content-keyed one",
		async () => {
			// RECURRENCE GUARDED: the signature's shape changed (the file-set prefix
			// is empty unless a count-driven hold is in the message). A record a
			// release wrote with the old prefix must neither throw nor suppress a
			// turn whose key it does not match; the next delivery replaces it.
			const old = JSON.parse(
				fs.readFileSync(
					path.join(
						import.meta.dirname,
						"fixtures/turn-end-findings-last/4.4.6-turn-end-findings-last.json",
					),
					"utf-8",
				),
			) as { signature: string; sessionId: string };
			const { handle, proj } = await openCell("old-record", false, (dir) => [
				...write(dir, "bad.ts", BLOCKING_FILE),
				...write(dir, "f1.ts"),
				...write(dir, "f2.ts"),
				...listen(),
			]);
			const cacheManager = new CacheManager(false);
			await handle.prompt("p1");
			// The record the previous release left for this session.
			cacheManager.writeCache(
				"turn-end-findings-last",
				{
					...old,
					sessionId: handle.session.sessionManager.getSessionId(),
				},
				proj,
			);
			await handle.prompt("p2");
			await handle.prompt("p3");
			await handle.prompt("p4");
			const last = cacheManager.readCache<{ signature: string }>(
				"turn-end-findings-last",
				proj,
			)?.data;
			// Written by this release: no file-set prefix.
			expect(last?.signature.startsWith("::")).toBe(true);
			// The old key matched nothing, so the blocker came once more, then held.
			expect(sections(handle, "bad.ts")).toBe(2);
			expect(handle.errors).toEqual([]);
		},
		LONG_SESSION_TIMEOUT_MS,
	);
});
