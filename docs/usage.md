# pi-lens Usage Guide

This page holds the detailed usage/reference material that does not need to live
in the repository front page.

## Lifecycle overview

pi-lens hooks into the pi agent lifecycle:

- **`session_start`** resets runtime state, hydrates project caches, preinstalls
  likely tools, warms LSPs, and starts background project scans.
- **`tool_call`** records read coverage and prepares read-guard/autopatch state
  before a write/edit lands.
- **`tool_result`** records file mutations, runs format/autofix/LSP/runners, and
  stores diagnostics on the runtime coordinator.
- **`turn_end`** merges blockers/advisories, refreshes project-diagnostic caches,
  runs selected project-level checks, and injects findings for the next turn.

## On-write pipeline

For each write/edit, pi-lens runs a language-aware pipeline:

1. Format queue / immediate formatting when configured.
2. Safe autofix from tools with deterministic fix support.
3. LSP file sync and diagnostic wait.
4. Parallel dispatch runners: LSP, ast-grep, tree-sitter, fact rules, and
   language-specific linters/security scanners.
5. Cascade diagnostics for likely affected neighbors.
6. Deduplication and routing to blockers, actionable warnings, or code-quality
   history.

## Agent tools

pi-lens exposes these high-value tools to agents:

- `lens_diagnostics` — cached diagnostic state; use `mode=all` before declaring
  work complete, and `mode=full` for an expensive project-wide LSP scan.
- `lsp_navigation` / `lsp_diagnostics` — IDE-style navigation and diagnostics.
- `ast_grep_search` / `ast_grep_replace` — AST-aware structural search/replace.
- `module_report` / `read_symbol` — navigable outline and targeted symbol-body
  reads; prefer these before broad full-file reads.

## Project config

Project-level `.pi-lens.json` can configure ignore patterns and selected rule
thresholds. Global config lives under `~/.pi-lens/config.json`.

Typical project config:

```jsonc
{
  "ignore": ["generated/**", "fixtures/**"],
  "rules": {
    "high-complexity": { "threshold": 20 },
    "high-fan-out": { "threshold": 25 }
  },
  "trivy": {
    "enabled": true,
    "minSeverity": "HIGH"
  }
}
```

## Runtime flags

```bash
# Standard mode (LSP enabled by default)
pi

# Optional switches
pi --no-lens             # Start pi-lens disabled for this session; /lens-toggle can re-enable
pi --no-lens-context     # Disable automatic context injection only (tools/LSP/read-guard/format stay on); /lens-context-toggle
pi --no-lsp              # Disable unified LSP diagnostics
pi --no-autoformat       # Skip auto-formatting entirely
pi --immediate-format    # Format immediately after each edit instead of deferring to agent_end
pi --no-autofix          # Skip auto-fix (Biome, Ruff, ESLint, stylelint, sqlfluff, RuboCop)
pi --no-tests            # Skip test runner
pi --no-delta            # Disable delta mode (show all diagnostics, not just new ones)
pi --lens-guard          # Block git commit/push when unresolved blockers exist (experimental)
pi --no-opengrep         # Disable the Opengrep security scanner (default-on auxiliary LSP)
```

## Rules

### Tree-sitter rules

Tree-sitter rules live under `rules/tree-sitter-queries/<language>/` and are
query-based. Use them when you need precise tree relationships or post-filters.
See [`docs/custom-rules.md`](../docs/custom-rules.md) and the
`pi-lens-write-tree-sitter-rule` skill.

### ast-grep rules

ast-grep rules live under `rules/ast-grep-rules/rules/`. Every shipped rule must
have a fixture in `rules/ast-grep-rules/rule-tests/`. Use the
`pi-lens-write-ast-grep-rule` skill for schema and runner gotchas.

The shipped baseline combines native pi-lens rules with vendored CodeRabbit
security rules under `rules/ast-grep-rules/coderabbit/rules/`.

## Security and dependency scans

Session-level scanners run in the background and surface at turn end:

- `gitleaks` — committed secrets.
- `govulncheck` — reachable Go vulnerabilities.
- `trivy` — dependency CVEs, hardcoded secrets, license risk, and IaC config
  scans when explicitly enabled.

Per-edit IaC config scanning currently covers Dockerfiles and Kubernetes-style
YAML when `trivy.enabled` is true.

## MCP mirror

pi-lens also ships an MCP server for Claude Code or other MCP clients. It is a
second host adapter that calls the same `clients/lens-engine.ts` seam as the pi
extension. Use `npm run build:dist` after MCP/engine changes so the user-scoped
server loads fresh compiled code.

## Troubleshooting

- Run `npm run build` before tests after editing TypeScript; tests import
  generated `.js` artifacts.
- Use `lens_diagnostics mode=all` to surface stale blockers from the current
  session.
- Check `~/.pi-lens/sessionstart.log`, `~/.pi-lens/latency.log`, and
  `~/.pi-lens/cascade.log` for lifecycle/performance/debug traces.
- For live tool validation, use `node scripts/smoke-tools.mjs` with the relevant
  `--lsp`, `--format`, or `--autofix` layer.
