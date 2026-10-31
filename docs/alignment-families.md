# Alignment families

Seven user-facing ideas that pi-lens implements in more than one place. The same idea has drifted into different meanings before: PR #5011 found one ignore pattern read three ways. This file is the single list. The daily alignment routine reads it to pick a family, and `scripts/check-pr-body.mjs` reads it to validate the `Alignment:` line in `### Class sweep`.

## Families

The family name is the text before the first colon in the Family column. Names contain no comma. A PR body names them exactly as written here.

| # | Family | Start from |
|---|---|---|
| 1 | Path globs and their anchors: `ignore`, `rules.<id>.ignorePaths`, rule-file `ignores` / `ignore_paths`, scanner directory exclusions, any include/exclude list | `clients/file-utils.ts` (project ignore matcher), `clients/dispatch/rule-policy.ts`, `clients/dispatch/runners/yaml-rule-parser.ts`, `clients/tree-sitter-query-loader.ts` |
| 2 | Turn-off and deny keys: `lsp.disabledServers`, `dispatch.disabledRunners`, `tools.<name>.enabled`, `rules.<id>.disable` / `select`, env kill switches | `clients/config-core/deny.ts`, `clients/config-schema.ts`, `clients/tool-config.ts` |
| 3 | Config tiers and nested owners: which readers resolve from the file's config owner and which from the workspace root; merge strategy per key | `clients/analysis-root.ts` (`resolveSessionConfigRoot`), `clients/config-core/resolve.ts`, `clients/config-core/merge.ts` |
| 4 | Verdict and coverage wording: clean, unconfirmed, unavailable, not checked, disabled; the same state worded differently on different surfaces | `clients/dispatch/dispatcher.ts` (`buildCoverageNotice`), `clients/dispatch/runners/lsp.ts`, the `lens_diagnostics` / `lsp_diagnostics` tool output |
| 5 | Tool parameter shapes across pi tools and MCP tools: names, defaults and accepted spellings of path / paths / scope / severity / wait parameters | `tools/`, `clients/mcp/` |
| 6 | Closed vocabularies: skip reasons (`RUNNER_SKIP_REASONS`), owner keys, degradation codes, `PILENS_CFG_*` diagnostic codes; one idea with two names, or one name with two meanings | `clients/config-diagnostic-codes.ts`, `clients/degradation-ledger.ts`, `tests/support/session-state-registry.ts` |
| 7 | Env tunables: `PI_LENS_*` variables, how each is parsed (int, bool, list), clamped and defaulted, and what an unparseable value does | `git grep -n "process.env.PI_LENS_" clients tools index.ts` |

## What touches means

A change touches a family when it adds or edits a member of that family. Naming a family does not ask for a fix; it tells the reviewer and the alignment routine which meanings this change could move. Moving a member to the meaning its siblings already use still counts as touching it. A change that touches no member writes `none: <reason>`, with a reason of at least 12 characters.

1. **Path globs and their anchors.** Touched when the change adds or edits one of these: `ignore`, `rules.<id>.ignorePaths`, rule-file `ignores` / `ignore_paths`, scanner directory exclusions, any include/exclude list.
2. **Turn-off and deny keys.** Touched when the change adds or edits one of these: `lsp.disabledServers`, `dispatch.disabledRunners`, `tools.<name>.enabled`, `rules.<id>.disable` / `select`, env kill switches.
3. **Config tiers and nested owners.** Touched when the change adds or edits one of these: which readers resolve from the file's config owner and which from the workspace root; merge strategy per key.
4. **Verdict and coverage wording.** Touched when the change adds or edits one of these: clean, unconfirmed, unavailable, not checked, disabled; the same state worded differently on different surfaces.
5. **Tool parameter shapes across pi tools and MCP tools.** Touched when the change adds or edits one of these: names, defaults and accepted spellings of path / paths / scope / severity / wait parameters.
6. **Closed vocabularies.** Touched when the change adds or edits one of these: skip reasons (`RUNNER_SKIP_REASONS`), owner keys, degradation codes, `PILENS_CFG_*` diagnostic codes; one idea with two names, or one name with two meanings.
7. **Env tunables.** Touched when the change adds or edits one of these: `PI_LENS_*` variables, how each is parsed (int, bool, list), clamped and defaulted, and what an unparseable value does.
