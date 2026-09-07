// Process-table access for BOTH trees, in two halves.
//
// The PURE half (#476, Layer B assertion 3: zero surviving LSP-server child
// processes after pi exits — the #472 orphan class) answers "does this
// command line look like a leaked LSP server, and is it NEW since the
// baseline snapshot", and is unit-testable with fake process tables.
//
// The IMPURE half is the platform listing itself: `buildProcessQuery` (the
// one place a Windows CIM/WQL or POSIX `ps` command is composed),
// `parseProcessTable` (the one place its output is read back), and
// `snapshotProcesses` (the scripts-side bounded spawn around the pair).
//
// #2443 folded the LAST copies in here. Before it there were five: this
// file's two scripts/ callers plus `clients/instance-reaper.ts` (three
// queries) and `clients/resource-sampler.ts` (two) — the same projection,
// the same fail-to-an-empty-table shape, written out five times, which is
// why PR #2438's exit-code hardening (a `ps` that prints a partial table and
// then dies must not read as a complete one) reached one copy and not the
// rest. `tests/config/process-table-seam.test.ts` is the guard that keeps it
// at one.
//
// WHY THE SEAM LIVES IN scripts/ AND NOT IN clients/ (#2443 boundary
// decision). The obvious alternative — a `clients/process-snapshot.ts`
// compiled to `.js` and imported by scripts/ — is how ~20 other scripts
// consume client code, and it was rejected for ONE reason: `clients/*.js` is
// gitignored build output, and `scripts/prune-agent-worktrees.mjs` is a
// SessionStart/SubagentStop hook that runs inside freshly created agent
// worktrees, which have neither `node_modules` nor a build yet. A hygiene
// hook that throws ERR_MODULE_NOT_FOUND is strictly worse than the
// duplication it removes. This file therefore stays dependency-free (node:
// builtins only) and clients/ reaches it through
// `clients/process-snapshot.ts`, the single crossing point, typed by the
// sibling `process-scan.d.mts`.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Read the platform LIVE rather than as a module-load constant, so both the
 * Windows CIM branch and the POSIX `ps` branch of `buildProcessQuery` are
 * exercisable in unit tests regardless of the host OS (the same reasoning
 * `clients/resource-sampler.ts` states for its own platform check — the
 * Windows half of this seam ships to machines no POSIX CI runner can cover,
 * and vice versa).
 */
function runningOnWindows() {
	return process.platform === "win32";
}

/** Default ceiling for one process listing. */
const DEFAULT_SNAPSHOT_TIMEOUT_MS = 4_000;

/**
 * @typedef {"pid" | "ppid" | "ageMs" | "rssBytes" | "cpuKernel100ns" | "cpuUser100ns" | "startedAt" | "command"} ProcessField
 * @typedef {{ pid: number, ppid: number, command: string, ageMs?: number, rssBytes?: number, cpuKernel100ns?: number, cpuUser100ns?: number, startedAt?: string, cwd?: string }} ProcRow
 * @typedef {{ column: "ProcessId" | "Name" | "CommandLine", op: "eq" | "like", values: ReadonlyArray<string|number> }} ProcessFilter
 */

/**
 * Per-field platform column names and token shapes. `ps`'s `args` and CIM's
 * `CommandLine` are the same question asked twice; keeping the mapping in one
 * table is what lets a caller say `["pid", "command"]` and get the right
 * query, and the right parse, on both platforms.
 *
 * `ps: null` marks a field the POSIX listing cannot answer. Asking for one on
 * POSIX THROWS rather than yielding a silently absent column — the callers
 * that need those fields (the resource sampler's CPU/RSS query) are
 * Windows-only by construction, and a wrong-shaped `ps` invocation would
 * return zero rows, which reads exactly like "no such process".
 */
const FIELD_COLUMNS = Object.freeze({
	pid: { wmi: "ProcessId", ps: "pid", token: "int" },
	ppid: { wmi: "ParentProcessId", ps: "ppid", token: "int" },
	ageMs: { wmi: "CreationDate", ps: "etime", token: "age" },
	rssBytes: { wmi: "WorkingSetSize", ps: null, token: "int" },
	cpuKernel100ns: { wmi: "KernelModeTime", ps: null, token: "int" },
	cpuUser100ns: { wmi: "UserModeTime", ps: null, token: "int" },
	startedAt: { wmi: "CreationDate", ps: null, token: "text" },
	command: { wmi: "CommandLine", ps: "args", token: "tail" },
});

/**
 * The canonical column ORDER, which every parser assumes. `command` is LAST
 * because it is the only column that can contain the delimiter — both parsers
 * take it as the tail of the line. Derived from `FIELD_COLUMNS` rather than
 * written out again, so a field cannot exist in one list and not the other.
 */
const FIELD_ORDER = Object.freeze(Object.keys(FIELD_COLUMNS));

/**
 * The DEFAULT projection: the three columns every platform can answer, which
 * is what a caller that names no fields gets. It is deliberately NOT the full
 * field set — `rssBytes`/`cpuKernel100ns`/`cpuUser100ns`/`startedAt` exist
 * only on the Windows side, so defaulting to them would make an unprojected
 * listing throw on POSIX instead of doing the obvious thing.
 */
export const ALL_PROCESS_FIELDS = Object.freeze(["pid", "ppid", "command"]);

/** Columns a filter may name. A closed set, so the column half of a WQL
 *  clause can never carry caller-supplied text. */
const FILTERABLE_COLUMNS = new Set(["ProcessId", "Name", "CommandLine"]);

/**
 * Absolute path to a System32 executable. Windows resolves a bare
 * `powershell.exe` through PATH, which a caller can shadow; the callers spawn
 * this to decide what to KILL, so the interpreter is named absolutely.
 *
 * @param {string} name
 * @returns {string}
 */
export function windowsExe(name) {
	return path.join(
		process.env.SystemRoot ?? path.join("C:", "Windows"),
		"System32",
		name,
	);
}

/**
 * Absolute path to POSIX `ps` (S4036: never spawn via a bare PATH lookup) —
 * the same reasoning as `windowsExe` applied to the other platform, since
 * this listing decides what gets killed. Prefers `/bin/ps`, then
 * `/usr/bin/ps`, and falls back to `/bin/ps` when neither probe succeeds, so
 * the spawn fails CLOSED instead of quietly resolving through a PATH a caller
 * can shadow. (#2443 adopted the reaper's stricter form over this file's
 * earlier bare-`ps` fallback: one seam, the safer of the two behaviours.)
 *
 * @returns {string}
 */
export function posixPsPath() {
	try {
		if (fs.existsSync("/bin/ps")) return "/bin/ps";
		if (fs.existsSync("/usr/bin/ps")) return "/usr/bin/ps";
	} catch {
		/* unreadable filesystem — fall through to the absolute default */
	}
	return "/bin/ps";
}

/**
 * Normalize and order a requested field list. `pid` is always present (it is
 * the row identity) and the order always follows `ALL_PROCESS_FIELDS`, so the
 * parser never has to be told the layout it is reading.
 *
 * @param {ReadonlyArray<ProcessField>|null|undefined} fields
 * @returns {ProcessField[]}
 */
export function normalizeProcessFields(fields) {
	const requested = new Set(
		(fields ?? ALL_PROCESS_FIELDS).filter((field) => field in FIELD_COLUMNS),
	);
	requested.add("pid");
	return FIELD_ORDER.filter((field) => requested.has(field));
}

/**
 * Escape a value for embedding in a WQL LIKE clause: WQL uses `'` as the
 * string delimiter (doubled to escape) and `%`/`_` as wildcards — a marker is
 * an opaque path string, so escape all three before interpolating.
 *
 * @param {string|number} value
 * @returns {string}
 */
export function escapeWqlLikeValue(value) {
	return String(value)
		.replaceAll("'", "''")
		.replaceAll(/[%_]/g, (ch) => `[${ch}]`);
}

/**
 * Escape a value for a WQL EQUALITY comparison: only the string delimiter
 * needs escaping — `%`/`_` are literal outside `LIKE`.
 *
 * @param {string|number} value
 * @returns {string}
 */
export function escapeWqlStringValue(value) {
	return String(value).replaceAll("'", "''");
}

/**
 * A pid about to be interpolated into a query, validated as a positive
 * integer so the numeric branch can never carry query text.
 *
 * @param {string|number} value
 * @returns {number}
 */
function assertPid(value) {
	const pid = Number(value);
	if (!Number.isInteger(pid) || pid <= 0) {
		throw new Error(`process filter: invalid pid ${String(value)}`);
	}
	return pid;
}

/**
 * One WQL boolean expression for a filter. `ProcessId` is compared
 * numerically (every value validated as a positive integer first, so nothing
 * caller-supplied reaches the query text); every other column is compared as
 * an escaped string.
 *
 * @param {ProcessFilter} filter
 * @returns {string}
 */
function wqlFilterExpression(filter) {
	const { column, op, values } = filter;
	if (!FILTERABLE_COLUMNS.has(column)) {
		throw new Error(`process filter: unsupported column ${String(column)}`);
	}
	const list = [...values];
	if (list.length === 0) {
		throw new Error(`process filter: ${column} filter has no values`);
	}
	if (column === "ProcessId") {
		return list.map((value) => `ProcessId=${assertPid(value)}`).join(" OR ");
	}
	if (op === "like") {
		return list
			.map((value) => `${column} LIKE '%${escapeWqlLikeValue(value)}%'`)
			.join(" OR ");
	}
	return list
		.map((value) => `${column} = '${escapeWqlStringValue(value)}'`)
		.join(" OR ");
}

/**
 * Compose the platform command that lists processes.
 *
 * Windows uses `Get-CimInstance` through `powershell -NoProfile` with an
 * explicit WQL projection (measured ~316ms for the query vs ~570ms for the
 * unprojected form on the #2435 box, plus ~208ms powershell startup) —
 * `tasklist` exposes no parent pid and no command line, and `wmic` is gone
 * from Windows 11. POSIX uses `ps`, either `-eo <cols>` (every process) or
 * `-p <pids> -o <cols>` when the filter is a pid set, which is the only
 * filter `ps` can apply server-side.
 *
 * `serverSideFiltered` reports whether the platform actually applied the
 * filter. A `Name`/`CommandLine` filter has no `ps` equivalent, so on POSIX
 * the caller gets the whole table and must narrow it itself — said out loud
 * here rather than left as a per-caller assumption.
 *
 * `ageMs` on Windows is computed IN PowerShell as a millisecond delta, never
 * exported as `CreationDate.Ticks`: `Ticks` is the LOCAL-time representation,
 * so subtracting the Unix epoch in JS produced an age wrong by the machine's
 * UTC offset (#1857 — measured on a UTC+3 host as -8358s for a process
 * started 40 minutes earlier). A delta computed on one side of the boundary
 * has no timezone to get wrong. The explicit `[datetime]` test matters too:
 * subtracting `$null` from `(Get-Date)` yields a two-thousand-year TimeSpan,
 * which would read as "ancient" and defeat a spawn-grace guard exactly where
 * the data is missing.
 *
 * @param {ReadonlyArray<ProcessField>} [fields]
 * @param {{ filter?: ProcessFilter, excludeSelfPid?: boolean }} [options]
 * @returns {{ command: string, args: string[], tabSeparated: boolean, fields: ProcessField[], serverSideFiltered: boolean }}
 */
export function buildProcessQuery(fields = ALL_PROCESS_FIELDS, options = {}) {
	const layout = normalizeProcessFields(fields);
	const filter = options.filter;
	if (runningOnWindows()) {
		const columns = [
			...new Set(layout.map((field) => FIELD_COLUMNS[field].wmi)),
		];
		const where = filter ? ` WHERE ${wqlFilterExpression(filter)}` : "";
		// A CommandLine filter's own marker is embedded in the command line of
		// the powershell.exe running the query, so the search would match
		// itself. `$PID` is the only identity that can exclude it, and it is
		// knowable only inside the child.
		const excludeSelf = options.excludeSelfPid
			? " | Where-Object { $_.ProcessId -ne $PID }"
			: "";
		const prelude = layout.includes("ageMs")
			? "$age = if ($_.CreationDate -is [datetime]) { [int64]((Get-Date) - $_.CreationDate).TotalMilliseconds } else { '' }; "
			: "";
		const row = layout
			.map((field) =>
				field === "ageMs" ? "$age" : `$($_.${FIELD_COLUMNS[field].wmi})`,
			)
			.join("`t");
		return {
			command: windowsExe("WindowsPowerShell\\v1.0\\powershell.exe"),
			args: [
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				`Get-CimInstance -Query "SELECT ${columns.join(",")} FROM Win32_Process${where}"${excludeSelf} | ForEach-Object { ${prelude}"${row}" }`,
			],
			tabSeparated: true,
			fields: layout,
			serverSideFiltered: Boolean(filter),
		};
	}
	const unsupported = layout.filter((field) => !FIELD_COLUMNS[field].ps);
	if (unsupported.length > 0) {
		throw new Error(
			`process query: ${unsupported.join(", ")} has no POSIX ps column`,
		);
	}
	const columns = layout
		.map((field) => `${FIELD_COLUMNS[field].ps}=`)
		.join(",");
	const pidFilter =
		filter && filter.column === "ProcessId" && filter.op === "eq"
			? [...filter.values].map((value) => assertPid(value))
			: null;
	return {
		command: posixPsPath(),
		args: pidFilter
			? ["-p", pidFilter.join(","), "-o", columns]
			: ["-eo", columns],
		tabSeparated: false,
		fields: layout,
		serverSideFiltered: Boolean(pidFilter),
	};
}

/**
 * Parse a non-negative integer token, rejecting anything else. A nonsensical
 * value means the value is UNKNOWN, not zero — a caller reasoning from a
 * fabricated 0 is how the #1857 local-time age bug stayed invisible.
 *
 * @param {string|undefined} raw
 * @returns {number|undefined}
 */
function parseNonNegativeInt(raw) {
	const token = String(raw ?? "").trim();
	if (!/^\d+$/.test(token)) return undefined;
	const value = Number(token);
	return Number.isFinite(value) ? value : undefined;
}

/**
 * Parse a `ps -o etime` token: `[[dd-]hh:]mm:ss`. Returns undefined for any
 * shape the column did not produce (a `ps` without the column emits the
 * command line where the token was expected).
 *
 * @param {string} raw
 * @returns {number|undefined}
 */
export function ageMsFromPosixEtime(raw) {
	const token = String(raw ?? "").trim();
	if (!/^(?:\d+-)?(?:\d+:)?\d+:\d+$/.test(token)) return undefined;
	let days = 0;
	let rest = token;
	const dash = rest.indexOf("-");
	if (dash >= 0) {
		days = Number(rest.slice(0, dash));
		rest = rest.slice(dash + 1);
	}
	const parts = rest.split(":").map(Number);
	if (parts.some((part) => !Number.isFinite(part))) return undefined;
	const [hours, minutes, seconds] =
		parts.length === 3 ? parts : [0, parts[0], parts[1]];
	return ((days * 24 + hours) * 60 * 60 + minutes * 60 + seconds) * 1000;
}

/**
 * POSIX token pattern per field: every column but the trailing command is a
 * single whitespace-delimited token, and `etime` is not purely numeric.
 *
 * @param {ProcessField} field
 * @returns {string}
 */
function posixTokenPattern(field) {
	return FIELD_COLUMNS[field].token === "age" ? "(\\S+)" : "(\\d+)";
}

/**
 * Parse a platform listing into rows.
 *
 * Windows CIM emits tab-joined fields, one per requested column. `ps` emits
 * whitespace-aligned columns whose LAST field (`args`) contains spaces, so it
 * is parsed positionally with the tail taken whole.
 *
 * `pid`, `ppid` and `command` are always present on the row at their zero
 * value (`ppid: 0`, `command: ""`) so consumers see one row shape regardless
 * of the projection; every other field appears only when it was requested,
 * and is `undefined` when the platform emitted a value that could not be
 * trusted.
 *
 * @param {string} out
 * @param {boolean} tabSeparated
 * @param {ReadonlyArray<ProcessField>} [fields]
 * @returns {ProcRow[]}
 */
export function parseProcessTable(
	out,
	tabSeparated,
	fields = ALL_PROCESS_FIELDS,
) {
	const layout = normalizeProcessFields(fields);
	const commandIndex = layout.indexOf("command");
	const positional = tabSeparated
		? null
		: new RegExp(
				`^\\s*${layout
					.filter((field) => field !== "command")
					.map((field) => posixTokenPattern(field))
					.join("\\s+")}${commandIndex === -1 ? "\\s*$" : "\\s+(.*)$"}`,
			);
	const rows = [];
	for (const line of String(out ?? "").split(/\r?\n/)) {
		if (!line.trim()) continue;
		/** @type {string[]} */
		let parts;
		if (tabSeparated) {
			const split = line.split("\t");
			if (split.length < layout.length - (commandIndex === -1 ? 0 : 1))
				continue;
			// The command is the tail: it may itself contain tabs.
			parts =
				commandIndex === -1
					? split
					: [
							...split.slice(0, commandIndex),
							split.slice(commandIndex).join("\t"),
						];
		} else {
			const match = positional?.exec(line);
			if (!match) continue;
			parts = match.slice(1);
		}
		const value = (field) => {
			const at = layout.indexOf(field);
			return at === -1 ? undefined : parts[at];
		};
		const pid = Number(value("pid"));
		if (!Number.isInteger(pid) || pid <= 0) continue;
		const ppid = Number(value("ppid"));
		/** @type {ProcRow} */
		const row = {
			pid,
			ppid: Number.isInteger(ppid) && ppid > 0 ? ppid : 0,
			command: value("command") ?? "",
		};
		for (const field of layout) {
			if (field === "pid" || field === "ppid" || field === "command") continue;
			const raw = value(field);
			if (field === "ageMs") {
				row.ageMs = tabSeparated
					? parseNonNegativeInt(raw)
					: ageMsFromPosixEtime(raw ?? "");
			} else if (field === "startedAt") {
				row.startedAt = String(raw ?? "").trim();
			} else {
				row[field] = parseNonNegativeInt(raw);
			}
		}
		rows.push(row);
	}
	return rows;
}

/**
 * Snapshot the process table, for scripts/ — one bounded spawn around
 * `buildProcessQuery` plus `parseProcessTable`.
 *
 * clients/ does NOT call this: it needs the extension's own spawn rails (an
 * unref'd child and piped stdout, a tree-kill-and-verify timeout handler, the
 * degradation ledger), so `clients/process-snapshot.ts` composes the same two
 * halves over `spawnCollectStdoutResult` instead. The QUERY and the PARSE are
 * shared; only the spawn differs, and it differs for a reason.
 *
 * Never rejects. Returns `{ rows, ok }`: `ok` is false when the listing
 * failed, timed out, never spawned, or EXITED NON-ZERO — the last of which
 * used to be ignored (PR #2438 review S5), so a `ps` that printed a partial
 * table and then died read as a complete one. `ok` is the only evidence a
 * caller has that an ABSENCE from the table means anything. Bounded by
 * `timeoutMs` so a hook can never hang a session on a wedged WMI service.
 *
 * The timed-out child is killed through the HELD HANDLE, never by spawning a
 * killer (#234: spawning during teardown aborts libuv on Windows).
 *
 * @param {ReadonlyArray<ProcessField>} [fields]
 * @param {number} [timeoutMs]
 * @param {{ filter?: ProcessFilter, excludeSelfPid?: boolean }} [options]
 * @returns {Promise<{ rows: ProcRow[], ok: boolean }>}
 */
export function snapshotProcesses(
	fields = ALL_PROCESS_FIELDS,
	timeoutMs = DEFAULT_SNAPSHOT_TIMEOUT_MS,
	options = {},
) {
	let query;
	try {
		query = buildProcessQuery(fields, options);
	} catch {
		// An unbuildable query (a Windows-only column asked for on POSIX, an
		// empty filter) is a caller bug, not a runtime outage — but this seam's
		// contract is never to throw at a best-effort caller, so it reports the
		// same not-ok empty table every other failure reports.
		return Promise.resolve({ rows: [], ok: false });
	}
	return new Promise((resolve) => {
		let settled = false;
		const finish = (rows, ok) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ rows, ok });
		};
		let child;
		const timer = setTimeout(() => {
			try {
				child?.kill();
			} catch {
				/* already gone */
			}
			finish([], false);
		}, timeoutMs);
		try {
			child = spawn(query.command, query.args, {
				shell: false,
				windowsHide: true,
				stdio: ["ignore", "pipe", "ignore"],
			});
		} catch {
			finish([], false);
			return;
		}
		let out = "";
		child.stdout.on("data", (chunk) => {
			out += chunk.toString();
		});
		child.once("error", () => finish([], false));
		// A non-zero exit (or a signal) means the listing is PARTIAL at best.
		// Whatever it printed is not evidence of what is NOT running, which is
		// exactly the question the orphan predicate asks of it.
		child.once("close", (code, signal) =>
			finish(
				parseProcessTable(out, query.tabSeparated, query.fields),
				code === 0 && !signal,
			),
		);
	});
}

/**
 * Command-line substrings that identify an LSP server process we launch.
 * Deliberately narrow — matching on the distinctive binary/module name, not
 * a generic "node" or "language-server" fragment, so the scan doesn't flag
 * unrelated node processes on a shared CI runner.
 */
export const LSP_PROCESS_MARKERS = [
	"typescript-language-server",
	"ast-grep lsp",
	"ast-grep-lsp",
	"pyright-langserver",
	"vscode-json-languageserver",
];

/**
 * @typedef {{ pid: number, command: string }} ProcessRow
 */

/**
 * True iff `command` looks like one of the LSP servers pi-lens spawns.
 *
 * @param {string} command
 */
export function isLspServerCommand(command) {
	const lower = command.toLowerCase();
	return LSP_PROCESS_MARKERS.some((marker) =>
		lower.includes(marker.toLowerCase()),
	);
}

/**
 * Diff a `before` and `after` process snapshot and return the LSP-server
 * rows that are NEW in `after` (i.e. survived/spawned during the run and are
 * still alive after pi exited — the orphan class #472 fixed). Matches by pid
 * — a row present in both snapshots with the same pid is presumed to be an
 * unrelated pre-existing process, not something this run leaked.
 *
 * @param {ProcessRow[]} before
 * @param {ProcessRow[]} after
 * @returns {ProcessRow[]}
 */
export function diffSurvivingLspProcesses(before, after) {
	const beforePids = new Set(before.map((r) => r.pid));
	return after.filter(
		(row) => !beforePids.has(row.pid) && isLspServerCommand(row.command),
	);
}

/**
 * @typedef {{ rows: ProcessRow[], ok: boolean }} ProcessSnapshot
 */

/**
 * The "no surviving LSP process" assertion (compat-smoke-behavioral.mjs,
 * Layer B assertion 3), extracted so it is unit-testable without spawning a
 * real `ps`/CIM listing.
 *
 * An absence of a row from `after` only means something when BOTH snapshots
 * are known-complete: `snapshotProcesses`'s `ok` is the only evidence of
 * that (see its doc comment). A failed or timed-out listing yields an empty
 * table, which must never read as "no leak" — that is silence, not
 * evidence, and would make a caller-side outage report a false pass
 * (PR #2438 review round 4, F-A).
 *
 * @param {ProcessSnapshot} before
 * @param {ProcessSnapshot} after
 * @returns {{ id: string, pass: boolean, detail: string }}
 */
export function evaluateNoSurvivingLspProcesses(before, after) {
	const id = "no-surviving-lsp-processes";
	if (!before.ok || !after.ok) {
		return {
			id,
			pass: false,
			detail: `process listing unavailable (before.ok=${before.ok}, after.ok=${after.ok}); cannot verify no LSP process survived`,
		};
	}
	const surviving = diffSurvivingLspProcesses(before.rows, after.rows);
	return {
		id,
		pass: surviving.length === 0,
		detail:
			surviving.length === 0
				? "no new LSP-server processes survived pi's exit"
				: `${surviving.length} surviving process(es): ${surviving.map((p) => `pid=${p.pid} ${p.command.slice(0, 80)}`).join("; ")}`,
	};
}
