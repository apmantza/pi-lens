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

> **Coverage:** this run measured **26 servers** (24 primary/alternate + 2
> auxiliary) — those whose toolchain is installed on this box. **11** more
> (csharp-ls, jdtls, kotlin-language-server, sourcekit-lsp, dart,
> lua-language-server, clangd, haskell-language-server, elixir-ls, ocamllsp, nixd)
> have a fixture but are toolchain-gated and reported `unavailable` here — run with
> `--install` on a box with their runtimes to measure them (#241). **fsautocomplete**
> now measures (it auto-installs via `dotnet tool install`, #241) — its `dotnet`
> runtime is present here.
>
> **Most fixtures are intentionally broken** (they carry a known defect so the smoke
> harness can assert a diagnostic). That means such a server always has a diagnostic
> to early-return on — see the clean-file note below, which a broken fixture masks.
> The `typescript-clean` fixture exists precisely to expose that cost.

## Results (2026-06 run, isolated)

Sorted by warm/edit. `role`: primary = the file's language server; alternate =
second server for a language (reached when the default is disabled); auxiliary =
cross-cutting, attaches alongside the primary in production but measured alone here.

| lang | role | cold | warm/edit | server |
|---|---|---:|---:|---|
| deno | alternate | 2208ms | 481ms | deno (alternate of typescript) |
| ruby | primary | 5443ms | 501ms | ruby-lsp |
| typescript | primary | 2542ms | 536ms | typescript-language-server |
| **ast-grep** | auxiliary | 2023ms | **549ms** | ast-grep |
| go | primary | 2459ms | 781ms | gopls |
| toml | primary | 2388ms | 783ms | taplo |
| dockerfile | primary | 2787ms | 789ms | docker-langserver |
| prisma | primary | 2864ms | 799ms | @prisma/language-server |
| rust | primary | 1776ms | 808ms | rust-analyzer |
| zig | primary | 1792ms | 845ms | zls |
| python | primary | 3112ms | 850ms | pyright |
| **opengrep** | auxiliary | 3028ms | **851ms** | opengrep |
| gleam | primary | 1993ms | 902ms | gleam lsp |
| yaml | primary | 3104ms | 944ms | yaml-language-server |
| clojure | primary | 7354ms | 955ms | clojure-lsp |
| css | primary | 3360ms | 1288ms | vscode-css-language-server |
| html | primary | 3283ms | 1290ms | vscode-html-language-server |
| typescript-clean | primary | 2350ms | 1324ms | typescript-language-server (clean file) |
| shell | primary | 3421ms | 1338ms | bash-language-server |
| svelte | primary | 4372ms | 1361ms | svelte-language-server |
| php | primary | 2804ms | 1370ms | intelephense |
| json | primary | 2941ms | 1379ms | vscode-json-language-server |
| jedi | alternate | 2922ms | 1585ms | jedi (alternate of pyright) |
| terraform | primary | 3221ms | 2215ms | terraform-ls |
| vue | primary | 6513ms | 2220ms | @vue/language-server |
| fsharp | primary | 3925ms | 2234ms | fsautocomplete (`dotnet tool`, #241) |

**Primary/alternate warm:** min 481ms · avg 1149ms · max 2234ms (n=24).
**Auxiliary warm:** ast-grep 549ms · opengrep 851ms — both at the **fast end** of the
primary band.

> **fsautocomplete caveat:** it returned **0 diagnostics** (the fixture isn't a
> restored .NET project, so the server surfaces nothing), so its 2234ms is the
> *clean-file* near-budget cost — see the clean-file note below — not a real
> per-edit-with-diagnostic latency. It is a heavy server regardless; this number is
> an upper bound, not a typical edit.

### Gate A verdict (#239)
**Pass, decisively.** Measured in isolation, both auxiliaries are faster than the
median primary (ast-grep 549ms, opengrep 851ms vs primary avg 1102ms). ast-grep as
an auxiliary does not regress the hot path — consolidating onto it (Phase 2) is
justified on latency grounds.

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
| typescript (broken — persistent error, re-published each edit) | 536ms |
| typescript-clean (no diagnostics) | 1324ms |

The clean file is ~2.5× slower: with a persistent diagnostic the server re-publishes
(version bump → early-return); with nothing to report, a Tier-3 push-silent server
(typescript publishes nothing on clean) gives no signal, so the touch waits its
budget. This is **budget-bound by necessity** — silence is irreducibly ambiguous, so
the cap is the only safe backstop. Tier-2 servers that re-publish empty-with-version
(ast-grep, opengrep) *do* early-return on clean files, which is why both measure fast
above even though their fixtures could be clean on a given edit.
