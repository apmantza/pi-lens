import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, describe, it } from "vitest";
import { TOOL_REGISTRY } from "../../clients/tool-config.js";
import { type RealPi, withRealPi } from "../support/real-pi-harness.js";

const realPiAvailable =
	spawnSync("pi", ["--version"], { stdio: "ignore" }).status === 0;

const situationalTools = TOOL_REGISTRY.flatMap((tool) =>
	"situational" in tool && tool.situational && tool.piName ? [tool.piName] : [],
).sort();

function roster(pi: RealPi): string[] {
	const tools = pi.providerObservations().at(-1)?.tools;
	return (Array.isArray(tools) ? tools : [])
		.flatMap((tool) =>
			typeof (tool as { name?: unknown }).name === "string"
				? [(tool as { name: string }).name]
				: [],
		)
		.sort();
}

function lifecycleRows(pi: RealPi) {
	return pi.lens
		.latencyRows()
		.filter((row) => row.phase === "session_scope_transition")
		.map((row) => {
			const metadata = row.metadata as
				| { transition?: string; reason?: string }
				| undefined;
			return `${metadata?.transition}:${metadata?.reason}`;
		});
}

function deadWeightRows(pi: RealPi) {
	return pi.lens
		.extensionLog()
		.filter((row) => row.message === "situational tool dead weight");
}

function deadWeightTools(pi: RealPi, index: number): string[] | undefined {
	const tools = (
		deadWeightRows(pi)[index]?.metadata as { tools?: string[] } | undefined
	)?.tools;
	return tools ? [...tools].sort() : undefined;
}

async function sessionFile(pi: RealPi): Promise<string> {
	await expect.poll(() => pi.sessionFiles().length).toBeGreaterThan(0);
	return pi.sessionFiles().at(-1) as string;
}

async function turn(pi: RealPi, text: string, expected: string[]) {
	await pi.prompt(text);
	await pi.awaitAssistantTurn();
	await expect.poll(() => roster(pi)).toEqual(expected);
}

// flake-shape: real-process-spawn — this is the only lane that can observe a real pi factory re-run, persisted-session restart, and stdin-close shutdown in one process sequence.
// Recurrence prevented: an in-process mock preserves its extension closure and cannot prove pi's lifecycle ordering (#2891, #2858, #2866).
describe.skipIf(!realPiAvailable)("real pi lifecycle witness", () => {
	it("drives startup, reload, new, resume, fork, and quit in order", async () => {
		await withRealPi(
			{
				fixture: "lifecycle",
				script: "script.json",
				agentSettings: { defaultTools: ["+codemode"] },
				persistedSession: true,
				env: { PI_LENS_TEST_MODE: "0" },
				extensions: [
					fileURLToPath(
						new URL(
							"../fixtures/real-harness/reload-extension.mjs",
							import.meta.url,
						),
					),
				],
			},
			async (pi) => {
				await pi.prompt("startup");
				await pi.awaitAssistantTurn();
				await pi.awaitToolResult("pi_lens_activate_tools");
				await pi.awaitAssistantTurn();
				const activatedRoster = roster(pi);
				expect(activatedRoster).toContain("ast_grep_search");
				const freshRoster = activatedRoster.filter(
					(name) => name !== "ast_grep_search",
				);
				const initialSessionFile = await sessionFile(pi);

				await pi.prompt("/real-harness-reload");
				await turn(pi, "after reload", activatedRoster);
				await expect.poll(() => deadWeightRows(pi)).toHaveLength(0);

				await pi.newSession();
				await turn(pi, "after new", freshRoster);
				const freshSessionFile = await sessionFile(pi);
				expect(freshSessionFile).not.toBe(initialSessionFile);
				await expect.poll(() => deadWeightRows(pi)).toHaveLength(1);
				expect(deadWeightTools(pi, 0)).toEqual(
					situationalTools.filter((name) => name !== "ast_grep_search"),
				);

				const beforeResumeSessionFile = freshSessionFile;
				await pi.resume();
				await turn(pi, "after resume", freshRoster);
				const resumedSessionFile = await sessionFile(pi);
				expect(resumedSessionFile).toBe(beforeResumeSessionFile);
				await expect.poll(() => deadWeightRows(pi)).toHaveLength(2);
				expect(deadWeightTools(pi, 1)).toEqual(situationalTools);

				await pi.clone();
				await turn(pi, "after fork", activatedRoster);
				await expect.poll(() => deadWeightRows(pi)).toHaveLength(3);
				expect(deadWeightTools(pi, 2)).toEqual(
					situationalTools.filter((name) => name !== "ast_grep_search"),
				);

				await pi.quit();
				await expect.poll(() => deadWeightRows(pi)).toHaveLength(4);
				expect(deadWeightTools(pi, 3)).toEqual(situationalTools);
				const rows = pi.lens
					.latencyRows()
					.filter((row) => row.phase === "session_scope_transition");
				const expectedTransitions = [
					"end:superseded",
					"start:startup",
					"shutdown:reload",
					"start:reload",
					"shutdown:new",
					"start:new",
					"shutdown:quit",
					"end:superseded",
					"start:startup",
					"shutdown:fork",
					"start:fork",
					"shutdown:quit",
				];
				expect(
					lifecycleRows(pi),
					JSON.stringify({
						rows,
					}),
				).toEqual(expectedTransitions);
			},
		);
	}, 60_000);
});
