---
section: Changed
audience: internal
---

- The required `TLA+ models` check is now an aggregate over four `scripts/check-tla-models.mjs --shard i/N` jobs, because the single job outgrew its 12-minute cap at 514 configs; the check name is unchanged and it fails if any shard fails or is cancelled (closes #3918).
