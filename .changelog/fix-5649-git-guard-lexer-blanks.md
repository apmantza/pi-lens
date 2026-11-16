---
section: Fixed
audience: user
area: blockers
---

- **The commit gate now sees commits that bash runs after escapes or Unicode spaces.** The gate read a no-break space or an escaped quote differently from bash, so a `git commit` written after one went unseen. It now splits words on a space, a tab and a newline only, as bash does. (refs #5649)
