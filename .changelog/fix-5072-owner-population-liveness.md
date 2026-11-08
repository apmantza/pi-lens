---
section: Fixed
audience: internal
---

- The tmp-fixture-hygiene owner-population case no longer asserts on directories it creates. It created `<prefix>population-` for every row of `tests/config/tmp-fixture-hygiene-baseline.json` and checked that the census saw each prefix, so the setup supplied the value the assertion read. A row whose producer had been deleted always passed. Liveness now comes from the owner's source, and a row with no live producer reds with "remove the admission". The census's owner index reads files through the same scan. (refs #5072)
