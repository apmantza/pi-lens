/**
 * Two mechanical scans over `clients/` that back the session-state lifecycle
 * registry — #1635 item 2.
 *
 * 1. {@link sessionStartResetNames} DERIVES the set of reset functions
 *    `handleSessionStart` actually reaches. The registry then asserts against
 *    that set instead of a hand-copied list, so a reset that is written but
 *    never called — the #1266/#1490/#1497/#1535/#1537/#1625 defect shape, eight
 *    bugs in one arc — cannot be declared "wired" on faith.
 * 2. {@link scanSessionStateCandidates} finds the source files that LOOK like
 *    they own session-scoped state, so the registry can be checked for
 *    coverage. See {@link SWEEP_HEURISTIC_LIMITS} for what this can and cannot
 *    see; the boundary is documented rather than papered over.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	escapeRegExp,
	listSourceFiles,
	relativePosix,
	stripSource,
} from "./sweep-kit.js";

export const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

const CLIENTS_ROOT = path.join(repoRoot, "clients");

/** Every `.ts` file under `clients/`, minus declarations and tests. */
export function clientSourceFiles(dir = CLIENTS_ROOT): string[] {
	return listSourceFiles(dir, { extensions: [".ts"], skipTests: true });
}

/** `clients/`-relative posix path for an absolute source path. */
export function clientsRelative(absolute: string): string {
	return relativePosix(CLIENTS_ROOT, absolute);
}

// ── 1. What session_start actually resets ────────────────────────────────────

/**
 * Blank out every comment body and string literal, preserving length and line
 * breaks so positions and line numbers still line up with the original.
 *
 * Now a thin alias over the sweep kit's single stripper (#1755) — the kit owns
 * the lexer, the regex-position rule and the recovery guards, and every sweep
 * in the repo shares one implementation instead of seven. Kept as a named
 * export because `host-event-shape-scan.ts` and the finding-delivery gate
 * import it, and because this name states which POLICY the session-state walk
 * needs: string contents BLANKED, so a reset named inside a string is not read
 * as a call.
 *
 * This is load-bearing, not tidiness. Review round R1 reinstated #1535's bug
 * by REPLACING the real `resetZizmorTokenAvailability()` call with a comment
 * that merely names it, and the conformance suite stayed green, because the
 * reachability walk regexed raw source. `runtime-session.ts`'s reset block is
 * mostly `#issue`-narrative comments that name resets by hand, so that
 * false-negative mode was armed on real source, not hypothetical.
 */
export function stripCommentsAndStrings(source: string): string {
	return stripSource(source, { strings: "blank" });
}

/**
 * Extract a named function's body by brace matching from its `{`.
 *
 * `source` must already be {@link stripCommentsAndStrings}-processed, so the
 * brace counter cannot be thrown by a brace inside a comment or string and the
 * call extraction cannot be fooled by a comment naming a call.
 */
function functionBody(source: string, name: string): string | undefined {
	const declaration = new RegExp(
		`\\bfunction\\s+${name}\\s*(?:<[^>]*>)?\\s*\\(`,
	);
	const match = declaration.exec(source);
	if (!match) return undefined;
	// Skip the PARAMETER LIST before looking for the body's `{`. A default
	// parameter value is very often an object literal (`options: T = {}`), and
	// taking the first `{` after the name would return that empty literal as
	// the whole function body — silently reporting a function that calls
	// nothing. `resetLSPService(options: LSPShutdownOptions = {})` hit exactly
	// that while this scan was being written.
	let parenDepth = 0;
	let afterParams = -1;
	for (let i = match.index + match[0].length - 1; i < source.length; i++) {
		if (source[i] === "(") parenDepth++;
		else if (source[i] === ")") {
			parenDepth--;
			if (parenDepth === 0) {
				afterParams = i + 1;
				break;
			}
		}
	}
	if (afterParams < 0) return undefined;
	const openBrace = source.indexOf("{", afterParams);
	if (openBrace < 0) return undefined;
	let depth = 0;
	for (let i = openBrace; i < source.length; i++) {
		if (source[i] === "{") depth++;
		else if (source[i] === "}") {
			depth--;
			if (depth === 0) return source.slice(openBrace, i + 1);
		}
	}
	return undefined;
}

/** Bare-identifier call targets inside `body` (`foo(...)`, never `x.foo(...)`). */
function bareCalls(body: string): string[] {
	const names = new Set<string>();
	for (const match of body.matchAll(/(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
		names.add(match[2]);
	}
	return [...names];
}

/**
 * Extract calls from the closure's own control flow, excluding callback
 * bodies. Control-flow blocks remain visible, so a reset behind an `if` still
 * counts as directly wired, while a reset deferred to `setImmediate`, `then`,
 * or `catch` does not. The source is stripped, so brace matching is safe.
 */
function directClosureCalls(body: string): string[] {
	const visible = body.split("");
	const maskRange = (start: number, end: number) => {
		for (let i = start; i < end; i++) visible[i] = " ";
	};
	const matchingBrace = (open: number): number => {
		let depth = 0;
		for (let i = open; i < body.length; i++) {
			if (body[i] === "{") depth++;
			else if (body[i] === "}" && --depth === 0) return i;
		}
		return body.length;
	};
	const functionBodyOpen = (start: number): number => {
		let parens = 0;
		for (let i = start + "function".length; i < body.length; i++) {
			if (body[i] === "(") parens++;
			else if (body[i] === ")") parens--;
			else if (body[i] === "{" && parens === 0) return i;
		}
		return body.length;
	};
	const arrowExpressionEnd = (start: number): number => {
		let parens = 0;
		let brackets = 0;
		for (let i = start; i < body.length; i++) {
			switch (body[i]) {
				case "(":
					parens++;
					break;
				case ")":
					if (parens === 0 && brackets === 0) return i;
					parens--;
					break;
				case "[":
					brackets++;
					break;
				case "]":
					brackets--;
					break;
				case ",":
				case ";":
					if (parens === 0 && brackets === 0) return i;
			}
		}
		return body.length;
	};

	for (let i = 0; i < body.length - 1; i++) {
		if (
			body.startsWith("function", i) &&
			!/[\w$]/.test(body[i - 1] ?? "") &&
			!/[\w$]/.test(body[i + "function".length] ?? "")
		) {
			const open = functionBodyOpen(i);
			if (open < body.length) {
				maskRange(open, matchingBrace(open) + 1);
				i = open;
			}
		}
		if (body[i] === "=" && body[i + 1] === ">") {
			let next = i + 2;
			while (/\s/.test(body[next] ?? "")) next++;
			if (body[next] === "{") {
				maskRange(next, matchingBrace(next) + 1);
				i = next;
			} else {
				maskRange(next, arrowExpressionEnd(next));
				i = next;
			}
		}
	}
	return bareCalls(visible.join(""));
}

/**
 * The bare-identifier calls made inside `name`'s body in `source`, with
 * comments and string literals removed first. Exported so the suite can pin
 * this behavior against synthetic source rather than only against whatever
 * happens to be in `clients/` today — see the R1 probes in
 * `tests/clients/session-state-conformance.test.ts`.
 */
export function callsWithinFunction(source: string, name: string): string[] {
	const body = functionBody(stripCommentsAndStrings(source), name);
	return body ? bareCalls(body) : [];
}

/**
 * Only reset-shaped names are followed. Walking EVERY call out of
 * `handleSessionStart` would drag in most of the codebase and answer a
 * different question; the registry's claim is specifically "this reset runs at
 * session_start", so the walk follows resets.
 */
const RESET_NAME = /^_?(reset|clear)[A-Z_]/;

/** Host built-ins that match {@link RESET_NAME} but reset nothing of ours. */
const BUILTIN_CLEARS = new Set([
	"clearTimeout",
	"clearInterval",
	"clearImmediate",
]);

/**
 * Reset-shaped (or rotate-shaped) bare call names worth following. Shared by
 * the `handleSessionStart` walk and the session_start-closure walk (#2319).
 */
function isResetName(name: string): boolean {
	return (
		(RESET_NAME.test(name) || /^rotate[A-Z]/.test(name)) &&
		!BUILTIN_CLEARS.has(name)
	);
}

let cachedResetNames: Set<string> | undefined;

/**
 * The reset functions reachable from `handleSessionStart` through bare
 * function calls, transitively.
 *
 * Known imprecision, stated rather than hidden:
 * - METHOD calls are not followed (`sessionFacts.clearAll()`,
 *   `runtime.resetForSession()`). Register such state under the exported
 *   function that ENCLOSES the method call (`resetDispatchBaselines`), which
 *   is the seam a caller can actually reach anyway.
 * - A reset called only inside a conditional still counts as reached. This
 *   scan answers "is it wired", not "does it always run".
 * - Name collisions across modules resolve to whichever file defines the name
 *   first. No two reset functions in `clients/` share a name today, and
 *   {@link resetNameDefinitions} exposes the mapping so a future collision is
 *   visible rather than silent.
 */
export function sessionStartResetNames(): Set<string> {
	if (cachedResetNames) return cachedResetNames;
	const sources = new Map<string, string>();
	for (const absolute of clientSourceFiles()) {
		// Stripped ONCE per file, then used for the declaration search, the brace
		// match and the call extraction alike (R1).
		sources.set(
			clientsRelative(absolute),
			stripCommentsAndStrings(fs.readFileSync(absolute, "utf8")),
		);
	}

	const bodyOf = (name: string): string | undefined => {
		for (const source of sources.values()) {
			const body = functionBody(source, name);
			if (body) return body;
		}
		return undefined;
	};

	const entry = bodyOf("handleSessionStart");
	if (!entry) {
		throw new Error(
			"session-state scan: could not find handleSessionStart's body in clients/ — " +
				"the session_start entry point moved or was renamed; update this scan.",
		);
	}

	const reached = new Set<string>();
	const queue = bareCalls(entry).filter(isResetName);
	while (queue.length > 0) {
		const name = queue.pop() as string;
		if (reached.has(name)) continue;
		reached.add(name);
		const body = bodyOf(name);
		if (!body) continue;
		for (const called of bareCalls(body)) {
			if (isResetName(called) && !reached.has(called)) queue.push(called);
		}
	}
	cachedResetNames = reached;
	return reached;
}

/** Which file defines each reset-shaped exported function, for collision checks. */
export function resetNameDefinitions(): Map<string, string[]> {
	const byName = new Map<string, string[]>();
	for (const absolute of clientSourceFiles()) {
		const source = stripCommentsAndStrings(fs.readFileSync(absolute, "utf8"));
		for (const match of source.matchAll(
			/^export function (_?(?:reset|clear)[A-Za-z0-9_]*)/gm,
		)) {
			const file = clientsRelative(absolute);
			byName.set(match[1], [...(byName.get(match[1]) ?? []), file]);
		}
	}
	return byName;
}

// ── 1b. What index.ts's session_start closure resets directly (#2319) ────────

/** The repository's root `index.ts`, which owns the session_start closure. */
function indexEntrySource(): string {
	return fs.readFileSync(path.join(repoRoot, "index.ts"), "utf8");
}

/**
 * The bare calls made DIRECTLY inside index.ts's `pi.on("session_start", ...)`
 * closure, with comments and string literals removed first. Exported so the
 * suite can pin this walker against synthetic source, exactly like
 * {@link callsWithinFunction}.
 *
 * The closure is anchored on its raw wrapper registration
 * (`wrapSessionEventHandler("session_start", async (event, ctx) => {`) and
 * brace-matched on the STRIPPED source, so a brace inside a string or comment
 * cannot truncate the body and a call named only in prose is not a call (the
 * same R1/S1 discipline the `handleSessionStart` walker obeys).
 */
export function callsWithinSessionStartClosure(source: string): string[] {
	const anchor =
		/wrapSessionEventHandler\(\s*"session_start"\s*,\s*async\s*\([^)]*\)\s*=>\s*\{/.exec(
			source,
		);
	if (!anchor) return [];
	const openBrace = anchor.index + anchor[0].length - 1;
	const stripped = stripCommentsAndStrings(source);
	let depth = 0;
	for (let i = openBrace; i < stripped.length; i++) {
		if (stripped[i] === "{") depth++;
		else if (stripped[i] === "}") {
			depth--;
			if (depth === 0)
				return directClosureCalls(stripped.slice(openBrace, i + 1));
		}
	}
	return [];
}

let cachedClosureResetNames: Set<string> | undefined;

/**
 * The reset-shaped bare calls directly inside index.ts's session_start closure
 * — #2319.
 *
 * {@link sessionStartResetNames} walks `handleSessionStart`'s reachable call
 * graph. A few resets are deliberately placed in the session_start CLOSURE
 * itself rather than inside `handleSessionStart`'s body: `resetCurrentPhaseForSession`
 * (must sit inside the #473 concurrent-secondary gate but before
 * `handleSessionStart` runs — #1723 review F4), the concurrent-session bind
 * rollup reset (must run only on the primary continuation path — #2249), and
 * the verified-attribution tally reset. The registry marks such entries with
 * `sessionStartClosureReset`, and this walk is the derived evidence the
 * conformance suite checks them against — a reset that is registered as
 * closure-wired but never called here reds exactly like an unwired
 * `handleSessionStart` reset does.
 */
export function sessionStartClosureResetNames(): Set<string> {
	if (cachedClosureResetNames) return cachedClosureResetNames;
	const names =
		callsWithinSessionStartClosure(indexEntrySource()).filter(isResetName);
	cachedClosureResetNames = new Set(names);
	return cachedClosureResetNames!;
}

// ── 2. Which files look like they own session-scoped state ───────────────────

/** A source file matching the session-scoped-state code pattern. */
export interface SessionStateCandidate {
	/** `clients/`-relative posix path. */
	file: string;
	/** Module-level `Map`/`Set` declarations found (name only). */
	containers: string[];
	/** Exported reset-shaped function names found. */
	resets: string[];
	/** True when at least one reset is an explicitly test-only seam. */
	hasTestOnlyReset: boolean;
	/** True when the file calls `getProcessSingleton(...)` — state on the
	 *  process-wide container (#2146/#2319). The container's VALUE lives off
	 *  module scope, so this is the only signal the file owns process-lifetime
	 *  (possibly session-scoped) state. */
	hasProcessSingleton: boolean;
}

/** Container constructors every scan recognises regardless of origin. */
const BUILTIN_CONTAINER_CTORS = ["Map", "Set", "WeakMap", "WeakSet"] as const;

/**
 * Class names {@link classDeclarationNames} finds in `clients/` that are
 * proven NOT to hold session-scoped state — an exclusion from the primary
 * #2455 predicate ("declared in `clients/`"), not from a narrower method-name
 * filter (round 1's `clear()`/`delete()` gate; see {@link containerClassNames}
 * for why round 2 dropped it). Add an entry with a one-line reason, the same
 * way {@link EXEMPT_SESSION_STATE_FILES} argues file-level exemptions, rather
 * than silently special-casing a name at the call site. Both halves are
 * self-checking (`tests/clients/session-state-conformance.test.ts`): a key
 * naming a class the live scan no longer finds, or a reason-less entry, reds
 * instead of quietly doing nothing.
 */
const CONTAINER_CLASS_EXCLUSIONS: Readonly<Record<string, string>> = {};

/**
 * `class Name` declarations in (already {@link stripCommentsAndStrings}
 * -processed) `source`, at column zero — module scope, mirroring the
 * container-declaration regex's own column-zero requirement — in every
 * export shape: `export class`, `export default class`, `export abstract
 * class`, `export default abstract class`, and a bare (non-exported) `class`.
 *
 * Only the identifier immediately after the `class` keyword is captured. The
 * round-1 regex instead matched the WHOLE header through to `{`
 * (`^export class NAME(?:<[^>]*>)?(?:\s+extends\s+BASE(?:<[^>]*>)?)?...`), so
 * it both required the literal `export class` prefix (missing `export
 * default class`, `export abstract class`, and a non-exported `class` later
 * re-exported via `export { A }` / `export { A as B }`) and broke on a nested
 * generic in either the class's own type parameters or its `extends` target
 * (`class A<T extends Map<K, V>>`, `extends Base<Map<K, V>>`) because
 * `[^>]*` stops at the FIRST `>`, one short of the real end. Capturing only
 * the name sidesteps both: nothing after `class NAME` is inspected — no
 * header text is ever walked, balanced or otherwise — so there is nothing
 * left for a nested generic to break. #2455 fix round 2 also drops the
 * `extends`-chain body match this regex used to feed — round 2's predicate is
 * "declared in `clients/`", not "owns `clear()`/`delete()`, directly or
 * inherited", so there is nothing to resolve through an `extends` chain any
 * more.
 */
function classDeclarationNames(source: string): Set<string> {
	const names = new Set<string>();
	const declaration =
		/^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/gm;
	for (const match of source.matchAll(declaration)) names.add(match[1]);

	// A non-exported class re-exported (optionally renamed) through its own
	// `export { A }` / `export { A as B }` statement: a caller elsewhere
	// constructs `new B(...)`, so the alias must resolve to a recognised name
	// too. Re-exports FROM another module (`export { A } from "./x.js"`) are
	// skipped — that class is declared in `./x.js`, where this same scan
	// already sees it directly when it walks that file.
	const exportList = /^export\s*\{([\s\S]*?)\}\s*(from\s*["'][^"']*["'])?/gm;
	for (const match of source.matchAll(exportList)) {
		if (match[2]) continue;
		for (const rawEntry of match[1].split(",")) {
			const entry = rawEntry.trim().replace(/^type\s+/, "");
			const aliased = /^[A-Za-z_$][\w$]*\s+as\s+([A-Za-z_$][\w$]*)$/.exec(
				entry,
			);
			if (aliased) names.add(aliased[1]);
		}
	}
	return names;
}

const declaredClassNamesCache = new Map<string, Set<string>>();

/**
 * Every class DECLARED anywhere in `dir` — the primary #2455 predicate,
 * BEFORE {@link CONTAINER_CLASS_EXCLUSIONS} is applied. Split out from
 * {@link containerClassNames} so {@link auditContainerClassExclusions} can
 * check an exclusion's class name against what the scan actually finds,
 * independent of whether that same name is about to be excluded.
 *
 * Round 1 gated recognition on the class owning a `clear()`/`delete()`
 * method, directly or through an `extends` chain: a narrower proxy for "looks
 * like a container", chosen so `BoundedFifoMap`/`BoundedLruCache` (which
 * migrated ~20 module-level `new Map()` caches off a hard-coded name
 * alternation, #2442) would be recognised by shape rather than by name. That
 * proxy was itself a miss: `FactStore` (`clients/dispatch/fact-store.ts`)
 * holds five session-scoped `Map`/`Set` fields behind `clearAll()` and
 * `deleteFileFact()` — neither name is literally `clear` or `delete` — so two
 * of its five production module-scope instances stayed invisible to the
 * round-1 scan. #2455's issue text names the PRIMARY predicate directly:
 * "module-level `const`/`let` bound to a `new` expression whose constructor
 * is declared in `clients/`". Round 2 uses that wording instead of the
 * method-name proxy, which also deletes the `extends`-chain walk and its
 * cycle guard — with no method filter to resolve inheritance for, there is
 * nothing left for either to do.
 *
 * Cached per `dir` — the real `clients/` tree is scanned once per process;
 * a fixture tree passed by a test gets its own cache entry so tests never
 * see a stale class list from an earlier fixture.
 */
function declaredClassNames(dir = CLIENTS_ROOT): Set<string> {
	const cached = declaredClassNamesCache.get(dir);
	if (cached) return cached;

	const names = new Set<string>();
	for (const absolute of clientSourceFiles(dir)) {
		const source = stripCommentsAndStrings(fs.readFileSync(absolute, "utf8"));
		for (const name of classDeclarationNames(source)) names.add(name);
	}
	declaredClassNamesCache.set(dir, names);
	return names;
}

const containerClassNamesCache = new Map<string, Set<string>>();

/** {@link declaredClassNames}, minus {@link CONTAINER_CLASS_EXCLUSIONS}. */
function containerClassNames(dir = CLIENTS_ROOT): Set<string> {
	const cached = containerClassNamesCache.get(dir);
	if (cached) return cached;

	const names = new Set(declaredClassNames(dir));
	for (const excluded of Object.keys(CONTAINER_CLASS_EXCLUSIONS)) {
		names.delete(excluded);
	}
	containerClassNamesCache.set(dir, names);
	return names;
}

/**
 * Problems with an exclusions table (defaults to the real
 * {@link CONTAINER_CLASS_EXCLUSIONS}): a key naming a class
 * {@link declaredClassNames} does not currently find (a stale entry — the
 * class was renamed, deleted, or never existed), or an entry whose reason is
 * empty. #2455 fix round 2 review F3: before this, a nonexistent class name
 * paired with an empty-string reason changed nothing observable — the
 * exclusion silently deleted nothing from a Set that never had that key, and
 * the conformance sweep stayed green. Exported so
 * `tests/clients/session-state-conformance.test.ts` can run this against
 * BOTH the real (today empty) table and a synthetic fixture table that
 * proves the guard actually fires.
 */
export function auditContainerClassExclusions(
	exclusions: Readonly<Record<string, string>> = CONTAINER_CLASS_EXCLUSIONS,
	dir = CLIENTS_ROOT,
): string[] {
	const declared = declaredClassNames(dir);
	const problems: string[] = [];
	for (const [name, reason] of Object.entries(exclusions)) {
		if (!declared.has(name)) {
			problems.push(
				`CONTAINER_CLASS_EXCLUSIONS names "${name}", which the live class scan does not find — stale entry (renamed, deleted, or never existed)`,
			);
		}
		if (reason.trim().length === 0) {
			problems.push(
				`CONTAINER_CLASS_EXCLUSIONS["${name}"] has an empty reason`,
			);
		}
	}
	return problems;
}

const containerDeclarationCache = new Map<string, RegExp>();

/**
 * Module-level (column-zero) `const`/`let` bound to `new <Ctor>(...)`, where
 * `<Ctor>` is a built-in container or a {@link containerClassNames} match for
 * `dir`. Column zero is the signal for "module scope" — a container declared
 * inside a function is per-call state and re-armed by construction.
 *
 * The `export` prefix is optional (#2455 fix round 4). It was not, and that
 * was a miss of the same family as the two this issue already closed: whether
 * a module-scope singleton is exported says nothing about whether it holds
 * session state, and `export const goClient = new GoClient()` — the process's
 * only Go availability latch — was invisible for no reason but the keyword in
 * front of it. Seven pre-existing `export const … = new …` sites in `clients/`
 * were equally unseen; the pins below record which of them the pairing rule
 * turns into candidates.
 *
 * Built fresh (once, cached) from a live class scan rather than a hand list —
 * see {@link containerClassNames}.
 */
function containerDeclarationRegex(dir: string): RegExp {
	const cached = containerDeclarationCache.get(dir);
	if (cached) return cached;
	const names = [...BUILTIN_CONTAINER_CTORS, ...containerClassNames(dir)].map(
		escapeRegExp,
	);
	const regex = new RegExp(
		`^(?:export\\s+)?(?:const|let)\\s+([A-Za-z_$][\\w$]*)[^=\\n]*=\\s*new\\s+(?:${names.join("|")})\\b`,
		"gm",
	);
	containerDeclarationCache.set(dir, regex);
	return regex;
}

/** An exported reset-shaped function. */
const EXPORTED_RESET = /^export function (_?(?:reset|clear)[A-Za-z0-9_]*)/gm;

/** A reset seam whose name says it exists for tests. */
const TEST_ONLY_RESET = /ForTests?$|ForTesting$/;

/**
 * A call to `getProcessSingleton(` — the file acquires state on the
 * process-wide container ({@link clients/process-singletons.ts}): a cell whose
 * correctness depends on being the process's only copy. The VALUE lives off
 * module scope on `globalThis`, so the module-scope container regex cannot see
 * it; this is the file-level signal that state is held at process lifetime and
 * must be classified (session_start / turn_end / process_lifetime) like any
 * other candidate.
 *
 * NO `g` flag, deliberately: `.test()` keeps `lastIndex` between calls on a
 * global regex, so scanning the second file would resume mid-string and a
 * legitimate call ahead of the cursor would be missed (this exact bug turned
 * `session-start-observability.ts` invisible in the first draft of #2319).
 */
const PROCESS_SINGLETON_CALL = /getProcessSingleton\s*\(/;

/**
 * What this heuristic catches, and what it structurally cannot.
 *
 * CATCHES — a module-level `Map`/`Set`/`WeakMap`/`WeakSet`, or any class
 * DECLARED in `clients/` regardless of export shape (see
 * {@link containerClassNames} — #2455), in a file that also exports a
 * reset-shaped function; a `getProcessSingleton(...)` call in a file that
 * also exports one; and any file exporting a `_reset…ForTests`-style seam.
 * Those pairings are the observed shape of every process-lifetime-latch bug in
 * the #1266–#1625 arc (and #2319's process-singleton twin): state that outlives
 * a session plus a reset nobody calls at the session boundary.
 *
 * MISSES — and each of these is a real, currently-unguarded class:
 * 1. **Scalar state.** `let installRetryGeneration = 0`, a boolean latch, a
 *    `number` cooldown deadline (`lsp/server.ts`'s
 *    `directLspCommandUnavailableUntil`). No container, so no signal.
 * 2. **Closure state.** `createAvailabilityLatch()`'s verdict lives in a
 *    closure, not a module-level container. The registry covers these by hand
 *    because the scan cannot.
 * 3. **State with no reset seam at all.** The scan needs the pairing; state
 *    nobody ever wrote a reset for is invisible to it. This is the worst
 *    blind spot, because "no reset exists" is a stronger version of the bug
 *    the sweep is looking for.
 * 4. **Instance fields.** `private readonly cache = new Map()` on a class the
 *    bootstrap builds once is session-scoped in practice and indented in
 *    source, so column-zero matching skips it.
 * 5. **Semantics.** The scan cannot tell a session-scoped dedupe set from a
 *    frozen lookup table built once at import. That judgment stays in the
 *    registry and in {@link SessionStateExemption}'s reasons.
 *
 * The #1817 symbol-count pin narrows the FIRST four of these from "invisible"
 * to "a total the pin table tracks", but it inherits one more blind spot of
 * its own:
 *
 * 6. **Substitution.** Adding one new uncleared container while removing an
 *    already-covered one leaves the file's total count unchanged, so the pin
 *    sees nothing. The pin proves the COUNT is deliberate, not that every
 *    individual symbol behind it still is — a swap that nets to zero is
 *    invisible to a total the same way it would be to a checksum. Full
 *    symbol-to-reset attribution (#1817's option (a), not taken here) is the
 *    only way to close this; the count pin's job is the cheaper, LOUDER
 *    common case where a symbol is added without one being removed.
 *
 * The sweep is therefore a floor, not a proof of coverage. It makes a NEW
 * matching file impossible to add without a decision; it does not certify
 * that everything session-scoped is registered.
 */
export const SWEEP_HEURISTIC_LIMITS = [
	"scalar (non-container) session state",
	"closure-held state, e.g. createAvailabilityLatch's verdict",
	"state with no reset seam at all",
	"instance fields on bootstrap-lived singletons",
	"session-scoped vs import-time-constant semantics",
	"substitution: add one container, remove another, and the #1817 symbol-count pin sees no change",
	"getProcessSingleton cells are a SIGNAL, but the cell VALUE lives off module scope on globalThis — a session-scoped cell is still only caught when its file also exports a reset (the pair-with-reset rule), and the cell itself is registered/exempted by hand judgment",
	// #2455 fix round 2, F4: the widened predicate is "declared in clients/",
	// which is still only a NAME match against clients/'s own class index —
	// two shapes remain structurally invisible even though they hold the exact
	// same kind of state a repo-local container does.
	"a `new` bound to a constructor IMPORTED FROM OUTSIDE clients/ (a node_modules class, e.g. a third-party cache/client) is invisible — the class index only walks clients/, by design (a walk of node_modules is a different, much larger problem)",
	"a `new` bound to a constructor built through a FACTORY FUNCTION rather than a bare `new Ctor(...)` expression (createAvailabilityLatch(), createToolchainAvailability()) is invisible to the container-declaration regex, which matches only `new <Name>(...)` — this is the same shape as MISS 2 (closure-held state) one level up: the factory's return value can itself hold session state with no module-level container syntax marking it",
] as const;

let cachedCandidates: SessionStateCandidate[] | undefined;

/**
 * Every source file under `dir` matching the session-scoped-state code
 * pattern. Defaults to (and caches) the real `clients/` tree; a caller may
 * pass an override root to run the same detection against a synthetic
 * fixture tree — `tests/clients/session-state-conformance.test.ts` uses this
 * to regression-test the #1817 symbol-count pin against a fixture that
 * cannot drift out from under the test the way the real tree can.
 */
export function scanSessionStateCandidates(
	dir = CLIENTS_ROOT,
): SessionStateCandidate[] {
	const useCache = dir === CLIENTS_ROOT;
	if (useCache && cachedCandidates) return cachedCandidates;
	const containerDeclaration = containerDeclarationRegex(dir);
	const found: SessionStateCandidate[] = [];
	for (const absolute of clientSourceFiles(dir)) {
		// Stripped for the same reason the reachability walk is (R1): a
		// commented-out declaration or reset export is not one.
		const source = stripCommentsAndStrings(fs.readFileSync(absolute, "utf8"));
		const containers = [...source.matchAll(containerDeclaration)].map(
			(m) => m[1],
		);
		const resets = [...source.matchAll(EXPORTED_RESET)].map((m) => m[1]);
		if (resets.length === 0) continue;
		const hasTestOnlyReset = resets.some((r) => TEST_ONLY_RESET.test(r));
		const hasProcessSingleton = PROCESS_SINGLETON_CALL.test(source);
		// Signal A (container + reset), signal B (an explicit test-only reset
		// seam, which by itself says "this module holds state tests must undo"),
		// or signal C (a getProcessSingleton cell + reset — #2319).
		if (containers.length === 0 && !hasTestOnlyReset && !hasProcessSingleton)
			continue;
		found.push({
			file: relativePosix(dir, absolute),
			containers,
			resets,
			hasTestOnlyReset,
			hasProcessSingleton,
		});
	}
	if (useCache) cachedCandidates = found;
	return found;
}
