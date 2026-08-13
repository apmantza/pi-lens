import { describe, expect, it } from "vitest";
import { AgentBehaviorClient } from "../../clients/agent-behavior-client.js";

const FORT = "/repo/roblox-project/blender/build_fort.py";
const OTHER_A = "/repo/src/server/LayoutStore.luau";
const OTHER_B = "/repo/src/server/Rooms.luau";
const OTHER_C = "/repo/src/server/Tank.luau";

function blindWriteWarnings(
	warnings: ReturnType<AgentBehaviorClient["recordToolCall"]>,
): string[] {
	return warnings.filter((w) => w.type === "blind-write").map((w) => w.message);
}

describe("AgentBehaviorClient blind-write detection", () => {
	it("does not flag the write-then-edit loop on a self-authored file", () => {
		const client = new AgentBehaviorClient();

		expect(blindWriteWarnings(client.recordToolCall("write", FORT))).toEqual(
			[],
		);
		// Four consecutive edits on the file the agent just authored must stay
		// quiet: the session's own write/edit of this path is file knowledge.
		for (let i = 0; i < 4; i++) {
			expect(blindWriteWarnings(client.recordToolCall("edit", FORT))).toEqual(
				[],
			);
		}
	});

	it("does not flag edits on a file authored earlier in the window", () => {
		const client = new AgentBehaviorClient();

		client.recordToolCall("write", OTHER_A);
		client.recordToolCall("edit", OTHER_B);
		// Second edit of OTHER_B: the first edit of the same path is still in
		// the window, so this is not a blind write.
		expect(blindWriteWarnings(client.recordToolCall("edit", OTHER_B))).toEqual(
			[],
		);
	});

	it("still flags an edit of a never-authored file after a write storm", () => {
		const client = new AgentBehaviorClient();

		client.recordToolCall("edit", OTHER_A);
		client.recordToolCall("edit", OTHER_B);
		// OTHER_C was never read and never written this session; two writes
		// without a read precede it, so it warns.
		const warnings = blindWriteWarnings(client.recordToolCall("edit", OTHER_C));
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("BLIND WRITE");
		expect(warnings[0]).toContain(OTHER_C);
	});

	it("still treats any read in the window as file knowledge", () => {
		const client = new AgentBehaviorClient();

		client.recordToolCall("edit", OTHER_A);
		client.recordToolCall("edit", OTHER_B);
		client.recordToolCall("read", OTHER_C);
		expect(blindWriteWarnings(client.recordToolCall("edit", OTHER_C))).toEqual(
			[],
		);
	});

	it("ignores same-path writes whose path is missing", () => {
		const client = new AgentBehaviorClient();

		client.recordToolCall("write");
		client.recordToolCall("edit");
		// No paths recorded anywhere: nothing can count as knowledge of the
		// target path, so the two-write threshold still trips.
		const warnings = blindWriteWarnings(client.recordToolCall("edit", OTHER_C));
		expect(warnings).toHaveLength(1);
	});
});

describe("AgentBehaviorClient thrashing detection", () => {
	it("still flags three consecutive identical tool+file calls", () => {
		const client = new AgentBehaviorClient();

		client.recordToolCall("edit", FORT);
		client.recordToolCall("edit", FORT);
		const warnings = client.recordToolCall("edit", FORT);

		const thrashing = warnings.filter((w) => w.type === "thrashing");
		expect(thrashing).toHaveLength(1);
		// The same edit is NOT a blind write anymore (self-authored path).
		expect(blindWriteWarnings(warnings)).toEqual([]);
	});
});

describe("AgentBehaviorClient reset", () => {
	it("clears history so a later edit storm can warn again", () => {
		const client = new AgentBehaviorClient();

		client.recordToolCall("write", FORT);
		client.recordToolCall("edit", FORT);
		client.reset();
		client.recordToolCall("edit", OTHER_A);
		client.recordToolCall("edit", OTHER_B);

		expect(blindWriteWarnings(client.recordToolCall("edit", OTHER_C))).toHaveLength(
			1,
		);
	});
});
