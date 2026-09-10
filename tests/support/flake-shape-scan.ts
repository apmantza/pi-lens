/**
 * Detectors for the flake-shape ratchet — #2547.
 *
 * Three deflake PRs in two days (#2531 alone fixed three shared-slot races)
 * and nothing counted the contention surface, so the set only grew. This
 * module owns the four detectors the ratchet (`tests/clients/flake-shape-
 * ratchet.test.ts`) runs over `tests/**\/*.test.ts` and — since #2563 — over
 * every non-test helper under `tests/support/**\/*.ts` (the time detectors
 * only; the spawn detector stays test-file-only, see
 * {@link SUPPORT_POPULATION_DETECTORS}):
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
 *    toward instead); in a `tests/support/` helper it also flags any
 *    `delay`/`sleep` helper DEFINITION (#2563 — the shared-primitive reuse
 *    vector that hides a raw wait from every `.test.ts` call site).
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
 * - Detector 1 uses `callSites`'s TypeScript AST for the known process-call
 *   names, so comments, strings, wrappers, and nested argument expressions do
 *   not create or truncate call sites. It separately uses `codeMatches` for
 *   helper calls and mock declarations, while `strings: "keep"` remains only
 *   for the intentional `"vitest"` argv evidence.
 * - Detector 1 recognizes known support-module helper names at their test call
 *   sites and ignores calls whose helper module is mocked in that file. It
 *   still cannot resolve arbitrary aliases, so aliases remain conservative
 *   false positives. Quoted and commented helper names are excluded by
 *   `codeMatches`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Lang, parse } from "@ast-grep/napi";

import {
	createCallSiteScanner,
	codeMatches,
	firstCommentMatch,
	listSourceFiles,
	relativePosix,
	stripSource,
} from "./sweep-kit.js";
import type { SgNode } from "../../clients/deps/ast-grep-napi.js";

export const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

const TESTS_ROOT = path.join(repoRoot, "tests");

/** Every `*.test.ts` file under `tests/`, as absolute paths, sorted. */
function testSourceFiles(dir = TESTS_ROOT): string[] {
	return listSourceFiles(dir, {
		extensions: [".ts"],
		skipDeclarations: true,
	}).filter((absolute) => absolute.endsWith(".test.ts"));
}

/**
 * Every non-test `*.ts` helper under `tests/support/` (#2563) — the shared
 * primitives every `.test.ts` file imports. A raw-timer wait hidden inside
 * one of these reaches every importing test file while sitting outside the
 * `.test.ts` glob the ratchet originally walked, so the support population
 * joins the scan.
 */
function supportHelperFiles(): string[] {
	return listSourceFiles(path.join(TESTS_ROOT, "support"), {
		extensions: [".ts", ".mts"],
		skipDeclarations: true,
	}).filter((absolute) => !absolute.endsWith(".test.ts"));
}

/**
 * #2563: the support-population gate for {@link scanRawTimerWait}'s
 * delay/sleep-definition shape — a non-test helper under `tests/support/`.
 * `file` is the `tests/`-relative posix key {@link countsByDetector} scans
 * under. In a `.test.ts` file the shape is redundant: the timer call itself
 * (hidden or not) already lands under the test-file detectors.
 */
function isSupportHelperFile(file: string): boolean {
	return file.startsWith("support/") && !file.endsWith(".test.ts");
}

/** `tests/`-relative posix path for an absolute source path. */
function testsRelative(absolute: string): string {
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
const SCAN_INFRASTRUCTURE: ReadonlySet<string> = new Set([
	"clients/flake-shape-ratchet.test.ts",
	"support/spawn-cwd-scan.test.ts",
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

export interface ScanContext {
	source: string;
	stripped: string;
	root: SgNode | undefined;
	rootReady: boolean;
}

function scanContext(source: string): ScanContext {
	return {
		source,
		stripped: stripSource(source),
		root: undefined,
		rootReady: false,
	};
}

function syntaxRoot(context: ScanContext): SgNode {
	if (!context.rootReady) {
		context.root = parse(Lang.TypeScript, context.source).root();
		context.rootReady = true;
	}
	return context.root as SgNode;
}

// Keep this lexical admission check cheap. It runs after comments and strings
// are blanked, so fixture prose cannot force an AST parse.
const TIMER_AST_TRIGGER =
	/\b(?:setTimeout|setInterval|timers\/promises|globalThis|delay|sleep)\b/;
function needsTimerAst(context: ScanContext): boolean {
	return TIMER_AST_TRIGGER.test(context.stripped);
}

// ── 1. Real-process spawn ───────────────────────────────────────────────────

const CHILD_PROCESS_IMPORT =
	/(?:^\s*import\b.*\bfrom\s*["'](?:node:)?child_process["']|\brequire\(\s*["'](?:node:)?child_process["']\s*\))/;
const SYNC_TRIAD = new Set(["execFileSync", "spawnSync", "execSync"]);
const VITEST_IN_ARGV = /\bvitest\b/i;
// These helpers are the test-side routes to real child processes. Keep this
// list beside the support-module census: matching the CALL in a test catches
// a helper that hides `node:child_process` behind another module boundary.
const SUPPORT_SPAWN_HELPER_CALL =
	/\b(gitFixtureSpawnAsync|gitExecFileSync|gitExecSync|execFileSync|execSync|spawnWedgedChild|safeSpawnAsync|withRealPi)\s*\(/g;
const MOCK_CALL = /\bvi\.(?:mock|doMock|hoisted)\s*\(\s*["']([^"']+)["']/g;
const HELPER_MODULE_SUFFIXES: Record<string, readonly string[]> = {
	gitFixtureSpawnAsync: ["/git-fixture-env", "/git-fixture-env.js"],
	gitExecFileSync: ["/git-fixture-env", "/git-fixture-env.js"],
	gitExecSync: ["/git-fixture-env", "/git-fixture-env.js"],
	spawnWedgedChild: ["/fault-injection", "/fault-injection.ts"],
	safeSpawnAsync: ["/safe-spawn", "/safe-spawn.js"],
	withRealPi: [
		"/real-pi-harness",
		"/real-pi-harness.js",
		"/real-pi-harness.ts",
	],
	execFileSync: ["node:child_process", "child_process"],
	execSync: ["node:child_process", "child_process"],
};

function mockedModules(source: string): Set<string> {
	const modules = new Set<string>();
	for (const match of codeMatches(source, MOCK_CALL)) {
		modules.add(match[1]);
	}
	return modules;
}

function helperIsMocked(name: string, modules: ReadonlySet<string>): boolean {
	return (HELPER_MODULE_SUFFIXES[name] ?? []).some((suffix) =>
		[...modules].some((module) => module === suffix || module.endsWith(suffix)),
	);
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
	context?: ScanContext,
): FlakeHit[] {
	const stripped = stripSource(source, { strings: "keep" });
	const spawnCandidate = /\b(?:spawn|exec|fork)\s*\(|child_process/i.test(
		stripped,
	);
	const sharedRoot =
		context && spawnCandidate ? syntaxRoot(context) : context?.root;
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

	for (const site of createCallSiteScanner(source, sharedRoot).find(
		/^(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)$/,
	)) {
		const name = site.callee;
		const lineIdx = site.line - 1;
		const isVitestInVitest =
			!SYNC_TRIAD.has(name) && VITEST_IN_ARGV.test(site.argsText);
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
	_context?: ScanContext,
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

const TIMER_IMPORT_MODULES = new Set([
	"node:timers/promises",
	"timers/promises",
]);
const TIMER_GLOBALS = new Set(["globalThis", "window", "self"]);

/** Resolve timer aliases from the parsed binding declarations. */
function timerBindings(
	source: string,
	root?: SgNode,
): {
	local: Set<string>;
	namespaces: Set<string>;
} {
	const local = new Set(["setTimeout", "setInterval"]);
	const namespaces = new Set<string>();
	const syntax = root ?? parse(Lang.TypeScript, source).root();
	const visit = (node: SgNode): void => {
		if (node.kind() === "import_statement") {
			const module = node
				.field("source")
				?.text()
				.replace(/^['"]|['"]$/g, "");
			if (module && TIMER_IMPORT_MODULES.has(module)) {
				for (const child of node.children()) {
					if (child.kind() !== "import_clause") continue;
					for (const specifier of child.children()) {
						if (specifier.kind() === "identifier")
							namespaces.add(specifier.text());
						if (specifier.kind() !== "named_imports") continue;
						for (const item of specifier.children()) {
							if (item.kind() !== "import_specifier") continue;
							const imported =
								item.field("name")?.text() ?? item.children()[0]?.text();
							const identifiers = item
								.children()
								.filter((child) => child.kind() === "identifier");
							const alias = identifiers[identifiers.length - 1]?.text();
							if (
								(imported === "setTimeout" || imported === "setInterval") &&
								alias
							)
								local.add(alias);
						}
					}
				}
			}
		}
		if (node.kind() === "variable_declarator") {
			const name = node.field("name");
			const value = node.field("value");
			if (
				name?.kind() === "object_pattern" &&
				value?.kind() === "identifier" &&
				TIMER_GLOBALS.has(value.text())
			) {
				for (const property of name.children()) {
					if (property.kind() === "pair_pattern") {
						const imported = property.children()[0]?.text();
						const alias = property.field("value")?.text();
						if (
							(imported === "setTimeout" || imported === "setInterval") &&
							alias
						)
							local.add(alias);
					}
					if (
						property.kind() === "shorthand_property_identifier_pattern" &&
						(property.text() === "setTimeout" ||
							property.text() === "setInterval")
					)
						local.add(property.text());
				}
			}
			if (
				name?.kind() === "identifier" &&
				value?.kind() === "identifier" &&
				local.has(value.text())
			)
				local.add(name.text());
		}
		for (const child of node.children()) visit(child);
	};
	visit(syntax);
	return { local, namespaces };
}

/**
 * A declared `delay`/`sleep`-named binding — `export function delayInside(...)`,
 * `const delay = ...` (prefix-anchored, so `delayInside`/`delayMs` count: the
 * name is the vector, not the exact spelling). This is the shape #2563 exists
 * for: a shared wait primitive defined in `tests/support/` is the reuse path
 * that lets a raw-timer wait reach every importing test file, and its
 * definition stays visible even when the timer behind it is hidden — an
 * aliased `import { setTimeout as sleep }`, a re-export — where
 * {@link RAW_TIMER_CALL} sees nothing. Applied only to the support
 * population (see {@link isSupportHelperFile}).
 */
const DELAY_SLEEP_HELPER_DEFINITION =
	/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s*\*?\s*|const\s+|let\s+|var\s+)((?:delay|sleep)\w*)\b/;

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
 * A raw `setTimeout`/`setInterval` wait outside a `vi.useFakeTimers()` scope,
 * plus — in a non-test helper under `tests/support/` (#2563) — any
 * `delay`/`sleep` helper definition ({@link DELAY_SLEEP_HELPER_DEFINITION}).
 *
 * `interleaving-kit.ts` itself is exempt by name (#2547's sanctioned
 * primitive; it lives in `tests/clients/`, outside both populations, but the
 * exemption is stated here too so a caller that scans it directly — this
 * module's own self-test — gets the same answer).
 */
export function scanRawTimerWait(
	file: string,
	source: string,
	context?: ScanContext,
): FlakeHit[] {
	if (path.posix.basename(file) === "interleaving-kit.ts") return [];
	const scan = context ?? scanContext(source);
	const stripped = scan.stripped;
	const lines = stripped.split("\n");
	const stateAtLine = fakeTimersStateAtLine(lines);
	const supportHelper = isSupportHelperFile(file);
	const bindings = needsTimerAst(scan)
		? timerBindings(source, syntaxRoot(scan))
		: { local: new Set<string>(), namespaces: new Set<string>() };

	const hits: FlakeHit[] = [];
	lines.forEach((lineText, idx) => {
		const m = RAW_TIMER_CALL.exec(lineText);
		if (m && !stateAtLine[idx]) {
			hits.push({
				line: idx + 1,
				text: lineText.trim(),
				reason: `raw ${m[1]}( outside vi.useFakeTimers()`,
			});
		}
		// A delay/sleep definition is the vector regardless of this file's own
		// fake-timer state: the helper is CALLED from other files whose timer
		// scope is not this file's.
		if (supportHelper && DELAY_SLEEP_HELPER_DEFINITION.test(lineText)) {
			hits.push({
				line: idx + 1,
				text: lineText.trim(),
				reason: "delay/sleep helper definition in tests/support (#2563)",
			});
		}
	});
	if (!needsTimerAst(scan)) return hits;
	const root = syntaxRoot(scan);
	const visit = (node: SgNode): void => {
		if (node.kind() === "call_expression") {
			const fn = node.field("function");
			const isLocal =
				fn?.kind() === "identifier" &&
				bindings.local.has(fn.text()) &&
				!new Set(["setTimeout", "setInterval"]).has(fn.text());
			const isNamespace =
				fn?.kind() === "member_expression" &&
				bindings.namespaces.has(fn.field("object")?.text() ?? "") &&
				["setTimeout", "setInterval"].includes(
					fn.field("property")?.text() ?? "",
				);
			const line = node.range().start.line;
			if ((isLocal || isNamespace) && !stateAtLine[line]) {
				if (!hits.some((hit) => hit.line === line))
					hits.push({
						line: line + 1,
						text: lines[line]?.trim() ?? "",
						reason: "aliased raw timer call outside vi.useFakeTimers()",
					});
			}
		}
		for (const child of node.children()) visit(child);
	};
	visit(root);
	hits.sort((a, b) => a.line - b.line);
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
	_context?: ScanContext,
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
	(file: string, source: string, context?: ScanContext) => FlakeHit[]
> = {
	"real-process-spawn": scanRealProcessSpawn,
	"elapsed-time-assertion": scanElapsedTimeAssertion,
	"raw-timer-wait": scanRawTimerWait,
	"ungoverned-wait-for": scanUngovernedWaitFor,
};

/**
 * Detectors run over the #2563 support population (non-test
 * `tests/support/**\/*.ts` helpers): the time shapes only. The spawn detector
 * (1) stays test-file-only on purpose — `tests/support/` helpers ARE the
 * sanctioned route to real child processes (`git-fixture-env.ts`,
 * `fake-child.ts`, `spawn-shapes.ts` all import `node:child_process` by
 * design), so scanning them would demand admission headers for the fixture
 * boundary itself; what #2563 governs is TIME primitives defined for reuse.
 */
const SUPPORT_POPULATION_DETECTORS: readonly DetectorName[] = [
	"elapsed-time-assertion",
	"raw-timer-wait",
	"ungoverned-wait-for",
];

let countsCache: Record<DetectorName, Record<string, number>> | undefined;

/**
 * file → hit count, for every `tests/**\/*.test.ts` file and every non-test
 * `tests/support/**\/*.ts` helper (#2563) the detector flags.
 */
export function countsByDetector(
	detector: DetectorName,
): Record<string, number> {
	if (countsCache === undefined) {
		const counts = Object.fromEntries(
			DETECTOR_NAMES.map((name) => [name, {}]),
		) as Record<DetectorName, Record<string, number>>;
		const scanFile = (
			absolute: string,
			detectors: readonly DetectorName[],
		): void => {
			const file = testsRelative(absolute);
			if (SCAN_INFRASTRUCTURE.has(file)) return;
			const source = fs.readFileSync(absolute, "utf8");
			const context = scanContext(source);
			for (const name of detectors) {
				const hits = DETECTORS[name](file, source, context);
				if (hits.length > 0) counts[name][file] = hits.length;
			}
		};
		for (const absolute of testSourceFiles()) {
			scanFile(absolute, DETECTOR_NAMES);
		}
		// #2563: the support population — non-test helpers under tests/support/.
		for (const absolute of supportHelperFiles()) {
			scanFile(absolute, SUPPORT_POPULATION_DETECTORS);
		}
		countsCache = counts;
	}
	return countsCache[detector];
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
