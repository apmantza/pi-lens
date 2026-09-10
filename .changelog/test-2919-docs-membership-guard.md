---
section: Fixed
---

- **Docs membership guard asserts list members, not counts (closes #2919).** `tests/docs/features-counts.test.ts` now compares the `docs/features.md` formatter list member-by-member against `ALL_FORMATTERS` and reports missing and extra names, so reinstating a removed formatter or swapping in a stale name fails the suite. The LSP server list and the `docs/mcp.md` tool table gain the same membership shape against `LSP_SERVERS` and `TOOL_REGISTRY`, marked skipped until #2917 corrects those docs pages.
