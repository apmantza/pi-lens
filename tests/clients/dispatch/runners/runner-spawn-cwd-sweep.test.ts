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
 * A site conforms when the options literal has a usable PROPERTY NAMED `cwd`; a
 * same-file function is a spawn-routing wrapper when a spawn's `cwd` value
 * resolves to one of that function's OWN parameters, and then its CALLERS are
 * the sites checked. Both are answered off the real AST (`@ast-grep/napi`, the
 * same dependency `tests/support/availability-gate.ts` uses), never off text.
 *
 * ## Scope
 *
 * The population covers `clients/`, `tools/`, `mcp/`, and `index.ts`. Genuine
 * global probes and deliberate non-seam cwd derivations remain exact, keyed
 * admissions with one reason per row. Every other site must pass `cwd`, and
 * every supplied value must resolve through the imported tool-cwd seam.
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

/**
 * The exact population, measured 2026-09-07. These are pinned, not floored:
 * round 2 declared an emptiness floor of 25 against 58 live sites, and a floor
 * that loose is one-sided — it catches a sweep that goes dead but not one that
 * quietly stops SEEING sites. Reverting `spawnPs` to positional arguments, or
 * reintroducing round 1's wrapper blindness, each drops three or more sites
 * with every remaining site still conforming, so a floor stays green while the
 * ratchet's reach shrinks (round-2 review F3).
 *
 * **These are the numbers to bump when you add or remove a child spawn.** A
 * new `safeSpawnAsync`/`safeSpawnSync` call, or a new call site of one of the
 * wrappers below, moves `EXPECTED_DIRECT_SITES` by one; a new runner file moves
 * `EXPECTED_FILES`. Bumping them is the whole cost, and it is deliberate: the
 * bump is where a reviewer sees a spawn was added.
 */
const EXPECTED_FILES = 76;
const EXPECTED_DIRECT_SITES = 136;
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
const NO_CWD_EXEMPTION_ROWS: ReadonlyArray<readonly [string, string]> = [
	[
		"clients/biome-client.ts#BiomeClient:91ce6b49",
		"clients/biome-client.ts:213 is a global or environment probe with no project target",
	],
	[
		"clients/dead-code-client.ts#PythonDeadCodeClient:262cd861",
		"clients/dead-code-client.ts:313 is a global or environment probe with no project target",
	],
	[
		"clients/dead-code-client.ts#PythonDeadCodeClient:488c639e",
		"clients/dead-code-client.ts:406 is a global or environment probe with no project target",
	],
	[
		"clients/dependency-checker.ts#4a8eaea5",
		"clients/dependency-checker.ts:679 is a global or environment probe with no project target",
	],
	[
		"clients/dispatch/dispatcher.ts#checkToolAvailability:8476f379",
		"clients/dispatch/dispatcher.ts:213 is a global or environment probe with no project target",
	],
	[
		"clients/dispatch/runners/cpp-check.ts#resolveCompiler:ef272657",
		"clients/dispatch/runners/cpp-check.ts:133 is a global or environment probe with no project target",
	],
	[
		"clients/dispatch/runners/psscriptanalyzer.ts#resolvePowerShellCmd:54c5ac70",
		"clients/dispatch/runners/psscriptanalyzer.ts:186 is a global or environment probe with no project target",
	],
	[
		"clients/dispatch/runners/psscriptanalyzer.ts#checkModuleAvailable:cb19d7fd",
		"clients/dispatch/runners/psscriptanalyzer.ts:238 is a global or environment probe with no project target",
	],
	[
		"clients/dispatch/runners/utils/candidate-probe.ts#probeAvailabilityCandidates:de7597bc",
		"clients/dispatch/runners/utils/candidate-probe.ts:77 is a global or environment probe with no project target",
	],
	[
		"clients/dispatch/runners/utils/runner-helpers.ts#probeAstGrepCommandAsync:1358e678",
		"clients/dispatch/runners/utils/runner-helpers.ts:1826 is a global or environment probe with no project target",
	],
	[
		"clients/dispatch/runners/utils/runner-helpers.ts#resolveLocalFirstAsync:84565942",
		"clients/dispatch/runners/utils/runner-helpers.ts:2166 is a global or environment probe with no project target",
	],
	[
		"clients/formatters.ts#which:d19ba32a",
		"clients/formatters.ts:506 is a global or environment probe with no project target",
	],
	[
		"clients/formatters.ts#resolveGoFmtBinary:041f83b9",
		"clients/formatters.ts:589 is a global or environment probe with no project target",
	],
	[
		"clients/formatters.ts#csharpierFormatter:2ca1f9e8",
		"clients/formatters.ts:1510 is a global or environment probe with no project target",
	],
	[
		"clients/formatters.ts#csharpierFormatter:ed0ec0c0",
		"clients/formatters.ts:1528 is a global or environment probe with no project target",
	],
	[
		"clients/formatters.ts#psscriptanalyzerFormatFormatter:d19ba32a",
		"clients/formatters.ts:1702 is a global or environment probe with no project target",
	],
	[
		"clients/govulncheck-client.ts#GovulncheckClient:ba9d5f6b",
		"clients/govulncheck-client.ts:163 is a global or environment probe with no project target",
	],
	[
		"clients/govulncheck-client.ts#GovulncheckClient:907edd61",
		"clients/govulncheck-client.ts:209 is a global or environment probe with no project target",
	],
	[
		"clients/govulncheck-client.ts#GovulncheckClient:7c57359c",
		"clients/govulncheck-client.ts:305 is a global or environment probe with no project target",
	],
	[
		"clients/installer/index.ts#verifyAstGrepProbePath:a18df340",
		"clients/installer/index.ts:2078 is a global or environment probe with no project target",
	],
	[
		"clients/installer/index.ts#verifyToolBinary:8331866b",
		"clients/installer/index.ts:2553 is a global or environment probe with no project target",
	],
	[
		"clients/installer/index.ts#getAllToolStatuses:d13d9713",
		"clients/installer/index.ts:2694 is a global or environment probe with no project target",
	],
	[
		"clients/installer/index.ts#getPythonUserBaseCandidates:63a9db2b",
		"clients/installer/index.ts:3372 is a global or environment probe with no project target",
	],
	[
		"clients/installer/index.ts#installGitHubTool:f4b22347",
		"clients/installer/index.ts:3701 is a global or environment probe with no project target",
	],
	[
		"clients/installer/index.ts#installGitHubTool:4f6bccd6",
		"clients/installer/index.ts:3747 is a global or environment probe with no project target",
	],
	[
		"clients/installer/index.ts#installGitHubTool:297c02d9",
		"clients/installer/index.ts:3756 is a global or environment probe with no project target",
	],
	[
		"clients/installer/index.ts#probeManagedToolVersion:eb60a80f",
		"clients/installer/index.ts:4119 is a global or environment probe with no project target",
	],
	[
		"clients/installer/index.ts#installPipTool:7100b335",
		"clients/installer/index.ts:5251 is a global or environment probe with no project target",
	],
	[
		"clients/installer/index.ts#installPipTool:cdb6c69e",
		"clients/installer/index.ts:5271 is a global or environment probe with no project target",
	],
	[
		"clients/installer/index.ts#installGemTool:b6a5f9a3",
		"clients/installer/index.ts:5369 is a global or environment probe with no project target",
	],
	[
		"clients/knip-client.ts#KnipClient:a1223aae",
		"clients/knip-client.ts:473 is a global or environment probe with no project target",
	],
	[
		"clients/lsp/jvm-runtime.ts#runJavaProbe:bae0ccaa",
		"clients/lsp/jvm-runtime.ts:241 is a global or environment probe with no project target",
	],
	[
		"clients/lsp/server.ts#tryGoInstallGopls:d19ba32a",
		"clients/lsp/server.ts:1631 is a global or environment probe with no project target",
	],
	[
		"clients/lsp/server.ts#tryDotnetToolInstall:d19ba32a",
		"clients/lsp/server.ts:1641 is a global or environment probe with no project target",
	],
	[
		"clients/lsp/server.ts#tryDotnetToolInstall:c1f5a0ed",
		"clients/lsp/server.ts:1657 is a global or environment probe with no project target",
	],
	[
		"clients/lsp/server.ts#tryGemInstall:d19ba32a",
		"clients/lsp/server.ts:2026 is a global or environment probe with no project target",
	],
	[
		"clients/mcp/review.ts#analyzeFileFresh:ce42ac4e",
		"clients/mcp/review.ts:61 is a global or environment probe with no project target",
	],
	[
		"clients/package-manager.ts#probeAvailability:d0a6319a",
		"clients/package-manager.ts:152 is a global or environment probe with no project target",
	],
	[
		"clients/package-manager.ts#probeGlobalBinDirs:bf156997",
		"clients/package-manager.ts:450 is a global or environment probe with no project target",
	],
	[
		"clients/pipeline.ts#tryRustClippyFix:8e05db7b",
		"clients/pipeline.ts:682 is a global or environment probe with no project target",
	],
	[
		"clients/pipeline.ts#tryDartFix:91623ccc",
		"clients/pipeline.ts:701 is a global or environment probe with no project target",
	],
	[
		"clients/ruff-client.ts#RuffClient:a9f1b92a",
		"clients/ruff-client.ts:129 is a global or environment probe with no project target",
	],
	[
		"clients/safe-spawn.ts#60b5b1fb",
		"clients/safe-spawn.ts:1563 is a global or environment probe with no project target",
	],
	[
		"clients/safe-spawn.ts#safeSpawnBatch:921a571e",
		"clients/safe-spawn.ts:2055 is a global or environment probe with no project target",
	],
	[
		"clients/safe-spawn.ts#isCommandAvailableAsync:45a177c3",
		"clients/safe-spawn.ts:2071 is a global or environment probe with no project target",
	],
	[
		"clients/safe-spawn.ts#findCommandAsync:45a177c3",
		"clients/safe-spawn.ts:2082 is a global or environment probe with no project target",
	],
	[
		"clients/safe-spawn.ts#isCommandAvailable:947ec768",
		"clients/safe-spawn.ts:2242 is a global or environment probe with no project target",
	],
	[
		"clients/safe-spawn.ts#findCommand:e3470221",
		"clients/safe-spawn.ts:2256 is a global or environment probe with no project target",
	],
	[
		"clients/security-scan-client.ts#SecurityScanClient:b0202c69",
		"clients/security-scan-client.ts:173 is a global or environment probe with no project target",
	],
	[
		"clients/sg-runner.ts#SgRunner:e9967cbc",
		"clients/sg-runner.ts:574 is a global or environment probe with no project target",
	],
	[
		"clients/sg-runner.ts#bd8f1573",
		"clients/sg-runner.ts:616 is a global or environment probe with no project target",
	],
	[
		"clients/sg-runner.ts#d19ba32a",
		"clients/sg-runner.ts:731 is a global or environment probe with no project target",
	],
	[
		"clients/sg-runner.ts#d19ba32a",
		"clients/sg-runner.ts:767 is a global or environment probe with no project target",
	],
	[
		"clients/sg-runner.ts#d19ba32a",
		"clients/sg-runner.ts:956 is a global or environment probe with no project target",
	],
	[
		"clients/sg-runner.ts#23665a2b",
		"clients/sg-runner.ts:1030 is a global or environment probe with no project target",
	],
	[
		"clients/sg-runner.ts#0a5b6a4d",
		"clients/sg-runner.ts:1039 is a global or environment probe with no project target",
	],
	[
		"clients/sg-runner.ts#bec6ba36",
		"clients/sg-runner.ts:1044 is a global or environment probe with no project target",
	],
	[
		"clients/test-runner-client.ts#TestRunnerClient:d444522b",
		"clients/test-runner-client.ts:780 is a global or environment probe with no project target",
	],
	[
		"clients/zizmor-config.ts#deriveGhCliToken:53993e8c",
		"clients/zizmor-config.ts:201 is a global or environment probe with no project target",
	],
];
const ORIGIN_ADMISSION_ROWS: ReadonlyArray<readonly [string, string]> = [
	[
		"clients/biome-client.ts#BiomeClient:29a3826f",
		"clients/biome-client.ts:175 deliberately derives cwd from its file or project boundary",
	],
	[
		"clients/biome-client.ts#BiomeClient:bcf3abbd",
		"clients/biome-client.ts:383 deliberately derives cwd from its file or project boundary",
	],
	[
		"clients/dead-code-client.ts#PythonDeadCodeClient:a6694002",
		"clients/dead-code-client.ts:452 deliberately derives cwd from its file or project boundary",
	],
	[
		"clients/dependency-checker.ts#1935bb9d",
		"clients/dependency-checker.ts:662 deliberately derives cwd from its file or project boundary",
	],
	[
		"clients/dependency-checker.ts#d19ba32a",
		"clients/dependency-checker.ts:732 deliberately derives cwd from its file or project boundary",
	],
	[
		"clients/dependency-checker.ts#6e4567d4",
		"clients/dependency-checker.ts:934 deliberately derives cwd from its file or project boundary",
	],
	[
		"clients/dependency-checker.ts#50922783",
		"clients/dependency-checker.ts:1059 deliberately derives cwd from its file or project boundary",
	],
	[
		"clients/dependency-checker.ts#d19ba32a",
		"clients/dependency-checker.ts:1074 deliberately derives cwd from its file or project boundary",
	],
	[
		"clients/dispatch/runners/biome-check.ts#resolveBiomeFixKinds:421743c0",
		"clients/dispatch/runners/biome-check.ts:212 deliberately derives cwd from its file or project boundary",
	],
	[
		"clients/dispatch/runners/credo.ts#probeCredo:dd8cc117",
		"clients/dispatch/runners/credo.ts:24 deliberately derives cwd from its file or project boundary",
	],
	[
		"clients/dispatch/runners/cue-vet.ts#cueVetRunner:f4cff533",
		"clients/dispatch/runners/cue-vet.ts:382 deliberately derives cwd from its file or project boundary",
	],
	[
		"clients/dispatch/runners/cue-vet.ts#cueVetRunner:25518bf5",
		"clients/dispatch/runners/cue-vet.ts:391 deliberately derives cwd from its file or project boundary",
	],
	[
		"clients/dispatch/runners/cue-vet.ts#cueVetRunner:f4cff533",
		"clients/dispatch/runners/cue-vet.ts:407 deliberately derives cwd from its file or project boundary",
	],
	[
		"clients/dispatch/runners/eslint.ts#makeEslintProbe:3be48c18",
		"clients/dispatch/runners/eslint.ts:39 deliberately derives cwd from its file or project boundary",
	],
	[
		"clients/dispatch/runners/helm-lint.ts#lintChart:ede3129e",
		"clients/dispatch/runners/helm-lint.ts:134 deliberately derives cwd from its file or project boundary",
	],
	[
		"clients/dispatch/runners/helm-lint.ts#helmLintRunner:833aee95",
		"clients/dispatch/runners/helm-lint.ts:212 deliberately derives cwd from its file or project boundary",
	],
	[
		"clients/dispatch/runners/helm-render.ts#runIacPass:40b7cb52",
		"clients/dispatch/runners/helm-render.ts:769 deliberately derives cwd from its file or project boundary",
	],
	[
		"clients/dispatch/runners/helm-render.ts#renderAndValidate:415768ad",
		"clients/dispatch/runners/helm-render.ts:930 deliberately derives cwd from its file or project boundary",
	],
	[
		"clients/dispatch/runners/helm-render.ts#renderAndValidate:23311c5b",
		"clients/dispatch/runners/helm-render.ts:1085 deliberately derives cwd from its file or project boundary",
	],
	[
		"clients/dispatch/runners/oxlint.ts#resolveVitePlusCommand:e2bb00ca",
		"clients/dispatch/runners/oxlint.ts:94 deliberately derives cwd from its file or project boundary",
	],
	[
		"clients/dispatch/runners/psscriptanalyzer.ts#spawnPs:5b1d2add",
		"clients/dispatch/runners/psscriptanalyzer.ts:61 deliberately derives cwd from its file or project boundary",
	],
	[
		"clients/dispatch/runners/rust-clippy.ts#makeClippyProbe:78407e0b",
		"clients/dispatch/runners/rust-clippy.ts:47 deliberately derives cwd from its file or project boundary",
	],
	[
		"clients/dispatch/runners/rust-clippy.ts#rustClippyRunner:d19ba32a",
		"clients/dispatch/runners/rust-clippy.ts:135 deliberately derives cwd from its file or project boundary",
	],
	[
		"clients/dispatch/runners/terragrunt.ts#terragruntRunner:d19ba32a",
		"clients/dispatch/runners/terragrunt.ts:182 deliberately derives cwd from its file or project boundary",
	],
	[
		"clients/dispatch/runners/tflint.ts#tflintRunner:4f859d5a",
		"clients/dispatch/runners/tflint.ts:110 deliberately derives cwd from its file or project boundary",
	],
	[
		"clients/dispatch/runners/utils/lazy-installer.ts#runLazyInstall:c226c0b2",
		"clients/dispatch/runners/utils/lazy-installer.ts:217 deliberately derives cwd from its file or project boundary",
	],
	[
		"clients/dispatch/runners/utils/lazy-installer.ts#performInstall:6db1ba7a",
		"clients/dispatch/runners/utils/lazy-installer.ts:234 deliberately derives cwd from its file or project boundary",
	],
	[
		"clients/dispatch/runners/utils/lazy-installer.ts#tryLazyInstall:1adf4f32",
		"clients/dispatch/runners/utils/lazy-installer.ts:334 deliberately derives cwd from its file or project boundary",
	],
	[
		"clients/dispatch/runners/utils/lazy-installer.ts#tryLazyInstallForFormatter:1adf4f32",
		"clients/dispatch/runners/utils/lazy-installer.ts:348 deliberately derives cwd from its file or project boundary",
	],
	[
		"clients/dispatch/runners/utils/runner-helpers.ts#createAvailabilityChecker:a29ba2ed",
		"clients/dispatch/runners/utils/runner-helpers.ts:1179 deliberately derives cwd from its file or project boundary",
	],
	[
		"clients/dispatch/runners/utils/runner-helpers.ts#resolveToolCommandWithInstallFallback:98ae1905",
		"clients/dispatch/runners/utils/runner-helpers.ts:1566 deliberately derives cwd from its file or project boundary",
	],
	[
		"clients/dispatch/runners/utils/runner-helpers.ts#verifyOrInstallCommand:3dd0894a",
		"clients/dispatch/runners/utils/runner-helpers.ts:1586 deliberately derives cwd from its file or project boundary",
	],
	[
		"clients/dispatch/runners/utils/runner-helpers.ts#resolveCommandArgsWithInstallFallback:ce7b0ed1",
		"clients/dispatch/runners/utils/runner-helpers.ts:1635 deliberately derives cwd from its file or project boundary",
	],
	[
		"clients/dispatch/runners/utils/runner-helpers.ts#resolveCommandArgsWithInstallFallback:bc3b5ebb",
		"clients/dispatch/runners/utils/runner-helpers.ts:1643 deliberately derives cwd from its file or project boundary",
	],
	[
		"clients/dispatch/runners/utils/runner-helpers.ts#resolveCommandWithInstallFallback:4a5cc9b1",
		"clients/dispatch/runners/utils/runner-helpers.ts:1666 deliberately derives cwd from its file or project boundary",
	],
	[
		"clients/file-utils.ts#detectFileChangedAfterCommand:2f580f41",
		"clients/file-utils.ts:1079 deliberately derives cwd from its file or project boundary",
	],
	[
		"clients/git-tracked-ignore.ts#fetchUntrackedIgnoredIds:d19ba32a",
		"clients/git-tracked-ignore.ts:92 deliberately derives cwd from its file or project boundary",
	],
	[
		"clients/git-tracked-ignore.ts#collectUntrackedIgnoredIds:538456dd",
		"clients/git-tracked-ignore.ts:141 deliberately derives cwd from its file or project boundary",
	],
	[
		"clients/git-tracked-ignore.ts#fetchTrackedFiles:ffac1a78",
		"clients/git-tracked-ignore.ts:193 deliberately derives cwd from its file or project boundary",
	],
	[
		"clients/git-tracked-ignore.ts#collectTrackedFiles:0f864633",
		"clients/git-tracked-ignore.ts:246 deliberately derives cwd from its file or project boundary",
	],
	[
		"clients/gitleaks-client.ts#GitleaksClient:c23b1b18",
		"clients/gitleaks-client.ts:374 deliberately derives cwd from its file or project boundary",
	],
	[
		"clients/gitleaks-client.ts#GitleaksClient:d19ba32a",
		"clients/gitleaks-client.ts:384 deliberately derives cwd from its file or project boundary",
	],
	[
		"clients/govulncheck-client.ts#GovulncheckClient:c23b1b18",
		"clients/govulncheck-client.ts:457 deliberately derives cwd from its file or project boundary",
	],
	[
		"clients/govulncheck-client.ts#GovulncheckClient:d19ba32a",
		"clients/govulncheck-client.ts:464 deliberately derives cwd from its file or project boundary",
	],
	[
		"clients/installer/index.ts#runCommand:cce079be",
		"clients/installer/index.ts:3518 deliberately derives cwd from its file or project boundary",
	],
	[
		"clients/installer/index.ts#installArchiveTool:f9ed9b6a",
		"clients/installer/index.ts:4851 deliberately derives cwd from its file or project boundary",
	],
	[
		"clients/installer/index.ts#installNpmTool:c7f0cfde",
		"clients/installer/index.ts:5033 deliberately derives cwd from its file or project boundary",
	],
	[
		"clients/installer/managed-tool-refresh.ts#performNpmRefresh:2bf80014",
		"clients/installer/managed-tool-refresh.ts:693 deliberately derives cwd from its file or project boundary",
	],
	[
		"clients/jscpd-client.ts#JscpdClient:af9206c2",
		"clients/jscpd-client.ts:265 deliberately derives cwd from its file or project boundary",
	],
	[
		"clients/jscpd-client.ts#JscpdClient:d19ba32a",
		"clients/jscpd-client.ts:319 deliberately derives cwd from its file or project boundary",
	],
	[
		"clients/knip-client.ts#KnipClient:2f580f41",
		"clients/knip-client.ts:609 deliberately derives cwd from its file or project boundary",
	],
	[
		"clients/mcp/review.ts#runRebuild:79b97833",
		"clients/mcp/review.ts:156 deliberately derives cwd from its file or project boundary",
	],
	[
		"clients/opaque-mutation-scan.ts#isGitWorktree:d19ba32a",
		"clients/opaque-mutation-scan.ts:313 deliberately derives cwd from its file or project boundary",
	],
	[
		"clients/opaque-mutation-scan.ts#resolveGitToplevel:dd42327f",
		"clients/opaque-mutation-scan.ts:347 deliberately derives cwd from its file or project boundary",
	],
	[
		"clients/opaque-mutation-scan.ts#recoverOpaqueChangesViaGit:d19ba32a",
		"clients/opaque-mutation-scan.ts:488 deliberately derives cwd from its file or project boundary",
	],
	[
		"clients/opengrep-client.ts#OpengrepClient:c23b1b18",
		"clients/opengrep-client.ts:147 deliberately derives cwd from its file or project boundary",
	],
	[
		"clients/opengrep-client.ts#OpengrepClient:d19ba32a",
		"clients/opengrep-client.ts:157 deliberately derives cwd from its file or project boundary",
	],
	[
		"clients/pipeline.ts#tryEslintFix:e15d0fb8",
		"clients/pipeline.ts:467 deliberately derives cwd from its file or project boundary",
	],
	[
		"clients/pipeline.ts#tryRustClippyFix:d19ba32a",
		"clients/pipeline.ts:691 deliberately derives cwd from its file or project boundary",
	],
	[
		"clients/pipeline.ts#tryDartFix:6d9ed63b",
		"clients/pipeline.ts:711 deliberately derives cwd from its file or project boundary",
	],
	[
		"clients/pipeline.ts#runAutofix:b112a810",
		"clients/pipeline.ts:861 deliberately derives cwd from its file or project boundary",
	],
	[
		"clients/pipeline.ts#runPipeline:a5f29544",
		"clients/pipeline.ts:1455 deliberately derives cwd from its file or project boundary",
	],
	[
		"clients/ruff-client.ts#RuffClient:95d48994",
		"clients/ruff-client.ts:147 deliberately derives cwd from its file or project boundary",
	],
	[
		"clients/safe-spawn.ts#safeSpawnAsync:b611b1c7",
		"clients/safe-spawn.ts:1495 deliberately derives cwd from its file or project boundary",
	],
	[
		"clients/shared-checkout-guard.ts#probeWorkingTreeState:d19ba32a",
		"clients/shared-checkout-guard.ts:205 deliberately derives cwd from its file or project boundary",
	],
	[
		"clients/test-runner-client.ts#2f580f41",
		"clients/test-runner-client.ts:1354 deliberately derives cwd from its file or project boundary",
	],
	[
		"clients/trivy-client.ts#TrivyClient:c23b1b18",
		"clients/trivy-client.ts:278 deliberately derives cwd from its file or project boundary",
	],
	[
		"clients/trivy-client.ts#TrivyClient:d19ba32a",
		"clients/trivy-client.ts:299 deliberately derives cwd from its file or project boundary",
	],
];
const NO_CWD_EXEMPTIONS = new Map(NO_CWD_EXEMPTION_ROWS);
const ORIGIN_ADMISSIONS = new Map(ORIGIN_ADMISSION_ROWS);
const ADMISSION_ROWS = [...NO_CWD_EXEMPTION_ROWS, ...ORIGIN_ADMISSION_ROWS];

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
/** Every spawn-bearing `.ts` file under the four population roots. */
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
		expect(sites.filter((site) => site.kind === "direct")).toHaveLength(
			EXPECTED_DIRECT_SITES,
		);
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
			(site) => !site.hasCwd && !NO_CWD_EXEMPTIONS.has(siteKey(site)),
		);
		expect(
			missing,
			`${missing.length} spawn(s) do not pass a cwd. Add the ` +
				"resolver result directly, through a local, or through an object spread. " +
				"Admit only a legitimate non-project probe with an exact reason:\n" +
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
			if (!site.hasCwd) {
				return false;
			}
			return !site.resolvedFromToolCwd && !ORIGIN_ADMISSIONS.has(siteKey(site));
		});
		expect(
			missingOrigin.map((site) => `${site.file}:${site.line} (${site.callee})`),
			"runner cwd bindings must resolve from an imported tool-cwd seam or a named admission",
		).toEqual([]);
		expect(
			ADMISSION_ROWS.every(([, reason]) => reason.length >= 15),
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
			(site) =>
				NO_CWD_EXEMPTIONS.has(siteKey(site)) ||
				ORIGIN_ADMISSIONS.has(siteKey(site)),
		);
		const liveKeys = new Set(sites.map(siteKey));
		expect(ADMISSION_ROWS).not.toHaveLength(0);
		expect(
			ADMISSION_ROWS.filter(([key]) =>
				sites.some(
					(site) => siteKey(site) === key && !site.resolvedFromToolCwd,
				),
			),
		).toHaveLength(ADMISSION_ROWS.length);
		expect(
			[...new Set(ADMISSION_ROWS.map(([key]) => key))].filter(
				(key) => !liveKeys.has(key),
			),
			"an exemption for a removed site is stale and must be deleted",
		).toEqual([]);
		assertNonEmptyScan(
			"runner-spawn-cwd-sweep: exact admissions found",
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
