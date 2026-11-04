---
section: Changed
audience: user
---

- **Codemode scripts receive pi-lens notes in the tool text (corrects #3832)** — A codemode script gets each pi-lens tool's joined text, including the notes pi-lens appends to it, such as a blocker note. The #3832 entry said scripts get raw output without those notes. That holds only for a tool that declares an `outputSchema`, and no pi-lens tool declares one, so a script gets text and never `details`.
