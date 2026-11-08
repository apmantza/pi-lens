---
section: Fixed
audience: user
area: tools
---

- **A stuck retry loop now shows the THRASHING warning.** Repeating the same failing edit three times renders 🔴 THRASHING on that failing result, instead of only when a later retry happens to succeed. (refs #5434)
