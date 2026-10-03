---
section: Changed
audience: internal
---

- **The required `install-test` verdict steps are pinned against tolerated failure (refs #3925)** — `tests/config/sharded-aggregate-failure-policy.test.ts` now asserts by name that all eight verdict-producing steps of the aggregate-less `install-test` job keep `continue-on-error` false: `Install from tarball`, `Verify required files in tarball`, `Verify package.json entry points exist in tarball`, `Verify bundled core grammars shipped in the tarball`, `Load each extension entry point`, `Verify no host-provided package shipped in the tarball (#1926)`, `Verify extension entry loads (catches missing node_modules deps)`, and `Startup not weakened — entry loads from precompiled dist (#182)`. A tolerated verdict step can no longer green that matrix leg's required check while the two declared best-effort steps stay allowed.
