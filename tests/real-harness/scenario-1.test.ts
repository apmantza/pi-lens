import { describe, expect, it } from "vitest";
import { withRealPi } from "../support/real-pi-harness.js";

// flake-shape: real-process-spawn — the real host must load the built extension and preserve its tool roster across turns
describe("real pi harness: load and tool-set restore", () => {
	it("loads commands and restores the baseline across a second turn", async () => {
		await withRealPi(
			{ fixture: "scenario-1", script: "script.json" },
			async (pi) => {
				await pi.newSession();
				await pi.prompt("run the scripted turn");
				await pi.awaitAssistantTurn();
				const first = pi.providerObservations();
				await pi.prompt("run the second scripted turn");
				await pi.awaitAssistantTurn();
				expect(pi.toolResults()).toEqual([]);
				const tools = first.map((row) => row.tools);
				expect(tools.length).toBeGreaterThanOrEqual(1);
				expect(tools[tools.length - 1]).toEqual(tools[0]);
			},
		);
	}, 60_000);
});
