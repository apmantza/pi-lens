---
section: Changed
audience: internal
---

- **The dispatcher records a runner's tier observation in one place (refs #4907)** — the collect-later run and the inline run in `clients/dispatch/dispatcher.ts` shared a spelled-twice block (latency observation, `runner_collect_later_tier_flip` row, `runner-collect-later` count); one local `observeRunnerTier` now does it. Rows, counts and tiers are unchanged for every probed project root.
