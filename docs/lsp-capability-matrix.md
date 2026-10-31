# LSP capability matrix — affirmative-clean-signal strategy

## Project-code trust class (#4269)

Some global language-server binaries execute repository-owned build, plugin, or
macro code while starting or indexing. The built-in registry marks these with
`executesProjectCode`; the launch gate refuses them unless pi reports the
project as trusted. Unknown trust is a `spawn-failed` refusal, not
`tool-not-found`, and does not install or retry the server. The class currently
includes rust-analyzer (Cargo `build.rs` and proc macros), Ruby LSP
(Bundler/Gemfile composed-bundle setup), PowerShell Editor Services (workspace
modules), C# / F# servers (MSBuild targets), JDT LS and Kotlin (Gradle/Maven),
SourceKit-LSP (SwiftPM plugins), Haskell Language Server (Cabal/Stack and
Template Haskell), ElixirLS / Expert (`mix compile`), and the project-configured
analysis servers whose startup evaluates workspace configuration: Dart, ZLS,
OCaml, Clojure, Terraform, Nix, CMake, Vue, and Svelte. Lean is tracked by
#4122 and will declare itself when that change lands. gopls is excluded: its
startup/index discovery uses `go list`; cgo is not compiled by gopls startup.

How pi-lens knows a just-edited file is **clean** (no diagnostics) vs the server
simply **hasn't answered yet** (cold/crashed/silent). pi-lens waits *synchronously*
for a verdict, so — unlike an editor, which renders asynchronously and never needs
to decide — it must have a positive signal. There is no signal for "silence", so we
classify each server and pick a per-server strategy. (Background: #240; mechanism
confirmed against Neovim's LSP client, which sidesteps this entirely by being async.)

Generate/refresh this matrix with `node scripts/characterize-lsp.mjs [--install]`
(the `mode` column) and `node scripts/probe-clean-signal.mjs [--install]` (the
`clean-behavior` column — 4-way: 2 / 2* / 3 / unknown — and the `first-publish`
column, #3310). Both **merge** in place: a server the
running host couldn't spawn keeps its prior row, so an ubuntu-poor run can't
regress a richer one (#390). The nightly **tool-smoke** workflow runs both (plus
`server-capabilities.mjs`) and opens/updates a single auto-PR
(`bot/lsp-docs-refresh`, "docs(nightly): refresh LSP capability docs") with the
regenerated docs — so this file self-populates from CI without manual copy-paste.

`probe-clean-signal.mjs` also runs a **drift check** (#529): it compares each
probed server's observed `clean-behavior` against the hand-set `silentOnClean`
marker in `clients/lsp/wait-policy/strategies.ts` and writes any mismatch to the
`## silentOnClean drift` section below. This is telemetry only — never a CI
gate — because the probe is a timing-based negative observation; a mismatch
just tells a human the marker may need updating. `unknown` observations are
never compared in either direction (a slow/absent server isn't evidence of
anything). The native TS7 launch variant (`typescript7`/`typescript7-clean`,
#524/#526) is deliberately excluded from comparison against classic's marker —
they share a server id but not a verified clean-signal behavior.

The `typescript` row has three launch variants, chosen in
`TypeScriptServer.spawn` (`clients/lsp/server.ts`). The project's own
TypeScript 7+ decides first: with `@effect/tsgo` installed beside it (the same
`node_modules` level, with a readable manifest version and an existing
`.bin/effect-tsgo` path) the launch is `effect-tsgo tsc --lsp --stdio`
(`launchVariant: "effect-tsgo"`, #4914); otherwise the native `tsc --lsp --stdio`
(`"native-ts7"`); with TypeScript 6 or older, or none, the classic
`typescript-language-server` (`"classic"`). Installing `@effect/tsgo` is the
only opt-in. pi-lens never installs it, adds no setting for it, and runs the
binary only when pi trusts the project, like the project's compiler. A
malformed `@effect/tsgo` install keeps the native launch and never takes an
ancestor's. So does an install the finder admits but the launcher cannot start
(no exec bit, a directory at the bin path): the failure records one
`lsp-registry-decision` row per root per generation and the native launch
follows. A process that starts and then fails `initialize` is not covered.
`effect-tsgo` wraps the same typescript-go server, so it uses the
native variant's wait strategy and cascade tier (`isTsgoLaunchVariant`,
`clients/lsp/server-traits.ts`) and is excluded from classic's marker the same
way; its own clean-signal behavior is not measured separately. The nightly
`effect-tsgo` smoke row (`scripts/smoke-tools.mjs`, pinned
`@effect/tsgo@0.62.0` on `typescript@7.0.2`) requires the `effect-tsgo` variant
and a published type error.

What IS gated is the pair of COMMITTED sources:
`tests/config/lsp-clean-behavior-census.test.ts` (#3347) compares the
`clean-behavior` column below against the `silentOnClean` markers in both
directions — every measured push row against its marker, and every marker
against a push row measured `silent` — so a nightly refresh cannot merge a
re-measured server until its marker moves with it, and a marker cannot outlive
the measurement that justified it. Push rows the probe has not classified are
admitted by name in that file, and an admission reds once its row becomes
measured.

## First publish: is the first push an answer? (#3310)

A second, ORTHOGONAL axis to the tiers below, measured from the same probe run
and written as the `first-publish` column:

| value | meaning | wait policy |
|---|---|---|
| `direct` | the first publish for a dirty file carries the findings | the first publish resolves the wait, as it always did |
| `empty-first` | the server answers `didOpen` with an EMPTY set while a one-time index builds, then publishes again once indexing ends | the client HOLDS that first empty publish (`emptyFirstPublish: "indexing"` in `clients/lsp/wait-policy/strategies.ts`); the server's own next publish releases it, and the hold is one-shot per client session |
| `empty-only` | every publish on the dirty fixture was empty | not classifiable on this axis — an undiagnosed dirty fixture looks exactly like an unfinished index, so nothing is inferred in either direction |
| `n/a (pull)` / `TBD` | pull-mode, or not measured on a host that could reach the server | no behavior change |

Why this axis had to exist at all: the wait needs a positive signal, and an
empty publish is a positive signal for a Tier 2/2\* server (a genuinely clean
file) and a MEANINGLESS one for a server that has not finished indexing. The two
are identical on the wire, so the difference is a measurement, not an inference.
intelephense is the measured member (2026-09-23, v1.18.5): `[]` at +295ms,
`indexingStarted` at +301ms — i.e. AFTER the empty publish, so no
work-in-progress signal is available at the moment the decision must be made —
`indexingEnded` at +689ms and the real 2-diagnostic set at +696ms. On a
genuinely clean file the same session publishes `[]` twice (at +304ms and again
at +663ms, right after indexing), which is what lets the held publish be
released by the server itself rather than by a timer; a WARM touch publishes the
real set first, so the hold costs nothing once the session is warm. pi-lens does
not advertise `window.workDoneProgress` (#974: advertising it crash-loops
opengrep's `--experimental` LSP mode), so `$/progress` is not an available
discriminator either.

`tests/config/lsp-first-publish-census.test.ts` compares this column against the
`emptyFirstPublish` markers and reds in BOTH directions, which is the expiry
check: when two consecutive nights re-measure a server into a different class,
the docs refresh commits the confirmed class and the marker must move with it.
A single-night flip remains in the refresh-state JSON below and does not change
the census's confirmed population.

The class is defined on a DIRTY file — is the first publish for a file that HAS
findings the answer, or an empty placeholder while a one-time index builds? — so
the probe takes it from a dirty fixture and never from a `clean: true` one: a
clean file has no finding to publish, so its trace can only ever be `empty-only`.
Before #4615 the clean fixture supplied both axes, which is how a publish that
belonged to another live client of the same server id became `typescript`'s
`empty-first`.

## The strategies

| Tier | Signal | Affirmative clean? | Example |
|---|---|---|---|
| **1 — pull** | `textDocument/diagnostic` returns an authoritative report (empty = clean) | YES, deterministic | rust-analyzer |
| **2 — push, publishes-versioned** | `publishDiagnostics([])` **with version** on every scan, incl. clean→clean | YES, currency-proven via version | ast-grep |
| **2\* — push, publishes-unversioned** | re-publishes on a clean scan but **version-less** — the wait still early-returns (the client accepts a version-less publish as fresh: it can't be proven stale), but currency is only *temporally correlated*, not proven. Since #3484 the client fences a server measured to answer a `documentSymbol` fence before it publishes (`diagnosticsFence: "reply-first"`: yaml, intelephense): a pre-edit publish is dropped until the fence's reply. Every other 2\* server (docker publishes before answering; prisma, taplo, zls, dart, gleam, clojure unmarked) keeps this behaviour | YES at runtime, with a staleness-risk caveat (not a latency cost) | opengrep |
| **3 — push, silent on clean** | server publishes nothing when nothing changed | **NO** — budget-wait floor (safe; a timeout is *not* a false clean). **This tier is #458's learned-deadline target set.** | typescript-language-server |
| **Navigation-only — custom, no evidence** | custom `lsp.servers.*` entry has no pull provider and has not published in this session | **NO** — diagnostics are unsupported; skip the wait and report navigation-only | Dexter |

Detection is **cached** at `initialize` (`detectWorkspaceDiagnosticsSupport` →
`state.workspaceDiagnosticsSupport.mode`, upgraded on `client/registerCapability`),
so the tier is free at collection time — no per-edit probe.

Custom servers without a pull provider begin with one bounded first-contact
probe. The probe uses the smaller of the server's push-wait budget and the live
hook deadline. If the hook cuts it off first, the result remains unconfirmed and
the next touch probes again. Only silence through the full push budget latches
that server id as navigation-only for the service session. A publish upgrades it
to the ordinary push-wait policy.

## Matrix (dev box + CI nightly; mode last refreshed 2026-06-17 from run 27713958681, clean-behavior probed in run 35914033696 — #460)

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

Two bounded guards keep that preservation from hiding a dead instrument
(#3401, #4512). A measured `first-publish` or `clean-behavior` cell the nightly
probe does not re-observe keeps its last known value and is marked in the
`stale` column with the date of the first miss (`since YYYY-MM-DD`). The refresh
never rewrites it to `unknown`: before #4512 a `direct` cell degraded to
`unknown` after five days, which erased five measured values in the #4338
refresh with nothing raised. The streak of consecutive nightly misses is kept
per lang and per axis in the refresh state below, so a `clean-behavior` miss one
night and a `first-publish` miss the next are two first misses; a cell whose
axis has missed two consecutive nights is
raised on one tracking issue (`nightly: LSP capability probe missed (stale
matrix cells)`), and an observation clears both the mark and the streak.
`empty-first` cells back the live `emptyFirstPublish` markers and are stamped
the same way (#4615): the refresh stamps the FIRST night it does not re-observe
one, and the first-publish census reds once that stamp is five days old, so the
cell+marker pair cannot outlive the instrument that produced it — a cell with
no live measurement behind it is no longer indistinguishable from a healthy
one. A `clean-behavior`/`tier` change is written only after two
consecutive nightly runs observe the same new value, so one flapping nightly
(ast-grep went 2 → 2* → 3 → 2* across four runs) cannot rewrite a cell; a night
that measured nothing for the lang resets the hold. A subset probe (`probe-clean-signal.mjs <langs>`) leaves the
bookkeeping of the langs it did not probe untouched.

The bookkeeping lives in the generated `## Capability matrix refresh state`
section at the end of this doc, the only state the refresh persists. The clock
is the nightly run, not the bot PR's merge: each nightly starts from the last
`bot/lsp-docs-refresh` doc when that branch is ahead of master and was built on
master's current doc (`scripts/seed-matrix-from-bot-branch.mjs`), and from
master's doc otherwise (branch absent, squash-merged, or master edited the doc
since). Closing the bot PR unmerged does not reset the bookkeeping: the branch
is kept and keeps seeding, so only deleting `bot/lsp-docs-refresh` resets it.

The `version` and `install` columns (#4512) record what the nightly ran: the
first version token of the server's own version command (the `checkArgs` its
installer entry registers, `--version` by default, read within that entry's
verification timeout) and the installer route that resolved it (`global-path`, `npm-global`, `pip-user`, `pi-lens-auto`,
`github-release`, `maven-jar`, `archive-dist`). `characterize-lsp.mjs` writes
them from the installer's resolution for the one tool a fixture names; a fixture
that names none or several, a server the installer cannot find, or a launcher
that answers every argument by starting a JVM (`tree-manifest`) records nothing,
and the cell keeps its last known value or `—`. They record the installer's
resolution, not the path the LSP launch finally spawned, so a PATH binary that
shadows a managed one reads as `global-path`. A change in `version` or `install`
is not a capability flip: the refresh PR's landing check ignores those columns
and `stale`.

`vue`'s `clean-behavior` was hand-reset to `unknown` (#3390): its
`publishes-unversioned` cell came from 58/45 publishes that the shared
`extension.log` window had attributed to vue but that belonged to `tinymist`.
With the sink scoped per server, nightly 36046209160 measured vue 0/0, and an
`unknown` result is never written by the merge above — so the refuted value had
to be cleared by hand. It stays `unknown` until a run observes
`@vue/language-server` publish; `tests/config/lsp-clean-behavior-census.test.ts`
carries the named admission until then.

| lang | server | mode | clean-behavior | first-publish | tier | src | version | install | stale |
|---|---|---|---|---|---|---|---|---|---|
| json | vscode-json-language-server | pull | — | n/a (pull) | 1 | dev+ci | — | — | — |
| css | vscode-css-language-server | pull | — | n/a (pull) | 1 | dev+ci | — | — | — |
| html | vscode-html-language-server | pull | — | n/a (pull) | 1 | dev+ci | — | — | — |
| rust | rust-analyzer | pull | — | n/a (pull) | 1 | dev+ci | — | — | — |
| svelte | svelte-language-server | pull | — | n/a (pull) | 1 | dev+ci | — | — | — |
| deno | deno (alt of typescript) | pull | — | n/a (pull) | 1 | dev+ci | — | — | — |
| ruby | ruby-lsp | pull | — | n/a (pull) | 1 | ci | — | — | — |
| csharp | csharp-ls | pull | — | n/a (pull) | 1 | ci | — | — | — |
| typescript | typescript-language-server | push-only | silent | direct | 3 | dev+ci | — | — | — |
| markdown | marksman | push-only | silent | direct | 3 | ci | — | — | — |
| lua | lua-language-server | push-only | silent | direct | 3 | dev+ci | — | — | — |
| python | pyright | push-only | publishes-versioned | direct | 2 | dev+ci | — | — | — |
| jedi | jedi-language-server (alt of python) | push-only | publishes-versioned | direct | 2 | ci | — | — | — |
| yaml | yaml-language-server | push-only | publishes-unversioned | direct | 2* | dev+ci | — | — | — |
| shell | bash-language-server | push-only | publishes-versioned | direct | 2 | dev+ci | — | — | — |
| dockerfile | docker-langserver | push-only | publishes-unversioned | direct | 2* | dev+ci | — | — | — |
| dockerfile-official | docker-language-server (official) | push-only | publishes-versioned | direct | 2 | dev+ci | — | — | — |
| toml | taplo | push-only | publishes-unversioned | direct | 2* | dev+ci | — | — | — |
| terraform | terraform-ls | push-only | publishes-unversioned | direct | 2* | dev+ci | — | — | — |
| prisma | @prisma/language-server | push-only | publishes-unversioned | direct | 2* | dev+ci | — | — | — |
| php | intelephense | push-only | publishes-unversioned | empty-first | 2* | dev+ci | — | — | — |
| zig | zls | push-only | publishes-unversioned | direct | 2* | dev+ci | — | — | — |
| vue | @vue/language-server | push-only | unknown | unknown | 2/3? | dev+ci | — | — | — |
| dart | dart language-server | push-only | publishes-unversioned | direct | 2* | ci | — | — | — |
| gleam | gleam lsp | push-only | publishes-unversioned | direct | 2* | ci | — | — | — |
| clojure | clojure-lsp | push-only | publishes-unversioned | direct | 2* | ci | — | — | — |
| opengrep | opengrep (aux) | push-only | publishes-unversioned | direct | 2* | dev+ci | — | — | — |
| ast-grep | ast-grep (aux) | push-only | publishes-versioned | direct | 2 | dev+ci | — | — | — |
| cue | CUE Language Server (cue lsp serve) | push-only | publishes-versioned | direct | 2 | dev+ci | — | — | — |

**Unknown — fixture exists, mode not yet captured.** The toolchain-gated family
(no auto-install today; tracked in #241) — `go` (gopls), `java` (jdtls),
`kotlin`, `swift` (sourcekit-lsp), `cpp` (clangd), `haskell`, `elixir`,
`ocaml`, `nix` (nixd), `fsharp`. Their servers don't install in the nightly, so
characterize reports `unknown` (a non-failure ⚠). Once #241 lands they'll fill in
the same way clojure-lsp/gleam now do (both auto-install via the github strategy
and were characterized `push-only` in the run above).

## Key findings
- **Mode ≠ tier, and the split needs BOTH axes.** Push-only further splits along
  latency (does anything publish on a clean transition? — silence is the only
  budget-wait case, because pi-lens's publish handler emits and early-returns the
  wait on every publish, versioned or not, with two exceptions: #3310's held
  empty FIRST publish from an `empty-first` server, and #4763's held empty
  publish from opengrep before `semgrep/rulesRefreshed`) and currency-proof (is the publish
  versioned, i.e. provably about the live edit?). The 4-way
  `probe-clean-signal.mjs` measurement drives this: ast-grep → 2, yaml/opengrep →
  2\*, typescript (clean file) → 3.
- **opengrep is 2\*, not 3 and not plain 2.** It *does* re-publish on a clean scan
  (the wait early-returns at runtime — fast), but every push carries
  `pubVersion=undefined`, so currency is only temporally correlated, not proven —
  a staleness-risk note, not a latency cost. An earlier hand-note called it Tier 2
  on the "re-publishes" observation alone; the phase-aware probe refines it to 2\*.
- **opengrep's first publish depends on its config (#4763).** With a local rule
  file the rules load before the first scan and `semgrep/rulesRefreshed` precedes
  the first publish (`direct`, the column above). With `--config auto` (the
  default pi-lens launch) opengrep scans the opened document before its rules
  load, logs "Rules not loaded yet, not scanning anything" and publishes `[]`;
  it then sends `semgrep/rulesRefreshed` and republishes every open document
  (opengrep@60ed3b3 `Scan_helpers.run_semgrep` / `refresh_rules`, unchanged since
  v1.0.0). Cold, online, 1.30.0 x3 and 1.32.0 x2: `[]` at +11..18 ms, the
  notification at +0.7..1.0 s, the findings 0.25..0.5 s later. Warm: `didChange`
  publishes nothing; the reopen pi-lens sends instead (`reopenOnResync`)
  publishes the fresh scan once, +0.25..0.4 s on both versions; a reopen with
  `didSave` publishes twice (+0.3..0.9 s), a lone `didSave` once (+0.25..0.5 s).
  Rules that never load (offline) leave the `[]` as the only publish and
  `window/showMessage` carries the error after it (#4764). Measured offline on
  the built tree, nine touches: the edit path (`with-auxiliary`) waits the
  aux grace ceiling (about 2 s) for six touches, then the existing demotion
  (`aux_wait_demoted`) skips the wait (0 ms); the explicit all-scope
  `lsp_diagnostics` call waits the full wait budget (3 s) every time and
  reports the coverage notice. The strategy marker
  `emptyUntilRulesRefreshed` holds that `[]`, released by the notification, not
  by a timer. The other three auxiliaries do not need it, measured in
  `tests/fixtures/opengrep-lsp-trace/auxiliary-first-publish.json`: ast-grep
  compiles its rules before the first parse (3/3, first publish carries the
  findings at +30..35 ms), zizmor audits inline and publishes once (3/3, +3 ms;
  its source runs every audit, online ones included, before the one publish),
  typos has the dictionary compiled in (3/3, +0..1 ms).
- **typescript's clean behavior is diagnostic-set-dependent (major probe finding).**
  On a DIRTY file it re-publishes (version-lessly) after every change — the dirty
  fixture measures 2\*. On a genuinely CLEAN file (the `typescript-clean` fixture)
  it publishes nothing on a clean→clean edit — silent, Tier 3. The clean-file
  behavior is the production case (the observed budget-wait timeouts), so the
  matrix row records the clean fixture's verdict; the probe prefers `clean: true`
  fixtures for exactly this reason. Corollary: a 2\* measured only on a dirty
  fixture may overstate a server whose publishes stop when its set goes empty —
  langs without a clean fixture carry that caveat.
- **The probe's publish capture was dead, and the column looked alive anyway
  (#3310).** `probe-clean-signal.mjs` intercepted `console.error` for the
  `[lsp-pub]` trace, but #1333 moved that trace's sink to `extension.log` — so
  every phase counted zero publishes, every server classified `unknown`, and the
  #390 merge guard then preserved the July 2026 values verbatim. A dead
  instrument and a healthy one are indistinguishable when non-results are
  discarded by design. The probe now reads the sink the client actually writes;
  `first-publish` measurements on the dev box, 2026-09-23: php `empty-first`,
  typescript / opengrep / ast-grep / marksman `direct` (so the class does not
  extend to them on the measurement, whatever their comments suggest).
- The official Docker row's clean-gate witness requires the BuildKit-backed
  `JSONArgsRecommended` rule and skips when `docker buildx` is unavailable;
  its first-publish class is the nightly's measured `direct`.
- **#458's learned-deadline target set = the tier-3 rows only.** 2\* rows resolve
  the wait at runtime and must NOT be given learned deadlines.
- **Tier 3 is budget-bound by necessity**, not laziness: a silent server's silence is
  ambiguous (clean-unchanged vs still-analyzing), so shortening the wait or reusing
  `lastKnownDiagnostics` would risk a false clean. The wait *is* the safety mechanism.
- **ast-grep (Phase 2 / #239) is Tier 2** — it self-signals clean on every scan, so it
  is not the bottleneck. The cost on a clean with-auxiliary touch is the *silent
  primary* (typescript), a pre-existing Tier-3 cost independent of ast-grep.

## Save-triggered servers: per-server verdict (#3405)

Population: every server that declares `textDocumentSync.save` in
`docs/servercapabilities.md` (15 `save`, 5 `save+text`), plus zizmor, which
registers `textDocument/didSave` dynamically and therefore never receives one
from pi-lens (its `didSave` registration is dynamic and pi-lens maps only the
static `initialize` reply). The `server` column is the registry id in
`clients/lsp/server.ts`, so a row can be matched against the capability
inventory mechanically.

`publishes after save only` states whether only a save makes the server answer:

| value | meaning |
|---|---|
| `no` | the seeded finding arrived without a save |
| `no (pull)` | pull mode: the `textDocument/diagnostic` request answered without a save, so no publish is involved |
| `yes` | the same bytes produced the finding only after a save |
| `yes (saved write)` | only a diagnostic-neutral edit plus a save produced it |
| `inconclusive` | no arm produced the finding, or the answer landed in the untriggered window between two arms and so belongs to no arm |
| `cannot measure` | no runner can install the server; the reason follows |
| `unknown` | no run has measured this row yet |

Regenerate it with

```text
node scripts/probe-save-verdict.mjs [lang ...] [--install] [--wait-ms <ms>] [--doc <path>]
```

The nightly `tool-smoke.yml` step "LSP save verdict (#3405)" runs it with
`--install` on the tool-smoke fixtures, so the measurement columns self-populate
through the same docs-refresh PR as `mode` and `clean-behavior` (#390). The probe
drives the real client and reports four arms of equal length: the seeded bytes
with `saved: false` (didOpen/didChange only), an untriggered window of the same
length, the SAME bytes with `saved: true` (so a publish has the save as its only
new input), and, only when nothing else answered, a diagnostic-neutral edit
plus a save. `scripts/lib/save-verdict.mjs` owns the classification, the wording
and the merge guard; a run rewrites the three measurement columns of the rows it
reached and copies every other row verbatim, so a runner that could not install a
server never blanks a measured cell.

A night that could not tell never erases an answer (#5060). A row that holds a
settled answer (`no`, `no (pull)`, `yes`, `yes (saved write)`) keeps it, with its
evidence, when the run measures `inconclusive` or `cannot measure`; only a
settled answer replaces a settled one, and a `yes` to `no` change stays a visible
flip. This table has no column for a night a row was not answered, so the held
night goes to the run log (`save-verdict: held back <server>`), to one
`::warning::` annotation per held server under GitHub Actions, and to the
`--summary` JSON (`heldBack`). No counter or issue tracks consecutive held
nights.

A pull-mode server answers a `textDocument/diagnostic` request rather than
publishing, so no arm of its run has the save as its only new input: it reads
`no (pull)` when the request answered without a save and `inconclusive`
otherwise, never `yes`.

The cells carry what a run OBSERVED, never when or where: each arm's elapsed time
and the `src` token that says CI or a dev box go to the run log, so a
re-measurement that changes only those is not a capability flip and the refresh PR
stays armed for auto-merge (#4512).

A row whose evidence names this command is a measurement by it. A row that names
a prior probe, a workflow run or a source commit instead is provenance from
before the command existed (or from a server no local run could reach), and the
dispatched nightly replaces it on the first night that reaches the server.

| server | save as declared | publishes after save only | verdict | evidence |
|---|---|---|---|---|
| expert | `save` | no | Prior measurement: answers with no `didSave` once the seed is under `lib/`. Gated. | #4768 arms A, B, C; nightly run 39852672584 (answered on call 6, 10955 ms); `tests/fixtures/nightly-floors/expert-readiness.json` |
| cpp | `save` | no | Measured: answers without a save (1 publish event on didOpen); a later save alone: silent (6000 ms). Gated. | `node scripts/probe-save-verdict.mjs` (fixture cpp) |
| lua | `save` | no | Measured: answers without a save (2 publish events on didOpen); a later save alone: silent (6000 ms). Gated. | `node scripts/probe-save-verdict.mjs` (fixture lua) |
| python-jedi | `save` | no | Measured: answers without a save (1 publish event on didOpen); a later save alone: silent (6000 ms). Gated. | `node scripts/probe-save-verdict.mjs` (fixture jedi) |
| opengrep | `save` | no | Measured: answers without a save (1 publish event on didOpen); a later save alone: silent (6000 ms). Auxiliary, not gated. | `node scripts/probe-save-verdict.mjs` (fixture opengrep) |
| gleam | `save` | no | Measured: answers without a save (1 publish event on didOpen); a later save alone: silent (6000 ms). Gated. | `node scripts/probe-save-verdict.mjs` (fixture gleam) |
| go | `save` | no | Source: `DidSave` calls `didModifyFiles`, the path a change takes. Gated. | golang/tools `02c9e4cb4c2f`, `gopls/internal/server/text_synchronization.go` |
| zig | `save` | no | Measured: answers without a save (1 publish event on didOpen); a later save alone: silent (6000 ms). Gated. | `node scripts/probe-save-verdict.mjs` (fixture zig) |
| rust | `save` | inconclusive | Measured: inconclusive — pull mode: every arm is a textDocument/diagnostic request, so no arm has the save as its only new input (arms: no-save silent (6000 ms), save alone silent (6000 ms), saved write silent (6000 ms)). Exempt from the clean gate. | `node scripts/probe-save-verdict.mjs` (fixture rust) |
| terraform | `save` | no | Measured: answers without a save (1 publish event on didOpen); a later save alone: silent (6000 ms). Gated. | `node scripts/probe-save-verdict.mjs` (fixture terraform) |
| fsharp | `save+text` | no | Source: a save holds the source and refreshes code lenses; diagnostics come from open and change checks. Exempt: 0 findings in every run. | ionide/FsAutoComplete `8f011f1395a4`, `src/FsAutoComplete/LspServers/AdaptiveFSharpLspServer.fs` (`TextDocumentDidSave`); nightly run 39845687189 |
| zizmor | · (registered dynamically) | no | Source: `didSave` is registered dynamically and pi-lens does not map that registration, so no save is sent. Auxiliary, not gated. | zizmor `crates/zizmor/src/lsp.rs` (`initialized`); `clients/lsp/wait-policy/strategies.ts:400-410` (#3548) |
| clojure | `save+text` | no | Measured: answers without a save (1 publish event on didOpen); a later save alone: silent (6000 ms). Gated. | `node scripts/probe-save-verdict.mjs` (fixture clojure) |
| fish | `save+text` | unknown | Unverified: not measured. Gated. | none |
| tinymist | `save` | no | Measured: answers without a save (1 publish event on didOpen); a later save alone: 1 publish event. Gated. | `node scripts/probe-save-verdict.mjs` (fixture typst) |
| cue | `save` | no | Measured: answers without a save (1 publish event on didOpen); a later save alone: silent (6000 ms). Gated. | `node scripts/probe-save-verdict.mjs` (fixture cue) |
| csharp | `save+text` | unknown | Unverified: not measured. Pull mode, so diagnostics are requested and a save is unlikely to be the only trigger. Gated. | none |
| deno | `save` | no (pull) | Measured: pull mode — no save needed; a later save+request answered: 1 diagnostic. Gated. | `node scripts/probe-save-verdict.mjs` (fixture deno) |
| svelte | `save` | no (pull) | Measured: pull mode — no save needed; a later save+request answered: 2 diagnostics. Gated. | `node scripts/probe-save-verdict.mjs` (fixture svelte) |
| powershell | `save+text` | unknown | Unverified: not measured. Exempt: intermittent. | none |
| cmake | `save` | inconclusive | Measured: inconclusive — no arm published, so this fixture does not distinguish a save-triggered server from one that never diagnoses it (arms: no-save silent (6000 ms), save alone silent (6000 ms), saved write silent (6000 ms)). Exempt from the clean gate. | `node scripts/probe-save-verdict.mjs` (fixture cmake) |

Notes.

1. Probe. `node scripts/probe-save-verdict.mjs` is the command that produces this
   table (see the paragraph above). It reuses the tool-smoke fixtures and the
   nightly that already installs those servers, so it is one measurement path, not
   a second driver. The only other command #4768 named is
   `node scripts/smoke-tools.mjs --lsp-gate`; that step drives the clean gate and
   writes no save verdict.
2. clangd reconciled. #4527 recorded "base 1 of 5, head 5 of 5" and #4768 recorded
   clangd publishing on `didOpen` alone; both hold, and they counted different
   things. The 5 checks are the rows of the `lsp-did-save/analyze` verify scenario,
   four of which require a `textDocument/didSave` on the wire, so its one passing
   check on base is `control: clangd answered for a.c`: clangd published the
   finding with `0 didSave(s)` captured. The sender was missing, not the
   publish. The probe reproduces both arms with one seed and one window (6000 ms
   each, one client): the no-save arm published on `didOpen`, and the save arm,
   with the identical bytes and the save on the wire, published nothing, because
   clangd does not republish identical bytes, the same property #4527 measured
   when its own re-push left the cold query inconclusive. So #4768's verdict
   stands, #4527's 1-of-5 → 5-of-5 is a sender measurement, and no clangd arm
   reads `yes`.
3. Citations corrected against master. #4768 cites `clients/lsp/client.ts:4410`
   for `sendDidSave`; it is at `clients/lsp/client.ts:4909`, with the save-capability
   gate at line 4917. The opengrep rescan claim is at
   `clients/lsp/wait-policy/strategies.ts:100`; line 345 is the
   `emptyUntilRulesRefreshed` hold.
4. Clean-gate policy in a measured row is the fixture's own declaration, not
   hand prose: `Gated.` is `lspGate: true`, `Auxiliary, not gated.` an auxiliary
   scanner, and `Exempt from the clean gate.` a fixture whose `lspGateExempt`
   reason lives in `scripts/smoke-tools.mjs`.

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
`clean-behavior` against `clients/lsp/wait-policy/strategies.ts`'s `silentOnClean`
marker; a mismatch means the marker may need a human update (#529). `unknown`
observations are never compared (a slow/absent server is not evidence either way).

- **[silent-not-marked]** observed silent on clean transitions but wait-policy/strategies.ts has no silentOnClean marker for "typescript7" — cascade is burning the full in-lane wait it could skip (the pre-#458 situation)

## Capability matrix refresh state (nightly-generated)

Bookkeeping for the two-run `first-publish`/`clean-behavior` hysteresis, the
first-miss stamps (#3401, #4615), the consecutive-night `missed-probe`
streaks behind the `stale` column (#4512) and consecutive-night
`idle-eviction` counts (#3989). Regenerated every run; never a measurement.

```json
{"idle-eviction":{"powershell":{"nights":[{"day":"2026-10-27","rssMb":155,"coldMs":2553}]}}}
```
