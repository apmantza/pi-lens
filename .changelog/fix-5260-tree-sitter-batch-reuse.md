---
section: Fixed
audience: user
---

- **The tree-sitter rule batch is no longer compiled again on the second dispatch.** The first dispatch in a project and every later one gave the batch two identities for the same rules, so each project paid the batch compile twice; the second dispatch in a fresh process drops from about 1.3 s to 0.26 s (refs #5260).
