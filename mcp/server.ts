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
	computeBuildStamp,
	STALE_SERVED_BY_FRESH,
	STALE_WARN_ONLY,
	StalenessGate,
	stalenessCheckEnabled,
} from "./build-staleness.js";
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
	readEnclosing,
	readSymbol,
	recentLatency,
	renderCompactModuleReport,
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

// --- Warm build-staleness guard (#535) ---------------------------------------
//
// Captured ONCE at process start: this server's OWN entry file's mtime. A
// rebuild (`npm run build:dist`) or a `git merge`/checkout that lands new
// code changes SERVER_FILE's mtime on disk, but this already-running process
// keeps the old code loaded in memory — the exact "stale-warm-server" trap
// #535 documents (a post-#517 rebuild still answering with the pre-#517
// schema). `computeBuildStamp` returns undefined when SERVER_FILE can't be
// stat'd (e.g. an unusual packaging layout); the gate then degrades to
// "never stale" rather than false-flagging every call.
//
// `PI_LENS_MCP_STALENESS_STAT_PATH` (test-only override): points the stamp at
// a different file than SERVER_FILE. Exists so a staleness smoke test can
// simulate a rebuild by bumping ONE isolated file's mtime, instead of mutating
// the real `mcp/server.js` on disk — a shared file every OTHER concurrently-
// spawned server process in the same test run also stats against, which would
// otherwise make the staleness smoke test flip unrelated tests' expectations
// under parallel vitest execution.
const STALENESS_STAT_PATH =
	process.env.PI_LENS_MCP_STALENESS_STAT_PATH ?? SERVER_FILE;
const BUILD_STAMP = computeBuildStamp(STALENESS_STAT_PATH);
const STALENESS_GATE = new StalenessGate(BUILD_STAMP);

/**
 * True when the warm server's loaded code is older than what's on disk right
 * now. Mtime-gated (at most one `fs.stat` per second, like the #492
 * cross-process reader) so a burst of tool calls costs one stat, not one per
 * call. Disabled entirely by `PI_LENS_WARM_STALENESS_CHECK=0` (escape hatch).
 */
function isWarmBuildStale(): boolean {
	if (!stalenessCheckEnabled()) return false;
	return STALENESS_GATE.isStale();
}

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
					// #535: the PostToolUse hook bin (mcp/analyze-cli.ts) already treats
					// ANY error response as "no usable warm server" and falls back to
					// its own cold, load-fresh-from-disk analysis path — so on a stale
					// warm build, replying with an error IS the fresh-fork behavior for
					// this channel, for free. No separate fresh-fork plumbing needed
					// here: the client-side fallback already loads current code.
					if (isWarmBuildStale()) {
						console.error(
							"[pi-lens-mcp] warm analyze: build stale, replying error so the hook falls back cold",
						);
						socket.end(
							`${JSON.stringify({ error: "warm build stale — falling back to cold analysis" })}\n`,
						);
						return;
					}
					const req = JSON.parse(line) as WarmAnalyzeRequest;
					console.error(`[pi-lens-mcp] warm analyze: ${req.file}`);
					// Warm = full LSP + an edit-detection path (register turn-state) +
					// review-graph maintenance (#536 — this is an in-process, long-lived
					// path, unlike the ephemeral `fresh` worker).
					const result = await analyzeFile(req.file, req.cwd, {
						registerTurnState: true,
						updateGraph: true,
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

/**
 * A tool result: human-readable text first, full JSON appended for the agent.
 * `compact` omits indentation (#512) — for token-efficient tools like
 * module_report the ~30% saved on the wire is worth losing pretty-printing
 * for a payload the agent parses, not reads formatted.
 */
function toolText(
	summary: string,
	structured?: unknown,
	compact = false,
): { content: { type: "text"; text: string }[] } {
	const text =
		structured === undefined
			? summary
			: `${summary}\n\n\`\`\`json\n${JSON.stringify(structured, compact ? undefined : null, compact ? undefined : 2)}\n\`\`\``;
	return { content: [{ type: "text" as const, text }] };
}

// --- Graph-staleness signal (#536) -------------------------------------------
//
// Extends #514's honesty-warning shape from "missing node" (module_report's
// existing `usedBy`-unavailable warning, #511) to "aging graph": when graph
// data IS present, a caller still can't tell whether it's fresh or stale
// without this. MCP-only per #536's decision — pi's graph is maintained
// per-edit (warm), so the same line there would be pure noise.

/** Below this age, no staleness note is added — a graph this fresh is never
 * worth flagging even if the workspace has had zero pilens_analyze calls yet. */
const GRAPH_STALENESS_THRESHOLD_MS = 10 * 60_000; // 10 minutes

function formatRelativeAge(ms: number): string {
	if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
	if (ms < 60 * 60_000) return `${Math.round(ms / 60_000)}m ago`;
	if (ms < 24 * 60 * 60_000) return `${Math.round(ms / (60 * 60_000))}h ago`;
	return `${Math.round(ms / (24 * 60 * 60_000))}d ago`;
}

/**
 * Builds a staleness note for a graph-derived MCP result when its persisted
 * timestamp is older than the threshold. Returns undefined when the timestamp
 * is missing/unparseable (no graph consulted — the existing #511 "no node"
 * warning already covers that case) or fresh enough not to flag.
 */
function graphStalenessNote(
	builtAtIso: string | undefined,
	label: string,
): string | undefined {
	if (!builtAtIso) return undefined;
	const builtAtMs = Date.parse(builtAtIso);
	if (!Number.isFinite(builtAtMs)) return undefined;
	const ageMs = Date.now() - builtAtMs;
	if (ageMs < GRAPH_STALENESS_THRESHOLD_MS) return undefined;
	return (
		`${label} last updated ${formatRelativeAge(ageMs)}; run pilens_analyze ` +
		"on recently-changed files, pilens_session_start, or pilens_rebuild to refresh it."
	);
}

// --- Tools -------------------------------------------------------------------

const cacheManager = new CacheManager();
// #536: investigated wiring the same `flushPending` 4th arg pi's index.ts passes
// (() => flushDebouncedToolResults()) before reading pilens_diagnostics. Verdict:
// genuinely not applicable here, not just unwired. `flushDebouncedToolResults`
// (clients/runtime-tool-result.ts) drains a module-level `debouncedPipelines` map
// that ONLY `handleToolResult` populates — pi's tool_result event handler, which
// this MCP process never calls (pilens_analyze routes through the independent
// clients/mcp/analyze.ts facade, calling dispatchLintWithResult directly, never
// handleToolResult). So that map is provably always empty in this process; a call
// to flushDebouncedToolResults() here would resolve immediately having flushed
// nothing — a no-op dressed as a fix, not a real parity gap. The 4th arg is left
// at its default (`async () => {}`, already a no-op) rather than importing and
// wiring a flush with nothing to flush.
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
			"relevant to <query>' by identifier — first step of the discovery funnel: " +
			"symbol_search finds candidate files, pilens_module_report explains one, " +
			"pilens_read_symbol reads a body. Complements grep (raw substrings) and " +
			"LSP (exact symbols). Each hit's `startLine`/`endLine` mark its best-matching " +
			"line (offset=startLine, limit=endLine-startLine+1 for a one-line peek) — " +
			"use pilens_module_report on `file` for the real outline. Returns " +
			"`available: false` with a retry hint if the index isn't built yet for this " +
			"workspace (pilens_session_start builds it, or it self-builds in the background " +
			"on first query).",
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
			"name/kind/signature/line-range (plus a first-line `doc` summary when a " +
			"doc comment is attached), plus who-uses-this, risk flags, and ranked " +
			"recommendedReads. To read a symbol's body: call pilens_read_symbol (or " +
			"read) with offset=startLine, limit=endLine-startLine+1 on THIS report's " +
			"`file` — those aren't repeated per symbol. Prefer this before a full " +
			"read; then use pilens_read_symbol for the exact body. Single mode: " +
			"tree-sitter outline + review-graph who-uses-this + inline executable " +
			"extraction; degrades to outline-only when no cached graph is available " +
			"(this path never calls LSP). `semantic.source` reports whether graph " +
			"data was used. Pass `blastRadius: true` for the cross-file blast radius " +
			"(transitive dependents as ranked file reads, read-only over the cached " +
			'graph). `view: "compact"` returns a line-oriented text rendering ' +
			"(cheapest option) instead of JSON. An outline shows shape, not bodies.",
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
				focus: {
					type: "string",
					description:
						"Optional task hint used only to rank recommendedReads (does not expand scope or trigger scans).",
				},
				view: {
					type: "string",
					enum: ["summary", "default", "compact"],
					description:
						"Payload tier. summary returns top-level entries/recommendedReads with heavy callback/usedBy/blast-radius payloads omitted. compact (cheapest) returns a line-oriented TEXT rendering of the full report instead of JSON.",
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
		name: "pilens_read_enclosing",
		description:
			"Return the verbatim source for the smallest useful symbol/callback " +
			"enclosing a line in a file. Use after pilens_ast_grep_search, " +
			"pilens_diagnostics, or pilens_lsp_navigation locations when you need " +
			"exact body text without reading the whole file. Uses tree-sitter only — " +
			"no LSP or graph build. MCP has no read-guard, so unlike the pi tool this " +
			"does not record edit-coverage.",
		inputSchema: {
			type: "object",
			properties: {
				file: {
					type: "string",
					description: "Absolute or workspace-relative path to the source file.",
				},
				line: {
					type: "number",
					description: "1-based line number inside the desired symbol/callback.",
				},
				cwd: { type: "string" },
				kinds: {
					type: "array",
					items: { type: "string" },
					description:
						"Optional kind filter, e.g. function, method, callback, class.",
				},
				maxLines: {
					type: "number",
					description:
						"Optional maximum body size to return. Oversized matches obey onOversize.",
				},
				onOversize: {
					type: "string",
					enum: ["error", "slice", "outline"],
					description:
						"Behavior when the enclosing body exceeds maxLines. error (default) returns metadata only; slice returns a bounded partial read around line; outline returns nested symbols/callbacks with read handles.",
				},
				aroundLine: {
					type: "number",
					description:
						"Maximum lines for onOversize=slice; defaults to maxLines, then 80.",
				},
			},
			required: ["file", "line"],
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
	servedBy?: string,
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
		(result.counts.fixed > 0 ? ` · ${result.counts.fixed} auto-fixed` : "") +
		(servedBy ? `\n\nservedBy: ${servedBy}` : "");
	return toolText(summary, servedBy ? { ...result, servedBy } : result);
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
		const requestedMode = args.mode === "fresh" ? "fresh" : "warm";
		const flags =
			args.flags && typeof args.flags === "object"
				? (args.flags as Record<string, boolean | string | undefined>)
				: undefined;

		// #535: analyze is fresh-routable — it's a stateless per-file dispatch
		// with no dependency on warm-process-only state (unlike module_report's
		// review graph or the warm LSP fleet). So a stale warm build force-routes
		// to fresh even when the caller asked for warm: analyze's whole value is
		// its diagnostics being CORRECT, and warm-only side effects (turn-state
		// registration, graph update) are worth losing for one call rather than
		// silently answering with old dispatch logic.
		const forcedFresh = requestedMode === "warm" && isWarmBuildStale();
		const mode = requestedMode === "fresh" || forcedFresh ? "fresh" : "warm";

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
			return formatAnalyze(
				outcome.result,
				cwd,
				"fresh",
				forcedFresh ? STALE_SERVED_BY_FRESH : undefined,
			);
		}

		await ensureReady(cwd);
		// Warm = an edit-detection path: register the file so pilens_turn_end picks
		// it up without an explicit file list, and maintain the review graph
		// (#536) so pilens_module_report/pilens_symbol_search reflect files
		// analyzed via MCP, not just session-start state. `fresh` (above) stays
		// read-only — it's an ephemeral forked worker.
		const result = await analyzeFile(file, cwd, {
			flags,
			registerTurnState: true,
			updateGraph: true,
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
		const { available, results, hint, snapshotGeneratedAt } = symbolSearch(
			query,
			cwd,
			limit,
		);
		if (!available) {
			return toolText(
				hint ?? "No word index for this workspace yet — run pilens_session_start first.",
				{ available: false, query, hint },
				true,
			);
		}
		const stalenessNote = graphStalenessNote(snapshotGeneratedAt, "Project snapshot");
		if (results.length === 0) {
			return toolText(
				`No files matched "${query}".` + (stalenessNote ? `\n\n${stalenessNote}` : ""),
				{
					available: true,
					query,
					results: [],
					...(stalenessNote ? { staleness: stalenessNote } : {}),
				},
				true,
			);
		}
		const lines = [
			`Top ${results.length} file(s) for "${query}":`,
			...results.map(
				(result, i) =>
					`  ${i + 1}. ${path.relative(cwd, result.file)} ` +
					`(score ${result.score.toFixed(2)}, ${result.hits} hit(s), ` +
					`line ${result.startLine})`,
			),
			...(stalenessNote ? ["", stalenessNote] : []),
		];
		// Compact (unindented) JSON — matches the module_report / read_symbol
		// convention (#517): an agent parses this payload, it doesn't read it
		// formatted. Path is relative-to-cwd once per hit, no repeated per-hit
		// `read` block — startLine/endLine already derive offset/limit.
		return toolText(
			lines.join("\n"),
			{
				query,
				results: results.map((result) => ({
					file: path.relative(cwd, result.file),
					score: result.score,
					hits: result.hits,
					startLine: result.startLine,
					endLine: result.endLine,
				})),
				...(stalenessNote ? { staleness: stalenessNote } : {}),
			},
			true,
		);
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
		const view =
			args.view === "summary" || args.view === "compact" ? args.view : undefined;
		const focus = typeof args.focus === "string" ? args.focus : undefined;
		const report = await moduleReport(file, cwd, {
			maxRefsPerSymbol,
			blastRadius,
			blastRadiusDepth,
			view,
			focus,
		});
		if (!report.available) {
			return {
				...toolText(
					`No module report for ${path.relative(cwd, path.resolve(cwd, file))} — not a symbol-bearing file, or unreadable.`,
					report,
					true,
				),
				isError: true,
			};
		}
		const graphStaleness = graphStalenessNote(report.graphBuiltAt, "Review graph");
		const summary =
			`${path.relative(cwd, report.path) || report.path} [${report.staleness}] — ` +
			`${report.summary.symbols} symbol(s), ${report.summary.exports} exported, ` +
			`${report.api.length} in public API` +
			(graphStaleness ? `\n\n${graphStaleness}` : "");
		if (view === "compact") {
			const compactText = renderCompactModuleReport(report);
			return {
				content: [
					{
						type: "text" as const,
						text: graphStaleness ? `${compactText}\n\n${graphStaleness}` : compactText,
					},
				],
			};
		}
		// Compact (unindented) JSON — matches the pi tool's mirror (#512); an
		// agent parses this payload, it doesn't read it formatted.
		return toolText(
			summary,
			graphStaleness ? { ...report, graphStalenessNote: graphStaleness } : report,
			true,
		);
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
		// Header line already states kind/name/path/range; a trailing JSON block
		// restating those same fields is redundant on the wire (#512) — only
		// `signature` was ever new, so fold it into the header text instead.
		const sigSuffix = result.signature ? `  ${result.signature}` : "";
		const header = `${result.kind} ${result.name}${sigSuffix}  ${path.relative(cwd, result.path)}:${result.startLine}-${result.endLine}`;
		return { content: [{ type: "text" as const, text: `${header}\n\n${result.source ?? ""}` }] };
	}

	if (name === "pilens_read_enclosing") {
		const file = typeof args.file === "string" ? args.file : "";
		const line = typeof args.line === "number" ? args.line : Number.NaN;
		if (!file.trim() || !Number.isFinite(line)) {
			return { ...toolText("Provide `file` and a numeric `line`."), isError: true };
		}
		const cwd = typeof args.cwd === "string" ? args.cwd : DEFAULT_CWD;
		const kinds = Array.isArray(args.kinds)
			? args.kinds.filter((k): k is string => typeof k === "string")
			: undefined;
		const maxLines =
			typeof args.maxLines === "number" && Number.isFinite(args.maxLines)
				? Math.max(1, Math.floor(args.maxLines))
				: undefined;
		const onOversize =
			args.onOversize === "error" ||
			args.onOversize === "slice" ||
			args.onOversize === "outline"
				? args.onOversize
				: undefined;
		const aroundLine =
			typeof args.aroundLine === "number" && Number.isFinite(args.aroundLine)
				? Math.max(1, Math.floor(args.aroundLine))
				: undefined;
		const result = await readEnclosing(file, line, cwd, {
			kinds,
			maxLines,
			onOversize,
			aroundLine,
		});
		if (!result.found) {
			const warningSuffix = result.warnings?.length
				? ` Warnings: ${result.warnings.join("; ")}`
				: "";
			const outlineSuffix = result.outline?.length
				? `\n\nNested outline:\n${JSON.stringify(result.outline)}`
				: "";
			const text = result.error
				? `Could not read enclosing range in ${path.basename(file)}:${result.line}: ${result.error}${warningSuffix}${outlineSuffix}`
				: `No enclosing symbol/callback found in ${path.basename(file)}:${result.line}.${warningSuffix}`;
			return {
				...toolText(text, { found: false, line: result.line }),
				isError: true,
			};
		}
		// Same #512 convention as pilens_read_symbol: the header line already
		// states kind/name/path/range, so no trailing JSON restates them.
		const range = result.partial
			? `${result.startLine}-${result.endLine} (partial of ${result.enclosingStartLine}-${result.enclosingEndLine})`
			: `${result.startLine}-${result.endLine}`;
		const header = `${result.kind} ${result.name}  ${path.relative(cwd, result.path)}:${range}`;
		return { content: [{ type: "text" as const, text: `${header}\n\n${result.source ?? ""}` }] };
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

// --- Warm build-staleness — per-tool warn-only set (#535) --------------------
//
// `pilens_analyze` is handled specially above (force-routes to the existing
// `fresh` worker fork — it's a stateless per-file dispatch with no dependency
// on warm-process-only state). Every OTHER tool below either:
//   - depends on state that only exists inside THIS long-lived process (the
//     in-memory review graph built by warm `pilens_analyze` calls, the warm
//     LSP client fleet, the latency/diagnostic counters, the CacheManager) —
//     a fresh fork would start with none of that and answer differently, not
//     "more correctly"; or
//   - is cheap/rare enough (rebuild, session_start) that building bespoke
//     fresh-fork plumbing isn't worth it yet.
// So the honest move for all of them is #535's "honest degrade": warn, don't
// silently serve, and don't pretend a fresh fork would help.
//
//   pilens_module_report, pilens_symbol_search — warm review-graph / word-index
//     cache is in-memory only; a fresh fork has an EMPTY graph, which is a
//     worse answer than a stale-but-populated one with a warning attached.
//   pilens_project_scan                        — CacheManager instance is warm-
//     process state; scan results are cache-derived.
//   pilens_health, pilens_latency              — these tools report ON the warm
//     process itself (alive LSP clients, this session's latency log) — the
//     question "is this call's ANSWER stale" doesn't quite apply, but the code
//     answering it might still be a stale build, so still worth a note.
//   pilens_session_start, pilens_turn_end      — mutate warm LSP/graph state;
//     must run in-process, can't be forked fresh.
//   pilens_ast_grep_search, pilens_ast_grep_replace,
//   pilens_lsp_navigation, pilens_lsp_diagnostics — depend on the warm LSP
//     fleet / ast-grep client instances; no fresh-fork machinery exists for
//     them today (only pilens_analyze's worker.ts loads a fresh dispatch
//     graph) and the LSP fleet specifically CANNOT be recreated cheaply per
//     call, so warn is the only honest option.
//   pilens_read_symbol, pilens_read_enclosing  — stateless file reads, but no
//     existing fresh-fork path either; warn rather than silently answer with
//     however this stale build's tree-sitter/read-symbol logic behaves.
//
// `pilens_rebuild` is deliberately excluded: it doesn't answer with analysis
// at all (it shells out to `npm run build`/`build:dist`), and it's the very
// mechanism that CAUSES staleness — noting "stale" on the tool that fixes
// staleness would be confusing, not honest.
const WARN_ONLY_STALE_TOOLS = new Set([
	"pilens_module_report",
	"pilens_symbol_search",
	"pilens_project_scan",
	"pilens_health",
	"pilens_latency",
	"pilens_session_start",
	"pilens_turn_end",
	"pilens_ast_grep_search",
	"pilens_ast_grep_replace",
	"pilens_lsp_navigation",
	"pilens_lsp_diagnostics",
	"pilens_read_symbol",
	"pilens_read_enclosing",
]);

/**
 * Appends the warm-code-stale advisory to a tool result's text (and a
 * `warmCodeStale: true` marker line) without disturbing its JSON payload
 * shape — callers already parse the fenced JSON block by locating braces
 * (see module_report/symbol_search callers), so appending plain text after it
 * is safe.
 */
function withStaleWarning<T extends { content: { type: "text"; text: string }[] }>(
	result: T,
): T {
	if (result.content.length === 0) return result;
	const last = result.content[result.content.length - 1];
	return {
		...result,
		content: [
			...result.content.slice(0, -1),
			{ ...last, text: `${last.text}\n\nwarmCodeStale: true\n${STALE_WARN_ONLY}` },
		],
	};
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
				let result = await callTool(name, args);
				// #535: pilens_analyze already self-routes (fresh-fork) when stale —
				// see the forcedFresh branch inside callTool. Every other tool that
				// depends on warm-only process state gets an honest-degrade warning
				// instead, so the warm boundary never silently serves old code.
				if (
					WARN_ONLY_STALE_TOOLS.has(name) &&
					!result.isError &&
					isWarmBuildStale()
				) {
					result = withStaleWarning(result);
				}
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
