# LSP capability matrix — affirmative-clean-signal strategy

How pi-lens knows a just-edited file is **clean** (no diagnostics) vs the server
simply **hasn't answered yet** (cold/crashed/silent). pi-lens waits *synchronously*
for a verdict, so — unlike an editor, which renders asynchronously and never needs
to decide — it must have a positive signal. There is no signal for "silence", so we
classify each server and pick a per-server strategy. (Background: #240; mechanism
confirmed against Neovim's LSP client, which sidesteps this entirely by being async.)

Generate/refresh this matrix with `node scripts/characterize-lsp.mjs [--install]`
(the `mode` column) and `node scripts/probe-clean-signal.mjs [--install]` (the
`clean-behavior` column — 4-way: 2 / 2* / 3 / unknown). Both **merge** in place: a server the
running host couldn't spawn keeps its prior row, so an ubuntu-poor run can't
regress a richer one (#390). The nightly **tool-smoke** workflow runs both (plus
`server-capabilities.mjs`) and opens/updates a single auto-PR
(`bot/lsp-docs-refresh`, "docs(nightly): refresh LSP capability docs") with the
regenerated docs — so this file self-populates from CI without manual copy-paste.

`probe-clean-signal.mjs` also runs a **drift check** (#529): it compares each
probed server's observed `clean-behavior` against the hand-set `silentOnClean`
marker in `clients/lsp/server-strategies.ts` and writes any mismatch to the
`## silentOnClean drift` section below. This is telemetry only — never a CI
gate — because the probe is a timing-based negative observation; a mismatch
just tells a human the marker may need updating. `unknown` observations are
never compared in either direction (a slow/absent server isn't evidence of
anything). The native TS7 launch variant (`typescript7`/`typescript7-clean`,
#524/#526) is deliberately excluded from comparison against classic's marker —
they share a server id but not a verified clean-signal behavior.

## The strategies

| Tier | Signal | Affirmative clean? | Example |
|---|---|---|---|
| **1 — pull** | `textDocument/diagnostic` returns an authoritative report (empty = clean) | YES, deterministic | rust-analyzer |
| **2 — push, publishes-versioned** | `publishDiagnostics([])` **with version** on every scan, incl. clean→clean | YES, currency-proven via version | ast-grep |
| **2\* — push, publishes-unversioned** | re-publishes on a clean scan but **version-less** — the wait still early-returns (the client accepts a version-less publish as fresh: it can't be proven stale), but currency is only *temporally correlated*, not proven | YES at runtime, with a staleness-risk caveat (not a latency cost) | opengrep |
| **3 — push, silent on clean** | server publishes nothing when nothing changed | **NO** — budget-wait floor (safe; a timeout is *not* a false clean). **This tier is #458's learned-deadline target set.** | typescript-language-server |

Detection is **cached** at `initialize` (`detectWorkspaceDiagnosticsSupport` →
`state.workspaceDiagnosticsSupport.mode`, upgraded on `client/registerCapability`),
so the tier is free at collection time — no per-edit probe.

## Matrix (dev box + CI nightly; mode last refreshed 2026-06-17 from run 27713958681, clean-behavior probed on the dev box 2026-07-08 — #460)

`mode` from cached capabilities; `clean-behavior` from the phase-aware publish-trace
probe. The probe attributes publishes to two phases — the **dirty touch** (proves the
server is live) and the **clean transitions** (the discriminator) — and classifies
4-way: `publishes-versioned` (tier 2: publish WITH version on a clean transition —
affirmative + currency-proven), `publishes-unversioned` (tier 2\*: version-less
publish on a clean transition — the wait still early-returns at runtime, currency
only temporally correlated), `silent` (tier 3: alive on dirty, silent on clean —
budget-wait, the #458 target), `unknown` (no publish at all — slow/absent,
conservatively not classified). `src` = where a row was measured: **ci** = the
nightly steps, **dev** = the dev box (a row measured on both reads `dev+ci`).
Merges never blank a prior good value, so a CI non-result leaves the dev
classification standing.

| lang | server | mode | clean-behavior | tier | src |
|---|---|---|---|---|---|
| json | vscode-json-language-server | pull | — | 1 | dev+ci |
| css | vscode-css-language-server | pull | — | 1 | dev+ci |
| html | vscode-html-language-server | pull | — | 1 | dev+ci |
| rust | rust-analyzer | pull | — | 1 | dev |
| svelte | svelte-language-server | pull | — | 1 | dev+ci |
| deno | deno (alt of typescript) | pull | — | 1 | dev+ci |
| ruby | ruby-lsp | pull | — | 1 | ci |
| csharp | csharp-ls | pull | — | 1 | ci |
| typescript | typescript-language-server | push-only | silent | 3 | dev+ci |
| python | pyright | push-only | publishes-versioned | 2 | dev+ci |
| jedi | jedi-language-server (alt of python) | push-only | publishes-versioned | 2 | ci |
| yaml | yaml-language-server | push-only | publishes-unversioned | 2* | dev+ci |
| shell | bash-language-server | push-only | publishes-versioned | 2 | dev+ci |
| dockerfile | docker-langserver | push-only | publishes-unversioned | 2* | dev+ci |
| toml | taplo | push-only | publishes-unversioned | 2* | dev+ci |
| terraform | terraform-ls | push-only | TBD | 2/3? | dev+ci |
| prisma | @prisma/language-server | push-only | publishes-unversioned | 2* | dev+ci |
| php | intelephense | push-only | TBD | 2/3? | dev |
| zig | zls | push-only | publishes-unversioned | 2* | dev+ci |
| vue | @vue/language-server | push-only | TBD | 2/3? | dev+ci |
| dart | dart language-server | push-only | publishes-unversioned | 2* | ci |
| gleam | gleam lsp | push-only | publishes-unversioned | 2* | ci |
| clojure | clojure-lsp | push-only | publishes-unversioned | 2* | ci |
| opengrep | opengrep (aux) | push-only | publishes-unversioned | 2* | dev+ci |
| ast-grep | ast-grep (aux) | push-only | publishes-versioned | 2 | dev+ci |

**Unknown — fixture exists, mode not yet captured.** The toolchain-gated family
(no auto-install today; tracked in #241) — `go` (gopls), `java` (jdtls),
`kotlin`, `swift` (sourcekit-lsp), `lua`, `cpp` (clangd), `haskell`, `elixir`,
`ocaml`, `nix` (nixd), `fsharp`. Their servers don't install in the nightly, so
characterize reports `unknown` (a non-failure ⚠). Once #241 lands they'll fill in
the same way clojure-lsp/gleam now do (both auto-install via the github strategy
and were characterized `push-only` in the run above).

## Key findings
- **Mode ≠ tier, and the split needs BOTH axes.** Push-only further splits along
  latency (does anything publish on a clean transition? — silence is the only
  budget-wait case, because pi-lens's publish handler emits and early-returns the
  wait on EVERY publish, versioned or not) and currency-proof (is the publish
  versioned, i.e. provably about the live edit?). The 4-way
  `probe-clean-signal.mjs` measurement drives this: ast-grep → 2, yaml/opengrep →
  2\*, typescript (clean file) → 3.
- **opengrep is 2\*, not 3 and not plain 2.** It *does* re-publish on a clean scan
  (the wait early-returns at runtime — fast), but every push carries
  `pubVersion=undefined`, so currency is only temporally correlated, not proven —
  a staleness-risk note, not a latency cost. An earlier hand-note called it Tier 2
  on the "re-publishes" observation alone; the phase-aware probe refines it to 2\*.
- **typescript's clean behavior is diagnostic-set-dependent (major probe finding).**
  On a DIRTY file it re-publishes (version-lessly) after every change — the dirty
  fixture measures 2\*. On a genuinely CLEAN file (the `typescript-clean` fixture)
  it publishes nothing on a clean→clean edit — silent, Tier 3. The clean-file
  behavior is the production case (the observed budget-wait timeouts), so the
  matrix row records the clean fixture's verdict; the probe prefers `clean: true`
  fixtures for exactly this reason. Corollary: a 2\* measured only on a dirty
  fixture may overstate a server whose publishes stop when its set goes empty —
  langs without a clean fixture carry that caveat.
- **#458's learned-deadline target set = the tier-3 rows only.** 2\* rows resolve
  the wait at runtime and must NOT be given learned deadlines.
- **Tier 3 is budget-bound by necessity**, not laziness: a silent server's silence is
  ambiguous (clean-unchanged vs still-analyzing), so shortening the wait or reusing
  `lastKnownDiagnostics` would risk a false clean. The wait *is* the safety mechanism.
- **ast-grep (Phase 2 / #239) is Tier 2** — it self-signals clean on every scan, so it
  is not the bottleneck. The cost on a clean with-auxiliary touch is the *silent
  primary* (typescript), a pre-existing Tier-3 cost independent of ast-grep.

## Completing the matrix
The fixtures (`tests/fixtures/tool-smoke/<lang>/`) are durable and cover every
registered server. `mode` is read from the server's advertised capabilities at
`initialize`, so it is **content-independent** — for languages that already had a
tool-layer fixture we point `characterize-lsp.mjs` at the existing (deliberately
dirty) `bad.*` source rather than a colliding clean duplicate; new languages get a
minimal clean source. Either way the mode reported is the same.

The nightly **tool-smoke** workflow runs `characterize-lsp.mjs --install` **and**
`probe-clean-signal.mjs --install` (after the LSP handshake layer) on `ubuntu-latest`,
then opens/updates an auto-PR with the regenerated docs (#390) — so both the `mode`
and `clean-behavior` columns self-populate in CI without manual copy-paste. They fill
for servers that either auto-install (npm/pip/github — including clojure-lsp and gleam,
both github-strategy as of f263cf3) or whose toolchain the workflow provisions
(Ruby/Dart/Zig + .NET→csharp). The remaining `unknown` rows are the toolchain-gated
family (#241): until `runtimeInstall` + canonical-bin discovery land, their servers
don't install in CI and stay ⚠. The **merge guard** means a CI run that can't reach a
server never blanks its dev-measured row.

The `clean-behavior` split (4-way: 2 publishes-versioned / 2\* publishes-unversioned /
3 silent / unknown) is now measured per-server by `probe-clean-signal.mjs`, no longer a
manual one-off. Locally confirmed: ast-grep + ast-grep-baseline → 2, yaml + opengrep →
2\*, typescript → 3 on its clean fixture (2\* on the dirty fixture — see Key findings);
the rest fill in as the nightly reaches them.

## silentOnClean drift (nightly-generated)

Telemetry only — never a CI gate. Compares each probed server's observed
`clean-behavior` against `clients/lsp/server-strategies.ts`'s `silentOnClean`
marker; a mismatch means the marker may need a human update (#529). `unknown`
observations are never compared (a slow/absent server is not evidence either way).

- **[marked-not-silent]** server-strategies.ts marks "typescript7" silentOnClean:true but this run observed publishes-unversioned — the marker may be stale (too pessimistic; cascade is skipping a wait the server would have resolved with a real publish)
