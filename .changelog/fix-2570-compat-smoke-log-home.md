---
section: Fixed
---

- **Compat-smoke Layer B reads the latency log it actually wrote (fixes #2570)** — the behavioral smoke pins `PI_LENS_HOME` for every child `pi` and reads `latency.log` from that pin; since the tmpdir probe-home redirect (#2534) it had been reading the untouched real `~/.pi-lens`, so the light-mode assertions reported a missing phase and the heavyweight-scan absence checks passed on an empty log. Those checks now require at least one entry from the run.
