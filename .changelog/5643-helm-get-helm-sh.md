---
section: Fixed
audience: user
area: install
---

- **Helm now installs on a machine that does not have it.** The helm release on GitHub holds only signature files, so the installer found no archive on any platform and never installed it. It now downloads the archive from get.helm.sh on Linux, macOS and Windows, for x64 and arm64. (refs #5643)
