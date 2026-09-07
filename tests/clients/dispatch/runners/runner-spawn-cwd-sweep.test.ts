/**
 * #2691 ratchet: a linter/formatter runner that computes `ctx.cwd` for its
 * availability probe and its config-detection helper, then spawns the
 * ACTUAL lint/analysis process without passing that same `cwd`, so the
 * child resolves project config (or, in psscriptanalyzer's case, a settings
 * file) against the extension host's `process.cwd()` instead of the
 * project being linted.
 *
 * #1731 fixed this shape for sqlfluff BY SYMBOL and missed five more
 * instances that a shape-based sweep found while fixing #2691's reported
 * yamllint case: ruff, spellcheck/typos, psscriptanalyzer, oxlint, and
 * shellcheck (the last two were not named in #2691 itself). A symbol-grep
 * for the next tool name will miss the next instance the same way. This
 * sweep instead walks every `safeSpawnAsync(`/`safeSpawnSync(` call site
 * directly under `clients/dispatch/runners/*.ts` and fails, by file:line,
 * on any whose OPTIONS OBJECT (the last top-level `{...}` in the call's
 * own argument list -- never the whole call text, see round 2 F1 below)
 * does not mention `cwd` at all -- catching the SHAPE (an omitted `cwd`
 * key) regardless of which tool's name appears at the call site.
 *
 * Round 2 review F1: the first version tested `\bcwd\b` against the WHOLE
 * call text (command + args array + options), not just the options
 * object. `spellcheck.ts`'s pre-fix call passed `ctx.cwd || process.cwd()`
 * as its FIRST argument (`typos.getCommand(ctx.cwd || process.cwd())`),
 * so the whole-call text already contained the substring "cwd" and the
 * sweep read it as conforming -- it never actually caught 1 of the 6
 * defects this PR fixes. Scoping the check to the LAST top-level `{...}`
 * (found by bracket-depth scanning, so a `{` inside the args array or a
 * string can never be mistaken for the options object) closes that hole:
 * `cwd` appearing anywhere BUT the options literal no longer satisfies
 * the sweep, and a value baked into the args array (e.g.
 * `path.resolve(cwd, ctx.filePath)`) is correctly still a violation.
 *
 * Round 2 review F2: `psscriptanalyzer.ts` routes every PowerShell spawn
 * through a local wrapper, `spawnPs`, so the only literal `safeSpawnAsync(`
 * call site the naive scan ever finds is INSIDE that wrapper -- and that
 * literal always names `cwd` (it's one of the wrapper's own parameters,
 * forwarded), regardless of whether any given CALLER of `spawnPs` actually
 * supplies one. Deleting the wrapper's `cwd` argument from one caller left
 * the sweep green.
 *
 * The fix generalizes, but narrowly: a locally-declared `function NAME(...)`
 * is swept as a wrapper ONLY when its OWN parameter list contains a
 * `{...}`-shaped parameter (a destructure or an inline object-type
 * annotation) that itself mentions `cwd` -- i.e. the function has DECLARED
 * "I take cwd via an options object", the exact representation a direct
 * `safeSpawnAsync(cmd, args, {cwd, ...})` call already uses. `spawnPs` was
 * converted to take that shape (`options: { timeoutMs?: number; cwd?:
 * string }`) specifically so ONE detection rule -- "does the last top-level
 * `{...}` in a call's own argument list name cwd" -- covers both direct
 * calls and wrapper calls without a second, positional-arg mode.
 *
 * This is deliberately narrower than "any function whose body contains a
 * safeSpawn* call, if also called elsewhere": an early version tried that
 * and produced false positives on `eslint.ts`'s `makeEslintProbe`,
 * `rust-clippy.ts`'s `makeClippyProbe`, `credo.ts`'s `probeCredo`,
 * `oxlint.ts`'s `resolveVitePlusCommand`, `cpp-check.ts`'s
 * `resolveCompiler`, `biome-check.ts`'s `resolveBiomeFixKinds`, and
 * `helm-lint.ts`/`helm-render.ts`'s chart helpers -- every one of these
 * takes `cwd` as a plain positional `string` parameter (or builds a probe
 * closure invoked with `cwd` later, per call, by shared cache machinery in
 * `utils/`), so their OWN call sites correctly have no trailing `{...}` at
 * all, and "no options object" is what a compliant plain-parameter call
 * looks like -- flagging it as "missing cwd" would be exactly backwards.
 * The options-shaped-parameter test excludes all of them: none of their
 * signatures has a `{...}` naming `cwd`, only `spawnPs` does. For a runner
 * with no such wrapper (every file but psscriptanalyzer.ts today), no
 * function's parameter list matches, so this generalization is a no-op.
 *
 * Scoped to direct children of `runners/` (not `runners/utils/*.ts`, the
 * shared availability-probe/installer helpers): several of those
 * deliberately omit `cwd` for a genuine global-PATH presence probe (e.g.
 * `runner-helpers.ts`'s "3. Global PATH" `safeSpawnAsync(toolName,
 * ["--version"], { timeout: 3000 })`), which is a different, legitimate
 * shape from a runner spawning an actual lint/analysis pass on a project
 * file. Widening this sweep into `utils/` would need its own exemption
 * design for that shape rather than borrowing this one.
 *
 * A call site that genuinely has no cwd to get wrong (a bare presence probe
 * with no file/config resolution, like cpp-check.ts's no-arg `cl` probe, or
 * psscriptanalyzer.ts's two interpreter/module presence probes) carries a
 * single-line `// cwd-exempt: <reason>` comment on the line DIRECTLY above
 * the call (other explanatory comments may sit above that, but the tag
 * line itself must be the one immediately preceding the call) -- the sweep
 * still fails if that exemption's call site now passes `cwd` anyway (a
 * redundant exemption).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	assertNonEmptyScan,
	findEnclosingSymbol,
	stripSource,
} from "../../../support/sweep-kit.js";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../../..",
);
const RUNNERS_DIR = path.join(REPO_ROOT, "clients/dispatch/runners");

const SPAWN_CALL_PATTERN = /\bsafeSpawn(?:Async|Sync)\s*\(/g;
const EXEMPT_TAG = /^\s*\/\/\s*cwd-exempt:\s*(.+)/;

interface CallSite {
	file: string;
	line: number;
	hasCwd: boolean;
	exemptReason?: string;
	/** Name of the call target -- `safeSpawnAsync`/`safeSpawnSync` for a
	 * direct call, or the wrapper's own name for a call routed through one. */
	callee: string;
}

/** Direct-child `.ts` runner files only -- never `utils/*.ts` (see header). */
function runnerFiles(): string[] {
	return fs
		.readdirSync(RUNNERS_DIR, { withFileTypes: true })
		.filter(
			(entry) =>
				entry.isFile() &&
				entry.name.endsWith(".ts") &&
				!entry.name.endsWith(".test.ts"),
		)
		.map((entry) => path.join(RUNNERS_DIR, entry.name))
		.sort();
}

function lineNumberAt(source: string, index: number): number {
	return source.slice(0, index).split("\n").length;
}

/** Index of the `)` matching the `(` at `openIdx`, scanned over
 * comment/string-blanked source so a literal paren inside a string, regex,
 * or comment can never desynchronize the count. */
function findMatchingClose(blanked: string, openIdx: number): number {
	let depth = 0;
	for (let i = openIdx; i < blanked.length; i++) {
		if (blanked[i] === "(") depth++;
		else if (blanked[i] === ")") {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

/**
 * Every TOP-LEVEL (not nested inside another `(`, `[`, or `{` within this
 * span) `{...}` object-literal span in `blanked[start..end]`, in source
 * order. A call's options object is conventionally its last argument, so
 * callers take the LAST span -- but every span is returned so a caller can
 * tell "no object literal at all" (empty array) from "found one, it just
 * doesn't name cwd" (round 2 F1: this is what lets the args-array case,
 * `path.resolve(cwd, ctx.filePath)`, stay correctly flagged -- `cwd` sits
 * in the array, not in any top-level `{}`, so it is invisible here on
 * purpose).
 */
function findTopLevelBraceSpans(
	blanked: string,
	start: number,
	end: number,
): Array<[number, number]> {
	const spans: Array<[number, number]> = [];
	let depth = 0;
	let braceStart = -1;
	for (let i = start; i <= end; i++) {
		const ch = blanked[i];
		if (ch === "(" || ch === "[" || ch === "{") {
			if (depth === 0 && ch === "{") braceStart = i;
			depth++;
		} else if (ch === ")" || ch === "]" || ch === "}") {
			depth--;
			if (depth === 0 && ch === "}" && braceStart !== -1) {
				spans.push([braceStart, i]);
				braceStart = -1;
			}
		}
	}
	return spans;
}

/** Whether the LAST top-level `{...}` in a call's own argument span names
 * `cwd` -- the options-object check every call site (direct or routed
 * through a wrapper) is held to. No top-level `{}` at all is a miss, not a
 * pass: a purely positional call has nowhere for `cwd` to live under this
 * repo's chosen convention (round 2 F2 picked the options-literal shape for
 * every spawn-routing wrapper, `spawnPs` included, specifically so this one
 * rule covers both direct and wrapper call sites). */
function hasCwdInLastOptions(
	raw: string,
	blanked: string,
	argsStart: number,
	argsEnd: number,
): boolean {
	const spans = findTopLevelBraceSpans(blanked, argsStart, argsEnd);
	if (spans.length === 0) return false;
	const [s, e] = spans[spans.length - 1];
	return /\bcwd\b/.test(raw.slice(s, e + 1));
}

function exemptReasonAbove(
	rawLines: readonly string[],
	line: number,
): string | undefined {
	return EXEMPT_TAG.exec(rawLines[line - 2] ?? "")?.[1]?.trim();
}

/**
 * Whether `name` is declared in this file as `function name(...)` with a
 * parameter list containing a top-level `{...}` span (a destructure or an
 * inline object-type annotation) that itself mentions `cwd` -- the
 * function has declared its OWN calling contract as "cwd travels through
 * an options object", the one representation this sweep's options-literal
 * check can verify at a call site. See the file header (round 2 F2) for
 * why this is the line between a genuine spawn-routing wrapper
 * (`spawnPs`) and an ordinary `cwd: string` positional helper.
 */
function hasOptionsShapedCwdParam(
	commentsBlanked: string,
	fullyBlanked: string,
	name: string,
): boolean {
	const declPattern = new RegExp(`\\bfunction\\s*\\*?\\s+${name}\\s*\\(`);
	const m = declPattern.exec(commentsBlanked);
	if (!m) return false; // not a plain `function NAME(...)` decl (e.g. const-bound)
	const parenOpen = m.index + m[0].length - 1;
	const parenClose = findMatchingClose(fullyBlanked, parenOpen);
	if (parenClose === -1) return false;
	const paramSpans = findTopLevelBraceSpans(
		fullyBlanked,
		parenOpen + 1,
		parenClose - 1,
	);
	return paramSpans.some(([s, e]) =>
		/\bcwd\b/.test(commentsBlanked.slice(s, e + 1)),
	);
}

/** Every call-shaped, non-declaration occurrence of `\bname(` in
 * `commentsBlanked`, each paired with its own balanced argument span. A
 * `function name(` DECLARATION is excluded (checked on the RAW line, since
 * `function` is a real keyword, never blanked) -- everything else naming
 * `name(` is treated as a call site of it. */
function findCallSitesOf(
	name: string,
	commentsBlanked: string,
	fullyBlanked: string,
): Array<{ index: number; openIdx: number; closeIdx: number }> {
	const pattern = new RegExp(`\\b${name}\\s*\\(`, "g");
	const results: Array<{ index: number; openIdx: number; closeIdx: number }> =
		[];
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(commentsBlanked))) {
		const before = commentsBlanked.slice(0, match.index);
		if (/function\s*\*?\s*$/.test(before)) continue; // its own declaration
		const openIdx = match.index + match[0].length - 1;
		const closeIdx = findMatchingClose(fullyBlanked, openIdx);
		if (closeIdx === -1) continue;
		results.push({ index: match.index, openIdx, closeIdx });
	}
	return results;
}

function scanFile(absPath: string): CallSite[] {
	const raw = fs.readFileSync(absPath, "utf8");
	const rawLines = raw.split("\n");
	// Comments blanked so a call written inside a comment is never counted;
	// strings kept so the options object's own text (and a wrapper name
	// appearing only in a string) reads correctly either way.
	const commentsBlanked = stripSource(raw, { strings: "keep" });
	// Comments AND strings blanked, purely to keep paren/brace-depth counting
	// from being thrown off by a stray bracket inside a string or regex.
	const fullyBlanked = stripSource(raw, { strings: "blank" });
	const relFile = path.relative(RUNNERS_DIR, absPath);

	const sites: CallSite[] = [];
	const wrapperNames = new Set<string>();

	const directPattern = new RegExp(SPAWN_CALL_PATTERN.source, "g");
	let match: RegExpExecArray | null;
	while ((match = directPattern.exec(commentsBlanked))) {
		const callee = match[0].slice(0, -1).trim(); // "safeSpawnAsync(" -> "safeSpawnAsync"
		const openIdx = match.index + match[0].length - 1;
		const closeIdx = findMatchingClose(fullyBlanked, openIdx);
		if (closeIdx === -1) continue; // malformed source; nothing to flag
		const line = lineNumberAt(raw, match.index);
		sites.push({
			file: relFile,
			line,
			hasCwd: hasCwdInLastOptions(raw, fullyBlanked, openIdx + 1, closeIdx - 1),
			exemptReason: exemptReasonAbove(rawLines, line),
			callee,
		});

		// Round 2 F2: the enclosing declaration of a direct call site may be a
		// local wrapper function rather than the runner's own top-level object
		// -- if its OWN parameter list is options-object-shaped and mentions
		// cwd, it has declared the same calling contract a direct safeSpawn*
		// call uses, so every OTHER call site of it in this file gets the
		// identical check (see header and hasOptionsShapedCwdParam).
		const enclosing = findEnclosingSymbol(rawLines, line - 1);
		if (
			enclosing &&
			hasOptionsShapedCwdParam(commentsBlanked, fullyBlanked, enclosing)
		) {
			wrapperNames.add(enclosing);
		}
	}

	for (const name of wrapperNames) {
		for (const call of findCallSitesOf(name, commentsBlanked, fullyBlanked)) {
			const line = lineNumberAt(raw, call.index);
			sites.push({
				file: relFile,
				line,
				hasCwd: hasCwdInLastOptions(
					raw,
					fullyBlanked,
					call.openIdx + 1,
					call.closeIdx - 1,
				),
				exemptReason: exemptReasonAbove(rawLines, line),
				callee: name,
			});
		}
	}

	return sites;
}

describe("dispatch runner spawns pass ctx.cwd (#2691 ratchet)", () => {
	const files = runnerFiles();
	assertNonEmptyScan(
		"runner-spawn-cwd-sweep: clients/dispatch/runners/*.ts files scanned",
		files.length,
		// 52 direct-child .ts files measured 2026-09-07; half rounded down.
		25,
	);

	const allSites = files.flatMap(scanFile);
	assertNonEmptyScan(
		"runner-spawn-cwd-sweep: safeSpawnAsync/safeSpawnSync/wrapper call sites found",
		allSites.length,
		// 57 sites measured 2026-09-07 (54 direct safeSpawnAsync/safeSpawnSync
		// calls + 3 psscriptanalyzer.ts spawnPs(...) wrapper call sites); half
		// rounded down.
		25,
	);

	it("every non-exempt spawn's options literal names cwd", () => {
		const missing = allSites.filter((s) => !s.hasCwd && !s.exemptReason);
		expect(
			missing,
			`${missing.length} spawn(s) under clients/dispatch/runners/*.ts have no ` +
				"`cwd` in their OPTIONS OBJECT (the last top-level {...} in the " +
				"call's own argument list), so the child resolves project config " +
				"against the extension host's process.cwd() instead of ctx.cwd " +
				"(#2691's yamllint shape). Pass `cwd` in that options object (or add " +
				"a `// cwd-exempt: <reason>` comment on the line above the call if " +
				"it genuinely has no file/config to resolve):\n" +
				missing.map((s) => `  ${s.file}:${s.line} (${s.callee})`).join("\n"),
		).toHaveLength(0);
	});

	it("every cwd-exempt marker still names a real, still-exempt call site", () => {
		const exemptSites = allSites.filter((s) => s.exemptReason);
		const staleOrRedundant = exemptSites.filter((s) => s.hasCwd);
		expect(
			staleOrRedundant,
			"the following `// cwd-exempt:` markers sit above a call that " +
				"already passes cwd -- the exemption is redundant, remove it:\n" +
				staleOrRedundant
					.map((s) => `  ${s.file}:${s.line} (${s.exemptReason})`)
					.join("\n"),
		).toHaveLength(0);
		for (const site of exemptSites) {
			expect(
				(site.exemptReason ?? "").length,
				`${site.file}:${site.line}'s cwd-exempt comment needs a real reason`,
			).toBeGreaterThanOrEqual(15);
		}
	});
});
