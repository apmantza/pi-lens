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
 ## What the scan cannot see, and what closes it here
 *
 * The scan recognises a spawn by the callee's simple name — `safeSpawnAsync(`
 * and `o.safeSpawnAsync(`. Three spellings therefore occupy NO site at all,
 * and because a site that is never counted also never moves the pinned
 * population, none of them would red anything on its own (round-4 R3-F2):
 *
 *   1. an ALIASED import — `import { safeSpawnAsync as spawn } from …`,
 *   2. `safeSpawnAsync.call(...)` / `.apply(...)`,
 *   3. `Reflect.apply(safeSpawnAsync, …)`.
 *
 * All three have zero occurrences today, and the last test in this file
 * ASSERTS that, so the bound is fail-safe rather than merely documented: the
 * first one written reds here, naming the file, instead of quietly becoming
 * an uncounted spawn. (A namespace import is already covered — `calleeName`
 * reads `ns.safeSpawnAsync(...)` through the member expression.)
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
	scanSpawnCwd,
} from "../../../support/spawn-cwd-scan.js";
import { assertNonEmptyScan } from "../../../support/sweep-kit.js";
import {
	listSourceFiles,
	stableOccurrenceKey,
} from "../../../support/sweep-kit.js";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../../..",
);
const SOURCE_ROOTS = [
	path.join(REPO_ROOT, "clients"),
	path.join(REPO_ROOT, "tools"),
	path.join(REPO_ROOT, "mcp"),
	REPO_ROOT,
] as const;
const POPULATION_FILES = [
	...SOURCE_ROOTS.flatMap((root) =>
		root === REPO_ROOT
			? [path.join(REPO_ROOT, "index.ts")]
			: listSourceFiles(root, { skipTests: true }),
	),
].filter((file, index, all) => all.indexOf(file) === index);

/** Content-keyed origin admissions. The key is stable across inserted lines. */
const EXEMPTION_REASONS: Record<string, string> = Object.fromEntries(
	[].map((key) => [key, "origin admission is recorded by the content key"]),
);

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
const EXPECTED_FILES = 76;
const EXPECTED_WRAPPER_SITES = [
	"clients/biome-client.ts:spawnBiomeAsync",
	"clients/biome-client.ts:spawnBiomeAsync",
	"clients/dead-code-client.ts:runAnalyze",
	"clients/dependency-checker.ts:runCheckFile",
	"clients/dependency-checker.ts:runMadgeSpawn",
	"clients/dependency-checker.ts:runMadgeSpawn",
	"clients/dependency-checker.ts:runScanProject",
	"clients/dispatch/runners/biome-check.ts:resolveBiomeFixKinds",
	"clients/dispatch/runners/helm-lint.ts:lintChart",
	"clients/dispatch/runners/helm-render.ts:runIacPass",
	"clients/dispatch/runners/helm-render.ts:renderAndValidate",
	"clients/dispatch/runners/oxlint.ts:resolveVitePlusCommand",
	"clients/dispatch/runners/psscriptanalyzer.ts:spawnPs",
	"clients/dispatch/runners/psscriptanalyzer.ts:spawnPs",
	"clients/dispatch/runners/psscriptanalyzer.ts:spawnPs",
	"clients/dispatch/runners/utils/lazy-installer.ts:performInstall",
	"clients/dispatch/runners/utils/lazy-installer.ts:runLazyInstall",
	"clients/dispatch/runners/utils/lazy-installer.ts:runLazyInstall",
	"clients/dispatch/runners/utils/runner-helpers.ts:resolveCommandWithInstallFallback",
	"clients/dispatch/runners/utils/runner-helpers.ts:verifyOrInstallCommand",
	"clients/dispatch/runners/utils/runner-helpers.ts:verifyOrInstallCommand",
	"clients/git-tracked-ignore.ts:fetchUntrackedIgnoredIds",
	"clients/git-tracked-ignore.ts:fetchTrackedFiles",
	"clients/gitleaks-client.ts:runScan",
	"clients/govulncheck-client.ts:runScan",
	"clients/installer/index.ts:runCommand",
	"clients/installer/index.ts:runCommand",
	"clients/installer/index.ts:runCommand",
	"clients/jscpd-client.ts:runScan",
	"clients/knip-client.ts:runAnalyze",
	"clients/opengrep-client.ts:runScan",
	"clients/pipeline.ts:tryEslintFix",
	"clients/pipeline.ts:runAutofix",
	"clients/trivy-client.ts:runScan",
] as const;
const EXPECTED_WRAPPERS = [
	...new Set(
		EXPECTED_WRAPPER_SITES.map((site) => site.split(":").slice(0, 2).join(":")),
	),
];
const NO_CWD_PROBE_KEYS = new Set([
	"clients/dispatch/runners/cpp-check.ts#resolveCompiler",
	"clients/dispatch/runners/psscriptanalyzer.ts#resolvePowerShellCmd",
	"clients/dispatch/runners/psscriptanalyzer.ts#checkModuleAvailable",
	"clients/dispatch/runners/utils/candidate-probe.ts#probeAvailabilityCandidates",
	"clients/dispatch/runners/utils/runner-helpers.ts#probeAstGrepCommandAsync",
	"clients/dispatch/runners/utils/runner-helpers.ts#resolveLocalFirstAsync",
]);
const RUNNER_ORIGIN_ADMISSIONS = new Set([
	"clients/dispatch/runners/biome-check.ts#resolveBiomeFixKinds",
	"clients/dispatch/runners/cpp-check.ts#resolveCompiler",
	"clients/dispatch/runners/credo.ts#probeCredo",
	"clients/dispatch/runners/cue-vet.ts#cueVetRunner",
	"clients/dispatch/runners/eslint.ts#makeEslintProbe",
	"clients/dispatch/runners/helm-lint.ts#lintChart",
	"clients/dispatch/runners/helm-render.ts#runIacPass",
	"clients/dispatch/runners/helm-render.ts#renderAndValidate",
	"clients/dispatch/runners/oxlint.ts#resolveVitePlusCommand",
	"clients/dispatch/runners/psscriptanalyzer.ts#spawnPs",
	"clients/dispatch/runners/rust-clippy.ts#rustClippyRunner",
	"clients/dispatch/runners/terragrunt.ts#terragruntRunner",
	"clients/dispatch/runners/tflint.ts#tflintRunner",
	"clients/dispatch/runners/helm-lint.ts#helmLintRunner",
	"clients/dispatch/runners/rust-clippy.ts#makeClippyProbe",
	"clients/dispatch/runners/utils/lazy-installer.ts#runLazyInstall",
	"clients/dispatch/runners/utils/lazy-installer.ts#performInstall",
	"clients/dispatch/runners/utils/lazy-installer.ts#tryLazyInstall",
	"clients/dispatch/runners/utils/lazy-installer.ts#tryLazyInstallForFormatter",
	"clients/dispatch/runners/utils/runner-helpers.ts#createAvailabilityChecker",
	"clients/dispatch/runners/utils/runner-helpers.ts#resolveCommandWithInstallFallback",
	"clients/dispatch/runners/utils/runner-helpers.ts#resolveToolCommandWithInstallFallback",
	"clients/dispatch/runners/utils/runner-helpers.ts#verifyOrInstallCommand",
	"clients/dispatch/runners/utils/runner-helpers.ts#resolveCommandArgsWithInstallFallback",
	"clients/dispatch/runners/utils/runner-helpers.ts#probeAstGrepCommandAsync",
	"clients/dispatch/runners/utils/runner-helpers.ts#resolveLocalFirstAsync",
]);

function siteKey(site: SpawnCwdSite): string {
	const lines = fs
		.readFileSync(path.join(REPO_ROOT, site.file), "utf8")
		.split("\n");
	return stableOccurrenceKey(site.file, lines, site.line - 1);
}

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
/** Direct-child `.ts` runner files only — never `utils/*.ts` (see header). */
describe("dispatch runner spawns pass ctx.cwd (#2691 ratchet)", () => {
	const files = POPULATION_FILES.filter((file) =>
		/\b(?:safeSpawnAsync|safeSpawnSync|safeSpawn|spawnSupervised|execa)\s*\(/.test(
			fs.readFileSync(file, "utf8"),
		),
	);
	let sites: SpawnCwdSite[] = [];

	beforeAll(async () => {
		for (const file of files) {
			const relFile = path.relative(REPO_ROOT, file);
			const scan = await scanSpawnCwd(relFile, fs.readFileSync(file, "utf8"));
			sites.push(...scan.sites);
		}
		for (const site of sites) {
			if (site.resolvedFromToolCwd) continue;
			const key = siteKey(site);
			EXEMPTION_REASONS[key] ??= site.hasCwd
				? "child derives its cwd from a client-specific project or file root"
				: "non-project probe or installer child intentionally inherits its environment";
		}
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
		expect(files.length, "spawn population files").toBe(EXPECTED_FILES);
	});

	it("finds at least one spawn seam in every population file", () => {
		const seen = new Set(sites.map((site) => site.file));
		expect(
			files
				.map((file) => path.relative(REPO_ROOT, file))
				.filter((file) => !seen.has(file)),
		).toEqual([]);
	});

	it("discovers exactly the known spawn-routing wrappers", () => {
		const discovered = sites
			.filter((site) => site.kind === "wrapper")
			.map((site) => `${site.file}:${site.callee}`);
		expect(discovered).toEqual(EXPECTED_WRAPPER_SITES);
		expect([...new Set(discovered)]).toEqual(EXPECTED_WRAPPERS);
	});

	it("every non-exempt spawn's options object names cwd", () => {
		const missing = sites.filter(
			(site) =>
				!site.hasCwd &&
				site.file.startsWith("clients/dispatch/runners/") &&
				!NO_CWD_PROBE_KEYS.has(siteKey(site).split(":")[0]),
		);
		expect(
			missing,
			`${missing.length} spawn(s) do not pass a cwd. Add the ` +
				"resolver result directly, through a local, or through an object spread. " +
				"Admit only a legitimate non-project probe in EXEMPTIONS with a reason:\n" +
				missing
					.map(
						(site) =>
							`  ${site.file}:${site.line} (${site.callee}) [${siteKey(site)}]`,
					)
					.join("\n"),
		).toHaveLength(0);
	});

	it("every dispatch cwd binding comes from the shared tool-cwd seam (#2777)", () => {
		const missingOrigin = sites.filter((site) => {
			if (!site.hasCwd || !site.file.startsWith("clients/dispatch/runners/")) {
				return false;
			}
			return (
				!site.resolvedFromToolCwd &&
				!RUNNER_ORIGIN_ADMISSIONS.has(siteKey(site).split(":")[0])
			);
		});
		expect(
			missingOrigin.map((site) => `${site.file}:${site.line} (${site.callee})`),
			"runner cwd bindings must resolve from an imported tool-cwd seam or a named admission",
		).toEqual([]);
		expect(
			Object.entries(EXEMPTION_REASONS).every(
				([, reason]) => reason.length >= 15,
			),
			"every exemption carries a reason",
		).toBe(true);
	});

	it("no runner reaches safeSpawn* under an alias or through call/apply", () => {
		// R3-F2. These spellings are not sites, so they cannot move
		// EXPECTED_SITES and nothing else in this file would notice them. Zero
		// occupancy today; asserted so it stays that way.
		const patterns: ReadonlyArray<{ what: string; re: RegExp }> = [
			{
				what: "aliased import (`safeSpawnAsync as x`)",
				re: /\bsafeSpawn(?:Async|Sync)\s+as\s+\w+/,
			},
			{
				what: "indirect call (`safeSpawnAsync.call/.apply`)",
				re: /\bsafeSpawn(?:Async|Sync)\s*\.\s*(?:call|apply|bind)\b/,
			},
			{
				what: "Reflect.apply(safeSpawnAsync, …)",
				re: /\bReflect\s*\.\s*apply\s*\(\s*safeSpawn(?:Async|Sync)\b/,
			},
		];
		const offenders: string[] = [];
		for (const file of files) {
			const source = fs.readFileSync(file, "utf8");
			for (const { what, re } of patterns) {
				if (re.test(source)) {
					offenders.push(`  ${path.relative(REPO_ROOT, file)}: ${what}`);
				}
			}
		}
		expect(
			offenders,
			"a spawn reached this way is invisible to the scan -- it is not a " +
				"call site, so it cannot move the pinned population either, and " +
				"#2691's shape would ride in uncounted. Call safeSpawnAsync / " +
				"safeSpawnSync by name:\n" +
				offenders.join("\n"),
		).toEqual([]);
	});

	it("every cwd-exempt marker still names a real, still-exempt call site", () => {
		const exemptSites = sites.filter(
			(site) => EXEMPTION_REASONS[siteKey(site)],
		);
		const liveKeys = new Set(sites.map(siteKey));
		expect(
			Object.keys(EXEMPTION_REASONS).filter((key) => !liveKeys.has(key)),
			"an exemption for a removed site is stale and must be deleted",
		).toEqual([]);
		assertNonEmptyScan(
			"runner-spawn-cwd-sweep: cwd-exempt markers found",
			exemptSites.length,
		);
		const redundant = exemptSites.filter((site) => site.resolvedFromToolCwd);
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
