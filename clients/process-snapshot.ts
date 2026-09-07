/**
 * The extension runtime's door onto the ONE process-table seam (#2443).
 *
 * `scripts/lib/process-scan.mjs` owns what a process listing IS: the field →
 * platform-column table, the Windows CIM/WQL and POSIX `ps` command
 * composition, the WQL escaping, and the row parser. This module owns how
 * clients/ RUNS one, which is genuinely different from how a script runs one
 * and stays different on purpose:
 *
 * - the child and its stdout pipe are `unref`'d (#1155) so a one-shot
 *   `pi --print` can settle without waiting on a CIM query;
 * - a child that blows its timeout is terminated through the caller's own
 *   tree-kill-and-verify machinery (#1864 F3), injected as `onTimeout` — a
 *   sweep that leaks its own scanner is the defect the sweep exists to fix;
 * - the outcome carries a `SpawnCollectStatus`, so "the table is empty" and
 *   "the query never ran" stay distinguishable and the caller can record the
 *   degradation (#1857).
 *
 * WHY THE SEAM IS IMPORTED FROM scripts/ RATHER THAN LIVING HERE: the .mjs
 * header argues it in full. Short version — `scripts/prune-agent-worktrees.mjs`
 * is a SessionStart/SubagentStop hook that runs inside freshly created agent
 * worktrees, where `clients/*.js` (gitignored build output) does not exist
 * yet, so the shared half has to be the side that needs no build. This file
 * is the single crossing point; nothing else in clients/ imports scripts/.
 */

import type { ChildProcess } from "node:child_process";
import {
	type SpawnCollectStatus,
	type SpawnTimeoutKill,
	spawnCollectStdoutResult,
} from "./child-unref.js";
import {
	buildProcessQuery,
	parseProcessTable,
	type ProcessField,
	type ProcessFilter,
	type ProcRow,
} from "../scripts/lib/process-scan.mjs";
/**
 * Re-exported, not redefined. `windowsExe` resolves an absolute System32
 * interpreter path for a spawn this process is about to make (a bare
 * `powershell.exe`/`taskkill.exe` is resolvable through a PATH a caller can
 * shadow, and these spawns decide what gets killed) — one definition of that
 * rule is the whole point of the seam.
 */
export { windowsExe } from "../scripts/lib/process-scan.mjs";

export interface ProcessTableRequest {
	/** Columns to project. `pid` is always included. */
	fields: readonly ProcessField[];
	/** Optional platform-side narrowing; see `serverSideFiltered` below. */
	filter?: ProcessFilter;
	/** Windows only: exclude the querying powershell.exe itself. */
	excludeSelfPid?: boolean;
}

export interface ProcessTableOptions {
	/** Hard wall-clock bound on the listing child. */
	timeoutMs: number;
	/**
	 * How to terminate a child that blew `timeoutMs`. Omitted means
	 * `child-unref.ts`'s default single unverified signal; callers that own a
	 * tree-kill (the reaper, the sampler) pass theirs.
	 */
	onTimeout?: (child: ChildProcess) => Promise<SpawnTimeoutKill>;
}

export interface ProcessTableResult {
	rows: ProcRow[];
	/** `ok` only when the child ran AND exited zero. Anything else means the
	 *  rows are partial at best, and an absence from them is not evidence. */
	status: SpawnCollectStatus;
	exitCode?: number | null;
	timeoutKill?: SpawnTimeoutKill;
	/**
	 * Whether the platform applied `filter` itself. False means the caller
	 * holds the WHOLE table and must narrow it in JS — the POSIX case for a
	 * `Name`/`CommandLine` filter, which `ps` cannot express.
	 */
	serverSideFiltered: boolean;
}

/**
 * Run one process-table query on the extension's spawn rails.
 *
 * Never throws and never rejects: an unbuildable query (a Windows-only column
 * asked for on POSIX, an empty filter) resolves as `spawn-error` with no rows,
 * the same shape every other failure takes, because every caller here is
 * best-effort instrumentation or a best-effort sweep.
 */
export async function queryProcessTable(
	request: ProcessTableRequest,
	options: ProcessTableOptions,
): Promise<ProcessTableResult> {
	let query: ReturnType<typeof buildProcessQuery>;
	try {
		query = buildProcessQuery(request.fields, {
			filter: request.filter,
			excludeSelfPid: request.excludeSelfPid,
		});
	} catch {
		return { rows: [], status: "spawn-error", serverSideFiltered: false };
	}
	const result = await spawnCollectStdoutResult(
		query.command,
		query.args,
		{ shell: false, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
		{ timeoutMs: options.timeoutMs, onTimeout: options.onTimeout },
	);
	return {
		// Whatever the collector kept is parsed rather than discarded here: it
		// drops stdout on a non-zero exit (that output is not evidence of what
		// is NOT running) but KEEPS the partial table from a timed-out child,
		// and the caller decides what a partial table is worth by reading
		// `status`. Re-deciding that here would be a second policy.
		rows: parseProcessTable(result.stdout, query.tabSeparated, query.fields),
		status: result.status,
		exitCode: result.exitCode,
		timeoutKill: result.timeoutKill,
		serverSideFiltered: query.serverSideFiltered,
	};
}
