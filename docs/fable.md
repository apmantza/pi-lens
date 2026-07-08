# Architecture observations — Fable, 2026-07-08

First-look assessment of pi-lens by Claude Fable 5 (fresh eyes, after reading
AGENTS.md, the source layout, the dispatch core, the engine seam, and the
entry point). Ranked by leverage; nothing here is urgent.

## Status update — end of day 2026-07-08

The write-path performance thread that grew out of this assessment shipped in
full, measurement-first (479 real edits from latency.log/cascade.log: mean
edit 6.4s, of which ~1.67s / 26% was the awaited cascade):

- **#450/#452 — cascade deferred off the write hot path.** The ~26% of every
  edit spent computing turn_end-only output now runs concurrently after the
  edit returns; settled at turn_end with a bounded wait + carry-over (a late
  compute survives `beginTurn`, never dropped). Watch `cascade_settle_wait`
  in latency.log for residual contention.
- **#453/#455 — micro batch.** ESLint autofix single-spawn (was dry-run+fix,
  double cold-start), parallel LSP codeAction lookups (~6× RTT off the
  blocking path), lsp-runner content reuse.
- **#454/#456 — logger consolidation SHIPPED** (item 3 below): all eight
  NDJSON loggers on one buffered async writer (`clients/ndjson-logger.ts`);
  no sync appendFileSync on the hot path; shared exit-flush.
- **#451/#457 — review-graph seq fast path.** The per-build O(project)
  walk+stat sweep (157ms p50 even on reuse) is skipped when coordinator seq
  state proves only pi-observed edits occurred; periodic re-verify (20
  builds/5 min) + kill switch `PI_LENS_GRAPH_SEQ_FASTPATH=0`. Watch
  `seqFastpathFallback` in cascade.log graph_build metadata for hit rate.
- **#449 filed** — multi-agent LSP resource sharing (registry → budget →
  same-root warm attach over the existing IPC seam; protocol multiplexing
  explicitly rejected). Strategic, not started.

Second wave (same day, evening):

- **#460/#390 → PR #463 MERGED** — per-server clean-signal probe (phase-aware
  4-way: 2 / 2\* / 3 / unknown) + the LSP-docs nightly commit-back that #390
  showed was missing (merge-don't-regress guard, auto-PR on
  `bot/lsp-docs-refresh`). Measured: typescript's clean silence is
  diagnostic-set-dependent (re-publishes while dirty, silent once clean —
  the production budget-wait case confirmed); opengrep/yaml are 2\*
  (version-less publish still resolves the wait — NOT #458 targets).
- **Filed:** #458 (learned clean-signal deadlines — the ~1–1.5s median win on
  clean TS edits; build AFTER dogfooding + first nightly matrix), #459
  (skip reverse-deps rebuild+write when the graph didn't change — quick),
  #462 re-scoped (slow-FS mode via latency probe, not mount-regex).

Dogfooding follow-up: after a few days, re-run the latency analysis to
confirm the p50 edit dropped from ~5.8s toward ~4.3s and check the two new
observability signals above; also check the first `bot/lsp-docs-refresh`
nightly PR behaves (populates ci columns, no row regressions).

Everything below is the original assessment; items 1, 2, and the smaller
observations (config-finder family, errorDebtBaseline, legacy-client
headers) remain OPEN, as does the strategic thread (#236).

## Overall

The discipline axis is unusually strong: invariants are documented with their
*why*, registries are guarded by consistency tests, the diagnostic model
insists on "affirmative clean, never silence," and blocked grammars are
guard-driven rather than hand-maintained. The recurring winning pattern:
**membership in a list is enforced by a check, not by memory.**

The real risks are structural concentration, not correctness.

## 1. `index.ts` is a ~2,250-line god-adapter that violates the seam rule

`clients/lens-engine.ts` is *the* seam and the MCP adapter obeys it; the pi
adapter doesn't (the engine header admits "index.ts can adopt incrementally").
Concretely, the `tool_call` handler spans roughly lines 1249–2097: ~850 lines
of read-guard preflight logic inline in the entry point — the most
safety-critical path (it mutates the agent's edits before they land), living
in the file that's hardest to unit-test.

**Suggested move:** extract the `tool_call` body into
`clients/runtime-tool-call.ts`, matching the existing `runtime-session` /
`runtime-tool-result` / `runtime-turn` pattern (the other three hooks already
made this move). Mechanical, low-risk, makes the autopatch pipeline directly
testable instead of only via its helpers.

## 2. The dual-artifact build is fenced, not fixed

TS compiles in-place to sibling `.js`, tests import `.js` specifiers, `dist/`
is a second compile, and staleness silently shadows source edits. Three fences
exist around this one hole: the vitest `globalSetup` freshness gate (#198),
the "build before test" working rule, and an AGENTS.md warning. Each fence is
a recurring tax.

**Root-cause option:** let vitest transform TS directly (native support) so
tests run against source; reserve compilation for `dist/` only. One-time
migration cost (import-specifier handling, plugin resolution), touches
everything — a deliberate project, not a drive-by. Worth a cost/benefit issue
even if the answer is "not yet."

## 3. `clients/` is a 121-file flat junk drawer

`dispatch/`, `lsp/`, `mcp/` are foldered; everything else sits at one level —
read-guard (6+ files), security scanners, project intelligence, and **eight
bespoke NDJSON loggers** (`cascade-logger`, `dead-code-logger`,
`read-guard-logger`, `latency-logger`, `tree-sitter-logger`,
`diagnostic-logger`, `actionable-warnings-logger`, `ast-grep-tool-logger`).

- **Loggers are the genuine consolidation target** — eight hand-rolled
  implementations of "append NDJSON, rotate at ~1 MiB." One
  `createNdjsonLogger(name, opts)` factory collapses them and centralizes
  rotation policy. Cheap, contained, real win.
- **The foldering itself ranks lower** — churny (every import path changes,
  open PRs conflict, concurrent worktree agent), and flat-but-well-named is
  livable. Do it opportunistically, not as a campaign.

## Smaller observations

- **Per-tool config finders are a copy-paste family**: `opengrep-config.ts`,
  `typos-config.ts`, `zizmor-config.ts` all implement "walk up looking for one
  of these filenames." A shared `findLocalToolConfig(cwd, names[])` would make
  the next auxiliary LSP a one-liner.
- **Dead plumbing**: `runtime.errorDebtBaseline` is never set in production
  (already flagged in AGENTS.md). Wire it or delete the green→red machinery —
  dormant features are expensive because they *look* load-bearing.
- **Legacy client classes** (`ruff-client`, `go-client`, `rust-client`, …)
  survived the #197 cull but their naming still implies they're the primary
  path. A one-line header comment on each ("legacy surface — hot path is
  `dispatch/runners/<x>`") is nearly free and stops contributors extending the
  wrong layer.
- **Deliberately not touching**: the hand-rolled MCP transport (the zero-dep
  rationale is sound), the dispatcher (1,038 lines but well-factored into
  named phases), and the auxiliary-LSP profile registry (recent additions
  slotted in cleanly — the sign of a good abstraction).

## Strategic thread with the highest leverage

Several capabilities are **built but not self-consumed** (also flagged in
AGENTS.md): the word index is paid for in every session scan but nothing
internal uses it; blast-radius is transitive BFS while the in-pi cascade is
still one-hop (#236, the "mirror into pi-lens" principle). That's financed
inventory earning nothing. Feeding transitive impact into cascade neighbor
selection is probably the highest-leverage *feature* work available — ideally
paired with the #202 structural-hash short-circuit so the expansion prunes
when a changed file's exported interface is unchanged.
