Operating rule: `lens_diagnostics` is the only diagnostics surface; `source` selects the evidence producer and `scope` selects its coverage.

Kept: The existing session cache, LSP probe, analyzer readers, result footer, and per-file confirmation rules remain unchanged behind the new modifiers.

## Summary

Fold `lsp_diagnostics` into `lens_diagnostics` with explicit `source` and `scope` modifiers. Keep the old pi and MCP names as one-release compatibility shims, and record one bounded `lsp-diagnostics-compatibility` degradation per session. The retired name is absent from the registry, roster, skills, and documentation.

## State-space table

The table is the design contract used before implementation. `session` means the existing cache-backed lens path, `lsp` means the existing per-file or workspace probe, and `analyzers` means the existing analyzer cache/fresh-runner path.

| source × scope | warm session cache | cold | stale-after-edit | no LSP server for file | analyzers only | code path | render | old `lsp_diagnostics` mapping | existing coverage |
|---|---|---|---|---|---|---|---|---|---|
| session × delta | actionable/session delta reader | clean with cold marker | stale findings remain identified | cache answer; no invented LSP result | analyzer state not queried | old `mode=delta` | `lens_diagnostics delta` | n/a | `tests/tools/lens-diagnostics.test.ts` |
| session × paths | filtered session/widget cache | empty filtered cache with caveat | stale paths remain marked | cache answer; no server probe | analyzer state not queried | old `mode=all` + `paths` | `lens_diagnostics paths` | n/a | `tests/tools/lens-diagnostics.test.ts` |
| session × workspace | session/widget cache | empty cache with cold marker | stale workspace state remains marked | cache answer; no server probe | analyzer state not queried | old `mode=all` | `lens_diagnostics workspace` | n/a | `tests/tools/lens-diagnostics.test.ts` |
| lsp × delta | fresh per-file probe when paths are supplied | probe returns confirmed/unconfirmed state | probe re-reads current file | explicit unavailable/unconfirmed result | analyzers not queried | old `paths`/`path` with primary/all scope | `lens_diagnostics lsp delta` | `path` or `paths` → `source=lsp,scope=delta`; `serverScope` is retained | `tests/tools/lsp-diagnostics.test.ts` |
| lsp × paths | fresh bounded file batch | same probe, no cache fallback | current disk binding governs result | per-file unavailable state | analyzers not queried | old `paths` | `lens_diagnostics lsp paths` | `paths` → `source=lsp,scope=paths` | `tests/tools/lsp-diagnostics.test.ts` |
| lsp × workspace | directory/workspace sweep | bounded incomplete result | current workspace sweep | files without a server are unconfirmed | analyzers not queried | old directory/default workspace path | `lens_diagnostics lsp workspace` | `path` directory or omitted path → `source=lsp,scope=workspace` | `tests/tools/lsp-diagnostics.test.ts` |
| analyzers × delta | cached analyzer delta | cold analyzers are named | stale analyzer records stay stale | independent of LSP availability | analyzer-only reader | analyzer cache delta | `lens_diagnostics analyzers delta` | n/a | `tests/tools/lens-diagnostics.test.ts` |
| analyzers × paths | filtered analyzer cache | empty filtered cache | stale paths remain marked | independent of LSP availability | path-filtered analyzer reader | analyzer cache + paths | `lens_diagnostics analyzers paths` | n/a | `tests/tools/lens-diagnostics.test.ts` |
| analyzers × workspace | analyzer snapshot/fresh run | cold analyzers are named | stale snapshot remains marked | independent of LSP availability | analyzer workspace reader | old `mode=full` analyzer branch | `lens_diagnostics analyzers workspace` | n/a | `tests/tools/lens-diagnostics.test.ts` |

The old lens `mode` maps to `session/delta` (`delta`), `session/workspace` (`all`), and the combined active scan (`full`, represented by `analyzers/workspace` with its existing LSP reconciliation). The old LSP arguments map as shown in the table; `severity`, `waitMs`, `concurrency`, `serverScope`, `path`, and `paths` remain probe arguments.

## Tests

Red-first and mutation transcripts:

```text
MUTATION shim mapping: `name = "pilens_lsp_diagnostics"` → `tests/mcp/server.smoke.test.ts` failed: expected "Checks not confirmed"; received the retired-name error footer.
MUTATION once-record: deleting `recordDegradationOnce` → health smoke failed: expected `lsp-diagnostics-compatibility`; received only the AST compatibility and cwd records.
MUTATION source modifier: removing `"lsp"` from the source enum → lens schema test failed: expected ["session", "lsp", "analyzers"].
MUTATION scope modifier: removing `"paths"` from the scope enum → lens schema test failed: expected ["delta", "paths", "workspace"].
```

Passing red-first follow-up: the real `lens_diagnostics` probe test returned the injected LSP finding with `details.source=lsp` and `details.scope=paths`; the MCP compatibility call returned the folded probe result, and the health response contained one compatibility group.

Targeted result: 140 tests passed across the fold, MCP smoke, roster budget, governance, skill drift, and result-contract suites. The broader tools/MCP population passed 48 files and 646 tests after the contract pin update; one unrelated `tests/mcp/analyze-cli.test.ts` case remains red because its existing fixture reports `1 warning(s)` instead of the asserted `0`.

Preflight result:

```text
| gate | pass/fail | first red line |
| build | pass | |
| lint | pass | |
| fmt:check | pass | |
| changelog:check | pass | |
| check-changelog-fragments | pass | |
| check:lockfile | pass | |
| lockfile:complete | pass | |
| tests/config | pass | |
| generation-guard | pass | |
| flake-shape-ratchet | pass | |
| lsp-spawn-heavy-coverage | pass | |
| ci-verdict | pass | |
| knip | pass | |
| check-pr-title | FAIL | local preflight has no PR title context; requested title contains `#2800` |
| check-close-keywords | pass | |
| check-pr-body | pass | |
```

Required suites: `tests/tools/`, `tests/mcp/`, `tests/clients/mcp/`, `tests/clients/public-surface-drift.test.ts`, `tests/config/`, `tests/index-integration.test.ts`, the result-contract and roster governance tests, and the real-harness compatibility cases.

## Blast radius

```text
lsp_diagnostics consumers
- index.ts registerTool(createLspDiagnosticsTool)
- mcp/server.ts ALL_TOOLS + callTool + pilens_lsp_diagnostics
- clients/tool-config.ts TOOL_REGISTRY entry
- clients/runtime-session.ts orientation/activation guidance
- docs/agent-tools.md, docs/configuration.md, docs/settings.md, docs/globalconfig.md
- skills/pi-lens-lsp-navigation/SKILL.md
- tests/tools/lsp-diagnostics*.test.ts and lsp cache/compatibility fixtures
+ index.ts registerTool(lens_diagnostics source=lsp)
+ mcp/server.ts pilens_lsp_diagnostics compatibility mapping
+ clients/tool-config.ts one canonical lens_diagnostics entry
```

The production seam is `createLensDiagnosticsTool`; the existing LSP probe engine remains the callee for `source=lsp`. No analyzer or cache consumer changes its storage contract.

## Class sweep

The sweep follows #2850: registry and enabled-tool gates contain only canonical names; the retired names are intercepted before those gates; pi and MCP use the same modifier mapping; docs, skills, tests, and guidance contain no active roster entry for the retired name. The final sweep records every remaining historical/internal `lsp_diagnostics` reference and why it is not a user-facing tool name.

## Observability

Compatibility calls emit the bounded once-record literal `lsp-diagnostics-compatibility` with subject `lsp_diagnostics` and the mapped `lens_diagnostics` modifiers. Repeated calls increment neither the retained entry nor the user-facing degradation row within a session.

## Test assessment

New and edited tests exercise the real pi registration path, the real MCP child, the compatibility mapping, the once-record, both roster surfaces, and each new modifier. Existing LSP and lens unit cases remain real-engine cases; process boundaries are mocked only where the repository already treats the external server as a boundary.
