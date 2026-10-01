---
name: retro
description: Run the pi-lens retrospective — turn a session, an incident, or a merged bug fix into environment changes (checks, hooks, contract lines, deletions), classified mechanical-vs-judgement, each with its red transcript or an issue naming the recurrence. Use at every regroup, after any merged bug fix, on the second round on one defect shape, or when asked "what should we change so this does not recur".
---

# Retro

> Source of truth: `docs/pi-lens-retro.md`. This file is the invocation
> procedure; on any conflict the contract wins.

## Invoke

`/retro` with no argument runs over the current session's ledger and
transcripts. `/retro <PR|issue|run id|"incident: ...">` scopes it to one
incident. The retro is read-only on the repo except for the outputs the
contract names.

## Steps

1. Read `docs/pi-lens-retro.md` in full, then the inputs it names for the
   scope: ledger, transcripts, PR bodies and verdicts, CI logs on the exact
   head.
2. Collect candidates by category; skip categories with no evidence.
3. Classify each candidate mechanical or judgement. Mechanical is the default.
4. Mechanical: build the check now when it is contained (governance test,
   hook, CI job, preflight row) and paste its red on the incident's shape and
   its mutation transcript; otherwise file it with the recurrence named.
   Judgement: one line in the catalog or the owning role contract.
5. Steering audit: every no-op line names the decision it changed or is
   deleted.
6. Record one mistake row per distinct mistake in
   `docs/pi-lens-merge-policy.md` ("Common mistakes").
7. Report the fixed-shape table (Finding, Evidence, Class, Deliverable,
   Status) ordered by severity, and the list of changes made or filed. When
   delegated without Git authority, hand off through `RETRO.md` at the
   worktree root.

## Do not

- Ship a check without its red transcript.
- Write a rule for a mechanical mistake.
- Create a new home for rules; the catalog, the role contracts, and the
  merge-policy mistake table are the only three.
- Mix the retro with implementation or review in one delegation.
