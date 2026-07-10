# Features

### LSP Support

pi-lens includes **37 language server definitions** (including two cross-cutting *auxiliary* scanners that attach alongside the file's language server — Opengrep for security, and ast-grep for structural rules in projects with an `sgconfig.y[a]ml` — see below). LSP is **enabled by default** (`--lsp` or no flag). Servers are auto-discovered from PATH, project `node_modules`, and managed installs. When a server is not installed, pi-lens offers an interactive install prompt.

**LSP Idle Management:** LSP servers shut down after 240 seconds of inactivity (no files modified) to free resources. The timer resets when you resume editing, preventing cold-start penalties during active development.

**Warm files:** For language servers that index lazily (e.g. clangd), configure `warmFiles` in `.pi-lens/lsp.json` to open entry-point files at session start so the server has AST/index context before the first symbol query:

```json
{ "warmFiles": ["src/main.cpp", "src/lib.cpp"] }
```

**Agent LSP tools:** `lsp_diagnostics` can check one file, a directory, or an explicit `filePaths` batch with bounded concurrency. `lsp_navigation` provides definitions, references, hover, workspace symbols, call hierarchy, rename edits, and `findSymbol` for filtered document-symbol lookup. Key operations:

- **`rename`** — renames a symbol across all references; `apply: true` writes workspace edits to disk with per-file LSP re-sync.
- **`rename_file`** — LSP-aware file rename: sends `workspace/willRenameFiles` to collect import-path rewrites, applies them, renames the file on disk, and notifies servers via `workspace/didRenameFiles`. `apply: false` previews the workspace edits without touching the filesystem.
- **`capabilities`** — shows which operations are supported by the active LSP server(s) for a file, read directly from the cached `initialize` response (no round-trip).
- **Symbol column resolution** — passing `symbol: "myFunc"` instead of an exact `character` position resolves the correct column automatically. Use `symbol: "foo#2"` for the second occurrence of `foo` on the line.

LSP servers for: TypeScript, Deno, Python (pyright/basedpyright + jedi), Go, Rust, Ruby (ruby-lsp + solargraph), PHP, C# (omnisharp), F#, Java (JDT LS, with Lombok javaagent support when a Lombok jar is available), Kotlin, Swift, Dart, Lua, C/C++, Zig, Haskell, Elixir, Gleam, OCaml, Clojure, Terraform, Nix, Bash, Docker, YAML, JSON, HTML, TOML, Prisma, Vue, Svelte, CSS.

### Formatters

pi-lens auto-detects and runs **32 formatters** based on project config:

biome, prettier, oxfmt, ruff, black, sqlfluff, gofmt, rustfmt, zig fmt, dart format, shfmt, nixfmt, mix format, ocamlformat, clang-format, ktlint, rubocop, standardrb, gleam format, terraform fmt, php-cs-fixer, csharpier, fantomas, swiftformat, stylua, ormolu, taplo, fish_indent, google-java-format, cljfmt, cmake-format, psscriptanalyzer-format

Detection rules:

- **Config-gated**: only runs when project config indicates usage (e.g. `biome.json`, `.prettierrc`, `ruff.toml`)
- **Nearest-wins**: when multiple formatter configs exist at different directory levels, the one closest to the edited file wins
- **Biome-default**: for JS/TS files without Prettier or Biome config, Biome is used as the default formatter
- **Ruff-default**: for Python files without Black config, Ruff format is used when available

### Review Graph - Cascade Diagnostics

pi-lens builds a review graph (`file → symbol → dependency`) during session and uses it at turn end to render an impact cascade: which files were affected by a change and how diagnostics propagated through the dependency graph. Nodes track kind, language, and export status; edges track contains/imports/calls/references.

### Read-Before-Edit Guard

pi-lens enforces a **read-before-edit** policy on all file writes and edits. Before allowing a `write` or `edit` tool call on an existing file, it verifies that the agent has previously read sufficient context:

- **Zero-read block** — blocks any edit to a file not read in the current session. Agent-created files are exempt: when a `write` tool creates a new file, pi-lens registers the written content as a synthetic read, so an immediate follow-up `edit` is not blocked
- **File-modified block** — blocks if the file changed on disk since the last read (auto-format, external tool, or a previous edit that was then reformatted)
- **Out-of-range block** — blocks if the edit target lines fall outside the ranges previously read, ensuring the agent cannot modify code it hasn't seen
- **Snapshot validation** — covered edit ranges are hash-checked against the lines the agent actually saw at read time; stale-range edits are rejected even when range coverage exists. Hash capture covers reads up to 3 000 lines

Coverage is tracked across multiple reads: two reads of lines 1–100 and 101–200 together satisfy a full-file write. Symbol-expanded reads (small reads silently widened to the enclosing symbol via tree-sitter) count toward coverage at the symbol level. Markdown files generate a warning instead of blocking (edits outside the section-expanded read range are warned, not silently passed). Plain-text (`.txt`) and log (`.log`) files remain fully exempt.

Override for a single edit: `/lens-allow-edit <path>`

Configure behavior with `--no-read-guard` to disable entirely, or set mode to `warn` instead of `block`.

### Module Report + Read Symbol (Read Substitute)

For "tell me about this file" or "show me one function", prefer the
`module_report` + `read_symbol` pair over a full `read`. Together they're
~4× cheaper than reading the whole file (12 k → 4 k tokens on a 42-symbol
file) and the agent gets a navigable outline plus targeted body fetches
instead of a flat blob of source. See
[`module-report-read-symbol.md`](module-report-read-symbol.md)
for the full design and token-efficiency numbers.

**`module_report(filePath, maxRefsPerSymbol?, blastRadius?, blastRadiusDepth?)`** —
returns a structured outline: every symbol's name/kind/startLine/endLine/signature,
exported vs internal split (with class/interface members nested under their
container), who-uses-this (`usedBy`), fanout/complexity risk flags, and a
`recommendedReads` top-3 ranked by usage + complexity. Each symbol entry includes
a ready-to-use `read` argument (`{path, offset, limit}`) so the agent's next call
sits right there. Pass `blastRadius: true` to also get the cross-file **blast
radius** — transitive dependents aggregated to ranked file `read` args ("if you
change this, verify these files"); read-only over the cached graph, omitted when
cold (this replaced the standalone `pilens_impact` tool). Tree-sitter extract +
cached review-graph lookup; never builds the graph, never calls LSP on this path.
`semantic.source` reports what backed the data (`review-graph` | `none`).

**`read_symbol(filePath, symbol)`** — returns the verbatim body of one
named symbol plus a one-line header (`<kind> <name>  <basename>:<startLine>-<endLine>`).
Records the read against the read-guard so a follow-up edit anywhere in
that symbol's range passes the read-before-edit check (an outline from
`module_report` deliberately does NOT — an outline is shape, not body).

**When to use which:**

- **Skim an unfamiliar file** → `module_report`, then `read_symbol` on the
  one symbol you actually need. ~−60% vs a full `read` for the common case.
- **One giant function in a long file** → skip `module_report`; `read` a
  line range instead (or `read_symbol` if it's named).
- **Tiny file (≤ ~10 lines, 0 symbols)** → just `read`; `module_report`'s
  metadata overhead exceeds the file.
- **Looking for a textual pattern across files** → use `grep` (not `module_report`).
- **Need exact LSP cross-file resolution** → use `lsp_navigation({operation: "definition"})`.

**MCP mirror:** `pilens_module_report` and `pilens_read_symbol` in the
pi-lens MCP server expose the same shape to Claude Code / any MCP client.

### Actionable Warnings

At `turn_end`, pi-lens writes `.pi-lens/cache/actionable-warnings.json` summarizing fixable warnings introduced by the current turn. This powers the optional conservative autofix at `agent_end`.

**Report contents:**

- Warnings are delta-only by default: only diagnostics in lines touched during the current turn are included. Pass `--lens-actionable-warning-all` to report all warnings regardless of location
- Each warning carries a stable `aw:<hash>` ID derived from file, rule, and message, so suppression state persists across turns in `.pi-lens/cache/actionable-warning-state.json`
- Sources: pipeline `fixable` diagnostics (always included) and LSP code-action warnings when `--lens-actionable-warning-actions` is set
- When warnings are present, a concise advisory is injected into the agent context (no blocker language)

**Conservative autofix (`agent_end`):**

When `actionableWarnings.autoFix.enabled` is set in global config (or `--lens-actionable-warning-autofix`), pi-lens applies LSP quickfixes from the report at `agent_end`. Safety gates:

- Re-fetches code actions from the live LSP server at fix time (stale actions are skipped)
- Skips any warning with zero or multiple eligible actions (ambiguity is not resolved)
- Applies only `edit`-kind actions (no command-only or create/delete operations)
- Hard cap of 5 fixes per `agent_end`
- Suppressed warnings are never autofixed

**Flags:**

- `--lens-actionable-warnings` — enable the turn_end report
- `--lens-actionable-warning-actions` — include LSP code-action warnings in the report
- `--lens-actionable-warning-autofix` — apply conservative fixes at agent_end
- `--lens-actionable-warning-all` — report all warnings, not just delta

### Bus Events — `pilens:files:touched` (#482)

pi-lens writes files **outside the agent's own tool calls**: dispatch autofix (biome/ruff/eslint/stylelint/sqlfluff/rubocop/ktlint/rust-clippy/dart-fix/golangci-lint/detekt/ktfmt/markdownlint/oxlint --fix) and formatter runs (immediate or deferred-at-`agent_end`) both mutate files after the fact, and the conservative actionable-warnings autofix above applies LSP quickfixes the same way. Other extensions in the same session that track file mutations are otherwise blind to those writes.

pi-lens broadcasts them on pi's shared in-process event bus (`pi.events`, exposed to every extension via the `ExtensionAPI`) as a single named event:

```
event:   pilens:files:touched
payload: {
  v: 1,
  source: "pi-lens",
  reason: "autofix" | "format",
  paths: string[],   // absolute, normalized (forward slashes, canonical casing)
  cwd: string,       // absolute, normalized
}
```

One event per logical write batch (not per file) — e.g. a single eslint `--fix` invocation that touches one file emits one event with `paths: [thatFile]`; a deferred-format pass across several queued files emits one event listing all of them.

**Versioning policy: additive-only.** New optional fields may be added under `v: 1`. A breaking change to an existing field's meaning bumps `v`. Consumers should ignore unknown fields.

**Non-goals:** pi-lens does not (yet) consume anyone's bus events, and does not emit for edits the agent makes itself through its own tool calls — the host already knows about those. This is a broadcast-only surface; see `#478` for the planned `pilens:rpc:*` request/response query API that will reuse the same versioning discipline.

**Kill switch:** `PI_LENS_BUS_PUBLISH=0` disables publishing entirely (see `docs/environment-variables.md`). Publishing is fire-and-forget — a disabled/unavailable/throwing bus never affects the write path's own success or latency.

### Opportunistic Read Expansion

When the agent reads a small slice of a file (≤ 60 lines), pi-lens transparently expands the read to the full enclosing symbol (function, method, or class) using the tree-sitter AST. The agent receives the full symbol as context, and the read guard records symbol-level coverage so edits anywhere within that symbol pass without requiring the agent to have read every line individually. Expansion runs within a 200 ms budget and falls back silently on unsupported file types or parse failures.

Supported: TypeScript, TSX, JavaScript, JSX, Python, Go, Rust, Ruby, Java, Kotlin, Dart, Elixir, C, C++, C#, PHP, Swift, Lua, OCaml, Zig, Bash.

### Fact Rules Pipeline

Covers JavaScript/TypeScript, Python, Go, Rust, Ruby, Shell, and CMake. A TypeScript AST-based fact-rule engine extracts function-level metrics and evaluates quality and security rules inline. Blocking rules surface immediately at write time; advisory rules are available via `lens_diagnostics mode=full`.

### AST Search and Replace

`ast_grep_search` and `ast_grep_replace` provide AST-aware pattern matching across 40+ languages via the `sg` CLI. Key capabilities:

- **Metavariable captures** — named captures (`$VAR`, `$$$ARGS`) appear below each match: `$VAR=x  $$$ARGS=a,b,c`.
- **Strictness modes** — `strictness: "relaxed"` ignores optional punctuation (trailing commas, semicolons) that causes zero matches in `smart` mode. Also supports `ast`, `cst`, `signature`, `template`.
- **Pagination** — `skip: N` offsets into large result sets; truncated results include a next-page hint.
- **Stale-preview detection** — `ast_grep_replace` re-validates the pattern before writing; returns a clear error if files changed since the preview instead of applying against wrong content.
- **`ast_dump`** — dumps the full tree-sitter AST for a source snippet. Use this when a pattern returns zero matches and the correct node kind or field name is unknown.

### Tree-sitter Rules

Structural rules organized by language in `rules/tree-sitter-queries/<language>/`. Rules marked **🔴** block the agent inline at write time (only for lines in the current edit); others are advisory.

**Suppressing a finding:** add `// pi-lens-ignore: rule-id` on the flagged line or the line above (JS/TS), or `# pi-lens-ignore: rule-id` for Python/Ruby/Shell. This suppresses that specific rule at that location only.

**Bring your own rules:** drop YAML query files into `rules/tree-sitter-queries/<language>/` in your project — pi-lens merges them with the built-ins on session start. The schema, predicates (`eq`, `match`, `any-of`), and `inline_tier` (`blocking` | `warning` | `review`) are documented in [`custom-rules.md`](custom-rules.md). A `rules/tree-sitter-queries/rule-schema.json` JSON Schema is bundled for editor autocomplete via `.vscode/settings.json`.

### Ast-Grep Rules

Pattern-based structural rules in `rules/ast-grep-rules/` across JS, TS, and Python — covers security (eval, hardcoded secrets, insecure randomness, dangerous DOM sinks), correctness (strict equality, constant conditions, duplicate keys), code smells (nested ternaries, long parameter lists, redundant state), and agent stubs (unimplemented bodies, raise NotImplementedError).

**Bring your own rules:** drop YAML rule files anywhere under `rules/ast-grep-rules/rules/` in your project — recursive discovery merges them with the built-ins, and the same `id` as a built-in overrides it consistently in raw ast-grep/LSP and NAPI. Duplicate IDs within one source layer are blocking configuration errors. The supported schema is documented in [`custom-rules.md`](custom-rules.md), with a `rules/ast-grep-rules/rule-schema.json` JSON Schema for editor autocomplete.

**Catalog port + playground cross-check:** 11 rules in `rules/ast-grep-rules/rules/` were ported from the official [ast-grep catalog](https://ast-grep.github.io/catalog) (security, correctness, framework-hygiene), and 184 vendored CWE-mapped rules live in `rules/ast-grep-rules/coderabbit/rules/`. To cross-validate a rule against the upstream playground, use `scripts/playground-verify-rule.mjs` (loads the rule into the [upstream playground](https://ast-grep.github.io/playground.html) via headless Chrome and reports the match count the upstream engine produces — a second opinion against the local `ast-grep` binary; see [`astplayground.md`](astplayground.md)).

### Opengrep Security Scanner (Auxiliary LSP, Experimental)

[Opengrep](https://github.com/opengrep/opengrep) (an open, login-free fork of Semgrep) runs as a pi-lens **auxiliary diagnostic LSP** — a cross-cutting, diagnostic-only language server that attaches *alongside* the file's normal language server (TypeScript, Python, …) and contributes findings on the same on-write diagnostics path. Running it as a warm LSP server compiles its ruleset **once per session** rather than on every file, so per-file scans cost ~1–2s (vs ~8s for a cold CLI invocation per file). High-signal security findings become blocking; the rest are advisory.

- **On by default** (it's a registered LSP server) when the `opengrep` binary is available; pi-lens **auto-installs it on demand** — a single GitHub-release binary, **no login, token, or telemetry**. Disable with `--no-opengrep`.
- **Rules:** a repo `.opengrep.yml`/`.opengrep.yaml` (or a legacy `.semgrep.yml`/`.semgrep.yaml`, whose format Opengrep consumes natively) is used if present; otherwise it falls back to Opengrep's login-free `auto` Community ruleset.

This is the first adopter of pi-lens's **auxiliary-LSP capability** (`role:"auxiliary"` servers + `clients/dispatch/auxiliary-lsp.ts`) — the same path future cross-cutting scanners (spelling, secrets, …) plug into by registration.

Local rules can opt into pi-lens blocking semantics with metadata:

```yaml
metadata:
  pi-lens:
    semantic: blocking
    defect_class: injection
    confidence: high
```

### Dependency &amp; secret session scans

Three external scanners run **once per session in the background** (not on every write — their inputs change at most daily and the scans are whole-tree). Each is **opt-in and auto-installed only when its gate trips**; results surface at turn end, with the highest-severity findings treated as blockers and the rest as advisory.

| Scanner | Finds | Opt-in gate | Auto-install |
|---|---|---|---|
| **gitleaks** | Committed secrets (API keys, tokens, certs) — regex + entropy, language-agnostic | `.gitleaks.toml` / `.gitleaksignore`, a `gitleaks` dep, or a pre-commit hook referencing it | GitHub release |
| **govulncheck** | Go module CVEs **reachable** from the build graph (call-graph filtered) | a `go.mod` at the analysis root | `go install` (needs the Go toolchain) |
| **trivy** | Dependency CVEs across every ecosystem (npm, PyPI, Maven/Gradle, Go, Cargo, Composer, RubyGems, NuGet, …), **hardcoded secrets**, and **dependency license risk** (copyleft/restricted licenses) — all from one `trivy fs` pass | **`trivy.enabled: true` in `.pi-lens.json`** *and* a dependency manifest at the root | GitHub release |

Secret findings from **gitleaks, trivy, and the ast-grep `*-hardcoded-secret-*` rules** are collapsed **by location** before surfacing: the same credential flagged by several scanners (with different rule ids) is reported **once** with combined provenance (`[gitleaks + trivy + ast-grep]`), not two or three times — the duplicate advisory copy is suppressed. This is the dedup contract that lets multiple secret scanners coexist without the triple-report noise.

Trivy requires an **explicit** opt-in (rather than just a manifest being present) because its first run pulls a 30–200 MB vulnerability database. Enable it per-project — or globally via a `~/.pi-lens.json` — and optionally widen severity:

```jsonc
// .pi-lens.json
{
  "trivy": {
    "enabled": true,
    "minSeverity": "MEDIUM" // default "HIGH"; HIGH/CRITICAL are always surfaced
  }
}
```

**IaC misconfiguration (per-edit, not a session scan).** When `trivy.enabled` is set, pi-lens also runs `trivy config` as an on-write dispatch runner (alongside hadolint/tflint) over **Dockerfiles** and **Kubernetes manifests** (YAML with an `apiVersion:` + `kind:` signature) — Trivy's security-policy engine (runs-as-root, no `HEALTHCHECK`, `privileged: true`, missing resource limits, …), a different class from hadolint's lint. On Dockerfiles, trivy-config findings that hadolint already reports at the same line are suppressed, so it only adds the security checks hadolint lacks. Terraform/Helm/Compose/CloudFormation are tracked as follow-ups.

### MCP Server (Experimental)

pi-lens ships an MCP (Model Context Protocol) server so Claude Code — or any MCP client — can drive the same diagnostic + read-substitute surface that the pi agent tools expose, without running pi. The server is a **second host adapter** alongside the pi extension; both call into the same `clients/lens-engine.ts` seam so a single implementation powers both surfaces.

**Why a second host:** the pi extension's tools are registered via the host SDK and run on pi's event loop. Claude Code lives in a different process with no SDK access. The MCP server sits in that gap, speaking JSON-RPC over stdio (or a warm Unix socket / Windows named pipe side-channel for the Claude Code PostToolUse hook). It's the easiest way to live-test, debug, and dogfood pi-lens — including running a **review loop** where Claude commits to pi-lens and re-measures.

**16 tools, grouped by lifecycle layer** (the same three layers the pi agent hooks use):

| Layer | MCP tools | What they expose |
|---|---|---|
| **Per-edit** | `pilens_analyze`, `pilens_lsp_diagnostics`, `pilens_lsp_navigation`, `pilens_ast_grep_search`, `pilens_ast_grep_replace`, `pilens_module_report`, `pilens_read_symbol` | The fast pipeline (format → autofix → LSP diagnostics → parallel runners) plus the structured read-substitute pair. `analyze` accepts `mode: warm \| fresh` — `warm` reuses the server's in-process LSP, `fresh` forks a worker that loads freshly-built code from disk so the result reflects the latest commit. |
| **Per-turn** | `pilens_turn_end` | Drives the **real** `handleTurnEnd` (knip incremental, jscpd delta, dep-circular, cascade, tests, actionable+code-quality warnings) — not a re-implementation. Caller-supplied edited files are auto-registered into turn-state via `addModifiedRange`. |
| **Per-session** | `pilens_session_start` | Drives the **real** `handleSessionStart` — full jscpd/knip/madge/govulncheck/gitleaks/trivy scans + complexity baselines + LSP warm + the **error-debt baseline** (tests/build pass-state) that powers green→red regression detection. |
| **Project / observability** | `pilens_project_scan`, `pilens_diagnostics`, `pilens_health`, `pilens_latency`, `pilens_symbol_search` | Cheap project-wide scans, cached diagnostic state, latency telemetry, ranked identifier search (BM25 over the persisted word index). Cross-file blast radius now lives in `pilens_module_report`'s `blastRadius` option. |
| **Lifecycle / loop** | `pilens_rebuild` | Runs `npm run build:dist` so `pilens_analyze mode=fresh` reflects the latest commit. Makes the review loop self-contained: commit → `pilens_rebuild` → `pilens_analyze mode=fresh` → `pilens_latency`. |

**Honest limits** (live-tested, documented in `mcp.md`):

- **`fresh` always cold-spawns the LSP**, so it systematically under-reports LSP diagnostics on large TS projects (`typescript-language-server` must index the whole project first). The result carries an explicit `lsp` honesty signal (`ran` / `status` / `diagnosticCount` / `durationMs`) so a cold `0` is never read as "clean" — use `warm` for LSP-complete reviews.
- **`pilens_analyze` by default surfaces everything** (`blockingOnly=false`); the per-edit fast path in the pi extension is still blocking-first.
- **The MCP server keeps the LSP warm across calls** within its process; `fresh` is for benchmarking a real cold spawn, not for steady-state usage.

**Transport is hand-rolled JSON-RPC** over stdio — zero new dependencies. The `npm install --omit=dev` constraint means even an "optional" SDK weighs down every pi-lens install; ~200 LOC of plain JSON-RPC beats a dep for a tools-only server. A warm Unix-socket / Windows-named-pipe side-channel (`clients/mcp/ipc.ts`) lets the `pi-lens-analyze` PostToolUse hook reuse the server's warm LSP without touching the stdio transport.

**Install / register in Claude Code:**

```bash
# Build the bundled dist (or `npm run build` for the in-place dev build)
npm run build:dist

# User-scope registration with auto session-start on connect
claude mcp add --scope user pi-lens \
  -e PI_LENS_MCP_AUTO_SESSION=1 \
  -- node <repo>/dist/mcp/server.js
```

The full design + tier-by-tier progress (and known limits) lives in [`docs/mcp.md`](docs/mcp.md). Status: **experimental** — the foundation is solid (transport, warm LSP, lifecycle handlers wired), but the surface is still maturing. Use the pi extension for production agent work; reach for the MCP server for debugging, dogfooding, and direct Claude Code access.
