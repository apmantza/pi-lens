/**
 * Pure detection logic for the #2523 hook-await-bounds sweep
 * (`tests/config/hook-await-bounds.test.ts`), pulled out so it has exactly
 * ONE home: the governance test imports it to build the guard, and
 * `scripts/rekey-hook-await-exemptions.mjs` imports the SAME functions to
 * recompute occurrence keys mechanically after a merge shifts lines near a
 * flagged site. A vitest test file cannot be `import()`ed by a plain Node
 * script (its top-level `describe()`/`it()` calls need a running vitest
 * worker), so the detector has to live somewhere script-reachable — this
 * module, not a second hand-copied implementation (the single-source-of-truth
 * rule: a script that reimplements the regexes would drift from the test the
 * moment either one changes).
 *
 * No vitest import anywhere in this file — that is what makes it importable
 * from a bare `node` process.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { jsTsCandidatePaths } from "../../clients/review-graph/import-resolvers.js";
import { lineContentHash } from "../../clients/read-guard.js";
import {
	listSourceFiles,
	matchingCloseIndex,
	readWalkedFile,
	relativePosix,
	stableOccurrenceKey,
	stripSource,
} from "./sweep-kit.js";
/** The one module allowed to spell a timeout race: the canonical implementation. */
export const DEFINITION_FILE = "clients/deadline-utils.ts";
/** An `await` token that is a KEYWORD, not a property name or an identifier tail. */
const AWAIT_TOKEN = /(?<![.\w$])await(?![\w$])/g;
/**
 * A `Promise.race(` or `Promise.any(` call head, with or without type
 * arguments (`Promise.race<T>(`). `Promise.any([work, delay])` is the same
 * shape as a `Promise.race` with a timer arm — first settlement wins either
 * way — so a hand-rolled bound spelled with `any` instead of `race` must not
 * slip past this scan (#2530 round 3 F3). A generic call used to read as no
 * call at all (the `<` sat between `race` and `(`), which hid the 3-way
 * client-wait race in `clients/lsp/index.ts`.
 */
const RACE_TOKEN = /\bPromise\s*\.\s*(?:race|any)\s*(?:<[^()]*>\s*)?\(/g;
/**
 * Every OTHER way to reach `Promise.race`/`Promise.any`: a bare property read
 * (`Promise.race.bind(Promise)`, `const r = Promise.race`), a computed access
 * (`Promise["race"]`; string contents are blanked before the scan, so the
 * bracket itself is the evidence) and a destructure (`const { race } =
 * Promise`). The arms of a race reached this way are not in the call's own
 * parentheses, so the scan cannot see a timer there; it refuses the form
 * instead of guessing (a gate admits the known-good call form and refuses
 * every other, #3134's lesson and AGENTS.md shape 69).
 */
const RACE_REFERENCE =
	/\bPromise\s*\.\s*(?:race|any)\b(?!\s*(?:<[^()]*>\s*)?\()|\bPromise\s*\[|\{[^{}]*\b(?:race|any)\b[^{}]*\}\s*=\s*Promise\b/g;
/** A timer arm: the shape that makes a race a hand-rolled bound. */
const TIMER_ARM = /\bsetTimeout\s*\(|\bAbortSignal\s*\.\s*timeout\s*\(/;
/**
 * How far ABOVE a `Promise.race(`/`Promise.any(` to look for the timer that
 * feeds it.
 *
 * The inline arm (`new Promise((r) => setTimeout(r, ms))` written straight
 * into the race) is the minority spelling. The dominant one hoists the arm
 * into a named local a few lines up — `clients/format-service.ts`'s
 * `timeoutPromise`, `clients/runtime-session.ts`'s
 * `readSequenceWithBudget` — and an inline-only detector called both of them
 * clean, which for a guard is the failure direction that hides. The window is
 * a line count rather than a scope walk for the same reason the rest of this
 * file is: a partial scope walk produces false negatives, a window produces
 * false positives, and a false positive is a table entry a reviewer reads.
 */
const RACE_TIMER_WINDOW = 25;
/** The only call shape that carries a real bound. See {@link SWEEP_HEURISTIC_LIMITS}. */
const BOUNDED_CALL = /^\s*bounded\s*\(/;
/**
 * Text of the call's own parentheses, starting at the `(` at or after
 * `from`. Paren matching over STRIPPED source, so a paren inside a comment or
 * string cannot unbalance it. Bounded by `maxChars` so one pathological
 * expression cannot turn this into a whole-file scan.
 */
function callArguments(stripped, from, maxChars = 4000) {
	const open = stripped.indexOf("(", from);
	if (open < 0) return "";
	const end = Math.min(stripped.length, open + maxChars);
	// #3134: the depth count is `sweep-kit.ts`'s `matchingCloseIndex`, run
	// over a `maxChars`-bounded WINDOW (`stripped.slice(open, end)`, not the
	// whole `stripped` prefix) so the cap this function exists for — "one
	// pathological expression cannot turn this into a whole-file scan" —
	// still bounds both the scan and the allocation, not just the scan.
	const window = stripped.slice(open, end);
	const close = matchingCloseIndex(window, 0, "(", ")");
	return close === -1 ? window : window.slice(0, close + 1);
}
/**
 * Is the expression starting at `at` (just past an `await`) bounded?
 *
 * Exactly ONE accepted form: `bounded(...)` (#2530 round 3 F1). Round 1
 * accepted a second, `withDeadline`/`withTimeout`/`withBudget`/
 * `withinRemaining` whenever the word `signal` appeared anywhere in the
 * call's own parentheses — but none of those helpers takes a `signal`
 * parameter at all (`DeadlineOptions` has no such field), so the match was
 * pure text: `withBudget(sweep(cwd, { signal }), 500)` read as bounded
 * because `signal` was in the argument list, even though it is threaded to
 * the WRAPPED work, not to the race that decides how long this await waits.
 * That is exactly the deadline-only hole #2523 exists to close, reopened by
 * substring match. Zero sites in the scanned tree relied on it (measured:
 * the flagged set is identical with or without the allowance), so dropping
 * it costs nothing today and closes a hole slice 2 would otherwise walk
 * into.
 */
function isBoundedAwait(stripped, at) {
	const head = stripped.slice(at, at + 80);
	return BOUNDED_CALL.test(head);
}
/** 1-based line number of `offset` in `source`. */
function lineOf(source, offset) {
	return source.slice(0, offset).split("\n").length;
}
/**
 * Every unbounded-await LINE in one already-stripped source, 1-based.
 *
 * Exported so the detector itself can be pinned against synthetic fixtures
 * (the mutation tests in `tests/config/hook-await-bounds.test.ts`) rather
 * than only against whatever happens to be in the tree today — a detector
 * that quietly stops detecting is defect shape 10 wearing a green check.
 */
export function findUnboundedAwaitLines(stripped) {
	const hits = new Set();
	for (const match of stripped.matchAll(AWAIT_TOKEN)) {
		const at = match.index + match[0].length;
		if (isBoundedAwait(stripped, at)) continue;
		hits.add(lineOf(stripped, match.index));
	}
	return [...hits].sort((a, b) => a - b);
}
/**
 * Every hand-rolled timeout race LINE in one already-stripped source,
 * 1-based: a `Promise.race(`/`Promise.any(` whose own arguments, or the 25
 * lines above it, spell a timer; and every reference to either that is not a
 * direct call ({@link RACE_REFERENCE}), whose arms cannot be read.
 */
export function findHandRolledRaceLines(stripped) {
	const hits = new Set();
	const lines = stripped.split("\n");
	for (const match of stripped.matchAll(RACE_REFERENCE)) {
		hits.add(lineOf(stripped, match.index));
	}
	for (const match of stripped.matchAll(RACE_TOKEN)) {
		const line = lineOf(stripped, match.index);
		const args = callArguments(stripped, match.index + match[0].length - 1);
		const above = lines
			.slice(Math.max(0, line - 1 - RACE_TIMER_WINDOW), line - 1)
			.join("\n");
		if (TIMER_ARM.test(args) || TIMER_ARM.test(above)) hits.add(line);
	}
	return [...hits].sort((a, b) => a - b);
}
/**
 * A CALL to {@link DEFINITION_FILE}'s `bounded()`, as opposed to any of the
 * `bounded*` identifiers around it. The lookbehind refuses a property access
 * (`deps.bounded(`) and an identifier tail (`unbounded(`); requiring `(` after
 * an optional type-argument list refuses `boundedLspCall(`, `boundedNumber(`
 * and `BoundedFifoMap`.
 */
const BOUNDED_CALL_HEAD = /(?<![.\w$])bounded\s*(?:<[^<>()]*>\s*)?\(/g;
/**
 * The `signal` property inside a `bounded()` options object, in either
 * spelling: `signal: expr` or the shorthand `signal` (followed by `,` or the
 * object's closing brace).
 */
const SIGNAL_PROPERTY = /(?:^|[,{(\s])signal\s*(?::|,|\})/;
/**
 * Every shipped `bounded()` CALL line in one already-stripped source, 1-based
 * — reported at the `signal:` property when the call spells one, and at the
 * call head otherwise.
 *
 * ## What this family is for (#2557 review F2)
 *
 * `bounded()`'s `signal` is a REQUIRED property typed `AbortSignal |
 * undefined`: the key must be written (so a deadline-only call cannot
 * compile), but several real seams hold an optional signal and pass it
 * straight through, which leaves them on ONE live bound whenever the caller
 * genuinely had none. That is weaker than #2523's contract, so it is not
 * forbidden — it is ENUMERATED, and the enumeration is what this detector
 * feeds.
 *
 * Round 1 of this PR enumerated the same fact by counting a `NEVER_ABORTED`
 * sentinel constant instead. The sentinel duplicated behaviour `bounded()`
 * already had (it treats a missing signal as one that never aborts), so it was
 * a second concept on an issue whose entire premise is that one primitive
 * replaces the private copies — the reviewer's net-count finding. Deleting it
 * loses nothing here: the registry keys on the CALL, not on a spelling a
 * caller has to remember to use, so it also covers the sites that never named
 * the sentinel.
 *
 * Deliberately NOT a heuristic over the argument's TEXT. "Is this expression
 * possibly `undefined`" is a type question; a regex for `??` / `||` /
 * `undefined` would call `signal: options.signal` — the bootstrap seam, whose
 * parameter is optional and which is the single most important site here —
 * clean, which is the false-negative direction a guard must never take. Every
 * call is registered instead, and its entry states where its signal comes
 * from.
 */
export function findBoundedCallLines(stripped) {
	const hits = new Set();
	for (const match of stripped.matchAll(BOUNDED_CALL_HEAD)) {
		const head = lineOf(stripped, match.index);
		const args = callArguments(stripped, match.index + match[0].length - 1);
		const offset = args.split("\n").findIndex((l) => SIGNAL_PROPERTY.test(l));
		hits.add(offset < 0 ? head : head + offset);
	}
	return [...hits].sort((a, b) => a - b);
}
/**
 * Nearest non-blank RAW line in `direction` from `index`, or `""` at the edge
 * of the file.
 */
function neighbourLine(rawLines, index, direction) {
	for (
		let i = index + direction;
		i >= 0 && i < rawLines.length;
		i += direction
	) {
		const line = rawLines[i] ?? "";
		if (line.trim().length > 0) return line;
	}
	return "";
}
/**
 * `stableOccurrenceKey` over the RAW lines, plus a neighbourhood suffix. See
 * `tests/config/hook-await-bounds.test.ts`'s module doc for the collision
 * measurements that justify the suffix.
 */
export function awaitOccurrenceKey(rel, rawLines, index) {
	const base = stableOccurrenceKey(rel, rawLines, index);
	// NUL separator: `lineContentHash` strips whitespace, so a newline would
	// vanish and `a\nb` would hash the same as `ab`.
	const context = lineContentHash(
		[
			neighbourLine(rawLines, index, -1),
			neighbourLine(rawLines, index, 1),
		].join("\u0000"),
	);
	return `${base}~${context}`;
}
/** The four file groups a registered hook handler and its direct deps live in. */
export function hookPathFiles(repoRoot) {
	const files = [];
	// Mechanical, never a hand-kept list: a NEW clients/runtime-*.ts is in
	// scope the moment it lands, which is the whole point of a governance
	// registry (a hand-maintained mirror of a directory is the defect).
	for (const absolute of listSourceFiles(path.join(repoRoot, "clients"), {
		skipTests: true,
	})) {
		const rel = relativePosix(repoRoot, absolute);
		if (/^clients\/runtime-[^/]+\.ts$/.test(rel)) files.push(absolute);
	}
	for (const rel of ["index.ts", "mcp/server.ts", "clients/mcp/session.ts"]) {
		const absolute = path.join(repoRoot, rel);
		if (fs.existsSync(absolute)) files.push(absolute);
	}
	return files.sort();
}
/**
 * A relative module specifier in an `import` / `export ... from` /
 * `await import()` / `require()`. Only RELATIVE ones: a bare specifier is an
 * npm package or a builtin and has no file in this repo.
 */
const LOCAL_SPECIFIER =
	/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["'](\.\.?\/[^"']*)["']/g;
/**
 * A whole `import type { … } from "…"` / `export type { … } from "…"`
 * DECLARATION — one where the `type` keyword sits immediately after `import`/
 * `export`, not a per-specifier `{ type Foo, bar }` inline modifier inside an
 * otherwise-real import (#2557 review friction). A hook handler that imports
 * only a TYPE from a helper never calls into it at runtime, so counting that
 * edge as "reached" is a false positive: the reviewer measured 9 modules /
 * 128 unbounded-await entries (`clients/lsp/client.ts` alone contributing 75)
 * that existed in the helper set ONLY through an edge like this, and that 22%
 * of recently merged PRs would have tripped the pin on one. `[^;]*?`
 * non-greedy up to the clause's own `from "…"` — it stops at the first match,
 * so it cannot swallow a later, unrelated `import` on the next line.
 */
const TYPE_ONLY_IMPORT_CLAUSE =
	/\b(?:import|export)\s+type\b[^;]*?\bfrom\s*["'](\.\.?\/[^"']*)["']/g;
/**
 * Resolve one relative specifier written the way this repo writes them —
 * `nodenext`, so `./x.js` names the SOURCE `./x.ts` — to an absolute `.ts`
 * path, or `undefined` when nothing exists there.
 *
 * Candidate generation is `clients/review-graph/import-resolvers.ts`'s
 * `jsTsCandidatePaths` (#2557 review F-C): this file used to hand-roll the
 * SAME `./x.js` → sibling `.ts`/`.tsx`/`index.ts` mapping that the review
 * graph's warm jsts builder and cold `module_report` path already share
 * (#694's single-source-of-truth rule for exactly this resolution). The
 * existence check and return shape (a raw `path.resolve()`-based, OS-native
 * path — not `resolveImportToFiles`'s realpath-canonicalized one, which
 * `hookHelperModules`'s `target.startsWith(repoRoot)` check below is not
 * written to survive) stay local, so this module's callers see no behaviour
 * change.
 */
function resolveLocalSpecifier(fromFile, specifier) {
	for (const candidate of jsTsCandidatePaths(fromFile, specifier)) {
		if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
			return candidate;
		}
	}
	return undefined;
}
/** Every repo-local `.ts` module `absolute` imports, resolved and deduplicated. */
export function localImportTargets(absolute) {
	// `strings: "keep"` — the thing being searched for IS a string literal, so
	// the default blanking policy (which every other scan in this file wants,
	// because an identifier inside a string is not a call) would erase every
	// specifier and return an empty set. It did, on the first cut here.
	// readWalkedFile: callers pass paths a directory walk produced (the
	// flake-shape ratchet's import graph walks every tests/**/*.test.ts), and a
	// path that vanished between the walk and the read imports nothing (#3082).
	const source = readWalkedFile(absolute);
	if (source === undefined) return [];
	const stripped = stripSource(source, {
		strings: "keep",
	});
	// Every `import type …` / `export type …` declaration's span — a type
	// edge is not a call, so a `from "…"` match landing inside one of these
	// spans is skipped below (#2557 review friction).
	const typeOnlySpans = [...stripped.matchAll(TYPE_ONLY_IMPORT_CLAUSE)].map(
		(match) => [match.index, match.index + match[0].length],
	);
	const targets = new Set();
	for (const match of stripped.matchAll(LOCAL_SPECIFIER)) {
		if (
			typeOnlySpans.some(
				([start, end]) => match.index >= start && match.index < end,
			)
		) {
			continue;
		}
		const resolved = resolveLocalSpecifier(absolute, match[1] ?? "");
		if (resolved !== undefined && !resolved.endsWith(".d.ts")) {
			targets.add(resolved);
		}
	}
	return [...targets].sort();
}
/**
 * The HELPER modules a registered hook handler reaches in ONE import hop.
 *
 * DERIVED, never spelled (#2557 review F4). Round 1 of this PR listed six
 * module names by hand — `clients/pipeline.ts`, `clients/bootstrap.ts`,
 * `clients/actionable-warnings.ts`, `clients/dispatch/dispatcher.ts`,
 * `clients/quiet-window.ts`, `clients/format-service.ts` — which is defect
 * shape 34 exactly: a guard that enumerates SPELLINGS is blind to everything
 * it did not think of. The reviewer's probe planted 18 unbounded awaits in
 * `clients/observed-mutation.ts` and 148 in `clients/lsp/index.ts` — two
 * modules this very PR labels hook-reached — and the sweep stayed green.
 *
 * One hop, not the transitive closure, and that is a deliberate limit rather
 * than an oversight: `index.ts` alone reaches most of `clients/` transitively,
 * so the closure is "the codebase" and would make this a whole-repo
 * unbounded-await ratchet — a different, much larger promise than #2523's, and
 * one whose numbers no reviewer could check. One hop is the set a hook handler
 * calls DIRECTLY, which is where the work a hook actually awaits lives. The
 * limit is stated in `SWEEP_HEURISTIC_LIMITS`.
 *
 * A whole `import type …` / `export type …` DECLARATION is excluded (#2557
 * review friction) — a type edge is not a call, so a hook handler that
 * imports only a TYPE from a helper never actually calls into it. Measured
 * before this exclusion: 9 modules / 128 unbounded-await entries
 * (`clients/lsp/client.ts` alone contributing 75) existed in this set ONLY
 * through an edge like this, and 22% of recently merged PRs would have
 * tripped the pin below on one. A MIXED clause (`import { type A, b } from
 * "…"`) is not excluded — the declaration itself does not start with `type`,
 * and `b` is a real value import, so the module genuinely is called into.
 */
export function hookHelperModules(repoRoot) {
	const handlers = hookPathFiles(repoRoot);
	const handlerSet = new Set(handlers);
	const helpers = new Set();
	for (const handler of handlers) {
		for (const target of localImportTargets(handler)) {
			if (handlerSet.has(target)) continue;
			if (!target.startsWith(repoRoot)) continue;
			helpers.add(target);
		}
	}
	return [...helpers].sort();
}
/** Every shipped source file the hand-rolled-race scan covers. */
export function shippedSourceFiles(repoRoot) {
	const files = ["clients", "mcp", "tools"].flatMap((dir) => {
		const absolute = path.join(repoRoot, dir);
		return fs.existsSync(absolute)
			? listSourceFiles(absolute, { skipTests: true })
			: [];
	});
	const indexTs = path.join(repoRoot, "index.ts");
	if (fs.existsSync(indexTs)) files.push(indexTs);
	return files.sort();
}
/**
 * Run one line detector over one file group and key every hit.
 *
 * `prefix` namespaces the two families inside the single exemption table, so
 * an `await` and a race on the same line can never be confused for one
 * another (and `auditRegistry`'s stale check stays exact for both).
 */
export function scanFiles(repoRoot, files, detect, prefix, skipRel) {
	const occurrences = [];
	let scanned = 0;
	for (const absolute of files) {
		const rel = relativePosix(repoRoot, absolute);
		if (skipRel?.(rel)) continue;
		scanned++;
		const raw = fs.readFileSync(absolute, "utf8");
		// Layout-preserving, so these line numbers and the hash inputs derived
		// from them line up with the raw source.
		const stripped = stripSource(raw);
		const rawLines = raw.split("\n");
		for (const line of detect(stripped)) {
			occurrences.push({
				key: `${prefix}${awaitOccurrenceKey(rel, rawLines, line - 1)}`,
				detail: `${rel}:${line}  ${(rawLines[line - 1] ?? "").trim().slice(0, 100)}`,
			});
		}
	}
	return { occurrences, scanned };
}
