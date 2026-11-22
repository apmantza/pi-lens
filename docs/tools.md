# Slash Commands

pi-lens registers the following slash commands with the pi host:

- `/lens-toggle` — toggle pi-lens on/off for the current session without restarting
- `/lens-context-toggle` — toggle automatic context injection on/off for the session (tools/LSP/read-guard/formatting stay active)
- `/lens-widget-toggle` — show/hide the pi-lens diagnostics widget
- `/lens-health` — runtime health, latency, and diagnostic telemetry, including
  bounded per-session degradation counts (trust refusals, LSP breakers,
  formatter skips/failures, idle evictions, WASM aborts, timeout tallies, and
  more)
- `/lens-perf` — independent top-five p50 and p99 rankings for the current process session and machine-wide active latency-log window
- `/lens-allow-edit <path>` — override the read-before-edit guard for a single edit
- `/lens-tools` — tool installation status: globally installed, auto-installed, or npx fallback
- `/lens-tdi` — Technical Debt Index (TDI) and project health trend
- `/lens-map` — generate an interactive HTML dependency map of the project
  (file-level nodes from the review graph; self-contained page written under
  the project data dir, path shown on completion)

For runtime startup flags (`--no-lens`, `--no-lsp`, etc.) see [`usage.md`](usage.md).

## Standalone CLI

Build and persist the review graph out of band for CI or cron:

```bash
npx pi-lens build-graph [--cwd <dir>]
```

The command uses the same graph builder, project configuration, file cap, and
persist cap as an interactive session. It prints file/node/edge/element count,
snapshot JSON bytes, and duration on success; an unsafe root, build skip/error,
or failed/skipped persistence exits non-zero with the reason on stderr.
