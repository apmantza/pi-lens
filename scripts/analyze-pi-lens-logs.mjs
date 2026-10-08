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
 *   ~/.pi-lens/extension*.log        JSONL extension diagnostics and console-guard telemetry
 *   ~/.pi-lens/actionable-warnings*.log  JSONL advisory pipeline (inject/suppress)
 *   ~/.pi-lens/ast-grep-tools*.log   JSONL MCP ast-grep search/replace telemetry
 *   ~/.pi-lens/logs/*.jsonl          JSONL diagnostic findings
 *   ~/.pi-lens/projects/<slug>/worklog.jsonl  JSONL fix worklog (rule/tool/model/provider, #1448)
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { minimatch } from "minimatch";

const DEFAULT_ROOT = path.join(os.homedir(), ".pi-lens");
const DEFAULT_SINCE = "2d";
const DEFAULT_LIMIT = 12;
const DEFAULT_EXCLUDE_GLOBS = [
	"**/AppData/Local/Temp/claude/**",
	"**/heap-corpus*/**",
	"**/.plegma/work/**",
];

const args = parseArgs(process.argv.slice(2));
const root = path.resolve(expandHome(args.root ?? DEFAULT_ROOT));
const since = parseSince(args.since ?? DEFAULT_SINCE);
const limit =
	Number.parseInt(args.limit ?? `${DEFAULT_LIMIT}`, 10) || DEFAULT_LIMIT;
const outputJson = Boolean(args.json);
const includeArchived = Boolean(args.archived);
const excludeGlobs = [
	...DEFAULT_EXCLUDE_GLOBS,
	...(Array.isArray(args.exclude)
		? args.exclude
		: args.exclude
			? [args.exclude]
			: []),
];

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
		analyzeWorklog(files.worklog, state),
		analyzeExtension(files.extension, state),
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
			else if (key === "exclude") {
				const value = argv[++i];
				out.exclude = out.exclude
					? Array.isArray(out.exclude)
						? [...out.exclude, value]
						: [out.exclude, value]
					: value;
			} else out[key] = argv[++i];
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

	// worklog.jsonl lives per-project under projects/<slug>/ (getProjectDataDir),
	// not at the log root — walk one level to find every project's file (#1448).
	const projectsDir = path.join(logRoot, "projects");
	const worklogs = safeReaddir(projectsDir)
		.map((slug) => path.join(projectsDir, slug, "worklog.jsonl"))
		.filter((file) => fs.existsSync(file));

	const byPrefix = (prefix) =>
		allRootFiles.filter((file) => {
			const base = path.basename(file);
			if (!base.startsWith(prefix)) return false;
			if (!archived && /\.\d{4}-\d{2}-\d{2}T/.test(base)) return false;
			return base.endsWith(".log") || base.includes(".log.");
		});

	return {
		latency: chronologicalFiles(byPrefix("latency")),
		sessionStart: chronologicalFiles(byPrefix("sessionstart")),
		cascade: chronologicalFiles(byPrefix("cascade")),
		readGuard: chronologicalFiles(byPrefix("read-guard")),
		treeSitter: chronologicalFiles(byPrefix("tree-sitter")),
		actionableWarnings: chronologicalFiles(byPrefix("actionable-warnings")),
		astGrepTools: chronologicalFiles(byPrefix("ast-grep-tools")),
		extension: chronologicalFiles(byPrefix("extension")),
		diagnostics: dailyLogs,
		worklog: worklogs,
	};
}

/**
 * Rotated siblings (`x.log.1`) carry older rows than the active `x.log`. The
 * run-splitting detectors (D3/D4/D5) and the read-guard evidence walk (D10)
 * only read correctly in chronological order, so order every multi-file stream
 * oldest-first with the active file last.
 */
function chronologicalFiles(files) {
	return [...files].sort((a, b) => {
		const activeA = path.basename(a).endsWith(".log");
		const activeB = path.basename(b).endsWith(".log");
		if (activeA !== activeB) return activeA ? 1 : -1;
		return a.localeCompare(b);
	});
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
		excludedRows: 0,
		seen: counter(),
		projects: counter(),
		smellTotals: counter(),
		latency: {
			testRunnerVerdicts: new Map(),
			runnerStatus: counter(),
			runnerFailureKinds: counter(),
			runnerBlockingFindings: counter(),
			runnerFailures: [],
			slowRunners: [],
			slowTotals: [],
			toolResults: counter(),
			phaseCounts: counter(),
			phaseTimeouts: counter(),
			// D1: every latency row timestamp (ms) in window, for the coverage-gap
			// scan. Sorted after all files are read.
			rowTs: [],
			cascadeTs: [],
			// D2: real-log pollution — rows whose filePath points at a test
			// home, grouped by pid.
			scratchRows: new Map(),
			// D5: test_runner_delivery outcomes per session, joined with the
			// sessionstart firing/stale text into one delivery-health verdict.
			testRunnerDelivery: new Map(),
			// D6: `phase: knip` executed rows per pid, for the drift and cost rules.
			knip: new Map(),
			// D7: hook-await-exceeded overruns plus the per-pid degradation census.
			hookAwaitExceeded: [],
			degradationKinds: new Map(),
			// D8: turn_end `tool_result` summaries per pid, and the retained-state text.
			turnEndTools: new Map(),
			retainingNewerTurn: [],
			// D9: empty-candidate LSP waits, edit touches that saw no client, and
			// warm-reuse selections, joined into the wait/contradiction verdict.
			lspWaitEmpty: new Map(),
			lspTouchEdit: new Map(),
			lspTouchNoClients: [],
			lspClientSelectedWarm: [],
			// D11: read-set carry outcomes at a restart boundary.
			carryRestart: [],
			// D12: nudges and scope transitions, joined by pid + wall clock.
			agentNudges: [],
			sessionScopeTransitions: [],
			// D13: deferred runner failures joined to their delivery row by (pid, turnId).
			deferredRunnerFailed: [],
			lateRunnerFindings: [],
			// D14: auxiliary stuck pair (pid, filePath, serverId) recurrence.
			auxStuck: new Map(),
			// D15: advisory provenance decisions with unknown provenance.
			advisoryProvenance: [],
			// D8/D15: first latency row timestamp per pid (lifetime base).
			pidFirstTs: new Map(),
			pidLastTs: new Map(),
			workspace: {
				started: 0,
				completed: 0,
				aborted: 0,
				timedOutSweeps: 0,
				timedOutFilesTotal: 0,
				// #1618: per-reason breakdown of the same total. Populated from each
				// sweep's `unconfirmedByReason` metadata when present; a sweep logged
				// by a pre-#1618 build carries no such field, so its files are
				// bucketed under "budget (pre-#1618 build)" — the ABSENT field is
				// itself the vintage signal, not an assumption that every one of
				// those files really was a budget timeout.
				unconfirmedByReason: counter(),
				sweeps: [],
				progress: [],
			},
		},
		// #2526: the config stack's positive-observability rows. `resolved`
		// counts `config_resolved` phase records; `legacyWithoutRecords` counts
		// the rows that carry a deprecated document but produced no
		// migration/notice record — the deprecation machinery gone silent.
		//
		// Round 2, F2: the session->row relation is a JOIN on the session id both
		// sides carry, not a subtraction of two counts.
		//
		// Round 3, S1: the session-side half of the join is no longer a
		// PREDICTION. `pendingSessions` holds every session id that published a
		// `config_resolution_pending` mark — written by `loadLSPConfig` itself,
		// at the instant a resolution is actually attempted, never by a
		// `runtime-session.ts` handler guessing from `no-lsp`/subagent/warm-attach
		// flags ahead of time. A session that never reaches that call (quick or
		// minimal mode's second-and-later session in a process, for the same
		// root) never gets a mark, so it is silently excluded rather than
		// counted against. `resolvedSessions` holds every session id a
		// resolution actually reported, from EITHER sink (the latency row or the
		// sessionstart line — one call writes both, so this is one fact
		// surviving an independent rotation of either log, not a second source
		// of truth).
		config: {
			resolved: 0,
			pendingSessions: new Map(),
			resolvedSessions: new Set(),
			legacyDocuments: 0,
			legacyWithoutRecords: 0,
			examples: [],
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
			// E2: the block/warn split. These rows do not carry a host-side
			// decision, so the analyzer must not invent one.
			blocks: [],
			warns: [],
			blockByKind: counter(),
			bypassedMismatch: 0,
			// D10: per-(session,file) evidence that a read or a committed edit
			// happened earlier in the session, so a later `zero_read` block is a
			// lost read-set rather than a genuine cold edit.
			fileEvidence: new Map(),
			stateLost: [],
			genuineZeroRead: [],
		},
		extension: {
			// D2: extension.log rows whose payload names a test home
			// directory, grouped by pid, plus the warn/error census.
			scratchRows: new Map(),
			warnErrorGroups: counter(),
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
			// E4: per-start build identity (`commit=`), so every rate can be split
			// by build. Keyed by commit, with the start timestamps that carried it.
			commits: counter(),
			slowStarts: [],
			slowTasks: [],
			toolNoise: counter(),
			lspNoise: counter(),
			errors: [],
			// D1: every sessionstart line timestamp (ms) in window.
			rowTs: [],
			// D16: `pi-lens loaded: Nms` lines, with their wall clock so a short
			// lived pid can be marked.
			slowLoads: [],
			// D16: the wall clock of every `session_start fired`, so a load with no
			// session start within 60 s (a short-lived pid) is visible.
			firedTs: [],
			// D3/D4/D5/D8: one run per `session_start fired`. Run splitting is the
			// only way to attribute a turn-end test decision to the session that made it.
			runs: [],
			currentRun: newRun(),
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
		worklog: {
			// key: "<rule>||<model>" (model "" when the entry predates #1448 or the
			// runtime didn't know it) -> { total, autoFixed }
			byRuleModel: new Map(),
			byModel: counter(),
			byModelAutoFixed: counter(),
			byProvider: counter(),
		},
	};
}

/**
 * The failure kind of a `failed` or `crashed` runner row. `metadata.failureKind`
 * is exact: inline rows carry it (#3781) and collect-later rows too (#3796).
 * Rows written by released versions never carry it, so the count heuristic
 * (a failure with diagnostics is found-errors) stays only as that fallback.
 */
function runnerFailureKind(entry) {
	if (entry.metadata?.failureKind) return entry.metadata.failureKind;
	if (entry.status === "crashed") return "crashed";
	return (entry.diagnosticCount ?? 0) > 0 ? "blocking_diagnostics" : "unknown";
}

async function analyzeLatency(files, state) {
	for (const file of files) {
		await forEachJsonLine(file, "latency", state, (entry) => {
			const ts = dateOf(entry.ts);
			if (!inWindow(ts)) return;
			state.seen.inc("latency");
			trackLatencyProject(state, entry);
			trackLatencySignals(state, entry, ts);

			if (entry.type === "runner") {
				const status = entry.status ?? "unknown";
				const runner = entry.runnerId ?? "unknown";
				state.latency.runnerStatus.inc(`${runner}:${status}`);
				if (status === "failed" || status === "crashed") {
					// Separate a genuine runner breakage from "the check ran and found
					// blocking issues" (e.g. the LSP runner reports status:failed when a
					// file has type errors).
					const kind = runnerFailureKind(entry);
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
				if (phase.endsWith("_timeout")) state.latency.phaseTimeouts.inc(phase);
				if (phase === "test_runner_verdict_delivery") {
					const sessionId = entry.metadata?.sessionId ?? "unknown";
					const summary = state.latency.testRunnerVerdicts.get(sessionId) ?? {
						total: 0,
						stale: 0,
						unknown: 0,
					};
					const verdictCount = entry.metadata?.verdictCount;
					const staleCount = entry.metadata?.staleCount;
					const unknownCount = entry.metadata?.unknownCount;
					summary.total += typeof verdictCount === "number" ? verdictCount : 1;
					if (typeof staleCount === "number") summary.stale += staleCount;
					else if (entry.metadata?.stale === true) summary.stale += 1;
					if (typeof unknownCount === "number") summary.unknown += unknownCount;
					state.latency.testRunnerVerdicts.set(sessionId, summary);
				}
				if (phase === "config_resolved") {
					// #2526. Counted here rather than derived from phaseCounts so the
					// legacy/record cross-check reads the same row it counts.
					state.config.resolved += 1;
					const md = entry.metadata ?? {};
					// #2526 R2 F2 / #2552 R4: the join key is (session, root), not
					// session alone — see `configJoinKey`'s doc comment. `entry.filePath`
					// is this row's root (the same `configResolutionKey(cwd)` value the
					// pending mark's `root=` carries); a row from a build that predates
					// the session id carries none, and simply joins to nothing.
					if (
						typeof md.sessionId === "string" &&
						md.sessionId.length > 0 &&
						typeof entry.filePath === "string" &&
						entry.filePath.length > 0
					) {
						state.config.resolvedSessions.add(
							configJoinKey(md.sessionId, entry.filePath),
						);
					}
					const documents = Array.isArray(md.documents) ? md.documents : [];
					const legacy = documents.filter((doc) => doc?.legacy === true);
					state.config.legacyDocuments += legacy.length;
					// A deprecated document that produced NO record means the
					// migration notices went silent — the user is on a removal
					// schedule and is never told. Zero records with zero legacy
					// documents is the correct canonical-only answer, not a smell.
					if (legacy.length > 0 && Number(md.recordCount ?? 0) === 0) {
						state.config.legacyWithoutRecords += 1;
						pushTop(
							state.config.examples,
							summarizeConfigResolved(entry, "legacy document with 0 records"),
							limit * 3,
							byDuration,
						);
					}
				}
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
				} else if (phase === "lsp_workspace_diagnostics_start") {
					state.latency.workspace.started += 1;
				} else if (phase === "lsp_workspace_diagnostics_progress") {
					// Keep the heartbeats so an incomplete sweep can show how far it
					// got (completed X/Y) before it went silent — the hang forensics.
					pushTop(
						state.latency.workspace.progress,
						summarizeWorkspaceSweep(entry),
						limit * 3,
						byDuration,
					);
				} else if (phase === "lsp_workspace_diagnostics") {
					const ws = state.latency.workspace;
					ws.completed += 1;
					if (entry.metadata?.aborted) ws.aborted += 1;
					const timedOut = Number(entry.metadata?.timedOutFiles ?? 0);
					if (timedOut > 0) {
						ws.timedOutSweeps += 1;
						ws.timedOutFilesTotal += timedOut;
						// #1618: attribute by the REAL per-reason tally when the build
						// that wrote this log line has it — a service-destroyed file
						// must never count toward "hit the per-file budget" the way it
						// used to (the forensics tool that found #1618 in the first
						// place read this exact field and mis-blamed budget exhaustion
						// for what were mostly service-destroyed files).
						const byReason = entry.metadata?.unconfirmedByReason;
						if (byReason && typeof byReason === "object") {
							for (const [reason, count] of Object.entries(byReason)) {
								const n = Number(count) || 0;
								if (n > 0) ws.unconfirmedByReason.inc(reason, n);
							}
						} else {
							// Vintage-attribution fallback: no `unconfirmedByReason` means
							// this line predates #1618 — the absent field IS the signal,
							// not proof every file here was really a budget timeout.
							ws.unconfirmedByReason.inc("budget (pre-#1618 build)", timedOut);
						}
						state.smellTotals.inc("lsp-workspace-file-timeouts");
						pushTop(
							ws.sweeps,
							summarizeWorkspaceSweep(entry),
							limit * 3,
							byDuration,
						);
					}
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
			if (ts) state.latency.cascadeTs.push(ts.getTime());
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
			if (!inWindow(ts)) {
				// D10 needs evidence that may precede a live-monitor window.
				// Keep this lookback state private; outside rows never affect counts.
				if (hasReadEvidence(entry)) {
					const key = `${readGuardSessionOf(entry) ?? "?"}\u0000${entry.filePath ?? "?"}`;
					state.readGuard.fileEvidence.set(key, true);
				}
				return;
			}
			state.seen.inc("read-guard");
			trackProject(state, entry.filePath);
			const event = entry.event ?? "unknown";
			const md = entry.metadata ?? {};
			state.readGuard.events.inc(event);
			state.readGuard.byFile.inc(shortPath(entry.filePath));
			const reasonKind = md.reasonKind;
			if (reasonKind) state.readGuard.byReason.inc(reasonKind);

			// D10: evidence that this file was read or edited earlier in the
			// SAME session. Read before this row's own evidence is recorded, so a
			// later `zero_read` block sees only the prior rows. An
			// `edit_batch_summary` carries no sessionId, so its session is the
			// turnId prefix before the last `:`.
			const evidenceKey = `${readGuardSessionOf(entry) ?? "?"}\u0000${entry.filePath ?? "?"}`;
			const hadEvidence =
				state.readGuard.fileEvidence.get(evidenceKey) === true;

			if (event === "edit_preflight_blocked") {
				state.readGuard.preflightReasons.inc(reasonKind ?? "unknown");
				registerBlock(state, entry, "preflight");
			}
			if (event === "edit_blocked") {
				const summary = registerBlock(state, entry, "blocked");
				if (reasonKind === "zero_read") {
					pushTop(state.readGuard.zeroReads, summary, limit * 3, byLine);
					if (hadEvidence) {
						pushTop(
							state.readGuard.stateLost,
							{ ...summary, classification: "state-lost" },
							limit * 3,
							byLine,
						);
					} else {
						pushTop(
							state.readGuard.genuineZeroRead,
							{ ...summary, classification: "genuine" },
							limit * 3,
							byLine,
						);
					}
				}
			}
			if (event === "edit_warned") {
				pushTop(
					state.readGuard.warns,
					summarizeReadGuard(entry),
					limit * 3,
					byLine,
				);
			}
			if (event === "range_snapshot_validation") {
				const status = md.status ?? "unknown";
				const outcome = String(md.outcome ?? "");
				state.readGuard.snapshotStatus.inc(status);
				state.readGuard.snapshotEnforcement.inc(
					md.enforced ? "enforced" : "not_enforced",
				);
				// E3: `bypassed-content-match` is an allowed edit, not a stale
				// read. Only a mismatch the caller did NOT bypass is a smell.
				if (status === "mismatch" && !outcome.startsWith("bypassed")) {
					state.smellTotals.inc("read-guard-stale-ranges");
					pushTop(
						state.readGuard.staleRanges,
						summarizeReadGuard(entry),
						limit * 3,
						byLine,
					);
				} else if (status === "mismatch") {
					state.readGuard.bypassedMismatch += 1;
				} else if (status === "unavailable") {
					pushTop(
						state.readGuard.unavailableSnapshots,
						summarizeReadGuard(entry),
						limit * 3,
						byLine,
					);
				}
			}
			if (
				event === "oldtext_not_found" ||
				event === "oldtext_duplicate" ||
				event === "touched_lines_missing"
			) {
				pushTop(
					state.readGuard.oldTextIssues,
					summarizeReadGuard(entry),
					limit * 3,
					byLine,
				);
			}

			if (hasReadEvidence(entry))
				state.readGuard.fileEvidence.set(evidenceKey, true);
		});
	}
}

/** D10: a row proving the file was read or edited earlier in its session. */
function hasReadEvidence(entry) {
	const md = entry.metadata ?? {};
	return (
		entry.event === "edit_batch_summary" ||
		(entry.event === "range_snapshot_validation" &&
			Number(md.candidateReadCount ?? 0) > 0) ||
		(entry.event === "edit_warned" && Number(md.readCount ?? 0) > 0)
	);
}

/**
 * D10: the session a read-guard row belongs to. `edit_batch_summary` rows carry
 * no `sessionId`, so fall back to the turnId prefix before the last `:` (the
 * report's own join instruction).
 */
function readGuardSessionOf(entry) {
	if (typeof entry.sessionId === "string" && entry.sessionId)
		return entry.sessionId;
	const turnId = entry.turnId;
	if (typeof turnId === "string" && turnId.includes(":"))
		return turnId.slice(0, turnId.lastIndexOf(":"));
	return null;
}

/** E2: one blocked edit. Host/model provenance is not present on this row. */
function registerBlock(state, entry, source) {
	const summary = summarizeReadGuard(entry);
	pushTop(state.readGuard.blocks, summary, limit * 3, byLine);
	state.readGuard.blockByKind.inc(
		`${source}:${entry.metadata?.reasonKind ?? "unknown"}`,
	);
	return summary;
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
			const message = match[2];
			if (!inWindow(ts)) {
				// A --since window can begin after the session_start that owns its
				// rows. Carry only that run anchor into the visible window.
				if (message.startsWith("session_start fired")) {
					state.session.currentRun = newRun();
					state.session.currentRun.startTs = iso(ts);
				}
				return;
			}
			if (isExcludedText(message)) {
				state.excludedRows++;
				return;
			}
			state.seen.inc("sessionstart");
			if (ts) state.session.rowTs.push(ts.getTime());

			// E4: starts are counted from `session_start fired`, which every mode
			// writes, instead of the dead `session_start cwd:` full-mode line. The
			// same line opens a D3/D4/D5/D8 run.
			if (message.startsWith("session_start fired")) {
				state.session.starts++;
				if (ts) state.session.firedTs.push(ts.getTime());
				state.session.runs.push(state.session.currentRun);
				state.session.currentRun = newRun();
				state.session.currentRun.startTs = iso(ts);
			}

			const cwd = /session_start cwd:\s*(.*)$/.exec(message)?.[1];
			if (cwd) {
				state.session.cwds.inc(projectOf(cwd));
				trackProject(state, cwd);
			}

			// E4: build identity for the session that just started.
			const buildIdentity =
				/session_start: build identity [—-] commit=(\w+)/.exec(message);
			if (buildIdentity) {
				state.session.commits.inc(buildIdentity[1]);
				state.session.currentRun.commit = buildIdentity[1];
			}

			// #2526 R3 S1: this session's config-resolution PENDING mark, published
			// by `loadLSPConfig` itself at the instant a resolution is actually
			// attempted — never a start-line prediction from `no-lsp`/subagent/
			// warm-attach flags. A session that never calls `loadLSPConfig` (quick
			// or minimal mode's second-and-later session in a process, for the
			// same root) never writes this line, and is correctly absent from the
			// join rather than counted against.
			//
			// #2552 R4: `root=` is REQUIRED in the match — a warm MCP process keeps
			// one session id for its whole life but marks once per served root
			// (`configJoinKey`'s doc comment), so a line missing it cannot be
			// attributed to a specific root and is left out of the join rather than
			// guessed into a wrong one.
			const pending =
				/session_start config_resolution_pending session=(\S+) root=(.*)$/.exec(
					message,
				);
			if (pending) {
				const [, sessionId, root] = pending;
				state.config.pendingSessions.set(configJoinKey(sessionId, root), {
					ts: iso(ts),
					sessionId,
					root,
				});
			}
			// The loader's own line is the second half of the join, so a rotated
			// latency.log cannot manufacture a deficit on its own.
			const resolvedSession =
				/config resolved .*\bsession=(\S+) root=(.*)$/.exec(message);
			if (resolvedSession) {
				const [, sessionId, root] = resolvedSession;
				state.config.resolvedSessions.add(configJoinKey(sessionId, root));
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

			// Runtime logs "success runMs=<n> queuedMs=<n>"; older logs used
			// "success (<n>ms)". Match both so a format drift can't silently zero
			// this smell again (it did: the `(<n>ms)` regex matched 0 of ~2k rows).
			const task =
				/session_start task ([^:]+): success runMs=(\d+)/.exec(message) ??
				/session_start task ([^:]+): success \((\d+)ms\)/.exec(message);
			if (task && Number(task[2]) >= thresholds.backgroundSlowMs) {
				state.smellTotals.inc("slow-background-tasks");
				pushTop(
					state.session.slowTasks,
					{ ts: iso(ts), task: task[1], durationMs: Number(task[2]), message },
					limit * 3,
					byDuration,
				);
			}

			// D16: extension load time is invisible to `slow-session-start`, which
			// reads `session_start total:` (a quick-mode total of tens of ms).
			const load = /pi-lens loaded: (\d+)ms after process start/.exec(message);
			if (load) {
				state.session.slowLoads.push({
					ts: iso(ts),
					ms: ts ? ts.getTime() : null,
					durationMs: Number(load[1]),
					message,
				});
			}

			const run = state.session.currentRun;
			const modified = /turn_end: (\d+) file\(s\) modified/.exec(message);
			if (modified) run.edits += 1;
			if (message.includes("excluded by the built-in turn-end policy")) {
				run.excluded += 1;
				const excludedPath = /turn_end:\s*(\S+)\s+→ test target excluded/.exec(
					message,
				)?.[1];
				if (excludedPath) run.excludedTestFiles.push(excludedPath);
			}
			if (message.includes("→ no test file found")) run.noTestFile += 1;
			const vitest =
				/^turn_end:\s+(.+?)\s+→\s+test vitest\s+(\S+)\s+\(([^)]+)\)/.exec(
					message,
				);
			if (vitest) {
				run.ran += 1;
				const [, src, tgt, mode] = vitest;
				if (mode.includes("failed-first")) {
					run.failedFirst += 1;
					const a = checkoutOf(src);
					const b = checkoutOf(tgt);
					if (a && b && a !== b) run.crossCheckout += 1;
				}
			}
			if (/turn_end: firing \d+ test target\(s\) async/.test(message))
				run.testFirings += 1;
			if (/\(stale\s*[—-]\s*turn advanced while tests ran\)/.test(message))
				run.testStale += 1;
			if (/turn_end: retaining newer turn state/.test(message))
				run.retainingNewerTurn += 1;

			const lower = message.toLowerCase();
			if (
				/(auto-install|preinstall|installation).*(failed|unavailable|exception)/i.test(
					message,
				)
			) {
				state.smellTotals.inc("tool-install-noise");
				state.session.toolNoise.inc(normalizeSessionNoise(message));
			}
			// E1: anchor to the production failure emitters so a worktree name
			// such as `468-wait-timeout` inside a `cwd=`/`command=` token cannot
			// match (the 20 false positives in the live session). Every emitter
			// puts the failure word before any `key=` token: `lsp spawn <id>:
			// unavailable|failed` (clients/lsp/index.ts) and `lsp launch
			// candidate|managed|bundle|tree-bin failed` (clients/lsp/server.ts).
			// `lsp read warm unavailable` is informational, and `lsp process
			// <cmd>:` only ever logs `spawn-error` or `closed` (clients/lsp/launch.ts).
			if (
				/^lsp (?:spawn [^:]+: (?:unavailable|failed)|launch (?:candidate|managed|bundle|tree-bin) failed)/.test(
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
	// Close the final run so the last `session_start fired` block is analyzed.
	if (state.session.currentRun.startTs)
		state.session.runs.push(state.session.currentRun);
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
				state.actionable.autoFixEligible += Number(
					summary.autoFixEligible ?? 0,
				);
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
						message: String(entry.errorRaw ?? "")
							.replace(/\s+/g, " ")
							.slice(0, 180),
						pattern: String(entry.pattern ?? "")
							.replace(/\s+/g, " ")
							.slice(0, 80),
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
						pattern: String(entry.pattern ?? "")
							.replace(/\s+/g, " ")
							.slice(0, 80),
					},
					limit * 3,
					byDuration,
				);
			}
		});
	}
}

/**
 * Per-model rollup (#1448): rule × model counts and auto-fixed vs
 * agent-required rates, from worklog.jsonl's optional `model`/`provider`
 * fields. Entries predating #1448 (or written outside a live agent turn)
 * have neither field — bucketed under the empty-string model/provider key so
 * "unattributed" volume stays visible rather than silently dropped.
 */
async function analyzeWorklog(files, state) {
	for (const file of files) {
		await forEachJsonLine(file, "worklog", state, (entry) => {
			const ts = dateOf(entry.timestamp);
			if (!inWindow(ts)) return;
			state.seen.inc("worklog");
			const rule = entry.rule ?? "unknown";
			const model = entry.model ?? "";
			const provider = entry.provider ?? "";
			const key = `${rule}||${model}`;
			const row = state.worklog.byRuleModel.get(key) ?? {
				rule,
				model,
				total: 0,
				autoFixed: 0,
			};
			row.total += 1;
			if (entry.autoFixed) row.autoFixed += 1;
			state.worklog.byRuleModel.set(key, row);
			state.worklog.byModel.inc(model || "(unknown)");
			if (entry.autoFixed)
				state.worklog.byModelAutoFixed.inc(model || "(unknown)");
			state.worklog.byProvider.inc(provider || "(unknown)");
		});
	}
}

async function forEachJsonLine(file, bucket, state, visitor) {
	await forEachLine(file, async (line) => {
		if (!line.trim()) return;
		try {
			const entry = JSON.parse(line);
			if (isExcludedEntry(entry)) {
				state.excludedRows++;
				return;
			}
			visitor(entry);
		} catch {
			state.parseErrors.inc(`${bucket}:${path.basename(file)}`);
		}
	});
}

function isExcludedEntry(entry) {
	return pathValues(entry).some((value) =>
		excludeGlobs.some((glob) =>
			minimatch(value, glob, { nocase: true, dot: true }),
		),
	);
}

function pathValues(value, key = "") {
	if (typeof value === "string") {
		return /(file|path|cwd|root|project)/i.test(key)
			? [normalizePath(value)]
			: [];
	}
	if (!value || typeof value !== "object") return [];
	return Object.entries(value).flatMap(([childKey, child]) =>
		pathValues(child, childKey),
	);
}

function isExcludedText(text) {
	// E4: the old match only ever saw the dead `session_start cwd:` line. The
	// live cwd/root carriers are the pending-resolution mark and the spawn lines.
	const values = [];
	const cwd = /session_start cwd:\s*(.*)$/.exec(text)?.[1];
	if (cwd) values.push(cwd);
	for (const match of text.matchAll(/\b(?:cwd|root)=(\S+)/g))
		values.push(match[1]);
	return values.some((value) =>
		excludeGlobs.some((glob) =>
			minimatch(normalizePath(value), glob, { nocase: true, dot: true }),
		),
	);
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

/**
 * The config-resolution join key (#2552 review round 4). A warm MCP process
 * keeps ONE session id for its entire life but calls `loadLSPConfig` once per
 * SERVED ROOT (#2526 review round 2, F3's premise, reintroduced one layer up
 * here) — joining on session id alone let one root's row silently clear every
 * OTHER root's deficit under the same session id. `root` is whatever string
 * the producer already wrote (the pending mark's `root=`, or the row's own
 * `filePath` — both come from the SAME `configResolutionKey(cwd)` call in
 * `clients/lsp/config.ts`, which folds separators, canonicalizes, then folds
 * again — `normalizeFilePath(path.resolve(normalizeFilePath(cwd)))`, in that
 * order (#2518 review F6; resolving first breaks POSIX backslash names), so they compare equal without this script re-deriving any
 * path normalization of its own).
 */
function configJoinKey(sessionId, root) {
	return `${sessionId} ${root}`;
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

/**
 * A `config_resolved` row (#2526), summarised for a smell example.
 *
 * Deliberately NOT `summarizeLatency`: that helper's metadata whitelist would
 * drop every field this row carries, so the example would print a phase name
 * and nothing a reader could act on.
 */
function summarizeConfigResolved(entry, note) {
	const md = entry.metadata ?? {};
	const documents = Array.isArray(md.documents) ? md.documents : [];
	return {
		ts: entry.ts,
		durationMs: entry.durationMs,
		phase: entry.phase,
		project: projectOf(entry.filePath),
		note,
		documents: documents
			.map(
				(doc) =>
					`${doc?.tier ?? "?"}:${doc?.file ?? "?"}${doc?.legacy ? " (legacy)" : ""}`,
			)
			.slice(0, 8),
		recordCount: md.recordCount,
		deniedServers: md.deniedServers,
	};
}

function summarizeWorkspaceSweep(entry) {
	const md = entry.metadata ?? {};
	const bits = [];
	if (md.completed != null)
		bits.push(`completed ${md.completed}/${md.total ?? md.fileCount ?? "?"}`);
	else if (md.filesChecked != null) bits.push(`checked ${md.filesChecked}`);
	if (md.timedOutFiles) bits.push(`timedOutFiles=${md.timedOutFiles}`);
	if (md.aborted) bits.push("aborted");
	if (md.perFileMs) bits.push(`perFileMs=${md.perFileMs}`);
	return {
		ts: entry.ts,
		durationMs: entry.durationMs,
		project: projectOf(entry.filePath),
		filePath: shortPath(entry.filePath),
		message: bits.join(", "),
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
	const md = entry.metadata ?? {};
	// R2: the old offset/limit/symbol fields were undefined on 100% of rows.
	// `touchedLines[0]`/`range[0]` are the real line identity the rows carry.
	const touched = Array.isArray(md.touchedLines) ? md.touchedLines : [];
	const range = Array.isArray(md.range) ? md.range : [];
	return {
		ts: entry.ts,
		event: entry.event,
		filePath: shortPath(entry.filePath),
		project: projectOf(entry.filePath),
		line: touched[0] ?? range[0],
		metadata: md,
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

/** One D3/D4/D5/D8 run, opened by a `session_start fired` line. */
function newRun() {
	return {
		startTs: null,
		commit: null,
		edits: 0,
		ran: 0,
		failedFirst: 0,
		crossCheckout: 0,
		excluded: 0,
		excludedTestFiles: [],
		noTestFile: 0,
		retainingNewerTurn: 0,
		testFirings: 0,
		testStale: 0,
	};
}

/** The checkout a turn-end path belongs to (`.worktrees/<id>/` or the main `src/`). */
function checkoutOf(p) {
	const m = /\.worktrees\/([^/]+)\//.exec(p);
	if (m) return m[1];
	if (/^(?:src|tests?)\//.test(p)) return "main";
	return null;
}

/**
 * D2: the markers only a test home carries: the #3521 fork-tree witness home
 * and the suite's `pi-lens-test-*` temp dirs. `pi-lens-worktrees`,
 * `pi-lens-orchestrator/tmp` and `.probe-home/` are not markers: real
 * sessions edit there (the orchestrator writes its task files under
 * `.probe-home/orchestration/`).
 */
const SCRATCH_PATH_RE = /(witness-home|pi-lens-test-)/;

/**
 * E5/D2: the `opaque_mutation_*` phases log the bash command as `filePath`
 * (clients/runtime-tool-call.ts, clients/runtime-tool-result.ts), except
 * `opaque_mutation_recovered`, which logs the recovered paths.
 */
function isCommandTextRow(entry) {
	const phase = String(entry.phase ?? "");
	return (
		phase.startsWith("opaque_mutation_") &&
		phase !== "opaque_mutation_recovered"
	);
}

/** E5: track a latency row's project unless its `filePath` is a shell command. */
function trackLatencyProject(state, entry) {
	const filePath = entry?.filePath;
	if (typeof filePath !== "string" || filePath.length === 0) return;
	if (isCommandTextRow(entry)) return;
	// The `<pi-lens>` sentinel is never a project path.
	if (filePath.startsWith("<")) return;
	state.projects.inc(projectOf(filePath));
}

function trackLatencyPollution(state, entry) {
	if (isCommandTextRow(entry)) return;
	const hit = pathValues(entry).some((value) => SCRATCH_PATH_RE.test(value));
	if (!hit) return;
	const pid = String(entry.pid ?? "unknown");
	state.latency.scratchRows.set(
		pid,
		(state.latency.scratchRows.get(pid) ?? 0) + 1,
	);
}

/**
 * Every latency signal the D5/D6/D7/D9/D11-D15 detectors read. Kept in one
 * function so the streaming visitor stays a thin fan-out.
 */
function trackLatencySignals(state, entry, ts) {
	const ms = ts instanceof Date ? ts.getTime() : null;
	if (ms != null && Number.isFinite(ms)) state.latency.rowTs.push(ms);
	const pid = String(entry.pid ?? "unknown");
	if (ms != null && Number.isFinite(ms)) {
		const first = state.latency.pidFirstTs.get(pid);
		if (first == null || ms < first) state.latency.pidFirstTs.set(pid, ms);
		const last = state.latency.pidLastTs.get(pid);
		if (last == null || ms > last) state.latency.pidLastTs.set(pid, ms);
	}
	trackLatencyPollution(state, entry);

	if (entry.type === "runner") {
		const md = entry.metadata ?? {};
		if (
			entry.status === "failed" &&
			md.tier === "collect-later" &&
			Number(entry.diagnosticCount ?? 0) > 0 &&
			runnerFailureKind(entry) === "blocking_diagnostics"
		) {
			state.latency.deferredRunnerFailed.push({
				ts: entry.ts,
				ms,
				pid,
				turnId: entry.turnId,
				runnerId: entry.runnerId,
				diagnosticCount: Number(entry.diagnosticCount ?? 0),
				filePath: entry.filePath,
			});
		}
		return;
	}

	if (entry.type === "tool_result") {
		// D8: the turn_end summary row carries `blockerSections`; the existing
		// tool_result branch only counts `result`, so it never saw this duration.
		if (entry.metadata && entry.metadata.blockerSections != null) {
			const rows = state.latency.turnEndTools.get(pid) ?? [];
			rows.push({
				ts: entry.ts,
				ms,
				durationMs: Number(entry.durationMs ?? 0),
			});
			state.latency.turnEndTools.set(pid, rows);
		}
		return;
	}
	if (entry.type !== "phase") return;

	const phase = entry.phase ?? "unknown";
	const md = entry.metadata ?? {};
	const nowIso = entry.ts;

	if (phase === "test_runner_delivery") {
		const sid = md.sessionId ?? pid;
		const c = state.latency.testRunnerDelivery.get(sid) ?? counter();
		c.inc(md.outcome ?? "unknown");
		state.latency.testRunnerDelivery.set(sid, c);
	} else if (phase === "knip") {
		if (
			md.execution === "executed" &&
			Number.isFinite(Number(md.totalIssues))
		) {
			const rows = state.latency.knip.get(pid) ?? [];
			rows.push({
				ts: nowIso,
				ms,
				durationMs: Number(entry.durationMs ?? 0),
				totalIssues: Number(md.totalIssues),
			});
			state.latency.knip.set(pid, rows);
		}
	} else if (phase === "degradation_ledger") {
		const kind = md.kind ?? "unknown";
		const perPid = state.latency.degradationKinds.get(pid) ?? new Map();
		perPid.set(kind, Math.max(perPid.get(kind) ?? 0, Number(md.count ?? 0)));
		state.latency.degradationKinds.set(pid, perPid);
		if (kind === "hook-await-exceeded") {
			const budgetMs = Number(md.budgetMs);
			const elapsedMs = Number(md.elapsedMs);
			state.latency.hookAwaitExceeded.push({
				ts: nowIso,
				pid,
				hook: md.hook,
				label: md.label,
				budgetMs,
				elapsedMs,
				cause: md.cause,
				ratio: budgetMs > 0 ? elapsedMs / budgetMs : 0,
			});
		}
	} else if (phase === "lsp_client_wait_timeout") {
		const serverIds = Array.isArray(md.serverIds) ? md.serverIds : [];
		if (serverIds.length === 0) {
			const cur = state.latency.lspWaitEmpty.get(pid) ?? { ms: 0, rows: 0 };
			cur.ms += Number(entry.durationMs ?? 0);
			cur.rows += 1;
			state.latency.lspWaitEmpty.set(pid, cur);
		}
	} else if (phase === "lsp_touch_file") {
		const cur = state.latency.lspTouchEdit.get(pid) ?? {
			rows: 0,
			noClients: 0,
		};
		if (md.source === "tool_call:edit") {
			cur.rows += 1;
			if (md.failureKind === "no_clients_none_spawning") cur.noClients += 1;
		}
		state.latency.lspTouchEdit.set(pid, cur);
		if (
			md.source === "tool_call:edit" &&
			md.failureKind === "no_clients_none_spawning"
		) {
			state.latency.lspTouchNoClients.push({
				ts: nowIso,
				ms,
				pid,
				filePath: entry.filePath,
			});
		}
	} else if (phase === "lsp_client_selected") {
		if (md.outcome === "warm-reuse") {
			state.latency.lspClientSelectedWarm.push({
				ts: nowIso,
				ms,
				pid,
				filePath: entry.filePath,
			});
		}
	} else if (phase === "read_guard_branch_retained") {
		state.latency.carryRestart.push({
			ts: nowIso,
			pid,
			trigger: md.trigger,
			source: md.source,
			kept: Number(md.kept ?? 0),
			dropped: Number(md.dropped ?? 0),
			branchToolResults: Number(md.branchToolResults ?? 0),
			branchReadable: md.branchReadable === true,
		});
	} else if (phase === "agent_nudge") {
		state.latency.agentNudges.push({
			ts: nowIso,
			ms,
			pid,
			originCrossProcess: Number(md.originCrossProcess ?? 0),
			originLocal: Number(md.originLocal ?? 0),
			reasonMix: md.reasonMix,
		});
	} else if (phase === "session_scope_transition") {
		state.latency.sessionScopeTransitions.push({
			ts: nowIso,
			ms,
			pid,
			handoffSource: md.handoffSource,
			sessionId: md.sessionId,
		});
	} else if (phase === "late_runner_findings") {
		state.latency.lateRunnerFindings.push({
			ts: nowIso,
			ms,
			pid,
			turnId: entry.turnId,
			failed: Number(md.failed ?? 0),
			delivered: Number(md.delivered ?? 0),
			dropped: Number(md.dropped ?? 0),
			pending: Number(md.pending ?? 0),
		});
	} else if (phase === "late_auxiliary_findings") {
		const pairs = Array.isArray(md.stuckPairs) ? md.stuckPairs : [];
		for (const pair of pairs) {
			if (!pair?.filePath || !pair?.serverId) continue;
			const key = `${pid}\u0000${pair.filePath}\u0000${pair.serverId}`;
			state.latency.auxStuck.set(
				key,
				(state.latency.auxStuck.get(key) ?? 0) + 1,
			);
		}
	} else if (phase === "advisory_provenance_decision") {
		const reasons = Array.isArray(md.reasons) ? md.reasons : [];
		// The malformed reason implies decision "historical": the validator
		// returns status "unknown" with it (clients/advisory-provenance.ts) and
		// the row logs every non-current status as historical
		// (clients/runtime-context.ts), so the reason alone is the rule.
		if (reasons.includes("malformed-or-legacy-provenance")) {
			state.latency.advisoryProvenance.push({
				ts: nowIso,
				ms,
				pid,
				reasons,
				provenanceStamp: md.provenanceStamp,
				advisoryKind: md.advisoryKind,
			});
		}
	}
}

/** D2: extension.log rows that name a test home. */
async function analyzeExtension(files, state) {
	for (const file of files) {
		await forEachJsonLine(file, "extension", state, (entry) => {
			const ts = dateOf(entry.ts);
			if (!inWindow(ts)) return;
			state.seen.inc("extension");
			if (SCRATCH_PATH_RE.test(JSON.stringify(entry))) {
				const pid = String(entry.pid ?? "unknown");
				state.extension.scratchRows.set(
					pid,
					(state.extension.scratchRows.get(pid) ?? 0) + 1,
				);
			}
			const level = String(entry.level ?? "").toLowerCase();
			if (level === "warn" || level === "error") {
				const message = String(entry.message ?? "").slice(0, 80);
				state.extension.warnErrorGroups.inc(
					`${entry.subsystem ?? "unknown"}: ${message}`,
				);
			}
		});
	}
}

function countBetween(sorted, a, b) {
	let n = 0;
	for (const value of sorted) {
		if (value > a && value < b) n += 1;
		else if (value >= b) break;
	}
	return n;
}

/** D1: latency gaps >= 10 min that a live session filled with >= 20 rows. */
function computeCoverageGaps(state) {
	const lat = [...state.latency.rowTs].sort((a, b) => a - b);
	const ss = [...state.session.rowTs].sort((a, b) => a - b);
	const cas = [...state.latency.cascadeTs].sort((a, b) => a - b);
	const gaps = [];
	for (let i = 1; i < lat.length; i += 1) {
		const a = lat[i - 1];
		const b = lat[i];
		const minutes = (b - a) / 60000;
		if (minutes < 10) continue;
		const sessionstartRows = countBetween(ss, a, b);
		if (sessionstartRows < 20) continue;
		gaps.push({
			start: new Date(a).toISOString(),
			end: new Date(b).toISOString(),
			minutes: Math.round(minutes),
			sessionstartRows,
			cascadeRows: countBetween(cas, a, b),
		});
	}
	return gaps;
}

/** D5: per-session firing/stale text and per-session delivery outcomes. */
function computeTestRunnerHealth(state) {
	const runs = state.session.runs.map((r) => ({
		startTs: r.startTs,
		firings: r.testFirings,
		stale: r.testStale,
	}));
	const staleRuns = runs.filter(
		(r) => r.firings >= 10 && r.stale / r.firings >= 0.5,
	);
	const firings = runs.reduce((n, r) => n + r.firings, 0);
	const stale = runs.reduce((n, r) => n + r.stale, 0);
	const sessions = [];
	for (const [sessionId, c] of state.latency.testRunnerDelivery) {
		const total = c.entries().reduce((n, [, v]) => n + v, 0);
		const delivered = c.get("delivered");
		sessions.push({
			sessionId,
			total,
			staged: c.get("staged"),
			eligible: c.get("eligible"),
			delivered,
			superseded: c.get("superseded"),
			deliveredShare: total ? delivered / total : 0,
		});
	}
	const lowDelivery = sessions.filter(
		(s) => s.total >= 10 && s.deliveredShare < 0.25,
	);
	return {
		firings,
		stale,
		staleShare: firings ? stale / firings : 0,
		staleRuns,
		sessions,
		lowDelivery,
	};
}

/** D6: scanner issue-count drift and turn-end knip wall cost, per pid. */
function computeKnip(state) {
	const drift = [];
	const cost = [];
	for (const [pid, rowsRaw] of state.latency.knip) {
		const rows = [...rowsRaw]
			.filter((r) => r.ms != null)
			.sort((a, b) => a.ms - b.ms);
		if (rows.length >= 10) {
			const issues = rows.map((r) => r.totalIssues);
			let increments = 0;
			for (let i = 1; i < issues.length; i += 1)
				if (issues[i] - issues[i - 1] >= 100) increments += 1;
			const min = Math.min(...issues);
			const max = Math.max(...issues);
			const spread = min > 0 ? (max - min) / min : 0;
			if (increments >= 5 || spread >= 0.25)
				drift.push({ pid, rows: rows.length, increments, min, max, spread });
		}
		const first = state.latency.pidFirstTs.get(pid);
		const last = state.latency.pidLastTs.get(pid);
		const hours = first != null && last != null ? (last - first) / 3600000 : 0;
		const totalMs = rows.reduce((n, r) => n + r.durationMs, 0);
		const maxRow = rows.reduce((n, r) => Math.max(n, r.durationMs), 0);
		// A lifetime under an hour counts as one hour, so a short pid's few
		// seconds of knip cannot extrapolate to a large hourly rate.
		const perHour = totalMs / Math.max(hours, 1);
		if (perHour >= 30000 || maxRow >= 5000)
			cost.push({ pid, rows: rows.length, totalMs, hours, perHour, maxRow });
	}
	return { drift, cost };
}

/** D7: hook deopts that overran their budget, plus the degradation census. */
function computeHookAwait(state) {
	const rows = [...state.latency.hookAwaitExceeded].sort((a, b) =>
		String(b.ts).localeCompare(String(a.ts)),
	);
	const census = [];
	for (const [pid, kinds] of state.latency.degradationKinds) {
		census.push({
			pid,
			kinds: [...kinds.entries()]
				.sort((a, b) => b[1] - a[1])
				.slice(0, 12)
				.map(([kind, count]) => `${kind}=${count}`),
		});
	}
	return { rows, over: rows.filter((r) => r.ratio >= 1.1).length, census };
}

/** D8: turn_end hook duration per pid, and the retained-turn-state runs. */
function computeTurnEndSlow(state) {
	const flagged = [];
	for (const [pid, rows] of state.latency.turnEndTools) {
		const slow = rows.filter((r) => r.durationMs > 3000).length;
		const max = rows.reduce((n, r) => Math.max(n, r.durationMs), 0);
		const share = rows.length ? slow / rows.length : 0;
		if ((rows.length >= 20 && share >= 0.1) || max >= 8000)
			flagged.push({ pid, rows: rows.length, slow, share, max });
	}
	const retainRuns = state.session.runs
		.filter((r) => r.retainingNewerTurn >= 5)
		.map((r) => ({ start: r.startTs, count: r.retainingNewerTurn }));
	return { flagged, retainRuns };
}

/** D9: empty-candidate waits, edit touches with no client, warm-reuse clashes. */
function computeLspWait(state) {
	const empty = [];
	for (const [pid, cur] of state.latency.lspWaitEmpty)
		if (cur.ms >= 5000) empty.push({ pid, ms: cur.ms, rows: cur.rows });
	const noClients = [];
	for (const [pid, cur] of state.latency.lspTouchEdit)
		if (cur.rows >= 20 && cur.noClients / cur.rows >= 0.2)
			noClients.push({
				pid,
				rows: cur.rows,
				noClients: cur.noClients,
				share: cur.noClients / cur.rows,
			});
	const contradictions = [];
	for (const touch of state.latency.lspTouchNoClients) {
		const match = state.latency.lspClientSelectedWarm.find(
			(w) =>
				w.pid === touch.pid &&
				w.filePath === touch.filePath &&
				touch.ms != null &&
				w.ms != null &&
				Math.abs(w.ms - touch.ms) <= 500,
		);
		if (match)
			contradictions.push({
				pid: touch.pid,
				filePath: touch.filePath,
				touchTs: touch.ts,
				selectedTs: match.ts,
			});
	}
	const pids = new Set([
		...empty.map((e) => e.pid),
		...noClients.map((e) => e.pid),
		...contradictions.map((c) => c.pid),
	]);
	return { empty, noClients, contradictions, pidCount: pids.size };
}

/** D11: a restart kept nothing while the branch held a populated read set. */
function computeCarryRestart(state) {
	return state.latency.carryRestart.filter(
		(r) =>
			["startup", "resume", "fork", "reload"].includes(r.trigger) &&
			r.source !== "none" &&
			r.kept + r.dropped === 0 &&
			r.branchToolResults >= 50 &&
			r.branchReadable,
	);
}

/** D12: a cross-process nudge right after a sidecar handoff (suspect grade). */
function computeRestartSelfNudge(state) {
	const flags = [];
	for (const nudge of state.latency.agentNudges) {
		if (nudge.originCrossProcess < 1) continue;
		const transition = state.latency.sessionScopeTransitions.find(
			(t) =>
				t.pid === nudge.pid &&
				["own-sidecar", "parent-sidecar"].includes(t.handoffSource) &&
				nudge.ms != null &&
				t.ms != null &&
				nudge.ms >= t.ms &&
				nudge.ms - t.ms <= 300000,
		);
		if (transition) flags.push({ ...nudge, transitionTs: transition.ts });
	}
	return flags;
}

/** D13: a collect-later runner failed with findings and nothing was delivered. */
function computeDeferredRunner(state) {
	const flags = [];
	for (const runner of state.latency.deferredRunnerFailed) {
		const delivery = state.latency.lateRunnerFindings.find(
			(f) =>
				f.pid === runner.pid &&
				f.turnId === runner.turnId &&
				(runner.ms == null || f.ms == null || f.ms >= runner.ms),
		);
		if (
			delivery &&
			delivery.failed >= 1 &&
			delivery.delivered === 0 &&
			delivery.dropped === 0
		)
			flags.push({
				...runner,
				deliveryTs: delivery.ts,
				pending: delivery.pending,
			});
	}
	return flags;
}

/** D14: an auxiliary (file, server) pair stuck in two or more turn ends. */
function computeAuxStuck(state) {
	const flagged = [];
	for (const [key, count] of state.latency.auxStuck) {
		if (count < 2) continue;
		const [pid, filePath, serverId] = key.split("\u0000");
		flagged.push({ pid, filePath, serverId, count });
	}
	flagged.sort((a, b) => b.count - a.count);
	return flagged;
}

/** D15: `historical` provenance with a malformed/legacy stamp. */
function computeAdvisoryProvenance(state) {
	return state.latency.advisoryProvenance.map((row) => {
		const first = state.latency.pidFirstTs.get(row.pid);
		const seconds =
			first != null && row.ms != null
				? Math.round((row.ms - first) / 1000)
				: null;
		return { ...row, secondsSinceFirstRow: seconds };
	});
}

/** D16: `pi-lens loaded: Nms` loads over 2 s. A load with no
 * `session_start fired` within the next 60 s is a short-lived pid. */
function computeSlowExtensionLoad(state) {
	const fired = state.session.firedTs;
	return state.session.slowLoads
		.filter((l) => l.durationMs >= 2000)
		.map((l) => ({
			...l,
			shortLived: !(
				Number.isFinite(l.ms) &&
				fired.some((f) => f >= l.ms && f - l.ms <= 60000)
			),
		}));
}

function buildReport(state) {
	const smells = [];
	const smellCount = (id) => state.smellTotals.get(id);

	// D1-D16 detector computations. Kept out of the smell list so every value
	// they produce is assertable on its own, not only through a smell count.
	const coverageGaps = computeCoverageGaps(state);
	const testRunnerHealth = computeTestRunnerHealth(state);
	const knip = computeKnip(state);
	const hookAwait = computeHookAwait(state);
	const turnEndSlow = computeTurnEndSlow(state);
	const lspWait = computeLspWait(state);
	const carryRestart = computeCarryRestart(state);
	const restartSelfNudge = computeRestartSelfNudge(state);
	const deferredRunner = computeDeferredRunner(state);
	const auxStuck = computeAuxStuck(state);
	const advisoryProvenance = computeAdvisoryProvenance(state);
	const slowExtensionLoad = computeSlowExtensionLoad(state);
	const latencyScratch = [...state.latency.scratchRows.values()].reduce(
		(n, v) => n + v,
		0,
	);
	const extensionScratch = [...state.extension.scratchRows.values()].reduce(
		(n, v) => n + v,
		0,
	);
	const d3Runs = state.session.runs.filter((r) => {
		const excludedTest = r.excludedTestFiles.some((p) =>
			/\.(test|spec)\.|\/tests?\//.test(p),
		);
		return (r.excluded >= 1 && excludedTest) || (r.edits >= 10 && r.ran === 0);
	});
	const d4Cross = state.session.runs.reduce(
		(n, r) => n + (r.crossCheckout >= 3 ? r.crossCheckout : 0),
		0,
	);
	const testRunnerSmellCount =
		testRunnerHealth.staleRuns.length + testRunnerHealth.lowDelivery.length;
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
	// #2526: config resolution has to prove it HAPPENED. Two shapes, one smell:
	//
	// (a) a session that has a `config_resolution_pending` mark and produced no
	//     `config_resolved` row. Round 3, S1: the pending mark is written by
	//     `loadLSPConfig` itself, at the instant a resolution is actually
	//     attempted — never predicted from a handler's own flags ahead of time.
	//     Round 2, F2 established the JOIN itself: on the session id both sides
	//     carry, never a subtraction of two counts (subtracting counted quick
	//     sessions' rows against full sessions' start lines — different
	//     populations — which both masked total silence and charged
	//     `--no-lsp`/subagent sessions with a permanent deficit they could never
	//     clear).
	//     Round 4, #2552 review: the join is on (session, root), not session
	//     alone — a warm MCP process keeps one session id for its whole life but
	//     marks once per SERVED ROOT (`configJoinKey`'s doc comment), so one
	//     root's row must not clear another root's deficit under the same id.
	// (b) a legacy document present with zero records — the deprecation
	//     machinery went silent while the user is on a removal schedule.
	const pendingConfigResolution = [...state.config.pendingSessions.entries()];
	const unresolvedSessions = pendingConfigResolution.filter(
		([key]) => !state.config.resolvedSessions.has(key),
	);
	for (const [, value] of unresolvedSessions.slice(0, limit * 3)) {
		state.config.examples.push({
			ts: value.ts,
			session: value.sessionId,
			root: value.root,
			note: "session had a config_resolution_pending mark and produced no config_resolved row",
		});
	}
	addSmell(
		smells,
		"config-resolution",
		unresolvedSessions.length + state.config.legacyWithoutRecords,
		`Sessions with a config_resolution_pending mark but no config_resolved row (${unresolvedSessions.length} of ${pendingConfigResolution.length}) or a legacy config document that produced no migration record (${state.config.legacyWithoutRecords})`,
		state.config.examples.slice(0, limit),
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
		"read-guard-blocks",
		state.readGuard.events.get("edit_blocked") +
			state.readGuard.events.get("edit_preflight_blocked"),
		"Read-guard blocked edits; host/model provenance is not present on the block rows, and warns and exact-replacement misses are informational",
		state.readGuard.blocks.slice(0, limit),
	);
	addSmell(
		smells,
		"read-guard-stale-ranges",
		smellCount("read-guard-stale-ranges"),
		`Enforced range mismatches whose read snapshot no longer matched (bypassed-content-match ${state.readGuard.bypassedMismatch} excluded as an allowed edit)`,
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
	const ws = state.latency.workspace;
	const incompleteSweeps = Math.max(0, ws.started - ws.completed);
	addSmell(
		smells,
		"lsp-workspace-diagnostics-incomplete",
		incompleteSweeps,
		"Full LSP workspace sweeps that logged a start but never a completion (hang/kill signature — the 8h-hang class #383 hardened)",
		ws.progress.slice(0, limit),
	);
	// #1618: "hit the per-file budget" used to be this smell's blanket
	// description regardless of WHY a file was unconfirmed — the exact
	// mislabeling the forensics pass on this class found (81/111 "budget"
	// files were actually service-destroyed). Render the real breakdown when
	// available.
	const unconfirmedReasonBreakdown = ws.unconfirmedByReason
		.top(limit)
		.map(({ key, count }) => `${key}=${count}`)
		.join(", ");
	addSmell(
		smells,
		"lsp-workspace-file-timeouts",
		smellCount("lsp-workspace-file-timeouts"),
		`Full LSP sweeps produced an unconfirmed file (${ws.timedOutFilesTotal} files across ${ws.timedOutSweeps} sweeps)` +
			(unconfirmedReasonBreakdown
				? ` — by reason: ${unconfirmedReasonBreakdown}`
				: ""),
		ws.sweeps.slice(0, limit),
	);

	// D1: a latency gap a live session filled.
	addSmell(
		smells,
		"log-coverage-gap",
		coverageGaps.length,
		"Latency stream gap >= 10 min that a live session filled with >= 20 sessionstart rows",
		coverageGaps.slice(0, limit).map((g) => ({
			ts: g.start,
			message: `${g.minutes} min gap ${g.start} -> ${g.end}; sessionstartRows=${g.sessionstartRows}; cascadeRows=${g.cascadeRows}`,
		})),
	);
	// D2: test home markers in a real log. Never added to the
	// default denylist so the pollution stays visible.
	addSmell(
		smells,
		"real-log-test-pollution",
		latencyScratch + extensionScratch,
		`Rows naming a test home (witness-home, pi-lens-test-*) (latency ${latencyScratch}, extension ${extensionScratch}); these never belong in a real log`,
		[
			...[...state.latency.scratchRows.entries()].map(([pid, count]) => ({
				key: `latency pid ${pid}`,
				count,
			})),
			...[...state.extension.scratchRows.entries()].map(([pid, count]) => ({
				key: `extension pid ${pid}`,
				count,
			})),
		].slice(0, limit),
	);
	addSmell(
		smells,
		"extension-warn-errors",
		state.extension.warnErrorGroups.size,
		"extension.log warn/error groups by subsystem and message prefix",
		state.extension.warnErrorGroups.top(limit),
	);
	// D3: a run that excluded its own test files, or edited without running one.
	addSmell(
		smells,
		"turn-end-tests-excluded",
		d3Runs.length,
		"Turn-end runs that skipped test files by policy, or edited >= 10 files and ran no test",
		d3Runs.slice(0, limit).map((r) => ({
			ts: r.startTs,
			message: `edits=${r.edits} ran=${r.ran} excluded=${r.excluded} noTestFile=${r.noTestFile}${
				r.excludedTestFiles.length ? `: ${r.excludedTestFiles.join(", ")}` : ""
			}`,
		})),
	);
	// D4: a failed-first target that resolved to a different checkout (#3649).
	addSmell(
		smells,
		"test-target-cross-checkout",
		d4Cross,
		"Failed-first test targets resolved to a different checkout than the edited source (regression guard for #3649)",
		state.session.runs
			.filter((r) => r.crossCheckout >= 3)
			.slice(0, limit)
			.map((r) => ({
				ts: r.startTs,
				message: `${r.crossCheckout} cross-checkout of ${r.failedFirst} failed-first`,
			})),
	);
	// D5: sessions whose turn-end verdicts went stale, or were rarely delivered.
	addSmell(
		smells,
		"test-runner-stale-verdicts",
		testRunnerSmellCount,
		`Sessions with >= 10 test firings and >= 50% stale (${testRunnerHealth.staleRuns.length}), or >= 10 delivery rows and < 25% delivered (${testRunnerHealth.lowDelivery.length}); window firings ${testRunnerHealth.firings}, stale ${testRunnerHealth.stale}`,
		[
			...testRunnerHealth.staleRuns.map((r) => ({
				ts: r.startTs,
				count: r.stale,
				message: `firings=${r.firings} stale=${r.stale}`,
			})),
			...testRunnerHealth.lowDelivery.map((s) => ({
				key: s.sessionId,
				count: s.delivered,
				message: `delivered ${s.delivered}/${s.total} (${Math.round(
					s.deliveredShare * 100,
				)}%), staged ${s.staged}, eligible ${s.eligible}, superseded ${s.superseded}`,
			})),
		].slice(0, limit),
	);
	// D6: scanner-count drift and knip wall cost.
	addSmell(
		smells,
		"scanner-count-drift",
		knip.drift.length,
		"knip totalIssues rose by >= 100 between consecutive executed runs at least 5 times, or its spread >= 25% (pids with >= 10 executed runs)",
		knip.drift.slice(0, limit).map((d) => ({
			key: `pid ${d.pid}`,
			count: d.increments,
			message: `issues ${d.min} -> ${d.max} (+${Math.round(
				d.spread * 100,
			)}%), ${d.increments} increments >= 100`,
		})),
	);
	addSmell(
		smells,
		"turn-end-knip-cost",
		knip.cost.length,
		"knip consumed >= 30 s per hour of pid lifetime (a lifetime under an hour counts as one hour), or a single run took >= 5 s",
		knip.cost.slice(0, limit).map((c) => ({
			key: `pid ${c.pid}`,
			count: Math.round(c.perHour),
			message: `${c.totalMs}ms over ${c.hours.toFixed(2)}h = ${Math.round(
				c.perHour,
			)}ms/h, max ${c.maxRow}ms`,
		})),
	);
	// D7: hook deopts that overran their budget.
	addSmell(
		smells,
		"hook-await-exceeded",
		hookAwait.rows.length,
		`Hook awaits that overran their budget (${hookAwait.over} with ratio >= 1.1)`,
		hookAwait.rows.slice(0, limit).map((r) => ({
			ts: r.ts,
			message: `${r.hook}:${r.label} ${r.elapsedMs}/${r.budgetMs}ms (${r.ratio.toFixed(
				3,
			)}) pid=${r.pid} cause=${r.cause}`,
		})),
	);
	// D8: turn_end hook duration and retained-state churn.
	addSmell(
		smells,
		"turn-end-slow",
		turnEndSlow.flagged.length,
		"turn_end hook duration over budget (a pid with >= 10% of summaries > 3 s, or one >= 8 s)",
		turnEndSlow.flagged.slice(0, limit).map((f) => ({
			key: `pid ${f.pid}`,
			count: f.slow,
			message: `${f.slow}/${f.rows} over 3s (${Math.round(
				f.share * 100,
			)}%), max ${f.max}ms`,
		})),
	);
	addSmell(
		smells,
		"turn-end-retained-state",
		turnEndSlow.retainRuns.length,
		"Turn-end retained newer turn state at least 5 times in one session",
		turnEndSlow.retainRuns.slice(0, limit).map((r) => ({
			ts: r.start,
			count: r.count,
		})),
	);
	// D9: empty-candidate waits and no-client/edit warm-reuse contradictions.
	addSmell(
		smells,
		"lsp-wait-empty-candidates",
		lspWait.pidCount,
		`LSP touch saw no client while a warm client was selected, or waited with an empty candidate set (empty ${lspWait.empty.length}, noClients ${lspWait.noClients.length}, contradictions ${lspWait.contradictions.length})`,
		[
			...lspWait.empty.map((e) => ({
				key: `pid ${e.pid}`,
				count: e.rows,
				message: `${e.ms}ms waiting with no candidate server`,
			})),
			...lspWait.noClients.map((e) => ({
				key: `pid ${e.pid}`,
				count: Math.round(e.share * 100),
				message: `${e.noClients}/${e.rows} edits saw no client (${Math.round(
					e.share * 100,
				)}%)`,
			})),
			...lspWait.contradictions.map((c) => ({
				key: `pid ${c.pid}`,
				count: 1,
				message: `${c.filePath}: no-client touch at ${c.touchTs}, warm-reuse at ${c.selectedTs}`,
			})),
		].slice(0, limit),
	);
	// D10: a zero_read block that contradicts earlier read/edit evidence.
	addSmell(
		smells,
		"resume-state-loss",
		state.readGuard.stateLost.length,
		`zero_read edits blocked despite earlier read/edit evidence in the same session (genuine ${state.readGuard.genuineZeroRead.length})`,
		state.readGuard.stateLost.slice(0, limit),
	);
	// D11: a restart whose read-set carry was empty while the branch was populated.
	addSmell(
		smells,
		"carry-empty-restart",
		carryRestart.length,
		"Restart carry kept and dropped nothing while the branch held a populated read set",
		carryRestart.slice(0, limit).map((r) => ({
			key: `pid ${r.pid}`,
			count: r.branchToolResults,
			message: `trigger=${r.trigger} source=${r.source} kept=${r.kept} dropped=${r.dropped} branchToolResults=${r.branchToolResults}`,
		})),
	);
	// D12: a cross-process nudge right after a sidecar handoff (suspect until O7).
	addSmell(
		smells,
		"restart-self-nudge",
		restartSelfNudge.length,
		"Cross-process nudge within 300 s of a sidecar handoff (suspect-grade until the nudge carries a file id, O7)",
		restartSelfNudge.slice(0, limit).map((r) => ({
			key: `pid ${r.pid}`,
			count: r.originCrossProcess,
			message: `${JSON.stringify(r.reasonMix)} crossProcess=${r.originCrossProcess} after ${r.transitionTs}`,
		})),
	);
	// D13: a collect-later runner failed with findings and none were delivered.
	addSmell(
		smells,
		"deferred-runner-failed-undelivered",
		deferredRunner.length,
		"collect-later runner failed with findings and the delivery row shows failed>=1, delivered=0, dropped=0 (#3796 witness)",
		deferredRunner.slice(0, limit).map((r) => ({
			ts: r.ts,
			message: `${r.runnerId} pid=${r.pid} turnId=${r.turnId} diagnostics=${r.diagnosticCount} delivery=${r.deliveryTs}`,
		})),
	);
	// D14: an auxiliary (file, server) pair stuck in >= 2 turn ends.
	addSmell(
		smells,
		"aux-stuck-pair",
		auxStuck.length,
		"Auxiliary (file, server) pair stuck in >= 2 turn ends",
		auxStuck.slice(0, limit).map((p) => ({
			key: p.serverId,
			count: p.count,
			message: `${p.filePath} pid=${p.pid}`,
		})),
	);
	// D15: historical provenance with a malformed/legacy stamp.
	addSmell(
		smells,
		"advisory-provenance-unknown",
		advisoryProvenance.length,
		"Advisory provenance resolved to historical with a malformed-or-legacy stamp",
		advisoryProvenance.slice(0, limit).map((r) => ({
			ts: r.ts,
			message: `${r.provenanceStamp} (${r.advisoryKind}) ${r.secondsSinceFirstRow}s after pid start`,
		})),
	);
	// D16: extension load time over 2 s.
	addSmell(
		smells,
		"slow-extension-load",
		slowExtensionLoad.length,
		"pi-lens loaded >= 2000ms after process start (short-lived: no session_start fired within 60 s)",
		slowExtensionLoad.slice(0, limit).map((l) => ({
			...l,
			message: `${l.message}${l.shortLived ? " [short-lived]" : ""}`,
		})),
	);

	return {
		window: state.window,
		filesScanned: Object.fromEntries(
			Object.entries(state.files).map(([key, list]) => [key, list.length]),
		),
		rowsSeen: state.seen.toJSON(),
		rowsExcluded: state.excludedRows,
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
			testRunnerVerdicts: Object.fromEntries(
				[...state.latency.testRunnerVerdicts.entries()].map(
					([sessionId, summary]) => [
						sessionId,
						{
							...summary,
							denominator: summary.total,
							rate: summary.total ? summary.stale / summary.total : 0,
						},
					],
				),
			),
			runnerStatus: state.latency.runnerStatus.top(limit * 2),
			runnerFailureKinds: state.latency.runnerFailureKinds.top(limit * 2),
			runnerBlockingFindings: state.latency.runnerBlockingFindings.toJSON(),
			toolResults: state.latency.toolResults.toJSON(),
			phaseCounts: state.latency.phaseCounts.top(limit),
			phaseTimeouts: state.latency.phaseTimeouts.toJSON(),
			workspaceDiagnostics: {
				started: ws.started,
				completed: ws.completed,
				incomplete: incompleteSweeps,
				aborted: ws.aborted,
				timedOutSweeps: ws.timedOutSweeps,
				timedOutFilesTotal: ws.timedOutFilesTotal,
				// #1618: the real per-reason breakdown of `timedOutFilesTotal`.
				// "budget (pre-#1618 build)" means those log lines predate the
				// per-reason tally entirely — an older build's absence of the field,
				// not a claim those files really timed out.
				unconfirmedByReason: ws.unconfirmedByReason.toJSON(),
			},
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
			// E2/D10: the block/warn split and the lost-read-set classification.
			warns: state.readGuard.warns.slice(0, limit),
			blockByKind: state.readGuard.blockByKind.toJSON(),
			bypassedMismatch: state.readGuard.bypassedMismatch,
			stateLost: state.readGuard.stateLost.slice(0, limit),
			genuineZeroRead: state.readGuard.genuineZeroRead.slice(0, limit),
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
			commits: state.session.commits.toJSON(),
			slowLoads: state.session.slowLoads.slice(0, limit),
			errors: state.session.errors.slice(0, limit),
		},
		// #2526: the positive-observability counters behind the
		// `config-resolution` smell, so a reader can see WHY it fired (or that
		// it correctly did not) without re-deriving the deficit.
		config: {
			resolved: state.config.resolved,
			sessionsPendingResolution: pendingConfigResolution.length,
			sessionsWithoutResolution: unresolvedSessions.length,
			legacyDocuments: state.config.legacyDocuments,
			legacyWithoutRecords: state.config.legacyWithoutRecords,
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
		worklog: {
			byModel: state.worklog.byModel.top(limit * 2),
			byProvider: state.worklog.byProvider.top(limit * 2),
			byRuleModel: [...state.worklog.byRuleModel.values()]
				.map((row) => ({
					...row,
					autoFixedRate: row.total ? row.autoFixed / row.total : 0,
				}))
				.sort((a, b) => b.total - a.total)
				.slice(0, limit * 3),
		},
		// D1-D16: the per-detector values behind the smells above, so a test can
		// pin the rule (not only the rendered count) and a reader can see WHY.
		detectors: {
			logCoverageGap: { gaps: coverageGaps },
			realLogTestPollution: {
				latencyByPid: Object.fromEntries(state.latency.scratchRows),
				extensionByPid: Object.fromEntries(state.extension.scratchRows),
				latencyTotal: latencyScratch,
				extensionTotal: extensionScratch,
			},
			turnEndTestsExcluded: {
				runs: d3Runs.map((r) => ({ ...r })),
			},
			testTargetCrossCheckout: {
				runs: state.session.runs.map((r) => ({
					startTs: r.startTs,
					crossCheckout: r.crossCheckout,
					failedFirst: r.failedFirst,
				})),
			},
			testRunnerStaleVerdicts: testRunnerHealth,
			knip,
			hookAwait,
			turnEndSlow,
			lspWait,
			resumeStateLoss: {
				stateLost: state.readGuard.stateLost,
				genuine: state.readGuard.genuineZeroRead,
			},
			carryEmptyRestart: carryRestart,
			restartSelfNudge,
			deferredRunnerFailedUndelivered: deferredRunner,
			auxStuckPairs: auxStuck,
			advisoryProvenanceUnknown: advisoryProvenance,
			slowExtensionLoad,
			extensionWarnErrors: state.extension.warnErrorGroups.toJSON(),
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
	console.log(`${report.rowsExcluded} rows excluded (synthetic corpora)`);
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

	// D1/D2/D5/D6/D7: the non-smell breakdown behind the new detectors.
	const det = report.detectors ?? {};
	const gap = det.logCoverageGap;
	if (gap?.gaps?.length) {
		console.log("\nLog coverage");
		for (const g of gap.gaps ?? [])
			console.log(
				`  gap ${g.minutes}min ${g.start} → ${g.end} sessionstart=${g.sessionstartRows} cascade=${g.cascadeRows}`,
			);
	}
	const warnErrors = Object.entries(det.extensionWarnErrors ?? {});
	if (warnErrors.length) {
		console.log("\nExtension diagnostics");
		for (const [k, v] of warnErrors.slice(0, limit))
			console.log(`  ${String(v).padStart(5)}  ${k}`);
	}
	const deg = det.hookAwait?.census ?? [];
	if (deg.length) {
		console.log("\nDegradation ledger census (max count per pid)");
		for (const row of deg.slice(0, limit))
			console.log(`  pid ${row.pid}: ${row.kinds.join(", ")}`);
	}
	const delivery = det.testRunnerStaleVerdicts;
	if (delivery) {
		console.log("\nTest-runner delivery");
		console.log(
			`  firings=${delivery.firings} stale=${delivery.stale} (${(
				delivery.staleShare * 100
			).toFixed(1)}%)`,
		);
		for (const s of delivery.sessions ?? [])
			console.log(
				`  ${s.sessionId}: delivered ${s.delivered}/${s.total} staged=${s.staged} eligible=${s.eligible} superseded=${s.superseded}`,
			);
	}
	const knip = det.knip;
	if (knip && (knip.drift.length || knip.cost.length)) {
		console.log("\nknip drift and cost");
		for (const d of knip.drift)
			console.log(
				`  pid ${d.pid}: issues ${d.min} → ${d.max} (${d.increments} increments >= 100)`,
			);
		for (const c of knip.cost)
			console.log(
				`  pid ${c.pid}: ${Math.round(c.perHour)}ms/h, max ${c.maxRow}ms`,
			);
	}
	const extLoads = det.slowExtensionLoad ?? [];
	if (extLoads.length) {
		const shortLived = extLoads.filter((l) => l.shortLived).length;
		console.log("\nExtension loads");
		console.log(`  slow=${extLoads.length} shortLived=${shortLived}`);
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
	const verdictSessions = Object.entries(
		report.latency.testRunnerVerdicts ?? {},
	);
	if (verdictSessions.length) {
		console.log("\nTest-runner stale verdicts per session (verdict rows only)");
		for (const [sessionId, summary] of verdictSessions) {
			console.log(
				`  ${sessionId}: ${summary.stale}/${summary.total} stale (${(summary.rate * 100).toFixed(1)}%)`,
			);
		}
	}

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

	const ws = report.latency.workspaceDiagnostics;
	if (ws && (ws.started || ws.completed)) {
		console.log("\nLSP workspace sweeps (lens_diagnostics full)");
		console.log(
			`  started=${ws.started} completed=${ws.completed} incomplete=${ws.incomplete} aborted=${ws.aborted} fileTimeouts=${ws.timedOutFilesTotal} (in ${ws.timedOutSweeps} sweeps)`,
		);
		// #1618: never let a flat count alone read as "budget exhaustion" —
		// print the real per-reason split (or its absence, which itself means
		// every line here predates the tally).
		const reasons = Object.entries(ws.unconfirmedByReason ?? {});
		if (reasons.length) {
			console.log(
				`  by reason: ${reasons.map(([reason, count]) => `${reason}=${count}`).join(", ")}`,
			);
		}
	}
	const wl = report.worklog;
	if (wl && (wl.byModel.length || wl.byRuleModel.length)) {
		console.log("\nWorklog per-model rollup (#1448)");
		console.log(
			`  by model: ${wl.byModel.map((x) => `${x.key}=${x.count}`).join(", ")}`,
		);
		if (wl.byProvider.length)
			console.log(
				`  by provider: ${wl.byProvider.map((x) => `${x.key}=${x.count}`).join(", ")}`,
			);
		console.log("  rule × model (auto-fixed vs agent-required):");
		for (const row of wl.byRuleModel.slice(0, limit))
			console.log(
				`    ${String(row.total).padStart(5)}  ${row.rule} [${row.model || "(unknown)"}]  autoFixed=${row.autoFixed} (${(row.autoFixedRate * 100).toFixed(0)}%)`,
			);
	}

	const timeouts = Object.entries(report.latency.phaseTimeouts ?? {});
	if (timeouts.length) {
		console.log("\nPhase timeouts");
		for (const [k, v] of timeouts)
			console.log(`  ${String(v).padStart(5)}  ${k}`);
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
