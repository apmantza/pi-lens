import { describe, expect, it } from "vitest";
import { withRealPi } from "../support/real-pi-harness";

// flake-shape: real-process-spawn — a real host tool call is required to prove the read guard's cross-process behavior
describe("real pi harness: read guard", () => {
	it("records the real host's tool results", async () => {
		await withRealPi({ fixture: "scenario-3", script: "script.json" }, async (pi) => {
			await pi.prompt("perform the scripted edit");
			const ended = await pi.events("message_end");
			expect(ended.length).toBeGreaterThan(0);
			expect(pi.lens.extensionLog()).toBeDefined();
		});
	}, 60_000);
});
