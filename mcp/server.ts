#!/usr/bin/env node
/**
 * pi-lens MCP server — exposes pi-lens's analysis to any MCP client (Claude Code).
 *
 * Transport: newline-delimited JSON-RPC 2.0 over stdio (the MCP stdio framing),
 * hand-rolled — no SDK dependency, so pi's `npm install --omit=dev` of the
 * extension is byte-for-byte unchanged (pi never runs this server; only an MCP
 * client does). The protocol surface a tools-only server needs is tiny and
 * stable: `initialize`, `tools/list`, `tools/call` (+ `ping`).
 *
 * The tools route to the host-neutral facade (clients/mcp/analyze.ts) and the
 * same dispatch/LSP/latency machinery pi-lens runs inside pi — which is what
 * makes a *real review loop* possible: an MCP client observes a commit's real
 * behavioral + perf impact first-hand, in the same latency.log schema, rather
 * than inferring it from pasted logs.
 *
 * stdout carries ONLY JSON-RPC. Everything diagnostic goes to stderr — and we
 * reroute console.log → stderr defensively so no transitively-loaded module can
 * corrupt the message stream.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CacheManager } from "../clients/cache-manager.js";
import { analyzeFile, type McpAnalyzeResult } from "../clients/mcp/analyze.js";
import {
	analyzeFileFresh,
	resolveRebuildScript,
	runRebuild,
	summarizeScan,
} from "../clients/mcp/review.js";
import { runSessionStart, runTurnEnd } from "../clients/mcp/session.js";
import { getDiagnosticTracker } from "../clients/diagnostic-tracker.js";
import { getLatencyReports } from "../clients/dispatch/integration.js";
import { getLSPService } from "../clients/lsp/index.js";
import { initLSPConfig } from "../clients/lsp/config.js";
import { scanProjectDiagnostics } from "../clients/project-diagnostics/scanner.js";
import { AstGrepClient } from "../clients/ast-grep-client.js";
import { createAstGrepReplaceTool } from "../tools/ast-grep-replace.js";
import { createAstGrepSearchTool } from "../tools/ast-grep-search.js";
import { createLensDiagnosticsTool } from "../tools/lens-diagnostics.js";

// Any stray stdout write corrupts the JSON-RPC stream; force it onto stderr.
console.log = (...args: unknown[]) => {
	console.error(...args);
};

const SERVER_NAME = "pi-lens-mcp";
const SERVER_VERSION = "0.1.0";
// Echoed back to the client when it doesn't pin a version; the negotiation rule
// for a tools-only server is "mirror the client's requested version if present".
const FALLBACK_PROTOCOL_VERSION = "2025-06-18";

// --- Workspace resolution ----------------------------------------------------

function resolveDefaultCwd(): string {
	const fromArg = process.argv
		.find((arg) => arg.startsWith("--cwd="))
		?.slice("--cwd=".length);
	return fromArg ?? process.env.PI_LENS_MCP_CWD ?? process.cwd();
}

const DEFAULT_CWD = path.resolve(resolveDefaultCwd());
const lspReadyCwds = new Set<string>();

// Where THIS server's code lives — used to resolve the fresh-mode worker (same
// build layout as the server) and the pi-lens repo root (for rebuilds).
const SERVER_FILE = fileURLToPath(import.meta.url);
const SERVER_DIR = path.dirname(SERVER_FILE);
const WORKER_PATH = path.join(SERVER_DIR, "worker.js");
const REBUILD_SCRIPT = resolveRebuildScript(SERVER_FILE);

function findRepoRoot(start: string): string {
	let dir = start;
	for (let depth = 0; depth < 6; depth++) {
		const pkgPath = path.join(dir, "package.json");
		if (fs.existsSync(pkgPath)) {
			try {
				const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
					name?: string;
				};
				if (pkg.name === "pi-lens") return dir;
			} catch {
				// keep walking up
			}
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return path.resolve(start, "..", "..");
}

const REPO_ROOT = findRepoRoot(SERVER_DIR);

async function ensureReady(cwd: string): Promise<void> {
	const normalized = path.resolve(cwd);
	if (lspReadyCwds.has(normalized)) return;
	try {
		await initLSPConfig(normalized);
	} catch (err) {
		console.error(`[pi-lens-mcp] initLSPConfig failed for ${normalized}: ${err}`);
	}
	lspReadyCwds.add(normalized);
}

// Auto session_start on connect (the "Claude SessionStart hook" the agent can't
// wire directly): a Claude Code SessionStart hook runs a separate process and
// can't warm THIS long-lived server's in-process LSP, so the server self-inits.
// Gated by PI_LENS_MCP_AUTO_SESSION=1 because the full session_start runs project
// scans (knip/jscpd/dep) — opt-in so it doesn't fire in every repo. Fire-and-
// forget; the warm/baseline/scan work continues in the background.
let autoSessionFired = false;
function maybeAutoSessionStart(): void {
	if (autoSessionFired || process.env.PI_LENS_MCP_AUTO_SESSION !== "1") return;
	autoSessionFired = true;
	void ensureReady(DEFAULT_CWD)
		.then(() => runSessionStart(DEFAULT_CWD))
		.then(() => console.error("[pi-lens-mcp] auto session_start complete"))
		.catch((err) =>
			console.error(`[pi-lens-mcp] auto session_start failed: ${err}`),
		);
}

// --- JSON-RPC plumbing -------------------------------------------------------

type JsonRpcId = string | number | null;
interface JsonRpcRequest {
	jsonrpc: "2.0";
	id?: JsonRpcId;
	method: string;
	params?: Record<string, unknown>;
}

function send(message: Record<string, unknown>): void {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(id: JsonRpcId, result: unknown): void {
	send({ jsonrpc: "2.0", id, result });
}

function sendError(id: JsonRpcId, code: number, message: string): void {
	send({ jsonrpc: "2.0", id, error: { code, message } });
}

/** A tool result: human-readable text first, full JSON appended for the agent. */
function toolText(summary: string, structured?: unknown): { content: { type: "text"; text: string }[] } {
	const text =
		structured === undefined
			? summary
			: `${summary}\n\n\`\`\`json\n${JSON.stringify(structured, null, 2)}\n\`\`\``;
	return { content: [{ type: "text" as const, text }] };
}

// --- Tools -------------------------------------------------------------------

const cacheManager = new CacheManager();
const lensDiagnosticsTool = createLensDiagnosticsTool(
	cacheManager,
	() => DEFAULT_CWD,
);
const astGrepClient = new AstGrepClient();
const astGrepSearchTool = createAstGrepSearchTool(astGrepClient);
const astGrepReplaceTool = createAstGrepReplaceTool(astGrepClient);

const TOOLS = [
	{
		name: "pilens_analyze",
		description:
			"Run pi-lens's per-edit dispatch pipeline (LSP + linters + structural " +
			"rules) on a single file and return its diagnostics plus the latency " +
			"record for that dispatch (same schema as latency.log). The core review " +
			"probe: shows a change's real behavioral + perf impact on a real file.",
		inputSchema: {
			type: "object",
			properties: {
				file: {
					type: "string",
					description: "Path to the file to analyze (absolute, or relative to cwd).",
				},
				cwd: {
					type: "string",
					description: "Project root. Defaults to the server's workspace.",
				},
				mode: {
					type: "string",
					enum: ["warm", "fresh"],
					description:
						"warm (default): run in this server process — fast, warm LSP, but reflects the code the server was started with. fresh: fork a worker that loads the freshly-built code from disk — slower, but reflects the latest commit (the honest review loop; pair with pilens_rebuild).",
				},
				flags: {
					type: "object",
					description:
						"Optional pi-lens flag overrides for this run, e.g. {\"no-lsp\": true} to bench the non-LSP path.",
				},
			},
			required: ["file"],
		},
	},
	{
		name: "pilens_diagnostics",
		description:
			"Query pi-lens's diagnostic state across ALL runners (not just LSP). " +
			"mode=delta (current turn, instant), mode=all (every dispatched file this " +
			"session), mode=full (expensive project-wide active scan).",
		inputSchema: {
			type: "object",
			properties: {
				mode: { type: "string", enum: ["delta", "all", "full"] },
				severity: { type: "string", enum: ["error", "warning", "all"] },
				cwd: { type: "string" },
			},
		},
	},
	{
		name: "pilens_latency",
		description:
			"Return recent dispatch latency reports (latency.log schema: per-file " +
			"total duration + per-runner timings). The review-loop measurement surface.",
		inputSchema: {
			type: "object",
			properties: {
				limit: { type: "number", description: "Max reports to return (default 5)." },
				file: { type: "string", description: "Only reports whose path ends with this." },
			},
		},
	},
	{
		name: "pilens_rebuild",
		description:
			"Rebuild pi-lens so subsequent `pilens_analyze mode=fresh` runs reflect " +
			"the latest commit. Runs `npm run build` (in-place dev layout) or " +
			"`npm run build:dist` (precompiled dist layout), matching how this server " +
			"was launched. The missing link that makes the review loop honest: " +
			"commit → pilens_rebuild → pilens_analyze mode=fresh.",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "pilens_project_scan",
		description:
			"Cheap project-wide scan (tree-sitter + fact rules) across source files, " +
			"returning structural/quality diagnostics. Complements pilens_diagnostics " +
			"mode=full (which adds active LSP).",
		inputSchema: {
			type: "object",
			properties: {
				cwd: { type: "string" },
				maxFiles: { type: "number", description: "Cap files scanned." },
			},
		},
	},
	{
		name: "pilens_health",
		description:
			"pi-lens runtime health for THIS server: alive LSP servers, last dispatch " +
			"summary, and session diagnostic counts.",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "pilens_session_start",
		description:
			"Run pi-lens's real session_start lifecycle: warm the dominant-language " +
			"LSP (so subsequent pilens_analyze is LSP-complete), establish the " +
			"error-debt baseline (tests/build pass-state) + complexity baselines, and " +
			"kick off knip/jscpd/type-coverage/dep/secrets project scans. Returns " +
			"project guidance + baseline; scan results land in caches (query via " +
			"pilens_diagnostics afterwards). Run once per workspace before reviewing.",
		inputSchema: {
			type: "object",
			properties: { cwd: { type: "string" } },
		},
	},
	{
		name: "pilens_turn_end",
		description:
			"Run pi-lens's real turn_end lifecycle over the files changed this turn: " +
			"knip dead-code + jscpd duplication (incremental), circular-dep checks, " +
			"tests on affected targets, cascade to dependents, and the actionable/" +
			"code-quality warning aggregation. Returns the turn-end advisory + test " +
			"findings. `files` is OPTIONAL — pilens_analyze (and the PostToolUse hook) " +
			"auto-register edited files into turn-state, so you can call this with no " +
			"args after a series of edits; pass `files` to add any not analyzed.",
		inputSchema: {
			type: "object",
			properties: {
				cwd: { type: "string" },
				files: {
					type: "array",
					items: { type: "string" },
					description:
						"Optional extra files to include (auto-registered ones are already picked up).",
				},
			},
		},
	},
	{
		name: "pilens_ast_grep_search",
		description:
			"Structural (AST) code search via ast-grep — match by code structure, not " +
			"text. Use meta-variables ($X) and AST context (e.g. 'console.log($MSG)', " +
			"'function $NAME() { $$$ }'). Far more precise than grep for code shapes.",
		inputSchema: {
			type: "object",
			properties: {
				pattern: {
					type: "string",
					description: "AST pattern (structural, with $meta-vars), not plain text.",
				},
				lang: { type: "string", description: "Target language (e.g. ts, tsx, py, go, rust)." },
				paths: {
					type: "array",
					items: { type: "string" },
					description: "Files/folders to search (default: whole workspace).",
				},
				context: { type: "number", description: "Lines of context around each match." },
				selector: { type: "string", description: "Restrict to a specific AST node kind." },
				rule: { type: "string", description: "Raw ast-grep YAML rule (full DSL; overrides pattern)." },
				strictness: {
					type: "string",
					enum: ["smart", "relaxed", "ast", "cst", "signature", "template"],
				},
				cwd: { type: "string" },
			},
			required: ["pattern", "lang"],
		},
	},
	{
		name: "pilens_ast_grep_replace",
		description:
			"Structural (AST) find-and-rewrite via ast-grep, e.g. pattern='var $X' " +
			"rewrite='let $X'. DRY-RUN by default (apply=false shows the diff); set " +
			"apply=true to write the changes to disk.",
		inputSchema: {
			type: "object",
			properties: {
				pattern: { type: "string", description: "AST pattern to match." },
				rewrite: { type: "string", description: "Replacement using the pattern's meta-vars ('' to delete)." },
				lang: { type: "string", description: "Target language." },
				paths: {
					type: "array",
					items: { type: "string" },
					description: "Files/folders to rewrite (default: whole workspace).",
				},
				apply: {
					type: "boolean",
					description: "false (default) = dry-run/diff; true = write changes to disk.",
				},
				strictness: {
					type: "string",
					enum: ["smart", "relaxed", "ast", "cst", "signature", "template"],
				},
				cwd: { type: "string" },
			},
			required: ["pattern", "rewrite", "lang"],
		},
	},
] as const;

function formatAnalyze(
	result: McpAnalyzeResult,
	cwd: string,
	mode: "warm" | "fresh",
): { content: { type: "text"; text: string }[] } {
	// Surface the LSP outcome so a cold/indexing server's "0" is never silently
	// read as "clean" — a known limit on large projects (warm mode / re-run once
	// the persistent server has indexed gives complete LSP coverage).
	const lspNote = result.lsp
		? ` · lsp ${result.lsp.diagnosticCount} (${result.lsp.status}, ${result.lsp.durationMs}ms)`
		: "";
	const summary =
		`${path.relative(cwd, result.filePath) || result.filePath} [${mode}] — ` +
		`${result.counts.blockers} blocking, ${result.counts.warnings} warning(s), ` +
		`${result.counts.diagnostics} total` +
		(result.latency ? ` · ${result.latency.totalDurationMs}ms` : "") +
		lspNote +
		(result.counts.fixed > 0 ? ` · ${result.counts.fixed} auto-fixed` : "");
	return toolText(summary, result);
}

async function callTool(
	name: string,
	args: Record<string, unknown>,
): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> {
	if (name === "pilens_analyze") {
		const file = args.file;
		if (typeof file !== "string" || file.length === 0) {
			return { ...toolText("pilens_analyze requires a 'file' string."), isError: true };
		}
		const cwd = typeof args.cwd === "string" ? args.cwd : DEFAULT_CWD;
		const mode = args.mode === "fresh" ? "fresh" : "warm";
		const flags =
			args.flags && typeof args.flags === "object"
				? (args.flags as Record<string, boolean | string | undefined>)
				: undefined;

		if (mode === "fresh") {
			// Honest review loop: a forked worker loads the freshly-built code, so
			// the result reflects the latest commit — not this long-lived server's
			// in-memory image.
			const outcome = await analyzeFileFresh(WORKER_PATH, file, cwd, { flags });
			if (outcome.error || !outcome.result) {
				return {
					...toolText(`fresh analyze failed: ${outcome.error ?? "no result"}`),
					isError: true,
				};
			}
			return formatAnalyze(outcome.result, cwd, "fresh");
		}

		await ensureReady(cwd);
		// Warm = an edit-detection path: register the file so pilens_turn_end picks
		// it up without an explicit file list.
		const result = await analyzeFile(file, cwd, {
			flags,
			registerTurnState: true,
		});
		return formatAnalyze(result, cwd, "warm");
	}

	if (name === "pilens_rebuild") {
		const outcome = await runRebuild(REPO_ROOT, REBUILD_SCRIPT);
		const headline = outcome.ok
			? `✓ rebuild succeeded (npm run ${outcome.script}, ${outcome.durationMs}ms). Fresh analyses now reflect the latest build.`
			: `✗ rebuild FAILED (npm run ${outcome.script}, ${outcome.durationMs}ms).`;
		return {
			...toolText(outcome.ok ? headline : `${headline}\n\n${outcome.output}`, {
				ok: outcome.ok,
				script: outcome.script,
				durationMs: outcome.durationMs,
				repoRoot: REPO_ROOT,
			}),
			isError: !outcome.ok,
		};
	}

	if (name === "pilens_project_scan") {
		const cwd = typeof args.cwd === "string" ? args.cwd : DEFAULT_CWD;
		await ensureReady(cwd);
		const maxFiles =
			typeof args.maxFiles === "number" && Number.isFinite(args.maxFiles)
				? Math.max(1, Math.floor(args.maxFiles))
				: undefined;
		const snapshot = await scanProjectDiagnostics({ cwd, tier: "cheap", maxFiles });
		const { deduped, byRule, byFile } = summarizeScan(snapshot.diagnostics);
		const topRules = Object.entries(byRule).sort((a, b) => b[1] - a[1]);
		const topFiles = Object.entries(byFile)
			.sort((a, b) => b[1] - a[1])
			.slice(0, 15)
			.map(([file, count]) => ({ file: path.relative(cwd, file), count }));
		const summaryLines = [
			`Scanned ${snapshot.filesScanned} file(s) [${snapshot.runners.join(", ")}] → ` +
				`${deduped.length} unique diagnostic(s)` +
				(snapshot.diagnostics.length !== deduped.length
					? ` (${snapshot.diagnostics.length} raw, ${snapshot.diagnostics.length - deduped.length} duplicate)`
					: ""),
			...topRules.slice(0, 12).map(([rule, count]) => `  ${count}× ${rule}`),
		];
		return toolText(summaryLines.join("\n"), {
			filesScanned: snapshot.filesScanned,
			runners: snapshot.runners,
			uniqueDiagnostics: deduped.length,
			rawDiagnostics: snapshot.diagnostics.length,
			byRule,
			topFiles,
			sample: deduped.slice(0, 40),
		});
	}

	if (name === "pilens_health") {
		const lsp = getLSPService();
		const servers = lsp.getStatus();
		const reports = getLatencyReports();
		const last = reports[reports.length - 1];
		const stats = getDiagnosticTracker().getStats();
		const lines = [
			`LSP: ${lsp.getAliveClientCount()} alive client(s)`,
			...servers.map(
				(server) =>
					`  ${server.connected ? "✓" : "✗"} ${server.serverId} (${server.root})`,
			),
			last
				? `Last dispatch: ${path.basename(last.filePath)} — ${last.totalDurationMs}ms, ${last.totalDiagnostics} diagnostic(s)`
				: "Last dispatch: none yet",
			`Diagnostics this session: ${stats.totalShown} shown · ${stats.totalAutoFixed} auto-fixed · ${stats.totalUnresolved} unresolved`,
		];
		return toolText(lines.join("\n"), {
			aliveClients: lsp.getAliveClientCount(),
			servers,
			lastDispatch: last
				? {
						filePath: last.filePath,
						totalDurationMs: last.totalDurationMs,
						totalDiagnostics: last.totalDiagnostics,
					}
				: undefined,
			diagnostics: {
				shown: stats.totalShown,
				autoFixed: stats.totalAutoFixed,
				unresolved: stats.totalUnresolved,
			},
		});
	}

	if (name === "pilens_diagnostics") {
		const cwd = typeof args.cwd === "string" ? args.cwd : DEFAULT_CWD;
		await ensureReady(cwd);
		const out = (await lensDiagnosticsTool.execute(
			"mcp",
			args,
			new AbortController().signal,
			undefined,
			{ cwd },
		)) as { content: { type: "text"; text: string }[] };
		return { content: out.content };
	}

	if (name === "pilens_latency") {
		const limit =
			typeof args.limit === "number" && Number.isFinite(args.limit)
				? Math.max(1, Math.floor(args.limit))
				: 5;
		const fileFilter = typeof args.file === "string" ? args.file : undefined;
		let reports = getLatencyReports();
		if (fileFilter) {
			reports = reports.filter((report) =>
				report.filePath.replace(/\\/g, "/").endsWith(fileFilter.replace(/\\/g, "/")),
			);
		}
		const recent = reports.slice(-limit).reverse();
		const summary =
			recent.length === 0
				? "No dispatch latency reports yet."
				: recent
						.map(
							(report) =>
								`${path.basename(report.filePath)}: ${report.totalDurationMs}ms ` +
								`(${report.totalDiagnostics} diag${report.stoppedEarly ? ", stopped early" : ""})`,
						)
						.join("\n");
		return toolText(summary, recent);
	}

	if (name === "pilens_session_start") {
		const cwd = typeof args.cwd === "string" ? args.cwd : DEFAULT_CWD;
		await ensureReady(cwd);
		const outcome = await runSessionStart(cwd);
		const lines = [
			`Session started for ${cwd}.`,
			`LSP: ${outcome.aliveLspClients} alive client(s) (warming continues in background).`,
			outcome.errorDebtBaseline
				? `Error-debt baseline: tests ${outcome.errorDebtBaseline.testsPassed ? "pass" : "FAIL"}, build ${outcome.errorDebtBaseline.buildPassed ? "pass" : "FAIL"}.`
				: "Error-debt baseline: computing in background.",
			"knip/jscpd/type-coverage/dep scans run in background — query pilens_diagnostics shortly.",
			outcome.guidance ? `\n${outcome.guidance}` : "",
		];
		return toolText(lines.filter(Boolean).join("\n"), outcome);
	}

	if (name === "pilens_turn_end") {
		const cwd = typeof args.cwd === "string" ? args.cwd : DEFAULT_CWD;
		await ensureReady(cwd);
		const files = Array.isArray(args.files)
			? args.files.filter((file): file is string => typeof file === "string")
			: [];
		const outcome = await runTurnEnd(cwd, files);
		const parts = [
			`Turn-end over ${outcome.filesRegistered} file(s).`,
			outcome.turnEnd ?? "No turn-end advisory.",
			outcome.tests ? `\nTests:\n${outcome.tests}` : "",
		];
		return toolText(parts.filter(Boolean).join("\n"), outcome);
	}

	if (name === "pilens_ast_grep_search" || name === "pilens_ast_grep_replace") {
		const cwd = typeof args.cwd === "string" ? args.cwd : DEFAULT_CWD;
		const tool =
			name === "pilens_ast_grep_search" ? astGrepSearchTool : astGrepReplaceTool;
		const out = (await tool.execute(
			"mcp",
			args,
			new AbortController().signal,
			undefined,
			{ cwd },
		)) as { content: { type: "text"; text: string }[] };
		return { content: out.content };
	}

	return { ...toolText(`Unknown tool: ${name}`), isError: true };
}

// --- Method dispatch ---------------------------------------------------------

async function handleRequest(request: JsonRpcRequest): Promise<void> {
	const { id, method, params } = request;
	const isNotification = id === undefined;

	switch (method) {
		case "initialize": {
			const requested = params?.protocolVersion;
			sendResult(id ?? null, {
				protocolVersion:
					typeof requested === "string" ? requested : FALLBACK_PROTOCOL_VERSION,
				capabilities: { tools: {} },
				serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
			});
			maybeAutoSessionStart();
			return;
		}
		case "notifications/initialized":
		case "initialized":
			return; // notification — no response
		case "ping":
			if (!isNotification) sendResult(id ?? null, {});
			return;
		case "tools/list":
			sendResult(id ?? null, { tools: TOOLS });
			return;
		case "tools/call": {
			const name = params?.name;
			const args =
				params?.arguments && typeof params.arguments === "object"
					? (params.arguments as Record<string, unknown>)
					: {};
			if (typeof name !== "string") {
				sendError(id ?? null, -32602, "tools/call requires a string 'name'");
				return;
			}
			try {
				const result = await callTool(name, args);
				sendResult(id ?? null, result);
			} catch (err) {
				// Surface as a tool error (isError), not a transport error, so the
				// agent sees the message instead of a dead request.
				sendResult(id ?? null, {
					...toolText(`pi-lens tool '${name}' failed: ${(err as Error).message}`),
					isError: true,
				});
			}
			return;
		}
		default:
			if (!isNotification) sendError(id ?? null, -32601, `Method not found: ${method}`);
			return;
	}
}

// --- stdio read loop (newline-delimited JSON) --------------------------------

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
	buffer += chunk;
	let newlineIndex = buffer.indexOf("\n");
	while (newlineIndex !== -1) {
		const line = buffer.slice(0, newlineIndex).trim();
		buffer = buffer.slice(newlineIndex + 1);
		if (line.length > 0) {
			let request: JsonRpcRequest | undefined;
			try {
				request = JSON.parse(line) as JsonRpcRequest;
			} catch {
				sendError(null, -32700, "Parse error");
			}
			if (request) void handleRequest(request);
		}
		newlineIndex = buffer.indexOf("\n");
	}
});
process.stdin.on("end", () => process.exit(0));

console.error(`[pi-lens-mcp] ready (cwd=${DEFAULT_CWD})`);
