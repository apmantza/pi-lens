# pi-lens

pi-lens focuses on real-time inline code feedback for AI agents.

## What It Does

### On Write/Edit

On every `write` and `edit`, pi-lens runs a fast, language-aware pipeline (checks depend on file language, project config, and installed tools):

- **Formatting + autofix**: language/tool-specific formatters and safe autofixers (Biome, Ruff, ESLint, and other toolchain-native formatters when available)
- **Type checking**: unified LSP (enabled by default) with language fallbacks (for example `ts-lsp`, `pyright`)
- **Lint + static analysis**: active runners for the current language and config
- **Test running**: related-file tests, with failed-first reruns for faster feedback
- **Security checks**: secret scanning and structural security rules
- **Structural analysis**: tree-sitter + ast-grep for bug patterns across supported languages
- **Delta reporting**: prioritize new issues over legacy baseline noise
- **Coverage transparency**: when primary analysis tools are unavailable for a file kind, pi-lens emits a non-blocking inline "analysis unavailable" warning (deduped per file per session)

### Session Start

At `session_start`, pi-lens:

- resets runtime state and diagnostic telemetry
- detects project root, language profile, and active tools
- applies language-aware startup defaults for tool preinstall
- warms caches and optional indexes (with overlap/session guardrails)
- emits missing-tool install hints for detected languages when relevant
- injects session guidance through internal context (non-user channel) to reduce acknowledgement-only first responses

### Turn End

At `turn_end`, pi-lens:

- summarizes deferred findings (for example duplicates/circulars)
- persists turn findings for next context injection
- updates debt/diagnostic tracking and cleans transient state

Inline output is intentionally concise and actionable.

- **Blocking issues**: shown inline and stop progress until fixed
- **Warnings**: summarized, with deeper detail in `/lens-booboo`
- **Health/telemetry**: available in `/lens-health`

## Install

```bash
pi install npm:pi-lens
```

Or from git:

```bash
pi install git:github.com/apmantza/pi-lens
```

## Run

```bash
# Standard mode
pi

# Optional safety: disable unified LSP and use fallbacks
pi --no-lsp
```

## Key Commands

- `/lens-booboo` — full quality report for current project state
- `/lens-health` — runtime health, latency, and diagnostic telemetry

## Runners

Registered dispatch runners:

- `lsp`, `ts-lsp`, `pyright`
- `biome-check-json`, `biome-lint`, `ruff-lint`, `eslint`, `oxlint`
- `tree-sitter`, `ast-grep-napi`, `type-safety`, `similarity`
- `architect`, `python-slop`, `shellcheck`, `spellcheck`
- `yamllint`, `sqlfluff`
- `go-vet`, `golangci-lint`, `rust-clippy`, `rubocop`

Some runners are language/config-gated and may skip when not applicable.
`ast-grep-napi` runs in post-write dispatch for JS/TS with blocker-focused filtering; `/lens-booboo` additionally runs full CLI ast-grep scans.

## Dependencies

Auto-install behavior depends on gate type:

- **Config-gated**: installs only when project config/deps indicate usage.
- **Flow/language-gated**: installs when the runtime path needs it for the current file/session flow.
- **Operational prewarm**: installs during session warm scans / turn-end analysis paths.

| Tool | Purpose | Auto-installed | Gate |
|---|---|---|---|
| `@biomejs/biome` | JS/TS lint/format/autofix | Yes | Config-gated (`biome.json`/`biome.jsonc` or `@biomejs/biome` dep) |
| `prettier` | Formatting fallback | Yes | Config-gated (Prettier dep or `package.json#prettier`) |
| `yamllint` | YAML linting | Yes | Config-gated (`.yamllint*` / tool section / dep hint) |
| `sqlfluff` | SQL linting/formatting | Yes | Config-gated (`.sqlfluff` / tool section / dep hint) |
| `ruff` | Python lint/format/autofix | Yes | Language-default + flow-gated (Python detected; respects `--no-autofix-ruff`) |
| `typescript-language-server` | Unified LSP diagnostics | Yes | Language-default + flow-gated (JS/TS detected and LSP enabled) |
| `pyright` | Python type diagnostics fallback | Yes | Flow/language-gated (Python fallback paths) |
| `@ast-grep/cli` (`sg`) | AST scans/search/replace | Yes | Operational prewarm + analysis flows |
| `knip` | Dead code analysis | Yes | Operational prewarm + turn-end flows (JS/TS language + config gated at startup) |
| `jscpd` | Duplicate code detection | Yes | Operational prewarm + turn-end flows (JS/TS language + config gated at startup) |
| `madge` | Circular dependency analysis | Yes | Turn-end analysis flow |

LSP is enabled by default. pi-lens includes many language-server definitions (including up to 31+ servers), and activates them when the server is installed and the project/root detection matches the file.

Optional safety switch:

- `--no-lsp` disables unified LSP dispatch and falls back to language-specific checks where available (for example `ts-lsp`, `pyright`).
- `--lens-guard` (experimental) blocks `git commit`/`git push` attempts when unresolved pi-lens blockers are pending.

## Notes

- Not every auto-install runs in every project: gate type decides when install is attempted.
- Rule packs are customizable via project-level rule directories.
