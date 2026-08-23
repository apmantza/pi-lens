/**
 * Session-scoped cooldown for commands whose spawn TIMED OUT (#1995).
 *
 * Live evidence: one wedged `markdownlint-cli2.cmd` on Windows charged its
 * failure budget three times for a single edit — availability verification
 * (30s, SIGTERM), autofix `--fix` (30s), and the lint runner (15s) each paid
 * separately, because a positive probe/cache verdict said nothing about the
 * command's ability to COMPLETE. Total post-edit cost: 52-60 seconds.
 *
 * This seam is the shared negative evidence:
 * - `noteSpawnTimeout` records that a resolved command timed out, in which
 *   phase, and what wrapper kind it had; every record emits one bounded
 *   latency row so the session stays auditable.
 * - `isInSpawnTimeoutCooldown` is consulted by every invocation path for that
 *   command — verification, autofix, and lint — so ONE wedged executable
 *   consumes at most ONE bounded failure budget per edit (invariant 1) and a
 *   timeout/skipped result is never re-reported as clean (invariant 4).
 *
 * Durability contract: SESSION. A hot loop of edits must not retry (a wedged
 * `.cmd` shim does not heal between edits), but a new session may — the
 * executable or its environment may have changed. Reset is registered in the
 * session-state registry (`spawn-timeout-cooldown:latches`) and wired into
 * `handleSessionStart`.
 */

import path from "node:path";
import { logLatency } from "./latency-logger.js";

interface SpawnTimeoutRecord {
	tool: string;
	command: string;
	phase: string;
	atMs: number;
}

/**
 * The map lives behind Symbol.for process-global state (same pattern as the
 * shared NDJSON writer registry): multiple module instances of THIS file must
 * share one cooldown population, because a consumer holding instance A must
 * observe what a consumer holding instance B recorded. Re-evaluation happens
 * whenever vi.resetModules() runs in tests or a bundled copy loads beside a
 * compiled one - module identity is simply not a reliable key for
 * session-scoped state.
 */
interface SpawnTimeoutGlobalState {
	timedOutByCommand: Map<string, SpawnTimeoutRecord>;
}
const COOLDOWN_STATE_KEY = Symbol.for("pi-lens:spawn-timeout-cooldown");
type GlobalWithCooldownState = typeof globalThis & {
	[COOLDOWN_STATE_KEY]?: SpawnTimeoutGlobalState;
};
const _global = globalThis as GlobalWithCooldownState;
if (!_global[COOLDOWN_STATE_KEY]) {
	_global[COOLDOWN_STATE_KEY] = { timedOutByCommand: new Map() };
}
const timedOutByCommand = _global[COOLDOWN_STATE_KEY]!.timedOutByCommand;

/** Wrapper kind for the telemetry record: how the command will be launched. */
function wrapperKindOf(command: string): string {
	const ext = path.extname(command);
	return ext ? ext.slice(1) : "bare";
}

export interface NoteSpawnTimeoutInput {
	/** The tool as a reader would name it ("markdownlint"). */
	tool: string;
	/** The RESOLVED command (absolute where the caller knows it). */
	command: string;
	/** Which lane paid the budget: "availability" | "autofix" | "lint" | ... */
	phase: string;
	/** The timeout budget that was consumed, when known. */
	durationMs?: number;
}

/**
 * Cooldown key: the command's basename minus extension, lowercased.
 *
 * Deliberately NOT the full resolved path: the three lanes resolve the same
 * physical binary through different helpers (PATH-resolved absolute,
 * `<cwd>/node_modules/.bin/...`, bare name), and cross-lane sharing is the
 * entire point (#1995 - otherwise each lane pays its own first budget).
 */
function cooldownKey(command: string): string {
	return path
		.basename(command)
		.replace(/\.[^.]+$/, "")
		.toLowerCase();
}

export function noteSpawnTimeout(input: NoteSpawnTimeoutInput): void {
	const key = cooldownKey(input.command);
	timedOutByCommand.set(key, {
		tool: input.tool,
		command: input.command,
		phase: input.phase,
		atMs: Date.now(),
	});
	logLatency({
		type: "phase",
		toolName: input.tool,
		phase: "spawn_timeout_cooldown",
		filePath: input.command,
		durationMs: input.durationMs ?? 0,
		status: "cooldown_armed",
		metadata: {
			command: input.command,
			wrapperKind: wrapperKindOf(input.command),
			timeoutPhase: input.phase,
			...(input.durationMs !== undefined && {
				timeoutBudgetMs: input.durationMs,
			}),
		},
	});
}

/**
 * True while `command` is cooling down after a spawn timeout. Every
 * invocation path for this command should skip WITHOUT spawning and report
 * an honest "not checked" outcome (skipped / 0-fixes), never clean.
 */
export function isInSpawnTimeoutCooldown(command: string): boolean {
	return timedOutByCommand.has(cooldownKey(command));
}

/**
 * Session-start re-arm seam (registered in the session-state registry):
 * a new session may retry a command the previous session cooled down -
 * the executable or its environment may have changed.
 */
export function resetSpawnTimeoutCooldowns(): void {
	timedOutByCommand.clear();
}
