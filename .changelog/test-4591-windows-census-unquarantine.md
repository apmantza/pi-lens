---
section: Changed
audience: internal
---

- **The tmp-fixture census asserts on the Windows lane again, and a red names its producer**: the `win32` quarantine around the four census assertions is removed, each sweep now persists what it found at every registered root, and the census failure message states per leaked entry whether the registry held it at sweep time, how its birth, modification and change times sit against the last sweep, and its first-level children (#4591).
