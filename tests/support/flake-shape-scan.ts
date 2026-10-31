/**
 * Detectors for the flake-shape ratchet — #2547.
 *
 * Three deflake PRs in two days (#2531 alone fixed three shared-slot races)
 * and nothing counted the contention surface, so the set only grew. This
 * module owns the seven detectors the ratchet (`tests/clients/flake-shape-
 * ratchet.test.ts`) runs over `tests/**\/*.test.ts` and — since #2563 — over
 * every non-test helper under `tests/support/**\/*.ts` (the time detectors
 * only; the spawn detector stays test-file-only, see
 * {@link SUPPORT_POPULATION_DETECTORS}):
 *
 * 1. {@link scanRealProcessSpawn} — a real child process: a `child_process`
 *    import, a call-shaped `execFileSync`/`spawnSync`/`execSync`, a spawn-helper
 *    call (a support helper, or the `collectUntrackedIgnoredIds` production
 *    seam), or a spawn whose argv mentions `vitest` (a test file
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
 * 5. {@link scanNeverSettlingWait} — a never-settling promise (#2885).
 * 6. {@link scanInProcessMock} — a `vi.mock`/`vi.doMock` of a module outside
 *    {@link PROCESS_BOUNDARY_MODULES} (#4362), test files only.
 * 7. {@link scanServiceDouble} — a hand-rolled double of a
 *    {@link SERVICE_SURFACES} service (#4362), test files only.
 *
 * Detectors 6 and 7 pin identity: each hit names its module or service, and
 * the ratchet keys it `<file>::<identity>` ({@link hitKey}).
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
 * - Detector 1's real-module read (#5064) reads an `importActual` call by its
 *   name and its first argument. A bound copy of the function (`const load =
 *   vi.importActual; load(...)`), a `require` of child_process, and a zero-
 *   argument passthrough in a mock factory (`importOriginal()`) are not read.
 *   No such call exists in the tree today (grep); a binding-following read is
 *   the follow-up if one appears.
 * - Detector 1 recognizes known spawn-helper names at their test call sites —
 *   the support-module helpers plus the one production seam that wraps the
 *   child, `collectUntrackedIgnoredIds` (#4598) — and ignores calls whose
 *   helper module is mocked in that file. It still cannot resolve arbitrary
 *   aliases, so aliases remain conservative false positives. Quoted and
 *   commented helper names are excluded by `codeMatches`.
 * - Detector 6 reads the callee through `isViMockCall`: `vi` or `vitest`
 *   written directly (parentheses and casts allowed). A callee reached
 *   through a value (an alias, a destructure, a helper's parameter) is not
 *   seen here (none in the tree today); the project-trust seam ratchet keys
 *   on the mocked specifier instead, so it counts those (#4429 round 3).
 *   `vi.spyOn` on a module namespace and `vi.mock` in `tests/support/` (the
 *   global setup mocks two modules) are out of scope.
 * - Detector 7 reads one object literal at a time. A double split across
 *   literals (`const s = { ...a, getStatus }` where `a` holds the other
 *   members), built with `Object.assign`, written as a class
 *   (`class FakeService implements LSPService`), assembled by a helper in
 *   another module, or patched in later (`s.touchFile = vi.fn()`, which
 *   `lsp-double-gate.ts` owns) is not seen (#4383 review F2).
 * - Detector 7 needs one shared member whose value is a function or a call
 *   result, so an all-identifier double (`{ touchFile: mockTouch, hasLSP:
 *   mockHas, getStatus: mockStatus }`) is not seen (#4383 review F3). None
 *   exists today: dropping the rule adds only capability data records.
 * - Detector 7 covers the two #4344 G5 surfaces only (`SERVICE_SURFACES`).
 *   Hand-rolled doubles of other in-process services (the siblings of
 *   `makeRunnerCtx` and `makeRealRunnerEnv`) are unmeasured; widening is one
 *   registry row plus its baseline rows.
 * All of these are false negatives, the safe direction for a ratchet.
 */

import * as fs from "node:fs";
import { builtinModules } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Lang, parse } from "@ast-grep/napi";

import { bareIdentifier } from "./lsp-double-gate.js";
import { unwrapParens } from "./spawn-cwd-scan.js";
import { isViMockCall, mockSpecifier, unquote } from "./vi-mock-export-gate.js";
import {
	createCallSiteScanner,
	codeMatches,
	firstCommentMatch,
	listSourceFiles,
	readWalkedFile,
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
 * — the ratchet's test file, this module's unit-test fixtures, and the
 * spawn-cwd fixture's synthetic child-process strings carry
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
	/**
	 * What the hit is, when the baseline must pin identity and not only a
	 * count (#4362): the mocked module, or the doubled service. The ratchet
	 * then keys the hit as `<file>::<identity>`.
	 */
	identity?: string;
}

export const DETECTOR_NAMES = [
	"real-process-spawn",
	"elapsed-time-assertion",
	"raw-timer-wait",
	"ungoverned-wait-for",
	"never-settling-wait",
	"in-process-mock",
	"service-double",
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
// #5064: a same-file `vi.mock`/`vi.doMock` of child_process hides the import
// and the triad above, but `vi.importActual("node:child_process")` returns the
// REAL module behind that mock, so the spawns started through it are real.
const CHILD_PROCESS_SPECIFIER = /^(?:node:)?child_process$/;
const FIRST_STRING_ARGUMENT = /^(["'`])([^"'`]*)\1/;
const IMPORT_ACTUAL_CALL = /\bimportActual\b\s*(?:<[^;]*?>)?\s*\(/g;
// These helpers are the test-side routes to real child processes. Keep this
// list beside the support-module census: matching the CALL in a test catches
// a helper that hides `node:child_process` behind another module boundary.
// `collectUntrackedIgnoredIds` (#4598) is one such boundary: the census reads
// it as a production seam, and its call site spawns the real `git ls-files`
// child that decides which fixture inputs survive a fresh checkout.
const SUPPORT_SPAWN_HELPER_CALL =
	/\b(gitFixtureSpawnAsync|gitExecFileSync|gitExecSync|execFileSync|execSync|spawnWedgedChild|safeSpawnAsync|collectUntrackedIgnoredIds|withRealPi|installPathProbeStub)\s*\(/g;
const MOCK_CALL = /\bvi\.(?:mock|doMock|hoisted)\s*\(\s*["']([^"']+)["']/g;
const HELPER_MODULE_SUFFIXES: Record<string, readonly string[]> = {
	gitFixtureSpawnAsync: ["/git-fixture-env", "/git-fixture-env.js"],
	gitExecFileSync: ["/git-fixture-env", "/git-fixture-env.js"],
	gitExecSync: ["/git-fixture-env", "/git-fixture-env.js"],
	spawnWedgedChild: ["/fault-injection", "/fault-injection.ts"],
	safeSpawnAsync: ["/safe-spawn", "/safe-spawn.js"],
	collectUntrackedIgnoredIds: ["/git-tracked-ignore", "/git-tracked-ignore.js"],
	withRealPi: [
		"/real-pi-harness",
		"/real-pi-harness.js",
		"/real-pi-harness.ts",
	],
	// The stub spawns nothing itself: it puts executable stand-ins first on PATH
	// so the production package-manager lookup spawns them for real (#4709).
	installPathProbeStub: [
		"/path-probe-stub",
		"/path-probe-stub.js",
		"/path-probe-stub.ts",
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
 * An `importActual` call (any receiver, optional type arguments) that reads
 * the real child_process module (#5064): its first argument names
 * child_process, or is not a string literal (an unknown specifier is refused,
 * not passed). A literal naming another module, or no argument, is not read.
 * Lexical rather than AST, because tree-sitter parses the type arguments of
 * `importActual<typeof import("…")>(…)` as an expression, so the call is no
 * call_expression there.
 */
function importActualReadsChildProcess(
	source: string,
	match: RegExpMatchArray,
): boolean {
	const rest = source.slice((match.index ?? 0) + match[0].length).trimStart();
	if (rest.startsWith(")")) return false;
	const specifier = FIRST_STRING_ARGUMENT.exec(rest)?.[2];
	return specifier === undefined || CHILD_PROCESS_SPECIFIER.test(specifier);
}

/**
 * A real child process: a `child_process` import, a call-shaped
 * `execFileSync`/`spawnSync`/`execSync`, ANY spawn flavor whose argv
 * mentions `vitest` — a test file re-launching the suite inside itself —
 * or a `vi.importActual` of `child_process` behind a same-file mock (#5064):
 * the mock hides the first three forms only, so this one is read even in a
 * mocking file.
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

	if (/child_process/.test(stripped)) {
		for (const match of codeMatches(source, IMPORT_ACTUAL_CALL)) {
			if (!importActualReadsChildProcess(source, match)) continue;
			const lineIdx = source.slice(0, match.index ?? 0).split("\n").length - 1;
			if (hits.has(lineIdx)) continue;
			hits.set(lineIdx, {
				line: lineIdx + 1,
				text: (lines[lineIdx] ?? "").trim(),
				reason: "importActual( reaches the real child_process module",
			});
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

// ── 5. Never-settling promise ───────────────────────────────────────────────

/**
 * A `new Promise(...)` whose executor body is empty, outside a
 * `vi.useFakeTimers()` scope (#2885). Such a promise can never settle, so
 * anything that awaits it ends only when a REAL timer fires somewhere: a
 * production helper's budget (`withTimeout`, `withBudget`, `withDeadline` in
 * clients/deadline-utils.ts), a harness deadline, or the test's own timeout.
 * Detector 3 reads timer calls in test and support source only, so a wait
 * whose `setTimeout` lives in production code was invisible: #2866's
 * `fails a session_start handler that never settles` waited a real 5 000 ms
 * through `pi-mock.ts`'s `withTimeout` with the ratchet green. This matches
 * the hang itself rather than a list of helper names, so a new wrapper
 * around a timer is covered the day it lands.
 *
 * Only an EMPTY executor body (or a bare `undefined` expression body) counts:
 * one that stores `resolve` for later can settle. A never-settling promise
 * that nothing awaits still counts; it is a hang double either way, and an
 * admitted baseline entry costs one line.
 */
// `new Promise(() => {})`, `new Promise<never>((_resolve) => {})`,
// `new Promise(function () {})`, `new Promise(() => undefined)`: an executor
// with an empty body. Matched over comment- and string-stripped source, so a
// shape named in prose never counts; a regex, not an AST walk, because this
// scan runs over every test file inside the ratchet's 30 s budget.
const NEVER_SETTLING_PROMISE =
	/\bnew\s+Promise\s*(?:<[^()]*?>)?\s*\(\s*(?:(?:async\s*)?(?:\([^()]*\)|[A-Za-z_$][\w$]*)\s*=>\s*(?:\{\s*\}|undefined\b)|function\s*\w*\s*\([^()]*\)\s*\{\s*\})\s*\)/g;

export function scanNeverSettlingWait(
	_file: string,
	source: string,
	context?: ScanContext,
): FlakeHit[] {
	const stripped = (context ?? scanContext(source)).stripped;
	const lines = stripped.split("\n");
	const stateAtLine = fakeTimersStateAtLine(lines);
	const hits: FlakeHit[] = [];
	for (const match of stripped.matchAll(NEVER_SETTLING_PROMISE)) {
		const line = stripped.slice(0, match.index).split("\n").length - 1;
		if (stateAtLine[line]) continue;
		hits.push({
			line: line + 1,
			text: lines[line]?.trim() ?? "",
			reason: "never-settling promise outside vi.useFakeTimers()",
		});
	}
	return hits;
}

// ── 6. In-process module mock (#4362) ───────────────────────────────────────

/**
 * Modules a test may `vi.mock` without an admission: the process and host
 * boundaries (AGENTS.md "Test requirements": mock only external binaries,
 * network, host SDK seams and clocks). Keys are {@link mockTarget}'s
 * normalized form. Every other target is an in-process module, and a new one
 * needs a `// flake-shape: in-process-mock — <reason>` admission.
 */
export const PROCESS_BOUNDARY_MODULES: Readonly<Record<string, string>> = {
	"@earendil-works/pi-coding-agent":
		"the pi host SDK: the extension's host boundary, not pi-lens code",
	"clients/safe-spawn":
		"pi-lens's single child-process seam; a mock stands in for the spawned binary",
	"node:child_process": "spawns a real child process",
	"node:fs": "the host filesystem API",
	"node:fs/promises": "the host filesystem API",
	"node:https": "the network: installer downloads and release lookups",
	"node:os": "host facts (home directory, platform, CPU count) from the OS",
	"node:perf_hooks":
		"the host runtime's clock and event-loop monitor (the Bun-compat case)",
	pidusage: "reads the OS process table for another process's resource usage",
};

/** Placeholder target for a specifier the AST cannot read as a literal. */
export const NON_LITERAL_MOCK_TARGET = "<non-literal>";

/**
 * One spelling-free name per mocked module: a `node:` builtin keeps its
 * prefix (a bare `fs` gains it), a relative specifier resolves against the
 * test file to a repo-relative posix path with no script extension, and a
 * package name stays as written. `file` is the `tests/`-relative key the
 * ratchet scans under, so `../../clients/x.js` from `tests/clients/a/`,
 * `../clients/x.ts` and `../clients/x` from `tests/` all name `clients/x`
 * (the same identity rule as `tests/config/project-trust-seam-ratchet.test.ts`).
 */
export function mockTarget(file: string, specifier: string): string {
	if (specifier.startsWith("node:")) return specifier;
	if (builtinModules.includes(specifier)) return `node:${specifier}`;
	if (specifier.startsWith(".")) {
		const absolute = path.resolve(
			path.dirname(path.join(TESTS_ROOT, file)),
			specifier,
		);
		return relativePosix(repoRoot, absolute).replace(/\.[cm]?[jt]s$/, "");
	}
	return specifier;
}

// `vi.mock`, `vi.doMock`, `vi["mock"]`: every spelling keeps `vi` followed by
// `.` or `[` once comments and strings are blanked, so this lexical check only
// skips the parse for a file with no `vi` member access at all.
const MOCK_AST_TRIGGER = /\bvi\s*[.[]/;

/**
 * One hit per distinct in-process module a test file mocks with `vi.mock` or
 * `vi.doMock` (#4362), with the module as the hit's identity, so the
 * baseline pins WHICH modules each file mocks, not only how many: swapping
 * one mocked module for another is a new entry, not a free pass (shape 36).
 *
 * Calls are read from the TypeScript AST (`isViMockCall`, the structural
 * check the vi.mock export gate owns), so a comment or string quoting
 * `vi.mock(` is not a call and never counts or excuses.
 */
export function scanInProcessMock(
	file: string,
	source: string,
	context?: ScanContext,
): FlakeHit[] {
	const scan = context ?? scanContext(source);
	if (!MOCK_AST_TRIGGER.test(scan.stripped)) return [];
	const lines = source.split("\n");
	const hits = new Map<string, FlakeHit>();
	for (const call of syntaxRoot(scan).findAll({
		rule: { kind: "call_expression" },
	})) {
		if (!isViMockCall(call.field("function"), ["mock", "doMock"])) continue;
		const specifier = mockSpecifier(
			call.field("arguments")?.namedChildren()[0],
		);
		const target =
			specifier === undefined
				? NON_LITERAL_MOCK_TARGET
				: mockTarget(file, specifier);
		if (Object.hasOwn(PROCESS_BOUNDARY_MODULES, target)) continue;
		if (hits.has(target)) continue;
		const line = call.range().start.line;
		hits.set(target, {
			line: line + 1,
			text: lines[line]?.trim() ?? "",
			reason: `in-process vi.mock of ${target}`,
			identity: target,
		});
	}
	return [...hits.values()].sort((a, b) => a.line - b.line);
}

// ── 7. Hand-rolled service double (#4362) ───────────────────────────────────

/**
 * An in-process service whose hand-rolled doubles the ratchet counts. The
 * member vocabulary is read from the production declaration, never copied,
 * so a method added to the service widens the detector in the same commit.
 * `factories` are the shared double factories: an object passed to one, or
 * spreading one's result, is seeded from it and is not hand-rolled.
 * `argumentOnlyFactories` are the entry points whose ARGUMENT is a factory's
 * overrides but whose RESULT is not a double (an async installer resolves a
 * `Promise`), so only the argument spelling is seeded (#4720 review F3).
 *
 * #4344 round 3 (G5) is the recurrence: one method added to `LSPClientInfo`
 * and `LSPService` had to be added by hand to doubles in 40 test files (34
 * client, 6 service).
 */
export interface ServiceSurface {
	name: string;
	/** Repo-relative production file that declares `name`. */
	file: string;
	/**
	 * Factories that seed in BOTH directions: the object literal is their
	 * argument, or it spreads their result.
	 */
	factories: readonly string[];
	/**
	 * Factories that seed as an ARGUMENT only. Their result is not a double, so
	 * a spread of it seeds nothing; absent means none.
	 */
	argumentOnlyFactories?: readonly string[];
}

export const SERVICE_SURFACES: readonly ServiceSurface[] = [
	{ name: "LSPClientInfo", file: "clients/lsp/client.ts", factories: [] },
	{
		name: "LSPService",
		file: "clients/lsp/index.ts",
		// `makeLspServiceDouble` is synchronous and returns the double, so an
		// overrides object passed to it, or a spread of its result, is seeded
		// exactly like one passed to the factory itself.
		factories: ["makeLspServiceDouble"],
		// `tests/support/lsp-service-seam.ts` (#4709) is the installer: it hands
		// its argument straight to `makeLspServiceDouble` and installs the
		// result, so an overrides object passed to it is factory-seeded. It is
		// ASYNC, so `{ ...installLspServiceDouble(), … }` spreads a Promise and
		// seeds nothing: that spelling stays a hand-rolled double (#4720 F3).
		// `installLspService` is NOT registered: it takes a finished double, so
		// an object literal handed to it is a hand-rolled double and must keep
		// being counted.
		argumentOnlyFactories: ["installLspServiceDouble"],
	},
];

/**
 * Shared member names an object needs before it reads as a double of a
 * surface. Measured on the 2026-10-14 tree: at 3 every hit is an LSP client
 * or service stand-in; at 2 diagnostic rows (`serverId`, `root`) and unrelated
 * records join.
 */
export const SERVICE_DOUBLE_MIN_MEMBERS = 3;

const surfaceMemberCache = new Map<string, ReadonlySet<string>>();

// The tree-sitter TypeScript grammar cannot parse an inline type import
// (`Promise<import("./client.js").LSPDiagnostic[]>`): its error recovery
// closed `LSPService` 2,300 lines early and dropped `hasLSP` and `getStatus`.
// Blanking the `import("…").` prefix to spaces leaves the type name, keeps
// every offset, and parses both surfaces with no ERROR node.
const INLINE_TYPE_IMPORT = /\bimport\(\s*(["'])[^"'\n]*\1\s*\)\./g;

/**
 * The public instance members `name` declares in `source`: a class's
 * methods, accessors and fields minus `constructor`, `static`, `private`,
 * `protected` and `#private`; an interface's properties and method
 * signatures. Throws when the declaration is missing or does not parse
 * cleanly, so a renamed surface or a grammar gap reds instead of silently
 * matching fewer members. `where` names the source in those errors.
 */
export function declaredMembers(
	source: string,
	name: string,
	where: string,
): Set<string> {
	const blanked = source.replace(INLINE_TYPE_IMPORT, (match) =>
		" ".repeat(match.length),
	);
	const declaration = parse(Lang.TypeScript, blanked)
		.root()
		.findAll({
			rule: {
				any: [{ kind: "class_declaration" }, { kind: "interface_declaration" }],
			},
		})
		.find((node) => node.field("name")?.text() === name);
	const body = declaration?.field("body");
	if (!declaration || !body) {
		throw new Error(`service surface ${name} is not declared in ${where}`);
	}
	const broken = declaration.find({ rule: { kind: "ERROR" } });
	if (broken) {
		throw new Error(
			`service surface ${name} does not parse cleanly at ` +
				`${where}:${broken.range().start.line + 1}; its member list would be partial. ` +
				"Find the construct on that line the tree-sitter grammar cannot read: " +
				"if it is a type form like the inline type import, blank it the way " +
				"INLINE_TYPE_IMPORT does (same length, offsets kept); otherwise restate " +
				"it in the production file (a named type alias usually parses).",
		);
	}
	const members = new Set<string>();
	for (const member of body.children()) {
		if (
			![
				"method_definition",
				"public_field_definition",
				"property_signature",
				"method_signature",
			].includes(String(member.kind()))
		)
			continue;
		const hidden = member
			.children()
			.some(
				(child) =>
					child.kind() === "static" ||
					(child.kind() === "accessibility_modifier" &&
						child.text() !== "public"),
			);
		const memberName = member.field("name");
		if (hidden || memberName?.kind() !== "property_identifier") continue;
		if (memberName.text() !== "constructor") members.add(memberName.text());
	}
	return members;
}

/** {@link declaredMembers} for a registered surface, read once per run. */
export function surfaceMembers(surface: ServiceSurface): ReadonlySet<string> {
	const cacheKey = `${surface.file}#${surface.name}`;
	let members = surfaceMemberCache.get(cacheKey);
	if (!members) {
		members = declaredMembers(
			fs.readFileSync(path.join(repoRoot, surface.file), "utf8"),
			surface.name,
			surface.file,
		);
		surfaceMemberCache.set(cacheKey, members);
	}
	return members;
}

// A value that is code to call: a method, a function, or a call result such
// as `vi.fn()` or `vi.fn().mockResolvedValue(x)`. A shorthand or identifier
// value is unknown and a literal is data.
const CALLABLE_VALUE_KINDS = new Set([
	"arrow_function",
	"function_expression",
	"call_expression",
]);

/**
 * Own keys of an object literal (pairs, shorthands and methods), each with
 * whether its value is callable. A double is called by the code under test;
 * an object whose shared keys all hold data (`toMatchObject({ hover: true })`)
 * is a record that happens to reuse the names.
 */
function objectKeys(object: SgNode): Map<string, boolean> {
	const keys = new Map<string, boolean>();
	for (const child of object.children()) {
		const kind = child.kind();
		if (kind === "shorthand_property_identifier") keys.set(child.text(), false);
		if (kind !== "pair" && kind !== "method_definition") continue;
		const key = child.field(kind === "pair" ? "key" : "name");
		const name =
			key?.kind() === "property_identifier"
				? key.text()
				: key?.kind() === "string"
					? unquote(key.text())
					: undefined;
		if (name === undefined) continue;
		const value = kind === "pair" ? child.field("value") : undefined;
		keys.set(
			name,
			kind === "method_definition" ||
				(value !== null &&
					value !== undefined &&
					CALLABLE_VALUE_KINDS.has(String(unwrapParens(value).kind()))),
		);
	}
	return keys;
}

function calledName(call: SgNode | null | undefined): string | undefined {
	if (call?.kind() !== "call_expression") return undefined;
	return bareIdentifier(call.field("function") as SgNode);
}

/**
 * The object is an argument of an admitted seeding call, or it spreads the
 * result of a factory whose result is itself a double. Every other spelling is
 * refused: the admitted set is the two `ServiceSurface` lists above, so a name
 * reached through any other form is counted, never skipped.
 */
function factorySeeded(
	object: SgNode,
	factories: ReadonlySet<string>,
	argumentOnlyFactories: ReadonlySet<string>,
): boolean {
	if (factories.size === 0 && argumentOnlyFactories.size === 0) return false;
	const parent = object.parent();
	if (parent?.kind() === "arguments") {
		const name = calledName(parent.parent());
		if (
			name !== undefined &&
			(factories.has(name) || argumentOnlyFactories.has(name))
		)
			return true;
	}
	if (factories.size === 0) return false;
	return object.children().some((child) => {
		if (child.kind() !== "spread_element") return false;
		// A spread admits `factories` only: an argument-only entry point's result
		// is not a double (it is a Promise), so spreading it seeds nothing.
		const name = calledName(unwrapParens(child.namedChildren()[0] as SgNode));
		return name !== undefined && factories.has(name);
	});
}

/**
 * One hit per object literal that carries at least
 * {@link SERVICE_DOUBLE_MIN_MEMBERS} members of one {@link SERVICE_SURFACES}
 * entry, at least one of them callable-valued, and is not seeded from a
 * registered factory (#4362). A factory's overrides are seeded whichever
 * surface their keys resemble: `makeLspServiceDouble({ getDiagnostics, … })`
 * shares names with `LSPClientInfo` too. The hit's identity is the surface,
 * so the baseline pins how many hand-rolled doubles of each service a file
 * holds. An object matching two surfaces counts once, for the one it shares
 * more members with (registry order breaks a tie).
 */
export function scanServiceDouble(
	_file: string,
	source: string,
	context?: ScanContext,
): FlakeHit[] {
	const scan = context ?? scanContext(source);
	const vocabularies = SERVICE_SURFACES.map((surface) => ({
		surface,
		members: surfaceMembers(surface),
	}));
	const factories = new Set(
		SERVICE_SURFACES.flatMap((surface) => surface.factories),
	);
	const argumentOnlyFactories = new Set(
		SERVICE_SURFACES.flatMap((surface) => surface.argumentOnlyFactories ?? []),
	);
	// Lexical pre-check over comment-blanked text (quoted keys are real keys,
	// so strings stay): skip the parse unless some surface could reach the
	// threshold at all.
	const words = new Set(
		stripSource(source, { strings: "keep" }).match(/[A-Za-z_$][\w$]*/g) ?? [],
	);
	const reachable = vocabularies.filter(
		({ members }) =>
			[...members].filter((member) => words.has(member)).length >=
			SERVICE_DOUBLE_MIN_MEMBERS,
	);
	if (reachable.length === 0) return [];
	const lines = source.split("\n");
	const hits: FlakeHit[] = [];
	for (const object of syntaxRoot(scan).findAll({ rule: { kind: "object" } })) {
		const keys = objectKeys(object);
		if (keys.size < SERVICE_DOUBLE_MIN_MEMBERS) continue;
		if (factorySeeded(object, factories, argumentOnlyFactories)) continue;
		let best: { name: string; shared: number } | undefined;
		for (const { surface, members } of reachable) {
			const shared = [...keys].filter(([key]) => members.has(key));
			if (shared.length < SERVICE_DOUBLE_MIN_MEMBERS) continue;
			if (!shared.some(([, callable]) => callable)) continue;
			if (!best || shared.length > best.shared)
				best = { name: surface.name, shared: shared.length };
		}
		if (!best) continue;
		const line = object.range().start.line;
		hits.push({
			line: line + 1,
			text: lines[line]?.trim() ?? "",
			reason: `hand-rolled ${best.name} double (${best.shared} members)`,
			identity: best.name,
		});
	}
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
	"never-settling-wait": scanNeverSettlingWait,
	"in-process-mock": scanInProcessMock,
	"service-double": scanServiceDouble,
};

/**
 * The mock detectors (#4362). They need no serialized lane (a mock adds no
 * contention), so their admission is the header and the
 * `ADMITTED_AFTER_BASELINE` entry alone, and they scan `.test.ts` files only.
 */
export const MOCK_DETECTORS: ReadonlySet<DetectorName> = new Set([
	"in-process-mock",
	"service-double",
]);

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
	"never-settling-wait",
];

/** Separates a file from a hit's identity in a ratchet key (#4362). */
export const IDENTITY_SEPARATOR = "::";

/**
 * The ratchet key one hit counts under: the file, or `<file>::<identity>`
 * when the detector pins identity (#4362).
 */
export function hitKey(file: string, hit: FlakeHit): string {
	return hit.identity === undefined
		? file
		: `${file}${IDENTITY_SEPARATOR}${hit.identity}`;
}

let countsPromise:
	| Promise<Record<DetectorName, Record<string, number>>>
	| undefined;

/**
 * One macrotask turn. `@ast-grep/napi` releases a dropped tree's native
 * memory from a finalizer that only runs once the event loop turns, so a
 * synchronous pass over the ~1,400-file population holds every transient
 * tree it parsed until the case ends (#3565; the same `setImmediate` turn
 * `vi-mock-export-sweep.test.ts` and `project-trust-seam-ratchet.test.ts`
 * already take). #4292 grew the population past the per-worker budget and
 * this file peaked at 2,049 MB against 2,048 MB; one turn per file brings
 * it back under the budget with byte-identical counts.
 */
function yieldToNapiFinalizer(): Promise<void> {
	return new Promise<void>((resolve) => setImmediate(resolve));
}

async function buildCounts(): Promise<
	Record<DetectorName, Record<string, number>>
> {
	const counts = Object.fromEntries(
		DETECTOR_NAMES.map((name) => [name, {}]),
	) as Record<DetectorName, Record<string, number>>;
	const scanFile = (
		absolute: string,
		detectors: readonly DetectorName[],
	): void => {
		const file = testsRelative(absolute);
		if (SCAN_INFRASTRUCTURE.has(file)) return;
		// readWalkedFile: a path that vanished between the walk and the read
		// is out of the population, not a finding (#3082).
		const source = readWalkedFile(absolute);
		if (source === undefined) return;
		const context = scanContext(source);
		for (const name of detectors) {
			for (const hit of DETECTORS[name](file, source, context)) {
				const key = hitKey(file, hit);
				counts[name][key] = (counts[name][key] ?? 0) + 1;
			}
		}
	};
	for (const absolute of testSourceFiles()) {
		scanFile(absolute, DETECTOR_NAMES);
		await yieldToNapiFinalizer();
	}
	// #2563: the support population — non-test helpers under tests/support/.
	for (const absolute of supportHelperFiles()) {
		scanFile(absolute, SUPPORT_POPULATION_DETECTORS);
		await yieldToNapiFinalizer();
	}
	return counts;
}

/**
 * file → hit count, for every `tests/**\/*.test.ts` file and every non-test
 * `tests/support/**\/*.ts` helper (#2563) the detector flags.
 *
 * Async so the per-file event-loop turn ({@link yieldToNapiFinalizer}) can
 * release each parsed tree's native memory while the population is walked;
 * the counts are unchanged, only the peak RSS. The first call builds the
 * shared promise, every later call awaits it.
 */
export async function countsByDetector(
	detector: DetectorName,
): Promise<Record<string, number>> {
	countsPromise ??= buildCounts();
	return (await countsPromise)[detector];
}

// ── Admission gate ──────────────────────────────────────────────────────────

function admissionHeaderPattern(detector = "[\\w-]+"): RegExp {
	return new RegExp(
		`^[ \\t]*\\/\\/[ \\t]*flake-shape:[ \\t]*(${detector})[ \\t]*—[ \\t]*(.+)$`,
		"gm",
	);
}

export interface AdmissionHeader {
	detector: string;
	reason: string;
}

/**
 * The file's `// flake-shape: <detector> — <reason>` header, if present.
 * Admission of a NEW ratchet entry (a file not in the frozen baseline, or an
 * allowlisted file whose count rose) requires this header naming which
 * detector the entry is admitted under and why a mock is not faithful, AND,
 * for a timing or spawn detector, the file's membership in
 * `vitest.config.ts`'s `wallClockBudgetInclude` project (so it runs in the
 * fully serialized lane) — see `ADMITTED_AFTER_BASELINE` in
 * `tests/clients/flake-shape-ratchet.test.ts`.
 *
 * With `detector`, returns the first header naming that detector, so a file
 * admitted under two detectors (a real spawn and an in-process mock) carries
 * one header for each (#4362). Without it, returns the file's first header.
 */
export function admissionHeader(
	source: string,
	detector?: DetectorName,
): AdmissionHeader | undefined {
	const match = firstCommentMatch(source, admissionHeaderPattern(detector));
	return match ? { detector: match[1], reason: match[2].trim() } : undefined;
}
