---
section: Fixed
audience: internal
---

- CI downloads of the pinned release binaries and the TLA+ jar go through one fetch-verified helper: restored from actions/cache by tool, version and sha256, fetched with `--fail` and retries on a miss, and verified before use. A GitHub 504 now names an HTTP error, not a checksum mismatch, a rejected cache file is deleted before the download, and a governance test refuses any other CI network fetch without a named admission (refs #5409).
