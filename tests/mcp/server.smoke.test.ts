/**
 * MCP server stdio smoke test — spawns the in-place-compiled server and drives
 * the real newline-delimited JSON-RPC handshake (initialize → tools/list →
 * tools/call), asserting the transport works without needing an MCP client.
 *
 * Requires `npm run build` first (resolves mcp/server.js next to its source);
 * that is the project's standing build-before-vitest rule.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	boundToolText,
	COMPLETE_MCP_RESULT_INPUT_BUDGET_BYTES,
} from "../../tools/render-compact.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { McpHarness, repoRoot } from "./harness.js";
import { stripSource } from "../support/sweep-kit.js";

// Spawns the MCP server as a real stdio subprocess; like analyze-cli, it can lose
// a CPU-starvation race in the full parallel suite (passes in isolation). retry: 2
// absorbs the transient spike (the established pattern for load-sensitive tests).
describe("pi-lens MCP server (stdio smoke)", { retry: 2 }, () => {
	let harness: McpHarness;

	beforeAll(() => {
		harness = new McpHarness();
	});

	afterAll(() => {
		harness.dispose();
	});

	// #2860 round 4 N6: this scans the production construction itself. The
	// previous test retyped the resolver expression, so deleting mcp/server.ts's
	// real argument left the whole test population green. `stripSource` blanks
	// comments and strings before the call-shape assertion.
	it("passes isLensGuardEnabled() into createLensDiagnosticsTool", () => {
		const source = stripSource(
			fs.readFileSync(new URL("../../mcp/server.ts", import.meta.url), "utf8"),
		);
		const callStart = source.indexOf("createLensDiagnosticsTool(");
		expect(callStart).toBeGreaterThanOrEqual(0);
		const callEnd = source.indexOf("\n);", callStart);
		expect(callEnd).toBeGreaterThan(callStart);
		const call = source.slice(callStart, callEnd);
		expect(call).toContain("() => isLensGuardEnabled(),");
	});

	it("completes the initialize handshake and mirrors the protocol version", async () => {
		const res = await harness.request(1, "initialize", {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "smoke-test", version: "0" },
		});
		const result = res.result as Record<string, unknown>;
		expect(result.protocolVersion).toBe("2025-06-18");
		expect((result.serverInfo as { name: string }).name).toBe("pi-lens-mcp");
		expect(result.capabilities).toHaveProperty("tools");
		harness.notify("notifications/initialized");
	}, 25_000);

	it("lists the pi-lens tools", async () => {
		const res = await harness.request(2, "tools/list");
		const tools = (
			res.result as { tools: { name: string; inputSchema: { type: string } }[] }
		).tools;
		const names = tools.map((t) => t.name);
		expect(names).toContain("pilens_analyze");
		expect(names).toContain("pilens_diagnostics");
		expect(names).toContain("pilens_latency");
		expect(names).toContain("pilens_rebuild");
		expect(names).toContain("pilens_project_scan");
		expect(names).toContain("pilens_health");
		expect(names).toContain("pilens_session_start");
		expect(names).toContain("pilens_turn_end");
		expect(names).toContain("pilens_ast_grep_search");
		expect(names).not.toContain("pilens_ast_grep_dump");
		expect(names).toContain("pilens_ast_grep_replace");
		expect(names).toContain("pilens_lsp_navigation");
		expect(names).not.toContain("pilens_lsp_diagnostics");
		expect(names).toContain("pilens_symbol_search");
		// pilens_impact was removed (#304) — its blast radius folded into
		// pilens_module_report's `blastRadius` option.
		expect(names).not.toContain("pilens_impact");
		expect(names).toContain("pilens_module_report");
		expect(names).toContain("pilens_project_report");
		expect(names).toContain("pilens_read_symbol");
		// Each tool advertises an object input schema.
		for (const tool of tools) {
			expect(tool.inputSchema.type).toBe("object");
		}
		// pilens_diagnostics mirrors lens_diagnostics' typebox schema verbatim
		// (schemaWithCwd); `paths` (#461) must be present on the MCP side too, not
		// just the pi tool — this is the one guard that would catch schema drift
		// between the two if the mirror ever stopped being a direct passthrough.
		const diagnosticsTool = tools.find(
			(t) => t.name === "pilens_diagnostics",
		) as
			| {
					description: string;
					inputSchema: { properties?: Record<string, unknown> };
			  }
			| undefined;
		expect(diagnosticsTool?.inputSchema.properties).toHaveProperty("paths");
		expect(diagnosticsTool?.description).toContain("LSP probe");
		expect(diagnosticsTool?.description).toContain("Empty cache is not proof");
		const astSearchTool = tools.find(
			(t) => t.name === "pilens_ast_grep_search",
		) as { inputSchema: { properties?: Record<string, unknown> } } | undefined;
		expect(astSearchTool?.inputSchema.properties).toHaveProperty("nodeKind");
		expect(astSearchTool?.inputSchema.properties).toHaveProperty(
			"hasDescendantKind",
		);
	}, 25_000);

	it("redirects the retired AST dump name once per session without advertising it", async () => {
		// Regression pin for #2850 HIGH-1: the retired literal must reach the
		// compatibility branch before the enabled-tool roster gate.
		const call = () =>
			harness.request(3, "tools/call", {
				name: "pilens_ast_grep_dump",
				arguments: { source: "foo()", lang: "typescript" },
			});
		const first = (await call()).result as {
			isError?: boolean;
			content: { text: string }[];
		};
		expect(first.isError).toBe(true);
		expect(first.content[0]?.text).toContain("pilens_ast_grep_search");
		expect(first.content[0]?.text).toContain("dump=true");
		expect(first.content[0]?.text).toMatch(
			/result error\nusage tokens=\d+ elapsed-ms=\d+ bytes=\d+ truncated=(?:true|false)$/,
		);
		const second = (
			await harness.request(4, "tools/call", {
				name: "pilens_ast_grep_dump",
				arguments: { source: "foo()", lang: "typescript" },
			})
		).result as typeof first;
		expect(second.isError).toBe(true);
		expect(second.content[0]?.text).toContain("result error");

		const unknown = (
			await harness.request(5, "tools/call", {
				name: "pilens_not_a_tool",
			})
		).result as typeof first;
		expect(unknown.isError).toBe(true);
		expect(unknown.content[0]?.text).toMatch(
			/result error\nusage tokens=\d+ elapsed-ms=\d+ bytes=\d+ truncated=(?:true|false)$/,
		);

		const health = async (id: number) => {
			const response = await harness.request(id, "tools/call", {
				name: "pilens_health",
			});
			const text = (response.result as { content: { text: string }[] })
				.content[0]?.text;
			if (typeof text !== "string") throw new Error("missing health text");
			const json = text.match(/```json\n([\s\S]*?)\n```/)?.[1];
			if (!json) throw new Error("missing health JSON");
			return JSON.parse(json) as {
				degradations: { kind: string; count: number }[];
			};
		};
		const firstSession = await health(5);
		expect(
			firstSession.degradations.find(
				(group) => group.kind === "ast-grep-dump-compatibility",
			)?.count,
		).toBe(1);

		await harness.request(6, "tools/call", { name: "pilens_session_start" });
		await call();
		const secondSession = await health(7);
		expect(
			secondSession.degradations.find(
				(group) => group.kind === "ast-grep-dump-compatibility",
			)?.count,
		).toBe(1);
	});

	it("maps the retired LSP diagnostics name to the folded tool", async () => {
		const response = await harness.request(2800, "tools/call", {
			name: "pilens_lsp_diagnostics",
			arguments: { paths: ["missing-file.ts"], cwd: process.cwd() },
		});
		expect(response.error).toBeUndefined();
		const result = response.result as {
			isError?: boolean;
			content?: { text: string }[];
		};
		expect(result.content?.[0]?.text).toContain("Checks not confirmed");
		const health = await harness.request(2801, "tools/call", {
			name: "pilens_health",
			arguments: {},
		});
		expect(JSON.stringify(health.result)).toContain(
			"lsp-diagnostics-compatibility",
		);
	});

	// #2860 round 2 F3 (fixed round 2, unguarded until now): the retired
	// name used to be exempted from the enabled-tool gate BY NAME
	// (`name !== "pilens_lsp_diagnostics"`), so a project that disabled
	// `lens_diagnostics` still got the retired name executed — including
	// real language-server spawns. The fix checks the CANONICAL name
	// (`pilens_diagnostics`) instead; this pins it so the config bypass
	// cannot come back silently.
	it("refuses pilens_lsp_diagnostics when lens_diagnostics is disabled by config (#2860 F3)", async () => {
		const cwd = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-mcp-lsp-disabled-"),
		);
		fs.writeFileSync(
			path.join(cwd, ".pi-lens.json"),
			JSON.stringify({ tools: { lens_diagnostics: { enabled: false } } }),
		);
		const isolated = new McpHarness({ cwd });
		try {
			const res = await isolated.request(31, "tools/call", {
				name: "pilens_lsp_diagnostics",
				arguments: { cwd, paths: ["missing-file.ts"] },
			});
			const result = res.result as {
				isError?: boolean;
				content?: { text: string }[];
			};
			expect(result.isError).toBe(true);
			expect(result.content?.[0]?.text).toContain(
				"Unknown or disabled tool: pilens_lsp_diagnostics",
			);
		} finally {
			isolated.dispose();
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	}, 25_000);

	it("omits a config-disabled tool from the real MCP tools/list path", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-mcp-tools-"));
		fs.writeFileSync(
			path.join(cwd, ".pi-lens.json"),
			JSON.stringify({ tools: { ast_grep_replace: { enabled: false } } }),
		);
		const isolated = new McpHarness({ cwd });
		try {
			const res = await isolated.request(3, "tools/list");
			const names = (res.result as { tools: { name: string }[] }).tools.map(
				(tool) => tool.name,
			);
			expect(names).not.toContain("pilens_ast_grep_replace");
			expect(names).toContain("pilens_ast_grep_search");
		} finally {
			isolated.dispose();
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	}, 25_000);

	it("does not advertise rebuild from an installed package", async () => {
		const installedRoot = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-installed-"),
		);
		const installedHarness = new McpHarness({
			env: { PI_LENS_MCP_REPO_ROOT: installedRoot },
		});
		try {
			const listed = await installedHarness.request(20, "tools/list");
			const tools = (listed.result as { tools: { name: string }[] }).tools.map(
				(tool) => tool.name,
			);
			expect(tools).not.toContain("pilens_rebuild");

			// Defense in depth: a client that calls the hidden tool directly still
			// reaches runRebuild's preflight and gets a tool-level error.
			const called = await installedHarness.request(21, "tools/call", {
				name: "pilens_rebuild",
				arguments: {},
			});
			const result = called.result as {
				content: { text: string }[];
				isError?: boolean;
			};
			expect(result.isError).toBe(true);
			expect(result.content[0].text).toContain("result error");
			expect(result.content[0].text).toContain(
				"unavailable in an installed pi-lens package",
			);
		} finally {
			installedHarness.dispose();
			fs.rmSync(installedRoot, { recursive: true, force: true });
		}
	}, 25_000);

	it("answers tools/call pilens_health with LSP + dispatch state", async () => {
		const res = await harness.request(5, "tools/call", {
			name: "pilens_health",
			arguments: {},
		});
		const result = res.result as {
			content: { type: string; text: string }[];
		};
		expect(result.content[0].type).toBe("text");
		expect(result.content[0].text).toContain("LSP:");
		expect(result.content[0].text).toContain("Tree-sitter: available");
		// #544: this harness never sets PI_LENS_MCP_AUTO_SESSION, so the health
		// response must report the feature as off (`null`), distinguishable from
		// "attempted and failed" — not merely omit the field.
		expect(result.content[0].text).toContain(
			"Auto session_start: disabled (PI_LENS_MCP_AUTO_SESSION not set)",
		);
		const jsonMatch = result.content[0].text.match(/```json\n([\s\S]*)\n```/);
		expect(jsonMatch).toBeTruthy();
		const payload = JSON.parse(jsonMatch?.[1] ?? "{}") as {
			autoSession: unknown;
			treeSitter: unknown;
		};
		expect(payload.autoSession).toBeNull();
		expect(payload.treeSitter).toEqual({
			available: true,
			wasmAborted: false,
			recovery: "not_required",
		});
	}, 25_000);

	it("answers tools/call pilens_diagnostics (lens_diagnostics, delta mode)", async () => {
		// Cache-only/instant — confirms the lens_diagnostics tool is wired through
		// the transport and returns a text content block.
		const res = await harness.request(6, "tools/call", {
			name: "pilens_diagnostics",
			arguments: { mode: "delta" },
		});
		const result = res.result as { content: { type: string; text: string }[] };
		expect(result.content[0].type).toBe("text");
		expect(typeof result.content[0].text).toBe("string");
	}, 25_000);

	it("answers tools/call pilens_analyze (warm) with a real dispatch result", async () => {
		// no-lsp keeps it fast (skips the cold LSP spawn) while still running the
		// real tree-sitter/ast-grep/oxlint pipeline on a clean repo file.
		const target = path.join(repoRoot, "clients", "mcp", "host-shim.ts");
		const res = await harness.request(7, "tools/call", {
			name: "pilens_analyze",
			arguments: { file: target, mode: "warm", flags: { "no-lsp": true } },
		});
		const result = res.result as {
			content: { type: string; text: string }[];
			isError?: boolean;
		};
		expect(result.isError).toBeFalsy();
		expect(result.content[0].text).toContain("[warm]");
		expect(result.content[0].text).toContain("host-shim.ts");
		// The structured JSON payload (fenced) carries the latency record.
		expect(result.content[0].text).toContain('"latency"');
	}, 60_000);

	// pilens_module_report + pilens_read_symbol execute against a tiny project in
	// module-report.smoke.test.ts — targeting the whole repo here cold-builds the
	// review graph and blocks the server. tools/list above asserts they're wired.

	it("answers tools/call pilens_ast_grep_search with content", async () => {
		const res = await harness.request(8, "tools/call", {
			name: "pilens_ast_grep_search",
			arguments: {
				pattern: "getLSPService()",
				lang: "ts",
				paths: [path.join(repoRoot, "clients", "mcp")],
			},
		});
		const result = res.result as { content: { type: string; text: string }[] };
		expect(result.content[0].type).toBe("text");
		expect(typeof result.content[0].text).toBe("string");
	}, 45_000);

	it("answers tools/call pilens_lsp_navigation (documentSymbol)", async () => {
		const res = await harness.request(9, "tools/call", {
			name: "pilens_lsp_navigation",
			arguments: {
				operation: "documentSymbol",
				filePath: path.join(repoRoot, "clients", "mcp", "host-shim.ts"),
			},
		});
		const result = res.result as { content: { type: string; text: string }[] };
		expect(result.content[0].type).toBe("text");
		expect(typeof result.content[0].text).toBe("string");
	}, 45_000);

	it("answers tools/call pilens_latency with a text content block", async () => {
		const res = await harness.request(3, "tools/call", {
			name: "pilens_latency",
			arguments: { limit: 3 },
		});
		const result = res.result as { content: { type: string; text: string }[] };
		expect(Array.isArray(result.content)).toBe(true);
		expect(result.content[0].type).toBe("text");
		expect(typeof result.content[0].text).toBe("string");
	}, 25_000);

	it("returns a JSON-RPC error for an unknown method", async () => {
		const res = await harness.request(4, "no/such/method");
		expect((res.error as { code: number }).code).toBe(-32601);
	}, 25_000);
});

describe("pi-lens MCP result bounds", { retry: 2 }, () => {
	it("caps the complete MCP payload before retaining or logging it", async () => {
		const previousHome = process.env.PI_LENS_HOME;
		const home = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-mcp-result-budget-home-"),
		);
		process.env.PI_LENS_HOME = home;
		resetDegradationLedger();
		let input: string | undefined = Array.from(
			{ length: 10_000 },
			(_, index) => `const value${index} = "${"x".repeat(900)}";`,
		).join("\n");
		try {
			if (typeof globalThis.gc === "function") globalThis.gc();
			const before = process.memoryUsage().heapUsed;
			const result = boundToolText(input);
			input = undefined;
			if (typeof globalThis.gc === "function") globalThis.gc();
			const after = process.memoryUsage().heapUsed;
			console.log(
				`10,000-match probe: input=9218889 bytes, heap before=${before}, after=${after}, delta=${after - before} bytes`,
			);
			const logPath = result.text.match(/Full output: ([^\]\n]+)/)?.[1];
			expect(result.text).toContain("[incomplete: ");
			expect(result.text).toContain(
				`budget ${COMPLETE_MCP_RESULT_INPUT_BUDGET_BYTES}]`,
			);
			expect(logPath).toBeTruthy();
			const logged = fs.readFileSync(logPath as string, "utf8");
			expect(Buffer.byteLength(logged)).toBeLessThan(8 * 1024 * 1024 + 1024);
			expect(logged).toContain("value0");
			expect(logged).toContain("value9999");
			let secondInput: string | undefined = "y".repeat(
				COMPLETE_MCP_RESULT_INPUT_BUDGET_BYTES + 1,
			);
			boundToolText(secondInput);
			secondInput = undefined;
			const budgetRows = getDegradationSummary().filter(
				(row) => row.kind === "mcp-complete-result-budget-exceeded",
			);
			expect(budgetRows).toHaveLength(1);
		} finally {
			if (previousHome === undefined) delete process.env.PI_LENS_HOME;
			else process.env.PI_LENS_HOME = previousHome;
			fs.rmSync(home, { recursive: true, force: true });
		}
	}, 180_000);

	it("bounds a large AST replacement and keeps the full result in the session log", async () => {
		const workspace = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-mcp-result-"),
		);
		const source = Array.from(
			{ length: 320 },
			(_, index) => `const value${index} = "${"x".repeat(900)}";`,
		).join("\n");
		const sourcePath = path.join(workspace, "large.ts");
		fs.writeFileSync(sourcePath, source);
		const harness = new McpHarness({ cwd: workspace });
		try {
			const res = await harness.request(1, "tools/call", {
				name: "pilens_ast_grep_replace",
				arguments: {
					pattern: "const $X = $Y;",
					rewrite: "let $X = $Y;",
					lang: "typescript",
					paths: [sourcePath],
					apply: false,
				},
			});
			const text = (res.result as { content: { text: string }[] }).content[0]
				.text;
			const logPath = text.match(/Full output: ([^\]\n]+)/)?.[1];
			expect(Buffer.byteLength(text)).toBeLessThanOrEqual(40 * 1024);
			expect(text).toMatch(/\d+ characters omitted/);
			expect(logPath).toBeTruthy();
			const fullText = fs.readFileSync(logPath as string, "utf8");
			expect(Buffer.byteLength(fullText)).toBeGreaterThan(40 * 1024);
			expect(fullText).toContain("value319");
		} finally {
			harness.dispose();
			fs.rmSync(workspace, { recursive: true, force: true });
		}
	}, 45_000);
});
