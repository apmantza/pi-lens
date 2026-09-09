import { describe, expect, it } from "vitest";
import { withRealPi } from "../support/real-pi-harness.js";

// flake-shape: real-process-spawn — child death is only observable at the real process boundary
describe("real pi harness: child lifecycle", () => {
	it("rejects a governed wait immediately when pi is killed", async () => {
		await withRealPi(
			{ fixture: "scenario-1", script: "script.json" },
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
