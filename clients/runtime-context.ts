import type { CacheManager } from "./cache-manager.js";
import type { TurnEndFindingsCache } from "./git-guard.js";
import type { RuntimeCoordinator } from "./runtime-coordinator.js";
import {
	provenanceStamp,
	validateAdvisoryProvenance,
	type AdvisoryProvenance,
} from "./advisory-provenance.js";
import type { TestRunnerFindingsCache } from "./project-diagnostics/runner-adapters/runner-findings.js";
import {
	incrementDegradationCount,
	recordDegradationOnce,
} from "./degradation-ledger.js";
import { toRunnerDisplayPath } from "./dispatch/runner-context.js";
import { logLatency } from "./latency-logger.js";
import {
	resolveLensToolName,
	translateGuidanceToolNames,
	type LensToolHost,
} from "./tool-config.js";

// Exported so the Stop-hook bin strips exactly what these bridges prepend.
export const AUTOMATION_FRAMING =
	"[pi-lens automated check — not a user request] ";

type ContextResult = {
	messages: Array<{ role: "user"; content: string }>;
	/** #5240: the blocker text of a repeat message, for the retained-injection check. */
	repeatBody?: string;
};

/**
 * #5240: opens a turn-end message that repeats blockers the model was already
 * told about. "Historical finding" means the workspace changed since capture,
 * so a repeat must not borrow it.
 */
export const BLOCKER_REPEAT_HEADING =
	"Still unresolved (already reported on an earlier turn, not new):";

export function blockerRepeatContent(blockers: string): string {
	return `${BLOCKER_REPEAT_HEADING}\n\n${blockers}`;
}

/**
 * #5532: a blocker set the session cannot clear (a pi-dev-flow session cannot
 * write another flow's worktree) repeats in full on at most this many prompts;
 * later prompts get {@link blockerRepeatCappedLine}. The blocker stays in
 * `lens_diagnostics` and the `--lens-guard` commit gate.
 */
export const BLOCKER_REPEAT_MAX_DELIVERIES = 3;

/** #5532: the one line that replaces a capped set's repeat. */
function blockerRepeatCappedLine(files: number): string {
	const tool = resolveLensToolName("lens_diagnostics", "pi");
	return `${files} older unresolved blocker ${files === 1 ? "file" : "files"} still open (already reported, not new). Every unresolved 🔴 blocker: ${tool} {source: "session", mode: "all", severity: "error"}`;
}

/**
 * #5240: the last line of a delivered repeat. The staged blocker text is
 * capped (`capTurnEndMessage`), so the repeat names the pull that lists every
 * blocker. Added when the repeat is rendered, never staged: `repeatBody` must
 * stay exactly the blocker text for the retained-injection check.
 */
function blockerRepeatPointer(): string {
	const tool = resolveLensToolName("lens_diagnostics", "pi");
	return `Every unresolved 🔴 blocker: ${tool} {source: "session", mode: "all", severity: "error"}`;
}

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

function turnEndMessage(
	content: string,
	current: boolean,
	provenance?: AdvisoryProvenance,
): { role: "user"; content: string } {
	return {
		role: "user",
		content: current
			? `${AUTOMATION_FRAMING}Address 🔴 blockers before continuing; ℹ️ advisories are informational only.\n\n${content}`
			: `${AUTOMATION_FRAMING}${historicalPrefix(provenance)}\n\n${content}`,
	};
}

/**
 * #4943: the reader the staged turn-end message is for, or undefined when it
 * is this reader's. One comparison per field: `deliverTo` (the composer's
 * address) against the reader's `address`; without it, the owner `sessionId`
 * against the reader's `sessionId`; a record that names neither is anyone's.
 * A pi request passes its session for both. The MCP host passes its one
 * address for every server process (`deliverTo` must outlive a restart) and
 * its coordinator id as the owner, reassigned at each session start (advisory
 * provenance tells a predecessor's findings apart by it). A reader that passes
 * no session takes every message. A skip records one ledger row per addressee.
 */
function addressedElsewhere(
	data: Partial<TurnEndFindingsCache>,
	sessionId: string | undefined,
	address: string | undefined = sessionId,
): string | undefined {
	if (sessionId === undefined) return undefined;
	const addressee =
		data.deliverTo !== undefined
			? data.deliverTo === address
				? undefined
				: data.deliverTo
			: data.sessionId !== undefined && data.sessionId !== sessionId
				? data.sessionId
				: undefined;
	if (addressee === undefined) return undefined;
	// Once per addressee, not per request: every request of the other session
	// skips the same message until its owner reads it.
	recordDegradationOnce({
		kind: "turn-end-delivery-addressed-elsewhere",
		subject: addressee,
		reason:
			"a staged turn-end message is addressed to another session; it waits for that session's next request",
	});
	return addressee;
}

/**
 * Read a turn-end finding without changing its durable delivery state.
 * `sessionId` and `address` name the reader (`addressedElsewhere`).
 */
export function peekTurnEndFindings(
	cacheManager: CacheManager,
	cwd: string,
	runtime?: RuntimeCoordinator,
	logDelivery = false,
	sessionId?: string,
	address?: string,
): ContextResult | undefined {
	const findings = cacheManager.readCache<Partial<TurnEndFindingsCache>>(
		"turn-end-findings",
		cwd,
	);
	if (!findings?.data?.content || findings.data.consumed === true) return;
	if (addressedElsewhere(findings.data, sessionId, address) !== undefined)
		return;
	const validation = validateAdvisoryProvenance(findings.data, cwd, runtime);
	if (logDelivery)
		logProvenanceDecision(
			validation,
			findings.data.provenance,
			"turn-end",
			cwd,
		);
	if (validation.allFilesDeleted) return;
	return {
		messages: [
			turnEndMessage(
				findings.data.content,
				validation.status === "current",
				findings.data.provenance,
			),
		],
	};
}

/**
 * #4943: `sessionId` is the reading request's session, and `address` the
 * address a message for it carries (`addressedElsewhere`). A message another
 * session's turn end composed (`deliverTo`), or the blocker text of a record
 * another session owns, is that session's: the read leaves it untouched for
 * that session's next request.
 */
export function consumeTurnEndFindings(
	cacheManager: CacheManager,
	cwd: string,
	runtime?: RuntimeCoordinator,
	sessionId?: string,
	address?: string,
	// #5240: a repeat record waits for a request that opens a prompt, and is
	// dropped once the reader's session holds no live blocker; every other
	// reader takes it as any message. pi's context hook says which.
	repeat: { atPromptTail: boolean; blockersLive: boolean } = {
		atPromptTail: true,
		blockersLive: true,
	},
): ContextResult | undefined {
	const findings = cacheManager.readCache<Partial<TurnEndFindingsCache>>(
		"turn-end-findings",
		cwd,
	);
	if (!findings?.data?.content || findings.data.consumed === true) return;
	if (addressedElsewhere(findings.data, sessionId, address) !== undefined)
		return;
	if (findings.data.repeat === true && !repeat.atPromptTail) return;
	const validation = validateAdvisoryProvenance(findings.data, cwd, runtime);
	logProvenanceDecision(validation, findings.data.provenance, "turn-end", cwd);
	settleStagedTurnEnd(cacheManager, cwd, findings.data);
	if (validation.allFilesDeleted) return;
	// Marked, fixed or retired since it was staged: nothing is left to repeat.
	if (findings.data.repeat === true && !repeat.blockersLive) return;
	const repeatBody =
		findings.data.repeat === true &&
		findings.data.content.startsWith(BLOCKER_REPEAT_HEADING)
			? {
					repeatBody: findings.data.content.slice(
						BLOCKER_REPEAT_HEADING.length + 2,
					),
				}
			: {};
	// #5532: this repeat is one more prompt told about the same set.
	const claim =
		findings.data.repeat === true
			? runtime?.claimBlockerRepeat(
					{ sessionId },
					BLOCKER_REPEAT_MAX_DELIVERIES,
				)
			: undefined;
	if (claim?.capped) {
		if (claim.capReached) {
			const subject = claim.files
				.map((file) => toRunnerDisplayPath(cwd, file))
				.sort()
				.join(", ");
			// Counted, once per set: the first capped prompt only (`capReached`).
			incrementDegradationCount({
				kind: "blocker-repeat-capped",
				subject: `inline-blocker-repeat:${subject}`,
				reason: `repeated in full on ${BLOCKER_REPEAT_MAX_DELIVERIES} prompts with no fix; later prompts get a one-line pointer, the blocker stays in lens_diagnostics and the commit gate`,
			});
		}
		return {
			messages: [
				{
					role: "user",
					content: `${AUTOMATION_FRAMING}${blockerRepeatCappedLine(claim.files.length)}`,
				},
			],
			...repeatBody,
		};
	}
	return {
		messages: [
			turnEndMessage(
				findings.data.repeat === true
					? `${findings.data.content}\n\n${blockerRepeatPointer()}`
					: findings.data.content,
				validation.status === "current",
				findings.data.provenance,
			),
		],
		...repeatBody,
	};
}

/**
 * A blocker record is also the opt-in commit gate's durable state. Mark the
 * context message consumed without deleting the record; clean/advisory-only
 * records retain the historical consume-and-clear behavior.
 */
function settleStagedTurnEnd(
	cacheManager: CacheManager,
	cwd: string,
	data: Partial<TurnEndFindingsCache>,
): void {
	if (data.hasBlockers === true && typeof data.sessionId === "string") {
		cacheManager.writeCache(
			"turn-end-findings",
			{ ...data, consumed: true },
			cwd,
		);
	} else {
		cacheManager.clearCache("turn-end-findings", cwd);
	}
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
					? `${AUTOMATION_FRAMING}${testFindingsCurrentPrefix(findings.data.runnerErrorOnly)}\n\n${findings.data.content}`
					: `${AUTOMATION_FRAMING}${historicalTestContent(findings.data.content, findings.data.provenance)}`,
			},
		],
	};
}

/**
 * #2522: a batch made entirely of RUNNER errors (timeout, missing
 * provider/binary — see `TestRunnerFindingsCache.runnerErrorOnly`) is not a
 * failure the agent introduced, so it must not read as a blocker the way a
 * genuine failing test does.
 */
function testFindingsCurrentPrefix(
	runnerErrorOnly: boolean | undefined,
): string {
	return runnerErrorOnly
		? "Test runner could not complete last turn (advisory — not a failure introduced this turn):"
		: "Test failures detected last turn — fix before continuing:";
}

/**
 * Retire a delivered test-findings record: blank the content, keep everything a
 * delivery does not settle.
 *
 * ONE function, called by both `consumeTestFindings` (the in-process context
 * hook) and `acknowledgeTestFindings` (the MCP Stop-hook commit), because
 * "what survives a retire" is exactly the kind of rule that rots when it is
 * stated twice. It already had: round 2 taught the consume copy to preserve
 * `deferredTargets` and left the acknowledge copy dropping them, and the
 * acknowledge copy is the LIVE Stop-hook path — including the branch where
 * `handleTurnEnd` never runs at all — so on that path the deferral set was
 * wiped before anything could ever dispatch it (#2522 review round 3, F2).
 *
 * What survives, and why:
 *  - `testRunGeneration` — nulling the slot would let a still-in-flight OLDER
 *    batch read `undefined`, pass the strictly-greater suppression check, and
 *    resurrect a consumed one-shot advisory with stale results.
 *  - `deferredTargets` — delivering the advisory says the agent has SEEN the
 *    deferral, not that those targets ran. Dropping the list silently un-defers
 *    them and the cut batch is never finished.
 *  - `retiredTargets` — the session-scoped deferral cap. Dropping it re-arms a
 *    suite already measured as too slow for the batch budget, which puts the
 *    livelock back.
 *
 * An empty-content record peeks as undelivered while keeping all three intact.
 */
function retireTestFindings(cacheManager: CacheManager, cwd: string): void {
	const prior = cacheManager.readCache<TestRunnerFindingsCache>(
		"test-runner-findings",
		cwd,
	)?.data;
	cacheManager.writeCache(
		"test-runner-findings",
		{
			content: "",
			testRunGeneration: prior?.testRunGeneration,
			deferredTargets: prior?.deferredTargets,
			retiredTargets: prior?.retiredTargets,
		} as TestRunnerFindingsCache,
		cwd,
	);
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
	retireTestFindings(cacheManager, cwd);
	return findings;
}

/**
 * Complete an acknowledged MCP delivery without re-validating or re-rendering
 * it. #4943: only a message still addressed to the reader that peeked it; one
 * a pi turn end staged since is left for its session.
 */
export function acknowledgeTurnEndFindings(
	cacheManager: CacheManager,
	cwd: string,
	sessionId?: string,
	address?: string,
): void {
	const findings = cacheManager.readCache<Partial<TurnEndFindingsCache>>(
		"turn-end-findings",
		cwd,
	);
	if (!findings?.data?.content || findings.data.consumed === true) return;
	if (addressedElsewhere(findings.data, sessionId, address) !== undefined)
		return;
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
	retireTestFindings(cacheManager, cwd);
}

export function consumeSessionStartGuidance(
	cacheManager: CacheManager,
	cwd: string,
	host: LensToolHost = "pi",
): ContextResult | undefined {
	const guidance = cacheManager.readCache<{ content: string }>(
		"session-start-guidance",
		cwd,
	);
	if (!guidance?.data?.content) return;

	// Consume by writing empty guidance, not by casting `null` into the entry's
	// own type. `writeCache` infers its type parameter from `data`, so the cast
	// bought nothing and claimed the file held a `{ content: string }` when it
	// held JSON `null`. The producer (`runtime-session.ts`) always writes
	// `{ content }`, and this reader gates on `data?.content` being non-empty,
	// so an empty string is the same "already consumed" signal with the type
	// the entry actually has. Same idiom as `acknowledgeTestFindings` above.
	cacheManager.writeCache("session-start-guidance", { content: "" }, cwd);

	return {
		messages: [
			{
				role: "user",
				// #2535: the stored guidance names pi tools; MCP agents receive
				// the registry-translated rendering. The stored record keeps
				// its shape — resolution happens here, at delivery.
				content: `[pi-lens automated context — not a user request]\n\n${translateGuidanceToolNames(guidance.data.content, host)}`,
			},
		],
	};
}
