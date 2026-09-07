# Delegated worker delivery contract

This contract applies to every delegated pi-lens worker, regardless of the
agent runner or model. Pair it with exactly one role contract: fixer, reviewer,
or investigator.

Work only in the assigned worktree. Before editing, verify its absolute path,
registered worktree entry, branch, and base. Preserve junctioned dependencies.
Never switch another checkout's branch, and never use `git stash`. Save a patch
before temporarily reverting work.

Treat the acceptance criteria as the contract. For a regression, prove the new
test red before the fix and green after it. Mutating or removing a new guard
must make at least one test fail. Sweep the whole tree for the same code pattern
and every member of any enumerable population. Record both sweeps.

State the blast radius, including callers, durable shapes, strict parsers, and
tool surfaces. Add bounded observability for every new failure path. Include the
required changelog fragment for a code change. Report verification honestly.
Write active, direct prose with short sentences and consistent terms.

## Tautological tests considered harmful

A test must observe behavior through the real seam, not repeat the implementation
or feed the expected answer in through setup. Keep the red-first failure tied to
the defect, and mutate the guard or filter to prove the test can detect its loss.
Mocks belong only at true process or host boundaries. When a test can use the
real store, sink, coordinator, or registry, use it and assert the durable result.

Git authority is separate from the role. Commit, push, or open a PR only when
the delegation explicitly grants that authority after worktree verification.
Otherwise, edit and test with the assigned worktree as the command working
directory, leave every change uncommitted, and write two handoff files at the
worktree root: `PR_BODY.md` (the full PR body, transcripts pasted) and
`COMMIT_MSG.txt` (subject, body, issue ref, trailers). Name any path inside the
worktree that must not be committed. The orchestrator commits from those files;
they are never committed themselves. Never merge.

A sandboxed worker may find the shared `.git` and the linked `node_modules`
read-only and the network absent (the codex `workspace-write` sandbox does
this; see plegma#311). Run Vitest as
`node_modules/.bin/vitest run <files> --configLoader runner`, and if the
tree-sitter grammar prefetch hangs offline, verify through direct probes of the
built code and say so; the orchestrator re-runs the files outside the sandbox.

When Git authority is granted, use one logical commit with an imperative,
conventional-prefix subject of at most 50 characters, a blank line, and a
72-column body that states what and why. Reference the issue. Open a PR, do not
merge it, and report its URL.
