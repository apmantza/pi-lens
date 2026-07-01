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
import * as net from "node:net";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { AstGrepClient } from "../clients/ast-grep-client.js";
import { CacheManager } from "../clients/cache-manager.js";
import {
	analyzeFile,
	analyzeFileFresh,
	createMcpHost,
	diagnosticStats,
	ensureLspConfig,
	ipcPathForCwd,
	lspStatus,
	type McpAnalyzeResult,
	moduleReport,
	projectScan,
	readSymbol,
	recentLatency,
	resolveRebuildScript,
	runRebuild,
	runSessionStart,
	runTurnEnd,
	summarizeScan,
	symbolSearch,
	type WarmAnalyzeRequest,
} from "../clients/lens-engine.js";
import { createAstGrepReplaceTool } from "../tools/ast-grep-replace.js";
import { createAstGrepSearchTool } from "../tools/ast-grep-search.js";
import { createLensDiagnosticsTool } from "../tools/lens-diagnostics.js";
import { createLspDiagnosticsTool } from "../tools/lsp-diagnostics.js";
import { createLspNavigationTool } from "../tools/lsp-navigation.js";

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
		await ensureLspConfig(normalized);
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

// --- Warm side-channel (server side) ----------------------------------------
// A local IPC endpoint the PostToolUse-hook bin connects to, so inline feedback
// runs in THIS warm process (LSP-complete) instead of a cold hook process.
// Responses go over the socket — never stdout — so the MCP stream is untouched.

const IPC_PATH = ipcPathForCwd(DEFAULT_CWD);

function startIpcServer(): void {
	// POSIX: a stale socket file blocks listen; remove it first. (Named pipes on
	// Windows don't need this.)
	if (process.platform !== "win32") {
		try {
			fs.unlinkSync(IPC_PATH);
		} catch {
			// no stale socket — fine
		}
	}

	const ipc = net.createServer((socket) => {
		socket.setEncoding("utf8");
		let buffer = "";
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			const newline = buffer.indexOf("\n");
			if (newline === -1) return;
			const line = buffer.slice(0, newline);
			void (async () => {
				try {
					const req = JSON.parse(line) as WarmAnalyzeRequest;
					console.error(`[pi-lens-mcp] warm analyze: ${req.file}`);
					// Warm = full LSP + an edit-detection path (register turn-state).
					const result = await analyzeFile(req.file, req.cwd, {
						registerTurnState: true,
					});
					socket.end(`${JSON.stringify({ result })}\n`);
				} catch (err) {
					socket.end(`${JSON.stringify({ error: String(err) })}\n`);
				}
			})();
		});
		socket.on("error", () => socket.destroy());
	});

	ipc.on("error", (err) => {
		// Listener failure must not take down the MCP server — warm channel is an
		// optimization; the hook falls back to cold analysis.
		console.error(`[pi-lens-mcp] IPC listener unavailable: ${err}`);
	});

	ipc.listen(IPC_PATH, () => {
		console.error(`[pi-lens-mcp] warm side-channel listening at ${IPC_PATH}`);
	});

	const cleanup = () => {
		try {
			ipc.close();
		} catch {
			// ignore
		}
		if (process.platform !== "win32") {
			try {
				fs.unlinkSync(IPC_PATH);
			} catch {
				// ignore
			}
		}
	};
	process.on("exit", cleanup);
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
const lspNavigationTool = createLspNavigationTool(createMcpHost().getFlag);
const lspDiagnosticsTool = createLspDiagnosticsTool();

// Wrapped pi tools already declare their params as typebox (which IS JSON
// Schema). Emit that directly as the MCP inputSchema (+ the MCP-only `cwd`)
// instead of hand-restating it — no drift between the tool and its schema.
function schemaWithCwd(parameters: unknown): Record<string, unknown> {
	const p = parameters as {
		properties?: Record<string, unknown>;
		required?: string[];
	};
	return {
		type: "object",
		properties: {
			...(p.properties ?? {}),
			cwd: {
				type: "string",
				description: "Project root (defaults to the server workspace).",
			},
		},
		...(p.required ? { required: p.required } : {}),
	};
}

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
		inputSchema: schemaWithCwd(lensDiagnosticsTool.parameters),
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
		name: "pilens_symbol_search",
		description:
			"Ranked identifier search over the persisted word index (BM25 + priors " +
			"that demote tests/vendor and doc files). Answers 'which files are most " +
			"relevant to <query>' by identifier — complements grep (raw substrings) " +
			"and LSP (exact symbols). Requires pilens_session_start to have built the " +
			"index for this workspace.",
		inputSchema: {
			type: "object",
			properties: {
				query: {
					type: "string",
					description: "Identifier-ish query, e.g. 'authenticate user'.",
				},
				cwd: { type: "string" },
				limit: {
					type: "number",
					description: "Max files to return (default 20).",
				},
			},
			required: ["query"],
		},
	},
	{
		name: "pilens_module_report",
		description:
			"Structured, navigable overview of a source module — a token-efficient " +
			"substitute for reading the whole file. Returns each symbol's " +
			"name/kind/signature/line-range with ready-to-use `read` args, plus " +
			"who-uses-this, risk flags, and ranked recommendedReads. Prefer this before " +
			"a full read; then use pilens_read_symbol for the exact body. Single mode: " +
			"tree-sitter outline + review-graph who-uses-this + bounded live-LSP " +
			"enrichment (exact references/implementations for exported symbols, " +
			"time-boxed, degrades to graph-only when no LSP server is available). " +
			"`semantic.source` reports whether LSP data was used. Pass " +
			"`blastRadius: true` for the cross-file blast radius (transitive dependents " +
			"as ranked file reads, read-only over the cached graph). An outline shows " +
			"shape, not bodies.",
		inputSchema: {
			type: "object",
			properties: {
				file: {
					type: "string",
					description: "File to report on (absolute or relative to cwd).",
				},
				cwd: { type: "string" },
				maxRefsPerSymbol: {
					type: "number",
					description: "Cap who-uses-this entries per symbol (default 10).",
				},
				blastRadius: {
					type: "boolean",
					description:
						"Include the cross-file blast radius: transitive dependents aggregated to ranked file reads. Read-only over the cached graph (omitted when cold).",
				},
				blastRadiusDepth: {
					type: "number",
					description:
						"Max hops for the blast-radius walk (default 3). Only used with blastRadius.",
				},
			},
			required: ["file"],
		},
	},
	{
		name: "pilens_read_symbol",
		description:
			"Return the verbatim source of a single named symbol " +
			"(function/class/method/interface/type) in a file — a targeted, cheap " +
			"alternative to reading the whole file. Pair with pilens_module_report: it " +
			"finds the symbol, this shows its body.",
		inputSchema: {
			type: "object",
			properties: {
				file: { type: "string", description: "File containing the symbol." },
				symbol: { type: "string", description: "Exact symbol name to read." },
				cwd: { type: "string" },
			},
			required: ["file", "symbol"],
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
		inputSchema: schemaWithCwd(astGrepSearchTool.parameters),
	},
	{
		name: "pilens_ast_grep_replace",
		description:
			"Structural (AST) find-and-rewrite via ast-grep, e.g. pattern='var $X' " +
			"rewrite='let $X'. DRY-RUN by default (apply=false shows the diff); set " +
			"apply=true to write the changes to disk.",
		inputSchema: schemaWithCwd(astGrepReplaceTool.parameters),
	},
	{
		name: "pilens_lsp_navigation",
		description:
			"LSP code navigation: definition, typeDefinition, declaration, " +
			"references, hover, documentSymbol, " +
			"workspaceSymbol, implementation, call hierarchy (prepareCallHierarchy/" +
			"incomingCalls/outgoingCalls), rename, codeAction, executeCommand " +
			"(allowlisted, dry-run by default) — exact + type-aware, " +
			"~50ms. Use before changing a signature to see every caller.",
		inputSchema: schemaWithCwd(lspNavigationTool.parameters),
	},
	{
		name: "pilens_lsp_diagnostics",
		description:
			"Pure LSP diagnostics for a file, directory, or batch of files (type " +
			"errors only — narrower than pilens_diagnostics, which spans all runners).",
		inputSchema: schemaWithCwd(lspDiagnosticsTool.parameters),
	},
];

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
		const runCmd = `${outcome.packageManager} run ${outcome.script}`;
		const headline = outcome.ok
			? `✓ rebuild succeeded (${runCmd}, ${outcome.durationMs}ms). Fresh analyses now reflect the latest build.`
			: `✗ rebuild FAILED (${runCmd}, ${outcome.durationMs}ms).`;
		return {
			...toolText(outcome.ok ? headline : `${headline}\n\n${outcome.output}`, {
				ok: outcome.ok,
				script: outcome.script,
				packageManager: outcome.packageManager,
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
		const snapshot = await projectScan(cwd, maxFiles);
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

	if (name === "pilens_symbol_search") {
		const query = typeof args.query === "string" ? args.query : "";
		if (!query.trim()) return toolText("Provide a non-empty `query`.");
		const cwd = typeof args.cwd === "string" ? args.cwd : DEFAULT_CWD;
		const limit =
			typeof args.limit === "number" && Number.isFinite(args.limit)
				? Math.max(1, Math.floor(args.limit))
				: 20;
		const { available, results } = symbolSearch(query, cwd, limit);
		if (!available) {
			return toolText(
				"No word index for this workspace yet — run pilens_session_start first.",
				{ available: false, query },
			);
		}
		if (results.length === 0) {
			return toolText(`No files matched "${query}".`, {
				available: true,
				query,
				results: [],
			});
		}
		const lines = [
			`Top ${results.length} file(s) for "${query}":`,
			...results.map(
				(result, i) =>
					`  ${i + 1}. ${path.relative(cwd, result.file)} ` +
					`(score ${result.score.toFixed(2)}, ${result.hits} hit(s), lines ` +
					`${result.lines.slice(0, 5).join(", ")}${result.lines.length > 5 ? "…" : ""})`,
			),
		];
		return toolText(lines.join("\n"), {
			query,
			results: results.map((result) => ({
				file: path.relative(cwd, result.file),
				score: result.score,
				hits: result.hits,
				lines: result.lines,
			})),
		});
	}


	if (name === "pilens_module_report") {
		const file = typeof args.file === "string" ? args.file : "";
		if (!file.trim()) return { ...toolText("Provide a `file`."), isError: true };
		const cwd = typeof args.cwd === "string" ? args.cwd : DEFAULT_CWD;
		const maxRefsPerSymbol =
			typeof args.maxRefsPerSymbol === "number" &&
			Number.isFinite(args.maxRefsPerSymbol)
				? Math.max(1, Math.floor(args.maxRefsPerSymbol))
				: undefined;
		const blastRadius = args.blastRadius === true;
		const blastRadiusDepth =
			typeof args.blastRadiusDepth === "number" &&
			Number.isFinite(args.blastRadiusDepth)
				? Math.max(1, Math.floor(args.blastRadiusDepth))
				: undefined;
		const report = await moduleReport(file, cwd, {
			maxRefsPerSymbol,
			blastRadius,
			blastRadiusDepth,
		});
		if (!report.available) {
			return {
				...toolText(
					`No module report for ${path.relative(cwd, path.resolve(cwd, file))} — not a symbol-bearing file, or unreadable.`,
					report,
				),
				isError: true,
			};
		}
		const summary =
			`${path.relative(cwd, report.path) || report.path} [${report.staleness}] — ` +
			`${report.summary.symbols} symbol(s), ${report.summary.exports} exported, ` +
			`${report.api.length} in public API`;
		return toolText(summary, report);
	}

	if (name === "pilens_read_symbol") {
		const file = typeof args.file === "string" ? args.file : "";
		const symbol = typeof args.symbol === "string" ? args.symbol : "";
		if (!file.trim() || !symbol.trim()) {
			return { ...toolText("Provide `file` and `symbol`."), isError: true };
		}
		const cwd = typeof args.cwd === "string" ? args.cwd : DEFAULT_CWD;
		const result = await readSymbol(file, symbol, cwd);
		if (!result.found) {
			return {
				...toolText(
					`Symbol "${symbol}" not found in ${path.basename(file)}. Use pilens_module_report to list symbols.`,
					{ found: false },
				),
				isError: true,
			};
		}
		const header = `${result.kind} ${result.name}  ${path.relative(cwd, result.path)}:${result.startLine}-${result.endLine}`;
		return toolText(`${header}\n\n${result.source ?? ""}`, {
			name: result.name,
			kind: result.kind,
			startLine: result.startLine,
			endLine: result.endLine,
			signature: result.signature,
		});
	}

	if (name === "pilens_health") {
		const { aliveClients, servers } = lspStatus();
		const last = recentLatency(1)[0];
		const stats = diagnosticStats();
		const lines = [
			`LSP: ${aliveClients} alive client(s)`,
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
			aliveClients,
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
		const recent = recentLatency(limit, fileFilter);
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

	if (name === "pilens_lsp_navigation" || name === "pilens_lsp_diagnostics") {
		const cwd = typeof args.cwd === "string" ? args.cwd : DEFAULT_CWD;
		await ensureReady(cwd);
		const tool =
			name === "pilens_lsp_navigation" ? lspNavigationTool : lspDiagnosticsTool;
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

startIpcServer();
console.error(`[pi-lens-mcp] ready (cwd=${DEFAULT_CWD})`);
