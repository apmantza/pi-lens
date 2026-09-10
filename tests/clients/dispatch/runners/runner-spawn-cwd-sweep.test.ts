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
 * site kind × where a `cwd` token can sit), plus one per node type the
 * TypeScript grammar lets own a declaration. THIS file is the integration
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
 * ## The three rules, in one line each
 *
 * 1. PRESENCE — a site's options literal names `cwd` and the value is usable
 *    (not `undefined`/`null`/`""`/`process.cwd()`).
 * 2. ORIGIN (#2777) — that value traces back to `resolveToolCwd` (or the
 *    `resolveRunnerCwd`/`resolveFormatterCwd` wrappers), imported from the
 *    shared seam rather than named like it.
 * 3. WRAPPERS — a same-file function is a spawn-routing wrapper when a spawn's
 *    `cwd` resolves to one of its OWN parameters, and then its CALLERS are the
 *    sites the first two rules are applied to.
 *
 * All three are answered off the real AST (`@ast-grep/napi`, the same
 * dependency `tests/support/availability-gate.ts` uses), never off text.
 *
 * ## Scope
 *
 * The population is every spawn-bearing `.ts` file under `clients/`, `tools/`,
 * `mcp/` and `index.ts` — not just `clients/dispatch/runners/`. Both rules are
 * enforced over all of it.
 *
 * ## What the scan cannot see, and what closes it here
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
 * ## Adding a spawn
 *
 * A new child spawn that passes a seam-resolved `cwd` costs one number:
 * `EXPECTED_DIRECT_SITES` (or `EXPECTED_WRAPPER_SITES`) moves by one, which is
 * where a reviewer sees the spawn was added. A new child spawn that does NOT
 * — no cwd, or a cwd from somewhere other than the seam — costs a ROW in one
 * of the three tables below, with a reason true of THAT site. Bumping a
 * number is never the way to admit a non-conforming spawn: the audits below
 * key every flagged site by its enclosing symbol, its call text and its cwd
 * expression, so an unadmitted one is reported by name (round-4 v3-F3, where
 * a new cwd-less spawn rode in on a colliding key and only the count moved).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { lineContentHash } from "../../../../clients/read-guard.js";
import {
	type SpawnCwdSite,
	scanSpawnCwd,
} from "../../../support/spawn-cwd-scan.js";
import {
	assertNonEmptyScan,
	auditRegistry,
	listSourceFiles,
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
 * The exact population, measured 2026-09-10. These are pinned, not floored:
 * round 2 declared an emptiness floor of 25 against 58 live sites, and a floor
 * that loose is one-sided — it catches a sweep that goes dead but not one that
 * quietly stops SEEING sites. Reverting `spawnPs` to positional arguments, or
 * reintroducing round 1's wrapper blindness, each drops three or more sites
 * with every remaining site still conforming, so a floor stays green while the
 * ratchet's reach shrinks (round-2 review F3).
 *
 * They pin REACH, never conformance: see "Adding a spawn" in the header for
 * what a non-conforming new site costs instead.
 */
const EXPECTED_FILES = 76;
const EXPECTED_DIRECT_SITES = 136;
/**
 * Every same-file spawn-routing wrapper call site the scan discovers. Pinned
 * as a LIST, not a count, because the list is the part round 2 got wrong: it
 * claimed "spawnPs and runIacPass are the two existing local wrappers" while
 * `lintChart`, `renderAndValidate`, `resolveVitePlusCommand` and
 * `resolveBiomeFixKinds` all route a positional cwd into a spawn and had their
 * callers unchecked.
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

/**
 * ## The three tables, and what each one means
 *
 * A row is `[key, reason]`. The key is what {@link siteKey} derives for that
 * exact call; the reason must be true of THAT site and nothing else. Round 3
 * shipped 127 rows carrying two canned sentences, four of which were false
 * where I read them (`eslint.ts` "derives cwd from its file boundary" — it is
 * a closure parameter; `safe-spawn.ts` the same sentence on the seam's own
 * implementation), which is how a table stops being auditable (v3-F5).
 *
 * - {@link NO_CWD_EXEMPTION_ROWS} — the site passes no cwd, and the child has
 *   no project to resolve anything against: a `--version` probe, a
 *   `which`/`where` lookup, an install into a global tool directory.
 * - {@link ORIGIN_ADMISSION_ROWS} — the site passes a real cwd that the scan
 *   cannot trace to the seam: the wrapper's own parameter (its callers are the
 *   checked sites), a probe closure's parameter, or a directory deliberately
 *   derived from the file or project boundary.
 * - {@link MIGRATION_WORKLIST_ROWS} — the honest reason is "this should move
 *   onto `resolveToolCwd`". Not an exemption: a ratchet. Each row names its
 *   issue, and {@link WORKLIST_CEILING} can only ever be lowered.
 */
const NO_CWD_EXEMPTION_ROWS: ReadonlyArray<readonly [string, string]> = [
	[
		"clients/biome-client.ts#BiomeClient.probeBiome:91ce6b49",
		"`biome --version` presence probe through spawnBiomeAsync: no project target to resolve config against",
	],
	[
		"clients/dead-code-client.ts#PythonDeadCodeClient.doEnsureAvailable:46c732a4",
		"`<vulture candidate> --version` availability probe over PATH candidates: no project target",
	],
	[
		"clients/dead-code-client.ts#PythonDeadCodeClient.analyze:488c639e~a19bd142",
		"the analysis root reaches runAnalyze as `key` (path.resolve(root)); the name carries no `cwd`, so the wrapper rule cannot see it — the spawn it reaches passes it as cwd",
	],
	[
		"clients/dependency-checker.ts#DependencyChecker.runCheckFile:fbbf6499~dcd12892",
		"forwards runCheckFile's own `projectRoot` parameter into runMadgeSpawn; the parameter name carries no `cwd`, so the wrapper rule reads it as unsupplied",
	],
	[
		"clients/dispatch/dispatcher.ts#checkToolAvailability:8b362990",
		"`<tool> --version` availability probe the dispatcher shares across runners: no project target",
	],
	[
		"clients/dispatch/runners/cpp-check.ts#resolveCompiler:ef272657",
		"`cl` with no arguments — an MSVC presence probe that reads no file and no config; carries the in-source cwd-exempt tag too",
	],
	[
		"clients/dispatch/runners/psscriptanalyzer.ts#resolvePowerShellCmd:e2207b24",
		"`pwsh -NoProfile -Command exit 0` interpreter-presence probe through spawnPs; carries the in-source cwd-exempt tag",
	],
	[
		"clients/dispatch/runners/psscriptanalyzer.ts#checkModuleAvailable:2e480adc",
		"`Get-Module -ListAvailable PSScriptAnalyzer` module-presence probe: PowerShell resolves modules from its own search path, not from a project",
	],
	[
		"clients/dispatch/runners/utils/candidate-probe.ts#probeAvailabilityCandidates:612dec1d",
		"shared availability-probe helper: runs each candidate with its probe args (`--version` and friends) to ask whether the binary exists at all",
	],
	[
		"clients/dispatch/runners/utils/runner-helpers.ts#probeAstGrepCommandAsync:b28406d1",
		"`<ast-grep> --version` PATH probe for the sg sweep: no project target",
	],
	[
		"clients/dispatch/runners/utils/runner-helpers.ts#resolveLocalFirstAsync:5e71e1e9",
		"`<tool> --version` global-PATH step of the local-first resolution ladder: it asks whether the tool exists system-wide, after the project-local lookups have failed",
	],
	[
		"clients/formatters.ts#which:040c257b",
		"`which`/`where <command>` PATH lookup: the answer is the same from any directory",
	],
	[
		"clients/formatters.ts#resolveGoFmtBinary:8379fd5c",
		"`go env GOROOT` — a toolchain query about the Go installation, not about the project",
	],
	[
		"clients/formatters.ts#resolveCommand:057285b5",
		"`dotnet csharpier --version` presence probe for the legacy driver form",
	],
	[
		"clients/formatters.ts#detect:e11d4239",
		"`dotnet csharpier --version` presence probe in the csharpier formatter's detect()",
	],
	[
		"clients/formatters.ts#detect:4818fd92",
		"`Get-Module -ListAvailable PSScriptAnalyzer` presence probe in the powershell formatter's detect()",
	],
	[
		"clients/govulncheck-client.ts#GovulncheckClient.doEnsureAvailable:d94153fa",
		"`go version` toolchain presence probe",
	],
	[
		"clients/govulncheck-client.ts#GovulncheckClient.doEnsureAvailable:eff0855a",
		"`go install golang.org/x/vuln/cmd/govulncheck@latest` — installs into the Go tool directory, not into the project",
	],
	[
		"clients/govulncheck-client.ts#GovulncheckClient.doEnsureAvailable:ea10738d",
		"`govulncheck -version` re-probe after the install attempt",
	],
	[
		"clients/installer/index.ts#verifyAstGrepProbePath:56408f6e",
		"`<binPath> --version` verification of a downloaded ast-grep binary",
	],
	[
		"clients/installer/index.ts#verifyToolBinary:96ec5ee1",
		"`<execPath> <verificationArgs>` verification that an installed managed binary runs at all",
	],
	[
		"clients/installer/index.ts#getAllToolStatuses:54003c71",
		"`<tool.checkCommand> --version` status sweep across installed tools",
	],
	[
		"clients/installer/index.ts#getPythonUserBaseCandidates:3fead921",
		"`python -m site --user-base` — a Python installation query, unrelated to any project",
	],
	[
		"clients/installer/index.ts#installGitHubTool:13e31114~5ede8ca9",
		"`tar xf <archive> -C <tmpDir>` extraction inside the global pi-lens bin directory (GITHUB_BIN_DIR): the name carries no `cwd`, and the target is not a project",
	],
	[
		"clients/installer/index.ts#installGitHubTool:34276407~5ede8ca9",
		"Windows `Expand-Archive` extraction inside the global pi-lens bin directory",
	],
	[
		"clients/installer/index.ts#installGitHubTool:bd7b7ee6~5ede8ca9",
		"`unzip -q -o <archive> -d <tmpDir>` extraction inside the global pi-lens bin directory",
	],
	[
		"clients/installer/index.ts#probeManagedToolVersion:3050f1fc",
		"`<cached managed binary> <checkArgs>` version probe for the managed-tool refresh",
	],
	[
		"clients/installer/index.ts#installPipTool:ba749b5d",
		"`pip install <package>` into the user/managed site, not into the project",
	],
	[
		"clients/installer/index.ts#installPipTool:3042a73f",
		"`python -m site --user-base` after a pip install, to find where the binary landed",
	],
	[
		"clients/installer/index.ts#installGemTool:94a5faab",
		"`gem install <package> --no-document` into the global gem path",
	],
	[
		"clients/knip-client.ts#KnipClient.analyze:a1223aae~e1452fe0",
		"the analysis root reaches runAnalyze as `key` (path.resolve(targetDir)); the name carries no `cwd`, so the wrapper rule reads it as unsupplied",
	],
	[
		"clients/lsp/jvm-runtime.ts#runJavaProbe:41cf49b2",
		"`which java` / `where java` PATH lookup for the JVM language servers",
	],
	[
		"clients/lsp/server.ts#tryGoInstallGopls:a28791c7",
		"`go install golang.org/x/tools/gopls@latest` — installs into the Go tool directory",
	],
	[
		"clients/lsp/server.ts#tryDotnetToolInstall:408e7057",
		"`dotnet tool install --tool-path <pi-lens bin>` — installs into pi-lens's own bin directory",
	],
	[
		"clients/lsp/server.ts#tryDotnetToolInstall:f9b474e8",
		"`dotnet tool update --tool-path <pi-lens bin>` — the update half of the same install",
	],
	[
		"clients/lsp/server.ts#tryGemInstall:b2e61c88",
		"`gem install <gem> --bindir <pi-lens bin>` — installs into pi-lens's own bin directory",
	],
	[
		"clients/mcp/review.ts#analyzeFileFresh:3ac7e2fe",
		"forks the review worker with `process.execPath`; the project it must analyse is passed explicitly as the `--cwd=<dir>` argv flag, so the child's own directory is not the channel",
	],
	[
		"clients/package-manager.ts#probeAvailability:d0a6319a",
		"`which`/`where <package manager>` PATH lookup",
	],
	[
		"clients/package-manager.ts#probeGlobalBinDirs:bf156997",
		"`npm config get prefix` / `pnpm bin -g` / `yarn global bin` — global install-location queries",
	],
	[
		"clients/pipeline.ts#tryRustClippyFix:8e05db7b",
		"`cargo --version` presence probe, before the package root is known",
	],
	[
		"clients/pipeline.ts#tryDartFix:91623ccc",
		"`dart --version` presence probe, before the package root is known",
	],
	[
		"clients/ruff-client.ts#RuffClient.fixFileAsync:61f923b4",
		"the options object is the local `spawnOpts`, built two statements above with `cwd: cwd ?? path.dirname(absolutePath)`; the scan does not follow an opaque options identifier (stated bound), so the cwd it carries is invisible here",
	],
	[
		"clients/safe-spawn.ts#safeSpawnAsync.killTree:77f62fd4",
		"`taskkill /F /T /PID <pid>` — kills a process tree by pid on Windows; it touches no file",
	],
	[
		"clients/safe-spawn.ts#safeSpawnBatch:921a571e",
		"safeSpawnBatch forwards each command's own `options` object unchanged, so the cwd belongs to whoever built that batch entry",
	],
	[
		"clients/safe-spawn.ts#isCommandAvailableAsync:45a177c3",
		"`which`/`where <command>` PATH lookup (async form)",
	],
	[
		"clients/safe-spawn.ts#findCommandAsync:45a177c3",
		"`which`/`where <command>` PATH lookup that returns the resolved path",
	],
	[
		"clients/safe-spawn.ts#isCommandAvailable:acf75340",
		"`which`/`where <command>` PATH lookup (deprecated sync form)",
	],
	[
		"clients/safe-spawn.ts#findCommand:e3470221",
		"`which`/`where <command>` PATH lookup returning the path (deprecated sync form)",
	],
	[
		"clients/security-scan-client.ts#SecurityScanClient.probeVersion:355605e9",
		"`<tool> <versionArgs>` version probe of a managed or PATH security binary",
	],
	[
		"clients/sg-runner.ts#SgRunner.probeHomebrew:4df45ecb",
		"`brew --prefix ast-grep` — asks Homebrew where it installed the binary",
	],
	[
		"clients/sg-runner.ts#SgRunner.probeCommand:45a37c68",
		"`<ast-grep candidate> --version` availability probe",
	],
	[
		"clients/sg-runner.ts#SgRunner.execRaw:05d2e3a2",
		"execRaw is the shared raw ast-grep invocation: the rule comes from the caller's `-p`/`--config` argument and every target is an explicit path in `args`, so nothing is discovered from the child's directory",
	],
	[
		"clients/sg-runner.ts#SgRunner.exec:84a4a8a1",
		"exec is the shared ast-grep invocation (optionally through bash on Windows): same explicit-argument contract as execRaw",
	],
	[
		"clients/sg-runner.ts#SgRunner.tempScanDetailedAsync:ee763d40",
		"`ast-grep scan --config <temp rule file> --json … <dir>`: both the rule file and the scan root are absolute arguments prepared by prepareTempScan",
	],
	[
		"clients/sg-runner.ts#SgRunner.tempScanWithFixAsync:23665a2b",
		"the match-only pass of the same temp-rule scan, with the same absolute --config and target arguments",
	],
	[
		"clients/sg-runner.ts#SgRunner.tempScanWithFixAsync:0a5b6a4d",
		"the count-first JSON pass before --update-all, same absolute arguments",
	],
	[
		"clients/sg-runner.ts#SgRunner.tempScanWithFixAsync:ed556eb8",
		"the --update-all apply pass, same absolute arguments",
	],
	[
		"clients/test-runner-client.ts#TestRunnerClient.detectRunner:4411bf71",
		"`which pytest` / `where pytest` PATH lookup for the global-pytest fallback",
	],
	[
		"clients/zizmor-config.ts#deriveGhCliToken:6acc7c4b",
		"`gh auth token` — reads the GitHub CLI's own credential store, which is per-user rather than per-project",
	],
];
const ORIGIN_ADMISSION_ROWS: ReadonlyArray<readonly [string, string]> = [
	[
		"clients/biome-client.ts#BiomeClient.spawnBiomeAsync:29a3826f~29a3826f",
		"cwd is spawnBiomeAsync's own `cwd` parameter; the checked sites are its two call sites in this file",
	],
	[
		"clients/biome-client.ts#BiomeClient.fixFileAsync:21f726e7~188c602a",
		"cwd is `configCwd` — the caller's cwd or the formatted file's own directory; BiomeClient is a formatter client with no DispatchContext to resolve from",
	],
	[
		"clients/dead-code-client.ts#PythonDeadCodeClient.runAnalyze:b54a18c7~1167a91f",
		"cwd is runAnalyze's own `root` parameter, the resolved project directory the client was asked to analyse",
	],
	[
		"clients/dependency-checker.ts#DependencyChecker.checkFile:1935bb9d~bed57757",
		"passes `projectRoot` = path.resolve(cwd || process.cwd()) from checkFile's own API argument; DependencyChecker is called from the pipeline, not from dispatch",
	],
	[
		"clients/dependency-checker.ts#DependencyChecker.runMadgeSpawn:7a8cc482~218c0256",
		"cwd is runMadgeSpawn's own `projectRoot` parameter — madge resolves tsconfig/webpack config from the project root, not from the edited file",
	],
	[
		"clients/dependency-checker.ts#DependencyChecker.checkFilesBatch:6e4567d4~57c925ee",
		"batch path: same `projectRoot` local as checkFile, passed into runMadgeSpawn per entry",
	],
	[
		"clients/dependency-checker.ts#DependencyChecker.scanProject:50922783~1c4b5679",
		"whole-project scan: passes the same `projectRoot` local into runScanProject",
	],
	[
		"clients/dependency-checker.ts#DependencyChecker.runScanProject:c4180627~218c0256",
		"cwd is runScanProject's own `projectRoot` parameter",
	],
	[
		"clients/dispatch/runners/biome-check.ts#resolveBiomeFixKinds:b80b220b~dbf27697",
		"cwd is resolveBiomeFixKinds' own `cwd` parameter; the checked site is its caller in this file",
	],
	[
		"clients/dispatch/runners/credo.ts#top:5c9246b1~dbf27697",
		"`mix credo --version` inside a createCwdCachedProbe closure: the `cwd` is the closure parameter that shared probe machinery supplies per call, so no call site in this file can be checked",
	],
	[
		"clients/dispatch/runners/cue-vet.ts#run:f61eafcc~e3b9420d@1",
		"cwd is `fileDir` = dirname(path.resolve(<resolveRunnerCwd result>, ctx.filePath)) — cue vets the file's own package directory; the scan does not follow a path computation, so the derivation is registered here",
	],
	[
		"clients/dispatch/runners/cue-vet.ts#run:1803a70e~e3b9420d",
		"same `fileDir` derivation, the package-wide `cue vet` pass",
	],
	[
		"clients/dispatch/runners/cue-vet.ts#run:f61eafcc~e3b9420d@2",
		"same `fileDir` derivation, the single-file fallback pass",
	],
	[
		"clients/dispatch/runners/eslint.ts#makeEslintProbe:748a199e~dbf27697",
		"`<eslint> --version` inside a createCwdCachedProbe closure: the `cwd` is the closure parameter the probe machinery supplies per call, not a value any caller in this file passes",
	],
	[
		"clients/dispatch/runners/helm-lint.ts#lintChart:dd42fa80~dbf27697",
		"cwd is lintChart's own `cwd` parameter; the checked site is its caller in this file",
	],
	[
		"clients/dispatch/runners/helm-render.ts#runIacPass:b8e36465~dbf27697",
		"cwd is runIacPass's own destructured `cwd` parameter; the checked site is its caller in this file",
	],
	[
		"clients/dispatch/runners/helm-render.ts#renderAndValidate:06daa837~dbf27697",
		"cwd is renderAndValidate's own `cwd` parameter; `helm template` renders into an explicit --output-dir",
	],
	[
		"clients/dispatch/runners/helm-render.ts#renderAndValidate:db985ac0~dbf27697",
		"renderAndValidate forwards its own `cwd` parameter into runIacPass",
	],
	[
		"clients/dispatch/runners/oxlint.ts#resolveVitePlusCommand:7b703741~dbf27697",
		"`vp --version` probe inside resolveVitePlusCommand, whose own `cwd` parameter it passes; the checked site is its caller in this file",
	],
	[
		"clients/dispatch/runners/psscriptanalyzer.ts#spawnPs:35a0658a~dbf27697",
		"spawnPs is the file's parameter-routed wrapper: the cwd is its `options.cwd`, and its three call sites are the checked ones",
	],
	[
		"clients/dispatch/runners/rust-clippy.ts#makeClippyProbe:1dfbec79~dbf27697",
		"`cargo clippy --version` inside a createCwdCachedProbe closure: the `cwd` is the closure parameter the probe machinery supplies per call",
	],
	[
		"clients/dispatch/runners/rust-clippy.ts#run:dba44d7f~19a492a2",
		"cwd is the directory of `findCargoToml(ctx.filePath)` — cargo must run at the package root, which is derived from the edited file rather than from the seam",
	],
	[
		"clients/dispatch/runners/terragrunt.ts#run:d106f5a8~d27138c5",
		"cwd is `fileDir` = dirname(path.resolve(<resolveRunnerCwd result>, ctx.filePath)): `terragrunt hcl validate` validates the unit directory the file sits in",
	],
	[
		"clients/dispatch/runners/tflint.ts#run:338013e8~e3b9420d",
		"cwd is `fileDir` = dirname(path.resolve(<resolveRunnerCwd result>, ctx.filePath)): tflint scans one module directory and its --config is passed absolute",
	],
	[
		"clients/dispatch/runners/utils/lazy-installer.ts#runLazyInstall:c226c0b2~c226c0b2",
		"runLazyInstall forwards its own `cwd` parameter into performInstall",
	],
	[
		"clients/dispatch/runners/utils/lazy-installer.ts#performInstall:0e6f55b2~dbf27697",
		"cwd is performInstall's own `cwd` parameter; the checked site is runLazyInstall's call in this file",
	],
	[
		"clients/dispatch/runners/utils/lazy-installer.ts#tryLazyInstall:1adf4f32~1adf4f32",
		"tryLazyInstall forwards its own `cwd` parameter into runLazyInstall",
	],
	[
		"clients/dispatch/runners/utils/lazy-installer.ts#tryLazyInstallForFormatter:1adf4f32~1adf4f32",
		"tryLazyInstallForFormatter forwards its own `cwd` parameter into runLazyInstall",
	],
	[
		"clients/dispatch/runners/utils/runner-helpers.ts#createAvailabilityChecker.isAvailableAsync:8b06bf2f~d99d2124",
		"cwd is `resolvedCwd`, the availability checker's own cwd argument; the checker is the seam every runner probes through",
	],
	[
		"clients/dispatch/runners/utils/runner-helpers.ts#resolveToolCommandWithInstallFallback:e313e2e7~dbf27697",
		"resolveToolCommandWithInstallFallback forwards its own `cwd` parameter into resolveCommandWithInstallFallback",
	],
	[
		"clients/dispatch/runners/utils/runner-helpers.ts#verifyOrInstallCommand:d80f1e68~dbf27697",
		"cwd is verifyOrInstallCommand's own `cwd` parameter; its two call sites in this file are the checked ones",
	],
	[
		"clients/dispatch/runners/utils/runner-helpers.ts#resolveCommandArgsWithInstallFallback:0dcab07a~cb93074a",
		"cwd is resolveCommandArgsWithInstallFallback's own `cwd` parameter, used for the `--version` verification spawn",
	],
	[
		"clients/dispatch/runners/utils/runner-helpers.ts#resolveCommandArgsWithInstallFallback:105fdbcb~dbf27697",
		"resolveCommandArgsWithInstallFallback forwards its own `cwd` parameter into verifyOrInstallCommand",
	],
	[
		"clients/dispatch/runners/utils/runner-helpers.ts#resolveCommandWithInstallFallback:4a5cc9b1~4a5cc9b1",
		"resolveCommandWithInstallFallback forwards its own `cwd` parameter into verifyOrInstallCommand",
	],
	[
		"clients/file-utils.ts#detectFileChangedAfterCommand:9a4b1a12~dbf27697",
		"cwd is detectFileChangedAfterCommand's own `cwd` parameter; its callers live in other files, which a per-file scan cannot follow",
	],
	[
		"clients/git-tracked-ignore.ts#fetchUntrackedIgnoredIds:3b26d235~dbf27697",
		"cwd is fetchUntrackedIgnoredIds' own `cwd` parameter; the checked site is collectUntrackedIgnoredIds in this file",
	],
	[
		"clients/git-tracked-ignore.ts#collectUntrackedIgnoredIds:538456dd~538456dd",
		"collectUntrackedIgnoredIds forwards its own `cwd` parameter, the repository root its callers pass",
	],
	[
		"clients/git-tracked-ignore.ts#fetchTrackedFiles:5fc25306~dbf27697",
		"cwd is fetchTrackedFiles' own `cwd` parameter; the checked site is collectTrackedFiles in this file",
	],
	[
		"clients/git-tracked-ignore.ts#collectTrackedFiles:0f864633~0f864633",
		"collectTrackedFiles forwards its own `cwd` parameter, the repository root its callers pass",
	],
	[
		"clients/gitleaks-client.ts#GitleaksClient.scan:c23b1b18~4bd5cc03",
		"passes `targetDir` = path.resolve(cwd) from the scan API's own argument; the security clients are driven by the MCP surface, not by dispatch",
	],
	[
		"clients/gitleaks-client.ts#GitleaksClient.runScan:94ae6442~353ea442",
		"cwd is runScan's own `cwd` parameter, and the scoped gitleaks config is written against it",
	],
	[
		"clients/govulncheck-client.ts#GovulncheckClient.analyze:c23b1b18~4bd5cc03",
		"passes `targetDir` = path.resolve(cwd) from the analyze API's own argument",
	],
	[
		"clients/govulncheck-client.ts#GovulncheckClient.runScan:aa1bfd70~353ea442",
		"cwd is runScan's own `cwd` parameter; `govulncheck -mode=source ./...` is relative to it by design",
	],
	[
		"clients/installer/index.ts#runCommand:bed06f4a~dbf27697",
		"cwd is runCommand's own `cwd` parameter; its three call sites in this file are the checked ones",
	],
	[
		"clients/installer/index.ts#installArchiveTool:ba060684~a938e107",
		"cwd is TOOLS_DIR, the managed-tool install directory this archive is being extracted into",
	],
	[
		"clients/installer/index.ts#installNpmTool.runInstallAttempt:166c7cea~a938e107",
		"cwd is TOOLS_DIR: the npm install runs in the managed-tool directory, never in the user's project",
	],
	[
		"clients/installer/managed-tool-refresh.ts#performNpmRefresh:0b3e9872~abe0cd3c",
		"cwd is `toolsDir`, the managed-tool install directory being refreshed",
	],
	[
		"clients/jscpd-client.ts#JscpdClient.scan:d8e5a0b6~86b35ae4",
		"passes `targetDir` = path.resolve(cwd) from the scan API's own argument",
	],
	[
		"clients/jscpd-client.ts#JscpdClient.runScan:441c892b~dbf27697",
		"cwd is runScan's own `cwd` parameter, and `hasProjectJscpdConfig(cwd)` decides the flags from the same directory",
	],
	[
		"clients/knip-client.ts#KnipClient.runAnalyze:b959739e~f5c0e305",
		"cwd is `targetDir`, runAnalyze's own project-root parameter; knip resolves its config from there",
	],
	[
		"clients/mcp/review.ts#runRebuild:f93df254~9f5ecf07",
		"cwd is `repoRoot`, the repository the rebuild script belongs to",
	],
	[
		"clients/opaque-mutation-scan.ts#isGitWorktree:7e6a8cd3~edb3d44f",
		"cwd is isGitWorktree's own `root` parameter — `git rev-parse --is-inside-work-tree` asks about exactly that directory",
	],
	[
		"clients/opaque-mutation-scan.ts#resolveGitToplevel:49511e7e~1167a91f",
		"cwd is resolveGitToplevel's own `root` parameter — `git rev-parse --show-toplevel` asks about exactly that directory",
	],
	[
		"clients/opaque-mutation-scan.ts#recoverOpaqueChangesViaGit:dad86fa7~1167a91f",
		"cwd is recoverOpaqueChangesViaGit's own `root` parameter — `git status --porcelain` reports the worktree at that root",
	],
	[
		"clients/opengrep-client.ts#OpengrepClient.scan:c23b1b18~4bd5cc03",
		"passes `targetDir` = path.resolve(cwd) from the scan API's own argument",
	],
	[
		"clients/opengrep-client.ts#OpengrepClient.runScan:93a73c72~353ea442",
		"cwd is runScan's own `cwd` parameter, from which OpengrepClient.resolveConfig(cwd) already chose the rule config",
	],
	[
		"clients/pipeline.ts#tryEslintFix:a8585677~dbf27697",
		"cwd is tryEslintFix's own `cwd` parameter, used for the eslint `--version` probe; the checked site is runAutofix in this file",
	],
	[
		"clients/pipeline.ts#tryRustClippyFix:cabb2369~86686e4d",
		'cwd is `cargoDir` = findNearestContaining(dirname(filePath), ["Cargo.toml"]): `cargo clippy --fix` must run at the package root',
	],
	[
		"clients/pipeline.ts#tryDartFix:656dd10b~7514b242",
		'cwd is `pubspecDir` = findNearestContaining(dirname(filePath), ["pubspec.yaml"]): `dart fix --apply` must run at the package root',
	],
	[
		"clients/pipeline.ts#runAutofix:b112a810~b112a810",
		"runAutofix forwards its own `cwd` parameter into tryEslintFix",
	],
	[
		"clients/pipeline.ts#runPipeline:a5f29544~a5f29544",
		"runPipeline forwards its own `cwd` parameter into runAutofix",
	],
	[
		"clients/ruff-client.ts#RuffClient.fixFileAsync:22e02ee5~32f35590",
		"cwd is the caller's own `cwd` argument, falling back to the linted file's directory; RuffClient is an autofix client with no DispatchContext seam",
	],
	[
		"clients/safe-spawn.ts#safeSpawnAsync:f7eca8ca~98fad979",
		"this IS the spawn seam: `spawnCwd` is the cwd its own caller passed in options, so the origin rule applies to the callers, not here",
	],
	[
		"clients/shared-checkout-guard.ts#probeWorkingTreeState:67edebd4~c87eec21",
		"cwd is probeWorkingTreeState's own `root` parameter — `git status` reports the worktree at that root",
	],
	[
		"clients/trivy-client.ts#TrivyClient.scan:c23b1b18~4bd5cc03",
		"passes `targetDir` = path.resolve(cwd) from the scan API's own argument",
	],
	[
		"clients/trivy-client.ts#TrivyClient.runScan:8715cda5~353ea442",
		"cwd is runScan's own `cwd` parameter, the directory `trivy fs` is pointed at",
	],
];
const MIGRATION_WORKLIST_ROWS: ReadonlyArray<readonly [string, string]> = [
	[
		"clients/dispatch/runners/helm-lint.ts#run:833aee95~833aee95",
		'#2882: helm-lint\'s run() reads `ctx.cwd` directly instead of resolveRunnerCwd(ctx, "helm") — the one runner still bypassing the #2777 seam, and this row retires when that lands',
	],
	[
		"clients/test-runner-client.ts#TestRunnerClient.runTestFileAsync:d02073e6~dbf27697",
		"#2871: the test-runner spawn takes its cwd from the client's own resolution instead of resolveToolCwd; PR #2879 moves it onto the seam and this row goes with it",
	],
];
/**
 * The worklist can only shrink. Lower this when a row lands; never raise it —
 * a new non-conforming site belongs in one of the two reasoned tables above,
 * or gets fixed.
 */
const WORKLIST_CEILING = 2;
const NO_CWD_EXEMPTIONS = Object.fromEntries(NO_CWD_EXEMPTION_ROWS);
const ORIGIN_ADMISSIONS = Object.fromEntries([
	...ORIGIN_ADMISSION_ROWS,
	...MIGRATION_WORKLIST_ROWS,
]);

/**
 * The identity of one flagged call site, immune to line churn and sensitive to
 * everything a reviewer would want re-examined:
 *
 *   `<file>#<enclosing symbols>:<hash of the call text>~<hash of the cwd expression>`
 *
 * - the SYMBOL comes from the AST (`SgRunner.probeVersion`), not from
 *   `findEnclosingSymbol`'s column-zero text match, which resolved every
 *   method of a class to the class name and let three `sg-runner.ts` spawns
 *   share one key (v3-F3);
 * - the CALL hash covers callee, argv and options, so two spawns in one method
 *   differ by what they run;
 * - the CWD hash covers the `cwd` property and the declaration of every local
 *   its value hops through, so editing `cwd: fileDir` to `cwd: ctx.cwd`
 *   retires the admission instead of inheriting it (v3-F2: the old key hashed
 *   the `safeSpawnAsync(` line, which no cwd edit touches);
 * - `@n` disambiguates the last case the content cannot: two byte-identical
 *   calls in one function (`cue-vet.ts` runs the same single-file `cue vet`
 *   twice). Adding a third one renumbers the rest, which is the right
 *   direction — each admission is re-read.
 *
 * `auditRegistry`'s `requireUniqueFlagged` (on by default) is the backstop: if
 * this ever hands two live sites one key, the sweep says so instead of letting
 * one row excuse both.
 */
function siteKeys(
	source: string,
	sites: readonly SpawnCwdSite[],
): Map<SpawnCwdSite, string> {
	const lines = source.split("\n");
	const textOf = (numbers: readonly number[]): string =>
		numbers.map((line) => lines[line - 1] ?? "").join("");
	const baseOf = (site: SpawnCwdSite): string =>
		`${site.file}#${site.symbol ?? "top"}:${lineContentHash(textOf(site.callLines))}` +
		(site.cwdLines.length > 0
			? `~${lineContentHash(textOf(site.cwdLines))}`
			: "");
	const totals = new Map<string, number>();
	for (const site of sites) {
		totals.set(baseOf(site), (totals.get(baseOf(site)) ?? 0) + 1);
	}
	const seen = new Map<string, number>();
	const keys = new Map<SpawnCwdSite, string>();
	for (const site of sites) {
		const base = baseOf(site);
		const ordinal = (seen.get(base) ?? 0) + 1;
		seen.set(base, ordinal);
		keys.set(site, (totals.get(base) ?? 0) > 1 ? `${base}@${ordinal}` : base);
	}
	return keys;
}

describe("dispatch runner spawns pass ctx.cwd (#2691 ratchet)", () => {
	const files = POPULATION_FILES.filter((file) =>
		/\b(?:safeSpawnAsync|safeSpawnSync|safeSpawn|spawnSupervised|execa)\s*\(/.test(
			fs.readFileSync(file, "utf8"),
		),
	);
	const sites: SpawnCwdSite[] = [];
	const keyBySite = new Map<SpawnCwdSite, string>();

	beforeAll(async () => {
		for (const file of files) {
			const relFile = path.relative(REPO_ROOT, file);
			const source = fs.readFileSync(file, "utf8");
			const scan = await scanSpawnCwd(relFile, source);
			for (const [site, key] of siteKeys(source, scan.sites)) {
				keyBySite.set(site, key);
			}
			sites.push(...scan.sites);
		}
	});

	const keyOf = (site: SpawnCwdSite): string => {
		const key = keyBySite.get(site);
		if (!key) throw new Error(`no key for ${site.file}:${site.line}`);
		return key;
	};
	const flag = (site: SpawnCwdSite): { key: string; detail: string } => ({
		key: keyOf(site),
		detail: `${site.file}:${site.line} (${site.callee})`,
	});

	it("scans the whole runner directory and finds the pinned population", () => {
		// The emptiness guard first (defect shape 10, #1718): a sweep that
		// matched nothing must fail, not read as clean.
		assertNonEmptyScan(
			"runner-spawn-cwd-sweep: spawn-bearing source files scanned",
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

	it("every non-exempt spawn's options object names a usable cwd", () => {
		const audit = auditRegistry({
			sweepName: "runner-spawn-cwd-sweep (presence)",
			flagged: sites.filter((site) => !site.hasCwd).map(flag),
			registered: [],
			exemptions: NO_CWD_EXEMPTIONS,
			// A tree where every spawn conforms must read as clean, not as a dead
			// sweep: the reach pins above are what catch a scan that stopped
			// seeing sites, and they do it without inverting.
			minFlagged: 0,
			remediation:
				"Pass the resolver result — directly, through a local, or through an " +
				"object spread. Admit a genuine non-project child only by adding a row " +
				"to NO_CWD_EXEMPTION_ROWS whose reason is true of THAT site.",
		});
		expect(audit.problems.join("\n\n"), "presence rule").toBe("");
	});

	it("every dispatch cwd binding comes from the shared tool-cwd seam (#2777)", () => {
		const audit = auditRegistry({
			sweepName: "runner-spawn-cwd-sweep (origin)",
			flagged: sites
				.filter((site) => site.hasCwd && !site.resolvedFromToolCwd)
				.map(flag),
			registered: [],
			exemptions: ORIGIN_ADMISSIONS,
			// A tree where every spawn conforms must read as clean, not as a dead
			// sweep: the reach pins above are what catch a scan that stopped
			// seeing sites, and they do it without inverting.
			minFlagged: 0,
			remediation:
				"Resolve the cwd through resolveToolCwd/resolveRunnerCwd/" +
				"resolveFormatterCwd imported from the shared seam, or add a row to " +
				"ORIGIN_ADMISSION_ROWS (a deliberate derivation) or " +
				"MIGRATION_WORKLIST_ROWS (a site that should move onto the seam) " +
				"whose reason is true of THAT site.",
		});
		expect(audit.problems.join("\n\n"), "origin rule").toBe("");
	});

	it("the migration worklist only shrinks, and every row names its issue", () => {
		// A worklist row is an admission with an expiry, so it must stay
		// countable and traceable. Liveness is already enforced: a row whose
		// site conforms (or disappears) shows up as a stale exemption in the
		// origin audit above.
		expect(
			MIGRATION_WORKLIST_ROWS.length,
			"the worklist grew; a new non-conforming site belongs in a reasoned " +
				"table or gets fixed",
		).toBeLessThanOrEqual(WORKLIST_CEILING);
		expect(
			MIGRATION_WORKLIST_ROWS.filter(([, reason]) => !/#\d+/.test(reason)).map(
				([key]) => key,
			),
			"a worklist row must name the issue that retires it",
		).toEqual([]);
	});

	it("no runner reaches safeSpawn* under an alias or through call/apply", () => {
		// R3-F2. These spellings are not sites, so they cannot move the pinned
		// population and nothing else in this file would notice them. Zero
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
});
