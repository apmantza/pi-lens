---
section: Fixed
audience: internal
---

- Settle the installer's probe-cache writer before the fallow archive test removes its home: the teardown now joins `updateProbeCache` calls that have not marked their change yet, then drains the probe-cache flush, so `probe-cache.json` and its lock no longer re-create the removed root and red the tmp-fixture hygiene owner. (closes #5657)
