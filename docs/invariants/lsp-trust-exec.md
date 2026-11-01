<important if="touching lsp, trust, and process execution rules">

### LSP, trust, and process execution

- `safeSpawnAsync` is the subprocess seam. It carries ambient abort behavior,
  process-tree cleanup, output caps, typed failure kinds, and bounded timeouts.
  Installs pass `ignoreAmbientSignal: true` and remain trust-gated.
  The seam defaults `GIT_OPTIONAL_LOCKS=0`, so unless a caller `env` override
  sets it, no child takes git's optional index lock that a timeout or host exit
  could orphan (#4930). The cost of the default: git does not write back its
  refreshed stat cache, so
  on a stat-dirty checkout each status read re-hashes the dirty set until the
  user's own git command refreshes the index.
  It is also the lookup chokepoint. Under pi trust other than
  `trusted`, every child's search path loses the session repository's own
  directories, and a bare command that still resolves into them is refused
  with a typed `trust-refused` result. "Session repository" is one rule in
  `clients/session-repository.ts`, never a caller-threaded root: the kernel-real
  path lies under `process.cwd()`, under a project-local bin dir of its
  ancestors below HOME, or in a checkout sharing its git commondir; the data
  dir never counts and a session at or above HOME owns nothing. Lookups that
  start a path rather than a name (`which` answers, global bin dirs, the
  installer's PATH walk, the LSP launcher) ask `isUntrustedProjectPath` or
  `admittedLookupAnswer` for the same judgment, and every refusal writes one
  `trust-refusal` row per target. A raw `node:child_process` start in the
  runtime trees is a hole by construction:
  `tests/config/spawn-chokepoint-sweep.test.ts` derives them from the module
  binding and requires each to be routed, or admitted with a reason, evidence
  and a pinned site count. Extend the seam; never add a per-caller guard. A
  non-pi maintenance host that starts the checkout's own tools adopts trust at
  its entry, as the MCP entry points do.
- Under pi, project trust is consumed through `isProjectTrusted`; pi-lens never
  registers the host's trust-answer handler. `compileLspRegistry` is the one admission
  seam for LSP executable fields: global config and built-ins remain allowed,
  while a project field requires pi's `trusted` answer unless
  `REPO_TIER_SERVER_FIELDS` (`name`) admits it; a field no table names is
  refused (`REPO_TIER_OVERRIDE_FIELDS` admits none, #5147). A refused field
  may have shadowed the user's own value, so the server (or, for an override,
  the catalog server) is not started for the project. Missing trust APIs are
  fail-closed for those project fields with one bounded notice; installs keep
  their existing compatibility policy. `tests/clients/lsp/lsp-registry-trust.test.ts`
  and the LSP config/service suites pin the boundary.
  Non-pi process entry points (`mcp/server.ts`, `mcp/worker.ts`,
  `mcp/analyze-cli.ts`, and `mcp/cli.ts`) declare trusted execution once at
  startup through `setProjectTrustState`: workspace trust belongs to their
  calling client, and pi trust is not consulted.
  `tests/mcp/server.smoke.test.ts` and `tests/mcp/analyze-cli.test.ts` pin it.
  The standalone harness scripts that drive the built `dist/clients/lsp/`
  service (`scripts/characterize-lsp.mjs`, `probe-clean-signal.mjs`,
  `server-capabilities.mjs`, `measure-lsp-idle-eviction.mjs`, `bench-lsp.mjs`,
  `smoke-tools.mjs`) are the same kind of entry point: each adopts trust once
  through `adoptFixtureProjectTrust` (`scripts/lib/lsp-fixture-workspace.mjs`),
  because a script that leaves trust `unknown` measures every refused server as
  absent. `tests/config/lsp-script-trust-census.test.ts` fails a
  `scripts/*.mjs` that reaches `dist/clients/lsp/` without it. The four nightly
  producers that run under `continue-on-error` also report what they evaluated
  to `scripts/lib/assert-evaluated.mjs` (one pure count function per producer,
  called by the script and by its test); the nightly's floor step fails below
  each measured floor and when a matrix cell classified at HEAD turned
  `unknown` without a HEAD `firstMissed` stamp at least
  `FIRST_PUBLISH_EXPIRY_DAYS` old (`tests/config/nightly-evaluated-floors.test.ts`).
  Every other
  `continue-on-error` producer either calls the same helper (`--count
  <producer>=<n> --floor <m>` from a workflow step; `--min-pass`, the
  complexity file count and the shuffle census's missing starts already do) or
  needs none, and one census decides that: every `continue-on-error` site in a
  `.github/workflows/*.yml` or `*.yaml` file and in a composite
  `.github/actions/**/action.yml` or `action.yaml` is registered in
  `tests/fixtures/nightly-floors/continue-on-error-sites.json` as `floored`
  (naming the gating step and the floor text, which must sit in the argument
  list of a named measuring invocation — `scripts/assert-evaluated.mjs`,
  `scripts/smoke-tools.mjs`, `scripts/complexity-report.mjs` — on a top-level
  line the shell executes, of a step whose `if:` is absent or a conjunction of
  `always()`, `success()`, `!cancelled()` and one `github.event_name` or
  `matrix.<name>` comparison the parsed document settles (the workflow's `on:`
  keys, that job's `strategy.matrix` list), so
  `!cancelled() && matrix.os == 'macos-latest'` counts only where the matrix
  declares that leg; every other `if:` expression, including a trivially true
  literal and a comparison no declared value satisfies, leaves the floor
  unproven, and so does a job whose own `if:` the document proves never true).
  A `\`-continued line and a line the previous one left unfinished with `&&`,
  `||` or `|` are one command, so the measuring invocation must start the
  joined command; an `exit` ends the script only in command position. A
  `no-floor` row states the reader that makes an empty result visible, or
  `governed-by` (naming the issue and the live tests that own the site, in
  files vitest collects). The reader derives the population from the parsed
  files, so it fails closed on a site the registry
  does not name, on a producer file or a non-file entry it does not classify,
  on a `continue-on-error` key in a location that is not a job or a step, and
  on a floor whose evidence is not in the argument list of such an invocation
  on a top-level command (a comment, a quoted command, a heredoc body, a
  printed command, a function or block body, a subshell, a chained command, or
  a line after an `exit`), or that names a step whose `if:` is outside that
  allowlist; a floor comes from a run recorded in
  `tests/fixtures/nightly-floors/measurements.json`. A
  `# No floor (<issue>): <reason>` header above a job is human-facing copy
  where one exists, not the record: six sites keep one (the five `lint.yml`
  jobs and `install-smoke.yml`'s `mise-repro`), and the registry row the
  census requires is the record.
  The helper must stay importable without `dist/` (the refresh-PR job runs it
  on a fresh checkout).
- LSP service generations, workspace-sweep holds, and repair latches use
  versioned process singletons. Reset tears down the old generation before a
  replacement can spawn. Idle eviction is lease-guarded and clears ownership
  timers on every removal path.
- Production callers use the grouped experimental `LspCapabilities` adapter in
  `clients/lsp/capabilities.ts`; direct `LSPService` module imports are limited
  to that adapter and are enforced by oxlint's `no-restricted-imports` in
  `.oxlintrc.json` (`npm run lint:js`, #2372/#277; it replaced the
  `lsp-capabilities-import-sweep` test in #4865).
- Idle-eviction policy is the registry's `idleEviction` field, declared per
  server. The nightly (`scripts/measure-lsp-idle-eviction.mjs`) measures every
  registry server's eviction cost and respawn safety into
  `docs/lsp-idle-eviction.md` and changes no policy; a declaration change is a
  follow-up that cites its row, or the nightly's draft promotion PR
  (`bot/lsp-idle-evict-promote`, #3989: two consecutive eligible nights, idle
  RSS floor, cold-start cap, hold list in
  `scripts/lib/lsp-idle-eviction-promote.mjs`, derived from the registry test's
  `HOLD_INDEXER_IDS` class; the PR also moves the id into
  the registry test's `TRANSPARENT_IDS`; night memory in the matrix doc's
  refresh-state block; never auto-merged, never demotes). `tests/config/lsp-idle-eviction-measurement.test.ts`
  fails when a registry server can go unmeasured without an admission or when
  the committed measurement vetoes a server declared `transparent`.
- The compiled registry holds the CATALOG ENTRY for every built-in with no
  command override (`compileLspRegistry`), so the object the client registry
  keeps (`SpawnedServer.info`) is the object `LSP_SERVERS`/`getServerById`
  exposes; an overridden server keeps its own copy so its `spawn` and trust
  admission never reach the catalog. A copy here is not a safe container: it is
  a second registry whose entries swallow every arm a caller applies to the
  first (history: `HISTORY.md`, 2026-10-19).
  `tests/clients/lsp/lsp-registry-trust.test.ts` pins both directions;
  `scheduleIdleEviction` records `lsp-idle-eviction-declined` once per server
  per session when it arms no timer.
- The server-role vocabulary and the declared trait table have one owner,
  `clients/lsp/server-traits.ts` (#1488, #1756 stage 1). Ask `isAuxiliary`,
  never a comparison against the role literal, and read `notifyInflightLimit`
  or `replyOrdering` through `serverTraits`, never by re-deriving a default;
  `LspServerRole` is declared there and nowhere else, so a second
  `"primary" | "auxiliary"` is a re-fork. `LSPServerInfo.role` is
  non-optional: a row declares it, or the factory and custom-server builders
  apply `DEFAULT_LSP_SERVER_ROLE`. Measured-behaviour markers (`silentOnClean`
  and the census siblings named by `STRATEGY_TABLE_TRAITS`) stay on
  `wait-policy/strategies.ts`, which their probes and expiry tests own; the two
  tables stay disjoint. The auxiliary lifecycle and wait policy lives in
  `clients/lsp/auxiliary-lifecycle.ts`, the diagnostic policy in
  `clients/dispatch/auxiliary-lsp.ts`. Enforced by
  `tests/config/lsp-role-predicate-sweep.test.ts` (production and `scripts/`
  trees at zero inlined predicates) and
  `tests/config/lsp-server-trait-table.test.ts` (registered-or-fail).
- Which auxiliaries the operator's configuration switches off (a kill switch
  such as `--no-opengrep` / `opengrep.enabled=false`) has one owner,
  `configDisabledAuxiliaryLspServerIds` in `clients/dispatch/auxiliary-lsp.ts`.
  The explicit `lsp_diagnostics` probe and `lsp_navigation workspaceDiagnostics`
  pass that set as `excludeServerIds` to both the touch and `getDiagnostics`,
  through the flag resolver each host injects; the session's resource degrade
  is not part of it. The probe's batch cache key comes from
  `buildProbeScopeKey`, never equal to the workspace sweep's key, because the
  sweep records before `pi-lens-ignore` and the probe after it.
- Every diagnostics entry route starts the same server set and gives the same
  confirmation verdict under each server-selecting switch (`--no-opengrep`,
  `opengrep.enabled=false`, a disabled or missing primary). Enforced by
  `tests/tools/diagnostics-route-switch-matrix.test.ts`, which derives the
  routes from every production access to an `LSPService` diagnostics member
  and fails closed on an access it cannot classify, so a new read joins the
  matrix or carries a reasoned exemption keyed by its `clientScope` and
  `diagnostics` options. Each cell asserts the exact lines the route shows.
- A file no primary answered for is unconfirmed, never clean, whether the
  primary could not start, was still starting, or is in `lsp.disabledServers`.
  The one rule is `unansweredPrimaries` (clients/lsp/index.ts), which names
  the disabled ones through `disabledPrimaries`
  (clients/lsp/session-roots.ts, not `config.js`, whose import surface the
  test mocks mirror). A `fallbackFor` alternate standing in for a disabled
  owner keeps the denial as the cause when it cannot answer either; the
  cascade names such a server once per session, not per neighbour.
  Every route words the cause through `primaryUnavailableCause` and
  `PRIMARY_UNAVAILABLE_CAUSE` (clients/lsp/diagnostic-binding.ts), never its
  own sentence. A later write of such a file prints a one-line unconfirmed
  status naming the cause, never the clean line.
- LSP roots never exceed the session-cwd ceiling. Root/config discovery uses
  shared marker seams. Child cwd resolution uses `resolveToolCwd` and its
  caller-specific markers.
- Temporary roots (#1129) are classified once per process by
  `clients/ephemeral-root.ts`, on real paths on both sides. A directory inside
  a real git checkout below `os.tmpdir()` (root or subdirectory) is a normal
  LSP root with the ephemeral idle window, and `getProjectDataDir` gives it
  its usual slug under `<base>/.ephemeral/<pid>-<8 hex>/`: normal within the
  process, never read by another one, removed by the exit hook and, for a
  dead pid, by the session-start sweep. A `pi-agent-*` path below the tmpdir
  that no checkout owns is declined at `resolveLspServerCwd` with one
  `lsp-root-declined` record per staging root per session.
- Per-path LSP notifications serialize read/build/send/record work. Pull
  cancellation blocks a same-path replacement until settlement. Waits are
  deadline- and abort-bounded, and silence is never clean.
- A cached answer is evidence about the state it was published for, never about a
  later change. `touchFile` skips a notify for bytes the server already holds
  (see the debounce bullet below), so the diagnostics it reports can be an
  entry the server published before the caller's edit; it names that case
  (`TouchFileResult.reusedAnswer`, server plus publish stamp) and never claims
  it as the touch's own answer. The cascade reads it (`isPreEditAnswer`,
  `clients/dispatch/integration.ts`): an answer published before the run's edit
  is unconfirmed, never clean, exactly as `isPostEditObservation` already rules
  for the passive snapshot and both fallbacks. An answer published after the
  edit (a push or pull inside the touch, the `typescript.tsserverRequest` sync
  confirm, or a server that republished for the file after the edit) keeps its
  verdict. A client that cannot date its cache reports no reuse and keeps the
  pre-#5040 verdict.
- Document line addressing has one owner, `clients/lsp/content-scan.ts`: the
  `\n` count behind the `lsp_document_send` record's `contentLineCount` and the
  LSP sync bound (`countLfNewlines`), the last LSP-addressable line an
  Incremental change spans, and one line's text (`lineTextAt`, which the
  diagnostic-conversion call sites read) all come from it. The rule it owns is
  the count and the one-line read: no other module may `split("\n")` document
  content to obtain a line count or a single line — a send, a bound check, and
  a line read ask this owner. A module that needs the whole line array (a
  multi-line table, a per-line scan of its own document) keeps its `split`; the
  array is the value it consumes, never a way to count or to reach one line.
- `touchFile` fires a type-2 watched-file announcement at entry for the first
  seen content hash of a path, before the owner's didChange; it reaches every
  other live client of the same server across package roots through the client
  watch queue. Content hashes are session-scoped and bounded (#4156).
- A capability the client advertises has a sender, or the advertisement states
  why it has none. `textDocument/didSave` follows a landed didOpen/didChange
  only when the server declared `textDocumentSync.save` and the caller declared
  the touch a save — the post-write sync, the explicit `lsp_diagnostics` query
  and the MCP analysis's first touch (`analyzeFile`, the MCP hosts' post-write
  route), never a sweep warm-up, cascade or sweep touch. The touch debounce
  reads one rule: skip only when the bytes the server will hold once the path's
  notify queue drains are this touch's content. The evidence is the client's
  own sent-content record (`getSentContent`) AND `hasNotifyInFlight`, because
  that record reports what landed and a send still running lands after a skip.
  `hasNotifyInFlight` counts a content send only: a save-only send
  (`sendDidSaveForHeldDocument`) cannot change the bytes or remove the document,
  so it leaves the record final, while a didClose always counts. A client that
  cannot answer either question is pushed, never skipped: the elapsed window
  that used to decide there is gone (`formal/lsp-server-content`
  `GateWindowReopen` is why). Its key is (path, server): the client scope never
  re-pushes bytes a server holds. The debounce never drops a save: a saved touch
  whose push it skipped sends the save alone (`notify.save`), and the save mark
  names the content a `didSave` LANDED for, owned by the client's document
  record and written only by the send continuation. Every rebuild of that
  record carries the mark with the rest of the binding: Incremental's
  text-budget eviction strips the payload, never the save evidence. A failed
  carried save leaves the save owed; a failed standalone save gets one bounded
  retry (`GateSaveRetry`, `MutGateSaveNoRetry`) and a retry that lands for
  other bytes cannot suppress the save the next saved touch owes.

- Every server-produced `WorkspaceEdit` a path applies is bound to the bytes the
  server computed it from. Both rename flows take the request instant before
  they ask (`rename` right before `lspService.rename`, `renameFile` right before
  `workspace/willRenameFiles`) and pass `captureRenameExpectedContent`'s map as
  `expectedContent`; `clients/lsp/edits.ts` compares every bound file inside
  pi's mutation queue before its first write, refuses the whole edit, and
  records one `lsp-edit-stale-content` row naming the file. `renameFile` has no
  target (nothing read the old path), so an unopened file there is best effort
  by mtime, the same remainder the `rename` path carries. The evidence a file
  is compared against the sent-content records of every client that
  contributed a kept edit for that file, keyed by the registry client key; a
  merged edit never falls back to a different client's priority record. The
  records bind the file only when every contributor holds one; a contributor
  with none leaves the file on the mtime rule, and the refusal names it. One
  client's failed `willRenameFiles` never discards another client's answer,
  of the same server id or not. `documentVersions` is
  the other binding axis, for a server-initiated `workspace/applyEdit`. A new
  apply site binds the content or states why it cannot.
- `touchFile` freezes content-bound auxiliary coverage at merge time. A later
  publication cannot undo a finding drop. Auxiliary gaps narrow coverage and
  never turn a primary answer inconclusive. When a primary touch is
  inconclusive but the merged result contains answered diagnostics, dispatch
  preserves only diagnostics from content-confirmed contributors and carries
  the named primary gap as unconfirmed; only an empty inconclusive result is
  skipped (#4219, #4231). Auxiliaries never confirm a file alone: a touch that
  acquired auxiliaries but no primary that rooted for the file is inconclusive
  with `primary-unavailable`, naming those primaries, and `getDiagnostics`
  records the same ids as `unavailablePrimaryServerIds` (one rule,
  `unansweredPrimaries`; an auxiliary-only language is unaffected).
- A server's `window/showMessage` is observed once per distinct text per
  session (`lsp_server_message`), and an error-level message reporting that the
  server's own config or rules failed to load records
  `lsp-server-config-load-failed`. An AUXILIARY in that state never evaluated
  the bytes it reports on, so its empty publications are refused as evidence
  (`lsp_publish_dropped_server_config_failed`) and empty answers already stored
  are retracted; a non-empty answer still flows, and a language-role server is
  recorded but never gated. A refused publication still answers its send,
  the server's own `semgrep/rulesRefreshed` clears the failure, and the
  touch's `lsp-scanner-coverage-gap` reason carries the failure text. It
  composes with the hold of the empty publish before the rules load (table:
  `tests/clients/lsp/opengrep-pre-rules-publish-4763.test.ts`). Proven by
  `tests/clients/lsp/opengrep-offline-config-failure.test.ts`. The same gate
  (`auxiliaryEmptyIsNotEvidence`) refuses an auxiliary's UNVERSIONED empty
  publication that lands in the phase of the path's stored or pending finding:
  one rules generation (`semgrep/rulesRefreshed` count) and one client send.
  Opengrep's open-documents scan publishes `[]` for files it did not target, so
  that empty is no scan; a new send or a rules refresh clears as before, and a
  versioned or language-server publication keeps last write wins
  (`lsp-auxiliary-empty-after-finding`).
- The explicit `lsp_diagnostics` read checks `exceedsLspSyncLimits` once before
  warm attachment or `touchFile`; an over-bound file returns a `too_large`
  result with its byte/line measurement and records
  `lsp-diagnostics-file-too-large` once per file per session.
- Every new LSP server has a smoke fixture or a documented alternate/toolchain
  exemption. Real LSP-spawn tests belong in the serialized `lsp-spawn-heavy`
  lane.
- A `fallbackFor` family is one primary for workspace grouping: a selected
  preferred server and its sequential alternate do not disable the workspace-
  pull fast path merely because both registry members match the file. Measure
  the alternate independently; do not attribute the preferred server's
  capabilities or diagnostics to it (#3939).

</important>
