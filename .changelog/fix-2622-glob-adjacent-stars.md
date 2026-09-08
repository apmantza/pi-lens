---
section: Fixed
---
- **Read-guard exemption globs and the file-utils directory glob no longer backtrack on adjacent wildcards (closes #2622)** — runs of adjacent `*` are collapsed to one before compiling, which is semantically identical for the `*`-only dialect and removes the polynomial backtracking (a 12-star pattern against a 40-component path went from tens of seconds to ~2 ms); a differential corpus pins both matchers' answers unchanged.
