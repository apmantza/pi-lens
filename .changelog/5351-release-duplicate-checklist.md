---
section: Changed
audience: internal
---

- The release roll now runs `node scripts/rollup-changelog.mjs --duplicates <version>`, which lists likely duplicate entry pairs (one section and area, similar headlines or shared code spans) as a checklist for the release PR body and edits nothing (refs #5351).
