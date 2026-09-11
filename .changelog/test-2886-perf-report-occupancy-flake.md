---
section: Fixed
---

- **Stop the /lens-perf occupancy guard flaking under CI contention (closes #2886)** — The wall-clock occupancy assertion moves into the serialized `wall-clock-budget` lane with the flake-shape ratchet's admission, and a deterministic yield-count assertion is added beside it: the count pins the parser's cadence, the lane keeps the real measurement honest.
