import * as nodeFs from "node:fs";
import * as path from "node:path";
import {
	applyConservativeActionableWarningFixes,
	checkActionableWarningsReportFresh,
	type ActionableWarningsReport,
} from "./actionable-warnings.js";
import type { CacheManager } from "./cache-manager.js";
import type { FormatService } from "./format-service.js";
import { logLatency } from "./latency-logger.js";
import { resyncLspFile, runFormatPhase } from "./pipeline.js";
import { publishFilesTouched } from "./bus-publish.js";
import {
	appendProjectChange,
	type ProjectChangeSource,
} from "./project-changes.js";
import type { RuntimeCoordinator } from "./runtime-coordinator.js";

interface AgentEndDeps {
	ctxCwd?: string;
	getFlag: (name: string) => boolean | string | undefined;
	notify: (msg: string, level: "info" | "warning" | "error") => void;
	dbg: (msg: string) => void;
	runtime: RuntimeCoordinator;
	cacheManager: CacheManager;
	getFormatService: () => FormatService;
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
	const bump = (args.runtime as Partial<RuntimeCoordinator>).bumpFileSeq;
	if (!bump) return;
	const { projectSeq, fileSeq } = bump.call(args.runtime, args.filePath);
	try {
		appendProjectChange(args.cwd, {
			seq: projectSeq,
			timestamp: new Date().toISOString(),
			sessionId: args.runtime.telemetrySessionId,
			turnIndex: args.runtime.turnIndex,
			source: args.source,
			filePath: path.resolve(args.filePath),
			fileSeq,
		});
	} catch (err) {
		args.dbg(`project change log append failed for ${args.filePath}: ${err}`);
	}
}

export async function handleAgentEnd({
	ctxCwd,
	getFlag,
	notify,
	dbg,
	runtime,
	cacheManager,
	getFormatService,
}: AgentEndDeps): Promise<AgentEndFormatSummary | undefined> {
	const records = runtime.consumeDeferredFormatFiles();
	const actionableAutofixEnabled = !!getFlag("lens-actionable-warning-autofix");
	if (records.length === 0 && !actionableAutofixEnabled) return undefined;

	const startedAt = Date.now();
	const summary: AgentEndFormatSummary = {
		queued: records.length,
		formatted: 0,
		changed: [],
		failed: [],
		skipped: [],
	};

	dbg(`agent_end deferred_format: ${records.length} file(s)`);
	logLatency({
		type: "phase",
		toolName: "agent_end",
		filePath: ctxCwd ?? runtime.projectRoot,
		phase: "agent_end_deferred_format_start",
		durationMs: 0,
		metadata: { fileCount: records.length },
	});

	const autoformatDisabled = !!getFlag("no-autoformat");
	if (autoformatDisabled) {
		for (const record of records) {
			summary.skipped.push({
				filePath: record.filePath,
				reason: "no-autoformat",
			});
		}
	}

	if (!autoformatDisabled) {
		type FormatOutcome =
			| { kind: "skipped"; filePath: string; reason: string }
			| { kind: "failed"; filePath: string; message: string; fileStart: number }
			| {
					kind: "done";
					record: (typeof records)[number];
					filePath: string;
					result: Awaited<ReturnType<typeof runFormatPhase>>;
					fileStart: number;
			  };

		// Run all formatter subprocesses concurrently — no shared state touched here.
		// bumpFileSeq / cacheManager mutations happen in the sequential pass below.
		const outcomes = await Promise.all(
			records.map(async (record): Promise<FormatOutcome> => {
				const fileStart = Date.now();
				const filePath = path.resolve(record.filePath);
				if (!nodeFs.existsSync(filePath)) {
					dbg(`agent_end deferred_format skipped missing file: ${filePath}`);
					return { kind: "skipped", filePath, reason: "missing" };
				}
				try {
					const result = await runFormatPhase(filePath, getFormatService, dbg);
					return { kind: "done", record, filePath, result, fileStart };
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					dbg(`agent_end deferred_format failed for ${filePath}: ${message}`);
					return { kind: "failed", filePath, message, fileStart };
				}
			}),
		);

		// Process results sequentially — bumpFileSeq and cacheManager mutations
		// must stay ordered to avoid sequence number races.
		for (const outcome of outcomes) {
			if (outcome.kind === "skipped") {
				summary.skipped.push({
					filePath: outcome.filePath,
					reason: outcome.reason,
				});
				continue;
			}
			if (outcome.kind === "failed") {
				summary.failed.push({
					filePath: outcome.filePath,
					errors: [outcome.message],
				});
				continue;
			}

			const { record, filePath, result, fileStart } = outcome;
			summary.formatted++;

			if (result.formatFailures.length > 0) {
				summary.failed.push({ filePath, errors: result.formatFailures });
			}

			if (result.formatChanged) {
				summary.changed.push(filePath);
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
					);
				} catch (err) {
					dbg(
						`agent_end deferred_format modified-range tracking failed for ${filePath}: ${err}`,
					);
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
			});
		}
	}

	if (actionableAutofixEnabled) {
		const actionReport = cacheManager.readCache<ActionableWarningsReport>(
			"actionable-warnings",
			ctxCwd ?? runtime.projectRoot,
			10 * 60_000,
		);
		if (!actionReport?.data) {
			dbg(
				"agent_end actionable_warnings_autofix: cache missing or expired, skipping fixes",
			);
		} else {
			const freshness = checkActionableWarningsReportFresh({
				report: actionReport.data,
				currentProjectSeq: runtime.projectSeq,
				getFileSeq: (filePath) => runtime.getFileSeq(filePath),
			});
			if (!freshness.fresh) {
				dbg(
					`agent_end actionable_warnings_autofix: stale report (${freshness.reason}; reportProjectSeqEnd=${freshness.reportProjectSeqEnd ?? "missing"}; currentProjectSeq=${freshness.currentProjectSeq}${freshness.filePath ? `; file=${freshness.filePath}; reportFileSeq=${freshness.reportFileSeq}; currentFileSeq=${freshness.currentFileSeq}` : ""}), skipping fixes`,
				);
			} else {
				const fixStart = Date.now();
				const fixSummary = await applyConservativeActionableWarningFixes({
					cwd: ctxCwd ?? runtime.projectRoot,
					report: actionReport.data,
					dbg,
				});
				for (const changedFile of fixSummary.changedFiles) {
					if (!nodeFs.existsSync(changedFile)) continue;
					recordProjectChange({
						runtime,
						cwd: ctxCwd ?? runtime.projectRoot,
						filePath: changedFile,
						source: "autofix",
						dbg,
					});
					if (!getFlag("no-read-guard"))
						runtime.readGuard.recordWritten(changedFile);
					try {
						const content = nodeFs.readFileSync(changedFile, "utf-8");
						cacheManager.addModifiedRange(
							changedFile,
							{ start: 1, end: content.split("\n").length },
							/^import\s/m.test(content),
							ctxCwd ?? runtime.projectRoot,
						);
					} catch (err) {
						dbg(
							`agent_end actionable warning changed-file tracking failed for ${changedFile}: ${err}`,
						);
					}
				}
				if (fixSummary.changedFiles.length > 0) {
					publishFilesTouched({
						reason: "autofix",
						paths: fixSummary.changedFiles,
						cwd: ctxCwd ?? runtime.projectRoot,
						dbg,
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
			}
		}
	}

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
	dbg(
		`agent_end deferred_format complete: formatted=${summary.formatted} changed=${summary.changed.length} failed=${summary.failed.length} skipped=${summary.skipped.length}`,
	);

	if (summary.failed.length > 0) {
		notify(
			`pi-lens deferred format: ${summary.changed.length} changed, ${summary.failed.length} failed`,
			"warning",
		);
	} else if (summary.changed.length > 0) {
		const names = summary.changed.map((f) => path.basename(f)).join(", ");
		notify(
			`pi-lens deferred format applied to ${summary.changed.length} file(s): ${names}`,
			"info",
		);
	}

	return summary;
}
