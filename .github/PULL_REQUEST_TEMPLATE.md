## Summary

At most three sentences: what changed, who notices, and the risk.

Closes #NNN only when every acceptance criterion is met. Otherwise Refs #NNN, and comment on the issue naming what remains. The PR title carries the same reference.

## Notes for the reviewer

- At most five bullets: decisions and risks only. Proof goes below.

## Change outline

```text
- caller above
  + changed symbol
    + callee below
```

## Proof and checks

### Tests

One red-first transcript per changed test file, cut to the failing lines (at most 20), or a line `Control: <file>: <reason>`. Skip the narrative. Update this section after each review round; do not append rounds.

### Mutations

One table row per new guard or relaxed assertion: the file, the mutation, the result as a backticked `1 failed`, and the failing test's title in backticks. Delete this section when the diff adds none.

### Class sweep

`Shape: #N`, the search command in backticks, then `folds onto ...` or `stays distributed because ...`. Use `none: <reason>` only for a diff with no runtime code.

Alignment: <family names, comma-separated> | none: <reason>

### Observability

The record this diff adds, `covered by existing record <kind> at <file>:<line>`, `none: <reason>`, or `No new failure path; no record added.`

### Fold check

One line per open issue or PR against this mechanism: `#N folded: <reason>`, `#N not folded: <reason>`, or `#N sequenced: <reason>`. Use `none: <reason>` when the search found none.

### Conditional sections

Delete this heading and every section below that does not apply. `npm run preflight` names any it requires.

### Blast radius

Only when the change reaches outside the touched module or hits a hot path: the dependents from `module_report`, and the measured cost.

### Behavior equivalence

Refactor PRs: a table with `Site`, `Before`, and `After` columns.

### Accepted residuals

One line per review finding left open: `p3 (<severity>, live <n>): <the gap>`.

### Detection

Required when this PR names an issue labelled `bug` or `nightly-drift`: `Caught by:`, `Should have been caught by:`, `Gap:`, `Shape:` (`#N` or `new: <name>`), and `Enforcer:` (a test path, `#N`, or `none: judgment-only, <reason>`).
