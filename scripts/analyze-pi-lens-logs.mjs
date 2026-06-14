#!/usr/bin/env node
/**
 * Analyze pi-lens' own logs for operational/code-quality smells across all projects.
 *
 * Sources:
 *   ~/.pi-lens/latency*.log          JSONL dispatch/runner/phase timings
 *   ~/.pi-lens/sessionstart*.log     text lifecycle/tool availability logs
 *   ~/.pi-lens/cascade*.log          JSONL impact-cascade logs
 *   ~/.pi-lens/read-guard*.log       JSONL read-guard friction logs
 *   ~/.pi-lens/tree-sitter*.log      JSONL structural runner logs
 *   ~/.pi-lens/actionable-warnings*.log  JSONL advisory pipeline (inject/suppress)
 *   ~/.pi-lens/ast-grep-tools*.log   JSONL MCP ast-grep search/replace telemetry
 *   ~/.pi-lens/logs/*.jsonl          JSONL diagnostic findings
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const DEFAULT_ROOT = path.join(os.homedir(), ".pi-lens");
const DEFAULT_SINCE = "2d";
const DEFAULT_LIMIT = 12;

const args = parseArgs(process.argv.slice(2));
const root = path.resolve(expandHome(args.root ?? DEFAULT_ROOT));
const since = parseSince(args.since ?? DEFAULT_SINCE);
const limit =
	Number.parseInt(args.limit ?? `${DEFAULT_LIMIT}`, 10) || DEFAULT_LIMIT;
const outputJson = Boolean(args.json);
const includeArchived = Boolean(args.archived);

const thresholds = {
	startupSlowMs: Number.parseInt(args.startupSlowMs ?? "500", 10),
	backgroundSlowMs: Number.parseInt(args.backgroundSlowMs ?? "3000", 10),
	totalSlowMs: Number.parseInt(args.totalSlowMs ?? "5000", 10),
	runnerSlowMs: Number.parseInt(args.runnerSlowMs ?? "2500", 10),
	cascadeGraphSlowMs: Number.parseInt(args.cascadeGraphSlowMs ?? "1000", 10),
};

main().catch((err) => {
	console.error(`log-smell analysis failed: ${err?.stack || err}`);
	process.exitCode = 1;
});

async function main() {
	if (args.help) {
		printHelp();
		return;
	}

	const files = discoverLogFiles(root, includeArchived);
	const state = createState(files);

	await Promise.all([
		analyzeLatency(files.latency, state),
		analyzeDiagnosticLogs(files.diagnostics, state),
		analyzeCascade(files.cascade, state),
		analyzeReadGuard(files.readGuard, state),
		analyzeTreeSitter(files.treeSitter, state),
		analyzeSessionStart(files.sessionStart, state),
		analyzeActionableWarnings(files.actionableWarnings, state),
		analyzeAstGrepTools(files.astGrepTools, state),
	]);

	const report = buildReport(state);
	if (outputJson) {
		console.log(JSON.stringify(report, null, 2));
	} else {
		printReport(report);
	}
}

function parseArgs(argv) {
	const out = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--help" || arg === "-h") out.help = true;
		else if (arg === "--json") out.json = true;
		else if (arg === "--archived") out.archived = true;
		else if (arg.startsWith("--")) {
			const key = arg.slice(2);
			const next = argv[i + 1];
			if (!next || next.startsWith("--")) out[key] = "true";
			else out[key] = argv[++i];
		}
	}
	return out;
}

function printHelp() {
	console.log(
		`Usage: node scripts/analyze-pi-lens-logs.mjs [options]\n\nOptions:\n  --since <2d|24h|YYYY-MM-DD|all>   Time window (default: ${DEFAULT_SINCE})\n  --root <dir>                       pi-lens log root (default: ~/.pi-lens)\n  --limit <n>                        Top-N rows per section (default: ${DEFAULT_LIMIT})\n  --archived                         Include archived rotated logs too\n  --json                             Emit machine-readable JSON\n\nThresholds:\n  --startupSlowMs <n>                session_start total threshold (default: ${thresholds.startupSlowMs})\n  --backgroundSlowMs <n>             session_start background task threshold (default: ${thresholds.backgroundSlowMs})\n  --totalSlowMs <n>                  tool total phase threshold (default: ${thresholds.totalSlowMs})\n  --runnerSlowMs <n>                 runner duration threshold (default: ${thresholds.runnerSlowMs})\n  --cascadeGraphSlowMs <n>           cascade graph build threshold (default: ${thresholds.cascadeGraphSlowMs})\n`,
	);
}

function parseSince(value) {
	if (!value || value === "all") return null;
	const now = Date.now();
	const rel = /^(\d+)([hdw])$/.exec(value);
	if (rel) {
		const amount = Number.parseInt(rel[1], 10);
		const unitMs =
			rel[2] === "h" ? 3600_000 : rel[2] === "d" ? 86_400_000 : 7 * 86_400_000;
		return new Date(now - amount * unitMs);
	}
	const date = new Date(value);
	if (!Number.isNaN(date.getTime())) return date;
	throw new Error(`Invalid --since value: ${value}`);
}

function expandHome(input) {
	return input.startsWith("~")
		? path.join(os.homedir(), input.slice(1))
		: input;
}

function discoverLogFiles(logRoot, archived) {
	const allRootFiles = safeReaddir(logRoot).map((name) =>
		path.join(logRoot, name),
	);
	const logsDir = path.join(logRoot, "logs");
	const dailyLogs = safeReaddir(logsDir)
		.filter((name) => name.endsWith(".jsonl"))
		.map((name) => path.join(logsDir, name));

	const byPrefix = (prefix) =>
		allRootFiles.filter((file) => {
			const base = path.basename(file);
			if (!base.startsWith(prefix)) return false;
			if (!archived && /\.\d{4}-\d{2}-\d{2}T/.test(base)) return false;
			return base.endsWith(".log") || base.includes(".log.");
		});

	return {
		latency: byPrefix("latency"),
		sessionStart: byPrefix("sessionstart"),
		cascade: byPrefix("cascade"),
		readGuard: byPrefix("read-guard"),
		treeSitter: byPrefix("tree-sitter"),
		actionableWarnings: byPrefix("actionable-warnings"),
		astGrepTools: byPrefix("ast-grep-tools"),
		diagnostics: dailyLogs,
	};
}

function safeReaddir(dir) {
	try {
		return fs.readdirSync(dir);
	} catch {
		return [];
	}
}

function createState(files) {
	return {
		window: { since: since?.toISOString() ?? "all", root },
		files,
		parseErrors: counter(),
		seen: counter(),
		projects: counter(),
		smellTotals: counter(),
		latency: {
			runnerStatus: counter(),
			runnerFailureKinds: counter(),
			runnerBlockingFindings: counter(),
			runnerFailures: [],
			slowRunners: [],
			slowTotals: [],
			toolResults: counter(),
			phaseCounts: counter(),
		},
		diagnostics: {
			bySeverity: counter(),
			byTool: counter(),
			byRule: counter(),
			byFile: counter(),
			shownInline: counter(),
			errors: [],
			topMessages: counter(),
		},
		cascade: {
			phases: counter(),
			slowGraphs: [],
			fallbacks: [],
			missingSnapshots: counter(),
			noNeighbors: counter(),
			largeFanout: [],
		},
		readGuard: {
			events: counter(),
			byFile: counter(),
			byReason: counter(),
			preflightReasons: counter(),
			snapshotStatus: counter(),
			snapshotEnforcement: counter(),
			blocked: [],
			oldTextIssues: [],
			staleRanges: [],
			zeroReads: [],
			unavailableSnapshots: [],
		},
		treeSitter: {
			phases: counter(),
			failures: [],
			blocking: [],
			highDiagnostics: [],
			queryCache: counter(),
			riskFlags: counter(),
		},
		session: {
			starts: 0,
			cwds: counter(),
			slowStarts: [],
			slowTasks: [],
			toolNoise: counter(),
			lspNoise: counter(),
			errors: [],
			rotations: counter(),
		},
		actionable: {
			events: counter(),
			reports: 0,
			injected: 0,
			injectedAdvisories: 0,
			suppressed: 0,
			autoFixEligible: 0,
			lspSource: counter(),
			fileSkipReasons: counter(),
			errors: [],
		},
		astGrep: {
			outcomes: counter(),
			errorKinds: counter(),
			truncated: 0,
			calls: 0,
			errors: [],
			slow: [],
		},
	};
}

async function analyzeLatency(files, state) {
	for (const file of files) {
		await forEachJsonLine(file, "latency", state, (entry) => {
			const ts = dateOf(entry.ts);
			if (!inWindow(ts)) return;
			state.seen.inc("latency");
			trackProject(state, entry.filePath);

			if (entry.type === "runner") {
				const status = entry.status ?? "unknown";
				const runner = entry.runnerId ?? "unknown";
				state.latency.runnerStatus.inc(`${runner}:${status}`);
				if (status === "failed" || status === "crashed") {
					// Separate a genuine runner breakage from "the check ran and found
					// blocking issues" (e.g. the LSP runner reports status:failed when a
					// file has type errors). Prefer the logged failureKind; fall back to
					// the heuristic that a failure carrying diagnostics is found-errors.
					const kind =
						entry.metadata?.failureKind ??
						(status === "crashed"
							? "crashed"
							: (entry.diagnosticCount ?? 0) > 0
								? "blocking_diagnostics"
								: "unknown");
					state.latency.runnerFailureKinds.inc(`${runner}:${kind}`);
					if (kind === "blocking_diagnostics") {
						state.latency.runnerBlockingFindings.inc(runner);
					} else {
						state.smellTotals.inc("runner-failures");
						pushTop(
							state.latency.runnerFailures,
							summarizeLatency(entry),
							limit * 3,
							byDuration,
						);
					}
				}
				if (
					(entry.durationMs ?? 0) >= thresholds.runnerSlowMs &&
					status !== "skipped"
				) {
					state.smellTotals.inc("slow-runners");
					pushTop(
						state.latency.slowRunners,
						summarizeLatency(entry),
						limit * 3,
						byDuration,
					);
				}
			} else if (entry.type === "phase") {
				const phase = entry.phase ?? "unknown";
				state.latency.phaseCounts.inc(phase);
				if (
					phase === "total" &&
					(entry.durationMs ?? 0) >= thresholds.totalSlowMs
				) {
					state.smellTotals.inc("slow-hook-path");
					pushTop(
						state.latency.slowTotals,
						summarizeLatency(entry),
						limit * 3,
						byDuration,
					);
				}
			} else if (entry.type === "tool_result") {
				state.latency.toolResults.inc(entry.result ?? "unknown");
			}
		});
	}
}

async function analyzeDiagnosticLogs(files, state) {
	for (const file of files) {
		await forEachJsonLine(file, "diagnostics", state, (entry) => {
			const ts = dateOf(entry.timestamp ?? entry.ts);
			if (!inWindow(ts)) return;
			state.seen.inc("diagnostics");
			trackProject(state, entry.filePath);
			const severity = entry.severity ?? "unknown";
			const tool = entry.tool ?? "unknown";
			const rule = entry.ruleId ?? entry.rule ?? "unknown";
			const filePath = shortPath(entry.filePath);
			state.diagnostics.bySeverity.inc(severity);
			state.diagnostics.byTool.inc(tool);
			state.diagnostics.byRule.inc(`${tool}/${rule}`);
			state.diagnostics.byFile.inc(filePath);
			state.diagnostics.shownInline.inc(
				`${Boolean(entry.shownInline)}:${Boolean(entry.shownToAgent)}:${Boolean(entry.unresolved)}`,
			);
			state.diagnostics.topMessages.inc(
				`${tool}/${rule}: ${normalizeMessage(entry.message)}`,
			);
			if (
				severity === "error" ||
				entry.shownToAgent === true ||
				entry.shownInline === true
			) {
				state.smellTotals.inc("diagnostic-blockers");
				pushTop(
					state.diagnostics.errors,
					summarizeDiagnostic(entry),
					limit * 4,
					bySeverityThenLine,
				);
			}
		});
	}
}

async function analyzeCascade(files, state) {
	for (const file of files) {
		await forEachJsonLine(file, "cascade", state, (entry) => {
			const ts = dateOf(entry.ts);
			if (!inWindow(ts)) return;
			state.seen.inc("cascade");
			trackProject(state, entry.filePath);
			const phase = entry.phase ?? "unknown";
			state.cascade.phases.inc(phase);
			if ((entry.graphBuiltMs ?? 0) >= thresholds.cascadeGraphSlowMs) {
				state.smellTotals.inc("cascade-slow-graphs");
				pushTop(
					state.cascade.slowGraphs,
					summarizeCascade(entry),
					limit * 3,
					(a, b) => b.graphBuiltMs - a.graphBuiltMs,
				);
			}
			if (entry.fallbackUsed || phase === "neighbor_fallback" || entry.error) {
				state.smellTotals.inc("cascade-fallbacks");
				pushTop(
					state.cascade.fallbacks,
					summarizeCascade(entry),
					limit * 3,
					byDuration,
				);
			}
			if (entry.snapshotMissing)
				state.cascade.missingSnapshots.inc(
					shortPath(entry.neighborFile ?? entry.filePath),
				);
			if (entry.metadata?.noNeighbors)
				state.cascade.noNeighbors.inc(projectOf(entry.filePath));
			if (
				(entry.totalNeighborCount ?? 0) >= 20 ||
				(entry.neighborCount ?? 0) >= 10
			) {
				pushTop(
					state.cascade.largeFanout,
					summarizeCascade(entry),
					limit * 3,
					(a, b) => (b.totalNeighborCount ?? 0) - (a.totalNeighborCount ?? 0),
				);
			}
		});
	}
}

async function analyzeReadGuard(files, state) {
	for (const file of files) {
		await forEachJsonLine(file, "read-guard", state, (entry) => {
			const ts = dateOf(entry.ts);
			if (!inWindow(ts)) return;
			state.seen.inc("read-guard");
			trackProject(state, entry.filePath);
			const event = entry.event ?? "unknown";
			state.readGuard.events.inc(event);
			state.readGuard.byFile.inc(shortPath(entry.filePath));
			const reasonKind = entry.metadata?.reasonKind;
			if (reasonKind) state.readGuard.byReason.inc(reasonKind);
			if (event === "edit_preflight_blocked") {
				state.readGuard.preflightReasons.inc(reasonKind ?? "unknown");
			}
			if (event === "range_snapshot_validation") {
				const status = entry.metadata?.status ?? "unknown";
				state.readGuard.snapshotStatus.inc(status);
				state.readGuard.snapshotEnforcement.inc(
					entry.metadata?.enforced ? "enforced" : "not_enforced",
				);
				if (status === "mismatch") {
					state.smellTotals.inc("read-guard-stale-ranges");
					pushTop(
						state.readGuard.staleRanges,
						summarizeReadGuard(entry),
						limit * 3,
						byLine,
					);
				} else if (status === "unavailable") {
					pushTop(
						state.readGuard.unavailableSnapshots,
						summarizeReadGuard(entry),
						limit * 3,
						byLine,
					);
				}
			}
			if (event === "edit_blocked" || event === "edit_warned") {
				state.smellTotals.inc("read-guard-friction");
				const summary = summarizeReadGuard(entry);
				pushTop(state.readGuard.blocked, summary, limit * 3, byLine);
				if (reasonKind === "zero_read") {
					pushTop(state.readGuard.zeroReads, summary, limit * 3, byLine);
				}
			}
			if (
				event === "oldtext_not_found" ||
				event === "oldtext_duplicate" ||
				event === "touched_lines_missing" ||
				event === "edit_preflight_blocked"
			) {
				state.smellTotals.inc("read-guard-friction");
				pushTop(
					state.readGuard.oldTextIssues,
					summarizeReadGuard(entry),
					limit * 3,
					byLine,
				);
			}
		});
	}
}

async function analyzeTreeSitter(files, state) {
	for (const file of files) {
		await forEachJsonLine(file, "tree-sitter", state, (entry) => {
			const ts = dateOf(entry.ts);
			if (!inWindow(ts)) return;
			state.seen.inc("tree-sitter");
			trackProject(state, entry.filePath);
			const phase = entry.phase ?? "unknown";
			state.treeSitter.phases.inc(phase);
			if (phase === "queries_loaded") {
				state.treeSitter.queryCache.inc(entry.cacheHit ? "hit" : "miss");
			}
			if (
				entry.status &&
				entry.status !== "succeeded" &&
				entry.status !== "skipped"
			) {
				state.smellTotals.inc("tree-sitter-failures");
				pushTop(
					state.treeSitter.failures,
					summarizeTreeSitter(entry),
					limit * 3,
					byDiagnostics,
				);
			}
			if ((entry.blocking ?? 0) > 0) {
				state.smellTotals.inc("tree-sitter-blocking");
				pushTop(
					state.treeSitter.blocking,
					summarizeTreeSitter(entry),
					limit * 3,
					byDiagnostics,
				);
			}
			if ((entry.diagnostics ?? 0) >= 20) {
				pushTop(
					state.treeSitter.highDiagnostics,
					summarizeTreeSitter(entry),
					limit * 3,
					byDiagnostics,
				);
			}
			for (const flag of entry.metadata?.riskFlags ?? [])
				state.treeSitter.riskFlags.inc(flag);
		});
	}
}

async function analyzeSessionStart(files, state) {
	const lineRe = /^\[([^\]]+)\]\s*(.*)$/;
	for (const file of files) {
		await forEachLine(file, async (line) => {
			const match = lineRe.exec(line);
			if (!match) return;
			const ts = dateOf(match[1]);
			if (!inWindow(ts)) return;
			const message = match[2];
			state.seen.inc("sessionstart");

			const cwd = /session_start cwd:\s*(.*)$/.exec(message)?.[1];
			if (cwd) {
				state.session.starts++;
				state.session.cwds.inc(projectOf(cwd));
				trackProject(state, cwd);
			}

			const total = /session_start total:\s*(\d+)ms/.exec(message);
			if (total && Number(total[1]) >= thresholds.startupSlowMs) {
				state.smellTotals.inc("slow-session-start");
				pushTop(
					state.session.slowStarts,
					{ ts: iso(ts), durationMs: Number(total[1]), message },
					limit * 3,
					byDuration,
				);
			}

			const task = /session_start task ([^:]+): success \((\d+)ms\)/.exec(
				message,
			);
			if (task && Number(task[2]) >= thresholds.backgroundSlowMs) {
				state.smellTotals.inc("slow-background-tasks");
				pushTop(
					state.session.slowTasks,
					{ ts: iso(ts), task: task[1], durationMs: Number(task[2]), message },
					limit * 3,
					byDuration,
				);
			}

			if (message.includes("log_cleanup: rotated"))
				state.session.rotations.inc(message.replace(/^log_cleanup:\s*/, ""));

			const lower = message.toLowerCase();
			if (
				/(auto-install|preinstall|installation).*(failed|unavailable|exception)/i.test(
					message,
				)
			) {
				state.smellTotals.inc("tool-install-noise");
				state.session.toolNoise.inc(normalizeSessionNoise(message));
			}
			if (
				/lsp .*?(unavailable|failed|timeout|skipped_broken|exited immediately|binary not found)/i.test(
					message,
				)
			) {
				state.smellTotals.inc("lsp-availability-noise");
				state.session.lspNoise.inc(normalizeSessionNoise(message));
			}
			if (
				lower.includes("error") ||
				lower.includes("exception") ||
				lower.includes("timeout")
			) {
				pushTop(
					state.session.errors,
					{ ts: iso(ts), message },
					limit * 4,
					(a, b) => String(b.ts).localeCompare(String(a.ts)),
				);
			}
		});
	}
}

async function analyzeActionableWarnings(files, state) {
	for (const file of files) {
		await forEachJsonLine(file, "actionable-warnings", state, (entry) => {
			const ts = dateOf(entry.ts);
			if (!inWindow(ts)) return;
			state.seen.inc("actionable-warnings");
			const event = entry.event ?? "unknown";
			state.actionable.events.inc(event);
			const meta = entry.metadata ?? {};

			if (event === "report_complete") {
				state.actionable.reports++;
				const summary = meta.summary ?? {};
				state.actionable.suppressed += Number(summary.suppressed ?? 0);
				state.actionable.autoFixEligible += Number(summary.autoFixEligible ?? 0);
			}
			if (event === "advisory_injected") {
				state.actionable.injected++;
				state.actionable.injectedAdvisories += Number(meta.unsuppressed ?? 0);
			}
			if (event === "lsp_file_checked" && meta.lspSource) {
				state.actionable.lspSource.inc(meta.lspSource);
			}
			if (event === "lsp_file_skipped") {
				state.actionable.fileSkipReasons.inc(meta.reason ?? "unknown");
			}
			if (/error|exception|failed/i.test(event) || meta.error) {
				state.smellTotals.inc("actionable-warning-errors");
				pushTop(
					state.actionable.errors,
					{
						ts: iso(ts),
						event,
						message: String(meta.error ?? meta.message ?? "").slice(0, 200),
					},
					limit * 3,
					(a, b) => String(b.ts).localeCompare(String(a.ts)),
				);
			}
		});
	}
}

async function analyzeAstGrepTools(files, state) {
	for (const file of files) {
		await forEachJsonLine(file, "ast-grep-tools", state, (entry) => {
			const ts = dateOf(entry.ts);
			if (!inWindow(ts)) return;
			state.seen.inc("ast-grep-tools");
			state.astGrep.calls++;
			const tool = entry.tool ?? "unknown";
			const outcome = entry.outcome ?? "unknown";
			state.astGrep.outcomes.inc(`${tool}:${outcome}`);
			if (entry.truncated) state.astGrep.truncated++;
			if (outcome === "error") {
				state.smellTotals.inc("ast-grep-tool-errors");
				state.astGrep.errorKinds.inc(entry.errorKind ?? "unknown");
				pushTop(
					state.astGrep.errors,
					{
						ts: entry.ts,
						tool,
						errorKind: entry.errorKind,
						durationMs: entry.durationMs,
						message: String(entry.errorRaw ?? "").replace(/\s+/g, " ").slice(0, 180),
						pattern: String(entry.pattern ?? "").replace(/\s+/g, " ").slice(0, 80),
					},
					limit * 3,
					(a, b) => String(b.ts).localeCompare(String(a.ts)),
				);
			}
			if ((entry.durationMs ?? 0) >= 1000) {
				pushTop(
					state.astGrep.slow,
					{
						ts: entry.ts,
						tool,
						durationMs: entry.durationMs,
						matchCount: entry.matchCount,
						pattern: String(entry.pattern ?? "").replace(/\s+/g, " ").slice(0, 80),
					},
					limit * 3,
					byDuration,
				);
			}
		});
	}
}

async function forEachJsonLine(file, bucket, state, visitor) {
	await forEachLine(file, async (line) => {
		if (!line.trim()) return;
		try {
			visitor(JSON.parse(line));
		} catch {
			state.parseErrors.inc(`${bucket}:${path.basename(file)}`);
		}
	});
}

async function forEachLine(file, visitor) {
	if (!fs.existsSync(file)) return;
	const rl = readline.createInterface({
		input: fs.createReadStream(file, { encoding: "utf8" }),
		crlfDelay: Infinity,
	});
	for await (const line of rl) await visitor(line);
}

function dateOf(value) {
	if (!value) return null;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? null : date;
}

function inWindow(date) {
	if (!since) return true;
	return date && date >= since;
}

function iso(date) {
	return date?.toISOString?.() ?? "unknown";
}

function counter() {
	const map = new Map();
	return {
		inc(key, by = 1) {
			map.set(
				String(key ?? "unknown"),
				(map.get(String(key ?? "unknown")) ?? 0) + by,
			);
		},
		entries() {
			return [...map.entries()];
		},
		top(n = limit) {
			return [...map.entries()]
				.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
				.slice(0, n)
				.map(([key, count]) => ({ key, count }));
		},
		toJSON() {
			return Object.fromEntries(
				[...map.entries()].sort(
					(a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
				),
			);
		},
		get(key) {
			return map.get(String(key ?? "unknown")) ?? 0;
		},
		get size() {
			return map.size;
		},
	};
}

function pushTop(array, item, max, compare) {
	array.push(item);
	array.sort(compare);
	if (array.length > max) array.length = max;
}

function byDuration(a, b) {
	return (b.durationMs ?? 0) - (a.durationMs ?? 0);
}
function byDiagnostics(a, b) {
	return (b.diagnostics ?? 0) - (a.diagnostics ?? 0);
}
function byLine(a, b) {
	return (
		String(b.ts ?? "").localeCompare(String(a.ts ?? "")) ||
		(a.line ?? 0) - (b.line ?? 0)
	);
}
function bySeverityThenLine(a, b) {
	const rank = { error: 3, warning: 2, info: 1, hint: 0 };
	return (
		(rank[b.severity] ?? 0) - (rank[a.severity] ?? 0) ||
		String(b.ts ?? "").localeCompare(String(a.ts ?? ""))
	);
}

function summarizeLatency(entry) {
	return {
		ts: entry.ts,
		durationMs: entry.durationMs,
		type: entry.type,
		phase: entry.phase,
		toolName: entry.toolName,
		runnerId: entry.runnerId,
		status: entry.status,
		result: entry.result,
		diagnosticCount: entry.diagnosticCount,
		filePath: shortPath(entry.filePath),
		project: projectOf(entry.filePath),
		metadata: pick(entry.metadata, [
			"failureKind",
			"failureMessage",
			"skipReason",
			"completed",
			"finalContent",
			"runners",
			"totalDiagnostics",
			"blockers",
		]),
	};
}

function summarizeDiagnostic(entry) {
	return {
		ts: entry.timestamp ?? entry.ts,
		severity: entry.severity,
		tool: entry.tool,
		ruleId: entry.ruleId ?? entry.rule,
		filePath: shortPath(entry.filePath),
		project: projectOf(entry.filePath),
		line: entry.line,
		column: entry.column,
		shownInline: Boolean(entry.shownInline),
		shownToAgent: Boolean(entry.shownToAgent),
		unresolved: Boolean(entry.unresolved),
		message: entry.message,
	};
}

function summarizeCascade(entry) {
	return {
		ts: entry.ts,
		phase: entry.phase,
		filePath: shortPath(entry.filePath),
		neighborFile: shortPath(entry.neighborFile),
		project: projectOf(entry.filePath),
		graphBuiltMs: entry.graphBuiltMs,
		durationMs: entry.durationMs,
		neighborCount: entry.neighborCount,
		totalNeighborCount: entry.totalNeighborCount,
		diagnosticCount: entry.diagnosticCount,
		fallbackUsed: Boolean(entry.fallbackUsed),
		snapshotMissing: Boolean(entry.snapshotMissing),
		error: entry.error,
	};
}

function summarizeReadGuard(entry) {
	return {
		ts: entry.ts,
		event: entry.event,
		filePath: shortPath(entry.filePath),
		project: projectOf(entry.filePath),
		requestedOffset: entry.requestedOffset,
		requestedLimit: entry.requestedLimit,
		effectiveOffset: entry.effectiveOffset,
		effectiveLimit: entry.effectiveLimit,
		symbol: entry.symbol,
		symbolKind: entry.symbolKind,
		line: entry.symbolStartLine,
		metadata: entry.metadata,
	};
}

function summarizeTreeSitter(entry) {
	return {
		ts: entry.ts,
		phase: entry.phase,
		status: entry.status,
		filePath: shortPath(entry.filePath),
		project: projectOf(entry.filePath),
		languageId: entry.languageId,
		diagnostics: entry.diagnostics,
		blocking: entry.blocking,
		queryCount: entry.queryCount,
		effectiveQueryCount: entry.effectiveQueryCount,
		metadata: pick(entry.metadata, [
			"riskFlags",
			"changedSymbols",
			"neighborFiles",
			"error",
		]),
	};
}

function pick(obj, keys) {
	if (!obj || typeof obj !== "object") return undefined;
	const out = {};
	for (const key of keys) if (key in obj) out[key] = obj[key];
	return Object.keys(out).length ? out : undefined;
}

function normalizeMessage(message) {
	return String(message ?? "")
		.replace(/\d+/g, "<n>")
		.replace(/"[^"]+"/g, '"…"')
		.replace(/'[^']+'/g, "'…'")
		.slice(0, 180);
}

function normalizeSessionNoise(message) {
	return message
		.replace(/\([0-9]+ms\)/g, "(<ms>)")
		.replace(/retryInMs":\d+/g, "retryInMs:<n>")
		.replace(/C:[^\s]+/g, "<path>")
		.replace(/\b\d+ms\b/g, "<ms>")
		.slice(0, 220);
}

function trackProject(state, filePath) {
	if (!filePath) return;
	state.projects.inc(projectOf(filePath));
}

function projectOf(filePath) {
	const p = normalizePath(filePath);
	let match = /\/Desktop\/([^/]+)/i.exec(p);
	if (match) return match[1];
	match = /\/AppData\/Local\/Temp\/([^/]+)/i.exec(p);
	if (match) return `temp:${match[1]}`;
	match = /\/\.pi\/agent\/extensions\/([^/]+)/i.exec(p);
	if (match) return `extension:${match[1]}`;
	match = /\/\.pi-lens\//i.exec(p);
	if (match) return ".pi-lens";
	match = /^([A-Za-z]:)?\/([^/]+)/.exec(p);
	return match?.[2] ?? "unknown";
}

function shortPath(filePath) {
	if (!filePath) return undefined;
	const p = normalizePath(filePath);
	const desktop = /\/Desktop\/([^/]+\/.*)$/i.exec(p);
	if (desktop) return desktop[1];
	const temp = /\/AppData\/Local\/Temp\/([^/]+\/.*)$/i.exec(p);
	if (temp) return `Temp/${temp[1]}`;
	const home = normalizePath(os.homedir());
	return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

function normalizePath(filePath) {
	return String(filePath).replace(/\\/g, "/");
}

function buildReport(state) {
	const smells = [];
	const smellCount = (id) => state.smellTotals.get(id);
	addSmell(
		smells,
		"diagnostic-blockers",
		smellCount("diagnostic-blockers"),
		"Diagnostics shown inline/to agent or severity=error",
		state.diagnostics.errors.slice(0, limit),
	);
	addSmell(
		smells,
		"runner-failures",
		smellCount("runner-failures"),
		"Dispatch runners failed/crashed",
		state.latency.runnerFailures.slice(0, limit),
	);
	addSmell(
		smells,
		"slow-hook-path",
		smellCount("slow-hook-path"),
		`Tool total phases >= ${thresholds.totalSlowMs}ms`,
		state.latency.slowTotals.slice(0, limit),
	);
	addSmell(
		smells,
		"slow-runners",
		smellCount("slow-runners"),
		`Runner durations >= ${thresholds.runnerSlowMs}ms`,
		state.latency.slowRunners.slice(0, limit),
	);
	addSmell(
		smells,
		"tool-install-noise",
		smellCount("tool-install-noise"),
		"Repeated unavailable/failed preinstall or auto-install messages",
		state.session.toolNoise.top(limit),
	);
	addSmell(
		smells,
		"lsp-availability-noise",
		smellCount("lsp-availability-noise"),
		"Repeated LSP unavailable/failed/timeout messages",
		state.session.lspNoise.top(limit),
	);
	addSmell(
		smells,
		"slow-session-start",
		smellCount("slow-session-start"),
		`session_start total >= ${thresholds.startupSlowMs}ms`,
		state.session.slowStarts.slice(0, limit),
	);
	addSmell(
		smells,
		"slow-background-tasks",
		smellCount("slow-background-tasks"),
		`session_start background tasks >= ${thresholds.backgroundSlowMs}ms`,
		state.session.slowTasks.slice(0, limit),
	);
	addSmell(
		smells,
		"cascade-fallbacks",
		smellCount("cascade-fallbacks"),
		"Cascade used fallback/degraded path or logged errors",
		state.cascade.fallbacks.slice(0, limit),
	);
	addSmell(
		smells,
		"cascade-slow-graphs",
		smellCount("cascade-slow-graphs"),
		`Cascade graph build >= ${thresholds.cascadeGraphSlowMs}ms`,
		state.cascade.slowGraphs.slice(0, limit),
	);
	addSmell(
		smells,
		"read-guard-friction",
		smellCount("read-guard-friction"),
		"Read-guard blocked/warned edits or exact replacement misses",
		[...state.readGuard.blocked, ...state.readGuard.oldTextIssues].slice(
			0,
			limit,
		),
	);
	addSmell(
		smells,
		"read-guard-stale-ranges",
		smellCount("read-guard-stale-ranges"),
		"Covered edit ranges whose read snapshot no longer matched current content",
		state.readGuard.staleRanges.slice(0, limit),
	);
	addSmell(
		smells,
		"tree-sitter-blocking",
		smellCount("tree-sitter-blocking"),
		"Tree-sitter runner produced blocking diagnostics",
		state.treeSitter.blocking.slice(0, limit),
	);
	addSmell(
		smells,
		"tree-sitter-failures",
		smellCount("tree-sitter-failures"),
		"Tree-sitter runner failures",
		state.treeSitter.failures.slice(0, limit),
	);
	addSmell(
		smells,
		"ast-grep-tool-errors",
		smellCount("ast-grep-tool-errors"),
		"MCP ast-grep search/replace calls that errored",
		state.astGrep.errors.slice(0, limit),
	);
	addSmell(
		smells,
		"actionable-warning-errors",
		smellCount("actionable-warning-errors"),
		"Actionable-warnings advisory pipeline logged an error",
		state.actionable.errors.slice(0, limit),
	);

	return {
		window: state.window,
		filesScanned: Object.fromEntries(
			Object.entries(state.files).map(([key, list]) => [key, list.length]),
		),
		rowsSeen: state.seen.toJSON(),
		parseErrors: state.parseErrors.toJSON(),
		projects: state.projects.top(limit),
		smells,
		diagnostics: {
			bySeverity: state.diagnostics.bySeverity.toJSON(),
			byTool: state.diagnostics.byTool.toJSON(),
			byRule: state.diagnostics.byRule.top(limit),
			byFile: state.diagnostics.byFile.top(limit),
			topMessages: state.diagnostics.topMessages.top(limit),
			shownInlineShownAgentUnresolved: state.diagnostics.shownInline.toJSON(),
		},
		latency: {
			runnerStatus: state.latency.runnerStatus.top(limit * 2),
			runnerFailureKinds: state.latency.runnerFailureKinds.top(limit * 2),
			runnerBlockingFindings: state.latency.runnerBlockingFindings.toJSON(),
			toolResults: state.latency.toolResults.toJSON(),
			phaseCounts: state.latency.phaseCounts.top(limit),
		},
		cascade: {
			phases: state.cascade.phases.toJSON(),
			missingSnapshots: state.cascade.missingSnapshots.top(limit),
			noNeighborsByProject: state.cascade.noNeighbors.top(limit),
			largeFanout: state.cascade.largeFanout.slice(0, limit),
		},
		readGuard: {
			events: state.readGuard.events.toJSON(),
			byReason: state.readGuard.byReason.toJSON(),
			preflightReasons: state.readGuard.preflightReasons.toJSON(),
			snapshotStatus: state.readGuard.snapshotStatus.toJSON(),
			snapshotEnforcement: state.readGuard.snapshotEnforcement.toJSON(),
			byFile: state.readGuard.byFile.top(limit),
			staleRanges: state.readGuard.staleRanges.slice(0, limit),
			zeroReads: state.readGuard.zeroReads.slice(0, limit),
			unavailableSnapshots: state.readGuard.unavailableSnapshots.slice(
				0,
				limit,
			),
		},
		treeSitter: {
			phases: state.treeSitter.phases.toJSON(),
			queryCache: state.treeSitter.queryCache.toJSON(),
			riskFlags: state.treeSitter.riskFlags.toJSON(),
			highDiagnostics: state.treeSitter.highDiagnostics.slice(0, limit),
		},
		session: {
			starts: state.session.starts,
			cwds: state.session.cwds.top(limit),
			rotations: state.session.rotations.toJSON(),
			errors: state.session.errors.slice(0, limit),
		},
		actionable: {
			events: state.actionable.events.toJSON(),
			reports: state.actionable.reports,
			advisoriesInjected: state.actionable.injected,
			advisoryWarningsInjected: state.actionable.injectedAdvisories,
			warningsSuppressed: state.actionable.suppressed,
			autoFixEligible: state.actionable.autoFixEligible,
			lspSource: state.actionable.lspSource.toJSON(),
			fileSkipReasons: state.actionable.fileSkipReasons.toJSON(),
			errors: state.actionable.errors.slice(0, limit),
		},
		astGrep: {
			calls: state.astGrep.calls,
			outcomes: state.astGrep.outcomes.toJSON(),
			errorKinds: state.astGrep.errorKinds.toJSON(),
			truncated: state.astGrep.truncated,
			errors: state.astGrep.errors.slice(0, limit),
			slow: state.astGrep.slow.slice(0, limit),
		},
	};
}

function addSmell(smells, id, count, description, examples) {
	if (!count) return;
	const severity = count >= 20 ? "high" : count >= 5 ? "medium" : "low";
	smells.push({ id, severity, count, description, examples });
}

function printReport(report) {
	console.log(`pi-lens log smell report`);
	console.log(`window: ${report.window.since} → now`);
	console.log(`root: ${report.window.root}`);
	console.log(
		`rows: ${
			Object.entries(report.rowsSeen)
				.map(([k, v]) => `${k}=${v}`)
				.join(", ") || "none"
		}`,
	);
	console.log(
		`files scanned: ${Object.entries(report.filesScanned)
			.map(([k, v]) => `${k}=${v}`)
			.join(", ")}`,
	);
	if (Object.keys(report.parseErrors).length)
		console.log(`parse errors: ${JSON.stringify(report.parseErrors)}`);

	section(
		"Projects touched",
		report.projects,
		(x) => `${x.count.toString().padStart(5)}  ${x.key}`,
	);

	console.log("\nSmells");
	if (!report.smells.length) {
		console.log("  none above thresholds");
	} else {
		for (const smell of report.smells) {
			console.log(`\n  [${smell.severity}] ${smell.id}: ${smell.count}`);
			console.log(`    ${smell.description}`);
			for (const ex of smell.examples.slice(0, Math.min(5, limit)))
				console.log(`    - ${formatExample(ex)}`);
		}
	}

	section(
		"Diagnostic rules",
		report.diagnostics.byRule,
		(x) => `${x.count.toString().padStart(5)}  ${x.key}`,
	);
	section(
		"Diagnostic files",
		report.diagnostics.byFile,
		(x) => `${x.count.toString().padStart(5)}  ${x.key}`,
	);
	section(
		"Runner statuses",
		report.latency.runnerStatus,
		(x) => `${x.count.toString().padStart(5)}  ${x.key}`,
	);
	section(
		"Read-guard events",
		Object.entries(report.readGuard.events).map(([key, count]) => ({
			key,
			count,
		})),
		(x) => `${String(x.count).padStart(5)}  ${x.key}`,
	);
	section(
		"Read-guard block reasons",
		Object.entries(report.readGuard.byReason).map(([key, count]) => ({
			key,
			count,
		})),
		(x) => `${String(x.count).padStart(5)}  ${x.key}`,
	);
	section(
		"Read-guard snapshot status",
		Object.entries(report.readGuard.snapshotStatus).map(([key, count]) => ({
			key,
			count,
		})),
		(x) => `${String(x.count).padStart(5)}  ${x.key}`,
	);
	section(
		"Cascade phases",
		Object.entries(report.cascade.phases).map(([key, count]) => ({
			key,
			count,
		})),
		(x) => `${String(x.count).padStart(5)}  ${x.key}`,
	);
	section(
		"Runner failure kinds (infra vs found-errors)",
		report.latency.runnerFailureKinds,
		(x) => `${x.count.toString().padStart(5)}  ${x.key}`,
	);

	const a = report.actionable;
	if (a.reports || a.advisoriesInjected) {
		console.log("\nActionable warnings");
		console.log(
			`  reports=${a.reports} advisoriesInjected=${a.advisoriesInjected} warningsInjected=${a.advisoryWarningsInjected} suppressed=${a.warningsSuppressed} autoFixEligible=${a.autoFixEligible}`,
		);
		const lspSrc = Object.entries(a.lspSource);
		if (lspSrc.length)
			console.log(
				`  lspSource: ${lspSrc.map(([k, v]) => `${k}=${v}`).join(", ")}`,
			);
		const skips = Object.entries(a.fileSkipReasons);
		if (skips.length)
			console.log(
				`  lsp skip reasons: ${skips.map(([k, v]) => `${k}=${v}`).join(", ")}`,
			);
	}

	const ag = report.astGrep;
	if (ag.calls) {
		console.log("\nast-grep tools");
		console.log(`  calls=${ag.calls} truncated=${ag.truncated}`);
		const outcomes = Object.entries(ag.outcomes);
		if (outcomes.length)
			console.log(
				`  outcomes: ${outcomes.map(([k, v]) => `${k}=${v}`).join(", ")}`,
			);
		if (Object.keys(ag.errorKinds).length)
			console.log(`  error kinds: ${JSON.stringify(ag.errorKinds)}`);
	}
}

function section(title, rows, formatter) {
	console.log(`\n${title}`);
	if (!rows?.length) {
		console.log("  none");
		return;
	}
	for (const row of rows.slice(0, limit)) console.log(`  ${formatter(row)}`);
}

function formatExample(ex) {
	if (!ex) return "";
	const bits = [];
	if (ex.durationMs != null) bits.push(`${ex.durationMs}ms`);
	if (ex.graphBuiltMs != null) bits.push(`graph=${ex.graphBuiltMs}ms`);
	if (ex.runnerId) bits.push(ex.runnerId);
	if (ex.phase) bits.push(ex.phase);
	if (ex.status) bits.push(ex.status);
	if (ex.tool) bits.push(`${ex.tool}/${ex.ruleId}`);
	if (ex.event) bits.push(ex.event);
	if (ex.project) bits.push(`[${ex.project}]`);
	if (ex.filePath) bits.push(ex.filePath);
	if (ex.line) bits.push(`:${ex.line}`);
	if (ex.message) bits.push(`— ${String(ex.message).slice(0, 160)}`);
	if (ex.error) bits.push(`— ${String(ex.error).slice(0, 160)}`);
	if (!bits.length && ex.key) bits.push(`${ex.count} × ${ex.key}`);
	return bits.join(" ");
}

if (process.argv[1] === fileURLToPath(import.meta.url) && args.help) {
	printHelp();
}
