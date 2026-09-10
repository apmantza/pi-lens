import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TOOL_REGISTRY } from "../../clients/tool-config.js";
import { MAX_RESULT_BYTES } from "../../tools/render-compact.js";
import { McpHarness } from "../mcp/harness.js";
import { createPiMock } from "../support/pi-mock.js";

type ToolResult = {
	content?: { type: string; text?: string }[];
	isError?: boolean;
};

function stableRenderedText(
	toolName: string,
	text: string | undefined,
): string {
	if (toolName !== "project_report") return text ?? "";
	// Each host starts its own cold graph build. The timestamp is runtime metadata,
	// not rendered result content, so compare every other byte of the full text.
	return (text ?? "").replace(/("when":\s*")[^"]+(")/, "$1<build-time>$2");
}

const EXACT_PARITY_TOOLS = new Set([
	"ast_grep_search",
	"ast_grep_replace",
	"lsp_navigation",
	"lens_diagnostics",
	"module_report",
]);

describe("result contract across registered tool surfaces", () => {
	let cwd: string;
	const originalCwd = process.cwd();
	let mcp: McpHarness;
	let pi: ReturnType<typeof createPiMock>;

	beforeAll(async () => {
		cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-result-contract-"));
		const fixtureRoot = path.resolve("tests/fixtures");
		fs.copyFileSync(
			path.join(fixtureRoot, "tool-smoke/ast-grep-baseline/bad.ts"),
			path.join(cwd, "bad.ts"),
		);
		fs.writeFileSync(
			path.join(cwd, "fixture.ts"),
			"export const fixture = 1;\nfunction enclosing() { return fixture; }\n",
		);
		// Oversized fixture (refs #2852 N3): one huge symbol whose read_symbol
		// body exceeds MAX_RESULT_BYTES, so the pi surface's only byte bound —
		// the one inside finalizeToolResult — has to engage.
		const bigLines = [
			"// Oversized fixture: the symbol body below must exceed MAX_RESULT_BYTES.",
			"export function bigSymbol(): string[] {",
			"\tconst acc: string[] = [];",
		];
		for (let i = 0; i < 1500; i++) {
			bigLines.push(`\tacc.push("line-${i}-${"x".repeat(80)}");`);
		}
		bigLines.push("\treturn acc;", "}");
		fs.writeFileSync(path.join(cwd, "big.ts"), `${bigLines.join("\n")}\n`);
		process.chdir(cwd);
		pi = createPiMock();
		const { default: extension } = await import("../../index.js");
		extension(pi.asExtensionAPI());
		mcp = new McpHarness({ cwd });
		await mcp.request(1, "initialize", {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "result-contract", version: "0" },
		});
	});

	afterAll(() => {
		mcp?.dispose();
		process.chdir(originalCwd);
		fs.rmSync(cwd, { recursive: true, force: true });
	});

	// Whole-roster sweep: drives every paired registry tool through a real pi
	// call AND a real MCP child (#2800 item 5). Under CI load it crossed
	// vitest's 5 s default twice on #2852 r6 (run 34442664966, both
	// attempts); the budget mirrors the other whole-tree sweeps (#2857).
	it("keeps every paired registry tool's real rendered text identical", async () => {
		const fixtures: Record<string, Record<string, unknown>> = {
			ast_grep_search: {
				pattern: "$A.sort()",
				lang: "typescript",
				paths: ["bad.ts"],
			},
			ast_grep_replace: {
				pattern: "$A.sort()",
				rewrite: "$A.sort((a, b) => a - b)",
				lang: "typescript",
				paths: ["bad.ts"],
				apply: false,
			},
			lsp_navigation: { operation: "documentSymbol", path: "fixture.ts" },
			lens_diagnostics: { source: "lsp", scope: "paths", paths: ["bad.ts"] },
			symbol_search: { query: "fixture", paths: ["fixture.ts"] },
			module_report: { path: "fixture.ts", view: "compact" },
			project_report: { view: "compact", limit: 1 },
			read_symbol: { path: path.join(cwd, "fixture.ts"), symbol: "enclosing" },
			read_enclosing: { path: path.join(cwd, "fixture.ts"), line: 2 },
			effective_config: { file: "fixture.ts" },
		};

		for (const entry of TOOL_REGISTRY) {
			if (!entry.piName || !entry.mcpName) continue;
			const args = fixtures[entry.name];
			expect(args, `${entry.name}: missing real fixture`).toBeDefined();
			const piTool = pi.getTool(entry.piName) as {
				execute?: (...args: unknown[]) => Promise<ToolResult>;
			};
			expect(
				piTool?.execute,
				`missing pi handler for ${entry.name}`,
			).toBeTypeOf("function");
			const piResult = await piTool.execute?.(
				"governance",
				args,
				new AbortController().signal,
				undefined,
				{ cwd },
			);
			const mcpResult = await mcp.request(
				100 + entry.name.length,
				"tools/call",
				{
					name: entry.mcpName,
					arguments: { ...args, ...(args.path ? { file: args.path } : {}) },
				},
			);
			const mcpText = (mcpResult.result as ToolResult).content?.[0]?.text;
			const piText = piResult?.content?.[0]?.text;
			if (EXACT_PARITY_TOOLS.has(entry.name)) {
				expect(
					stableRenderedText(entry.name, mcpText),
					`${entry.name}: complete rendered text`,
				).toBe(stableRenderedText(entry.name, piText));
			}
			const mcpResultValue = mcpResult.result as ToolResult;
			expect(mcpText, `${entry.name}: MCP result`).toMatch(
				/result (?:ok|error)\n(?:diag severity=.*\n)?usage tokens=\d+ elapsed-ms=\d+ bytes=\d+ truncated=(?:true|false)$/,
			);
			expect(
				mcpText?.includes("result error"),
				`${entry.name}: MCP verdict matches isError`,
			).toBe(mcpResultValue.isError === true);
			expect(mcpText, `${entry.name}: MCP usage`).toMatch(
				/usage tokens=\d+ elapsed-ms=\d+ bytes=\d+ truncated=(?:true|false)/,
			);
			expect(piText, `${entry.name}: pi result`).toMatch(
				/result (?:ok|error)\n(?:diag severity=.*\n)?usage tokens=\d+ elapsed-ms=\d+ bytes=\d+ truncated=(?:true|false)$/,
			);
			expect(
				piText?.includes("result error"),
				`${entry.name}: pi verdict matches isError`,
			).toBe(piResult?.isError === true);
			expect(piText, `${entry.name}: pi usage`).toMatch(
				/usage tokens=\d+ elapsed-ms=\d+ bytes=\d+ truncated=(?:true|false)/,
			);
		}
	}, 30_000);

	it("covers every pi-only registry tool through pi and proves MCP absence", async () => {
		const piOnlyFixtures: Record<string, Record<string, unknown>> = {
			ast_grep_outline: { paths: ["fixture.ts"], lang: "typescript" },
			ast_grep_dump: {
				source: "function fixture() { return 1; }",
				lang: "typescript",
			},
			lens_diagnostic_mark: {
				filePath: "bad.ts",
				line: 4,
				message: "a real fixture disposition",
				disposition: "defer",
			},
			pi_lens_activate_tools: { tools: ["ast_grep_outline"] },
		};
		const listed = (await mcp.request(2, "tools/list", {})).result as {
			tools?: { name?: string }[];
		};
		const mcpNames = new Set(listed.tools?.map((tool) => tool.name));
		for (const entry of TOOL_REGISTRY) {
			if (!entry.piName || entry.mcpName) continue;
			const args = piOnlyFixtures[entry.name];
			expect(
				args,
				`${entry.name}: untested pi-only registry row`,
			).toBeDefined();
			expect(
				mcpNames.has(`pilens_${entry.name}`),
				`${entry.name}: MCP side is absent`,
			).toBe(false);
			const piTool = pi.getTool(entry.piName) as {
				execute?: (...args: unknown[]) => Promise<ToolResult>;
			};
			expect(piTool?.execute, `${entry.name}: missing pi handler`).toBeTypeOf(
				"function",
			);
			const result = await piTool.execute?.(
				"governance",
				args,
				new AbortController().signal,
				undefined,
				{ cwd },
			);
			const text = result?.content?.[0]?.text;
			expect(text, `${entry.name}: pi rendering`).toMatch(
				/result (?:ok|error)\n(?:diag severity=.*\n)?usage tokens=\d+ elapsed-ms=\d+ bytes=\d+ truncated=(?:true|false)$/,
			);
			expect(
				text?.includes("result error"),
				`${entry.name}: pi verdict matches isError`,
			).toBe(result?.isError === true);
		}
		// An erroring pi-only call exercises that verdict⟺isError pin in the
		// failing direction: every registry fixture above succeeds, so a
		// hard-coded `result ok` footer would pass the loop unchecked.
		const markTool = pi.getTool("lens_diagnostic_mark") as {
			execute?: (...args: unknown[]) => Promise<ToolResult>;
		};
		const badMark = await markTool.execute?.(
			"governance",
			{
				filePath: "bad.ts",
				line: 4,
				message: "a real fixture disposition",
				disposition: "not-a-disposition",
			},
			new AbortController().signal,
			undefined,
			{ cwd },
		);
		expect(badMark?.isError, "invalid disposition errors").toBe(true);
		expect(badMark?.content?.[0]?.text ?? "").toContain("result error");
	});

	it("bounds an oversized pi result through the real index.ts wrapper", async () => {
		// N3 (refs #2852): the byte bound inside finalizeToolResult is the pi
		// surface's only bound. Drive the real index.ts registration wrapper
		// (createPiMock + extension factory above) with a >MAX_RESULT_BYTES
		// read_symbol body and assert the delivered text is bounded — dropping
		// boundToolResultText from finalizeToolResult reds here.
		const piTool = pi.getTool("read_symbol") as {
			execute?: (...args: unknown[]) => Promise<ToolResult>;
		};
		expect(piTool?.execute).toBeTypeOf("function");
		const result = await piTool.execute?.(
			"governance",
			{ path: path.join(cwd, "big.ts"), symbol: "bigSymbol" },
			new AbortController().signal,
			undefined,
			{ cwd },
		);
		const text = result?.content?.[0]?.text ?? "";
		expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(
			MAX_RESULT_BYTES,
		);
		expect(text).toContain("characters omitted");
		// Item 7 (refs #2800): the footer reports the delivered payload, and the
		// bound reserves the footer's own size, so footer included the text stays
		// inside the budget. Dropping the reserve reds the byteLength assert;
		// reporting pre-bound bytes reds the bytes= assert below.
		const delivered = Number(text.match(/bytes=(\d+)/)?.[1]);
		expect(Number.isFinite(delivered), "bytes= present").toBe(true);
		expect(delivered).toBeLessThanOrEqual(MAX_RESULT_BYTES);
		expect(text).toMatch(/truncated=true$/);
	});

	it("stamps exact delivered bytes on a normal result through both surfaces", async () => {
		// Item 7 (refs #2800): bytes= is the UTF-8 byte count of the delivered
		// payload text (the footer excluded), measured here independently from
		// the rendered text on both real surfaces.
		const args = { path: path.join(cwd, "fixture.ts"), symbol: "enclosing" };
		const readByteFigures = (text: string | undefined) => {
			const match = text?.match(
				/\n\nresult ok\nusage tokens=\d+ elapsed-ms=\d+ bytes=(\d+) truncated=(true|false)$/,
			);
			expect(match, "footer with bytes=/truncated=").not.toBeNull();
			const payload = text?.slice(0, text.indexOf("\n\nresult ok")) as string;
			return {
				bytes: Number(match?.[1]),
				truncated: match?.[2],
				measured: Buffer.byteLength(payload, "utf8"),
			};
		};
		const piTool = pi.getTool("read_symbol") as {
			execute?: (...args: unknown[]) => Promise<ToolResult>;
		};
		const piResult = await piTool.execute?.(
			"governance",
			args,
			new AbortController().signal,
			undefined,
			{ cwd },
		);
		const piFigures = readByteFigures(piResult?.content?.[0]?.text);
		expect(piFigures.truncated).toBe("false");
		expect(piFigures.bytes).toBe(piFigures.measured);
		const mcpResult = await mcp.request(150, "tools/call", {
			name: "pilens_read_symbol",
			arguments: { ...args, file: args.path },
		});
		const mcpFigures = readByteFigures(
			(mcpResult.result as ToolResult).content?.[0]?.text,
		);
		expect(mcpFigures.truncated).toBe("false");
		expect(mcpFigures.bytes).toBe(mcpFigures.measured);
	});

	it("sums the turn's tool calls onto the real cache_usage row (refs #2800 item 7)", async () => {
		// Real sinks: no cache-observability mock. Two normal calls plus one
		// oversized call close a turn; the emitted message_end writes the real
		// `cache_usage` latency row whose toolResultBytes must equal the sum of
		// the delivered footers' bytes= figures, and whose toolResultsTruncated
		// must count the oversized call. Dropping the wrapper aggregation reds
		// both asserts with 0.
		const { flushLatencyLog, getLatencyLogPath } =
			await import("../../clients/latency-logger.js");
		const sessionId = `row-bytes-${Date.now().toString(36)}`;
		const ctx = {
			cwd,
			sessionManager: { getSessionId: () => sessionId },
		};
		const readSymbol = pi.getTool("read_symbol") as {
			execute?: (...args: unknown[]) => Promise<ToolResult>;
		};
		const executed = [
			await readSymbol.execute?.(
				"row-1",
				{ path: path.join(cwd, "fixture.ts"), symbol: "enclosing" },
				new AbortController().signal,
				undefined,
				ctx,
			),
			await readSymbol.execute?.(
				"row-2",
				{ path: path.join(cwd, "fixture.ts"), symbol: "enclosing" },
				new AbortController().signal,
				undefined,
				ctx,
			),
			await readSymbol.execute?.(
				"row-3",
				{ path: path.join(cwd, "big.ts"), symbol: "bigSymbol" },
				new AbortController().signal,
				undefined,
				ctx,
			),
		];
		const figures = executed.map((result) => {
			const text = result?.content?.[0]?.text ?? "";
			return {
				bytes: Number(text.match(/bytes=(\d+)/)?.[1]),
				truncated: /truncated=true$/.test(text),
			};
		});
		for (const figure of figures) {
			expect(Number.isFinite(figure.bytes), "footer bytes= present").toBe(true);
		}
		// #1742's sanctioned opt-out: the row must be read from the REAL sink,
		// so test mode is scoped off for exactly this write/read window.
		const previousTestMode = process.env.PI_LENS_TEST_MODE;
		process.env.PI_LENS_TEST_MODE = "0";
		try {
			await pi.emit(
				"message_end",
				{
					message: {
						role: "assistant",
						provider: "p",
						model: "m",
						usage: { input: 1, output: 1, cacheRead: 1, cacheWrite: 0 },
					},
				},
				ctx,
			);
			await flushLatencyLog();
		} finally {
			if (previousTestMode === undefined) {
				delete process.env.PI_LENS_TEST_MODE;
			} else {
				process.env.PI_LENS_TEST_MODE = previousTestMode;
			}
		}
		const rows = fs
			.readFileSync(getLatencyLogPath(), "utf8")
			.split("\n")
			.filter(Boolean)
			.map(
				(line) =>
					JSON.parse(line) as {
						phase?: string;
						metadata?: Record<string, unknown>;
					},
			)
			.filter(
				(entry) =>
					entry.phase === "cache_usage" &&
					entry.metadata?.sessionId === sessionId,
			);
		expect(rows, "one cache_usage row for the session").toHaveLength(1);
		const metadata = rows[0].metadata as Record<string, unknown>;
		expect(metadata.toolResultBytes).toBe(
			figures.reduce((sum, figure) => sum + figure.bytes, 0),
		);
		expect(metadata.toolResultsTruncated).toBe(
			figures.filter((figure) => figure.truncated).length,
		);
	});
});
