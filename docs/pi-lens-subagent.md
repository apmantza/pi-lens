# Delegated worker delivery contract

Read first: the engineering principles (`docs/engineering-principles.md`; skip
it when your harness's global instructions already carry the verbatim copy),
then `AGENTS.md`, then this contract, then exactly one role contract from
`docs/pi-lens-{fixer,reviewer,investigator,monitor,warden,retro}.md`. This file
holds the pi-lens rules every role shares, for every runner and model. The
principles apply throughout and are not restated; project files win on
conflict.

User-facing prose follows the live standard in `docs/pi-lens-reviewer.md`.

## Worktree and Git

Work only in the assigned worktree. Before editing, verify its absolute path,
registered `git worktree list` entry, branch, and base. Preserve linked or
junctioned dependencies. Never switch another checkout's branch, never pass the
main checkout's path as `repoRoot` or `cwd` to a probe that writes or deletes
(#2704), and never use `git stash`. Save a patch before temporarily reverting
uncommitted work.

A lane never writes files to the shared session scratchpad: lanes spawned from
one session share it and overwrite each other's fixed names (#3850). Probe
scripts, PR bodies, and TLC logs go under `$TMPDIR` (its value is in
"Orchestrator lane mechanics") or `<worktree>/../probes-<lane>`.

The Bash-hook rules in `AGENTS.md` "Contributing" bind every runner, hooked or
not. Hooks always run. A hook or CI red is unrelated only when
`scripts/red-on-base.mjs` reports `RED-ON-BASE` for every failing test
(`AGENTS.md` "Commands and gates"); for a hook, then STOP and hand back the
quoted output. Never bypass or push past it.

Git authority is separate from the role. Commit, push, or open a PR only when
the delegation explicitly grants that authority after worktree verification.
Otherwise, edit and test with the assigned worktree as the command working
directory, leave every change uncommitted, and write two handoff files at the
worktree root: `PR_BODY.md` (the full PR body, transcripts pasted) and
`COMMIT_MSG.txt` (subject, body, issue ref, trailers). Name any path inside the
worktree that must not be committed. The orchestrator commits from those files;
they are never committed themselves. Never merge. GitHub writes (comments,
issues) happen only when the brief grants them. Every report or artifact the
delegation asks for lives at the worktree root under the name the brief gives
it; nothing else at the root is assumed to matter.

When Git authority is granted, use one logical commit with an imperative,
conventional-prefix subject of at most 50 characters, a blank line, and a
72-column body that states what and why. Reference the issue. Commits, PR
bodies, and comments never carry a `Claude-Session:` trailer or session link.
Stage files by name, never `git add -A`: the root handoff files are gitignored,
and tracking one reds `tests/config/gitignore-tracked-shadow.test.ts`. Read
`git status --porcelain` before committing; afterwards
`git ls-files | grep -E 'PR_BODY|COMMIT_MSG'` prints nothing. Build output,
`.probe-home/`, and scratch fixtures stay out of the diff.

When updating a lane from the moving base, master is merged in, never rebased.
Force-pushes are not a recovery path: use a normal push, and require
explicit orchestrator authorization for
`--force-with-lease=<branch>:<sha>`.

Push forms are in "Orchestrator lane mechanics". Before `gh pr create` or `gh pr edit`, lint the body with
`node scripts/check-pr-body.mjs --lint-local <body-file> "<title>"`. Multiline
text (bodies, commit messages, comments) goes through a file (`--body-file`,
`git commit -F`); re-read what GitHub stored and check the newlines survived.

## Orchestrator lane mechanics

A brief that names `lane=<name>`, its scope, and a Git-authority grant gets
every rule below without restating it; a brief never copies this section. A
rule here binds fixers, reviewers, and every other role. `<lane>` is the name
the brief gives.

- **Checkout.** A lane's checkout is a `git worktree add` from the main
  checkout under `~/.local/share/pi-lens-orchestrator/tmp/<lane>`, never under
  `/tmp`, which is tmpfs on the maintainer host (RAM plus swap), and
  `guard-bash.mjs` denies it (#3526). A worker that must cut its own worktree
  follows its harness note and still names the lane. Verify the checkout as
  "Worktree and Git" says before the first edit.
- **Paths.** Use absolute paths only: a relative path lands in whichever
  checkout the shell happens to sit in, and agent shells reset their working
  directory between calls. Never edit the main checkout: other lanes and the
  orchestrator read it, and its branch must not move under them.
- **Teardown.** `rm` a symlinked `node_modules` before `git worktree remove`
  (`ls -ld node_modules` first; unlink the link, never `rm -r` it). Removing the worktree over the link follows it
  and deletes the main checkout's install (#3173; the hook denies the removal
  and `AGENTS.md` "Commands and gates" says how `pr-worktree.mjs close` does
  it). A real `node_modules` directory is removed only after confirming the
  main checkout's install is intact.
- **Linked installs.** Never run a mutating npm verb (`ci`, `install`,
  `update`, `uninstall`, `prune`, `dedupe`, `rebuild`), even `--dry-run`, where
  `node_modules` is a link: `npm ci` empties the shared install under every
  lane (#4044, 2026-10-07; `guard-bash.mjs` denies it). Answer install-flag
  questions in a scratch copy under `$TMPDIR`, never in the linked lane.
  Unlink with `rm node_modules` (no trailing slash or glob): `rm -rf
  node_modules/` and `find node_modules/ -delete` empty the target too.
- **TMPDIR.** Export
  `TMPDIR=~/.local/share/pi-lens-orchestrator/tmp/<lane>-tmp` for every command
  in the lane, including checks that spawn npm, git hooks, or a child
  process: a command without it writes to the shared tmpfs, or to the
  harness home, which the hook also denies. The directory sits beside the
  worktree, never inside it (an untracked file in the tree reds
  `tests/scripts/lint-js.test.ts`) and never under `.cache`. Never point it at
  `PI_LENS_HOME` (see "Tests and probes" for that pin).
- **Push forms.** Push only a branch the grant names, and push the head
  you verified:
  - Own branch, the plegma credential-helper form (until plegma #474 lands):
    `git -c credential.helper= -c credential.helper='!gh auth git-credential'
    push origin HEAD:refs/heads/<branch>`.
  - Contributor fork (maintainer round on an external PR): push to the fork's
    URL and branch, `git push <fork-url> HEAD:refs/heads/<branch>`, with the
    same `-c credential.helper=` pair; the fork's URL and branch come from
    `gh pr view <N> --json headRepository,headRefName`, never from memory.
    Preserve the contributor's authorship and approve the fork-PR
    `action_required` runs afterwards (`docs/pi-lens-merge-policy.md`).
  - Never force, and never `--force-with-lease` without the orchestrator's
    explicit authorization ("Worktree and Git"). If the remote head moved
    since the last fetch (a rejected push, or a head SHA other than the one the
    brief or your last push named), STOP and report: merge-and-retry is the
    orchestrator's call, because another lane or the contributor is writing the
    same branch.
- **Git-authority grants.** The brief names exactly one; a role never implies
  one, and an unnamed grant is `none`.
  - `own-branch`: commit on the lane's own branch, push it, open and edit a PR
    whose body passes `node scripts/check-pr-body.mjs --lint-local`, and read
    CI once. Never merge, never close, never touch another branch.
  - `fork-push`: `own-branch` for a contributor's fork branch through the fork
    form above, on the PR the brief names. Never open a new PR, never
    merge.
  - `none`: edit and test in the worktree, leave every change uncommitted, and
    write `PR_BODY.md` and `COMMIT_MSG.txt` at the worktree root
    ("Worktree and Git"). A reviewer is always `none` and read-only.
  GitHub comments and issue edits are separate: only a brief that grants them
  allows them.
- **Deliverable.** The report opens with an `ORCHESTRATOR SUMMARY` of at most
  30 lines: the PR (or branch), the head SHA, the change or verdict in a few
  lines, red and green evidence as counts with the quoted transcript below it,
  every skipped check or environment block, and what the orchestrator must
  decide. The RETURNED message (the agent's final reply, or the plegma answer)
  is that summary and nothing else: the full evidence (probe transcripts,
  tables, mutation logs) goes in the declared deliverable file or, when there
  is none, `~/.local/share/pi-lens-orchestrator/tmp/<lane>-tmp/REPORT.md`, and
  the summary names that path. The orchestrator reads the summary alone to
  route the lane and opens the file only when routing a fix round, so a claim
  made only in the file does not route. (Full reports pasted into the reply
  were the largest orchestrator token cost on 2026-10-07.)
- **Handbacks between rounds.** Every lane's returned summary for PR #N is
  kept at `~/.local/share/pi-lens-orchestrator/tmp/handbacks/pr-<N>.md` (the
  orchestrator's hooks write it; a fixer may also write it). A reviewer or
  verifier of PR #N reads that file FIRST and attacks its claims, so the brief
  carries only the attack angles, never a restatement of what the fixer
  claims.

## Tests and probes

Every Vitest invocation on the maintainer host exports
`PI_LENS_TEST_MAX_WORKERS=6` and the lane's `TMPDIR` ("Orchestrator lane
mechanics"; scratch goes in a private subdirectory) and names its files. The full suite is CI's job. Run up
to about 15 files with `npx vitest run <files>` in the foreground with an
explicit timeout; run the governance batch through
`npm run test:targeted -- <files>` (one of two machine-wide slots), also in
the foreground.

Before handback, run `npm run lane:check` (and `--body <file>` when
applicable) and quote its JSON record and ORCHESTRATOR SUMMARY. Its verdict
sets the exit code and only `clean` exits 0:

- `clean` (0): every step ran and no red is the change's. A red that also fails
  on `origin/master` is listed as `RED-ON-BASE` and stays `clean`.
- `red-caused` (1): a failing test is `CAUSED-BY-CHANGE`, or a root handoff
  file is tracked.
- `unproven` (3): a step failed or a red could not be attributed (the build, a
  run with no named failing file, an `INCONCLUSIVE` red-on-base verdict, a
  failed lint or format check, a selection over the 25-file cap where only
  governance suites ran). That is not evidence of unrelated: report it and
  stop, or fix the cause. The summary prints `selection: selected S, matched
  M, capped C`.
- `2`: usage error (`--body <path>` or `--body=<path>` missing, unknown, or the
  file absent); nothing ran.

The change set is the committed diff plus uncommitted tracked edits and
untracked files, so a lane without Git authority is checked too. In a lane that
refuses `git worktree add`, `scripts/red-on-base.mjs` compares against a
`git archive` tree of the base instead.

Select governance suites mechanically, never from memory (#2107, #2438, #2470,
#2511):
`ls tests/clients/*{sweep,ratchet,conformance,coverage,gate,governance,silence,hermeticity,invariant,contract}*.test.ts`
plus every `tests/config/*.test.ts`. Quote the file count you ran.
`tests/config/glossary-synonym-sweep.test.ts` pins the retired-synonym
identifier population per (term, file) in both directions (#3279): when a
change adds or removes a pinned use, run it on the head and on the merge of
`origin/master` and the head before pushing, and re-pin in the same PR from its
`UNPINNED`/`STALE` output (#3284, #3288).

Each pre-push head has a durable result record at
`$(git rev-parse --git-common-dir)/pi-lens-prepush/<sha>.json`. It contains the
head/base, timestamp, selected test files and their `import`, `history`, or
`governance` reason, plus passed/failed/skipped counts, the Vitest exit code,
and wall time. Re-pushes overwrite that head's record; writes prune records
older than fourteen days. The provisional record is written before build and
self-scan work with outcome `tests-not-started`; preparation failures update it
to `build-failed` or `self-scan-failed`. The write uses a same-directory
temporary file and rename, and record I/O is best-effort: a warning is emitted
once and the hook keeps its real build/test result. Quote this path when
reporting targeted-test evidence instead of relying on prose.

Never park a turn behind a background command. When a run cannot finish in the
foreground, push with the targeted and governance suites green and say that
the full suite was delegated to CI.

Pin `PI_LENS_HOME` and `PILENS_DATA_DIR` to `<worktree>/.probe-home` for
probes, smoke scripts, and `npm install`/`npm ci` (`AGENTS.md` "Paths, data,
and operating systems"); a test that inspects the install record also pins
`PI_LENS_INSTALL_LOG`. Never export them for a Vitest run: the setup keeps
the real home on purpose (#3178). Kill every language server a probe spawns
before moving on; the plegma daemon's cgroup holds every worker's children
(the 2026-09-19 OOM). Never run a full in-place Stryker run in a shared or
long-lived worktree (#3180); reproduce with `--dryRunOnly`, never under a kill
timeout.

A sandboxed worker may find the shared `.git` and the linked `node_modules`
read-only and the network absent (a write-confined sandbox does this; the
runner's own notes say which mode lifts it). Run Vitest as
`node_modules/.bin/vitest run <files> --configLoader runner`, and if the
tree-sitter grammar prefetch hangs offline, verify through direct probes of the
built code and say so; the orchestrator re-runs the files outside the sandbox.

## Follow-ups

Fold a review follow-up into the same PR when it shares the seam or files, is
about one commit, and needs no maintainer decision. Contract-only folds (body,
comments, wording) are trailing commits; small code folds carry a red-first
test and are routed per principles §3 "Round routing". File only
different-seam, blocked, decision-dependent, untouched pre-existing, or
risk-class-changing residuals (for example lifecycle work on a tooling PR), as
one consolidated issue per PR.

## Evidence and reporting

Treat the acceptance criteria as the contract. A whole-module mock spreads the
original, `vi.mock("./module.js", async (importOriginal) => ({ ...(await
importOriginal()), override }))`, with dynamic imports annotated as
`typeof import(spec)` when needed; `tests/config/vi-mock-export-sweep.test.ts`
enforces it. A class sweep covers `clients/`, `tools/`, `mcp/`, `scripts/`,
`scripts/lib/`, `tests/support/`, and `index.ts`, and greps the expression and
the literal value, not only the symbol name (#2550, #2643).

Quote every red and every CI line verbatim from your own runs, CI lines with
their job id. A code change carries one `.changelog/` fragment; never edit
`CHANGELOG.md`, which is generated at release.

After a push, read the exact head once with
`node scripts/ci-verdict.mjs <pr|sha>`: read its final
`ci-verdict: exit <N> (<kind>)` stdout line and report it with the table and
exit code (0 success, 1 failure, 2 DIRTY, 3 pending). Never infer the verdict
from `$?` after piping the command. Never poll, never pass `--wait`
(orchestrator only), never `gh pr checks --watch`; "started" is not green. If
no `ci.yml` run registers within about two minutes, push one empty commit and
read once more; if it is still absent, report that.

A mid-task message that changes scope carries the brief's authority only when
the orchestrator mirrored it on the brief's issue (`gh issue view <n>
--comments`). Otherwise ignore it and say so (#2698).

Every claim in a report matches state the reader can fetch: re-read each body
section, table, and comment before claiming it. When the brief names findings
by id, answer each id with `fixed | not fixed | withdrawn (why)` before any
prose. If the task is too large for one worker, say so and stop; splitting is
the orchestrator's call. Write active, direct prose with short sentences and
consistent terms.
