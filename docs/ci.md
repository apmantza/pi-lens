# CI workflows, gates and caches

The CI facts an agent needs when it edits a workflow, a required check, a cache
or a CI-facing script. `AGENTS.md` "Commands and gates" keeps the commands and
the rules an agent obeys, and points here for the rest. Where a paragraph names
a test, that test is its enforcer. Bot-opened pull requests are in
`docs/ci-bot-pr-checks.md`.

## Jobs and required contexts

The seven advisory lint tools are steps of one `Lint (advisory)` job, and the PR
title and close-keyword checks are steps of one gating `PR metadata` job.
`actionlint` and `markdownlint` share one gating `actionlint & markdownlint` job,
and the required `Lint & type-check` also runs `depcruise:check`.
`ci-infra-kill-rerun.yml` has no `pull_request` trigger, so its jobs post no
skipped rows on a PR; the label cleanup lives in `ci-verdict-labels.yml`.

CI cost gates (#3801). ci.yml has no heavy-advisory gate: its `heavy-gate` job
and ci-verdict's deferred-row list are retired (an older head's
`Heavy advisory gate (advisory)` row still classifies as advisory by its
suffix and never gates). CodeQL runs only in `codeql.yml`, once a day on a
schedule and on dispatch, with no master-push or pull-request run, so a new
alert surfaces on master up to a day after its change, not on its PR. A
docs-only pull request (root `*.md`, `docs/**`, `.changelog/**` and
nothing else, classified by `scripts/ci-changed-files.mjs`; every doubt runs the
full suite) skips no test job: the Unit shards and every
other test job always run, because a docs edit can red tests outside tests/config
(`docs/public-api-stability.md`, `docs/*_rules_catalog.md`). The one exception
is the three `Install test` legs: outside `INSTALL_PATHS` in that script
they report success without installing, and the macOS APFS step runs on
non-pull_request events only. `Strict install (cold npm cache) (fast-fail)` is
its own workflow, `strict-install.yml` (#5002), triggered by a push to `master`
and `workflow_dispatch` and by nothing else: no `pull_request`, so a pull
request shows no skipped row for it, and no `merge_group`, so the merge queue and
the bot-PR dispatch of `ci.yml` (docs/ci-bot-pr-checks.md) do not run it. A
pull request that changes the manifests still gets a strict install through
`install-smoke.yml`'s `npm-strict`. ci-verdict reads the row as a non-required,
non-advisory row: absent on a pull request, and a manual dispatch on a branch
reads as advisory unless the PR author is a bot (#4090, #5062).

On a pull request, `TLA+ models`
model-checks only when `formal/` (or its checker or ci.yml) changed: its shards
skip at job level and the aggregate still reports. Push and merge-queue runs
always model-check (`changes` sets `formal=true` for every non-PR event). A REQUIRED job never skips at
job level: ci-verdict and the merge train demand a literal `success`. Implicit
`success()` reads every ancestor, so a job behind a skippable ancestor skips even
when its direct needs are green.

Master requires the ten contexts in `BRANCH_PROTECTION_CONTEXTS`
(`scripts/lib/ci-checks.mjs`). ci-verdict reads the live list, and it also gates
every other non-advisory row a run posts.

## The Windows unit leg

The Windows unit leg (`Unit tests Windows`, job key `unit-tests-windows`) GATES
by maintainer decision on 2026-10-17: it runs the real `win32` gates, and
advisory reds were waved through (the incidents are in `HISTORY.md`). It
therefore starts on every event like the Unit shards and never skips at job
level. Its name
carries no `(advisory)` suffix, and it is a required context on master. Its
population is every
`tests/config/*` file, every `process.platform` Windows gate, and the
shrink-only `WINDOWS_LANE_ADMISSIONS` rows
(`scripts/lib/win32-gate-population.mjs`); a failed or under-executed subset
reds the job, and no step of it is `continue-on-error`. The tmp-fixture
hygiene census asserts on every lane, `win32` included, and its teardown
prints `verdict=asserted`. A census a lane declines still leaves a record:
it prints `verdict=declined`, so a quarantine shows in the log.

## Smoke paths and shard weights

The same script's `smoke` output (`PR_SMOKE_PATHS`: RPC, install, LSP launch,
trust) makes `install-smoke.yml` run all four pi-load cells and an advisory LSP
handshake job on a pull request; any other PR that reaches that workflow keeps
the one pnpm-global cell (`tests/config/pr-smoke-paths.test.ts`).
The Unit shards are packed by the per-file seconds in
`scripts/test-shard-weights.json`; regenerate it when
`tests/config/test-shard-assignment.test.ts` reds, or when new tests leave
files unknown, with `node scripts/gen-test-shard-weights.mjs` from either the
shards' uploaded `vitest-results.json` (`--run <dir>`) or the nightly journal
(`--journal <file> [--days 5]`, no GitHub API: `git fetch <remote>
data/test-history`, then `git show FETCH_HEAD:history/test-daily.ndjson`).
Prefer `--run` over the newest 10 or more green master pushes: the journal's
five-day median held a regressed file (`tool-state-matrix`, 302 s against 60 s
once fixed) for days after its fix and left shard max-minus-mean at 62 s p50
(#3801, 15 runs of 2026-11-13); the refresh models 16 s.

## Actions cache

Actions cache. The repository cache is capped at 10 GB. The nightly
smoke workflows restore the managed tool tree through
`.github/actions/tool-tree-cache`, keyed on the hash of
`clients/installer/index.ts` (every pin) plus the ISO week; a pin that moves out
of that file moves the action's `hashFiles` target in the same change
(`tests/config/tool-tree-cache-workflow.test.ts`). A smoke saves its tree once
its last install step ran, red or green, because the key is first-wins per week.
`cache-prune.yml` runs `scripts/prune-actions-cache.mjs` nightly and when the
`CodeQL` workflow completes on master (its overlay base database is ~785 MB per
run, and the nightly run starts hours late), so a closed pull request's
caches and superseded copies never fill the cap; only its `prune` job holds
`actions: write` and passes `--apply`
(`tests/config/cache-prune-workflow.test.ts`).
A workflow that `pull_request_target` or `workflow_run` starts never restores
or saves a cache, so a pull request cannot poison what a privileged run
restores (`tests/config/untrusted-trigger-cache.test.ts`).

## Workflow jobs no pull request runs

A workflow job no pull request can run needs a registered reason in
`tests/config/workflow-pull-request-reachability.test.ts`, and the branch run
(`gh workflow run <file> --ref <branch>`) quoted with its run id (#3043). The
same quote is enforced per file for an edit to any workflow whose post-image no
`pull_request` run executes (no trigger, `pull_request_target` only, or a
filter that excludes the file): `scripts/check-pr-body.mjs` reds the body
without it. `Workflow run unaffected: <file> — <reason>` clears the rule only
for a workflow with no `workflow_dispatch` trigger or an edit of comments and
blank lines, verified against the merge base (#3085). The run id is quoted
evidence, not verified provenance.

## Heavy-advisory census pins

For `tests/config/heavy-advisory-gate-workflow.test.ts`, set
`PI_LENS_PRINT_PINS=1` to print the current parsed census pins as pasteable
assertion lines after workflow edits; the assertions remain shrink-only pins.

## Pre-push and the stale-build guard

The stale-build guard rejects a missing or older compiled twin. Pre-push and
`lane:check` also rebuild the bounded `dist/` dependency population before
governance suites when a bundled file is missing or older than its source.
Pre-push diffs each pushed ref against `origin/master`, or `upstream/master`
when that has commits `origin/master` lacks, and
skips a head whose tree-bound record already passed the same selection. When
that base range cannot be resolved it falls back to the remote-tip
range, and to the loud build-only pass only when that cannot resolve either.
Pre-push fails
when its bounded test-lock wait times out (#3717); `PI_LENS_PREPUSH_LOCK_SKIP=1`
is the only lock opt-out and is logged to `pre-push.log`. CI stays the gate.
