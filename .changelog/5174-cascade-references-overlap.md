---
section: Changed
audience: user
---

- **Cascade asks for changed-symbol references together** - up to three references requests now overlap instead of running one at a time, which cut the leg by 6 to 44 ms at the median on a real tsserver and bounds it at one 750 ms window (#5174).
