---
section: Fixed
---

- **Keep bridge bookkeeping alive across session transitions (closes #2992)** — stale extension contexts no longer make read or mutation bridge flag checks throw or drop their records.
