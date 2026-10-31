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

import type { GenerationHandle } from "../generation-guard.js";
import { logExtension, type ExtensionLogLevel } from "../extension-log.js";
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
	isWindowsPath,
	normalizeEphemeralMapKey,
	normalizeMapKey,
} from "../path-utils.js";
import { loadPiLensProjectConfig } from "../project-lens-config.js";
import { RUNTIME_CONFIG, getRunnerTimeoutFloorMs } from "../runtime-config.js";
import { probeToolAsync } from "../tool-probe.js";
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
import { linesOfRanges, rangesOfLines } from "../line-alignment.js";
import { applyFindingPolicyByOwner } from "./finding-policy.js";
import { getToolPlan } from "./plan.js";
import { resolveRunnerPath } from "./runner-context.js";
import {
	classifyObservedRunner,
	COLLECT_LATER_THRESHOLD_MS,
	observeRunnerLatency,
} from "./collect-later-tier.js";
import { deferRunnerFindings } from "./pending-runner-findings.js";
import {
	ADOPTED_ROOT_RUNNER_ALLOWLIST,
	filterGroupsForAdoptedRoot,
} from "./adopted-root-runners.js";

import { laneCopyStandsFor, semanticRank } from "./lane-copies.js";
import { normalizeRuleId } from "./rule-id-normalize.js";
import {
	applyRulePolicy,
	projectRulePolicy,
	resolveDispatchPolicyConfigForFile,
	rulePolicyMapFromResolution,
} from "./rule-policy.js";
import {
	DISABLED_BY_CONFIG_SKIP_REASON,
	disabledRunnerIdsFor,
} from "./disabled-runners.js";
import { getToolProfile } from "./tool-profile.js";
import { classifyPreExisting, preEditSeedFactKey } from "./pre-edit-seed.js";
import {
	hasUsableResult,
	isRunnerClaimSource,
	isNotApplicableSkipReason,
	isRunnerSkipReason,
	reachedNoVerdict,
} from "./types.js";

const dispatcherProbeFlights = createAvailabilityProbeFlight<
	Awaited<ReturnType<typeof probeToolAsync>>
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
	RunnerClaimSource,
	RunnerSkipReason,
} from "./types.js";
import {
	DELTA_UNUSED_PROMOTION_NOTE,
	formatDiagnostics,
} from "./utils/format-utils.js";
import { registerRunnerId } from "./known-runner-ids.js";
import {
	combinePrimaryUnavailableCauses,
	PRIMARY_UNAVAILABLE_CAUSE,
	type PrimaryUnavailableCause,
} from "../lsp/diagnostic-binding.js";

// --- Runner Registry ---

export class RunnerRegistry implements RunnerRegistryContract {
	private readonly runners = new Map<string, RunnerDefinition>();

	register(runner: RunnerDefinition): void {
		if (this.runners.has(runner.id)) return;
		this.runners.set(runner.id, runner);
		// The registry is the runner-id identity source (#3968): every id that
		// enters any registry is the set `lsp.servers.<id>.covers` validation
		// projects from (`clients/dispatch/known-runner-ids.ts`, an import
		// leaf so the config loader can ask without importing this graph).
		registerRunnerId(runner.id);
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
		let result: Awaited<ReturnType<typeof probeToolAsync>>;
		let hostStallMs: number;
		let probeJoined = false;
		try {
			const shared = dispatcherProbeFlights.run(`dispatcher:${key}`, () =>
				probeToolAsync(command, ["--version"], {
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
	/** #3568: the session of a post-write dispatch, for its deferred runners. */
	sessionGeneration?: GenerationHandle,
	/** Stable session identity for deferred runner delivery. */
	sessionId?: string,
	/** Root ownership selected by the shared analysis-root seam. */
	analysisRootMode?: import("../analysis-root.js").AnalysisRootMode,
): DispatchContext {
	const absoluteFilePath = resolveRunnerPath(cwd, filePath);
	const normalizedProjectRoot = normalizeMapKey(
		path.resolve(projectRoot ?? cwd),
	);
	const normalizedCwd = normalizeMapKey(
		resolveLanguageRootForFile(absoluteFilePath, cwd),
	);
	const normalizedFilePath = normalizeMapKey(absoluteFilePath);
	// `resolveRunnerPath` intentionally normalizes map keys, which folds a
	// literal POSIX backslash into a separator. Preserve that one proven
	// classifier distinction while still resolving relative inputs from `cwd`.
	const kindFilePath =
		!isWindowsPath(filePath) && filePath.includes("\\")
			? path.resolve(cwd, filePath)
			: absoluteFilePath;
	const kind = detectFileKind(kindFilePath);
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
	// One resolution from the file's config owner, read by both policy keys,
	// so a nested `.pi-lens.json` governs its own files' rules and denials.
	const policyConfig = resolveDispatchPolicyConfigForFile(
		absoluteFilePath,
		normalizedProjectRoot,
	);
	const rulePolicy = rulePolicyMapFromResolution(
		policyConfig,
		normalizedProjectRoot,
	);
	const disabledRunnerIds = disabledRunnerIdsFor(policyConfig);

	return {
		filePath: normalizedFilePath,
		projectRoot: normalizedProjectRoot,
		cwd: normalizedCwd,
		kind,
		fileRole,
		analysisRootMode,
		generatedEvidence: generatedDetail?.evidence,
		generatedLineShapeMean: generatedDetail?.lineShapeMean,
		pi,
		autofix: false,
		deltaMode: !pi.getFlag("no-delta"),
		facts,
		projectConfig,
		rulePolicy,
		...(disabledRunnerIds !== undefined && { disabledRunnerIds }),
		blockingOnly,
		modifiedRanges,
		writeIndex,
		sessionGeneration,
		sessionId,
		telemetryModel,
		telemetryProvider,
		toolCwdMemo: {},

		async hasTool(command: string): Promise<boolean> {
			return checkToolAvailability(command, facts);
		},

		log(message: string, level?: ExtensionLogLevel): void {
			// #1333: pi owns the terminal — a runner advisory must never be a raw
			// write. Every DispatchContext.log line lands in extension.log instead.
			logExtension({
				subsystem: "dispatch",
				// exactOptionalPropertyTypes: an omitted level must stay omitted.
				...(level !== undefined && { level }),
				message,
				metadata: { filePath: normalizedFilePath, kind },
			});
		},
	};
}

// --- Delta Mode Logic ---

/**
 * The session fact holding a file's delta baseline (absolute, normalized
 * path; the #2489 note in `dispatchForFile`). The #4483 pre-edit capture reads
 * it to tell a file's first dispatch from a later one.
 */
export function deltaBaselineFactKey(filePath: string): string {
	return `session.baseline.${filePath}`;
}

/**
 * Filter diagnostics to only show NEW issues (delta mode). Two diagnostics are
 * one finding when they share an id, or when ANOTHER lane reports the same
 * `copyOf.key` (#4629: a language server's copy and its CLI's copy of one
 * finding carry two ids). Two ids of ONE lane stay two findings, as the id
 * decides alone: an ordinal or a message in the id marks a different finding
 * at the same place and rule.
 */
function filterDelta<T extends { id: string }>(
	after: T[],
	before: T[] | undefined,
	copyOf: { key: (d: T) => string; lane: (d: T) => string },
): { new: T[]; fixed: T[] } {
	const namedBy = (side: T[]) => {
		const ids = new Set(side.map((d) => d.id));
		const lanesByKey = new Map<string, Set<string>>();
		for (const d of side) {
			const key = copyOf.key(d);
			const lanes = lanesByKey.get(key) ?? new Set<string>();
			lanes.add(copyOf.lane(d));
			lanesByKey.set(key, lanes);
		}
		return (d: T) => {
			if (ids.has(d.id)) return true;
			const lane = copyOf.lane(d);
			for (const other of lanesByKey.get(copyOf.key(d)) ?? []) {
				if (other !== lane) return true;
			}
			return false;
		};
	};
	const inBefore = namedBy(before ?? []);
	const inAfter = namedBy(after);

	const fixed = (before ?? []).filter((d) => !inAfter(d));
	const newItems = after.filter((d) => !inBefore(d));

	return { new: newItems, fixed };
}

function toolPriority(tool: string, defectClass: string): number {
	return getToolProfile(tool, defectClass).dedupPriority;
}

/**
 * One finding's identity across lanes (#4629): its place, its defect class and
 * its rule. A language server renders the rule `<source>:<code>` where its CLI
 * prints `<code>`, so the normalized rule is the key, as `lens_diagnostics` and
 * `laneCopyStandsFor` read it: one finding has one identity on every surface.
 * The two lanes' copies carry different ids and one `findingKey`. The overlap
 * dedupe keeps one copy per key and the delta reads the same key, so a lane
 * that goes silent does not make the other lane's copy a new finding.
 */
function findingKey(
	d: Diagnostic,
	defectClass: string = d.defectClass ?? classifyDiagnostic(d),
): string {
	const line = d.line ?? 1;
	const column = d.column ?? 1;
	const ruleKey = normalizeRuleId(d.rule || d.id || "unknown");
	return `${d.filePath}:${line}:${column}:${defectClass}:${ruleKey}`;
}

function dedupeOverlappingDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
	const byKey = new Map<string, Diagnostic>();

	for (const d of diagnostics) {
		const defectClass = d.defectClass ?? classifyDiagnostic(d);
		const key = findingKey(d, defectClass);
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
		// #4130: a runner fault is never a finding about the code, so it never
		// becomes a blocker, whatever its message says (`faultResult`).
		if (d.runnerFault === true) return d;
		if (!isUnusedValueDiagnostic(d)) return d;
		if (d.semantic === "blocking" || d.severity === "error") return d;
		return {
			...d,
			severity: "error",
			semantic: "blocking",
			promotionNote: DELTA_UNUSED_PROMOTION_NOTE,
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
		| "deferred"
		| "skipped"
		| "when_skipped"
		| "test_file_skipped"
		| "pending";
	diagnosticCount: number;
	semantic: string;
	/** The runner's own `failureKind`, when it set one (#3781). */
	failureKind?: string;
	skipReason?: RunnerSkipReason;
	/** WHO supplied the `covered-by-primary` claim (#3968 F2). */
	claimSource?: RunnerClaimSource;
	unconfirmedServerIds?: readonly string[];
	deferredServerIds?: readonly string[];
	/** #4403: the runner's own `primaryUnavailableCause`. */
	primaryUnavailableCause?: PrimaryUnavailableCause;
	/** #4403: the runner's own `disabledPrimaryServerIds`. */
	disabledPrimaryServerIds?: readonly string[];
	/** #4638 r3 (N2): the runner's own `withheldNotice`, rendered inline. */
	withheldNotice?: string;
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

/**
 * Build the synthetic coverage notice for this dispatch, or `undefined` when
 * the runners covered the file. #4403: with it, `unconfirmedStatus`, set
 * whenever the primary group gave no usable result for the file even when the
 * latch withholds the notice, so the caller never renders that write clean.
 *
 * `dedupe` is the push/pull axis, always supplied by the sole caller
 * (`dispatchForFile`). `true` is the pi push surface, where the session-scoped
 * `coverageNoticeSeen` latch keeps a per-edit notice from repeating on every
 * keystroke. A pull surface (`pilens_analyze`) passes `false`: each call is an
 * independent question, so the notice must come back every time, and the latch
 * is left untouched so a later push still gets its once-per-session notice
 * (refs #3791).
 */
function buildCoverageNotice(
	ctx: DispatchContext,
	runnerLatencies: RunnerLatency[],
	dedupe: boolean,
): Pick<
	DispatchResult,
	"unconfirmedStatus" | "coverage" | "primaryLspChecked"
> & {
	notice?: Diagnostic;
} {
	if (!ctx.kind) return {};
	const lspEnabled = !ctx.pi.getFlag("no-lsp");
	const primary = getPrimaryDispatchGroup(ctx.kind, lspEnabled);
	if (!primary || primary.runnerIds.length === 0)
		return { coverage: "unconfigured" };

	const relevant = runnerLatencies.filter((r) =>
		primary.runnerIds.includes(r.runnerId),
	);
	if (relevant.length === 0) return {};

	// #1867 catalog shape 4: this is correlation, not classification. The LSP
	// touch already decided which scanner publications were absent for these
	// bytes; the runner and latency assembly only preserve that exact set.
	const unconfirmedServerIds = [
		...new Set(relevant.flatMap((r) => r.unconfirmedServerIds ?? [])),
	];
	if (unconfirmedServerIds.length > 0) {
		const deferredIds = new Set(
			relevant.flatMap((r) => r.deferredServerIds ?? []),
		);
		const markerFor = (ids: readonly string[]) => {
			const shown = ids.slice(0, 4);
			const remainder = ids.length - shown.length;
			return `${shown.join(", ")}${remainder > 0 ? ` +${remainder}` : ""}`;
		};
		const deferredServerIds = unconfirmedServerIds.filter((id) =>
			deferredIds.has(id),
		);
		const silentServerIds = unconfirmedServerIds.filter(
			(id) => !deferredIds.has(id),
		);
		// The marker describes this exact scanner set. A scanner can recover
		// while another goes dark on the same file, so the set belongs in the
		// session dedupe identity rather than only kind and path.
		// #2016: these are SCANNER IDS, not filesystem paths. `normalizeMapKey`
		// would realpath each one; on Windows that fails, falls through to
		// `resolveNonExisting`, and resolves the id against the CURRENT process
		// cwd, so the dedupe key differed by platform and by cwd (the #2219
		// non-path-sentinel class). The cheap syntactic fold is what this
		// session-scoped dedupe key actually needs. Code-unit comparator: the
		// sorted set is a KEY, so ordering must be deterministic across locales
		// — localeCompare is not.
		const dedupeSet = (ids: readonly string[]) =>
			[...new Set(ids)]
				.map(normalizeEphemeralMapKey)
				.sort((a, b) => Number(a > b) - Number(a < b))
				.join(",");
		// #2810 round 4: the PARTITION is part of the identity, not just the
		// scanner set. The same scanner can be silent on one edit and marked for
		// late delivery on the next; keying on the unconfirmed set alone showed
		// the session whichever message came first and suppressed the other, so a
		// scanner that recovered a delivery path (or lost one) kept the stale
		// wording for the rest of the session.
		const onceKey = `${ctx.kind}:${ctx.filePath}:${dedupeSet(silentServerIds)}|${dedupeSet(deferredServerIds)}`;
		// #5008 review r2 (F1): the latch suppresses the NOTICE, never the CLAIM.
		// This block is one of the rule's "found no full coverage" answers, so it
		// carries `unconfirmedStatus` on BOTH returns exactly as the no-coverage
		// paths below do (`types.ts` says the field is set whenever the rule finds
		// no coverage). Without it, write 2..N on the same file with the same
		// silent scanner hit the dedupe key and `buildAllClearOutput` rendered
		// `\u2713 <lang> clean` — the reporter's 133-write session claimed a clean
		// security lane on every edit after the first. On the notice return the
		// field is redundant TODAY (the notice is output, so the all-clear line is
		// unreachable there) and it is spelled anyway, so the rule's answer never
		// depends on which write paid the latch.
		const statusParts: string[] = [];
		if (deferredServerIds.length > 0)
			statusParts.push(`${markerFor(deferredServerIds)} deferred`);
		if (silentServerIds.length > 0)
			statusParts.push(`${markerFor(silentServerIds)} silent`);
		const unconfirmedStatus = `${statusParts.join(", ")} (diagnostics are incomplete)`;
		if (dedupe) {
			if (coverageNoticeSeen.has(onceKey)) return { unconfirmedStatus };
			coverageNoticeSeen.add(onceKey);
		}
		const coverageParts: string[] = [];
		if (deferredServerIds.length > 0) {
			coverageParts.push(
				`coverage: ${markerFor(deferredServerIds)} deferred — diagnostics are incomplete; findings arrive at turn end if the scan lands.`,
			);
		}
		if (silentServerIds.length > 0) {
			coverageParts.push(
				`coverage: ${markerFor(silentServerIds)} silent — diagnostics are incomplete (not a clean result).`,
			);
		}
		return {
			notice: {
				id: `coverage-partial:${ctx.kind}:${path.basename(ctx.filePath)}`,
				message: coverageParts.join("\n"),
				filePath: ctx.filePath,
				severity: "warning",
				semantic: "warning",
				tool: "pi-lens",
			},
			unconfirmedStatus,
		};
	}

	// A runner covers the file when it reached a verdict about these bytes:
	// `succeeded`, or `failed` whose own findings failed the check
	// (`failureKind: "blocking_diagnostics"`). A timed-out or spawn-failed
	// primary produced no usable result and must not suppress the notice
	// (#3867). `hasUsableResult` owns that rule in dispatch/types.ts.
	const primaryHasCoverage = relevant.some(hasUsableResult);
	// #4734 r3: the one return where a language server checked these bytes, so
	// the only one that may say so (`DispatchResult.primaryLspChecked`). A CLI
	// primary (pyright under --no-lsp) or a fallback linter is coverage, not an
	// answer from a language server.
	if (primaryHasCoverage) {
		return {
			coverage: "primary",
			...(relevant.some((r) => r.runnerId === "lsp" && hasUsableResult(r)) && {
				primaryLspChecked: true,
			}),
		};
	}

	// A primary still in flight (collect-later) may deliver findings at turn
	// end, so it withholds the notice. A skipped or broken primary produced
	// nothing for these bytes, so it falls through to the fallback check.
	const primaryStillInFlight = relevant.some(
		(r) => r.status === "pending" || r.status === "deferred",
	);
	if (primaryStillInFlight) return { coverage: "in_flight" };

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

	// These fallback runners provide type coverage when the primary group is
	// unavailable. Keep this explicit until runner metadata owns this capability.
	const TYPE_CAPABLE_FALLBACK_RUNNERS = new Set(["mypy"]);
	const anyFallbackHasCoverage = runnerLatencies.some(
		(r) =>
			fallbackRunnerIds.has(r.runnerId) &&
			!STRUCTURAL_RUNNERS.has(r.runnerId) &&
			hasUsableResult(r) &&
			(!plan?.capabilities.includes("types") ||
				TYPE_CAPABLE_FALLBACK_RUNNERS.has(r.runnerId)),
	);
	if (anyFallbackHasCoverage) return { coverage: "fallback" };

	// #4403: no primary checked this file. When the runner knows why, the
	// status line says it; otherwise it says what the notice says.
	const cause = combinePrimaryUnavailableCauses(
		relevant.flatMap((r) => r.primaryUnavailableCause ?? []),
	);
	// `dispatch.disabledRunners` denials are skipped by the dispatch loop with
	// a stated reason; they name their own key, not the LSP's.
	const deniedRunnerIds = relevant
		.filter((r) => r.skipReason === DISABLED_BY_CONFIG_SKIP_REASON)
		.map((r) => r.runnerId);
	const deniedNote = `${deniedRunnerIds.join(", ")} disabled in config by dispatch.disabledRunners`;
	// A row that is not a tool failure: one the operator switched off (a runner
	// denial, or a primary LSP `lsp.disabledServers` turned off, with or without
	// its fallback), or one that skipped with a stated not-applicable reason
	// (nothing for it to check). The config-only wording holds only when every
	// row is one; any other row is a tool that is missing, timed out, or failed
	// (a skip that states no listed reason included), and the notice must still
	// say so rather than let the denial hide it.
	const onlySwitchedOff = relevant.every(
		(r) =>
			r.skipReason === DISABLED_BY_CONFIG_SKIP_REASON ||
			isNotApplicableSkipReason(r.skipReason) ||
			r.primaryUnavailableCause === "disabled" ||
			r.primaryUnavailableCause === "disabledFallback",
	);
	const unconfirmedStatus = cause
		? `no primary language server answered (${PRIMARY_UNAVAILABLE_CAUSE[cause]})${deniedRunnerIds.length > 0 ? `; ${deniedNote}` : ""}`
		: deniedRunnerIds.length > 0
			? onlySwitchedOff
				? `not checked (${deniedNote})`
				: `not fully checked (a language tool is missing, timed out, or failed to run; ${deniedNote})`
			: "not fully checked (a language tool is missing, timed out, or failed to run)";

	if (
		onlySwitchedOff &&
		(cause === "disabled" ||
			cause === "disabledFallback" ||
			(cause === undefined && deniedRunnerIds.length > 0))
	) {
		// #4403: the operator turned the primary off on purpose. That is not a
		// tool that is missing or failed, and it holds for every file the
		// server serves, so it gets one note per server per session, then the
		// status line alone. Round 4 (N1): the same when the primary's
		// `fallbackFor` alternate stands in and does not answer either.
		const disabledIds = [
			...new Set(relevant.flatMap((r) => r.disabledPrimaryServerIds ?? [])),
		].sort((a, b) => Number(a > b) - Number(a < b));
		const onceKeys = [
			...disabledIds.map((id) => `disabled-primary:${id}`),
			...deniedRunnerIds.map((id) => `disabled-runner:${id}`),
		];
		if (dedupe) {
			if (onceKeys.every((key) => coverageNoticeSeen.has(key)))
				return { unconfirmedStatus };
			for (const key of onceKeys) coverageNoticeSeen.add(key);
		}
		return {
			notice: {
				id: `coverage-disabled:${ctx.kind}:${[...disabledIds, ...deniedRunnerIds].join(",")}`,
				message:
					disabledIds.length === 0
						? `Pi-lens ${ctx.kind} analysis unconfirmed — Runner (${deniedRunnerIds.join(", ")}) is disabled in config by dispatch.disabledRunners, so no runner checks these files this session (not a clean result).`
						: deniedRunnerIds.length > 0
							? `Pi-lens ${ctx.kind} analysis unconfirmed — Primary LSP (${disabledIds.join(", ")}) is disabled in config by lsp.disabledServers and runner (${deniedRunnerIds.join(", ")}) by dispatch.disabledRunners, so nothing checks these files this session (not a clean result).`
							: cause === "disabled"
								? `Pi-lens ${ctx.kind} analysis unconfirmed — Primary LSP (${disabledIds.join(", ")}) is disabled in config by lsp.disabledServers, so no language server checks these files this session (not a clean result).`
								: `Pi-lens ${ctx.kind} analysis unconfirmed — Primary LSP (${disabledIds.join(", ")}) is disabled in config by lsp.disabledServers and its fallback did not answer, so no language server checked these files (not a clean result).`,
				filePath: ctx.filePath,
				severity: "warning",
				semantic: "warning",
				tool: "pi-lens",
			},
			unconfirmedStatus,
		};
	}

	const onceKey = `${ctx.kind}:${ctx.filePath}`;
	if (dedupe) {
		if (coverageNoticeSeen.has(onceKey)) return { unconfirmedStatus };
		coverageNoticeSeen.add(onceKey);
	}

	return {
		notice: {
			id: `coverage-unavailable:${ctx.kind}:${path.basename(ctx.filePath)}`,
			message: `Pi-lens ${ctx.kind} analysis unavailable — a language tool is missing, timed out, or failed to run, or the LSP server isn't ready yet, so this file was not fully checked (not a clean result).${deniedRunnerIds.length > 0 ? ` Runner (${deniedRunnerIds.join(", ")}) is also disabled in config by dispatch.disabledRunners.` : ""}`,
			filePath: ctx.filePath,
			severity: "warning",
			semantic: "warning",
			tool: "pi-lens",
		},
		unconfirmedStatus,
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
	/** #4484 r2: findings the runners' edit-range gates withheld (`outOfEditScope`). */
	outOfEditScope: Diagnostic[];
	/** #4484 r2: runners and servers that reached no verdict in this group. */
	inconclusiveRunnerIds: string[];
	inconclusiveServerIds: string[];
	/** #4484 round 3: the inconclusive runners still in flight (collect-later). */
	collectLaterRunnerIds: string[];
	/** #4484 round 6: runners whose verdict covers only the edit's ranges. */
	editScopedRunnerIds: string[];
	/** #4484 round 7: runners that reached a verdict, and the lanes covered skips defer to. */
	answeredRunnerIds: string[];
	/** #4509: `ran` marks a covered run (it read the bytes), not a covered skip. */
	coveredRunners: {
		runnerId: string;
		lane: { runnerId: string; serverId?: string };
		ran: boolean;
	}[];
}

/**
 * #4484 round 3 (R4): `ctx` for one runner, its `modifiedRanges` widened by
 * the lines an earlier write owed it (`DispatchContext.owedRanges`). A
 * whole-file dispatch (no ranges) already covers them.
 */
export function runnerDispatchContext(
	ctx: DispatchContext,
	runnerId: string,
): DispatchContext {
	const owed = ctx.owedRanges?.get(runnerId);
	if (!owed?.length || !ctx.modifiedRanges) return ctx;
	return {
		...ctx,
		modifiedRanges: rangesOfLines([
			...linesOfRanges(ctx.modifiedRanges),
			...linesOfRanges(owed),
		]),
	};
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
	const outOfEditScope: Diagnostic[] = [];
	const inconclusiveRunnerIds: string[] = [];
	const inconclusiveServerIds: string[] = [];
	const collectLaterRunnerIds: string[] = [];
	const editScopedRunnerIds: string[] = [];
	const answeredRunnerIds: string[] = [];
	const coveredRunners: GroupResult["coveredRunners"] = [];

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

		// `dispatch.disabledRunners`: the operator turned this runner off. It is
		// skipped before `when`/`run`, so its tool never spawns (not even an
		// availability probe), and the skip carries a stated reason, so it is
		// neither a failure nor a runner that reached no verdict: a fallback
		// group moves on to its next member as for any other skip.
		if (ctx.disabledRunnerIds?.has(runnerId)) {
			const runnerEnd = Date.now();
			latencies.push({
				runnerId,
				startTime: runnerStart,
				endTime: runnerEnd,
				durationMs: 0,
				status: "skipped",
				diagnosticCount: 0,
				semantic: "none",
				skipReason: DISABLED_BY_CONFIG_SKIP_REASON,
			});
			logLatency({
				type: "runner",
				filePath: ctx.filePath,
				runnerId,
				durationMs: 0,
				status: "skipped",
				diagnosticCount: 0,
				semantic: "none",
				metadata: { skipReason: DISABLED_BY_CONFIG_SKIP_REASON },
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
				// #4484 round 3: a precondition that threw never decided the runner
				// does not apply, so the skip reaches no verdict (R1).
				inconclusiveRunnerIds.push(runner.id);
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
		// #4484 round 3: this runner's range, with the lines owed to it.
		const runnerCtx = runnerDispatchContext(ctx, runner.id);
		// Only post-write dispatches participate. Project scans and direct API
		// callers must retain their existing synchronous semantics.
		const observedTier =
			ctx.writeIndex === undefined
				? "inline"
				: classifyObservedRunner(projectRoot, runner.id);
		if (observedTier === "collect-later") {
			const markedAtMs = Date.now();
			const deferred = runRunner(runnerCtx, runner, semantic).then((result) => {
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
					metadata: {
						tier: "collect-later",
						delivered: "turn_end",
						...failureRowMetadata(result),
					},
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
				session: ctx.sessionGeneration,
				sessionId: ctx.sessionId,
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
			// #4484 r2: a run still in flight has observed nothing yet.
			inconclusiveRunnerIds.push(runner.id);
			collectLaterRunnerIds.push(runner.id);
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

		const result = await runRunner(runnerCtx, runner, semantic);
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
		// WHO claimed, for `covered-by-primary` (#3968 F2). Admitted only on
		// actual skips and only through the closed-taxonomy guard, like
		// skipReason, so free text cannot enter durable latency metadata.
		const claimSource =
			result.status === "skipped" && isRunnerClaimSource(result.claimSource)
				? result.claimSource
				: undefined;

		latencies.push({
			runnerId,
			startTime: runnerStart,
			endTime: runnerEnd,
			durationMs: duration,
			status: result.status,
			diagnosticCount: result.diagnostics.length,
			semantic: result.semantic ?? semantic,
			...(result.failureKind !== undefined && {
				failureKind: result.failureKind,
			}),
			...(skipReason !== undefined && {
				skipReason,
			}),
			...(claimSource !== undefined && {
				claimSource,
			}),
			...(result.unconfirmedServerIds !== undefined && {
				unconfirmedServerIds: result.unconfirmedServerIds,
			}),
			...(result.deferredServerIds !== undefined && {
				deferredServerIds: result.deferredServerIds,
			}),
			...(result.primaryUnavailableCause !== undefined && {
				primaryUnavailableCause: result.primaryUnavailableCause,
			}),
			...(result.disabledPrimaryServerIds !== undefined && {
				disabledPrimaryServerIds: result.disabledPrimaryServerIds,
			}),
			...(result.withheldNotice !== undefined && {
				withheldNotice: result.withheldNotice,
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
				failureRowMetadata(result) ??
				(skipReason
					? { skipReason, ...(claimSource !== undefined && { claimSource }) }
					: undefined),
		});
		// #4483: a pre-edit capture reads bytes the host is about to replace,
		// so its counts never reach the widget's runner state.
		if (!ctx.preEditCapture)
			recordRunner(
				ctx.filePath,
				runnerId,
				result.status,
				result.diagnostics.length,
				duration,
				ctx.writeIndex,
			);

		// #4484 r2: every finding names the runner that observed it, so a
		// recorded blocker is retired only by a conclusive run of its own source.
		for (const d of result.diagnostics) d.runnerId ??= runnerId;
		for (const d of result.outOfEditScope ?? []) {
			d.runnerId ??= runnerId;
			outOfEditScope.push(d);
		}
		if (reachedNoVerdict(result)) inconclusiveRunnerIds.push(runnerId);
		else {
			answeredRunnerIds.push(runnerId);
			if (result.coveredBy)
				coveredRunners.push({
					runnerId,
					lane: result.coveredBy,
					ran: result.skipReason !== "covered-by-primary",
				});
			if (result.editScopedVerdict === true) editScopedRunnerIds.push(runnerId);
		}
		inconclusiveServerIds.push(
			...(result.unconfirmedServerIds ?? []),
			...(result.deferredServerIds ?? []),
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

	return {
		diagnostics,
		latencies,
		hadBlocker,
		outOfEditScope,
		inconclusiveRunnerIds,
		inconclusiveServerIds,
		collectLaterRunnerIds,
		editScopedRunnerIds,
		answeredRunnerIds,
		coveredRunners,
	};
}

// --- Main Dispatch Function ---

export async function dispatchForFile(
	ctx: DispatchContext,
	groups: RunnerGroup[],
	registry: RunnerRegistryContract,
	onRunnerResult?: RunnerResultSink,
	/**
	 * Push/pull coverage-notice dedupe (refs #3791). Defaults to `true` (the pi
	 * push surface's once-per-session latch). A pull surface passes `false` so
	 * every call carries the notice — see {@link buildCoverageNotice}.
	 */
	options?: { dedupeCoverageNotice?: boolean },
): Promise<DispatchResult> {
	const _overallStart = Date.now();
	if (ctx.analysisRootMode === "adopted") {
		// #4242 phase A (per-file linters): an adopted root runs ONLY the explicit
		// admission list of config-free, code-free runners, and only from global or
		// pi-lens-managed binaries. The default is refused, so a newly registered
		// runner stays off an adopted root until `ADOPTED_ROOT_RUNNER_ALLOWLIST`
		// admits it. Whole-project scanners and test runners are not in the plan
		// for a per-file dispatch, and turn-end tests stay off via the foreign
		// checkout gate.
		const planned = groups.flatMap((g) => g.runnerIds);
		groups = filterGroupsForAdoptedRoot(groups);
		const admitted = new Set(groups.flatMap((g) => g.runnerIds));
		logLatency({
			type: "phase",
			filePath: ctx.filePath,
			phase: "dispatch_adopted_root_allowlist",
			durationMs: 0,
			metadata: {
				admissionList: ADOPTED_ROOT_RUNNER_ALLOWLIST.join(","),
				admitted: groups.flatMap((g) => g.runnerIds).join(","),
				refused: planned
					.flatMap((id) => (admitted.has(id) ? [] : [id]))
					.join(","),
				noAdmittedRunner: groups.length === 0,
			},
		});
		if (groups.length === 0) {
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
	}
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
			...(ctx.preEditCapture && { preEditCapture: true }),
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
	const baselineAbsKey = deltaBaselineFactKey(ctx.filePath);
	const previousBaseline =
		ctx.deltaMode && baselinePathSafe
			? ctx.facts.getBoundedSessionFact<Diagnostic[]>(baselineAbsKey)
			: undefined;
	const baselineWarnings = previousBaseline?.filter(
		(d) => d.semantic === "warning" || d.semantic === "none",
	);
	const baselineWarningCount = baselineWarnings?.length ?? 0;

	const outOfEditScope: Diagnostic[] = [];
	const inconclusiveRunnerIds = new Set<string>();
	const inconclusiveServerIds = new Set<string>();
	const collectLaterRunnerIds = new Set<string>();
	const editScopedRunnerIds: string[] = [];
	const answeredRunnerIds = new Set<string>();
	const coveredRunners: GroupResult["coveredRunners"] = [];
	for (const {
		diagnostics: groupDiags,
		latencies,
		hadBlocker,
		outOfEditScope: groupOutOfScope,
		inconclusiveRunnerIds: groupRunnerIds,
		inconclusiveServerIds: groupServerIds,
		collectLaterRunnerIds: groupCollectLater,
		editScopedRunnerIds: groupEditScoped,
		answeredRunnerIds: groupAnswered,
		coveredRunners: groupCovered,
	} of groupResults) {
		runnerLatencies.push(...latencies);
		outOfEditScope.push(...groupOutOfScope);
		for (const id of groupRunnerIds) inconclusiveRunnerIds.add(id);
		for (const id of groupServerIds) inconclusiveServerIds.add(id);
		for (const id of groupCollectLater) collectLaterRunnerIds.add(id);
		editScopedRunnerIds.push(...groupEditScoped);
		for (const id of groupAnswered) answeredRunnerIds.add(id);
		coveredRunners.push(...groupCovered);

		allDiagnostics.push(...groupDiags);
		if (hadBlocker) stopped = true;
	}
	// #4484 round 7: a covered skip is a verdict only when the lane it defers
	// to answered: its runner reached a verdict, and its server confirmed.
	// #4509: a covered run read the bytes, so its verdict stands either way.
	// Where its answering lane delivers one of its findings (same line and
	// rule, at least as severe: `laneCopyStandsFor`), the lane's copy stands
	// for it, so the one finding is listed once.
	const voidedCovers = new Set<string>();
	const laneCopyByRunner = new Map<string, (d: Diagnostic) => boolean>();
	for (const { runnerId, lane, ran } of coveredRunners) {
		const silent =
			!answeredRunnerIds.has(lane.runnerId) ||
			(lane.serverId !== undefined && inconclusiveServerIds.has(lane.serverId));
		if (ran) {
			if (silent) continue;
			laneCopyByRunner.set(
				runnerId,
				laneCopyStandsFor(
					allDiagnostics.flatMap((d) =>
						d.runnerId === lane.runnerId &&
						(lane.serverId === undefined || d.serverId === lane.serverId)
							? [d]
							: [],
					),
				),
			);
			continue;
		}
		if (!silent) continue;
		voidedCovers.add(runnerId);
		inconclusiveRunnerIds.add(runnerId);
	}
	const deliveredDiagnostics =
		laneCopyByRunner.size === 0
			? allDiagnostics
			: allDiagnostics.flatMap((d) =>
					laneCopyByRunner.get(d.runnerId ?? "")?.(d) ? [] : [d],
				);

	// Apply delta mode ONCE across the full diagnostic set.
	// This avoids partial-baseline corruption when processing multiple groups.
	const dedupedDiagnostics = dedupeOverlappingDiagnostics(deliveredDiagnostics);
	const fileContent =
		ctx.facts.getFileFact<string>(ctx.filePath, "file.content") ?? "";
	// Project rule policy (`.pi-lens.json` `rules.<id>.disable`/`select`).
	//
	// Each finding is filtered by its OWN file's config owner under
	// `ctx.projectRoot` (falling back to `ctx.cwd`), NOT `ctx.projectConfig` —
	// `ctx.projectConfig` is loaded from the nested LANGUAGE root
	// (`resolveLanguageRootForFile`), and `discoverPiLensProjectConfig`'s upward
	// walk stops at the first config, so it never sees a repo-root policy. The
	// owner's resolution layers the global tier, the repo root's file, and each
	// nested file between. A runner may report on files other than the edited
	// one (helm-lint puts chart-level findings on `Chart.yaml`), so one owner's
	// map must not filter another owner's finding (#5011 r8, F24).
	// `lens_diagnostics` reads the same owner per file (`loadProjectRulePolicy`),
	// which keeps the two surfaces in agreement. `ctx.projectConfig` itself is
	// untouched — thresholds and mutation flags keep their existing
	// language-root resolution. A context `createDispatchContext` built carries
	// the edited file's map (possibly empty), which that owner reuses.
	const rulePolicyRoot = ctx.projectRoot ?? ctx.cwd;
	const rulePolicy = projectRulePolicy(
		rulePolicyRoot,
		"rulePolicy" in ctx
			? { filePath: ctx.filePath, map: ctx.rulePolicy }
			: undefined,
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
		// #5044: inline comments and dispositions belong to the file a finding
		// NAMES, not the edited one (see `applyFindingPolicyByOwner`).
		const { disposed: disposition } = applyFindingPolicyByOwner(overlap, {
			cwd: rulePolicyRoot,
			filePath: ctx.filePath,
			content: fileContent,
			policyMap: undefined,
		});
		return applyRulePolicy(disposition, rulePolicy, {
			root: rulePolicyRoot,
			filePath: ctx.filePath,
		});
	};
	let visibleDiagnostics = applyOutputFilters(dedupedDiagnostics);
	let resolvedCount = 0;
	// #4484 r2: what this observation still holds that neither delivers nor
	// enters the record alone. An edit-range gate decides delivery only, so the
	// blocking findings it withheld (through the same output filters) keep a
	// recorded blocker of the same identity pending. They stay out of the
	// baseline and the delta.
	const stillObserved: Diagnostic[] =
		outOfEditScope.length > 0
			? applyOutputFilters(outOfEditScope).flatMap((d) =>
					d.semantic === "blocking" ? [d] : [],
				)
			: [];
	// #4484: the delta decides only what the agent is told is NEW, never
	// whether a blocker is still pending. The blocking findings it holds back
	// as already seen are still in this observation, so they go back beside
	// the delta: the inline-blocker record, the store and the commit gate read
	// them, and the record clears only when they and the delta's blockers are
	// both gone.
	let heldBackBlockers: Diagnostic[] = [];
	if (ctx.deltaMode && previousBaseline) {
		// Silencing a rule is not fixing it. The stored baseline is deliberately
		// unfiltered (below), so compare against a fully-filtered view of it
		// through the SAME pipeline — otherwise every persistently-suppressed
		// finding sits in `fixed` on every dispatch and inflates the agent's
		// resolved tally (trackAgentFixed) forever. Only `fixed` changes:
		// filtered-out ids are absent from `after` either way.
		//
		// #4629: the id alone is one lane's name for a finding. The baseline keeps
		// the language server's copy of a finding both lanes reported, so when that
		// lane goes silent, the CLI's copy of the unchanged finding carries another
		// id. `findingKey` is the identity the dedupe merged the two copies on, so
		// a copy that another tool reports under it is the same finding, and the
		// delta calls it neither new nor fixed. Two ids of one tool stay apart.
		const filtered = filterDelta(
			visibleDiagnostics,
			applyOutputFilters(previousBaseline),
			{ key: (d) => findingKey(d), lane: (d) => d.tool },
		);
		const isNew = new Set(filtered.new);
		heldBackBlockers = visibleDiagnostics.filter(
			(d) => d.semantic === "blocking" && !isNew.has(d),
		);
		// #4484 r2: an unused value is a blocker only while the delta calls it
		// new. Held back as already seen, it is still observed, promoted as it
		// was when it was recorded, so the record keeps it pending.
		stillObserved.push(
			...promoteDeltaUnusedToBlockers(
				visibleDiagnostics.flatMap((d) =>
					!isNew.has(d) &&
					d.semantic !== "blocking" &&
					isUnusedValueDiagnostic(d)
						? [d]
						: [],
				),
			),
		);
		visibleDiagnostics = promoteDeltaUnusedToBlockers(filtered.new);
		resolvedCount = filtered.fixed.length;
	}

	// #4483: a blocking linter finding the file held before its first edit
	// this session (the seed `tool_call` captured) is pre-existing: not a
	// blocker, not held back, reported on its own. Matched by identity and
	// line text, so it stays pre-existing when lines move; the seed shrinks to
	// what this run still observes, or keeps entries of runners with no verdict.
	const seedKey = preEditSeedFactKey(ctx.filePath);
	const preEditSeed =
		ctx.deltaMode && baselinePathSafe
			? ctx.facts.getBoundedSessionFact<Diagnostic[]>(seedKey)
			: undefined;
	const seedContent = ctx.facts.getFileFact<string>(
		ctx.filePath,
		"file.content",
	);
	let preExisting: Diagnostic[] = [];
	if (preEditSeed && seedContent !== undefined) {
		const classified = classifyPreExisting(
			preEditSeed,
			[
				...visibleDiagnostics.filter((d) => d.semantic === "blocking"),
				...heldBackBlockers,
			],
			seedContent,
			new Set(
				[...answeredRunnerIds].filter((id) => !inconclusiveRunnerIds.has(id)),
			),
		);
		if (classified.preExisting.length > 0) {
			const held = new Set(classified.preExisting);
			visibleDiagnostics = visibleDiagnostics.filter((d) => !held.has(d));
			heldBackBlockers = heldBackBlockers.filter((d) => !held.has(d));
			preExisting = classified.preExisting;
		}
		ctx.facts.setBoundedSessionFact(seedKey, classified.nextSeed);
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
	const {
		notice: coverageNotice,
		unconfirmedStatus,
		coverage,
		primaryLspChecked,
	} = buildCoverageNotice(
		ctx,
		runnerLatencies,
		options?.dedupeCoverageNotice ?? true,
	);

	// Format output — only blocking issues shown inline
	// Warnings tracked but not shown (noise) — surfaced via lens_diagnostics
	const blockerOutput = formatDiagnostics(inlineBlockers, "blocking");
	let output = blockerOutput;
	output += formatDiagnostics(inlineFixed, "fixed");
	// #4638 r3 (N2): findings a runner withheld on purpose are named on the same
	// inline channel as the coverage notice, never left to the ledger alone.
	const withheldMessages = [
		...new Set(runnerLatencies.flatMap((r) => r.withheldNotice ?? [])),
	];
	const withheldNotice: Diagnostic | undefined =
		withheldMessages.length > 0
			? {
					id: `withheld-compile:${ctx.kind}:${path.basename(ctx.filePath)}`,
					message: withheldMessages.join("\n"),
					filePath: ctx.filePath,
					severity: "warning",
					semantic: "warning",
					tool: "pi-lens",
				}
			: undefined;
	const inlineNotices = [
		...(coverageNotice ? [coverageNotice] : []),
		...(withheldNotice ? [withheldNotice] : []),
	];
	if (inlineNotices.length > 0) {
		output += formatDiagnostics(inlineNotices, "warning", inlineNotices.length);
		warnings.push(...inlineNotices);
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
			// #4484: blockers still observed that the delta did not call new.
			heldBackBlockers: heldBackBlockers.length,
			// #4483: whether a pre-edit seed was read, and the blocking linter
			// findings it reported as pre-existing.
			preEditSeed: preEditSeed !== undefined,
			preExisting: preExisting.length,
			...(ctx.preEditCapture && { preEditCapture: true }),
			// #4484 r2: findings that only keep a recorded blocker pending, and
			// the sources whose silence is no evidence.
			stillObserved: stillObserved.length,
			inconclusiveRunners: inconclusiveRunnerIds.size,
			inconclusiveServers: inconclusiveServerIds.size,
		},
	});

	return {
		latencyReport,
		diagnostics: visibleDiagnostics,
		blockers,
		warnings,
		baselineWarningCount,
		fixed: fixedItems,
		resolvedCount,
		output,
		blockerOutput,
		hasBlockers: blockers.length > 0,
		...(heldBackBlockers.length > 0 && { heldBackBlockers }),
		...(preExisting.length > 0 && { preExisting }),
		...(stillObserved.length > 0 && { stillObserved }),
		...(editScopedRunnerIds.some((id) => !voidedCovers.has(id)) && {
			editScopedRunnerIds: editScopedRunnerIds.flatMap((id) =>
				voidedCovers.has(id) ? [] : [id],
			),
		}),
		...((inconclusiveRunnerIds.size > 0 || inconclusiveServerIds.size > 0) && {
			inconclusiveSources: {
				runnerIds: [...inconclusiveRunnerIds],
				serverIds: [...inconclusiveServerIds],
				collectLaterRunnerIds: [...collectLaterRunnerIds],
			},
		}),
		...(unconfirmedStatus !== undefined && { unconfirmedStatus }),
		...(coverage !== undefined && { coverage }),
		...(primaryLspChecked && { primaryLspChecked }),
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

/**
 * The `failureKind` of a failed run, for the latency.log runner row (#3796).
 * Inline and collect-later rows share it, so the log analyzer reads one place.
 */
function failureRowMetadata(result: RunnerResult):
	| Partial<{
			failureKind: string;
			failureMessage: string | undefined;
			inconclusive: true;
	  }>
	| undefined {
	// #4522 T3: an inconclusive run says so on its row even when it succeeded
	// (detekt exit 1 with warning findings), so latency.log shows a partial read.
	const inconclusive =
		result.inconclusive === true ? { inconclusive: true as const } : {};
	if (result.status === "failed" && result.failureKind) {
		return {
			failureKind: result.failureKind,
			failureMessage: result.failureMessage,
			...inconclusive,
		};
	}
	return result.inconclusive === true ? inconclusive : undefined;
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
