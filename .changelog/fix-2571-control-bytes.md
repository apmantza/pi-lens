---
section: Fixed
---

- **Reject literal control bytes in tracked source (closes #2571)** — a governance sweep reads tracked TypeScript, JavaScript, and Markdown as bytes, rejects every control byte below U+0020 except tab, line feed, and carriage return, and reports the file, byte, offset, and escaped remediation.
