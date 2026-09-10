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

For each write/edit, pi-lens runs a language-aware pipeline. Format and safe
autofix (steps 1–2) run on different schedules depending on the tool:

- **`write`** (new file, full overwrite, bash-authored write): autofix runs
  immediately, in the same tool result, carrying the fixed file's full content
  back to the agent when it fits under the per-file cap.
- **`edit`**: autofix defers to `agent_end`, joining the same per-file queue as
  deferred formatting; autofix drains before format so the final state is
  formatter-stable. A `write` followed by an `edit` on the same file in the
  same turn demotes the write's autofix to deferred too.

1. Format queue / immediate formatting when configured (deferred to
   `agent_end` for an `edit` even under `--immediate-format`, so it lands
   after autofix reformats the file).
2. Safe autofix from tools with deterministic fix support — immediate for
   `write`, deferred to `agent_end` for `edit` (see above).
3. LSP file sync and diagnostic wait.
4. Parallel dispatch runners: LSP, ast-grep, tree-sitter, fact rules, and
   language-specific linters/security scanners. For a deferred `edit`, these
   run against the not-yet-autofixed disk state, so a lint finding autofix
   would have cleared may appear here and resolve itself at `agent_end`.
5. Cascade diagnostics for likely affected neighbors.
6. Deduplication and routing to blockers, actionable warnings, or code-quality
   history.

See [`docs/agent-guide.md`](agent-guide.md#6-auto-format--auto-fix-timing--dont-be-surprised)
for the consumer-facing version of this routing.

## Agent tools

pi-lens exposes these high-value tools to agents:

- `lens_diagnostics` — `source=session` (default) reports cached findings; an
  empty cache is not proof of a clean file. If changed files have no cached
  diagnostics or stale findings, use `source=lsp scope=paths` for targeted
  active verification (or `scope=workspace` to sweep a whole directory/project).
- `lsp_navigation` — IDE-style code navigation (definition/references/etc.).
- `ast_grep_search` / `ast_grep_replace` — AST-aware structural search/replace.
- `module_report` / `read_symbol` — navigable outline and targeted symbol-body
  reads; prefer these before broad full-file reads.

## Project config

Project-level `.pi-lens.json` can configure mutation policy, ignore patterns,
and selected rule thresholds. Global config lives under
`~/.pi-lens/config.json`.

Typical project config:

```jsonc
{
  "format": { "enabled": false },
  "autofix": { "enabled": false },
  "actionableWarnings": {
    "autoFix": { "enabled": false }
  },
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

The three mutation controls disable auto-formatting, deterministic pipeline
autofix, and actionable-warning quickfixes respectively. Diagnostics continue
to run. See [Global and Project Config](globalconfig.md#project-config) for
precedence and the complete project schema.

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
pi --lens-checkout-guard # Decline git commands that rewrite the working tree while another live pi-lens session shares this dirty checkout (experimental)
pi --no-opengrep         # Disable the Opengrep security scanner (default-on auxiliary LSP)
pi --no-read-guard       # Disable the read-before-edit behavior monitor
pi --lens-turn-summary   # Persist a per-turn summary of diagnostics, autofixes, and autoformats
pi --lens-compact-tool-line   # Render tool results as one compact, theme-aware line (closes #1327)
pi --no-lazy-tools       # Keep every pi-lens tool active instead of activating the situational ones on demand
pi --lens-turn-end-madge # Run the madge circular-dependency check at every turn end, not just at session start

# Actionable warnings (all default off)
pi --lens-actionable-warnings          # Report fixable warnings at turn end
pi --lens-actionable-warning-actions   # Enrich the report with LSP code-action titles
pi --lens-actionable-warning-autofix   # Apply conservative LSP quickfixes at agent_end
pi --lens-actionable-warning-all       # Report every warning, not just this turn's
```

Every one of these has a `~/.pi-lens/config.json` equivalent, so you can set it
once instead of per session. See
[Global and Project Config](globalconfig.md#every-toggle-both-ways) for the
flag-to-key table and the precedence order.

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

Two Claude Code hooks give the MCP mirror the same automatic cadence the pi
extension has. PostToolUse runs the per-edit pass, `Stop` runs the per-turn one:

```json
{ "hooks": {
  "PostToolUse": [
    { "matcher": "Edit|Write",
      "hooks": [ { "type": "command", "command": "pi-lens-analyze --hook" } ] } ],
  "Stop": [
    { "hooks": [ { "type": "command", "command": "pi-lens-analyze --turn-end", "timeout": 60 } ] } ]
} }
```

The `Stop` hook only works against a running MCP server because only that
process owns the session state and pending turn work. With no warm server the
turn-end is skipped, not faked: one line on stderr and nothing on stdout.

## Troubleshooting

- Run `npm run build` before tests after editing TypeScript; tests import
  generated `.js` artifacts.
- Use `lens_diagnostics mode=all` to surface stale blockers from the current
  session.
- Check `~/.pi-lens/sessionstart.log`, `~/.pi-lens/latency.log`, and
  `~/.pi-lens/cascade.log` for lifecycle/performance/debug traces.
- For live tool validation, use `node scripts/smoke-tools.mjs` with the relevant
  `--lsp`, `--format`, or `--autofix` layer.
