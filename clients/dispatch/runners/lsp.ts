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
import { exceedsLspSyncLimits } from "../../lsp/content-limits.js";
import {
	primaryUnavailableCause,
	readBoundToCurrentDisk,
	touchCompletedConfirmationPolicy,
	touchCoverageGap,
	warmAnswerBinding,
} from "../../lsp/diagnostic-binding.js";
import { getLSPService } from "../../lsp/capabilities.js";
import { disabledPrimaries } from "../../lsp/session-roots.js";
import { LSP_SERVERS } from "../../lsp/server.js";
import {
	describePythonCompileWithheld,
	detectPythonTargetVersion,
	partitionOutrankedPythonCompileVerdicts,
	recordPythonCompileVerdictDrop,
} from "../../python-environment.js";
import { RUNTIME_CONFIG } from "../../runtime-config.js";
import { PRIORITY } from "../priorities.js";
import { resolveRunnerPath } from "../runner-context.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import {
	faultResult,
	findingsResult,
	spanOverlapsModifiedRanges,
} from "../types.js";
import { convertLspDiagnostics } from "../utils/lsp-diagnostics.js";
import { demoteLanguageServerRows } from "../../lsp/inferred-project.js";
import type { TsserverProjectIdentity } from "../../lsp/tsserver-sync.js";
import {
	configDisabledAuxiliaryLspServerIds,
	dropExcludedServers,
	enabledAuxiliaryLspServerIds,
	retagAuxiliaryDiagnostics,
} from "../auxiliary-lsp.js";
import { readFileContent } from "./utils.js";
import {
	tryWarmAttachedCodeActions,
	tryWarmAttachedDiagnostics,
} from "../../warm-attach.js";
import { contentHash, WARM_CODE_ACTION_LOOKUP_LIMIT } from "../../mcp/ipc.js";

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
			// #4403: no server is selected, but a primary the operator disabled
			// would have served the file. Say so; it is not "no LSP here".
			const { disabledServerIds: disabledPrimaryServerIds } = disabledPrimaries(
				ctx.filePath,
			);
			return {
				status: "skipped",
				diagnostics: [],
				semantic: "none",
				...(disabledPrimaryServerIds.length > 0 && {
					primaryUnavailableCause: "disabled" as const,
					disabledPrimaryServerIds,
				}),
			};
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
		let inconclusiveServerIds: readonly string[] = [];
		// #4403: set when the touch says no primary answered (`primary-unavailable`).
		let primaryUnavailable:
			| Pick<
					RunnerResult,
					"primaryUnavailableCause" | "disabledPrimaryServerIds"
			  >
			| undefined;
		// #1470/#1493: server ids the touch carries no evidence for — an auxiliary
		// whose push wait our aux grace timer cut off (#1470), or one that stayed
		// silent with no stored publication for this content (#1493). The touch is
		// NOT inconclusive (the primary answered, and its findings below are real),
		// so this is tracked separately: the only claim it invalidates is "0
		// diagnostics means clean".
		let unconfirmedServerIds: readonly string[] = [];
		let deferredServerIds: readonly string[] = [];
		// #5008: did the PRIMARY answer these bytes? A collecting touch says so by
		// completing its confirmation policy (`confirmed`, or `partial` when only
		// an auxiliary went missing) — the one owner of that question. Only that
		// verdict retires a recorded blocker of the primary's; an unconfirmed
		// auxiliary withdraws the claim of full coverage, not the primary's answer.
		// A touch that says neither (`inconclusive` names the negative evidence,
		// handled below) keeps the pre-#5008 reading.
		let primaryAnswered = false;
		// #5008 review r2 (F4): `confirmation` says the primary ANSWERED;
		// `binding` says whether that answer was computed for THESE bytes. They
		// are attached independently (`clients/lsp/index.ts` sets both under the
		// same `collected !== undefined`), so a version-less primary whose publish
		// describes the previous revision produces `confirmation: "partial"`
		// beside `boundToCurrentDisk: false`. An answer for other bytes is not an
		// observation of these — the contributor filter below withholds its rows
		// (#4231, #5017) — so it withholds the verdict: `keepUnobserved`
		// otherwise retires a live recorded blocker on it. Absent or "unknown"
		// keeps the pre-r2 reading; only an explicit `false` withholds it.
		let primaryAnswerStale = false;
		let usedWarmAttach = false;
		// #4645: the warm incumbent's answer to the membership probe this runner
		// may not send itself; it stands in for that probe below.
		let incumbentProjectIdentity: TsserverProjectIdentity | undefined;
		let failureReason = "";
		// #3481: when the synced bytes were read, for the notify queue's order.
		const readStamp = performance.now();
		const content = readFileContent(ctx.filePath);
		if (!content) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		// #3405 r2: was an inline second copy of the pipeline's byte/line
		// predicate. One module owns the bound now (M3406-1's root cause was that
		// a third writer could be added with neither copy); the SKIP is still this
		// runner's own policy.
		if (exceedsLspSyncLimits(content).tooLarge) {
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
			if (attached?.available) {
				incumbentProjectIdentity = attached.response.projectIdentity;
			}
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
			// #4944: the incumbent answers every auxiliary; a switched-off one's
			// rows and coverage-gap name are not this process's answer.
			const answer = attached?.available
				? dropExcludedServers(
						attached.response,
						configDisabledAuxiliaryLspServerIds((f) => ctx.pi.getFlag(f)),
					)
				: undefined;
			const touched = answer
				? {
						diags: answer.diagnostics,
						// #5008: `confirmation` is what says the PRIMARY answered
						// (`primaryAnswered` below). The incumbent's DTO carries it for
						// exactly this reason, and dropping it here would read every warm
						// answer as a primary that never completed its policy — the #1179
						// side-channel loss class, one field further on.
						...(answer.confirmation !== undefined && {
							confirmation: answer.confirmation,
						}),
						...(answer.unconfirmedServerIds !== undefined && {
							unconfirmedServerIds: answer.unconfirmedServerIds,
						}),
						// #5030: the incumbent's content binding, so a stale-bound answer
						// takes the same withholding below as a local one. An incumbent
						// that sends none reads as not current (`warmAnswerBinding`).
						binding: warmAnswerBinding(answer),
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
						readStamp,
					});
			if (touched === undefined) {
				lspClientReady = false;
			} else {
				lspDiags = touched.diags;
				diagnosticsInconclusive = touched.inconclusive === true;
				inconclusiveServerIds = touched.inconclusiveServerIds ?? [];
				if (touched.inconclusiveReason === "primary-unavailable") {
					const disabledPrimaryServerIds =
						touched.disabledPrimaryServerIds ?? [];
					primaryUnavailable = {
						primaryUnavailableCause:
							touched.primaryUnavailableCause ??
							primaryUnavailableCause(
								inconclusiveServerIds,
								disabledPrimaryServerIds,
							),
						...(disabledPrimaryServerIds.length > 0 && {
							disabledPrimaryServerIds,
						}),
					};
				}
				unconfirmedServerIds = [
					...new Set([
						...touchCoverageGap(touched),
						...(diagnosticsInconclusive ? inconclusiveServerIds : []),
					]),
				];
				deferredServerIds = touched.deferredServerIds ?? [];
				// #5051: the cascade's confirmed-touch display reads the same
				// verdict through the same reader.
				primaryAnswerStale = readBoundToCurrentDisk(touched) === false;
				primaryAnswered =
					touchCompletedConfirmationPolicy(touched) && !primaryAnswerStale;
				if (primaryAnswerStale) {
					// #4231, #5017: a stale-bound answer is not an observation of these
					// bytes, so a row stays only with provenance that its server
					// answered them. An inconclusive touch names the servers that did
					// not (#4231: an inconclusive primary may contribute its last-known
					// diagnostics while its wait is wedged), and the service attributes
					// each row, so the other attributed rows stand. A touch that
					// completed its policy against older bytes names none, so no row
					// has that provenance and every row is withheld: the run then takes
					// the no-rows arm below, which reaches no verdict. Without both
					// pieces of provenance, fail closed rather than publish a stale
					// finding from the aggregate binding (#5017: `hasErrors` read such
					// rows as a `failed` verdict, and `keepUnobserved` retired a live
					// recorded blocker on findings about other bytes).
					// #5034 r3 (F7): a `primary-unavailable` touch names primaries that
					// were never acquired (`resolveTouchVerdict` keeps no wait or notify
					// id), so they contributed no row and no binding: the stale binding
					// is a fallback's or an auxiliary's, and no row has the provenance.
					const namesStaleContributor =
						diagnosticsInconclusive &&
						touched.inconclusiveReason !== "primary-unavailable";
					const unconfirmed = new Set(unconfirmedServerIds);
					const currentContentDiags: typeof lspDiags = [];
					for (const diagnostic of lspDiags) {
						if (
							namesStaleContributor &&
							diagnostic.serverId !== undefined &&
							!unconfirmed.has(diagnostic.serverId)
						) {
							currentContentDiags.push(diagnostic);
						}
					}
					lspDiags = currentContentDiags;
				}
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

		// #4638: the project's declared syntax level outranks jedi's own `compile`
		// verdict on this lane exactly as it does on the probe. The rule and its
		// record belong to the declaration's owner, so the two lanes cannot disagree
		// about which rows are evidence.
		// The drop is disclosed on this lane (#4638 r3 N2): with the only row
		// withheld the result would otherwise be `succeeded` with no diagnostics, an
		// edit that reads clean while the ledger alone knows better. The dispatcher
		// renders the sentence inline beside the blocker output.
		let withheldNotice: string | undefined;
		if (lspDiags.length > 0) {
			const declared = await detectPythonTargetVersion(diagnosticPath);
			const { kept, dropped } = partitionOutrankedPythonCompileVerdicts(
				lspDiags,
				declared,
			);
			if (dropped > 0 && declared) {
				recordPythonCompileVerdictDrop(diagnosticPath, declared, dropped);
				lspDiags = kept;
				withheldNotice = describePythonCompileWithheld(dropped, declared);
			}
		}

		if (serverFailed) {
			return faultResult(
				{ kind: "server_error", failureMessage: failureReason },
				{
					id: `lsp:server-error:0`,
					message: `LSP server failed: ${failureReason}`,
					filePath: diagnosticPath,
					line: 1,
					column: 1,
					tool: "lsp",
				},
			);
		}

		if (!lspClientReady) {
			// No answer from the LSP — reporting "succeeded with 0 diagnostics"
			// would read as a clean bill of health when we simply didn't get a
			// reply. Report "skipped" so the coverage notice can flag the gap and
			// the next edit re-checks once the server has warmed; any diagnostics
			// published late still land in the client cache and surface then.
			// #4403: no client was ready, and a disabled primary would have made
			// the touch say so, so the language server could not start in time.
			return {
				status: "skipped",
				diagnostics: [],
				semantic: "none",
				primaryUnavailableCause: "unstarted",
			};
		}

		if (diagnosticsInconclusive && lspDiags.length === 0) {
			// The touch ran and a client was ready, but the notify write and/or
			// diagnostics wait hit their deadline without any collected findings.
			// With no answered diagnostics, report "skipped" so the coverage notice
			// flags the gap instead of reading this as a confirmed clean result (#570).
			// #4403: when no primary answered at all, the result says why.
			// #4484: a skip without a stated reason reaches no verdict
			// (`reachedNoVerdict`), so this empty result never retires a recorded
			// blocker.
			return {
				status: "skipped",
				diagnostics: [],
				semantic: "none",
				...primaryUnavailable,
			};
		}

		if (lspDiags.length === 0) {
			// #5008: the primary's empty answer is a verdict about ITS blockers even
			// while an auxiliary is unconfirmed or deferred. The named ids are what
			// withdraws the claim of FULL coverage (the coverage notice) and keeps
			// that auxiliary's own recorded blockers.
			if (deferredServerIds.length > 0) {
				return {
					status: primaryAnswered ? "succeeded" : "deferred",
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
				// the security lane. The correlated server ids therefore keep the run
				// from claiming FULL coverage (the coverage notice names them), and the
				// result stays `skipped` unless the touch says the primary completed its
				// policy (#5008) — a silent scanner withdraws the coverage claim, never
				// the primary's answer. Nothing is thrown away either way: the primary
				// answered with zero findings, so there is nothing to report; when it
				// DOES have findings the branch below still reports them, which is how a
				// trustworthy primary stays trustworthy under a silent scanner.
				return {
					status: primaryAnswered ? "succeeded" : "skipped",
					diagnostics: [],
					semantic: "none",
					unconfirmedServerIds: [...unconfirmedServerIds],
				};
			}
			if (primaryAnswerStale) {
				// #5008 review r2 (F4): nothing is unconfirmed and no scanner is
				// deferred, so no id names the gap — only the binding says the answer
				// describes other bytes. `skipped` is this runner's no-verdict status
				// (`reachedNoVerdict`), which is what keeps the primary's recorded
				// blockers pending instead of retiring them on a clean claim. A
				// stale-bound findings run lands here too, its rows withheld (#5017).
				return {
					status: "skipped",
					diagnostics: [],
					semantic: "none",
				};
			}
			return {
				status: "succeeded",
				diagnostics: [],
				semantic: "none",
				rawOutput: "no-diagnostics",
				...(withheldNotice !== undefined && { withheldNotice }),
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
		// #1645 review F2: this runner does NOT probe under warm attach. There,
		// diagnostics came from an already-running remote session over IPC and no
		// local client exists — so the probe would have to spawn a whole tsserver
		// fleet to answer, breaking this branch's spawn-free contract (see the
		// comment below), and the answer it spawned for would be the NEW server's
		// project resolution, not the warm session's. A meaningless answer bought
		// with a process is worse than no answer.
		// #4645: the probe is asked where the answer lives instead. The incumbent
		// owns the live client, sends its `projectIdentity` beside the server's
		// raw rows, and this reader seeds the pipeline's identity memo with it, so
		// the one pipeline runs here exactly as on a local read: the environment
		// rule first, then membership. This reader still passes no `service`.
		// Against an incumbent built before #4645 no answer arrives and the rows
		// render as they did before #1640 (the mixed-build gap).
		// #4532: the environment-gap rule rides the same pipeline and is NOT
		// gated on warm attach: it asks one filesystem question about the file's
		// own directory, needs nothing from the remote session, and left behind
		// `usedWarmAttach` it kept the reported `🔴 STOP` on this route (round 4).
		// `demoteLanguageServerRows` runs it on every route and the membership
		// probe only where a local client may answer (round 5, review F3).
		const validLspDiags = (
			await demoteLanguageServerRows(rawValidLspDiags, {
				filePath: diagnosticPath,
				cwd: ctx.cwd,
				...(!usedWarmAttach && { service: lspService }),
				...(incumbentProjectIdentity !== undefined && {
					identityCache: new Map([[diagnosticPath, incumbentProjectIdentity]]),
				}),
			})
		).rows;
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
		// #4481 r2: each converted diagnostic's raw LSP range (1:1, as above),
		// captured before the re-tag drops suppressed entries, so the edit-scope
		// filter below reads the match's full span, not only its start line.
		const rawRangeByDiagnostic = new Map(
			diagnostics.map((d, i) => [d, validLspDiags[i]?.range]),
		);
		const retaggedDiagnostics = retagAuxiliaryDiagnostics(
			diagnostics,
			validLspDiags,
			content,
			{ cwd: ctx.cwd, fileRole: ctx.fileRole },
		);
		// #4481: the ast-grep LSP runs the same rule catalog as the
		// ast-grep-napi runner, so on the per-edit pass its blocker whose span
		// does not overlap the edited lines is dropped, as napi and tree-sitter
		// drop theirs. Language-server diagnostics (tool "lsp") and every other
		// auxiliary stay unscoped by design: an edit can cause a type error or a
		// finding at a line it never touched.
		// #4484 r2: the gate decides delivery only; what it withholds rides out
		// as `outOfEditScope`, still observed, for the recorded-blocker carry.
		const keptDiagnostics: Diagnostic[] = [];
		const outOfEditScope: Diagnostic[] = [];
		for (const d of retaggedDiagnostics) {
			const range =
				ctx.blockingOnly && d.tool === "ast-grep" && d.semantic === "blocking"
					? rawRangeByDiagnostic.get(d)
					: undefined;
			const inScope =
				range === undefined ||
				spanOverlapsModifiedRanges(
					range.start.line + 1,
					(range.end?.line ?? range.start.line) + 1,
					ctx.modifiedRanges,
				);
			(inScope ? keptDiagnostics : outOfEditScope).push(d);
		}

		const hasErrors = keptDiagnostics.some((d) => d.semantic === "blocking");
		const resultSemantic = hasErrors
			? "blocking"
			: keptDiagnostics.length > 0
				? "warning"
				: "none";

		return {
			// "failed" here means the file has blocking type errors — the check ran
			// fine; findingsResult tags it so it never reads as a runner crash.
			...findingsResult(keptDiagnostics, {
				status: hasErrors
					? "failed"
					: deferredServerIds.length > 0 && !primaryAnswered
						? "deferred"
						: "succeeded",
				semantic: resultSemantic,
			}),
			// #5008: findings a run DOES report do not make it a verdict about the
			// primary's own recorded blockers when the primary did not answer. A
			// `failed` run with its own findings is `hasUsableResult`, so without
			// this flag it would retire them (the inverse cell of the state table),
			// and a settled collect-later run would too. `inconclusive` is the
			// touch's own positive evidence that a primary deadline lapsed or no
			// primary was acquired — a touch that says neither keeps the pre-#5008
			// reading (a diagnostics-unsupported primary, an incumbent built before the
			// confirmation field), which is today's behaviour.
			...(diagnosticsInconclusive && { inconclusive: true as const }),
			...(unconfirmedServerIds.length > 0 && {
				unconfirmedServerIds: [...unconfirmedServerIds],
			}),
			...(deferredServerIds.length > 0 && {
				deferredServerIds: [...deferredServerIds],
			}),
			...(outOfEditScope.length > 0 && { outOfEditScope }),
			...(withheldNotice !== undefined && { withheldNotice }),
		};
	},
};

export default lspRunner;
