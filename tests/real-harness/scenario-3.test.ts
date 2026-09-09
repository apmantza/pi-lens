import { describe, expect, it } from "vitest";
import { withRealPi } from "../support/real-pi-harness.js";

// flake-shape: real-process-spawn — a real host tool call is required to prove the read guard's cross-process behavior
describe("real pi harness: read guard", () => {
	it("records the real host's tool results", async () => {
		await withRealPi(
			{ fixture: "scenario-3", script: "script.json" },
			async (pi) => {
				await pi.prompt("perform the scripted edit");
				const blocked = await pi.awaitToolResult("edit");
				expect(JSON.stringify(blocked)).toMatch(/RETRYABLE|read/i);
				const read = await pi.awaitToolResult("read_symbol");
				expect(JSON.stringify(read)).toMatch(/value|guarded/);
				await pi.awaitToolResult("read");
				const edited = await pi.awaitToolResult("edit");
				expect(JSON.stringify(edited)).toMatch(/success|value|updated/i);
				await pi.awaitAssistantTurn();
			},
		);
	}, 60_000);
});
