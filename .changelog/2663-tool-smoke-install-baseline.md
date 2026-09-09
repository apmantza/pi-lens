---
section: Added
---

- **Add the tool-smoke install lane to the release-QA baseline (refs #2663, #2784)** — a `tool-smoke-install` row installs every npm/pip installer-registry entry through the real smoke harness, so a dead registry entry is a red do-not-ship row, a registry-unreachable lane is INCONCLUSIVE, and neither reads as green.
