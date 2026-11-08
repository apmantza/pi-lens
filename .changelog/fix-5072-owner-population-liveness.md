---
section: Fixed
audience: internal
---

- The tmp-fixture-hygiene owner-population case no longer asserts on directories it creates. It created `<prefix>population-` for every row of `tests/config/tmp-fixture-hygiene-baseline.json` and checked that the census saw each prefix, so the setup supplied the value the assertion read and a row whose producer had been deleted always passed; liveness now comes from the owner's source, and a row with no live producer reds with "remove the admission". (refs #5072)
