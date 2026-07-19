# Slash Commands

pi-lens registers the following slash commands with the pi host:

- `/lens-toggle` — toggle pi-lens on/off for the current session without restarting
- `/lens-context-toggle` — toggle automatic context injection on/off for the session (tools/LSP/read-guard/formatting stay active)
- `/lens-widget-toggle` — show/hide the pi-lens diagnostics widget below the editor
- `/lens-health` — runtime health, latency, and diagnostic telemetry
- `/lens-allow-edit <path>` — override the read-before-edit guard for a single edit
- `/lens-tools` — tool installation status: globally installed, auto-installed, or npx fallback
- `/lens-tdi` — Technical Debt Index (TDI) and project health trend
- `/lens-map` — generate an interactive HTML dependency map of the project
  (file-level nodes from the review graph; self-contained page written under
  the project data dir, path shown on completion)

For runtime startup flags (`--no-lens`, `--no-lsp`, etc.) see [`usage.md`](usage.md).
