/**
 * Slice 4 of #4632: the `tool_call` hook's verdict as the MODEL receives it.
 *
 * The claim every case here pins is the hook's RESULT, not the hook's return
 * value: pi turns a `{ block: true, reason }` answer into the tool result the
 * model reads on its next request, and the tool never runs. A double that
 * records what `index.ts` PASSED to a handler cannot see either half — it can
 * only compare the object it was handed with the object it expected.
 *
 * Two families moved here from the doubles that stood in for the host:
 *
 * 1. The commit gate (#3248's witness,
 *    `tests/index-3248-git-guard-latch-witness.test.ts`). The blocker is now
 *    the BUNDLED rules' own answer on a real file (`debugger;` raises an
 *    ast-grep and a code-quality blocking finding), so `clients/pipeline.ts` —
 *    the previous double — is the real one, and the bytes the gate re-reads
 *    are the bytes the pipeline analysed.
 * 2. The inline half of #3814's session-boundary cells
 *    (`tests/index-3814-deferred-blocker-gate.test.ts`): a record written in
 *    one session must answer a commit in the NEXT session as a refusal, never
 *    as allowed. Here the next session comes from pi's own replacement code
 *    for each reason (`PiSession.restart`), so the shutdown and start events,
 *    their payloads, the session id and the conversation are pi's — not a
 *    re-emitted event on one process-lifetime activation, which is how the old
 *    cells answered `session_mismatch` for `reload` too, a reason that keeps
 *    the session id.
 *
 * What stays on the double, and why: #3814's deferred half. A deferred runner
 * is a LATENCY classification (`clients/dispatch/collect-later-tier.ts`), so
 * producing one needs a real runner observed over 5 s; its blocker cannot be
 * scripted at the provider boundary. Those cells keep `clients/pipeline.js`
 * stubbed and their `in-process-mock` baseline row.
 *
 * ORDER MATTERS IN THE SCRIPT: one tool call per scripted reply. Tool calls
 * sharing one assistant message are handed to the host together, so a commit
 * written into the same message as the edit it must judge can reach the
 * `tool_call` hook before that edit's `tool_result` recorded its blocker —
 * measured. Each reply below therefore carries at most one call.
 *
 * The commit verb carries a marker (`echo`) after a `;`: a blocked call never
 * reaches the shell, so the marker's ABSENCE is the observable that the tool
 * did not execute, and its presence in an allowed turn is the observable that
 * it did. The marker keeps that assertion true whether git refuses the commit
 * or creates one, so the case does not depend on the checkout it runs in.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
	BLOCKER,
	BLOCKING_FILE,
	CLEAN_FILE,
	GATE_BLOCK,
	MARKED_FILE,
	RAN_MARKER,
	type Received,
	activateMarkTool,
	commitAttempt,
	endTurn,
	markFalsePositive,
	openGuardedSession,
	raise,
	readTarget,
	seed,
	step,
	textBlocks,
	toolResults,
	warmGuardedSession,
	writeTarget,
} from "./support/pi-session-commit-gate.js";
import {
	type PiFauxReply,
	type PiMessage,
	fauxToolCall,
	piSessionFixture,
} from "./support/pi-session.js";

const fixture = piSessionFixture();

// The first guarded session's cold cost is paid in a hook (#5056, #5061).
beforeAll(() => warmGuardedSession(fixture.root));

/**
 * The sentence BOTH guard branches answer with: the live latch (`:1358`) and
 * the persisted record (`:1457`). Only what each appends tells them apart.
 */
const GATE_PHRASE = "unresolved blockers must be fixed before commit/push";
/** What only the LATCH branch appends: the blocker list the live copy holds. */
const LATCH_LIST = "🔴 STOP —";

const GOLDEN = path.join(
	import.meta.dirname,
	"fixtures/witness/git-guard-latch/tool-call-verdict.txt",
);
/** #3282's witness: a marked blocker, then the commits it no longer gates. */
const MARKED_GOLDEN = path.join(
	import.meta.dirname,
	"fixtures/witness/git-guard-latch/all-marked-commit-allowed.txt",
);

function editTarget(
	target: string,
	oldText: string,
	newText: string,
): Record<string, unknown> {
	return fauxToolCall("edit", {
		path: target,
		edits: [{ oldText, newText }],
	});
}

/**
 * Every `bash` tool result the model received, in order. Read from the LAST
 * transcript only: each provider request carries the whole conversation, so
 * folding every request would count one result once per later round trip.
 */
function bashResults(requests: readonly (readonly PiMessage[])[]): Received[] {
	return toolResults(requests.at(-1) ?? [], "bash");
}

/** A refused commit: the gate's prefix and `answer`, an error, never run. */
function expectRefused(verdict: Received | undefined, answer: string): void {
	expect(verdict?.text).toContain(GATE_BLOCK);
	expect(verdict?.text).toContain(answer);
	expect(verdict?.text).not.toContain(RAN_MARKER);
	expect(verdict?.isError).toBe(true);
}

/** The first `L<n>: …` blocker line in a rendered finding block. */
function firstBlockerLine(text: string): string | undefined {
	return text
		.split("\n")
		.map((line) => line.trim())
		.find((line) => /^L\d+: /.test(line));
}

/** The prefix pi-lens puts on every context block it injects. */
const INJECTION_PREFIX = "[pi-lens automated";

/**
 * Every injection the model read in one transcript, in order. pi delivers a
 * `context` block either beside the prompt's own text (the session-start
 * guidance) or as a user message of its own (a turn-end delivery), so the
 * marker is the block's own text, never its position.
 */
function injections(transcript: readonly PiMessage[]): string[] {
	return transcript
		.filter((message) => message.role === "user")
		.flatMap((message) => textBlocks(message))
		.filter((text) => text.startsWith(INJECTION_PREFIX));
}

/**
 * The injections one request carried from a prompt on: the prompt's own
 * message (pi merges a `context` block beside its text) and every user
 * message after it. Prompt texts are unique per case, so the prompt names its
 * turn.
 */
function readDuring(
	transcript: readonly PiMessage[],
	promptText: string,
): string[] {
	const at = transcript.findIndex(
		(message) =>
			message.role === "user" && textBlocks(message)[0] === promptText,
	);
	return injections(at === -1 ? [] : transcript.slice(at));
}

/** The last injection the model read in one transcript. */
function lastInjection(transcript: readonly PiMessage[]): string {
	return injections(transcript).at(-1) ?? "(nothing injected)";
}

/** The next session's script: one commit attempt. */
function commitThenEnd(): PiFauxReply[] {
	return [step(commitAttempt(), "committing"), endTurn("done")];
}

/**
 * Turns 1 and 2 of the marked family: raise the blocker, then mark it
 * false-positive the way a model does (activate the tool, call it). pi ends a
 * turn after every reply, and a turn that wrote no file returns before the
 * turn-end policy pass that re-judges a mark (the `files.length === 0` return
 * in `clients/runtime-turn.ts`), so the latch is re-judged by the NEXT turn
 * that writes. The cases therefore write a file after the mark.
 */
function raiseThenMark(target: string): PiFauxReply[] {
	return [
		...raise(target, MARKED_FILE),
		step(activateMarkTool(), "activating the mark tool"),
		step(markFalsePositive(target), "marking"),
		endTurn("turn 2 done"),
	];
}

describe("#4632 s4: a blocked tool_call reaches the model (git guard)", () => {
	it("shows the model the blocker and blocks the commit, then lets it through once the blocker is fixed", async () => {
		const { proj, target } = seed(fixture.root, "gate-golden", CLEAN_FILE);
		const handle = await openGuardedSession(fixture.root, proj, [
			// Turn 1: raise the blockers, then try to commit them.
			step(readTarget(target), "reading"),
			step(writeTarget(target, BLOCKING_FILE), "writing"),
			step(commitAttempt(), "committing"),
			endTurn("turn 1 done"),
			// Turn 2: fix the file the blockers named, then commit again.
			step(editTarget(target, "\tdebugger;\n", ""), "fixing"),
			step(commitAttempt(), "committing again"),
			endTurn("turn 2 done"),
		]);

		await handle.prompt("write the file and commit it");
		const turnTwoStarts = handle.requests.length;

		await handle.prompt("fix it and commit again");

		const commits = bashResults(handle.requests);
		expect(commits).toHaveLength(2);
		const blocked = commits[0];
		const allowed = commits[1];
		// The injection the model reads on turn 2 is turn 1's, delivered through
		// pi's own `context` merge.
		// The delivery the model read BEFORE it attempted the commit: the inline
		// blocker notice lands on the request that carries the commit call, so the
		// two surfaces are compared at the same instant.
		const banner =
			handle.requests
				.slice(0, turnTwoStarts)
				.map((transcript) => lastInjection(transcript))
				.filter((text) => text !== "(nothing injected)")
				.at(-1) ?? "(nothing injected)";

		// The witness artifact: what the model was shown at turn end, and what the
		// gate answered a moment later. It records FACTS drawn from both texts
		// rather than the texts themselves: the texts also carry fixture paths
		// and fix hints, so a raw golden would pin those instead of the verdict.
		const facts = (label: string, text: string) =>
			[
				`--- ${label} ---`,
				`names the gate's prefix: ${text.includes(GATE_BLOCK)}`,
				`names a blocker: ${firstBlockerLine(text) !== undefined}`,
				`first blocker: ${firstBlockerLine(text) ?? "(none)"}`,
				`the command ran: ${text.includes(RAN_MARKER)}`,
			].join("\n");
		const actual = `${[
			"=== turn 1: the context message the model reads on its next turn ===",
			facts("what the model read at turn end", banner),
			"",
			"=== turn 1: the commit's tool result ===",
			facts("the commit's tool result", blocked.text),
			"",
			"=== turn 2: the commit's tool result after the fix ===",
			facts("the commit's tool result", allowed.text),
		].join("\n")}\n`;
		if (process.env.PI_LENS_WITNESS_UPDATE === "1") {
			fs.mkdirSync(path.dirname(GOLDEN), { recursive: true });
			fs.writeFileSync(GOLDEN, actual);
		}
		expect(actual).toBe(fs.readFileSync(GOLDEN, "utf8"));

		// The two surfaces agree: the banner the model read at turn end and the
		// gate's answer name the same blockers, and the tool's own side effects
		// settle what ran.
		expect(banner).toContain("Unresolved from this turn");
		expect(banner).toContain("Debugger statement");
		expect(blocked.text).toContain(GATE_BLOCK);
		expect(blocked.text).toContain("Debugger statement");
		// The LATCH's answer, which is what a same-session commit reads: the live
		// copy still holds the blocker, so the gate appends its list. The reload
		// cell below asserts the opposite of this line, so the constant has to be
		// witnessed where it really appears.
		expect(blocked.text).toContain(LATCH_LIST);
		// A blocked call never reached the shell.
		expect(blocked.isError).toBe(true);
		expect(blocked.text).not.toContain(RAN_MARKER);
		// The fixed file has no blocker left, so the gate allows the call and the
		// command really ran.
		expect(allowed.text).not.toContain(GATE_BLOCK);
		expect(allowed.text).toContain(RAN_MARKER);
		expect(handle.errors).toEqual([]);
	});

	it("lets the commit through once the blocker is marked false-positive, and a later write keeps it clear", async () => {
		// #3282's witness, through the host: the model marks the blocker with its
		// own tool call, the next turn that writes re-judges the record, and the
		// banner and the gate then agree that nothing blocks. A second write to
		// the unrelated file must not bring the marked blocker back.
		const { proj, target } = seed(fixture.root, "gate-marked", CLEAN_FILE);
		const notes = path.join(proj, "src", "notes.ts");
		const prompts = [
			"write the file",
			"mark the blocker",
			"write the notes and commit",
			"edit the notes and commit again",
		];
		const handle = await openGuardedSession(fixture.root, proj, [
			...raiseThenMark(target),
			step(writeTarget(notes, "export const note = 1;\n"), "writing notes"),
			step(commitAttempt(), "committing"),
			endTurn("turn 3 done"),
			step(editTarget(notes, "note = 1", "note = 2"), "editing notes"),
			step(commitAttempt(), "committing again"),
			endTurn("turn 4 done"),
		]);
		// The request index each prompt starts at: an injection rides only the
		// request pi built it for, so a turn's banner is read from that turn's
		// own requests, never from the final transcript.
		const starts: number[] = [];
		for (const text of prompts) {
			starts.push(handle.requests.length);
			await handle.prompt(text);
		}
		starts.push(handle.requests.length);

		const [marked] = toolResults(
			handle.requests.at(-1) ?? [],
			"lens_diagnostic_mark",
		);
		const commits = bashResults(handle.requests);
		expect(commits).toHaveLength(2);
		const shown = (turn: number) =>
			handle.requests
				.slice(starts[turn], starts[turn + 1])
				.some((transcript) =>
					readDuring(transcript, prompts[turn]).some((block) =>
						block.includes(BLOCKER.message),
					),
				);
		const actual = `${[
			"=== turn 1: the blocker raised ===",
			`the model was shown the blocker: ${shown(0)}`,
			"",
			"=== turn 2: the model marks it false-positive ===",
			`the mark's tool result: ${(marked?.text ?? "(none)").split("\n")[0]}`,
			"",
			"=== turn 3: another file written, then the commit ===",
			`the model was shown the blocker: ${shown(2)}`,
			`names the gate's prefix: ${commits[0].text.includes(GATE_BLOCK)}`,
			`the command ran: ${commits[0].text.includes(RAN_MARKER)}`,
			"",
			"=== turn 4: the other file edited again, then the commit ===",
			`the model was shown the blocker: ${shown(3)}`,
			`names the gate's prefix: ${commits[1].text.includes(GATE_BLOCK)}`,
			`the command ran: ${commits[1].text.includes(RAN_MARKER)}`,
		].join("\n")}\n`;
		if (process.env.PI_LENS_WITNESS_UPDATE === "1") {
			fs.mkdirSync(path.dirname(MARKED_GOLDEN), { recursive: true });
			fs.writeFileSync(MARKED_GOLDEN, actual);
		}
		expect(actual).toBe(fs.readFileSync(MARKED_GOLDEN, "utf8"));

		// The golden's facts, stated: the mark took, and both commits ran.
		expect(marked?.isError).toBe(false);
		for (const commit of commits) {
			expect(commit.text).not.toContain(GATE_BLOCK);
			expect(commit.text).toContain(RAN_MARKER);
		}
		expect(handle.errors).toEqual([]);
	});

	it("does not allow the commit after an external change to a marked file", async () => {
		// GG-3283-01 through the host. The blocker is MARKED and the latch is
		// clear, so the only branch left that can refuse is the stale-bytes
		// check (`firstExpiredSuppressionVerdict`): the mark's verdict spoke for
		// the bytes the turn end read, and an external writer moved them without
		// a dispatch.
		const { proj, target } = seed(fixture.root, "gate-external", CLEAN_FILE);
		const notes = path.join(proj, "src", "notes.ts");
		const handle = await openGuardedSession(fixture.root, proj, [
			...raiseThenMark(target),
			step(writeTarget(notes, "export const note = 1;\n"), "writing notes"),
			endTurn("turn 3 done"),
			step(commitAttempt(), "committing"),
			endTurn("turn 4 done"),
		]);
		await handle.prompt("write the file");
		await handle.prompt("mark the blocker");
		await handle.prompt("write the notes");
		// A formatter, a checkout or an editor wrote the file: no dispatch ran,
		// so nothing re-analysed these bytes.
		fs.writeFileSync(target, `${MARKED_FILE}// external writer\n`);
		await handle.prompt("commit it");

		const verdict = bashResults(handle.requests).at(-1);
		expectRefused(verdict, "inline_policy_stale");
		expect(handle.errors).toEqual([]);
	});
});

describe("#4632 s4: a record written in one session answers the next one", () => {
	// One order per reason. Round 1 also ran each reason with the commit in the
	// SAME turn as the write ("gate-first"); the inline record is written at
	// `tool_result` in both orders, every reason answered the same way in both,
	// and no mutation told the two apart, so those cells were duplicates.

	it("refuses the commit of a new session, which starts empty, as a session_mismatch", async () => {
		const { proj, target } = seed(fixture.root, "replace-new", CLEAN_FILE);
		const first = await openGuardedSession(fixture.root, proj, raise(target));
		await first.prompt("write the file");
		const firstId = first.session.sessionManager.getSessionId();

		const second = await first.restart({ reason: "new" }, commitThenEnd());
		await second.prompt("commit it");

		// pi's `newSession`: a new id and an empty conversation.
		expect(second.session.sessionManager.getSessionId()).not.toBe(firstId);
		expect(second.requests[0]?.map((message) => message.role)).toEqual([
			"system",
			"user",
		]);
		// The record names the session that wrote it, and that is not this one.
		expectRefused(bashResults(second.requests).at(-1), "session_mismatch");
		expect(second.errors).toEqual([]);
	});

	it("refuses the commit of a resumed earlier conversation as a session_mismatch", async () => {
		const { proj, target } = seed(fixture.root, "replace-resume", CLEAN_FILE);
		const earlier = await openGuardedSession(fixture.root, proj, [
			endTurn("hello"),
		]);
		await earlier.prompt("an earlier conversation");
		const earlierFile = earlier.sessionFile() ?? "";
		const earlierId = earlier.session.sessionManager.getSessionId();
		const first = await earlier.restart({ reason: "new" }, raise(target));
		await first.prompt("write the file");

		const second = await first.restart(
			{ reason: "resume", sessionFile: earlierFile },
			commitThenEnd(),
		);
		await second.prompt("commit it");

		// pi's `switchSession`: the earlier file's id and its conversation.
		expect(second.session.sessionManager.getSessionId()).toBe(earlierId);
		expect(textBlocks(second.requests[0]?.[1])[0]).toBe(
			"an earlier conversation",
		);
		expectRefused(bashResults(second.requests).at(-1), "session_mismatch");
		expect(second.errors).toEqual([]);
	});

	it("refuses the commit of a fork that carries the blocker's turn as a session_mismatch", async () => {
		const { proj, target } = seed(fixture.root, "replace-fork", CLEAN_FILE);
		const first = await openGuardedSession(fixture.root, proj, raise(target));
		await first.prompt("write the file");
		const firstId = first.session.sessionManager.getSessionId();
		const leaf = first.session.sessionManager.getLeafId() ?? "";

		const second = await first.restart(
			{ reason: "fork", entryId: leaf, position: "at" },
			commitThenEnd(),
		);
		await second.prompt("commit it");

		// pi's `fork` at the leaf: a new id over a branched copy of the
		// conversation, which still holds the write that raised the blocker.
		expect(second.session.sessionManager.getSessionId()).not.toBe(firstId);
		const [write] = toolResults(second.requests[0] ?? [], "write");
		expect(write?.text).toContain("Debugger statement");
		expectRefused(bashResults(second.requests).at(-1), "session_mismatch");
		expect(second.errors).toEqual([]);
	});

	it("refuses the commit after a reload from the record the reloaded copy still reads", async () => {
		const { proj, target } = seed(fixture.root, "replace-reload", CLEAN_FILE);
		const first = await openGuardedSession(fixture.root, proj, raise(target));
		await first.prompt("write the file");
		const firstId = first.session.sessionManager.getSessionId();
		// pi's reload re-runs this session's extension factories, so the loaded
		// copy the gate runs in is a NEW one. Captured here, asserted below: with
		// `session.reload()` neutered the same runner answers, which is how this
		// cell once passed with the reload never running.
		const runnerBefore = first.session.extensionRunner;

		const second = await first.restart({ reason: "reload" }, commitThenEnd());
		await second.prompt("commit it");

		// pi's `reload`: the same session and id. The reloaded copy's own latch is
		// empty (nothing raised in IT), so the answer is the persisted record
		// (`clients/git-guard.ts:1457`, `cache_blockers`): the session identity
		// and the file sequence still match, so the record refuses. That is why
		// the latch's sentence alone cannot pin this cell — the latch branch
		// appends the blocker list (`:1358`), and this answer carries none.
		expect(second).toBe(first);
		expect(second.session.sessionManager.getSessionId()).toBe(firstId);
		// Compared as a boolean: vitest prints an `AgentSession` by reading pi's
		// theme Proxy, which throws `Theme not initialized`, so an identity
		// matcher on the session hides WHY it failed (#4664).
		const runnerChanged = second.session.extensionRunner !== runnerBefore;
		expect(runnerChanged).toBe(true);
		const verdict = bashResults(second.requests).at(-1);
		expectRefused(verdict, GATE_PHRASE);
		expect(verdict?.text).not.toContain(LATCH_LIST);
		expect(verdict?.text).not.toContain("session_mismatch");
		expect(second.errors).toEqual([]);
	});
});
