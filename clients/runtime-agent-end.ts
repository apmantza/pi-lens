import * as nodeFs from "node:fs";
import * as path from "node:path";
import {
	type ActionableWarningsReport,
	applyConservativeActionableWarningFixes,
	checkActionableWarningsReportFresh,
} from "./actionable-warnings.js";
import { publishFilesTouched } from "./bus-publish.js";
import type { CacheManager } from "./cache-manager.js";
import type { BiomeClient } from "./biome-client.js";
import type { RuffClient } from "./ruff-client.js";
import {
	publishAutofixStart,
	publishFormatStart,
} from "./format-events-publish.js";
import type { FormatService } from "./format-service.js";
import { logLatency } from "./latency-logger.js";
import { isPathIgnoredByProject } from "./file-utils.js";
import { admitBounded, emitBounded } from "./bounded-telemetry.js";
import {
	newLspMutationCorrelationId,
	type LspMutationContext,
} from "./lsp-mutation.js";
import {
	getGlobalActionableWarningMaxFixes,
	type PiLensFlagSource,
} from "./lens-config.js";
import { resyncLspFile, runAutofix, runFormatPhase } from "./pipeline.js";
import { getAmbientAbortSignal } from "./safe-spawn.js";
import { type ProjectChangeSource } from "./project-changes.js";
import type { RuntimeCoordinator } from "./runtime-coordinator.js";
import {
	getAutofixPolicyForFile,
	hasBiomeConfig,
	hasDetektConfig,
	hasEslintConfig,
	hasGolangciConfig,
	hasKtfmtConfig,
	hasKtlintConfig,
	hasOxlintConfig,
	hasRubocopConfig,
	hasSqlfluffConfig,
	hasStylelintConfig,
} from "./tool-policy.js";

/**
 * A queued file is claimed by any flush once it has sat unclaimed by its own
 * owning session for this long — recovery for an orphaned record whose
 * owner (e.g. a primary session that crashed mid-run) will never flush it
 * itself. Generous on purpose: normal same-session flushes never hit this
 * path at all (they match on `ownerSessionId`), so this only trades a little
 * extra staleness for guaranteed eventual formatting. (#791)
 */
export const DEFERRED_FORMAT_STALE_AFTER_MS = 10 * 60_000;
const DEFERRED_FORMAT_CONCURRENCY = 3;

interface AgentEndDeps {
	ctxCwd?: string;
	getFlag: (name: string, filePath?: string) => boolean | string | undefined;
	/** Optional: provenance for dbg/skip logs — see `PipelineContext["getFlagSource"]` (#792). */
	getFlagSource?: (name: string, filePath?: string) => PiLensFlagSource;
	notify: (msg: string, level: "info" | "warning" | "error") => void;
	dbg: (msg: string) => void;
	runtime: RuntimeCoordinator;
	cacheManager: CacheManager;
	getFormatService: () => FormatService;
	biomeClient?: BiomeClient;
	ruffClient?: RuffClient;
	getAutofixClients?: () => Promise<{
		biomeClient: BiomeClient;
		ruffClient: RuffClient;
	}>;
	/**
	 * The STABLE pi session id for the ctx this `agent_end` fired on. Used to
	 * scope the deferred-format drain to records this session actually
	 * queued (#791) — omit (or leave `undefined`, e.g. in existing tests) to
	 * fall back to today's "claim everything" behavior.
	 */
	currentSessionId?: string;
	/** Test/override hook for {@link DEFERRED_FORMAT_STALE_AFTER_MS}. */
	staleAfterMs?: number;
}

export interface AgentEndFormatSummary {
	queued: number;
	formatted: number;
	changed: string[];
	failed: Array<{ filePath: string; errors: string[] }>;
	skipped: Array<{ filePath: string; reason: string }>;
}

function recordProjectChange(args: {
	runtime: RuntimeCoordinator;
	cwd: string;
	filePath: string;
	source: ProjectChangeSource;
	dbg: (msg: string) => void;
}): void {
	// One mutation seam (#2000 phase 1): bump + receipt + change-log live in
	// RuntimeCoordinator.recordProjectMutation; this wrapper only carries the
	// legacy dbg shape.
	(args.runtime as Partial<RuntimeCoordinator>).recordProjectMutation?.({
		filePath: args.filePath,
		source: args.source,
		cwd: args.cwd,
		onAppendError: (err) =>
			args.dbg(`project change log append failed for ${args.filePath}: ${err}`),
	});
}

export async function handleAgentEnd({
	ctxCwd,
	getFlag,
	getFlagSource,
	notify,
	dbg,
	runtime,
	cacheManager,
	getFormatService,
	biomeClient,
	ruffClient,
	getAutofixClients,
	currentSessionId,
	staleAfterMs = DEFERRED_FORMAT_STALE_AFTER_MS,
}: AgentEndDeps): Promise<AgentEndFormatSummary | undefined> {
	// #791: ownership-filtered drain — records queued by a DIFFERENT known
	// session (e.g. a concurrent in-process secondary/subagent) stay queued
	// for their owner's own agent_end, unless they've been stale long enough
	// to fall back to "claim as orphaned" (see claimDeferredFormatFiles).
	const { claimed, staleClaimed, deferredToOwner, droppedOrphans } =
		runtime.claimDeferredMutations(
			currentSessionId,
			Date.now(),
			staleAfterMs,
			ctxCwd ?? runtime.projectRoot,
		);
	const records = [...claimed, ...staleClaimed];
	const requeuedKinds = new Set<"autofix" | "format">();
	// S2d (gap 4, #1432 review): the aggregate `agent_end_deferred_mutation_drain`
	// row only carried a coalesced `requeuedKinds` set with no reason, per-call
	// file count, or tool provenance — every requeue (abort mid-drain, missing
	// autofix clients, an autofix/format failure) collapsed into one
	// indistinguishable bucket. Log one bounded record PER requeue call instead,
	// so a real incident can tell "aborted with N files still queued" apart
	// from "M files failed to format".
	const requeue = (
		pending: Parameters<RuntimeCoordinator["requeueDeferredMutations"]>[0],
		reason:
			| "abort"
			| "autofix-failed"
			| "format-failed"
			| "clients-unavailable",
	): void => {
		if (pending.length === 0) return;
		const kinds = new Set<"autofix" | "format">();
		const toolNames = new Set<string>();
		for (const record of pending) {
			for (const kind of record.kinds) {
				requeuedKinds.add(kind);
				kinds.add(kind);
			}
			for (const toolName of record.toolNames) toolNames.add(toolName);
		}
		logLatency({
			type: "phase",
			toolName: "agent_end",
			filePath: ctxCwd ?? runtime.projectRoot,
			phase: "agent_end_deferred_mutation_requeue",
			durationMs: 0,
			metadata: {
				reason,
				kinds: [...kinds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
				fileCount: pending.length,
				toolNames: [...toolNames].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
			},
		});
		runtime.requeueDeferredMutations(pending);
	};
	const rootActionableAutofixEnabled = !!getFlag(
		"lens-actionable-warning-autofix",
	);
	// The actionable-warnings cache is only ever written when the
	// "lens-actionable-warnings" writer flag is on (clients/runtime-turn.ts).
	// A reader that ignores this gate always misses in a host where the
	// writer is off and logs "cache missing or expired" at every agent_end,
	// misdirecting the debug log toward a bogus cache problem instead of the
	// real cause: the feature that populates the cache is disabled (#1607).
	const actionableWarningsWriterEnabled = !!getFlag("lens-actionable-warnings");
	// A path-aware source resolver signals that nested configs may re-enable
	// actionable autofix even when the root default is off. Legacy/test hosts
	// without that resolver keep the old fast exit and avoid a cache read.
	const inspectActionableReport =
		actionableWarningsWriterEnabled &&
		typeof cacheManager.readCache === "function" &&
		(rootActionableAutofixEnabled || getFlagSource !== undefined);
	if (droppedOrphans.length > 0) {
		// #1642 F3: a stale/foreign record whose origin (the cwd/worktree it
		// was actually queued under) does NOT match this flush's own
		// workspace/worktree is left queued and NEVER formatted by this
		// flush — claiming it would be the same worktree→parent
		// re-attribution the reported incident hit, just via the orphan
		// fallback instead of tool_result's path resolution. It stays in
		// `_pendingDeferredMutations` (not deleted) so a flush whose origin
		// actually matches can still claim it later; a genuinely abandoned
		// origin will keep surfacing this record on every subsequent
		// agent_end, which is the deliberately safer trade-off over silently
		// losing it forever.
		dbg(
			`agent_end deferred_format: left ${droppedOrphans.length} orphaned file(s) queued due to a mismatched origin (unclaimed >${staleAfterMs}ms, not formatted by this flush): ${droppedOrphans
				.map((r) => `${r.filePath} origin=${r.originCwd}`)
				.join(", ")}`,
		);
		// #1678 item 1: a genuinely abandoned origin re-surfaces the SAME
		// record on every subsequent agent_end for as long as the queued
		// entry lives — by design (see the comment above), but the repo
		// invariant is that a repeated degradation goes through the ledger's
		// counting path instead of accumulating as unbounded raw log lines.
		// The ledger is the single source of truth for whether THIS is a
		// record's first appearance (its return value): the detailed forensic
		// record below names only the orphans on that rising edge, with file
		// identity/origin/age. Every later repeat of
		// the same record is counted ONLY by the ledger's running count —
		// no second raw event, no parallel "already logged" latch to
		// maintain here.
		// #1743: `admitBounded` IS that ledger call, plus the registry
		// membership the bounded-telemetry sweep checks. This site admits PER
		// ORPHAN and then writes ONE batched record naming the admitted ones,
		// which is why it uses `admitBounded` directly instead of a per-record
		// `emitBounded` — the per-call form would turn one log line into N.
		const firstSeenOrphans: typeof droppedOrphans = [];
		for (const record of droppedOrphans) {
			const isFirstOccurrence = admitBounded(
				"agent_end_deferred_format_orphan_origin_mismatch",
				record.filePath,
				{
					ledgerKind: "path-attribution-orphan-unresolved",
					risingEdgePer: "identity",
					reason: `origin=${record.originCwd} unclaimed >${staleAfterMs}ms`,
				},
			);
			if (isFirstOccurrence) firstSeenOrphans.push(record);
		}
		if (firstSeenOrphans.length > 0) {
			// Already admitted above, one orphan at a time — hence no bounding
			// options here. The batch's own identity is the origin this flush ran
			// under; per-file identity rides in `metadata.files`.
			emitBounded(
				"agent_end_deferred_format_orphan_origin_mismatch",
				ctxCwd ?? runtime.projectRoot,
				{
					type: "phase",
					toolName: "agent_end",
					durationMs: 0,
					metadata: {
						fileCount: firstSeenOrphans.length,
						staleAfterMs,
						currentOriginCwd: ctxCwd ?? runtime.projectRoot,
						files: firstSeenOrphans.map((r) => ({
							filePath: r.filePath,
							originCwd: r.originCwd,
							ownerSessionId: r.ownerSessionId,
							queuedTurnIndex: r.queuedTurnIndex,
							ageMs: Date.now() - r.lastTouchedAt,
						})),
					},
				},
			);
		}
	}
	if (records.length === 0 && !inspectActionableReport) return undefined;
	if (deferredToOwner.length > 0) {
		dbg(
			`agent_end deferred_format: leaving ${deferredToOwner.length} file(s) queued for their owning session (${deferredToOwner
				.map((r) => `${r.filePath} owner=${r.ownerSessionId}`)
				.join(", ")})`,
		);
	}
	if (staleClaimed.length > 0) {
		dbg(
			`agent_end deferred_format: staleness fallback claimed ${staleClaimed.length} orphaned file(s) (unclaimed >${staleAfterMs}ms): ${staleClaimed
				.map((r) => r.filePath)
				.join(", ")}`,
		);
		logLatency({
			type: "phase",
			toolName: "agent_end",
			filePath: ctxCwd ?? runtime.projectRoot,
			phase: "agent_end_deferred_format_stale_claim",
			durationMs: 0,
			metadata: {
				fileCount: staleClaimed.length,
				staleAfterMs,
				files: staleClaimed.map((r) => ({
					filePath: r.filePath,
					ownerSessionId: r.ownerSessionId,
					queuedTurnIndex: r.queuedTurnIndex,
					ageMs: Date.now() - r.lastTouchedAt,
				})),
			},
		});
	}
	const startedAt = Date.now();
	const summary: AgentEndFormatSummary = {
		queued: records.length,
		formatted: 0,
		changed: [],
		failed: [],
		skipped: [],
	};
	// #502 fix provenance: per-path {tool, kind} entries accumulated across the
	// deferred-format loop below, passed as `fixes` on the batch
	// publishFilesTouched call so consumers can tell "pi-lens formatted this"
	// from an agent edit.
	const deferredFormatFixes: Array<{
		path: string;
		tool: string;
		kind: "format";
	}> = [];
	const deferredAutofixFixes: Array<{
		path: string;
		tool: string;
		kind: "autofix";
	}> = [];
	const deferredAutofixChanged = new Set<string>();

	// Mutation ordering is intentional: lint --write may disturb wrapping, so
	// autofix reaches the final edited state first and formatting stabilizes it.
	const ambientSignal = getAmbientAbortSignal();
	const executedAutofixScopes = new Set<string>();
	const autofixRecords = records.filter((candidate) =>
		candidate.kinds.has("autofix"),
	);
	if (
		autofixRecords.length > 0 &&
		(!biomeClient || !ruffClient) &&
		getAutofixClients
	) {
		({ biomeClient, ruffClient } = await getAutofixClients());
	}
	for (
		let autofixIndex = 0;
		autofixIndex < autofixRecords.length;
		autofixIndex++
	) {
		const record = autofixRecords[autofixIndex];
		if (ambientSignal?.aborted) {
			requeue(
				autofixRecords.slice(autofixIndex).map((pending) => ({
					...pending,
					kinds: new Set(["autofix" as const]),
					toolNames: new Set(pending.toolNames),
				})),
				"abort",
			);
			break;
		}
		const filePath = path.resolve(record.filePath);
		if (!nodeFs.existsSync(filePath)) {
			summary.skipped.push({ filePath, reason: "missing" });
			continue;
		}
		if (!biomeClient || !ruffClient) {
			dbg(`agent_end deferred_autofix: clients unavailable for ${filePath}`);
			requeue(
				[
					{
						...record,
						kinds: new Set(["autofix"]),
						toolNames: new Set(record.toolNames),
					},
				],
				"clients-unavailable",
			);
			continue;
		}
		const policy = getAutofixPolicyForFile(filePath, {
			hasEslintConfig: hasEslintConfig(record.cwd),
			hasStylelintConfig: hasStylelintConfig(record.cwd),
			hasSqlfluffConfig: hasSqlfluffConfig(record.cwd),
			hasRubocopConfig: hasRubocopConfig(record.cwd),
			hasBiomeConfig: hasBiomeConfig(record.cwd),
			hasGolangciConfig: hasGolangciConfig(record.cwd),
			hasDetektConfig: hasDetektConfig(record.cwd),
			hasOxlintConfig: hasOxlintConfig(record.cwd),
			hasKtfmtConfig: hasKtfmtConfig(record.cwd),
			hasKtlintConfig: hasKtlintConfig(record.cwd),
		});
		const scopeKey =
			policy?.scope && policy.scope !== "file"
				? `${policy.defaultTool ?? "unknown"}:${path.resolve(record.cwd)}`
				: `${policy?.defaultTool ?? "unknown"}:${filePath}`;
		if (executedAutofixScopes.has(scopeKey)) continue;
		executedAutofixScopes.add(scopeKey);
		try {
			const result = await runAutofix(
				filePath,
				record.cwd,
				getFlag,
				dbg,
				{ biomeClient, ruffClient, fixedThisTurn: runtime.fixedThisTurn },
				getFlagSource,
			);
			const tools = result.autofixTools.map((label) => label.split(":")[0]);
			for (const changed of result.changedFiles) {
				const changedPath = path.resolve(changed);
				deferredAutofixChanged.add(changedPath);
				for (const tool of tools)
					deferredAutofixFixes.push({
						path: changedPath,
						tool,
						kind: "autofix",
					});
				if (!nodeFs.existsSync(changedPath)) continue;
				recordProjectChange({
					runtime,
					cwd: record.turnStateCwd,
					filePath: changedPath,
					source: "autofix",
					dbg,
				});
				if (!getFlag("no-read-guard"))
					runtime.readGuard.recordWritten(changedPath);
				const content = nodeFs.readFileSync(changedPath, "utf-8");
				cacheManager.addModifiedRange(
					changedPath,
					{ start: 1, end: content.split("\n").length },
					/^import\s/m.test(content),
					record.turnStateCwd,
					currentSessionId ?? runtime.telemetrySessionId,
					"pi",
				);
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			summary.failed.push({ filePath, errors: [message] });
			requeue(
				[
					{
						...record,
						kinds: new Set(["autofix"]),
						toolNames: new Set(record.toolNames),
					},
				],
				"autofix-failed",
			);
		}
	}
	if (deferredAutofixFixes.length > 0) {
		publishFilesTouched({
			reason: "autofix",
			paths: [...new Set(deferredAutofixFixes.map((fix) => fix.path))],
			cwd: ctxCwd ?? runtime.projectRoot,
			dbg,
			fixes: deferredAutofixFixes,
		});
	}

	dbg(`agent_end deferred_format: ${records.length} file(s)`);
	logLatency({
		type: "phase",
		toolName: "agent_end",
		filePath: ctxCwd ?? runtime.projectRoot,
		phase: "agent_end_deferred_format_start",
		durationMs: 0,
		metadata: {
			fileCount: records.length,
			currentSessionId,
			// #791: per-record provenance so a future incident can be diagnosed
			// straight from latency.log — which session/turn queued each file,
			// and whether it was claimed via the staleness fallback.
			records: records.map((r) => ({
				filePath: r.filePath,
				queuedTurnIndex: r.queuedTurnIndex,
				ownerSessionId: r.ownerSessionId,
				staleClaim: staleClaimed.includes(r),
			})),
			deferredToOwnerCount: deferredToOwner.length,
		},
	});
	// #673: same moment as the latency phase above — a same-process listener
	// (e.g. a review/snapshot controller) can use this to know the deferred-
	// format phase is starting and these specific paths may still be mutated.
	if (records.length > 0) {
		publishFormatStart({
			cwd: ctxCwd ?? runtime.projectRoot,
			paths: records.map((r) => r.filePath),
			dbg,
			kinds: [...new Set(records.flatMap((record) => [...record.kinds]))],
		});
	}

	const formatRecords = records
		.filter((record) => record.kinds.has("format"))
		.filter((record) => {
			const disabled = !!getFlag("no-autoformat", record.filePath);
			if (disabled) {
				const source = getFlagSource?.("no-autoformat", record.filePath);
				dbg(
					`agent_end deferred_format: skipping ${record.filePath} (--no-autoformat${source ? `, source=${source}` : ""})`,
				);
				summary.skipped.push({
					filePath: record.filePath,
					reason: "no-autoformat",
				});
			}
			return !disabled;
		});

	if (formatRecords.length > 0) {
		// Formatter subprocesses are independent across files, so retain bounded
		// overlap here. Result application stays admission-ordered below because
		// its synchronous file reads/bookkeeping are observable shared state.
		type FormatWork = {
			record: (typeof formatRecords)[number];
			filePath: string;
			fileStart: number;
			result?: Awaited<ReturnType<typeof runFormatPhase>>;
			error?: string;
			missing?: boolean;
		};
		const work = new Array<FormatWork | undefined>(formatRecords.length);
		const started = new Set<number>();
		let nextIndex = 0;
		const worker = async (): Promise<void> => {
			while (nextIndex < formatRecords.length) {
				const index = nextIndex++;
				if (ambientSignal?.aborted) return;
				const record = formatRecords[index];
				const fileStart = Date.now();
				const filePath = path.resolve(record.filePath);
				started.add(index);
				if (!nodeFs.existsSync(filePath)) {
					work[index] = { record, filePath, fileStart, missing: true };
					continue;
				}
				try {
					work[index] = {
						record,
						filePath,
						fileStart,
						result: await runFormatPhase(filePath, getFormatService, dbg),
					};
				} catch (err) {
					work[index] = {
						record,
						filePath,
						fileStart,
						error: err instanceof Error ? err.message : String(err),
					};
				}
			}
		};
		await Promise.all(
			Array.from(
				{ length: Math.min(DEFERRED_FORMAT_CONCURRENCY, formatRecords.length) },
				() => worker(),
			),
		);
		if (ambientSignal?.aborted) {
			requeue(
				formatRecords
					.filter((_, index) => !started.has(index))
					.map((record) => ({
						...record,
						kinds: new Set(["format" as const]),
						toolNames: new Set(record.toolNames),
					})),
				"abort",
			);
		}

		for (const entry of work) {
			if (!entry) continue;
			await new Promise<void>((resolve) => setImmediate(resolve));
			const { record, filePath, fileStart } = entry;
			if (entry.missing) {
				dbg(`agent_end deferred_format skipped missing file: ${filePath}`);
				if (
					!summary.skipped.some(
						(item) => item.filePath === filePath && item.reason === "missing",
					)
				) {
					summary.skipped.push({ filePath, reason: "missing" });
				}
				continue;
			}
			if (entry.error) {
				dbg(`agent_end deferred_format failed for ${filePath}: ${entry.error}`);
				summary.failed.push({ filePath, errors: [entry.error] });
				requeue(
					[
						{
							...record,
							kinds: new Set(["format"]),
							toolNames: new Set(record.toolNames),
						},
					],
					"format-failed",
				);
				continue;
			}
			const result = entry.result;
			if (!result) continue;

			summary.formatted++;

			if (result.formatFailures.length > 0) {
				summary.failed.push({ filePath, errors: result.formatFailures });
				requeue(
					[
						{
							...record,
							kinds: new Set(["format"]),
							toolNames: new Set(record.toolNames),
						},
					],
					"format-failed",
				);
			}

			if (result.formatChanged) {
				summary.changed.push(filePath);
				for (const tool of result.formattersUsed) {
					deferredFormatFixes.push({ path: filePath, tool, kind: "format" });
				}
				// turnStateCwd is required on DeferredFormatRecord (PR #114) — the
				// previous fallback chain through ctxCwd / projectRoot / record.cwd
				// could silently regress the monorepo cwd-mismatch fix from PR #105.
				const bookkeepingCwd = record.turnStateCwd;
				recordProjectChange({
					runtime,
					cwd: bookkeepingCwd,
					filePath,
					source: "format",
					dbg,
				});
				if (!getFlag("no-read-guard")) {
					runtime.readGuard.recordWritten(filePath);
				}
				try {
					const content = nodeFs.readFileSync(filePath, "utf-8");
					const lineCount = content.split("\n").length;
					const hasImports = /^import\s/m.test(content);
					cacheManager.addModifiedRange(
						filePath,
						{ start: 1, end: lineCount },
						hasImports,
						bookkeepingCwd,
						currentSessionId ?? runtime.telemetrySessionId,
						"pi",
					);
				} catch (err) {
					dbg(
						`agent_end deferred_format modified-range tracking failed for ${filePath}: ${err}`,
					);
				}

				// #484: opt-in per-turn summary — deferred format is the OTHER
				// half of the format signal (immediate-mode is recorded at the
				// runtime-tool-result.ts seam); same result.formattersUsed the
				// latency phase below already logs, no new plumbing.
				if (getFlag("lens-turn-summary")) {
					for (const tool of result.formattersUsed) {
						runtime.turnSummary.recordFormat(filePath, { tool });
					}
				}
			}

			if (result.fileContent) {
				await resyncLspFile(
					filePath,
					result.fileContent,
					true,
					false,
					getFlag,
					dbg,
				);
			}

			dbg(
				`agent_end deferred_format file ${filePath}: changed=${result.formatChanged} duration=${Date.now() - fileStart}ms`,
			);
			logLatency({
				type: "phase",
				toolName: "agent_end",
				filePath,
				phase: "deferred_format_file",
				durationMs: Date.now() - fileStart,
				metadata: {
					changed: result.formatChanged,
					formattersUsed: result.formattersUsed,
					failureCount: result.formatFailures.length,
				},
			});
		}

		if (summary.changed.length > 0) {
			publishFilesTouched({
				reason: "format",
				paths: summary.changed,
				cwd: ctxCwd ?? runtime.projectRoot,
				dbg,
				fixes: deferredFormatFixes,
			});
		}
	}

	// LSP sees only authoritative content after both mutation phases. In
	// particular, never publish the autofix intermediate state before format.
	for (const changedPath of deferredAutofixChanged) {
		if (!nodeFs.existsSync(changedPath)) continue;
		const content = nodeFs.readFileSync(changedPath, "utf-8");
		await resyncLspFile(changedPath, content, true, false, getFlag, dbg);
	}

	if (inspectActionableReport) {
		const actionCwd = ctxCwd ?? runtime.projectRoot;
		const actionableWarningsMaxAgeMs = 10 * 60_000;
		const actionReport = cacheManager.readCache<ActionableWarningsReport>(
			"actionable-warnings",
			actionCwd,
			actionableWarningsMaxAgeMs,
		);
		if (!actionReport?.data) {
			// Distinguish "no cache file was ever written" from "a cache file
			// exists but its TTL elapsed" (#1607) — both used to collapse into
			// one "cache missing or expired" line, which doesn't tell a reader
			// whether the writer ran and produced a stale file, or never ran.
			const inspection =
				typeof cacheManager.inspectCache === "function"
					? cacheManager.inspectCache(
							"actionable-warnings",
							actionCwd,
							actionableWarningsMaxAgeMs,
						)
					: undefined;
			if (inspection === "missing") {
				dbg(
					"agent_end actionable_warnings_autofix: cache absent, skipping fixes",
				);
			} else if (inspection === "stale") {
				dbg(
					"agent_end actionable_warnings_autofix: cache expired, skipping fixes",
				);
			} else {
				dbg(
					`agent_end actionable_warnings_autofix: cache missing or expired${inspection ? ` (${inspection})` : ""}, skipping fixes`,
				);
			}
		} else {
			const enabledFiles = actionReport.data.files.filter((file) => {
				// #1247: the per-edit dispatch surface gates ignored files before
				// running; the turn-end autofix must apply the same filter or a
				// `.pi-lens.json` `ignore` entry cannot protect a prose file
				// (CHANGELOG.md / AGENTS.md) from being rewritten here.
				if (
					isPathIgnoredByProject(file.filePath, ctxCwd ?? runtime.projectRoot)
				) {
					dbg(
						`agent_end actionable_warnings_autofix: skipped ${file.filePath} (ignored by project)`,
					);
					return false;
				}
				const enabled = !!getFlag(
					"lens-actionable-warning-autofix",
					file.filePath,
				);
				if (!enabled) {
					const source = getFlagSource?.(
						"lens-actionable-warning-autofix",
						file.filePath,
					);
					dbg(
						`agent_end actionable_warnings_autofix: skipped ${file.filePath} (disabled${source ? `, source=${source}` : ""})`,
					);
				}
				return enabled;
			});
			const eligibleCount = enabledFiles.reduce(
				(total, file) =>
					total +
					file.warnings.reduce(
						(count, warning) =>
							count +
							(warning.suppressed
								? 0
								: warning.actions.filter((action) => action.autoFixEligible)
										.length),
						0,
					),
				0,
			);
			const eligibleReport: ActionableWarningsReport = {
				...actionReport.data,
				files: enabledFiles,
				summary: {
					...actionReport.data.summary,
					files: enabledFiles.length,
					autoFixEligible: eligibleCount,
				},
			};
			const freshness = checkActionableWarningsReportFresh({
				report: eligibleReport,
				currentProjectSeq: runtime.projectSeq,
				getFileSeq: (filePath) => runtime.getFileSeq(filePath),
			});
			if (!freshness.fresh) {
				dbg(
					`agent_end actionable_warnings_autofix: stale report (${freshness.reason}; reportProjectSeqEnd=${freshness.reportProjectSeqEnd ?? "missing"}; currentProjectSeq=${freshness.currentProjectSeq}${freshness.filePath ? `; file=${freshness.filePath}; reportFileSeq=${freshness.reportFileSeq}; currentFileSeq=${freshness.currentFileSeq}` : ""}), skipping fixes`,
				);
			} else if (eligibleReport.summary.autoFixEligible > 0) {
				// #684: same "genuine work about to happen" gate as
				// publishFormatStart — only fires when the report is fresh AND
				// has at least one autofix-eligible warning, right before
				// applyConservativeActionableWarningFixes actually starts.
				publishAutofixStart({
					cwd: ctxCwd ?? runtime.projectRoot,
					paths: eligibleReport.files
						.filter((file) =>
							file.warnings.some(
								(warning) =>
									!warning.suppressed &&
									warning.actions.some((action) => action.autoFixEligible),
							),
						)
						.map((file) => file.filePath),
					eligibleCount: eligibleReport.summary.autoFixEligible,
					dbg,
				});
				const fixStart = Date.now();
				const fixCwd = ctxCwd ?? runtime.projectRoot;
				const mutationContext: LspMutationContext = {
					cwd: fixCwd,
					correlationId: newLspMutationCorrelationId(),
					tool: "lsp-quickfix",
					source: "autofix",
					runtime,
					cacheManager,
					readGuard: getFlag("no-read-guard") ? undefined : runtime.readGuard,
					recordAutofix: getFlag("lens-turn-summary")
						? (filePath) =>
								runtime.turnSummary.recordAutofix(filePath, {
									tool: "lsp-quickfix",
								})
						: undefined,
					dbg,
				};
				const fixSummary = await applyConservativeActionableWarningFixes({
					cwd: fixCwd,
					report: eligibleReport,
					maxFixes: getGlobalActionableWarningMaxFixes(),
					dbg,
					mutationContext,
				});
				if (fixSummary.changedFiles.length > 0) {
					publishFilesTouched({
						reason: "autofix",
						paths: fixSummary.changedFiles,
						cwd: ctxCwd ?? runtime.projectRoot,
						dbg,
						fixes: fixSummary.changedFiles.map((changedFile) => ({
							path: changedFile,
							tool: "lsp-quickfix",
							kind: "autofix" as const,
						})),
					});
				}
				logLatency({
					type: "phase",
					toolName: "agent_end",
					filePath: ctxCwd ?? runtime.projectRoot,
					phase: "actionable_warnings_autofix",
					durationMs: Date.now() - fixStart,
					metadata: {
						considered: fixSummary.considered,
						applied: fixSummary.applied,
						changedFiles: fixSummary.changedFiles.length,
						skipped: fixSummary.skipped.length,
					},
				});
				if (fixSummary.applied > 0) {
					notify(
						`pi-lens applied ${fixSummary.applied} conservative LSP warning quickfix(es)`,
						"info",
					);
				}
			} else {
				dbg(
					"agent_end actionable_warnings_autofix: fresh report, 0 autofix-eligible warnings, skipping",
				);
			}
		}
	}

	logLatency({
		type: "phase",
		toolName: "agent_end",
		filePath: ctxCwd ?? runtime.projectRoot,
		phase: "agent_end_deferred_mutation_drain",
		durationMs: Date.now() - startedAt,
		metadata: {
			autofixRecords: autofixRecords.length,
			formatRecords: formatRecords.length,
			coalescedPaths: records.length,
			requeuedKinds: [...requeuedKinds].sort((a, b) =>
				a < b ? -1 : a > b ? 1 : 0,
			),
		},
	});
	logLatency({
		type: "tool_result",
		toolName: "agent_end",
		filePath: ctxCwd ?? runtime.projectRoot,
		durationMs: Date.now() - startedAt,
		result: "deferred_format_complete",
		metadata: {
			queued: summary.queued,
			formatted: summary.formatted,
			changed: summary.changed.length,
			failed: summary.failed.length,
			skipped: summary.skipped.length,
		},
	});
	logLatency({
		type: "phase",
		toolName: "agent_end",
		filePath: ctxCwd ?? runtime.projectRoot,
		phase: "agent_end_deferred_format_done",
		durationMs: Date.now() - startedAt,
		metadata: {
			formatted: summary.formatted,
			changed: summary.changed.length,
			failed: summary.failed.length,
			skipped: summary.skipped.length,
		},
	});
	dbg(
		`agent_end deferred_format complete: formatted=${summary.formatted} changed=${summary.changed.length} failed=${summary.failed.length} skipped=${summary.skipped.length}`,
	);

	if (summary.failed.length > 0) {
		notify(
			`pi-lens deferred format: ${summary.changed.length} changed, ${summary.failed.length} failed`,
			"warning",
		);
	} else if (summary.changed.length > 0 && !getFlag("lens-turn-summary")) {
		// The info-level success toast is redundant once the turn-summary entry
		// (#484) is opted in — it would repeat the same "N reformatted" fact the
		// transcript entry already carries. Failures above stay untouched either way.
		const names = summary.changed.map((f) => path.basename(f)).join(", ");
		notify(
			`pi-lens deferred format applied to ${summary.changed.length} file(s): ${names}`,
			"info",
		);
	}

	return summary;
}
