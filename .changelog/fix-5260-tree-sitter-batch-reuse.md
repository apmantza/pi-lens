---
section: Fixed
audience: user
---

- **The tree-sitter rule batch is no longer compiled again on the second dispatch.** The first dispatch in a project and every later one gave the batch two identities for the same rules, so each project paid the batch compile twice. On the hot-path sample's large input, the second dispatch drops from about 590-640 ms to 280-330 ms (refs #5260).
