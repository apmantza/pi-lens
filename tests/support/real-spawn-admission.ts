/**
 * #5100 — the one answer to "does this test file have permission to start a
 * real child process?".
 *
 * The run-time observer (`tests/support/real-spawn-observer.ts`) records a real
 * `node:child_process` call while a file runs; the teardown check asks THIS
 * module whether the file is admitted. Two ledgers answer, and a file needs
 * only one:
 *
 * - `flake-shape-baseline.json` → `real-process-spawn` — the static census's
 *   pinned, digest-frozen population
 *   (`tests/clients/flake-shape-ratchet.test.ts`). A row there is the account;
 *   the `// flake-shape: real-process-spawn` header, the
 *   `wallClockBudgetInclude` lane, and the `ADMITTED_AFTER_BASELINE` entry are
 *   the ratchet's conditions for ADDING one, enforced where a row is added, not
 *   here. The mint is write-once, so this ledger is not where a run that just
 *   observed a new spawner records it.
 * - `real-spawn-observed.json` — the run-time ledger: one row per file the
 *   observer caught starting a real child through a route the static census
 *   does not name (a support helper it has never registered, a renamed import).
 *   Each row carries the route the run observed, so the admission is a claim a
 *   reviewer can check against the run, not a bare allowlist entry. It is the
 *   growing set: when a route becomes a census member, the census row wins and
 *   the observed row is deleted (its governance test reds a row the census
 *   already covers, so the runtime ledger cannot quietly become the place rows
 *   live).
 *
 * - {@link RUNTIME_SCAN_SKIP}: the governance files that run the census, and so
 *   read the source of every spawner in the tree. They are not a spawner's
 *   contention; the census excludes them for the same reason and the run-time
 *   gate must not out-vote its own instrument.
 *
 * Kept free of `@ast-grep/napi` and every heavy import: `vitest-setup.ts`
 * imports it in every worker.
 */
import type { RealSpawnLedger } from "./real-spawn-observer.js";
import { harnessSpawnCount, repoRelative } from "./real-spawn-observer.js";

/** The census baseline file: `{ "<detector>": { "<file below tests/>": count } }`. */
export const REAL_SPAWN_BASELINE_FILE = "flake-shape-baseline.json";

/** The run-time ledger file: `{ "<file below tests/>": { reason, routes } }`. */
export const REAL_SPAWN_OBSERVED_FILE = "real-spawn-observed.json";

/** The detector whose rows are the real-spawn admission. */
export const REAL_SPAWN_DETECTOR = "real-process-spawn";

/** Governance files the census excludes (#4792 `SCAN_INFRASTRUCTURE`): each
 *  reads the source of every file in the tree, so every spawner's name appears
 *  in them by construction. They must not be judged as spawners themselves —
 *  otherwise a census run would red its own runner. */
export const RUNTIME_SCAN_SKIP = new Set([
	"clients/flake-shape-ratchet.test.ts",
	"config/spawn-cwd-scan.test.ts",
]);

/** An injected file reader so a test can drive the gate without touching disk. */
export interface RealSpawnAdmissionIo {
	/** Read a UTF-8 file (a ledger and the test file's own source). */
	readFile(path: string): string;
	/** Absolute path of `tests/support/`, so a ledger is found without
	 *  depending on the worker's cwd. */
	supportDir: string;
}

/** One observed row: why the file starts a child, and the route the run saw. */
export interface RealSpawnObservedRow {
	reason: string;
	/** `"<entry>:<command> via <module>"`, copied from the run's evidence. */
	routes: string[];
}

interface LedgerCache {
	supportDir: string;
	/** `null` = the ledger could not be read or parsed, which admits nothing. */
	census: Set<string> | null;
	observed: Set<string> | null;
	/** A ledger that could not be read: the gate must not silently pass every
	 *  spawner, so an unreadable ledger admits nothing and each judged file
	 *  reports it. */
	problems: string[];
}

const cache: LedgerCache = {
	supportDir: "",
	census: null,
	observed: null,
	problems: [],
};

/** Parse one ledger's keys. `pick` returns the keyed object out of the file's
 *  shape (the census nests its rows under the detector name; the observed
 *  ledger is flat). */
function readLedgers(io: RealSpawnAdmissionIo): void {
	if (cache.supportDir === io.supportDir && cache.supportDir !== "") return;
	cache.supportDir = io.supportDir;
	cache.census = null;
	cache.observed = null;
	cache.problems = [];

	let censusParsed: unknown;
	try {
		censusParsed = JSON.parse(
			io.readFile(`${io.supportDir}/${REAL_SPAWN_BASELINE_FILE}`),
		) as unknown;
	} catch (error) {
		cache.problems.push(
			`the ${REAL_SPAWN_DETECTOR} baseline could not be read: ${String(
				error instanceof Error ? error.message : error,
			)}`,
		);
		return;
	}
	const rows = (
		censusParsed as Record<string, Record<string, number> | undefined>
	)?.[REAL_SPAWN_DETECTOR];
	if (!rows || typeof rows !== "object") {
		cache.problems.push(
			`the ${REAL_SPAWN_DETECTOR} baseline has no "${REAL_SPAWN_DETECTOR}" table`,
		);
		return;
	}
	cache.census = new Set(Object.keys(rows));

	let observedParsed: unknown;
	try {
		observedParsed = JSON.parse(
			io.readFile(`${io.supportDir}/${REAL_SPAWN_OBSERVED_FILE}`),
		) as unknown;
	} catch (error) {
		const code = (error as { code?: string })?.code;
		if (code !== "ENOENT") {
			cache.problems.push(
				`the run-time real-spawn ledger could not be read: ${String(
					error instanceof Error ? error.message : error,
				)}`,
			);
			return;
		}
		cache.observed = new Set();
		return;
	}
	if (
		!observedParsed ||
		typeof observedParsed !== "object" ||
		Array.isArray(observedParsed)
	) {
		cache.problems.push(
			`tests/support/${REAL_SPAWN_OBSERVED_FILE} is not an object`,
		);
		return;
	}
	cache.observed = new Set(
		Object.keys(observedParsed as Record<string, unknown>),
	);
}

/**
 * Whether `file` (spelled below `tests/`, forward slashes) may start a real
 * child: it holds a pinned census row, an observed-ledger row, or the census
 * excludes it as scan infrastructure.
 */
export function hasRealSpawnAdmission(
	file: string,
	io: RealSpawnAdmissionIo,
): boolean {
	if (RUNTIME_SCAN_SKIP.has(file)) return true;
	readLedgers(io);
	return (
		(cache.census?.has(file) ?? false) || (cache.observed?.has(file) ?? false)
	);
}

/** The ledger-reading problems, for the failure message (empty when both ledgers read). */
export function realSpawnAdmissionProblems(io: RealSpawnAdmissionIo): string[] {
	readLedgers(io);
	return cache.problems;
}

/** One caller frame's module and line: `tests/mcp/harness.ts:98` from
 *  `harness:new McpHarness (/abs/tests/mcp/harness.ts:98:16)`. A frame with no
 *  parenthesized location (an anonymous frame) is reported as-is, shortened. */
function frameSite(frame: string): string {
	const at = /\(([^)]+)\)\s*$/.exec(frame);
	const site = (at?.[1] ?? frame.replace(/^[a-z]+:/, "")).trim();
	return repoRelative(site).replace(/:(\d+):\d+$/, ":$1");
}

/** The distinct harness routes this run observed, as
 *  `"<entry>:<command> via <module>:<line>"`, capped so one chatty file cannot
 *  fill the terminal: the count in the sentence above the list is the total. */
export function realSpawnRouteSummaries(
	ledger: RealSpawnLedger,
	cap = 4,
): string[] {
	const routes = new Set<string>();
	for (const call of ledger.harnessCalls) {
		routes.add(
			`${call.entry}:${call.command} via ${frameSite(call.frames[0] ?? "?")}`,
		);
	}
	const all = [...routes];
	return all.length > cap
		? [...all.slice(0, cap), `+${all.length - cap} more`]
		: all;
}

/** The row a run asks the author to paste, with the routes it observed. */
export function realSpawnObservedRowDraft(
	ledger: RealSpawnLedger,
): RealSpawnObservedRow {
	return {
		reason:
			"<why this file must start a real child, and why a mock will not do>",
		routes: realSpawnRouteSummaries(ledger, 8),
	};
}

/**
 * The gate decision for one finished file: `undefined` when nothing is owed,
 * the failure message when the file started a real child from harness code and
 * holds no admission. Exported as a pure function so
 * `tests/support/real-spawn-observer.test.ts` drives the whole decision table
 * (admitted by census / admitted by the run-time ledger / unadmitted /
 * production-route-only / scan infrastructure / an unreadable ledger) without
 * nesting a vitest run.
 *
 * A ledger that cannot be read is reported: a census that cannot read its own
 * admissions must not pass a spawner (fail closed).
 */
export function realSpawnGateFailure(
	file: string,
	ledger: RealSpawnLedger,
	io: RealSpawnAdmissionIo,
): string | undefined {
	const harness = harnessSpawnCount(ledger);
	if (harness === 0) return undefined;
	if (hasRealSpawnAdmission(file, io)) return undefined;
	const problems = realSpawnAdmissionProblems(io);
	const routes = realSpawnRouteSummaries(ledger).join("; ");
	return (
		`\u26d4 #5100 real-spawn census: this file started ${harness} real child ` +
		`process(es) from harness code (${routes}) and holds no admission.` +
		(problems.length > 0
			? `\n  (${problems.join("; ")})`
			: `\n  Add a row to tests/support/${REAL_SPAWN_OBSERVED_FILE}, ` +
				`keyed "${file}", with the route the run saw and a reason a ` +
				`reviewer can check:\n` +
				`    ${JSON.stringify(realSpawnObservedRowDraft(ledger))}\n` +
				`  Mock the child instead when the test does not need a real ` +
				`process. When the route is one the static census should name ` +
				`(a shared support kit, a production client), register it in ` +
				`tests/support/flake-shape-scan.ts instead: the census's ` +
				`\`real-process-spawn\` row then carries the admission, with its ` +
				`\`// flake-shape: ${REAL_SPAWN_DETECTOR}\` header, its ` +
				`ADMITTED_AFTER_BASELINE entry, and its lane in vitest.config.ts.`)
	);
}
