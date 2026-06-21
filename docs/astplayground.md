# ast-grep Playground Verifier

A headless-CDP tool that loads a rule into the official upstream [ast-grep
playground](https://ast-grep.github.io/playground.html) and reports back
what the playground's own engine sees. It is **a second opinion** against
the local `ast-grep scan` test, not a replacement for it.

```
scripts/playground-chrome.mjs       # headless Chrome lifecycle (port 9224)
scripts/playground-cdp.mjs          # minimal CDP driver (list, nav, eval)
scripts/playground-verify-rule.mjs  # the verifier CLI
```

## Why

The shipped rule set runs in two engines:

| Path | Engine | Source |
|------|--------|--------|
| ast-grep LSP (the live path) | upstream binary, auto-installed by `ensureTool` | the binary's `ast-grep` version may be ahead of `npx ast-grep@x` |
| ast-grep napi runner (fallback) | `@ast-grep/napi` npm package, version-pinned in `package.json` | can lag the binary by a release |

The CLI test in `tests/clients/dispatch/runners/ast-grep-catalog-rules.test.ts`
asserts what *our* local binary does. The playground verifier loads the same
rule into the **upstream web playground** (which always tracks the
released `ast-grep`), so we get a fresh-engine cross-check.

## What the playground actually does

The playground's source code is **fixed** — the user cannot inject custom
source via the URL hash. The URL hash only carries:

- `mode: "Config"` + `config: <rule YAML>` (the rule)
- `query` (an ast-grep pattern string, only used in `mode: "Pattern"`)

So this verifier is a **pattern-level smoke test**: "does the rule's
pattern fire on the playground's hardcoded sample source?" It catches:

- **YAML/pattern rejection** — the playground shows an error if the rule's
  YAML uses features the upstream engine doesn't support
- **Pattern-engine divergence** — local ast-grep matches but upstream
  doesn't (or vice versa)
- **Match-count drift** — `Found N match(es)` count differs between local
  and upstream

It does **not** catch rule-vs-source bugs where the source is what the user
wrote — the local CLI test is the source of truth for that.

## Usage

```bash
# Smoke-test a single rule (auto-launches headless Chrome on 9224, then kills it)
node scripts/playground-verify-rule.mjs rules/ast-grep-rules/rules/no-console-except-error.yml --code "ignored"

# Assert a specific match count
node scripts/playground-verify-rule.mjs rules/ast-grep-rules/rules/jsx-boolean-short-circuit.yml \
  --code "ignored" --expected 0

# Keep Chrome alive for follow-up runs (avoids the 5–10s cold-start cost)
node scripts/playground-verify-rule.mjs rules/ast-grep-rules/rules/no-console-except-error.yml \
  --code "ignored" --keep-chrome

# Audit all our shipped rules (uses the default source — no per-rule expectations)
node scripts/playground-verify-rule.mjs --all
```

### Output

JSON to stdout, e.g.:

```json
{
  "ok": true,
  "rule_id": "no-console-except-error",
  "language": "typescript",
  "matches": 3,
  "lines": [1, 2, 3],
  "fix": null,
  "engine_ms": 819
}
```

| Field | Meaning |
|-------|---------|
| `ok` | `true` if the rule loaded and the playground produced a count. `false` if `--expected` was set and the count didn't match. |
| `matches` | Count from the playground's `Found N match(es)` text (or `0` for `No match found`) |
| `lines` | Source-line numbers painted in the playground's gutter (best-effort; empty if the playground changed its DOM) |
| `fix` | The rule's `fix:` field, echoed for convenience |
| `engine_ms` | Wall time of the verifier (not the engine). For `--keep-chrome` runs, this is dominated by page load. |

### Exit codes

| Code | Meaning |
|------|---------|
| `0` | Success, or no `--expected` set |
| `1` | `--expected N` set and the count didn't match |
| `2` | Setup error (rule unreadable, source missing, Chrome not on PATH) |
| `3` | Engine / page error (timeout, JS eval threw, Chrome failed to launch) |

## Environment

| Env | Default | Meaning |
|-----|---------|---------|
| `PILENS_PLAYGROUND_CHROME` | auto-detect | Path to `chrome.exe` (set this if Chrome is installed in a non-standard location) |
| `PILENS_PLAYGROUND_PORT` | `9224` | CDP port (chosen to avoid GreedySearch's `9222` and the user's main Chrome on `9223`) |
| `PILENS_PLAYGROUND_KEEP` | unset | If set, `playground-chrome.mjs kill` leaves the profile dir in place (useful for debugging) |

## How it works

```
┌─────────────────────────────────────┐
│ playground-verify-rule.mjs          │  (CLI entrypoint)
│ - reads rule YAML                   │
│ - builds base64-encoded URL hash    │
│ - shells out to playground-cdp.mjs  │
└────────────┬────────────────────────┘
             │  spawn (per CDP call)
             ▼
┌─────────────────────────────────────┐
│ playground-cdp.mjs (per command)    │  (one-shot Node process)
│ - opens WebSocket to Chrome         │  exits hard to avoid the
│ - sends CDP message, awaits reply   │  Node.js 30s close-handshake
│ - prints stdout, exits              │  hang on Windows
└────────────┬────────────────────────┘
             │  CDP (Chrome DevTools Protocol)
             ▼
┌─────────────────────────────────────┐
│ Headless Chrome (port 9224)         │  isolated profile:
│ - profile: <tmpdir>/                │  <tmpdir>/pilens-playground-profile/
│     pilens-playground-profile/      │
│ - owned by playground-chrome.mjs    │
└─────────────────────────────────────┘
```

Three scripts, one job each:

- `playground-chrome.mjs` — launches a dedicated headless Chrome with an
  isolated profile (does not touch the user's main Chrome on 9223, nor
  GreedySearch's Chrome on 9222). Adopted from
  [GreedySearch-pi's](https://github.com/apmantza/GreedySearch-pi) `launch.mjs`
  with the port and profile dir changed.
- `playground-cdp.mjs` — a minimal CDP driver. Just `list`, `newpage`,
  `nav`, `eval`, `snap`. Adopted from `cdp.mjs` with the daemon, target
  resolution, accessibility tree, and network tracing stripped out.
- `playground-verify-rule.mjs` — the CLI the user invokes. Reads the rule,
  builds the playground URL, runs the page through CDP, scrapes the
  result, prints JSON, kills Chrome.

## Skipping the test

`tests/clients/dispatch/runners/ast-grep-playground-verify.test.ts` is
auto-skipped when Google Chrome is not on `PATH` and
`PILENS_PLAYGROUND_CHROME` is unset. No CI noise.

## Performance

- **First run** (cold start, no Chrome): ~11s. The first paint of
  ast-grep.github.io is the dominant cost (Docusaurus + VitePress SPA
  with heavy JS bundles).
- **Subsequent runs** (Chrome already on 9224): the first call still
  reuses Chrome (~1.5s for the CDP attach + load + scrape). With
  `--keep-chrome`, multiple `playground-verify-rule.mjs` invocations
  share the same Chrome process.
- The verifier does **not** parallelize — it's a single-rule smoke test.
  For batch audits, run `--all` (TODO) or script the loop yourself.

## Known limitations

- **Source is fixed.** The playground uses its own hardcoded sample
  source. Custom source code passed via `--code` is ignored by the
  upstream playground in `mode: "Config"`. This is by design — the
  playground is a manual tool, not a test harness.
- **Slow.** ~11s per rule. Don't enable in the default `npm test` run.
- **Line numbers are best-effort.** The playground's gutter layout
  changes between builds. If the line-extraction JS misses, `lines` is
  empty but the count is still correct.
- **Headless Chrome only.** Visible mode would let a human watch the
  run, but the verifier has no use for it.
