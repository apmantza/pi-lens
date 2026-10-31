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
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
import { setupTestEnvironment } from "../clients/test-utils.js";
import { McpHarness, repoRoot } from "./harness.js";
import { isProcessAlive } from "../support/process-tree.js";
import { projectScan } from "../../clients/lens-engine.js";
import { _resetStateCacheForTests } from "../../clients/diagnostic-dispositions.js";
import { createLensDiagnosticMarkTool } from "../../tools/lens-diagnostic-mark.js";
import { stripSource } from "../support/sweep-kit.js";

// Spawns the MCP server as a real stdio subprocess; like analyze-cli, it can lose
// a CPU-starvation race in the full parallel suite (passes in isolation). retry: 2
// absorbs the transient spike (the established pattern for load-sensitive tests).
describe("pi-lens MCP server (stdio smoke)", { retry: 2 }, () => {
	let harness: McpHarness;
	let workspace: ReturnType<typeof setupTestEnvironment>;

	beforeAll(() => {
		workspace = setupTestEnvironment("mcp-smoke-session-");
		harness = new McpHarness({ cwd: workspace.tmpDir });
	});

	afterAll(() => {
		harness.dispose();
		workspace.cleanup();
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

	it("discloses unverified session evidence on the real MCP wire", async () => {
		// MCP strips details before delivery. The shared tool's TEXT must keep
		// the state and a callable MCP recipe, even when no cached row exists.
		const res = await harness.request(600, "tools/call", {
			name: "pilens_diagnostics",
			arguments: {
				source: "session",
				scope: "paths",
				paths: [path.join(workspace.tmpDir, "unseen-session-evidence.txt")],
			},
		});
		const result = res.result as {
			content: { text: string }[];
			details?: unknown;
		};
		expect(result.content[0]?.text).toContain("Session cache unverified");
		expect(result.content[0]?.text).toContain(
			"pilens_diagnostics source=lsp scope=paths",
		);
		expect(result.content[0]?.text).not.toContain("✓");
		expect(result.details).toBeUndefined();
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

	it("pilens_project_scan drops a marked finding and states the count (#1634)", async () => {
		// #1634 recurrence: this tool rendered the raw cheap scan, so a finding
		// marked false-positive through lens_diagnostic_mark came back here
		// while every other surface dropped it. The mark is written in-process
		// into the data directory the spawned server then reads.
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-mcp-1634-"));
		const dataDir = path.join(cwd, ".data");
		const filePath = path.join(cwd, "a.ts");
		fs.writeFileSync(
			filePath,
			"export function f(x: unknown) {\n\tconsole.log(x);\n\treturn x;\n}\n",
		);
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = dataDir;
		_resetStateCacheForTests();
		let isolated: McpHarness | undefined;
		try {
			const target = (await projectScan(cwd)).diagnostics.find(
				(d) => d.filePath === filePath,
			);
			expect(target).toBeDefined();
			if (!target) return;
			const marked = await createLensDiagnosticMarkTool(() => cwd).execute(
				"mark-1634-mcp",
				{
					filePath,
					line: target.line,
					message: target.message,
					rule: target.rule,
					tool: target.tool,
					disposition: "false-positive",
				},
				undefined,
				() => {},
				{ cwd },
			);
			expect(marked.isError).toBeFalsy();
			isolated = new McpHarness({ cwd, env: { PILENS_DATA_DIR: dataDir } });
			await isolated.request(52, "initialize", {
				protocolVersion: "2025-06-18",
				capabilities: {},
				clientInfo: { name: "scan-1634-test", version: "0" },
			});
			const response = await isolated.request(53, "tools/call", {
				name: "pilens_project_scan",
				arguments: { cwd },
			});
			const result = response.result as {
				isError?: boolean;
				content: { text: string }[];
			};
			expect(result.isError).toBeFalsy();
			const text = result.content.map((part) => part.text).join("\n");
			expect(text).toContain("suppressed by disposition: 1 finding(s)");
			expect(text).not.toContain(target.message);
			expect(text).toContain('"dispositionSuppressed": 1');
		} finally {
			isolated?.dispose();
			if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
			else process.env.PILENS_DATA_DIR = previousDataDir;
			_resetStateCacheForTests();
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	}, 60_000);

	it("answers tools/call pilens_analyze (warm) with a real dispatch result", async () => {
		// no-lsp keeps it fast (skips the cold LSP spawn) while still running the
		// real tree-sitter/ast-grep/oxlint pipeline on a clean repo file.
		// #4309 F1: this smoke checks ordinary session dispatch. A repository
		// file outside the isolated server's session is now correctly adopted.
		const target = path.join(workspace.tmpDir, "host-shim.ts");
		fs.copyFileSync(
			path.join(repoRoot, "clients", "mcp", "host-shim.ts"),
			target,
		);
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
				lang: "typescript",
				paths: [path.join(repoRoot, "clients", "mcp")],
			},
		});
		const result = res.result as {
			content: { type: string; text: string }[];
			isError?: boolean;
		};
		expect(result.isError).toBeFalsy();
		expect(result.content[0].type).toBe("text");
		expect(typeof result.content[0].text).toBe("string");
	}, 45_000);

	// #4723 F4: the MCP route hands execute the client's JSON without schema
	// validation, so `lang` can be any JSON value. Recurrence: replace threw a
	// TypeError on a number (`"pi-lens tool ... failed"`) and search called it
	// "lang is required"; both must answer the refusal that names the ids.
	it.each([
		["pilens_ast_grep_search", 3],
		["pilens_ast_grep_search", null],
		["pilens_ast_grep_replace", 3],
		["pilens_ast_grep_replace", { id: "typescript" }],
	] as const)(
		"refuses %s with lang %j over the wire",
		async (name, lang) => {
			const res = await harness.request(4723, "tools/call", {
				name,
				arguments:
					name === "pilens_ast_grep_replace"
						? { pattern: "foo($X)", rewrite: "bar($X)", lang }
						: { pattern: "foo($X)", lang },
			});
			const result = res.result as {
				content: { type: string; text: string }[];
				isError?: boolean;
			};
			expect(result.isError).toBe(true);
			expect(result.content[0]?.text).toContain("lang must be a string");
			expect(result.content[0]?.text).toContain("valid ids: bash");
		},
		25_000,
	);

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
// The reviewed sweep output (#3809 re-pin, #5041 re-pin): all 429 refusals of
// 4813 probes over the live tools/list schemas, every one a declared parameter
// the call did not send, written with another case, a plural `s`, or a leading
// word that does not retarget it (`filePath`, `dir_path`, `Paths` -> `path`,
// `kind` for `kinds`; not `cwdPath`, `maxFiles`). A new tool or key that adds a
// pair must be read and added here on purpose.
//
// #5041 grew this list from 273 for one reason: six single-file tools now declare
// `path` ALONGSIDE `file` and `filePath` (`pilens_analyze`,
// `pilens_module_report`, `pilens_read_symbol`, `pilens_read_enclosing`,
// `pilens_effective_config`, plus the folded `pilens_diagnostics` /
// `pilens_lsp_navigation` schemas). Each new declared spelling retires the
// `{filePath} -> path` rows it used to refuse and adds `{Path} -> path` /
// `{files} -> file` / `{filepath} -> filePath` rows in their place; `pilens_analyze`
// also stops declaring a `required` key, because any one of the three spellings
// now satisfies it, and a probe that sends no spelling refuses on the others.
const PINNED_REFUSALS: string[] = [
	"pilens_analyze {Cwd} -> cwd",
	"pilens_analyze {FILE} -> file",
	"pilens_analyze {FilePath} -> filePath",
	"pilens_analyze {Filepath} -> filePath",
	"pilens_analyze {File} -> file",
	"pilens_analyze {Flags} -> flags",
	"pilens_analyze {Mode} -> mode",
	"pilens_analyze {PATH} -> path",
	"pilens_analyze {Path} -> path",
	"pilens_analyze {absPath} -> path",
	"pilens_analyze {configPath} -> path",
	"pilens_analyze {cwds} -> cwd",
	"pilens_analyze {dirPath} -> path",
	"pilens_analyze {dir_path} -> path",
	"pilens_analyze {filePaths} -> filePath",
	"pilens_analyze {file_path} -> filePath",
	"pilens_analyze {filepaths} -> filePath",
	"pilens_analyze {filepath} -> filePath",
	"pilens_analyze {files} -> file",
	"pilens_analyze {hasFiles} -> file",
	"pilens_analyze {modes} -> mode",
	"pilens_analyze {namePath} -> path",
	"pilens_analyze {name_path} -> path",
	"pilens_analyze {newFile} -> file",
	"pilens_analyze {paths} -> path",
	"pilens_analyze {projectPath} -> path",
	"pilens_analyze {rootPath} -> path",
	"pilens_analyze {sourcePath} -> path",
	"pilens_analyze {source_path} -> path",
	"pilens_analyze {symbolPath} -> path",
	"pilens_analyze {symbol_path} -> path",
	"pilens_analyze {targetPath} -> path",
	"pilens_analyze {target_path} -> path",
	"pilens_analyze {workspacePath} -> path",
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
	"pilens_ast_grep_replace {absPath} -> paths",
	"pilens_ast_grep_replace {applys} -> apply", // spellchecker:disable-line
	"pilens_ast_grep_replace {configPath} -> paths",
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
	"pilens_ast_grep_replace {path} -> paths",
	"pilens_ast_grep_replace {projectPath} -> paths",
	"pilens_ast_grep_replace {rootPath} -> paths",
	"pilens_ast_grep_replace {sourcePath} -> paths",
	"pilens_ast_grep_replace {source_path} -> paths",
	"pilens_ast_grep_replace {symbolPath} -> paths",
	"pilens_ast_grep_replace {symbol_path} -> paths",
	"pilens_ast_grep_replace {targetPath} -> paths",
	"pilens_ast_grep_replace {target_path} -> paths",
	"pilens_ast_grep_replace {workspacePath} -> paths",
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
	"pilens_ast_grep_search {absPath} -> paths",
	"pilens_ast_grep_search {configPath} -> paths",
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
	"pilens_ast_grep_search {path} -> paths",
	"pilens_ast_grep_search {patterns} -> pattern",
	"pilens_ast_grep_search {projectPath} -> paths",
	"pilens_ast_grep_search {rootPath} -> paths",
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
	"pilens_ast_grep_search {workspacePath} -> paths",
	"pilens_diagnostics {AnalysisRoot} -> analysisRoot",
	"pilens_diagnostics {Concurrency} -> concurrency",
	"pilens_diagnostics {Cwd} -> cwd",
	"pilens_diagnostics {FILE} -> file",
	"pilens_diagnostics {FilePath} -> filePath",
	"pilens_diagnostics {Filepath} -> filePath",
	"pilens_diagnostics {File} -> file",
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
	"pilens_diagnostics {absPath} -> path",
	"pilens_diagnostics {analysisRoots} -> analysisRoot",
	"pilens_diagnostics {concurrencys} -> concurrency",
	"pilens_diagnostics {configPath} -> path",
	"pilens_diagnostics {cwds} -> cwd",
	"pilens_diagnostics {dirPath} -> path",
	"pilens_diagnostics {dir_path} -> path",
	"pilens_diagnostics {filePaths} -> filePath",
	"pilens_diagnostics {file_path} -> filePath",
	"pilens_diagnostics {filepaths} -> filePath",
	"pilens_diagnostics {filepath} -> filePath",
	"pilens_diagnostics {files} -> file",
	"pilens_diagnostics {hasFiles} -> file",
	"pilens_diagnostics {includeGenerateds} -> includeGenerated",
	"pilens_diagnostics {modes} -> mode",
	"pilens_diagnostics {namePath} -> path",
	"pilens_diagnostics {name_path} -> path",
	"pilens_diagnostics {newFile} -> file",
	"pilens_diagnostics {projectPath} -> path",
	"pilens_diagnostics {rootPath} -> path",
	"pilens_diagnostics {scopes} -> scope",
	"pilens_diagnostics {serverScopes} -> serverScope",
	"pilens_diagnostics {severitys} -> severity",
	"pilens_diagnostics {sources} -> source",
	"pilens_diagnostics {symbolPath} -> path",
	"pilens_diagnostics {symbol_path} -> path",
	"pilens_diagnostics {targetPath} -> path",
	"pilens_diagnostics {target_path} -> path",
	"pilens_diagnostics {workspacePath} -> path",
	"pilens_effective_config {Cwd} -> cwd",
	"pilens_effective_config {FILE} -> file",
	"pilens_effective_config {FilePath} -> filePath",
	"pilens_effective_config {Filepath} -> filePath",
	"pilens_effective_config {File} -> file",
	"pilens_effective_config {PATH} -> path",
	"pilens_effective_config {Path} -> path",
	"pilens_effective_config {absPath} -> path",
	"pilens_effective_config {configPath} -> path",
	"pilens_effective_config {cwds} -> cwd",
	"pilens_effective_config {dirPath} -> path",
	"pilens_effective_config {dir_path} -> path",
	"pilens_effective_config {filePaths} -> filePath",
	"pilens_effective_config {file_path} -> filePath",
	"pilens_effective_config {filepaths} -> filePath",
	"pilens_effective_config {filepath} -> filePath",
	"pilens_effective_config {files} -> file",
	"pilens_effective_config {hasFiles} -> file",
	"pilens_effective_config {namePath} -> path",
	"pilens_effective_config {name_path} -> path",
	"pilens_effective_config {newFile} -> file",
	"pilens_effective_config {paths} -> path",
	"pilens_effective_config {projectPath} -> path",
	"pilens_effective_config {rootPath} -> path",
	"pilens_effective_config {sourcePath} -> path",
	"pilens_effective_config {source_path} -> path",
	"pilens_effective_config {symbolPath} -> path",
	"pilens_effective_config {symbol_path} -> path",
	"pilens_effective_config {targetPath} -> path",
	"pilens_effective_config {target_path} -> path",
	"pilens_effective_config {workspacePath} -> path",
	"pilens_latency {FILE} -> file",
	"pilens_latency {File} -> file",
	"pilens_latency {Limit} -> limit",
	"pilens_latency {files} -> file",
	"pilens_latency {hasFiles} -> file",
	"pilens_latency {limits} -> limit",
	"pilens_latency {newFile} -> file",
	"pilens_lsp_navigation {Apply} -> apply",
	"pilens_lsp_navigation {CallHierarchyItem} -> callHierarchyItem",
	"pilens_lsp_navigation {Character} -> character",
	"pilens_lsp_navigation {CommandArguments} -> commandArguments",
	"pilens_lsp_navigation {Command} -> command",
	"pilens_lsp_navigation {Cwd} -> cwd",
	"pilens_lsp_navigation {EndCharacter} -> endCharacter",
	"pilens_lsp_navigation {EndLine} -> endLine",
	"pilens_lsp_navigation {ExactMatch} -> exactMatch",
	"pilens_lsp_navigation {FILE} -> file",
	"pilens_lsp_navigation {FilePath} -> filePath",
	"pilens_lsp_navigation {Filepath} -> filePath",
	"pilens_lsp_navigation {File} -> file",
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
	"pilens_lsp_navigation {absPath} -> path",
	"pilens_lsp_navigation {applys} -> apply", // spellchecker:disable-line
	"pilens_lsp_navigation {callHierarchyItems} -> callHierarchyItem",
	"pilens_lsp_navigation {characters} -> character",
	"pilens_lsp_navigation {commands} -> command",
	"pilens_lsp_navigation {configPath} -> path",
	"pilens_lsp_navigation {cwds} -> cwd",
	"pilens_lsp_navigation {dirPath} -> path",
	"pilens_lsp_navigation {dir_path} -> path",
	"pilens_lsp_navigation {endCharacters} -> endCharacter",
	"pilens_lsp_navigation {endLines} -> endLine",
	"pilens_lsp_navigation {exactMatchs} -> exactMatch", // spellchecker:disable-line
	"pilens_lsp_navigation {filePaths} -> filePath",
	"pilens_lsp_navigation {file_path} -> filePath",
	"pilens_lsp_navigation {filepaths} -> filePath",
	"pilens_lsp_navigation {filepath} -> filePath",
	"pilens_lsp_navigation {files} -> file",
	"pilens_lsp_navigation {hasFiles} -> file",
	"pilens_lsp_navigation {kind} -> kinds",
	"pilens_lsp_navigation {lines} -> line",
	"pilens_lsp_navigation {namePath} -> path",
	"pilens_lsp_navigation {name_path} -> path",
	"pilens_lsp_navigation {newFilePaths} -> newFilePath",
	"pilens_lsp_navigation {newFile} -> file",
	"pilens_lsp_navigation {newNames} -> newName",
	"pilens_lsp_navigation {paths} -> path",
	"pilens_lsp_navigation {projectPath} -> path",
	"pilens_lsp_navigation {querys} -> query", // spellchecker:disable-line
	"pilens_lsp_navigation {rootPath} -> path",
	"pilens_lsp_navigation {sourcePath} -> path",
	"pilens_lsp_navigation {source_path} -> path",
	"pilens_lsp_navigation {symbols} -> symbol",
	"pilens_lsp_navigation {targetPath} -> path",
	"pilens_lsp_navigation {target_path} -> path",
	"pilens_lsp_navigation {topLevelOnlys} -> topLevelOnly",
	"pilens_lsp_navigation {workspacePath} -> path",
	"pilens_module_report {BlastRadiusDepth} -> blastRadiusDepth",
	"pilens_module_report {BlastRadius} -> blastRadius",
	"pilens_module_report {CallGraph} -> callGraph",
	"pilens_module_report {Cwd} -> cwd",
	"pilens_module_report {FILE} -> file",
	"pilens_module_report {FilePath} -> filePath",
	"pilens_module_report {Filepath} -> filePath",
	"pilens_module_report {File} -> file",
	"pilens_module_report {Focus} -> focus",
	"pilens_module_report {MaxCallGraphEntries} -> maxCallGraphEntries",
	"pilens_module_report {MaxRefsPerSymbol} -> maxRefsPerSymbol",
	"pilens_module_report {PATH} -> path",
	"pilens_module_report {Path} -> path",
	"pilens_module_report {View} -> view",
	"pilens_module_report {absPath} -> path",
	"pilens_module_report {blastRadiusDepths} -> blastRadiusDepth",
	"pilens_module_report {callGraphs} -> callGraph",
	"pilens_module_report {configPath} -> path",
	"pilens_module_report {cwds} -> cwd",
	"pilens_module_report {dirPath} -> path",
	"pilens_module_report {dir_path} -> path",
	"pilens_module_report {filePaths} -> filePath",
	"pilens_module_report {file_path} -> filePath",
	"pilens_module_report {filepaths} -> filePath",
	"pilens_module_report {filepath} -> filePath",
	"pilens_module_report {files} -> file",
	"pilens_module_report {hasFiles} -> file",
	"pilens_module_report {maxRefsPerSymbols} -> maxRefsPerSymbol",
	"pilens_module_report {namePath} -> path",
	"pilens_module_report {name_path} -> path",
	"pilens_module_report {newFile} -> file",
	"pilens_module_report {paths} -> path",
	"pilens_module_report {projectPath} -> path",
	"pilens_module_report {rootPath} -> path",
	"pilens_module_report {sourcePath} -> path",
	"pilens_module_report {source_path} -> path",
	"pilens_module_report {symbolPath} -> path",
	"pilens_module_report {symbol_path} -> path",
	"pilens_module_report {targetPath} -> path",
	"pilens_module_report {target_path} -> path",
	"pilens_module_report {views} -> view",
	"pilens_module_report {workspacePath} -> path",
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
	"pilens_read_enclosing {FILE} -> file",
	"pilens_read_enclosing {FilePath} -> filePath",
	"pilens_read_enclosing {Filepath} -> filePath",
	"pilens_read_enclosing {File} -> file",
	"pilens_read_enclosing {Kinds} -> kinds",
	"pilens_read_enclosing {Kind} -> kinds",
	"pilens_read_enclosing {MaxLines} -> maxLines",
	"pilens_read_enclosing {OnOversize} -> onOversize",
	"pilens_read_enclosing {PATH} -> path",
	"pilens_read_enclosing {Path} -> path",
	"pilens_read_enclosing {absPath} -> path",
	"pilens_read_enclosing {aroundLines} -> aroundLine",
	"pilens_read_enclosing {configPath} -> path",
	"pilens_read_enclosing {cwds} -> cwd",
	"pilens_read_enclosing {dirPath} -> path",
	"pilens_read_enclosing {dir_path} -> path",
	"pilens_read_enclosing {filePaths} -> filePath",
	"pilens_read_enclosing {file_path} -> filePath",
	"pilens_read_enclosing {filepaths} -> filePath",
	"pilens_read_enclosing {filepath} -> filePath",
	"pilens_read_enclosing {files} -> file",
	"pilens_read_enclosing {hasFiles} -> file",
	"pilens_read_enclosing {kind} -> kinds",
	"pilens_read_enclosing {namePath} -> path",
	"pilens_read_enclosing {name_path} -> path",
	"pilens_read_enclosing {newFile} -> file",
	"pilens_read_enclosing {onOversizes} -> onOversize",
	"pilens_read_enclosing {paths} -> path",
	"pilens_read_enclosing {projectPath} -> path",
	"pilens_read_enclosing {rootPath} -> path",
	"pilens_read_enclosing {sourcePath} -> path",
	"pilens_read_enclosing {source_path} -> path",
	"pilens_read_enclosing {symbolPath} -> path",
	"pilens_read_enclosing {symbol_path} -> path",
	"pilens_read_enclosing {targetPath} -> path",
	"pilens_read_enclosing {target_path} -> path",
	"pilens_read_enclosing {workspacePath} -> path",
	"pilens_read_symbol {Cwd} -> cwd",
	"pilens_read_symbol {FILE} -> file",
	"pilens_read_symbol {FilePath} -> filePath",
	"pilens_read_symbol {Filepath} -> filePath",
	"pilens_read_symbol {File} -> file",
	"pilens_read_symbol {Kind} -> kind",
	"pilens_read_symbol {PATH} -> path",
	"pilens_read_symbol {Path} -> path",
	"pilens_read_symbol {absPath} -> path",
	"pilens_read_symbol {configPath} -> path",
	"pilens_read_symbol {cwds} -> cwd",
	"pilens_read_symbol {dirPath} -> path",
	"pilens_read_symbol {dir_path} -> path",
	"pilens_read_symbol {filePaths} -> filePath",
	"pilens_read_symbol {file_path} -> filePath",
	"pilens_read_symbol {filepaths} -> filePath",
	"pilens_read_symbol {filepath} -> filePath",
	"pilens_read_symbol {files} -> file",
	"pilens_read_symbol {hasFiles} -> file",
	"pilens_read_symbol {kinds} -> kind",
	"pilens_read_symbol {namePath} -> path",
	"pilens_read_symbol {name_path} -> path",
	"pilens_read_symbol {newFile} -> file",
	"pilens_read_symbol {paths} -> path",
	"pilens_read_symbol {projectPath} -> path",
	"pilens_read_symbol {rootPath} -> path",
	"pilens_read_symbol {sourcePath} -> path",
	"pilens_read_symbol {source_path} -> path",
	"pilens_read_symbol {targetPath} -> path",
	"pilens_read_symbol {target_path} -> path",
	"pilens_read_symbol {workspacePath} -> path",
	"pilens_session_start {Cwd} -> cwd",
	"pilens_session_start {cwds} -> cwd",
	"pilens_symbol_search {Cwd} -> cwd",
	"pilens_symbol_search {Lang} -> lang",
	"pilens_symbol_search {Limit} -> limit",
	"pilens_symbol_search {PATH} -> paths",
	"pilens_symbol_search {Paths} -> paths",
	"pilens_symbol_search {Path} -> paths",
	"pilens_symbol_search {absPath} -> paths",
	"pilens_symbol_search {configPath} -> paths",
	"pilens_symbol_search {cwds} -> cwd",
	"pilens_symbol_search {dirPath} -> paths",
	"pilens_symbol_search {dir_path} -> paths",
	"pilens_symbol_search {filePath} -> paths",
	"pilens_symbol_search {file_path} -> paths",
	"pilens_symbol_search {langs} -> lang",
	"pilens_symbol_search {limits} -> limit",
	"pilens_symbol_search {namePath} -> paths",
	"pilens_symbol_search {name_path} -> paths",
	"pilens_symbol_search {path} -> paths",
	"pilens_symbol_search {projectPath} -> paths",
	"pilens_symbol_search {rootPath} -> paths",
	"pilens_symbol_search {sourcePath} -> paths",
	"pilens_symbol_search {source_path} -> paths",
	"pilens_symbol_search {symbolPath} -> paths",
	"pilens_symbol_search {symbol_path} -> paths",
	"pilens_symbol_search {targetPath} -> paths",
	"pilens_symbol_search {target_path} -> paths",
	"pilens_symbol_search {workspacePath} -> paths",
	"pilens_turn_end {Cwd} -> cwd",
	"pilens_turn_end {FILE} -> files",
	"pilens_turn_end {Files} -> files",
	"pilens_turn_end {File} -> files",
	"pilens_turn_end {cwds} -> cwd",
	"pilens_turn_end {file} -> files",
	"pilens_turn_end {hasFiles} -> files",
	"pilens_turn_end {newFile} -> files",
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
	//
	// #5041 superseded the refusal: `filePath` is now a DECLARED alias of `path`
	// on every single-file tool, so the call runs — and it must run SCOPED, which
	// is the half of the report that a warning alone never fixed.
	it("runs the reporter's `filePath` call scoped to that file, not on the default scope", async () => {
		const result = await call("pilens_diagnostics", {
			filePath: "/tmp/x/bad.ts",
		});
		expect(result.isError).not.toBe(true);
		expect(firstLine(result)).not.toContain("Ignored unknown argument");
		expect(result.content[0]?.text).toContain(
			"paths restricts this to cached findings",
		);
		expect(result.structuredContent).toBeUndefined();
	}, 25_000);

	it("keeps a warning for a spelling that is not a declared alias", async () => {
		const result = await call("pilens_diagnostics", {
			file_path: "/tmp/x/bad.ts",
		});
		expect(result.isError).toBe(true);
		expect(firstLine(result)).toContain("Ignored unknown argument(s)");
		expect(result.content[0]?.text).toContain(
			"Not run: `file_path` looks like a mistyped `filePath`, which was not sent.",
		);
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
		const result = await call("pilens_ast_grep_search", {
			langs: "typescript",
		});
		expect(result.isError).toBe(true);
		expect(firstLine(result)).toBe(
			"Ignored unknown argument(s) for pilens_ast_grep_search: `langs` (did you mean `lang`?). They had no effect on this call.",
		);
		expect(result.content[0]?.text).toContain(
			"Not run: required argument(s) `lang` missing",
		);
		expect(result.structuredContent?.ignoredArguments).toEqual(["langs"]);
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
			"pilens_analyze requires a `path` string.",
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
		// #5041: `filePath` is now a declared alias of `path`, so this call runs
		// scoped; a spelling that is not declared still refuses.
		const aliased = await call("pilens_lsp_diagnostics", { filePath: "x.ts" });
		// The retired name's contract forwards `path` to the LSP probe, so an
		// absent file is "Path not found" — which is itself proof the alias was
		// read as the file parameter rather than reported and dropped.
		expect(aliased.content[0]?.text).toContain("Path not found");
		expect(aliased.content[0]?.text).toContain("x.ts");
		expect(aliased.content[0]?.text).not.toContain("Ignored unknown");
		const refused = await call("pilens_lsp_diagnostics", { file_path: "x.ts" });
		expect(refused.isError).toBe(true);
		expect(refused.content[0]?.text).toContain(
			"Not run: `file_path` looks like a mistyped `filePath`, which was not sent.",
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
			["pilens_lsp_navigation", { operation: "hover" }, "filePath", null],
			[
				"pilens_lsp_navigation",
				{ operation: "hover" },
				"file_path",
				"filePath",
			],
			["pilens_lsp_navigation", { operation: "hover" }, "file", null],
			["pilens_lsp_navigation", { operation: "hover" }, "files", "file"],
			["pilens_lsp_navigation", { operation: "hover" }, "File", "file"],
			["pilens_diagnostics", {}, "filePath", null],
			["pilens_diagnostics", {}, "file_path", "filePath"],
			["pilens_diagnostics", {}, "file", null],
			["pilens_diagnostics", {}, "files", "file"],
			["pilens_diagnostics", {}, "File", "file"],
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
			// #3809: the qualifier makes these a different parameter, not `path` /
			// `file` / `files`; each was refused on that head noun before.
			["pilens_diagnostics", {}, "cwdPath", null],
			["pilens_lsp_navigation", { operation: "hover" }, "cwdPath", null],
			["pilens_turn_end", {}, "maxFiles", null],
			["pilens_latency", {}, "outFile", null],
			["pilens_latency", {}, "includeFiles", null],
			// An undeclared qualifier keeps the head-noun refusal.
			["pilens_diagnostics", {}, "workspacePath", "path"],
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

	// #3809: a retargeted key runs with a warning that names no wrong parameter.
	it("hints the declared qualifier for cwdPath and no head noun for maxFiles", async () => {
		const cwdPath = await call("pilens_diagnostics", { cwdPath: "/x" });
		expect(cwdPath.isError).not.toBe(true);
		expect(firstLine(cwdPath)).toBe(
			"Ignored unknown argument(s) for pilens_diagnostics: `cwdPath` (did you mean `cwd`?). They had no effect on this call.",
		);
		const maxFiles = await call("pilens_turn_end", { maxFiles: 3 });
		expect(maxFiles.isError).not.toBe(true);
		expect(firstLine(maxFiles)).toBe(
			"Ignored unknown argument(s) for pilens_turn_end: `maxFiles`. They had no effect on this call.",
		);
	}, 60_000);

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
		// #3809: a qualifier plus a head noun. Retargeted ones (`cwdPath`,
		// `maxFiles`) must not be pinned as refusals; the rest are.
		const qualified = [
			"cwdPath",
			"cwd_path",
			"maxFiles",
			"countFiles",
			"outFile",
			"includeFiles",
			"workspacePath",
			"projectPath",
			"rootPath",
			"configPath",
			"absPath",
			"newFile",
			"hasFiles",
		];
		const common = new Set<string>([
			...qualified,
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
		// #3809: a retargeted key runs instead of being refused, and is counted.
		await call("pilens_turn_end", { maxFiles: 3 });
		const last = await health();
		expect(last?.count).toBe((after?.count ?? 0) + 1);
		expect(
			last?.latestReasons.find((entry) => entry.subject === "pilens_turn_end")
				?.reason,
		).toContain("ignored argument(s): maxFiles");
	}, 25_000);
});

// Recurrence (#4081): dispose() SIGKILLed only the server, so a descendant it
// had spawned (detached, as the real tools are) outlived it, kept writing under
// PI_LENS_HOME, and failed the recursive removal. A preload makes the server
// spawn exactly that writer at startup; the removal of its directory succeeds
// only when dispose() killed the whole tree.
// #5041: `path` is the canonical single-file parameter, and `file` /
// `filePath` stay accepted as aliases so no caller breaks (#2418). Before this
// change `pilens_module_report {path}` was REFUSED and `pilens_diagnostics
// {file}` ran on the default scope with only a warning — the answer looked
// real. These cases drive the real stdio server: the schema census reads
// `tools/list`, and each call proves the alias is the one the handler used.
describe("pi-lens MCP canonical `path` parameter (#5041)", { retry: 2 }, () => {
	type WireResult = {
		isError?: boolean;
		content: { text: string }[];
		structuredContent?: unknown;
	};
	let harness: McpHarness;
	let workspace: ReturnType<typeof setupTestEnvironment>;
	let nextId = 504_100;
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
	const text = (result: WireResult): string =>
		result.content.map((part) => part.text).join("\n");

	beforeAll(async () => {
		workspace = setupTestEnvironment("pi-lens-mcp-5041-");
		harness = new McpHarness({ cwd: workspace.tmpDir });
		await harness.request(504_099, "initialize", {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "canonical-path", version: "0" },
		});
		harness.notify("notifications/initialized");
	}, 25_000);

	afterAll(async () => {
		harness.dispose();
		workspace.cleanup();
	});

	it("declares `path` plus both aliases on every single-file tool", async () => {
		const listed = (await harness.request(504_098, "tools/list")).result as {
			tools: {
				name: string;
				inputSchema: { properties?: Record<string, unknown> };
			}[];
		};
		const singleFile = [
			"pilens_analyze",
			"pilens_module_report",
			"pilens_read_symbol",
			"pilens_read_enclosing",
			"pilens_effective_config",
			"pilens_diagnostics",
			"pilens_lsp_navigation",
		];
		for (const name of singleFile) {
			const tool = listed.tools.find((candidate) => candidate.name === name);
			expect(tool, `missing ${name}`).toBeDefined();
			const keys = Object.keys(tool?.inputSchema.properties ?? {});
			// A tool that only declares its old spelling sends an agent reading
			// another tool's schema to a refused or silently-dropped key.
			expect(keys, name).toContain("path");
			expect(keys, name).toContain("file");
			expect(keys, name).toContain("filePath");
		}
	}, 30_000);

	it("runs pilens_module_report through the canonical `path`", async () => {
		const result = await call("pilens_module_report", { path: "missing.ts" });
		// A missing file is its own answer; the point is that the argument was
		// READ (pre-fix this call was refused as an unknown `path` key).
		expect(text(result)).toContain("No module report for missing.ts");
		expect(text(result)).not.toContain("Not run:");
		expect(text(result)).not.toContain("Ignored unknown");
	}, 30_000);

	it("runs pilens_read_symbol and pilens_read_enclosing through `path`", async () => {
		const file = path.join(workspace.tmpDir, "app.ts");
		fs.writeFileSync(
			file,
			"export function greet(name: string) {\n  return `hi ${name}`;\n}\n",
		);
		const symbol = await call("pilens_read_symbol", {
			path: "app.ts",
			symbol: "greet",
		});
		expect(symbol.isError).toBeFalsy();
		expect(text(symbol)).toContain("greet");
		const enclosing = await call("pilens_read_enclosing", {
			path: "app.ts",
			line: 2,
		});
		expect(enclosing.isError).toBeFalsy();
		expect(text(enclosing)).toContain("greet");
	}, 30_000);

	it("runs pilens_effective_config through `path`, as through `file`", async () => {
		const file = path.join(workspace.tmpDir, "app.ts");
		fs.writeFileSync(file, "export const value = 1;\n");
		const canonical = await call("pilens_effective_config", { path: "app.ts" });
		const older = await call("pilens_effective_config", { file: "app.ts" });
		expect(canonical.isError, text(canonical)).toBeFalsy();
		expect(text(canonical)).toContain(`File: ${file}`);
		expect(text(older)).toContain(`File: ${file}`);
	}, 30_000);

	it("runs pilens_analyze through `path` instead of asking for `file`", async () => {
		const target = path.join(workspace.tmpDir, "analyzed-5041.ts");
		fs.writeFileSync(target, "export const analyzed = 1;\n");
		const result = await call("pilens_analyze", {
			path: target,
			mode: "warm",
			flags: { "no-lsp": true },
		});
		// Pre-fix the call was refused as `required argument(s) \`file\` missing`;
		// an answer that names the analyzed file proves `path` was read.
		expect(result.isError, text(result)).toBeFalsy();
		expect(text(result)).not.toContain("Not run:");
		expect(text(result)).toContain("[warm]");
		expect(text(result)).toContain("analyzed-5041.ts");
	}, 60_000);

	// RECURRENCE GUARDED (#5047 r1 F3): a call that names its file through one
	// declared spelling and adds an UNDECLARED near-miss of a different spelling
	// was refused with "looks like a mistyped `filePath`, which was not sent",
	// although the file was sent. The extra key is still reported, never refused.
	it("runs a call that names its file and adds a mistyped sibling spelling", async () => {
		const diagnostics = await call("pilens_diagnostics", {
			path: "src/app.ts",
			file_path: "src/app.ts",
		});
		expect(diagnostics.isError, text(diagnostics)).not.toBe(true);
		expect(text(diagnostics)).not.toContain("Not run:");
		expect(text(diagnostics)).toContain("Ignored unknown argument");
		expect(text(diagnostics)).toContain("file_path");
		const analyze = await call("pilens_analyze", {
			file: path.join(workspace.tmpDir, "analyzed-5041.ts"),
			sourcePath: "ignored",
			mode: "warm",
			flags: { "no-lsp": true },
		});
		expect(analyze.isError, text(analyze)).not.toBe(true);
		expect(text(analyze)).not.toContain("Not run:");
		expect(text(analyze)).toContain("Ignored unknown argument");
	}, 60_000);

	it("scopes pilens_diagnostics to the file an alias names", async () => {
		const result = await call("pilens_diagnostics", { file: "src/app.ts" });
		expect(result.isError).not.toBe(true);
		expect(text(result)).toContain("paths restricts this to cached findings");
	}, 30_000);

	it("refuses two spellings that name different files", async () => {
		const result = await call("pilens_module_report", {
			path: "a.ts",
			file: "b.ts",
		});
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("name different files");
	}, 30_000);
});

describe("McpHarness.dispose tears down the server's process tree", () => {
	it.skipIf(process.platform === "win32")(
		"kills a detached descendant and removes the home it writes into",
		async () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-mcp-tree-");
			const info = path.join(tmpDir, "info.json");
			const preload = path.join(
				repoRoot,
				"tests/fixtures/mcp-orphan-writer-preload.cjs",
			);
			const harness = new McpHarness({
				cwd: tmpDir,
				env: {
					NODE_OPTIONS: `--require ${preload}`,
					ORPHAN_WRITER_INFO: info,
				},
			});
			let stderr = "";
			const write = vi
				.spyOn(process.stderr, "write")
				.mockImplementation((chunk) => {
					stderr += String(chunk);
					return true;
				});
			try {
				await harness.request(90, "initialize", {
					protocolVersion: "2025-06-18",
					capabilities: {},
					clientInfo: { name: "dispose-test", version: "0" },
				});
				const { home, writer: pid } = JSON.parse(
					fs.readFileSync(info, "utf8"),
				) as { home: string; writer: number };
				expect(isProcessAlive(pid)).toBe(true);
				harness.dispose();
				// PI_LENS_HOME is <isolationDir>/home, which dispose() removes whole.
				expect(fs.existsSync(path.dirname(home))).toBe(false);
				expect(stderr).not.toContain("[test cleanup] could not remove");
			} finally {
				write.mockRestore();
				cleanup();
			}
		},
		60_000,
	);
});

/**
 * #3405: a save-triggered server answers an MCP host. The fake server here
 * declares `textDocumentSync.save` and publishes ONLY from its didSave branch,
 * Expert's measured shape (it compiles on didSave and on nothing else), so the
 * finding reaches the MCP result exactly when a save reached the server.
 * Recurrences, each measured on the real MCP server with clangd 22.1.0:
 * `pilens_analyze` (the route the PostToolUse hooks share) never declared its
 * touch a save, and a cold `pilens_diagnostics` query lost its save to the
 * debounce after its own unsaved sweep warm-up pushed the same bytes.
 */
describe("a save-triggered server through MCP (#3405)", { retry: 2 }, () => {
	const SAVE_ONLY_MESSAGE = "diagnostic published only after didSave";

	/** `cleanOnOpen`: the server also answers each didOpen/didChange with an
	 *  empty publish, so a sweep warm-up sees a ready server; without it the
	 *  server is silent until a save, Expert's measured shape. */
	function saveOnlyWorkspace(prefix: string, cleanOnOpen = false) {
		const env = setupTestEnvironment(prefix);
		const trace = path.join(env.tmpDir, "save-server.trace");
		const shim = path.join(env.tmpDir, "save-server.mjs");
		fs.writeFileSync(
			shim,
			[
				'process.env.FAKE_LSP_SAVE = "true";',
				'process.env.FAKE_LSP_PUBLISH_ON_SAVE = "1";',
				'process.env.FAKE_LSP_NO_DIAGNOSTIC_PROVIDER = "1";',
				...(cleanOnOpen
					? ['process.env.FAKE_LSP_PUBLISH_SEQUENCE = "empty";']
					: []),
				`process.env.FAKE_LSP_TRACE_FILE = ${JSON.stringify(trace)};`,
				`await import(${JSON.stringify(new URL("../fixtures/fake-lsp-server.mjs", import.meta.url).href)});`,
				"",
			].join("\n"),
		);
		fs.writeFileSync(path.join(env.tmpDir, ".luarc.json"), "{}\n");
		fs.mkdirSync(path.join(env.tmpDir, ".pi-lens"), { recursive: true });
		fs.writeFileSync(
			path.join(env.tmpDir, ".pi-lens", "lsp.json"),
			JSON.stringify({
				servers: {
					emmylua: {
						name: "save-only server",
						extensions: [".lua"],
						command: process.execPath,
						args: [shim],
						rootMarkers: [".luarc.json"],
					},
				},
				disabledServers: ["lua", "ast-grep", "typos", "opengrep"],
			}),
		);
		const file = path.join(env.tmpDir, "probe.lua");
		fs.writeFileSync(file, "local value = 1\n");
		/** Every document notification the server received, by method. */
		const wire = () =>
			fs.existsSync(trace)
				? fs
						.readFileSync(trace, "utf8")
						.split("\n")
						.flatMap(
							(line) =>
								/^recv textDocument\/(did\w+) /.exec(line)?.slice(1, 2) ?? [],
						)
				: [];
		const saves = () => wire().filter((method) => method === "didSave");
		return { env, file, saves, wire };
	}

	it("pilens_analyze returns the finding a save-only server publishes", async () => {
		const { env, file, wire } = saveOnlyWorkspace("pi-lens-mcp-save-analyze-");
		const child = new McpHarness({ cwd: env.tmpDir });
		try {
			// Default flags, so the auxiliary profiles stay on and the dispatch
			// runner touches with scope "with-auxiliary" after the analysis's
			// "primary" push. #3405 r2: the debounce key carried the scope, so the
			// runner re-pushed the same bytes after the save and cleared the
			// finding this server (silent on a change) had published.
			const res = await child.request(3405, "tools/call", {
				name: "pilens_analyze",
				arguments: { file, mode: "warm" },
			});
			const text = (res.result as { content: { text: string }[] }).content[0]
				.text;
			expect(wire(), "one push, one save, no re-push").toEqual([
				"didOpen",
				"didSave",
			]);
			expect(text).toContain(SAVE_ONLY_MESSAGE);
		} finally {
			child.dispose();
			env.cleanup();
		}
	}, 60_000);

	it("a cold pilens_diagnostics query saves after its own warm-up pushed the same bytes", async () => {
		const { env, file, saves } = saveOnlyWorkspace(
			"pi-lens-mcp-save-query-",
			true,
		);
		const child = new McpHarness({ cwd: env.tmpDir });
		try {
			const query = () =>
				child.request(3406, "tools/call", {
					name: "pilens_diagnostics",
					arguments: {
						source: "lsp",
						scope: "paths",
						paths: [file],
						serverScope: "primary",
						waitMs: 3000,
						severity: "all",
					},
				});
			await query();
			expect(saves(), "the server heard a save").toHaveLength(1);
			// The empty publish for the re-push and the save's finding race inside
			// the first answer; a repeat query of the same bytes sends nothing
			// (debounced) and reads what the save produced.
			const res = await query();
			const text = (res.result as { content: { text: string }[] }).content[0]
				.text;
			expect(saves(), "one save per bytes").toHaveLength(1);
			expect(text).toContain(SAVE_ONLY_MESSAGE);
		} finally {
			child.dispose();
			env.cleanup();
		}
	}, 60_000);
});

// #4300: the real MCP child must not inherit pi's absent-host trust policy.
// Real transport and process are required: in-process setters cannot witness startup.
describe("non-pi workspace trust (#4300)", () => {
	it("uses the project-local oxlint in warm and fresh MCP analysis", async () => {
		const env = setupTestEnvironment("pi-lens-mcp-trust-bin-");
		const bin = path.join(env.tmpDir, "node_modules", ".bin");
		fs.mkdirSync(bin, { recursive: true });
		const marker = path.join(env.tmpDir, "used-oxlint");
		const script = path.join(env.tmpDir, "oxlint.cjs");
		fs.writeFileSync(
			script,
			`require("node:fs").appendFileSync(${JSON.stringify(marker)}, "used\\n"); console.log(JSON.stringify({diagnostics: []}));`,
		);
		fs.writeFileSync(
			path.join(bin, "oxlint"),
			`#!/usr/bin/env node\nrequire(${JSON.stringify(script)});\n`,
			{ mode: 0o755 },
		);
		fs.writeFileSync(
			path.join(bin, "oxlint.cmd"),
			`@"${process.execPath}" "${script}" %*\r\n`,
		);
		fs.writeFileSync(path.join(env.tmpDir, ".oxlintrc.json"), "{}");
		const file = path.join(env.tmpDir, "sample.js");
		fs.writeFileSync(file, "export const answer = 42;\n");
		const child = new McpHarness({ cwd: env.tmpDir });
		try {
			for (const [index, mode] of ["warm", "fresh"].entries()) {
				fs.rmSync(marker, { force: true });
				await child.request(4300 + index, "tools/call", {
					name: "pilens_analyze",
					arguments: { file, mode, flags: { "no-lsp": true } },
				});
				expect(fs.existsSync(marker), `${mode} uses local oxlint`).toBe(true);
			}
		} finally {
			child.dispose();
			env.cleanup();
		}
	}, 60_000);

	it("admits Lean's code-running server through the real MCP spawn gate", async () => {
		const env = setupTestEnvironment("pi-lens-mcp-trust-lean-");
		const home = path.join(env.tmpDir, "home");
		fs.mkdirSync(home);
		const marker = path.join(env.tmpDir, "spawned-lean");
		const script = path.join(env.tmpDir, "lean.mjs");
		fs.writeFileSync(
			script,
			`import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(marker)}, "spawned"); await import(${JSON.stringify(new URL("../fixtures/fake-lsp-server.mjs", import.meta.url).href)});`,
		);
		fs.writeFileSync(
			path.join(home, "lsp.json"),
			JSON.stringify({
				serverOverrides: { lean: { command: [process.execPath, script] } },
			}),
		);
		fs.writeFileSync(path.join(env.tmpDir, "lakefile.lean"), "import Lake\n");
		const file = path.join(env.tmpDir, "Main.lean");
		fs.writeFileSync(file, "def main := 1\n");
		const child = new McpHarness({
			cwd: env.tmpDir,
			env: { PI_LENS_HOME: home, PI_LENS_TEST_MODE: "0" },
		});
		try {
			await child.request(4302, "tools/call", {
				name: "pilens_lsp_navigation",
				arguments: { operation: "documentSymbol", path: file },
			});
			expect(fs.existsSync(marker), "Lean crossed the project-code gate").toBe(
				true,
			);
			await child.closeInput();
			const records = fs
				.readFileSync(path.join(home, "extension.log"), "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as { message: string });
			expect(
				records.filter(
					(row) =>
						row.message ===
						"mcp: workspace trust belongs to the MCP client; pi trust not consulted",
				),
			).toHaveLength(1);
		} finally {
			child.dispose();
			env.cleanup();
		}
	}, 60_000);
});
