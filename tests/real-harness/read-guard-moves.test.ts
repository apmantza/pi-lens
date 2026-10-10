import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	type RealPi,
	realHarnessFixtureRoot,
	withRealPi,
} from "../support/real-pi-harness.js";

// flake-shape: real-process-spawn — the read guard's branch admission reads pi's own session branch after a real RPC clone rebinds the extension; the ids a nested call carries (`c1/1`, parent `c1`) and the toolResult pi persists for it exist only in the real host
//
// Recurrence prevented: #4138 (a relative-path read left no record with an
// id, so every /clone, /fork, /tree and /reload dropped it and the next edit
// was refused), #3831 (a nested codemode read was recorded under `c1/1`,
// which is never a toolResult on the branch) and #4185 round 1 F1 (a read
// that errored kept an identity and licensed an edit after the clone) and F4
// (a nested `bash grep` stayed under the nested id).

type Row = Record<string, unknown>;

/**
 * Prompt 1 runs the scenario's first turn, then RPC clone, then the edit.
 * `retained` is the forked session's `read_guard_branch_retained` row; the
 * logger flushes it asynchronously, so callers poll it.
 */
async function readCloneEdit(pi: RealPi): Promise<{
	edit: Row;
	retained: () => Row | undefined;
}> {
	// The run has to end (tool result delivered, second assistant message
	// streamed) before pi accepts the clone and the next prompt.
	await pi.prompt("read");
	await pi.events("agent_end");
	const clone = await pi.clone();
	expect(clone).toMatchObject({ success: true });
	await pi.prompt("edit");
	const edit = await pi.awaitToolResult("edit");
	await pi.events("agent_end");
	const retained = () =>
		pi.lens
			.latencyRows()
			.filter(
				(row) =>
					row.phase === "read_guard_branch_retained" &&
					(row.metadata as Row | undefined)?.trigger === "fork",
			)
			.at(-1)?.metadata as Row | undefined;
	return { edit, retained };
}

const kept = (retained: () => Row | undefined, expected: Row) =>
	expect.poll(retained, { timeout: 5_000 }).toMatchObject(expected);

const applied = {
	isError: false,
	result: {
		content: expect.arrayContaining([
			expect.objectContaining({
				text: expect.stringContaining("Successfully replaced 1 block(s)"),
			}),
		]),
	},
};
const refused = {
	isError: true,
	result: {
		content: expect.arrayContaining([
			expect.objectContaining({
				text: expect.stringContaining("Edit without read"),
			}),
		]),
	},
};

const scenario = (script: string) => ({
	fixture: "read-guard-moves",
	script,
	// The edit's LSP warm and the typescript server are not under test here,
	// and they cost the lane seconds per child.
	args: ["--no-lsp"],
	env: { PI_LENS_TEST_MODE: "0" },
	agentSettings: { defaultTools: ["+codemode"] },
});

describe("real pi RPC: read evidence across a conversation move", () => {
	it("keeps a relative-path top-level read across /clone and applies the next edit (#4138)", async () => {
		await withRealPi(scenario("script.json"), async (pi) => {
			const { edit, retained } = await readCloneEdit(pi);
			await kept(retained, { kept: 1, dropped: 0 });
			expect(edit).toMatchObject(applied);
		});
	}, 60_000);

	it("keeps a nested codemode read under its parent's transcript id across /clone (#3831)", async () => {
		await withRealPi(scenario("nested-read.json"), async (pi) => {
			const { edit, retained } = await readCloneEdit(pi);
			const nested = pi
				.toolResults()
				.find((row) => row.toolName === "read" && row.parentToolCallId);
			expect(nested).toMatchObject({
				toolCallId: "c1/1",
				parentToolCallId: "c1",
			});
			await kept(retained, { kept: 1, dropped: 0 });
			expect(edit).toMatchObject(applied);
		});
	}, 60_000);

	it("keeps a nested bash grep's search read across /clone (#3831)", async () => {
		await withRealPi(scenario("nested-grep.json"), async (pi) => {
			const { edit, retained } = await readCloneEdit(pi);
			await kept(retained, { kept: 1, dropped: 0 });
			expect(edit).toMatchObject(applied);
		});
	}, 60_000);

	it("drops a top-level read that errored, so the edit after /clone is refused", async () => {
		await withRealPi(scenario("failed-read.json"), async (pi) => {
			const { edit, retained } = await readCloneEdit(pi);
			expect(
				pi.toolResults().find((row) => row.toolName === "read"),
			).toMatchObject({ isError: true });
			// The errored result dropped the tool_call capture, so the clone had
			// no read of a.ts to keep or drop.
			await kept(retained, { kept: 0, dropped: 0 });
			expect(edit).toMatchObject(refused);
		});
	}, 60_000);

	it("drops a nested read that errored even though its parent's result is on the branch", async () => {
		await withRealPi(scenario("nested-failed-read.json"), async (pi) => {
			const { edit, retained } = await readCloneEdit(pi);
			expect(
				pi.toolResults().find((row) => row.toolName === "read"),
			).toMatchObject({ isError: true, parentToolCallId: "c1" });
			// The errored result dropped the tool_call capture, so the clone had
			// no read of a.ts to keep or drop.
			await kept(retained, { kept: 0, dropped: 0 });
			expect(edit).toMatchObject(refused);
		});
	}, 60_000);

	// The live twin of round 1 F1, found by the model (`formal/read-guard`
	// FailedReadLive): without any move, the errored read's capture satisfied
	// the zero-read check for the next oldText edit.
	it("refuses an edit after a read that errored, with no move at all", async () => {
		await withRealPi(scenario("failed-read-live.json"), async (pi) => {
			await pi.prompt("read");
			await pi.events("agent_end");
			await pi.prompt("edit");
			const edit = await pi.awaitToolResult("edit");
			await pi.events("agent_end");
			expect(
				pi.toolResults().find((row) => row.toolName === "read"),
			).toMatchObject({ isError: true });
			expect(edit).toMatchObject(refused);
		});
	}, 60_000);
});

// #4185 round 4 R4-1: a later extension rewrites a failed read into a
// success. The release at tool_execution_end reads pi's FINAL isError, which
// the rewrite flipped, so the capture of the read the agent got no bytes from
// survived and licensed the next oldText edit. pi-lens's own tool_result
// handler saw the real failure and now drops the capture there.
describe("real pi RPC: a failed read another extension rewrites to a success licenses nothing", () => {
	it("refuses an edit after a failed read a later extension rewrote to isError false", async () => {
		await withRealPi(
			{
				...scenario("failed-read-next-turn.json"),
				extensions: [
					path.join(realHarnessFixtureRoot, "read-error-rewrite-extension.mjs"),
				],
			},
			async (pi) => {
				// One run: the failed read and the edit are consecutive turns, so
				// only the release at the read's own result can drop the capture
				// (the agent_settled backstop fires after the edit).
				await pi.prompt("read then edit");
				await pi.events("agent_end");
				// The rewrite took effect: the persisted read result is a success.
				expect(
					pi.toolResults().find((row) => row.toolName === "read"),
				).toMatchObject({ isError: false });
				expect(
					pi.toolResults().find((row) => row.toolName === "edit"),
				).toMatchObject(refused);
			},
		);
	}, 60_000);
});

// #4185 round 3 R3-2: a later extension blocks a read that pi-lens already
// captured at tool_call. pi emits `tool_execution_end` for the blocked call
// and no `tool_result`, so the agent never saw the bytes; an edit later in the
// SAME run (the next LLM turn, the same message, or the same codemode script)
// must not be licensed by the capture. Round 3 released it only at
// agent_settled, after the edit had already been applied.
describe("real pi RPC: a read blocked by a later extension licenses nothing in its run", () => {
	const blocked = (script: string) => ({
		...scenario(script),
		extensions: [path.join(realHarnessFixtureRoot, "read-block-extension.mjs")],
	});
	const editResult = (pi: RealPi) =>
		pi.toolResults().find((row) => row.toolName === "edit");

	it("refuses an edit in the next turn of the run after a blocked read", async () => {
		await withRealPi(blocked("blocked-read-next-turn.json"), async (pi) => {
			await pi.prompt("read then edit");
			await pi.events("agent_end");
			expect(
				pi.toolResults().find((row) => row.toolName === "read"),
			).toMatchObject({ isError: true });
			expect(editResult(pi)).toMatchObject(refused);
		});
	}, 60_000);

	it("refuses an edit in the same message as a blocked read", async () => {
		await withRealPi(blocked("blocked-read-same-message.json"), async (pi) => {
			await pi.prompt("read and edit");
			await pi.events("agent_end");
			expect(editResult(pi)).toMatchObject(refused);
		});
	}, 60_000);

	it("refuses a nested edit after a nested read the extension blocked", async () => {
		await withRealPi(blocked("blocked-nested-read.json"), async (pi) => {
			await pi.prompt("codemode read and edit");
			await pi.events("agent_end");
			expect(
				pi.toolResults().find((row) => row.toolName === "read"),
			).toMatchObject({ isError: true, parentToolCallId: "c1" });
			expect(editResult(pi)).toMatchObject({
				...refused,
				parentToolCallId: "c1",
			});
		});
	}, 60_000);

	// Control: the same script with no blocking extension applies the edit,
	// so the refusals above are the block's doing, not the script's.
	it("applies the same next-turn edit when no extension blocks the read", async () => {
		await withRealPi(scenario("blocked-read-next-turn.json"), async (pi) => {
			await pi.prompt("read then edit");
			await pi.events("agent_end");
			expect(editResult(pi)).toMatchObject(applied);
		});
	}, 60_000);
});
