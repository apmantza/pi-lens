---
section: Added
---
- **`complexity (advisory)` CI job dogfoods pi-lens's own complexity client over `clients/`, `tools/` and `mcp/` (refs #2697)** — `npm run complexity` writes a Markdown report (top functions by cyclomatic/cognitive complexity, files over 1,000 lines, split candidates at the dispatch threshold of 15) to the step summary and an artifact; `ComplexityClient` exposes the per-function metrics it already computes, uses the dispatch cyclomatic metric for JS/TS, and fails when analysis produces no files or throws.
