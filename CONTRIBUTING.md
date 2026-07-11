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

Pull requests must pass `npm run lint` and `npm test`. CI also runs `npm run check:lockfile` and a production `--omit=dev` build (`npm run build:dist`), so keep `package-lock.json` in sync with `package.json`.

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
- [ ] `npm run lint` passes (`tsc` type-checks the whole repo including tests)
- [ ] `npm test` passes
- [ ] `npm run build:dist` succeeds if you changed code under `clients/`, `commands/`, `tools/`, or `index.ts`
- [ ] `package-lock.json` is in sync with `package.json` (run `npm install` after dep changes)
- [ ] New rules, runners, or LSP servers follow the wiring checklists below
- [ ] Commit subject includes the issue number: `(closes #NNN)` or `(refs #NNN)`
- [ ] `AGENTS.md` is updated if your change changes behavior, commands, conventions, or invariants documented there

## How the codebase is organized

| Area | Entry points | What lives there |
|------|--------------|------------------|
| Host adapters | `index.ts`, `mcp/server.ts` | pi extension entry and MCP mirror. New capabilities must go through `clients/lens-engine.ts` — never reach into internals from `mcp/server.ts`. |
| Dispatch | `clients/dispatch/` | Runner registry, groups, diagnostics merging, cascade. |
| Runners | `clients/dispatch/runners/*.ts` | One file per tool. Registered in `clients/dispatch/runners/index.ts`. |
| LSP | `clients/lsp/server.ts`, `clients/lsp/config.ts`, `clients/lsp/server-strategies.ts` | Language server definitions, custom config, diagnostic strategies. |
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
   - Return `status: "succeeded"` with diagnostics (even for findings), or `status: "failed"` only when the runner itself broke. Use `failureKind` to distinguish real crashes from "found blocking diagnostics".
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

4. **Add a diagnostic strategy** in `clients/lsp/server-strategies.ts` if the server has unusual push/pull behavior.

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
4. Add/update `SERVER_DIAGNOSTIC_STRATEGIES` in `clients/lsp/server-strategies.ts` if needed.

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
4. Add a test in `tests/clients/tree-sitter-*.test.ts`.

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
- Many tests import compiled `.js`. After editing `.ts`, run `npm run build` before `npm test`.
- The build-freshness guard (`tests/support/check-build-freshness.ts`) will fail fast if source `.ts` is newer than its `.js`.
- For extension wiring tests, use `tests/support/pi-mock.ts`.
- For live tool/LSP validation, use `scripts/smoke-tools.mjs` (opt-in, not a per-PR gate).

## Other contribution areas

- **Main LSPs / language strategies**: Adding a new `FileKind` requires updating `clients/file-kinds.ts`, adding/extending LSP servers, updating `clients/language-policy.ts` primary groups, adding a plan in `clients/dispatch/plan.ts`, and adding fixtures.
- **Project intelligence**: Graph, reverse-deps, snapshots, word index — see `clients/review-graph/`, `clients/reverse-deps.ts`, `clients/project-snapshot.ts`.
- **MCP mirror**: New MCP tools must be added as one engine method in `clients/lens-engine.ts` plus one tool route in `mcp/server.ts`.
- **Configuration**: Project config is loaded by `clients/project-lens-config.ts`; LSP config by `clients/lsp/config.ts`.

## License and conduct

pi-lens is released under the [MIT License](LICENSE). By contributing, you agree that your contributions will be licensed under the same terms.

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). Please read it before participating.

If you land a pull request or report an issue that gets resolved, we'll add you to the [contributors table](README.md#contributors-) via [all-contributors](https://allcontributors.org/). If the all-contributors bot is installed, maintainers can comment `@all-contributors please add @username for code,bug`; otherwise update `.all-contributorsrc` and regenerate the table with `npx all-contributors-cli generate`.

## Questions?

Open a discussion issue or ask in the project's issue tracker. Keep it concrete and reference the files you're working with.
