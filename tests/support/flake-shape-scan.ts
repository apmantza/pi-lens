/**
 * Detectors for the flake-shape ratchet — #2547.
 *
 * Three deflake PRs in two days (#2531 alone fixed three shared-slot races)
 * and nothing counted the contention surface, so the set only grew. This
 * module owns the four detectors the ratchet (`tests/clients/flake-shape-
 * ratchet.test.ts`) runs over `tests/**\/*.test.ts`:
 *
 * 1. {@link scanRealProcessSpawn} — a real child process: a `child_process`
 *    import, a call-shaped `execFileSync`/`spawnSync`/`execSync`, a support
 *    spawn-helper call, or a spawn whose argv mentions `vitest` (a test file
 *    re-launching the
 *    suite inside itself).
 * 2. {@link scanElapsedTimeAssertion} — a DELTA of two clock reads flowing
 *    into a numeric matcher (`toBeLessThan`/`toBeGreaterThan`/…), not just a
 *    clock-read token and a matcher token co-occurring somewhere in the file
 *    (shape 34: detect the semantic shape, not token presence).
 * 3. {@link scanRawTimerWait} — a raw `setTimeout`/`setInterval` wait outside
 *    a `vi.useFakeTimers()` scope, and outside `interleaving-kit.ts` itself
 *    (the sanctioned primitive these three detectors exist to route callers
 *    toward instead).
 * 4. {@link scanUngovernedWaitFor} — a `vi.waitFor(` call outside a
 *    `vi.useFakeTimers()` scope — the #1767 shape
 *    (`tests/clients/runtime-session.test.ts`'s own recorded flake, real
 *    polling racing a real `testTimeout` budget). Reuses detector 3's exact
 *    fake/real-timers file-order tracking.
 *
 * Built on `sweep-kit.ts` ({@link stripSource}, {@link listSourceFiles},
 * {@link relativePosix}) rather than a private walker — #2487's kit already
 * owns comment/string stripping and deterministic file listing.
 *
 * ## Known limits, named rather than papered over
 *
 * - Detector 2's dataflow tracking is LINE-SCOPED to one `const`/`let`/`var`
 *   assignment per identifier; a destructured clock read
 *   (`const [s, ns] = process.hrtime(t0);`) is invisible unless the whole
 *   `process.hrtime(...)` call itself sits inside the `expect(...)` argument.
 *   False negative, the safe direction for a ratchet.
 * - Detectors 3 and 4's shared fake/real-timers tracking
 *   ({@link fakeTimersStateAtLine}) is FILE-ORDER, not scope-accurate: it
 *   does not know which `describe`/`it` block a `vi.useFakeTimers()` call
 *   belongs to, only its line position. A file that calls
 *   `vi.useFakeTimers()` in one `describe` and leaves a raw wait or
 *   `vi.waitFor` ungoverned in a LATER, unrelated `describe` reads as
 *   governed. False negative, same direction.
 * - Detector 1's `strings: "keep"` policy (needed to see `"vitest"` inside an
 *   argv string) means a string literal that merely CONTAINS
 *   `execFileSync(...)`-shaped text would false-positive; comments are
 *   blanked so a doc comment cannot. No such string exists in `tests/` today
 *   (the FALSE positive direction, safe for a ratchet that a human reviews at
 *   admission time).
 * - Detector 1 recognizes known support-module helper names at their test call
 *   sites and ignores calls whose helper module is mocked in that file. It
 *   still cannot resolve arbitrary aliases, so aliases remain conservative
 *   false positives. Quoted and commented helper names are excluded by
 *   `codeMatches`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
	codeMatches,
	firstCommentMatch,
	listSourceFiles,
	relativePosix,
	stripSource,
} from "./sweep-kit.js";

export const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

const TESTS_ROOT = path.join(repoRoot, "tests");

/** Every `*.test.ts` file under `tests/`, as absolute paths, sorted. */
export function testSourceFiles(dir = TESTS_ROOT): string[] {
	return listSourceFiles(dir, {
		extensions: [".ts"],
		skipDeclarations: true,
	}).filter((absolute) => absolute.endsWith(".test.ts"));
}

/** `tests/`-relative posix path for an absolute source path. */
export function testsRelative(absolute: string): string {
	return relativePosix(TESTS_ROOT, absolute);
}

/**
 * `tests/`-relative files that are the ratchet's OWN scanning infrastructure
 * — the ratchet's test file and this module's unit-test fixtures carry
 * literal spawn/timer/clock-matcher TEXT as synthetic fixture strings, and
 * `tests/` fully contains `tests/clients/flake-shape-ratchet.test.ts`, unlike
 * `single-flight-ratchet.test.ts`'s `clients/`-only scan target, which never
 * contains its own test file. Excluding these by name is the same move
 * `delivery-surface-ratchet.test.ts` makes for `finding-delivery-gate.ts`
 * ("the registry itself").
 */
export const SCAN_INFRASTRUCTURE: ReadonlySet<string> = new Set([
	"clients/flake-shape-ratchet.test.ts",
]);

/** One line the scan flags. */
export interface FlakeHit {
	/** 1-based line number. */
	line: number;
	/** Trimmed source text of the flagged line, for diagnostics. */
	text: string;
	/** Which sub-shape matched, for messages. */
	reason: string;
}

export const DETECTOR_NAMES = [
	"real-process-spawn",
	"elapsed-time-assertion",
	"raw-timer-wait",
	"ungoverned-wait-for",
] as const;

export type DetectorName = (typeof DETECTOR_NAMES)[number];

// ── 1. Real-process spawn ───────────────────────────────────────────────────

const CHILD_PROCESS_IMPORT =
	/(?:^\s*import\b.*\bfrom\s*["'](?:node:)?child_process["']|\brequire\(\s*["'](?:node:)?child_process["']\s*\))/;
const SPAWN_CALL =
	/\b(spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\s*\(/g;
const SYNC_TRIAD = new Set(["execFileSync", "spawnSync", "execSync"]);
const VITEST_IN_ARGV = /\bvitest\b/i;
// These helpers are the test-side routes to real child processes. Keep this
// list beside the support-module census: matching the CALL in a test catches
// a helper that hides `node:child_process` behind another module boundary.
const SUPPORT_SPAWN_HELPER_CALL =
	/\b(gitFixtureSpawnAsync|gitExecFileSync|gitExecSync|execFileSync|execSync|spawnWedgedChild|safeSpawnAsync)\s*\(/g;
const MOCK_CALL = /\bvi\.(?:mock|doMock)\s*\(\s*["']([^"']+)["']/g;
const HELPER_MODULE_SUFFIXES: Record<string, readonly string[]> = {
	gitFixtureSpawnAsync: ["/git-fixture-env", "/git-fixture-env.js"],
	gitExecFileSync: ["/git-fixture-env", "/git-fixture-env.js"],
	gitExecSync: ["/git-fixture-env", "/git-fixture-env.js"],
	spawnWedgedChild: ["/fault-injection", "/fault-injection.ts"],
	safeSpawnAsync: ["/safe-spawn", "/safe-spawn.js"],
	execFileSync: ["node:child_process", "child_process"],
	execSync: ["node:child_process", "child_process"],
};

function mockedModules(source: string): Set<string> {
	const modules = new Set<string>();
	MOCK_CALL.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = MOCK_CALL.exec(stripSource(source, { strings: "keep" })))) {
		modules.add(match[1]);
	}
	return modules;
}

function helperIsMocked(name: string, modules: ReadonlySet<string>): boolean {
	return (HELPER_MODULE_SUFFIXES[name] ?? []).some((suffix) =>
		[...modules].some((module) => module === suffix || module.endsWith(suffix)),
	);
}

/** The text between a call's `(` (given its index) and its balanced `)`. */
function balancedCallArgs(source: string, openParenIndex: number): string {
	let depth = 0;
	for (let i = openParenIndex; i < source.length; i++) {
		const ch = source[i];
		if (ch === "(") depth++;
		else if (ch === ")") {
			depth--;
			if (depth === 0) return source.slice(openParenIndex + 1, i);
		}
	}
	return source.slice(openParenIndex + 1);
}

/**
 * A real child process: a `child_process` import, a call-shaped
 * `execFileSync`/`spawnSync`/`execSync`, or ANY spawn flavor whose argv
 * mentions `vitest` — a test file re-launching the suite inside itself.
 *
 * `strings: "keep"` is required to see `"vitest"` inside an argv array;
 * comments are still blanked so a doc comment naming these calls cannot
 * count (see the module doc's known-limits note for the trade this makes).
 */
export function scanRealProcessSpawn(
	_file: string,
	source: string,
): FlakeHit[] {
	const stripped = stripSource(source, { strings: "keep" });
	const lines = stripped.split("\n");
	const hits = new Map<number, FlakeHit>();
	const mocks = mockedModules(source);
	const childProcessMocked = [...mocks].some(
		(module) => module === "node:child_process" || module === "child_process",
	);

	lines.forEach((lineText, idx) => {
		if (!childProcessMocked && CHILD_PROCESS_IMPORT.test(lineText)) {
			hits.set(idx, {
				line: idx + 1,
				text: lineText.trim(),
				reason: "child_process import",
			});
		}
	});

	SPAWN_CALL.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = SPAWN_CALL.exec(stripped))) {
		const name = m[1];
		const openParenIndex = m.index + m[0].length - 1;
		const lineIdx = stripped.slice(0, m.index).split("\n").length - 1;
		const isVitestInVitest =
			!SYNC_TRIAD.has(name) &&
			VITEST_IN_ARGV.test(balancedCallArgs(stripped, openParenIndex));
		if ((!childProcessMocked && SYNC_TRIAD.has(name)) || isVitestInVitest) {
			if (!hits.has(lineIdx)) {
				hits.set(lineIdx, {
					line: lineIdx + 1,
					text: (lines[lineIdx] ?? "").trim(),
					reason: SYNC_TRIAD.has(name)
						? `${name}( real sync spawn`
						: `${name}( vitest-in-vitest (argv mentions "vitest")`,
				});
			}
		}
	}

	for (const match of codeMatches(source, SUPPORT_SPAWN_HELPER_CALL)) {
		if (childProcessMocked || helperIsMocked(match[1], mocks)) continue;
		const lineIdx = source.slice(0, match.index ?? 0).split("\n").length - 1;
		if (!hits.has(lineIdx)) {
			hits.set(lineIdx, {
				line: lineIdx + 1,
				text: source.split("\n")[lineIdx]?.trim() ?? "",
				reason: `${match[1]}( support spawn helper`,
			});
		}
	}
	return [...hits.values()].sort((a, b) => a.line - b.line);
}

// ── 2. Elapsed-time assertion ───────────────────────────────────────────────

const CLOCK_READ = /\b(?:Date\.now|performance\.now|process\.hrtime)\s*\(/;
const NUMERIC_MATCHER =
	/\.(toBeLessThan|toBeGreaterThan|toBeLessThanOrEqual|toBeGreaterThanOrEqual)\s*\(/;
const SIMPLE_ASSIGN =
	/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(.+?);?\s*$/;
const SUBTRACTION =
	/([A-Za-z_$][\w$.]*(?:\([^()]*\))?)\s*-\s*([A-Za-z_$][\w$.]*(?:\([^()]*\))?)/;
const EXPECT_ARG = /\bexpect\(\s*([^)]*)\)/;

/**
 * A DELTA of two clock reads flowing into a numeric matcher — not merely a
 * clock-read call and a `toBeLessThan`-family matcher both present somewhere
 * in the file (the token-only shape shape 34 asks to avoid).
 *
 * Two-pass: first tag every identifier assigned directly from a clock read
 * (`const start = Date.now();`) or from a subtraction naming one
 * (`const elapsed = Date.now() - start;`), then flag every numeric-matcher
 * line whose `expect(...)` argument is clock-derived — inline
 * (`expect(Date.now() - start)`) or via a tagged identifier
 * (`expect(elapsed)`).
 */
export function scanElapsedTimeAssertion(
	_file: string,
	source: string,
): FlakeHit[] {
	const stripped = stripSource(source, { strings: "blank" });
	const lines = stripped.split("\n");

	const clockDerived = new Set<string>();
	const deltaDerived = new Set<string>();
	const isClockOrDerived = (token: string): boolean => {
		const t = token.trim();
		return CLOCK_READ.test(t) || clockDerived.has(t) || deltaDerived.has(t);
	};

	lines.forEach((lineText) => {
		const assign = SIMPLE_ASSIGN.exec(lineText);
		if (!assign) return;
		const [, name, rhs] = assign;
		if (CLOCK_READ.test(rhs)) {
			clockDerived.add(name);
			return;
		}
		const sub = SUBTRACTION.exec(rhs);
		if (sub && (isClockOrDerived(sub[1]) || isClockOrDerived(sub[2]))) {
			deltaDerived.add(name);
		}
	});

	const hits: FlakeHit[] = [];
	lines.forEach((lineText, idx) => {
		if (!NUMERIC_MATCHER.test(lineText)) return;
		const expectArg = EXPECT_ARG.exec(lineText)?.[1]?.trim();
		if (!expectArg) return;
		let deltaShaped = isClockOrDerived(expectArg);
		if (!deltaShaped) {
			const inlineSub = SUBTRACTION.exec(expectArg);
			deltaShaped =
				!!inlineSub &&
				(isClockOrDerived(inlineSub[1]) || isClockOrDerived(inlineSub[2]));
		}
		if (deltaShaped) {
			hits.push({
				line: idx + 1,
				text: lineText.trim(),
				reason: "a clock-read delta feeds a numeric matcher",
			});
		}
	});
	return hits;
}

// ── 3. Raw setTimeout/setInterval wait ──────────────────────────────────────

const RAW_TIMER_CALL = /\b(setTimeout|setInterval)\s*\(/;
const USE_FAKE_TIMERS = /\bvi\.useFakeTimers\s*\(/;
const USE_REAL_TIMERS = /\bvi\.useRealTimers\s*\(/;

/**
 * Per-line "are fake timers active here" state, tracked in FILE-ORDER (see
 * the module doc's known-limits note): `vi.useFakeTimers()` turns tracking
 * on, the next `vi.useRealTimers()` turns it off, and every line in between
 * reads as governed. Shared by {@link scanRawTimerWait} and
 * {@link scanUngovernedWaitFor} — both key off the exact same toggle, so it
 * is computed once rather than re-derived per detector.
 */
function fakeTimersStateAtLine(lines: readonly string[]): boolean[] {
	let fakeTimersActive = false;
	return lines.map((lineText) => {
		if (USE_FAKE_TIMERS.test(lineText)) fakeTimersActive = true;
		else if (USE_REAL_TIMERS.test(lineText)) fakeTimersActive = false;
		return fakeTimersActive;
	});
}

/**
 * A raw `setTimeout`/`setInterval` wait outside a `vi.useFakeTimers()` scope.
 *
 * `interleaving-kit.ts` itself is exempt by name (#2547's sanctioned
 * primitive; it is not a `.test.ts` file so the ratchet's own glob never
 * reaches it, but the exemption is stated here too so a caller that scans it
 * directly — this module's own self-test — gets the same answer).
 */
export function scanRawTimerWait(file: string, source: string): FlakeHit[] {
	if (path.posix.basename(file) === "interleaving-kit.ts") return [];
	const stripped = stripSource(source, { strings: "blank" });
	const lines = stripped.split("\n");
	const stateAtLine = fakeTimersStateAtLine(lines);

	const hits: FlakeHit[] = [];
	lines.forEach((lineText, idx) => {
		const m = RAW_TIMER_CALL.exec(lineText);
		if (!m || stateAtLine[idx]) return;
		hits.push({
			line: idx + 1,
			text: lineText.trim(),
			reason: `raw ${m[1]}( outside vi.useFakeTimers()`,
		});
	});
	return hits;
}

// ── 4. Ungoverned vi.waitFor ────────────────────────────────────────────────

const WAIT_FOR_CALL = /\bvi\.waitFor\s*\(/;

/**
 * A `vi.waitFor(` call outside a `vi.useFakeTimers()` scope — the #1767
 * shape (`tests/clients/runtime-session.test.ts`'s own recorded flake):
 * `vi.waitFor`'s default poll loop runs on the REAL clock, so under shared-
 * slot machine contention its polling interval and the surrounding
 * `describe`/`it` `testTimeout` race each other the same way a raw
 * `setTimeout` wait does. Reuses detector 3's exact fake/real-timers
 * file-order tracking ({@link fakeTimersStateAtLine}) — a `vi.waitFor` under
 * `vi.useFakeTimers()` is a caller explicitly driving it with
 * `vi.advanceTimersByTimeAsync`, not left to real wall-clock polling.
 */
export function scanUngovernedWaitFor(
	_file: string,
	source: string,
): FlakeHit[] {
	const stripped = stripSource(source, { strings: "blank" });
	const lines = stripped.split("\n");
	const stateAtLine = fakeTimersStateAtLine(lines);

	const hits: FlakeHit[] = [];
	lines.forEach((lineText, idx) => {
		if (!WAIT_FOR_CALL.test(lineText) || stateAtLine[idx]) return;
		hits.push({
			line: idx + 1,
			text: lineText.trim(),
			reason: "vi.waitFor( outside vi.useFakeTimers()",
		});
	});
	return hits;
}

export const DETECTORS: Record<
	DetectorName,
	(file: string, source: string) => FlakeHit[]
> = {
	"real-process-spawn": scanRealProcessSpawn,
	"elapsed-time-assertion": scanElapsedTimeAssertion,
	"raw-timer-wait": scanRawTimerWait,
	"ungoverned-wait-for": scanUngovernedWaitFor,
};

/** file → hit count, for every `tests/**\/*.test.ts` file the detector flags. */
export function countsByDetector(
	detector: DetectorName,
): Record<string, number> {
	const scan = DETECTORS[detector];
	const counts: Record<string, number> = {};
	for (const absolute of testSourceFiles()) {
		const file = testsRelative(absolute);
		if (SCAN_INFRASTRUCTURE.has(file)) continue;
		const source = fs.readFileSync(absolute, "utf8");
		const hits = scan(file, source);
		if (hits.length > 0) counts[file] = hits.length;
	}
	return counts;
}

// ── Admission gate ──────────────────────────────────────────────────────────

const ADMISSION_HEADER =
	/^[ \t]*\/\/[ \t]*flake-shape:[ \t]*([\w-]+)[ \t]*—[ \t]*(.+)$/gm;

export interface AdmissionHeader {
	detector: string;
	reason: string;
}

/**
 * The file's `// flake-shape: <detector> — <reason>` header, if present.
 * Admission of a NEW ratchet entry (a file not in the frozen baseline, or an
 * allowlisted file whose count rose) requires this header naming which
 * detector the entry is admitted under and why a mock is not faithful, AND
 * the file's membership in `vitest.config.ts`'s `wallClockBudgetInclude`
 * project (so it runs in the fully serialized lane) — see
 * `ADMITTED_AFTER_BASELINE` in `tests/clients/flake-shape-ratchet.test.ts`.
 */
export function admissionHeader(source: string): AdmissionHeader | undefined {
	const match = firstCommentMatch(source, ADMISSION_HEADER);
	return match ? { detector: match[1], reason: match[2].trim() } : undefined;
}
