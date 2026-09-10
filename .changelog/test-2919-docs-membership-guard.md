---
section: Fixed
---

- **Docs membership guard asserts list members, not counts (closes #2919).** `tests/docs/features-counts.test.ts` now compares the `docs/features.md` formatter list member-by-member against `ALL_FORMATTERS`, the LSP language list against non-auxiliary `LSP_SERVERS` ids, and the `docs/mcp.md` tool table against `TOOL_REGISTRY`, and reports missing and extra names, so reinstating a removed member or swapping in a stale name fails the suite.
