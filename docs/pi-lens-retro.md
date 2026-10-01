# pi-lens retro — role contract

Turn a session, an incident, or a merged bug fix into changes to the
environment agents work in: a check, a hook, a contract line, a navigation
pointer, or a deletion. Advice that lives only in a transcript is not an
output of this role. Source of truth for every rule here is this file and
`AGENTS.md`; `.claude/skills/retro/SKILL.md` only points here.

Read first: the engineering principles (`docs/engineering-principles.md`),
then `AGENTS.md` ("Recurring defect shapes", "Orchestration and delegated
work", "Test requirements"), then `docs/pi-lens-subagent.md` when delegated,
then this contract and `docs/pi-lens-merge-policy.md` ("Common mistakes"),
which is where mistake rows land.

## When it runs

- At every orchestrator regroup (a status table, a context reset, a handoff).
- After every merged bug fix, as the detection retrospective the PR body already
  owes: which layer caught it, which should have, at what cost.
- On the second round on one defect shape in one session (the same trigger
  that moves a contract).
- On any incident: master red, a wasted round, a refuted claim, a probe that
  wrote where it must not, a worker that skipped a rule it had read.

## Inputs (primary sources, never memory)

The lane ledger, the session transcripts, PR bodies and review verdicts, CI
job logs on the exact head, `~/.pi-lens/latency.log` when runtime behaviour
is involved. Every finding cites the source it came from.

## Procedure

1. **Collect candidates** across these categories. Skip a category when the
   session has no evidence for it; never manufacture one.
   - *Navigation*: the agent took long to find a file, a seam, or a rule.
   - *Automated checks*: a mistake a lint, test, hook, governance sweep, CI
     lane, or preflight row could have caught, or an existing check that is
     unwired, advisory when it should gate, or blind to the case (a lane that
     skips on `pull_request` and therefore never ran on the PR that changed it).
   - *Standards*: a rule the reviewer should enforce, or an existing rule that
     was read and still violated.
   - *Steering no-ops*: a line in `AGENTS.md`, a role contract, or a skill that
     changed no decision in the session and cannot name one where it did.
   - *Tool economy*: repeated or expensive calls, retries against the same
     failing surface, transcript reads where a bounded summary existed.
   - *Information access*: a fact the agent needed and could not reach (a log
     not readable until a run completed, a value only a maintainer knew).
   - *Measurement*: a claim asserted rather than measured, or a probe run in
     the wrong environment (an unpinned home, a `TMPDIR` aimed at the harness
     home).
2. **Classify every candidate: mechanical or judgement.** Mechanical means a
   fixed pattern a program can decide: a banned spelling, a file location, a
   workflow gate, a required transcript in a PR body, a value that must match a
   table. Judgement means cross-file consistency or intent that no program can
   decide. The default is mechanical; a candidate is judgement only when the
   retro says what a check would have to know that it cannot.
3. **Mechanical candidates become checks, in the same session when contained.**
   The check is a governance test, a `PreToolUse` hook, a CI job, or a
   preflight row, whichever the repo's existing guardrail makes cheapest. It
   ships with its red on the incident's own shape and a mutation transcript,
   exactly as a regression test would; a check without a red is a proposal and
   is filed as an issue naming the incident as its recurrence, not merged.
4. **Judgement candidates become one line in the right place.** A defect shape
   goes into the `AGENTS.md` catalog with the reference; a reviewer duty goes
   into `docs/pi-lens-reviewer.md`; a fixer duty goes into `docs/pi-lens-fixer.md`
   only when the fixer is the sole actor who can honour it. Standards are
   enforced by the reviewer, whose context pressure is lowest; fixers get
   navigation pointers, not more prose.
5. **Steering audit.** For every no-op candidate, either name the session and
   decision where the line changed behaviour, or delete the line. A rule that
   was violated the day it was written is a mechanisation candidate, not a
   candidate for stronger wording.
6. **Record.** One mistake row in `docs/pi-lens-merge-policy.md`
   ("Common mistakes") per distinct mistake, with the fix that is now in place.
   Orchestrator-level lessons that are not repo rules go to the orchestrator's
   memory. Never a fourth home for rules.

## Output (fixed shape)

A table ordered by severity, then the changes made or filed:

| Finding | Evidence (path, run, PR, transcript line) | Class | Deliverable | Status |
|---|---|---|---|---|

Status is one of `built` (with the red transcript), `filed` (issue number
with the recurrence named), `refuted` (the probe that showed the candidate is
not real), or `deleted` (the steering line removed). A retro with no rows is a
valid result and says so.

## Rules

- A check that cannot be made red on the incident does not ship.
- Never widen scope: a retro proposes changes to the environment, not to the
  product, and files product defects it finds as issues.
- The retro is run on the strongest available model and is never mixed with
  implementation or review in one delegation.
- A delegated retro worker is read-only on the repo except for the files this
  contract names as outputs, and hands off through `RETRO.md` at the worktree
  root when it lacks Git authority.
