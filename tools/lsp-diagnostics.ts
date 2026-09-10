/**
 * lsp_diagnostics tool definition
 *
 * Proactive LSP diagnostics check — single files or directories.
 * Adopted from code-yeongyu/pi-lsp-client design.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
	getProjectIgnoreMatcher,
	isExcludedDirName,
} from "../clients/file-utils.js";
import {
	getLSPService,
	groupFilesByPrimaryServer,
	runPerServerGroups,
} from "../clients/lsp/index.js";
import {
	buildScopeKey,
	createWorkspaceDiagnosticsCacheContext,
	type WorkspaceDiagnosticsCacheContext,
} from "../clients/lsp/workspace-diagnostics-cache.js";
import {
	getServersForFileWithConfig,
	primaryServerId,
} from "../clients/lsp/config.js";
import {
	combineAbortSignals,
	withDeadline,
} from "../clients/deadline-utils.js";
import {
	applyAuxiliarySuppressions,
	retagAuxiliaryDiagnostics,
} from "../clients/dispatch/auxiliary-lsp.js";
import { detectFileRole } from "../clients/file-role.js";
import type { LSPDiagnostic } from "../clients/lsp/client.js";
import {
	hashDiagnosticContent,
	touchCompletedConfirmationPolicy,
	touchCoverageGap,
	type DiagnosticBinding,
	type TouchFileResult,
} from "../clients/lsp/diagnostic-binding.js";
import { classifyCascadeWaitTier } from "../clients/lsp/wait-policy/index.js";
import { attemptTsserverSyncDiagnostics } from "../clients/lsp/tsserver-sync.js";
import { convertLspDiagnostics } from "../clients/dispatch/utils/lsp-diagnostics.js";
import { demoteInferredProjectDiagnostics } from "../clients/lsp/inferred-project.js";
import {
	isBlocking,
	reconcileScanDiagnostics,
} from "../clients/widget-state.js";
import { makeProgressReporter } from "./scan-progress.js";
import {
	isWarmAttached,
	tryWarmAttachedDiagnostics,
} from "../clients/warm-attach.js";
import {
	extensionsForLanguage,
	SCAN_LANGUAGE_PRIORITY,
} from "../clients/language-registry.js";

const MAX_FILES = 100;
const MAX_BATCH_FILES = 100;
const MAX_DIAGNOSTICS = 200;
const DEFAULT_BATCH_CONCURRENCY = 8;
const MAX_BATCH_CONCURRENCY = 16;
const DEFAULT_BATCH_FILE_DEADLINE_MS = 15_000;

// LSP severities: 1=Error, 2=Warning, 3=Information, 4=Hint
const SEVERITY_NAMES: Record<number, string> = {
	1: "error",
	2: "warning",
	3: "information",
	4: "hint",
};

type LspHealthLike = {
	health?: string;
	serverCountAttempted?: number;
	serverCountReady?: number;
	candidateServerIds?: string[];
	mergedCount?: number;
};

type BatchOptions = {
	concurrency: number;
	waitMs?: number;
	signal?: AbortSignal;
	onProgress?: (completed: number, total: number) => void;
	// #571/#1198: threaded down to `collectFileDiagnosticResult`, which reserves
	// one per-file token before awaiting the LSP result.
	nextWriteIndex?: () => number;
	// "primary" skips every cross-cutting auxiliary scanner (ast-grep,
	// opengrep, zizmor, typos, marksman) and only touches the file's actual
	// language server — for when the caller just wants "does the type
	// checker/compiler confirm this clean", not a full security/lint pass.
	serverScope?: "primary" | "all";
	// #671: project root the workspace-diagnostics cache is rooted under
	// (`getProjectDataDir(cwd)`) — threaded down to `collectBatchDiagnostics`
	// so its per-file cache context lands in the same on-disk store
	// `runWorkspaceDiagnostics` (`lens_diagnostics mode=full`) reads/writes,
	// letting a file swept by either tool benefit the other's next sweep.
	cwd?: string;
	// #1561: per-file blocker-retire hook, threaded so a batch/directory sweep
	// retires the same stale verdicts a single-file check does. A sibling surface
	// left without it would be the very defect this fixes, one call site over.
	onConfirmedNoBlockers?: (info: ConfirmedNoBlockersInfo) => void;
};

type FileDiag = {
	file: string;
	line?: number;
	character?: number;
	severity: number;
	message: string;
	source?: string;
	serverId?: string;
	code?: string | number;
};

type FileDiagnosticResult = {
	file: string;
	diagnostics: FileDiag[];
	outcome?: BatchFileOutcome;
	unavailable?: string;
	error?: string;
	inconclusiveReason?: string;
	/**
	 * #533: discriminated per-file outcome, mirroring the #240 doctrine at the
	 * LSP layer (found | clean | unresolved) up through the tool's aggregation.
	 * "found" = diagnostics.length > 0 (self-evident, doesn't need the field).
	 * "clean" = an empty result the server actually confirmed (a pull server, or
	 * a push server whose empty result isn't from a known-silent-on-clean tier).
	 * "unconfirmed" = an empty result from a push-only, silent-on-clean server
	 * (classic typescript-language-server) — indistinguishable from "still
	 * analyzing" or "never asked". Never render this bucket as "0 diagnostics".
	 */
	confirmation?: "clean" | "unconfirmed";
	/**
	 * #570: true when `confirmation === "unconfirmed"` specifically because
	 * the priming LSP check TIMED OUT (notify write and/or diagnostics wait
	 * hit its deadline), as opposed to the server being a known silent-on-
	 * clean tier. Both land in the same "unconfirmed" bucket for counting
	 * purposes, but the reason differs and the rendered text should say so.
	 */
	timedOut?: boolean;
	/**
	 * The file's actual language server (e.g. "typescript"), as opposed to a
	 * cross-cutting auxiliary scanner (ast-grep, opengrep, ...). Used to split
	 * `diagnostics` into a primary-confirmation section and an auxiliary-
	 * findings section so a page of aux noise never buries whether the real
	 * type checker/compiler confirmed the file clean.
	 */
	primaryServerId?: string;
	diagnosticsUnsupported?: boolean;
};

/** The only per-file states an explicit batch exposes to an agent. */
type BatchFileOutcome =
	| "clean"
	| "findings"
	| "unsupported"
	| "unavailable"
	| "failed"
	| "inconclusive";

function batchFileDeadlineMs(): number {
	const raw = Number(process.env.PI_LENS_LSP_BATCH_FILE_MS);
	return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_BATCH_FILE_DEADLINE_MS;
}

// #646: `primaryServerId` moved to clients/lsp/config.ts so this tool and
// tools/lens-diagnostics.ts's mode=full sweep share the exact same
// primary-vs-auxiliary classification instead of each keeping its own copy.

function lspUnavailableMessage(
	filePath: string,
	health: LspHealthLike | undefined,
): string | undefined {
	if (!health || !String(health.health ?? "").startsWith("no_clients")) {
		return undefined;
	}
	const candidates = health.candidateServerIds?.length
		? ` candidates=${health.candidateServerIds.join(",")}`
		: "";
	const reason =
		(health.serverCountAttempted ?? 0) === 0
			? "no LSP server configured"
			: "no LSP client is currently ready";
	const stale =
		(health.mergedCount ?? 0) > 0
			? " Showing stale last-known diagnostics below."
			: " No diagnostics were collected.";
	return `LSP unavailable for ${filePath}: ${reason}; ready=${health.serverCountReady ?? 0}/${health.serverCountAttempted ?? 0}.${candidates}.${stale}`;
}

function boundedPositiveInt(
	value: unknown,
	fallback: number,
	min: number,
	max: number,
): number {
	const parsed = typeof value === "number" ? Math.floor(value) : Number.NaN;
	if (!Number.isFinite(parsed)) return fallback;
	return Math.max(min, Math.min(max, parsed));
}

/**
 * #631: fan `mapper` out across `items` (a batch/directory file list) while
 * respecting per-LSP-server affinity — previously this was a flat,
 * server-oblivious bounded-concurrency pool (up to `concurrency` files
 * in flight at once, regardless of which server they belonged to). That let
 * a single-language batch (the common case) fire many concurrent touches at
 * the SAME shared, single-threaded LSP server — exactly the pattern #387
 * found doesn't parallelize (it queues server-side and cascades per-file
 * timeouts by queue position) and that `runWorkspaceDiagnostics` (the engine
 * behind `lens_diagnostics mode=full`) has been protected against since #387.
 *
 * Groups `items` by primary server via `groupFilesByPrimaryServer` (the same
 * grouping key `runWorkspaceDiagnostics` uses) and schedules them with
 * `runPerServerGroups` (both extracted from `clients/lsp/index.ts` so this
 * tool shares the real primitive instead of a second hand-copied
 * implementation): at most one in-flight `mapper` call per server group,
 * parallelized across distinct groups up to `concurrency`. A single-language
 * batch collapses to one group and runs effectively serially regardless of
 * `concurrency` — the CORRECT, intended #387 behavior, not a regression.
 *
 * Result order matches `items`' original order (not completion order),
 * matching the old flat pool's positional-assignment behavior — callers may
 * depend on `results[i]` corresponding to `items[i]`.
 *
 * #667: before a group's own per-file loop starts, calls the shared
 * `LSPService.ensureWarmForSweep` warm-check/ensure-warm step (the same one
 * `runWorkspaceDiagnostics` uses for `lens_diagnostics mode=full`) against
 * the group's first file — a no-op when that group's primary server already
 * demonstrated readiness earlier this session, one bounded warm-up round
 * trip otherwise. Fixes the first-few-files-eat-cold-start-timeouts pattern
 * for THIS tool's batch/directory sweep the same way #667 fixed it for the
 * workspace-diagnostics sweep.
 */
async function mapWithConcurrency<R>(
	items: string[],
	concurrency: number,
	mapper: (item: string, index: number) => Promise<R>,
	lspService: NonNullable<ReturnType<typeof getLSPService>> | undefined,
	signal?: AbortSignal,
	onProgress?: (completed: number, total: number) => void,
): Promise<R[]> {
	const results: R[] = [];
	let completed = 0;
	// Multiple original indices can map to the same file path (duplicate
	// entries in an explicit `paths` batch) — track them as a per-file queue
	// so each occurrence still lands in its own original slot.
	const pendingIndices = new Map<string, number[]>();
	items.forEach((item, index) => {
		const queue = pendingIndices.get(item);
		if (queue) queue.push(index);
		else pendingIndices.set(item, [index]);
	});
	const groups = groupFilesByPrimaryServer(items);
	await runPerServerGroups(
		groups,
		concurrency,
		async (group) => {
			if (signal?.aborted) return;
			const first = group.files[0];
			if (
				first &&
				lspService &&
				!isWarmAttached() &&
				typeof lspService.ensureWarmForSweep === "function"
			) {
				await lspService.ensureWarmForSweep(first, { signal });
				if (signal?.aborted) return;
			}
			for (const item of group.files) {
				// Honor cancellation (Escape / turn abort): stop pulling new items
				// rather than grind the whole batch. Completed entries are returned.
				if (signal?.aborted) return;
				const index = pendingIndices.get(item)!.shift()!;
				results[index] = await mapper(item, index);
				completed += 1;
				onProgress?.(completed, items.length);
			}
		},
		signal,
	);
	return results;
}

/**
 * Project-ignore predicate rooted at `root`, fail-open. Lets a directory scan
 * honor the user's `.pi-lens.json` / `.gitignore` patterns — not just the
 * canonical dir-name list — so `lsp_diagnostics` stays consistent with the
 * workspace-diagnostics walk and every other scan surface (#243/#297/#298). A
 * config-probe error never blocks a scan (matches the walkers' behaviour).
 */
function projectIgnorePredicate(
	root: string,
): (fullPath: string, isDir: boolean) => boolean {
	try {
		const matcher = getProjectIgnoreMatcher(root);
		return (fullPath, isDir) => matcher.isIgnored(fullPath, isDir);
	} catch {
		return () => false;
	}
}

/**
 * #1137: async so a directory read never blocks the event loop (and pi's TUI).
 *
 * This walk was fully synchronous with NO yielding of any kind, bounded only by
 * `maxFiles` *kept* — an ignored-heavy or cloud-backed (OneDrive/network) tree
 * could traverse unboundedly many entries, and a single stalled `readdirSync`
 * held the loop for the whole stall. It is also called once PER FAMILY in
 * `runDirectoryDiagnostics`'s `SCAN_LANGUAGE_PRIORITY` loop (#2434, grouped by
 * family since #2458 fix-round F1), so a directory-mode `lsp_diagnostics`
 * could pay that cost several times over.
 *
 * The traversal is deliberately still **depth-first with immediate descent**
 * (not the shared stack-based `walkTreeStackAsync`): the `maxFiles` cap makes
 * traversal ORDER observable — a stack walk would keep a different subset of
 * files on an over-large tree. Only scheduling changes here; the returned list
 * is identical. Awaiting each directory read is itself the yield point.
 */
async function collectFiles(
	dir: string,
	extensions: string[],
	maxFiles: number,
	isIgnored: (fullPath: string, isDir: boolean) => boolean = () => false,
): Promise<string[]> {
	const files: string[] = [];
	async function walk(current: string): Promise<void> {
		if (files.length >= maxFiles) return;
		let entries: fs.Dirent[];
		try {
			entries = await fs.promises.readdir(current, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (files.length >= maxFiles) return;
			if (entry.isSymbolicLink()) continue;
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) {
				if (!isExcludedDirName(entry.name) && !isIgnored(full, true))
					await walk(full);
			} else if (entry.isFile() && extensions.includes(path.extname(full))) {
				if (isIgnored(full, false)) continue;
				files.push(full);
			}
		}
	}
	await walk(dir);
	return files;
}

export function createLspDiagnosticsTool(
	// #571/#1198: same shared write-ordering token source `lens_diagnostics`
	// mode=full uses (index.ts injects `() => runtime.nextWriteIndex()`). A
	// confirmed result reconciled into the footer reserves its token when the
	// per-file check starts, so settlement order cannot make an older result look
	// newer. Optional/undefined in tests.
	nextWriteIndex?: () => number,
	// #1561: #571 wired this tool's confirmed result into the widget footer and
	// stopped there. The inline-blocker map is a SECOND agent-facing store fed by
	// the same dispatch verdict, and nothing retired it — so pi-lens kept
	// injecting "Unresolved from this turn" for three more turns after answering
	// "confirmed clean" for the same file. index.ts injects
	// `runtime.retireInlineBlockerOnConfirmedClean`. Optional/undefined in tests.
	onConfirmedNoBlockers?: (info: ConfirmedNoBlockersInfo) => void,
	getService: () => ReturnType<typeof getLSPService> = getLSPService,
) {
	return {
		async execute(
			_toolCallId: string,
			params: Record<string, unknown>,
			_signal: AbortSignal | undefined,
			onUpdate: unknown,
			ctx: { cwd?: string; signal?: AbortSignal },
		) {
			// Escape aborts the turn via ctx.signal; honor both it and the tool-call
			// signal so a batch/directory scan cancels rather than grinding on.
			const signal = combineAbortSignals(_signal, ctx.signal);
			// Stream a throttled progress bar for batch/directory scans (opaque for
			// seconds-to-minutes otherwise).
			const onProgress = makeProgressReporter(
				onUpdate,
				"Scanning LSP diagnostics",
			);
			const typedParams = params as {
				path?: string;
				paths?: string[];
				severity?: string;
				concurrency?: number;
				waitMs?: number;
				serverScope?: string;
			};
			const severity = (typedParams.severity ?? "all") as string;
			const cwd = ctx.cwd ?? process.cwd();
			const concurrency = boundedPositiveInt(
				typedParams.concurrency,
				DEFAULT_BATCH_CONCURRENCY,
				1,
				MAX_BATCH_CONCURRENCY,
			);
			const waitMs =
				typeof typedParams.waitMs === "number" && typedParams.waitMs >= 0
					? Math.floor(typedParams.waitMs)
					: undefined;
			const serverScope: "primary" | "all" =
				typedParams.serverScope === "primary" ? "primary" : "all";

			const lspService = getService();
			if (!lspService) {
				return {
					content: [
						{ type: "text" as const, text: "LSP service not available." },
					],
					isError: true,
					details: {},
				};
			}

			if (Array.isArray(typedParams.paths) && typedParams.paths.length > 0) {
				if (typedParams.paths.length > MAX_BATCH_FILES) {
					return {
						content: [
							{
								type: "text" as const,
								text: `paths accepts at most ${MAX_BATCH_FILES} files; received ${typedParams.paths.length}.`,
							},
						],
						isError: true,
						details: { mode: "batch", filesChecked: 0 },
					};
				}
				const rawPaths = typedParams.paths.filter(
					(entry): entry is string =>
						typeof entry === "string" && entry.trim().length > 0,
				);
				if (rawPaths.length !== typedParams.paths.length) {
					return {
						content: [
							{
								type: "text" as const,
								text: "paths must contain non-empty file paths.",
							},
						],
						isError: true,
						details: { mode: "batch", filesChecked: 0 },
					};
				}
				// Preserve input order (including duplicate entries); normalize each
				// path before grouping so Windows separators and dot segments cannot
				// change cache/group identity. Explicit lists never enter the walker.
				const absPaths = rawPaths.map((entry) =>
					path.normalize(
						path.isAbsolute(entry) ? entry : path.resolve(cwd, entry),
					),
				);
				return runBatchFileDiagnostics(absPaths, severity, lspService, {
					concurrency,
					waitMs,
					signal,
					onProgress,
					nextWriteIndex,
					serverScope,
					cwd,
					onConfirmedNoBlockers,
				});
			}

			const rawPath = typedParams.path;
			if (!rawPath || rawPath.trim().length === 0) {
				return {
					content: [
						{
							type: "text" as const,
							text: "path or paths is required.",
						},
					],
					isError: true,
					details: {},
				};
			}
			const absPath = path.isAbsolute(rawPath)
				? rawPath
				: path.resolve(cwd, rawPath);

			let stat: fs.Stats;
			try {
				stat = fs.statSync(absPath);
			} catch {
				return {
					content: [
						{ type: "text" as const, text: `Path not found: ${absPath}` },
					],
					isError: true,
					details: {},
				};
			}

			if (stat.isDirectory()) {
				return runDirectoryDiagnostics(absPath, severity, lspService, {
					concurrency,
					waitMs,
					signal,
					onProgress,
					nextWriteIndex,
					serverScope,
					cwd,
					onConfirmedNoBlockers,
				});
			}
			return runFileDiagnostics(
				absPath,
				severity,
				lspService,
				waitMs,
				nextWriteIndex,
				serverScope,
				cwd,
				onConfirmedNoBlockers,
			);
		},
	};
}

type DiagnosticsCollectionResult = {
	diagnostics: LSPDiagnostic[];
	skipReason?: "outside-project-root";
	/**
	 * #570: true when the priming `touchFile` call could not confirm its
	 * result (notify write and/or diagnostics wait timed out) before the
	 * follow-up `getDiagnostics` read below. An empty result in that case is
	 * NOT a confirmed clean answer — treat it the same as the existing
	 * "unconfirmed" (silent-on-clean server) bucket rather than reporting a
	 * bare 0.
	 */
	timedOut: boolean;
	/**
	 * True only when `touchFile` explicitly preserved completion of its configured
	 * diagnostics policy. This is distinct from merely receiving an empty array;
	 * scope-specific consumers may still require a stricter fallback (see
	 * `canTrustTouchConfirmation`).
	 */
	confirmedByTouch: boolean;
	/**
	 * #1470/#1493: server ids the touch carries no evidence for — an auxiliary whose
	 * push wait was cut off by the aux grace timer (#1470), or one that stayed silent
	 * with no stored publication for this content (#1493). Empty when every spawned
	 * server got to answer. `confirmedByTouch` stays TRUE in that case: the primary's
	 * own confirmation is untouched, and conflating the two would report a hung or
	 * silent opengrep as "typescript could not confirm clean", a different lie. The caller
	 * demotes the FILE-level verdict to "unconfirmed" while keeping the primary line
	 * honest.
	 */
	unconfirmedServerIds: readonly string[];
	/** Custom navigation-only servers that supplied no diagnostic evidence. */
	diagnosticsUnsupportedServerIds: readonly string[];
	/**
	 * #692: the file content read while collecting (undefined only when the
	 * read itself failed) — reused by the widget-reconcile caller so it can
	 * derive `fileRole` for `retagAuxiliaryDiagnostics`'s `skipTestFiles` gate
	 * without a second disk read.
	 */
	content?: string;
	/**
	 * #1095: content binding of the collected result — whether these diagnostics
	 * were computed against current disk. `boundToCurrentDisk === false` means the
	 * server's view diverged from disk; the caller demotes such a result to
	 * "unconfirmed" so a stale-but-fresh-looking result never re-cements the
	 * widget (#1092). Undefined when no touch produced one (warm-attach /
	 * getDiagnostics fallback) → treated as "unknown" (no demotion).
	 */
	binding?: DiagnosticBinding;
};

async function collectDiagnosticsForFile(
	absPath: string,
	lspService: NonNullable<ReturnType<typeof getLSPService>>,
	waitMs?: number,
	serverScope: "primary" | "all" = "all",
): Promise<DiagnosticsCollectionResult> {
	let timedOut = false;
	let content: string | undefined;
	// `touchFile` is the authoritative collection boundary for every scope: it
	// preserves per-touch timeout, content-binding, and silent-clean confirmation
	// metadata while returning diagnostics from only the requested clients. The
	// getDiagnostics fallback below remains for the two states a REAL service
	// still reaches: the file read threw (no content to touch with), or the
	// touch resolved no clients and returned `undefined` (clients/lsp/index.ts
	// `touchFile`'s `no_clients`/`destroyed` returns). #2598 deleted the third
	// reason — "an older/mock service without touchFile" — because the real
	// `LSPService` has always defined the method unconditionally, so that arm
	// was reachable only from a partial test double (AGENTS.md shape 7).
	// #1179: the result is an explicit wrapper so side-channel fields survive
	// array copies; confirmation was added when Marksman's lower-level clean verdict
	// proved that a successful empty collection also needs explicit provenance.
	let touched: TouchFileResult | undefined;
	try {
		content = fs.readFileSync(absPath, "utf-8");
		if (isWarmAttached()) {
			// The local sweep's default service wait is bounded to the same
			// 15-second per-file envelope used by the workspace sweep. An explicit
			// waitMs remains the tighter caller-selected cap.
			const attachedBudgetMs = waitMs ?? 15_000;
			const attached = await tryWarmAttachedDiagnostics(
				absPath,
				content,
				attachedBudgetMs,
				"sweep",
			);
			if (attached?.available) {
				const scopedDiagnostics =
					serverScope === "primary"
						? attached.response.diagnostics.filter(
								(item) => item.serverId === primaryServerId(absPath),
							)
						: attached.response.diagnostics;
				const filtered = applyAuxiliarySuppressions(
					scopedDiagnostics,
					content,
					{ fileRole: detectFileRole(absPath, content) },
				);
				return {
					diagnostics: filtered,
					timedOut: false,
					// #1253: the incumbent's touch carries the same confirmation
					// provenance a local touch does (an `available: true` answer is
					// already gated on `fresh && !inconclusive`, but that is NOT
					// evidence a silent-on-clean server was confirmed — only the
					// explicit flag is). The incumbent always touches with
					// `clientScope: "with-auxiliary"`, so this is an AGGREGATE
					// confirmation: it carries the same caveat all-scope local
					// touches do, and classic TypeScript still needs the primary-only
					// tsserver sync check below rather than this verdict.
					// #1470: `"partial"` counts, for the same reason the local touch
					// branch below accepts it — the incumbent's primary confirmed; only
					// a named auxiliary did not.
					confirmedByTouch:
						attached.response.confirmation !== undefined &&
						primaryServerId(absPath) !== "typescript",
					// #1470: the incumbent's narrowed verdict, carried as an explicit DTO
					// field across the socket. An older incumbent omits it → empty → the
					// pre-#1470 handling, unchanged.
					unconfirmedServerIds: attached.response.unconfirmedServerIds ?? [],
					diagnosticsUnsupportedServerIds: [],
					content,
				};
			}
		}
		touched = await lspService.touchFile(absPath, content, {
			diagnostics: "document",
			collectDiagnostics: true,
			maxClientWaitMs: waitMs,
			source: "lsp_diagnostics",
			clientScope: serverScope,
		});
		timedOut = touched?.inconclusive === true;
	} catch {
		// Non-fatal: getDiagnostics may still have stale/health information.
	}

	// Only fall through to the unscoped getDiagnostics() read when the touch
	// produced nothing to read — it threw, the file read threw before it ran, or
	// it resolved no clients at all. When touched IS defined it's already the
	// answer — reusing it is what makes serverScope:"primary" actually skip
	// auxiliary scanners and drops the common case back to a single LSP round
	// trip instead of two.
	const diagnostics =
		touched !== undefined
			? touched.diags
			: await lspService.getDiagnostics(
					absPath,
					waitMs !== undefined ? "document" : "full",
				);
	// #586: honor each auxiliary profile's native inline-suppression comment
	// (e.g. opengrep's `// nosemgrep`, #441) the same way the per-edit dispatch
	// runner does — previously this standalone query path ignored it entirely.
	// #692: also honor a profile's `skipTestFiles` gate (e.g. ast-grep, #687) —
	// this standalone-query path had no test-file gating of its own, so an
	// `lsp_diagnostics` check on a test file surfaced ast-grep findings the
	// per-edit dispatch runner would have suppressed. `content` is only unset
	// if the read itself failed above; fail-open (no filtering) rather than
	// lose diagnostics over an unrelated read error.
	const filtered =
		content !== undefined
			? applyAuxiliarySuppressions(diagnostics, content, {
					fileRole: detectFileRole(absPath, content),
				})
			: diagnostics;
	// #1095: surface the touch's content binding (only a touch that resolved
	// clients carries one; the getDiagnostics fallback leaves it undefined →
	// "unknown", no demotion).
	const binding = touched?.binding;
	// #1470: `"partial"` counts here. `confirmedByTouch` feeds
	// `canTrustTouchConfirmation`, which asks about the PRIMARY's own verdict —
	// and a partial touch is one whose primary confirmed while an auxiliary was
	// cut off. Excluding it would render "Primary LSP: unconfirmed" for a primary
	// that did confirm. The coverage gap is carried separately, below.
	const confirmedByTouch = touchCompletedConfirmationPolicy(touched);
	return {
		diagnostics: filtered,
		timedOut,
		skipReason: touched?.skipReason,
		confirmedByTouch,
		// #1470: only a touch that resolved clients contributes a coverage gap;
		// the getDiagnostics fallback never reports one, which is honest — that
		// path claims no confirmation at all.
		unconfirmedServerIds: touchCoverageGap(touched),
		diagnosticsUnsupportedServerIds:
			touched?.diagnosticsUnsupportedServerIds ?? [],
		content,
		binding,
	};
}

function diagnosticsToFileDiags(
	file: string,
	diagnostics: LSPDiagnostic[],
): FileDiag[] {
	return diagnostics.map((d) => ({
		file,
		line: d.range?.start?.line,
		character: d.range?.start?.character,
		severity: d.severity,
		message: d.message,
		source: d.source,
		serverId: d.serverId,
		code: d.code,
	}));
}

/**
 * #533: classify an EMPTY diagnostic result as "clean" (the server actually
 * confirmed no issues) or "unconfirmed" (came from a push-only,
 * silent-on-clean server — classic typescript-language-server — that
 * publishes nothing on a clean→clean transition, so an empty result here is
 * indistinguishable from "still analyzing" or "never asked"). Reuses the same
 * capability-snapshot classifier the #458 cascade lane already trusts
 * (`classifyCascadeWaitTier`) so this tool's notion of "silent tier-3" stays
 * in lockstep with the rest of the LSP layer instead of drifting via a second
 * copy of the server-strategy table. Fail-safe: any error or missing snapshot
 * (server not alive, capability probe failure) reads as "clean" — the same
 * default this tool has always had — rather than manufacturing a new failure
 * mode from a best-effort classification.
 */
async function classifyEmptyResult(
	file: string,
	lspService: NonNullable<ReturnType<typeof getLSPService>>,
): Promise<"clean" | "unconfirmed"> {
	try {
		const snapshots = await lspService.getCapabilitySnapshots(file);
		const tier = classifyCascadeWaitTier(lspService, file, snapshots);
		return tier === "tier3-silent" ? "unconfirmed" : "clean";
	} catch {
		return "clean";
	}
}

// --- #611/#707: tier-3 silent escape hatch (typescript.tsserverRequest sync
// commands) — implementation extracted to clients/lsp/tsserver-sync.ts and
// re-used from there by the per-edit dispatch path (#707). ---

/**
 * #611: resolve an EMPTY diagnostic result for a Tier-3 silent server (see
 * `classifyCascadeWaitTier` — today only classic typescript-language-server,
 * native-ts7 is explicitly excluded there) with a definitive answer instead of
 * defaulting straight to "unconfirmed". `confirmed: true` with an empty
 * `diagnostics` array is a genuinely confirmed clean result; `confirmed: true`
 * with a non-empty array means the sync command surfaced real diagnostics the
 * server had computed but never published (silentOnClean) — these must be
 * surfaced to the caller, not discarded. `confirmed: false` is the existing
 * "unconfirmed" fallback (command unavailable, error, or the file isn't part
 * of any project). Fail-safe: any error in the tier classification itself
 * (missing snapshot, server not alive) reads as `confirmed: true` with no
 * diagnostics — the same "clean" default this tool has always had.
 */
async function resolveEmptyResult(
	file: string,
	lspService: NonNullable<ReturnType<typeof getLSPService>>,
): Promise<{ confirmed: boolean; diagnostics: LSPDiagnostic[] }> {
	try {
		const snapshots = await lspService.getCapabilitySnapshots(file);
		const tier = classifyCascadeWaitTier(lspService, file, snapshots);
		if (tier !== "tier3-silent") {
			return { confirmed: true, diagnostics: [] };
		}
		const syncDiagnostics = await attemptTsserverSyncDiagnostics(
			file,
			lspService,
		);
		if (syncDiagnostics === undefined) {
			return { confirmed: false, diagnostics: [] };
		}
		return { confirmed: true, diagnostics: syncDiagnostics };
	} catch {
		return { confirmed: true, diagnostics: [] };
	}
}

/**
 * A primary-scope touch is authoritative because `touchFile` runs that
 * primary's own confirmation path (including TypeScript's sync fallback). For
 * all-scope TypeScript touches, the aggregate silent-clean gate can settle
 * without that primary-only sync request, so preserve `resolveEmptyResult`'s
 * existing tsserver fallback instead of accepting the aggregate verdict.
 */
function canTrustTouchConfirmation(
	file: string,
	serverScope: "primary" | "all",
	confirmedByTouch: boolean,
): boolean {
	return (
		confirmedByTouch &&
		(serverScope === "primary" || primaryServerId(file) !== "typescript")
	);
}

/**
 * #571: reconcile this tool's fresh LSP result into the footer cache
 * (`widget-state.ts`'s `allDiagnostics`) — same shared choke point
 * `lens_diagnostics` mode=full uses (`clients/widget-state.ts`'s
 * `reconcileScanDiagnostics`). A manual `lsp_diagnostics` check that proves a
 * stale footer error is actually gone (the real-world case that surfaced
 * #571) is exactly the kind of confirmed result that should correct it.
 * Direct `lsp_diagnostics` deliberately does not perform a second disk read at
 * this reconciliation seam: its collecting touch already read the content and
 * supplies the binding verdict. `false` is unconfirmed and is never written;
 * `true` is trusted, while an absent/`unknown` verdict preserves the legacy
 * fail-open policy for servers that cannot bind their diagnostics to content.
 *
 * `rawDiags` (pre-severity-filter) is what gets written — the footer records
 * the true known state, independent of this call's display-only severity
 * filter. A non-empty result is definitionally confirmed (the server DID
 * answer with real diagnostics); an empty result is only confirmed when
 * `classifyEmptyResult` (#533) says "clean", not "unconfirmed" (silent
 * push-only server — indistinguishable from still-analyzing/never-asked, so
 * must not overwrite a real prior footer entry).
 *
 * #692: `retagAuxiliaryDiagnostics` re-tags aux-sourced entries (ast-grep,
 * opengrep, zizmor, typos) with their real tool id + semantic policy before
 * they're written — the same treatment the per-edit dispatch runner gives
 * them — so a scan-reconciled entry no longer keeps tool `"lsp"`. `content`
 * is the file content `collectDiagnosticsForFile`/the cache already read (or
 * undefined for a cache-hit branch, whose `rawDiags` were already suppression-
 * /skipTestFiles-filtered at write time — an empty string here is then a safe
 * no-op re-check, not a behavior gap).
 */
/**
 * #1561: what the reconcile actually established about this file.
 *
 * `confirmed: false` means the result was not trustworthy enough to write
 * anywhere (unconfirmed, content-binding mismatch, or the reconcile threw), and
 * `blocking` is then pinned `true` — an unknown verdict must never read as
 * evidence of clean.
 */
type LspReconcileVerdict = {
	confirmed: boolean;
	blocking: boolean;
};

/**
 * #1561 F1: what this check is entitled to speak for.
 *
 * Inline blockers are raised by the whole dispatch — eslint, biome-check,
 * actionlint, ast-grep security rules — while this tool only ever consults
 * language servers. Retiring one therefore needs an explicit coverage claim,
 * and the honest claim is exactly the servers this check consulted and got an
 * answer from. `serverScope: "primary"` consults only the primary, so its claim
 * is `"lsp"` alone; an all-scope check adds each auxiliary server by id, which
 * is the same vocabulary `retagAuxiliaryDiagnostics` tags their findings with.
 *
 * A server named in `unconfirmedServerIds` is dropped: it produced no evidence
 * for this content, so claiming coverage for it would be the #1470/#1493 lie one
 * layer up. (Today an aux gap also demotes the whole verdict to "unconfirmed",
 * so the hook does not fire at all — this stays correct if that ever narrows.)
 */
function coveredSourcesForCheck(
	file: string,
	serverScope: "primary" | "all",
	unconfirmedServerIds: readonly string[],
): string[] {
	const unconfirmed = new Set(unconfirmedServerIds);
	const covered = new Set<string>();
	let servers: Array<{ id: string; role?: string }> = [];
	try {
		servers = (getServersForFileWithConfig(file) ?? []) as Array<{
			id: string;
			role?: string;
		}>;
	} catch {
		// A registry we cannot read is not a coverage claim. Returning an empty
		// set makes every retire fail closed, which is the safe direction for a
		// commit gate.
		return [];
	}
	for (const server of servers) {
		const auxiliary = server.role === "auxiliary";
		if (auxiliary && serverScope === "primary") continue;
		if (unconfirmed.has(server.id)) continue;
		// The dispatch runner tags the primary language server's findings `lsp`;
		// auxiliaries keep their own tool id.
		covered.add(auxiliary ? server.id : "lsp");
	}
	return [...covered];
}

/**
 * #1645 review F3: `lsp_diagnostics` writes into the SAME widget store as
 * `lens_diagnostics mode=full`. Two tools writing one store must apply ONE rule
 * for "is this file's diagnostics demoted" — otherwise an orphan file blocks or
 * does not depending purely on which tool ran last, which is the #1633-V1
 * lesson. Every path in this file that reaches `reconcileWidgetFromLspResult`
 * or the rendered output routes its raw diagnostics through here first, so the
 * store, the counts, and the text all agree.
 *
 * Applied AFTER the confirmation verdict is computed, never before: confirmation
 * asks "did the server answer for this content", which the demotion must not
 * influence.
 */
function demoteInferredForFile(
	file: string,
	diagnostics: LSPDiagnostic[],
	cwd: string,
	lspService: NonNullable<ReturnType<typeof getLSPService>>,
): Promise<LSPDiagnostic[]> {
	return demoteInferredProjectDiagnostics(diagnostics, {
		filePath: file,
		cwd,
		service: lspService,
	});
}

/** #1561: everything the retire decision needs, as one argument. */
export type ConfirmedNoBlockersInfo = {
	filePath: string;
	writeIndex?: number;
	coveredSources: string[];
	cwd: string;
};

function reconcileWidgetFromLspResult(
	file: string,
	rawDiags: LSPDiagnostic[],
	confirmation: "clean" | "unconfirmed" | undefined,
	writeIndex: number | undefined,
	cwd: string,
	content: string | undefined,
	// #1095: true when the result's content binding demonstrably mismatches disk
	// (boundToCurrentDisk === false). Such a result — even a NON-EMPTY one, which
	// the pre-#1095 "non-empty is definitionally confirmed" doctrine would have
	// written straight through — must NOT re-cement the footer with a stale view
	// (#1092's window-1 transcript: 17 live-looking diagnostics while tsc exits
	// 0). "unknown"/true bindings leave the doctrine unchanged (fallback preserved
	// for servers that never bind a version).
	boundMismatch = false,
	// #1093: when these `rawDiags` were actually OBSERVED. Fresh touches observe
	// now (`undefined` → `Date.now()`); a cache HIT replays diagnostics scanned
	// earlier, so its caller passes the cache entry's `scannedAt` here so the
	// footer's `touchedAt` isn't re-armed to now() and the mtime-staleness gate
	// stays live (the #1092 re-arming defect).
	observedAt?: number,
): LspReconcileVerdict {
	const confirmed =
		(rawDiags.length > 0 || confirmation !== "unconfirmed") && !boundMismatch;
	if (!confirmed) return { confirmed: false, blocking: true };
	try {
		// #692: provenance label ONLY — must never affect `rule`/identity (see
		// `ConvertLspDiagnosticsOptions.scanOrigin`'s doc comment).
		const diagnostics = convertLspDiagnostics(rawDiags, file, {
			scanOrigin: "lsp_diagnostics",
		});
		const retagged = retagAuxiliaryDiagnostics(
			diagnostics,
			rawDiags,
			content ?? "",
			{ cwd, fileRole: detectFileRole(file, content) },
		);
		reconcileScanDiagnostics(file, retagged, true, writeIndex, observedAt);
		// #1561: the blocking tally comes from the SAME `isBlocking` predicate the
		// footer counts with — no second severity rule for the blocker-retire
		// decision to drift away from.
		return { confirmed: true, blocking: retagged.some(isBlocking) };
	} catch {
		// Never let a footer-reconciliation hiccup fail the diagnostics check.
		// A verdict we could not compute is NOT evidence of clean: report it as
		// still-blocking so no caller retires a blocker off a failed reconcile.
		return { confirmed: false, blocking: true };
	}
}

async function collectFileDiagnosticResult(
	file: string,
	severity: string,
	lspService: NonNullable<ReturnType<typeof getLSPService>>,
	waitMs?: number,
	nextWriteIndex?: () => number,
	serverScope: "primary" | "all" = "all",
	// #671: shared workspace-diagnostics cache (see `createWorkspaceDiagnostics
	// CacheContext`'s doc) — optional so single-file callers of this function
	// (there are none today, but keep it non-breaking) can omit it and simply
	// always touch. Only `collectBatchDiagnostics` (the batch/directory sweep)
	// passes these.
	cacheCtx?: WorkspaceDiagnosticsCacheContext,
	scopeKey?: string,
	// #692: threaded through so `reconcileWidgetFromLspResult` can compute
	// `allowBlocking(cwd)` for a scan-reconciled aux finding — defaults to
	// `process.cwd()` for any call site that predates this (there are none
	// today besides the two below, both of which now pass it explicitly).
	cwd: string = process.cwd(),
	// #1561: see `createLspDiagnosticsTool`'s parameter doc. Called only for a
	// FRESH observation — never on the cache-hit replay below, whose `rawDiags`
	// are an OLD observation (#1093) and therefore no evidence about now.
	onConfirmedNoBlockers?: (info: ConfirmedNoBlockersInfo) => void,
): Promise<FileDiagnosticResult> {
	// Reserve the ordering token when this diagnostic operation starts, not when
	// its LSP promise settles. A slower old result must not receive a newer token
	// merely because it completed later (#1198).
	const writeIndex = nextWriteIndex?.();
	let stat: ReturnType<typeof fs.statSync>;
	try {
		stat = fs.statSync(file);
		if (!stat.isFile()) {
			return { file, diagnostics: [], error: `${file}: not a file` };
		}
	} catch {
		return { file, diagnostics: [], error: `${file}: path not found` };
	}

	if (cacheCtx && scopeKey !== undefined) {
		const cached = cacheCtx.lookup(file, scopeKey);
		// #1095: a cached entry whose content binding demonstrably mismatches disk
		// (bytes changed without the mtime bump the freshness gate would catch) is
		// NOT served — fall through to a fresh touch instead of replaying a stale
		// cached result. "unknown"/true bindings serve as before.
		if (cached && cached.binding.boundToCurrentDisk !== false) {
			const confirmation: "clean" | undefined =
				cached.diagnostics.length === 0 ? "clean" : undefined;
			// #1645 review F3: a cache REPLAY writes the widget store exactly like a
			// fresh touch does, so it gets the same demotion. Without this, replaying
			// yesterday's cached blocker would re-cement an orphan file as blocking
			// after mode=full had demoted it.
			const cachedDiags = await demoteInferredForFile(
				file,
				cached.diagnostics,
				cwd,
				lspService,
			);
			const filteredDiags = applySeverityFilter(cachedDiags, severity);
			// #692: cached.diagnostics were already suppression-/skipTestFiles-
			// filtered at write time (this same code path); no file content was
			// cached alongside them, so `undefined` here is a safe re-check, not
			// a gap.
			// #1093: this is a CACHE HIT — a replay of an OLD observation. Stamp the
			// footer's `touchedAt` with the cache entry's original `scannedAt`, NOT
			// now(), or a repeat check that only re-serves the cache would keep
			// re-arming the mtime-staleness gate and a resolved finding would render
			// forever (the #1092 defect).
			reconcileWidgetFromLspResult(
				file,
				cachedDiags,
				confirmation,
				writeIndex,
				cwd,
				undefined,
				// This branch only runs when the cache binding is not a mismatch
				// (guarded above), so boundMismatch is false; #1093's observedAt is
				// the cache entry's original scan time.
				false,
				cached.scannedAt,
			);
			return {
				file,
				diagnostics: diagnosticsToFileDiags(file, filteredDiags),
				confirmation,
				primaryServerId: primaryServerId(file),
			};
		}
	}

	const {
		diagnostics: rawDiags,
		timedOut,
		confirmedByTouch,
		unconfirmedServerIds,
		diagnosticsUnsupportedServerIds,
		content: collectedContent,
		binding,
		skipReason,
	} = await collectDiagnosticsForFile(file, lspService, waitMs, serverScope);
	const health = lspService.getDiagnosticsHealth?.(file) as
		| LspHealthLike
		| undefined;
	// #570: a timed-out priming check is never a confirmed "clean" — treat it
	// as unconfirmed without consulting the (unrelated) silent-tier
	// classifier, and remember why so the rendered text is accurate.
	// #611: a genuinely empty (not just severity-filtered-away) push-based
	// result gets a shot at the tier-3 sync escape hatch before "unconfirmed"
	// — it may surface real diagnostics the server never published, which must
	// be merged in rather than discarded.
	let effectiveRawDiags = rawDiags;
	let confirmation: "clean" | "unconfirmed" | undefined;
	if (diagnosticsUnsupportedServerIds.length > 0) {
		// No diagnostic provider and no push evidence is a capability boundary,
		// not a clean result and not a timeout.
		confirmation = undefined;
	} else if (skipReason !== undefined) {
		confirmation = "unconfirmed";
	} else if (timedOut) {
		if (applySeverityFilter(rawDiags, severity).length === 0) {
			confirmation = "unconfirmed";
		}
	} else if (canTrustTouchConfirmation(file, serverScope, confirmedByTouch)) {
		if (applySeverityFilter(rawDiags, severity).length === 0) {
			confirmation = "clean";
		}
	} else if (rawDiags.length === 0) {
		const resolved = await resolveEmptyResult(file, lspService);
		effectiveRawDiags = resolved.diagnostics;
		confirmation = resolved.confirmed
			? resolved.diagnostics.length === 0
				? "clean"
				: undefined
			: "unconfirmed";
	} else if (applySeverityFilter(rawDiags, severity).length === 0) {
		confirmation = await classifyEmptyResult(file, lspService);
	}
	// #1095: a result whose content binding demonstrably mismatches disk is
	// demoted to "unconfirmed" — it must neither confirm the footer nor be cached
	// as clean, regardless of how many diagnostics it carries (the #1092
	// re-cementing path). "unknown"/true bindings leave the verdict untouched.
	const boundMismatch = binding?.boundToCurrentDisk === false;
	if (boundMismatch) confirmation = "unconfirmed";
	// #1470/#1493: an auxiliary that never reported — cut off by the aux grace timer,
	// or silent with nothing published for this content — contributed no evidence
	// about this file, so a "clean" verdict computed from the merged result would
	// be claiming coverage this batch does not have. Demote it — that also keeps
	// the entry out of the workspace cache below, which would otherwise replay the
	// partial answer as a confirmed clean on every later sweep.
	if (unconfirmedServerIds.length > 0 && confirmation === "clean") {
		confirmation = "unconfirmed";
	}
	// #1645 review F3: one demotion rule for every writer of the widget store.
	effectiveRawDiags = await demoteInferredForFile(
		file,
		effectiveRawDiags,
		cwd,
		lspService,
	);
	const filteredDiags = applySeverityFilter(effectiveRawDiags, severity);
	const verdict = reconcileWidgetFromLspResult(
		file,
		effectiveRawDiags,
		confirmation,
		writeIndex,
		cwd,
		collectedContent,
		boundMismatch,
	);
	if (verdict.confirmed && !verdict.blocking) {
		onConfirmedNoBlockers?.({
			filePath: file,
			writeIndex,
			coveredSources: coveredSourcesForCheck(
				file,
				serverScope,
				unconfirmedServerIds,
			),
			cwd,
		});
	}
	// #671: only a CONFIRMED outcome ("clean", or a non-empty result — either
	// is definitionally confirmed per this function's own doctrine above) is
	// safe to cache; "unconfirmed" (timeout OR a silent-tier server's
	// unescapable empty push) must never be persisted as a cacheable clean
	// result — same false-clean bug class `runWorkspaceDiagnostics`'s cache
	// wiring guards against. #1095: the entry carries the content fingerprint so a
	// later lookup can verify it against disk beyond the mtime proxy.
	if (
		cacheCtx &&
		scopeKey !== undefined &&
		confirmation !== "unconfirmed" &&
		diagnosticsUnsupportedServerIds.length === 0 &&
		unconfirmedServerIds.length === 0
	) {
		cacheCtx.record(
			file,
			scopeKey,
			effectiveRawDiags,
			stat.mtimeMs,
			collectedContent !== undefined
				? hashDiagnosticContent(collectedContent)
				: undefined,
			stat.size,
		);
	}
	return {
		file,
		diagnostics: diagnosticsToFileDiags(file, filteredDiags),
		unavailable: lspUnavailableMessage(file, health),
		confirmation,
		timedOut: confirmation === "unconfirmed" ? timedOut : undefined,
		...(skipReason !== undefined && { skipReason }),
		primaryServerId: primaryServerId(file),
		diagnosticsUnsupported: diagnosticsUnsupportedServerIds.length > 0,
	};
}

async function runFileDiagnostics(
	absPath: string,
	severity: string,
	lspService: NonNullable<ReturnType<typeof getLSPService>>,
	waitMs?: number,
	nextWriteIndex?: () => number,
	serverScope: "primary" | "all" = "all",
	cwd: string = process.cwd(),
	// #1561: see `createLspDiagnosticsTool`'s parameter doc. This is the path the
	// live incident took (`mode: "file"`).
	onConfirmedNoBlockers?: (info: ConfirmedNoBlockersInfo) => void,
) {
	// Reserve the token before awaiting this file's LSP result. The direct-file
	// path performs its own confirmation/reconciliation below (#1198).
	const writeIndex = nextWriteIndex?.();
	const {
		diagnostics: rawDiags,
		timedOut,
		confirmedByTouch,
		unconfirmedServerIds,
		diagnosticsUnsupportedServerIds,
		content: collectedContent,
		binding,
		skipReason,
	} = await collectDiagnosticsForFile(absPath, lspService, waitMs, serverScope);
	const lspHealth = lspService.getDiagnosticsHealth?.(absPath) as
		| LspHealthLike
		| undefined;
	const unavailable = lspUnavailableMessage(absPath, lspHealth);
	// #533: an empty result needs a confirmed/unconfirmed verdict — a push-only,
	// silent-on-clean server (classic typescript) publishes nothing on a
	// clean→clean edit, so "0 diagnostics" from it is unverifiable, not clean.
	// #570: a timed-out priming check is a second, distinct reason a result
	// can be unconfirmed — checked first since it's a property of THIS check,
	// not a general server-capability classification.
	// #611: a genuinely empty (not just severity-filtered-away) result gets a
	// shot at the tier-3 sync escape hatch before "unconfirmed" — real
	// diagnostics it surfaces are merged in, not discarded.
	let effectiveRawDiags = rawDiags;
	let confirmation: "clean" | "unconfirmed" | undefined;
	if (diagnosticsUnsupportedServerIds.length > 0) {
		confirmation = undefined;
	} else if (skipReason !== undefined) {
		confirmation = "unconfirmed";
	} else if (timedOut) {
		if (applySeverityFilter(rawDiags, severity).length === 0) {
			confirmation = "unconfirmed";
		}
	} else if (
		canTrustTouchConfirmation(absPath, serverScope, confirmedByTouch)
	) {
		if (applySeverityFilter(rawDiags, severity).length === 0) {
			confirmation = "clean";
		}
	} else if (rawDiags.length === 0) {
		const resolved = await resolveEmptyResult(absPath, lspService);
		effectiveRawDiags = resolved.diagnostics;
		confirmation = resolved.confirmed
			? resolved.diagnostics.length === 0
				? "clean"
				: undefined
			: "unconfirmed";
	} else if (applySeverityFilter(rawDiags, severity).length === 0) {
		confirmation = await classifyEmptyResult(absPath, lspService);
	}
	// #1095: demote a result whose content binding mismatches disk to
	// "unconfirmed" (the #1092 re-cementing path) — a non-empty stale result is no
	// longer "definitionally confirmed". "unknown"/true bindings are unchanged.
	const boundMismatch = binding?.boundToCurrentDisk === false;
	if (boundMismatch) confirmation = "unconfirmed";
	// #1470/#1493: NARROWED, not collapsed. An auxiliary that never reported — the aux
	// grace timer cut it off, or it stayed silent with nothing published for this
	// content — makes the FILE-level verdict unconfirmed. The merged result is missing
	// whatever that scanner would have said, and this tool is the security lane's read surface. The
	// PRIMARY's own verdict is untouched (`primaryCoverageGapOnly` below), so a
	// TypeScript answer stays "confirmed clean" on its own line while an explicit
	// line names the scanner whose coverage is absent.
	const primaryCoverageGapOnly =
		unconfirmedServerIds.length > 0 && confirmation === "clean";
	if (primaryCoverageGapOnly) confirmation = "unconfirmed";
	// #1645 review F3: one demotion rule for every writer of the widget store.
	effectiveRawDiags = await demoteInferredForFile(
		absPath,
		effectiveRawDiags,
		cwd,
		lspService,
	);
	const filtered = applySeverityFilter(effectiveRawDiags, severity);
	const total = filtered.length;
	const truncated = total > MAX_DIAGNOSTICS;
	const limited = truncated ? filtered.slice(0, MAX_DIAGNOSTICS) : filtered;
	const unconfirmed = confirmation === "unconfirmed";
	const verdict = reconcileWidgetFromLspResult(
		absPath,
		effectiveRawDiags,
		confirmation,
		writeIndex,
		cwd,
		collectedContent,
		boundMismatch,
	);
	// #1561: a confirmed current view with nothing at the blocking tier retires
	// this file's stale inline blocker — the store #571 corrected the footer for
	// but never reached, which is how a resolved cross-file finding kept being
	// injected as "Unresolved from this turn" for the rest of the session.
	if (verdict.confirmed && !verdict.blocking) {
		onConfirmedNoBlockers?.({
			filePath: absPath,
			writeIndex,
			coveredSources: coveredSourcesForCheck(
				absPath,
				serverScope,
				unconfirmedServerIds,
			),
			cwd,
		});
	}

	const primaryId = primaryServerId(absPath);
	const primaryDiags = limited.filter((d) => d.serverId === primaryId);
	const auxiliaryDiags = limited.filter((d) => d.serverId !== primaryId);

	// Primary confirmation is always its own line, independent of how many
	// auxiliary findings exist — a wall of ast-grep/opengrep noise must never
	// bury whether the actual language server confirmed the file clean.
	const primaryLine = (() => {
		if (diagnosticsUnsupportedServerIds.length > 0) {
			return `Primary LSP${primaryId ? ` (${primaryId})` : ""}: navigation-only — diagnostics unsupported (no pull provider or publish evidence).`;
		}
		if (timedOut) {
			return (
				"Primary LSP: check timed out — NOT the same as 0 diagnostics; the " +
				"file may still have errors that just hadn't been reported yet. " +
				"Re-check after the server settles, or increase waitMs."
			);
		}
		// #1470: a file demoted ONLY because an auxiliary was cut off must not render
		// the silent-on-clean text — the primary did confirm, and saying otherwise is
		// the same overclaim in the opposite direction. The coverage line below names
		// what is actually missing.
		if (unconfirmed && !primaryCoverageGapOnly) {
			return (
				`Primary LSP${primaryId ? ` (${primaryId})` : ""}: unconfirmed — ` +
				"cannot confirm clean (push-only, silent-on-clean, e.g. classic " +
				"typescript-language-server never publishes on a clean re-check). " +
				"NOT the same as 0 diagnostics; re-check after an edit, or use " +
				"waitMs to wait longer."
			);
		}
		if (primaryDiags.length === 0) {
			return `Primary LSP${primaryId ? ` (${primaryId})` : ""}: confirmed clean.`;
		}
		return `Primary LSP${primaryId ? ` (${primaryId})` : ""}: ${primaryDiags.length} diagnostic${primaryDiags.length === 1 ? "" : "s"}.`;
	})();

	// #1470: this is the narrowing made readable. It states exactly which servers
	// this result does NOT speak for, so "no auxiliary findings" can never be read
	// as "the security scanners found nothing".
	const coverageLine =
		unconfirmedServerIds.length > 0
			? `Auxiliary coverage INCOMPLETE — ${[...unconfirmedServerIds].join(", ")} did not answer within the wait budget, so ${unconfirmedServerIds.length === 1 ? "its findings are" : "their findings are"} NOT included here. This is not a clean bill of health for ${unconfirmedServerIds.length === 1 ? "that scanner" : "those scanners"}; re-check after the next edit. waitMs can extend an ordinary wait, but it cannot override a session-demoted scanner.`
			: undefined;

	let text: string;
	if (total === 0) {
		text = [
			primaryLine,
			"",
			unavailable ?? "No auxiliary findings.",
			...(coverageLine ? [coverageLine] : []),
		].join("\n");
	} else {
		const lines = [primaryLine, ""];
		if (primaryDiags.length > 0) {
			lines.push(...primaryDiags.map(formatDiag), "");
		}
		if (auxiliaryDiags.length > 0) {
			lines.push(`Auxiliary findings (${auxiliaryDiags.length}):`);
			lines.push(...auxiliaryDiags.map(formatDiag));
		}
		if (coverageLine) lines.push("", coverageLine);
		if (unavailable) lines.unshift(unavailable, "");
		if (truncated) {
			lines.unshift(
				`Found ${total} diagnostics (showing first ${MAX_DIAGNOSTICS}):`,
			);
		}
		text = lines.join("\n");
	}

	return {
		content: [{ type: "text" as const, text }],
		details: {
			filePath: absPath,
			mode: "file",
			severity,
			serverScope,
			primaryServerId: primaryId,
			primaryDiagnosticsCount: primaryDiags.length,
			auxiliaryDiagnosticsCount: auxiliaryDiags.length,
			diagnostics: limited.map((d) => ({
				line: d.range?.start?.line,
				character: d.range?.start?.character,
				severity: d.severity,
				message: d.message,
				source: d.source,
				code: d.code,
			})),
			totalDiagnostics: total,
			truncated,
			unconfirmed,
			timedOut: unconfirmed ? timedOut : undefined,
			navigationOnlyFiles:
				diagnosticsUnsupportedServerIds.length > 0 ? 1 : undefined,
			...(skipReason !== undefined && { skipReason }),
			// #1470: which servers this result does NOT speak for. Absent when it
			// speaks for all of them.
			...(unconfirmedServerIds.length > 0 && {
				unconfirmedServerIds: [...unconfirmedServerIds],
			}),
			lspHealth,
			waitMs,
		},
	};
}

/**
 * #533: tally the per-file discriminated outcome across a batch/directory
 * result set. `unconfirmed` files are those whose diagnostics collapsed to an
 * empty array from a push-only, silent-on-clean server (see
 * `classifyEmptyResult`) — they must never be folded into "clean" in the
 * aggregate render, or a majority-unconfirmed result reads as a false "0
 * diagnostics across N files".
 */
function tallyConfirmation(results: FileDiagnosticResult[]): {
	clean: number;
	unconfirmed: number;
	timedOut: number;
	navigationOnly: number;
} {
	let clean = 0;
	let unconfirmed = 0;
	let timedOut = 0;
	let navigationOnly = 0;
	for (const result of results) {
		if (result.diagnosticsUnsupported) {
			navigationOnly += 1;
			continue;
		}
		if (result.diagnostics.length > 0) continue;
		if (result.confirmation === "unconfirmed") {
			unconfirmed += 1;
			// #570: timed-out checks are a subset of "unconfirmed" — tallied
			// separately so the aggregate text can say WHY, not just THAT.
			if (result.timedOut) timedOut += 1;
		} else {
			clean += 1;
		}
	}
	return { clean, unconfirmed, timedOut, navigationOnly };
}

function classifyBatchFileOutcome(
	result: FileDiagnosticResult,
): BatchFileOutcome {
	if (result.error) return "failed";
	if (result.diagnosticsUnsupported) return "unsupported";
	// A timed-out/unconfirmed answer may contain partial findings, but it cannot
	// honestly be called a complete findings result. Keep the raw findings for
	// investigation while making the aggregate incomplete.
	if (result.timedOut || result.confirmation === "unconfirmed") {
		return "inconclusive";
	}
	if (result.diagnostics.length > 0) return "findings";
	if (result.unavailable) {
		return result.primaryServerId ? "unavailable" : "unsupported";
	}
	if (!result.primaryServerId) return "unsupported";
	return "clean";
}

function inconclusiveBatchResult(
	file: string,
	reason: string,
): FileDiagnosticResult {
	return {
		file,
		diagnostics: [],
		confirmation: "unconfirmed",
		timedOut: true,
		outcome: "inconclusive",
		inconclusiveReason: reason,
	};
}

/**
 * #570: build the explanatory clause for a batch/directory result that has
 * unconfirmed files, distinguishing timed-out checks from the pre-existing
 * #533 silent-on-clean-server bucket — both are "unconfirmed" for counting,
 * but the reason differs and misreporting a timeout as "server can't confirm
 * clean" would itself be misleading.
 */
function unconfirmedReasonClause(
	unconfirmed: number,
	timedOut: number,
): string {
	const silent = unconfirmed - timedOut;
	if (timedOut > 0 && silent > 0) {
		return (
			`${timedOut} timed out (check didn't complete within budget) and ` +
			`${silent} from a server that cannot confirm clean (push-only, ` +
			"silent-on-clean)."
		);
	}
	if (timedOut > 0) {
		return `${timedOut} timed out (check didn't complete within the wait budget).`;
	}
	return (
		"from a server that cannot confirm clean (push-only, silent-on-clean; " +
		"e.g. classic typescript-language-server does not publish on a clean " +
		"re-check)."
	);
}

/**
 * Fan out `collectFileDiagnosticResult` across a file list at bounded
 * concurrency and reduce the results into the shape both batch-style callers
 * (`runBatchFileDiagnostics`/`runDirectoryDiagnostics`) render from —
 * previously duplicated identically between them (SonarCloud
 * `new_duplicated_lines_density` gate, surfaced when #571 added the
 * `nextWriteIndex` threading to both call sites). Purely mechanical
 * extraction: no behavior change, and does NOT touch the confirmed/
 * unconfirmed semantics `collectFileDiagnosticResult`/`tallyConfirmation`
 * already encode — those, and `lens_diagnostics` mode=full's separate,
 * deliberately different confirmation gate in `tools/lens-diagnostics.ts`,
 * are unrelated to this file's internal duplication and are left exactly
 * as they were.
 */
async function collectBatchDiagnostics(
	files: string[],
	severity: string,
	lspService: NonNullable<ReturnType<typeof getLSPService>>,
	options: BatchOptions,
): Promise<{
	results: FileDiagnosticResult[];
	fileErrors: string[];
	lspHealthWarnings: string[];
	total: number;
	truncated: boolean;
	display: FileDiag[];
	primaryDisplay: FileDiag[];
	auxiliaryDisplay: FileDiag[];
	clean: number;
	unconfirmed: number;
	timedOut: number;
	outcomeCounts: Record<BatchFileOutcome, number>;
	incompleteFiles: number;
}> {
	// #671: one cache context for this whole batch/directory sweep — loaded
	// once, written back once after every file has been processed (see the
	// `persist()` call below), rather than round-tripping the on-disk cache
	// file per-file. Shared store with `runWorkspaceDiagnostics` (`lens_
	// diagnostics mode=full`'s engine); `scopeKey` keeps the two tools'
	// differently-scoped touches (this tool never excludes any server, that
	// one excludes opengrep — see `buildScopeKey`'s doc) from cross-serving
	// entries that wouldn't actually match what each asked for.
	const resolvedCwd = options.cwd ?? process.cwd();
	const cacheCtx = createWorkspaceDiagnosticsCacheContext(resolvedCwd);
	const scopeKey = buildScopeKey(options.serverScope ?? "all");
	const results = await mapWithConcurrency(
		files,
		options.concurrency,
		async (file) => {
			const work = collectFileDiagnosticResult(
				file,
				severity,
				lspService,
				options.waitMs,
				options.nextWriteIndex,
				options.serverScope,
				cacheCtx,
				scopeKey,
				resolvedCwd,
				options.onConfirmedNoBlockers,
			);
			const bounded = withDeadline(work, {
				ms: batchFileDeadlineMs(),
				onTimeout: "undefined",
				onReject: "undefined",
			});
			const result = options.signal
				? await Promise.race([
						bounded,
						new Promise<FileDiagnosticResult | undefined>((resolve) => {
							if (options.signal?.aborted) {
								resolve(undefined);
								return;
							}
							options.signal?.addEventListener(
								"abort",
								() => resolve(undefined),
								{
									once: true,
								},
							);
						}),
					])
				: await bounded;
			return (
				result ??
				inconclusiveBatchResult(
					file,
					options.signal?.aborted
						? "Batch aborted before this file completed."
						: `File check exceeded ${batchFileDeadlineMs()}ms.`,
				)
			);
		},
		lspService,
		options.signal,
		options.onProgress,
	);
	// Persist whatever was recorded, including a partial/aborted sweep's
	// already-completed files — same "don't throw away confirmed work"
	// posture as `runWorkspaceDiagnostics`.
	cacheCtx.persist();
	const fileErrors = results.flatMap((result) =>
		result.error ? [result.error] : [],
	);
	const lspHealthWarnings = results.flatMap((result) =>
		result.unavailable ? [result.unavailable] : [],
	);
	const allDiags = results.flatMap((result) => result.diagnostics);
	const total = allDiags.length;
	const truncated = total > MAX_DIAGNOSTICS;
	const display = truncated ? allDiags.slice(0, MAX_DIAGNOSTICS) : allDiags;
	const { clean, unconfirmed, timedOut } = tallyConfirmation(results);
	for (const result of results) {
		result.outcome = classifyBatchFileOutcome(result);
	}
	const outcomeCounts = Object.fromEntries(
		(
			[
				"clean",
				"findings",
				"unsupported",
				"unavailable",
				"failed",
				"inconclusive",
			] as const
		).map((outcome) => [
			outcome,
			results.filter((result) => result.outcome === outcome).length,
		]),
	) as Record<BatchFileOutcome, number>;
	// Per-file primary-server lookup so a flattened multi-file `display` list
	// can still be split into "primary findings" vs "auxiliary findings" —
	// `clean`/`unconfirmed` above already reflect ONLY the primary server's
	// confirmation; this split does the same job for the listed diagnostics.
	const primaryIdByFile = new Map(
		results.map((r) => [r.file, r.primaryServerId] as const),
	);
	const primaryDisplay = display.filter(
		(d) => d.serverId === primaryIdByFile.get(d.file),
	);
	const auxiliaryDisplay = display.filter(
		(d) => d.serverId !== primaryIdByFile.get(d.file),
	);
	return {
		results,
		fileErrors,
		lspHealthWarnings,
		total,
		truncated,
		display,
		primaryDisplay,
		auxiliaryDisplay,
		clean,
		unconfirmed,
		timedOut,
		outcomeCounts,
		incompleteFiles: Math.max(0, files.length - results.length),
	};
}

async function runBatchFileDiagnostics(
	absPaths: string[],
	severity: string,
	lspService: NonNullable<ReturnType<typeof getLSPService>>,
	options: BatchOptions,
) {
	if (absPaths.length === 0) {
		return {
			content: [{ type: "text" as const, text: "No file paths provided." }],
			isError: true,
			details: { mode: "batch", severity, filesChecked: 0 },
		};
	}

	const {
		results,
		fileErrors,
		lspHealthWarnings,
		total,
		truncated,
		display,
		primaryDisplay,
		auxiliaryDisplay,
		clean,
		unconfirmed,
		timedOut,
		outcomeCounts,
		incompleteFiles,
	} = await collectBatchDiagnostics(absPaths, severity, lspService, options);
	const navigationOnly = results.filter(
		(result) => result.diagnosticsUnsupported,
	).length;

	const lines: string[] = [
		`Files checked: ${results.length}`,
		`Total diagnostics: ${total}`,
		`Concurrency: ${options.concurrency}`,
	];
	if (options.waitMs !== undefined)
		lines.push(`Wait budget: ${options.waitMs}ms`);
	lines.push(
		`Outcomes: ${Object.entries(outcomeCounts)
			.map(([outcome, count]) => `${outcome}=${count}`)
			.join(", ")}`,
	);
	const notConfirmed =
		outcomeCounts.inconclusive +
		outcomeCounts.unavailable +
		outcomeCounts.unsupported +
		outcomeCounts.failed +
		incompleteFiles;
	if (notConfirmed > 0) {
		lines.push(
			"",
			`Checks not confirmed: ${notConfirmed} (inconclusive/unavailable/unsupported/failed or not started).`,
		);
	}
	if (incompleteFiles > 0) {
		lines.push(
			"",
			`Batch incomplete: ${incompleteFiles} file${incompleteFiles === 1 ? "" : "s"} were not confirmed because the batch was aborted.`,
		);
	}
	if (fileErrors.length > 0) lines.push("", "File errors:", ...fileErrors);
	if (lspHealthWarnings.length > 0) {
		lines.push("", "LSP health warnings:", ...lspHealthWarnings.slice(0, 10));
	}
	// #533/#570: surface unconfirmed files regardless of whether OTHER files in
	// the batch found real diagnostics — a mixed found/unconfirmed result must
	// not let the unconfirmed files silently pass as clean just because the
	// batch as a whole isn't "0 diagnostics". This tally is primary-server-only
	// (see collectFileDiagnosticResult) — it's the batch-level equivalent of
	// the single-file "Primary LSP: ..." line, always reported on its own.
	if (unconfirmed > 0) {
		lines.push(
			"",
			`${clean} file${clean === 1 ? "" : "s"} confirmed clean, ${unconfirmed} unconfirmed: ` +
				`${unconfirmedReasonClause(unconfirmed, timedOut)} NOT the same as 0 diagnostics.`,
		);
	}
	if (display.length === 0) {
		if (unconfirmed === 0) {
			lines.push("", "No diagnostics found.");
		}
	} else {
		if (primaryDisplay.length > 0) {
			lines.push("", `Primary findings (${primaryDisplay.length}):`);
			lines.push(...primaryDisplay.map(formatDisplayDiag));
		}
		if (auxiliaryDisplay.length > 0) {
			lines.push("", `Auxiliary findings (${auxiliaryDisplay.length}):`);
			lines.push(...auxiliaryDisplay.map(formatDisplayDiag));
		}
		if (truncated) {
			lines.push(
				"",
				`... (${total - MAX_DIAGNOSTICS} more diagnostics not shown)`,
			);
		}
	}

	return {
		content: [{ type: "text" as const, text: lines.join("\n") }],
		details: {
			mode: "batch",
			severity,
			serverScope: options.serverScope ?? "all",
			filesChecked: results.length,
			concurrency: options.concurrency,
			waitMs: options.waitMs,
			diagnostics: display,
			primaryDiagnosticsCount: primaryDisplay.length,
			auxiliaryDiagnosticsCount: auxiliaryDisplay.length,
			totalDiagnostics: total,
			truncated,
			cleanFiles: clean,
			unconfirmedFiles: unconfirmed,
			navigationOnlyFiles: navigationOnly > 0 ? navigationOnly : undefined,
			timedOutFiles: timedOut > 0 ? timedOut : undefined,
			outcomes: results.map((result) => ({
				file: result.file,
				outcome: result.outcome,
				reason: result.inconclusiveReason ?? result.error ?? result.unavailable,
				primaryDiagnosticsCount: result.diagnostics.filter(
					(diagnostic) => diagnostic.serverId === result.primaryServerId,
				).length,
				auxiliaryDiagnosticsCount: result.diagnostics.filter(
					(diagnostic) => diagnostic.serverId !== result.primaryServerId,
				).length,
			})),
			outcomeCounts,
			incompleteFiles: incompleteFiles > 0 ? incompleteFiles : undefined,
			fileErrors: fileErrors.length > 0 ? fileErrors : undefined,
			lspHealthWarnings:
				lspHealthWarnings.length > 0 ? lspHealthWarnings : undefined,
		},
	};
}

/**
 * The scan-language DECISION `runDirectoryDiagnostics` makes, pulled out as
 * its own function so `tests/tools/lsp-diagnostics-scan-family.test.ts` can
 * pin it against the golden `LANG_EXTENSIONS` table for every 1- and
 * 2-extension combination in that table's universe without spinning up one
 * real directory (and the full LSP-mocked tool) per combination — `hasMatch`
 * is the only I/O-shaped seam, so the caller decides whether it is backed by
 * a real `collectFiles` walk (production) or an in-memory extension-set probe
 * (tests).
 *
 * Walks `SCAN_LANGUAGE_PRIORITY`'s FAMILIES in order and unions each member
 * id's {@link extensionsForLanguage} into ONE `hasMatch` call — the first
 * family with any match wins the whole directory for this pass. Grouping by
 * family (not trying each id alone) is what makes a directory mixing BOTH
 * extensions of a registry-split pair (`.ts`+`.tsx`, `.css`+`.scss`, ...)
 * behavior-preserving vs the pre-#2434 bundled-key table: a flat per-id loop
 * stopped at the first id with ANY match, silently losing the sibling half of
 * a split pair present in the same directory (#2458 fix-round F1).
 */
export async function resolveDirectoryScanExtensions(
	hasMatch: (extensions: readonly string[]) => boolean | Promise<boolean>,
): Promise<readonly string[] | undefined> {
	for (const family of SCAN_LANGUAGE_PRIORITY) {
		const exts = family.flatMap((languageId) =>
			extensionsForLanguage(languageId),
		);
		if (await hasMatch(exts)) {
			return exts;
		}
	}
	return undefined;
}

async function runDirectoryDiagnostics(
	absPath: string,
	severity: string,
	lspService: NonNullable<ReturnType<typeof getLSPService>>,
	options: BatchOptions,
) {
	let collectedFiles: string[] = [];

	const isIgnored = projectIgnorePredicate(absPath);
	await resolveDirectoryScanExtensions(async (exts) => {
		collectedFiles = await collectFiles(
			absPath,
			[...exts],
			MAX_FILES + 1,
			isIgnored,
		);
		return collectedFiles.length > 0;
	});

	if (collectedFiles.length === 0) {
		return {
			content: [
				{
					type: "text" as const,
					text: `No supported source files found in: ${absPath}`,
				},
			],
			details: {
				filePath: absPath,
				mode: "directory",
				severity,
				filesScanned: 0,
			},
		};
	}

	const wasCapped = collectedFiles.length > MAX_FILES;
	const filesToProcess = collectedFiles.slice(0, MAX_FILES);
	const {
		results,
		fileErrors,
		lspHealthWarnings,
		total,
		truncated,
		display,
		primaryDisplay,
		auxiliaryDisplay,
		clean,
		unconfirmed,
		timedOut,
	} = await collectBatchDiagnostics(
		filesToProcess,
		severity,
		lspService,
		options,
	);
	const navigationOnly = results.filter(
		(result) => result.diagnosticsUnsupported,
	).length;

	let text: string;
	if (total === 0) {
		// #533/#570: an unconfirmed-containing directory result must never
		// render as a bare "no diagnostics" — that reads as an affirmative
		// clean scan the server never actually gave for those files.
		const cleanLine =
			unconfirmed > 0
				? `${clean} clean · ${unconfirmed} unconfirmed: ` +
					`${unconfirmedReasonClause(unconfirmed, timedOut)} NOT the same as 0 diagnostics.`
				: "No diagnostics found.";
		text = [
			`Directory: ${absPath}`,
			`Files scanned: ${filesToProcess.length}${wasCapped ? ` (capped at ${MAX_FILES})` : ""}`,
			...(lspHealthWarnings.length > 0
				? [
						"LSP unavailable for one or more files:",
						...lspHealthWarnings.slice(0, 10),
					]
				: [cleanLine]),
		].join("\n");
	} else {
		const lines: string[] = [
			`Directory: ${absPath}`,
			`Files scanned: ${filesToProcess.length}${wasCapped ? ` (capped at ${MAX_FILES})` : ""}`,
			`Files with errors: ${new Set(display.map((d) => d.file)).size}`,
			`Total diagnostics: ${total}`,
			...(lspHealthWarnings.length > 0
				? ["", "LSP health warnings:", ...lspHealthWarnings.slice(0, 10)]
				: []),
			// #533/#570: the remaining clean-looking files in a mixed scan may
			// still be unconfirmed — say so even though the directory as a
			// whole found diagnostics elsewhere.
			...(unconfirmed > 0
				? [
						"",
						`${clean} other file${clean === 1 ? "" : "s"} confirmed clean, ${unconfirmed} unconfirmed: ` +
							unconfirmedReasonClause(unconfirmed, timedOut),
					]
				: []),
			"",
		];
		const toRelative = (d: FileDiag): FileDiag => ({
			...d,
			file: path.relative(absPath, d.file),
		});
		if (primaryDisplay.length > 0) {
			lines.push(`Primary findings (${primaryDisplay.length}):`);
			lines.push(...primaryDisplay.map(toRelative).map(formatDisplayDiag));
			lines.push("");
		}
		if (auxiliaryDisplay.length > 0) {
			lines.push(`Auxiliary findings (${auxiliaryDisplay.length}):`);
			lines.push(...auxiliaryDisplay.map(toRelative).map(formatDisplayDiag));
		}
		if (truncated) {
			lines.push(
				"",
				`... (${total - MAX_DIAGNOSTICS} more diagnostics not shown)`,
			);
		}
		text = lines.join("\n");
	}

	return {
		content: [{ type: "text" as const, text }],
		details: {
			filePath: absPath,
			mode: "directory",
			severity,
			serverScope: options.serverScope ?? "all",
			filesScanned: filesToProcess.length,
			capped: wasCapped,
			diagnostics: display.map((d) => ({
				file: path.relative(absPath, d.file),
				line: d.line,
				character: d.character,
				severity: d.severity,
				message: d.message,
				source: d.source,
				code: d.code,
			})),
			primaryDiagnosticsCount: primaryDisplay.length,
			auxiliaryDiagnosticsCount: auxiliaryDisplay.length,
			totalDiagnostics: total,
			truncated,
			cleanFiles: clean,
			unconfirmedFiles: unconfirmed,
			navigationOnlyFiles: navigationOnly > 0 ? navigationOnly : undefined,
			timedOutFiles: timedOut > 0 ? timedOut : undefined,
			fileErrors: fileErrors.length > 0 ? fileErrors : undefined,
			lspHealthWarnings:
				lspHealthWarnings.length > 0 ? lspHealthWarnings : undefined,
			concurrency: options.concurrency,
			waitMs: options.waitMs,
		},
	};
}

// ── helpers ─────────────────────────────────────────────────────────────

function applySeverityFilter<T extends { severity: number }>(
	diags: T[],
	severity: string,
): T[] {
	if (severity === "all") return diags;
	const maxLevel: Record<string, number> = {
		error: 1,
		warning: 2,
		information: 3,
		hint: 4,
	};
	const max = maxLevel[severity] ?? 0;
	if (max === 0) return diags;
	return diags.filter((d) => (d.severity ?? 3) <= max);
}

function formatDisplayDiag(d: FileDiag): string {
	const sevName = SEVERITY_NAMES[d.severity] ?? "unknown";
	const loc =
		d.line !== undefined
			? `${d.file}:${d.line + 1}:${(d.character ?? 0) + 1}`
			: d.file;
	const src = d.source ? `[${d.source}]` : "";
	const code = d.code ? ` (${d.code})` : "";
	return `${loc}: ${sevName}${src}${code}: ${d.message}`;
}

function formatDiag(diag: LSPDiagnostic): string {
	const loc =
		diag.range?.start?.line !== undefined
			? `L${diag.range.start.line + 1}:${(diag.range.start.character ?? 0) + 1}`
			: "";
	const src = diag.source ? `[${diag.source}]` : "";
	const code = diag.code ? ` (${diag.code})` : "";
	const sevName = SEVERITY_NAMES[diag.severity] ?? "unknown";
	return `${loc}: ${sevName}${src}${code}: ${diag.message}`;
}
