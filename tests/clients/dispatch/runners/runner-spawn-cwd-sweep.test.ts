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

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../../..",
);
const RUNNERS_DIR = path.join(REPO_ROOT, "clients/dispatch/runners");
const POPULATION_FILES = [
	...fs
		.readdirSync(RUNNERS_DIR, { withFileTypes: true })
		.filter(
			(entry) =>
				entry.isFile() &&
				entry.name.endsWith(".ts") &&
				!entry.name.endsWith(".test.ts"),
		)
		.map((entry) => path.join(RUNNERS_DIR, entry.name)),
	...fs
		.readdirSync(path.join(RUNNERS_DIR, "utils"), { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
		.map((entry) => path.join(RUNNERS_DIR, "utils", entry.name)),
	path.join(REPO_ROOT, "clients/formatters.ts"),
	path.join(REPO_ROOT, "clients/php-cs-fixer-config.ts"),
	path.join(REPO_ROOT, "clients/biome-client.ts"),
	path.join(REPO_ROOT, "clients/lsp/server.ts"),
	path.join(REPO_ROOT, "clients/lsp/jvm-runtime.ts"),
	path.join(REPO_ROOT, "clients/test-runner-client.ts"),
	path.join(REPO_ROOT, "clients/dispatch/dispatcher.ts"),
	path.join(REPO_ROOT, "index.ts"),
].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

const EXEMPTIONS: Readonly<Record<string, string>> = Object.fromEntries(
	[
		"clients/biome-client.ts:175:safeSpawnAsync",
		"clients/biome-client.ts:213:spawnBiomeAsync",
		"clients/biome-client.ts:383:spawnBiomeAsync",
		"clients/dispatch/dispatcher.ts:213:safeSpawnAsync",
		"clients/dispatch/runners/biome-check.ts:212:safeSpawnAsync",
		"clients/dispatch/runners/cpp-check.ts:133:safeSpawnAsync",
		"clients/dispatch/runners/credo.ts:24:safeSpawnAsync",
		"clients/dispatch/runners/cue-vet.ts:382:safeSpawnAsync",
		"clients/dispatch/runners/cue-vet.ts:391:safeSpawnAsync",
		"clients/dispatch/runners/cue-vet.ts:407:safeSpawnAsync",
		"clients/dispatch/runners/eslint.ts:39:safeSpawnAsync",
		"clients/dispatch/runners/helm-lint.ts:134:safeSpawnAsync",
		"clients/dispatch/runners/helm-lint.ts:212:lintChart",
		"clients/dispatch/runners/helm-render.ts:769:safeSpawnAsync",
		"clients/dispatch/runners/helm-render.ts:930:safeSpawnAsync",
		"clients/dispatch/runners/helm-render.ts:1085:runIacPass",
		"clients/dispatch/runners/oxlint.ts:94:safeSpawnAsync",
		"clients/dispatch/runners/psscriptanalyzer.ts:61:safeSpawnAsync",
		"clients/dispatch/runners/psscriptanalyzer.ts:186:spawnPs",
		"clients/dispatch/runners/psscriptanalyzer.ts:238:spawnPs",
		"clients/dispatch/runners/rust-clippy.ts:47:safeSpawnAsync",
		"clients/dispatch/runners/rust-clippy.ts:135:safeSpawnAsync",
		"clients/dispatch/runners/terragrunt.ts:182:safeSpawnAsync",
		"clients/dispatch/runners/tflint.ts:110:safeSpawnAsync",
		"clients/dispatch/runners/utils/candidate-probe.ts:77:safeSpawnAsync",
		"clients/dispatch/runners/utils/lazy-installer.ts:217:performInstall",
		"clients/dispatch/runners/utils/lazy-installer.ts:234:safeSpawnAsync",
		"clients/dispatch/runners/utils/lazy-installer.ts:334:runLazyInstall",
		"clients/dispatch/runners/utils/lazy-installer.ts:348:runLazyInstall",
		"clients/dispatch/runners/utils/runner-helpers.ts:1179:safeSpawnAsync",
		"clients/dispatch/runners/utils/runner-helpers.ts:1566:resolveCommandWithInstallFallback",
		"clients/dispatch/runners/utils/runner-helpers.ts:1586:safeSpawnAsync",
		"clients/dispatch/runners/utils/runner-helpers.ts:1635:safeSpawnAsync",
		"clients/dispatch/runners/utils/runner-helpers.ts:1643:verifyOrInstallCommand",
		"clients/dispatch/runners/utils/runner-helpers.ts:1666:verifyOrInstallCommand",
		"clients/dispatch/runners/utils/runner-helpers.ts:1826:safeSpawnAsync",
		"clients/dispatch/runners/utils/runner-helpers.ts:2166:safeSpawnAsync",
		"clients/formatters.ts:506:safeSpawnAsync",
		"clients/formatters.ts:589:safeSpawnAsync",
		"clients/formatters.ts:1510:safeSpawnAsync",
		"clients/formatters.ts:1528:safeSpawnAsync",
		"clients/formatters.ts:1702:safeSpawnAsync",
		"clients/lsp/jvm-runtime.ts:241:safeSpawnAsync",
		"clients/lsp/server.ts:1631:safeSpawnAsync",
		"clients/lsp/server.ts:1641:safeSpawnAsync",
		"clients/lsp/server.ts:1657:safeSpawnAsync",
		"clients/lsp/server.ts:2026:safeSpawnAsync",
		"clients/test-runner-client.ts:780:safeSpawn",
		"clients/test-runner-client.ts:1354:safeSpawnAsync",
	].map((key) => [
		key,
		key === "clients/test-runner-client.ts:1354:safeSpawnAsync"
			? "#2871 test-runner child spawn awaits seam migration"
			: "existing probe or parameter-routed child; resolver origin is outside this file",
	]),
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
const EXPECTED_FILES = 54;

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

	it("every non-exempt spawn's options object names cwd", () => {
		const missing = sites.filter(
			(site) =>
				!site.resolvedFromToolCwd &&
				!EXEMPTIONS[`${site.file}:${site.line}:${site.callee}`],
		);
		expect(
			missing,
			`${missing.length} spawn(s) do not pass cwd from resolveToolCwd. Add the ` +
				"resolver result directly, through a local, or through an object spread. " +
				"Admit only a legitimate non-project probe in EXEMPTIONS with a reason:\n" +
				missing
					.map((site) => `  ${site.file}:${site.line} (${site.callee})`)
					.join("\n"),
		).toHaveLength(0);
	});

	it("every dispatch cwd binding comes from the shared tool-cwd seam (#2777)", () => {
		expect(
			Object.entries(EXEMPTIONS).every(([, reason]) => reason.length >= 15),
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
					offenders.push(`  ${path.relative(RUNNERS_DIR, file)}: ${what}`);
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
			(site) => EXEMPTIONS[`${site.file}:${site.line}:${site.callee}`],
		);
		const liveKeys = new Set(
			sites.map((site) => `${site.file}:${site.line}:${site.callee}`),
		);
		expect(
			Object.keys(EXEMPTIONS).filter((key) => !liveKeys.has(key)),
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
