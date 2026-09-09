import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { withRealPi } from "../support/real-pi-harness.js";

function documentedToolBaselines(): { active: string[]; lazy: string[] } {
	const docs = readFileSync(
		path.resolve(
			path.dirname(fileURLToPath(import.meta.url)),
			"../../docs/agent-tools.md",
		),
		"utf8",
	);
	const lazyStart = docs.indexOf("Six situational tools");
	const section = docs.slice(
		lazyStart,
		docs.indexOf("are registered", lazyStart),
	);
	const activeSection = docs.slice(
		docs.indexOf("Six tools stay always-active"),
		lazyStart,
	);
	return {
		active: [...activeSection.matchAll(/`([a-z][a-z0-9_]*)`/g)].map(
			(match) => match[1],
		),
		lazy: [...section.matchAll(/`([a-z][a-z0-9_]*)`/g)].map(
			(match) => match[1],
		),
	};
}

// flake-shape: real-process-spawn — the real host must load the built extension and preserve its tool roster across turns
describe("real pi harness: load and tool-set restore", () => {
	it("loads commands and restores the baseline across a second turn", async () => {
		await withRealPi(
			{ fixture: "scenario-1", script: "script.json" },
			async (pi) => {
				const baseline = documentedToolBaselines();
				await pi.newSession();
				await pi.prompt("run the scripted turn");
				await pi.awaitAssistantTurn();
				const first = pi.providerObservations();
				const active = first.at(-1)?.tools as string[] | undefined;
				expect(
					active
						?.filter((name) =>
							[...baseline.active, ...baseline.lazy].includes(name),
						)
						.sort(),
				).toEqual([...baseline.active].sort());
				await pi.prompt("run the second scripted turn");
				await pi.awaitAssistantTurn();
				expect(pi.toolResults()).toEqual([]);
				const second = pi.providerObservations().at(-1)?.tools;
				expect(second).toEqual(active);
			},
		);
	}, 60_000);
});
