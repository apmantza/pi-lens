/**
 * Per-file census of managed processes whose owner is dead (#5528, #5146).
 *
 * Named recurrence: CI shard 5 jobs end with `ast-grep` children still alive
 * whose `PI_LENS_OWNER` tag names a pid that was reaped. Nothing names the test
 * file whose worker spawned them, so #5146 (closed without the census) and
 * #5267 only hid the symptom from the s7 orphan-sweep witness.
 *
 * What it does: when `PI_LENS_DEAD_OWNER_CENSUS_FILE` names a log file, every
 * vitest worker (one fork per test file) appends `owner <pid> <file>` at load,
 * and at its teardown lists the live managed binaries whose owner tag names a
 * dead pid. One stderr line per distinct leaked pid, bounded per file:
 * `[dead-owner-census] pid=… owner=… owner_file=… seen_after=… cmd=…`.
 * `owner_file` is the file whose worker had the owner pid; `unknown` means the
 * owner was not a worker (a child process of one). `seen_after` is the file
 * whose teardown first saw the process, which brackets when it appeared.
 *
 * It reuses, not rebuilds, the production readers: the process-table seam
 * (`queryProcessTable`), the owner-tag reader (`readOwnerTags`), the managed
 * name match (`matchesManagedBinary`), the liveness check (`realIsPidAlive`)
 * and the dead-owner rule the backstop sweep applies
 * (`partitionBackstopCandidates` over an empty registry and no spawn grace).
 *
 * The table query carries no `Name` filter on purpose: `vitest-setup.ts`
 * answers every `Name`-filtered query with an empty table (#3917) so no test
 * reaches the host through the orphan backstop, and this census needs the real
 * table. POSIX `ps` cannot filter by name anyway, so the query is the same one.
 *
 * Off unless the env var names a file, and off on Windows, where no owner tag
 * is written. Known limit, stated rather than implied: a dead owner whose pid
 * was reused by a live process reads as alive (no start-time lookup, one `ps`
 * per file), so the census can miss a leak, never invent one.
 */
import * as fs from "node:fs";

export const DEAD_OWNER_CENSUS_FILE_ENV = "PI_LENS_DEAD_OWNER_CENSUS_FILE";

/** Lines one file's teardown may print; the rest are counted, not listed. */
export const CENSUS_MAX_LINES_PER_FILE = 5;
/** Bound on the one `ps` per file; a slow table skips the scan, never the file. */
export const CENSUS_SCAN_TIMEOUT_MS = 2_000;
/** Longest command text a line carries. */
const CENSUS_COMMAND_CHARS = 120;

export interface DeadOwnerLeak {
	pid: number;
	ownerPid: number;
	ageMs?: number | undefined;
	command: string;
}

/** The three production readers the census composes. */
export interface CensusSeams {
	listProcesses(): Promise<{
		rows: Array<{
			pid: number;
			ppid: number;
			ageMs?: number | undefined;
			command: string;
		}>;
		status: string;
	}>;
	readOwnerTags(pids: number[]): Promise<{
		tags: Map<number, { pid: number; start: string }>;
		status: string;
	}>;
	isManaged(command: string): boolean;
	isPidAlive(pid: number): boolean;
	partition: typeof import("../../clients/instance-reaper.js").partitionBackstopCandidates;
}

/** The census's log file, or undefined when it is off. */
export function censusFile(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): string | undefined {
	if (platform === "win32") return undefined;
	const file = env[DEAD_OWNER_CENSUS_FILE_ENV];
	return file ? file : undefined;
}

/** Append one worker's `owner <pid> <file>` line. Never throws. */
export function recordCensusWorker(
	file: string,
	pid: number = process.pid,
	log: string | undefined = censusFile(),
): void {
	if (log === undefined) return;
	try {
		fs.appendFileSync(log, `owner ${pid} ${file}\n`);
	} catch {
		// An unwritable log costs attribution only: the line says `unknown`.
	}
}

/** The file whose worker had `pid`, from the log text, or `unknown`. */
export function resolveOwnerFile(logText: string, pid: number): string {
	const prefix = `owner ${pid} `;
	for (const line of logText.split("\n")) {
		if (line.startsWith(prefix)) return line.slice(prefix.length) || "unknown";
	}
	return "unknown";
}

/** Pids the log already reported, so a leak prints once per run, not per file. */
export function reportedLeakPids(logText: string): Set<number> {
	const pids = new Set<number>();
	for (const line of logText.split("\n")) {
		const match = /^leak (\d+) /.exec(line);
		if (match) pids.add(Number(match[1]));
	}
	return pids;
}

export function formatLeakLine(
	leak: DeadOwnerLeak,
	ownerFile: string,
	seenAfter: string,
): string {
	const age =
		leak.ageMs === undefined ? "?" : `${Math.round(leak.ageMs / 1000)}s`;
	const command = leak.command
		.replace(/\s+/g, " ")
		.slice(0, CENSUS_COMMAND_CHARS);
	return `[dead-owner-census] pid=${leak.pid} owner=${leak.ownerPid} age=${age} owner_file=${ownerFile} seen_after=${seenAfter} cmd=${command}`;
}

/**
 * The production readers. Imported when the teardown runs, never at setup
 * load: `vitest-setup.ts` loads before a test file's `vi.mock` registers.
 */
export async function loadActualCensusSeams(): Promise<CensusSeams> {
	const snapshot = await import("../../clients/process-snapshot.js");
	const reaper = await import("../../clients/instance-reaper.js");
	return {
		listProcesses: () =>
			snapshot.queryProcessTable(
				{ fields: ["pid", "ppid", "ageMs", "command"] },
				{ timeoutMs: CENSUS_SCAN_TIMEOUT_MS },
			),
		readOwnerTags: (pids) =>
			snapshot.readOwnerTags(pids, { timeoutMs: CENSUS_SCAN_TIMEOUT_MS }),
		isManaged: reaper.matchesManagedBinary,
		isPidAlive: reaper.realIsPidAlive,
		partition: reaper.partitionBackstopCandidates,
	};
}

/**
 * The live managed processes whose owner tag names a dead pid. A scan that did
 * not run (`ps` failed or timed out) is `{ unavailable: <status> }`, not an
 * empty list.
 */
export async function findDeadOwnerLeaks(
	seams: CensusSeams,
): Promise<DeadOwnerLeak[] | { unavailable: string }> {
	const table = await seams.listProcesses();
	if (table.status !== "ok") return { unavailable: `ps ${table.status}` };
	const managed = table.rows.filter(
		(row) => row.pid !== process.pid && seams.isManaged(row.command),
	);
	if (managed.length === 0) return [];
	const tagScan = await seams.readOwnerTags(managed.map((row) => row.pid));
	if (tagScan.status !== "ok")
		return { unavailable: `owner tags ${tagScan.status}` };
	const processes = managed.map((row) => ({
		pid: row.pid,
		parentPid: row.ppid,
		command: row.command,
		ageMs: row.ageMs,
		// The sweep needs a start to aim a kill; the census only reads, so any
		// value keeps a dead-owner process out of the `unknownStart` drop.
		start: "census",
		ownerTag: tagScan.tags.get(row.pid),
	}));
	const dead = seams.partition(processes, [], seams.isPidAlive, { graceMs: 0 });
	return dead.eligible.flatMap((proc) =>
		proc.ownerTag === undefined
			? []
			: [
					{
						pid: proc.pid,
						ownerPid: proc.ownerTag.pid,
						ageMs: proc.ageMs,
						command: proc.command,
					},
				],
	);
}

/** Run `emit` the first time `kind` is noted in this run's log. */
function noteOnce(log: string, kind: string, emit: () => void): void {
	try {
		const seen = fs.existsSync(log)
			? fs.readFileSync(log, "utf8").split("\n").includes(`note ${kind}`)
			: false;
		if (seen) return;
		fs.appendFileSync(log, `note ${kind}\n`);
	} catch {
		// An unwritable log prints the note every file; still bounded by files.
	}
	emit();
}

/**
 * A scan that could not run: one `scanfail` log line per file (the CI summary
 * step counts them) and one stderr line per run, so a failing census never
 * reads as a clean one.
 */
function recordScanFailure(
	log: string,
	reason: string,
	seenAfter: string,
	write: (line: string) => void,
): void {
	try {
		fs.appendFileSync(log, `scanfail ${reason} after ${seenAfter}\n`);
	} catch {
		// An unwritable log loses the count; the stderr line below still prints.
	}
	noteOnce(log, "scan-unavailable", () =>
		write(
			`[dead-owner-census] scan did not run: ${reason} (first after ${seenAfter})`,
		),
	);
}

/**
 * Teardown hook: scan once, print one line per leak not yet in the log, record
 * it. Returns the printed lines. Never throws, and records a `scanfail` line
 * (stderr once per run) when the scan could not run.
 */
export async function runDeadOwnerCensus(
	seenAfter: string,
	options: {
		log?: string | undefined;
		seams?: CensusSeams;
		write?: (line: string) => void;
	} = {},
): Promise<string[]> {
	const log = options.log ?? censusFile();
	if (log === undefined) return [];
	const write = options.write ?? ((line) => process.stderr.write(`${line}\n`));
	try {
		const leaks = await findDeadOwnerLeaks(
			options.seams ?? (await loadActualCensusSeams()),
		);
		if (!Array.isArray(leaks)) {
			recordScanFailure(log, leaks.unavailable, seenAfter, write);
			return [];
		}
		if (leaks.length === 0) return [];
		const logText = fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";
		const reported = reportedLeakPids(logText);
		const fresh = leaks.filter((leak) => !reported.has(leak.pid));
		const lines: string[] = [];
		for (const leak of fresh.slice(0, CENSUS_MAX_LINES_PER_FILE)) {
			const line = formatLeakLine(
				leak,
				resolveOwnerFile(logText, leak.ownerPid),
				seenAfter,
			);
			lines.push(line);
			write(line);
		}
		// Every fresh pid is logged, printed or not, so a later file does not
		// reprint it; the count line says how many were not listed.
		fs.appendFileSync(
			log,
			fresh
				.map((leak) => `leak ${leak.pid} seen_after=${seenAfter}\n`)
				.join(""),
		);
		if (fresh.length > lines.length) {
			write(
				`[dead-owner-census] ${fresh.length - lines.length} more dead-owner process(es) after ${seenAfter}, not listed`,
			);
		}
		return lines;
	} catch (error) {
		recordScanFailure(
			log,
			`threw ${error instanceof Error ? error.message : String(error)}`,
			seenAfter,
			write,
		);
		return [];
	}
}
