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
import {
	boundToolResultText,
	renderToolResultContract,
	renderToolText as toolText,
} from "../tools/render-compact.js";
import { AstGrepClient } from "../clients/ast-grep-client.js";
import { CacheManager } from "../clients/cache-manager.js";
import {
	getDegradationSummary,
	recordDegradationOnce,
	renderDegradationLines,
} from "../clients/degradation-ledger.js";
import {
	acknowledgeTurnEnd,
	analyzeFile,
	analyzeFileFresh,
	canRebuildPiLens,
	createMcpHost,
	createWarmIpcLineReader,
	createWarmIpcRequestQueue,
	diagnosticStats,
	effectiveConfig,
	type EffectiveConfigView,
	type EffectiveFileView,
	type EffectiveServerDecision,
	ensureLspConfig,
	generatedSkipNotice,
	ipcPathForCwd,
	isEffectiveFileViewError,
	lspStatus,
	type McpAnalyzeResult,
	moduleReport,
	projectReport,
	projectScan,
	readEnclosing,
	readSymbol,
	readTurnEndStatus,
	recentLatency,
	renderCompactModuleReport,
	renderCompactProjectReport,
	renderLspBrokenStatusLines,
	resolveRebuildScript,
	resourceFootprint,
	runRebuild,
	runSessionStart,
	runTurnEnd,
	runTurnEndForIpc,
	scanTruncationNotice,
	summarizeScan,
	symbolSearch,
	treeSitterRuntimeStatus,
	WARM_TURN_END_SCHEMA_VERSION,
	type WarmAnalyzeRequest,
	type WarmTurnEndRequest,
	type WarmTurnEndResponse,
} from "../clients/lens-engine.js";
import { createAstGrepReplaceTool } from "../tools/ast-grep-replace.js";
import {
	astGrepDumpCompatibilityResult,
	createAstGrepSearchTool,
} from "../tools/ast-grep-search.js";
import { createLensDiagnosticsTool } from "../tools/lens-diagnostics.js";
import { peekMcpSessionRuntime } from "../clients/mcp/session.js";
import { createLspDiagnosticsTool } from "../tools/lsp-diagnostics.js";
import { loadPiLensGlobalConfig } from "../clients/lens-config.js";
import { loadPiLensProjectConfig } from "../clients/project-lens-config.js";
import {
	resolveLensToolEnabled,
	toolRegistryEntryForMcp,
} from "../clients/tool-config.js";
import { createLspNavigationTool } from "../tools/lsp-navigation.js";
import { shouldInitializeSessionRoot } from "../clients/lsp/session-roots.js";
import {
	computeBuildStamp,
	STALE_SERVED_BY_FRESH,
	STALE_WARN_ONLY,
	StalenessGate,
	stalenessCheckEnabled,
} from "./build-staleness.js";

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

// `PI_LENS_MCP_STALENESS_INTERVAL_MS` (test-only override): shrinks the
// gate's re-stat throttle below its 1000ms default so a staleness smoke test
// doesn't have to sleep out a full second per assertion. Parsed explicitly
// rather than `Number(raw) || undefined` — that idiom would coerce a real
// "0" override (disable the throttle entirely) back to the 1000ms default.
const stalenessIntervalOverride = ((): number | undefined => {
	const raw = process.env.PI_LENS_MCP_STALENESS_INTERVAL_MS;
	if (raw === undefined) return undefined;
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
})();
const STALENESS_GATE = new StalenessGate(BUILD_STAMP, {
	checkIntervalMs: stalenessIntervalOverride,
});

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

// Test-only override lets the stdio smoke exercise the published-package shape
// without copying the whole compiled server tree under node_modules.
const REPO_ROOT = process.env.PI_LENS_MCP_REPO_ROOT
	? path.resolve(process.env.PI_LENS_MCP_REPO_ROOT)
	: findRepoRoot(SERVER_DIR);

async function ensureReady(cwd: string): Promise<void> {
	const normalized = path.resolve(cwd);
	// #2052 R1: the session-root registry evicts old roots at a fixed cap. The
	// readiness memo is only a fast path; consult the registry so an evicted
	// root can initialize again when it is used later.
	if (!shouldInitializeSessionRoot(normalized, lspReadyCwds)) {
		return;
	}
	try {
		await ensureLspConfig(normalized);
		// pi-lens-ignore: missing-error-propagation
	} catch (err) {
		console.error(
			`[pi-lens-mcp] initLSPConfig failed for ${normalized}: ${err}`,
		);
	}
	lspReadyCwds.add(normalized);
}

// Auto session_start on connect (the "Claude SessionStart hook" the agent can't
// wire directly): a Claude Code SessionStart hook runs a separate process and
// can't warm THIS long-lived server's in-process LSP, so the server self-inits.
// Gated by PI_LENS_MCP_AUTO_SESSION=1 because the full session_start runs project
// scans (knip/jscpd/dep) — opt-in so it doesn't fire in every repo. Fire-and-
// forget; the warm/baseline/scan work continues in the background.
//
// #544: this state used to be a bare boolean logged only to stderr (which
// Claude Code never surfaces), so a stale/reconnected server silently stayed
// cold with no way to tell short of `claude --debug` log spelunking. Now it's
// tracked so `pilens_health` can report it, and `tools/call` self-heals by
// re-triggering (see the `handleRequest` "tools/call" case) if the connection
// never got a successful run — the exact stale-process/thrown-before-complete
// scenario that motivated this.
interface AutoSessionState {
	attempted: boolean;
	succeeded: boolean;
	firedAt: string | null;
	error: string | null;
}
let autoSessionState: AutoSessionState = {
	attempted: false,
	succeeded: false,
	firedAt: null,
	error: null,
};
// Non-null while a run is in flight — guards both the `initialize` call site
// and the `tools/call` self-heal fallback against double-firing/races.
let autoSessionInFlight: Promise<void> | null = null;

function maybeAutoSessionStart(): void {
	if (process.env.PI_LENS_MCP_AUTO_SESSION !== "1") return;
	// Already running, or already completed successfully — nothing to do. A
	// prior *failed* attempt is retried (this is the self-heal path).
	if (autoSessionInFlight || autoSessionState.succeeded) return;
	autoSessionState = {
		attempted: true,
		succeeded: false,
		firedAt: new Date().toISOString(),
		error: null,
	};
	autoSessionInFlight = ensureReady(DEFAULT_CWD)
		.then(() => runSessionStart(DEFAULT_CWD))
		.then(() => {
			autoSessionState = { ...autoSessionState, succeeded: true };
			console.error("[pi-lens-mcp] auto session_start complete");
		})
		.catch((err) => {
			autoSessionState = { ...autoSessionState, error: String(err) };
			console.error(`[pi-lens-mcp] auto session_start failed: ${err}`);
		})
		.finally(() => {
			autoSessionInFlight = null;
		});
}

/**
 * `pilens_health`-facing view of auto-session state. Returns `null` when
 * `PI_LENS_MCP_AUTO_SESSION` isn't set at all, so "the feature is off" is
 * distinguishable from "attempted and failed".
 */
function getAutoSessionStatus(): AutoSessionState | null {
	if (process.env.PI_LENS_MCP_AUTO_SESSION !== "1") return null;
	return { ...autoSessionState };
}

// --- Warm side-channel (server side) ----------------------------------------
// A local IPC endpoint the PostToolUse-hook bin connects to, so inline feedback
// runs in THIS warm process (LSP-complete) instead of a cold hook process.
// Responses go over the socket — never stdout — so the MCP stream is untouched.

const IPC_PATH = ipcPathForCwd(DEFAULT_CWD);

/**
 * #1273: the turn-end route runs the TARGET directory's configured test runner
 * and spins up an LSP for it, from a client-supplied `cwd`. Every legitimate
 * client derived the socket path from that same cwd, so a workspace check costs
 * nothing legitimate — but without it, anything that can reach this endpoint
 * (same-uid processes, a permissive-umask shared host, a Windows named pipe's
 * more generous default DACL) can make the server execute an arbitrary
 * directory's test suite. "Lint one file" and "run this directory's test suite"
 * are different blast radii, so the guard is on turn-end and its ack.
 */
function rejectForeignTurnCwd(route: string, cwd: string): string {
	const message = `${route} cwd outside this server's workspace: ${path.resolve(cwd)} not within ${DEFAULT_CWD}`;
	console.error(`[pi-lens-mcp] rejected ${message}`);
	return message;
}

function isWithinServerWorkspace(cwd: string): boolean {
	const target = path.resolve(cwd);
	// `path.relative` applies the platform's own path semantics (including
	// win32 case-insensitivity), which is what "inside the workspace" means
	// here — do NOT hand-roll a case fold. An empty result means `target`
	// IS `DEFAULT_CWD` (win32 can reach that via a pure case/drive-letter
	// difference, since path.relative there is case-insensitive) and must
	// be accepted, not rejected — do NOT reintroduce a `rel !== ""` guard.
	const rel = path.relative(DEFAULT_CWD, target);
	return !rel.startsWith("..") && !path.isAbsolute(rel);
}

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

	const requestQueue = createWarmIpcRequestQueue();
	const ipc = net.createServer((socket) => {
		socket.setEncoding("utf8");
		// One-shot per connection (#1219): clients write exactly one request and
		// read one reply, so a handler that kept re-reading the same buffered
		// line re-dispatched the request on stray bytes. The reader consumes the
		// line and ignores anything after it.
		socket.on(
			"data",
			createWarmIpcLineReader((line) => {
				void requestQueue.enqueue(async () => {
					try {
						if (isWarmBuildStale()) {
							console.error(
								"[pi-lens-mcp] warm request: build stale, replying with an error",
							);
							socket.end(`${JSON.stringify({ error: "warm build stale" })}\n`);
							return;
						}
						const parsed = JSON.parse(line) as Partial<
							WarmTurnEndRequest & WarmAnalyzeRequest
						>;
						if ((parsed as { route?: string }).route === "turn-end-ack") {
							if (
								parsed.version !== WARM_TURN_END_SCHEMA_VERSION ||
								typeof (parsed as { deliveryId?: unknown }).deliveryId !==
									"string"
							) {
								socket.end(
									`${JSON.stringify({ error: `turn-end ack schema ${parsed.version} != ${WARM_TURN_END_SCHEMA_VERSION}` })}\n`,
								);
								return;
							}
							const turnCwd = parsed.cwd ?? DEFAULT_CWD;
							if (!isWithinServerWorkspace(turnCwd)) {
								socket.end(
									`${JSON.stringify({ error: rejectForeignTurnCwd("turn-end-ack", turnCwd) })}\n`,
								);
								return;
							}
							const acknowledged = acknowledgeTurnEnd(
								turnCwd,
								(parsed as { deliveryId: string }).deliveryId,
							);
							socket.end(
								`${JSON.stringify({
									result: {
										route: "turn-end-ack",
										version: WARM_TURN_END_SCHEMA_VERSION,
										acknowledged,
									},
								})}\n`,
							);
							return;
						}
						if (parsed.route === "turn-end") {
							if (parsed.version !== WARM_TURN_END_SCHEMA_VERSION) {
								socket.end(
									`${JSON.stringify({ error: `turn-end schema ${parsed.version} != ${WARM_TURN_END_SCHEMA_VERSION}` })}\n`,
								);
								return;
							}
							const turnCwd = parsed.cwd ?? DEFAULT_CWD;
							if (!isWithinServerWorkspace(turnCwd)) {
								socket.end(
									`${JSON.stringify({ error: rejectForeignTurnCwd("turn-end", turnCwd) })}\n`,
								);
								return;
							}
							// #1274: a client that already gave up (hook timeout, killed
							// Claude Code) leaves a destroyed socket. Starting a heavy
							// pass whose reply nobody can read is pure waste; the findings
							// stay in the cache for the next Stop either way.
							if (socket.destroyed) {
								console.error(
									`[pi-lens-mcp] warm turn-end: client gone before the pass started (${turnCwd})`,
								);
								return;
							}
							console.error(`[pi-lens-mcp] warm turn-end: ${turnCwd}`);
							await ensureReady(turnCwd);
							const delivery = await runTurnEndForIpc(turnCwd);
							const result: WarmTurnEndResponse = {
								route: "turn-end",
								version: WARM_TURN_END_SCHEMA_VERSION,
								turnEnd: delivery.outcome.turnEnd,
								tests: delivery.outcome.tests,
								deliveryId: delivery.deliveryId,
							};
							socket.end(`${JSON.stringify({ result })}\n`);
							return;
						}
						const req = parsed as WarmAnalyzeRequest;
						console.error(`[pi-lens-mcp] warm analyze: ${req.file}`);
						const result = await analyzeFile(req.file, req.cwd, {
							registerTurnState: true,
							updateGraph: true,
						});
						socket.end(`${JSON.stringify({ result })}\n`);
					} catch (err) {
						socket.end(`${JSON.stringify({ error: String(err) })}\n`);
					}
				});
			}),
		);
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
	undefined,
	undefined,
	undefined,
	undefined,
	// #1413 surface parity: validate cached test-runner findings against the
	// same session identity the in-process path uses. Resolved lazily — until
	// an MCP session context exists there is no session to compare against and
	// validation skips the check, which is the honest classification.
	() => peekMcpSessionRuntime(),
);
const astGrepClient = new AstGrepClient();
const astGrepSearchTool = createAstGrepSearchTool(astGrepClient);
const astGrepReplaceTool = createAstGrepReplaceTool(astGrepClient);
// #792: unlike every other per-request `cwd` resolution in this file, this
// tool used to be built ONCE at module load with `createMcpHost().getFlag`,
// which freezes `projectRoot` at the server's own launch directory — a
// project-config-gated flag consulted through this tool would silently read
// whatever `.pi-lens.json` happens to sit there, never the caller's project.
// Resolve lazily against the call's own `cwd` instead (config loads are
// mtime-cached, so this stays cheap).
const lspNavigationTool = createLspNavigationTool((name, cwd) =>
	createMcpHost(undefined, cwd ?? DEFAULT_CWD).getFlag(name),
);
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
			...p.properties,
			cwd: {
				type: "string",
				description: "Project root (defaults to the server workspace).",
			},
		},
		...(p.required ? { required: p.required } : {}),
	};
}

const ALL_TOOLS = [
	{
		name: "pilens_analyze",
		description:
			"Run pi-lens's per-edit dispatch pipeline on one file. Example: analyze `src/app.ts` after an edit.",
		inputSchema: {
			type: "object",
			properties: {
				file: {
					type: "string",
					description:
						"Path to the file to analyze (absolute, or relative to cwd).",
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
						'Optional pi-lens flag overrides for this run, e.g. {"no-lsp": true} to bench the non-LSP path.',
				},
			},
			required: ["file"],
		},
	},
	{
		name: "pilens_diagnostics",
		description: lensDiagnosticsTool.description.replaceAll(
			"lsp_diagnostics",
			"pilens_lsp_diagnostics",
		),
		inputSchema: schemaWithCwd(lensDiagnosticsTool.parameters),
	},
	{
		name: "pilens_latency",
		description:
			"Return recent dispatch latency reports. Example: limit results to 5.",
		inputSchema: {
			type: "object",
			properties: {
				limit: {
					type: "number",
					description: "Max reports to return (default 5).",
				},
				file: {
					type: "string",
					description: "Only reports whose path ends with this.",
				},
			},
		},
	},
	{
		name: "pilens_rebuild",
		description:
			"Rebuild pi-lens so later fresh analyses use the latest commit. Example: rebuild after changing a tool.",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "pilens_project_scan",
		description:
			"Scan project files for structural and quality diagnostics. Example: cap the scan with `maxFiles: 20`.",
		inputSchema: {
			type: "object",
			properties: {
				cwd: { type: "string" },
				maxFiles: { type: "number", description: "Cap files scanned." },
				includeGenerated: {
					type: "boolean",
					description:
						"Scan WITHOUT the generated/artifact NAME-heuristic filter " +
						"(lockfiles, gen.ts-style names, generated/ dirs, …). Default " +
						"false. Use when a scan's 'excluded by generated-name " +
						"heuristics' notice suggests a real file was skipped.",
				},
			},
		},
	},
	{
		name: "pilens_symbol_search",
		description:
			"Find relevant files by ranked identifier search. On a cold cache, project_report and symbol_search return available: false with a retry hint and start a non-blocking background build; module_report degrades to outline-only with cache freshness explicit. Example: search `authenticate user` before pilens_module_report.",
		inputSchema: {
			type: "object",
			properties: {
				query: {
					type: "string",
					description:
						"Identifier-ish query, e.g. 'authenticate user'. Mix in composable prefix filters: lang:<kind> (e.g. lang:jsts, lang:python — kinds from file-kinds.ts), file:<substr> (path substring), ext:<ext> (e.g. ext:ts or ext:.ts), each optionally negated with a leading '-' (-file:test). Filters apply before ranking; e.g. 'lang:jsts file:clients/ -file:test rank'. Unknown prefixes/kinds error with the supported list.",
				},
				cwd: { type: "string" },
				limit: {
					type: "number",
					description: "Max files to return (default 20).",
				},
				paths: {
					type: "array",
					items: { type: "string" },
					description:
						"Glob array scoping hits to matching files — same shape/semantics as pilens_ast_grep_search's `paths` (a bare directory/file entry scopes its whole subtree). Filters before ranking, so scores within the scoped set are unaffected.",
				},
				lang: {
					type: "string",
					description:
						"Restrict hits to one language, using the same identifiers as pilens_ast_grep_search's `lang` param (e.g. 'typescript', 'python', 'go').",
				},
			},
			required: ["query"],
		},
	},
	{
		name: "pilens_module_report",
		description:
			"Return a navigable source-module outline with references and read handles. An outline shows shape, not bodies, and does not satisfy read-before-edit; `read_symbol` and `read_enclosing` return body text and record read coverage. On a cold cache, project_report and symbol_search return available: false with a retry hint and start a non-blocking background build; module_report degrades to outline-only with cache freshness explicit. Example: use pilens_module_report on `src/app.ts` before pilens_read_symbol.",
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
				callGraph: {
					type: "boolean",
					description:
						"Include bounded derived callers/callees from the cached FunctionCallGraph; cold or stale cache state is explicit.",
				},
				maxCallGraphEntries: {
					type: "number",
					description:
						"Per-direction cap for call-graph relations (default 20).",
				},
			},
			required: ["file"],
		},
	},
	{
		name: "pilens_project_report",
		description:
			"Orient in a project from its review graph. On a cold cache, project_report and symbol_search return available: false with a retry hint and start a non-blocking background build; module_report degrades to outline-only with cache freshness explicit. Example: use pilens_project_report before choosing a file.",
		inputSchema: {
			type: "object",
			properties: {
				cwd: { type: "string" },
				limit: {
					type: "number",
					description:
						"Scales every ranked section's cap (default 10) — a single knob for all sections.",
				},
				focus: {
					type: "string",
					description:
						"Optional task hint used only to re-rank sections toward relevant subsystems (does not expand scope or trigger scans).",
				},
				view: {
					type: "string",
					enum: ["default", "compact"],
					description:
						"Payload tier. compact (cheapest) returns a line-oriented TEXT rendering instead of JSON. Default returns JSON.",
				},
			},
		},
	},
	{
		name: "pilens_read_symbol",
		description:
			"Return one symbol's verbatim source. An outline shows shape, not bodies, and does not satisfy read-before-edit; `read_symbol` and `read_enclosing` return body text and record read coverage. Example: use pilens_read_symbol after pilens_module_report identifies `parseConfig`.",
		inputSchema: {
			type: "object",
			properties: {
				file: { type: "string", description: "File containing the symbol." },
				symbol: {
					type: "string",
					description:
						"Exact symbol name to read, or a dotted `Class.method` to disambiguate a member.",
				},
				kind: {
					type: "string",
					description:
						"Optional kind filter (e.g. function, interface, class) to disambiguate when multiple same-file symbols share the requested name.",
				},
				cwd: { type: "string" },
			},
			required: ["file", "symbol"],
		},
	},
	{
		name: "pilens_read_enclosing",
		description:
			"Return the smallest symbol or callback enclosing a line. An outline shows shape, not bodies, and does not satisfy read-before-edit; `read_symbol` and `read_enclosing` return body text and record read coverage. Example: use pilens_read_enclosing after a diagnostic points to line 42.",
		inputSchema: {
			type: "object",
			properties: {
				file: {
					type: "string",
					description:
						"Absolute or workspace-relative path to the source file.",
				},
				line: {
					type: "number",
					description:
						"1-based line number inside the desired symbol/callback.",
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
			"Return pi-lens runtime health for this server. Example: call it after a slow analysis.",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "pilens_effective_config",
		description:
			"Explain resolved configuration and provenance. Response is redacted by construction: it contains no environment values, no command arguments beyond the binary, and home-relative paths; a tier-denied LSP decision cannot be lifted by a nearer config. Example: pass `file` to explain one selection.",
		inputSchema: {
			type: "object",
			properties: {
				cwd: { type: "string" },
				file: {
					type: "string",
					description:
						"Path to explain: adds the resolved language plus the per-server and " +
						"per-runner selection decisions for it. Must resolve inside `cwd` " +
						"(a sibling package in the same monorepo does not count) — a file " +
						"outside it is rejected with the `cwd` it was measured against; " +
						"re-query with `cwd` set to that file's own workspace instead.",
				},
			},
		},
	},
	{
		name: "pilens_session_start",
		description:
			"Initialize pi-lens for a workspace. Example: run once before reviewing a project.",
		inputSchema: {
			type: "object",
			properties: { cwd: { type: "string" } },
		},
	},
	{
		name: "pilens_turn_end",
		description:
			"Summarize checks for files changed this turn. Example: pass `files` for an unanalysed file.",
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
			"Search code by AST structure rather than text. Example: find calls with `console.log($MSG)`.",
		inputSchema: schemaWithCwd(astGrepSearchTool.parameters),
	},
	{
		name: "pilens_ast_grep_replace",
		description:
			"Find and rewrite code by AST structure; preview by default. Example: set `apply: false` to inspect a diff.",
		inputSchema: schemaWithCwd(astGrepReplaceTool.parameters),
	},
	{
		name: "pilens_lsp_navigation",
		description:
			'Navigate source with language-server operations. Example: use `{operation: "references", path: "src/app.ts", line: 12}`.',
		inputSchema: schemaWithCwd(lspNavigationTool.parameters),
	},
	{
		name: "pilens_lsp_diagnostics",
		description:
			'Query language-server diagnostics for files or directories. Example: use `{path: "src/app.ts"}` before a build.',
		inputSchema: schemaWithCwd(lspDiagnosticsTool.parameters),
	},
];
// #920: published packages cannot rebuild themselves safely because their
// build config is intentionally not shipped. Do not advertise the destructive
// capability to clients/subagent allowlists; callTool retains its own guard.
const TOOLS = canRebuildPiLens(REPO_ROOT)
	? ALL_TOOLS
	: ALL_TOOLS.filter((tool) => tool.name !== "pilens_rebuild");

function enabledToolsForCwd(cwd: string) {
	const global = loadPiLensGlobalConfig();
	const project = loadPiLensProjectConfig(cwd);
	return TOOLS.filter((tool) => {
		const entry = toolRegistryEntryForMcp(tool.name);
		return (
			entry !== undefined &&
			resolveLensToolEnabled(entry.name, global, project.raw)
		);
	});
}

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
		// #2420: advisories (hint/info-tier style opinions) are reported under
		// their own label so they are no longer folded into the warning count.
		`${result.counts.advisories} advisory(ies), ` +
		`${result.counts.diagnostics} total` +
		(result.latency ? ` · ${result.latency.totalDurationMs}ms` : "") +
		lspNote +
		(result.counts.fixed > 0 ? ` · ${result.counts.fixed} auto-fixed` : "") +
		(servedBy ? `\n\nservedBy: ${servedBy}` : "");
	return toolText(summary, servedBy ? { ...result, servedBy } : result);
}

/** The per-tier and per-code counts `pilens_health` reports for a resolution. */
interface HealthConfigProvenance {
	readonly documents: number;
	readonly tiers: Readonly<Record<string, number>>;
	readonly codes: Readonly<Record<string, number>>;
}

/**
 * The `Config:` line of `pilens_health` (#2427).
 *
 * A named formatter rather than a ternary nested inside a template inside a
 * ternary in the `lines` array (review round 2, F3). Counts only — the
 * whole point of embedding provenance in a health report is that it names WHICH
 * files contributed without carrying WHAT they said.
 */
function healthConfigLine(provenance: HealthConfigProvenance | null): string {
	if (!provenance) return "Config: unavailable (resolution failed)";
	const tiers = Object.entries(provenance.tiers)
		.filter(([, count]) => count > 0)
		.map(([tier, count]) => `${tier} ${count}`)
		.join(" · ");
	const codes = Object.entries(provenance.codes)
		.map(([code, count]) => `${code}×${count}`)
		.join(", ");
	const notices = codes.length > 0 ? ` · notices ${codes}` : "";
	const documents = `${provenance.documents} file(s)`;
	return `Config: ${documents} · ${tiers} leaf/leaves${notices}`;
}

/** One `pilens_effective_config` server row, with the tier that decided it. */
function effectiveServerLine(server: EffectiveServerDecision): string {
	const mark = server.selected ? "✓" : "✗";
	const decided = server.decidedBy;
	if (!decided) return `  ${mark} ${server.id} — ${server.reason}`;
	const file = decided.file === undefined ? "" : ` ${decided.file}`;
	const source = `${decided.tier}${file} → ${decided.key}`;
	return `  ${mark} ${server.id} — ${server.reason} (${source})`;
}

/** The `File:` heading of `pilens_effective_config`. */
function effectiveFileHeading(file: EffectiveFileView): string {
	const language = file.language === undefined ? "" : ` — ${file.language}`;
	const kind = file.kind === undefined ? "" : ` (kind ${file.kind})`;
	return `File: ${file.path}${language}${kind}`;
}

/** One `pilens_effective_config` config-document row. */
function effectiveDocumentLine(
	document: EffectiveConfigView["documents"][number],
): string {
	const legacy = document.legacy
		? " (legacy location — scheduled for removal)"
		: "";
	return `  ${document.tier}: ${document.file}${legacy}`;
}

async function callTool(
	name: string,
	args: Record<string, unknown>,
): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> {
	if (name === "pilens_ast_grep_dump") {
		recordDegradationOnce({
			kind: "ast-grep-dump-compatibility",
			subject: "ast_grep_dump",
			reason: "retired tool name redirected to ast_grep_search dump mode",
		});
		return astGrepDumpCompatibilityResult(args, "mcp");
	}
	if (name === "pilens_analyze") {
		const file = args.file;
		if (typeof file !== "string" || file.length === 0) {
			return {
				...toolText("pilens_analyze requires a 'file' string."),
				isError: true,
			};
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
		if (!outcome.packageManager) {
			return {
				...toolText(outcome.output, {
					ok: false,
					script: outcome.script,
					repoRoot: REPO_ROOT,
				}),
				isError: true,
			};
		}
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
		const includeGenerated = args.includeGenerated === true;
		const snapshot = await projectScan(cwd, maxFiles, includeGenerated);
		// #747: a cwd at/above $HOME refuses to walk — say so instead of letting
		// "Scanned 0 file(s) → 0 diagnostics" read as a clean project.
		if (snapshot.unsafeRoot) {
			return toolText(
				`Refused to scan: the working directory (${cwd}) resolves at or above the home directory, so a project scan would walk every unrelated tree under it. Run pilens_project_scan from inside a project directory. This is NOT a clean result — nothing was scanned.`,
				{ filesScanned: 0, unsafeRoot: true, cwd },
				true,
			);
		}
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
		// #784: scanTruncated reached this seam already (#760) but nothing
		// rendered it, so a capped scan read as a complete clean sweep. Say so
		// explicitly — mirrors the #777 warm-skip notify's override-hint wording.
		const truncationNotice = scanTruncationNotice(snapshot);
		if (truncationNotice) summaryLines.push(truncationNotice);
		// #1107 phase 2: same "reached the seam but nothing rendered it" gap as
		// #784's scanTruncationNotice, for the generated-name skip counters.
		const skipNotice = generatedSkipNotice(snapshot);
		if (skipNotice) summaryLines.push(skipNotice);
		return toolText(summaryLines.join("\n"), {
			filesScanned: snapshot.filesScanned,
			runners: snapshot.runners,
			uniqueDiagnostics: deduped.length,
			rawDiagnostics: snapshot.diagnostics.length,
			byRule,
			topFiles,
			sample: deduped.slice(0, 40),
			...(snapshot.scanTruncated ? { scanTruncated: true } : {}),
			...(snapshot.treeSitterStatus
				? { treeSitterStatus: snapshot.treeSitterStatus }
				: {}),
			...(snapshot.generatedFileSkips
				? { generatedFileSkips: snapshot.generatedFileSkips }
				: {}),
			...(snapshot.generatedNameOnlySkips
				? { generatedNameOnlySkips: snapshot.generatedNameOnlySkips }
				: {}),
			...(snapshot.generatedDirSkips
				? { generatedDirSkips: snapshot.generatedDirSkips }
				: {}),
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
		const paths = Array.isArray(args.paths)
			? args.paths.filter((p): p is string => typeof p === "string")
			: undefined;
		const lang = typeof args.lang === "string" ? args.lang : undefined;
		const {
			available,
			results,
			hint,
			unavailableReason,
			coverage,
			snapshotGeneratedAt,
		} = await symbolSearch(query, cwd, limit, { paths, lang });
		if (!available) {
			return toolText(
				hint ??
					"No word index for this workspace yet — run pilens_session_start first.",
				{ available: false, query, hint, unavailableReason },
				true,
			);
		}
		const stalenessNote = graphStalenessNote(
			snapshotGeneratedAt,
			"Project snapshot",
		);
		if (results.length === 0) {
			return toolText(
				`No files matched "${query}".` +
					(coverage
						? `\nIndex covers ${coverage.files} files${coverage.truncated ? " (capped — results may be incomplete)" : ""}.`
						: "") +
					(stalenessNote ? `\n\n${stalenessNote}` : ""),
				{
					available: true,
					query,
					results: [],
					coverage,
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
			...(coverage
				? [
						`Index covers ${coverage.files} files${coverage.truncated ? " (capped — results may be incomplete)" : ""}.`,
					]
				: []),
		];
		// Compact (unindented) JSON — matches the module_report / read_symbol
		// convention (#517): an agent parses this payload, it doesn't read it
		// formatted. Path is relative-to-cwd once per hit, no repeated per-hit
		// `read` block — startLine/endLine already derive offset/limit.
		return toolText(
			lines.join("\n"),
			{
				query,
				coverage,
				results: results.map((result) => {
					const relFile = path.relative(cwd, result.file);
					return {
						file: relFile,
						score: result.score,
						hits: result.hits,
						startLine: result.startLine,
						endLine: result.endLine,
						...(result.annotations ? { annotations: result.annotations } : {}),
						// #771: machine-actionable discovery-funnel hint, mirroring the
						// pi-tool-surface's suggestedNext (tools/symbol-search.ts).
						suggestedNext: { tool: "pilens_module_report", path: relFile },
					};
				}),
				...(stalenessNote ? { staleness: stalenessNote } : {}),
			},
			true,
		);
	}

	if (name === "pilens_module_report") {
		const file = typeof args.file === "string" ? args.file : "";
		if (!file.trim())
			return { ...toolText("Provide a `file`."), isError: true };
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
		const callGraph = args.callGraph === true;
		const maxCallGraphEntries =
			typeof args.maxCallGraphEntries === "number" &&
			Number.isFinite(args.maxCallGraphEntries)
				? Math.max(1, Math.floor(args.maxCallGraphEntries))
				: undefined;
		const view =
			args.view === "summary" || args.view === "compact"
				? args.view
				: undefined;
		const focus = typeof args.focus === "string" ? args.focus : undefined;
		const report = await moduleReport(file, cwd, {
			maxRefsPerSymbol,
			blastRadius,
			blastRadiusDepth,
			callGraph,
			maxCallGraphEntries,
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
		const graphStaleness = graphStalenessNote(
			report.graphBuiltAt,
			"Review graph",
		);
		const summary =
			`${path.relative(cwd, report.path) || report.path} [${report.staleness}] — ` +
			`${report.summary.symbols} symbol(s), ${report.summary.exports} exported, ` +
			`${report.api.length} in public API` +
			(graphStaleness ? `\n\n${graphStaleness}` : "");
		if (view === "compact") {
			const compactText = renderCompactModuleReport(report);
			return boundToolResultText(
				renderToolResultContract({
					content: [
						{
							type: "text" as const,
							text: graphStaleness
								? `${compactText}\n\n${graphStaleness}`
								: compactText,
						},
					],
				}),
			);
		}
		// Compact (unindented) JSON — matches the pi tool's mirror (#512); an
		// agent parses this payload, it doesn't read it formatted.
		return toolText(
			summary,
			graphStaleness
				? { ...report, graphStalenessNote: graphStaleness }
				: report,
			true,
		);
	}

	if (name === "pilens_project_report") {
		const cwd = typeof args.cwd === "string" ? args.cwd : DEFAULT_CWD;
		const limit =
			typeof args.limit === "number" && Number.isFinite(args.limit)
				? Math.max(1, Math.floor(args.limit))
				: undefined;
		const focus = typeof args.focus === "string" ? args.focus : undefined;
		const view = args.view === "compact" ? "compact" : undefined;
		const report = await projectReport(cwd, { limit, focus, view });
		if (!report.available) {
			return {
				...toolText(
					report.hint ?? "No review graph cached for this workspace yet.",
					report,
				),
				isError: true,
			};
		}
		const graphStaleness = report.trust
			? graphStalenessNote(report.trust.graphBuiltAt, "Review graph")
			: undefined;
		if (view === "compact") {
			const compactText = renderCompactProjectReport(report);
			return boundToolResultText(
				renderToolResultContract({
					content: [
						{
							type: "text" as const,
							text: graphStaleness
								? `${compactText}\n\n${graphStaleness}`
								: compactText,
						},
					],
				}),
			);
		}
		const summary =
			`Project report — ${report.hubs?.length ?? 0} hub(s), ` +
			`${report.entryPoints?.length ?? 0} entry point(s), ` +
			`${report.riskHotspots?.length ?? 0} risk hotspot(s)` +
			(graphStaleness ? `\n\n${graphStaleness}` : "");
		return toolText(
			summary,
			graphStaleness
				? { ...report, graphStalenessNote: graphStaleness }
				: report,
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
		const kind = typeof args.kind === "string" ? args.kind : undefined;
		const result = await readSymbol(file, symbol, cwd, { kind });
		if (!result.found) {
			const suggestionSuffix = result.suggestions?.length
				? ` Did you mean: ${result.suggestions.join(", ")}?`
				: " Use pilens_module_report to list symbols.";
			return {
				...toolText(
					`Symbol "${symbol}" not found in ${path.basename(file)}.${suggestionSuffix}`,
					{
						found: false,
						...(result.suggestions ? { suggestions: result.suggestions } : {}),
					},
				),
				isError: true,
			};
		}
		// Header line already states kind/name/path/range; a trailing JSON block
		// restating those same fields is redundant on the wire (#512) — only
		// `signature` was ever new, so fold it into the header text instead.
		const sigSuffix = result.signature ? `  ${result.signature}` : "";
		const ambiguityNote = result.ambiguous
			? ` (${result.ambiguous.count} matches — returned the ${result.kind}; pass \`kind\` to disambiguate: ${result.ambiguous.kinds.join(", ")})`
			: "";
		const header = `${result.kind} ${result.name}${ambiguityNote}${sigSuffix}  ${path.relative(cwd, result.path)}:${result.startLine}-${result.endLine}`;
		return boundToolResultText(
			renderToolResultContract({
				content: [
					{
						type: "text" as const,
						text: `${header}\n\n${result.source ?? ""}`,
					},
				],
			}),
		);
	}

	if (name === "pilens_read_enclosing") {
		const file = typeof args.file === "string" ? args.file : "";
		const line = typeof args.line === "number" ? args.line : Number.NaN;
		if (!file.trim() || !Number.isFinite(line)) {
			return {
				...toolText("Provide `file` and a numeric `line`."),
				isError: true,
			};
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
		return boundToolResultText(
			renderToolResultContract({
				content: [
					{
						type: "text" as const,
						text: `${header}\n\n${result.source ?? ""}`,
					},
				],
			}),
		);
	}

	if (name === "pilens_health") {
		const { aliveClients, servers, brokenServers } = lspStatus();
		const last = recentLatency(1)[0];
		const stats = diagnosticStats();
		const autoSession = getAutoSessionStatus();
		const treeSitter = treeSitterRuntimeStatus();
		const degradations = getDegradationSummary();
		// #1272, following the #544 precedent: the Stop hook is a separate,
		// short-lived process, so a turn-end it skipped left no trace here at all
		// — a dead integration looked exactly like a clean turn, forever. The
		// hook records its outcome per workspace; this is where it becomes
		// visible without `claude --debug` log spelunking.
		const turnEnd = readTurnEndStatus(DEFAULT_CWD) ?? null;
		// #2427: per-tier COUNTS only, never values — #2415's "provenance
		// surfaces in health output without leaking values". Best-effort for the
		// same reason the footprint below is: a config resolution failure must
		// not take down the older, more load-bearing half of this report.
		const configProvenance = await effectiveConfig({ cwd: DEFAULT_CWD })
			.then((view) => ({
				documents: view.documents.length,
				tiers: view.provenanceCounts,
				codes: view.recordCounts,
			}))
			.catch(() => null);
		// #620: best-effort — a footprint read failure must never break the rest
		// of pilens_health's (much older, more load-bearing) reporting.
		const footprint = await resourceFootprint().catch(() => null);
		const lines = [
			treeSitter.wasmAborted
				? `Tree-sitter: DEGRADED — WASM runtime aborted${treeSitter.abortedAt ? ` at ${treeSitter.abortedAt}` : ""}; restart this server to recover`
				: "Tree-sitter: available",
			`LSP: ${aliveClients} alive client(s)`,
			...servers.flatMap((server) => [
				`  ${server.connected ? "✓" : "✗"} ${server.serverId} (${server.root})`,
				...server.pullFailureHistory
					.slice(-1)
					.map(
						(failure) =>
							`    ⚠ diagnostics pull failed: ${failure.method}${failure.code !== undefined ? ` (${failure.code})` : ""} — ${failure.message.length > 200 ? `${failure.message.slice(0, 200)}…` : failure.message}`,
					),
			]),
			...renderLspBrokenStatusLines(brokenServers),
			...renderDegradationLines(degradations),
			last
				? `Last dispatch: ${path.basename(last.filePath)} — ${last.totalDurationMs}ms, ${last.totalDiagnostics} diagnostic(s)`
				: "Last dispatch: none yet",
			`Diagnostics this session: ${stats.totalShown} shown · ${stats.totalAutoFixed} auto-fixed · ${stats.totalUnresolved} unresolved`,
			autoSession
				? `Auto session_start: ${autoSession.succeeded ? "succeeded" : autoSession.error ? "FAILED" : autoSession.attempted ? "in progress" : "not yet attempted"}${autoSession.firedAt ? ` (fired ${autoSession.firedAt})` : ""}${autoSession.error ? ` — ${autoSession.error}` : ""}`
				: "Auto session_start: disabled (PI_LENS_MCP_AUTO_SESSION not set)",
			turnEnd
				? `Stop-hook turn-end: ${turnEnd.ran} ran · ${turnEnd.skipped} skipped` +
					`${turnEnd.lastRunAt ? ` (last ran ${turnEnd.lastRunAt})` : ""}` +
					`${turnEnd.lastSkipReason ? ` — last skip: ${turnEnd.lastSkipReason}${turnEnd.lastSkipAt ? ` at ${turnEnd.lastSkipAt}` : ""}` : ""}`
				: "Stop-hook turn-end: no activity recorded (hook not installed, or no Stop yet)",
			healthConfigLine(configProvenance),
			footprint
				? `Resource footprint: ${footprint.instanceCount} pi-lens instance(s) · ` +
					`${(footprint.totalRssBytes / 1024 / 1024).toFixed(0)}MB RSS · ` +
					`${footprint.totalCpuPercent.toFixed(1)}% CPU · ` +
					`${footprint.totalLspChildCount} LSP child process(es)`
				: "Resource footprint: unavailable (instance registry unreadable)",
		];
		return toolText(lines.join("\n"), {
			aliveClients,
			servers,
			brokenServers,
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
			autoSession,
			treeSitter,
			turnEnd,
			resourceFootprint: footprint,
			degradations,
			configProvenance,
		});
	}

	if (name === "pilens_effective_config") {
		const cwd = typeof args.cwd === "string" ? args.cwd : DEFAULT_CWD;
		const view = await effectiveConfig({
			cwd,
			...(typeof args.file === "string" ? { file: args.file } : {}),
			redact: true,
		});
		const fileLines =
			view.file === undefined
				? []
				: isEffectiveFileViewError(view.file)
					? [`File: ${view.file.error}`]
					: [
							effectiveFileHeading(view.file),
							...view.file.servers
								// Only the servers with something to say: every registry entry
								// whose extension simply does not match this file would be ~40
								// lines of "not applicable" ahead of the answer.
								.filter((server) => server.reason !== "extension-mismatch")
								.map(effectiveServerLine),
							...view.file.tools.map(
								(tool) =>
									`  ${tool.selected ? "✓" : "✗"} ${tool.id} — ${tool.reason}`,
							),
						];
		const lines = [
			`Config: ${view.documents.length} file(s) contributing, ${view.provenance.length} resolved leaf/leaves`,
			...view.documents.map(effectiveDocumentLine),
			...fileLines,
		];
		return toolText(lines.join("\n"), view);
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
		)) as { content: { type: "text"; text: string }[]; isError?: boolean };
		return boundToolResultText(renderToolResultContract(out));
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
			name === "pilens_ast_grep_search"
				? astGrepSearchTool
				: astGrepReplaceTool;
		const out = (await tool.execute(
			"mcp",
			args,
			new AbortController().signal,
			undefined,
			{ cwd, resultMaxItems: Number.POSITIVE_INFINITY },
		)) as { content: { type: "text"; text: string }[]; isError?: boolean };
		return boundToolResultText(renderToolResultContract(out));
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
		)) as { content: { type: "text"; text: string }[]; isError?: boolean };
		return boundToolResultText(renderToolResultContract(out));
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
//   pilens_effective_config                    — derives (never reads) the
//     LSP config for the file's directory to say which servers it selects,
//     and the merge/deny semantics it explains are compiled code; a stale
//     build would explain a resolution the running one no longer performs.
//
// `pilens_rebuild` is deliberately excluded: it doesn't answer with analysis
// at all (it shells out to `npm run build`/`build:dist`), and it's the very
// mechanism that CAUSES staleness — noting "stale" on the tool that fixes
// staleness would be confusing, not honest.
const WARN_ONLY_STALE_TOOLS = new Set([
	"pilens_module_report",
	"pilens_project_report",
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
	"pilens_effective_config",
]);

/**
 * Appends the warm-code-stale advisory to a tool result's text (and a
 * `warmCodeStale: true` marker line) without disturbing its JSON payload
 * shape — callers already parse the fenced JSON block by locating braces
 * (see module_report/symbol_search callers), so appending plain text after it
 * is safe.
 */
function withStaleWarning<
	T extends { content: { type: "text"; text: string }[] },
>(result: T): T {
	if (result.content.length === 0) return result;
	const last = result.content[result.content.length - 1];
	return {
		...result,
		content: [
			...result.content.slice(0, -1),
			{
				...last,
				text: `${last.text}\n\nwarmCodeStale: true\n${STALE_WARN_ONLY}`,
			},
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
			sendResult(id ?? null, { tools: enabledToolsForCwd(DEFAULT_CWD) });
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
			if (
				name !== "pilens_ast_grep_dump" &&
				name !== "pilens_rebuild" &&
				!enabledToolsForCwd(
					typeof args.cwd === "string" ? args.cwd : DEFAULT_CWD,
				).some((tool) => tool.name === name)
			) {
				sendResult(id ?? null, toolText(`Unknown or disabled tool: ${name}`));
				return;
			}
			// #544 self-heal: if auto-session was supposed to fire on `initialize`
			// (PI_LENS_MCP_AUTO_SESSION=1) but never completed successfully — never
			// attempted, still in flight, or threw — nudge it here too. Cheap no-op
			// once it has actually succeeded (see the in-flight/succeeded guard
			// inside maybeAutoSessionStart), so this does NOT re-run session_start
			// on every tool call, only until the connection's first success.
			maybeAutoSessionStart();
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
					...toolText(
						`pi-lens tool '${name}' failed: ${(err as Error).message}`,
					),
					isError: true,
				});
			}
			return;
		}
		default:
			if (!isNotification)
				sendError(id ?? null, -32601, `Method not found: ${method}`);
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
