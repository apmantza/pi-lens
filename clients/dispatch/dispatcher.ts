/**
 * Declarative Tool Dispatcher for pi-lens
 *
 * Redesigned to handle the full complexity of pi-lens's tool_result handler:
 * - Multiple tools with different semantics (blocking, warning, silent)
 * - Delta mode (baseline tracking)
 * - Autofix handling
 * - Output aggregation and formatting
 *
 * Key abstractions:
 * - RunnerDefinition: A tool that can be run
 * - Diagnostic: Structured issue representation
 * - OutputSemantic: How to display (blocking, warning, silent, etc.)
 * - BaselineStore: Track pre-existing issues for delta mode
 */

import { logExtension } from "../extension-log.js";
import * as fs from "node:fs";
import * as path from "node:path";
import type { FileKind } from "../file-kinds.js";
import { recordRunner } from "../widget-state.js";
import {
	incrementDegradationCount,
	recordDegradationOnce,
} from "../degradation-ledger.js";
import { detectFileKind } from "../file-kinds.js";
import { detectFileRole } from "../file-role.js";
import {
	classifyGeneratedOrArtifactDetailed,
	type GeneratedArtifactEvidence,
} from "../generated-artifacts.js";
import { isTestFile } from "../file-utils.js";
import { getPrimaryDispatchGroup } from "../language-policy.js";
import { resolveLanguageRootForFile } from "../language-profile.js";
import { logLatency, phaseFinished, phaseStarted } from "../latency-logger.js";
import { isSpawnableCommand } from "../installer/index.js";
import {
	isAbsoluteFilePath,
	normalizeEphemeralMapKey,
	normalizeMapKey,
} from "../path-utils.js";
import { loadPiLensProjectConfig } from "../project-lens-config.js";
import { RUNTIME_CONFIG, getRunnerTimeoutFloorMs } from "../runtime-config.js";
import { safeSpawnAsync } from "../safe-spawn.js";
import { classifyDiagnostic } from "./diagnostic-taxonomy.js";
import {
	classifyProbeFailure,
	logAvailabilityDecision,
	startHostStallSampler,
	transientRetryDelayMs,
} from "./runners/utils/availability-policy.js";
import {
	recordAvailabilityProbeOverrun,
	getDispatchAvailabilityGeneration,
} from "./runners/utils/runner-helpers.js";
import { createAvailabilityProbeFlight } from "../availability-probe-flight.js";
import type { FactStore } from "./fact-store.js";
import { applyDispositions } from "../diagnostic-dispositions.js";
import { applyInlineSuppressions } from "./inline-suppressions.js";
import { getToolPlan } from "./plan.js";
import { resolveRunnerPath } from "./runner-context.js";
import {
	classifyObservedRunner,
	COLLECT_LATER_THRESHOLD_MS,
	observeRunnerLatency,
} from "./collect-later-tier.js";
import { deferRunnerFindings } from "./pending-runner-findings.js";

import { applyRulePolicy, rulePolicyMapFromConfig } from "./rule-policy.js";
import { getToolProfile } from "./tool-profile.js";
import { isRunnerSkipReason } from "./types.js";

const dispatcherProbeFlights = createAvailabilityProbeFlight<
	Awaited<ReturnType<typeof safeSpawnAsync>>
>({ generation: () => getDispatchAvailabilityGeneration() });
import type {
	Diagnostic,
	DispatchContext,
	DispatchResult,
	OutputSemantic,
	PiAgentAPI,
	RunnerDefinition,
	RunnerGroup,
	RunnerRegistry as RunnerRegistryContract,
	RunnerResult,
	RunnerSkipReason,
} from "./types.js";
import { formatDiagnostics } from "./utils/format-utils.js";

// --- Runner Registry ---

export class RunnerRegistry implements RunnerRegistryContract {
	private readonly runners = new Map<string, RunnerDefinition>();

	register(runner: RunnerDefinition): void {
		if (this.runners.has(runner.id)) return;
		this.runners.set(runner.id, runner);
	}

	get(id: string): RunnerDefinition | undefined {
		return this.runners.get(id);
	}

	getForKind(kind: FileKind, filePath?: string): RunnerDefinition[] {
		const matching: RunnerDefinition[] = [];
		const isTest = filePath ? isTestFile(filePath) : false;

		for (const runner of this.runners.values()) {
			if (isTest && runner.skipTestFiles) continue;
			if (runnerAppliesToKind(runner, kind)) {
				matching.push(runner);
			}
		}

		return matching.sort((a, b) => a.priority - b.priority);
	}

	list(): RunnerDefinition[] {
		return Array.from(this.runners.values());
	}

	clear(): void {
		this.runners.clear();
	}
}

function runnerAppliesToKind(
	runner: RunnerDefinition,
	kind: FileKind | undefined,
): boolean {
	return (
		runner.appliesTo.length === 0 ||
		(kind !== undefined && runner.appliesTo.includes(kind))
	);
}

// --- Tool Availability Cache ---

/**
 * Normalize a command name to a FactStore session key.
 * Strips .cmd/.exe suffixes (case-insensitive) and lowercases,
 * then prefixes with "session.toolCache.".
 */
export function normalizeCacheKey(cmd: string): string {
	const normalized = cmd.replace(/\.(cmd|exe)$/i, "").toLowerCase();
	return `session.toolCache.${normalized}`;
}

/** Probe budget for the generic `hasTool` availability check, ms. */
const TOOL_PROBE_TIMEOUT_MS = 5000;

/**
 * Session fact holding the epoch ms after which a TRANSIENT verdict for a
 * command may be re-probed. Kept beside the boolean fact so both share the
 * session's lifetime — no second global to reset (#1476).
 */
function transientRetryKey(command: string): string {
	return `${normalizeCacheKey(command)}.retryAt`;
}

/**
 * Consecutive transient verdicts for a command, so the cooldown ESCALATES the
 * way the policy documents (30 s, 60 s, 120 s … capped at 5 min) instead of
 * sitting flat at 30 s.
 *
 * This is the highest-traffic availability consumer in the product. A flat
 * cooldown here means a permanently sick host is re-probed every 30 s per
 * command for the whole session — ten times the storm the policy claims to
 * bound, and the one place the bound matters most. `createAvailabilityChecker`
 * tracks the same counter; this keeps the two seams telling one story.
 */
function transientAttemptsKey(command: string): string {
	return `${normalizeCacheKey(command)}.transientAttempts`;
}

/**
 * Is `command` usable right now? Cached per session.
 *
 * Latch policy (#1467/#1476): a `false` from a genuine absence is durable and
 * is remembered for the session. A `false` from a TIMED-OUT probe is not — this
 * is the highest-traffic availability consumer in the codebase, and caching a
 * host stall here silently disabled a healthy tool for every later dispatch in
 * the session. A transient verdict instead holds only for a bounded cooldown,
 * which also stops a sick host from being re-probed on every dispatch.
 */
export async function checkToolAvailability(
	command: string,
	facts: FactStore,
): Promise<boolean> {
	const key = normalizeCacheKey(command);
	const cached = facts.getSessionFact<boolean>(key);
	if (cached !== undefined) {
		return cached;
	}
	const retryAt = facts.getSessionFact<number>(transientRetryKey(command));
	if (retryAt !== undefined && Date.now() < retryAt) return false;
	// A command that isn't even on disk can't pass a --version probe; the ~μs
	// stat/PATH walk saves a guaranteed-to-fail spawn round-trip per cold tool.
	if (!(await isSpawnableCommand(command))) {
		facts.setSessionFact(key, false);
		return false;
	}
	try {
		// The budget is enforced by a HOST-side timer, so measure the loop stall
		// that overlapped the window and let the shared classifier read it.
		const sampler = startHostStallSampler();
		const startedAt = Date.now();
		let result: Awaited<ReturnType<typeof safeSpawnAsync>>;
		let hostStallMs: number;
		let probeJoined = false;
		try {
			const shared = dispatcherProbeFlights.run(`dispatcher:${key}`, () =>
				safeSpawnAsync(command, ["--version"], {
					timeout: TOOL_PROBE_TIMEOUT_MS,
				}),
			);
			probeJoined = shared.joined;
			result = await shared.promise;
		} finally {
			hostStallMs = sampler.stop();
		}
		const elapsedMs = Date.now() - startedAt;
		recordAvailabilityProbeOverrun(
			command,
			key,
			elapsedMs,
			TOOL_PROBE_TIMEOUT_MS,
			result.failure,
		);
		if (result.status === 0) {
			facts.setSessionFact(key, true);
			// The tool answered: retire the cooldown facts rather than leaving a
			// stale retry deadline behind a `true`.
			facts.setSessionFact(transientRetryKey(command), 0);
			facts.setSessionFact(transientAttemptsKey(command), 0);
			logAvailabilityDecision({
				tool: command,
				verdict: "available",
				outcome: "success",
				cause: "ok",
				elapsedMs,
				latched: true,
				classifiedBy: probeJoined ? "joined" : "probe",
				hostStallMs,
				budgetMs: TOOL_PROBE_TIMEOUT_MS,
			});
			return true;
		}
		// `missing` for anything unclassified preserves the pre-#1476 meaning of
		// a non-zero exit: durable, cached for the session.
		const { outcome, cause, evidence } = classifyProbeFailure(result, {
			hostStallMs,
			unclassifiedFailureOutcome: "missing",
		});
		let retryAfterMs: number | undefined;
		if (outcome === "transient") {
			const attempts =
				(facts.getSessionFact<number>(transientAttemptsKey(command)) ?? 0) + 1;
			facts.setSessionFact(transientAttemptsKey(command), attempts);
			retryAfterMs = transientRetryDelayMs(attempts, cause);
			facts.setSessionFact(
				transientRetryKey(command),
				Date.now() + retryAfterMs,
			);
		} else {
			facts.setSessionFact(key, false);
			facts.setSessionFact(transientAttemptsKey(command), 0);
		}
		logAvailabilityDecision({
			tool: command,
			verdict: "unavailable",
			outcome,
			cause,
			elapsedMs,
			latched: outcome !== "transient",
			hostStallMs,
			...(retryAfterMs !== undefined && { retryAfterMs }),
			budgetMs: TOOL_PROBE_TIMEOUT_MS,
			classifiedBy: probeJoined ? "joined" : "probe",
			evidence,
		});
		return false;
	} catch {
		facts.setSessionFact(key, false);
		return false;
	}
}

// --- Dispatch Context Factory ---

function readFilePrefix(filePath: string, maxBytes = 4096): string | undefined {
	let fd: number | undefined;
	try {
		fd = fs.openSync(filePath, "r");
		const buffer = Buffer.alloc(maxBytes);
		const bytesRead = fs.readSync(fd, buffer, 0, maxBytes, 0);
		return buffer.subarray(0, bytesRead).toString("utf8");
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) {
			try {
				fs.closeSync(fd);
			} catch {
				// ignore close errors
			}
		}
	}
}

export function createDispatchContext(
	filePath: string,
	cwd: string,
	pi: PiAgentAPI,
	facts: FactStore,
	blockingOnly?: boolean,
	modifiedRanges?: import("./types.js").ModifiedRange[],
	/** Authoritative workspace root; `cwd` may be a nested language root. */
	projectRoot?: string,
	/** Ordered per-file pipeline token, when this is a post-write dispatch. */
	writeIndex?: number,
	/** Runtime telemetry identity, when known (#1448) — threaded to the
	 * worklog append; see DispatchContext.telemetryModel's doc. */
	telemetryModel?: string,
	telemetryProvider?: string,
): DispatchContext {
	const absoluteFilePath = resolveRunnerPath(cwd, filePath);
	const normalizedProjectRoot = normalizeMapKey(
		path.resolve(projectRoot ?? cwd),
	);
	const normalizedCwd = normalizeMapKey(
		resolveLanguageRootForFile(absoluteFilePath, cwd),
	);
	const normalizedFilePath = normalizeMapKey(absoluteFilePath);
	const kind = detectFileKind(normalizedFilePath);
	const contentPrefix = readFilePrefix(normalizedFilePath);
	const fileRole = detectFileRole(normalizedFilePath, contentPrefix);
	// Captured once here so the generated short-circuit below can emit a
	// `dispatch_skipped_generated` record carrying the deciding evidence tier
	// and the measured line-shape statistic — without re-reading the file
	// (refs #2346). The content passed is the same 4096-byte prefix already
	// read for role detection, so this classification costs no extra I/O.
	const generatedDetail =
		fileRole === "generated"
			? classifyGeneratedOrArtifactDetailed(normalizedFilePath, {
					content: contentPrefix,
					includeDeclarations: false,
				})
			: undefined;
	const projectConfig = loadPiLensProjectConfig(normalizedCwd);

	return {
		filePath: normalizedFilePath,
		projectRoot: normalizedProjectRoot,
		cwd: normalizedCwd,
		kind,
		fileRole,
		generatedEvidence: generatedDetail?.evidence,
		generatedLineShapeMean: generatedDetail?.lineShapeMean,
		pi,
		autofix: false,
		deltaMode: !pi.getFlag("no-delta"),
		facts,
		projectConfig,
		blockingOnly,
		modifiedRanges,
		writeIndex,
		telemetryModel,
		telemetryProvider,

		async hasTool(command: string): Promise<boolean> {
			return checkToolAvailability(command, facts);
		},

		log(message: string): void {
			// #1333: pi owns the terminal — a runner advisory must never be a raw
			// write. Every DispatchContext.log line lands in extension.log instead.
			logExtension({
				subsystem: "dispatch",
				message,
				metadata: { filePath: normalizedFilePath, kind },
			});
		},
	};
}

// --- Delta Mode Logic ---

/**
 * Filter diagnostics to only show NEW issues (delta mode)
 */
function filterDelta<T extends { id: string }>(
	after: T[],
	before: T[] | undefined,
	keyFn: (d: T) => string,
): { new: T[]; fixed: T[] } {
	const beforeSet = new Set((before ?? []).map(keyFn));
	const afterSet = new Set(after.map(keyFn));

	const fixed = (before ?? []).filter((d) => !afterSet.has(keyFn(d)));
	const newItems = after.filter((d) => !beforeSet.has(keyFn(d)));

	return { new: newItems, fixed };
}

function semanticRank(semantic: OutputSemantic): number {
	if (semantic === "blocking") return 4;
	if (semantic === "warning") return 3;
	if (semantic === "fixed") return 2;
	if (semantic === "silent") return 1;
	return 0;
}

function toolPriority(tool: string, defectClass: string): number {
	return getToolProfile(tool, defectClass).dedupPriority;
}

function dedupeOverlappingDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
	const byKey = new Map<string, Diagnostic>();

	for (const d of diagnostics) {
		const defectClass = d.defectClass ?? classifyDiagnostic(d);
		const line = d.line ?? 1;
		const column = d.column ?? 1;
		const ruleKey = d.rule || d.id || "unknown";
		const key = `${d.filePath}:${line}:${column}:${defectClass}:${ruleKey}`;
		const current = byKey.get(key);
		if (!current) {
			byKey.set(key, { ...d, defectClass });
			continue;
		}

		const currScore =
			semanticRank(current.semantic) * 100 +
			toolPriority(current.tool, defectClass);
		const nextScore =
			semanticRank(d.semantic) * 100 + toolPriority(d.tool, defectClass);
		if (nextScore > currScore) {
			byKey.set(key, { ...d, defectClass });
		}
	}

	return [...byKey.values()];
}

function suppressLintOverlapsWithLsp(diagnostics: Diagnostic[]): Diagnostic[] {
	const lspBySpanClass = new Set<string>();
	const lspByLine = new Set<string>();
	const isLintTool = (tool: string): boolean => {
		return getToolProfile(tool).lintLike;
	};

	for (const d of diagnostics) {
		if (d.tool !== "lsp") continue;
		const line = d.line ?? 1;
		const defectClass = d.defectClass ?? classifyDiagnostic(d);
		lspBySpanClass.add(`${d.filePath}:${line}:${defectClass}`);
		lspByLine.add(`${d.filePath}:${line}`);
	}

	if (lspByLine.size === 0) return diagnostics;

	return diagnostics.filter((d) => {
		if (d.tool === "lsp") return true;
		if (!isLintTool(d.tool)) return true;
		if (d.semantic === "blocking" || d.severity === "error") return true;

		const line = d.line ?? 1;
		const defectClass = d.defectClass ?? classifyDiagnostic(d);
		const key = `${d.filePath}:${line}:${defectClass}`;
		if (lspBySpanClass.has(key)) return false;

		// Conservative fallback for unclassified overlap at same line.
		if (defectClass === "unknown") {
			return !lspByLine.has(`${d.filePath}:${line}`);
		}

		return true;
	});
}

/**
 * Dockerfile overlap dedup (#131 Mode 2): hadolint and `trivy config` both flag
 * a few of the same Dockerfile issues (e.g. `:latest`, running as root) with
 * different rule ids, which the rule-keyed `dedupeOverlappingDiagnostics` can't
 * collapse. Keep hadolint authoritative on the lines it covers and drop the
 * trivy-config finding there — trivy still contributes the security checks
 * hadolint lacks (on other lines), and all Kubernetes findings (no hadolint
 * diagnostics exist for YAML, so none are suppressed). Exported for unit tests.
 */
export function suppressTrivyConfigDockerOverlap(
	diagnostics: Diagnostic[],
): Diagnostic[] {
	const hadolintLines = new Set<string>();
	for (const d of diagnostics) {
		if (d.tool === "hadolint") {
			hadolintLines.add(`${d.filePath}:${d.line ?? 1}`);
		}
	}
	if (hadolintLines.size === 0) return diagnostics;
	return diagnostics.filter(
		(d) =>
			d.tool !== "trivy-config" ||
			!hadolintLines.has(`${d.filePath}:${d.line ?? 1}`),
	);
}

function isUnusedValueDiagnostic(d: Diagnostic): boolean {
	const raw = `${d.id ?? ""} ${d.rule ?? ""} ${d.message ?? ""}`.toLowerCase();
	if (raw.includes("no-unused")) return true;
	if (/\b(6133|6192|6196)\b/.test(raw)) return true;

	const rule = String(d.rule ?? "").toLowerCase();
	if (rule.includes("unused")) return true;

	const message = d.message.toLowerCase();
	return (
		message.includes("is declared but its value is never read") ||
		message.includes("is assigned a value but never used") ||
		message.includes("declared but never used") ||
		message.includes("unused")
	);
}

function promoteDeltaUnusedToBlockers(diagnostics: Diagnostic[]): Diagnostic[] {
	return diagnostics.map((d) => {
		if (!isUnusedValueDiagnostic(d)) return d;
		if (d.semantic === "blocking" || d.severity === "error") return d;
		return {
			...d,
			severity: "error",
			semantic: "blocking",
			fixSuggestion:
				d.fixSuggestion ??
				"Remove the unused declaration or rename with '_' prefix if intentionally unused.",
		};
	});
}

// --- Latency Logger ---

/**
 * Optional per-runner result sink. Fires once for each runner that actually
 * executes (immediately after its `run()` returns), with the exact
 * `RunnerResult` — including `failureKind`/`failureMessage` that the merged
 * `DispatchResult` discards. Runners that are filtered out, `when`-skipped,
 * skipped for being a test file, or not registered do not fire it. Lets the
 * live tool-smoke harness (#209) assert each tool spawned and exited cleanly
 * without duplicating dispatch's selection/gating logic.
 */
export type RunnerResultSink = (runnerId: string, result: RunnerResult) => void;

export interface RunnerLatency {
	runnerId: string;
	startTime: number;
	endTime: number;
	durationMs: number;
	status:
		| "succeeded"
		| "failed"
		| "skipped"
		| "when_skipped"
		| "test_file_skipped"
		| "pending";
	diagnosticCount: number;
	semantic: string;
	skipReason?: RunnerSkipReason;
	unconfirmedServerIds?: readonly string[];
}

export interface DispatchLatencyReport {
	filePath: string;
	fileKind: string | undefined;
	overallStartMs: number;
	overallEndMs: number;
	totalDurationMs: number;
	runners: RunnerLatency[];
	stoppedEarly: boolean;
	totalDiagnostics: number;
	blockers: number;
	warnings: number;
}

function buildCoverageNotice(
	ctx: DispatchContext,
	runnerLatencies: RunnerLatency[],
): Diagnostic | undefined {
	if (!ctx.kind) return undefined;
	const lspEnabled = !ctx.pi.getFlag("no-lsp");
	const primary = getPrimaryDispatchGroup(ctx.kind, lspEnabled);
	if (!primary || primary.runnerIds.length === 0) return undefined;

	const relevant = runnerLatencies.filter((r) =>
		primary.runnerIds.includes(r.runnerId),
	);
	if (relevant.length === 0) return undefined;

	// #1867 catalog shape 4: this is correlation, not classification. The LSP
	// touch already decided which scanner publications were absent for these
	// bytes; the runner and latency assembly only preserve that exact set.
	const unconfirmedServerIds = [
		...new Set(relevant.flatMap((r) => r.unconfirmedServerIds ?? [])),
	];
	if (unconfirmedServerIds.length > 0) {
		// The marker describes this exact silent-scanner set. A scanner can
		// recover while another goes dark on the same file, so the set belongs
		// in the session dedupe identity rather than only kind and path.
		// #2016: these are SCANNER IDS, not filesystem paths. `normalizeMapKey`
		// would realpath each one; on Windows that fails, falls through to
		// `resolveNonExisting`, and resolves the id against the CURRENT process
		// cwd, so the dedupe key differed by platform and by cwd (the #2219
		// non-path-sentinel class). The cheap syntactic fold is what this
		// session-scoped dedupe key actually needs.
		const silentScannerSet = [...new Set(unconfirmedServerIds)]
			.map(normalizeEphemeralMapKey)
			// Code-unit comparator: the sorted set is a dedupe KEY, so ordering
			// must be deterministic across locales — localeCompare is not.
			.sort((a, b) => Number(a > b) - Number(a < b))
			.join(",");
		const onceKey = `${ctx.kind}:${ctx.filePath}:${silentScannerSet}`;
		if (coverageNoticeSeen.has(onceKey)) return undefined;
		coverageNoticeSeen.add(onceKey);
		const shown = unconfirmedServerIds.slice(0, 4);
		const remainder = unconfirmedServerIds.length - shown.length;
		const marker = `${shown.join(", ")}${remainder > 0 ? ` +${remainder}` : ""}`;
		return {
			id: `coverage-partial:${ctx.kind}:${path.basename(ctx.filePath)}`,
			message: `coverage: ${marker} silent — diagnostics are incomplete (not a clean result).`,
			filePath: ctx.filePath,
			severity: "warning",
			semantic: "warning",
			tool: "pi-lens",
		};
	}

	// Check primary runners first
	const primaryHasCoverage = relevant.some(
		(r) => r.status === "succeeded" || r.status === "failed",
	);
	if (primaryHasCoverage) return undefined;

	const allPrimarySkipped = relevant.every(
		(r) =>
			r.status === "skipped" ||
			r.status === "when_skipped" ||
			r.status === "test_file_skipped",
	);
	if (!allPrimarySkipped) return undefined;

	const plan = getToolPlan(ctx.kind);
	const fallbackRunnerIds = new Set(
		(plan?.groups ?? [])
			.filter(
				(group) =>
					!group.runnerIds.every((runnerId) =>
						primary.runnerIds.includes(runnerId),
					),
			)
			.flatMap((group) => group.runnerIds)
			.filter((runnerId) => !primary.runnerIds.includes(runnerId)),
	);

	// Structural-only runners (tree-sitter, ast-grep) are not substitutes
	// for real linters — don't suppress the notice if only they ran.
	const STRUCTURAL_RUNNERS = new Set([
		"tree-sitter",
		"ast-grep-napi",
		"spellcheck",
		"fact-rules",
		"opengrep",
	]);
	const anyLinterHasCoverage = runnerLatencies.some(
		(r) =>
			fallbackRunnerIds.has(r.runnerId) &&
			!STRUCTURAL_RUNNERS.has(r.runnerId) &&
			(r.status === "succeeded" || r.status === "failed"),
	);
	if (anyLinterHasCoverage) return undefined;

	const onceKey = `${ctx.kind}:${ctx.filePath}`;
	if (coverageNoticeSeen.has(onceKey)) return undefined;
	coverageNoticeSeen.add(onceKey);

	return {
		id: `coverage-unavailable:${ctx.kind}:${path.basename(ctx.filePath)}`,
		message: `Pi-lens ${ctx.kind} analysis unavailable — language tools are missing or the LSP server isn't ready yet, so this file was not fully checked (not a clean result).`,
		filePath: ctx.filePath,
		severity: "warning",
		semantic: "warning",
		tool: "pi-lens",
	};
}

const latencyReports: DispatchLatencyReport[] = [];
const coverageNoticeSeen = new Set<string>();
// One `dispatch_skipped_generated` phase record per file per process (refs
// #2346): a generated file dispatched repeatedly must not spam latency.log,
// so only the first skip of each file emits the row; the degradation ledger
// below still tallies every repetition with a bounded per-subject count.
const generatedSkipRecorded = new Set<string>();

export function getLatencyReports(): DispatchLatencyReport[] {
	return [...latencyReports];
}

export function clearLatencyReports(): void {
	latencyReports.length = 0;
}

export function clearCoverageNoticeState(): void {
	coverageNoticeSeen.clear();
	generatedSkipRecorded.clear();
}

export function formatLatencyReport(report: DispatchLatencyReport): string {
	const lines: string[] = [];
	lines.push(
		`\n═══════════════════════════════════════════════════════════════`,
	);
	lines.push(`📊 DISPATCH LATENCY REPORT: ${report.filePath.split("/").pop()}`);
	lines.push(
		`   Kind: ${report.fileKind || "unknown"} | Total: ${report.totalDurationMs}ms`,
	);
	lines.push(`───────────────────────────────────────────────────────────────`);
	lines.push(
		`Runner                          Duration  Status    Issues  Semantic`,
	);
	lines.push(`───────────────────────────────────────────────────────────────`);

	for (const r of report.runners) {
		const name = r.runnerId.padEnd(30);
		const dur = `${r.durationMs}ms`.padStart(8);
		const status = r.status.padStart(9);
		const issues = String(r.diagnosticCount).padStart(6);
		const sem = r.semantic.padStart(8);
		const slowMarker =
			r.durationMs > 500 ? " 🔥" : r.durationMs > 100 ? " ⚡" : "";
		lines.push(`${name}${dur}${status}${issues}${sem}${slowMarker}`);
	}

	lines.push(`───────────────────────────────────────────────────────────────`);
	lines.push(
		`Total: ${report.runners.length} runners | Stopped early: ${report.stoppedEarly}`,
	);
	lines.push(
		`Diagnostics: ${report.totalDiagnostics} (${report.blockers} blockers, ${report.warnings} warnings)`,
	);

	// Show top 3 slowest
	const sorted = [...report.runners].sort(
		(a, b) => b.durationMs - a.durationMs,
	);
	if (sorted.length > 0 && sorted[0].durationMs > 100) {
		lines.push(`\n🐌 Slowest runners:`);
		for (const r of sorted.slice(0, 3)) {
			if (r.durationMs > 50) {
				lines.push(`   ${r.runnerId}: ${r.durationMs}ms (${r.status})`);
			}
		}
	}

	lines.push(`═══════════════════════════════════════════════════════════════`);
	return lines.join("\n");
}

// --- Group runner (used by dispatchForFile for parallel execution) ---

interface GroupResult {
	diagnostics: Diagnostic[];
	latencies: RunnerLatency[];
	hadBlocker: boolean;
}

/**
 * Execute all runners in a single group.
 *
 * - mode "fallback": run runners sequentially and stop at the first
 *   one that succeeds (returns status !== "skipped").
 * - mode "all" (default): run all runners in the group sequentially
 *   and collect every diagnostic.
 *
 * Groups themselves are run in parallel by dispatchForFile, so this
 * function must NOT mutate shared state.
 */
async function runGroup(
	ctx: DispatchContext,
	group: RunnerGroup,
	registry: RunnerRegistryContract,
	onRunnerResult?: RunnerResultSink,
): Promise<GroupResult> {
	const diagnostics: Diagnostic[] = [];
	const latencies: RunnerLatency[] = [];
	let hadBlocker = false;

	// Filter runners by kind if specified
	const runnerIds = group.filterKinds
		? group.runnerIds.filter((id) => {
				const runner = registry.get(id);
				return runner && ctx.kind && group.filterKinds?.includes(ctx.kind);
			})
		: group.runnerIds;

	const semantic = group.semantic ?? "warning";

	for (const runnerId of runnerIds) {
		const runnerStart = Date.now();
		const runner = registry.get(runnerId);

		if (!runner) {
			latencies.push({
				runnerId,
				startTime: runnerStart,
				endTime: Date.now(),
				durationMs: 0,
				status: "skipped",
				diagnosticCount: 0,
				semantic: "unknown",
			});
			logLatency({
				type: "runner",
				filePath: ctx.filePath,
				runnerId,
				durationMs: 0,
				status: "not_registered",
				diagnosticCount: 0,
				semantic: "unknown",
			});
			continue;
		}

		// Same skipTestFiles gate RunnerRegistry.getForKind applies for the
		// per-edit path (#2337): the plan/group path resolves runners by id via
		// registry.get() instead, which bypasses getForKind entirely, so a
		// runner declaring skipTestFiles never had it enforced here.
		if (runner.skipTestFiles && isTestFile(ctx.filePath)) {
			latencies.push({
				runnerId,
				startTime: runnerStart,
				endTime: Date.now(),
				durationMs: Date.now() - runnerStart,
				status: "test_file_skipped",
				diagnosticCount: 0,
				semantic: "none",
			});
			logLatency({
				type: "runner",
				filePath: ctx.filePath,
				runnerId,
				durationMs: 0,
				status: "test_file_skipped",
				diagnosticCount: 0,
				semantic: "none",
			});
			continue;
		}

		// Keep explicit groups aligned with RunnerRegistry.getForKind(): an empty
		// appliesTo list means every kind, while a populated list must contain the
		// current kind. A filtered runner remains visible as skipped telemetry so
		// language mismatches cannot be mistaken for runner failures.
		const appliesToCurrentKind = runnerAppliesToKind(runner, ctx.kind);
		if (!appliesToCurrentKind) {
			const runnerEnd = Date.now();
			latencies.push({
				runnerId,
				startTime: runnerStart,
				endTime: runnerEnd,
				durationMs: 0,
				status: "skipped",
				diagnosticCount: 0,
				semantic: "unknown",
			});
			logLatency({
				type: "runner",
				filePath: ctx.filePath,
				runnerId,
				durationMs: 0,
				status: "skipped",
				diagnosticCount: 0,
				semantic: "unknown",
				metadata: { reason: "applies_to", kind: ctx.kind },
			});
			continue;
		}

		// Check preconditions
		let shouldRun = true;
		if (runner.when) {
			try {
				shouldRun = await runner.when(ctx);
			} catch (error) {
				ctx.log(`Runner ${runner.id} precondition failed: ${error}`);
				shouldRun = false;
			}
		}
		if (!shouldRun) {
			latencies.push({
				runnerId,
				startTime: runnerStart,
				endTime: Date.now(),
				durationMs: Date.now() - runnerStart,
				status: "when_skipped",
				diagnosticCount: 0,
				semantic: runner.id,
			});
			logLatency({
				type: "runner",
				filePath: ctx.filePath,
				runnerId,
				durationMs: 0,
				status: "when_skipped",
				diagnosticCount: 0,
				semantic: "when_condition",
			});
			continue;
		}

		const projectRoot = ctx.projectRoot ?? ctx.cwd;
		// Only post-write dispatches participate. Project scans and direct API
		// callers must retain their existing synchronous semantics.
		const observedTier =
			ctx.writeIndex === undefined
				? "inline"
				: classifyObservedRunner(projectRoot, runner.id);
		if (observedTier === "collect-later") {
			const markedAtMs = Date.now();
			const deferred = runRunner(ctx, runner, semantic).then((result) => {
				const durationMs = Date.now() - markedAtMs;
				const tier = observeRunnerLatency({
					projectRoot,
					runnerId: runner.id,
					durationMs,
					timedOut: result.failureKind === "timeout",
				});
				if (tier !== observedTier) {
					logLatency({
						type: "phase",
						filePath: ctx.filePath,
						phase: "runner_collect_later_tier_flip",
						durationMs: 0,
						metadata: {
							runnerId: runner.id,
							from: observedTier,
							to: tier,
							projectRoot,
						},
					});
				}
				if (tier === "collect-later") {
					incrementDegradationCount({
						kind: "runner-collect-later",
						subject: `${projectRoot}:${runner.id}`,
						reason: `observed ${durationMs}ms, threshold ${COLLECT_LATER_THRESHOLD_MS}ms`,
					});
				}
				logLatency({
					type: "runner",
					filePath: ctx.filePath,
					runnerId: runner.id,
					startedAt: new Date(markedAtMs).toISOString(),
					durationMs,
					status: result.status,
					diagnosticCount: result.diagnostics.length,
					semantic: result.semantic ?? semantic,
					metadata: { tier: "collect-later", delivered: "turn_end" },
				});
				return result;
			});
			deferRunnerFindings({
				filePath: ctx.filePath,
				cwd: ctx.cwd,
				projectRoot,
				runnerId: runner.id,
				markedAtMs,
				writeIndex: ctx.writeIndex,
				promise: deferred,
			});
			// A deferred runner is still an observed runner. Keep it visible in
			// both the edit latency report and the widget until its turn-end result
			// replaces this pending state (#2122 F1).
			latencies.push({
				runnerId: runner.id,
				startTime: runnerStart,
				endTime: runnerStart,
				durationMs: 0,
				status: "pending",
				diagnosticCount: 0,
				semantic: semantic,
			});
			recordRunner(ctx.filePath, runner.id, "pending", 0, 0, ctx.writeIndex);
			logLatency({
				type: "runner",
				filePath: ctx.filePath,
				runnerId: runner.id,
				durationMs: 0,
				status: "pending",
				diagnosticCount: 0,
				semantic,
				metadata: { tier: "collect-later", delivered: "turn_end" },
			});
			continue;
		}

		const result = await runRunner(ctx, runner, semantic);
		onRunnerResult?.(runnerId, result);
		const runnerEnd = Date.now();
		const duration = runnerEnd - runnerStart;
		const tier =
			ctx.writeIndex === undefined
				? "inline"
				: observeRunnerLatency({
						projectRoot,
						runnerId: runner.id,
						durationMs: duration,
						timedOut: result.failureKind === "timeout",
					});
		if (tier !== observedTier) {
			logLatency({
				type: "phase",
				filePath: ctx.filePath,
				phase: "runner_collect_later_tier_flip",
				durationMs: 0,
				metadata: {
					runnerId: runner.id,
					from: observedTier,
					to: tier,
					projectRoot,
				},
			});
		}
		if (tier === "collect-later") {
			incrementDegradationCount({
				kind: "runner-collect-later",
				subject: `${projectRoot}:${runner.id}`,
				reason: `observed ${duration}ms, threshold ${COLLECT_LATER_THRESHOLD_MS}ms`,
			});
		}
		// Runner definitions are a typed API, but embedders/plugins can still
		// return untyped objects at runtime. Admit only the closed taxonomy and
		// only on actual skips so free text cannot enter durable latency metadata.
		const skipReason =
			result.status === "skipped" && isRunnerSkipReason(result.skipReason)
				? result.skipReason
				: undefined;

		latencies.push({
			runnerId,
			startTime: runnerStart,
			endTime: runnerEnd,
			durationMs: duration,
			status: result.status,
			diagnosticCount: result.diagnostics.length,
			semantic: result.semantic ?? semantic,
			...(skipReason !== undefined && {
				skipReason,
			}),
			...(result.unconfirmedServerIds !== undefined && {
				unconfirmedServerIds: result.unconfirmedServerIds,
			}),
		});
		logLatency({
			type: "runner",
			filePath: ctx.filePath,
			runnerId,
			startedAt: new Date(runnerStart).toISOString(),
			durationMs: duration,
			status: result.status,
			diagnosticCount: result.diagnostics.length,
			semantic: result.semantic ?? semantic,
			diagnostics:
				result.diagnostics.length > 0
					? result.diagnostics.map((d) => ({
							rule: d.rule,
							message: d.message.slice(0, 120),
							line: d.line,
							semantic: d.semantic,
						}))
					: undefined,
			metadata:
				result.status === "failed" && result.failureKind
					? {
							failureKind: result.failureKind,
							failureMessage: result.failureMessage,
						}
					: skipReason
						? { skipReason }
						: undefined,
		});
		recordRunner(
			ctx.filePath,
			runnerId,
			result.status,
			result.diagnostics.length,
			duration,
			ctx.writeIndex,
		);

		diagnostics.push(...result.diagnostics);

		const resultSemantic = result.semantic ?? semantic;
		if (
			(resultSemantic === "blocking" && result.diagnostics.length > 0) ||
			result.diagnostics.some((d) => d.semantic === "blocking")
		) {
			hadBlocker = true;
		}

		// mode:"fallback" — stop at first successful runner
		if (group.mode === "fallback" && result.status === "succeeded") {
			break;
		}
	}

	return { diagnostics, latencies, hadBlocker };
}

// --- Main Dispatch Function ---

export async function dispatchForFile(
	ctx: DispatchContext,
	groups: RunnerGroup[],
	registry: RunnerRegistryContract,
	onRunnerResult?: RunnerResultSink,
): Promise<DispatchResult> {
	const _overallStart = Date.now();
	if (ctx.fileRole === "generated") {
		// The generated short-circuit (refs #2346): never ran before this fix
		// for name-less machine-emitted files (a scraped/minified page has no
		// `.min.js` pattern to catch it), so the classification now also has a
		// content-shape tier. The skip is observable — one `dispatch_skipped_generated`
		// phase record per file per process carrying the deciding evidence tier
		// and the measured line-shape statistic. Deliberately NOT a degradation
		// ledger entry: skipping a generated file is healthy behavior working
		// as designed, and the ledger's bounded kind slots are reserved for
		// genuine degradations (#2348 review F3 — the ledger precedent at the
		// collect-later tier flip below records an actual capability loss).
		const evidence: GeneratedArtifactEvidence | undefined =
			ctx.generatedEvidence;
		const lineShapeMean = ctx.generatedLineShapeMean;
		if (!generatedSkipRecorded.has(ctx.filePath)) {
			generatedSkipRecorded.add(ctx.filePath);
			logLatency({
				type: "phase",
				filePath: ctx.filePath,
				phase: "dispatch_skipped_generated",
				durationMs: 0,
				metadata: {
					evidence: evidence ?? "unknown",
					...(lineShapeMean !== undefined && { lineShapeMean }),
				},
			});
		}
		return {
			diagnostics: [],
			blockers: [],
			warnings: [],
			baselineWarningCount: 0,
			fixed: [],
			resolvedCount: 0,
			output: "",
			blockerOutput: "",
			hasBlockers: false,
		};
	}
	const allDiagnostics: Diagnostic[] = [];
	let stopped = false;
	const runnerLatencies: RunnerLatency[] = [];

	// Debug logging goes to latency log only (not console - avoid noise)
	const allRunnerIds = groups.flatMap((g) => g.runnerIds);
	logLatency({
		type: "phase",
		filePath: ctx.filePath,
		phase: "dispatch_start",
		durationMs: 0,
		metadata: {
			groupCount: groups.length,
			kind: ctx.kind,
			runners: allRunnerIds.join(","),
		},
	});

	// Run all groups in parallel — they are independent and don't depend on
	// each other's results. Within each group, mode:"fallback" semantics are
	// preserved (sequential first-success). Results are merged in original
	// group order so output is deterministic.
	const groupResults = await Promise.all(
		groups.map((group) => runGroup(ctx, group, registry, onRunnerResult)),
	);

	// Count baseline warnings before filtering (for delta count display)
	//
	// #2489: `ctx.filePath` is `createDispatchContext`'s `normalizedFilePath`
	// (`resolveRunnerPath` -> `path.resolve` -> `normalizeMapKey`), which is
	// ALWAYS absolute — the #2016 invariant this seam already relies on. A
	// prior relative-path fallback key (`session.baseline.<path relative to
	// ctx.cwd>`) existed here for self-consistency across the abs/rel read
	// and write, but on `ctx.facts` singletons that outlive one project root
	// (`dispatch/integration.ts`'s module-scope `sessionFacts`, reached by
	// the warm `pilens_analyze` MCP route across any number of cwds) two
	// different projects dispatching files that share a relative path (e.g.
	// both have `src/index.ts`) collided on that fallback key, so project
	// B's first-ever delta baseline read could silently return project A's
	// stored diagnostics. Since the absolute key can never collide across
	// projects (an absolute path is unique on the filesystem) and both
	// writes always land together, the relative fallback is both unneeded
	// and the sole source of the collision — removed rather than cwd-scoped
	// (`cwd` is not a stable identity across this seam's callers, #2494).
	//
	// #2489 round 2: the #2016 invariant above is enforced by
	// `createDispatchContext`, the sole real constructor, but nothing enforced
	// it AT THIS SEAM — a hand-built `DispatchContext` (test scaffolding, a
	// future caller) carrying a relative `filePath` would silently key the
	// baseline under a value the constructor could never produce, and every
	// subsequent same-session dispatch of the real (absolute-keyed) file would
	// read back `undefined`, never the collision itself. Mirrors the sibling
	// guard `recordEntitySnapshotDiff` already enforces for the entity-snapshot
	// seam (`clients/review-graph/service.ts`, #2477): reject visibly and skip
	// the baseline read/write for this dispatch rather than compute one under
	// an unreachable key.
	const baselinePathSafe = isAbsoluteFilePath(ctx.filePath);
	if (ctx.deltaMode && !baselinePathSafe) {
		recordDegradationOnce({
			kind: "dispatch-non-absolute-baseline-path",
			subject: ctx.filePath,
			reason:
				"dispatchForFile requires an absolute ctx.filePath to key the delta baseline (refs #2489)",
		});
	}
	const baselineAbsKey = `session.baseline.${ctx.filePath}`;
	const previousBaseline =
		ctx.deltaMode && baselinePathSafe
			? ctx.facts.getBoundedSessionFact<Diagnostic[]>(baselineAbsKey)
			: undefined;
	const baselineWarnings = previousBaseline?.filter(
		(d) => d.semantic === "warning" || d.semantic === "none",
	);
	const baselineWarningCount = baselineWarnings?.length ?? 0;

	for (const {
		diagnostics: groupDiags,
		latencies,
		hadBlocker,
	} of groupResults) {
		runnerLatencies.push(...latencies);

		allDiagnostics.push(...groupDiags);
		if (hadBlocker) stopped = true;
	}

	// Apply delta mode ONCE across the full diagnostic set.
	// This avoids partial-baseline corruption when processing multiple groups.
	const dedupedDiagnostics = dedupeOverlappingDiagnostics(allDiagnostics);
	const fileContent =
		ctx.facts.getFileFact<string>(ctx.filePath, "file.content") ?? "";
	// Project rule policy (`.pi-lens.json` `rules.<id>.disable`/`select`).
	//
	// Resolved from `ctx.projectRoot` (falling back to `ctx.cwd`), NOT
	// `ctx.projectConfig` — `ctx.projectConfig` is loaded from the nested
	// LANGUAGE root (`resolveLanguageRootForFile`), so in a monorepo where a
	// package directory has its own `.pi-lens.json`, `discoverPiLensProjectConfig`'s
	// upward walk stops there and never sees a repo-root policy.
	// `lens_diagnostics` loads its policy map from `runtime.projectRoot`; using
	// the same root here keeps the two surfaces in agreement. `ctx.projectConfig`
	// itself is untouched — thresholds and mutation flags keep their existing
	// language-root resolution.
	const rulePolicy = rulePolicyMapFromConfig(
		loadPiLensProjectConfig(ctx.projectRoot ?? ctx.cwd).rules,
	);
	// The output-only filter pipeline: LSP/docker overlap suppression + inline
	// `pi-lens-ignore` + agent/user dispositions + project rule policy. Applied
	// AFTER dedupe so the pi renderer, widget, and delta all see one filtered
	// set. #690: dispositions drop false-positive/suppress marks and anything
	// deferred this session (flagged marks stay; lens_diagnostics tags them at
	// render time). #1030: the disposition anchor + store MUST key off the
	// PROJECT ROOT, not ctx.cwd — the mark tool writes dispositions under
	// runtime.projectRoot, so reading from ctx.cwd (the nested language root in
	// a monorepo) opened a different diagnostic-dispositions.json and silently
	// no-op'd every mark under a nested marker.
	//
	// #1087: "silencing is not fixing" applies to the WHOLE class, not just the
	// policy member. This single pipeline is applied identically to the live set
	// AND (below) to the delta baseline, so a finding persistently dropped by
	// ANY layer — overlap, inline suppression, disposition, or policy — is
	// absent from both sides of the delta and never oscillates into `fixed`
	// (which `trackAgentFixed` would otherwise inflate forever). The stored
	// baseline remains the unfiltered `dedupedDiagnostics`, so editing a
	// project's policy/suppressions never resets or corrupts the user-authored
	// delta baseline — the filtering is re-derived on read for both sides.
	const applyOutputFilters = (diags: Diagnostic[]): Diagnostic[] => {
		const dockerOverlap = suppressTrivyConfigDockerOverlap(diags);
		const overlap = suppressLintOverlapsWithLsp(dockerOverlap);
		const inline = applyInlineSuppressions(overlap, fileContent);
		const disposition = applyDispositions(
			inline,
			ctx.projectRoot ?? ctx.cwd,
			ctx.filePath,
			fileContent,
		);
		return applyRulePolicy(disposition, rulePolicy);
	};
	let visibleDiagnostics = applyOutputFilters(dedupedDiagnostics);
	let resolvedCount = 0;
	if (ctx.deltaMode && previousBaseline) {
		// Silencing a rule is not fixing it. The stored baseline is deliberately
		// unfiltered (below), so compare against a fully-filtered view of it
		// through the SAME pipeline — otherwise every persistently-suppressed
		// finding sits in `fixed` on every dispatch and inflates the agent's
		// resolved tally (trackAgentFixed) forever. Only `fixed` changes:
		// filtered-out ids are absent from `after` either way.
		const filtered = filterDelta(
			visibleDiagnostics,
			applyOutputFilters(previousBaseline),
			(d) => d.id,
		);
		visibleDiagnostics = promoteDeltaUnusedToBlockers(filtered.new);
		resolvedCount = filtered.fixed.length;
	}

	// Persist full current snapshot for next run (not delta-filtered subset).
	// Gated on `baselinePathSafe` too: a non-absolute `ctx.filePath` already
	// skipped the read above (the degradation record fired there), and writing
	// under that same unreachable key here would just seed a baseline no real
	// reader (always absolute) could ever read back.
	if (ctx.deltaMode && baselinePathSafe) {
		ctx.facts.setBoundedSessionFact(baselineAbsKey, [...dedupedDiagnostics]);
	}

	// Categorize results
	const blockers = visibleDiagnostics.filter((d) => d.semantic === "blocking");
	const warnings = visibleDiagnostics.filter(
		(d) => d.semantic === "warning" || d.semantic === "none",
	);
	const fixedItems = visibleDiagnostics.filter((d) => d.semantic === "fixed");

	// Append fixed and fixable diagnostics to the persistent worklog, attributed
	// to the runtime's active model/provider when known (#1448).
	const worklogIdentity = {
		model: ctx.telemetryModel,
		provider: ctx.telemetryProvider,
	};
	if (fixedItems.length > 0) {
		import("../fix-worklog.js")
			.then(({ appendToWorklog }) => {
				appendToWorklog(ctx.cwd, fixedItems, true, worklogIdentity);
			})
			.catch(() => {});
	}
	const fixableWarnings = warnings.filter((d) => d.fixable);
	if (fixableWarnings.length > 0) {
		import("../fix-worklog.js")
			.then(({ appendToWorklog }) => {
				appendToWorklog(ctx.cwd, fixableWarnings, false, worklogIdentity);
			})
			.catch(() => {});
	}

	const inlineBlockers = blockers;
	const inlineFixed = fixedItems;
	const coverageNotice = buildCoverageNotice(ctx, runnerLatencies);

	// Format output — only blocking issues shown inline
	// Warnings tracked but not shown (noise) — surfaced via lens_diagnostics
	const blockerOutput = formatDiagnostics(inlineBlockers, "blocking");
	let output = blockerOutput;
	output += formatDiagnostics(inlineFixed, "fixed");
	if (coverageNotice) {
		output += formatDiagnostics([coverageNotice], "warning", 1);
		warnings.push(coverageNotice);
	}
	const pendingRunners = runnerLatencies
		.filter((runner) => runner.status === "pending")
		.map((runner) => runner.runnerId);
	if (pendingRunners.length > 0) {
		output += `\n⏳ Pending runners (reported at turn end): ${pendingRunners.join(", ")}\n`;
	}

	// Generate and store latency report
	const overallEnd = Date.now();
	const latencyReport: DispatchLatencyReport = {
		filePath: ctx.filePath,
		fileKind: ctx.kind,
		overallStartMs: _overallStart,
		overallEndMs: overallEnd,
		totalDurationMs: overallEnd - _overallStart,
		runners: runnerLatencies,
		stoppedEarly: stopped,
		totalDiagnostics: visibleDiagnostics.length,
		blockers: blockers.length,
		warnings: warnings.length,
	};

	// Store for later analysis
	latencyReports.push(latencyReport);

	// Keep only last 100 reports to prevent memory bloat
	if (latencyReports.length > 100) {
		latencyReports.shift();
	}

	// Runner latencies already logged immediately after execution (line ~329)
	// The runnerLatencies array is stored in latencyReport for aggregate analysis
	// No need to log again here - would create duplicates in the log

	// Log summary to latency log only (not console - avoid noise)
	const sumMs = runnerLatencies.reduce((s, r) => s + r.durationMs, 0);
	const wallClockMs = latencyReport.totalDurationMs;
	logLatency({
		type: "tool_result",
		filePath: ctx.filePath,
		durationMs: wallClockMs,
		wallClockMs,
		sumMs,
		parallelGainMs: Math.max(0, sumMs - wallClockMs),
		result: "dispatch_complete",
		metadata: {
			runners: runnerLatencies.map((r) => ({
				id: r.runnerId,
				startedAt: new Date(r.startTime).toISOString(),
				duration: r.durationMs,
				status: r.status,
			})),
			totalDiagnostics: visibleDiagnostics.length,
			blockers: blockers.length,
			// #2489 round 2: distinguishes a delta baseline HIT (a prior snapshot
			// was read for this file this session) from a MISS (first dispatch, or
			// the non-absolute-path guard above skipped the read) — `dispatch_start`
			// (above, `metadata: { groupCount, kind, runners }`) fires before the
			// baseline read ever runs and cannot carry either value.
			baselineHit: previousBaseline !== undefined,
			baselineWarningCount,
		},
	});

	return {
		diagnostics: visibleDiagnostics,
		blockers,
		warnings,
		baselineWarningCount,
		fixed: fixedItems,
		resolvedCount,
		output,
		blockerOutput,
		hasBlockers: blockers.length > 0,
	};
}

// --- Run Single Runner ---

/** Maximum wall-clock time a single runner may take before we abort it. */
const RUNNER_TIMEOUT_MS = RUNTIME_CONFIG.dispatch.runnerTimeoutMs;

function looksLikeDiagnosticCodePath(value: string): boolean {
	if (!value) return false;
	const text = value.trim();
	if (!text) return false;
	const base = path.basename(text.replace(/\\/g, "/"));
	if (/^lsp:\d+(?::\d+)?$/i.test(text) || /^lsp:\d+(?::\d+)?$/i.test(base)) {
		return true;
	}
	if (/^similarity[-:]/i.test(text) || /^similarity[-:]/i.test(base)) {
		return true;
	}
	if (
		/^[a-z-]+:\d+(?::\d+)?$/i.test(text) ||
		/^[a-z-]+:\d+(?::\d+)?$/i.test(base)
	) {
		return true;
	}
	return false;
}

function normalizeDiagnosticFilePath(
	ctx: DispatchContext,
	rawPath?: string,
): string {
	if (typeof rawPath === "string" && looksLikeDiagnosticCodePath(rawPath)) {
		ctx.log(
			`runner path normalization: ignored diagnostic code-like path '${rawPath}', using current file`,
		);
		return resolveRunnerPath(ctx.cwd, ctx.filePath);
	}

	return resolveRunnerPath(ctx.cwd, rawPath || ctx.filePath);
}

async function runRunner(
	ctx: DispatchContext,
	runner: RunnerDefinition,
	defaultSemantic: OutputSemantic,
): Promise<RunnerResult> {
	const timeoutMs = Math.max(
		runner.timeoutMs ?? RUNNER_TIMEOUT_MS,
		getRunnerTimeoutFloorMs(),
	);
	let timer: ReturnType<typeof setTimeout> | undefined;
	// #1723: mark this runner as the in-flight phase for the WHOLE race below,
	// not just the runner's own promise — a synchronous CPU hog inside
	// `runner.run` (ast-grep-napi, tree-sitter, …) blocks the event loop before
	// it ever gets to log its own completion, so `recentPhases` (which only
	// records FINISHED phases) can't name it. `phaseFinished` clears on every
	// exit from this race (success, runner error, or timeout) via try/finally,
	// so a `loop_block` sampled after this call returns never sees a stale
	// pointer. See `phaseStarted`'s doc comment for the identity-token
	// reasoning and the cost note (negligible next to a runner invocation).
	const phaseToken = phaseStarted(runner.id);
	try {
		const result = await Promise.race([
			runner.run(ctx).finally(() => clearTimeout(timer)),
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() =>
						reject(
							new Error(`Runner ${runner.id} timed out after ${timeoutMs}ms`),
						),
					timeoutMs,
				);
			}),
		]);

		const diagnostics = result.diagnostics.map((d) => ({
			...d,
			filePath: normalizeDiagnosticFilePath(ctx, d.filePath),
		}));

		return {
			...result,
			diagnostics,
			semantic: result.semantic ?? defaultSemantic,
		};
	} catch (error) {
		clearTimeout(timer);
		ctx.log(`Runner ${runner.id} failed: ${error}`);
		const message = error instanceof Error ? error.message : String(error);
		return {
			status: "failed",
			diagnostics: [],
			semantic: defaultSemantic,
			failureKind: message.includes("timed out") ? "timeout" : "exception",
			failureMessage: message.slice(0, 200),
		};
	} finally {
		phaseFinished(phaseToken);
	}
}

// --- Simple Integration Helper ---
