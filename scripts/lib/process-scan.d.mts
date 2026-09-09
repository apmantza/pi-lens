// Type declarations for process-scan.mjs (untyped .mjs imported from .ts).
//
// Two consumers: the tests, and `clients/process-snapshot.ts` — the single
// point where the extension runtime reaches into scripts/ for this seam
// (#2443; the boundary decision is argued in the .mjs header).

export const LSP_PROCESS_MARKERS: string[];

export interface ProcessRow {
	pid: number;
	command: string;
}

export function isLspServerCommand(command: string): boolean;

export function diffSurvivingLspProcesses(
	before: ProcessRow[],
	after: ProcessRow[],
): ProcessRow[];

export type ProcessField =
	| "pid"
	| "ppid"
	| "ageMs"
	| "rssBytes"
	| "cpuKernel100ns"
	| "cpuUser100ns"
	| "startedAt"
	| "command";

export interface ProcRow {
	pid: number;
	ppid: number;
	command: string;
	/** Present only when `ageMs` was projected; undefined when the platform
	 *  emitted a value that could not be trusted. */
	ageMs?: number;
	rssBytes?: number;
	cpuKernel100ns?: number;
	cpuUser100ns?: number;
	startedAt?: string;
	cwd?: string;
}

/** A platform-side narrowing of the process table. `ProcessId` is the only
 *  column POSIX `ps` can filter on; the others apply on Windows only, and
 *  `serverSideFiltered` on the built query says which happened. */
export interface ProcessFilter {
	column: "ProcessId" | "Name" | "CommandLine";
	op: "eq" | "like";
	values: ReadonlyArray<string | number>;
}

export interface ProcessQueryOptions {
	filter?: ProcessFilter;
	/** Windows only: drop the query's own powershell.exe row, whose command
	 *  line embeds whatever marker a `CommandLine` filter searched for. */
	excludeSelfPid?: boolean;
}

export interface ProcessQuery {
	command: string;
	args: string[];
	tabSeparated: boolean;
	fields: ProcessField[];
	serverSideFiltered: boolean;
}

export const ALL_PROCESS_FIELDS: readonly ProcessField[];

export function windowsExe(name: string): string;

export function posixPsPath(): string;

export function escapeWqlLikeValue(value: string | number): string;

export function escapeWqlStringValue(value: string | number): string;

export function ageMsFromPosixEtime(raw: string): number | undefined;

export function normalizeProcessFields(
	fields: readonly ProcessField[] | null | undefined,
): ProcessField[];

export function buildProcessQuery(
	fields?: readonly ProcessField[],
	options?: ProcessQueryOptions,
): ProcessQuery;

export function parseProcessTable(
	out: string,
	tabSeparated: boolean,
	fields?: readonly ProcessField[],
): ProcRow[];

export function snapshotProcesses(
	fields?: readonly ProcessField[],
	timeoutMs?: number,
	options?: ProcessQueryOptions,
): Promise<{ rows: ProcRow[]; ok: boolean }>;

export interface ProcessSnapshot {
	rows: ProcessRow[];
	ok: boolean;
}

export function evaluateNoSurvivingLspProcesses(
	before: ProcessSnapshot,
	after: ProcessSnapshot,
): { id: string; pass: boolean; detail: string };
