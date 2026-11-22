---
section: Changed
audience: internal
---

- The PR-gating `host range · newest-in-range` lane now installs the newest stable pi (the npm dist-tag `latest`) with no hand-kept ceiling, so a new pi release is exercised by a gating lane at once; a registry failure resolving `latest` fails the lane closed. The `PI_HOST_SUPPORTED_RANGE` ceiling is gone and the floor stays 0.86.1. (refs #5749)
