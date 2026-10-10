import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TOOL_REGISTRY } from "../../clients/tool-config.js";
import { withRealPi } from "../support/real-pi-harness.js";

const realPiAvailable =
	spawnSync("pi", ["--version"], {
		stdio: "ignore",
	}).status === 0;

// Pi-surface entries of the canonical registry (clients/tool-config.ts), the
// one source of truth for the model-facing tool roster (#2800).
const EXPECTED_PI_TOOLS: string[] = TOOL_REGISTRY.flatMap((tool) =>
	tool.piName ? [tool.piName] : [],
);

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

/**
 * Every user-role text the scripted provider saw. #2967: the session-start
 * orientation reaches the model through the `context` hook as an injected
 * user message, so it is observable here without a fake seam.
 */
function orientationText(pi: {
	providerObservations(): ReadonlyArray<Record<string, unknown>>;
}): string {
	return pi
		.providerObservations()
		.flatMap((row) => (Array.isArray(row.userMessages) ? row.userMessages : []))
		.filter((message): message is string => typeof message === "string")
		.join("\n");
}

// flake-shape: real-process-spawn — these assertions require pi to load the built extension and report the provider payload across the process boundary
// PI_LENS_TEST_MODE="0" opts this scenario's pi child out of vitest-inherited
// test mode: its assertions read real sessionstart.log/extension.log rows, and
// every NDJSON logger is a no-op under isTestMode(). Other scenarios keep the
// harness default.
describe.skipIf(!realPiAvailable)("real pi RPC: tools.<name>.enabled", () => {
	// #2889 recurrence: pi rebuilds the extension factory on reload, so a
	// closure-local activation set loses the model's lazy-tool posture.
	it("restores lazy activation after the real extension factory reloads", async () => {
		await withRealPi(
			{
				fixture: "scenario-1",
				script: "lazy-activation-reload.json",
				extensions: [
					fileURLToPath(
						new URL(
							"../fixtures/real-harness/reload-extension.mjs",
							import.meta.url,
						),
					),
				],
				env: { PI_LENS_TEST_MODE: "0" },
			},
			async (pi) => {
				await pi.prompt("activate a lazy tool");
				await pi.awaitAssistantTurn();
				const before = pi.providerObservations().at(0)?.tools;
				expect(
					(Array.isArray(before) ? before : []).some(
						(tool) => (tool as { name?: string }).name === "ast_grep_search",
					),
				).toBe(false);
				await pi.awaitToolResult("pi_lens_activate_tools");
				await pi.awaitAssistantTurn();
				const activated = pi.providerObservations().at(-1)?.tools;
				expect(
					(Array.isArray(activated) ? activated : []).some(
						(tool) => (tool as { name?: string }).name === "ast_grep_search",
					),
				).toBe(true);

				await pi.prompt("/real-harness-reload");
				await pi.prompt("observe the restored tool set");
				await pi.awaitAssistantTurn();
				const restored = pi.providerObservations().at(-1)?.tools;
				expect(
					(Array.isArray(restored) ? restored : []).some(
						(tool) => (tool as { name?: string }).name === "ast_grep_search",
					),
				).toBe(true);

				const restores = () =>
					pi.lens
						.latencyRows()
						.filter(
							(row) =>
								row.phase === "tool_set_mutation" &&
								(row.metadata as { reason?: string })?.reason ===
									"session_rebuild_restore",
						);
				await expect.poll(() => restores().length, { timeout: 5_000 }).toBe(1);
				const restoreRows = restores();
				expect(restoreRows).toHaveLength(1);
				expect(restoreRows[0]?.metadata).toMatchObject({
					reason: "session_rebuild_restore",
					addedCount: expect.any(Number),
					removedCount: expect.any(Number),
				});
			},
		);
	}, 60_000);

	it("omits a project-disabled tool from pi's wire roster and records it once", async () => {
		await withRealPi(
			{
				fixture: "tools-disabled",
				script: "script.json",
				args: ["--no-lazy-tools"],
				env: { PI_LENS_TEST_MODE: "0" },
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
						line.includes(
							"session_start: disabled tools = ast_grep_replace, health (2 total)",
						),
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

	it("renders the session-start orientation from the enabled tool set (#2967)", async () => {
		await withRealPi(
			{
				fixture: "tools-guidance",
				script: "script.json",
				env: { PI_LENS_TEST_MODE: "0" },
			},
			async (pi) => {
				// A second start in this process runs full mode, which is where the
				// orientation is published (the first start protects TUI latency).
				await pi.newSession();
				await pi.prompt("read the session-start orientation");
				await pi.awaitAssistantTurn();
				const text = orientationText(pi);
				expect(text).toContain("pi-lens active");
				// Every disabled tool is never mentioned ...
				expect(text).not.toMatch(/\bsymbol_search\b/);
				expect(text).not.toMatch(/\bmodule_report\b/);
				expect(text).not.toMatch(/\bread_enclosing\b/);
				// ... while the tool that stayed enabled is still advertised.
				expect(text).toContain("read_symbol");
				expect(text).toContain("lens_diagnostics");
			},
		);
	}, 60_000);

	it("keeps the orientation byte-stable for the default config (#2967)", async () => {
		await withRealPi(
			{
				fixture: "scenario-1",
				script: "script.json",
				env: { PI_LENS_TEST_MODE: "0" },
			},
			async (pi) => {
				await pi.newSession();
				await pi.prompt("read the session-start orientation");
				await pi.awaitAssistantTurn();
				const text = orientationText(pi);
				expect(text).toContain(
					"symbol_search → module_report → read_symbol/read_enclosing — ranked identifier search, then navigable outline/callback handles + exact body reads; cheaper than reading a whole file before editing.",
				);
				expect(text).toContain(
					"blocking errors (including pre-existing) show inline and must be fixed.",
				);
			},
		);
	}, 60_000);

	it("does not emit a disabled-tools note for the default config", async () => {
		await withRealPi(
			{
				fixture: "scenario-1",
				script: "script.json",
				env: { PI_LENS_TEST_MODE: "0" },
			},
			async (pi) => {
				await pi.prompt("check the default startup note");
				await pi.awaitAssistantTurn();
				expect(
					pi.lens
						.sessionStartLog()
						.some((line) => line.includes("session_start: disabled tools =")),
				).toBe(false);
			},
		);
	});

	it("bounds a long disabled-tools session note", async () => {
		await withRealPi(
			{
				fixture: "tools-disabled-many",
				script: "script.json",
				env: { PI_LENS_TEST_MODE: "0" },
			},
			async (pi) => {
				await pi.prompt("report the disabled tools");
				await pi.awaitAssistantTurn();
				expect(
					pi.lens
						.sessionStartLog()
						.some((line) =>
							line.includes(
								"session_start: disabled tools = ast_grep_search, ast_grep_replace, ast_grep_outline, lsp_navigation, lens_diagnostics, lens_diagnostic_mark, symbol_search, module_report and 9 more (17 total)",
							),
						),
				).toBe(true);
			},
		);
	});

	it("keeps the activation loader registered and emits its config diagnostic once", async () => {
		await withRealPi(
			{
				fixture: "loader-disabled",
				script: "script.json",
				env: { PI_LENS_TEST_MODE: "0" },
			},
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
				env: { PI_LENS_TEST_MODE: "0" },
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
