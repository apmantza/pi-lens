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
	buildEnvironmentQuery,
	buildProcessQuery,
	parseEnvironmentVariable,
	parseProcessTable,
	type ProcessField,
	type ProcessFilter,
	type ProcRow,
	readLinuxPidNamespace,
	readLinuxProcessEnvironmentVariable,
	readLinuxProcessStart,
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
		{
			shell: false,
			windowsHide: true,
			stdio: ["ignore", "pipe", "ignore"],
			env: query.env,
		},
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

/**
 * Who a process is: its command line and its OS start time (#3538). A pid
 * alone names whichever process holds it now; (pid, start) names one process
 * for its whole life. `start` is undefined when the platform did not report
 * it, and an unknown start never matches a recorded one.
 *
 * The start is an opaque, per-platform string, compared only for equality
 * against a value read the same way: Linux clock ticks since boot
 * (`/proc/<pid>/stat`) qualified by the boot id, macOS `lstart` in the C
 * locale and UTC, Windows
 * `CreationDate` in UTC (ISO-8601, so it also orders).
 */
export interface ProcessIdentity {
	command: string;
	start?: string | undefined;
}

/** `pids` without duplicates and without anything that is not a pid. */
function validPids(pids: readonly number[]): number[] {
	return [...new Set(pids.filter((p) => Number.isInteger(p) && p > 0))];
}

/**
 * The identity of each live pid in `pids`, in one query. Pids that are gone
 * are absent. `status` is the listing's own status (see
 * `ProcessTableResult.status`); on POSIX `ps -p` exits non-zero when none of
 * the pids exist, which the caller may read as a clean empty result.
 */
export async function queryProcessIdentities(
	pids: readonly number[],
	options: ProcessTableOptions,
): Promise<{
	identities: Map<number, ProcessIdentity>;
	status: SpawnCollectStatus;
}> {
	const valid = validPids(pids);
	const identities = new Map<number, ProcessIdentity>();
	if (valid.length === 0) return { identities, status: "ok" };
	const linux = process.platform === "linux";
	const result = await queryProcessTable(
		{
			fields: linux ? ["pid", "command"] : ["pid", "startedAt", "command"],
			filter: { column: "ProcessId", op: "eq", values: valid },
		},
		options,
	);
	for (const row of result.rows) {
		const start = linux ? readLinuxProcessStart(row.pid) : row.startedAt;
		identities.set(row.pid, {
			command: row.command,
			start: start ? start : undefined,
		});
	}
	return { identities, status: result.status };
}

/**
 * The environment variable an LSP child carries naming the pi-lens process
 * that spawned it: `<pid>:<start>` (#3539). An orphan keeps it after its
 * owner dies, and on POSIX, where the orphan is reparented and its ppid says
 * nothing about the owner, it is the only record of who owned it.
 */
export const OWNER_TAG_ENV = "PI_LENS_OWNER";

export interface OwnerTag {
	pid: number;
	start: string;
}

export function formatOwnerTag(tag: OwnerTag): string {
	return `${tag.pid}:${tag.start}`;
}

/**
 * Undefined for anything that is not `<positive pid>:<start>`, where the
 * start has a shape this module writes: Linux clock ticks with the boot id
 * (`<ticks>@<boot_id>`), or an ISO-8601 UTC instant (macOS). Anything longer (say, a later `pid:start:namespace` form)
 * is no tag at all rather than a tag whose start never matches, which would
 * read as a dead owner.
 */
export function parseOwnerTag(value: string | undefined): OwnerTag | undefined {
	const match =
		/^(\d+):(\d+@[0-9a-f-]{36}|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)$/.exec(
			value ?? "",
		);
	if (!match) return undefined;
	const [, pidText = "", start = ""] = match;
	const pid = Number(pidText);
	return pid > 0 ? { pid, start } : undefined;
}

/**
 * The value of `OWNER_TAG_ENV` for a child this process spawns, or undefined
 * when there is none to give. Windows gets none: its backstop reads the
 * ppid, and reading this process's start there would put a CIM query on the
 * LSP spawn path.
 */
export async function ownerTagForChildren(
	options: ProcessTableOptions,
): Promise<string | undefined> {
	if (process.platform === "win32") return undefined;
	const start = await ownProcessStart(options);
	return start === undefined
		? undefined
		: formatOwnerTag({ pid: process.pid, start });
}

/**
 * The owner tag each pid carries. POSIX only: Linux reads
 * `/proc/<pid>/environ`, macOS asks `ps -E`. Windows has no way to read
 * another process's environment without native code, so it returns none and
 * its backstop judges ownership from the ppid instead.
 *
 * Linux returns no tag for a process in another pid namespace (a container,
 * a rootless podman or Flatpak sandbox): the pid inside its tag names a
 * process in THAT namespace, and read from this one it names some other
 * process or none, which would judge a live owner dead (#3539 review F1).
 */
export async function readOwnerTags(
	pids: readonly number[],
	options: ProcessTableOptions,
): Promise<{ tags: Map<number, OwnerTag>; status: SpawnCollectStatus }> {
	const tags = new Map<number, OwnerTag>();
	const valid = validPids(pids);
	if (valid.length === 0 || process.platform === "win32")
		return { tags, status: "ok" };
	if (process.platform === "linux") {
		const own = ownPidNamespace();
		for (const pid of valid) {
			const namespace = readLinuxPidNamespace(pid);
			if (namespace === undefined || namespace !== own) continue;
			const tag = parseOwnerTag(
				readLinuxProcessEnvironmentVariable(pid, OWNER_TAG_ENV),
			);
			if (tag) tags.set(pid, tag);
		}
		return { tags, status: "ok" };
	}
	const query = buildEnvironmentQuery(valid);
	const result = await spawnCollectStdoutResult(
		query.command,
		query.args,
		{ shell: false, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
		options,
	);
	for (const [pid, value] of parseEnvironmentVariable(
		result.stdout,
		OWNER_TAG_ENV,
	)) {
		const tag = parseOwnerTag(value);
		if (tag) tags.set(pid, tag);
	}
	// `ps -p` exits non-zero when a requested pid is gone, which is a clean
	// answer for that pid (no tag), not a failed read of the others.
	return {
		tags,
		status: result.status === "exit-error" ? "ok" : result.status,
	};
}

/**
 * Whether a registry entry's pid means something in `namespace` (#3539
 * review F1). An entry with no namespace (an older writer, or not Linux) is
 * taken as this one's, as every entry was before.
 */
export function isInPidNamespace(
	entry: { pidNamespace?: string | undefined },
	namespace: string | undefined,
): boolean {
	return entry.pidNamespace === undefined || entry.pidNamespace === namespace;
}

/**
 * This process's pid namespace (Linux), or undefined elsewhere or when it
 * cannot be read. A pid means something only inside its namespace.
 */
export function ownPidNamespace(): string | undefined {
	return process.platform === "linux"
		? readLinuxPidNamespace(process.pid)
		: undefined;
}

interface OwnStartCell {
	promise: Promise<string | undefined>;
	value?: string;
}

/** This process's start, once read. A failed read is not kept. */
let ownStart: OwnStartCell | null = null;

/**
 * This process's OS start time, read once. Linux reads it synchronously; the
 * other platforms query the process table the first time. A failed read is
 * not remembered, so the next caller tries again.
 */
export function ownProcessStart(
	options: ProcessTableOptions,
): Promise<string | undefined> {
	if (process.platform === "linux")
		return Promise.resolve(readLinuxProcessStart(process.pid));
	if (ownStart) return ownStart.promise;
	const cell: OwnStartCell = {
		promise: readProcessStart(process.pid, options).then((start) => {
			if (start === undefined) ownStart = null;
			else cell.value = start;
			return start;
		}),
	};
	ownStart = cell;
	return cell.promise;
}

/** One pid's OS start time, or undefined when it cannot be read. */
export async function readProcessStart(
	pid: number,
	options: ProcessTableOptions,
): Promise<string | undefined> {
	if (process.platform === "linux") return readLinuxProcessStart(pid);
	return (await queryProcessIdentities([pid], options)).identities.get(pid)
		?.start;
}

/** This process's start if it is already known, without waiting. */
export function ownProcessStartIfKnown(): string | undefined {
	if (process.platform === "linux") return readLinuxProcessStart(process.pid);
	return ownStart?.value;
}
