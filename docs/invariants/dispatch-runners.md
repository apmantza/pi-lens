<important if="touching dispatch, runners, formatters, and installers rules">

### Dispatch, runners, formatters, and installers

- The analysed-state latch records a pipeline-owned target hash captured after
  pi-lens writes and before LSP or dispatch awaits. `fileModified` also covers
  side-effect files, so `postWriteStateHash` is the ownership discriminator;
  an absent hash must not stamp the target with later disk bytes (#2499).
- The opaque prescan resolves its root once, through `opaquePrescanRoot`
  (`clients/opaque-mutation-scan.ts`), and every consumer of that session root
  asks the same owner: the baseline record and take, the head-move record and
  take, and the root each held-primary send is scoped by. A
  session whose cwd is not the coordinator's `projectRoot` — a concurrent
  secondary session, which the host's session-start guard declines before any
  `session_start` body runs — otherwise records its baseline and its HEAD under
  one root and takes them under another, reporting `no-pending-snapshot` for a
  command that did write. Scan evidence is scoped to the checkout it ran in: a
  recognized write outside that root is kept (never cleared by a scan that
  could not see it) and earns no authorship the scan cannot confirm.
- A bash command's writes are recovered from that session root AND from every
  checkout the command ITSELF names — its `cd`/`pushd` target or a recognised
  write operand — when that checkout is a linked worktree of the session's own
  repository (`resolveOpaqueRecoveryRoots`, `sameCheckoutOtherRoot`). Both hooks
  derive bounded root lists (`OPAQUE_RECOVERY_ROOT_CAP`) from the command text,
  the session root, and the checkout each hook sees at its own instant, so a
  worktree the command itself creates is admitted only at `tool_result` and its
  missing baseline is reported as `partial-recognition-no-baseline`, while a
  root both hooks admit still names one key for its record and its take; a
  checkout of another repository, a checkout named past the cap, and a
  git target under a non-checkout session root each leave one bounded
  `opaque-recovery-root-refused` record per session. This is why a `cd` into a
  sibling worktree no longer reads a clean `git status` in the wrong checkout as
  "nothing changed". Relative operands resolve against the directory in effect
  for their own segment (`scanShellWriteScopes`). That directory moves only for
  an admitted form: `cd DIR` or `pushd DIR` whose one operand is a plain
  path: bash's own word after quote removal, made only of admitted characters
  (any quoted one, an escape bash also removes, an unquoted letter, digit or
  `_./@%:,=+-`, and a leading `~` only as `~` or `~/`), starting with a
  letter, digit, `_`, `.`, `/` or `~`; or a bare `popd` of a push the scan
  admitted, entered at list start or after `&&`, `;`, a newline
  or a backgrounded list, ended by `&&`, `;`, a newline or the end, and in no
  pipeline or backgrounded list. A move entered after `&&` holds only to the end
  of that `&&` chain, because it happened only if the left side succeeded. A
  directory builtin in a pipeline or a backgrounded list leaves the directory
  unchanged. Any other directory change, construct or shell-text builtin
  returns the scan to the session root for the rest of the command.
- A recovered write is judged by the checkout that OWNS it, in both directions:
  the ignore gate a synthetic bash-write dispatch passes asks the `.gitignore`
  of the root that admitted the write (`_ownerRoot`), not the session root's, so
  a linked worktree nested under a directory the session checkout ignores is
  analysed instead of dropped silently (`.claude/worktrees/` in this
  repository); and admission asks `analysis-root.ts`
  (`canWriteAnalysisRoot(resolveAnalysisRoot(...))`) rather than re-deriving the
  rule. Ownership is compared by REAL path, so a `cd` into a symlinked spelling
  of a worktree keeps its authorship and its observed identity.
- `RUNNERS` declarations include file kinds. Runner selection is gated by file
  kind and anchored at the file's language root, not by dispatch-root config or
  declaration order. Runner children use `resolveToolCwd` with launcher markers.
- Automatic tests do not cross a Git checkout boundary, including through
  filesystem aliases: `foreignGitRoot` (`clients/test-runner-client.ts`) gates
  failed-first cache admission, retirement, every discovery path, and the
  turn-end gate. Indeterminate ownership is not a foreign verdict, a deleted
  target retires as `retired-missing`, and final rejections emit
  `test-target-foreign-checkout`. Proven by
  `tests/clients/test-runner-worktree-isolation.test.ts`.
- By design, a session whose cwd is a plain folder with no `.git` that holds several repositories, a submodule, or a nested linked worktree gets no automatic tests for the files inside them: any nested `.git` is a foreign checkout, and there is no per-project opt-in (maintainer decision, #3649/#3691). Run them explicitly.
- The one exception to that boundary is a linked worktree of the session's own repository (same git commondir, different top level, `resolveLinkedWorktreeOwner` in `clients/review-graph/git-identity.ts`, #3871): turn_end selects and runs its tests with that worktree's root as the project root (`clients/test-target-roots.ts`), so config, `node_modules` and the failed-first state are the worktree's own. A worktree root without its own runner install (no `node_modules/.bin`, venv or `vendor/bin`) is skipped with a counted `turn-end-test-root-skipped` row rather than run through `npx` or a bare interpreter; a reported location is rebased through `displayRoot` using the runner cwd first, then the dispatch root, only when that file exists, and otherwise remains as printed. A sibling worktree's file is still foreign to every other root. Python's ambient `VIRTUAL_ENV`, `CONDA_PREFIX`, or absolute `UV_PROJECT_ENVIRONMENT` is accepted for the session checkout, and for a linked worktree only when the environment root is inside that checkout; a skipped pytest row says that ambient environments were not borrowed when one is set. The edit worklist is the session's project worklist (#2504), so a session whose cwd is itself a linked worktree never sees an edit in the main checkout or a sibling and runs only its own tests. Each turn that edited files writes one `turn_end_test_selection` record to `latency.log` (candidates, selected, why not, and selected/candidates per owning root; first 8 roots, the rest in `rootsOmitted`; `selected` includes carried deferred targets, which no candidate bucket counts, so per-root `selected` can sum below it; one row of about 570 B per edit turn with candidates, bounded by log rotation only), so a turn with 0 tests is explained without the dbg lines the MCP route drops.
- Managed tools resolve through the registry and sanctioned availability seams.
  Do not hand-roll install, PATH, or package-manager discovery. Use typed
  `SpawnFailure.kind`; repair only `tool-not-found`.
- Windows LSP startup exit-code-1 failures are repairable only when the shared
  command resolver finds no command or an npm shim target is absent; present
  binaries that exit 1 remain runtime failures (#4263, #1199). The launch and
  repair gate are pinned by `tests/clients/lsp/windows-startup-repair.test.ts`.
- Expected skips remain distinct from clean success and failure. Extend the
  closed `RUNNER_SKIP_REASONS` taxonomy when policy intentionally defers work.
  Preserve the skip reason through runner latency and model-facing delivery.
- `scripts/ci-verdict.mjs` ends every CLI path with `ci-verdict: exit <N> (<kind>)`;
  read that final stdout line instead of `$?` after a pipe. `guard-bash` denies
  the piped-status recurrence while allowing output-only pipes.
- A formatter is handed the file's identity, never the link that named it:
  `realpathOrResolve` (`clients/path-utils.ts`) is the real path
  of the nearest existing ancestor plus the missing tail, with no lexical `..`
  collapse first. `formatFile` and `FormatService.formatFile` use it, so
  `AGENTS.md -> CLAUDE.md` formats `CLAUDE.md` and Prettier's "is a symbolic
  link" rejection never occurs. `FormatService.formatFile` also requires
  `sessionRoot` and classifies the identity through `resolveAnalysisRoot`: an
  `adopted` or `none` identity is refused, writes nothing, and records one
  `adopted-root-writer-skipped` row (`writer: "format"`). The refusal is on
  identity, not spelling, so a plain file outside every writable root (a
  sibling package of a monorepo session cwd, say) is refused as well; a caller
  that must format it passes that root as `sessionRoot`. Proven by
  `tests/clients/format-service-symlink-identity.test.ts`.
- Every other writer of source files takes the same two seams from
  `clients/write-source-file.ts` (#5417). `refuseOutOfRootWrites` is the root
  guard: `ast_grep_replace` (the files its dry run matched, plus the
  `no-autofix` flag), `applyWorkspaceEdit` and `lens_diagnostic_mark` refuse an
  `adopted` or `none` identity, write nothing and record one
  `adopted-root-writer-skipped` row per (file, writer). `writeSourceFile` runs
  the writer inside pi's per-file mutation queue and calls its authorship
  record on every exit, a throw included, so an interrupted write records the
  files it reached. A fixer's write result is `resolveWriteResult`
  (`clients/file-utils.ts`): `changed` is the bytes, `success` is the exit code,
  and a nonzero exit that rewrote the file is still a change. Proven by
  `tests/clients/write-source-file-5417.test.ts` and
  `tests/clients/autofix-exit-status-5417.test.ts`.
- Formatter and autofix policy is config-first where the registry says so.
  Formatting is strict by default. Autofix must carry per-diagnostic fixability
  or a conservative capability allowlist.
- Analyzer and runner fallback filters must match the substituted surface's
  contract. Empty output distinguishes clean, skipped, unavailable, errored,
  inconclusive, and partial states.
- Every autonomous writer (pipeline autofix, immediate/deferred formatter, and
  actionable-warning quickfix) resolves through `clients/tool-agreement.ts`.
  Its declarative population assigns one evidence bucket and declines absent,
  unreadable, unparseable, unsupported, or unregistered evidence; callers emit
  bounded degradation records. Ktlint's standalone-CLI exception still
  declines Gradle-owned projects without guessing a CLI version.
- Node tool agreement in `nodeAgreement` is established from the project's lockfile evidence in the deterministic order npm (`package-lock.json`) → pnpm (`pnpm-lock.yaml`, v9 `importers` and v6 top-level maps) → yarn (`yarn.lock`, v1 blocks and Berry `npm:` descriptors); the decision names the supplying lockfile, and missing, unreadable, unparseable, or shape-unsupported evidence declines.
- A whole-package fixer (`cargo clippy --fix`, `dart fix --apply`) rewrites
  files pi's mutation queue does not hold, so it runs through
  `runWithFixRestore` (`clients/fix-run-restore.ts`, #3598): hash the tool's
  source files, capture agent mutations pi-lens observes during the run (the
  tool_result seam and the mutation bridge), write them back after, one
  degradation per run, and name any edit that cannot be restored. The restore
  takes pi's queue entry for each sibling, one at a time (#3830). It starts
  after the caller's scan of the tool's changes and is awaited only after the
  target's hold is released, never inside it. The tool_result pipeline does not
  await it (F's result must not wait on a sibling's holder; the loss notice is
  queued as an advisory), the `agent_end` drain does, after the release: a queue entry is requested by something that holds no other
  entry, except the multi-path LSP edit, which requests in ascending key order,
  and nothing that holds an entry awaits the restore. Do not add a second
  whole-package fixer without it, and do not await a queue entry while holding
  another.
- A file's first write in a session blocks on the linter delta, not on every
  linter error. The `tool_call` of the first classified write or edit
  runs the file's inline linters (`PRE_EDIT_SEED_RUNNER_IDS`, tied to the
  edit-scope census's LINTER lanes) over the bytes still on disk, under
  `bounded()` with `PRE_EDIT_CAPTURE_BUDGET_MS` (500 ms), and installs their blocking
  findings as `session.preEdit.<file>` beside the delta baseline. The capture
  admits at most four active captures, aborts their process groups on abandonment
  or session reset, and retains slots until teardown settles. It
  only creates that record, and only while no baseline, tombstone or seed
  exists, the bytes are the ones it read, and its session is current; each
  dispatch only shrinks it (`classifyPreExisting`, identity plus line text,
  one current finding per entry). A matched finding is reported as
  pre-existing, never as a blocker, unless the inline record already holds
  it. Language servers, type checkers, gated runners and scanners are never
  seeded (maintainer scope, 2026-10-15). Collect-later linters and the MCP
  route have no seed. Proven by
  `tests/index-4483-first-write-seed-witness.test.ts`.
- `clients/dispatch/runners/runner-spawn-cwd-sweep.test.ts` is the population
  guard for child cwd derivation. Add a reasoned migration row instead of a
  pin-only update.
- Each real-bytes fixture under `tests/fixtures/runner-output/` records the
  availability probe its runner sends (`availability`: the argv, the binary
  that answered from its own banner, and the real exit status) and a real clean
  run (`clean`; there is no prose alternative). The clean record is the
  fixture's own invocation run in `tests/fixtures/runner-output-clean/<runner>`,
  whose inputs are un-ignored by `.gitignore` on purpose. One gate,
  `recordProblems` in `scripts/capture-runner-output.mjs`, refuses a record whose
  version its own answer never printed, and a clean run whose argv is not this
  fixture's; the capture and the census both call it.
  `captured-real-output.test.ts` runs the REAL checker against that record
  instead of mocking it, so a tool that rejects its own probe — helm 4 rejects
  `--version` — reaches the replay; the clean bytes are what the matrix's clean
  cell replays, in the clean workspace. `scripts/capture-runner-fixtures.mjs
  --records-only` retrofits those records onto an existing fixture without
  touching its work bytes, keyed on the fixture's own case.
  Enforced by `tests/clients/dispatch/smoke-fixture-coverage.test.ts` and
  `tests/clients/dispatch/tool-state-matrix.test.ts`.
- Every `parseToolRun` runner documents its nonzero-exit table; the documented
  `ran` codes are pinned exactly so adding or removing one does not pass
  silently, and each documented code needs an executable status fixture in the
  runner's own test matrix (#3292).

</important>
