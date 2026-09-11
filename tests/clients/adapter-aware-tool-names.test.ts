import * as fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
	formatActionableWarningsAdvisory,
	type ActionableWarningsReport,
} from "../../clients/actionable-warnings.js";
import { formatCodeQualityWarningsAdvisory } from "../../clients/code-quality-warnings.js";
import { resolveLensToolName } from "../../clients/tool-config.js";
import { stripSource } from "../support/sweep-kit.js";

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
});
