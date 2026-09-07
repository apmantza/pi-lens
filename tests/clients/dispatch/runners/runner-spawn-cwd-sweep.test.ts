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
 * on any whose options object literal does not mention `cwd` at all --
 * catching the SHAPE (an omitted `cwd` key) regardless of which tool's
 * name appears at the call site.
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
 * with no file/config resolution, like cpp-check.ts's no-arg `cl` probe)
 * carries a single-line `// cwd-exempt: <reason>` comment on the line
 * DIRECTLY above the call (other explanatory comments may sit above that,
 * but the tag line itself must be the one immediately preceding the call) --
 * the sweep still fails if that exemption's call site now passes `cwd`
 * anyway (a redundant exemption).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertNonEmptyScan, stripSource } from "../../../support/sweep-kit.js";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../../..",
);
const RUNNERS_DIR = path.join(REPO_ROOT, "clients/dispatch/runners");

const CALL_PATTERN = /\bsafeSpawn(?:Async|Sync)\s*\(/g;
const EXEMPT_TAG = /^\s*\/\/\s*cwd-exempt:\s*(.+)/;

interface CallSite {
	file: string;
	line: number;
	hasCwd: boolean;
	exemptReason?: string;
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

/** Index of the `)` matching the `(` at `openIdx`, scanned over string/regex/
 * comment-blanked source so a literal paren inside a string or regex can
 * never desynchronize the count. */
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

function scanFile(absPath: string): CallSite[] {
	const raw = fs.readFileSync(absPath, "utf8");
	const rawLines = raw.split("\n");
	// Comments blanked so a call written inside a comment is never counted;
	// strings kept so an options object nested inside a template/string arg
	// still reads as itself for the `cwd` text check below.
	const commentsBlanked = stripSource(raw, { strings: "keep" });
	// Comments AND strings blanked, purely to keep paren-depth counting from
	// being thrown off by a stray `(`/`)` inside a string or regex literal.
	const fullyBlanked = stripSource(raw, { strings: "blank" });
	const relFile = path.relative(RUNNERS_DIR, absPath);

	const sites: CallSite[] = [];
	const pattern = new RegExp(CALL_PATTERN.source, "g");
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(commentsBlanked))) {
		const openIdx = match.index + match[0].length - 1;
		const closeIdx = findMatchingClose(fullyBlanked, openIdx);
		if (closeIdx === -1) continue; // malformed source; nothing to flag
		const argsText = raw.slice(openIdx, closeIdx + 1);
		const hasCwd = /\bcwd\b/.test(argsText);
		const line = lineNumberAt(raw, match.index);
		const exemptMatch = EXEMPT_TAG.exec(rawLines[line - 2] ?? "");
		sites.push({
			file: relFile,
			line,
			hasCwd,
			exemptReason: exemptMatch?.[1]?.trim(),
		});
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
		"runner-spawn-cwd-sweep: safeSpawnAsync/safeSpawnSync call sites found",
		allSites.length,
		// 54 call sites measured 2026-09-07; half rounded down.
		25,
	);

	it("every non-exempt spawn's options literal names cwd", () => {
		const missing = allSites.filter((s) => !s.hasCwd && !s.exemptReason);
		expect(
			missing,
			`${missing.length} spawn(s) under clients/dispatch/runners/*.ts have no ` +
				"`cwd` in their options literal, so the child resolves project " +
				"config against the extension host's process.cwd() instead of " +
				"ctx.cwd (#2691's yamllint shape). Pass `cwd` (or add a `// " +
				"cwd-exempt: <reason>` comment on the line above the call if it " +
				"genuinely has no file/config to resolve):\n" +
				missing.map((s) => `  ${s.file}:${s.line}`).join("\n"),
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
