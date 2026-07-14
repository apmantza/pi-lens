# Configuration

pi-lens reads optional user preferences from `~/.pi-lens/config.json` (`%USERPROFILE%\\.pi-lens\\config.json` on Windows). Unknown keys are ignored, and missing or invalid config falls back to defaults.

Hide the diagnostics widget by default, run formatting immediately after write/edit tool calls instead of at `agent_end`, and enable actionable warnings with conservative autofix:

```json
{
  "ignore": [
    "**/*.snapshot",
    "scratch/**"
  ],
  "widget": {
    "visible": false
  },
  "format": {
    "enabled": true,
    "mode": "immediate"
  },
  "edit": {
    "partialApply": false
  },
  "actionableWarnings": {
    "enabled": true,
    "includeLspCodeActions": true,
    "deltaOnly": true,
    "autoFix": {
      "enabled": false,
      "maxFixes": 5
    }
  },
  "contextInjection": {
    "enabled": false
  }
}
```

`format.mode` can be `"deferred"` (default) or `"immediate"`. Set `format.enabled` to `false` to match `--no-autoformat`. `/lens-widget-toggle` still works as a session-only override.

`edit.partialApply` defaults to `false`. When a multi-edit contains both matching and non-matching `oldText` blocks, pi-lens blocks the whole batch without writing anything so the native edit tool keeps its all-or-nothing semantics. Set it to `true` (or pass `--lens-partial-edit-apply`) only to opt in to the legacy behavior that applies matching blocks before reporting the unresolved ones.

`contextInjection.enabled` (default `true`) controls whether pi-lens prepends automatic findings — session-start guidance, turn-end findings, and test findings — into the next model turn. Set it to `false` (or use `--no-lens-context` / `PI_LENS_NO_CONTEXT_INJECTION=1` / `/lens-context-toggle`) to keep tools, LSP, read-guard, and formatting running while avoiding the prompt-cache invalidation that injected messages cause in long, cache-sensitive sessions. Findings are still cached, so `lens_diagnostics` and `/lens-health` keep working.

`actionableWarnings.enabled` gates the turn_end report. `includeLspCodeActions` fetches LSP code actions for each warning (requires an active language server). `deltaOnly` (default `true`) limits the report to lines touched in the current turn. `autoFix.enabled` applies conservative LSP quickfixes at `agent_end`; `autoFix.maxFixes` caps the number applied per turn (default `5`).

`ignore` is an array of gitignore-style glob patterns excluded from pi-lens scans across **every** project — the global counterpart to the per-project `.pi-lens.json` `ignore` below. Precedence is lowest: a project `.gitignore` or `.pi-lens.json` (including a `!negation`) overrides it, so you can globally hide e.g. `scratch/**` and still re-include it in one repo.

## Project Config

In addition to the user-level `~/.pi-lens/config.json` above, pi-lens reads a per-project `.pi-lens.json` (or `pi-lens.json`) at the project root. Walked upward from the cwd, so a monorepo can keep the config at the repo root and have every subdir pick it up. The schema is intentionally small — only fields pi-lens actually honors:

```json
{
  "ignore": [
    "**/__tests__/**",
    "**/*.test.ts",
    "fixtures/**",
    "vendor/**"
  ],
  "rules": {
    "high-complexity": { "threshold": 25 },
    "high-fan-out": { "threshold": 30 }
  }
}
```

### `ignore`

Array of gitignore-style glob patterns. Any path matching is excluded from every diagnostic scan (LSP walk, fact-rules, tree-sitter, jscpd, knip, review graph, source-filter). Useful for vendored code, generated files, or per-project noise you want to silence without editing `.gitignore` (which would also affect git itself). These patterns take precedence over the global `~/.pi-lens/config.json` `ignore`, so a `!negation` here can re-include a globally-ignored path.

### `rules`

Per-rule threshold overrides. Currently honored:

- `high-complexity.threshold` — cyclomatic complexity (default `15`)
- `high-fan-out.threshold` — distinct function calls (default `20`)

### Schema rules

- Unknown top-level keys and unknown rule ids are ignored, so a forward-compat file with extra fields (e.g. an LSP `servers` block from `lsp.json`) won't break the parse.
- A malformed JSON file is logged once and treated as "no config" — your diagnostics never get blocked by a syntax error in your own config.
- Rule thresholds must be positive finite numbers; invalid, zero, or negative values are logged once and ignored.
- The depth sub-threshold of `high-complexity` (default `6`) is intentionally not exposed; only the cyclomatic-complexity knob ships today to keep the schema tight.
- The file is mtime-cached, so editing it takes effect on the next scan without restarting the agent.
