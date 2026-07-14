import * as path from "node:path";
import {
	appendActionableWarningsHistory,
	buildActionableWarningsReport,
	formatActionableWarningsAdvisory,
	writeActionableWarningsReport,
} from "./actionable-warnings.js";
import { logActionableWarningsEvent } from "./actionable-warnings-logger.js";
import {
	appendCodeQualityWarningsHistory,
	buildCodeQualityWarningsReport,
	formatCodeQualityWarningsAdvisory,
	writeCodeQualityWarningsReport,
} from "./code-quality-warnings.js";
import type { CacheManager } from "./cache-manager.js";
import type { CascadeSkipReason } from "./cascade-types.js";
import { logCascade } from "./cascade-logger.js";
import { normalizeMapKey } from "./path-utils.js";
import type { DependencyChecker } from "./dependency-checker.js";
import {
	resolveRunnerPath,
	toRunnerDisplayPath,
} from "./dispatch/runner-context.js";
import { getKnipIgnorePatterns } from "./file-utils.js";
import type { GitleaksResult } from "./gitleaks-client.js";
import type { GovulncheckResult } from "./govulncheck-client.js";
import type { TrivyResult } from "./trivy-client.js";
import {
	dedupeSecretFindings,
	fromAstGrepWarnings,
	fromGitleaks,
	fromTrivySecrets,
	isSecretWarning,
	secretLocationKey,
} from "./secret-findings.js";
import type { KnipClient, KnipIssue, KnipResult } from "./knip-client.js";
import type { DeadCodeClient, DeadCodeResult } from "./dead-code-client.js";
import { formatDeadCodeAdvisory } from "./dead-code-client.js";
import {
	PROJECT_DIAGNOSTICS_CACHE_VERSION,
	writeProjectDiagnosticsDeltaReport,
} from "./project-diagnostics/cache.js";
import { knipIssuesToProjectDiagnostics } from "./project-diagnostics/runner-adapters/knip.js";
import type { ProjectDiagnostic } from "./project-diagnostics/types.js";
import { logLatency } from "./latency-logger.js";
import { updateHeartbeat } from "./instance-registry.js";
import { emitLensTurnFindings } from "./lens-events.js";
import { RUNTIME_CONFIG } from "./runtime-config.js";
import type { RuntimeCoordinator } from "./runtime-coordinator.js";
import type { TestResult, TestRunnerClient } from "./test-runner-client.js";

interface TurnEndDeps {
	ctxCwd?: string;
	getFlag: (name: string) => boolean | string | undefined;
	dbg: (msg: string) => void;
	runtime: RuntimeCoordinator;
	cacheManager: CacheManager;
	knipClient: KnipClient;
	deadCodeClients: DeadCodeClient[];
	depChecker: DependencyChecker;
	testRunnerClient: TestRunnerClient;
	resetLSPService: () => void;
	resetFormatService: () => void;
}

// LSP idle reset scheduling — prevents thrashing by delaying shutdown
let lspIdleResetTimeout: ReturnType<typeof setTimeout> | null = null;

function emitIdleResetReporterWarning(reportErr: unknown): void {
	try {
		process.emitWarning(
			`pi-lens LSP idle reset error reporter failed: ${reportErr}`,
			{ code: "PI_LENS_LSP_IDLE_RESET_REPORTER_FAILED" },
		);
	} catch {
		// Preserve the detached-timer invariant: this path must never crash.
		void reportErr;
	}
}

function reportIdleResetError(
	onError: ((err: unknown) => void) | undefined,
	err: unknown,
): void {
	try {
		onError?.(err);
	} catch (reportErr) {
		emitIdleResetReporterWarning(reportErr);
	}
}

function scheduleLSPIdleReset(
	resetFn: () => void,
	delayMs: number,
	options: {
		isCurrentSession?: () => boolean;
		onError?: (err: unknown) => void;
	} = {},
): void {
	// Clear any pending reset to avoid multiple timers
	if (lspIdleResetTimeout) {
		clearTimeout(lspIdleResetTimeout);
	}
	lspIdleResetTimeout = setTimeout(() => {
		lspIdleResetTimeout = null;
		try {
			if (options.isCurrentSession && !options.isCurrentSession()) {
				return;
			}
			resetFn();
		} catch (err) {
			// Detached timers run outside a pi event boundary. They must never crash
			// the extension process (for example if a host UI object was invalidated
			// by session replacement before the timer fired).
			reportIdleResetError(options.onError, err);
		}
	}, delayMs);
	// unref so this timer does not prevent the process from exiting naturally
	// (critical for subagent / --mode json -p usage where the process should
	// exit after completing its work, not wait 240 seconds for this to fire)
	lspIdleResetTimeout.unref();
}

export function cancelLSPIdleReset(): void {
	if (lspIdleResetTimeout) {
		clearTimeout(lspIdleResetTimeout);
		lspIdleResetTimeout = null;
	}
}

// Bounded wait for the turn's deferred cascade computes (#450) to settle before
// they are merged below. A late compute is carried over to the next turn_end.
function cascadeSettleWaitMs(): number {
	const raw = Number(process.env.PI_LENS_CASCADE_SETTLE_WAIT_MS);
	return Number.isFinite(raw) && raw >= 0 ? raw : 5000;
}

function capTurnEndMessage(content: string): string {
	const maxLines = RUNTIME_CONFIG.turnEnd.maxLines;
	const maxChars = RUNTIME_CONFIG.turnEnd.maxChars;

	let out = content;
	const lines = out.split("\n");
	if (lines.length > maxLines) {
		out = `${lines.slice(0, maxLines).join("\n")}\n... (truncated)`;
	}
	if (out.length > maxChars) {
		out = `${out.slice(0, maxChars)}\n... (truncated)`;
	}

	return out;
}

export async function handleTurnEnd(deps: TurnEndDeps): Promise<void> {
	const {
		ctxCwd,
		getFlag,
		dbg,
		runtime,
		cacheManager,
		knipClient,
		deadCodeClients,
		depChecker,
		testRunnerClient,
		resetLSPService,
		resetFormatService,
	} = deps;

	// #449 slice 1: piggyback the instance-registry heartbeat on this existing
	// per-turn touchpoint rather than adding a new timer/interval. Cheap (reads
	// process.memoryUsage().rss, one read-modify-write of instances.json) and
	// fire-and-forget — the kill-switch check + no-op behavior live inside
	// updateHeartbeat itself, so this call site doesn't need to know about it.
	//
	// #620: intentionally RSS-only here — CPU%/LSP-child sampling (which shells
	// out to `pidusage`, and a full CIM query on Windows for a spawn's process
	// tree) is left to the quiet-window "instance_registry_heartbeat" task
	// (clients/quiet-window.ts's `buildHeartbeatResourcePatch`), which fires on
	// the idle `agent_settled` window rather than every single turn end. Every
	// turn end is a much hotter path than an idle window, and the issue's own
	// guardrail is not to let the measurement itself become a new source of
	// per-turn overhead worth investigating.
	void updateHeartbeat().catch(() => {
		// best-effort observability — never fail turn_end over this
	});

	const cwd = ctxCwd ?? process.cwd();
	let turnState = cacheManager.readTurnState(cwd);

	// Evict turn state written by a previous session — it carries stale file
	// ranges that no longer reflect the current editing context.
	if (
		turnState.sessionId &&
		turnState.sessionId !== runtime.telemetrySessionId
	) {
		dbg(
			`turn_end: evicting stale turn state (session ${turnState.sessionId} ≠ current ${runtime.telemetrySessionId})`,
		);
		cacheManager.clearTurnState(cwd);
		turnState = cacheManager.readTurnState(cwd);
	}

	const files = Object.keys(turnState.files);

	if (files.length === 0) {
		dbg("turn_end: no modified files, scheduling LSP idle reset (240s)");
		if (!getFlag("no-lsp")) {
			const sessionGeneration = runtime.sessionGeneration;
			scheduleLSPIdleReset(resetLSPService, 240_000, {
				isCurrentSession: () => runtime.isCurrentSession(sessionGeneration),
				onError: (err) => dbg(`lsp idle reset failed: ${err}`),
			});
		}
		resetFormatService();
		return;
	}

	// Cancel any pending idle reset since we're actively working
	if (lspIdleResetTimeout) {
		cancelLSPIdleReset();
		dbg("turn_end: cancelled pending LSP idle reset (active editing)");
	}

	dbg(
		`turn_end: ${files.length} file(s) modified, cycles: ${turnState.turnCycles}/${turnState.maxCycles}`,
	);

	if (cacheManager.isMaxCyclesExceeded(cwd)) {
		dbg("turn_end: max cycles exceeded, clearing state and forcing through");
		cacheManager.clearTurnState(cwd);
		runtime.fixedThisTurn.clear();
		resetFormatService();
		return;
	}

	const turnEndStart = Date.now();
	const blockerParts: string[] = [];
	const advisoryParts: string[] = [];
	const projectDiagnosticsDelta: ProjectDiagnostic[] = [];
	const projectDiagnosticsSources = new Set<string>();

	// Re-surface inline blockers from this turn that the agent didn't fix.
	// These were shown inline during write/edit but the agent moved on without resolving them.
	const unresolvedBlockers = runtime.consumeInlineBlockers();
	for (const { filePath: bPath, summary } of unresolvedBlockers) {
		const displayPath = toRunnerDisplayPath(cwd, bPath);
		blockerParts.push(
			`Unresolved from this turn — ${displayPath}:\n${summary}`,
		);
	}

	// Drain the deferred cascade computes kicked off this turn (#450). They ran
	// concurrently off the write hot path; wait a bounded time for them here so
	// their runs are available to the merge below. A compute still in flight at
	// the cap is carried over to the next turn_end (never dropped).
	const cascadeSettleStart = Date.now();
	const { settled, timedOut } = await runtime.settleCascadeRuns(
		cascadeSettleWaitMs(),
	);
	logLatency({
		type: "phase",
		toolName: "turn_end",
		filePath: cwd,
		phase: "cascade_settle_wait",
		durationMs: Date.now() - cascadeSettleStart,
		metadata: { settled, timedOut },
	});

	// Merge accumulated cascade results from all pipeline runs this turn.
	// Two-pass dedup:
	//   1. Primary-level: dedup by primary file (last writer wins).
	//   2. Neighbor-level: each neighbor is claimed by the latest cascade result
	//      that covers it — suppresses stale neighbor state from earlier writes.
	const t0 = Date.now();
	const cascadeRuns = runtime.consumeCascadeRuns();
	const cascadeResults = cascadeRuns.flatMap((r) =>
		r.result ? [r.result] : [],
	);
	if (cascadeResults.length > 0) {
		const seen = new Map<string, (typeof cascadeResults)[number]>();
		for (const result of cascadeResults) {
			seen.set(normalizeMapKey(result.filePath), result);
		}
		// Iterate in reverse so the latest result claims each neighbor first.
		const neighborOwner = new Map<string, string>();
		for (const result of [...seen.values()].reverse()) {
			const pk = normalizeMapKey(result.filePath);
			for (const n of result.neighbors) {
				const nk = normalizeMapKey(n.filePath);
				if (!neighborOwner.has(nk)) neighborOwner.set(nk, pk);
			}
		}
		const parts: string[] = [];
		for (const result of seen.values()) {
			const pk = normalizeMapKey(result.filePath);
			const ownsAny = result.neighbors.some(
				(n) => neighborOwner.get(normalizeMapKey(n.filePath)) === pk,
			);
			if (ownsAny && result.formatted) parts.push(result.formatted);
		}
		// Suggest tests for cascade neighbors (files with diagnostics)
		const neighborFilesWithErrors = cascadeResults
			.flatMap((r) => r.neighbors)
			.filter((n) => n.diagnostics.length > 0)
			.map((n) => n.filePath);
		const uniqueNeighborFiles = [...new Set(neighborFilesWithErrors)];
		if (
			uniqueNeighborFiles.length > 0 &&
			typeof testRunnerClient.suggestTestFiles === "function"
		) {
			const testSuggestions = testRunnerClient.suggestTestFiles(
				uniqueNeighborFiles,
				cwd,
			);
			if (testSuggestions.length > 0) {
				const testLines = testSuggestions
					.slice(0, 5)
					.map(
						(s) => `  ${toRunnerDisplayPath(cwd, s.testFile)} (${s.runner})`,
					);
				let testSection = `🧪 Likely tests for affected neighbors:\n${testLines.join("\n")}`;
				if (testSuggestions.length > 5) {
					testSection += `\n  ... and ${testSuggestions.length - 5} more`;
				}
				parts.push(testSection);
			}
		}
		if (parts.length > 0) blockerParts.push(parts.join("\n\n"));
		logCascade({
			phase: "cascade_turn_end",
			filePath: files[0] ?? cwd,
			neighborCount: cascadeResults.reduce((s, r) => s + r.neighbors.length, 0),
			diagnosticCount: cascadeResults.reduce(
				(s, r) =>
					s + r.neighbors.reduce((ns, n) => ns + n.diagnostics.length, 0),
				0,
			),
			metadata: {
				fileCount: cascadeResults.length,
				mergedResults: seen.size,
			},
		});
	}
	const cascadeSkipped: Record<CascadeSkipReason, number> = {
		blockers: 0,
		non_code: 0,
		no_neighbors: 0,
		clean: 0,
		error: 0,
	};
	for (const r of cascadeRuns) {
		if (r.skipReason)
			cascadeSkipped[r.skipReason] = (cascadeSkipped[r.skipReason] ?? 0) + 1;
	}
	logLatency({
		type: "phase",
		toolName: "turn_end",
		filePath: cwd,
		phase: "cascade_merge",
		durationMs: Date.now() - t0,
		metadata: {
			runsTotal: cascadeRuns.length,
			resultCount: cascadeResults.length,
			neighborCount: cascadeRuns.reduce((s, r) => s + r.neighborCount, 0),
			diagnosticCount: cascadeRuns.reduce((s, r) => s + r.diagnosticCount, 0),
			skipped: cascadeSkipped,
		},
	});

	const t2 = Date.now();
	let knipMeta: {
		skipped?: boolean;
		success?: boolean;
		totalIssues?: number;
		newIssues?: number;
		blockerIssues?: number;
		reason?: string;
	} = {};
	if (runtime.isStartupScanInFlight("knip")) {
		dbg("turn_end: skipping knip (startup scan still in flight)");
		knipMeta = { skipped: true };
	} else {
		// Let KnipClient resolve/validate a real JS project root before probing or
		// auto-installing knip. Non-JS repos (for example Unity projects) should not
		// run tool checks every turn. Also back off after a timeout/kill so every
		// agent turn does not spend 30s launching another heavyweight knip process.
		const prevKnip = cacheManager.readCache<KnipResult>("knip", cwd);
		const previousFailedHard =
			prevKnip &&
			!prevKnip.data.success &&
			/(timed out|killed|SIGTERM|SIGKILL|SIGABRT)/i.test(prevKnip.data.summary);

		if (previousFailedHard) {
			dbg(
				`turn_end: skipping knip after recent failure: ${prevKnip.data.summary}`,
			);
			knipMeta = { skipped: true, reason: prevKnip.data.summary };
		} else {
			const knipResult = await knipClient.analyze(cwd, getKnipIgnorePatterns());
			cacheManager.writeCache("knip", knipResult, cwd);
			knipMeta = {
				success: knipResult.success,
				totalIssues: knipResult.issues.length,
				newIssues: 0,
				blockerIssues: 0,
				...(!knipResult.success && { reason: knipResult.summary }),
			};

			if (knipResult.success && knipResult.issues.length > 0) {
				const issueKey = (i: KnipIssue) =>
					`${i.type}:${i.file ?? ""}:${i.name}:${i.line ?? 0}:${i.package ?? ""}`;
				const prevKeys = new Set((prevKnip?.data?.issues ?? []).map(issueKey));
				const modifiedSet = new Set(
					files.map((f) => resolveRunnerPath(cwd, f)),
				);

				const newIssues = knipResult.issues.filter((issue) => {
					if (prevKeys.has(issueKey(issue))) return false;
					if (!issue.file) return false;
					const abs = resolveRunnerPath(cwd, issue.file);
					return modifiedSet.has(abs);
				});
				knipMeta.newIssues = newIssues.length;
				if (newIssues.length > 0) {
					projectDiagnosticsDelta.push(
						...knipIssuesToProjectDiagnostics(cwd, newIssues),
					);
					projectDiagnosticsSources.add("knip");
				}

				const blockerIssues = newIssues.filter(
					(i) => i.type === "unlisted" || i.type === "bin",
				);
				knipMeta.blockerIssues = blockerIssues.length;
				if (blockerIssues.length > 0) {
					let report =
						"🔴 New unresolved imports/deps in modified code (Knip):\n";
					let firstPath: string | null = null;
					for (const issue of blockerIssues.slice(0, 5)) {
						const display = issue.file
							? toRunnerDisplayPath(cwd, issue.file)
							: "(unknown)";
						if (!firstPath && display !== "(unknown)") firstPath = display;
						report += `  ${display}${issue.line ? `:${issue.line}` : ""} — ${issue.type}: ${issue.name}\n`;
					}
					if (firstPath) {
						report += `  First location: ${firstPath}\n`;
					}
					blockerParts.push(report);
				}

				// Turn-end injects only this turn's HIGH-CONFIDENCE, ATTRIBUTABLE
				// delta: symbols in files the agent just edited that became unused
				// (weren't flagged in the previous scan) — low-volume and actionable
				// now. The FULL project-wide dead-code picture is deliberately NOT
				// injected per turn (hundreds of mostly-pre-existing findings would
				// drown the blockers and burn context every turn); it's available
				// on demand via lens_diagnostics. The delta also feeds the session-slop
				// record (`projectDiagnosticsDelta`) above.
				const unusedExportDelta = newIssues.filter(
					(i) => i.type === "export" || i.type === "enumMember",
				);
				if (unusedExportDelta.length > 0) {
					let report =
						"⚠️ Newly unused exports in files you edited — check if callers need updating (Knip):\n";
					for (const issue of unusedExportDelta.slice(0, 5)) {
						const display = issue.file
							? toRunnerDisplayPath(cwd, issue.file)
							: "(unknown)";
						report += `  ${display}${issue.line ? `:${issue.line}` : ""} — ${issue.name}\n`;
					}
					advisoryParts.push(report);
				}
			}
		}
	}
	logLatency({
		type: "phase",
		toolName: "turn_end",
		filePath: cwd,
		phase: "knip",
		durationMs: Date.now() - t2,
		metadata: knipMeta,
	});

	// govulncheck — surface session_start-cached Go CVE findings as advisory.
	// No per-turn re-run in this slice; the cache refreshes at next session_start.
	const govCacheEntry = cacheManager.readCache<GovulncheckResult>(
		"govulncheck",
		cwd,
	);
	if (govCacheEntry?.data?.findings?.length) {
		const findings = govCacheEntry.data.findings.slice(0, 5);
		let report =
			"🛡️ Go CVEs reachable from this code (govulncheck) — upgrade where possible:\n";
		for (const f of findings) {
			const callSite = f.trace.find((t) => t.filename);
			const where = callSite?.filename
				? `${toRunnerDisplayPath(cwd, callSite.filename)}${callSite.line ? `:${callSite.line}` : ""}`
				: (f.module ?? f.packageName ?? "(module)");
			const fix = f.fixedVersion
				? ` — upgrade to ${f.fixedVersion} or later`
				: " — no fix yet, track upstream";
			report += `  ${f.osv} (${where})${fix}\n`;
		}
		if (govCacheEntry.data.findings.length > findings.length) {
			report += `  … and ${govCacheEntry.data.findings.length - findings.length} more\n`;
		}
		advisoryParts.push(report);
	}

	const trivyCacheEntry = cacheManager.readCache<TrivyResult>("trivy", cwd);

	// Secrets — UNIFIED surfacing (#131 Mode 3). gitleaks, trivy secret, and the
	// ast-grep hardcoded-secret rules can each flag the SAME line with different
	// rule ids, which the rule-keyed diagnostic dedup can't collapse. Collapse by
	// location so a committed/hardcoded secret is reported ONCE (with combined
	// provenance) — a blocker, since credentials need rotation before merge.
	const gitleaksData = cacheManager.readCache<GitleaksResult>(
		"gitleaks",
		cwd,
	)?.data;
	const astSecretWarnings = runtime
		.peekActionableWarnings()
		.filter(isSecretWarning);
	const sessionSecrets = dedupeSecretFindings([
		...fromGitleaks(gitleaksData?.findings ?? []),
		...fromTrivySecrets(trivyCacheEntry?.data?.secrets ?? []),
	]);
	// Locations already surfaced as session-scan secret blockers — used to enrich
	// provenance where ast-grep agrees and to suppress the duplicate ast-grep copy
	// from the actionable-warnings advisory below.
	const secretBlockedLocations = new Set(
		sessionSecrets.map((f) => secretLocationKey(f.file, f.line)),
	);
	if (sessionSecrets.length) {
		// Fold in ast-grep provenance ONLY where it coincides with a session
		// secret — don't promote ast-grep-only findings out of their advisory tier.
		const enriched = dedupeSecretFindings([
			...sessionSecrets,
			...fromAstGrepWarnings(astSecretWarnings).filter((a) =>
				secretBlockedLocations.has(secretLocationKey(a.file, a.line)),
			),
		]);
		const shown = enriched.slice(0, 5);
		let report =
			"🔴 STOP — hardcoded secrets detected. Rotate the credentials and remove them from source:\n";
		for (const f of shown) {
			const where = `${toRunnerDisplayPath(cwd, f.file)}:${f.line}`;
			report += `  ${where} — ${f.rule} [${f.sources.join(" + ")}]${f.description ? `: ${f.description}` : ""}\n`;
		}
		if (enriched.length > shown.length) {
			report += `  … and ${enriched.length - shown.length} more\n`;
		}
		blockerParts.push(report);
	}

	// trivy — surface session_start-cached dependency CVEs (#131, Phase 1).
	// CRITICAL is a blocker (a known-exploitable CVE in a shipped dep is real
	// production risk); HIGH/MEDIUM/LOW are advisory. The agent gets the upgrade
	// target as a hint and decides — we never auto-edit lockfiles.
	if (trivyCacheEntry?.data?.findings?.length) {
		const all = trivyCacheEntry.data.findings;
		const critical = all.filter((f) => f.severity === "CRITICAL");
		const advisory = all.filter((f) => f.severity !== "CRITICAL");
		const fmt = (f: TrivyResult["findings"][number]): string => {
			const pkg = f.installedVersion
				? `${f.pkgName}@${f.installedVersion}`
				: f.pkgName;
			const fix = f.fixedVersion
				? ` — upgrade to ${f.fixedVersion} or later`
				: " — no fix yet, track upstream";
			return `  ${f.vulnerabilityId} (${pkg})${fix}\n`;
		};
		if (critical.length) {
			const shown = critical.slice(0, 5);
			let report =
				"🔴 STOP — CRITICAL dependency CVEs (trivy). Upgrade before shipping:\n";
			for (const f of shown) report += fmt(f);
			if (critical.length > shown.length) {
				report += `  … and ${critical.length - shown.length} more\n`;
			}
			blockerParts.push(report);
		}
		if (advisory.length) {
			const shown = advisory.slice(0, 5);
			let report = "🛡️ Dependency CVEs (trivy) — upgrade where possible:\n";
			for (const f of shown) report += fmt(f);
			if (advisory.length > shown.length) {
				report += `  … and ${advisory.length - shown.length} more\n`;
			}
			advisoryParts.push(report);
		}
	}

	// trivy — dependency license risk (#131 Mode 4). Advisory only: a copyleft /
	// restricted license in a proprietary tree is a compliance signal, not a
	// build break. Surfaced from the same cached `trivy fs` pass.
	const licenses = trivyCacheEntry?.data?.licenses ?? [];
	if (licenses.length) {
		const shown = licenses.slice(0, 5);
		let report =
			"📜 Dependency license risk (trivy) — review for compliance:\n";
		for (const l of shown) {
			const cat = l.category ? `, ${l.category}` : "";
			report += `  ${l.pkgName} — ${l.license} (${l.severity}${cat})\n`;
		}
		if (licenses.length > shown.length) {
			report += `  … and ${licenses.length - shown.length} more\n`;
		}
		advisoryParts.push(report);
	}

	const t3 = Date.now();
	if (await depChecker.ensureAvailable()) {
		const madgeFiles = cacheManager.getFilesForMadge(cwd);
		if (madgeFiles.length > 0) {
			dbg(
				`turn_end: madge checking ${madgeFiles.length} file(s) for circular deps`,
			);
			for (const file of madgeFiles) {
				const absPath = path.resolve(cwd, file);
				const depResult = await depChecker.checkFile(absPath, cwd);
				if (depResult.localSkips && depResult.localSkips > 0) {
					// Not silent: a skipped LOCAL import means madge couldn't resolve
					// it into the graph, so a cycle through it would be missed.
					dbg(
						`turn_end: madge skipped ${depResult.localSkips} local file(s) resolving ${file} — possible silent cycle-miss`,
					);
				}
				if (depResult.hasCircular && depResult.circular.length > 0) {
					// Whole-project circular deps are surfaced in lens_diagnostics via the
					// session-start `madge` cache + extractor; this per-file turn-end pass
					// only logs (blockers-only mode suppresses circular-dep notes).
					dbg(
						`turn_end: circular dependency note for ${file} (suppressed in blockers-only mode)`,
					);
				}
			}
		}
	}

	logLatency({
		type: "phase",
		toolName: "turn_end",
		filePath: cwd,
		phase: "madge",
		durationMs: Date.now() - t3,
	});

	// --- Test runner: fire once per turn after all edits are done ---
	// Runs for each unique test target across modified files; results appear
	// in the next turn's context injection alongside jscpd/madge findings.
	if (!getFlag("no-tests") && files.length > 0) {
		const seen = new Set<string>();
		const targets: NonNullable<
			ReturnType<TestRunnerClient["getTestRunTarget"]>
		>[] = [];

		// #628: also target the test companions of this turn's cascade neighbors
		// (files that import an edited file) — a neighbor's own tests can break
		// even though the neighbor's source wasn't touched. Reuses `cascadeResults`,
		// already computed above (from the same #450 deferred-cascade drain) for the
		// LSP cascade-diagnostics merge — no second reverse-dependency walk, and the
		// neighbor set inherits whatever budget the cascade compute already applied
		// (CASCADE_NEIGHBOUR_BUDGET), so this can't turn into unbounded per-edit work.
		const candidates: Array<{ display: string; abs: string; isNeighbor: boolean }> =
			[];
		const seenCandidateKeys = new Set<string>();
		for (const file of files) {
			const abs = resolveRunnerPath(cwd, file);
			const key = normalizeMapKey(abs);
			if (seenCandidateKeys.has(key)) continue;
			seenCandidateKeys.add(key);
			candidates.push({ display: file, abs, isNeighbor: false });
		}
		for (const result of cascadeResults) {
			for (const neighbor of result.neighbors) {
				const abs = path.isAbsolute(neighbor.filePath)
					? neighbor.filePath
					: resolveRunnerPath(cwd, neighbor.filePath);
				const key = normalizeMapKey(abs);
				if (seenCandidateKeys.has(key)) continue;
				seenCandidateKeys.add(key);
				candidates.push({ display: neighbor.filePath, abs, isNeighbor: true });
			}
		}

		for (const { display, abs, isNeighbor } of candidates) {
			const target = testRunnerClient.getTestRunTarget(abs, cwd);
			if (target && !seen.has(target.testFile)) {
				seen.add(target.testFile);
				targets.push(target);
				dbg(
					`turn_end: ${display} → test ${target.runner} ${path.relative(cwd, target.testFile)} (${target.strategy}${isNeighbor ? ", cascade-neighbor" : ""})`,
				);
			} else if (!target) {
				dbg(
					`turn_end: ${display} → no test file found${isNeighbor ? " (cascade-neighbor)" : ""}`,
				);
			}
		}
		if (targets.length > 0) {
			dbg(
				`turn_end: firing ${targets.length} test target(s) async (non-blocking)`,
			);
			const firedAtTurn = runtime.turnIndex;
			Promise.allSettled(
				targets.map((t) =>
					testRunnerClient.runTestFileAsync(
						t.testFile,
						cwd,
						t.runner,
						t.config,
					),
				),
			)
				.then((results) => {
					// #628: the turn advancing while tests ran no longer means the
					// results are thrown away — a late result is still real
					// information about what's currently broken. It's tagged `stale`
					// so a downstream consumer can distinguish it from a result that
					// arrived in time, but it's cached either way.
					const stale = runtime.turnIndex !== firedAtTurn;
					const failures: string[] = [];
					const resultValues: TestResult[] = [];
					for (const r of results) {
						if (r.status === "rejected") {
							dbg(`turn_end: test run rejected — ${r.reason}`);
							continue;
						}
						resultValues.push(r.value);
						const { file, runner, passed, failed, duration, error } = r.value;
						const shortFile = path.basename(file);
						const summary =
							error && passed === 0 && failed === 0
								? `error: ${error}`
								: `${failed > 0 ? "FAIL" : "PASS"} ${passed}p/${failed}f (${duration}ms)`;
						dbg(
							`turn_end: ${stale ? "[stale] " : ""}test ${runner} ${shortFile} → ${summary}`,
						);
						if (failed > 0) {
							const formatted = testRunnerClient.formatResult(r.value);
							if (formatted) failures.push(formatted);
						}
					}
					if (failures.length > 0) {
						const content = stale
							? `[from a prior turn — the edit that triggered this run had already been superseded by the time results came back]\n\n${failures.join("\n\n")}`
							: failures.join("\n\n");
						cacheManager.writeCache(
							"test-runner-findings",
							{ content, stale, results: resultValues },
							cwd,
						);
						dbg(
							`turn_end: ${failures.length} test failure(s) cached for next context injection${stale ? " (stale — turn advanced while tests ran)" : ""}`,
						);
					} else if (results.length > 0) {
						dbg(
							`turn_end: all tests passed${stale ? " (stale — turn advanced while tests ran)" : ""}`,
						);
					}
				})
				.catch(() => {});
		}
	}

	if (runtime.errorDebtBaseline && files.length > 0) {
		dbg("turn_end: marking error debt check for next session");
		cacheManager.writeCache(
			"errorDebt",
			{
				pendingCheck: true,
				baselineTestsPassed: runtime.errorDebtBaseline.testsPassed,
			},
			cwd,
		);
	}

	// Session summaries are intentionally suppressed at turn_end to avoid
	// distracting the agent with non-blocking telemetry.

	if (projectDiagnosticsDelta.length > 0) {
		writeProjectDiagnosticsDeltaReport(cwd, {
			version: PROJECT_DIAGNOSTICS_CACHE_VERSION,
			cwd,
			generatedAt: new Date().toISOString(),
			sessionId: runtime.telemetrySessionId,
			turnIndex: runtime.turnIndex,
			projectSeqStart: runtime.turnStartProjectSeq,
			projectSeqEnd: runtime.projectSeq,
			diagnostics: projectDiagnosticsDelta,
			sources: [...projectDiagnosticsSources].sort((a, b) =>
				a.localeCompare(b),
			),
		});
	}

	const t4 = Date.now();
	const modifiedRangesByFile = new Map(
		Object.entries(turnState.files).map(([file, state]) => [
			normalizeMapKey(resolveRunnerPath(cwd, file)),
			state.modifiedRanges,
		]),
	);
	const getFileSeq = (runtime as Partial<RuntimeCoordinator>).getFileSeq;
	const fileSeqByPath = new Map<string, number>();
	if (getFileSeq) {
		for (const file of files) {
			const filePath = normalizeMapKey(resolveRunnerPath(cwd, file));
			fileSeqByPath.set(filePath, getFileSeq.call(runtime, filePath));
		}
	}
	if (getFlag("lens-actionable-warnings")) {
		try {
			const report = await buildActionableWarningsReport({
				cwd,
				sessionId: runtime.telemetrySessionId,
				turnIndex: runtime.turnIndex,
				files,
				modifiedRangesByFile,
				// Suppress the ast-grep secret advisory at any location already
				// surfaced in the unified secrets blocker above (#131 Mode 3) — the
				// secret is reported once, not twice.
				dispatchWarnings: runtime
					.peekActionableWarnings()
					.filter(
						(w) =>
							!(
								isSecretWarning(w) &&
								typeof w.line === "number" &&
								secretBlockedLocations.has(
									secretLocationKey(w.filePath, w.line),
								)
							),
					),
				includeLspCodeActions: !!getFlag("lens-actionable-warning-actions"),
				projectSeqStart: runtime.turnStartProjectSeq,
				projectSeqEnd: runtime.projectSeq,
				fileSeqByPath,
				deltaOnly: !getFlag("lens-actionable-warning-all"),
				dbg,
			});
			writeActionableWarningsReport(cacheManager, cwd, report);
			appendActionableWarningsHistory(cwd, report);
			const advisory = formatActionableWarningsAdvisory(report);
			if (advisory) advisoryParts.push(advisory);
			logActionableWarningsEvent({
				event: advisory ? "advisory_injected" : "advisory_skipped",
				sessionId: runtime.telemetrySessionId,
				metadata: {
					turnIndex: runtime.turnIndex,
					unsuppressed: report.summary.unsuppressed,
				},
			});
			logLatency({
				type: "phase",
				toolName: "turn_end",
				filePath: cwd,
				phase: "actionable_warnings_report",
				durationMs: Date.now() - t4,
				metadata: report.summary,
			});
		} catch (err) {
			dbg(`turn_end: actionable warning report failed: ${err}`);
			logLatency({
				type: "phase",
				toolName: "turn_end",
				filePath: cwd,
				phase: "actionable_warnings_report",
				durationMs: Date.now() - t4,
				metadata: {
					failed: true,
					error: err instanceof Error ? err.message : String(err),
				},
			});
		}
	}

	// Call-graph impact analysis — surface WillBreak/MayBreak callers for modified symbols
	if (runtime.callGraph && files.length > 0) {
		try {
			const { impact, formatImpact } = await import("./call-graph.js");
			const impactLines: string[] = [];
			for (const filePath of files.slice(0, 5)) {
				// Find callee keys for this file in the call graph
				const fileCallerKeys = [...runtime.callGraph.callers.keys()].filter(
					(k) => k.startsWith(`${filePath}:`),
				);
				for (const calleeKey of fileCallerKeys.slice(0, 3)) {
					const results = impact(runtime.callGraph, calleeKey);
					if (results.length > 0) {
						const summary = formatImpact(results, cwd);
						if (summary)
							impactLines.push(`  ${calleeKey.split(":").pop()}: ${summary}`);
					}
				}
			}
			if (impactLines.length > 0) {
				advisoryParts.push(
					`📊 Call-graph impact (changed symbols have callers):\n${impactLines.join("\n")}`,
				);
			}
		} catch {
			// Non-fatal — call graph is best-effort
		}
	}

	const t5 = Date.now();
	try {
		const qualityReport = buildCodeQualityWarningsReport({
			cwd,
			sessionId: runtime.telemetrySessionId,
			turnIndex: runtime.turnIndex,
			warnings: runtime.peekCodeQualityWarnings(),
			modifiedRangesByFile,
			projectSeqStart: runtime.turnStartProjectSeq,
			projectSeqEnd: runtime.projectSeq,
			fileSeqByPath,
		});
		writeCodeQualityWarningsReport(cacheManager, cwd, qualityReport);
		appendCodeQualityWarningsHistory(cwd, qualityReport);
		const advisory = formatCodeQualityWarningsAdvisory(qualityReport);
		if (advisory) advisoryParts.push(advisory);
		logLatency({
			type: "phase",
			toolName: "turn_end",
			filePath: cwd,
			phase: "code_quality_warnings_report",
			durationMs: Date.now() - t5,
			metadata: qualityReport.summary,
		});
	} catch (err) {
		dbg(`turn_end: code quality warning report failed: ${err}`);
		logLatency({
			type: "phase",
			toolName: "turn_end",
			filePath: cwd,
			phase: "code_quality_warnings_report",
			durationMs: Date.now() - t5,
			metadata: {
				failed: true,
				error: err instanceof Error ? err.message : String(err),
			},
		});
	}

	// Cross-file dead-code (#127): surface the cached session_start scan as an
	// advisory (project-wide unused symbols are slow to compute, so we read the
	// cache rather than re-scanning every turn — the analogue of knip's cache
	// for non-JS/TS languages). Merged across languages for polyglot repos.
	try {
		const deadCodeResults: DeadCodeResult[] = [];
		for (const client of deadCodeClients) {
			if (!client.detect(cwd)) continue;
			const cached = cacheManager.readCache<DeadCodeResult>(
				`dead-code-${client.id}`,
				cwd,
			);
			if (cached?.data) deadCodeResults.push(cached.data);
		}
		const advisory = formatDeadCodeAdvisory(deadCodeResults);
		if (advisory) advisoryParts.push(advisory);
	} catch (err) {
		dbg(`turn_end: dead-code advisory failed: ${err}`);
	}

	cacheManager.incrementTurnCycle(cwd);

	const labeledAdvisoryParts = advisoryParts.map(
		(p) => `ℹ️ Advisory — no action required this turn:\n${p}`,
	);
	const findingParts = [...blockerParts, ...labeledAdvisoryParts];
	if (findingParts.length > 0) {
		dbg(
			`turn_end: ${blockerParts.length} blocker section(s), ${advisoryParts.length} advisory section(s) found, persisting for next context`,
		);
		const content = capTurnEndMessage(findingParts.join("\n\n"));
		const signature = `${files
			.slice()
			.sort((a, b) => a.localeCompare(b))
			.join("|")}::${content}`;
		const last = cacheManager.readCache<{
			signature: string;
			sessionId: string;
		}>("turn-end-findings-last", cwd);
		if (
			last?.data?.signature === signature &&
			last?.data?.sessionId === runtime.telemetrySessionId
		) {
			dbg(
				"turn_end: duplicate findings detected (same session), suppressing re-prompt",
			);
			cacheManager.clearTurnState(cwd);
			runtime.fixedThisTurn.clear();
			resetFormatService();
			return;
		}
		cacheManager.writeCache("turn-end-findings", { content }, cwd);
		cacheManager.writeCache(
			"turn-end-findings-last",
			{
				signature,
				sessionId: runtime.telemetrySessionId,
				projectSeqStart: runtime.turnStartProjectSeq,
				projectSeqEnd: runtime.projectSeq,
			},
			cwd,
		);
		emitLensTurnFindings({
			cwd,
			filePaths: files.map((file) => resolveRunnerPath(cwd, file)),
			sessionId: runtime.telemetrySessionId,
			turnIndex: runtime.turnIndex,
			blockerSections: blockerParts.length,
			advisorySections: advisoryParts.length,
			content,
		});
	}
	if (blockerParts.length === 0) {
		cacheManager.clearTurnState(cwd);
	}

	runtime.fixedThisTurn.clear();
	runtime.clearActionableWarnings();
	runtime.clearCodeQualityWarnings();
	logLatency({
		type: "tool_result",
		toolName: "turn_end",
		filePath: cwd,
		durationMs: Date.now() - turnEndStart,
		result: blockerParts.length > 0 ? "blockers_found" : "clean",
		metadata: {
			fileCount: files.length,
			blockerSections: blockerParts.length,
			advisorySections: advisoryParts.length,
		},
	});
	resetFormatService();
}
