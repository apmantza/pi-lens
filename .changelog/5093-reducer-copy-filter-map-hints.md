---
section: Added
audience: user
---

- **Reducer copies and filter-then-map chains get hints.** `no-accumulating-spread-js` now flags a reduce callback that returns a copy of its accumulator through `Object.assign`, `Array.from`, `concat` or `slice`, not only through a spread. The new `filter-then-map` hint, for TypeScript and JavaScript, flags an adjacent `filter().map()` chain and never blocks. `ts-redundant-filter-map` now warns only on identity filters. (refs #5093, refs #5094)
