import * as fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
	formatActionableWarningsAdvisory,
	type ActionableWarningsReport,
} from "../../clients/actionable-warnings.js";
import { formatCodeQualityWarningsAdvisory } from "../../clients/code-quality-warnings.js";
import {
	TOOL_REGISTRY,
	resolveLensToolName,
} from "../../clients/tool-config.js";
import { generatedSkipNotice } from "../../clients/lens-engine.js";
import { CacheManager } from "../../clients/cache-manager.js";
import { consumeSessionStartGuidance } from "../../clients/runtime-context.js";
import { SESSION_START_GUIDANCE } from "../../clients/runtime-session.js";
import { stripSource } from "../support/sweep-kit.js";
import { setupTestEnvironment } from "./test-utils.js";

const report: ActionableWarningsReport = {
	generatedAt: new Date(0).toISOString(),
	sessionId: "s",
	turnIndex: 1,
	scope: "turn_delta",
	deltaOnly: true,
	includeLspCodeActions: false,
	files: [],
	summary: {
		warnings: 1,
		unsuppressed: 1,
		suppressed: 0,
		files: 1,
		actions: 0,
		autoFixEligible: 0,
	},
};

describe("#2535 adapter-aware agent tool names", () => {
	it("pi-host advisories name the pi tool the agent receives", () => {
		const text = formatActionableWarningsAdvisory(report, "/tmp/project", "pi");
		expect(text).toContain("Use lens_diagnostics with mode=delta");
		expect(text).not.toContain("pilens_diagnostics");
	});

	it("MCP-host advisories name the MCP tool the agent receives", () => {
		const text = formatActionableWarningsAdvisory(
			report,
			"/tmp/project",
			"mcp",
		);
		expect(text).toContain("Use pilens_diagnostics with mode=delta");
		expect(text).not.toContain("Use lens_diagnostics");
		expect(resolveLensToolName("lens_diagnostics", "mcp")).toBe(
			"pilens_diagnostics",
		);
	});

	it("code-quality advisories use the same resolver on MCP", () => {
		const text = formatCodeQualityWarningsAdvisory(
			{
				generatedAt: new Date(0).toISOString(),
				sessionId: "s",
				turnIndex: 1,
				files: 1,
				warnings: 1,
				summary: { warnings: 1, files: 1, topRules: [] },
				topRules: [],
				entries: [],
			} as never,
			"/tmp/project",
			"mcp",
		);
		expect(text).toContain("Use pilens_diagnostics with mode=delta");
	});

	it("the grep guard accepts routed strings and rejects the nearest direct string", () => {
		const scan = (source: string): boolean =>
			/(?:Use|Run)\s+lens_diagnostics\b/.test(
				stripSource(source, { strings: "keep" }),
			);
		// Recurrence: a comment quoting a tool name is prose, not an advisory.
		expect(scan("// Use lens_diagnostics with mode=delta\nconst x = 1;")).toBe(
			false,
		);
		expect(
			scan('const advisory = "Use lens_diagnostics with mode=delta";'),
		).toBe(true);
		expect(
			scan(
				'const advisory = `Use ${resolveLensToolName("lens_diagnostics", host)}`;',
			),
		).toBe(false);
	});

	it("the production advisory population contains no direct pi tool name", () => {
		const files = [
			"clients/actionable-warnings.ts",
			"clients/code-quality-warnings.ts",
			"clients/git-guard.ts",
		];
		for (const file of files) {
			const source = fs.readFileSync(file, "utf8");
			expect(
				/(?:Use|Run)\s+lens_diagnostics\b/.test(
					stripSource(source, { strings: "keep" }),
				),
				file,
			).toBe(false);
		}
	});

	// #2535 F3: a registry tool with a pi name and no MCP name must be
	// pi-only BY DECLARATION (PI_ONLY_TOOL_REASONS), never by omission — a
	// missing entry used to degrade silently into the pi name on MCP, sending
	// the agent to a dead call. The map is read dynamically so the red-first
	// run fails on the missing declaration itself, not on a module-load error.
	it("every registry row resolves on both hosts, or is declared pi-only", async () => {
		const toolConfig = (await import("../../clients/tool-config.js")) as Record<
			string,
			unknown
		>;
		const declared = toolConfig.PI_ONLY_TOOL_REASONS as
			| Record<string, string>
			| undefined;
		expect(
			declared,
			"pi-only tools must be declared in PI_ONLY_TOOL_REASONS",
		).toBeDefined();
		const declaredNames = Object.keys(declared ?? {}).sort();
		const piOnlyNames = TOOL_REGISTRY.filter(
			(entry) => entry.piName && !entry.mcpName,
		)
			.map((entry) => entry.name)
			.sort();
		// Reject twin: an omission (pi name, no MCP name, no declaration) reds
		// here instead of degrading into a wrong answer at render time.
		expect(piOnlyNames).toEqual(declaredNames);
		for (const entry of TOOL_REGISTRY) {
			if (entry.piName && entry.mcpName) {
				expect(resolveLensToolName(entry.name, "pi")).toBe(entry.piName);
				expect(resolveLensToolName(entry.name, "mcp")).toBe(entry.mcpName);
			} else if (entry.piName && !entry.mcpName) {
				expect(resolveLensToolName(entry.name, "pi")).toBe(entry.piName);
				// Recurrence #2535 F3: MCP resolution of a pi-only tool must be
				// visibly unavailable, never the pi name.
				expect(resolveLensToolName(entry.name, "mcp")).toBeUndefined();
			} else if (entry.mcpName && !entry.piName) {
				expect(resolveLensToolName(entry.name, "mcp")).toBe(entry.mcpName);
				expect(resolveLensToolName(entry.name, "pi")).toBeUndefined();
			}
		}
	});

	it("unknown tool names pass through unchanged on both hosts", () => {
		expect(resolveLensToolName("not_a_tool", "pi")).toBe("not_a_tool");
		expect(resolveLensToolName("not_a_tool", "mcp")).toBe("not_a_tool");
	});

	// #2535 F1: the generated-skip notice names the CALLABLE tools for the
	// delivery host. pi has no project-scan surface; MCP has both.
	it("generatedSkipNotice names the pi tool on the pi host", () => {
		const notice = generatedSkipNotice(
			{ generatedNameOnlySkips: 1, generatedDirSkips: 0 },
			"pi",
		);
		expect(notice).toContain("to lens_diagnostics");
		expect(notice).not.toContain("pilens_");
	});

	it("generatedSkipNotice names the MCP tools on the MCP host", () => {
		const notice = generatedSkipNotice(
			{ generatedNameOnlySkips: 1, generatedDirSkips: 0 },
			"mcp",
		);
		expect(notice).toContain("pilens_project_scan");
		expect(notice).toContain("pilens_diagnostics");
		// Reject twin: the bare pi name must not appear — "pilens_diagnostics"
		// contains "lens_diagnostics", so the lookbehind excludes that prefix.
		expect(notice).not.toMatch(/(?<![A-Za-z0-9_])lens_diagnostics/);
	});

	it("generatedSkipNotice stays silent when nothing was skipped, on both hosts", () => {
		const empty = { generatedNameOnlySkips: 0, generatedDirSkips: 0 };
		expect(generatedSkipNotice(empty, "pi")).toBeUndefined();
		expect(generatedSkipNotice(empty, "mcp")).toBeUndefined();
	});

	// Wiring pins: the MCP project-scan route and the shared full-mode path
	// must pass the delivery host into the notice renderer. A runtime probe
	// through either route costs a real scan (an LSP sweep for the shared
	// path), so these pin the call shape the same way the isLensGuardEnabled
	// pin in tests/mcp/server.smoke.test.ts does; the real MCP route test
	// there covers the project-scan delivery end to end.
	it("mcp/server.ts routes its project-scan skip notice through the MCP host", () => {
		const source = stripSource(fs.readFileSync("mcp/server.ts", "utf8"), {
			strings: "keep",
		});
		const callStart = source.indexOf("generatedSkipNotice(snapshot,");
		expect(callStart).toBeGreaterThanOrEqual(0);
		const call = source.slice(callStart, source.indexOf(")", callStart));
		expect(call).toContain('"mcp"');
	});

	it("lens-diagnostics threads the delivery host into its skip notice", () => {
		const source = stripSource(
			fs.readFileSync("tools/lens-diagnostics.ts", "utf8"),
			{ strings: "keep" },
		);
		expect(source).toContain("host: ctx.host ?? ");
		const callStart = source.indexOf("generatedSkipNotice(projectSnapshot,");
		expect(callStart).toBeGreaterThanOrEqual(0);
		const call = source.slice(callStart, source.indexOf(")", callStart));
		expect(call).toContain("host");
	});

	// #2535 sweep remainder: the session-start orientation names nine pi tools
	// and is consumed by BOTH hosts from one shared cache record, so it is
	// translated at delivery through the registry — never re-stored per host.
	// The translator is read dynamically so the red-first run fails on the
	// missing seam itself, not on a module-load error.
	it("session-start guidance reaches pi byte-identical", async () => {
		const toolConfig = (await import("../../clients/tool-config.js")) as Record<
			string,
			unknown
		>;
		const translate = toolConfig.translateGuidanceToolNames as
			| ((content: string, host: "pi" | "mcp") => string)
			| undefined;
		expect(
			translate,
			"guidance must be translated through the registry at delivery",
		).toBeDefined();
		const text = SESSION_START_GUIDANCE.join("\n");
		const render = translate as (content: string, host: "pi" | "mcp") => string;
		expect(render(text, "pi")).toBe(text);
	});

	it("MCP session-start guidance names MCP-callable tools", async () => {
		const env = setupTestEnvironment("pi-lens-guidance-host-");
		try {
			const cacheManager = new CacheManager(false);
			cacheManager.writeCache(
				"session-start-guidance",
				{ content: SESSION_START_GUIDANCE.join("\n") },
				env.tmpDir,
			);
			const consumed = consumeSessionStartGuidance(
				cacheManager,
				env.tmpDir,
				"mcp",
			);
			const text = consumed?.messages[0].content ?? "";
			for (const tool of [
				"pilens_diagnostics",
				"pilens_symbol_search",
				"pilens_module_report",
				"pilens_read_symbol",
				"pilens_read_enclosing",
				"pilens_lsp_navigation",
				"pilens_ast_grep_search",
				"pilens_ast_grep_replace",
			]) {
				expect(text).toContain(tool);
			}
			// Reject twins: no bare pi name survives (the lookbehind excludes
			// the pilens_ prefix the names above carry), and the pi-only
			// activation clause is rephrased instead of naming a dead tool.
			for (const entry of TOOL_REGISTRY) {
				// String() comparison: the as-const literals never overlap, so
				// a direct !== reads as unintentional to tsc.
				if (
					typeof entry.piName !== "string" ||
					typeof entry.mcpName !== "string" ||
					String(entry.piName) === String(entry.mcpName)
				) {
					continue;
				}
				expect(text).not.toMatch(
					new RegExp(`(?<![A-Za-z0-9_])${entry.piName}(?![A-Za-z0-9_])`),
				);
			}
			expect(text).not.toContain("pi_lens_activate_tools");
			expect(text).toContain("call directly");
			// The pi consumer keeps the stored spelling byte-identical.
			const stored = SESSION_START_GUIDANCE.join("\n");
			const cacheManagerPi = new CacheManager(false);
			cacheManagerPi.writeCache(
				"session-start-guidance",
				{ content: stored },
				env.tmpDir,
			);
			const piConsumed = consumeSessionStartGuidance(
				cacheManagerPi,
				env.tmpDir,
			);
			expect(piConsumed?.messages[0].content).toContain(stored);
		} finally {
			env.cleanup();
		}
	});

	it("mcp/session.ts consumes session-start guidance for the MCP host", () => {
		const source = stripSource(
			fs.readFileSync("clients/mcp/session.ts", "utf8"),
			{ strings: "keep" },
		);
		const callStart = source.indexOf("consumeSessionStartGuidance(");
		expect(callStart).toBeGreaterThanOrEqual(0);
		const call = source.slice(callStart, source.indexOf(")", callStart));
		expect(call).toContain('"mcp"');
	});
});
