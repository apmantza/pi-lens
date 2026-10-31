# Engineering principles

Source of truth: https://github.com/apmantza/engineering-principles (private), file PRINCIPLES.md. Verbatim copy; the repo wins on drift. Project-level AGENTS.md / CLAUDE.md add the project catalog and win on conflict.

Project-neutral rules distilled from the pi-lens contracts, playbooks and merge
train (2026-08 to 2026-09). Each rule is imperative and carries the reason it
exists. Projects keep their own catalog of defect shapes, registries, and
commands; this file is what stays the same across them.

Read order for any agent starting work: this file, then the project's own
AGENTS.md or CLAUDE.md, then the role contract for the task (fixer, reviewer,
investigator). Project instructions win on conflict.

## 1. Building

**Premise first.** Reproduce a reported defect through the production call
path before writing a fix. Drive the real dispatcher, loader, or builder; never
a hand-shaped input that exists only to hit the bug. If it does not reproduce,
the deliverable is the recorded refutation (which invariant covers it, with the
probe) and, where cheap, an assertion that pins it, not machinery for a
collision that cannot occur.

**Speculative robustness needs buy-in.** Before adding mechanism for a race,
security edge case or failure nobody has reproduced, state the trigger path
(which inputs, in what order, through which production caller), the evidence
that it can happen, and the cost (new state, seams, tests to maintain). Without
a reproduction the default is no new mechanism: record the case as a hypothesis
or an accepted residual for the maintainer to decide. Workers flag it in the
hand-back and do not build it; reviewers file an unproven race as a hypothesis,
not a high-severity finding. This never waives validation, error handling or
security at a real trust boundary; it bounds new mechanism, not hygiene.
Screen: can the author name the production sequence that triggers it, with
evidence?

**Climb the minimalism ladder before writing code.** Be lazy about the
solution, never about reading. Trace the real flow, then ask in order: does this
need to exist at all; does the codebase already do it (reuse the seam); does the
platform or stdlib do it; does an installed dependency do it; is it one line.
Only then write the minimum that works. Validation, error handling, security and
bounded observability are never skipped in the name of minimalism.

**Net-count rule for shared helpers.** A change that introduces a shared helper
while same-shape siblings exist deletes at least one sibling in the same change.
The helper count never goes up. Deferring the fold is allowed only when the
brief names every sibling, states why folding them together is unsafe, and
links the follow-up. This binds whoever writes the brief as much as whoever
implements it.

**A fix's pattern matters more than its instance.** When a root cause is
understood, name the defect shape and sweep the whole tree for other members
before closing. Fix the contained siblings in the same change; file the rest
with the member list; record what was grepped and what was found clean. Seeing
without recording is indistinguishable from not looking. Every sweep ends with
a consolidation verdict: fold onto one seam (name it) or stay distributed (say
why). The deciding test is deletion: would removing the shared module
concentrate complexity back into callers (fold) or merely relocate the same
lines (stay)?

**Design shared state once, at design time.** Before adding a second writer to
any shared record (a cache entry, a latch, a ledger, a mirror, a counter) decide
whether every actor needs one canonical object or each can own its record and
merge at read. Refresh mirrors inside the guard that published the durable
state. A resource bounded along one axis and unbounded along another is a leak.

**Every new failure path gets bounded observability.** One record per distinct
event per session, never one per occurrence in a loop; repeated degradations go
through a once-only or counted record. A discriminator nothing can observe is a
vacuous guard and does not ship.

**Gates fail closed on what they do not recognize.** When code decides a
verdict (a trust check, a lint, a census, a body check), it admits a short list
of known-good forms and refuses everything else. It never enumerates known-bad
spellings. Each review of an enumerated gate finds the next spelling it missed;
one gate took sixteen rounds that way. Once a second round finds a new
spelling, stop patching and redesign. A value the gate cannot resolve to a
known-good literal (computed, concatenated, aliased, templated, reached through
an indirection) is unrecognized: it counts as a hit, never a pass. Screen: can
an input nobody planned for pass the gate?

**Blast radius as a call-tree diff.** For any change to a shared seam, list the
changed symbol, its callers above, its callees below, with plus and minus on the
lines that moved. Prose keeps missing callers; a tree the reviewer can grep does
not. Name every strict consumer of a durable record whose shape changes, and
prove old records still parse.

**Deletion sweeps dependents first.** Before removing a guard, a defensive
branch, or a field, grep every caller and every test double. Correct-looking
deletion asks have redded CI because dozens of doubles depended on the removed
line.

**Identity and lifecycle rules are stated before the first edit.** When a change
touches session, ownership, or resume semantics, write the invariants and the
writers-by-axis table (which actor, which identity, which timing) first, and
choose the simplest identity rule that satisfies every cell. Adding a second
identity clause "to be safe" produced two consecutive regressions on one seam.

## 2. Testing

**Red first, and keep the transcript.** Every regression test is shown failing
on the pre-fix code with the failure that matches the defect, and the output is
pasted into the change description. A test that passes pre-fix is a finding.

**Tests ship with the code, in the same commit.** A change and the tests that
prove it land together; a test-only follow-up round means the first commit
shipped unproven. The failure list is written before the first edit, and the
mutation table is that list with transcripts, never a list invented after the
code.

**Keep fixture corpora from every supported version.** Every durable record,
config file, cache entry or wire message the project still reads has a fixture
from each version that produced it, and the parser is run over all of them. An
old-record parse proof is a fixture in the corpus, not a sentence in a PR body.

**Mutation output is quoted, not ticked.** For every new guard, branch, filter,
cap or fallback: neuter it in the built output, run the suite that should catch
it, and paste the red. A checked box with no transcript is treated as false. A
mutation that fails to compile proves nothing about the test; redo it as a
compile-valid change. A guard that cannot be made to red does not need to exist.

**A precision figure names its judgement and an outside sample.** A claim that
a rule, check or heuristic is N% precise states what counts as a true positive,
and someone other than its author judges a random sample. "The pattern matched"
is not "the finding is worth acting on": one rule reported 611 of 611 hits real
on a type check, and an independent sample of 58 found none worth the rewrite.
Below the stated bar, the rule ships disabled with the count recorded.

**Tautological tests are harmful.** A test observes behaviour through the real
seam and asserts an independent effect. It never restates the implementation,
never asserts a value its own setup supplied, and never swaps a real in-process
store, sink, coordinator or registry for a fake. Mocks belong only at true
process or host boundaries.

**Every guard test names the recurrence it prevents** in its own comment: the
shipped defect or the concrete drift it would catch. A guard with no named
recurrence is speculative and does not ship.

**Detectors match code, not prose.** Any test-side scan that regexes source
must run over comment-and-string-blanked text, with a per-needle policy for the
rare needle whose evidence is a string literal. A comment quoting the needle
must never satisfy a requirement or an exemption. The self-excuse direction
(prose makes a guard pass) is the dangerous one; the false-positive direction
reds loudly and is lower priority.

**Ratchets and baselines are admissions, not loosening.** A new real spawn,
timer, or wall-clock assertion is admitted with a header stating why the real
thing is required, a registry entry, a baseline row and lane membership. A
mocked seam is not a real spawn and gets an exemption with its reason, never an
admission.

**A gate judges the actor's delta, not inherited state.** A check run on an
artifact someone edits (a tracker body, a shared file, a long-lived record)
judges only what that edit adds or changes. Inherited violations belong in a
baseline that shrinks on purpose. Refusing an honest edit for debt it did not
create blocks the work or invites routing around the gate. If the gate cannot
compute the delta, it checks the whole artifact, failing closed.

**A new ratchet sweeps the open changes before it lands.** A governance test
that rejects a new pattern fails every open change that already adds one, and
none of them conflict textually, so nothing warns. Before merging a ratchet,
run it against each open change merged with the base, and fix or notify each
one it fails. Screen: which open change would fail this test after the merge?

**Run targeted files while iterating; the full suite runs once.** Build before
testing when tests execute compiled output, and rebuild between mutations. A red
is environmental only when the same test is red on the base branch in the same
environment; say so with the evidence.

**Probe hygiene.** Every probe, test run and child process pins its home,
data and log directories under the working tree. Nothing an agent runs writes
to the maintainer's real home.

## 3. Reviewing and delegating

**Every change is reviewed adversarially, including small and self-authored
ones.** Depth follows what the diff touches, never the priority label: runtime,
tooling, CI and manifests get full adversarial review; test-only diffs that are
not ratchets get one scoped pass; docs and renames get an orchestrator read plus
CI on the exact head.

**A finding is real when a probe proves it; a fix is real when the same probe
passes.** Reviewers attack with throwaway probes and quote the output. They
reproduce the red run themselves (keep the tests, revert the source), mutate
every new guard, check merge state first (a conflicted change silently skips
its gates), and read CI on the exact head. Reviewer prescriptions are
hypotheses: the verify round attacks them as a rival's.

**The same reviewer verifies each fix round.** Continuity is the reviewer's
judgment and probe set; the checkout under it is rebuilt fresh at the new head
every round. When a review or verify names a new defect on the same seam, the
next fix opens with the state-space table written before any edit, on the
strongest available model. Never send a third patch-only round on one seam.

**Round routing.** A round that only applies a prescribed remedy with quoted
reds merges on green. A round that adds mechanism, touches lifecycle or session
semantics, or rewrites a guard gets a fresh verify. Classify by the worst
finding, not the count. Intent-free findings (a body sentence, a comment, a
literal, a changelog line) are applied by the orchestrator as trailing commits
and never re-verified; anything that changes what code means goes through a
round, however small it looks.

**A round does what its brief prescribes, and flags anything more.** A worker
that changes something outside its brief lists that change as scope growth at
the top of its hand-off; one round widened a shared detector while asked to add
a single admission. Routing then re-classifies the round, because a silent extra
mechanism turns a merge-on-green round into one that needs a verify. Screen:
does the hand-off name every change the brief did not ask for?

**Merge gate.** Merge only when the verdict is merge-ready, every gating check
genuinely executed and passed on the exact head, and every failing check was
read and judged. Absent is not green. Read exit codes directly, never after a
pipe. After a merge, check the other open changes for conflicts and prune only
the merged lane's worktrees.

**Delegation contract.** Every delegation names the role, the absolute worktree,
branch, base, acceptance criteria, non-goals, sibling files to avoid, and Git
authority. A role never grants Git authority by itself. A worker without it
leaves changes uncommitted and hands off through a PR body and a commit message
at the worktree root; the orchestrator commits. Implementation and review are
never mixed in one delegation. Scope changes are mirrored on the tracking issue
before they are sent, so the worker can verify them.

**Work in progress survives a cut.** A worker with Git authority commits at
each green step; one without it leaves its tree and names it in the hand-off.
A backend outage, a quota stop or a crash then costs one step, not the round,
and the next round ports the tree instead of redoing it. Screen: how much is
lost if this process dies now?

**No manufactured work.** An idle worker is cheaper than fake work. Delegate
when a real producer, consumer, probe or diagnosis is unresolved, never to keep
a pool busy. The same applies to status artifacts: they exist for coordination
someone consumes.

**A step done by hand twice becomes a script with a test.** That includes
cleanup, triage and status upkeep. The script surfaces unfinished work and
never hides it: stalled work is restarted, not unassigned, archived or deleted.
Screen: is this the second time this step was done by hand?

## 4. Honesty and records

**Closes versus refs follows delivery, not optimism.** Close only when every
acceptance criterion is met; otherwise reference the issue and post the named
remainder before anything merges. After merging a referencing change, verify the
issue carries that comment or close it crediting the change.

**Report what ran, what was skipped, and what CI must still confirm.** A
skipped suite, an environment-blocked file, a mutation that could not be
executed: each is named, never implied green.

**Contracts move in the same session.** When a review or an incident reveals a
defect class rather than an instance, the rule enters the project's catalog with
the reference and a one-line screen before the next dispatch. Two rounds on the
same shape in one session is the trigger.

**Detection retrospective on every merged bug fix.** Record which verification
layer caught it and which layer should have caught it earlier and at what cost.
If that layer does not exist, file it with the bug as its named recurrence.

**Keep a lane ledger.** One row per lane with a fixed state vocabulary (not
started, fixing rN, waiting on CI, waiting on review, waiting on verify,
blocked, ready to merge, merged, needs user decision, held). It is what survives
a context reset, and it lets a different orchestrator build the status table
without reading transcripts.
