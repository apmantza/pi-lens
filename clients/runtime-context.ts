import type { CacheManager } from "./cache-manager.js";
import type { TurnEndFindingsCache } from "./git-guard.js";
import type { RuntimeCoordinator } from "./runtime-coordinator.js";
import {
	provenanceStamp,
	validateAdvisoryProvenance,
	type AdvisoryProvenance,
} from "./advisory-provenance.js";
import type { TestRunnerFindingsCache } from "./project-diagnostics/runner-adapters/runner-findings.js";
import { logLatency } from "./latency-logger.js";

// Exported so the Stop-hook bin strips exactly what these bridges prepend.
export const AUTOMATION_FRAMING =
	"[pi-lens automated check — not a user request] ";

type ContextResult = { messages: Array<{ role: "user"; content: string }> };

// #1432 review (S3b): a multi-file bash write can carry hundreds of changed
// paths, one `reasons` entry apiece — logging all of them shrinks the
// smells-rollup tail window (a fixed-size ring) to a handful of these
// records. Cap what this decision row carries; the full list is never
// needed for triage, only "how many and roughly what kind".
const MAX_LOGGED_REASONS = 8;

function boundedReasons(reasons: string[]): string[] {
	if (reasons.length <= MAX_LOGGED_REASONS) return reasons;
	return [
		...reasons.slice(0, MAX_LOGGED_REASONS),
		`+${reasons.length - MAX_LOGGED_REASONS} more`,
	];
}

function logProvenanceDecision(
	validation: ReturnType<typeof validateAdvisoryProvenance>,
	provenance: AdvisoryProvenance | undefined,
	advisoryKind: "turn-end" | "test-findings",
	cwd: string,
): void {
	logLatency({
		type: "phase",
		phase: "advisory_provenance_decision",
		filePath: cwd,
		durationMs: 0,
		metadata: {
			decision: validation.status === "current" ? "current" : "historical",
			reasons: boundedReasons(validation.reasons),
			changedPathCount: validation.changedPathCount,
			provenanceStamp: provenanceStamp(provenance),
			advisoryKind,
		},
	});
}

function historicalPrefix(provenance: AdvisoryProvenance | undefined): string {
	return `Historical finding; workspace changed since capture; re-run to confirm. (${provenanceStamp(provenance)})`;
}

function historicalTestContent(
	content: string,
	provenance?: AdvisoryProvenance,
): string {
	return content.startsWith("[from a prior turn")
		? content
		: `${historicalPrefix(provenance)}\n\n${content}`;
}

/**
 * Check if content is purely advisory/noise that should be skipped in steer mode.
 * Returns true if the content is non-actionable operational noise.
 */
function isAdvisoryOnlyContent(content: string): boolean {
	const trimmed = content.trim();
	return (
		/^\s*[ℹ️⚠️]?\s*Advisory — no action required/i.test(trimmed) ||
		/^\s*[ℹ️⚠️]?\s*Cascade could not compute/i.test(trimmed) ||
		/^\s*pi-lens: \d+ file\(s\) were/i.test(trimmed)
	);
}

function turnEndMessage(
	content: string,
	current: boolean,
	provenance?: AdvisoryProvenance,
): { role: "user"; content: string } | undefined {
	// Skip purely advisory/noise content — it's not actionable.
	if (isAdvisoryOnlyContent(content)) {
		return undefined;
	}
	return {
		role: "user",
		content: current
			? `${AUTOMATION_FRAMING}Address 🔴 blockers before continuing; ℹ️ advisories are informational only.\n\n${content}`
			: `${AUTOMATION_FRAMING}${historicalPrefix(provenance)}\n\n${content}`,
	};
}

/** Read a turn-end finding without changing its durable delivery state. */
export function peekTurnEndFindings(
	cacheManager: CacheManager,
	cwd: string,
	runtime?: RuntimeCoordinator,
	logDelivery = false,
): ContextResult | undefined {
	const findings = cacheManager.readCache<Partial<TurnEndFindingsCache>>(
		"turn-end-findings",
		cwd,
	);
	if (!findings?.data?.content || findings.data.consumed === true) return;
	const validation = validateAdvisoryProvenance(findings.data, cwd, runtime);
	if (logDelivery)
		logProvenanceDecision(validation, findings.data.provenance, "turn-end", cwd);
	if (validation.allFilesDeleted) return;
	const msg = turnEndMessage(
		findings.data.content,
		validation.status === "current",
		findings.data.provenance,
	);
	if (!msg) return undefined;
	return { messages: [msg] };
}

export function consumeTurnEndFindings(
	cacheManager: CacheManager,
	cwd: string,
	runtime?: RuntimeCoordinator,
): ContextResult | undefined {
	const findings = cacheManager.readCache<Partial<TurnEndFindingsCache>>(
		"turn-end-findings",
		cwd,
	);
	if (!findings?.data?.content || findings.data.consumed === true) return;
	const validation = validateAdvisoryProvenance(findings.data, cwd, runtime);
	logProvenanceDecision(validation, findings.data.provenance, "turn-end", cwd);

	// A blocker record is also the opt-in commit gate's durable state. Mark the
	// context message consumed without deleting the record; clean/advisory-only
	// records retain the historical consume-and-clear behavior.
	if (
		findings.data.hasBlockers === true &&
		typeof findings.data.sessionId === "string"
	) {
		cacheManager.writeCache(
			"turn-end-findings",
			{ ...findings.data, consumed: true },
			cwd,
		);
	} else {
		cacheManager.clearCache("turn-end-findings", cwd);
	}
	if (validation.allFilesDeleted) return;
	const msg = turnEndMessage(
		findings.data.content,
		validation.status === "current",
		findings.data.provenance,
	);
	if (!msg) return undefined;
	return { messages: [msg] };
}

/** Read test findings without consuming them; used by acknowledged IPC delivery. */
export function peekTestFindings(
	cacheManager: CacheManager,
	cwd: string,
	runtime?: RuntimeCoordinator,
	logDelivery = false,
): ContextResult | undefined {
	const findings = cacheManager.readCache<TestRunnerFindingsCache>(
		"test-runner-findings",
		cwd,
	);
	if (!findings?.data?.content) return;
	const validation = validateAdvisoryProvenance(findings.data, cwd, runtime);
	if (logDelivery)
		logProvenanceDecision(
			validation,
			findings.data.provenance,
			"test-findings",
			cwd,
		);
	if (validation.allFilesDeleted) return;
	const current = validation.status === "current";
	return {
		messages: [
			{
				role: "user",
				content: current
					? `${AUTOMATION_FRAMING}Test failures detected last turn — fix before continuing:\n\n${findings.data.content}`
					: `${AUTOMATION_FRAMING}${historicalTestContent(findings.data.content, findings.data.provenance)}`,
			},
		],
	};
}

export function consumeTestFindings(
	cacheManager: CacheManager,
	cwd: string,
	runtime?: RuntimeCoordinator,
): ContextResult | undefined {
	const record = cacheManager.readCache<TestRunnerFindingsCache>(
		"test-runner-findings",
		cwd,
	);
	if (!record?.data?.content) return;
	const findings = peekTestFindings(cacheManager, cwd, runtime, true);
	if (!findings) return;
	// Retire the content but PRESERVE the generation high-water mark: nulling
	// the whole slot would let a still-in-flight OLDER batch see `undefined`,
	// pass the strictly-greater suppression check, and resurrect a consumed
	// one-shot advisory with stale results. An empty-content record peeks as
	// undelivered while keeping late-generation ordering intact.
	const priorGeneration = cacheManager.readCache<TestRunnerFindingsCache>(
		"test-runner-findings",
		cwd,
	)?.data?.testRunGeneration;
	cacheManager.writeCache(
		"test-runner-findings",
		{
			content: "",
			testRunGeneration: priorGeneration,
		} as TestRunnerFindingsCache,
		cwd,
	);
	return findings;
}

/** Complete an acknowledged MCP delivery without re-validating or re-rendering it. */
export function acknowledgeTurnEndFindings(
	cacheManager: CacheManager,
	cwd: string,
): void {
	const findings = cacheManager.readCache<Partial<TurnEndFindingsCache>>(
		"turn-end-findings",
		cwd,
	);
	if (!findings?.data?.content || findings.data.consumed === true) return;
	if (
		findings.data.hasBlockers === true &&
		typeof findings.data.sessionId === "string"
	) {
		cacheManager.writeCache(
			"turn-end-findings",
			{ ...findings.data, consumed: true },
			cwd,
		);
	} else {
		cacheManager.clearCache("turn-end-findings", cwd);
	}
}

export function acknowledgeTestFindings(
	cacheManager: CacheManager,
	cwd: string,
): void {
	const findings = cacheManager.readCache<TestRunnerFindingsCache>(
		"test-runner-findings",
		cwd,
	);
	if (!findings?.data?.content) return;
	// Same high-water-mark preservation as consumeTestFindings.
	cacheManager.writeCache(
		"test-runner-findings",
		{
			content: "",
			testRunGeneration: findings.data.testRunGeneration,
		} as TestRunnerFindingsCache,
		cwd,
	);
}

export function consumeSessionStartGuidance(
	cacheManager: CacheManager,
	cwd: string,
): ContextResult | undefined {
	const guidance = cacheManager.readCache<{ content: string }>(
		"session-start-guidance",
		cwd,
	);
	if (!guidance?.data?.content) return;

	cacheManager.writeCache(
		"session-start-guidance",
		null as unknown as { content: string },
		cwd,
	);

	return {
		messages: [
			{
				role: "user",
				content: `[pi-lens automated context — not a user request]\n\n${guidance.data.content}`,
			},
		],
	};
}
