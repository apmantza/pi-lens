---
section: Changed
audience: internal
---

- **Mutation diff now mutates product code, not just scripts (closes #3531)** —
  `scripts/stryker-diff.mjs` previously mutated only `scripts/**/*.mjs`, so
  every PR that touched `clients/`, `tools/`, `mcp/`, or `index.ts` printed
  "no changed scripts/**/*.mjs files" and the advisory `Mutation diff` workflow
  went green having mutated nothing. It now also mutates those sources through
  their compiled `.js` (what the test suite actually executes), mapping the
  PR's `.ts` diff hunks onto the compiled output via tsc source maps
  (column-aware, so a survivor on a collapsed multi-line expression reports
  its real `.ts` line) and reporting survivors back at `.ts` file:line. The
  range budget is sized from a measured `--dryRunOnly` cost
  (`budget × concurrency ÷ dry-run seconds`) rather than a fixed range count,
  with a deterministic, seeded sample when the diff still exceeds it; a
  budget kill reports the partial result Stryker itself saved, labelled
  `Partial run`, instead of a bare "no mutants evaluated". The workflow posts
  a job summary and a sticky PR comment (matched to the bot's own prior
  comment, never a human's) listing every survivor (mutator, original →
  replacement) and the killed/survived/timeout/no-coverage counts; a run that
  evaluates 0 or partial mutants always says why and never reads as a clean
  pass, and a head whose job produced no report at all marks its PR comment
  stale rather than leaving an earlier head's report up unmarked. A new
  `scripts/mutation-report.mjs` renders a downloaded `mutation.json` the same
  way for local use. The fixer and reviewer playbooks read the PR's Stryker
  report (once one exists) before hand-mutating anything it already covers,
  including a partial run's unevaluated remainder. A sampled run that
  evaluates 0 mutants now retries against the ranges not yet tried before
  reporting that, and when it still comes up empty its reason names the
  sample size and the measured total instead of claiming no mutable code
  exists across the whole changed-line set (both the job summary and the
  sticky comment always show the "sampled N of M" note, even on that
  zero-mutant path). A partial run's reason no longer contradicts its own "N
  of M evaluated" banner by claiming no mutants were evaluated, and the stale
  notice on a head that produced no report names a `cancelled` upstream job
  as either a newer push superseding it or the job hitting its own time
  limit (GitHub reports both the same way, so the wording no longer picks
  one), separate from a neutral crash/time-cap wording when the upstream
  result says neither. The report renderer itself now backstops a 0-mutant,
  non-partial result at the render seam, so it can never read as a clean
  pass even if a future change to the driver's own branching slips past that
  guard -- computed from the mutants a report actually carries, not only
  from this driver's own summary counts, so a raw `mutation.json` read
  directly (never through this driver) still renders its real survivors
  instead of a false "0 mutants evaluated". Still advisory.
