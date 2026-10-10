/**
 * The read guard across conversation moves (#3521): `/tree`, `/fork`,
 * `/clone`, resume and `pi --fork <path>`.
 *
 * A read record is evidence only while the conversation still shows the
 * agent the tool result it came from. pi keeps entry ids and tool-call ids
 * intact across `/tree`, `createBranchedSession` and `forkFrom`, and the
 * handler's `ctx.sessionManager.getBranch()` is the ground truth for what the
 * conversation now holds. So the rule is: keep a record exactly when its
 * `toolCallId` has a `toolResult` entry on that branch.
 *
 * Accepted residual (maintainer decision on #3521): pi stores provider
 * tool-call ids verbatim, and some providers reuse them across responses —
 * Mistral's fallback derives `toolcall:<index>`, OpenAI-compatible servers
 * may send index ids or none (`id || ""`), Google makes ids unique within one
 * message only. With those providers a sibling branch's read can match an id
 * that is also on this branch. An empty id is never recorded
 * (`resolveToolCallCorrelationId` returns undefined), so it never matches.
 *
 * The hand-off. pi re-runs the extension factory for every conversation move
 * except `/tree`, so the read-set crosses to the next activation as the
 * `read-guard` session store (#3612): the hand-off slot for an in-process
 * `/fork`, `/clone` or `/reload`, the sidecar for resume and `pi --fork`.
 */

import { promises as fs } from "node:fs";
import { logLatency } from "./latency-logger.js";
import type { PersistedReadGuardState, ReadGuard } from "./read-guard.js";
import { sanitizeCorrelationId } from "./read-guard-logger.js";
import {
	type AdoptContext,
	defineSessionStore,
	type SessionScope,
	scopeCell,
	type StartSource,
} from "./session-scope.js";

export interface BranchToolResults {
	/** `toolResult` tool-call ids on the branch, in record (`sanitizeCorrelationId`) form. */
	ids: Set<string>;
	/** False when the session manager was missing or threw: no id is on the branch. */
	readable: boolean;
}

/**
 * The tool-call ids whose `toolResult` entry is on the session's current
 * branch. The result, not the call: a `/tree` target can be the assistant
 * entry that issued a call whose result is not on the branch, and then the
 * agent never saw the read's bytes. An unreadable session manager (a stale
 * ctx, a host without `getBranch`) yields no ids, so every record is dropped:
 * a re-read, never an edit vouched for by a branch nobody can see.
 */
export function branchToolResultIds(
	sessionManager: unknown,
): BranchToolResults {
	const ids = new Set<string>();
	try {
		const branch = (
			sessionManager as { getBranch?: () => unknown } | undefined
		)?.getBranch?.();
		if (!Array.isArray(branch)) return { ids, readable: false };
		for (const entry of branch) {
			// Only a `toolResult` message carries `toolCallId`; an assistant
			// message holds its calls' ids inside `content`.
			const message =
				(entry as { type?: unknown; message?: unknown } | undefined)?.type ===
				"message"
					? ((entry as { message?: unknown }).message as
							| { toolCallId?: unknown }
							| undefined)
					: undefined;
			const id = sanitizeCorrelationId(message?.toolCallId);
			if (id !== undefined) ids.add(id);
		}
		return { ids, readable: true };
	} catch {
		return { ids: new Set<string>(), readable: false };
	}
}

/** A session header line is small; this bounds a corrupt first line. */
const SESSION_HEADER_MAX_BYTES = 64 * 1024;

/**
 * The stable session id in a pi session file's header (its first JSONL line,
 * `{"type":"session","id":…}`), which keys that session's sidecar.
 * `undefined` for a missing, unreadable or malformed file.
 */
export async function readSessionHeaderId(
	sessionFile: string,
): Promise<string | undefined> {
	let handle: fs.FileHandle | undefined;
	try {
		handle = await fs.open(sessionFile, "r");
		const buffer = Buffer.alloc(SESSION_HEADER_MAX_BYTES);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		const firstLine =
			buffer.toString("utf8", 0, bytesRead).split("\n")[0] ?? "";
		const header = JSON.parse(firstLine) as { id?: unknown } | null;
		return typeof header?.id === "string" ? header.id : undefined;
	} catch {
		return undefined;
	} finally {
		await handle?.close().catch(() => {});
	}
}

/**
 * The reads a persisted read-set holds before the branch filter (#3873 O2),
 * whatever its version: `undefined` when there is no payload, `0` for an empty
 * set or a payload whose `reads` is not a list.
 */
function persistedReadCount(payload: unknown): number | undefined {
	if (payload === undefined) return undefined;
	const reads = (payload as { reads?: unknown } | null)?.reads;
	if (!Array.isArray(reads)) return 0;
	let count = 0;
	for (const entry of reads)
		if (Array.isArray(entry) && Array.isArray(entry[1]))
			count += entry[1].length;
	return count;
}

/**
 * One `read_guard_branch_retained` latency row per conversation move: which
 * move, where the read-set came from, and how many records the branch kept.
 * A move that drops every read (an unreadable branch included) is otherwise
 * indistinguishable from a guard that was never populated.
 *
 * `payloadReads` (#3873 O2) is the count BEFORE the branch filter, so `kept 0,
 * dropped 0` reads as one of: no payload (`null`), an empty set (`0`), or a
 * payload the importer ignored whole (a count above 0 with `payloadVersion`
 * not the current one). A `/tree` has no payload and omits both.
 */
export function logReadGuardBranchMove(args: {
	trigger: string;
	source: StartSource | "live";
	kept: number;
	dropped: number;
	branch: BranchToolResults;
	cwd: string;
	payload?: { reads: number | undefined; version: unknown };
}): void {
	logLatency({
		type: "phase",
		phase: "read_guard_branch_retained",
		filePath: args.cwd,
		durationMs: 0,
		metadata: {
			trigger: args.trigger,
			source: args.source,
			kept: args.kept,
			dropped: args.dropped,
			branchToolResults: args.branch.ids.size,
			branchReadable: args.branch.readable,
			...(args.payload && {
				payloadReads: args.payload.reads ?? null,
				payloadVersion: args.payload.version ?? null,
			}),
		},
	});
}

/**
 * The key under which a scope holds its read guard. The coordinator's guard is
 * bound to its scope at the primary `session_start` (#3612).
 */
export const READ_GUARD_CELL = "read-guard";

/**
 * The guard bound to `scope`. A snapshot can find none (a start that threw
 * before binding it); a restore cannot, because the primary start binds the
 * guard before it adopts.
 */
function guardOf(scope: SessionScope): ReadGuard | undefined {
	return scopeCell<ReadGuard>(scope, READ_GUARD_CELL);
}

/**
 * The read-set (#3521, #3612). Every adopted record passes the branch filter
 * (`importBranch`), so a record whose tool result is not on the starting
 * branch never crosses, on a `/reload` either.
 */
defineSessionStore<PersistedReadGuardState>({
	name: "read-guard",
	policy: {
		startup: "adopt",
		new: "reset",
		resume: "adopt",
		fork: "adopt",
		reload: "adopt",
	},
	snapshot: (scope) => guardOf(scope)?.exportState(),
	restore: (scope, payload, ctx: AdoptContext) => {
		const guard = guardOf(scope) as ReadGuard;
		const branch = branchToolResultIds(ctx.sessionManager);
		const imported = guard.importBranch(
			payload as PersistedReadGuardState | undefined,
			branch.ids,
		);
		const payloadReads = persistedReadCount(payload);
		logReadGuardBranchMove({
			trigger: ctx.reason,
			source: ctx.source,
			kept: imported.imported,
			dropped: imported.dropped,
			branch,
			cwd: ctx.cwd,
			payload: {
				reads: payloadReads,
				version: (payload as { version?: unknown } | null | undefined)?.version,
			},
		});
		return { itemsIn: payloadReads ?? 0, itemsKept: imported.imported };
	},
	reason:
		"the reads the conversation shows the agent; a move keeps exactly those whose tool result is on the new branch",
});

/**
 * The files the session authored (D5), each with the content identity and
 * transcript id of its write. Every start that keeps a conversation adopts
 * them through the branch filter (`importAuthorship`, #3603), as the
 * read-set store does: an entry crosses iff its write's tool result is on the
 * starting branch, and its bytes must still match at the next check (#4131).
 * `/new` starts an empty conversation and resets them.
 */
defineSessionStore({
	name: "read-guard-authorship",
	policy: {
		startup: "adopt",
		new: "reset",
		resume: "adopt",
		fork: "adopt",
		reload: "adopt",
	},
	snapshot: (scope) => guardOf(scope)?.exportAuthorship(),
	restore: (scope, payload, ctx: AdoptContext) => {
		const guard = guardOf(scope) as ReadGuard;
		const branch = branchToolResultIds(ctx.sessionManager);
		const imported = guard.importAuthorship(payload, branch.ids);
		return {
			itemsIn: imported.imported + imported.dropped,
			itemsKept: imported.imported,
		};
	},
	reason:
		"the files this session wrote, with the bytes it wrote; a move keeps exactly those whose write's tool result is on the new branch",
});
