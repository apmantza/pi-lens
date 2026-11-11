---
section: Fixed
audience: user
area: blockers
---

- **The footer keeps every file with findings visible.** Two files sharing a basename no longer collapse into one footer row. Rows are keyed on the file path and same-named files show enough of the parent directory to tell them apart, so a blocking file can no longer hide behind a clean one and the header keeps counting every recorded file. (refs #5460)
