import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { withRealPi } from "../support/real-pi-harness.js";

const realPiAvailable =
	spawnSync("pi", ["--version"], {
		stdio: "ignore",
	}).status === 0;

const EXPECTED_PI_TOOLS = [
	"lens_diagnostics",
	"lsp_diagnostics",
	"module_report",
	"project_report",
	"read_symbol",
	"read_enclosing",
	"symbol_search",
	"pi_lens_activate_tools",
	"ast_grep_search",
	"ast_grep_replace",
	"ast_grep_outline",
	"ast_grep_dump",
	"lsp_navigation",
	"lens_diagnostic_mark",
	"effective_config",
];

type WireTool = {
	name: string;
	descriptionBytes: number;
	schemaBytes: number;
	surfaceBytes: number;
};

function latestTools(pi: {
	providerObservations(): ReadonlyArray<Record<string, unknown>>;
}): WireTool[] {
	const tools = pi.providerObservations().at(-1)?.tools;
	return (Array.isArray(tools) ? tools : []) as WireTool[];
}

// flake-shape: real-process-spawn — these assertions require pi to load the built extension and report the provider payload across the process boundary
describe.skipIf(!realPiAvailable)("real pi RPC: tools.<name>.enabled", () => {
	it("omits a project-disabled tool from pi's wire roster and records it once", async () => {
		await withRealPi(
			{
				fixture: "tools-disabled",
				script: "script.json",
				args: ["--no-lazy-tools"],
			},
			async (pi) => {
				await pi.prompt("report the tool roster");
				await pi.awaitAssistantTurn();
				const tools = latestTools(pi).filter((tool) =>
					EXPECTED_PI_TOOLS.includes(tool.name),
				);
				const names = tools.map((tool) => tool.name);
				expect(names).not.toContain("ast_grep_replace");
				expect(names.sort()).toEqual(
					EXPECTED_PI_TOOLS.filter(
						(name) => name !== "ast_grep_replace",
					).sort(),
				);
				const disabledLines = pi.lens
					.sessionStartLog()
					.filter((line) =>
						line.includes("session_start: disabled tools = ast_grep_replace"),
					);
				expect(disabledLines).toHaveLength(1);
				for (const tool of tools) {
					expect(tool.surfaceBytes).toBe(
						tool.descriptionBytes + tool.schemaBytes,
					);
				}
			},
		);
	});

	it("keeps the activation loader registered and emits its config diagnostic once", async () => {
		await withRealPi(
			{ fixture: "loader-disabled", script: "script.json" },
			async (pi) => {
				await pi.prompt("report the loader roster");
				await pi.awaitAssistantTurn();
				expect(
					latestTools(pi)
						.filter((tool) => EXPECTED_PI_TOOLS.includes(tool.name))
						.map((tool) => tool.name),
				).toContain("pi_lens_activate_tools");
				const diagnostics = pi.lens
					.extensionLog()
					.filter((row) =>
						String(row.message ?? "").includes("PILENS_CFG_0009"),
					);
				expect(diagnostics).toHaveLength(1);
			},
		);
	});

	it("lets --no-tool win over a project config that enables the tool", async () => {
		await withRealPi(
			{
				fixture: "cli-no-tool",
				script: "script.json",
				args: ["--no-lazy-tools", "--no-tool=lsp_navigation"],
			},
			async (pi) => {
				await pi.prompt("report the CLI roster");
				await pi.awaitAssistantTurn();
				expect(
					latestTools(pi)
						.filter((tool) => EXPECTED_PI_TOOLS.includes(tool.name))
						.map((tool) => tool.name),
				).not.toContain("lsp_navigation");
			},
		);
	});
});
