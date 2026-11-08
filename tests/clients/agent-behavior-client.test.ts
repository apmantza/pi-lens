import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	AgentBehaviorClient,
	toolCallProgress,
} from "../../clients/agent-behavior-client.js";
import { getGlobalPiLensLogDir } from "../../clients/probe-home-state.js";
import { flushLatencyLog } from "../../clients/latency-logger.js";
import { readNdjsonRows } from "../support/ndjson-rows.js";

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

function thrashWarnings(
	warnings: ReturnType<AgentBehaviorClient["recordToolCall"]>,
): string[] {
	return warnings.filter((w) => w.type === "thrashing").map((w) => w.message);
}

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

	// #5429: the tracker's own doc says it flags "repeated identical tool calls
	// with no progress". Three successful edits whose arguments differ each
	// changed the file, so they are progress, not thrashing.
	it("does not flag three successful edits that each change the file", () => {
		const client = new AgentBehaviorClient();

		client.recordToolCall("edit", FORT, { argsKey: "edit:1" });
		client.recordToolCall("edit", FORT, { argsKey: "edit:2" });
		expect(
			thrashWarnings(
				client.recordToolCall("edit", FORT, { argsKey: "edit:3" }),
			),
		).toEqual([]);
	});

	it("still flags three identical retries of one call", () => {
		const client = new AgentBehaviorClient();

		client.recordToolCall("edit", FORT, { argsKey: "edit:same" });
		client.recordToolCall("edit", FORT, { argsKey: "edit:same" });
		expect(
			thrashWarnings(
				client.recordToolCall("edit", FORT, { argsKey: "edit:same" }),
			),
		).toHaveLength(1);
	});

	it("still flags three failed results even when their arguments differ", () => {
		const client = new AgentBehaviorClient();

		client.recordToolCall("edit", FORT, { argsKey: "edit:1", failed: true });
		client.recordToolCall("edit", FORT, { argsKey: "edit:2", failed: true });
		expect(
			thrashWarnings(
				client.recordToolCall("edit", FORT, {
					argsKey: "edit:3",
					failed: true,
				}),
			),
		).toHaveLength(1);
	});

	it("clears the streak when a later call makes progress", () => {
		const client = new AgentBehaviorClient();

		client.recordToolCall("edit", FORT, { failed: true });
		client.recordToolCall("edit", FORT, { failed: true });
		// The third call finally moved: the loop is over, so the warning the
		// pre-#5429 counter raised on its identity alone is a false positive.
		expect(
			thrashWarnings(
				client.recordToolCall("edit", FORT, { argsKey: "edit:3" }),
			),
		).toEqual([]);
	});

	it("counts a call whose progress the caller could not see as before", () => {
		const client = new AgentBehaviorClient();

		client.recordToolCall("read", FORT);
		client.recordToolCall("read", FORT);
		expect(thrashWarnings(client.recordToolCall("read", FORT))).toHaveLength(1);
	});

	it("still flags blind writes across three successful edits", () => {
		const client = new AgentBehaviorClient();

		// #5429 changed only the thrash counter. BLIND WRITE asks a different
		// question — has the agent shown knowledge of this path — so three
		// progressing edits of never-read files still warn.
		expect(
			blindWriteWarnings(
				client.recordToolCall("edit", OTHER_A, { argsKey: "edit:a" }),
			),
		).toEqual([]);
		expect(
			blindWriteWarnings(
				client.recordToolCall("edit", OTHER_B, { argsKey: "edit:b" }),
			),
		).toEqual([]);
		expect(
			blindWriteWarnings(
				client.recordToolCall("edit", OTHER_C, { argsKey: "edit:c" }),
			),
		).toHaveLength(1);
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

		expect(
			blindWriteWarnings(client.recordToolCall("edit", OTHER_C)),
		).toHaveLength(1);
	});
});

describe("AgentBehaviorClient edit counts", () => {
	it("matches mixed-separator and case-variant paths", () => {
		const client = new AgentBehaviorClient();

		client.recordToolCall("edit", "C:\\Repo\\SRC\\File.ts");

		expect(client.getEditCount("c:/repo/src/file.ts")).toBe(1);
	});
});

describe("toolCallProgress", () => {
	// The one unavailable result this module produces, read back from the real
	// sink: arguments that cannot be serialized give the call no identity, and
	// the bounded row is what says so.
	it("records a call whose arguments cannot be serialized", async () => {
		const previousTestMode = process.env.PI_LENS_TEST_MODE;
		// latency.log writes are off under PI_LENS_TEST_MODE (#1742).
		process.env.PI_LENS_TEST_MODE = "0";
		const log = path.join(getGlobalPiLensLogDir(), "latency.log");
		const fromByte = fs.existsSync(log) ? fs.statSync(log).size : 0;
		try {
			const circular: Record<string, unknown> = { path: FORT, offset: 1 };
			circular.self = circular;
			expect(toolCallProgress({ toolName: "edit", input: circular })).toEqual(
				{},
			);
			expect(
				toolCallProgress({
					toolName: "edit",
					input: circular,
					isError: true,
				}),
			).toEqual({ failed: true });
			await flushLatencyLog();
			const { rows, skipped } = readNdjsonRows<{
				phase?: string;
				toolName?: string;
				result?: string;
			}>(log, fromByte);
			expect(skipped).toBe(0);
			expect(
				rows
					.filter((row) => row.phase === "behavior_args_unserializable")
					.map((row) => ({ toolName: row.toolName, result: row.result })),
			).toEqual([
				{ toolName: "edit", result: "no-args-key" },
				{ toolName: "edit", result: "no-args-key" },
			]);
		} finally {
			if (previousTestMode === undefined) delete process.env.PI_LENS_TEST_MODE;
			else process.env.PI_LENS_TEST_MODE = previousTestMode;
		}
	});
});
