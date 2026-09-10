Operating rule: Admit each whole-module vi.mock by file, specifier, and sorted factory-property fingerprint, then ratchet the missing count.

Kept: The existing importer reachability, pass-through, skipped-specifier, and AST detector rules remain unchanged, including shape 38’s “also” clause.

## Summary

Closes #2816

The sweep no longer keys admissions on test-file line numbers or exact missing-export arrays. It uses `file:specifier:sorted-factory-properties` and stores the admitted missing count.

Production exports added while a factory stays unchanged produce a warning row naming the missing export. A changed factory fingerprint is a new admission and reds, so dropping a previously provided export remains blocking.

`npm run test:regen -- vi-mock` runs the live sweep and rewrites the baseline. The old baseline had 605 entries and 10,939 lines. The regenerated baseline has 605 entries and 607 lines. All 605 rows changed keys because the old `file:line:specifier` identity became the content identity; no admission was added or dropped. The old exact arrays became integer missing counts.

## Tests

The requested red-first fixtures run through the real detector and comparison path:

- Production module gains an export: passes with a warning containing `missing b`.
- Factory drops a previously provided export: reds with `regression` because its fingerprint admission is absent.
- A line inserted above `vi.mock`: preserves the key and excludes the line number.
- Line-key mutation: produces a regression and dead-entry problem.

Verbatim transcripts:

```text
> pi-lens@4.1.5 test:regen
> node scripts/regen-test-baseline.mjs vi-mock

Test Files  1 passed (1)
Tests  12 passed (12)
```

```text
Test Files  1 passed (1)
Tests  11 passed | 1 skipped (12)
```

```text
Test Files  50 passed (50)
Tests  427 passed | 1 skipped (428)
```

```text
Test Files  2 failed | 12 passed (14)
Tests  3 failed | 211 passed (214)

The three failures are unrelated support git-fixture tests. The workspace guard rejected their intentional temporary `git init` calls outside this worktree.
```

```text
Test Files  2 failed | 12 passed (14)
Tests  3 failed | 211 passed (214)
```

The required commands also passed: `npm run build`, `npm run fmt:check`, and the first preflight.

Preflight transcript:

```text
| gate                      | mirrored CI job                | pass/fail | first red line |
| ------------------------- | ------------------------------ | --------- | -------------- |
| build                     | Lint & type-check              | pass      |                |
| lint                      | Lint & type-check              | pass      |                |
| fmt:check                 | oxfmt format check             | pass      |                |
| changelog:check           | Unit tests                     | pass      |                |
| check-changelog-fragments | Changelog fragment (fast-fail) | pass      |                |
| check:lockfile            | Lint & type-check              | pass      |                |
| lockfile:complete         | Lint & type-check              | pass      |                |
| tests/config              | Unit tests                     | pass      |                |
| generation-guard          | Unit tests                     | pass      |                |
| flake-shape-ratchet       | Unit tests                     | pass      |                |
| lsp-spawn-heavy-coverage  | Unit tests                     | pass      |                |
| ci-verdict                | Unit tests                     | pass      |                |
| knip                      | knip (advisory)                | pass      |                |
```

## Blast radius

The baseline has one consumer: `tests/config/vi-mock-export-sweep.test.ts`. The regeneration script is the only writer and is invoked by `npm run test:regen -- vi-mock`. The detector adds only the factory-property metadata required by that consumer. No production runtime path changes.

## Class sweep

`tests/config/hook-await-bounds.test.ts` uses `rel#symbol:hash(ownLine)` keys, and `tests/clients/flake-shape-ratchet.test.ts` uses detector/file identities with count ratchets. They share the general risk of routine source edits invalidating a baseline, but they protect different observations: hook occurrence identity needs symbol neighbourhood disambiguation, while flake-shape data measures per-file detector populations. Neither should fold into the vi.mock baseline because neither has a mock-factory property fingerprint or export-count direction.

## Observability

No new failure path; no record added. Warning output names the admitted entry and every currently missing export, so an export-surface expansion remains visible without turning routine additions into red CI.

## Test assessment

This change edits `tests/config/vi-mock-export-sweep.test.ts` and adds four real-detector fixtures. The fixtures use temporary production and test files, exercise `findViMockExportGaps`, and independently test comparison outcomes. The baseline is regenerated by the new entry point rather than hand-maintained. No existing test was weakened or replaced with a fake runtime.
