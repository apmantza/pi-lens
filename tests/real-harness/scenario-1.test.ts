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
	const lazyStart = docs.indexOf("Five situational tools");
	const section = docs.slice(
		lazyStart,
		docs.indexOf("are registered", lazyStart),
	);
	const activeSection = docs.slice(
		docs.indexOf("Five tools stay always-active"),
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

// The provider observation's tools are wire objects ({ name, ...bytes }); the
// roster assertion compares NAMES.
function observedRoster(pi: {
	providerObservations(): ReadonlyArray<Record<string, unknown>>;
}): string[] {
	const tools = pi.providerObservations().at(-1)?.tools;
	return (Array.isArray(tools) ? tools : []).flatMap((tool) =>
		typeof (tool as { name?: unknown }).name === "string"
			? [(tool as { name: string }).name]
			: [],
	);
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
				const active = observedRoster(pi);
				expect(
					active
						.filter((name) =>
							[...baseline.active, ...baseline.lazy].includes(name),
						)
						.sort(),
				).toEqual([...baseline.active].sort());
				await pi.prompt("run the second scripted turn");
				await pi.awaitAssistantTurn();
				expect(pi.toolResults()).toEqual([]);
				const second = observedRoster(pi);
				expect(second).toEqual(active);
			},
		);
	}, 60_000);
});
