import { expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { type RealPi, withRealPi } from "../support/real-pi-harness.js";

const fixture = (name: string) =>
	fileURLToPath(new URL(`../fixtures/real-harness/${name}`, import.meta.url));

async function scriptedEdit(pi: RealPi): Promise<Record<string, unknown>> {
	await pi.prompt("edit guarded.ts");
	const edit = await pi.awaitToolResult("edit");
	await pi.awaitAssistantTurn();
	return edit;
}

// flake-shape: real-process-spawn — the shipped pi host must reload built pi-lens, resolve a third-party v1 bridge read, and authorize the subsequent edit across the process boundary
// Recurrence prevented: pi starts re-evaluating extensions on /reload (fresh module instance) → bridge producers would record into an orphaned runtime (#4169).
it("keeps a third-party v1 bridge read live across /reload (#4169)", async () => {
	await withRealPi(
		{
			fixture: "bridge-reload",
			script: "script.json",
			extensions: [
				fixture("reload-extension.mjs"),
				fixture("bridge-read-extension.mjs"),
			],
			env: { PI_LENS_TEST_MODE: "0" },
		},
		async (pi) => {
			await pi.prompt("/real-harness-reload");
			await pi.prompt("/real-harness-bridge-read guarded.ts");
			const edit = await scriptedEdit(pi);
			expect(edit).toMatchObject({
				isError: false,
				result: {
					content: expect.arrayContaining([
						expect.objectContaining({
							text: expect.stringContaining("Successfully replaced 1 block(s)"),
						}),
					]),
				},
			});
		},
	);
}, 60_000);
