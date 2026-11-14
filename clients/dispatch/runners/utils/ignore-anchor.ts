/**
 * #5594: detekt, phpstan and credo match the ignore globs of the project's own
 * config against the ABSOLUTE path of the file, and each turns the config's
 * globs into absolute patterns itself, so no argv spelling avoids the match. A
 * project checked out under `<root>/.claude/worktrees/<lane>` whose config
 * ignores `**\/.claude/**` was therefore excluded from its own analysis: the
 * tool printed nothing, and the runner reported a clean file it never read.
 *
 * This module is the one owner of the cure: a generated copy of the project's
 * config in which every ignore glob is anchored at the project root, so it can
 * only match what lies UNDER the root. The user's own ignore list is kept (each
 * entry is rewritten, never dropped), and the project's tree is never written:
 * the copy lives in a scratch directory that goes away on every exit path.
 *
 * `**\/X` read "X at any depth, below any prefix", and the prefix is the part
 * that wrongly reached the ancestors. The anchored form is two patterns,
 * `<root>/X` (no directory in between) and `<root>/**\/X`, because the second
 * needs at least one separator after the root.
 *
 * ## When the rewrite cannot apply
 *
 * A pattern this module does not recognise (a `regex:` matcher, a leading
 * brace group), a config it cannot read, or a tool that cannot say what it
 * resolved, leaves the rewrite undone. The runner then runs the tool on the
 * original config, exactly as before, and {@link markUnanchored} makes sure a
 * clean answer from that run is never reported as one: it is `inconclusive`,
 * with one bounded `runner-ignore-unanchored` record per tool. Findings the
 * tool did print stay, since an ignore glob can only hide findings, never
 * invent them.
 *
 * Does not prove: Windows (the root is written with forward slashes, which both
 * Java's glob and PHP's fnmatch read as the separator there, but no Windows
 * binary was run).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { incrementDegradationCount } from "../../../degradation-ledger.js";
import { toPosix } from "../../../path-utils.js";
import { scannerReportParentDir } from "../../../scanner-temp-root.js";
import type { RunnerResult } from "../../types.js";

/**
 * The two glob dialects the three tools speak. `java-glob` is
 * `FileSystems.getPathMatcher("glob:…")` (detekt): `*` stops at a separator,
 * `**` crosses it. `fnmatch` is PHP's `fnmatch()` without `FNM_PATHNAME`
 * (phpstan): `*` crosses a separator, so `**` and `*` are one wildcard.
 */
export type IgnoreGlobDialect = "java-glob" | "fnmatch";

/** `\` before every character either dialect gives a meaning. */
function escapeGlobLiteral(literal: string): string {
	return literal.replace(/[\\*?[\]{}]/g, "\\$&");
}

/** The root as a glob literal: forward slashes, no trailing separator. */
function globRoot(root: string): string {
	const slashed = toPosix(root);
	const trimmed = slashed.length > 1 ? slashed.replace(/\/+$/, "") : slashed;
	return escapeGlobLiteral(trimmed);
}

function isAbsolutePattern(pattern: string): boolean {
	return pattern.startsWith("/") || /^[A-Za-z]:[\\/]/.test(pattern);
}

/**
 * Root-anchored form of one ignore pattern, or `null` when this module does not
 * recognise the pattern. A gate that decides a verdict admits known forms and
 * refuses the rest, so an unknown spelling is `null`, never a pass-through:
 *
 * - `**\/X` (java-glob) and `*\/X`, `*X` (fnmatch): the anchored rewrite above.
 * - an absolute pattern: already anchored, kept.
 * - a relative pattern that starts with a name character (`.claude/**`,
 *   `src/gen`): it cannot match an absolute path, so it never reached the
 *   ancestors, kept.
 * - java-glob only: a `glob:` prefix is dropped (it is the default syntax); any
 *   other `syntax:` prefix (`regex:`) is not a glob and is refused.
 */
export function anchorIgnorePattern(
	pattern: string,
	root: string,
	dialect: IgnoreGlobDialect,
): string[] | null {
	let rest = pattern;
	if (dialect === "java-glob") {
		if (rest.startsWith("glob:")) rest = rest.slice("glob:".length);
		else if (/^[A-Za-z][A-Za-z0-9+.-]+:/.test(rest)) return null;
	}
	if (rest.length === 0) return null;
	if (isAbsolutePattern(rest)) return [rest];
	const anchor = globRoot(root);
	if (dialect === "java-glob") {
		if (rest.startsWith("**/")) {
			const tail = rest.slice(3);
			if (tail.length === 0 || tail.startsWith("/")) return null;
			return [`${anchor}/${tail}`, `${anchor}/**/${tail}`];
		}
		return /^[A-Za-z0-9_.-]/.test(rest) ? [rest] : null;
	}
	if (rest.startsWith("*")) {
		const lead = /^\*+\/(.+)$/.exec(rest);
		if (lead) return [`${anchor}/${lead[1]}`, `${anchor}/*/${lead[1]}`];
		return [`${anchor}/${rest}`];
	}
	return null;
}

/** Anchor a list; one unrecognised entry refuses the whole list. */
export function anchorIgnorePatterns(
	patterns: readonly string[],
	root: string,
	dialect: IgnoreGlobDialect,
): { patterns: string[] } | { unrecognized: string } {
	const out: string[] = [];
	for (const pattern of patterns) {
		const anchored = anchorIgnorePattern(pattern, root, dialect);
		if (anchored === null) return { unrecognized: pattern };
		for (const entry of anchored) if (!out.includes(entry)) out.push(entry);
	}
	return { patterns: out };
}

/**
 * The generated config's result: nothing to rewrite (the original config is
 * already safe to hand the tool), the text of the rewritten config, or the
 * reason it cannot be rewritten.
 */
export type AnchoredConfig =
	| { kind: "unchanged" }
	| { kind: "rewritten"; text: string }
	| { kind: "unapplied"; reason: string };

/**
 * The text of the project config the seam found, or the reason it cannot be
 * read. The read lives here, not in a runner, so a runner stays a caller of the
 * config seam; an unreadable config is `unapplied`, which {@link markUnanchored}
 * records and which withholds the clean verdict.
 */
export function readConfigText(
	tool: string,
	file: string,
): { kind: "read"; text: string } | { kind: "unapplied"; reason: string } {
	try {
		return { kind: "read", text: fs.readFileSync(file, "utf8") };
	} catch (err) {
		// none: the failure is returned as `unapplied`, and the runner's `markUnanchored` records it and withholds the clean verdict.
		return {
			kind: "unapplied",
			reason: `its ${tool} config is unreadable (${(err as NodeJS.ErrnoException).code ?? "read failed"})`,
		};
	}
}

/**
 * Write `text` to `<scratch>/<fileName>`, hand the path to `use`, and remove the
 * scratch directory on every exit path. One directory per run: two dispatches of
 * one project never share a file, so neither can delete the other's. The parent
 * is the shared scanner scratch root (`scannerReportParentDir`), so a harness
 * that sweeps it also sweeps an orphan this leaves behind.
 */
export async function withOverlayFile<T>(
	tool: string,
	fileName: string,
	text: string,
	use: (file: string) => Promise<T>,
): Promise<T> {
	const dir = fs.mkdtempSync(
		path.join(scannerReportParentDir(), `pi-lens-${tool}-anchor-`),
	);
	try {
		const tmpFile = path.join(dir, fileName);
		fs.writeFileSync(tmpFile, text);
		return await use(tmpFile);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * The verdict for a run whose ignore globs could not be anchored. The tool ran
 * on the original config, so a finding it printed is real and stays; a clean
 * answer is not a verdict, because the config may have excluded the file under
 * its ancestors, so it is `inconclusive`. One `runner-ignore-unanchored` record
 * per tool names the reason.
 */
export function markUnanchored(
	tool: string,
	reason: string,
	result: RunnerResult,
): RunnerResult {
	incrementDegradationCount({
		kind: "runner-ignore-unanchored",
		subject: tool,
		reason: `${tool} ran on the project's own config: ${reason}`,
	});
	if (result.status === "succeeded" && result.diagnostics.length === 0) {
		return { ...result, inconclusive: true };
	}
	return result;
}
