/**
 * Tier 2 of the MCP path: drive pi-lens's *real* lifecycle handlers
 * (`handleSessionStart`, `handleTurnEnd`) instead of re-implementing the runners
 * they orchestrate. This is what exposes the layers the per-edit dispatch slice
 * doesn't — session-start warms the dominant-language LSP (so warm `analyze` is
 * LSP-complete), establishes the error-debt baseline + complexity baselines, and
 * kicks off knip/jscpd/type-coverage/dep/secrets scans; turn-end runs
 * knip/jscpd incrementally, dep-circular, tests, cascade, and the
 * actionable/code-quality aggregation.
 *
 * The handlers don't return findings — they emit them through the same
 * cache/context bridge pi consumes (`consume*` from runtime-context). We drive
 * the handler, then consume that bridge and hand the text back as the tool result.
 *
 * The host coupling stays thin: a `getFlag` shim, no-op notify/dbg/log, a
 * persistent RuntimeCoordinator + CacheManager (so baselines/turn-state survive
 * across calls, like a real session), and the bootstrap client bundle.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { AstGrepClient } from "../ast-grep-client.js";
import { type BootstrapClients, loadBootstrapClients } from "../bootstrap.js";
import { CacheManager } from "../cache-manager.js";
import { resetDispatchBaselines } from "../dispatch/integration.js";
import { resetFormatService } from "../format-service.js";
import { getLSPService, resetLSPService } from "../lsp/index.js";
import {
	consumeSessionStartGuidance,
	consumeTestFindings,
	consumeTurnEndFindings,
} from "../runtime-context.js";
import { RuntimeCoordinator } from "../runtime-coordinator.js";
import { handleSessionStart } from "../runtime-session.js";
import { handleTurnEnd } from "../runtime-turn.js";
import { createMcpHost } from "./host-shim.js";

interface McpSessionContext {
	runtime: RuntimeCoordinator;
	cacheManager: CacheManager;
	astGrepClient: AstGrepClient;
	clients: BootstrapClients;
}

let contextPromise: Promise<McpSessionContext> | undefined;

/** Lazily build (once) the persistent session context shared across MCP calls. */
export function getMcpSessionContext(): Promise<McpSessionContext> {
	contextPromise ??= (async () => ({
		runtime: new RuntimeCoordinator(),
		cacheManager: new CacheManager(),
		astGrepClient: new AstGrepClient(),
		clients: await loadBootstrapClients(),
	}))();
	return contextPromise;
}

/** Test hook — drop the cached context so a fresh one is built next call. */
export function _resetMcpSessionContext(): void {
	contextPromise = undefined;
}

const noop = (): void => {};

function joinMessages(
	consumed: { messages: Array<{ content: string }> } | undefined,
): string | undefined {
	if (!consumed?.messages?.length) return undefined;
	return consumed.messages.map((message) => message.content).join("\n\n");
}

export interface SessionStartOutcome {
	guidance?: string;
	errorDebtBaseline?: { testsPassed: boolean; buildPassed: boolean };
	aliveLspClients: number;
}

/**
 * Run pi-lens's real session_start. Much of the work (scans, baseline, LSP warm)
 * runs in the background, so the immediate return carries the synchronous
 * guidance + whatever baseline/LSP state is ready; query `pilens_diagnostics` /
 * `pilens_health` afterwards for the scan results as they land.
 */
export async function runSessionStart(
	cwd: string,
): Promise<SessionStartOutcome> {
	const ctx = await getMcpSessionContext();
	const host = createMcpHost();

	await handleSessionStart({
		ctxCwd: cwd,
		getFlag: host.getFlag,
		notify: noop,
		dbg: noop,
		log: noop,
		runtime: ctx.runtime,
		metricsClient: ctx.clients.metricsClient,
		cacheManager: ctx.cacheManager,
		todoScanner: ctx.clients.todoScanner,
		astGrepClient: ctx.astGrepClient,
		biomeClient: ctx.clients.biomeClient,
		ruffClient: ctx.clients.ruffClient,
		knipClient: ctx.clients.knipClient,
		jscpdClient: ctx.clients.jscpdClient,
		deadCodeClients: ctx.clients.deadCodeClients,
		govulncheckClient: ctx.clients.govulncheckClient,
		gitleaksClient: ctx.clients.gitleaksClient,
		trivyClient: ctx.clients.trivyClient,
		opengrepClient: ctx.clients.opengrepClient,
		depChecker: ctx.clients.depChecker,
		testRunnerClient: ctx.clients.testRunnerClient,
		goClient: ctx.clients.goClient,
		rustClient: ctx.clients.rustClient,
		ensureTool: async (name: string) =>
			(await import("../installer/index.js")).ensureTool(name),
		cleanStaleTsBuildInfo: () => [],
		resetDispatchBaselines: (cwdArg?: string) =>
			resetDispatchBaselines(cwdArg ?? cwd),
		resetLSPService,
	});

	const baseline = ctx.runtime.errorDebtBaseline;
	return {
		guidance: joinMessages(consumeSessionStartGuidance(ctx.cacheManager, cwd)),
		errorDebtBaseline: baseline
			? { testsPassed: baseline.testsPassed, buildPassed: baseline.buildPassed }
			: undefined,
		aliveLspClients: getLSPService().getAliveClientCount(),
	};
}

export interface TurnEndOutcome {
	turnEnd?: string;
	tests?: string;
	filesRegistered: number;
}

/**
 * Run pi-lens's real turn_end over the files edited this "turn". The handler
 * reads edited files from turn-state, so we register the caller-supplied files
 * first (a full-file range, importsChanged=true so dep/knip re-check broadly).
 */
export async function runTurnEnd(
	cwd: string,
	files: string[] = [],
): Promise<TurnEndOutcome> {
	const ctx = await getMcpSessionContext();
	const host = createMcpHost();

	let registered = 0;
	for (const file of files) {
		const abs = path.isAbsolute(file) ? file : path.resolve(cwd, file);
		let lineCount = 1;
		try {
			lineCount = fs.readFileSync(abs, "utf8").split("\n").length;
		} catch {
			continue; // unreadable / deleted — skip
		}
		ctx.cacheManager.addModifiedRange(
			abs,
			{ start: 1, end: lineCount },
			true,
			cwd,
			ctx.runtime.telemetrySessionId,
		);
		registered++;
	}

	await handleTurnEnd({
		ctxCwd: cwd,
		getFlag: host.getFlag,
		dbg: noop,
		runtime: ctx.runtime,
		cacheManager: ctx.cacheManager,
		knipClient: ctx.clients.knipClient,
		deadCodeClients: ctx.clients.deadCodeClients,
		depChecker: ctx.clients.depChecker,
		testRunnerClient: ctx.clients.testRunnerClient,
		resetLSPService,
		resetFormatService,
	});

	return {
		turnEnd: joinMessages(consumeTurnEndFindings(ctx.cacheManager, cwd)),
		tests: joinMessages(consumeTestFindings(ctx.cacheManager, cwd)),
		filesRegistered: registered,
	};
}
