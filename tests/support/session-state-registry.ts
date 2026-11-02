/**
 * Session-state lifecycle registry — #1635 item 2.
 *
 * Eight bugs in the #1266–#1625 arc are one defect: state whose contract is
 * "durable for a SESSION" living in a process-lifetime container, with a reset
 * function that either nobody calls at `session_start` or that no test proves
 * re-arms anything. `#1266` (install-failure suppression), `#1490`/`#1540`
 * (PSScriptAnalyzer latches), `#1497` (install-retry ceiling), `#1535` (zizmor
 * token), `#1537` (lazy-install hold), `#1570` (classic-TS repair guard),
 * `#1618` (workspace sweep hold), `#1625` (deferred dispositions) — each was
 * found in production, one at a time, by a human noticing a tool stayed off.
 *
 * This registry makes that class checkable instead of noticeable. Every entry
 * declares:
 *
 * - WHERE the state lives (module + symbol), so a reader can go look;
 * - WHAT its reset policy is (`session_start`, `turn_end`, `process_lifetime`);
 * - WHICH exported reset implements that policy;
 * - and optionally a PROBE — arm the state, then prove the reset disarms it.
 *
 * `tests/clients/session-state-conformance.test.ts` then checks three things
 * the registry alone cannot assert:
 *
 * 1. every `session_start` entry's reset is genuinely reachable from
 *    `handleSessionStart` (DERIVED by `sessionStartResetNames()`, never a
 *    hand-copied list — that derivation is the whole point);
 * 2. every declared GAP is still a real gap, so a fix landing upstream turns
 *    the stale declaration red instead of leaving a lie in the file;
 * 3. every file the sweep flags as session-state-shaped is either registered
 *    or exempted with a reason.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	_boundedTurnCountForTest,
	admitBounded,
	resetBoundedTelemetry,
} from "../../clients/bounded-telemetry.js";
import {
	getLastLiveMessageEndSessionId,
	noteLiveMessageEndSessionId,
	resetMessageEndAttribution,
	rotateMessageEndAttribution,
} from "../../clients/message-end-attribution.js";
import {
	getDegradationSummary,
	recordDegradationOnce,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import {
	getPathIdentityFallbacks,
	realpathOrResolve,
	resetPathIdentityFallbacks,
} from "../../clients/path-utils.js";
import {
	_analyzerBootstrapFailureStrikes as analyzerBootstrapStrikes,
	_armAnalyzerBootstrapLatchForTests as armAnalyzerBootstrapLatch,
	isAnalyzerBootstrapShutdown,
	markAnalyzerBootstrapShutdown,
	resetAnalyzerBootstrapSessionState,
} from "../../clients/bootstrap.js";
import {
	abortDeferredLspWork,
	armDeferredLspWork,
	isDeferredLspWorkArmed,
} from "../../clients/deferred-lsp-work.js";
import {
	lookupLearnedMutatingTool,
	noteObservedMutation,
	resetMutationAttribution,
} from "../../clients/mutation-attribution.js";
import {
	_observedMutationStateForTests,
	noteMutationHandled,
	resetObservedMutationNet,
} from "../../clients/observed-mutation.js";
import {
	acquireWorkspaceSweepHold,
	clearWorkspaceSweepHoldForSessionStart,
	isWorkspaceSweepActive,
} from "../../clients/lsp/workspace-sweep-hold.js";
import {
	_getCascadeTierSweepCountersForTests,
	_getOutstandingCascadeTouchesForTests,
	recordOutstandingCascadeTouch,
	resetCascadeTierSessionState,
} from "../../clients/lsp/cascade-tier.js";
import {
	_getPosixCaseSensitivityCacheSizeForTests,
	isSameOrWithin,
	resetLSPCaseSensitivityState,
} from "../../clients/lsp/server.js";
import {
	hasAnyDispositionMarks,
	isDeferredThisSession,
	markDisposition,
	resetDeferredDispositions,
} from "../../clients/diagnostic-dispositions.js";
import {
	_getReverseDepsIndexCacheKeysForTests,
	_seedReverseDepsIndexCacheForTests,
	clearReverseDepsIndexCache,
} from "../../clients/dispatch/integration.js";
import {
	classifyObservedRunner,
	observeRunnerLatency,
	resetObservedRunnerLatency,
} from "../../clients/dispatch/collect-later-tier.js";
import {
	deferRunnerFindings,
	pendingRunnerFindingsSize,
	resetPendingRunnerFindings,
} from "../../clients/dispatch/pending-runner-findings.js";
import type { RunnerResult } from "../../clients/dispatch/types.js";
import {
	createAvailabilityLatch,
	resetInstallRetryLatches,
} from "../../clients/dispatch/runners/utils/availability-policy.js";
import {
	managedToolRefreshesThisSession,
	reserveManagedToolRefreshSlot,
	resetManagedToolRefreshSession,
} from "../../clients/installer/managed-tool-refresh-session.js";
import {
	getSharedTreeSitterClient,
	resetTreeSitterClientLoadState,
} from "../../clients/tree-sitter-shared.js";
import {
	noteWorkspaceFileCreated,
	resetWorkspaceDiagnosticsCacheSession,
	workspaceDiagnosticsCacheSessionStart,
	workspaceFileCreatedAtFor,
} from "../../clients/lsp/workspace-diagnostics-session.js";
import {
	noteAtomicReplace,
	notePathAppeared,
	pathBirthtimeMs,
	resetPathBirthForTests,
} from "../../clients/path-birth.js";
import { removeTempDirSync } from "../clients/test-utils.js";
import { clearFormatterCache } from "../../clients/formatters.js";
import * as formattersModule from "../../clients/formatters.js";
import { resetZizmorTokenAvailability } from "../../clients/zizmor-config.js";
import * as zizmorConfigModule from "../../clients/zizmor-config.js";
import {
	isInSpawnTimeoutCooldown,
	noteSpawnTimeout,
	resetSpawnTimeoutCooldowns,
} from "../../clients/spawn-timeout-cooldown.js";
import {
	consumeHostReadyDelayAnchor,
	resetHostReadyDelayAnchorForTests,
} from "../../clients/startup-timing.js";
import {
	isOutsideAllSessionRoots,
	registerSessionRoot,
	resetSessionRootsForTests,
} from "../../clients/lsp/session-roots.js";
import {
	_lspMutationNoBridgeDbgLoggedForTests,
	recordLspMutation,
	resetLspMutationNoBridgeDbgLatch,
	type LspMutationContext,
} from "../../clients/lsp-mutation.js";
import {
	_getSituationalToolTelemetryStateForTests,
	emitSituationalDeadWeight,
	observeSituationalToolActivation,
	observeSituationalToolCall,
	resetSituationalToolTelemetry,
} from "../../clients/situational-tool-telemetry.js";

/**
 * When a piece of state must return to its initial value.
 *
 * `process_lifetime` is a legitimate answer — a memo of what the HOST looks
 * like does not change because the agent started a new session. It just has to
 * be stated, because "I meant it to be process-lived" and "I forgot to wire the
 * reset" are indistinguishable from the outside, and that ambiguity is the
 * whole defect class.
 */
type SessionResetPolicy = "session_start" | "turn_end" | "process_lifetime";

/**
 * #4965 (defect shape 72): WHO the state answers for, which is not the same
 * question as when it resets. Derived from the store's code, never from its
 * reset policy:
 *
 * - `session`: what one conversation was told or did (a delivered-once mark, a
 *   turn counter, a pending delivery), whatever the store's key is. A process
 *   container that holds it states in `sessionSeamException` why a scope cell
 *   (`scopeCell`, `clients/session-scope.ts`, #3609) cannot hold it yet; a
 *   store that is on a scope cell has no process container and no entry.
 * - `repository`: the answer is about a git repository root.
 * - `project`: the answer is about a project root or working directory.
 * - `process-wide: <reason>`: one answer for the whole process, such as a fact
 *   about this machine or the shared LSP pool.
 *
 * `auditOwnerKeys` (session-state-scan.ts) admits these and refuses the rest.
 */
export type OwnerKey =
	| "session"
	| "repository"
	| "project"
	| `process-wide: ${string}`;

/**
 * A file the sweep flags that the registry deliberately does not cover (#5027):
 * who the file's state answers for, and why that is not session state that
 * must re-arm. A file with several owners states the narrowest: `session`, then
 * `repository`, then `project`, then `process-wide`. A `session` owner states
 * `sessionSeamException`, and `auditOwnerKeys` refuses a row without one: a
 * process container says why a scope cell cannot hold it yet, a class field
 * names the instance that holds it.
 */
export interface SessionStateExemption {
	ownerKey: OwnerKey;
	sessionSeamException?: string;
	reason: string;
}

/** Arm the state, then check whether it is back in its post-reset shape. */
interface SessionStateProbe {
	/** Put the state into a dirty, definitely-not-reset condition. */
	arm(): void;
	/** True when the state is in its initial, re-armed condition. */
	isArmed(): boolean;
	/** Run the entry's reset. Separate from `arm` so the test can order them. */
	reset(): void;
}

export interface SessionStateEntry {
	/** Stable id, used in failure output. */
	id: string;
	/** `clients/`-relative posix path of the module that owns the state. */
	module: string;
	/** The declaration(s) this entry covers, by name. */
	state: string;
	policy: SessionResetPolicy;
	/** Who the state answers for (#4965); see {@link OwnerKey}. */
	ownerKey: OwnerKey;
	/**
	 * Retired (#4965 r2): a scope-cell store has no entry. Typed so the audit can
	 * refuse it; no entry sets it.
	 */
	sessionSeam?: never;
	/**
	 * `session` owners only: why a scope cell cannot hold the store yet. Each
	 * one is a shape 72 member: the change that moves it deletes the entry.
	 */
	sessionSeamException?: string;
	/**
	 * The exported reset that implements `policy`. For state cleared by a
	 * METHOD call (`sessionFacts.clearAll()`), name the exported function that
	 * ENCLOSES the call — that is the seam a caller can actually reach, and the
	 * one the static reachability walk can see.
	 */
	resetName: string;
	/** Optional session-start transition when the full reset is not the boundary operation. */
	sessionStartResetName?: string;
	/** Why this policy is the right one. One sentence, in the author's words. */
	reason: string;
	/**
	 * Set when `policy` is `session_start` but `resetName` is NOT wired into
	 * `handleSessionStart` today. The value states the gap and names the issue
	 * or PR that closes it. The conformance test asserts the gap is still real,
	 * so this cannot rot into a false claim after the fix lands.
	 */
	gap?: string;
	/**
	 * Set when `policy` is `session_start` and `resetName` runs inside
	 * `index.ts`'s `pi.on("session_start", ...)` CLOSURE rather than inside
	 * `handleSessionStart`'s reachable call graph — #2319. The conformance test
	 * checks the reset against {@link sessionStartClosureResetNames} (derived
	 * from that closure), an exact mirror of the `sessionStartResetNames` walk
	 * every other entry is checked against. Use ONLY when the reset's placement
	 * is load-bearing (behind the #473 concurrent-secondary gate but outside
	 * `handleSessionStart`'s own body, or before it runs): `resetCurrentPhaseForSession`
	 * is the canonical precedent (#1723 review F4), and the two rollup counters
	 * that must never self-reset from a declined bind's own `session_start`
	 * inherit the same gate placement.
	 */
	sessionStartClosureReset?: boolean;
	/** Optional runtime proof that the reset re-arms the state. */
	probe?: SessionStateProbe;
}

/** Throwaway cwds a probe created, removed by {@link _resetRegistryProbeState}. */
const scratchDirs: string[] = [];
let observedRunnerProbeRoot: string | undefined;

/** Throwaway cwd for probes that need a project root on disk. */
function scratchCwd(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-session-state-"));
	scratchDirs.push(dir);
	return dir;
}

/**
 * #3609 §3.8 item 1 (#3612): the state declared as a session store
 * (`defineSessionStore` in `clients/session-scope.ts`), by store name. A
 * store's transition behaviour is its declared policy, not a reset, so it has
 * no `SESSION_STATE_REGISTRY` row. `tests/config/session-scope-sweep.test.ts`
 * diffs this table both ways against the declared stores.
 */
export const SESSION_STORE_REGISTRY: Readonly<
	Record<string, { module: string; state: string; ownerKey: OwnerKey }>
> = {
	"agent-advisories": {
		module: "agent-nudge.ts",
		state: "the scope's queued, undelivered agent advisories (_advisories)",
		ownerKey: "session",
	},
	"lazy-tool-memory": {
		module: "tool-set-policy.ts",
		state: "a per-scope Set of the lazy tools the conversation activated",
		ownerKey: "session",
	},
	"read-guard": {
		module: "read-guard-branch.ts",
		state:
			"the reads of the ReadGuard bound to the scope (RuntimeCoordinator._readGuard)",
		ownerKey: "session",
	},
	"read-guard-authorship": {
		module: "read-guard-branch.ts",
		state: "the ReadGuard's writtenThisSession",
		ownerKey: "session",
	},
	widget: {
		module: "widget-state.ts",
		state: "the widget's files and sessionLanguages",
		ownerKey: "session",
	},
};

/**
 * #4965 (#3609): the census of the session-scope seam, pinned both ways against
 * `scanScopeCellKeys()`: per file, one token per `scopeCell` / `sessionCell`
 * use (the cell key, or `ident:NAME` for an imported constant). A moved store
 * adds its cell here and loses its `SESSION_STATE_REGISTRY` entry; a spelling
 * the scan cannot read (`?...`) never matches, so it reds until it is read.
 * Cells, by store:
 *
 * - `cache-observability`: `clients/cache-observability.ts` (attribution state,
 *   `messages[0]` baseline hash)
 * - `memory-turn-end`: `clients/memory-sampler.ts` (a session's pending turn end)
 * - `turn-warnings`: `clients/runtime-coordinator.ts` (per-turn actionable and
 *   code-quality warnings; two uses, one for the coordinator's own scope, one
 *   for a concurrent session found by id)
 * - `read-guard`, `lazy-tool-memory`, `dead-code-late-scans`,
 *   `knip-carried-files`: the declared stores and turn-end cells of #3609
 */
export const SESSION_CELL_KEYS: Readonly<Record<string, readonly string[]>> = {
	"clients/cache-observability.ts": ["cache-observability"],
	"clients/memory-sampler.ts": ["memory-turn-end", "memory-turn-end"],
	"clients/read-guard-branch.ts": ["read-guard"],
	"clients/runtime-coordinator.ts": ["turn-warnings", "turn-warnings"],
	"clients/runtime-turn.ts": ["dead-code-late-scans", "knip-carried-files"],
	"clients/tool-set-policy.ts": ["lazy-tool-memory"],
	"index.ts": ["ident:READ_GUARD_CELL"],
};

export const SESSION_STATE_REGISTRY: SessionStateEntry[] = [
	{
		id: "ast-grep-napi:loadState",
		module: "dispatch/runners/ast-grep-napi.ts",
		state: "defaultUnsupportedLanguageLog, the NAPI load latch",
		policy: "session_start",
		ownerKey: "session",
		sessionSeamException:
			"defaultUnsupportedLanguageLog is a process Set keyed by language id that records which unsupported-language notice the agent was shown, so a second live session shares its marks; the native addon load result in this entry is a process fact, and the notice is the session-owned half (#4972 review F3)",
		resetName: "resetAstGrepUnsupportedLanguageLog",
		reason:
			"A failed native-module load is evidence about one moment, and the unsupported-language log is a once-per-session notice.",
	},
	{
		id: "availability-policy:installRetryLatches",
		module: "dispatch/runners/utils/availability-policy.ts",
		state: "installRetryGeneration (and each latch's install-class state)",
		policy: "session_start",
		ownerKey:
			"process-wide: whether a tool can be installed is a fact about this machine, held on bootstrap-built clients",
		resetName: "resetInstallRetryLatches",
		reason:
			"#1497: the install-retry ceiling is terminal for a SESSION, but the latches holding it live on bootstrap-built client instances — without this the ceiling is terminal for the process and a repaired network never re-earns its install.",
		probe: {
			arm: () => {
				const latch = createAvailabilityLatch();
				probeLatch = latch;
				// Escalate on the install ladder until the session ceiling latches.
				for (let i = 0; i < 12 && !latch.isInstallExhausted(); i++) {
					latch.noteUnavailable("transient", "probe-timeout", {
						operationClass: "install",
					});
				}
			},
			isArmed: () =>
				probeLatch === undefined || !probeLatch.isInstallExhausted(),
			reset: () => resetInstallRetryLatches(),
		},
	},

	// ── Deliberately not session_start ───────────────────────────────────────
	{
		id: "biome-check:fixKindCache",
		module: "dispatch/runners/biome-check.ts",
		state: "biomeFixKindCache",
		policy: "process_lifetime",
		ownerKey:
			"process-wide: a static property of one biome binary, keyed by binary path and rule name",
		resetName: "_resetBiomeFixKindCacheForTests",
		reason:
			"#1810: the cache maps (biome binary path, rule name) to that rule's real fix tier, read live from `biome explain <rule>`. That answer is a static property of the running binary — it cannot change without a different biome install, which is itself a different cache key — so there is nothing for a session boundary to invalidate. No probe: arming it for real requires spawning the actual biome binary, which this generic registry sweep does not do; `tests/clients/dispatch/runners/biome-check-runner.test.ts`'s dedicated cache/reset tests cover the re-arm behavior with a mocked spawn instead.",
	},
	{
		id: "bootstrap:failure-latch",
		module: "bootstrap.ts",
		state: "bootstrapFailureStrikes",
		policy: "session_start",
		ownerKey:
			"process-wide: whether the analyzer modules load is a fact about this environment, not about one session",
		resetName: "resetAnalyzerBootstrapSessionState",
		reason:
			"#2467 review: after BOOTSTRAP_FAILURE_STRIKE_LIMIT consecutive failed builds the seam stops rebuilding, so a permanently unresolvable analyzer module no longer re-runs seventeen dynamic imports plus collectInstallDiagnostics on every tool call. That verdict is about an ENVIRONMENT, and an environment is repaired between sessions (a dependency installed, a package layout fixed) — held process-wide without a session_start reset it would write the analyzers off for the life of the process, which is defect shape 17 exactly.",
		probe: {
			arm: () => armAnalyzerBootstrapLatch(),
			isArmed: () => analyzerBootstrapStrikes() === 0,
			reset: () => resetAnalyzerBootstrapSessionState(),
		},
	},
	{
		id: "bootstrap:shutdown-gate",
		module: "bootstrap.ts",
		state: "bootstrapShutdown",
		policy: "session_start",
		ownerKey:
			"process-wide: the gate for the one shared analyzer-bootstrap flight, set by the departing primary's teardown and re-armed by the replacement's session_start; it holds no session's data",
		resetName: "resetAnalyzerBootstrapSessionState",
		reason:
			"#2467: the analyzer bootstrap refuses NEW loads once the primary session has torn down, which is a per-SESSION claim held in process-lived storage — without a session_start reset a replacement session in the same process would find every analyzer refused for the rest of the process (defect shape 17). The resident clients themselves are deliberately NOT dropped: they are stateless constructions whose session-scoped latches are re-armed by their own registered resets (resetInstallRetryLatches, #1497), so re-paying the seventeen-module load at every session boundary would cost the interactive path for nothing.",
		probe: {
			arm: () => markAnalyzerBootstrapShutdown(),
			isArmed: () => !isAnalyzerBootstrapShutdown(),
			reset: () => resetAnalyzerBootstrapSessionState(),
		},
	},
	// ── #1743 bounded-telemetry helper ───────────────────────────────
	{
		id: "bounded-telemetry:turnCounts",
		module: "bounded-telemetry.ts",
		state: "turnCounts, countedTurnIndex",
		policy: "session_start",
		ownerKey: "session",
		sessionSeamException:
			"keyed by turn key (RuntimeCoordinator.turnKey, one number per session turn), not by session id; one process table that session_start clears whole (shape 72 member, no open issue)",
		resetName: "resetBoundedTelemetry",
		reason:
			"#1743: the per-turn admission counters are keyed by turn index, and a new session restarts turn numbering at 0, so without a session-boundary clear a count from the previous session's turn 0 would consume the new session's budget. The helper's rising-edge state is deliberately NOT here — it is the degradation ledger's own tally, reset one line above this one in handleSessionStart.",
		probe: {
			arm: () => {
				admitBounded("loop_block", "session-state-registry-probe", {
					capPerTurn: { limit: 1, turnIndex: 0 },
				});
			},
			isArmed: () => _boundedTurnCountForTest("loop_block") === 0,
			reset: () => resetBoundedTelemetry(),
		},
	},
	{
		id: "cascade-format:cascadeUnansweredPrimariesDelivered",
		module: "cascade-format.ts",
		state: "cascadeUnansweredPrimariesDelivered",
		policy: "session_start",
		ownerKey: "session",
		sessionSeamException:
			"one process Set keyed by language-server id that records what the agent was told; a second live session shares its marks (shape 72 member, no open issue)",
		resetName: "resetCascadeUnansweredPrimariesDelivered",
		reason:
			"#4403: the primaries whose cascade 'no language server answered' line reached this session's agent; the next session's agent has not been told.",
	},
	{
		id: "cascade-format:pendingNeighbors",
		module: "cascade-format.ts",
		state: "pendingNeighbors",
		policy: "session_start",
		ownerKey: "session",
		sessionSeamException:
			"one process BoundedFifoMap keyed by normalized file path, with no session in the key; it records what the agent was shown (shape 72 member, no open issue)",
		resetName: "resetCascadePendingNeighbors",
		reason:
			"#4487: cascade neighbour errors this session's agent was shown and no later observation cleared; the next session's agent was never shown them, and the tree may have changed between sessions.",
	},
	{
		id: "cascade-tier:outstandingTouches",
		module: "lsp/cascade-tier.ts",
		state:
			"_outstandingTouches, _expiredSinceLastSweep, _evictedSinceLastSweep",
		policy: "session_start",
		ownerKey: "session",
		sessionSeamException:
			"one process BoundedFifoMap keyed by normalized file path, with no session in the key; a reconcile answers whichever session drains it (shape 72 member, no open issue)",
		resetName: "resetCascadeTierSessionState",
		reason:
			"#1910: the tier-3 cascade outstanding-touch registry and its sweep-scoped expired/evicted counters are a per-SESSION claim about touches THIS session fired. #1899 bounded the registry between sweeps but, by its own review, left the session boundary unwired — a session replacement inherited the prior session's outstanding touches, and a stray eviction/expiry landing between a sweep and the boundary attributed its count to the next session's first reconcile gauge. Previously the whole file was blanket-exempted (#1909 review F4: 'cascade-tier registration and outstanding-touch bookkeeping'); this entry replaces that blanket claim with the real reset now that one exists. `_reconcileTaskRegistered` and the `_enabledCache` kill-switch memo are deliberately still NOT covered by a reset — the former is idempotent quiet-window-task registration (same shape as the other publisher-registration exemptions in this file), and the latter is a memo of the `PI_LENS_TIER_AWARE_CASCADE` env var, unaffected by a session boundary.",
		probe: {
			// Arms all THREE pieces of state the reset claims to cover, not just
			// the map: an ancient touch trips the age prune (bumps `expired` on
			// the next record), and CAP+1 fresh touches trip the size cap (bumps
			// `evicted`). A probe that only checked the map would stay green if a
			// future counter were added and left out of the reset — this one
			// would not (review round, F2).
			arm: () => {
				const base = Date.now();
				recordOutstandingCascadeTouch({
					filePath: "/probe/session-state-registry-ancient.ts",
					serverId: "session-state-registry-probe",
					// Mirrors OUTSTANDING_TOUCH_MAX_AGE_MS in clients/lsp/cascade-tier.ts.
					touchedAt: base - 15 * 60_000 - 1,
				});
				// Mirrors MAX_OUTSTANDING_TOUCHES in clients/lsp/cascade-tier.ts; the
				// (CAP + 1)th record both prunes the ancient entry above and evicts
				// the oldest surviving one.
				const CAP = 256;
				for (let i = 0; i <= CAP; i++) {
					recordOutstandingCascadeTouch({
						filePath: `/probe/session-state-registry-f${i}.ts`,
						serverId: "session-state-registry-probe",
						touchedAt: base - CAP + i,
					});
				}
			},
			isArmed: () => {
				const counters = _getCascadeTierSweepCountersForTests();
				return (
					_getOutstandingCascadeTouchesForTests().length === 0 &&
					counters.expired === 0 &&
					counters.evicted === 0
				);
			},
			reset: () => resetCascadeTierSessionState(),
		},
	},
	{
		id: "collect-later-tier:observedRunners",
		module: "dispatch/collect-later-tier.ts",
		state: "slowRunners",
		policy: "session_start",
		ownerKey: "project",
		resetName: "resetObservedRunnerLatency",
		reason:
			"#2116: observed slow-runner decisions are scoped to the current session because a new session must re-probe its project environment rather than inherit a process-lifetime collect-later latch.",
		probe: {
			arm: () => {
				observedRunnerProbeRoot = scratchCwd();
				observeRunnerLatency({
					projectRoot: observedRunnerProbeRoot,
					runnerId: "session-state-probe",
					durationMs: 5_001,
				});
			},
			isArmed: () =>
				classifyObservedRunner(
					observedRunnerProbeRoot ?? "<missing>",
					"session-state-probe",
				) === "inline",
			reset: () => resetObservedRunnerLatency(),
		},
	},
	{
		id: "deferred-lsp-work:handle",
		module: "deferred-lsp-work.ts",
		state: "deferredController, deferredWork",
		policy: "session_start",
		ownerKey:
			"process-wide: shared LSP pool: one slot for the pull that still talks to the shared LSP service, aborted when that service resets",
		resetName: "resetLSPService",
		reason:
			"#2504 review round 2 (F3): the slot holds the off-hook actionable-warnings pull that is still talking to the LSP service after turn_end returned. Its lifetime is exactly the service's, so it is retired through the same seam — resetLSPService aborts it before any teardown and before the no-live-service early return, which is how session_shutdown, session_start and the idle reset all reach it. A session_start that left the previous session's loop running would have it opening documents against a service the new session just replaced; that is defect shape 17 with an LSP client attached. Round 3 removed the unused _resetDeferredLspWorkForTests export (S-1), which was the file's only Signal-B hit, so the scan no longer flags it and it carries no SESSION_STATE_SYMBOL_COUNTS row; this hand-written entry and its probe are its coverage.",
		probe: {
			arm: () => {
				armDeferredLspWork();
			},
			isArmed: () => !isDeferredLspWorkArmed(),
			reset: () => abortDeferredLspWork("session-state-registry-probe"),
		},
	},
	// ── The named population from #1635 ──────────────────────────────────────
	{
		id: "degradation-ledger:onceKeys",
		module: "degradation-ledger.ts",
		state: "onceKeys, groups, tallies",
		policy: "session_start",
		ownerKey: "session",
		sessionSeamException:
			"one process Set, Map and tally keyed by degradation subject; the once-per-session rows hold for the primary alone (shape 72 member, no open issue)",
		resetName: "resetDegradationLedger",
		reason:
			"A once-per-session degradation notice that survives the session tells the next session's agent nothing happened when it did.",
		probe: {
			arm: () =>
				recordDegradationOnce({
					kind: "runner-unavailable",
					subject: "session-state-registry-probe",
					reason: "armed by the #1635 conformance probe",
					// biome-ignore lint/suspicious/noExplicitAny: the kind union is
					// owned by the ledger; the probe only needs a valid member.
				} as any),
			isArmed: () => getDegradationSummary().length === 0,
			reset: () => resetDegradationLedger(),
		},
	},
	{
		id: "diagnostic-dispositions:deferredThisSession",
		module: "diagnostic-dispositions.ts",
		state: "deferredByCwd",
		policy: "session_start",
		ownerKey: "session",
		sessionSeamException:
			"deferredByCwd holds one session's `defer` marks (a mark suppresses a diagnostic for THIS session by design) keyed by cwd with no session in the key, so a secondary in the same cwd defers for the primary (#4972 review F3 probe: the primary sees the subagent's defer)",
		resetName: "resetDeferredDispositions",
		reason:
			"A `defer` mark suppresses a diagnostic for THIS session by design; carrying it into the next session hides a finding nobody deferred. #4701 F1 wired the reset #1625's gap declared missing: `resetDeferredDispositions` clears the anchor Set and the project index beside it, and `resetSessionScopedState` (reached from `handleSessionStart`) calls it.",
		probe: {
			arm: () => {
				const cwd = scratchCwd();
				probeDeferredCwd = cwd;
				probeDeferredAnchor = markDisposition(
					cwd,
					{
						cwd,
						filePath: path.join(cwd, "probe.ts"),
						rule: "session-state-probe",
						message: "armed by the #1635 conformance probe",
						line: 1,
					},
					"defer",
					"conformance probe",
				);
			},
			isArmed: () => probeDeferredAnchor === undefined || !probeIsDeferred(),
			reset: () => resetDeferredDispositions(),
		},
	},
	{
		id: "dispatch-integration:reverseDepsIndexCache",
		module: "dispatch/integration.ts",
		state: "reverseDepsIndexCache",
		policy: "session_start",
		ownerKey: "project",
		resetName: "clearReverseDepsIndexCache",
		reason:
			"A reverse-dependency index is a snapshot of a tree the next session may open at a different revision.",
		probe: {
			arm: () =>
				_seedReverseDepsIndexCacheForTests(
					"session-state-registry-probe",
					{
						projectRoot: "/probe",
						generatedAt: "now",
						imports: {},
						importedBy: {},
						source: "review-graph",
					},
					1,
				),
			isArmed: () => _getReverseDepsIndexCacheKeysForTests().length === 0,
			reset: () => clearReverseDepsIndexCache(),
		},
	},
	{
		id: "dispatch-integration:sessionCaches",
		module: "dispatch/integration.ts",
		state:
			"primaryFilesThisTurn, sessionSlopRuleCounts, sessionFacts, preEditCaptureFacts",
		policy: "session_start",
		ownerKey: "session",
		sessionSeamException:
			"FactStore keeps one process-wide session-fact map and file-fact map keyed by fact id and path, plus per-process slop counters, with no session in any key (shape 72 member, no open issue)",
		resetName: "resetDispatchBaselines",
		reason:
			"Every one of these is a claim about the tree as this session found it; `sessionFacts` and `preEditCaptureFacts` (#4483) are cleared by a method call inside this same reset, so the reset is the registered seam.",
	},
	{
		id: "dispatcher:coverageNoticeSeen",
		module: "dispatch/dispatcher.ts",
		state: "coverageNoticeSeen, generatedSkipRecorded",
		policy: "session_start",
		ownerKey: "session",
		sessionSeamException:
			"one process Set keyed by notice kind, file path and server set; a notice one session heard is withheld from a second live session (shape 72 member, no open issue)",
		resetName: "clearCoverageNoticeState",
		reason:
			"A once-per-session coverage notice must be sayable again to the next session's agent; `generatedSkipRecorded` (refs #2346) rides the same reset so a generated file's `dispatch_skipped_generated` record is emitted for the new session's dispatches of that file, not silently withheld because an older session already logged it.",
	},
	{
		id: "file-utils:pendingDataDirMigrations",
		module: "file-utils.ts",
		state: "pendingDataDirMigrations",
		policy: "session_start",
		ownerKey: "session",
		sessionSeamException:
			"one process array capped at 32 that holds migration notices for the session that resolved the data directory; a second live session could drain them (shape 72 member, no open issue)",
		resetName: "resetProjectDataDirSessionState",
		reason:
			"Migration notices belong to the session that resolves the project data directory; clearing the bounded queue at session_start prevents a prior session's migration from being emitted again.",
	},
	{
		id: "formatters:runtimeState",
		module: "formatters.ts",
		state: "detectionCache",
		policy: "turn_end",
		ownerKey: "project",
		resetName: "clearFormatterRuntimeState",
		reason:
			"Formatter resolution is re-derived every turn through `resetFormatService()`; #1537's note explains why the lazy-install hold specifically must NOT ride this turn-scoped reset.",
	},
	{
		id: "formatters:whichLatches",
		module: "formatters.ts",
		state:
			"whichLatchByCommand, whichTransientCommands, cooldownRecordedForRetryAtMs, formatterSignatureFlights (cleared together with detectionCache)",
		policy: "session_start",
		ownerKey:
			"process-wide: formatter availability on PATH is a fact about this machine, keyed by command",
		resetName: "clearFormatterCache",
		reason:
			"#1895: formatter PATH availability is session-scoped, but these module-local latches are not covered by the dispatch availability generation. A formatter installed or removed between sessions must be re-probed. The reset is `clearFormatterCache`, not the latch clear alone: `getFormattersForFile` answers a same-cwd lookup from `detectionCache` before it reaches a `which` probe, so dropping the latches without the selection cache re-arms every directory except the working one (review round on PR #1896).",
		probe: {
			// Arms all FIVE pieces of state the reset claims to cover — the three
			// latch maps AND the selection cache. A probe that armed only the
			// latches would stay green if a future cache were added and left out
			// of `clearFormatterCache`; that omission is precisely the #1895 bug.
			arm: () => {
				const ns = getFormattersInternals();
				ns.whichLatchByCommand.set("pi-lens-probe-cmd", {
					latch: createAvailabilityLatch({ maxCooldownMs: 1_000 }),
					resolved: null,
				});
				ns.whichTransientCommands.add("pi-lens-probe-transient");
				ns.cooldownRecordedForRetryAtMs.set("pi-lens-probe-cmd", Date.now());
				ns.detectionCache.set("/pi-lens-probe-cwd", {
					signature: "session-state-registry-probe",
					trustGeneration: 0,
					entries: new Map(),
				});
				ns.formatterSignatureFlights.set("/pi-lens-probe-cwd", {
					promise: Promise.resolve("session-state-registry-probe"),
				});
			},
			isArmed: () => {
				const ns = getFormattersInternals();
				return (
					ns.whichLatchByCommand.size === 0 &&
					ns.whichTransientCommands.size === 0 &&
					ns.cooldownRecordedForRetryAtMs.size === 0 &&
					ns.detectionCache.size === 0 &&
					ns.formatterSignatureFlights.size === 0
				);
			},
			reset: () => clearFormatterCache(),
		},
	},
	// ── #2455: GoClient/RustClient's own availability latches ─────────────────
	// Found by hand while auditing what the widened predicate SHOULD have
	// covered, not by the widened predicate itself. #2455 fix round 3, F4
	// corrects the causal claim an earlier draft of this comment made: the
	// sweep skips any file that exports no reset at all (`session-state-scan.ts`:
	// `if (resets.length === 0) continue`), and on master no file in this chain
	// exported one — so however wide the container predicate got, none of them
	// could yield a candidate. They became visible to the sweep only because
	// #2455 added `resetGoAvailability`/`resetRustAvailability`, i.e. the reset
	// came first and the visibility followed. The pair-with-reset gate is
	// MISS 3 in `SWEEP_HEURISTIC_LIMITS` ("state with no reset seam at all")
	// and #2455 does not narrow it.
	//
	// What the audit found stands on its own: `goClient`/`rustClient` are
	// module-scope singletons wrapping a `createAvailabilityLatch()` each, and
	// they are NOT stateless. A probe-class "missing" verdict never expires
	// (`isLatchingOutcome`), so a go/cargo install between sessions stayed
	// unobserved for the rest of the process's life, the same #1496 shape
	// `package-manager.ts` and the same #1535 shape `zizmor-config.ts`'s
	// `ghTokenLatch` already have registered resets for.
	//
	// #2455 fix round 4, F2 moved both instances and both resets OFF the
	// runner modules and into the client modules that own the classes. Round 2
	// left the runner holding one instance while `bootstrap.ts` built a second
	// for `BootstrapClients.goClient`/`.rustClient` — the objects
	// `handleSessionStart` reads for its "Active tools" line — so the reset
	// re-armed a latch nothing user-visible consulted, and the bug survived its
	// own fix. One instance per toolchain, beside the reset that clears it, is
	// what makes the reset total; `tests/clients/toolchain-client-singleton.test.ts`
	// is the ratchet.
	{
		id: "go-client:goClientAvailability",
		module: "go-client.ts",
		state:
			"goClient's ToolchainAvailability latch (resolved go path, availability verdict)",
		policy: "session_start",
		ownerKey:
			"process-wide: whether the go toolchain is installed is a fact about this machine",
		resetName: "resetGoAvailability",
		reason:
			"#2455: GoClient wraps createAvailabilityLatch() the same way zizmor-config.ts's standalone gh-token latch does, outside the dispatch generation counter (runner-helpers.ts) and outside the install-retry generation (availability-policy.ts, which only re-arms the install-EXHAUSTED ceiling, not a plain probe-class 'missing' verdict). A go binary installed mid-process stayed invisible until process restart. Fix round 4, F2: the instance and this reset live in go-client.ts, which is what makes go-vet.ts's runner and bootstrap.ts's BootstrapClients.goClient the same object — two instances meant the reset never reached the session-start 'Active tools' line.",
	},
	{
		id: "installer:pathWalkMemo",
		module: "installer/index.ts",
		state: "pathWalkMemo",
		policy: "session_start",
		ownerKey:
			"process-wide: a PATH walk answers a question about this machine, keyed by command",
		resetName: "resetPathWalkMemo",
		reason:
			"The PATH walk memo must not outlive a session that installed something onto PATH.",
	},
	{
		id: "installer:resolvedPathCache",
		module: "installer/index.ts",
		state: "resolvedPathCache",
		policy: "session_start",
		ownerKey:
			"process-wide: a resolved tool path is a fact about this machine, keyed by tool id",
		resetName: "resetResolvedPathCache",
		reason:
			"Bare cached commands return without a spawnability check, so a PATH change between sessions must clear this positive cache.",
	},
	{
		id: "language-profile:topology-derived-cache",
		module: "language-profile.ts",
		state: "languageProfileCache",
		policy: "session_start",
		ownerKey: "project",
		resetName: "resetWorkspaceTopology",
		reason:
			"Language profiles derive configured markers from workspace topology, so the memo must re-arm with that index.",
	},
	// The exemption this entry replaces (#2319): liveBrackets is NOT exempt
	// any longer - it is real session-scoped process-shared state whose reset
	// the closure-site derivation now proves. The exemption's text said "the
	// reset sits in the closure, so the handleSessionStart walk cannot see it;
	// exempted rather than falsely registered" - the closure site IS that
	// registration now.
	{
		id: "latency-logger:liveBrackets",
		module: "latency-logger.ts",
		state:
			"liveBrackets, closedBrackets (the in-flight-phase bracket map); LAST_PHASE_EXCLUDED is a constant, not state",
		policy: "session_start",
		ownerKey:
			"process-wide: in-flight phase brackets of this process's own timing log",
		resetName: "resetCurrentPhaseForSession",
		sessionStartClosureReset: true,
		reason:
			"#1723 review F4: the in-flight-phase live-bracket map is process-shared state that only a confirmed full session start may re-arm - the reset must sit INSIDE the #473 concurrent-secondary gate, yet outside handleSessionStart's own body (it runs before handleSessionStart), so it is called directly in index.ts's session_start closure, unreachable from the handleSessionStart walk. #2319 adds the closure-site evidence and this entry replaces the file's exemption. See resetCurrentPhaseForSession's own doc comment for the full placement reasoning.",
	},
	// ── #2526 once-per-session phase claims ─────────────────────────────
	{
		id: "latency-logger:oncePerSessionPhases",
		module: "latency-logger.ts",
		state:
			"oncePerSessionPhases (which SESSION-fact phase rows have already been written this session) plus sessionRecordId, the identity those rows are stamped with; sessionRecordSeq is a monotonic mint counter, not session state",
		policy: "session_start",
		ownerKey: "session",
		sessionSeamException:
			"one process Set of claim keys (phase and served root) with no session in the key; the claim holds for the primary alone (shape 72 member, no open issue)",
		resetName: "resetOncePerSessionPhases",
		sessionStartClosureReset: true,
		reason:
			"#2526: `config_resolved` is a SESSION fact written by `loadLSPConfig`, which runs many times per session (session start, each served root, the MCP `ensureReady` boot, the first edit's ensure). The claim set is what collapses those to one row per session and served root. Review round 2 F1 MOVED the re-arm out of handleSessionStart's body into index.ts's session_start closure, beside resetCurrentPhaseForSession and behind the same #473 gate: index.ts's ensureLSPConfigInitialized resolves this session's config BEFORE handleSessionStart runs, so a re-arm inside the handler fired between the session's own two resolutions and the deferred loadLSPConfig wrote a second row for one session. Behind the #473 gate for the same reason as liveBrackets - a concurrent secondary never reaches handleSessionStart, so it never publishes an expectation line and must not re-arm a live primary's claims. Catalog shape 17 still applies in the other direction: a claim never re-armed silences a positive-observability record for the rest of the process.",
	},
	{
		id: "lazy-installer:attempts",
		module: "dispatch/runners/utils/lazy-installer.ts",
		state: "attempts",
		policy: "session_start",
		ownerKey:
			"process-wide: install attempts are a fact about this machine, keyed by tool",
		resetName: "resetLazyInstallAttempts",
		reason:
			"#1537: the lazy-install hold is durable for a SESSION; it deliberately sits here and not on the turn_end path, where a failing install would re-spawn every turn.",
	},
	{
		id: "lsp-index:globalLSPService",
		module: "lsp/index.ts",
		state: "globalLSPService",
		policy: "session_start",
		ownerKey:
			"process-wide: shared LSP pool: one service the process builds and tears down for every session",
		resetName: "resetLSPService",
		reason:
			"The service is torn down and rebuilt per session; this reset also clears the adaptive auxiliary wait streak and demotion set, alongside the sweep hold and TS-repair guard resets.",
	},
	{
		id: "lsp-mutation:noBridgeDbgLogged",
		module: "lsp-mutation.ts",
		state: "noBridgeDbgLogged",
		policy: "session_start",
		ownerKey: "session",
		sessionSeamException:
			"one process boolean that gates a debug line once per session; a second live session is silenced by the first (shape 72 member, no open issue)",
		resetName: "resetLspMutationNoBridgeDbgLatch",
		reason:
			"#2450 fix round 3: the 'mutation bridge unavailable' dbg line (a bridge-less process, e.g. the MCP server, has no bookkeeping seam for an LSP-applied edit) is gated once per SESSION so a rename touching many files does not spam it once per file. A latch that survived a session boundary would silently suppress the warning for every session after the first that ever hit it — exactly the #1635 class this registry exists to catch.",
		probe: {
			arm: () => {
				const context: LspMutationContext = {
					cwd: scratchCwd(),
					correlationId: "session-state-registry-probe",
					tool: "lsp_navigation:executeCommand",
					source: "lsp-execute-command",
					emitSummary: false,
					dbg: () => {},
				};
				const filePath = path.join(context.cwd, "probe.ts");
				recordLspMutation(context, {
					results: [
						{
							descriptions: [],
							files: [filePath],
							operationTotal: 1,
							appliedOperationTotal: 1,
							appliedOperationIndexes: [0],
							operationCounts: {
								textEdits: 1,
								create: 0,
								rename: 0,
								delete: 0,
							},
							fileDetails: [
								{
									filePath,
									range: { start: 1, end: 1 },
									importsChanged: false,
								},
							],
						},
					],
				});
			},
			// `arm()` drives a no-bridge record — the same shape
			// tests/clients/lsp-mutation-bridge-unmounted.test.ts exercises end to
			// end — which flips the latch true as a side effect of the dbg line
			// firing. `isArmed()` reads that latch directly (via the test-only
			// getter) rather than re-deriving it from captured dbg messages, so
			// re-arming genuinely means "a SECOND no-bridge record dbg's again",
			// not just "a message array still has an old entry in it".
			isArmed: () => !_lspMutationNoBridgeDbgLoggedForTests(),
			reset: () => resetLspMutationNoBridgeDbgLatch(),
		},
	},
	{
		id: "lsp-server:classicTsRepairGuard",
		module: "lsp/server.ts",
		state: "the classic-tsserver repair guard",
		policy: "session_start",
		ownerKey:
			"process-wide: shared LSP pool: the repair guard of the shared tsserver client",
		resetName: "resetClassicTsRepairGuard",
		reason:
			"#1570: a repair that failed transiently in an earlier session must not stay latched for the rest of the extension-host process.",
	},
	{
		id: "lsp-server:directCommandUnavailable",
		module: "lsp/server.ts",
		state: "directLspCommandUnavailableUntil, directLspCommandSkipLoggedUntil",
		policy: "session_start",
		ownerKey:
			"process-wide: shared LSP pool: a negative launch cooldown keyed by server command",
		resetName: "resetDirectLspCommandAvailability",
		reason:
			"A direct-LSP command that appears between sessions must receive a fresh availability probe instead of inheriting the prior negative cooldown.",
	},
	{
		id: "lsp-server:launchAvailabilityGeneration",
		module: "lsp/server.ts",
		state: "lspLaunchAvailabilityGeneration",
		policy: "session_start",
		ownerKey:
			"process-wide: shared LSP pool: the generation shared by every LSP launch",
		resetName: "resetLSPService",
		reason:
			"Availability publication shares the LSP service generation. A managed lookup, install, or launch that crosses reset must not publish into the replacement session. #2351.",
	},
	{
		id: "lsp-server:posixCaseSensitivityProbe",
		module: "lsp/server.ts",
		state: "posixCaseInsensitiveByPath",
		policy: "session_start",
		ownerKey:
			"process-wide: shared LSP pool: a filesystem probe keyed by root path",
		resetName: "resetLSPCaseSensitivityState",
		reason:
			"#2052: case-sensitivity answers are cached by root, but a root can be probed before it exists. A new session may create that root, so the process must clear this memo before containment decisions continue.",
		probe: {
			arm: () => {
				resetLSPCaseSensitivityState();
				const root = "/pi-lens-session-case-probe/Project";
				isSameOrWithin(root, `${root}/src/app.ts`, {
					caseInsensitiveProbe: () => false,
				});
			},
			isArmed: () => _getPosixCaseSensitivityCacheSizeForTests() === 0,
			reset: () => resetLSPCaseSensitivityState(),
		},
	},
	{
		id: "lsp-session-roots:sessionRoots",
		module: "lsp/session-roots.ts",
		state: "sessionRoots",
		policy: "process_lifetime",
		ownerKey: "project",
		resetName: "resetSessionRootsForTests",
		reason:
			"#2052: the project roots this PROCESS serves, each mapped to the LSP config loaded for it (#2518 merged the two — see that module's header for why one entry per root is what keeps an operator's denial from being evicted out from under a live root). A root enters it when `initLSPConfig` runs for that cwd, and that same call warms an LSP client fleet rooted there which stays alive for the process, not the session: clearing at session_start would decline files for roots this process is still serving, with warm clients still attached to them. Accumulating roots is also the SAFE direction — an extra registered root only means a file is served as it was before #2052, whereas a missing root means a hard refusal to answer. (Before #2518 this entry also argued that a session_start clear could not self-heal, because index.ts deduped on `_lspConfigInitializedCwds` alone; that half is obsolete — both readiness memos now consult `shouldInitializeSessionRoot`, so a cleared root re-registers on its next session start or tool call. The two arguments above are the ones that still hold.)",
		probe: {
			arm: () => {
				resetSessionRootsForTests();
				registerSessionRoot("/pi-lens-probe/session-root");
			},
			// Post-reset shape is an EMPTY registry, which by the fail-open rule
			// declines nothing — so no path reads as outside-all-roots.
			isArmed: () =>
				!isOutsideAllSessionRoots("/pi-lens-probe/elsewhere/file.ts"),
			reset: () => resetSessionRootsForTests(),
		},
	},
	{
		id: "lsp-workspace-diagnostics-cache:fileCreatedAt",
		module: "lsp/workspace-diagnostics-session.ts",
		state: "_fileCreations; _allFilesChangedAt",
		policy: "session_start",
		ownerKey:
			"process-wide: shared LSP pool: the latest Created send per client, root and path",
		resetName: "resetWorkspaceDiagnosticsCacheSession",
		reason:
			"#4320, #4346: each client's latest Created send per path refuses older cached entries whose dependency scope holds that path, under that client's root (#4476: or a declaration file pi-lens saw change on disk, for any server), and `_allFilesChangedAt` holds what the bound evicted and the last dependency install; kept across sessions they would refuse every later session's entries.",
		probe: {
			arm: () =>
				noteWorkspaceFileCreated("probe-server", "/", ["/probe-created.ts"], 1),
			isArmed: () =>
				workspaceFileCreatedAtFor(
					() => true,
					() => true,
				) === 0,
			reset: () => resetWorkspaceDiagnosticsCacheSession(),
		},
	},
	{
		id: "lsp-workspace-diagnostics-cache:sessionClock",
		module: "lsp/workspace-diagnostics-session.ts",
		state: "_sessionStartedAt",
		policy: "session_start",
		ownerKey: "session",
		sessionSeamException:
			"one process timestamp that every session_start overwrites, so the last session to start decides which cached findings predate it (shape 72 member, no open issue)",
		resetName: "resetWorkspaceDiagnosticsCacheSession",
		reason:
			"#1782: the clock that decides whether a cached finding predates this session is worthless if it keeps the first session's value for the life of the extension host.",
		probe: {
			arm: () => resetWorkspaceDiagnosticsCacheSession(0),
			isArmed: () => workspaceDiagnosticsCacheSessionStart() > 0,
			reset: () => resetWorkspaceDiagnosticsCacheSession(),
		},
	},
	// ── #2026 pending auxiliary coverage baselines ──────────────────────
	{
		id: "lsp:pending-aux-coverage",
		module: "lsp/pending-aux-coverage.ts",
		state:
			"pending Map (filePath,serverId) pairs; napiFallbackCoverage Map (filePath) (#2324 R2-A)",
		policy: "session_start",
		ownerKey: "session",
		sessionSeamException:
			"one process BoundedFifoMap keyed by file path and server id with no session in the key; a late drain delivers to whichever session reads it (shape 72 member, no open issue)",
		resetName: "resetPendingAuxiliaryCoverage",
		reason:
			"#2026: pending auxiliary baselines are keyed by cwd and become unreachable when the session generation advances. #2324 R2-A: napiFallbackCoverage records WHEN the ast-grep napi fallback last covered a file, so the aux-grace wait can skip marking a duplicate pending pair — a cross-session leftover would wrongly suppress a legitimate mark in the new session.",
	},
	{
		id: "managed-tool-refresh-session:refreshesThisSession",
		module: "installer/managed-tool-refresh-session.ts",
		state: "refreshesThisSession",
		policy: "session_start",
		ownerKey: "session",
		sessionSeamException:
			"one process table keyed by tool id that spends the one-refresh-per-session budget for the whole process (shape 72 member, no open issue)",
		resetName: "resetManagedToolRefreshSession",
		reason:
			"#1730: the managed-tool refresh budget is one `npm update` per SESSION; left process-lived, a long-running pi refreshes one tool at launch and never revisits the other 21. The weekly per-tool cadence is deliberately NOT reset here — it lives in the persisted stamp, so re-arming the budget only restores the session's right to ask.",
		probe: {
			arm: () => {
				reserveManagedToolRefreshSlot(1);
			},
			isArmed: () => managedToolRefreshesThisSession() === 0,
			reset: () => resetManagedToolRefreshSession(),
		},
	},
	// #2319 survey catch: the session_start closure ALSO resets the
	// #1999 rising-edge memory-sample cadence. Its state is two module-scope
	// SCALARS, so the container scan cannot flag the file (SWEEP_HEURISTIC_LIMITS
	// item 1 - the registry covers scalar session state by hand). #1332 adds the
	// per-session pending turn end, cleared by the same reset. The module's
	// own doc calls this session state reset at primary session_start, so it
	// registers as another closure-site entry and the derived closure set maps
	// to the registry (or a widget-state exemption) one-to-one.
	{
		id: "memory-sampler:cadence",
		module: "memory-sampler.ts",
		state:
			"_lastSampledHeapUsedBytes, _tightenThroughTurn (rising-edge cadence)",
		policy: "session_start",
		ownerKey:
			"process-wide: the rising-edge cadence follows this process's heap growth, not a conversation; a session's pending turn end moved to the memory-turn-end scope cell",
		resetName: "resetMemorySamplerCadence",
		sessionStartClosureReset: true,
		reason:
			"#2319 survey: #1999's rising-edge memory-sample cadence tightens sampling after rapid heap growth until it stabilizes; the latch is module-scope SCALAR session state (SWEEP_HEURISTIC_LIMITS item 1 - the container scan cannot see it, so the registry covers it by hand). Its reset runs in index.ts's session_start closure behind the #473 gate, and the #2319 derivation is what surfaced that it was never registered; see the module's own defect-shape-17 note.",
	},
	{
		id: "message-end-attribution:two-slot-anchor",
		module: "message-end-attribution.ts",
		state: "lastStableSessionId, previousSessionId",
		policy: "session_start",
		ownerKey: "session",
		sessionSeamException:
			"two process slots that hold the last live session id, last write wins by design; a second live session overwrites the first's anchor (shape 72 member, no open issue)",
		resetName: "resetMessageEndAttribution",
		sessionStartResetName: "rotateMessageEndAttribution",
		reason:
			"#1956 R3: session_start rotates the live anchor into one bounded previous slot because a stale message_end can drain after replacement; the full registry reset clears both slots.",
		probe: {
			// Arm BOTH slots: the getter's ?? fallback reads previous, so a
			// reset that leaks previousSessionId fails isArmed (#1956 R9).
			arm: () => {
				noteLiveMessageEndSessionId("session-state-probe-prev");
				rotateMessageEndAttribution();
				noteLiveMessageEndSessionId("session-state-probe");
			},
			isArmed: () => getLastLiveMessageEndSessionId() === undefined,
			reset: () => resetMessageEndAttribution(),
		},
	},
	{
		id: "mutation-attribution:session+fromDisk",
		module: "mutation-attribution.ts",
		state:
			"session BoundedFifoMap (toolName -> observations), fromDisk Set, primedCwd",
		policy: "session_start",
		ownerKey: "session",
		sessionSeamException:
			"one process map keyed by tool name, plus a disk set that belongs to one project root; neither has a session in the key (shape 72 member, no open issue)",
		resetName: "resetMutationAttribution",
		reason:
			"#2430: the learned map says 'this tool name mutates files' for the SESSION, and the adopted disk set belongs to one project root. A `pi --session` switch can change that root, so carrying either across a session boundary classifies a tool for a project that never observed it. The reset is immediately followed by `primePersistedMutationAttribution(ctxCwd)`, which re-adopts the CURRENT project's persisted attributions.",
		probe: {
			arm: () => {
				noteObservedMutation("pi-lens-2430-probe-tool", undefined);
			},
			isArmed: () =>
				lookupLearnedMutatingTool("pi-lens-2430-probe-tool") === undefined,
			reset: resetMutationAttribution,
		},
	},
	// ── #2430 observational mutation net ────────────────────────────────
	{
		id: "observed-mutation:pending+ledger+handled",
		module: "observed-mutation.ts",
		state:
			"pending BoundedFifoMap (toolCallId -> baseline), ledger BoundedFifoMap (path -> content stamp), handled Set, per-turn budget counters",
		policy: "session_start",
		ownerKey: "session",
		sessionSeamException:
			"pending snapshots are keyed by tool-call id with the session generation, the content ledger and handled set by path; no session id in any key (shape 72 member, no open issue)",
		resetName: "resetObservedMutationNet",
		reason:
			"#2430: a pending pre-snapshot is keyed by tool-call id and carries the session generation it was taken in, so it is unreachable once the session advances; the content ledger and the handled set describe the PREVIOUS session's files, and diffing a resumed session against them would report every intervening external change as this session's drift. The per-turn budget counters are the same class — a turn index from a finished session must not decide whether this session may take a snapshot.",
		probe: {
			arm: () => {
				noteMutationHandled(path.join(os.tmpdir(), "pi-lens-2430-probe.ts"));
			},
			isArmed: () =>
				_observedMutationStateForTests().handled.length === 0 &&
				_observedMutationStateForTests().pending.length === 0,
			reset: resetObservedMutationNet,
		},
	},
	// ── #2000 phase 2 opaque-recovery baselines ─────────────────────────
	{
		id: "opaque-mutation-scan:baselineStore+gitMemo",
		module: "opaque-mutation-scan.ts",
		state:
			"OpaqueBaselineStore pending map, gitRepoMemo, overCapRootMemo, gitToplevelMemo, headRecords, headLooks, pendingHeadDiscards",
		policy: "session_start",
		ownerKey: "project",
		resetName: "resetOpaqueMutationState",
		reason:
			"#2000 phase 2: pending pre-command baselines are keyed cwd:generation (plus the tool-call id, #4137) and become unreachable when the session generation advances; and the git-worktree and toplevel memos must re-probe after a session that may have seen a directory become a worktree, or become a LINKED worktree of another (#2007). Without the reset the baselines leak per session and the memos mis-answer forever. #4493: the per-session HEAD records (capped at 64) and the per-key HEAD-look flights clear at the same boundary, where the LSP service resets too, so no record outlives the documents it guards. #4612 r4: the discard paths a joined HEAD look still owes (keyed like the HEAD records, capped at 64 keys) clear at the same boundary. #4905: `overCapRootMemo` (capped at 16 roots) keeps a stat-walk verdict of file-cap-exceeded so the next opaque call of the session does not walk that root again; it clears at the same boundary, so a tree that shrank is walked again by the next session.",
	},

	// ── The rest of the session_start reset chain ────────────────────────────
	{
		id: "package-manager:availabilityLatches",
		module: "package-manager.ts",
		state:
			"availabilityLatches, globalBinDirCache, cache generation, and package-manager probe flights",
		policy: "session_start",
		ownerKey:
			"process-wide: whether pnpm or yarn is installed is a fact about this machine, keyed by manager",
		resetName: "_resetPackageManagerCache",
		reason:
			"#1496 shape: a `missing` verdict for pnpm/yarn is durable for a session, not for the process — a manager installed mid-process should be re-probed by the next session. Declared a gap when this registry landed; PR #1666 wired the reset into handleSessionStart, and the gap test went red naming the fix, which is the registry doing its job.",
	},
	{
		id: "path-attribution-telemetry:verifiedGuessCount",
		module: "path-attribution-telemetry.ts",
		state: "verifiedGuessCount (process-singleton backed as of #2319)",
		policy: "session_start",
		ownerKey: "session",
		sessionSeamException:
			"one process-singleton counter that emits one rollup row at session end for the primary alone (shape 72 member, no open issue)",
		resetName: "resetVerifiedPathAttributionGuessCount",
		sessionStartClosureReset: true,
		reason:
			"#2319: the verified path-attribution guess tally is a per-session counter that emits one path_attribution_verified_rollup row at session end; PR #2312's class sweep flagged the module-scope `let` as the same latent shape as the bind rollup, so it now rides getProcessSingleton (shape 25). Its reset runs in index.ts's session_start closure after the #473 decision and only on the primary path, so a secondary cannot erase the primary's tally; the count is memory-only best-effort observability, so a lost tally is noise, not data.",
	},
	{
		id: "path-birth:appearedPaths",
		module: "path-birth.ts",
		state: "appearedPaths",
		policy: "process_lifetime",
		ownerKey: "process-wide: a fact about files on disk, keyed by path",
		resetName: "resetPathBirthForTests",
		reason:
			"#4368 r1 row 13: `appearedPaths` records that the import resolver saw a path absent and then present, so a module moved into place (old inode) answers with that later observation. A fact about files on disk, not about a session: a client started after the observation reads the path as older than itself and sends nothing, so keeping it across sessions changes no answer, and a session_start clear would only lose the record for a client that is still live. Bounded (1024).",
		probe: {
			arm: () => notePathAppeared("/session-state-probe/moved.py", 20_000),
			// Unarmed, the path answers its inode's own birth.
			isArmed: () =>
				pathBirthtimeMs(
					{ dev: 1, ino: 7, birthtimeMs: 5_000, ctimeMs: 5_001 },
					"/session-state-probe/moved.py",
				) !== 20_000,
			reset: () => resetPathBirthForTests(),
		},
	},
	{
		id: "path-birth:replacedPathBirths",
		module: "path-birth.ts",
		state: "replacedPathBirths; birthIsCtimeAlias",
		policy: "process_lifetime",
		ownerKey: "process-wide: a fact about files on disk, keyed by inode",
		resetName: "resetPathBirthForTests",
		reason:
			"#4320 r2: `replacedPathBirths` records that an inode pi-lens installed by an atomic partial edit stands for a path born earlier. That is a fact about files on disk, not about a session: a session_start clear would make the next first open of every file this process edited read as a creation and send the server a Created. Bounded (1024), keyed by the installed inode's own birth so a reused inode number never inherits it. `birthIsCtimeAlias` memoises whether libuv fell back from statx, a property of the process that cannot change.",
		probe: {
			arm: () =>
				noteAtomicReplace(
					{ dev: 1, ino: 7, birthtimeMs: 1_000, ctimeMs: 1_001 },
					{ dev: 1, ino: 8, birthtimeMs: 9_000, ctimeMs: 9_001 },
				),
			// Unarmed, the installed inode answers anything but the carried birth.
			isArmed: () =>
				pathBirthtimeMs({
					dev: 1,
					ino: 8,
					birthtimeMs: 9_000,
					ctimeMs: 9_001,
				}) !== 1_000,
			reset: () => resetPathBirthForTests(),
		},
	},
	{
		id: "path-utils:pathIdentityFallbacks",
		module: "path-utils.ts",
		state: "pathIdentityFallbacks",
		policy: "session_start",
		ownerKey: "session",
		sessionSeamException:
			"one process BoundedFifoMap keyed by path with no session in the key; the tally folds into one ledger row for the primary (shape 72 member, no open issue)",
		resetName: "resetPathIdentityFallbacks",
		reason:
			"#4689: the identity-fallback tally is the ledger's `path-identity-fallback` row, folded at read time; a tally that outlived the session would report the previous session's fallbacks to the next one. `resetDegradationLedger` (reached from `handleSessionStart`) calls it.",
		probe: {
			// A NUL byte is refused by realpath with ERR_INVALID_ARG_VALUE on every
			// platform, so the probe needs no symlink.
			arm: () => {
				realpathOrResolve(path.join(os.tmpdir(), "pi-lens-probe\0x"));
			},
			isArmed: () => getPathIdentityFallbacks().length === 0,
			reset: () => resetPathIdentityFallbacks(),
		},
	},
	{
		id: "pending-runner-findings:pending",
		module: "dispatch/pending-runner-findings.ts",
		state: "pending runner handoff array",
		policy: "session_start",
		ownerKey: "session",
		sessionSeamException:
			"one process array whose entries carry a session id and handle but are read and drained by any session; the stamp is the primary's for a sub-agent's write (#4943 covers the stamp)",
		resetName: "resetPendingRunnerFindings",
		reason:
			"#2122: deferred runner results are session-scoped and must not cross a session boundary or accumulate handlers across turn-end drains.",
		probe: {
			arm: () => {
				const result: RunnerResult = {
					status: "succeeded",
					diagnostics: [],
					semantic: "warning",
				};
				deferRunnerFindings({
					filePath: "/probe/session-state-runner.ts",
					cwd: "/probe",
					projectRoot: "/probe",
					runnerId: "session-state-probe",
					markedAtMs: Date.now(),
					promise: Promise.resolve(result),
				});
			},
			isArmed: () => pendingRunnerFindingsSize() === 0,
			reset: () => resetPendingRunnerFindings(),
		},
	},
	{
		id: "psscriptanalyzer:latches",
		module: "dispatch/runners/psscriptanalyzer.ts",
		state: "psAnalyzerLatchByCmd, psExecLatchByCmd",
		policy: "session_start",
		ownerKey:
			"process-wide: PowerShell tool availability is a fact about this machine, keyed by command",
		resetName: "resetPsScriptAnalyzerAvailability",
		reason:
			"#1490/#1540: these latches are module-local, so the availability generation counter does not reach them and they need their own session hook.",
	},
	{
		id: "review-graph-builder:workspaceGraphCache",
		module: "review-graph/builder.ts",
		state:
			"_workspaceGraphCache, _workspaceCacheEpochs, _sourcePathMemos, _sourcePathNormalizeCalls, _retainedGraphSites",
		policy: "session_start",
		ownerKey: "project",
		resetName: "clearReviewGraphWorkspaceCache",
		reason:
			"Same reason as the module graph: a cached workspace graph describes one revision of one tree. #2255 adds one memory-attribution companion on the same seam: _retainedGraphSites (WeakRefs to graphs retained outside the cache, cleared with it so a new session never samples the previous one's graphs).",
	},
	{
		id: "runner-helpers:availabilityGeneration",
		module: "dispatch/runners/utils/runner-helpers.ts",
		state: "availabilityGeneration",
		policy: "session_start",
		ownerKey:
			"process-wide: one counter that re-arms every cwd-cached probe latch",
		resetName: "resetDispatchAvailabilityState",
		reason:
			"The generation counter is how every cwd-cached probe latch (eslint, clippy, and the rest of createCwdCachedProbe's users) re-arms without holding a reset closure per checker — one counter, not a parallel list of resets. #1754 made it a GenerationSource; resetDispatchAvailabilityState still owns the bump.",
	},
	{
		id: "runner-helpers:correctedAvailabilityByCwd",
		module: "dispatch/runners/utils/runner-helpers.ts",
		state:
			"correctedAvailabilityByCwd, installAttemptsByCwd, resolveInstallInFlightByCwd",
		policy: "session_start",
		ownerKey: "session",
		sessionSeamException:
			"correctedAvailabilityByCwd is the once-per-correction memo that withholds a repeat compensating row from the session that already logged one, keyed by cwd and tool id with no session in the key; the install-attempt and in-flight maps in this entry are cwd-keyed machine facts (#4972 review F3)",
		resetName: "resetDispatchAvailabilityState",
		reason:
			"#1615: the once-per-correction memo that suppresses repeat compensating rows is a per-session claim, so a new session must be able to log its own correction.",
	},
	{
		id: "rust-client:rustClientAvailability",
		module: "rust-client.ts",
		state:
			"rustClient's ToolchainAvailability latch (resolved cargo path, availability verdict); clippyAvailabilityByCargo (the cwd-keyed clippy-tool probe cache) is a SEPARATE, already-covered latch — it rides createCwdCachedProbe's shared availabilityGeneration counter (runner-helpers.ts's resetDispatchAvailabilityState, registered above as runner-helpers:availabilityGeneration), not this reset",
		policy: "session_start",
		ownerKey:
			"process-wide: whether the rust toolchain is installed is a fact about this machine",
		resetName: "resetRustAvailability",
		reason:
			"#2455: same shape as go-client:goClientAvailability — RustClient's own createAvailabilityLatch() sits outside every generation counter that already covers the rust-clippy runner's OTHER cache. A cargo install mid-process stayed invisible until process restart. Fix round 4, F2: the instance and this reset live in rust-client.ts so the runner and bootstrap.ts share one object.",
	},
	{
		id: "safe-spawn:windowsCommandCache",
		module: "safe-spawn.ts",
		state: "windowsCommandCache",
		policy: "session_start",
		ownerKey:
			"process-wide: a resolved Windows command path is a fact about this machine",
		resetName: "resetSafeSpawnWindowsCommandCache",
		reason:
			"A resolved Windows command path can be invalidated by an install that happened between sessions.",
	},
	// ── #2319 process-singleton state with closure-located resets ──────────
	// These resets run inside index.ts's `pi.on("session_start", ...)` closure,
	// NOT inside handleSessionStart's reachable call graph, so the
	// `sessionStartResetNames()` walk cannot see them (they would fail the
	// "not reachable from handleSessionStart" test on line 238). Each carries
	// `sessionStartClosureReset` and the conformance suite checks it against
	// `sessionStartClosureResetNames()` instead — the derived evidence, never
	// a hand-copied claim. The placement is load-bearing in every case: two of
	// the resets re-arm counters that a DECLINED bind's own session_start
	// increments (a reset there would erase a live sibling's tally), and the
	// others must sit inside the #473 gate but before handleSessionStart runs.
	// Together with widget-state.ts's exemption for `clearWidgetState`, every
	// reset the closure derivation sees is now accounted for on this registry.
	{
		id: "session-start-observability:bindRollupCounters",
		module: "session-start-observability.ts",
		state:
			"the concurrent-session bind rollup counters (process-singleton backed)",
		policy: "session_start",
		ownerKey: "session",
		sessionSeamException:
			"process-singleton counters for declined binds; a declined bind's own session_start increments them, so one table counts every session (shape 72 member, no open issue)",
		resetName: "resetConcurrentSessionBindRollupCounts",
		sessionStartClosureReset: true,
		reason:
			"#2319: #2249's declined-bind rollup is process-singleton backed (catalog shape 25), so the module-scope container scan could not see it. Its reset runs in index.ts's session_start closure on the primary-continuation path behind the #473 concurrent-secondary gate - a declined bind's own session_start increments these counters, so resetting there would erase every prior sibling's tally; the closure placement (with the emit-before-reset first line) still lets a primary that crashed before session_shutdown start from zero.",
	},
	{
		id: "situational-tool-telemetry:sessionObservation",
		module: "situational-tool-telemetry.ts",
		state:
			"activated, called (the conversation's observation sets), emitted (its once-per-row latch), sessionHost (which host owns the open session), and connectionEnded (the MCP-only connection-terminal latch). situationalToolSet is also counted by the scan but is an import-time frozen lookup over TOOL_REGISTRY (SWEEP_HEURISTIC_LIMITS item 5); sessionStarted is the start/end pair's own in-progress flag. sessionStarted and connectionEnded are deliberately NOT cleared by this reset: both hosts call startSituationalToolTelemetrySession() before handleSessionStart, so clearing sessionStarted would make endSituationalToolTelemetry() skip the session's own final row, and only MCP may arm connectionEnded. The reset also refuses to clear while a telemetry session is live because a repeated MCP session_start refresh must not wipe calls recorded before it; this reset is the registry's structural hook and the real clearing happens in endSituationalToolTelemetry() and in the opener itself.",
		policy: "session_start",
		ownerKey: "session",
		sessionSeamException:
			"module-level sets and flags for one conversation or MCP connection; a second live session shares them (shape 72 member, no open issue)",
		resetName: "resetSituationalToolTelemetry",
		reason:
			"#2858: the dead-weight line is one row per pi conversation or MCP connection naming situational tools that host never used. The row belongs to the conversation identified by pi's session file: a shutdown that switches the file (new, resume, fork — pi sends targetSessionFile) emits the ending conversation's row and resets; reload keeps the same file and preserves the observations even though pi re-runs the extension factory (the module state survives); a process restart starts both sets empty and recovers nothing, because the restore deactivates every situational tool in a new process (#2866 review F1 — the host's restored active set is every registered tool, not evidence of activation). MCP owns connectionEnded. The reset's sessionStarted exclusion is stated in the state field above.",
		probe: {
			arm: () => {
				observeSituationalToolActivation(["lsp_navigation"]);
				observeSituationalToolCall("lsp_navigation");
				emitSituationalDeadWeight();
			},
			isArmed: () => {
				const state = _getSituationalToolTelemetryStateForTests();
				return state.activated === 0 && state.called === 0 && !state.emitted;
			},
			reset: () => resetSituationalToolTelemetry(),
		},
	},
	{
		id: "smells-rollup:notifiedThisSession",
		module: "smells-rollup.ts",
		state: "notifiedThisSession",
		policy: "session_start",
		ownerKey: "session",
		sessionSeamException:
			"one process Set keyed by smell key with no session in the key; a smell one session heard is withheld from another (shape 72 member, no open issue)",
		resetName: "resetSmellsSessionState",
		reason:
			"#1123: the once-per-session smell gate must let a fresh session hear the smell once.",
	},
	{
		id: "spawn-timeout-cooldown:latches",
		module: "spawn-timeout-cooldown.ts",
		state: "timedOutByCommand",
		policy: "session_start",
		ownerKey:
			"process-wide: a wedged command is a fact about this machine, keyed by command",
		resetName: "resetSpawnTimeoutCooldowns",
		reason:
			"#1995: a wedged command's post-timeout cooldown is session-scoped - a hot loop of edits must not hand the same .cmd shim a second budget, but a NEW session may retry because the executable or its environment may have changed.",
		probe: {
			arm: () => {
				noteSpawnTimeout({
					tool: "markdownlint",
					command: "/pi-lens-probe-cmd",
					phase: "lint",
				});
			},
			isArmed: () => !isInSpawnTimeoutCooldown("/pi-lens-probe-cmd"),
			reset: () => resetSpawnTimeoutCooldowns(),
		},
	},
	{
		id: "startup-scan:topology-derived-cache",
		module: "startup-scan.ts",
		state: "startupScanContextCache",
		policy: "session_start",
		ownerKey: "project",
		resetName: "resetWorkspaceTopology",
		reason:
			"Startup scan context derives its project-root verdict from workspace marker topology, so the memo must re-arm with that index.",
	},
	{
		id: "startup-timing:hostReadyDelayAnchor",
		module: "startup-timing.ts",
		state: "hostReadyDelayAnchorConsumed",
		policy: "process_lifetime",
		ownerKey:
			"process-wide: the anchor is the process's own boot: it is meaningful only against the first session_start",
		resetName: "resetHostReadyDelayAnchorForTests",
		reason:
			"The load-complete timestamp has meaning only against the first session_start in this process; resetting it at a session boundary would fabricate host stalls from the original process boot.",
		probe: {
			arm: () => {
				resetHostReadyDelayAnchorForTests();
				consumeHostReadyDelayAnchor();
			},
			isArmed: () => consumeHostReadyDelayAnchor(),
			reset: () => resetHostReadyDelayAnchorForTests(),
		},
	},
	{
		id: "test-runner-delivery:pending",
		module: "test-runner-delivery.ts",
		state: "pending",
		policy: "session_start",
		ownerKey: "session",
		sessionSeamException:
			"a BoundedFifoMap keyed by cwd, session id and owner id in one composite string; the key carries the session, so it is a hand-rolled partition that the seam can absorb in a follow-up",
		resetName: "resetTestRunnerDelivery",
		reason:
			"#2366: staged test results belong to their owning session and must not cross a primary session replacement; the durable findings cache remains available to pull diagnostics.",
	},
	{
		id: "tree-sitter-shared:webTreeSitterLoadFailed",
		module: "tree-sitter-shared.ts",
		state:
			"the shared TreeSitterClient singleton's webTreeSitterLoadFailed latch",
		policy: "session_start",
		ownerKey:
			"process-wide: whether the web tree-sitter module loads is a fact about this process's ESM cache",
		resetName: "resetTreeSitterClientLoadState",
		reason:
			"#1592: an EVALUATION-shaped loadWebTreeSitter() rejection latches for the session (Node's ESM loader permanently memoizes the rejected module record for that URL, the same shape #1567/#1575 fixed for sgSessionHold) — but that verdict must not outlive the session that observed it, so a fresh session (or a process restart in between) gets a real re-attempt instead of a silently reused stale failure.",
		probe: {
			arm: () => {
				const client = getSharedTreeSitterClient() as unknown as {
					webTreeSitterLoadFailed: boolean;
				} | null;
				if (client) client.webTreeSitterLoadFailed = true;
			},
			isArmed: () => {
				const client = getSharedTreeSitterClient() as unknown as {
					webTreeSitterLoadFailed: boolean;
				} | null;
				return client ? client.webTreeSitterLoadFailed === false : true;
			},
			reset: () => resetTreeSitterClientLoadState(),
		},
	},
	{
		id: "tsconfig-paths:topology-derived-caches",
		module: "review-graph/tsconfig-paths.ts",
		state: "cache, referencesCache",
		policy: "session_start",
		ownerKey: "project",
		resetName: "resetWorkspaceTopology",
		reason:
			"Tsconfig path and project-reference resolutions derive from workspace topology, so both memos must re-arm with that index.",
	},
	{
		id: "turn-context:perSessionCounters",
		module: "turn-context.ts",
		state:
			"the per-session turn counters keyed by stable session id (and the AsyncLocalStorage binding)",
		policy: "session_start",
		ownerKey: "session",
		sessionSeamException:
			"a Map keyed by session id inside a getProcessSingleton family; it is a hand-rolled partition that is never retired at session_shutdown and that the seam can absorb in a follow-up",
		resetName: "resetTurnContext",
		sessionStartClosureReset: true,
		reason:
			"#2815: turn context is process-singleton-backed state with per-session counters. Its reset must run once from the primary session_start closure, after concurrent-secondary classification, so a secondary cannot erase the primary's live turn identity; the coordinator only changes identity and begins turns.",
	},
	{
		id: "workspace-modules:moduleSourceFilesMemo",
		module: "review-graph/workspace-modules.ts",
		state: "_moduleSourceFilesMemo",
		policy: "session_start",
		ownerKey: "project",
		resetName: "clearModuleGraphCache",
		reason:
			"The module graph is a snapshot of the tree at session start, not a durable fact about the project.",
	},
	{
		id: "workspace-sweep-hold:holds",
		module: "lsp/workspace-sweep-hold.ts",
		state: "process-singleton holds, idleWaiters, nextHoldId",
		policy: "session_start",
		ownerKey:
			"process-wide: shared LSP pool: holds on the shared pool's workspace sweep",
		resetName: "clearWorkspaceSweepHoldForSessionStart",
		reason:
			"#1618: a hold leaked by a previous generation's sweep would defer the new session's idle reset forever.",
		probe: {
			arm: () => {
				acquireWorkspaceSweepHold();
			},
			isArmed: () => !isWorkspaceSweepActive(),
			reset: () => clearWorkspaceSweepHoldForSessionStart(),
		},
	},
	{
		id: "workspace-topology:caches",
		module: "workspace-topology.ts",
		state: "dirMarkerCache, walkCache",
		policy: "session_start",
		ownerKey: "project",
		resetName: "resetWorkspaceTopology",
		reason:
			"Workspace layout is re-derived per session; a new session can open a tree whose markers moved.",
	},
	{
		id: "zizmor-config:tokenAvailability",
		module: "zizmor-config.ts",
		state: "the `gh auth token` availability latch",
		policy: "session_start",
		ownerKey:
			"process-wide: whether `gh auth token` answers is a fact about this user's machine",
		resetName: "resetZizmorTokenAvailability",
		reason:
			"#1535: a user who runs `gh auth token` between sessions must not read the previous session's `no token` verdict.",
		probe: {
			arm: () => {
				zizmorConfigModule
					._getZizmorTokenLatchForTests()
					.noteUnavailable("missing", "not-found");
			},
			isArmed: () => {
				// A latched "missing" verdict reads false; a reset latch reads null
				// (unknown — must re-probe). Clean means the verdict is forgotten.
				return (
					zizmorConfigModule._getZizmorTokenLatchForTests().read() === null
				);
			},
			reset: () => resetZizmorTokenAvailability(),
		},
	},
];

/** Scratch state the probes above need to hold between `arm` and `isArmed`. */
let probeLatch: ReturnType<typeof createAvailabilityLatch> | undefined;
let probeDeferredAnchor: string | undefined;
let probeDeferredCwd: string | undefined;

/**
 * Module-private formatter state behind #1895's reset, exposed through the
 * module's `_getFormatterResetStateForTests` hook — namespace casts cannot
 * see non-exported bindings, so the hook is the only honest access.
 */
function getFormattersInternals() {
	return formattersModule._getFormatterResetStateForTests();
}

/**
 * Read the defer set. `cwd` is part of the key since #1625: a weak anchor
 * encodes only a relative path, so the same anchor in two projects collided.
 */
function probeIsDeferred(): boolean {
	if (probeDeferredCwd === undefined) return false;
	// Both halves of the entry's state: the anchor that suppresses a finding and
	// the project index the read-only turn's cost guard reads (#4701 F1). A
	// reset that cleared one and not the other is not the session boundary.
	return (
		isDeferredThisSession(probeDeferredCwd, probeDeferredAnchor as string) ||
		hasAnyDispositionMarks(probeDeferredCwd)
	);
}

/** Drop probe scratch state so repeated conformance runs start clean. */
export function _resetRegistryProbeState(): void {
	probeLatch = undefined;
	probeDeferredAnchor = undefined;
	probeDeferredCwd = undefined;
	while (scratchDirs.length > 0) {
		removeTempDirSync(scratchDirs.pop() as string);
	}
}

/**
 * Files the sweep flags that the registry deliberately does not cover, each
 * with the reason it is not session-scoped state.
 *
 * This list is hand-maintained ON PURPOSE, exactly as
 * `tests/support/atomic-write-scan.ts`'s exemptions are: "is this a session
 * verdict or a memo of something that cannot change mid-process" is a semantic
 * judgment no regex makes. An entry here is a standing claim that carrying the
 * value across a `session_start` cannot mislead the agent.
 */
export const EXEMPT_SESSION_STATE_FILES: Readonly<
	Record<string, SessionStateExemption>
> = {
	"agent-behavior-client.ts": {
		ownerKey: "session",
		sessionSeamException:
			"the process singleton agentBehaviorClient keeps one conversation's tool-call history and per-file edit counts with no session in the key, so a second live session reads and extends the first one's history",
		reason:
			"tool history and edit counts of the agent's recent calls, held on one process-wide client",
	},
	"agent-nudge.ts": {
		ownerKey: "session",
		sessionSeamException:
			"the module Map _touched accumulates the agent's touched files and is keyed by path alone, so a second live session reads and clears the first one's entries; it is cleared only inside consumeAgentNudge",
		reason:
			"the nudge accumulator deliberately spans runs by design (see its own doc comment)",
	},
	"ast-grep-client.ts": {
		ownerKey: "project",
		reason:
			"the rule manager reads the project's rule directory; the runner holds the sg binary",
	},
	"biome-client.ts": {
		ownerKey: "project",
		reason:
			"the resolved biome binary is cached per cwd so monorepo sub-packages keep their own",
	},
	"blocker-freshness.ts": {
		ownerKey: "project",
		reason:
			"per-file memos validated by mtime and size, keyed by file path and project scope role",
	},
	"bounded-cache.ts": {
		ownerKey:
			"process-wide: a generic bounded container; each instance's owner is the module that constructs it and states its own owner",
		reason:
			"the implementation of BoundedFifoMap and BoundedSet, holding entries only for the instance that owns them",
	},
	"bounded-pid-file-lock.ts": {
		ownerKey:
			"process-wide: memory of the OS process that last held a lock past a wait, keyed by lock directory",
		reason:
			"the last timed-out lock holder per lock directory, bounded at 16 entries",
	},
	"bus-events-logger.ts": {
		ownerKey:
			"process-wide: bus event rollup counters are an observability tally of this process, never read as a verdict",
		reason: "bus event rollup counters, an observability tally",
	},
	"bus-publish.ts": {
		ownerKey:
			"process-wide: the bus publisher is registered once per process and holds no session answer",
		reason: "bus publisher registration",
	},
	"complexity-client.ts": {
		ownerKey:
			"process-wide: frozen per-language node-kind tables built at import and only read",
		reason:
			"#5036 F1: the language tables are module objects whose members are Sets of tree-sitter node-kind names; nothing writes them after load, so a session boundary cannot change them",
	},
	"config-core/records.ts": {
		ownerKey:
			"process-wide: a call-scoped collector discarded with one config load and a frozen code vocabulary",
		reason: "the migration record collector lives for one config resolution",
	},
	"config-resolve.ts": {
		ownerKey:
			"process-wide: frozen config-surface vocabularies built at import and only read",
		reason:
			"import-time lookup tables handed to callers by value, never written after load",
	},
	// #2418: the warn-once latch that used to live in lens-config.ts and
	// project-lens-config.ts moved here when the three loaders' duplicated warn
	// bodies were collapsed into one seam. Same lifetime as before — it is tied
	// to the config file and reason it warned about, not to a session — and the
	// loaders' own reset helpers delegate to resetIgnoredConfigWarnCache.
	//
	// Review round 3, F1: this latch guards the NOTIFICATION only. The durable
	// ledger row is recorded ahead of it, so the per-session half of the seam
	// is bounded by the ledger's own once-keys (which resetDegradationLedger
	// clears) rather than by this process-lifetime Set. A gate in front of the
	// record would have left every session after the first with no
	// config-ignored row while the config was still being ignored.
	"config-warn.ts": {
		ownerKey: "project",
		reason:
			"ignored-config warn-once NOTIFICATION latch, tied to the config file it warned about; the per-session ledger row is bounded by the degradation ledger, not by this Set",
	},
	// #4212 round 4: turn-scoped working state, so a session_start reset would
	// be redundant rather than missing. This is the per-dispatch-cycle
	// rule-corpus fingerprint memo shared by the tree-sitter loader and the
	// ast-grep source fingerprint. Every key begins with `getTurnId()`, and
	// `resetTurnContext` moves that identity at session_start, so any entry a
	// previous session could have written is already unreachable and is
	// FIFO-evicted; the turn boundary is a strictly shorter lifetime than the
	// session, and the map is bounded at 16 entries on top of that.
	"custom-rule-locations.ts": {
		ownerKey: "project",
		reason:
			"the per-dispatch-cycle rule-corpus fingerprint memo, keyed on the turn identity and FIFO-bounded, so the turn boundary invalidates it rather than a session reset",
	},
	"dead-code-client.ts": {
		ownerKey: "project",
		reason:
			"in-flight scans and hard-failure back-off stamps are keyed by project root",
	},
	"dependency-checker.ts": {
		ownerKey: "project",
		reason:
			"in-flight checks, import caches and the circular-dependency result are keyed by project root",
	},
	"diagnostic-line-freshness.ts": {
		ownerKey: "project",
		reason:
			"the #1641 past-EOF line-count memo, keyed on mtime AND size and re-stat'd on every read — a mismatch always recomputes, so it is invalidated by its own freshness check per file, not by the session boundary, same as git-tracked-ignore.ts",
	},
	"diagnostics-publish.ts": {
		ownerKey: "project",
		reason: "diagnostics publisher registration and dirty-path dedupe",
	},
	"disk-changes.ts": {
		ownerKey:
			"process-wide: the disk-change subscriber registry, one per process, rebuilt by each module evaluation",
		reason: "subscribers to out-of-band disk changes, keyed by consumer id",
	},
	"dispatch/auxiliary-lsp.ts": {
		ownerKey:
			"process-wide: a memo over the frozen AUXILIARY_LSP_PROFILES table, keyed by diagnostic source string",
		reason: "profile lookup memo, never mutated profile data",
	},
	"dispatch/fact-store.ts": {
		ownerKey:
			"process-wide: a generic fact container; each instance's owner is the module that constructs it (dispatch-integration:sessionCaches, mcp/analyze.ts) and states its own owner",
		reason:
			"FactStore holds file and session facts for the instance that owns it",
	},
	// #3968: registration identity, not session state — the Set is fed once
	// per runner definition that enters a RunnerRegistry (the dispatcher's own
	// population, re-derived at every process start; see the
	// bounded-container-guard admission for the finite-vocabulary reason).
	"dispatch/known-runner-ids.ts": {
		ownerKey:
			"process-wide: runner ids are registration state re-derived from the runner registry at every process start",
		reason:
			"runner-id identity registration state, fed by RunnerRegistry.register, re-derived every process start; not session-scoped",
	},
	"dispatch/rule-id-normalize.ts": {
		ownerKey:
			"process-wide: language suffixes derived once at import from the bundled rule corpus, the same for every session",
		reason: "the suffix set is extended only while the module loads",
	},
	"dispatch/runners/ast-grep-literal-anchors.ts": {
		ownerKey:
			"process-wide: a WeakMap keyed by parsed YamlRule object, dropped with the rule",
		reason: "literal-anchor requirements derived from a parsed rule",
	},
	"dispatch/runners/eslint.ts": {
		ownerKey: "project",
		reason: "eslint availability is keyed by cwd and PATH",
	},
	"dispatch/runners/helm-lint.ts": {
		ownerKey: "project",
		reason: "in-flight helm lint runs are keyed by chart root",
	},
	"dispatch/runners/helm-render.ts": {
		ownerKey: "project",
		reason: "in-flight helm render runs are keyed by chart root",
	},
	"dispatch/runners/rust-clippy.ts": {
		ownerKey: "project",
		reason: "clippy availability is keyed by the cargo working directory",
	},
	"dispatch/runners/spotbugs.ts": {
		ownerKey: "project",
		reason: "SpotBugs installation lookup, host-derived",
	},
	"dispatch/runners/tree-sitter.ts": {
		ownerKey: "project",
		reason: "the blast cooldown is keyed by file path",
	},
	"dispatch/runners/yaml-rule-parser.ts": {
		ownerKey: "project",
		reason:
			"parsed rule caches are keyed by rule directory and revalidated on a cadence",
	},
	"disposition-publish.ts": {
		ownerKey:
			"process-wide: the disposition publisher is registered once per process and holds no session answer",
		reason: "disposition publisher registration",
	},
	"ephemeral-root.ts": {
		ownerKey:
			"process-wide: temp-directory classification settled once per process, like the data dir it selects",
		reason: "classification of directory spellings, FIFO-bounded at 1024",
	},
	// #2507: the in-flight tool-call keep-alive. Deliberately NOT reset at a
	// session boundary: a session_start can land mid-turn (see
	// clients/bootstrap.ts), and clearing a hold there would un-hold a tool
	// call that is still running — reintroducing the exact drain (a headless
	// child exiting 0 mid `lsp_diagnostics`) the hold exists to prevent. The
	// hold is scoped to one call's try/finally and bounded by its own max-age
	// failsafe, not by the session.
	"event-loop-hold.ts": {
		ownerKey:
			"process-wide: an in-flight tool call holds this process's event loop open, scoped to one call's try/finally",
		reason:
			"in-flight tool-call keep-alive; scoped to one call's try/finally and force-released by its own max-age failsafe — a session boundary that cleared it would un-hold a still-running call and reintroduce #2507",
	},
	"extension-log.ts": {
		ownerKey:
			"process-wide: the console method guard is installed on this process's console",
		reason: "console-method guard installation",
	},
	"file-kinds.ts": {
		ownerKey:
			"process-wide: file-kind lookup tables built at import from the language registry",
		reason: "the extension to kind map is filled while the module loads",
	},
	"file-time.ts": {
		ownerKey: "session",
		sessionSeamException:
			"reads is keyed by the sessionID string a caller passes to the FileTime constructor, not by a scope cell: the module reads no ambient session, so there is nothing to derive a scope from",
		reason:
			"#5036 F1: the read stamps live in the module object globalState, a store the module-container scan did not read before; clearFileTimeSessions (clearAllSessions) empties it at session_start (runtime-session.ts). #5120 deleted the write locks with their only caller, the partial-apply writer",
	},
	"file-utils.ts": {
		ownerKey: "project",
		reason:
			"the settledDataDirs project-directory memo is process-lifetime identity state; it is keyed by configured base and resolved cwd, and resetting it at session_start would repeat filesystem migration checks without changing identity. The projectIgnoreMatcherCache and projectIgnoreGlobsCache in the same file are signature-validated content caches: every read re-checks .gitignore mtime+size, the .pi-lens.json path+mtime+size and the global-config mtime, with a 2 s cadence sweep for newly created nested sources, so a session boundary reset is unnecessary (#2929 round 4, F1)",
	},
	"format-events-publish.ts": {
		ownerKey:
			"process-wide: the format event publisher is registered once per process and holds no session answer",
		reason: "format event publisher registration",
	},
	"format-service.ts": {
		ownerKey: "session",
		sessionSeamException:
			"globalFormatService is one process-wide instance created for the first caller's session id and replaced by resetFormatService at every turn end, so a second live session shares the first one's FileTime stamps",
		reason: "the format service stamps files it formatted under one session id",
	},
	"generated-artifacts.ts": {
		ownerKey: "project",
		reason: "generated-file classification derived from path patterns",
	},
	"generation-guard.ts": {
		ownerKey:
			"process-wide: compile-time literal source names declared at module initialisation",
		reason:
			"declared generation sources, bounded by the literals in the source",
	},
	"generation-lock.ts": {
		ownerKey:
			"process-wide: memory of the OS process that last held a lock past a wait, keyed by lock directory",
		reason:
			"the last timed-out lock holder per lock directory, bounded at 16 entries",
	},
	"git-guard.ts": {
		ownerKey: "session",
		sessionSeamException:
			"the blocker sections are a durable turn-end record on disk, partitioned by owning session id (#4738, #4921), not a process container, and a scope cell does not outlive a restart; the writer passes its own session id and keeps only its own partition",
		reason: "git-guard turn state, cleared on the turn path",
	},
	"git-tracked-ignore.ts": {
		ownerKey: "repository",
		reason:
			"git tracked/ignored sets, invalidated by their own mtime checks rather than by the session boundary",
	},
	"hard-failure-summary.ts": {
		ownerKey: "project",
		reason: "per-root back-off stamps for the heavyweight scan clients",
	},
	"hashline-anchor.ts": {
		ownerKey: "project",
		reason:
			"anchor index entries are keyed by file path and bounded to the tool call",
	},
	"instance-registry-lock.ts": {
		ownerKey:
			"process-wide: the locks this process holds on the instance registry",
		reason: "own lock holds in a process singleton cell",
	},
	"instance-registry-tail.ts": {
		ownerKey:
			"process-wide: the instance-registry mutation tail must outlive every session by construction",
		reason: "the serialised mutation tail of the instance registry",
	},
	"instance-registry.ts": {
		ownerKey:
			"process-wide: the instance-registry enablement flag is read from this process's environment",
		reason: "instance-registry enablement flag",
	},
	"jscpd-client.ts": {
		ownerKey: "project",
		reason: "in-flight scans are keyed by project root",
	},
	"knip-client.ts": {
		ownerKey: "project",
		reason:
			"scans, durations and completed results are keyed by canonical project root",
	},
	"language-registry.ts": {
		ownerKey:
			"process-wide: language lookup tables built at import from the registry",
		reason:
			"extension, filename, id and kind maps are filled while the module loads",
	},
	"lens-events.ts": {
		ownerKey:
			"process-wide: the lens event publisher is registered once per process and holds no session answer",
		reason: "lens event publisher registration",
	},
	"lens-flag-registry.ts": {
		ownerKey:
			"process-wide: a lookup over the frozen LENS_FLAGS table built at import",
		reason: "flag specs by name",
	},
	"lsp-budget.ts": {
		ownerKey:
			"process-wide: the LSP budget decision is about this machine's resources, shared across processes",
		reason: "cross-process LSP budget decision, re-read on its own cadence",
	},
	"lsp/capabilities.ts": {
		ownerKey:
			"process-wide: capabilities adapted per LSP service of the pool shared across sessions",
		reason: "a WeakMap keyed by the LSP service object",
	},
	"lsp/client-registry.ts": {
		ownerKey:
			"process-wide: the shared LSP client pool, kept warm across sessions by design",
		reason:
			"spawned clients, failure counts, leases and idle timers of the shared pool",
	},
	"lsp/client.ts": {
		ownerKey:
			"process-wide: per-connection bookkeeping of the LSP client pool, which is shared across sessions by design",
		reason:
			"per-connection request bookkeeping, torn down with the connection. #2065 fix round 1 added `activeLspClients`, a projection registry (not an independent source of truth — see its doc comment) that lets memory-sampler.ts total retained-text bytes without importing LSPService. It deliberately spans sessions, matching the LSP clients it mirrors, which are themselves kept warm across session boundaries: a session_start reset would desync the projection from live connections rather than protect anything. Its only writers are spawnClient (add) and disposeClientConnection (delete), and disposeClientConnection is the single convergence point every permanent-death path already funnels through, so membership is torn down exactly when the connection it describes is. #2130 round 2 moved it behind getProcessSingleton so it is one Set per PROCESS rather than one per module evaluation: the sampler runs in a single evaluation, and a module-scope Set made every other evaluation's clients — which is where a secondary root's servers live — invisible to it. The lifetime argument above is unchanged; only the number of copies is.",
	},
	"lsp/config.ts": {
		ownerKey: "project",
		reason: "LSP config in-flight dedupe, per-load not per-session",
	},
	"lsp/created-import-targets.ts": {
		ownerKey: "session",
		sessionSeamException:
			"the scan rollup is one process singleton cell with a single cwd field, so concurrent sessions fold into one tally that its snapshot reports as this session's",
		reason: "the producer tally of the created-import scan",
	},
	"lsp/document-drift.ts": {
		ownerKey:
			"process-wide: per-connection document sync bookkeeping of the shared LSP pool",
		reason: "synced document records and pending resyncs of one LSP connection",
	},
	"lsp/jvm-runtime.ts": {
		ownerKey:
			"process-wide: the resolved JVM location is a fact about this machine",
		reason: "resolved JVM location; a session boundary cannot move it",
	},
	"lsp/ruby-drive-dirs.ts": {
		ownerKey: "project",
		reason: "Ruby directory names are keyed by project root",
	},
	"lsp/service-singleton.ts": {
		ownerKey:
			"process-wide: the LSP service singleton is one per process by design; sessions share the pool",
		reason:
			"the owner stores the process-wide singleton identity and pending teardown handoff; session-scoped resets are delegated to the registered implementation hooks, while the owner itself has no independent session verdict to re-arm",
	},
	"lsp/spawn-history.ts": {
		ownerKey:
			"process-wide: spawn duration history of the shared LSP pool, deliberately spanning sessions",
		reason:
			"successful spawn duration history intentionally spans session boundaries within the host process so later sessions can avoid waits that prior evidence proves cannot succeed",
	},
	"lsp/watch-queue.ts": {
		ownerKey:
			"process-wide: the file-watch event queue of one LSP connection in the shared pool",
		reason:
			"pending watched-file events for one connection, flushed on a timer",
	},
	"lsp/workspace-diagnostics-cache.ts": {
		ownerKey: "project",
		reason:
			"#1669 review F1/F2/N3: a sweep-cwd discovery registry (idempotent — re-registers on every createWorkspaceDiagnosticsCacheContext call) plus a per-cwd cache epoch. Neither needs a session_start reset, but a session boundary is NOT harmless for the registry: a refresh for a cwd this process has not yet swept clears nothing on disk (the review's N3 finding) until that cwd is finally reached, at which point clearWorkspaceDiagnosticsCache's state.root fallback and the epoch's on-disk generation field (durable across the boundary, unlike the in-memory map alone) recover it. A session_start wipe would only widen that window, not close it, so exemption is still correct — the fix is durability at the write site, not a reset seam here. #4322 adds `RELEASED_OLDER_CACHE_VERSIONS`, an import-time constant set of released cache versions that nothing writes after load (SWEEP_HEURISTIC_LIMITS item 5); a session boundary cannot change it.",
	},
	"mcp/analyze.ts": {
		ownerKey: "project",
		reason:
			"warm word-index cache keyed by path with its own freshness check. #2455 fix round 2: the widened detector (any class declared in clients/, not just clear()/delete()-owning ones) also now flags `warmGraphFacts`, a module-scope FactStore. #2455 fix round 3, F3: an earlier draft of this exemption claimed the MCP server has no pi session_start boundary to hook into. That is false — `clients/mcp/session.ts`'s runSessionStart calls handleSessionStart, and `mcp/server.ts` runs it both at boot (:252) and from the `pilens_session_start` tool (:1631) — so the exemption rests only on its real merits. `warmGraphFacts` is deliberately reused across calls by design (#536: buildOrUpdateGraph's incremental/cached tiers key off a stable instance, so a fresh store per call would defeat that reuse), and its entity-snapshot diff self-heals on eviction (wasBoundedSessionFactEvicted). It is NOT risk-free: the entity-snapshot key has no cwd component, so a warm process serving two projects that share a relative path could cross-contaminate a diff — filed as #2477, out of scope for the detector fix itself.",
	},
	"mcp/session.ts": {
		ownerKey: "session",
		sessionSeamException:
			"the MCP server holds one session context per process that runSessionStart replaces, and its turn-end queue and delivery maps are keyed by cwd with no session id, so a second live session would share them",
		reason:
			"MCP turn-end delivery chain, drained per turn; its session context is replaced, not accumulated. #2455 fix round 2: the widened detector also now flags `turnEndQueue`, a non-exported TurnEndQueue instance — the serial queue this same delivery chain drains through. It already has a reset seam (`_resetTurnEndChain`, exported above), and the same reasoning applies: at most one item is ever pending (a second enqueue is rejected busy), and each carries its own 5s unref'd timeout, so nothing accumulates across a boundary. (#2455 fix round 3, F3: an earlier draft added the clause 'and MCP has no pi session_start boundary for this file to hook into anyway'. Struck — it is false. runSessionStart in this very file calls handleSessionStart, and `mcp/server.ts` runs it at boot (:252) and from the `pilens_session_start` tool (:1631).)",
	},
	"metrics-client.ts": {
		ownerKey: "project",
		reason: "per-file content and entropy baselines keyed by file path",
	},
	"module-report-lsp.ts": {
		ownerKey:
			"process-wide: a frozen kind vocabulary and a config memo derived from the LSP registry, the same for every session",
		reason: "module-report LSP config memo",
	},
	"module-report.ts": {
		ownerKey:
			"process-wide: a per-language extractor cache and frozen node-kind vocabularies",
		reason: "grammar-derived extractors keyed by language id",
	},
	"mutating-tool.ts": {
		ownerKey:
			"process-wide: a call-scoped hand-off keyed by the host's unique tool-call id and a frozen tool-name table",
		reason:
			"#2423: the built-in tool-name table is an import-time frozen lookup (SWEEP_HEURISTIC_LIMITS item 5), and the resolved-range carry is CALL-scoped — one entry per toolCallId, written by the tool_call classification and read by that same call's tool_result, drained FIFO at 64 entries. Host tool-call ids are unique per call, so a carried entry cannot be read by a later session; a session_start reset would be redundant, not missing",
	},
	"ndjson-logger.ts": {
		ownerKey:
			"process-wide: the log sink is shared by every session of this process; the exit flushers and the set of registered log files describe the process, not a session",
		reason:
			"#5036 F2: exitFlushers and registeredLogFiles are declared as `a ?? b ?? new Set()` over the canonical globalThis state, a spelling the container scan did not read before; both describe the process, not a session",
	},
	"out-of-band-changes.ts": {
		ownerKey: "project",
		reason: "root records and owed walks are keyed by project root",
	},
	"package-root.ts": {
		ownerKey: "project",
		reason: "the package root is cached per directory",
	},
	"partial-edit-apply.ts": {
		ownerKey:
			"process-wide: a store instantiated by RuntimeCoordinator (runtime.partialApplyRecords); the owner is stated on its runtime-coordinator.ts row",
		reason: "applied partial-edit records for the instance that owns the store",
	},
	"pipeline.ts": {
		ownerKey: "project",
		reason: "the eslint autofix availability is keyed by cwd and PATH",
	},
	"probe-home-state.ts": {
		ownerKey:
			"process-wide: the probe-home redirect decision is fixed by this process's cwd and environment",
		reason:
			"#2506: the globalThis-keyed probe-home-redirect RESOLUTION (the memoized decision plus the degradation event it produced), the same shape as process-singletons.ts's container just below — a PROCESS boundary, not a session one. getGlobalPiLensLogDir()'s redirect decision is fixed by cwd/env at process start and is memoized once, so a session_start reset would only hide the fact from every session after the first in the same probe process. The slot key is a module-scope Symbol.for constant, which the container scan does not count. #2516 round 2 moved getGlobalPiLensLogDir() and the whole redirect decision into this module: it is off file-utils.ts's import cycle, so its own bindings can never be observed mid-initialization the way a resolver living in file-utils.ts could.",
	},
	"process-bridge.ts": {
		ownerKey:
			"process-wide: bridge dependencies of the live activation, rebound by each activation",
		reason:
			"versioned process singleton cells holding the mounted bridge's dependencies",
	},
	"process-singletons.ts": {
		ownerKey:
			"process-wide: the globalThis container for process-scope state; it owns storage, never lifecycle",
		reason:
			"the globalThis-keyed container for process-scope state (#2146). It owns storage, never lifecycle: every family keeps whatever boundary it already had, and each one is a PROCESS boundary rather than a session boundary. session-lifecycle.ts releases its registration at the primary's own session_shutdown (releasePrimarySession), not at session_start. startup-timing.ts's host-ready anchor is registered here as policy process_lifetime with a ForTests-only reset, because resetting it at a session boundary would fabricate host stalls from the original process boot. The instance-registry mutation tail must outlive every session by construction. A reset in this module would therefore wipe state no session boundary owns. Its only module-scope binding is the Symbol.for container key, a constant.",
	},
	"project-changes.ts": {
		ownerKey: "project",
		reason:
			"change-log sequence fold counter, an observability tally; and (#3511) the per-log read cursor, a bounded (16) content-keyed memo of the append-only change log's byte offset and max seq. Every full read of the log re-seeds it, so a session_start reset would only force the next logged edit to re-read the whole log",
	},
	"project-lens-config.ts": {
		ownerKey: "project",
		reason:
			"project .pi-lens config cache with its own mtime-based invalidation",
	},
	"project-report.ts": {
		ownerKey: "project",
		reason: "project-report build guard, per build",
	},
	"project-scale.ts": {
		ownerKey: "project",
		reason: "project-scale base measurement, recomputed on its own inputs",
	},
	"project-snapshot.ts": {
		ownerKey: "project",
		reason:
			"snapshot parse caches and the bounded per-root persist coordinator are process-lifetime state keyed by content/generation; a session reset must not abandon an in-flight durable publication",
	},
	"project-trust.ts": {
		ownerKey: "project",
		reason:
			"install-refusal warn-once set, tied to the trust decision rather than the session",
	},
	"python-provenance.ts": {
		ownerKey:
			"process-wide: frozen Python provenance tables and a WeakMap keyed by parse root",
		reason: "provenance summaries dropped with their parse tree",
	},
	"quiet-window-config.ts": {
		ownerKey:
			"process-wide: the environment-derived quiet-window kill switch and wait budget of this process",
		reason:
			"the env-derived quiet-window kill switch and wait budget, split out of quiet-window.ts by #1462; a memo of configuration, not of a session verdict",
	},
	"quiet-window.ts": {
		ownerKey:
			"process-wide: quiet-window task registration, one registry per process",
		reason: "quiet-window task registration",
	},
	"read-guard-tool-lines.ts": {
		ownerKey: "session",
		sessionSeamException:
			"recentOldTextFailures is a process FIFO keyed by file path and edit preview that counts the agent's repeated oldText failures, with no session in the key; a 300 s TTL and 200 entries bound it",
		reason:
			"repeat-failure counts that escalate the message for the agent's repeated edit mistakes",
	},
	"read-guard.ts": {
		ownerKey: "session",
		sessionSeamException:
			"ReadGuard instances live on the read-guard scope cell (SESSION_CELL_KEYS) and on RuntimeCoordinator._foreignReadGuards, so these fields belong to one instance, not to a process container",
		reason:
			"reads, edits and written bytes of the agent's conversation, held per ReadGuard instance",
	},
	"recent-touches.ts": {
		ownerKey: "project",
		reason: "the recent-touch cursor, consumed and advanced per read",
	},
	"resource-sampler.ts": {
		ownerKey: "process-wide: CPU history of this machine's processors",
		reason: "Windows CPU sample history keyed by processor",
	},
	"review-graph/git-identity.ts": {
		ownerKey: "repository",
		reason:
			"no module state since #3417: the per-cwd git-dir memo was deleted (a cached null hid a mid-session `git init`), the identity is memoized per build inside the builder, and the reset seam is a compatibility no-op",
	},
	"review-graph/shared-extraction-ir.ts": {
		ownerKey: "project",
		reason:
			"extraction IR keyed by cwd and file, invalidated by the graph build that produced it",
	},
	"runtime-config.ts": {
		ownerKey:
			"process-wide: the environment-derived runner timeout floor of this process",
		reason: "env-derived runner timeout floor",
	},
	"runtime-coordinator.ts": {
		ownerKey: "session",
		sessionSeamException:
			"RuntimeCoordinator is built once per extension instance and shared by concurrent primaries, so its remaining per-turn and per-session fields answer for whichever session wrote last; turn-warnings and the read guard already moved onto scope cells",
		reason:
			"per-turn and per-session working state of the runtime coordinator instance",
	},
	"runtime-tool-result.ts": {
		ownerKey: "session",
		sessionSeamException:
			"inFlightPipelines, lastAnalyzedStateByFile and debouncedPipelines are keyed by file path with no session in the key, so two live sessions editing one file share a pipeline flight, a last-analyzed turn index and a debounce slot",
		reason: "in-flight pipeline and last-analyzed memo, per file and per call",
	},
	"security-scan-client.ts": {
		ownerKey: "project",
		reason: "in-flight scans are keyed by project root",
	},
	"session-lifecycle.ts": {
		ownerKey:
			"process-wide: the session_start decision seam holds process registration, not a session answer",
		reason:
			"the session_start decision seam itself — it is the boundary, not state behind it",
	},
	"session-scope.ts": {
		ownerKey: "session",
		sessionSeamException:
			"this file is the seam: Scope.cells and boundKeys are one Scope's own storage, retired with that scope; sessionStores is the process registry of declared store specs",
		reason:
			"the scope cells themselves and the declared session store registry",
	},
	"sg-runner.ts": {
		ownerKey: "process-wide: ast-grep binary resolution facts of this machine",
		reason: "sg path candidates probed on this host",
	},
	"sgconfig.ts": {
		ownerKey:
			"process-wide: bundled ast-grep rule snapshots shipped with the extension, the same for every session",
		reason:
			"bundled ast-grep rule snapshots and baselines, shipped with the extension",
	},
	"slow-fs.ts": {
		ownerKey:
			"process-wide: the measured filesystem latency classification of this host's mounts",
		reason: "measured filesystem-latency classification of the host",
	},
	"source-walker.ts": {
		ownerKey:
			"process-wide: a per-listing memo discarded with the directory listing",
		reason: "case-folded entry names memoised on one DirectoryListing",
	},
	"subagent-mode.ts": {
		ownerKey:
			"process-wide: the subagent-mode flag is fixed for the process by construction",
		reason: "subagent-mode flag, fixed for the process by construction",
	},
	"test-runner-client.ts": {
		ownerKey: "project",
		reason: "runner availability and test globs are keyed by project root",
	},
	"tool-agreement.ts": {
		ownerKey:
			"process-wide: a memo of tool-agreement verdicts keyed by tool evidence bucket, bounded at 512",
		reason: "agreement verdicts derived from tool evidence",
	},
	"tool-policy.ts": {
		ownerKey: "project",
		reason:
			"frozen tool policy tables plus a spotless Kotlin config cache keyed by project directory",
	},
	"tree-sitter-cache.ts": {
		ownerKey: "project",
		reason: "parsed trees are keyed by file path and validated by content hash",
	},
	"tree-sitter-client.ts": {
		ownerKey:
			"process-wide: grammar load state and query caches of the tree-sitter client, derived from this machine's installed grammars",
		reason:
			"grammar paths, retry clocks and query caches keyed by language and grammar",
	},
	"tree-sitter-query-loader.ts": {
		ownerKey:
			"process-wide: the bundled query root health and parsed queries are the same for every session",
		reason:
			"#2636 review round 2, F3: getBundledQueriesRootHealth's memo of the bundled rules/tree-sitter-queries root's health, keyed on the degradation ledger's OWN generation counter (bumped by resetDegradationLedger, wired into handleSessionStart) rather than 'compute once, forever' — round 1's version overclaimed that a bundled install location cannot change mid-process, but a managed-cache RELOCATION of a live install is exactly the failure #2587/#2626 investigated. It is invalidated by its own generation compare on every read (same shape as diagnostic-line-freshness.ts's mtime+size re-stat below), not by an explicit reset call this module would need to register — a session boundary is exactly when it re-probes, it just does so lazily on next access rather than eagerly at session_start.",
	},
	"tree-sitter-symbol-extractor.ts": {
		ownerKey:
			"process-wide: static node-kind vocabularies of the extractor class",
		reason: "frozen sets shared by every extractor instance",
	},
	"turn-summary.ts": {
		ownerKey:
			"process-wide: a collector instantiated by RuntimeCoordinator (_turnSummary); the owner is stated on its runtime-coordinator.ts row",
		reason:
			"the per-run turn summary accumulator for the instance that owns it",
	},
	"warm-attach.ts": {
		ownerKey:
			"process-wide: the warm-attach IPC server and incumbent role belong to this process instance",
		reason:
			"the warm-attach IPC server and incumbent-PID role, which belong to the process instance, not the session; its served-diagnostic dedupe is keyed by content hash, so a carried entry can only mean the answer is unchanged",
	},
	"widget-state.ts": {
		ownerKey: "session",
		sessionSeamException:
			"the module Maps files and lspServers hold the footer records of the one primary session and are rebuilt from their sources; widgetStore carries the snapshot across a transition (SESSION_STORE_REGISTRY widget)",
		reason:
			"widget render state, rebuilt from the sources it displays. #2275 added `renderedDependencyDriftFiles`, the set of files whose dependency-drift demotions the footer has drawn since the last turn end: it is drained (emptied) by every turn end's delivery-cap step and cleared by clearWidgetState, so it is turn-scoped working state that cannot outlive a session even without its own reset",
	},
	"word-index-store.ts": {
		ownerKey: "project",
		reason: "the file id table belongs to one project word index",
	},
	"word-index.ts": {
		ownerKey: "project",
		reason:
			"word-index build guard, per build; asyncWordIndexOperations queue is keyed by WordIndex and self-deletes in finally, so it needs no reset",
	},
	"write-ordering-guard.ts": {
		ownerKey:
			"process-wide: a generic ordering guard; each instance's owner is the module that constructs it (widget-state.ts, RuntimeCoordinator) and states its own owner",
		reason:
			"last-seen write order per key for the instance that owns the guard",
	},
};

/**
 * SYMBOL-granularity backstop for the file-granular audit above — #1817.
 *
 * `EXEMPT_SESSION_STATE_FILES` and `SESSION_STATE_REGISTRY` both answer "is
 * this FILE accounted for". Neither answers "how many stateful symbols does
 * the scan see IN it right now" — so a new module-level `Map`/`Set` added
 * inside a file that already registered or exempted, is invisible to the
 * coverage sweep. That is exactly #1801 review F1's shape: `staleGrammarVersionAt`
 * landed on `TreeSitterClient` (backed by the already-registered
 * `tree-sitter-shared.ts`) with no session_start reset, and the sweep stayed
 * 55/55 green because the file itself was already accounted for.
 *
 * This table pins `symbolCount()` of `scanSessionStateCandidates()` (module
 * containers that are not an admitted read-only constant, plus class fields
 * bound to a container, #5027) for
 * every file the scan currently flags — registered AND exempted alike, since
 * an exemption's reason is written against the symbols known at the time it
 * was granted, and a new symbol arriving under cover of an old exemption is
 * the same silent-drift shape. A count that no longer matches is not a
 * failure by itself — it is a REQUIRED stop: decide whether the new symbol
 * needs a registry entry, a reset, or its own exemption reason, then update
 * the pinned number here.
 *
 * Before #5027 the number counted every module container, constants included;
 * the `(n -> m)` notes below that name an import-time lookup table record that
 * history, and the number itself no longer counts such a constant.
 *
 * Generated from a full scan at the time this table was written (`node
 * -e`-style dump of `scanSessionStateCandidates()`, one row per flagged
 * file). Keep it sorted; the coverage test below diffs it against a live
 * scan on every run, so a stale or missing entry reds immediately rather than
 * silently under- or over-counting.
 */
export const SESSION_STATE_SYMBOL_COUNTS: Readonly<Record<string, number>> = {
	"agent-behavior-client.ts": 3,
	"agent-nudge.ts": 1,
	"ast-grep-client.ts": 2,
	"biome-client.ts": 1,
	"blocker-freshness.ts": 4,
	// #2467: flagged because the file now exports a session_start reset; the
	// scan counts no module-scope CONTAINER here (the gate is a boolean and the
	// resident slot a nullable reference).
	"bootstrap.ts": 0,
	"bounded-cache.ts": 2,
	"bounded-pid-file-lock.ts": 1,
	"bounded-telemetry.ts": 1,
	"bus-events-logger.ts": 1,
	"bus-publish.ts": 0,
	// #4403 round 5 (V1): the primaries whose cascade line was delivered,
	// registered above and reset by resetDispatchBaselines.
	// #4487: the cascade pending-error record (1 -> 2), registered above and
	// reset by resetDispatchBaselines.
	"cascade-format.ts": 2,
	"complexity-client.ts": 24,
	"config-core/records.ts": 1,
	"config-resolve.ts": 2,
	// #2418: the one warn-once latch behind all three config loaders, moved
	// here out of lens-config.ts and project-lens-config.ts.
	// #2426: 1 -> 2. The second symbol is `DEPRECATION_NOUN_BY_CODE`, an
	// import-time `Map` DERIVED from `DEPRECATED_CONFIG_SURFACES` — a lookup
	// table over a frozen data leaf, not session state (SWEEP_HEURISTIC_LIMITS
	// item 5: the scan cannot tell a constant `Map` from a mutable one). It is
	// never written after module evaluation, so resetting it would be
	// meaningless; the file's one real latch is still the warn-once Set above.
	"config-warn.ts": 1,
	// #4212 round 4: one bounded container — the per-dispatch-cycle rule-corpus
	// fingerprint map (cap 16, FIFO eviction). The single-slot read-through in
	// front of it and `_resetRuleCorpusCycleFingerprintsForTests` are the same
	// state, not extra containers. See this file's EXEMPT_SESSION_STATE_FILES
	// entry for why the turn boundary, not session_start, invalidates it.
	"custom-rule-locations.ts": 1,
	"dead-code-client.ts": 2,
	// #2505: 3 -> 4. The fourth symbol is `INFORMATIONAL_DEGRADATION_KINDS`,
	// an import-time `ReadonlySet` of kind names the health renderer prints
	// without the warning marker — a lookup table, not session state
	// (SWEEP_HEURISTIC_LIMITS item 5: the scan cannot tell a constant `Set`
	// from a mutable one). It is never written after module evaluation, so
	// resetting it would be meaningless; this file's real session state is
	// still the ledger map, its once-keys, and the generation counter.
	"degradation-ledger.ts": 3,
	"dependency-checker.ts": 8,
	"diagnostic-dispositions.ts": 1,
	"diagnostic-line-freshness.ts": 1,
	"diagnostics-publish.ts": 1,
	"disk-changes.ts": 0,
	"dispatch/auxiliary-lsp.ts": 1,
	"dispatch/collect-later-tier.ts": 1,
	// #2346 added `generatedSkipRecorded` beside `coverageNoticeSeen` (1 → 2);
	// both are cleared by the same session-start reset seam.
	"dispatch/dispatcher.ts": 3,
	"dispatch/fact-store.ts": 5,
	// #1899 removed the dead `neighborTouchCache` (10 → 9); #2282 removed the
	// redundant `cascadeDiagnosticBaselines` shadow map (9 → 8).
	// #2455 fix round 1: the container scan recognised any repo-local class
	// owning a `clear()`/`delete()` method instead of a hard-coded name list,
	// so `sessionRunnerRegistry` (`new RunnerRegistry()`) was counted (8 → 9).
	// It is an import-time-built lookup with no session lifetime
	// (SWEEP_HEURISTIC_LIMITS item 5, same as this file's other frozen
	// vocabulary constants) — no new registry entry needed.
	// #2455 fix round 2: the predicate widened again, from "owns clear()/
	// delete()" to "declared in clients/" (any export shape). `sessionFacts`
	// (`new FactStore("dispatch")`) is now ALSO counted (9 → 10) — FactStore's
	// own clear methods are named `clearAll`/`deleteFileFact`, so round 1's
	// method-name filter still missed it. Already registered above
	// (dispatch-integration:sessionCaches names `sessionFacts` and its reset
	// clears it via a method call) — only the pin was stale.
	// #2455 fix round 4: the container regex now also allows an `export`
	// prefix, so `CASCADE_GRAPH_KINDS` (an exported module-level `new Set`) is
	// counted (10 -> 11). Import-time frozen vocabulary, same class as this
	// file's other constant lookups above — SWEEP_HEURISTIC_LIMITS item 5.
	// #4485: the recently-clean neighbour cache is deleted (11 -> 10); the
	// pending record in cascade-format.ts replaces it.
	// #4483 (10 -> 12): `preEditCaptureFacts`, the pre-edit capture's file
	// facts, cleared by `resetDispatchBaselines` (the sessionCaches entry); and
	// `preEditCapturesInFlight`, which holds an entry only while that file's
	// capture runs (at most four); reset aborts each controller and each capture
	// releases its slot after teardown, preventing overlap across resets.
	"dispatch/integration.ts": 8,
	// #3968: the runner-id identity leaf beside the dispatcher — one Set fed
	// by `RunnerRegistry.register` and re-derived at every process start
	// (registration state, not session state); see the file-level exemption
	// above and the bounded-container admission row.
	"dispatch/known-runner-ids.ts": 1,
	"dispatch/rule-id-normalize.ts": 1,
	"dispatch/runners/ast-grep-literal-anchors.ts": 1,
	// #2215 added the language matrix's two derived lookups
	// (`BINDING_BY_EXTENSION`, `LSP_ONLY_RULE_LANGUAGES`) (5 → 7). Both are
	// import-time frozen lookups with no session lifetime —
	// SWEEP_HEURISTIC_LIMITS item 5, not state that must re-arm.
	"dispatch/runners/ast-grep-napi.ts": 1,
	"dispatch/runners/biome-check.ts": 1,
	"dispatch/runners/eslint.ts": 1,
	"dispatch/runners/helm-lint.ts": 1,
	"dispatch/runners/helm-render.ts": 1,

	"dispatch/runners/psscriptanalyzer.ts": 2,
	"dispatch/runners/rust-clippy.ts": 1,

	// #2442 review F2: the container regex now recognises BoundedFifoMap /
	// BoundedLruCache, so this file's module-level bounded cache is counted.
	"dispatch/runners/spotbugs.ts": 1,
	"dispatch/runners/tree-sitter.ts": 1,
	"dispatch/runners/utils/lazy-installer.ts": 2,
	"dispatch/runners/utils/runner-helpers.ts": 7,
	"dispatch/runners/yaml-rule-parser.ts": 4,
	"disposition-publish.ts": 0,
	"ephemeral-root.ts": 1,
	"event-loop-hold.ts": 0,
	"extension-log.ts": 2,
	"file-kinds.ts": 2,
	"file-time.ts": 1,
	// #2874: the live scan sees settledDataDirs plus the two project-ignore
	// caches. All three ride the file-level exemption above: the ignore caches
	// are signature-validated per call (#2929 round 4, F1), so no reset exists
	// to register. This pin counts all three module-level containers, not the
	// migration queue array.
	"file-utils.ts": 3,
	"format-events-publish.ts": 0,
	"format-service.ts": 1,
	// #2442 review F2: the container regex now recognises BoundedFifoMap /
	// BoundedLruCache, so this file's module-level bounded cache is counted.
	// #2455 fix round 4: the container regex now also allows an `export`
	// prefix, so `FORMATTERS_WITH_EXPLICIT_CONFIG_CHECK` (an exported
	// module-level `new Set`) is counted (8 -> 9). An import-time frozen
	// vocabulary with no session lifetime — SWEEP_HEURISTIC_LIMITS item 5, and
	// this file's existing registry entries already cover its real caches.
	// #2756 round 3: the live container scan includes the module-level
	// formatterSignatureFlights cache added with the project-root cwd resolver.
	// #2777 folded the formatter marker map into tool-cwd.ts, removing one
	// import-time container from this module.
	"formatters.ts": 6,
	// #2442 review F2: the container regex now recognises BoundedFifoMap /
	// BoundedLruCache, so this file's module-level bounded cache is counted.
	"generated-artifacts.ts": 1,
	"generation-guard.ts": 1,
	"generation-lock.ts": 1,
	// #2007 hoisted git's global-option table to a module-level `new Set`
	// (1 → 2). It is an import-time frozen lookup with no session lifetime —
	// SWEEP_HEURISTIC_LIMITS item 5, not state that must re-arm.
	"git-guard.ts": 0,
	"git-tracked-ignore.ts": 3,
	// #2455 fix round 4, F2: `go-client.ts` now owns the process's ONE
	// `GoClient` (`export const goClient = new GoClient()`) and the
	// `resetGoAvailability` seam beside it, so the pair-with-reset rule flags
	// it here instead of in `dispatch/runners/go-vet.ts`. Round 2 put the
	// instance in the runner and let `bootstrap.ts` build a SECOND one for the
	// object `handleSessionStart` reads, so the reset re-armed a latch nothing
	// user-visible consulted. Registered above (go-client:goClientAvailability).
	// Visible only because the container regex now allows an `export` prefix —
	// without that widening this fix would have moved the state OUT of the
	// sweep's view.
	"go-client.ts": 1,
	"hard-failure-summary.ts": 1,
	"hashline-anchor.ts": 1,
	// #2442 review F2: the container regex now recognises BoundedFifoMap /
	// BoundedLruCache, so this file's module-level bounded cache is counted.
	"installer/index.ts": 12,
	"instance-registry-lock.ts": 0,
	"instance-registry-tail.ts": 0,
	"instance-registry.ts": 0,
	"jscpd-client.ts": 2,
	"knip-client.ts": 5,
	"language-profile.ts": 1,
	"language-registry.ts": 3,
	"latency-logger.ts": 2,
	// #2418 removed lens-config.ts's row: its only module-scope state was the
	// warn-once set, now owned by config-warn.ts, so the scan no longer flags
	// the file at all.
	"lens-events.ts": 0,
	"lens-flag-registry.ts": 1,
	"lsp-budget.ts": 0,
	"lsp/capabilities.ts": 1,
	"lsp/cascade-tier.ts": 1,
	"lsp/client-registry.ts": 20,
	// #2065 fix round 1: 2 -> 3 for activeLspClients (see
	// EXEMPT_SESSION_STATE_FILES).
	// #2130 round 2: 3 -> 2. The `activeLspClients` module-level `new Set` moved
	// behind `getProcessSingleton`, so the scan no longer sees a module-scope
	// container here. The state did not disappear — it moved UP, from one copy
	// per module evaluation to one per process — and it stays exempt from a
	// session_start reset for exactly the reason recorded above.
	"lsp/client.ts": 1,
	// #2442 review F2: the container regex now recognises BoundedFifoMap /
	// BoundedLruCache, so this file's module-level bounded cache is counted.
	// #2427 review round 2 took this to 3 for a `silentInFlight` set; round 3
	// deleted the set with the `initLSPConfig` call that needed it, so the file
	// was back to `workspaceConfigs` + `configInFlight`.
	// #2518: 2 -> 1. `workspaceConfigs` is gone — the per-root config is now the
	// session-root registry's own value (`lsp/session-roots.ts`), so a config
	// cannot be evicted while its root is still served. `configInFlight`
	// remains here.
	// #5036 N1: `configInFlight` + `EMPTY_CONFIG.disabledServerIds` +
	// `EMPTY_CONFIG.serverOverrides` (the module-level literal's members).
	"lsp/config.ts": 3,
	"lsp/created-import-targets.ts": 0,
	// #5036 N1: `DocumentDriftTracker.synced` + `DocumentDriftTracker.pendingResync`
	// (class fields) + `SKIPPED.queued` (a module-level literal's member).
	"lsp/document-drift.ts": 3,
	// #2372 slice 3: 2 -> 1. The never-mutated `OPTIONAL_LSP_SERVER_IDS` set
	// moved to lsp/client-registry.ts with the spawn path that reads it; that
	// module exports no reset, so the scan does not flag it.
	"lsp/index.ts": 18,
	"lsp/jvm-runtime.ts": 0,
	// #2324 R2-A added `napiFallbackCoverage`, the napi-run hand-off map
	// (1 → 2). Registered above and cleared by the same
	// `resetPendingAuxiliaryCoverage`.
	"lsp/pending-aux-coverage.ts": 2,
	"lsp/ruby-drive-dirs.ts": 1,
	// #4547: 6 -> 8. `PYTHON_BOUNDARY_MARKERS` and `PYTHON_EXTENSIONS` are
	// import-time constant sets that nothing writes after load
	// (SWEEP_HEURISTIC_LIMITS item 5); a session boundary cannot change them.
	"lsp/server.ts": 4,
	"lsp/service-singleton.ts": 0,
	"lsp/session-roots.ts": 1,
	"lsp/spawn-history.ts": 1,
	"lsp/watch-queue.ts": 1,
	// #4322: `RELEASED_OLDER_CACHE_VERSIONS`, an import-time constant set the
	// scan cannot tell from state (1 -> 2). Exempted above, never written.
	"lsp/workspace-diagnostics-cache.ts": 1,
	// #4320 r2: `_fileCreations`, the bounded Created markers (per server,
	// root and path since #4346), registered above with `_allFilesChangedAt`.
	"lsp/workspace-diagnostics-session.ts": 1,
	"lsp/workspace-sweep-hold.ts": 0,
	// #2455 fix round 2: `warmGraphFacts` (`new FactStore("mcp-analyze")`) is now
	// counted (1 → 2) under the widened "declared in clients/" predicate. See
	// this file's EXEMPT_SESSION_STATE_FILES entry above for why it stays
	// exempt rather than registered.
	"mcp/analyze.ts": 2,
	// #2455 fix round 2: `turnEndQueue` (a non-exported `TurnEndQueue`,
	// unreachable by the round-1 `export class` regex and undiscoverable by its
	// clear()/delete()-shaped-method filter — it exposes `reset()`, not either
	// name) is now counted (2 → 3) under the widened "declared in clients/,
	// any export shape" predicate. See this file's EXEMPT_SESSION_STATE_FILES
	// entry above.
	"mcp/session.ts": 4,
	"metrics-client.ts": 1,
	// #5036 N1: `NO_LSP.byName` (a member of the module-level `NO_LSP` literal).
	"module-report-lsp.ts": 1,
	"module-report.ts": 3,
	// #2423: the frozen built-in tool-name table plus the call-scoped
	// resolved-range carry. Both are argued in EXEMPT_SESSION_STATE_FILES.
	"mutating-tool.ts": 1,
	"ndjson-logger.ts": 2,
	// #2000 phase 2: the pending-baseline store (one slot per cwd:generation)
	// plus the process-global Symbol.for slot; cleared via resetOpaqueMutationState.
	// #2060: 1 -> 3 for UNMERGED_PORCELAIN_STATUSES and
	// LEGAL_ORDINARY_PORCELAIN_STATUSES. Both are frozen-by-convention lookup
	// tables of Git's documented porcelain matrix — import-time constants with
	// no session identity, so they need no reset (SWEEP_HEURISTIC_LIMITS item 5).
	// #2007 added `gitToplevelMemo`, the worktree-identity cache (3 → 4). It
	// is registered above and cleared by the same `resetOpaqueMutationState`.
	// #4493: 4 -> 5, the HEAD records and the HEAD-look single-flight, both
	// in the entry above and cleared by `resetOpaqueMutationState`.
	// #4612 r4: 5 -> 6, `pendingHeadDiscards`, the discard paths a joined HEAD
	// look owes, in the entry above and cleared by the same reset.
	// #4732: 6 -> 7, `PI_BUILTIN_TOOL_WRITES`, the frozen table of what each of
	// pi's built-in tools can write — an import-time constant with no session
	// identity, so it needs no reset (SWEEP_HEURISTIC_LIMITS item 5).
	// #4905: 7 -> 8, `overCapRootMemo`, in the entry above and cleared by
	// `resetOpaqueMutationState`.
	"opaque-mutation-scan.ts": 6,
	"out-of-band-changes.ts": 2,
	// #1602 added `globalBinDirCache` (1 → 2), cleared by the same
	// `_resetPackageManagerCache` the registry entry above names.
	"package-manager.ts": 2,
	"package-root.ts": 1,
	"partial-edit-apply.ts": 1,
	// #2319: the verified-guess tally moved behind getProcessSingleton, so the
	// module-scope scan sees no container here; the getProcessSingleton SIGNAL
	// is what flags this file now.
	"path-attribution-telemetry.ts": 0,
	// #4320 r2: `replacedPathBirths`, registered above (process_lifetime).
	// #4368 r1 row 13: `appearedPaths` (1 -> 2), registered above.
	"path-birth.ts": 2,
	// #4689: `pathIdentityFallbacks` and its exported reset, registered above.
	"path-utils.ts": 1,
	"pipeline.ts": 1,
	// #2506: the container key is a Symbol.for constant, so the scan sees no
	// mutable module-scope container here — the same shape as
	// process-singletons.ts just below.
	"probe-home-state.ts": 0,
	"process-bridge.ts": 0,
	// #2146: the container key is a Symbol.for constant, so the scan sees no
	// mutable module-scope container here.
	"process-singletons.ts": 0,
	// #3511: 0 -> 1 for changeLogCursors, the change-log read cursor.
	"project-changes.ts": 1,
	// #2418: 3 -> 2, the warn-once set moved to config-warn.ts.
	"project-lens-config.ts": 2,
	"project-report.ts": 1,
	"project-scale.ts": 0,
	// #1785: 5 -> 6 for _lastNarrowParseDigestForTests. #1997: 6 -> 10 for
	// bounded successful/failed and active/latest-queued persist state.
	"project-snapshot.ts": 10,
	"project-trust.ts": 1,
	"python-provenance.ts": 2,
	"quiet-window-config.ts": 0,
	"quiet-window.ts": 0,
	"read-guard-tool-lines.ts": 1,
	"read-guard.ts": 12,
	"recent-touches.ts": 1,
	"resource-sampler.ts": 1,
	// #3605: 19 -> 20 for _wasmTrappedFiles, process-lifetime like the
	// tree-sitter client's trap map it follows: a session boundary resets
	// neither the wasm heap nor the client's charges, and each extraction
	// rewrites its file's entry, so a session_start clear would re-arm nothing.
	"review-graph/builder.ts": 19,
	// #3417: the module-level git-dir memo is gone; the count is pinned at 0 so a
	// re-hoisted memo (the stale-negative shape) fails this sweep, not just the
	// lifecycle test.
	"review-graph/git-identity.ts": 0,
	"review-graph/shared-extraction-ir.ts": 1,
	// #2442 review F2: the container regex now recognises BoundedFifoMap /
	// BoundedLruCache, so this file's module-level bounded cache is counted.
	"review-graph/tsconfig-paths.ts": 2,
	"review-graph/workspace-modules.ts": 1,
	"runtime-config.ts": 0,
	// #5120 r2: 31 -> 32 for _partialApplies, a WeakMap keyed by one call's own
	// input object, so no session reads another's entry and none needs a reset.
	"runtime-coordinator.ts": 32,
	// #2060: 3 -> 5 for GIT_INTEGRATION_SUBCOMMANDS and
	// GIT_GLOBAL_OPTIONS_WITH_VALUE — command-shape vocabulary, not state.
	"runtime-tool-result.ts": 3,
	// #2455 fix round 4, F2: the twin of `go-client.ts` above — the process's
	// ONE `RustClient` plus `resetRustAvailability`, moved off
	// `dispatch/runners/rust-clippy.ts`. That file keeps
	// `clippyAvailabilityByCargo`, which is covered by
	// `resetDispatchAvailabilityState`'s generation
	// (runner-helpers:availabilityGeneration) and, exporting no reset of its
	// own, is not a candidate on its own account — the pre-#2455 status quo,
	// and MISS 3 in SWEEP_HEURISTIC_LIMITS.
	"rust-client.ts": 1,
	// #2042/#3091 F1: rose to 4 with `verifiedOwnPids`, the FIFO-bounded memo of
	// pids this PROCESS has proved, from the kernel, to be its own live
	// children. Deliberately NOT reset at session_start, and a reset would be a
	// regression rather than hygiene: the facts it holds are about the OS
	// process tree, not the session — an LSP server spawned last session and
	// still running is still this process's child — and dropping a verdict is
	// exactly what re-breaks #2026's host-exit group kill for a leader that has
	// since died. It cannot grow (BoundedFifoMap, 512 entries, FIFO eviction)
	// and a stale entry cannot mislead: a pid alive under a different parent is
	// refused by the /proc read before the memo is ever consulted.
	//
	// #3091 F1-r2b: rose to 5 with `heldOwnPids`, the companion store for
	// RESOURCE-scoped verdicts — the LSP children `lsp/launch.ts` spawns with
	// `nodeSpawn`. Same no-reset reasoning, and the same axis argument one step
	// further: this set is retired by resource STATE (`releaseOwnChildPid` when
	// the shutdown ladder is done, plus a sweep that drops every pid whose
	// process GROUP no longer exists), never by age, because age is exactly
	// what evicted a long-lived server's verdict from the FIFO above.
	"safe-spawn.ts": 4,
	"security-scan-client.ts": 1,
	// #2146 moved the four registration fields onto the process singleton, so the
	// scan sees no module-scope container here either.
	"session-lifecycle.ts": 0,
	"session-scope.ts": 3,
	// #2319: the bind-rollup counters live behind getProcessSingleton, so the
	// module-scope scan sees no container here; the getProcessSingleton SIGNAL
	// is what flags this file now.
	"session-start-observability.ts": 0,
	"sg-runner.ts": 3,
	"sgconfig.ts": 2,
	// #2800 item 8: the dead-weight line's two per-session observation sets
	// (activated, called) plus situationalToolSet — an import-time frozen lookup
	// over TOOL_REGISTRY that the container scan cannot distinguish from mutable
	// state (SWEEP_HEURISTIC_LIMITS item 5). Registered above; the wired reset
	// clears the two sets and the emitted latch.
	"situational-tool-telemetry.ts": 3,
	// #2442 review F2: the container regex now recognises BoundedFifoMap /
	// BoundedLruCache, so this file's module-level bounded cache is counted.
	"slow-fs.ts": 1,
	"smells-rollup.ts": 1,
	"source-walker.ts": 1,
	"startup-scan.ts": 1,
	"startup-timing.ts": 0,
	"subagent-mode.ts": 0,
	"test-runner-client.ts": 4,
	// #2366: one bounded pending-delivery map, cleared at primary session_start.
	"test-runner-delivery.ts": 1,
	"tool-agreement.ts": 1,
	"tool-policy.ts": 2,
	"tree-sitter-cache.ts": 2,
	"tree-sitter-client.ts": 28,
	// #2636 review F6: getBundledQueriesRootHealth's memo (a bare module-scope
	// `let`) plus its `_resetBundledQueriesRootHealthForTests` export (the
	// scan's reset-signal detector) — see this file's EXEMPT_SESSION_STATE_FILES
	// entry above for why it is exempt rather than registered.
	"tree-sitter-query-loader.ts": 3,
	"tree-sitter-shared.ts": 0,
	"tree-sitter-symbol-extractor.ts": 2,
	"turn-context.ts": 0,
	"turn-summary.ts": 1,
	// #5036 N1: `state.servedDiagnosticHashes` (a member of the module-level
	// `state` literal).
	"warm-attach.ts": 1,
	// #2275 added `renderedDependencyDriftFiles` (the drained per-turn footer
	// delivery set) alongside the existing two.
	// #2455: the container scan now recognises any repo-local class owning a
	// `clear()`/`delete()` method, so `diagnosticsWriteGuard` and
	// `runnerWriteGuard` (`new WriteOrderingGuard(...)`) are now counted
	// (3 → 5). Both were already cleared by `clearWidgetState` — the file's
	// exemption above already covers them; only the pin was stale.
	"widget-state.ts": 5,
	"word-index-store.ts": 3,
	// #2068 added the per-index dirty-file set; it is process-local wire-cache
	// state and is cleared by serialization, so it needs no session reset.
	// #4129 added the serialized-source WeakMap used to publish persist-owned
	// wire bytes; it follows the WordIndex object's lifetime and needs no reset.
	"word-index.ts": 4,
	"workspace-topology.ts": 2,
	"write-ordering-guard.ts": 1,
	"zizmor-config.ts": 0,
};
