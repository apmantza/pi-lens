---
section: Fixed
audience: user
area: tools
---

- **`symbol_search` joins one word-index build per project root, however the root is spelled.** A root reached through a symlink answered "no build" while the build for its real directory ran, so it started a second whole-project walk and hid a failed build behind a "building" hint. (refs #4907)
