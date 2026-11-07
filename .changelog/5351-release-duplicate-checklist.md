---
section: Changed
audience: internal
---

- The release roll (`release-roll.sh`) now runs `node scripts/rollup-changelog.mjs --duplicates <version>` and adds its checklist of likely duplicate entry pairs (one section and area, similar headlines or shared code spans) to the release PR body; it edits nothing. A release can also carry `.changelog/highlights/<version>.md`, which `changelog-extract.mjs --summary` puts on top of the release body (refs #5351).
