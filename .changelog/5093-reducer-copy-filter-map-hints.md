---
section: Changed
audience: user
---

- **Reducer copy and filter-map warnings change.** `no-accumulating-spread-js` now flags a reduce callback that copies its accumulator through `Object.assign`, `Array.from`, `concat` or `slice`, not only through a spread, and its message names the object case. `ts-redundant-filter-map` now warns only on identity filters (`filter(x => x)`, `filter((x: T) => x)`, `filter(Boolean)`), so a TypeScript `filter().map()` chain that warned before no longer warns. The new `filter-then-map` hint ships disabled. (refs #5093, refs #5094)
