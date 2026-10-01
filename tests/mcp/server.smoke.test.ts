// mutation-lane: exclude
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
import {
	findIgnoredArguments,
	refusalResult,
} from "../../mcp/tool-arguments.js";
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

	it("keeps diagnostics visible for an out-of-enum severity through MCP", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-mcp-severity-"));
		fs.writeFileSync(
			path.join(cwd, "smelly.ts"),
			[
				"export function f(x) {",
				"\tif (x) { if (x.a) { if (x.b) { if (x.c) { return 1; } } } }",
				'\tconsole.log("debug");',
				"}",
				"",
			].join("\n"),
		);
		const isolated = new McpHarness({ cwd });
		try {
			await isolated.request(40, "initialize", {
				protocolVersion: "2025-06-18",
				capabilities: {},
				clientInfo: { name: "severity-test", version: "0" },
			});
			const analyzed = await isolated.request(41, "tools/call", {
				name: "pilens_analyze",
				arguments: {
					file: path.join(cwd, "smelly.ts"),
					mode: "warm",
					flags: { "no-lsp": true },
				},
			});
			expect((analyzed.result as { isError?: boolean }).isError).toBeFalsy();
			const analyzedText = (analyzed.result as { content: { text: string }[] })
				.content[0].text;
			expect(analyzedText).toMatch(/deep-nesting|console-statement/);
			const response = await isolated.request(42, "tools/call", {
				name: "pilens_diagnostics",
				arguments: {
					mode: "full",
					refreshRunners: "cheap",
					severity: "critical",
				},
			});
			const result = response.result as {
				isError?: boolean;
				content: { text: string }[];
			};
			expect(result.isError).toBeFalsy();
			expect(result.content[0].text).not.toContain("No files diagnosed");
			expect(result.content[0].text).toMatch(/deep-nesting|console-statement/);
		} finally {
			isolated.dispose();
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	}, 60_000);

	it("pilens_project_scan generated-skip notice names MCP tools (#2535 F1)", async () => {
		// A `generated/` directory is pruned without a content probe, so
		// generatedDirSkips fires deterministically and the skip notice must
		// name the tools an MCP agent can actually call.
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-mcp-genskip-"));
		fs.mkdirSync(path.join(cwd, "packages", "a", "src"), { recursive: true });
		fs.mkdirSync(path.join(cwd, "packages", "a", "generated"), {
			recursive: true,
		});
		fs.writeFileSync(
			path.join(cwd, "package.json"),
			JSON.stringify({
				name: "genskip",
				private: true,
				workspaces: ["packages/a"],
			}),
		);
		fs.writeFileSync(
			path.join(cwd, "packages", "a", "package.json"),
			JSON.stringify({ name: "@scope/a", version: "0.0.0" }),
		);
		fs.writeFileSync(
			path.join(cwd, "packages", "a", "src", "index.ts"),
			"export const v = 1;\n",
		);
		fs.writeFileSync(
			path.join(cwd, "packages", "a", "generated", "one.ts"),
			"export const one = 1;\n",
		);
		const isolated = new McpHarness({ cwd });
		try {
			await isolated.request(50, "initialize", {
				protocolVersion: "2025-06-18",
				capabilities: {},
				clientInfo: { name: "genskip-test", version: "0" },
			});
			const response = await isolated.request(51, "tools/call", {
				name: "pilens_project_scan",
				arguments: { cwd },
			});
			const result = response.result as {
				isError?: boolean;
				content: { text: string }[];
			};
			expect(result.isError).toBeFalsy();
			const text = result.content[0].text;
			// The notice fired (not a vacuous pass over a silent scan).
			expect(text).toContain("excluded by generated-name heuristics");
			expect(text).toContain("pilens_project_scan");
			expect(text).toContain("pilens_diagnostics");
			// Reject twin: the bare pi name must not appear — the lookbehind
			// excludes the "pilens_" prefix both names above carry.
			expect(text).not.toMatch(/(?<![A-Za-z0-9_])lens_diagnostics/);
		} finally {
			isolated.dispose();
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	}, 60_000);

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

// #3749: `pilens_diagnostics {"filePath": ...}` (the schema says `path`) ran on
// defaults and answered "No issues in the current turn delta." -- a false clean.
// The dispatcher now checks every tool's arguments against the schema it
// advertises. Own harness, so the degradation ledger these tests read starts
// empty.
// The reviewed sweep output (round 3): all 256 refusals of 4580 probes over the
// live tools/list schemas, every one a declared parameter the call did not send,
// written with another case, a plural `s`, or a leading word (`filePath`,
// `dir_path`, `Paths`, `kind` for `kinds`). A new tool or key that adds a pair
// must be read and added here on purpose.
const PINNED_REFUSALS: string[] = [
	"pilens_analyze {Cwd} -> cwd",
	"pilens_analyze {Flags} -> flags",
	"pilens_analyze {Mode} -> mode",
	"pilens_analyze {cwds} -> cwd",
	"pilens_analyze {modes} -> mode",
	"pilens_ast_grep_replace {Apply} -> apply",
	"pilens_ast_grep_replace {Cwd} -> cwd",
	"pilens_ast_grep_replace {Follows} -> follows",
	"pilens_ast_grep_replace {HasDescendantKind} -> hasDescendantKind",
	"pilens_ast_grep_replace {HasKind} -> hasKind",
	"pilens_ast_grep_replace {InsideKind} -> insideKind",
	"pilens_ast_grep_replace {PATH} -> paths",
	"pilens_ast_grep_replace {Paths} -> paths",
	"pilens_ast_grep_replace {Path} -> paths",
	"pilens_ast_grep_replace {Precedes} -> precedes",
	"pilens_ast_grep_replace {Strictness} -> strictness",
	"pilens_ast_grep_replace {applys} -> apply", // spellchecker:disable-line
	"pilens_ast_grep_replace {cwds} -> cwd",
	"pilens_ast_grep_replace {dirPath} -> paths",
	"pilens_ast_grep_replace {dir_path} -> paths",
	"pilens_ast_grep_replace {filePath} -> paths",
	"pilens_ast_grep_replace {file_path} -> paths",
	"pilens_ast_grep_replace {hasDescendantKinds} -> hasDescendantKind",
	"pilens_ast_grep_replace {hasKinds} -> hasKind",
	"pilens_ast_grep_replace {insideKinds} -> insideKind",
	"pilens_ast_grep_replace {namePath} -> paths",
	"pilens_ast_grep_replace {name_path} -> paths",
	"pilens_ast_grep_replace {pathPath} -> paths",
	"pilens_ast_grep_replace {path_path} -> paths",
	"pilens_ast_grep_replace {path} -> paths",
	"pilens_ast_grep_replace {sourcePath} -> paths",
	"pilens_ast_grep_replace {source_path} -> paths",
	"pilens_ast_grep_replace {symbolPath} -> paths",
	"pilens_ast_grep_replace {symbol_path} -> paths",
	"pilens_ast_grep_replace {targetPath} -> paths",
	"pilens_ast_grep_replace {target_path} -> paths",
	"pilens_ast_grep_search {Context} -> context",
	"pilens_ast_grep_search {Cwd} -> cwd",
	"pilens_ast_grep_search {Dump} -> dump",
	"pilens_ast_grep_search {Follows} -> follows",
	"pilens_ast_grep_search {GroupByFile} -> groupByFile",
	"pilens_ast_grep_search {HasDescendantKind} -> hasDescendantKind",
	"pilens_ast_grep_search {HasKind} -> hasKind",
	"pilens_ast_grep_search {InsideKind} -> insideKind",
	"pilens_ast_grep_search {MaxMatches} -> maxMatches",
	"pilens_ast_grep_search {NodeKind} -> nodeKind",
	"pilens_ast_grep_search {PATH} -> paths",
	"pilens_ast_grep_search {Paths} -> paths",
	"pilens_ast_grep_search {Path} -> paths",
	"pilens_ast_grep_search {Pattern} -> pattern",
	"pilens_ast_grep_search {Precedes} -> precedes",
	"pilens_ast_grep_search {Rule} -> rule",
	"pilens_ast_grep_search {Selector} -> selector",
	"pilens_ast_grep_search {Skip} -> skip",
	"pilens_ast_grep_search {Strictness} -> strictness",
	"pilens_ast_grep_search {ValidateOnly} -> validateOnly",
	"pilens_ast_grep_search {contexts} -> context",
	"pilens_ast_grep_search {cwds} -> cwd",
	"pilens_ast_grep_search {dirPath} -> paths",
	"pilens_ast_grep_search {dir_path} -> paths",
	"pilens_ast_grep_search {dumps} -> dump",
	"pilens_ast_grep_search {filePath} -> paths",
	"pilens_ast_grep_search {file_path} -> paths",
	"pilens_ast_grep_search {groupByFiles} -> groupByFile",
	"pilens_ast_grep_search {hasDescendantKinds} -> hasDescendantKind",
	"pilens_ast_grep_search {hasKinds} -> hasKind",
	"pilens_ast_grep_search {insideKinds} -> insideKind",
	"pilens_ast_grep_search {namePath} -> paths",
	"pilens_ast_grep_search {name_path} -> paths",
	"pilens_ast_grep_search {nodeKinds} -> nodeKind",
	"pilens_ast_grep_search {pathPath} -> paths",
	"pilens_ast_grep_search {path_path} -> paths",
	"pilens_ast_grep_search {path} -> paths",
	"pilens_ast_grep_search {patterns} -> pattern",
	"pilens_ast_grep_search {rules} -> rule",
	"pilens_ast_grep_search {selectors} -> selector",
	"pilens_ast_grep_search {skips} -> skip",
	"pilens_ast_grep_search {sourcePath} -> paths",
	"pilens_ast_grep_search {source_path} -> paths",
	"pilens_ast_grep_search {symbolPath} -> paths",
	"pilens_ast_grep_search {symbol_path} -> paths",
	"pilens_ast_grep_search {targetPath} -> paths",
	"pilens_ast_grep_search {target_path} -> paths",
	"pilens_ast_grep_search {validateOnlys} -> validateOnly",
	"pilens_diagnostics {AnalysisRoot} -> analysisRoot",
	"pilens_diagnostics {Concurrency} -> concurrency",
	"pilens_diagnostics {Cwd} -> cwd",
	"pilens_diagnostics {IncludeGenerated} -> includeGenerated",
	"pilens_diagnostics {MaxLspFiles} -> maxLspFiles",
	"pilens_diagnostics {MaxProjectFiles} -> maxProjectFiles",
	"pilens_diagnostics {Mode} -> mode",
	"pilens_diagnostics {PATH} -> path",
	"pilens_diagnostics {Paths} -> path",
	"pilens_diagnostics {Path} -> path",
	"pilens_diagnostics {RefreshRunners} -> refreshRunners",
	"pilens_diagnostics {SOURCE} -> source",
	"pilens_diagnostics {Scope} -> scope",
	"pilens_diagnostics {ServerScope} -> serverScope",
	"pilens_diagnostics {Severity} -> severity",
	"pilens_diagnostics {Source} -> source",
	"pilens_diagnostics {WaitMs} -> waitMs",
	"pilens_diagnostics {analysisRoots} -> analysisRoot",
	"pilens_diagnostics {concurrencys} -> concurrency",
	"pilens_diagnostics {cwds} -> cwd",
	"pilens_diagnostics {dirPath} -> path",
	"pilens_diagnostics {dir_path} -> path",
	"pilens_diagnostics {filePath} -> path",
	"pilens_diagnostics {file_path} -> path",
	"pilens_diagnostics {includeGenerateds} -> includeGenerated",
	"pilens_diagnostics {modes} -> mode",
	"pilens_diagnostics {namePath} -> path",
	"pilens_diagnostics {name_path} -> path",
	"pilens_diagnostics {pathPath} -> path",
	"pilens_diagnostics {path_path} -> path",
	"pilens_diagnostics {scopes} -> scope",
	"pilens_diagnostics {serverScopes} -> serverScope",
	"pilens_diagnostics {severitys} -> severity",
	"pilens_diagnostics {sourcePath} -> path",
	"pilens_diagnostics {source_path} -> path",
	"pilens_diagnostics {sources} -> source",
	"pilens_diagnostics {symbolPath} -> path",
	"pilens_diagnostics {symbol_path} -> path",
	"pilens_diagnostics {targetPath} -> path",
	"pilens_diagnostics {target_path} -> path",
	"pilens_effective_config {Cwd} -> cwd",
	"pilens_effective_config {FILE} -> file",
	"pilens_effective_config {File} -> file",
	"pilens_effective_config {cwds} -> cwd",
	"pilens_effective_config {files} -> file",
	"pilens_latency {FILE} -> file",
	"pilens_latency {File} -> file",
	"pilens_latency {Limit} -> limit",
	"pilens_latency {files} -> file",
	"pilens_latency {limits} -> limit",
	"pilens_lsp_navigation {Apply} -> apply",
	"pilens_lsp_navigation {CallHierarchyItem} -> callHierarchyItem",
	"pilens_lsp_navigation {Character} -> character",
	"pilens_lsp_navigation {CommandArguments} -> commandArguments",
	"pilens_lsp_navigation {Command} -> command",
	"pilens_lsp_navigation {Cwd} -> cwd",
	"pilens_lsp_navigation {EndCharacter} -> endCharacter",
	"pilens_lsp_navigation {EndLine} -> endLine",
	"pilens_lsp_navigation {ExactMatch} -> exactMatch",
	"pilens_lsp_navigation {Kinds} -> kinds",
	"pilens_lsp_navigation {Kind} -> kinds",
	"pilens_lsp_navigation {Line} -> line",
	"pilens_lsp_navigation {MaxResults} -> maxResults",
	"pilens_lsp_navigation {NewFilePath} -> newFilePath",
	"pilens_lsp_navigation {NewName} -> newName",
	"pilens_lsp_navigation {PATH} -> path",
	"pilens_lsp_navigation {Path} -> path",
	"pilens_lsp_navigation {Query} -> query",
	"pilens_lsp_navigation {SYMBOL} -> symbol",
	"pilens_lsp_navigation {Symbol} -> symbol",
	"pilens_lsp_navigation {TopLevelOnly} -> topLevelOnly",
	"pilens_lsp_navigation {applys} -> apply", // spellchecker:disable-line
	"pilens_lsp_navigation {callHierarchyItems} -> callHierarchyItem",
	"pilens_lsp_navigation {characters} -> character",
	"pilens_lsp_navigation {commands} -> command",
	"pilens_lsp_navigation {cwds} -> cwd",
	"pilens_lsp_navigation {dirPath} -> path",
	"pilens_lsp_navigation {dir_path} -> path",
	"pilens_lsp_navigation {endCharacters} -> endCharacter",
	"pilens_lsp_navigation {endLines} -> endLine",
	"pilens_lsp_navigation {exactMatchs} -> exactMatch", // spellchecker:disable-line
	"pilens_lsp_navigation {filePath} -> path",
	"pilens_lsp_navigation {file_path} -> path",
	"pilens_lsp_navigation {kind} -> kinds",
	"pilens_lsp_navigation {lines} -> line",
	"pilens_lsp_navigation {namePath} -> path",
	"pilens_lsp_navigation {name_path} -> path",
	"pilens_lsp_navigation {newFilePaths} -> newFilePath",
	"pilens_lsp_navigation {newNames} -> newName",
	"pilens_lsp_navigation {pathPath} -> path",
	"pilens_lsp_navigation {path_path} -> path",
	"pilens_lsp_navigation {paths} -> path",
	"pilens_lsp_navigation {querys} -> query", // spellchecker:disable-line
	"pilens_lsp_navigation {sourcePath} -> path",
	"pilens_lsp_navigation {source_path} -> path",
	"pilens_lsp_navigation {symbolPath} -> path",
	"pilens_lsp_navigation {symbol_path} -> path",
	"pilens_lsp_navigation {symbols} -> symbol",
	"pilens_lsp_navigation {targetPath} -> path",
	"pilens_lsp_navigation {target_path} -> path",
	"pilens_lsp_navigation {topLevelOnlys} -> topLevelOnly",
	"pilens_module_report {BlastRadiusDepth} -> blastRadiusDepth",
	"pilens_module_report {BlastRadius} -> blastRadius",
	"pilens_module_report {CallGraph} -> callGraph",
	"pilens_module_report {Cwd} -> cwd",
	"pilens_module_report {Focus} -> focus",
	"pilens_module_report {MaxCallGraphEntries} -> maxCallGraphEntries",
	"pilens_module_report {MaxRefsPerSymbol} -> maxRefsPerSymbol",
	"pilens_module_report {View} -> view",
	"pilens_module_report {blastRadiusDepths} -> blastRadiusDepth",
	"pilens_module_report {callGraphs} -> callGraph",
	"pilens_module_report {cwds} -> cwd",
	"pilens_module_report {maxRefsPerSymbols} -> maxRefsPerSymbol",
	"pilens_module_report {views} -> view",
	"pilens_project_report {Cwd} -> cwd",
	"pilens_project_report {Focus} -> focus",
	"pilens_project_report {Limit} -> limit",
	"pilens_project_report {View} -> view",
	"pilens_project_report {cwds} -> cwd",
	"pilens_project_report {limits} -> limit",
	"pilens_project_report {views} -> view",
	"pilens_project_scan {Cwd} -> cwd",
	"pilens_project_scan {IncludeGenerated} -> includeGenerated",
	"pilens_project_scan {MaxFiles} -> maxFiles",
	"pilens_project_scan {cwds} -> cwd",
	"pilens_project_scan {includeGenerateds} -> includeGenerated",
	"pilens_read_enclosing {AroundLine} -> aroundLine",
	"pilens_read_enclosing {Cwd} -> cwd",
	"pilens_read_enclosing {Kinds} -> kinds",
	"pilens_read_enclosing {Kind} -> kinds",
	"pilens_read_enclosing {MaxLines} -> maxLines",
	"pilens_read_enclosing {OnOversize} -> onOversize",
	"pilens_read_enclosing {aroundLines} -> aroundLine",
	"pilens_read_enclosing {cwds} -> cwd",
	"pilens_read_enclosing {kind} -> kinds",
	"pilens_read_enclosing {onOversizes} -> onOversize",
	"pilens_read_symbol {Cwd} -> cwd",
	"pilens_read_symbol {Kind} -> kind",
	"pilens_read_symbol {cwds} -> cwd",
	"pilens_read_symbol {kinds} -> kind",
	"pilens_session_start {Cwd} -> cwd",
	"pilens_session_start {cwds} -> cwd",
	"pilens_symbol_search {Cwd} -> cwd",
	"pilens_symbol_search {Lang} -> lang",
	"pilens_symbol_search {Limit} -> limit",
	"pilens_symbol_search {PATH} -> paths",
	"pilens_symbol_search {Paths} -> paths",
	"pilens_symbol_search {Path} -> paths",
	"pilens_symbol_search {cwds} -> cwd",
	"pilens_symbol_search {dirPath} -> paths",
	"pilens_symbol_search {dir_path} -> paths",
	"pilens_symbol_search {filePath} -> paths",
	"pilens_symbol_search {file_path} -> paths",
	"pilens_symbol_search {langs} -> lang",
	"pilens_symbol_search {limits} -> limit",
	"pilens_symbol_search {namePath} -> paths",
	"pilens_symbol_search {name_path} -> paths",
	"pilens_symbol_search {pathPath} -> paths",
	"pilens_symbol_search {path_path} -> paths",
	"pilens_symbol_search {path} -> paths",
	"pilens_symbol_search {sourcePath} -> paths",
	"pilens_symbol_search {source_path} -> paths",
	"pilens_symbol_search {symbolPath} -> paths",
	"pilens_symbol_search {symbol_path} -> paths",
	"pilens_symbol_search {targetPath} -> paths",
	"pilens_symbol_search {target_path} -> paths",
	"pilens_turn_end {Cwd} -> cwd",
	"pilens_turn_end {FILE} -> files",
	"pilens_turn_end {Files} -> files",
	"pilens_turn_end {File} -> files",
	"pilens_turn_end {cwds} -> cwd",
	"pilens_turn_end {file} -> files",
];

describe("pi-lens MCP unknown arguments (#3749)", { retry: 2 }, () => {
	type WireResult = {
		isError?: boolean;
		content: { text: string }[];
		structuredContent?: {
			ignoredArguments: string[];
			ignoredArgumentCount: number;
		};
	};
	let harness: McpHarness;
	let nextId = 374_900;
	const call = async (
		name: string,
		args: Record<string, unknown>,
	): Promise<WireResult> => {
		const response = await harness.request(nextId++, "tools/call", {
			name,
			arguments: args,
		});
		expect(response.error).toBeUndefined();
		return response.result as WireResult;
	};
	const firstLine = (result: WireResult): string =>
		result.content[0]?.text.split("\n")[0] ?? "";

	beforeAll(async () => {
		harness = new McpHarness();
		await harness.request(374_899, "initialize", {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "unknown-arguments", version: "0" },
		});
		harness.notify("notifications/initialized");
	}, 25_000);

	afterAll(() => {
		harness.dispose();
	});

	// The reporter's exact call (#3749 round 2): `path` is optional for
	// pilens_diagnostics, yet `filePath` is plainly a mistyped `path` that was
	// not sent, so running on the session default and answering "No issues"
	// would read as a clean file.
	it("refuses the reporter's mistyped diagnostics key instead of answering No issues", async () => {
		const result = await call("pilens_diagnostics", {
			filePath: "/tmp/x/bad.ts",
		});
		expect(result.isError).toBe(true);
		expect(firstLine(result)).toBe(
			"Ignored unknown argument(s) for pilens_diagnostics: `filePath` (did you mean `path`?). They had no effect on this call.",
		);
		expect(result.content[0]?.text).toContain(
			"Not run: `filePath` looks like a mistyped `path`, which was not sent.",
		);
		expect(result.content[0]?.text).not.toContain("No issues");
		expect(result.structuredContent).toEqual({
			ignoredArguments: ["filePath"],
			ignoredArgumentCount: 1,
		});
		expect(result.content[0]?.text).toMatch(
			/result error\nusage tokens=\d+ elapsed-ms=\d+ bytes=\d+ truncated=false$/,
		);
	}, 25_000);

	it("keeps a warning and runs when the near match was also sent", async () => {
		const result = await call("pilens_diagnostics", {
			filePath: "/tmp/x/bad.ts",
			path: "/tmp/x/bad.ts",
		});
		expect(result.isError).toBe(false);
		expect(firstLine(result)).toContain("Ignored unknown argument(s)");
		expect(result.content[0]?.text).toContain("No issues");
		expect(result.content[0]?.text).not.toContain("Not run");
	}, 25_000);

	it("keeps a warning for cwd on a tool whose handler never reads it", async () => {
		const result = await call("pilens_health", { cwd: "/tmp" });
		expect(result.isError).toBe(false);
		expect(firstLine(result)).toBe(
			"Ignored unknown argument(s) for pilens_health: `cwd`. They had no effect on this call.",
		);
		expect(result.content[0]?.text).toContain("LSP:");
	}, 25_000);

	it("turns an ignored key that leaves a required input missing into an error", async () => {
		const result = await call("pilens_analyze", { filePath: "/tmp/x/bad.ts" });
		expect(result.isError).toBe(true);
		expect(firstLine(result)).toBe(
			"Ignored unknown argument(s) for pilens_analyze: `filePath` (did you mean `file`?). They had no effect on this call.",
		);
		expect(result.content[0]?.text).toContain(
			"Not run: required argument(s) `file` missing.",
		);
		expect(result.structuredContent?.ignoredArguments).toEqual(["filePath"]);
		// The refusal still goes through the result-footer gate.
		expect(result.content[0]?.text).toMatch(
			/result error\nusage tokens=\d+ elapsed-ms=\d+ bytes=\d+ truncated=false$/,
		);
	}, 25_000);

	it("runs the tool when the required key is sent next to an ignored one", async () => {
		const result = await call("pilens_module_report", {
			file: "missing.ts",
			bogus: true,
		});
		expect(firstLine(result)).toContain("Ignored unknown argument(s)");
		expect(result.content[0]?.text).toContain("No module report for");
		expect(result.content[0]?.text).not.toContain("Not run");
	}, 25_000);

	it("leaves a call with only declared keys byte-for-byte free of the report", async () => {
		const result = await call("pilens_diagnostics", { mode: "delta" });
		expect(result.content[0]?.text).not.toContain("Ignored unknown");
		expect(result.structuredContent).toBeUndefined();
	}, 25_000);

	it("keeps the tool's own message when a required key is missing and nothing is ignored", async () => {
		const result = await call("pilens_analyze", {});
		expect(result.content[0]?.text).toContain(
			"pilens_analyze requires a 'file' string.",
		);
		expect(result.content[0]?.text).not.toContain("Ignored unknown");
	}, 25_000);

	it("checks the retired LSP diagnostics name against the folded tool's schema", async () => {
		// `pth` is a typo, not the parameter written another way: a warning, run.
		const warned = await call("pilens_lsp_diagnostics", {
			paths: ["missing-file.ts"],
			pth: "x.ts",
		});
		expect(firstLine(warned)).toBe(
			"Ignored unknown argument(s) for pilens_lsp_diagnostics: `pth` (did you mean `path`?). They had no effect on this call.",
		);
		expect(warned.content[0]?.text).toContain("Checks not confirmed");
		// `filePath` with neither `path` nor `paths` sent is refused, as on
		// `pilens_diagnostics`.
		const refused = await call("pilens_lsp_diagnostics", { filePath: "x.ts" });
		expect(refused.isError).toBe(true);
		expect(refused.content[0]?.text).toContain(
			"Not run: `filePath` looks like a mistyped `path`, which was not sent.",
		);
	}, 25_000);

	it("does not change the answer for an unknown tool", async () => {
		const result = await call("pilens_not_a_tool", { bogus: 1 });
		expect(result.isError).toBe(true);
		expect(firstLine(result)).toBe(
			"Unknown or disabled tool: pilens_not_a_tool",
		);
		expect(result.structuredContent).toBeUndefined();
	}, 25_000);

	it("names Object.prototype keys as ignored and bounds a flood of keys", async () => {
		const proto = await call("pilens_diagnostics", {
			constructor: 1,
			toString: 2,
		});
		expect(proto.structuredContent?.ignoredArguments).toEqual([
			"constructor",
			"toString",
		]);
		const flood = await call("pilens_diagnostics", {
			...Object.fromEntries(
				Array.from({ length: 50 }, (_, index) => [
					`${"k".repeat(200)}${index}`,
					index,
				]),
			),
		});
		expect(flood.structuredContent?.ignoredArgumentCount).toBe(50);
		expect(flood.structuredContent?.ignoredArguments).toHaveLength(8);
		expect(firstLine(flood).length).toBeLessThan(1000);
		expect(firstLine(flood)).toContain("and 42 more");
	}, 25_000);

	// Recurrence this prevents: a tool added later that skips the check (the
	// bug was that NO tool had one). Iterates tools/list, so a new tool is
	// covered without anyone editing this test. `pilens_rebuild` is the one
	// tool not driven over the wire: it runs `npm run build` on the checkout
	// that holds this very test run; its schema still goes through the
	// schema-level rows below.
	it("reports an unknown key on every registered tool", async () => {
		const listed = (await harness.request(374_898, "tools/list")).result as {
			tools: {
				name: string;
				inputSchema: {
					properties?: Record<string, unknown>;
					required?: string[];
				};
			}[];
		};
		expect(listed.tools.length).toBeGreaterThan(10);
		for (const tool of listed.tools) {
			// Every declared key of every tool is accepted silently...
			expect(
				findIgnoredArguments(
					tool.inputSchema,
					Object.fromEntries(
						Object.keys(tool.inputSchema.properties ?? {}).map((key) => [
							key,
							null,
						]),
					),
				),
				tool.name,
			).toBeUndefined();
			// ...and an undeclared one is always reported.
			expect(
				findIgnoredArguments(tool.inputSchema, { __bogus_key__: 1 })?.ignored,
				tool.name,
			).toEqual([{ key: "__bogus_key__" }]);
		}
		for (const tool of listed.tools) {
			if (tool.name === "pilens_rebuild") continue;
			const result = await call(tool.name, { __bogus_key__: 1 });
			expect(firstLine(result), tool.name).toBe(
				`Ignored unknown argument(s) for ${tool.name}: \`__bogus_key__\`. They had no effect on this call.`,
			);
			expect(result.structuredContent, tool.name).toEqual({
				ignoredArguments: ["__bogus_key__"],
				ignoredArgumentCount: 1,
			});
			// A tool with a required input never runs on the defaults.
			if ((tool.inputSchema.required ?? []).length > 0) {
				expect(result.isError, tool.name).toBe(true);
				expect(result.content[0]?.text, tool.name).toContain("Not run:");
			}
		}
	}, 240_000);

	// Round 3 (#3749 review F1): the refusal gate reused the loose "did you mean"
	// scorer, so `pilens_lsp_navigation {filePath}` was refused as a mistyped
	// `newFilePath` and `pilens_diagnostics {files}` as `maxLspFiles`: a call
	// master ran, refused with a misdirecting message. The gate is now the narrow
	// predicate (`refusalMatches`); this table drives the REAL tools/list schemas.
	it("refuses a file-like key only where a declared parameter matches as a whole token", async () => {
		// [tool, extra required args, key, refused?, named parameter]
		const rows: [string, Record<string, unknown>, string, string | null][] = [
			["pilens_lsp_navigation", { operation: "hover" }, "filePath", "path"],
			["pilens_lsp_navigation", { operation: "hover" }, "file_path", "path"],
			["pilens_lsp_navigation", { operation: "hover" }, "file", null],
			["pilens_lsp_navigation", { operation: "hover" }, "files", null],
			["pilens_lsp_navigation", { operation: "hover" }, "File", null],
			["pilens_diagnostics", {}, "filePath", "path"],
			["pilens_diagnostics", {}, "file_path", "path"],
			["pilens_diagnostics", {}, "file", null],
			["pilens_diagnostics", {}, "files", null],
			["pilens_diagnostics", {}, "File", null],
			["pilens_diagnostics", {}, "Path", "path"],
			["pilens_ast_grep_search", { lang: "typescript" }, "filePath", "paths"],
			["pilens_ast_grep_search", { lang: "typescript" }, "file_path", "paths"],
			["pilens_ast_grep_search", { lang: "typescript" }, "file", null],
			["pilens_ast_grep_search", { lang: "typescript" }, "files", null],
			["pilens_ast_grep_search", { lang: "typescript" }, "File", null],
			// A sample of the review's misfire rows: each ran on master.
			["pilens_diagnostics", {}, "fixes", null],
			["pilens_diagnostics", {}, "code", null],
			["pilens_diagnostics", {}, "patch", null],
			["pilens_diagnostics", {}, "ref", null],
			["pilens_module_report", { file: "missing.ts" }, "symbol", null],
			["pilens_lsp_navigation", { operation: "hover" }, "name", null],
			["pilens_ast_grep_search", { lang: "typescript" }, "text", null],
		];
		for (const [tool, required, key, named] of rows) {
			const result = await call(tool, { ...required, [key]: "x" });
			const text = result.content[0]?.text ?? "";
			const label = `${tool} {${key}}`;
			if (named === null) {
				expect(text, label).not.toContain("Not run:");
			} else {
				expect(result.isError, label).toBe(true);
				expect(text, label).toContain(
					`Not run: \`${key}\` looks like a mistyped \`${named}\`, which was not sent.`,
				);
			}
		}
	}, 120_000);

	// Round 3 sweep: every (tool, key) pair over the LIVE tools/list schemas, the
	// tool's required keys sent, so a refusal can only come from the predicate.
	// The pinned list below is the complete set of refusals, each one a call whose
	// key really is the declared parameter written another way. A retune of the
	// predicate that flips any call between run and refuse reds this test.
	it("refuses exactly the pinned pairs across every live key and common name", async () => {
		const listed = (await harness.request(374_897, "tools/list")).result as {
			tools: {
				name: string;
				inputSchema: {
					properties?: Record<string, unknown>;
					required?: string[];
				};
			}[];
		};
		const fileish = [
			"file",
			"path",
			"dir",
			"source",
			"target",
			"name",
			"symbol",
		];
		const bases = [
			...fileish,
			"directory",
			"folder",
			"src",
			"dest",
			"query",
			"text",
			"code",
			"content",
			"pattern",
			"line",
			"column",
			"limit",
			"max",
			"count",
			"language",
			"lang",
			"mode",
			"view",
			"kind",
			"type",
			"id",
			"root",
			"cwd",
			"workspace",
			"project",
			"filename",
			"filepath",
			"uri",
			"url",
			"position",
			"range",
			"start",
			"end",
			"scope",
			"severity",
			"all",
			"apply",
			"dryRun",
			"force",
			"verbose",
			"timeout",
			"wait",
			"include",
			"exclude",
			"ignore",
			"only",
			"top",
			"level",
			"depth",
			"recursive",
			"result",
			"fix",
			"patch",
			"diff",
			"ref",
			"run",
			"runner",
			"output",
			"format",
			"ext",
			"new",
			"context",
			"select",
			"rule",
			"skip",
		];
		const cap = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);
		const common = new Set<string>([
			...bases,
			...bases.map(cap),
			...bases.map((word) => `${word}s`),
			...fileish.flatMap((word) => [
				`${word}Path`,
				`${word}_path`,
				`${word}Name`,
				`${word}_name`,
				`${word.toUpperCase()}`,
			]),
		]);
		let probes = 0;
		const refused: string[] = [];
		for (const tool of listed.tools) {
			const declared = Object.keys(tool.inputSchema.properties ?? {});
			const required = Object.fromEntries(
				(tool.inputSchema.required ?? []).map((key) => [key, "x"]),
			);
			for (const key of new Set([
				...declared.map(cap),
				...declared.map((k) => `${k}s`),
				...common,
			])) {
				if (declared.includes(key)) continue;
				probes += 1;
				const report = findIgnoredArguments(tool.inputSchema, {
					...required,
					[key]: "x",
				});
				if (report && refusalResult(tool.name, report))
					refused.push(
						`${tool.name} {${key}} -> ${report.unsentSuggestions.map((m) => m.suggestion).join(",")}`,
					);
			}
		}
		expect(probes).toBeGreaterThan(2000);
		expect(refused.sort()).toEqual(PINNED_REFUSALS);
	}, 60_000);

	it("treats a non-object `arguments` per the spec: empty is no arguments, anything else is an error", async () => {
		const raw = (value: unknown) =>
			harness.request(nextId++, "tools/call", {
				name: "pilens_health",
				arguments: value,
			});
		for (const value of [[1, 2], "x", 7, true]) {
			const response = await raw(value);
			expect(
				(response.error as { code: number }).code,
				JSON.stringify(value),
			).toBe(-32602);
		}
		const omitted = await harness.request(nextId++, "tools/call", {
			name: "pilens_health",
		});
		expect(omitted.error, "omitted").toBeUndefined();
		for (const value of [null, [], {}]) {
			const response = await raw(value);
			expect(response.error, JSON.stringify(value)).toBeUndefined();
			const text = (response.result as WireResult).content[0]?.text ?? "";
			expect(text, JSON.stringify(value)).toContain("LSP:");
			expect(text, JSON.stringify(value)).not.toContain("Ignored unknown");
		}
	}, 60_000);

	it("records each call in the degradation ledger as a counted row, not one row per key", async () => {
		const health = async () => {
			const text = (await call("pilens_health", {})).content[0]?.text ?? "";
			const json = text.match(/```json\n([\s\S]*?)\n```/)?.[1];
			if (!json) throw new Error("missing health JSON");
			return (
				JSON.parse(json) as {
					degradations: {
						kind: string;
						count: number;
						latestReasons: { subject: string; reason: string }[];
					}[];
				}
			).degradations.find((group) => group.kind === "mcp-ignored-arguments");
		};
		const before = (await health())?.count ?? 0;
		await call("pilens_diagnostics", { onlyKeyA: 1, onlyKeyB: 2 });
		await call("pilens_diagnostics", { onlyKeyA: 1 });
		// A refused call is still counted (the row is written before the refusal).
		await call("pilens_analyze", { onlyKeyC: 1 });
		const after = await health();
		expect(after?.count).toBe(before + 3);
		const row = after?.latestReasons.find(
			(entry) => entry.subject === "pilens_diagnostics",
		);
		expect(row?.reason).toContain("ignored argument(s): onlyKeyA");
		expect(row?.reason).not.toContain("onlyKeyB");
	}, 25_000);
});
