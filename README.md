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

### Session Start

At `session_start`, pi-lens:

- resets runtime state and diagnostic telemetry
- detects project root and active tools
- warms caches and optional indexes
- preps LSP/tool installers when needed

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
- `go-vet`, `golangci-lint`, `rust-clippy`, `rubocop`

Some runners are language/config-gated and may skip when not applicable.
`ast-grep-napi` runs in post-write dispatch for JS/TS with blocker-focused filtering; `/lens-booboo` additionally runs full CLI ast-grep scans.

## Dependencies

Auto-installed defaults:

| Tool | Purpose | Auto-installed |
|---|---|---|
| `typescript-language-server` | LSP type diagnostics | Yes |
| `pyright` | Python type diagnostics fallback | Yes |
| `prettier` | Formatting fallback | Yes |
| `ruff` | Python lint/format/autofix | Yes |
| `@biomejs/biome` | JS/TS lint/format/autofix | Yes |
| `madge` | Circular dependency analysis | Yes |
| `jscpd` | Duplicate code detection | Yes |
| `@ast-grep/cli` (`sg`) | AST search/replace and scans | Yes |
| `knip` | Dead code analysis | Yes |

LSP is enabled by default. pi-lens includes many language-server definitions (including up to 31+ servers), and activates them when the server is installed and the project/root detection matches the file.

Optional safety switch:

- `--no-lsp` disables unified LSP dispatch and falls back to language-specific checks where available (for example `ts-lsp`, `pyright`).
- `--lens-guard` (experimental) blocks `git commit`/`git push` attempts when unresolved pi-lens blockers are pending.

## Notes

- Some tools are auto-installed; others are config/availability-based.
- Rule packs are customizable via project-level rule directories.
