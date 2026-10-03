import { describe, expect, it } from "vitest";
import { withRealPi } from "../support/real-pi-harness.js";

// flake-shape: real-process-spawn — child death is only observable at the real process boundary
describe("real pi harness: child lifecycle", () => {
	// PATH is emptied so the child can start only through the harness's own
	// PATH head (#3742); a bare `pi` lookup would exit before the kill.
	it("rejects a governed wait immediately when pi is killed", async () => {
		await withRealPi(
			{ fixture: "scenario-1", script: "script.json", env: { PATH: "" } },
			async (pi) => {
				await pi.prompt("start a turn");
				const started = Date.now();
				const pending = pi.awaitToolResult("never-produced");
				pi.killChildForTest();
				await expect(pending).rejects.toMatchObject({
					name: "RealPiChildExitError",
					signal: "SIGKILL",
				});
				expect(Date.now() - started).toBeLessThan(2_000);
			},
		);
	}, 60_000);
});
