# Delegated worker delivery contract

Read first: the engineering principles (`docs/engineering-principles.md`; skip
it when your harness's global instructions already carry the verbatim copy),
then `AGENTS.md`, then this contract, then exactly one role contract from
`docs/pi-lens-{fixer,reviewer,investigator,monitor,warden,retro}.md`. This file
holds the pi-lens rules every role shares, for every runner and model. The
principles apply throughout and are not restated; project files win on
conflict.

## Worktree and Git

Work only in the assigned worktree. Before editing, verify its absolute path,
registered `git worktree list` entry, branch, and base. Preserve linked or
junctioned dependencies. Never switch another checkout's branch, never pass the
main checkout's path as `repoRoot` or `cwd` to a probe that writes or deletes
(#2704), and never use `git stash`. Save a patch before temporarily reverting
uncommitted work.

A lane never writes files to the shared session scratchpad: lanes spawned from
one session share it and overwrite each other's fixed names (#3850). Probe
scripts, PR bodies, and TLC logs go under `$TMPDIR`
(`~/.local/share/pi-lens-orchestrator/tmp/<lane>`) or
`<worktree>/../probes-<lane>`.

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

Until plegma #474 lands, push with `git -c credential.helper= -c
credential.helper='!gh auth git-credential' push origin HEAD:refs/heads/<branch>`.
Before `gh pr create` or `gh pr edit`, lint the body with
`node scripts/check-pr-body.mjs --lint-local <body-file> "<title>"`. Multiline
text (bodies, commit messages, comments) goes through a file (`--body-file`,
`git commit -F`); re-read what GitHub stored and check the newlines survived.

## Tests and probes

Every Vitest invocation on the maintainer host exports
`PI_LENS_TEST_MAX_WORKERS=6` and
`TMPDIR=~/.local/share/pi-lens-orchestrator/tmp/<lane>` (scratch goes in a
private subdirectory) and names its files. The full suite is CI's job. Run up
to about 15 files with `npx vitest run <files>` in the foreground with an
explicit timeout; run the governance batch through
`npm run test:targeted -- <files>` (one of two machine-wide slots), also in
the foreground.

Select governance suites mechanically, never from memory (#2107, #2438, #2470,
#2511):
`ls tests/clients/*{sweep,ratchet,conformance,coverage,gate,governance,silence,hermeticity,invariant,contract}*.test.ts`
plus every `tests/config/*.test.ts`. Quote the file count you ran.
`tests/config/glossary-synonym-sweep.test.ts` pins the retired-synonym
identifier population per (term, file) in both directions (#3279): when a
change adds or removes a pinned use, run it on the head and on the merge of
`origin/master` and the head before pushing, and re-pin in the same PR from its
`UNPINNED`/`STALE` output (#3284, #3288).

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
