---
section: Changed
audience: internal
---

- Run the required `Unit tests` CI job as five parallel `vitest --shard=k/5` jobs behind one aggregate check still named `Unit tests`, so branch protection is unchanged while the long pole shrinks. A red or cancelled shard fails the aggregate (never green-by-skip), every shard re-runs the serialized tmp-fixture-hygiene owner so no shard's tmp leaks go unjudged, ci-verdict and the infra-kill classifier read the failing shard's log, and the nightly test-history rollup downloads one artifact per shard (refs #3753).
