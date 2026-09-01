# Language Coverage

pi-lens supports **36+ languages** through dispatch runners and LSP integration.

Formatting uses a single selected formatter per file: explicit project config wins, otherwise pi-lens uses a smart default where supported, and config-first ecosystems do not autoformat without config.

Dispatch is diagnostics-oriented: automatic formatting and safe autofix happen in the post-write pipeline rather than through dispatch format-check runners.

| Language              | LSP | Dispatch Runners                                                                                               | Formatter               |
| --------------------- | --- | -------------------------------------------------------------------------------------------------------------- | ----------------------- |
| JavaScript/TypeScript | ✓   | lsp, ts-lsp, biome-check-json, tree-sitter, ast-grep-napi, type-safety, similarity, fact-rules, eslint, oxlint | biome, prettier         |
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
| Swift                 | ✓   | lsp, swiftlint                                                                                                 | swiftformat             |
| Dart                  | ✓   | lsp, dart-analyze                                                                                              | dart format             |
| Lua                   | ✓   | lsp                                                                                                            | stylua                  |
| Zig                   | ✓   | lsp, zig-check                                                                                                 | zig fmt                 |
| Haskell               | ✓   | lsp                                                                                                            | ormolu                  |
| Elixir                | ✓ (ElixirLS default, Expert alternate) | lsp, elixir-check, credo                                                                   | mix format              |
| Gleam                 | ✓   | lsp, gleam-check                                                                                               | gleam format            |
| OCaml                 | ✓   | lsp                                                                                                            | ocamlformat             |
| Clojure               | ✓   | lsp                                                                                                            | cljfmt                  |
| Terraform             | ✓   | lsp, tflint, trivy-config (opt-in)                                                                             | terraform fmt           |
| Terragrunt            | —   | terragrunt                                                                                                     | terragrunt hcl fmt      |
| Nix                   | ✓   | lsp                                                                                                            | nixfmt                  |
| TOML                  | ✓   | lsp, taplo                                                                                                     | taplo                   |
| CMake                 | ✓ (cmake-language-server) | lsp                                                                                      | cmake-format            |
| CUE                   | ✓ (syntax via cue lsp, evaluation via cue vet) | lsp, cue-vet                                                              | cue fmt                 |

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
