import { describe, expect, it } from "vitest";
import { withRealPi } from "../support/real-pi-harness";

// flake-shape: real-process-spawn — the real host must load the built extension and preserve its tool roster across turns
describe("real pi harness: load and tool-set restore", () => {
	it("loads commands and restores the baseline across a second turn", async () => {
		await withRealPi({ fixture: "scenario-1", script: "script.json" }, async (pi) => {
			const commands = await pi.getCommands();
			const names = ((commands.data as { commands?: Array<{ name?: string }> }).commands ?? []).map((command) => command.name ?? "");
			expect(names.some((name) => name.startsWith("lens-"))).toBe(true);
			await pi.prompt("run the scripted turn"); await pi.events("message_end");
			await pi.prompt("run the second scripted turn"); await pi.events("message_end");
			expect(pi.toolResults()).toEqual([]);
		});
	}, 60_000);
});
