/**
 * #2691 ratchet (AGENTS.md defect shape 40): a linter/formatter runner that
 * computes `ctx.cwd` for its availability probe and its config-detection
 * helper, then spawns the ACTUAL lint/analysis process without passing that
 * same `cwd`, so the child resolves project config (or, for psscriptanalyzer,
 * a settings file) against the extension host's `process.cwd()` instead of the
 * project being linted — while the runner's own `hasXConfig(ctx.cwd)` gate
 * says the project config was found.
 *
 * #1731 fixed this shape for sqlfluff BY SYMBOL and missed five more instances
 * that a shape-based sweep found while fixing #2691's reported yamllint case:
 * ruff, spellcheck/typos, psscriptanalyzer, oxlint and shellcheck. A
 * symbol-grep for the next tool name will miss the next instance the same way,
 * so this sweeps the SHAPE across every runner at once.
 *
 * ## What this file is, and what it is not
 *
 * The detection itself lives in `tests/support/spawn-cwd-scan.ts` and is
 * specified cell by cell in `tests/support/spawn-cwd-scan.test.ts` — one named
 * fixture per cell of PR #2693's "Detector state space (round 3)" table (call-
 * site kind × where a `cwd` token can sit). THIS file is the integration
 * assertion: it runs that scan over the live tree.
 *
 * The split is the round-3 lesson. Rounds 1 and 2 had only the live-tree run,
 * which can assert nothing about the cells today's tree does not occupy — so
 * round 1 shipped a detector that read argument one as the options object
 * (missing one of the six defects its own red block claimed to prove), and
 * round 2 shipped one that read a comment or a string value inside the braces
 * as a passed cwd, and whose wrapper rule never followed `helm-lint.ts`'s
 * `lintChart` or `helm-render.ts`'s `renderAndValidate`. Both went green here
 * the whole time.
 *
 * ## The two rules, in one line each
 *
 * A site conforms when the options literal has a PROPERTY NAMED `cwd`; a
 * same-file function is a spawn-routing wrapper when a spawn's `cwd` value
 * resolves to one of that function's OWN parameters, and then its CALLERS are
 * the sites checked. Both are answered off the real AST (`@ast-grep/napi`, the
 * same dependency `tests/support/availability-gate.ts` uses), never off text.
 *
 * ## Scope
 *
 * Direct children of `clients/dispatch/runners/` only, never `runners/utils/`:
 * several helpers there deliberately omit `cwd` for a genuine global-PATH
 * presence probe (`runner-helpers.ts`'s "3. Global PATH"
 * `safeSpawnAsync(toolName, ["--version"], { timeout: 3000 })`), a different
 * and legitimate shape from a runner spawning an analysis pass on a project
 * file. Widening into `utils/` needs its own exemption design rather than
 * borrowing this one.
 *
 * A call site that genuinely has no cwd to get wrong carries a single-line
 * `// cwd-exempt: <reason>` comment on the line DIRECTLY above the call (other
 * explanatory comments may sit above that; the tag line itself must be the one
 * immediately preceding), and the reason has to be a real one — a tag under
 * 15 characters of reason exempts nothing, which the scan decides so a fixture
 * can prove it. The sweep additionally fails on an exemption whose call site
 * now passes `cwd` anyway, so a stale exemption cannot rot in place.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
	type SpawnCwdSite,
	type SpawnCwdWrapper,
	scanSpawnCwd,
} from "../../../support/spawn-cwd-scan.js";
import { assertNonEmptyScan } from "../../../support/sweep-kit.js";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../../..",
);
const RUNNERS_DIR = path.join(REPO_ROOT, "clients/dispatch/runners");

/**
 * The exact population, measured 2026-09-07. These are pinned, not floored:
 * round 2 declared an emptiness floor of 25 against 58 live sites, and a floor
 * that loose is one-sided — it catches a sweep that goes dead but not one that
 * quietly stops SEEING sites. Reverting `spawnPs` to positional arguments, or
 * reintroducing round 1's wrapper blindness, each drops three or more sites
 * with every remaining site still conforming, so a floor stays green while the
 * ratchet's reach shrinks (round-2 review F3).
 *
 * **These are the numbers to bump when you add or remove a runner spawn.** A
 * new `safeSpawnAsync`/`safeSpawnSync` call, or a new call site of one of the
 * wrappers below, moves `EXPECTED_SITES` by one; a new runner file moves
 * `EXPECTED_FILES`. Bumping them is the whole cost, and it is deliberate: the
 * bump is where a reviewer sees a spawn was added.
 */
const EXPECTED_FILES = 52;
const EXPECTED_DIRECT_SITES = 54;
const EXPECTED_WRAPPER_SITES = 8;
const EXPECTED_SITES = EXPECTED_DIRECT_SITES + EXPECTED_WRAPPER_SITES;

/**
 * Every same-file spawn-routing wrapper the scan discovers, with the parameter
 * it routes `cwd` through. Pinned as a LIST, not a count, because the list is
 * the part round 2 got wrong: it claimed "spawnPs and runIacPass are the two
 * existing local wrappers" while `lintChart`, `renderAndValidate`,
 * `resolveVitePlusCommand` and `resolveBiomeFixKinds` all route a positional
 * cwd into a spawn and had their callers unchecked.
 *
 * `resolveVitePlusCommand` and `resolveBiomeFixKinds` were named in round 2's
 * own header as positional-cwd helpers that must NOT be followed; that
 * justification was wrong on its face — each puts its own `cwd` parameter into
 * a spawn's options literal, which is exactly what makes a wrapper — and both
 * are correctly followed now. The genuine non-wrappers are the probe closures
 * (`makeEslintProbe`, `probeCredo`, `makeClippyProbe`, `resolveCompiler`),
 * whose `cwd` is bound by an ANONYMOUS arrow that `createCwdCachedProbe`
 * invokes per call — no caller in the file supplies it, so there is no caller
 * to check.
 */
const EXPECTED_WRAPPERS = [
	"biome-check.ts::resolveBiomeFixKinds:positional@1",
	"helm-lint.ts::lintChart:positional@1",
	"helm-render.ts::renderAndValidate:positional@1",
	"helm-render.ts::runIacPass:options@0",
	"oxlint.ts::resolveVitePlusCommand:positional@0",
	"psscriptanalyzer.ts::spawnPs:options@2",
];

/** Direct-child `.ts` runner files only — never `utils/*.ts` (see header). */
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
		.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

describe("dispatch runner spawns pass ctx.cwd (#2691 ratchet)", () => {
	const files = runnerFiles();
	let sites: SpawnCwdSite[] = [];
	let wrappers: string[] = [];

	beforeAll(async () => {
		for (const file of files) {
			const relFile = path.relative(RUNNERS_DIR, file);
			const scan = await scanSpawnCwd(relFile, fs.readFileSync(file, "utf8"));
			sites.push(...scan.sites);
			wrappers.push(
				...scan.wrappers.map(
					(w: SpawnCwdWrapper) =>
						`${relFile}::${w.name}:${w.mode}@${w.paramIndex}`,
				),
			);
		}
		// Explicit, locale-independent comparator: this list is compared against
		// EXPECTED_WRAPPERS by identity (SonarCloud S2871).
		wrappers = wrappers.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
	});

	it("scans the whole runner directory and finds the pinned population", () => {
		// The emptiness guard first (defect shape 10, #1718): a sweep that
		// matched nothing must fail, not read as clean.
		assertNonEmptyScan(
			"runner-spawn-cwd-sweep: clients/dispatch/runners/*.ts files scanned",
			files.length,
		);
		assertNonEmptyScan(
			"runner-spawn-cwd-sweep: spawn and wrapper call sites found",
			sites.length,
		);
		expect(files.length, "runner files under clients/dispatch/runners").toBe(
			EXPECTED_FILES,
		);
		expect(
			sites.filter((site) => site.kind === "direct").length,
			"direct safeSpawnAsync/safeSpawnSync call sites",
		).toBe(EXPECTED_DIRECT_SITES);
		expect(
			sites.filter((site) => site.kind === "wrapper").length,
			"call sites of same-file spawn-routing wrappers",
		).toBe(EXPECTED_WRAPPER_SITES);
		expect(sites.length, "total checked call sites").toBe(EXPECTED_SITES);
	});

	it("discovers exactly the known spawn-routing wrappers", () => {
		expect(
			wrappers,
			"a wrapper that disappears from this list has stopped being followed, " +
				"and its callers are no longer checked -- that is round 2's F2 " +
				"regressing. A wrapper that appears is a new spawn-routing helper: " +
				"confirm its callers are checked at the right parameter, then add it.",
		).toEqual(EXPECTED_WRAPPERS);
	});

	it("every non-exempt spawn's options object names cwd", () => {
		const missing = sites.filter((site) => !site.hasCwd && !site.exemptReason);
		expect(
			missing,
			`${missing.length} spawn(s) under clients/dispatch/runners/*.ts do not ` +
				"pass a `cwd`, so the child resolves project config against the " +
				"extension host's process.cwd() instead of ctx.cwd (#2691's yamllint " +
				"shape, AGENTS.md defect shape 40). For a direct call, add `cwd` to " +
				"the options object; for a call routed through a same-file wrapper, " +
				"pass a cwd-bearing argument at the wrapper's cwd parameter. If the " +
				"call genuinely has no file or config to resolve, add a " +
				"`// cwd-exempt: <reason>` comment on the line directly above it:\n" +
				missing
					.map((site) => `  ${site.file}:${site.line} (${site.callee})`)
					.join("\n"),
		).toHaveLength(0);
	});

	it("every cwd-exempt marker still names a real, still-exempt call site", () => {
		const exemptSites = sites.filter((site) => site.exemptReason);
		assertNonEmptyScan(
			"runner-spawn-cwd-sweep: cwd-exempt markers found",
			exemptSites.length,
		);
		const redundant = exemptSites.filter((site) => site.hasCwd);
		expect(
			redundant,
			"the following `// cwd-exempt:` markers sit above a call that already " +
				"passes cwd -- the exemption is redundant, remove it:\n" +
				redundant
					.map((site) => `  ${site.file}:${site.line} (${site.exemptReason})`)
					.join("\n"),
		).toHaveLength(0);
	});
});
