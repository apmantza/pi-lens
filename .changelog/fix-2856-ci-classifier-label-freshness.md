---
section: Fixed
---

- **Keep CI verdict labels fresh across pushes (refs #2856)** — Clear verdict labels when a pull-request head changes, explicitly scope checkout-free `gh` calls to the repository, and ignore incidental exit-137 log text as test-failure evidence.
