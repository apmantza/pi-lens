/**
 * #4698: a turn whose ONLY action is `lens_diagnostic_mark` must clear the
 * `--lens-guard` commit gate for the blocker it marked.
 *
 * The defect: turn end re-derives the commit-gate latch from the turn-end
 * disposition policy (`resyncGitGuardAfterInlinePolicy`, #3248) at the point
 * where a file's post-policy survivor set is final. A turn that writes no file
 * returns from `handleTurnEnd` long before that pass (`clients/runtime-turn.ts`,
 * the `files.length === 0` early return), so the mark took and the next prompt
 * showed no blocker, while the latch still counted the marked record and
 * `--lens-guard` named it back at the commit. Two surfaces judged one
 * disposition, and only one of them saw the mark.
 *
 * Tier 2 (#4632): the BUILT extension inside a real pi `AgentSession`, with the
 * host's own `fauxProvider` scripted at the provider boundary. Nothing here is
 * mocked — the blocker is a bundled rule's answer on a real file, the mark is
 * the real `lens_diagnostic_mark` tool, and the commit is a real `bash` call
 * whose gate answer is asserted from the tool result the MODEL received. The
 * turn-script pieces (one tool call per reply, the `echo` marker, the
 * `lens_diagnostic_mark` identity, the transcript readers) are shared with
 * `tests/index-4632-s4-tool-call-verdict.test.ts` through
 * `tests/support/pi-session-commit-gate.ts`; only the turn grouping is local.
 *
 * The commit verb carries a marker (`echo`) after a `;`: a blocked call never
 * reaches the shell, so the marker's ABSENCE is the observable that the tool
 * did not execute and its presence is the observable that it did. That keeps
 * the assertion true whether git refuses the commit or creates one, so the
 * case does not depend on the checkout it runs in.
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
	CLEAN_FILE,
	GATE_BLOCK,
	MARKED_FILE,
	RAN_MARKER,
	BLOCKER,
	activateMarkTool,
	commitAttempt,
	endTurn,
	markFalsePositive,
	openGuardedSession,
	raise,
	readTarget,
	seed,
	step,
	toolResults,
	warmGuardedSession,
} from "./support/pi-session-commit-gate.js";
import { type PiFauxReply, piSessionFixture } from "./support/pi-session.js";

const fixture = piSessionFixture();

// #5731: the file's first case paid the worker's cold first-session cost (1.9 s
// against 0.4 s for its sibling, 87% of its 5 s cap on CI). The shared warm-up
// (#5061) pays it in a hook, so no case carries it.
beforeAll(() => warmGuardedSession(fixture.root));

/** Turn 2 of both cases: a turn that writes no file at all. */
function noWriteTurn(...calls: Record<string, unknown>[]): PiFauxReply[] {
	return [...calls.map((call) => step(call)), endTurn("turn 2 done")];
}

describe("#4698: a mark-only turn clears the commit gate it marked", () => {
	it("lets the commit through on the turn AFTER a mark that wrote no file", async () => {
		const { proj, target } = seed(fixture.root, "mark-only", CLEAN_FILE);
		const handle = await openGuardedSession(fixture.root, proj, [
			...raise(target, MARKED_FILE),
			// Turn 2: the model's whole action is the mark. Nothing is written,
			// so this is the turn shape that used to return before the policy pass.
			...noWriteTurn(activateMarkTool(), markFalsePositive(target)),
			// Turn 3: the commit the mark should now unblock.
			step(commitAttempt(), "committing"),
			endTurn("turn 3 done"),
		]);
		await handle.prompt("write the file");
		await handle.prompt("mark the blocker false-positive");
		await handle.prompt("commit it");

		const [marked] = toolResults(
			handle.requests.at(-1) ?? [],
			"lens_diagnostic_mark",
		);
		const [commit] = toolResults(handle.requests.at(-1) ?? [], "bash");
		// The mark itself was accepted, so a later failure is the gate's, not the
		// mark's.
		expect(marked?.isError).toBe(false);
		expect(marked?.text).toContain("marked false-positive");
		// The gate the model reads: allowed, and the command really ran.
		expect(commit?.text).not.toContain(GATE_BLOCK);
		expect(commit?.text).toContain(RAN_MARKER);
		expect(handle.errors).toEqual([]);
	});

	it("still refuses the commit when a no-write turn marks nothing", async () => {
		// The other direction of the same rule, so the fix cannot become "a turn
		// that wrote no file opens the gate": the record's blocker is still
		// unmarked, the bytes it describes are still on disk, and the gate must
		// keep refusing.
		const { proj, target } = seed(
			fixture.root,
			"mark-only-control",
			CLEAN_FILE,
		);
		const handle = await openGuardedSession(fixture.root, proj, [
			...raise(target, MARKED_FILE),
			// Turn 2: a read-only turn that marks nothing.
			...noWriteTurn(readTarget(target)),
			step(commitAttempt(), "committing"),
			endTurn("turn 3 done"),
		]);
		await handle.prompt("write the file");
		await handle.prompt("re-read the file");
		await handle.prompt("commit it");

		const [commit] = toolResults(handle.requests.at(-1) ?? [], "bash");
		expect(commit?.text).toContain(GATE_BLOCK);
		// The latch's own list, naming the blocker the turn never marked.
		expect(commit?.text).toContain(BLOCKER.message);
		expect(commit?.text).not.toContain(RAN_MARKER);
		expect(commit?.isError).toBe(true);
		expect(handle.errors).toEqual([]);
	});
});
