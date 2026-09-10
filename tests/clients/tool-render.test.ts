import { describe, expect, it } from "vitest";
import type { Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { compactRenderResult } from "../../tools/render-compact.js";
import {
	buildCompactToolLine,
	wrapToolForCompactLine,
	wrapToolsForCompactLine,
} from "../../clients/tool-render.js";

// Fake theme that tags each call with its token name so tests can assert
// WHICH semantic token was used (status/name/detail), not just raw text —
// same style as tests/clients/turn-summary-render.test.ts's makeFakeTheme,
// but token-preserving instead of pass-through so token usage is provable.
function makeFakeTheme(): Theme {
	return {
		fg: (color: string, text: string) => `[${color}:${text}]`,
		bold: (text: string) => `<b>${text}</b>`,
	} as unknown as Theme;
}

function fakeContext(overrides: Record<string, unknown> = {}) {
	return {
		args: {},
		toolCallId: "call-1",
		invalidate: () => {},
		lastComponent: undefined,
		state: {},
		cwd: "/repo",
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: false,
		isError: false,
		...overrides,
	} as never;
}

describe("buildCompactToolLine", () => {
	it("uses the success glyph and splits on ' — ' into name/detail tokens", () => {
		const theme = makeFakeTheme();
		const line = buildCompactToolLine(
			"lens_diagnostics all — 3 blocking · 3 errors · 2 warnings (1 file)",
			false,
			theme,
		);
		expect(line).toBe(
			"[success:✓] [toolTitle:<b>lens_diagnostics all</b>] [dim:—] " +
				"[toolOutput:3 blocking · 3 errors · 2 warnings (1 file)]",
		);
	});

	it("uses the error glyph and error token for isError results", () => {
		const theme = makeFakeTheme();
		const line = buildCompactToolLine("ast_grep_search — boom", true, theme);
		expect(line).toContain("[error:✗]");
		expect(line).toContain("[error:boom]");
		expect(line).not.toContain("[toolOutput:");
	});

	it("styles the whole string as one span when no ' — ' separator is present", () => {
		const theme = makeFakeTheme();
		const line = buildCompactToolLine("clean", false, theme);
		expect(line).toBe("[success:✓] [toolOutput:clean]");
	});
});

describe("wrapToolForCompactLine — representative tools", () => {
	// lens_diagnostics: mirrors tools/lens-diagnostics.ts's summarizer shape
	// (name + mode hint + counts joined by " — ").
	const diagnosticsTool = {
		name: "lens_diagnostics" as const,
		label: "Project Diagnostics",
		description: "d",
		parameters: {} as never,
		async execute() {
			return { content: [] };
		},
		renderResult: compactRenderResult<{
			mode?: string;
			totalBlocking?: number;
		}>(({ details, isError, text }) => {
			const mode = details?.mode ?? "delta";
			if (isError) return `lens_diagnostics ${mode} — ${text.split("\n")[0]}`;
			return `lens_diagnostics ${mode} — ${details?.totalBlocking ?? 0} blocking`;
		}),
	};

	// lsp_diagnostics: mirrors tools/lsp-diagnostics.ts's "toolname — detail"
	// shape without an args-derived hint (stand-in for the "format"-adjacent
	// diagnostic-check tool; pi-lens has no tool literally named `format` —
	// formatting runs automatically via the write pipeline, not as a tool).
	const lspDiagnosticsTool = {
		name: "lsp_diagnostics" as const,
		label: "LSP Diagnostics",
		description: "d",
		parameters: {} as never,
		async execute() {
			return { content: [] };
		},
		renderResult: compactRenderResult<{ totalDiagnostics?: number }>(
			({ details, isError, text }) => {
				if (isError) return `lsp_diagnostics — ${text.split("\n")[0]}`;
				return `lsp_diagnostics — ${details?.totalDiagnostics ?? 0} diagnostics`;
			},
		),
	};

	for (const [label, tool, result, expectSubstring] of [
		[
			"lens_diagnostics",
			diagnosticsTool,
			{ content: [], details: { mode: "all", totalBlocking: 3 } },
			"lens_diagnostics all",
		],
		[
			"lsp_diagnostics",
			lspDiagnosticsTool,
			{ content: [], details: { totalDiagnostics: 5 } },
			"lsp_diagnostics",
		],
	] as const) {
		it(`${label}: collapsed result becomes a single combined line reusing its own summary`, () => {
			const wrapped = wrapToolForCompactLine(
				tool as unknown as ToolDefinition<any, any, any>,
			);
			const theme = makeFakeTheme();
			const ctx = fakeContext();

			// Call row is blanked once a settled result exists.
			const callComponent = wrapped.renderCall?.(
				{},
				theme,
				Object.assign({}, ctx as object, { isPartial: false }) as never,
			);
			expect(callComponent?.render(80)).toEqual([]);

			const resultComponent = wrapped.renderResult?.(
				result as never,
				{ expanded: false, isPartial: false },
				theme,
				ctx,
			);
			const lines = resultComponent?.render(200) ?? [];
			expect(lines).toHaveLength(1);
			expect(lines[0]).toContain(expectSubstring);
			// Status glyph present (success — none of the fixtures are errors).
			expect(lines[0]).toContain("[success:✓]");
		});
	}

	it("expanded view falls through to the tool's own renderResult (full output preserved)", () => {
		const wrapped = wrapToolForCompactLine(
			diagnosticsTool as unknown as ToolDefinition<any, any, any>,
		);
		const theme = makeFakeTheme();
		const ctx = fakeContext({ expanded: true });
		const result = {
			content: [{ type: "text", text: "full diagnostic dump\nline two" }],
			details: { mode: "all", totalBlocking: 3 },
		};
		const component = wrapped.renderResult?.(
			result as never,
			{ expanded: true, isPartial: false },
			theme,
			ctx,
		);
		const lines = component?.render(200) ?? [];
		expect(lines.join("\n")).toContain("full diagnostic dump");
		expect(lines.join("\n")).toContain("line two");
	});

	it("expanded call row shows the tool name (call row is only blanked when collapsed)", () => {
		const wrapped = wrapToolForCompactLine(
			diagnosticsTool as unknown as ToolDefinition<any, any, any>,
		);
		const theme = makeFakeTheme();
		const component = wrapped.renderCall?.(
			{},
			theme,
			fakeContext({ expanded: true }) as never,
		);
		const lines = component?.render(80) ?? [];
		expect(lines.join(" ")).toContain("lens_diagnostics");
	});

	it("call row stays visible (not blanked) while the tool is still running (isPartial)", () => {
		const wrapped = wrapToolForCompactLine(
			diagnosticsTool as unknown as ToolDefinition<any, any, any>,
		);
		const theme = makeFakeTheme();
		const component = wrapped.renderCall?.(
			{},
			theme,
			fakeContext({ isPartial: true }) as never,
		);
		const lines = component?.render(80) ?? [];
		expect(lines.length).toBeGreaterThan(0);
	});

	it("errors flow through with the error glyph and error token", () => {
		const wrapped = wrapToolForCompactLine(
			diagnosticsTool as unknown as ToolDefinition<any, any, any>,
		);
		const theme = makeFakeTheme();
		const result = {
			content: [{ type: "text", text: "boom" }],
			isError: true,
			details: {},
		};
		const component = wrapped.renderResult?.(
			result as never,
			{ expanded: false, isPartial: false },
			theme,
			fakeContext({ isError: true }),
		);
		const lines = component?.render(200) ?? [];
		expect(lines[0]).toContain("[error:✗]");
	});

	// #1341 review: pi passes results as {content, details} -- failure arrives
	// on context.isError. A failed tool must not render a success glyph.
	it("error status comes from context.isError when the result omits isError", () => {
		const wrapped = wrapToolForCompactLine(
			diagnosticsTool as unknown as ToolDefinition<any, any, any>,
		);
		const theme = makeFakeTheme();
		const component = wrapped.renderResult?.(
			{ content: [{ type: "text", text: "boom" }], details: {} } as never,
			{ expanded: false, isPartial: false },
			theme,
			fakeContext({ isError: true }),
		);
		const line = (component?.render(120) ?? []).join("");
		expect(line).toContain("[error:✗]");
		expect(line).not.toContain("[success:");
	});

	it("tools without a renderResult pass through unchanged (nothing to compact)", () => {
		const bare = {
			name: "pi_lens_activate_tools" as const,
			label: "Activate Tools",
			description: "d",
			parameters: {} as never,
			async execute() {
				return { content: [] };
			},
		};
		const wrapped = wrapToolForCompactLine(
			bare as unknown as ToolDefinition<any, any, any>,
		);
		expect(wrapped).toBe(bare);
		expect(wrapped.renderCall).toBeUndefined();
		expect(wrapped.renderResult).toBeUndefined();
	});

	it("wrapToolsForCompactLine wraps only tools that have renderResult", () => {
		const bare = {
			name: "pi_lens_activate_tools" as const,
			label: "Activate Tools",
			description: "d",
			parameters: {} as never,
			async execute() {
				return { content: [] };
			},
		};
		const wrapped = wrapToolsForCompactLine([diagnosticsTool, bare] as never);
		expect(wrapped[0].renderResult).not.toBe(diagnosticsTool.renderResult);
		expect(wrapped[1]).toBe(bare);
	});

	it("a throwing original renderResult falls back to the first content line instead of blanking", () => {
		const throwing = {
			name: "flaky_tool" as const,
			label: "Flaky",
			description: "d",
			parameters: {} as never,
			async execute() {
				return { content: [] };
			},
			renderResult: () => {
				throw new Error("boom");
			},
		};
		const wrapped = wrapToolForCompactLine(
			throwing as unknown as ToolDefinition<any, any, any>,
		);
		const theme = makeFakeTheme();
		const result = {
			content: [{ type: "text", text: "raw first line\nsecond" }],
		};
		const component = wrapped.renderResult?.(
			result as never,
			{ expanded: false, isPartial: false },
			theme,
			fakeContext(),
		);
		const lines = component?.render(200) ?? [];
		expect(lines[0]).toContain("raw first line");
	});
});
