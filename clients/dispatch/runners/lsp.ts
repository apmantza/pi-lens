/**
 * Unified LSP Runner for pi-lens
 *
 * Handles type checking for ALL LSP-supported languages:
 * - TypeScript/JavaScript (typescript-language-server)
 * - Python (pyright/pylsp)
 * - Go (gopls)
 * - Rust (rust-analyzer)
 * - Ruby, PHP, C#, Java, Kotlin, Swift, Dart, etc.
 *
 * Replaces language-specific runners (pyright, etc.) with a single
 * unified runner that delegates to the LSP service.
 */

import { logExtension } from "../../extension-log.js";
import { getLspCapableKinds } from "../../language-policy.js";
import { touchCoverageGap } from "../../lsp/diagnostic-binding.js";
import { getLSPService } from "../../lsp/index.js";
import { LSP_SERVERS } from "../../lsp/server.js";
import { RUNTIME_CONFIG } from "../../runtime-config.js";
import { PRIORITY } from "../priorities.js";
import { resolveRunnerPath } from "../runner-context.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import { convertLspDiagnostics } from "../utils/lsp-diagnostics.js";
import { demoteInferredProjectDiagnostics } from "../../lsp/inferred-project.js";
import {
	enabledAuxiliaryLspServerIds,
	retagAuxiliaryDiagnostics,
} from "../auxiliary-lsp.js";
import { readFileContent } from "./utils.js";
import {
	tryWarmAttachedCodeActions,
	tryWarmAttachedDiagnostics,
} from "../../warm-attach.js";
import { contentHash, WARM_CODE_ACTION_LOOKUP_LIMIT } from "../../mcp/ipc.js";

const LSP_MAX_FILE_BYTES = RUNTIME_CONFIG.pipeline.lspMaxFileBytes;
const LSP_MAX_FILE_LINES = RUNTIME_CONFIG.pipeline.lspMaxFileLines;
const LSP_SPAWN_BUDGET_MS = RUNTIME_CONFIG.pipeline.lspSpawnBudgetMs;

// Diagnostics-wait cap for the dispatch lsp-runner. Bounded so a slow LSP
// (typescript-language-server on large monorepos has been observed >7 s)
// can't dominate the per-edit pipeline budget. Diagnostics that arrive
// after the cap still land in the client's cache and surface on the
// next edit. Overridable via PI_LENS_LSP_DIAGNOSTICS_MAX_WAIT_MS.
export const LSP_DIAGNOSTICS_WAIT_MS = 2500;
const MAX_CODE_ACTION_TITLES = 3;

/**
 * Fixed margin above the worst-case cold-spawn-plus-diagnostics wait, so
 * scheduling jitter alone can't reopen the F2 race below.
 */
const LSP_COLD_SPAWN_MARGIN_MS = 5_000;

/**
 * This runner's own dispatch wall-clock budget. `runRunner` in
 * `dispatcher.ts` races `runner.timeoutMs ?? RUNNER_TIMEOUT_MS` (30s)
 * against `runner.run()` for the WHOLE call — reading the file, waiting for
 * a client (bounded by `LSP_SPAWN_BUDGET_MS`, raised per-server via
 * `LSPServerInfo.clientWaitTimeoutMs`), then waiting for diagnostics
 * (`LSP_DIAGNOSTICS_WAIT_MS`).
 *
 * Left undeclared, this runner inherited the shared 30s default. A server
 * whose `clientWaitTimeoutMs` exceeds that — Prisma's 40s, Vue's 30s
 * (#2169, #2176) — could never actually use its own raised wait: the outer
 * race always fired first, at 30s, so raising a server's floor without also
 * raising this ceiling was a no-op on the real dispatch path (fix-round F2,
 * #2233). Derive the ceiling from the registry instead of a second
 * hand-picked literal, so the next slow server's `clientWaitTimeoutMs` keeps
 * this budget correct automatically: the highest declared
 * `clientWaitTimeoutMs` (or the shared 5s default, whichever is larger),
 * plus the diagnostics wait that still runs after a cold spawn succeeds,
 * plus a fixed margin.
 *
 * This raises the failure-detection latency for every OTHER language's
 * hung-server case too (30s -> the value below), not just the five servers
 * that need the headroom — the tradeoff is stated in PR #2233's body. It
 * remains well inside the spread other dispatch runners already use
 * (pyright 75s, golangci-lint/dotnet-build/rust-clippy 90s).
 */
export const LSP_RUNNER_TIMEOUT_MS =
	Math.max(
		LSP_SPAWN_BUDGET_MS,
		...LSP_SERVERS.map((server) => server.clientWaitTimeoutMs ?? 0),
	) +
	LSP_DIAGNOSTICS_WAIT_MS +
	LSP_COLD_SPAWN_MARGIN_MS;

function normalizeActionTitle(title: string): string {
	return title.replace(/\s+/g, " ").trim();
}

function buildCodeActionSuggestion(
	actions: import("../../lsp/client.js").LSPCodeAction[],
): string | undefined {
	if (!actions.length) return undefined;
	const quickFixes = actions.filter((action) =>
		action.kind?.startsWith("quickfix"),
	);
	if (!quickFixes.length) return undefined;

	const titles = Array.from(
		new Set(
			quickFixes
				.map((action) => normalizeActionTitle(action.title))
				.filter((title) => title.length > 0),
		),
	).slice(0, MAX_CODE_ACTION_TITLES);

	if (!titles.length) return undefined;
	return `LSP quick fixes: ${titles.join("; ")}`;
}

const lspRunner: RunnerDefinition = {
	id: "lsp",
	// Derived from LANGUAGE_POLICY, never hand-maintained: the copy this
	// replaced had drifted (fish was lspCapable but absent, so getForKind
	// answered that no LSP runs on fish). Registering a language as lspCapable
	// is now the only step this seam needs (#1545).
	appliesTo: getLspCapableKinds(),
	priority: PRIORITY.LSP_PRIMARY,
	timeoutMs: LSP_RUNNER_TIMEOUT_MS,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const diagnosticPath = resolveRunnerPath(ctx.cwd, ctx.filePath);
		// Only run if LSP is not disabled via --no-lsp
		if (ctx.pi.getFlag("no-lsp")) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const lspService = getLSPService();

		// Fast capability check only — actual client creation happens when we
		// open the file below.
		if (!lspService.supportsLSP(ctx.filePath)) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		// Always sync current file content before reading diagnostics so dispatch
		// does not operate on stale LSP snapshots.
		let lspDiags: import("../../lsp/client.js").LSPDiagnostic[] = [];
		let serverFailed = false;
		// touchFile resolves to `undefined` when no LSP client was ready (a cold
		// spawn that didn't complete in the budget, or LSP unavailable for this
		// file) — distinct from `[]`, which means the server replied with zero.
		let lspClientReady = true;
		// True when touchFile ran but couldn't confirm its result within
		// budget (notify write and/or diagnostics wait timed out on at least
		// one spawned server) — an empty `lspDiags` in that case is NOT a
		// confirmed clean result and must not be reported as one (#570).
		let diagnosticsInconclusive = false;
		// #1470/#1493: server ids the touch carries no evidence for — an auxiliary
		// whose push wait our aux grace timer cut off (#1470), or one that stayed
		// silent with no stored publication for this content (#1493). The touch is
		// NOT inconclusive (the primary answered, and its findings below are real),
		// so this is tracked separately: the only claim it invalidates is "0
		// diagnostics means clean".
		let unconfirmedServerIds: readonly string[] = [];
		let deferredServerIds: readonly string[] = [];
		let usedWarmAttach = false;
		let failureReason = "";
		const content = readFileContent(ctx.filePath);
		if (!content) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const sizeBytes = Buffer.byteLength(content, "utf-8");
		const lineCount = content.split("\n").length;
		if (sizeBytes > LSP_MAX_FILE_BYTES || lineCount > LSP_MAX_FILE_LINES) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		// Cross-cutting auxiliary scanners (opengrep, …) attach alongside the
		// primary language server when enabled — collected on the with-auxiliary
		// path so their warm diagnostics merge into this same result.
		const auxiliaryServerIds = enabledAuxiliaryLspServerIds((f) =>
			ctx.pi.getFlag(f),
		);
		try {
			const attached = await tryWarmAttachedDiagnostics(
				ctx.filePath,
				content,
				Math.max(LSP_SPAWN_BUDGET_MS, LSP_DIAGNOSTICS_WAIT_MS),
			);
			usedWarmAttach = attached?.available === true;
			// #1179 (shape-5 structural fix): both branches normalize to the
			// `touchFile` wrapper shape. The warm-attach IPC branch resolves a plain
			// diagnostics array — `available` no longer implies a fully confirmed
			// answer: a `partial` confirmation (an auxiliary that never
			// reported — cut off by the grace timer, or silent) is served as
			// `available: true` too (the IPC gate at
			// `clients/mcp/ipc.ts:248` rejects only `inconclusive`). Carry the
			// incumbent's `unconfirmedServerIds` onto the wrapper so
			// `touchCoverageGap` below sees it — dropping it here is the same
			// false-clean defect already fixed at `clients/lsp/index.ts` (the
			// workspace sweep wrapper) and `tools/lsp-diagnostics.ts` (the tool
			// consumer); wrap it as `{ diags }`; the incumbent branch already
			// returns the wrapper.
			const touched = attached?.available
				? {
						diags: attached.response.diagnostics,
						...(attached.response.unconfirmedServerIds !== undefined && {
							unconfirmedServerIds: attached.response.unconfirmedServerIds,
						}),
					}
				: await lspService.touchFile(ctx.filePath, content, {
						diagnostics: "document",
						collectDiagnostics: true,
						clientScope:
							auxiliaryServerIds.length > 0 ? "with-auxiliary" : "primary",
						auxiliaryServerIds,
						maxClientWaitMs: LSP_SPAWN_BUDGET_MS,
						maxDiagnosticsWaitMs: LSP_DIAGNOSTICS_WAIT_MS,
						source: "dispatch-lsp-runner",
					});
			if (touched === undefined) {
				lspClientReady = false;
			} else {
				lspDiags = touched.diags;
				diagnosticsInconclusive = touched.inconclusive === true;
				unconfirmedServerIds = touchCoverageGap(touched);
				deferredServerIds = touched.deferredServerIds ?? [];
			}
		} catch (err) {
			serverFailed = true;
			failureReason = err instanceof Error ? err.message : String(err);
			if (
				failureReason.includes("spawn") ||
				failureReason.includes("exited") ||
				failureReason.includes("connection") ||
				failureReason.includes("JSON RPC")
			) {
				logExtension({
					subsystem: "lsp-runner",
					message: `LSP server failed for ${diagnosticPath}: ${failureReason}`,
					metadata: { filePath: diagnosticPath },
				});
			}
		}

		if (serverFailed) {
			return {
				status: "failed",
				failureKind: "server_error",
				failureMessage: failureReason.slice(0, 200),
				diagnostics: [
					{
						id: `lsp:server-error:0`,
						message: `LSP server failed: ${failureReason}`,
						filePath: diagnosticPath,
						line: 1,
						column: 1,
						severity: "error",
						semantic: "warning", // Don't block - fallback to other runners
						tool: "lsp",
					},
				],
				semantic: "warning",
			};
		}

		if (!lspClientReady) {
			// No answer from the LSP — reporting "succeeded with 0 diagnostics"
			// would read as a clean bill of health when we simply didn't get a
			// reply. Report "skipped" so the coverage notice can flag the gap and
			// the next edit re-checks once the server has warmed; any diagnostics
			// published late still land in the client cache and surface then.
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		if (diagnosticsInconclusive) {
			// The touch ran and a client was ready, but the notify write and/or
			// diagnostics wait hit their deadline before the server confirmed
			// completion — `lspDiags` (even if non-empty) is not a trustworthy
			// merged result. Same treatment as `!lspClientReady`: report
			// "skipped" rather than "succeeded" with a possibly-incomplete
			// diagnostics list, so the coverage notice flags the gap instead of
			// the footer reading this as a confirmed clean/partial result (#570).
			// Diagnostics that do arrive late still land in the client cache and
			// surface on the next edit.
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		if (lspDiags.length === 0) {
			if (deferredServerIds.length > 0) {
				return {
					status: "deferred",
					diagnostics: [],
					semantic: "none",
					unconfirmedServerIds: [...unconfirmedServerIds],
					deferredServerIds: [...deferredServerIds],
				};
			}
			if (unconfirmedServerIds.length > 0) {
				// #1470/#1493: an auxiliary never reported — cut off by the aux grace
				// timer, or silent with nothing published for this content — so this
				// empty merged result is missing whatever that scanner would have said.
				// A hung OR silent opengrep must not read as a clean bill of health on
				// the security lane. The empty result remains skipped, while the correlated
				// server ids let the coverage notice name the missing scanners once. Nothing
				// is thrown away: the primary answered with zero findings, so there is nothing to
				// report; when it DOES have findings the branches below still report
				// them (see the non-empty path), which is how a trustworthy primary
				// stays trustworthy under an auxiliary that never reported.
				return {
					status: "skipped",
					diagnostics: [],
					semantic: "none",
					unconfirmedServerIds: [...unconfirmedServerIds],
				};
			}
			return {
				status: "succeeded",
				diagnostics: [],
				semantic: "none",
				rawOutput: "no-diagnostics",
			};
		}

		// Convert LSP diagnostics to our format
		// Defensive: filter out malformed diagnostics that may lack range
		const rawValidLspDiags = lspDiags.filter(
			(d) => d.range?.start?.line !== undefined,
		);
		// #1640: the per-edit path renders the same authority as the mode=full
		// sweep, so it applies the same demotion. Costs one bounded `projectInfo`
		// request, and only when the file already has a TypeScript ERROR — an edit
		// that type-checks clean pays nothing.
		//
		// #1645 review F2: NOT under warm attach. There, diagnostics came from an
		// already-running remote session over IPC and no local client exists — so
		// the probe would have to spawn a whole tsserver fleet to answer, breaking
		// this branch's spawn-free contract (see the comment below), and the
		// answer it spawned for would be the NEW server's project resolution, not
		// the warm session's. A meaningless answer bought with a process is worse
		// than no answer, so the warm-attach path keeps pre-#1640 rendering. This
		// is a known gap, recorded on the issue rather than papered over with an
		// "unverified" label that would fire on every warm-attach file including
		// the properly configured majority.
		const validLspDiags = usedWarmAttach
			? rawValidLspDiags
			: await demoteInferredProjectDiagnostics(rawValidLspDiags, {
					filePath: diagnosticPath,
					cwd: ctx.cwd,
					service: lspService,
				});
		const fixSuggestionByIndex = new Map<number, string>();

		// #1640: read severity off the RAW list. A demoted diagnostic is still
		// worth a quick-fix suggestion — the demotion changes its authority, not
		// whether tsserver can offer a fix. Indexes align 1:1 with `validLspDiags`.
		const blockingDiagIndexes = rawValidLspDiags
			.map((d, idx) => ({ d, idx }))
			.filter(({ d }) => d.severity === 1)
			.slice(0, WARM_CODE_ACTION_LOOKUP_LIMIT);

		if (usedWarmAttach) {
			// Diagnostics have already succeeded. Code actions are optional
			// enrichment, so ANY IPC failure degrades to today's skip without
			// promoting the attached session to a local LSP fleet.
			const ranges = blockingDiagIndexes.map(({ d }) => ({
				start: d.range.start,
				end: d.range.end ?? d.range.start,
			}));
			const result = await tryWarmAttachedCodeActions(
				ctx.filePath,
				contentHash(content),
				ranges,
				LSP_DIAGNOSTICS_WAIT_MS,
			);
			if (result?.available) {
				result.response.actions.forEach((actions, responseIndex) => {
					const diagnosticIndex = blockingDiagIndexes[responseIndex]?.idx;
					const suggestion = buildCodeActionSuggestion(actions);
					if (diagnosticIndex !== undefined && suggestion) {
						fixSuggestionByIndex.set(diagnosticIndex, suggestion);
					}
				});
			}
		} else {
			await Promise.all(
				blockingDiagIndexes.map(async ({ d, idx }) => {
					try {
						const start = d.range.start;
						const end = d.range.end ?? d.range.start;
						const actions = await lspService.codeAction(
							ctx.filePath,
							start.line,
							start.character,
							end.line,
							end.character,
						);
						const suggestion = buildCodeActionSuggestion(actions);
						if (suggestion) {
							fixSuggestionByIndex.set(idx, suggestion);
						}
					} catch {
						// Best-effort enrichment only; base diagnostics remain authoritative.
					}
				}),
			);
		}

		const diagnostics: Diagnostic[] = convertLspDiagnostics(
			validLspDiags,
			diagnosticPath,
			{ fixSuggestionByIndex },
		);

		// convertLspDiagnostics maps validLspDiags 1:1, so re-tag any
		// auxiliary-sourced diagnostics (opengrep emits source "Semgrep", …) with
		// their tool id + semantic policy — language-server diagnostics keep "lsp".
		// #692: shared with the scan/sweep reconcile paths (`retagAuxiliaryDiagnostics`
		// in `../auxiliary-lsp.js`) so a scan-reconciled aux finding gets identical
		// tool/semantic/defectClass tagging instead of keeping tool "lsp".
		const keptDiagnostics = retagAuxiliaryDiagnostics(
			diagnostics,
			validLspDiags,
			content,
			{ cwd: ctx.cwd, fileRole: ctx.fileRole },
		);

		const hasErrors = keptDiagnostics.some((d) => d.semantic === "blocking");
		const resultSemantic = hasErrors
			? "blocking"
			: keptDiagnostics.length > 0
				? "warning"
				: "none";

		return {
			status: hasErrors
				? "failed"
				: deferredServerIds.length > 0
					? "deferred"
					: "succeeded",
			// "failed" here means the file has blocking type errors — the check ran
			// fine. Tag it so the smell analyzer doesn't read it as a runner crash.
			failureKind: hasErrors ? "blocking_diagnostics" : undefined,
			diagnostics: keptDiagnostics,
			semantic: resultSemantic,
			...(unconfirmedServerIds.length > 0 && {
				unconfirmedServerIds: [...unconfirmedServerIds],
			}),
			...(deferredServerIds.length > 0 && {
				deferredServerIds: [...deferredServerIds],
			}),
		};
	},
};

export default lspRunner;
