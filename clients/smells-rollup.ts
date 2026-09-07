/**
 * Automatic smells self-surfacing (#1123 item 3).
 *
 * `scripts/analyze-pi-lens-logs.mjs` (`npm run logs:smells`) already detects
 * a wide catalogue of operational smells, but it is MANUAL — an operator has
 * to think to run it. The #1123 investigation found 20 stale-ctx
 * `emit_failed` rows (see `session-lifecycle.ts`'s stale-ctx guard) and 37
 * opengrep respawns sitting in logs for days before an audit went looking.
 * This module closes that gap with a small, ALWAYS-ON rollup that surfaces a
 * subset of the analyzer's smells without anyone running the script.
 *
 * COST BOUND (the constraint that shapes the design): `~/.pi-lens/*.log`
 * files are size-rotated at `PI_LENS_MAX_LOG_SIZE_MB` (default 10MB,
 * `clients/log-cleanup.ts`). Re-scanning a whole rotated log on every
 * `session_start` — the analyzer's own approach — is exactly the megabyte
 * full-file read `session_start` (a hot, input-latency-sensitive path, see
 * `runtime-session.ts`'s cold-start comment) cannot afford. So this module
 * does a BOUNDED TAIL READ: at most `SMELLS_TAIL_BYTES_PER_FILE` bytes from
 * the END of each source log, via a single `pread`-style `fs.readSync` at a
 * computed offset — never a full-file read, by construction (see
 * `tailReadText`). Two source files, ~64KB each: ~128KB total I/O, once per
 * session_start plus one bounded re-check every `SMELLS_TURN_CHECK_INTERVAL`
 * turns — negligible next to the multi-second full startup walk it rides
 * alongside.
 *
 * The tail scan is bounded, but the tail can contain prior-session rows. The
 * `session_start` and `turn_end` callers supply the in-process session
 * boundary (`runtime.sessionStartedAt`), and rows are admitted only when
 * their own UTC timestamp is at or after that boundary. `/lens-health` has
 * no per-session caller to anchor to (it can run at any point, including
 * outside a turn) so it omits `sessionStartMs` and falls back to
 * `SMELLS_ROLLING_WINDOW_MS` (24h) — its rendered line is labeled "last 24h
 * tail-scan" to say so explicitly rather than implying a session-scoped
 * count it isn't. This keeps the same bounded read without reporting
 * historical failures as current, so this module does not additionally
 * instrument the write call sites (`bus-publish.ts`, `clients/lsp/index.ts`'s
 * respawn path) with parallel live counters. That keeps the change contained
 * to one new module + three small call sites (session_start, `/lens-health`,
 * `turn_end`) instead of touching every producer of the two source logs.
 *
 * Smells covered (deliberately a SUBSET — the two the issue named as having
 * gone unnoticed; the full catalogue stays in the manual analyzer):
 *   - stale-ctx `emit_failed`: `bus-events.log` rows where
 *     `outcome === "emit_failed"` and `error` contains the SDK's
 *     `"stale after session replacement"` fragment (the known-benign class
 *     `session-lifecycle.ts` documents — still worth a glance if it recurs
 *     often, since a HIGH count could mask a real regression).
 *   - opengrep respawns: `latency.log` rows where
 *     `phase === "lsp_server_respawn"` and `metadata.serverId === "opengrep"`
 *     (`clients/lsp/index.ts`'s existing respawn log point — unmodified).
 *
 * Both counters are gated by trivial threshold constants (`SMELLS_THRESHOLDS`)
 * so a single stray event never surfaces noise — only a repeating pattern
 * does, matching the analyzer's own low/medium/high severity gating.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getGlobalPiLensLogDir } from "./probe-home-state.js";

/** Bounded tail-read budget PER source log file — never a full-file scan. */
export const SMELLS_TAIL_BYTES_PER_FILE = 64 * 1024;
const SMELLS_ROLLING_WINDOW_MS = 24 * 60 * 60_000;

/** Re-check cadence at `turn_end`, mirroring `memory-sampler.ts`'s pattern —
 *  cheap enough (bounded ~128KB I/O) not to need finer throttling, but a
 *  fixed interval keeps it from running on every single turn. */
const SMELLS_TURN_CHECK_INTERVAL = 20;

export type SmellKey = "staleCtxEmitFailed" | "opengrepRespawn";

/** Trivial threshold constants (#1123 item 3's explicit design ask). Counts
 *  strictly below these never surface anywhere. */
export const SMELLS_THRESHOLDS: Record<SmellKey, number> = {
	staleCtxEmitFailed: 5,
	opengrepRespawn: 5,
};

const SMELL_LABELS: Record<SmellKey, string> = {
	staleCtxEmitFailed: "stale-ctx emit_failed (bus-events.log)",
	opengrepRespawn: "opengrep respawn (latency.log)",
};

const SMELL_KEYS: SmellKey[] = ["staleCtxEmitFailed", "opengrepRespawn"];

export type SmellsRollupCounts = Record<SmellKey, number>;

/**
 * Read at most `maxBytes` from the END of `filePath`. Never reads more than
 * that regardless of the file's actual size — the cost bound is enforced by
 * construction (a single sized `fs.readSync` at a computed offset), not by a
 * convention callers have to remember. Missing file / unreadable → "".
 *
 * The leading (possibly partial) line is dropped whenever the read started
 * mid-file, since we can't tell if it's a truncated JSON row.
 */
export function tailReadText(filePath: string, maxBytes: number): string {
	let fd: number;
	try {
		fd = fs.openSync(filePath, "r");
	} catch {
		return "";
	}
	try {
		const size = fs.fstatSync(fd).size;
		const readBytes = Math.min(size, maxBytes);
		if (readBytes <= 0) return "";
		const start = size - readBytes;
		const buf = Buffer.alloc(readBytes);
		fs.readSync(fd, buf, 0, readBytes, start);
		const text = buf.toString("utf8");
		if (start <= 0) return text;
		const firstNewline = text.indexOf("\n");
		return firstNewline >= 0 ? text.slice(firstNewline + 1) : "";
	} catch {
		return "";
	} finally {
		try {
			fs.closeSync(fd);
		} catch {
			/* already closed / nothing to do */
		}
	}
}

function countMatchingLines(
	text: string,
	predicate: (entry: Record<string, unknown>) => boolean,
	sessionStartMs?: number,
): number {
	let count = 0;
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		let entry: unknown;
		try {
			entry = JSON.parse(line);
		} catch {
			continue; // partial/corrupt line at the tail boundary — skip, don't throw
		}
		if (
			entry &&
			typeof entry === "object" &&
			(sessionStartMs === undefined ||
				isAtOrAfterSessionStart(
					entry as Record<string, unknown>,
					sessionStartMs,
				)) &&
			predicate(entry as Record<string, unknown>)
		) {
			count++;
		}
	}
	return count;
}

function isAtOrAfterSessionStart(
	entry: Record<string, unknown>,
	sessionStartMs: number,
): boolean {
	const timestamp = typeof entry.ts === "string" ? Date.parse(entry.ts) : NaN;
	return Number.isFinite(timestamp) && timestamp >= sessionStartMs;
}

function isStaleCtxEmitFailed(entry: Record<string, unknown>): boolean {
	return (
		entry.outcome === "emit_failed" &&
		typeof entry.error === "string" &&
		entry.error.includes("stale after session replacement")
	);
}

function isOpengrepRespawn(entry: Record<string, unknown>): boolean {
	if (entry.phase !== "lsp_server_respawn") return false;
	const metadata = entry.metadata as Record<string, unknown> | undefined;
	return metadata?.serverId === "opengrep";
}

/**
 * Bounded tail-scan of the two source logs. Total I/O is capped at
 * `2 * SMELLS_TAIL_BYTES_PER_FILE` regardless of how large the (size-rotated,
 * up to ~10MB) source files are. `root` is injectable for tests.
 */
export function countRecentSmells(
	root: string = getGlobalPiLensLogDir(),
	sessionStartMs?: number,
): SmellsRollupCounts {
	const sinceMs = sessionStartMs ?? Date.now() - SMELLS_ROLLING_WINDOW_MS;
	const busTail = tailReadText(
		path.join(root, "bus-events.log"),
		SMELLS_TAIL_BYTES_PER_FILE,
	);
	const latencyTail = tailReadText(
		path.join(root, "latency.log"),
		SMELLS_TAIL_BYTES_PER_FILE,
	);
	return {
		staleCtxEmitFailed: countMatchingLines(
			busTail,
			isStaleCtxEmitFailed,
			sinceMs,
		),
		opengrepRespawn: countMatchingLines(
			latencyTail,
			isOpengrepRespawn,
			sinceMs,
		),
	};
}

/**
 * One `sessionstart.log` line, gated to fire only when at least one smell is
 * AT/ABOVE its threshold — `null` (nothing logged) otherwise, so an ordinary
 * session never gets a noise line. Pairs with `logSessionStart` the same way
 * every other `session_start ...` line does (see `runtime-session.ts`).
 */
export function formatSmellsSessionStartLine(
	counts: SmellsRollupCounts,
): string | null {
	const bits: string[] = [];
	for (const key of SMELL_KEYS) {
		if (counts[key] >= SMELLS_THRESHOLDS[key]) {
			bits.push(`${SMELL_LABELS[key]} x${counts[key]}`);
		}
	}
	if (bits.length === 0) return null;
	const tailKb = Math.round(SMELLS_TAIL_BYTES_PER_FILE / 1024);
	return `session_start smells (last ${tailKb}KB tail): ${bits.join(", ")} — run \`npm run logs:smells\` for detail`;
}

/**
 * Compact, ALWAYS-shown `/lens-health` line (unconditional, like
 * `memory-sampler.ts`'s `formatMemoryHealthLine` — the health command is
 * explicitly requested, so it always renders current counts even when
 * everything is below threshold).
 */
export function formatSmellsHealthLine(counts: SmellsRollupCounts): string {
	return (
		`Smells (last 24h tail-scan): stale-ctx emit_failed=${counts.staleCtxEmitFailed}` +
		` · opengrep respawn=${counts.opengrepRespawn}`
	);
}

/** `true` on turn 20, 40, 60, ... — never turn 0. Pure so the cadence is
 *  unit-testable without driving a real turn loop (mirrors
 *  `memory-sampler.ts`'s `shouldEmitMemorySample`). */
export function shouldCheckSmellsThisTurn(turnIndex: number): boolean {
	return turnIndex > 0 && turnIndex % SMELLS_TURN_CHECK_INTERVAL === 0;
}

// Module-scope session state: which smells have already produced a turn-end
// note THIS session. Bounded to once per session per smell by construction —
// see `checkSmellsAndNoteOnce`.
const notifiedThisSession = new Set<SmellKey>();

/**
 * Given a fresh `counts` read, return zero or more turn-end note strings for
 * smells crossing threshold for the FIRST time this session. A smell already
 * notified this session never fires again, even if its count keeps growing —
 * "once per session per smell" per #1123 item 3's design ask.
 */
export function checkSmellsAndNoteOnce(counts: SmellsRollupCounts): string[] {
	const notes: string[] = [];
	for (const key of SMELL_KEYS) {
		if (notifiedThisSession.has(key)) continue;
		if (counts[key] >= SMELLS_THRESHOLDS[key]) {
			notifiedThisSession.add(key);
			notes.push(
				`pi-lens smell: ${SMELL_LABELS[key]} x${counts[key]} (recent tail-scan) — run \`npm run logs:smells\` for detail`,
			);
		}
	}
	return notes;
}

/** Reset the "already notified this session" state — call at `session_start`
 *  (a fresh session should be able to re-report) and from tests. */
export function resetSmellsSessionState(): void {
	notifiedThisSession.clear();
}
