# Language Coverage

pi-lens supports **37+ languages** through dispatch runners and LSP integration.

Formatting uses a single selected formatter per file: explicit project config wins, otherwise pi-lens uses a smart default where supported, and config-first ecosystems do not autoformat without config.

Dispatch is diagnostics-oriented: automatic formatting and safe autofix happen in the post-write pipeline rather than through dispatch format-check runners.

| Language              | LSP | Dispatch Runners                                                                                               | Formatter               |
| --------------------- | --- | -------------------------------------------------------------------------------------------------------------- | ----------------------- |
| JavaScript/TypeScript | ✓   | lsp, biome-check-json, tree-sitter, ast-grep-napi, fact-rules, eslint, oxlint | biome, prettier         |
| Python                | ✓   | lsp, pyright, mypy (config-first), ruff-lint, tree-sitter                                                      | ruff, black             |
| Go                    | ✓   | lsp, go-vet, golangci-lint, tree-sitter                                                                        | gofmt                   |
| Rust                  | ✓   | lsp, rust-clippy, tree-sitter                                                                                  | rustfmt                 |
| Ruby                  | ✓   | lsp, rubocop, tree-sitter                                                                                      | rubocop, standardrb     |
| C/C++                 | ✓   | lsp, cpp-check, tree-sitter                                                                                    | clang-format            |
| Shell                 | ✓   | lsp, shellcheck                                                                                                | shfmt                   |
| Fish                  | ✓ (fish-lsp) | lsp, fish-indent                                                                                      | fish_indent             |
| CSS/SCSS/Less         | ✓   | lsp, stylelint                                                                                                 | biome, prettier         |
| HTML                  | ✓   | lsp, htmlhint                                                                                                  | prettier (with project config) |
| YAML                  | ✓   | lsp, yamllint, actionlint (GitHub workflows), trivy-config (opt-in; Kubernetes manifests, CloudFormation)      | prettier (with project config) |
| JSON                  | ✓   | lsp, trivy-config (opt-in; CloudFormation templates only)                                                      | biome, prettier         |
| Svelte                | ✓   | lsp                                                                                                            | oxfmt (needs `svelte` pkg installed + config `svelte: true`) |
| Vue                   | ✓   | lsp                                                                                                            | prettier, oxfmt         |
| SQL                   | —   | sqlfluff                                                                                                       | sqlfluff                |
| Markdown              | —   | spellcheck, markdownlint, vale                                                                                 | prettier                |
| Docker                | ✓   | lsp, hadolint, trivy-config (opt-in)                                                                           | —                       |
| PHP                   | ✓   | lsp, php-lint, phpstan                                                                                         | php-cs-fixer            |
| PowerShell            | ✓   | lsp, psscriptanalyzer                                                                                          | psscriptanalyzer-format |
| Prisma                | ✓   | lsp, prisma-validate                                                                                           | —                       |
| C#                    | ✓   | lsp, dotnet-build                                                                                              | csharpier               |
| F#                    | ✓   | lsp                                                                                                            | fantomas                |
| Java                  | ✓   | lsp, javac                                                                                                     | google-java-format      |
| Java + Lombok         | ✓   | JDT LS launched with `-javaagent:<lombok.jar>` when Lombok is detected and a jar is found (`PI_LENS_LOMBOK_JAR` / `LOMBOK_JAR`, project `.lombok/lombok.jar`, or Maven/Gradle cache) | google-java-format      |
| Kotlin                | ✓   | lsp, ktlint, detekt                                                                                            | ktlint                  |
| Groovy                | ✓ (groovy-language-server; explicit `lens_diagnostics source=lsp` and `lsp_navigation` only) | —                                                                      | —                       |
| Lean 4                | ✓ (Lake `serve`) | lsp; uses each project's Lake toolchain and environment                                               | —                       |
| Swift                 | ✓   | lsp, swiftlint                                                                                                 | swiftformat             |
| Dart                  | ✓   | lsp, dart-analyze                                                                                              | dart format             |
| Lua                   | ✓   | lsp                                                                                                            | stylua                  |
| Zig                   | ✓   | lsp, zig-check                                                                                                 | zig fmt                 |
| Haskell               | ✓   | lsp                                                                                                            | ormolu                  |
| Elixir                | ✓ (ElixirLS default, Expert alternate) | lsp, elixir-check, credo                                                                   | mix format              |
| Gleam                 | ✓   | lsp, gleam-check                                                                                               | gleam format            |
| Typst                 | ✓ (tinymist) | —                                                                                                         | typstyle (`.typ`, `.typc`) |
| OCaml                 | ✓   | lsp                                                                                                            | ocamlformat             |
| Clojure               | ✓   | lsp                                                                                                            | cljfmt                  |
| Terraform             | ✓   | lsp, tflint, trivy-config (opt-in)                                                                             | terraform fmt           |
| Terragrunt            | —   | terragrunt                                                                                                     | terragrunt hcl fmt      |
| Nix                   | ✓   | lsp                                                                                                            | nixfmt                  |
| TOML                  | ✓   | lsp, taplo                                                                                                     | taplo                   |
| CMake                 | ✓ (cmake-language-server) | lsp                                                                                      | cmake-format            |
| CUE                   | ✓ (syntax via cue lsp, evaluation via cue vet) | lsp, cue-vet                                                              | cue fmt                 |

### CUE tree-sitter grammar

`cue lsp` reports load and parse errors as you type but leaves conflicting
values and failed constraints to `cue vet` — the `cue-vet` auxiliary runner
(#1522) covers that gap, so together they give full coverage: syntax/parse
diagnostics, hover, definition, completion, code actions, and formatting from
the language server, plus evaluation-error validation from `cue vet` on every
edit (vetted at the PACKAGE level — the touched file's directory — with the
result filtered back to that file, since CUE packages are directory-scoped).
`.cue` files parse under tree-sitter with symbol (`#Definition`s, fields,
`let` bindings) and import queries (#1522), giving CUE the same structural
symbol search and import extraction as any other language, with two known
rough edges inherited from the young `tree-sitter-cue` grammar itself (not
this repo's queries):

- **Multi-hash raw strings** (`` ##"..."## ``, two or more `#` delimiters)
  mis-parse regardless of content — the field's value becomes a bare
  `identifier` node instead of a `string`, and the parser emits stray
  top-level nodes outside the field entirely. Because the broken value node
  can carry `#`-prefixed text, this can surface as a spurious symbol
  reference in the extracted refs. Single-hash raw strings (`` #"..."# ``)
  are unaffected.
- **Aliased field labels** (`X=name: value`) emit the alias identifier (`X`)
  as its own spurious `property` symbol alongside the real field's correct
  symbol, because the grammar exposes both identifiers as untagged siblings
  under the same `label` node with no way to tell them apart structurally.

Both are upstream grammar limitations (tracked among
[eonpatapon/tree-sitter-cue](https://github.com/eonpatapon/tree-sitter-cue)'s
open issues), not something a query change here can fix.

### Groovy tree-sitter grammar

`.groovy`, `.gvy`, `.gy` and `.gsh` files, plus `Jenkinsfile`, `build.gradle`
and `settings.gradle`, parse under tree-sitter, so `module_report`,
`read_symbol`, symbol search, import extraction and the call-graph refs all
support Groovy (#5235). Symbol extraction lists classes, traits, interfaces,
enums, records, constructors, methods, and named closures held by a class
field or a top-level script variable; import extraction reads qualified
import names, and the call-graph refs cover calls, constructions and type
names.
The grammar is [dekobon/tree-sitter-groovy](https://github.com/dekobon/tree-sitter-groovy)
v0.3.0, built to wasm at its tagged commit with `tree-sitter-cli@0.25.10` and
committed to `vendor/grammars/` **as is, with no fork and no patch**. It is a
young grammar and it is partial. Measured on 2026-11-05 over 1,353 real files
from five public repositories (Spock, jenkinsci/pipeline-examples,
apache/groovy, Gradle, grails-core), **70% parse with no ERROR node** and 8.1%
of lines sit inside an error:

| Sample                         | Files parsed with no ERROR node |
| ------------------------------ | ------------------------------- |
| `build.gradle` (Gradle, 250)   | 95%                             |
| Jenkins pipeline-examples (53) | 73%                             |
| `Jenkinsfile`-named files (4)  | 50%                             |
| Spock (400)                    | 64%                             |
| Grails (250)                   | 56%                             |
| apache/groovy (400)            | 69%                             |

The Spock and apache/groovy samples are weighted toward language-stress tests,
so they are harder than typical project code. "No ERROR node" is a parse
measure, not a claim that the outline is right. Known gaps, all in the
upstream grammar rather than in this repo's queries:

- **Types nested in a class body.** A `class`, `interface`, `enum` or `trait`
  declared inside another class produces an ERROR node and often a stray `}`
  after it.
- **Command calls with named arguments.** `mail to: x, subject: y`,
  `slackSend channel: x, message: y` and `@Library('x') _` do not parse. These
  are common in Jenkins pipelines and in Gradle dependency blocks.
- **A field with modifiers and no type or `def`.** `static x = {` and
  `static final X = 1` do not parse.
- **The diamond.** `new HashMap<>()` leaves a MISSING type node.

Consequences:

- A file with an ERROR node still yields the declarations the parser recovered
  around it, but may miss the ones it could not. `module_report` and the read
  tools carry a syntax-error warning ("tree-sitter could not parse part of this
  file; the symbol list may be incomplete"): `module_report` on every such
  partial parse, `read_symbol` only when the name is not found. An absent
  symbol is not proof of absence.
- Named closures (`def handler = { ... }`) are listed only when held by a class
  field or a top-level script variable. A method-local closure is not listed.
- Calls that take a trailing closure (`list.each { ... }`, DSL blocks) parse as
  sibling statements, not as invocations, so they add no call-graph edge. Only
  `foo(1)`, `a.b(2)` and `new X()` do.
- A Spock feature method (`def "adds two numbers"() { ... }`) is listed under
  its quoted name.
- `Jenkinsfile`, `build.gradle` and `settings.gradle` reach the grammar by file
  kind, which covers `module_report` and the symbol index. Read expansion, the
  project scanner and the directory-wide tree-sitter search key on the file
  extension, so they see `.groovy`, `.gvy`, `.gy` and `.gsh` only; other
  `.gradle` files are not claimed.
- Groovy has no tuned callback rules, so `module_report` reports its
  callbacks as `generic`, and Groovy is not in the review graph's main kinds.
- Lint and format (npm-groovy-lint) are not part of this slice (#5235).

## What runs by default

Each tool falls in one of three tiers. The gate comes from two layers in the code: the policy in `clients/tool-policy.ts` (`gate`, `defaultWhenUnconfigured`, and the per-tool `configEligibility`), and the skip inside each runner's `run` function. The table lists the tools the README names, plus the other runners that have no policy entry. Where the runner's skip is stricter than the policy, the table follows the runner and the notes below say so. `tests/config/gate-table-derived.test.ts` derives each tool's tier from `clients/tool-policy.ts` and fails when this table disagrees.

A tool counts as available when the binary exists in the project (`node_modules/.bin`, `.venv/bin`, or `vendor/bin`), in pi-lens's managed install, or on `PATH`. The project rung runs only when pi trusts the project (`resolveToolCommandWithInstallFallback` in `clients/dispatch/runners/utils/runner-helpers.ts`, `refuseLocalBin` in `clients/package-manager.ts`). pi-lens installs a missing linter or formatter only when its `autoInstall` is true in `TOOL_EXECUTION_POLICY`; ESLint, phpstan, and vale are never auto-installed. Language servers have no policy row: `ensureTool` in `clients/lsp/server.ts` installs a missing server, such as the TypeScript language server. Every install also needs pi project trust (`assertInstallAllowed` in `clients/project-trust.ts`).

| Tier | Tool | Gate | Source |
|---|---|---|---|
| No project config | Language servers | On by default; `--no-lsp` turns them off | `no-lsp` in `clients/lens-flag-registry.ts` |
| No project config | ruff (Python lint), `.py` format | Policy `smart-default`; ruff is the Python default | `getLinterPolicyForFile`, `ruff.ts` |
| No project config | shellcheck | Policy `smart-default`; `.shellcheckrc` is optional; skips zsh | `shellcheck.ts` |
| No project config | hadolint, markdownlint, rubocop, ktlint (lint), taplo (lint) | Policy `smart-default`, no runner skip for config | `getLinterPolicyForFile`, one runner file each |
| No project config | stylelint | Policy `smart-default`; with no config it runs default rules | `stylelint.ts` |
| No project config | oxlint, Biome (JS and TS lint) | The default pair when the project has no ESLint, oxlint, or Biome config; one project config selects its tool | `getPreferredJstsLintRunners`, `biome-check.ts` |
| No project config | swiftlint, go vet, ast-grep rules, tree-sitter rules | No linter-policy entry; the runner has no config skip. go vet needs the Go toolchain. | `swiftlint.ts`, `go-vet.ts`, `ast-grep-napi.ts`, `tree-sitter.ts` |
| No project config | javac | No policy entry; skips files inside a Maven or Gradle project | `javac.ts` |
| No project config | Formatters: Biome (`.js .jsx .mjs .cjs .ts .tsx .mts .cts .css .scss .sass`), shfmt, gofmt, rustfmt, ruff, typstyle (`.typ .typc`), prettier (`.less .graphql .gql` only), gleam, dart, zig, cue | Formatter policy `defaultWhenUnconfigured: true`; explicit project config wins | `FORMATTER_POLICY_BY_EXTENSION`, `getFormattersForFile` |
| Project config | ESLint | Needs an ESLint config; policy `config-first` | `eslint.ts` |
| Project config | golangci-lint | Needs a golangci config; policy `config-first` | `golangci-lint.ts` |
| Project config | mypy | Needs a mypy config; ruff covers Python without it | `mypy.ts` |
| Project config | phpstan | Needs `phpstan.neon`, `phpstan.neon.dist`, or `phpstan.dist.neon` | `phpstan.ts` |
| Project config | vale | Needs `.vale.ini` | `vale.ts` |
| Project config | detekt | Needs a detekt config file | `detekt.ts` |
| Project config | credo | Needs `mix.exs` in the project directory | `credo.ts` |
| Project config | Formatters: taplo, clang-format, php-cs-fixer, stylua, and other `config-first` rows; ktfmt; ktlint (format) | Run only when the project has their config | `FORMATTER_POLICY_BY_EXTENSION`, `hasExplicitFormatterConfig` |
| Opt-in | trivy (IaC scans and session scan) | `trivy.enabled: true` in `.pi-lens.json` | `isTrivyEnabled` in `clients/trivy-client.ts` |
| Opt-in | SpotBugs | `--lens-spotbugs`, a Java build descriptor, and compiled `.class` files | `withSpotbugsGroup` in `clients/dispatch/integration.ts` |
| Opt-in | Helm render validation | `helm.renderValidation.enabled: true`, plus pi project trust | `helm-render.ts` |
| Opt-in | Commit guard | `--lens-guard` | `lens-guard` in `clients/lens-flag-registry.ts` |

Notes on rows where the two layers differ:

- taplo lints with no config but formats only with config. The same split holds for ktlint.
- prettier is a smart default for the formatter policy only on `.less`, `.graphql`, and `.gql`. Other prettier rows wait for config.
- credo's file policy is `smart-default` with `defaultWhenUnconfigured: true`, but its runner skips a project without `mix.exs`. The table follows the runner.
- mypy's per-tool row is `config-first`, while the Python file policy is `smart-default` because ruff is the default runner.
- The background scans (gitleaks, govulncheck, trivy) have their own gates; see [features](features.md).

## Non-core grammars

The `tree-sitter` runner and `symbol_search`/`module_report` structural
extraction ship a fixed set of core grammars; grammars for the other
languages in the table above (CUE included) are fetched lazily on first use
into web-tree-sitter's resolved package directory, verified against
`scripts/grammars.lock.json`. This resolution works on a runtime that cannot
resolve a bare package specifier — pi shipped as a `bun build --compile`
binary — via one shared subpath-based ladder
(`scripts/lib/web-tree-sitter-dir.mjs`, #3409); before that fix, non-core
languages could never be analysed on those hosts. A grammar that never loads
(fetch failure, unwritable target, an unsupported runtime) is recorded as a
`grammar_unavailable` **skip**, never a clean pass
(`clients/dispatch/runners/tree-sitter.ts`).

## Considered and skipped (2026-08-20 survey, closed out by #1757)

Recorded so these are not re-litigated. The 2026-08-20 survey's first pass
rejected `bandit` and `checkov` as duplicates of existing lanes; #1752's
review disproved both "already covered" claims against the actual code, and
#1757 closed the resulting gaps:

- **bandit** (Python SAST) — RESOLVED. ruff's `S` ruleset implements Bandit's
  checks; `config/ruff/core.toml` now selects `S`, with `S101` (assert),
  `S311` (non-cryptographic random), `S603`/`S607` (subprocess without
  `shell=True` / partial executable path) excluded as over-firing on real
  code (measured against the `requests` and `pip` packages — see the config
  file's comments for the exclusion reasoning and hit counts). `C90`
  (mccabe complexity) was evaluated and NOT enabled: it is a maintainability
  metric, not a Bandit-equivalent security check, and its hit volume on a
  large pre-existing codebase (379 in `pandas`) would drown the security
  signal `S` adds. As always, a project-local ruff config overrides the
  bundled one outright.
- **checkov** (IaC security) — the `trivy config` lane pi-lens's own dispatch
  registry already carries (`clients/dispatch/runners/trivy-config.ts`,
  opt-in via `trivy.enabled`) makes checkov a duplicate, not a gap: no
  second full-scan tool is needed. That lane covers Kubernetes manifests,
  Dockerfiles, and Terraform; #1757 added CloudFormation (yaml and json
  templates, detected via `AWSTemplateFormatVersion` / SAM `Transform` /
  `Type: AWS::*` heuristics) and fixed a real bug found while verifying
  against the installed binary: the runner passed `--no-progress` to `trivy
  config`, a flag that subcommand rejects (only `trivy fs` accepts it) —
  every real invocation exited 1 and, because trivy prints its usage text to
  stdout on a rejected flag, was misreported as a clean `succeeded` scan
  rather than an errored one. Dropping the flag was the fix.
- **radon / lizard** (complexity) — still not enabled; see the C90 note
  above. Unchanged conclusion, now backed by measurement rather than
  assumption.

Known coverage holes with no tool currently clearing the adoption bar: Rust and Java dead-code detection, Ruby type checking (sorbet judged too heavy and idiosyncratic for a default lane).
