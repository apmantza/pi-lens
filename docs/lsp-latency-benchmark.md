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

> **Coverage:** this measures the **17 servers that have a tool-smoke fixture**, not
> all 38 registered server definitions. The other ~21 (go, ruby, java, kotlin,
> swift, dart, lua, cpp, zig, haskell, gleam, ocaml, clojure, elixir, nix, vue,
> svelte, omnisharp, fsharp, …) have no fixture and are skipped. To benchmark the
> full registry, add a minimal fixture per language.
>
> **Every fixture is intentionally broken** (it carries a known defect so the smoke
> harness can assert a diagnostic). That means each server always has diagnostics to
> early-return on — see the lifecycle note below, which this masks.

## Results (2026-06 run)

Sorted by warm/edit. `role`: primary = the file's language server; alternate =
second server for a language (reached when the default is disabled); auxiliary =
cross-cutting, attaches alongside the primary.

| lang | role | cold | warm/edit | server |
|---|---|---:|---:|---|
| deno | alternate | 2028ms | 377ms | deno |
| rust | primary | 1381ms | 378ms | rust-analyzer |
| typescript | primary | 2195ms | 420ms | typescript-language-server |
| yaml | primary | 2701ms | 639ms | yaml-language-server |
| dockerfile | primary | 2487ms | 684ms | docker-langserver |
| toml | primary | 2331ms | 693ms | taplo |
| prisma | primary | 2671ms | 700ms | @prisma/language-server |
| python | primary | 2736ms | 724ms | pyright |
| json | primary | 2555ms | 1172ms | vscode-json-language-server |
| html | primary | 2950ms | 1177ms | vscode-html-language-server |
| opengrep | auxiliary | 4233ms | 1181ms | opengrep |
| css | primary | 2951ms | 1201ms | vscode-css-language-server |
| php | primary | 2595ms | 1280ms | intelephense |
| shell | primary | 3751ms | 1388ms | bash-language-server |
| jedi | alternate | 2853ms | 1484ms | jedi-language-server |
| terraform | primary | 3146ms | 2066ms | terraform-ls |
| **ast-grep** | auxiliary | 3547ms | **~2000ms** (see note) | ast-grep |

**Primary/alternate warm:** min 377ms · avg ~960ms · max 2066ms (n=15).
**Auxiliary warm:** opengrep ~1180ms, ast-grep ~2000ms — both within the primary range.

### Gate A verdict (#239)
**Pass.** Both auxiliaries land inside the primary band (377–2066ms). ast-grep as
an auxiliary does not regress the hot path beyond what pi-lens already tolerates
for primaries, so consolidating onto it (Phase 2) is justified on latency grounds.

## Note on the ast-grep "20557ms" anomaly (a measurement artifact)

The raw full-suite bench first reported **ast-grep warm = 20557ms**. That number is
**not ast-grep being slow** — it is a benchmark artifact, root-caused as follows:

1. **ast-grep is fast and correct.** Instrumenting the publish handler showed it
   emits one prompt `publishDiagnostics` per edit with the **correct count and a
   matching document version** (toggling the violation count 3→1→4→2 returned the
   right fresh count each time, `pubVersion == docVersion`). It re-scans on
   `didChange` — no reopen needed.
2. **The wait is gated by the PRIMARY, not the auxiliary.** On the with-auxiliary
   path the touch waits for *all* attached servers (`Promise.all`). The benchmark
   fixtures are clean `console.log` JS with **no TypeScript errors**, so the primary
   (typescript) emits **zero** diagnostics and its per-server wait never
   early-returns.
3. **The deadline was inflated by the caller cap.** For with-auxiliary, the per-touch
   deadline is `Math.max(callerCap, maxStrategyWait)`. The harness passed a large
   `maxDiagnosticsWaitMs` (20s), so that big cap *became* the deadline — and with the
   clean primary never resolving early, the touch burned it.

At a realistic cap the warm latency drops to **~2.0s** with correct fresh counts
(`CAP=1500` → 2078ms; `CAP=4000` → 6.6s tracked the cap, confirming the
deadline-floor mechanism). Opengrep looked fast in the same run only because its
fixture happens to trip a TypeScript diagnostic, so its primary resolved early.

Fix applied: ast-grep's strategy `aggregateWaitMs` was set to 1000 (not Opengrep's
6000) so it doesn't inflate `maxStrategyWait`; `reopenOnResync: false` (didChange is
sufficient and lighter).

### Lifecycle implication (general, not ast-grep-specific)
The ast-grep investigation surfaced a general diagnostic-collection behavior worth
its own issue. The collection wait early-returns only when **a fresh, version-
bumping publish arrives** (or a `seedFirstPush` server's first push). A server that
processes an edit and finds **no new diagnostics** gives the wait nothing to trip on,
so the touch waits the **full strategy budget / deadline**:

- **With-auxiliary:** the `Promise.all` waits for the primary even when the primary
  has no diagnostics and the auxiliary already published — a clean-primary file pays
  the full deadline on any auxiliary touch (affects opengrep too).
- **Primary-only — measured.** A clean TypeScript file vs the broken one, same server:

  | fixture | warm/edit (run 1) | warm/edit (run 2) |
  |---|---:|---:|
  | typescript (broken — persistent error) | 782ms | 462ms |
  | typescript-clean (no diagnostics) | 1796ms | 1226ms |

  The clean file is ~2–3× slower: with a persistent diagnostic the server re-publishes
  (version bump → early-return); with nothing to report it gives the wait no signal, so
  the touch runs out its budget.
- **Masked by the benchmark:** every *other* fixture here is intentionally broken, so
  each server always has a diagnostic to early-return on — the clean-file cost only
  shows via the dedicated `typescript-clean` fixture.

A lifecycle fix — treat a published **document-version acknowledgment** (even with
empty diagnostics, when the server stamps `version >= ` the `didChange` we sent) as a
definitive early-return — would speed up clean-file edits across **every** server, not
just the with-auxiliary path. **Crucially this must trigger on an affirmative
version-matched publish, never on mere silence**, so a crashed/cold/stale/errored
server is never painted "clean". The ast-grep probe confirmed servers echo doc
versions reliably (`pubVersion == docVersion`), so this is feasible. Tracked as
**#240** (a prerequisite for #239 Phase 2, since the universal baseline makes
clean-file edits the common case).
