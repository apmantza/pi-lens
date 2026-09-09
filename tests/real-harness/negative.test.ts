import { describe, expect, it } from "vitest";
import { withRealPi } from "../support/real-pi-harness.js";

// The provider's typed exhaustion and the real tool's argument validation are
// process-boundary behavior; a mocked provider cannot certify either path.
// flake-shape: real-process-spawn — real pi must surface provider and tool errors
describe("real pi harness: negative scripts", () => {
	it("surfaces typed provider exhaustion instead of hanging", async () => {
		await withRealPi(
			{ fixture: "scenario-1", script: "short.json" },
			async (pi) => {
				await pi.prompt("first");
				await pi.awaitAssistantTurn();
				await pi.prompt("second");
				const ended = await pi.awaitAssistantTurn();
				expect(JSON.stringify(ended)).toMatch(
					/beyond script|ScriptedProviderError|error/i,
				);
			},
		);
	}, 60_000);

	it("surfaces the real tool's own malformed-argument error", async () => {
		await withRealPi(
			{ fixture: "scenario-3", script: "wrong-arguments.json" },
			async (pi) => {
				await pi.prompt("bad arguments");
				const result = await pi.awaitToolResult("edit");
				expect(JSON.stringify(result)).toMatch(/required|path|argument|error/i);
			},
		);
	}, 60_000);
});
