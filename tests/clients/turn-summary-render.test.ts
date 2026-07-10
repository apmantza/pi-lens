import { describe, expect, it } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { renderTurnSummaryMessage } from "../../clients/turn-summary-render.js";
import { TurnSummaryCollector } from "../../clients/turn-summary.js";

// Minimal fake theme — the renderer only calls fg()/bold(), never the ANSI
// color-mode internals, so we don't need the real Theme class's constructor.
function makeFakeTheme(): Theme {
	return {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as unknown as Theme;
}

function makeMessage(details: unknown) {
	return {
		role: "custom" as const,
		customType: "pilens:turn-summary",
		content: "fallback",
		display: true,
		details,
		timestamp: Date.now(),
	};
}

describe("renderTurnSummaryMessage (#484)", () => {
	it("returns undefined when details is missing", () => {
		const theme = makeFakeTheme();
		const result = renderTurnSummaryMessage(
			makeMessage(undefined) as never,
			{ expanded: false },
			theme,
		);
		expect(result).toBeUndefined();
	});

	it("renders a single collapsed line matching formatTurnSummaryLine", () => {
		const collector = new TurnSummaryCollector();
		collector.recordDiagnostic("/repo/a.ts", { tool: "eslint" });
		collector.recordFormat("/repo/a.ts", { tool: "prettier" });
		const details = collector.consume(1, () => "a.ts");

		const theme = makeFakeTheme();
		const component = renderTurnSummaryMessage(
			makeMessage(details) as never,
			{ expanded: false },
			theme,
		);
		expect(component).toBeDefined();
		const lines = component?.render(80);
		expect(lines).toHaveLength(1);
		expect(lines?.[0]).toBe(
			"pi-lens: 1 diagnostic (eslint 1) · 1 reformatted (prettier 1)",
		);
	});

	it("renders file-major blocks when expanded", () => {
		const collector = new TurnSummaryCollector();
		collector.recordFormat("/repo/b.ts", { tool: "prettier" });
		collector.recordDiagnostic("/repo/a.ts", {
			tool: "eslint",
			ruleId: "no-unused-vars",
			severity: "warning",
			line: 4,
			description: "'x' is declared but never used",
		});
		collector.recordAutofix("/repo/a.ts", { tool: "ruff" });
		const details = collector.consume(1, (fp) =>
			fp.replace("/repo/", ""),
		);

		const theme = makeFakeTheme();
		const component = renderTurnSummaryMessage(
			makeMessage(details) as never,
			{ expanded: true },
			theme,
		);
		const lines = component?.render(80) ?? [];

		// File-major: a.ts block appears before b.ts (alphabetical), and each
		// file's own events are grouped under its own header line.
		const aIndex = lines.findIndex((l) => l.includes("a.ts"));
		const bIndex = lines.findIndex((l) => l.includes("b.ts"));
		expect(aIndex).toBeGreaterThanOrEqual(0);
		expect(bIndex).toBeGreaterThan(aIndex);

		const joined = lines.join("\n");
		expect(joined).toContain("autofix:ruff");
		expect(joined).toContain("eslint");
		expect(joined).toContain("no-unused-vars");
		expect(joined).toContain(":4");
		expect(joined).toContain("format:prettier");
	});

	it("component.invalidate() is a callable no-op", () => {
		const collector = new TurnSummaryCollector();
		collector.recordFormat("/repo/a.ts", { tool: "prettier" });
		const details = collector.consume(1);
		const component = renderTurnSummaryMessage(
			makeMessage(details) as never,
			{ expanded: false },
			makeFakeTheme(),
		);
		expect(() => component?.invalidate()).not.toThrow();
	});
});
