---
category: Fixed
---

**fix(ci): remove unused scratch export and fix test formatting** (refs #2759)

Remove `export` from `DEFAULT_SCRATCH_MAX_AGE_MS` in `scripts/lib/scratch-dir.mjs`
and its matching declaration in `scripts/lib/scratch-dir.d.mts`. The constant is
used internally but has no external consumer — Knip reported it as unused after
PR #2755 introduced it. Fix oxfmt formatting violations in
`tests/clients/formatters.test.ts` and `tests/scripts/lint-js-advisory.test.ts`
introduced by PR #2751.
