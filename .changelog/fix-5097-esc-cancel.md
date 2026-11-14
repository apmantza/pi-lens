---
section: Fixed
audience: user
area: tools
---

- **Esc now stops an `ast_grep_replace` apply's precheck.** The structural-rule precheck carries the call's abort signal, so a host with no tool scope stops it too. Once the `--update-all` write starts it still runs to completion, so an apply leaves 0 or all matched files rewritten. (refs #5097)
