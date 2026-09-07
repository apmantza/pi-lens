# Release-QA baseline matrix

The feature × modality matrix a release candidate is witnessed against before a
tag is cut. `scripts/release-qa.mjs` reads THIS FILE — the table below is the
runner's row list, not a copy of one — exports the committed tree, packs and
installs the candidate into a scratch `HOME`, drives each row's entry point
against a real `pi`, and writes `release-qa-report.md` plus one witness file per
row under `release-qa-evidence/`.

Every child process the runner spawns — `pi`, the MCP server, `node`, `npm` —
runs under a pinned environment: `HOME`, `USERPROFILE`, `PI_LENS_HOME`,
`PILENS_DATA_DIR`, `PI_LENS_INSTALL_LOG` and `npm_config_cache` all inside the
scratch root. `PI_LENS_INSTALL_LOG` is on that list by hard experience: it is
what `scripts/warm-loader-cache.mjs` keys its install log on, `PI_LENS_HOME`
does NOT redirect it, and the runner's first six runs — which pinned the pi-lens
home but passed no environment to `npm` at all — put 41 records into the
maintainer's real `~/.pi-lens/install.log` (#2619 review F1). The pack runs in a
`git archive HEAD` export, never the live checkout, because `npm pack` fires our
own `prepack` (rewrites `package.json` + `package-lock.json`) and `prepare`
(rebuilds `dist/`, downloads grammars, reinstalls git hooks).

Why it exists: #2587. The four shipped skills were suspected of never
registering for four releases because **no check ever asked a real pi what it
loaded**. The unit suite (~10.8k tests) and the nightly smokes (install, compat,
tool, lifecycle, parser) are per-seam; nothing composed them into a release
verdict with counted coverage, so a missing row read as absence rather than
arithmetic.

## Reading the table

- **row id** — the runner's key. Every id here must have a probe in
  `scripts/release-qa.mjs`, and every probe there must appear here; the tie is
  enforced by `tests/scripts/release-qa.test.ts`, so neither list can drift into
  a hand-maintained mirror of the other.
- **entry point** — the command or RPC a **user path** actually takes. Never a
  raw internal function: a row whose entry point is an internal call proves the
  function works, not the product.
- **pass criterion** — the concrete thing the witness must SHOW (a status, a
  count, a named record). "It ran without throwing" is not a criterion.
- **witness** — the artifact captured under `release-qa-evidence/`. A witness
  that merely exists is not a witness; the report quotes the line that shows the
  asserted result.
- **reuse** — the existing script that already produces this witness, or the
  smoke that would have caught this row's regression. `new` means nothing in the
  repo covers it, and the cell says so rather than leaving the gap implicit.
- **umbrella** — the open smoke-umbrella issue whose scope this row overlaps
  (#1605 lifecycle/real-host lanes, #1829 tool-contract lanes), with one line on
  where the two differ. `—` means neither umbrella claims this ground. This
  column exists so a reader can tell at a glance which rows are a down-payment
  on an already-filed umbrella and which are genuinely uncovered — and so the
  umbrella issues are not re-litigated row by row when they are eventually
  built.

## Modalities

| modality | what it stands for |
| --- | --- |
| `npm-pack` | the published artifact itself — what `npm publish` uploads |
| `npm-install` | a user installing the tarball into a project's `node_modules` |
| `pi-rpc` | pi loading the installed package, driven headless via `pi --mode rpc` |
| `mcp-stdio` | an MCP client speaking JSON-RPC to `dist/mcp/server.js` |
| `git-install` | `pi install git:...` against a pushed ref |

Static packaging shape under `npm-pack` is NOT a matrix row: CI's
`ci.yml` `prod-install-build` job already runs `publint` (gating) on every
PR's packed tarball (#2700, the check #2587 was missing). `attw`
(arethetypeswrong) is not run there or here — the package ships no
`.d.ts` at all (`tsconfig.dist.json` sets `"declaration": false`, no
`types`/`exports` in `package.json`), so there is nothing for it to grade.

## The matrix

| row id | feature | modality | entry point | pass criterion | witness | reuse | umbrella |
| --- | --- | --- | --- | --- | --- | --- | --- |
| pack-skills-payload | the four shipped skills and the compiled entry are IN the published artifact | npm-pack | `npm pack --json` on the release candidate | packed file list contains `dist/index.js` and at least 4 `skills/**/SKILL.md` | pack listing JSON | new — `tests/packaging.test.ts` asserts `files[]` NAMES `skills/`, never that the pack carries SKILL.md files | — |
| install-selftest | the runtime dependency graph and the `pi.skills` manifest resolve AS INSTALLED | npm-install | `node <installed>/scripts/install-selftest.mjs --allow-soft` | process exits 0 and no `[FAIL]` line | selftest stdout | `scripts/install-selftest.mjs` verbatim — install-smoke's `smoke` job | #1605 lane 5 (real-host install), narrower: this row asserts the packaged artifact resolves, not that a host classifier parses |
| skills-registered | a real pi registers the four pi-lens skills from the installed package | pi-rpc | `pi install <installed pkg>` then `pi --mode rpc` plus `{"type":"get_commands"}` | at least 4 commands with `source` `skill`; every `sourceInfo.path` inside the installed package AND every `sourceInfo.source` equal to `extension:index` | get_commands response JSON | new probe on the #2589 mechanism — the recurrence is #2587 | — |
| commands-registered | the extension loads and registers its `lens-*` slash commands | pi-rpc | same RPC session as above | at least 1 command with `source` `extension` named `lens-*`, and zero `extension_error` events | same get_commands response plus the event stream | `scripts/rpc-load-check.mjs` assertion — install-smoke's `pi-load` job, which runs it against the PUBLISHED package only | #1605 lane 1 (real-host): the same real-host principle, applied to extension registration rather than stderr classification |
| mcp-tools-registered | the MCP mirror advertises the `pilens_*` tool surface | mcp-stdio | `node <installed>/dist/mcp/server.js` then `initialize` plus `tools/list` | every advertised tool name starts `pilens_`, and the set contains analyze, diagnostics, turn_end, lsp_navigation, health | tools/list response JSON | new — no smoke drives the MCP mirror from an install | — |
| mcp-diagnostics-full | `lens_diagnostics` full mode answers on a fixture repo | mcp-stdio | `tools/call` `pilens_diagnostics` with `mode` `full` and `refreshRunners` `cheap`, POLLED | text carries a `Summary (N files diagnosed this session)` line with N at least 1 | tool result text | new — `tests/clients` covers the handler, nothing covers it through a packaged install | — |
| mcp-turn-end | the turn-end pipeline runs over the turn's files and returns an advisory | mcp-stdio | `tools/call` `pilens_turn_end` with the fixture file | text carries `Turn-end over N file(s).` with N at least 1 | tool result text | new — `scripts/smoke-availability-lifecycle.mjs` covers lifecycle availability, not the packaged turn-end path | #1605 lane 2 (availability-lifecycle): overlaps the turn-end half; #1605 asserts latch recovery, this row asserts the packaged turn-end path answers at all |
| mcp-lsp-navigation | LSP navigation answers on a fixture | mcp-stdio | `tools/call` `pilens_lsp_navigation` with operation `documentSymbol` and the fixture path | result is not an error and names the fixture's exported `releaseQaFixtureSymbol` | tool result text | `scripts/smoke-tools.mjs --lsp` is the per-server sibling; this row is the packaged-path variant | #1829 lane 2/3 (gated real-binary + the rotating install lane): #1829 pins each tool's own contract, this row pins that the packaged LSP path answers |
| config-provenance | a project config is LOADED and its provenance is reportable | mcp-stdio | `tools/call` `pilens_effective_config` with the fixture file | result names the fixture's `.pi-lens.json` as a contributing document | tool result text | new — `tests/config/pi-lens-config-schema.test.ts` covers the schema, not the packaged load | — |
| degradation-visible | a silently-ignored input is RECORDED as a degradation instead of vanishing | mcp-stdio | `tools/call` `pilens_health` with the fixture's project-tier `lsp.enabled` (a global-only setting) loaded | health text carries a `config-ignored` degradation line naming the fixture's `.pi-lens.json` | health tool result text | `clients/degradation-ledger.ts` is the reused machinery; no smoke asserts it end to end | #1605 lane 2 (availability-lifecycle): the degradation-recorded half; #1605 additionally asserts RECOVERY, which this row does not |
| git-install-loads | a `git:` install of a pushed ref builds and loads in a real pi | git-install | `pi install git:github.com/apmantza/pi-lens@<ref>` then `get_commands` | at least 1 `lens-*` command and at least 4 skills | get_commands response JSON | `scripts/rpc-load-check.mjs` assertion, re-run against the git layout | — |

## Why `skills-registered` pins the registrar

pi-lens has **two independent skill registrars**: the `pi.skills` manifest, and
`index.ts`'s own `resources_discover` handler (#205,
`resolvePackagePath(import.meta.url, "skills")`), which never reads the
manifest. #2587 is the proof that one half can be broken for four releases while
the other silently covers for it — driving published pi-lens 4.1.3, with the
broken `["../../skills"]` manifest, through a real pi registers all four skills,
via `extension:index`.

So the row asserts `sourceInfo.source === "extension:index"` on every skill, not
merely that four skills appeared. The cost is stated plainly: a future release
that deliberately moved registration to the manifest would FAIL this row until
the criterion is updated. That is the intended trade — the row's job is to name
which half is load-bearing, and a row that accepts "some path worked" is exactly
the check that was missing for four releases. The observed registrar values are
printed in the witness either way, so a pi-side rename reads as a diagnosable
mismatch rather than a mystery.

## Outcomes

Every row ends in exactly one of four states, and the four partition the
discovered set — the report asserts the identity
`discovered = pass + fail + untested + skipped` and says ARITHMETIC MISMATCH if
it does not hold.

The printed arithmetic is `discovered / rows / untested`, and the three words
mean different things:

- **`discovered`** — rows in the matrix above. The denominator.
- **`rows`** — of those, the ones this run actually DROVE a probe for. A row the
  runner has no probe for is not counted; a BLOCKED run drives none, so `rows`
  reads 0. A SKIPPED row IS counted: its probe ran and decided the row
  unreachable.
- **`untested`** — rows that produced no witness.

- **PASS** — the witness shows the pass criterion.
- **FAIL(cause)** — the witness shows something else. The cause is the observed
  value, not a category.
- **UNTESTED(reason)** — no witness was produced. An async row that did not
  reach a terminal state before its polling cap expires **UNTESTED, never PASS**;
  a row with no probe implementation is UNTESTED too, so an unimplemented row is
  arithmetic rather than silence.
- **SKIPPED(reason)** — the row is unreachable in this run by construction (a
  `git:` install with no ref given, for instance). Reachability is decided in
  planning, not discovered mid-run.

**BLOCKED is about the HOST, not the candidate.** The runner probes
`pi --mode rpc` **before anything is installed**; only a pi that cannot start a
bare session makes the run BLOCKED, because then nothing about the candidate
was measured. A candidate that will not pack, will not install, or stops a
working pi from booting is a **result** — DO-NOT-SHIP — not an untestable
state. A blocked run is not a failed run and must never be reported as one.

**A run that witnessed nothing is INCONCLUSIVE, never ship-with-caveats.** If pi
booted and no row reached PASS, "no row disagreed" is not evidence; the run gets
no ship verdict either.

Ship line, from the outcomes:

| condition | verdict | exit | rows |
| --- | --- | --- | --- |
| pi did not boot with NO candidate installed | BLOCKED — no verdict | 3 | 0 |
| pi booted, the candidate would not install or activate | do not ship, cause named on the verdict | 1 | 0 |
| any row FAILED | do not ship | 1 | N |
| pi booted but zero rows PASSED | INCONCLUSIVE — no verdict | 3 | N |
| any UNTESTED or SKIPPED, at least one PASS | ship with caveats, each named | 2 | N |
| all PASS | ship | 0 | N |

A candidate that never activated leaves **every row UNTESTED, none FAILED, and
`rows` at 0** — no probe ran, so nothing was witnessed and nothing can honestly
be called a failure of that row. The activation failure is the verdict's own
cause. (An earlier revision copied it onto all eleven rows as FAILs and wrote an
empty evidence dir — a verdict with no witness, against the first hard rule.)

**A row is PASS only if its witness has something in it.** A probe that reports
success and produces no artifact — or an EMPTY one — is recorded UNTESTED, not
PASS, and the report's excerpt column carries the downgrade reason rather than
the pass line. The empty case is the reachable one: every probe attaches a
witness object on its pass path, but `install-selftest` passes on "exit 0 with
no `[FAIL]` line", which a packaged selftest that printed nothing satisfies
vacuously, and its witness is that same empty stdout. The check is on CONTENT,
not on the presence of a file.

A usage or self-check error (bad option, unparseable matrix, arithmetic
mismatch) exits **4**. **Exit 2 is the EXPECTED verdict for a working-tree run**:
`git-install-loads` is SKIPPED without `--git-ref`. A CI lane should treat 2 as
a warning and 1/3/4 as failures.

## Deliberately out of scope

- **Anything needing a model turn.** Every row above is model-free by
  construction; `get_commands` and the MCP tool calls never reach a provider. A
  row that needs a real LLM turn cannot be a release gate on an unfunded key,
  and a stubbed turn would be a double that mirrors our own assumption
  (AGENTS.md, external contracts).
- **The `concurrent_session_bind` guard.** Observing it needs a second in-process
  `createAgentSession()`, which needs model config. `docs/subagent-compat.md`
  carries the same TODO; duplicating it here would add a row that can only ever
  be UNTESTED.
- **Per-language tool and LSP coverage.** `scripts/smoke-tools.mjs` sweeps the
  whole registry nightly. This matrix asserts the packaged path answers at all,
  not that every server answers well.
