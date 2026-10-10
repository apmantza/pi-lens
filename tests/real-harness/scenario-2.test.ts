import { spawnSync } from "node:child_process";
import { expect, describe, it } from "vitest";
import { withRealPi } from "../support/real-pi-harness.js";

const realPiAvailable =
	spawnSync("pi", ["--version"], { stdio: "ignore" }).status === 0;

// flake-shape: real-process-spawn — only a persisted real pi session can prove
// the host's fork successor is interrupted before pi-lens's handler (W0).
// Recurrence prevented: #4236 drops activations when that named marker expires.
describe.skipIf(!realPiAvailable)("real pi persisted hand-off expiry", () => {
	it("keeps activations across an expired unstarted fork successor", async () => {
		await withRealPi(
			{
				fixture: "scenario-2",
				script: "script.json",
				persistedSession: true,
				env: {
					PI_LENS_TEST_MODE: "0",
					PI_LENS_TEST_SUCCESSOR_PENDING_TTL_MS: "0",
				},
			},
			async (pi) => {
				await pi.prompt("activate");
				await pi.awaitToolResult("pi_lens_activate_tools");
				await pi.awaitAssistantTurn();
				await pi.clone();
				await pi.prompt("after fork");
				await pi.awaitAssistantTurn();
				expect(pi.providerObservations().at(-1)?.tools).toEqual(
					expect.arrayContaining([
						expect.objectContaining({ name: "ast_grep_search" }),
					]),
				);
			},
		);
	}, 60_000);
});
