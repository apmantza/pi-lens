# Orchestration procedure

The orchestrator-only half of `AGENTS.md` "Orchestration and delegated work":
brief authoring, review intake, the fold check, and the merge gate's CI read.
The delegation and hand-back rules a worker obeys stay in `AGENTS.md`; the
per-PR loop itself is `docs/pi-lens-merge-policy.md`.

- A brief never asks a worker to wait for an answer ("report the size first"):
  a worker cannot wait for a reply. It either authorizes the conditional
  branch with its bound, or tells the worker to stop and hand back there.
- A brief names every file by its repo path (`clients/lsp/index.ts`, never
  `index.ts`): a bare basename resolves to another file in a read-only pass.
- After every completion, push, verdict, merge, or status request, trigger the
  next named owner in the same pass, and keep the handoff (exact head, verdict,
  dispositions, next owner) on the PR or the ledger.
- Review intake generalizes before it routes. For every HIGH, MEDIUM or
  CRITICAL finding, name the defect shape, grep the tree for other members, and
  record a verdict before the fix round dispatches: contained in this PR (with
  the sweep), sibling issue filed with the member list, or none (with the
  grep). The fix brief carries it as a `Shape:` line. History: `HISTORY.md`,
  2026-10-10.
- Plegma reads are token-budgeted (#417): settlements via `watch --next --mine`,
  `result` only when the transcript or handoff artifact is needed.
- Every regroup, merged bug fix, second round on one shape, and incident runs
  the retrospective in `docs/pi-lens-retro.md`.
- Three open issues on one mechanism, in any seam groups, open a consolidation
  audit across every consumer of that mechanism before the next one is filed
  (history: `HISTORY.md`, 2026-10-16).
- Run the **fold check** as soon as a lane's mechanism is known, which is when
  the brief is written: read every open issue against that mechanism and decide
  each candidate as folded into this PR (one `Closes #…` per folded issue) or
  not folded, with the reason (two hazards in one review, a maintainer decision,
  a blocked dependency, a different seam). The brief carries the candidate list
  and its decisions, and the PR body records them under `### Fold check`.
  Planning precedes filing: a new issue is the answer for p2+ work no lane can
  carry, never for a p3 the lane could fold (history: `HISTORY.md`, 2026-10-20).
- A PR body's `### Class sweep` ends with one `Alignment:` line naming the
  families of `docs/alignment-families.md` the change touches, or `none:
  <reason>`; the body lint refuses a body without it.
- The per-PR loop (review, verify, auto-merge on green), round routing, the
  merge gate and the Common mistakes table live in `docs/pi-lens-merge-policy.md`.
- Read CI with `node scripts/ci-verdict.mjs <pr|sha>` (exact head, all pages).
  Never merge on absent, stale, or advisory-only checks.

