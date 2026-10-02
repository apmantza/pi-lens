---
section: Changed
audience: internal
---

- Cut CI runner demand: the heavy advisory jobs (`mutation (advisory)`, `Unit tests Windows (advisory)`) start only after every required check passed on the same head, through a `Heavy advisory gate (advisory)` job in `ci.yml` (the mutation lane moved from `mutation.yml` into `ci.yml` so `needs:` can hold it); a docs-only pull request (root `*.md`, `docs/**`, `.changelog/**` only) skips just those heavy advisory jobs while every test job still runs; `TLA+ models` model-checks only when `formal/` changed; the Unit tests run as four shards (was five) packed by recorded per-file duration instead of vitest's equal-count path hash, with a partition that does not depend on the shard host; and Install test no longer waits for lint or the shards. Required check names are unchanged and every required job still concludes success; ci-verdict lists the deferred jobs with their real state (PENDING, or NOT RUN with the gate's reason) and never gates on them (refs #3801, #3771).
