---
section: Fixed
---

- **The observed-mutation dispatch-cap test no longer depends on machine speed (closes #3493)** — on a loaded CI runner the 50 ms settle deadline could cut the last of the test's 33 files, so exactly 32 changes were seen and the cap record the test checks was never written. The test now widens the observation's time bounds through a test-only seam; the production bounds are unchanged.
