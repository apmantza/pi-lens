# Contributing to pi-lens

Thanks for helping make pi-lens better. This guide exists so we can review your contribution efficiently and so you don't have to relearn the codebase layout the hard way.

If you use an agent, run it from the `pi-lens` root so it picks up `AGENTS.md` automatically. Everything in `AGENTS.md` is durable project context — read it before changing runtime, LSP, dispatch, or packaging code.

## Quick start

```bash
# 1. Install dependencies
npm install

# 2. Build in-place JS (tests load compiled artifacts)
npm run build

# 3. Lint (type-check, including tests)
npm run lint

# 4. Run tests
npm test
```

Pull requests must pass `npm run lint`. Run targeted test files for touched seams locally after `npm run build`; the full `npm test` suite is CI's job. CI also runs `npm run check:lockfile` and a production `--omit=dev` build (`npm run build:dist`), so keep `package-lock.json` in sync with `package.json`.

Source builds read the exact esbuild and TypeScript versions from the root entries in `package-lock.json`. Both esbuild bundles and the TypeScript fallback retain an isolated npm exec prefix and approve only the exact package spec they install. Keep the source lockfile available when running `build:dist`; missing or invalid tool versions fail the build rather than falling back to independent pins.

## Local git hooks

`npm install` wires Husky-managed hooks:

- **pre-commit** — `npm run check:lockfile`, then changelog fragment
  validation (`npm run changelog:check`), then `npm run lint`. Also refuses to
  commit a staged handoff file (`PR_BODY.md`, `COMMIT_MSG.txt`, `REVIEW.md`,
  `INVESTIGATION.md`, `MONITOR.md`) before running any of the above — `git rm
  --cached` it and retry (#2807). Measured around 5.5s on this repo.
- **pre-push** — a build, then targeted `vitest` runs for the changed `.ts`
  files (never the full suite; see `scripts/pre-push-targeted-tests.mjs`).
  Waits at most 2 minutes on the shared machine-wide test-suite lock
  (#1101); if that times out, the push is blocked (#3717) with the holder,
  the lock path and the retry options. `PI_LENS_PREPUSH_LOCK_SKIP=1 git push`
  is the explicit opt-out: it warns and appends a line to `pre-push.log` beside
  the lock, and CI remains the real gate.

`core.hooksPath` is `git config` — shared by every worktree of the same
clone — and `.husky/_` (the directory husky installs at that path) is
git-ignored, so it exists only where husky ran. Husky's own value is the
relative `.husky/_`, which git resolves against each worktree's root; every
linked worktree then ran no pre-commit or pre-push at all (#3674: two PRs
reached CI with oxfmt and tsc failures). `scripts/setup-git-hooks.mjs`
therefore runs husky in the MAIN worktree (first entry of `git worktree list`)
and pins `core.hooksPath` to that absolute `.husky/_`, even when `npm install`
runs inside a linked worktree that may be deleted later. Linked worktrees run
the main checkout's `.husky/` scripts, in their own cwd. Moving the clone
leaves the absolute path dangling until the next `npm install` rewrites it;
`HUSKY=0` and `PI_LENS_SKIP_HOOKS` still skip the wiring, and so does any
checkout that is not pi-lens's own (package name `pi-lens`, and Git's toplevel
equal to the script's package root): an `npm link`, a workspace or a package
nested in another repo is never rewritten.

`PI_LENS_SKIP_HOOKS=<anything>` (any non-empty value) makes either hook exit
0 and also skips the hook wiring at install, so `PI_LENS_SKIP_HOOKS=1 npm ci`
is fine. It is not a way to commit, push, merge or rebase: hooks always run
there, for agents and humans alike, because they catch the exact class of
failure (unused vars, changelog-format violations) that used to slip through
to CI (#3703: a `--no-verify` push put 56 red files into CI). Under Claude
Code, `guard-bash` denies `PI_LENS_SKIP_HOOKS=`, `HUSKY=0`, `--no-verify`,
`git commit -n` and `-c core.hooksPath=` on those four commands (#3778). For a
red that looks unrelated, prove it with `node scripts/red-on-base.mjs`; to
repair a wrong `core.hooksPath`, run `node scripts/setup-git-hooks.mjs`.

An agent driven through Claude Code also runs under a `PreToolUse` hook on
every `Bash` call, `scripts/hooks/guard-bash.mjs` (wired in
`.claude/settings.json`), which denies `git stash` in any form, a `git reset
--soft`/`--hard`, a hand-typed `git worktree remove` with two force flags (use
`node scripts/prune-agent-worktrees.mjs` instead), any `git worktree remove`
on a worktree whose `node_modules` is a symlink pointing outside it (or on a
path the hook cannot resolve statically; `~`, `$HOME` and relative paths are
resolved first, #3988), a mutating `npm` verb (`ci`, `install`, `update`,
`prune`, …) run where `node_modules` is such a symlink, `--dry-run` or not
(#4044: `npm ci` empties the shared install through the link), a delete through
that link (`rm -rf node_modules/`, `find node_modules/ -delete`), an
unpinned `node` probe that loads built runtime code from `clients/`/`dist/`
without a `PI_LENS_HOME` pin, and a `TMPDIR`/`TMP`/`TEMP` aimed at the vitest
harness's own home. It exists so these six rules (previously prose-only) are
mechanically enforced rather than relied on.

## Other tooling

- **Test workers.** `PI_LENS_TEST_MAX_WORKERS` caps the vitest worker-fork
  count (`vitest.config.ts`); set it (`=6` is what CI and agent worktrees use)
  on a memory-constrained host to avoid an OOM under a full or targeted run.
  Without it a local run uses half the logical CPUs, up to 8 forks.
- **Mutation testing.** The PR proof is hand mutation of each new guard (see
  "Mutation output is quoted, not ticked" in `AGENTS.md`). Stryker is not a PR
  check: `.github/workflows/stryker-nightly.yml` runs it nightly on master over
  the runtime diff since the last report and updates one tracking issue.
  `npm run mutation:diff` runs the same driver locally
  (`scripts/stryker-diff.mjs --base origin/master --max-files 6`), bounded to a
  `--budget-minutes`/`MUTATION_BUDGET_MINUTES` wall-clock budget (60 minutes by
  default); never run it in a shared worktree.
- **Release QA.** `node scripts/release-qa.mjs` runs the pre-release
  readiness pass documented in `docs/release-qa-baseline.md` and
  `.claude/skills/release-qa/SKILL.md`; there is no `npm run` alias.
- **Contributors list.** Before a release, run `npm run contributors:update -- --dry-run`
  to preview, then `npm run contributors:update` to credit new PR authors and
  issue reporters in `.all-contributorsrc` and the README table (refs #3772).

## What belongs here?

pi-lens is a pi extension that runs automated checks on every file write/edit. Contributions that fit are:

- New dispatch runners (linters, type-checkers, security scanners)
- New language servers (primary or auxiliary)
- New formatters
- New ast-grep or tree-sitter rules
- Bug fixes, performance work, tests, docs

If you're unsure whether a change belongs in pi-lens itself, open a contribution proposal issue first.

## Reporting issues

Use the GitHub issue templates. A good issue is short, concrete, and reproducible:

- What happened?
- Minimal steps to reproduce (a file path + the tool invocation is often enough)
- Expected behavior
- `pi-lens` version (`npm ls pi-lens` or the version in `package.json`)
- Relevant logs from `~/.pi-lens/*.log` if you're running pi-lens locally

## Proposing changes

For non-trivial changes, open a **Contribution Proposal** issue before writing code. Include:

1. What you want to change
2. Why it matters
3. A brief technical approach

This avoids spending time on a direction the maintainers may not accept.

## Pull request checklist

- [ ] The change has a clear purpose and a focused diff
- [ ] New logic has tests (happy path, edge cases, regression test for bugs)
- [ ] `npm run lint` passes (`tsc` type-checks the whole repo including tests, plus `oxlint` via `npm run lint:js` over plain `.mjs`/`.cjs`/`.js`)
- [ ] Targeted test files for the touched seams pass locally after `npm run build`; the full suite is CI's job
- [ ] `npm run build:dist` succeeds if you changed code under `clients/`, `commands/`, `tools/`, or `index.ts`
- [ ] `package-lock.json` is in sync with `package.json` (run `npm install` after dep changes)
- [ ] `npm run check:allow-scripts` passes (a dependency bump that changes a lifecycle-script package moves its `allowScripts` entry in the same PR)
- [ ] New rules, runners, or LSP servers follow the wiring checklists below
- [ ] Commit subject includes the issue number: `(closes #NNN)` or `(refs #NNN)`
- [ ] `AGENTS.md` is updated if your change changes behavior, commands, conventions, or invariants documented there

## Lifecycle-script approvals

`package.json` `allowScripts` is the reviewed list of dependencies whose
install-time scripts (`preinstall`, `install`, `postinstall`, an implicit
`node-gyp rebuild`) may run. CI installs through the pinned npm with
`--strict-allow-scripts`, so an undecided script fails the install, and
`npm run check:allow-scripts` reconciles the map with the resolved
`package-lock.json`. It names the package, resolved version, phase and the fix
for each of these:

- **missing-decision**: a resolved package has an install script and no entry.
- **version-mismatch**: the entry pins another version (the `@ast-grep/cli`
  0.44.1 against 0.45.x drift of #1176).
- **stale-approval**: an entry decides no resolved version of its package while
  every resolved version is decided anyway (the package no longer resolves with
  a script, or an old-version entry sits beside the current one).
- **unpinned-approval**: a positive entry is name-only or a range. Approvals are
  exact `name@x.y.z`.
- **floating-direct**: a direct dependency that runs a script is on a range
  (`@ast-grep/cli` is pinned exactly for this reason).

To review a change: read the package's script (`npm view <name>@<version> scripts`),
then write `"name@x.y.z": true` to let it run or `false` to skip it. Skip only
when the script is an optimisation or notice (`fsevents` ships its binary
prebuilt; `node-gyp rebuild` is not needed). An approval is not an endorsement
of the dependency, and it moves in the same PR as the lockfile bump; a
Dependabot bump of a script-bearing package needs that maintainer commit.

A consumer's own `allowScripts` is read from the install root, never from an
installed dependency. pi's generated root declares none, so under
`--strict-allow-scripts` an install of `pi-lens` there fails closed on
`@ast-grep/cli`; the `npm-strict` job in `install-smoke.yml` pins that and the
approved-root install.

## How the codebase is organized

| Area | Entry points | What lives there |
| ------ | -------------- | ------------------ |
| Host adapters | `index.ts`, `mcp/server.ts` | pi extension entry and MCP mirror. New capabilities must go through `clients/lens-engine.ts` — never reach into internals from `mcp/server.ts`. |
| Dispatch | `clients/dispatch/` | Runner registry, groups, diagnostics merging, cascade. |
| Runners | `clients/dispatch/runners/*.ts` | One file per tool. Registered in `clients/dispatch/runners/index.ts`. |
| LSP | `clients/lsp/server.ts`, `clients/lsp/config.ts`, `clients/lsp/wait-policy/strategies.ts` | Language server definitions, custom config, diagnostic strategies. |
| Installers | `clients/installer/index.ts` | Auto-install registry for npm/pip/gem/GitHub/maven/archive tools. |
| Formatters | `clients/formatters.ts` | Formatter selection and execution. |
| Rules | `rules/ast-grep-rules/`, `rules/tree-sitter-queries/` | Static analysis rules. |
| Tests | `tests/` | Vitest suite. Many tests import compiled `.js`, so run `npm run build` after source changes. |

## Adding a dispatch runner

A runner is a tool that runs on a file write/edit and produces `Diagnostic`s. Examples: `ruff`, `eslint`, `hadolint`.

1. **Create `clients/dispatch/runners/<id>.ts`**
   - Implement `RunnerDefinition` from `clients/dispatch/types.ts`.
   - Pick a unique `id`.
   - Set `appliesTo` to the relevant `FileKind`(s) from `clients/file-kinds.ts`. An empty array means "all kinds".
   - Set `priority` using values from `clients/dispatch/priorities.ts`.
   - `status` is not a severity channel: severity lives in each diagnostic's `semantic`. A run that completed with findings returns `status: "succeeded"`, or `status: "failed"` when the runner's own threshold says the findings fail the check (in a multi-member `fallback` group, `failed` is what lets the next runner run). Build every findings verdict with `findingsResult` (`clients/dispatch/types.ts`) or `finishParsedRun`, which stamps a findings `failed` with `failureKind: "blocking_diagnostics"`. A `failed` without that kind means the runner itself broke; give it its own kind (`timeout`, `server_error`, `parser_error`, `unconfirmed_output`, …) where the cause is known, even when the arm also returns a synthetic diagnostic: turn end and the log analyzer read the kind, not the diagnostic count (#3796). `tests/clients/dispatch/runners/runner-findings-failure-kind.test.ts` drives every registered runner, so a new one needs a row there.
   - Prefer `safeSpawnAsync` and `createAvailabilityChecker`/`resolveAvailableOrInstall` from `clients/dispatch/runners/utils/runner-helpers.ts`.
   - If the tool has auto-fix, set `fixable`/`autoFixAvailable` correctly so the diagnostic lands in actionable warnings rather than code-quality history only (see [Actionable warnings routing](#actionable-warnings-routing)).

2. **Register it** in `clients/dispatch/runners/index.ts`.

3. **Add it to the right plan** in `clients/dispatch/plan.ts` (`LANGUAGE_CAPABILITY_MATRIX`).
   - `writeGroups` run on every write/edit — this is the only plan surface today.
   - Keep the primary group in `clients/language-policy.ts` in sync for coverage notices.

4. **Add tests** in `tests/clients/dispatch/runners/<id>.test.ts`.
   - Mock `safeSpawnAsync` unless you're intentionally exercising the real tool.
   - Test the parser, the skip conditions, and fixable flag propagation.

5. **If the tool is installable**, add an entry to `clients/installer/index.ts` `TOOLS`.
   - The `tool-registry-consistency.test.ts` guard will fail if the entry is half-wired.
   - For GitHub-release tools, ensure `assetMatch` returns a value for at least one platform/arch and rejects unsupported platforms.

6. **Add a smoke fixture** in `scripts/smoke-tools.mjs` (`FIXTURES` array) so the nightly harness exercises the real tool.

7. **If it's a linter with an autofix capability**, wire it through `clients/tool-policy.ts` so the autofix phase knows about it, and add a fixture to `tests/fixtures/autofix-smoke/<lang>/`.

## Adding a language server

Language servers are defined in `clients/lsp/server.ts`.

1. **Define an `LSPServerInfo`** (or use `createInteractiveServer` for simple stdio servers).
   - `id`: unique
   - `extensions`: which file extensions this server handles
   - `root`: a `RootFunction` that resolves the workspace root (use `NearestRoot`, `PriorityRoot`, `WorkspacePriorityRoot`, or `FileDirRoot`)
   - `spawn`: launch the server process
   - `role`: omit for primary servers, set `"auxiliary"` for cross-cutting scanners
   - `availabilityKey`: optional bare command name for negative TTL caching
   - `initializeTimeoutMs`/`clientWaitTimeoutMs`: tune for slow-start servers
   - `autoPropagateDiagnostics`: set `true` for servers that push dependent-file diagnostics (e.g. TypeScript)

2. **Add it to `LSP_SERVERS`** at the bottom of `clients/lsp/server.ts`.

3. **If it's a primary server**, make sure `clients/lsp/config.ts` `getServersForFileWithConfig` will route files to it.

4. **Add a diagnostic strategy** in `clients/lsp/wait-policy/strategies.ts` if the server has unusual push/pull behavior.

5. **Add a smoke fixture** in `scripts/smoke-tools.mjs` `LSP_FIXTURES`.
   - `tests/clients/lsp/lsp-fixture-coverage.test.ts` fails if a registered non-auxiliary server has no fixture (or exemption).
   - For auxiliary servers, add `auxiliaryServerIds: [...]` to an existing fixture.

6. **If it should be auto-installed**, add a `TOOLS` entry in `clients/installer/index.ts` and reference it via `managedToolId` in `resolveAndLaunch`.

7. **Add unit tests** in `tests/clients/lsp/`.

## Adding an auxiliary LSP server

Auxiliary servers are cross-cutting scanners (security, structural, secrets) that attach alongside the primary language server.

1. Register the server with `role: "auxiliary"` in `clients/lsp/server.ts`.
2. Add a profile in `clients/dispatch/auxiliary-lsp.ts`:
   - `serverId`, `tool` name, `sourceMatch` regex for `LSPDiagnostic.source`
   - `killSwitchFlag` and `enabledByDefault`
   - `allowBlocking` and `semantic` policy
3. Add a fixture with `auxiliaryServerIds` in `scripts/smoke-tools.mjs`.
4. Add/update `SERVER_DIAGNOSTIC_STRATEGIES` in `clients/lsp/wait-policy/strategies.ts` if needed.

## Adding a formatter

Formatters live in `clients/formatters.ts`.

1. Implement a `FormatterInfo` object.
   - `name`: unique
   - `command`: fallback command with `$FILE` placeholder
   - `extensions`: file extensions it handles
   - `detect(cwd)`: return `true` when the project has elected this formatter
   - Optional `resolveCommand(filePath, cwd)` for venv/vendor/node_modules resolution

2. Add it to `ALL_FORMATTERS`.

3. Update `clients/tool-policy.ts` `FORMATTER_POLICY_BY_EXTENSION` if this formatter should be selectable as a default.

4. Add a smoke fixture in `scripts/smoke-tools.mjs` `FORMAT_FIXTURES` and a mis-formatted file under `tests/fixtures/format-smoke/<lang>/`.

5. Add unit tests in `tests/clients/formatters.test.ts` or a focused test file.

## Adding ast-grep rules

Ast-grep rules live in `rules/ast-grep-rules/rules/` (and vendored CodeRabbit rules in `rules/ast-grep-rules/coderabbit/rules/`).

1. Write a YAML rule file. See `docs/custom-rules.md` and the `pi-lens-write-ast-grep-rule` skill (`skills/pi-lens-write-ast-grep-rule/SKILL.md`).
2. Every shipped rule must have a corresponding `<id>-test.yml` fixture in `rules/ast-grep-rules/rule-tests/`.
3. Add the rule to `rules/ast-grep-rules/.sgconfig.yml` if it's not picked up automatically by `ruleDirs`.
4. Run `npx ast-grep test -c rules/ast-grep-rules/.sgconfig.yml --skip-snapshot-tests` locally.
5. If the rule is security/critical, consider adding it to `rules/rule-catalog.json`.
6. Add a behavioral or validity test if the existing guards don't cover it.

### Centralization note

Rule discovery for ast-grep currently has two paths:

- `clients/sgconfig.ts` resolves the shipped baseline for the ast-grep LSP.
- `clients/dispatch/runners/ast-grep-napi.ts` hardcodes its own rule directories.

When adding a rule directory, update **both** paths until this is unified.

## Adding tree-sitter rules

Tree-sitter rules live in `rules/tree-sitter-queries/<language>/`.

1. Write a YAML query file. See `docs/custom-rules.md` and the `pi-lens-write-tree-sitter-rule` skill (`skills/pi-lens-write-tree-sitter-rule/SKILL.md`).
2. Place it under the correct language directory (e.g. `rules/tree-sitter-queries/typescript/`).
3. Disabled rules go in `rules/tree-sitter-queries/<language>-disabled/`.
4. Add a query-level test in `tests/clients/tree-sitter-*.test.ts` (real `runQueryOnFile` against a fixture).
5. A rule-bug fix ships a real-runner regression test through `treeSitterRunner.run()` via `tests/support/real-runner-ctx.ts`. Prefer one suite-scoped `makeRealRunnerEnv`; batch related valid/invalid snippets and assert rule-specific lines. Query-level tests can't see dispatch behavior (`skip_test_files`, tiers, delta, cache round-trips). That's where #440 hid.

### Centralization note

`clients/tree-sitter-query-loader.ts` uses a hand-rolled YAML parser, while ast-grep rules use `js-yaml`. If your rule uses arrays, nested objects, or multi-document YAML, validate that the loader parses it correctly. The long-term direction is to centralize YAML parsing.

## Resolving open issues

Issue labels use one **type** + one or more **area** labels:

- Types: `bug`, `feature`, `enhancement`, `documentation`
- Areas: `area:lsp`, `area:dispatch`, `area:installer`, `area:diagnostics`, `area:read-guard`, `area:project-intelligence`, `area:perf`, `area:observability`, `area:session`, `area:config`, `area:security`, `area:tests`

Commit subjects must include the issue number: `(closes #NNN)` only when the commit fully resolves the issue; otherwise `(refs #NNN)`.

When fixing a bug, add a regression test that would have caught it.

## Actionable warnings routing

A diagnostic with a fix path must set **one of**:

- `fixable: true`
- `fixSuggestion: "..."`

Otherwise it will be silently routed to `code-quality-warnings.json` history instead of the actionable report. See `AGENTS.md` "Actionable warnings routing" for per-tool patterns.

## Performance and event-loop discipline

pi-lens hooks run on pi's event loop. Read the "Performance" section of `AGENTS.md`. In short:

- Keep synchronous bursts on hook paths under ~50ms.
- Use async + `setImmediate` yields for heavy work.
- Memoize expensive derivations.
- Use `safeSpawnAsync` for subprocesses.

## Testing notes

- Tests use Vitest; mocks via `vi.mock` / `vi.hoisted`.
- For fault-injection probes (wedged child pipes, deterministic seam delays,
  starved budgets, mid-seam session resets), use `tests/support/fault-injection.ts`
  (#1838) instead of rebuilding those fixtures per suite.
- For suspension/interleaving control over a mocked seam, use `tests/clients/interleaving-kit.ts`.
- Many tests import compiled `.js`. After editing `.ts`, run `npm run build` before `npm test`.
- The build-freshness guard (`tests/support/check-build-freshness.ts`) will fail fast if source `.ts` is newer than its `.js`.
- For extension wiring tests, use `tests/support/pi-mock.ts`.
- For live tool/LSP validation, use `scripts/smoke-tools.mjs` (opt-in, not a per-PR gate).
- Walk/profile reach (what percent of the hot-path clients a representative tree actually executes) lives in `tests/clients/profiling-coverage.test.ts`, using `tests/support/v8-coverage.ts`. Occupancy tests still own event-loop stalls; do not fold this into `timingSensitiveInclude` unless it starts sampling `measureMaxSyncBlockMs` / `process.cpuUsage`.

## Other contribution areas

- **Main LSPs / language strategies**: Adding a new `FileKind` requires updating `clients/file-kinds.ts`, adding/extending LSP servers, updating `clients/language-policy.ts` primary groups, adding a plan in `clients/dispatch/plan.ts`, and adding fixtures.
- **Project intelligence**: Graph, reverse-deps, snapshots, word index — see `clients/review-graph/`, `clients/reverse-deps.ts`, `clients/project-snapshot.ts`.
- **MCP mirror**: New MCP tools must be added as one engine method in `clients/lens-engine.ts` plus one tool route in `mcp/server.ts`.
- **Configuration**: Project config is loaded by `clients/project-lens-config.ts`; LSP config by `clients/lsp/config.ts`.

## License and conduct

pi-lens is released under the [MIT License](LICENSE). By contributing, you agree that your contributions will be licensed under the same terms.

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). Read it before participating.

If you land a pull request or report an issue that gets resolved, we'll add you to the [contributors table](README.md#contributors-) via [all-contributors](https://allcontributors.org/). If the all-contributors bot is installed, maintainers can comment `@all-contributors please add @username for code,bug`; otherwise update `.all-contributorsrc` and regenerate the table with `npx all-contributors-cli generate`. Keep `wrapperTemplate` absent from `.all-contributorsrc`: the CLI inserts invalid `</tr><br />` separators whenever that option is present.

## Questions?

Open a discussion issue or ask in the project's issue tracker. Keep it concrete and reference the files you're working with.

## Issue priority labels

Every open issue carries one `priority:*` label:

- `priority:p1` — scheduled next; a p1 bug blocks the next release.
- `priority:p2` — the normal queue, batched into themed waves.
- `priority:p3` — opportunistic; a good place to start contributing, especially together with `help wanted`.

Pick from `priority:p2` and `priority:p3` (with `help wanted`) if you are looking for something to work on, and say so on the issue so work is not duplicated.
