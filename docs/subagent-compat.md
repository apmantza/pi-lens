# Subagent-extension compatibility (#476)

pi-lens's subagent-compatibility features — #475 (subagent light mode), #474
(instance registry + orphan LSP reaper), and #473 (concurrent-session guard) —
were all built on **reverse-engineered facts** about two third-party pi
extensions and the pi SDK itself. Nobody has promised us these stay true
across their releases. This doc records exactly what we depend on, where, and
how the nightly `compat-smoke` workflow (`.github/workflows/compat-smoke.yml`)
verifies it. See issue #476 for the design rationale.

## Pinned contracts

Versions below are what was installed and verified while building this smoke
(2026-07). Re-verify against current versions any time the nightly alerts —
`scripts/compat-contracts.mjs` prints the versions it actually installed on
every run.

| # | Contract | Depended on by | Third-party file (as of the versions below) | Verified against |
|---|----------|-----------------|-------------------------------------------------|-------------------|
| 1 | `PI_SUBAGENT_CHILD` is set to the literal string `"1"` in every spawned child's env; `PI_SUBAGENT_RUN_ID` / `PI_SUBAGENT_CHILD_AGENT` are set alongside it for best-effort identity. | `clients/subagent-mode.ts` (`isSubagentSession()`, `getSubagentIdentity()`) | `pi-subagents@0.34.0` — `src/runs/shared/pi-args.ts` (`SUBAGENT_CHILD_ENV`/`SUBAGENT_RUN_ID_ENV`/`SUBAGENT_CHILD_AGENT_ENV` consts + the `env[SUBAGENT_CHILD_ENV] = "1"` assignment) | `checkNicobailonChildEnv` |
| 2a | The pi SDK's extension loader keeps a **process-global** cache (`extensionCache = new Map()`). This is what makes an in-process `bindExtensions()` reuse pi-lens's own module-scope singletons instead of a fresh isolated instance. | `clients/session-lifecycle.ts` (the whole premise of the concurrent-session guard) | `@earendil-works/pi-coding-agent@0.80.6` — `dist/core/extensions/loader.js` | `checkSdkExtensionCache` |
| 2b | `AgentSession.bindExtensions()` **unconditionally** emits a `session_start`-typed event (`this._extensionRunner.emit(this._sessionStartEvent)`). | Same as 2a — this is why an in-process subagent bind re-triggers pi-lens's `session_start` handler at all. | `@earendil-works/pi-coding-agent@0.80.6` — `dist/core/agent-session.js` (`bindExtensions()`, ~line 1717) | `checkSdkBindExtensionsEmitsSessionStart` |
| 2c | `_extensionRunner.invalidate(...)` is called from the sequential session-replacement path (`newSession`/`fork`/`switchSession`/`reload`'s dispose route), never from a concurrent sibling bind. | `clients/session-lifecycle.ts` (`probeCtxActive()` — the asymmetry this whole guard relies on) | `@earendil-works/pi-coding-agent@0.80.6` — `dist/core/agent-session.js` (~line 551) | `checkSdkInvalidateCalled` |
| 2d | The stale-ctx error thrown by an invalidated context's accessors contains the literal fragment `"stale after session replacement"`. | `clients/session-lifecycle.ts` (`probeCtxActive()` matches on this exact fragment) | `@earendil-works/pi-coding-agent@0.80.6` — `dist/core/agent-session.js` (the `invalidate(...)` message string) | `checkSdkStaleCtxMessage` |
| 3 | tintinweb's subagent runner constructs a `DefaultResourceLoader` and calls `session.bindExtensions(...)` on a freshly created `AgentSession`, **inside the same Node process** as the parent pi session. | `clients/session-lifecycle.ts` (the concurrent-secondary case #473 exists to protect against) | `@tintinweb/pi-subagents@0.13.0` — `src/agent-runner.ts` (`new DefaultResourceLoader({...})` ~line 433, `await session.bindExtensions({...})` ~line 597) | `checkTintinwebInProcessBind` |

All six checks live in `scripts/lib/compat-contracts.mjs` as pure, unit-tested
regex matchers against RESILIENT semantic shapes (never a line number — those
drift on every third-party release). `scripts/compat-contracts.mjs` is the
orchestration script: it `npm install`s the three packages into a scratch
directory, reads the specific files above, and runs every check.

## The three env levers

| Env var | Default | Effect |
|---------|---------|--------|
| `PI_LENS_SUBAGENT_FULL` | unset (light mode auto-detects) | Set to `1` to force full (non-light) behavior even inside a detected nicobailon/pi-subagents child session — disables the light-mode heavyweight-scan skip. |
| `PI_LENS_CONCURRENT_SESSION_GUARD` | unset (guard enabled) | Set to `0` to disable the #473 concurrent-session guard entirely — every `session_start` classifies as sequential replacement (pre-#473 behavior: a concurrent in-process bind would run the full reset, tearing down the parent's live LSP fleet). |
| `PI_LENS_INSTANCE_REGISTRY` | unset (registry enabled) | Set to `0` to disable the #474 cross-process instance registry — no orphan-LSP reaping happens at `session_start`, but also no new risk (registry writes are best-effort and already fail open). |

## What each smoke layer asserts

### Layer A — pinned-contract verification (`scripts/compat-contracts.mjs`)

No `pi` process, no LLM turn. Installs the real packages (table above) and
mechanically re-checks all six contracts against the installed source. Exit
0 = all pass; exit 1 = at least one contract check failed (real drift); exit
2 = infrastructure failure (npm install of the third-party packages itself
failed — usually a registry/network issue, not a contract regression).

### Layer B — real-pi behavioral smoke (`scripts/compat-smoke-behavioral.mjs`)

Installs the packed pi-lens tarball into a real `pi` (the same "pi-load"
mechanism `.github/workflows/install-smoke.yml` already uses) and drives
`pi --mode rpc` so `session_start` fires and pi-lens loads — no LLM turn
needed, matching `scripts/rpc-load-check.mjs`'s no-model-required design.

**Every invocation sets `PI_LENS_STARTUP_MODE=full`.** pi-lens's
cold-start-quick optimization (see AGENTS.md "Session-start critical path")
forces the *first* `session_start` of any process onto the fast "quick"
path regardless of `--print` — that path returns before the subagent-light
-mode check (and the heavyweight-scan skip it gates) ever runs. This was
confirmed empirically while building this smoke: without the override, the
"quick mode active" line appears in `sessionstart.log` and no
`subagent_light_mode` phase is ever logged, producing a false negative. With
`PI_LENS_STARTUP_MODE=full`, the phase logs deterministically on the very
first session.

Assertions:

1. **Subagent light mode engages** — with `PI_SUBAGENT_CHILD=1` set,
   `subagent_light_mode` is logged to `~/.pi-lens/latency.log` (a `type:
   "phase"` entry) and none of the seven heavyweight-scan phases
   (`knip`/`jscpd`/`madge`/`dead-code`/`govulncheck`/`gitleaks`/`trivy`) are
   logged for that run.
2. **`PI_LENS_SUBAGENT_FULL=1` overrides it off** — with both
   `PI_SUBAGENT_CHILD=1` and `PI_LENS_SUBAGENT_FULL=1` set, no
   `subagent_light_mode` phase is logged for that run.
3. **Zero surviving LSP-server processes after a clean exit** — pi is asked
   to shut down gracefully (closing its RPC stdin, which pi's own RPC mode
   treats as a shutdown trigger — NOT a `SIGKILL`, which would skip
   `session_shutdown` and make this assertion meaningless). A grace period
   (a few seconds) is given for the async teardown
   (`session_shutdown` → LSP fast teardown → child `SIGTERM`) to complete,
   then the process table is diffed against a pre-run snapshot for any
   *new* process whose command line matches a narrow LSP-server marker list
   (`typescript-language-server`, `ast-grep lsp`, `pyright-langserver`, …,
   `scripts/lib/process-scan.mjs`). This is the #472 orphan class #474
   fixed.
4. **`concurrent_session_bind` (#473) — NOT asserted, documented TODO.**
   The guard is fully wired on master (PR #477): `index.ts`'s `session_start`
   handler calls `decideSessionStart()` and logs a `concurrent_session_bind`
   latency phase for a concurrent-secondary bind — so the phase exists to
   observe. The blocker is DRIVING it keylessly: reproducing tintinweb's
   in-process model for real (mirroring `agent-runner.ts`'s
   `createAgentSession()` + `DefaultResourceLoader` + `bindExtensions()`
   sequence) requires full session construction, which in turn needs
   model/provider config — not cheaply stubbable without a real model key,
   and #476 explicitly asks not to ship something flaky here. The unit +
   behavioral coverage in `tests/clients/session-lifecycle.test.ts` guards
   the classifier and the no-reset contract in-repo; what Layer B cannot yet
   add is the end-to-end SDK-driven variant. **Revisit if the pi SDK grows a
   model-free session constructor or stub provider** — at that point add a
   Layer B assertion analogous to 1-3 checking the `concurrent_session_bind`
   phase and the absence of a second LSP fleet teardown.

## What to do when the nightly alerts

`compat-smoke.yml` never reds itself on a contract/behavioral failure — both
layers run under `continue-on-error: true`. Instead, a failure opens (or
refreshes the body of) a single tracking issue titled **"compat-smoke:
third-party contract drift detected"** — search for it by title before
assuming a NEW investigation is needed; the workflow already
create-or-updates it, never duplicates.

1. Read the linked run log — both layers print a `[PASS]`/`[FAIL]` line per
   check with a one-line detail on exactly what didn't match.
2. Find the failed check's row in the pinned-contracts table above and go
   read the current third-party source at the referenced file — a Layer A
   failure means the semantic shape genuinely changed upstream (a renamed
   env var, a moved `emit()` call, a reworded error message, ...).
3. Update the corresponding matcher in `scripts/lib/compat-contracts.mjs`
   (and its test in `tests/scripts/compat-contracts.test.ts`) to match the
   new shape, update the pinned-contracts table's version/line reference
   above, and fix whichever pi-lens module (`subagent-mode.ts` /
   `session-lifecycle.ts` / `instance-reaper.ts`) actually depended on the
   old shape if the drift broke real behavior — not just the check.
4. A Layer B failure (an assertion, not an infra error) means real pi-lens
   behavior regressed under a real `pi` — treat it like any other bug: write
   a fixture-level test if the gap wasn't otherwise covered, then fix.
5. Close the tracking issue once the underlying check is green again — it
   will reopen (well, get a fresh create — see the note in the issue body
   about not manually closing while still failing) if it recurs.
