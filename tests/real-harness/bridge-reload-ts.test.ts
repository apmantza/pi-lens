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

// flake-shape: real-process-spawn — the TypeScript-source entry is transpiled by the real pi host's jiti loader, so only a real child re-evaluates the pi-lens graph on /reload and reaches the orphaned module-scope runtime (#4169); a double cannot produce a fresh module instance
it("keeps a third-party v1 bridge read live across /reload on the TypeScript-source load (#4169)", async () => {
	await withRealPi(
		{
			fixture: "bridge-reload",
			script: "script.json",
			entry: "index.ts",
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
