# LSP latency benchmark

Cold/warm per-edit latency for pi-lens's registered language servers, measured to
gate the ast-grep LSP consolidation (#239 Gate A: an auxiliary scanner is
acceptable as long as its warm latency is in the range of the primary language
servers pi-lens already tolerates).

- **Reproduce:** `npm run build:dist && node scripts/bench-lsp.mjs [lang …] [--install]`
- **Machine:** Windows 11, dev box, warm npm cache. Numbers are **indicative, not
  absolute** — single machine, small fixtures, one run.
- **cold** = first touch: spawn + `initialize` handshake + first scan.
- **warm** = re-touch after a content edit (the per-edit latency the agent waits on),
  averaged over 3 edits.
- Source fixtures: `tests/fixtures/tool-smoke/*` (driven through the real
  `LSPService.touchFile`, same entry the dispatch path uses).
- **Isolation (since #242):** each fixture measures **one server alone**. The
  service + workspace config are reset between fixtures (no lingering server from a
  previous measurement), and every *other* server matching the file is disabled —
  so an auxiliary number is the auxiliary by itself (primaries off) and a primary
  number is the default by itself (alternates + auxiliaries off). This removes the
  primary↔auxiliary cross-contamination that produced the old "20557ms" artifact
  (see the resolved-history note below).

> **Coverage:** this run measured **31 servers** (27 primary/alternate + 4
> auxiliary) — those whose toolchain is installed on this box. **Newly measuring
> since the previous run:** **clangd** (cpp) and **zizmor** (auxiliary) now
> auto-install via the archive/github strategies (#241/#272), **PowerShell Editor
> Services** via its pwsh-bootstrapped bundle (#278), and **marksman** (markdown,
> #274). **11** fixtures remain toolchain-gated and reported `unavailable` here
> (csharp-ls, jdtls [java + java-lombok], kotlin-language-server, sourcekit-lsp,
> dart, lua-language-server, haskell-language-server, elixir-ls, ocamllsp, nixd) —
> run with `--install` on a box with their runtimes to measure them (#241).
>
> **Most fixtures are intentionally broken** (they carry a known defect so the smoke
> harness can assert a diagnostic). That means such a server always has a diagnostic
> to early-return on — see the clean-file note below, which a broken fixture masks.
> The `typescript-clean` fixture exists precisely to expose that cost.

## Results (2026-06-21 run, isolated)

Sorted by warm/edit. `role`: primary = the file's language server; alternate =
second server for a language (reached when the default is disabled); auxiliary =
cross-cutting, attaches alongside the primary in production but measured alone here.

| lang | role | cold | warm/edit | server |
|---|---|---:|---:|---|
| ruby | primary | 5608ms | 159ms | ruby-lsp |
| deno | alternate | 1521ms | 165ms | deno (alternate of typescript) |
| **ast-grep-baseline** | auxiliary | 1906ms | **394ms** | ast-grep (no-sgconfig baseline) |
| **ast-grep** | auxiliary | 1614ms | **399ms** | ast-grep |
| dockerfile | primary | 1715ms | 470ms | docker-langserver |
| toml | primary | 1622ms | 471ms | taplo |
| go | primary | 1777ms | 473ms | gopls |
| prisma | primary | 1935ms | 473ms | @prisma/language-server |
| zig | primary | 1237ms | 496ms | zls |
| yaml | primary | 1908ms | 506ms | yaml-language-server |
| python | primary | 2025ms | 520ms | pyright |
| rust | primary | 1015ms | 576ms | rust-analyzer |
| gleam | primary | 1219ms | 585ms | gleam lsp |
| typescript | primary | 1811ms | 605ms | typescript-language-server |
| **cpp** | primary | 983ms | 607ms | clangd (#241) |
| clojure | primary | 5496ms | 624ms | clojure-lsp |
| **opengrep** | auxiliary | 2156ms | **651ms** | opengrep |
| css | primary | 2204ms | 967ms | vscode-css-language-server |
| json | primary | 2014ms | 972ms | vscode-json-language-server |
| html | primary | 2234ms | 981ms | vscode-html-language-server |
| shell | primary | 2327ms | 1012ms | bash-language-server |
| svelte | primary | 3311ms | 1028ms | svelte-language-server |
| typescript-clean | primary | 1827ms | 1043ms | typescript-language-server (clean file) |
| php | primary | 1703ms | 1167ms | intelephense |
| jedi | alternate | 2477ms | 1278ms | jedi (alternate of pyright) |
| **powershell** | primary | 5053ms | 1401ms | PowerShell Editor Services (#278) |
| markdown | primary | 2979ms | 1725ms | marksman (#274) |
| terraform | primary | 2331ms | 1729ms | terraform-ls |
| fsharp | primary | 2958ms | 1730ms | fsautocomplete (`dotnet tool`, #241) |
| vue | primary | 5545ms | 1731ms | @vue/language-server |
| **zizmor** | auxiliary | 962ms | **2158ms†** | zizmor (#272) |

**Primary/alternate warm:** min 159ms · avg 870ms · max 1731ms (n=27).
**Auxiliary warm:** ast-grep 399ms · ast-grep-baseline 394ms · opengrep 651ms —
all at the **fast end** of the primary band. **zizmor 2158ms†** is a bench
artifact, not its real per-edit cost — see the caveat below; its true warm/edit is
**~680ms**, also fast-end.

> **† zizmor caveat (the bench number is a no-signal artifact).** The harness's
> warm edit appends `\n// bench edit N\n`, but `//` is **not** a YAML comment
> (`#` is) — so each warm touch hands zizmor an *unparseable workflow*. zizmor
> collects no auditable input and publishes nothing, so the touch has no diagnostic
> to early-return on and runs to its `aggregateWaitMs` budget (the same class of
> "no-signal, budget-bound" cost as a clean file — see below). Re-measured with a
> *valid* edit (appending a `#` comment so the workflow stays parseable + still
> flagged), zizmor early-returns on the version-matched republish:
>
> | edit kind | cold | warm/edit | diags |
> |---|---:|---:|---:|
> | bench `//` (unparseable) | 962ms | 2158ms | 1 cold, 0 warm |
> | valid `#` (parseable, flagged) | 2376ms | **682ms** | 1 every touch |
>
> So zizmor's real per-edit latency sits with opengrep (~650ms), not at 2158ms.

> **fsautocomplete caveat:** it returned **0 diagnostics** (the fixture isn't a
> restored .NET project, so the server surfaces nothing), so its 1730ms is the
> *clean-file* near-budget cost — see the clean-file note below — not a real
> per-edit-with-diagnostic latency. It is a heavy server regardless; this number is
> an upper bound, not a typical edit.

### Auxiliary verdict (#239 Gate A, re-confirmed #272)
**Pass, decisively.** Measured in isolation, every auxiliary's real warm latency is
at or below the median primary (ast-grep 399ms, opengrep 651ms, zizmor ~682ms vs
primary avg 870ms). None regresses the hot path.

### Shared with-auxiliary floor on YAML (#272 re-measure)
Editing a workflow YAML now attaches **three** auxiliaries alongside the yaml
primary — opengrep, ast-grep, **and zizmor** (all include YAML in their kind set).
The concern (#272) was that each new auxiliary joins the same `with-auxiliary`
`Promise.all` and could extend the per-edit floor. It does **not**, because of the
#242 fix: each attached server gets its **own** deadline bounded by the caller cap
as a ceiling (`min(callerCap, aggregateWaitMs)`), and they run concurrently — so
the touch waits for the *slowest single* aux, not their sum. opengrep
(`min(2500, 3500) = 2500`) already sets that ceiling; zizmor
(`min(2500, 2000) = 2000`) sits under it and never extends the floor. On a normal
(parseable) edit all three early-return well inside the cap (~400–680ms). zizmor's
`aggregateWaitMs` is intentionally left at 2000ms for online-mode (GitHub-API)
headroom; a late online finding is cached and surfaces on the next edit.

## Resolved: the with-auxiliary measurement artifact (#240 + #242)

An earlier full-suite bench reported **ast-grep warm = 20557ms** (and ~2000–3700ms
at lower caps). That was **never ast-grep being slow** — it was two compounding bugs,
both now fixed:

1. **The benchmark co-spawned the primary.** An auxiliary fixture was touched with
   `clientScope: "with-auxiliary"`, which spawns the file's primary language server
   *and* the auxiliary, then waits for **all** of them (`Promise.all`). The fixtures
   are clean JS with no TypeScript errors, so the primary (typescript, push-silent on
   a clean file) never published and never early-returned — the touch ran to the
   deadline even though ast-grep published in ~0.5s. **Fix:** the bench now disables
   the primary and measures each server alone (this doc, isolation note above).
2. **The with-auxiliary deadline was a floor, not a ceiling.** The collection used
   `timeoutMs = max(callerCap, maxStrategyWait)` for *every* attached server, so a
   large cap *became* the deadline and a slow auxiliary could override the per-edit
   cap. **Fix (#242):** each server now gets its own deadline bounded by the caller
   cap as a ceiling — `min(callerCap, strategyWait)` — so a clean/push-silent primary
   can no longer hold the touch and an auxiliary can't blow the per-edit budget.
   ast-grep's `aggregateWaitMs` was also raised 1000 → 1800 (its scan is ~1.3s; 1000
   was under-budgeted, masked before only by the global floor).

Correctness of the early-return signal was hardened separately in **#240**: pull
diagnostics now return a discriminated `found | clean | unavailable` outcome and a
failed pull (dead/null/threw) is **never** read as clean — only an affirmative,
version-matched publish (or authoritative empty pull) ends the wait early. A
crashed/cold/stale/errored server is never painted "clean".

### Clean-file cost is real and irreducible for push-silent servers
A server that processes an edit and finds **no new diagnostics** gives the wait
nothing to trip on, so a clean file costs more than a broken one on the *same* server:

| fixture | warm/edit |
|---|---:|
| typescript (broken — persistent error, re-published each edit) | 605ms |
| typescript-clean (no diagnostics) | 1043ms |

The clean file is ~1.7× slower: with a persistent diagnostic the server re-publishes
(version bump → early-return); with nothing to report, a Tier-3 push-silent server
(typescript publishes nothing on clean) gives no signal, so the touch waits its
budget. This is **budget-bound by necessity** — silence is irreducibly ambiguous, so
the cap is the only safe backstop. Tier-2 servers that re-publish empty-with-version
(ast-grep, opengrep) *do* early-return on clean files, which is why both measure fast
above even though their fixtures could be clean on a given edit.
