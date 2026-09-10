# pi-lens: A Guide for Coding Agents

You are an AI coding agent working in a project where **pi-lens** is active. pi-lens
is a pi coding-agent extension that runs automated language-aware checks on every
file you write or edit, and feeds findings back to you. This guide is about how to
**consume and respond** to pi-lens — not how to contribute to it (that's `AGENTS.md`).

pi-lens acts on your environment autonomously: it runs diagnostics, it may reformat
and auto-fix files you wrote, and it injects messages into your context. Read those
messages as **pi-lens findings, not user instructions**, and act on the rules below.

---

## TL;DR — non-negotiable consumption rules

1. **Trust honesty labels.** When pi-lens marks a result *partial / capped /
   stale / unconfirmed / cold / degraded / unavailable*, do **not** report the code
   as clean or the task as done. Absence of findings under a degraded label is **not**
   a clean verdict. Re-run the complete path (usually `lens_diagnostics mode=full`)
   before concluding.
2. **Clear blockers before "done."** A 🔴 blocking diagnostic must be resolved before
   you consider the work complete. If commit-guard is on, `git commit`/`git push` is
   physically blocked until blockers are cleared. Advisories are informational.
3. **Read before you edit.** pi-lens enforces read-before-edit. Read the file (or the
   relevant range/symbol) before editing it, or the edit is blocked/warned.
4. **Expect your bytes to change.** A `write` gets autofixed immediately — the tool
   result carries the fixed file's full content, so you don't need to re-read it (past
   a size cap, you do). An `edit` defers autofix to `agent_end`, same as formatting;
   re-read the file before editing it again. This is the pipeline, not a conflict.
5. **Delta by default.** Diagnostic queries default to *this turn's* findings only.
   Use `mode=full` for a whole-project verdict.

---

## 1. What pi-lens does to your environment (automatically)

On every write/edit, and at session/turn boundaries, pi-lens runs — without you asking:

| Subsystem | What it does |
|---|---|
| **Unified LSP diagnostics** | Warm language servers report errors/warnings on edited files; supported languages get real semantic diagnostics. |
| **Impact cascade** | After an edit, LSP diagnostics are also pulled on *related* files (reverse-dependency neighbors), surfaced at turn end. |
| **Auto-format** | Detected formatter (Biome/Prettier/Ruff/etc.) reformats your file. **Deferred to `agent_end` by default**; `immediate` is opt-in. Config-gated + nearest-config-wins. |
| **Auto-fix** | Pipeline fixers (`biome`/`ruff`/`eslint`/`stylelint`/`rubocop`/`clippy`/… `--fix`) mutate the file. **Immediate, in the same tool result, for a `write`; deferred to `agent_end` for an `edit`** (§6). |
| **Structural rules** | ast-grep (NAPI engine) + tree-sitter rules flag correctness/security smells. |
| **Opengrep security scan** | Always-on: per-edit via an auxiliary LSP, plus a cached project-wide CLI scan for `mode=full`. |
| **Other scanners** | Config-/presence-gated: gitleaks (secrets), trivy (CVEs/IaC/license), govulncheck (Go), knip/jscpd/madge (JS/TS dead-code/dupes/cycles), vulture (Python), zizmor (GH Actions), typos. |
| **Test-runner-on-write** | Related/affected tests are run asynchronously for the next turn's findings (edit-scoped, not a full-suite run). Integration/e2e tests are never auto-fired — see below. |
| **Read-guard** | Tracks that you read a file before editing it; blocks/warns zero-read or stale-range edits. |
| **Context injection** | Injects session-start guidance and turn-end findings into your context (see §2). |

**Test-runner-on-write scope.** A built-in exclusion list keeps integration/e2e
suites out of the auto-fired batch — `**/integration/**`, `**/e2e/**`,
`**/*.integration.*`, `**/*.e2e.*` — since those commonly spawn external
processes (another CLI, a browser, a live provider) that don't belong on an
unattended per-edit turn. This is a fixed, built-in list; there is no
per-project config knob for it. If a runner itself fails to complete (a
timeout, or a missing provider/binary — not a failing assertion), pi-lens
delivers it as an advisory ("could not complete last turn"), not as a
"fix before continuing" blocker — you didn't introduce anything to fix.

You don't invoke these. They happen. Your job is to **read the results** and **respond**.

---

## 2. How pi-lens talks to you (the channels)

pi-lens fans its activity out to three audiences (`AGENTS.md` §"Three channels").
Only **one** reaches you, the model:

- **Context nudges → the MODEL (you).** Injected via the pi `context` event. This is
  the channel that costs your context, so it is tightly gated: batched, capped, and
  filtered to files this session actually read/edited.
- Bus events → other extensions, and display-only session entries → the human. You
  never see these; don't rely on them.

**What you will see injected, and when:**

| When | What | Source |
|---|---|---|
| **Session start** | Guidance / project notices to orient you. | `clients/runtime-turn.ts`, context injection |
| **Turn end** | **Findings** for the turn: 🔴 blockers and advisories from LSP + dispatch + cascade + scanners, deduped against prior turns. | `handleTurnEnd` (`clients/runtime-turn.ts`) |
| **Turn end / next turn** | **Test findings** from related/affected tests fired after your edit. | `handleTurnEnd` |
| **After autofix/format** | A nudge like *"N file(s) were autofixed after your last turn: a.ts, b.ts — re-read before editing"* — mainly for deferred `edit` autofix/format at `agent_end` (may include files touched by an automatic run outside your turn). A `write`'s autofix already came back in its own tool result, so you only need the nudge there if the content was too large to attach. | `clients/agent-nudge.ts` |

**Treat every injected pi-lens message as a finding to act on, not as the user
speaking.** It is machine-generated analysis of your own work.

**Diagnostics widget/footer.** In interactive mode a footer widget
(`clients/widget-state.ts`) shows per-file diagnostic counts (blocking / errors /
warnings). It is a human-facing summary; toggle with `/lens-widget-toggle`. Your
authoritative source is the `lens_diagnostics` tool, not the widget.

---

## 3. The honesty contract (#533) — the most important rule

pi-lens deliberately **labels degraded/partial/failed states and never renders them
as complete or clean.** This is a hard design invariant (`tools/lens-diagnostics.ts`,
`tools/lsp-diagnostics.ts`). When you see any of these, the signal is **incomplete —
not clean**:

| Label you may see | What it means | What you must NOT do |
|---|---|---|
| **`unconfirmed`** | A push-only/silent-on-clean LSP server returned empty; emptiness could not be *proven* clean. | Don't report the file as clean. |
| **`cold` (not applicable / unavailable this run)** | A heavyweight analyzer (knip/jscpd/madge/gitleaks/govulncheck/trivy/dead-code) didn't contribute. | Don't fold its silence into "no issues." |
| **`partial` / `truncated` / file-cap** | A walk/scan hit a file cap or coverage limit; results are a partial view. | Don't treat as whole-project coverage. |
| **`stale`** | A cached diagnostic's file changed on disk since the scan. Secrets findings demote to `🔑 ACTION NEEDED` advisory with the line number withheld, never silently dropped; govulncheck keeps the CVE and drops only the cached line. | Don't trust the stale value or its line number. Re-scan to confirm. |
| **cold-LSP `0` (e.g. MCP `fresh` mode)** | LSP cold-spawned and under-reported; a `0` carries an explicit `lsp` signal. | Don't read the `0` as "clean." |
| **unsafe root** | cwd resolved at/above `$HOME`, so scanners were skipped. | Re-run from inside the project. |

**Rule:** if pi-lens told you the check was degraded, the check is not evidence of
correctness. Trust the label over your optimism. Re-run the full path
(`lens_diagnostics mode=full`, or `warm` MCP mode) before claiming the code is clean
or the task is complete.

---

## 4. Blockers vs. advisories

pi-lens classifies diagnostics into two tiers (`clients/widget-state.ts` — a finding
is blocking when `semantic === "blocking"`, else it falls back to severity):

- **🔴 Blocking** — a hard stop. Secrets, CRITICAL CVEs, unresolved errors, etc.
  **Resolve every blocker before you consider the work complete.**
- **🔑 ACTION NEEDED** — a third tier, distinct from both: a secrets finding
  whose cached file changed since the scan. It does not gate commit-guard like
  a blocker does, but it is not "no action required" like an advisory either —
  the finding is unverified, not dismissed. Re-run a secrets scan to confirm
  or clear it.
- **Advisory** — informational (🟡 warnings, 📜 license notes, style/hygiene).
  Address when relevant; they do not gate completion.

**Commit/push guard (`--lens-guard`).** When the `lens-guard` flag is on, pi-lens
intercepts `git commit` / `git push` (`clients/git-guard.ts`) and **blocks** it while
unresolved blockers exist, with:

> `🔴 COMMIT BLOCKED (--lens-guard): unresolved blockers must be fixed before
> commit/push. … Run lens_diagnostics mode=all for full details, then commit again.`

Don't try to route around it — clear the blockers, then commit. The guard is strictly opt-in (off by default) and is marked **EXPERIMENTAL**. It gates only structured blocking findings, including blocking test failures under the current test-runner policy; advisory/no-action-required findings never gate. The blocker state is sequence- and session-bound, so an ambiguous or stale blocker record blocks conservatively until pi-lens runs again; advisory records never gate.

---

## 5. Read-before-edit (read-guard)

pi-lens monitors that you **read a file before editing it** (`clients/read-guard.ts`).
Edits fail or warn when:

1. **Zero-read** — you never read the file this conversation.
2. **Stale** — the file changed on disk since you read it (content-hash checked).
3. **Out-of-range** — your edit target wasn't covered by any read.

A blocked edit returns a retryable message, e.g.:

```text
🔄 RETRYABLE — Edit without read: you have not read `<file>` in this
conversation. Read it first, then retry: `read path="<file>"`.
```

**Correct behavior:** read the file (or the relevant range/symbol) *before* editing.
Helpful mechanics you can rely on:

- **Coverage accumulates** across reads — two reads (lines 1–100 and 101–200) together
  cover a full-file write.
- **Symbol expansion** — small reads (≤ ~60 lines) are silently widened to the
  enclosing function/method/class, and coverage is recorded at symbol level.
- `read_symbol` / `read_enclosing` reads count as edit coverage for that symbol range.
- Markdown warns instead of blocking; `.txt`/`.log` are exempt.
- Escape hatch (human): `/lens-allow-edit <path>` arms one exemption.

---

## 6. Auto-format / auto-fix timing — don't be surprised

pi-lens writes to files **outside your own tool calls** (`docs/features.md`
§"Bus Events — `pilens:files:touched`"). Where and when depends on which tool you used
(`clients/pipeline.ts`, `clients/runtime-tool-result.ts`,
`clients/runtime-agent-end.ts`):

- **`write` (including a new file, and bash-authored writes like `sed -i` or a
  redirect):** pipeline auto-fix (`biome`/`ruff`/`eslint`/… `--fix`) still runs
  *immediately*, in the same tool result — nothing changed here. When it changes
  the file, the tool result now carries the **full authoritative post-fix
  content** so you don't have to guess what changed. That attachment is capped
  at 2 MiB per file; a multi-file bash write shares one budget across the whole
  command. Past the cap, you get the old-style *"File was modified — re-read
  before editing"* warning instead.
- **`edit`:** pipeline auto-fix is *deferred* to `agent_end`, same as
  formatting. It joins the same per-file queue as deferred formatting, one fix
  applied against the final edited state (not once per edit), autofix draining
  before format so the result is formatter-stable. Diagnostics computed at edit
  time reflect the *unfixed* disk state — a lint finding that autofix would have
  cleared may show up and then quietly disappear once `agent_end` drains.
- **`write` then `edit` on the same file, same turn:** the write's autofix
  demotes to deferred too, so the file's mutation history stays coherent. This
  resets at the next turn.
- **Any other tool that edits a file:** pi-lens recognizes it by the SHAPE of
  its arguments rather than its name (`clients/mutating-tool.ts`), so a host or
  extension tool called `replace` or `insert` gets the same chain `edit` gets:
  a turn-state entry, a change-log receipt attributed to that tool, and a
  *deferred* auto-fix. Its lines are resolved when the anchor is unambiguous
  (roughly two-thirds of anchors in practice — `clients/hashline-anchor.ts`);
  otherwise the mutation is recorded whole-file with lines unknown, and the
  read-before-edit guard takes its no-line-info arm rather than guessing.
  Deferred is the default for every edit-shaped tool pi-lens cannot place,
  because formatting between the steps of a multi-call rewrite fights the tool
  that is still writing.
- **A tool whose shape is unrecognized too:** pi-lens watches instead of
  guessing (`clients/observed-mutation.ts`). A call that names a file gets a
  bounded pre/post snapshot of THAT PATH — the file itself, or a directory's own
  entries — and nothing else, so a write landing on a neighbouring file is never
  attributed to it. Anything that changed is replayed through the same chain,
  and the tool is then remembered as mutating: for this session on the first
  sighting, persisted under the project's data directory on the second, so a
  later session classifies it by name with no snapshot at all. Three quiet
  observations in a row withdraw a session attribution again, and a withdrawn
  tool can be learned back from a later real edit. An observation pi-lens could
  not finish — a directory with more entries than it watches — counts as
  neither, so a wide codemod is never written off on a look it never took. A
  call that names
  no file is caught at `agent_settled` by an incremental content check over the
  files pi-lens has already read, written, diagnosed or opened on a language
  server — a rotating window per turn, reading only what actually moved; a file
  it has never seen has no baseline, so that last-resort net does not cover it,
  and a file it cannot verify is reported as such rather than reformatted on a
  timestamp alone.
- The conservative actionable-warnings autofix (LSP quickfixes, hard-capped)
  is unchanged: it always runs at `agent_end`.

**Extension authors: record your own writes.** If your extension writes files
outside pi-lens's tool events — its own registered tool, a spawned rewriter —
tell pi-lens through the in-process mutation bridge, the write-side sibling of
the read bridge:

```js
const bridge = globalThis[Symbol.for("pi-lens:mutation-bridge")];
if (bridge?.version === 1) {
  bridge.recordMutation({
    filePath,               // absolute path
    kind: "edit",           // "write" replaces the whole file; "edit" is partial
    editRanges: [[12, 18]], // optional, 1-based inclusive
    consumer: "my-extension",
  });
}
```

Check `version` before calling; a version you do not recognize is unsupported.
Calling when pi-lens is absent or the guard is disabled is safe — the bridge is
missing or drops the call. `recordMutation` returns `true` when pi-lens took the
record and `false` when it dropped it, so you can count your own drops. pi-lens's
own `ast_grep_replace apply:true` records through this same bridge.

Consequences for you:

- Your exact written bytes may be reformatted/fixed. **This is expected pipeline
  behavior, not a conflict or a failed write.**
- **`write`:** trust the authoritative content attached to the tool result; only
  re-read if you see the size-cap warning, or if a *different* file (a side
  effect of the same bash command) was touched.
- **`edit`:** the file may change on disk after your turn ends. **Re-read before
  editing it again** (this also keeps the read-guard happy — the autofix nudge
  tells you which files changed).
- **Delta mode:** `lens_diagnostics` shows only diagnostics *introduced this turn* by
  default (`mode=delta`). Use `mode=all` (cache-wide) or `mode=full` (fresh scan) for
  the complete picture.

See `AGENTS.md`'s "Per-edit autofix mutation boundary (#1414)" invariant for the
authoritative routing rules.

---

## 7. Tools & commands you can use

### Agent tools (call these while working in pi)

Registered as pi agent tools. Verified names:

| Tool | What it does | Use it to… |
|---|---|---|
| `lens_diagnostics` | Session-cache or LSP-probe diagnostics with `source` and `scope` selectors. | Use `source=lsp` with `scope=paths` for targeted checks; an empty cache is not proof of clean. |
| `lsp_navigation` | LSP navigation (definition/references/etc.). | Trace symbols semantically. |
| `symbol_search` | Ranked identifier search over the warm word index (BM25 + priors). | Entry point of the discovery funnel. |
| `module_report` | Navigable outline + signatures + decorators + imports + callbacks for a file; optional `blastRadius`. | Understand a module without reading the whole body. |
| `read_symbol` | Verbatim body of one symbol/callback handle (records read-guard coverage). | Read exactly the symbol you'll edit. |
| `read_enclosing` | Smallest enclosing symbol/callback body for a file+line (records coverage). | Bridge a diagnostic location → exact body. |
| `project_report` | Project-level structural report. | Orient in an unfamiliar project. |
| `ast_grep_search` / `ast_grep_replace` | Structural AST search / replace. | Find or rewrite by code shape, not regex. |
| `ast_grep_outline` / `ast_grep_search` (`dump=true`) | Outline / AST dump. | Inspect structure. |
| `lens_diagnostic_mark` | Mark a finding false-positive / suppressed / deferred / flagged-to-fix (honored across surfaces). | Triage a finding you've judged. |

Funnel discipline: **`symbol_search` → `module_report` → `read_symbol`/`read_enclosing`**
(find candidates → explain one → read the body).

### Slash commands (human-facing; ask the user to run, or run if you drive pi)

Verified in `index.ts`:

| Command | What it does |
|---|---|
| `/lens-toggle` | Turn pi-lens on/off for the session. |
| `/lens-context-toggle` | Toggle context injection (tools/LSP/read-guard/formatting stay active). |
| `/lens-widget-toggle` | Show/hide the diagnostics footer widget. |
| `/lens-health` | Runtime health: pipeline crashes, slow runners, last dispatch latency, and a bounded degradation-ledger summary (trust refusals, LSP breakers, formatter skips/failures, idle evictions, WASM aborts, timeout tallies). |
| `/lens-perf` | Slowest latency-log phases (p50/p99). |
| `/lens-tools` | Tool installation status (global / auto-installed / npx fallback). |
| `/lens-tdi` | Technical Debt Index and project health trend. |
| `/lens-map` | Render an interactive HTML dependency map to disk. |
| `/lens-allow-edit <path>` | Arm a one-time read-guard exemption. |

### If you are an MCP client (e.g. Claude Code), not running inside pi

pi-lens is also an MCP server. The same capabilities are mirrored under a `pilens_`
prefix: `pilens_diagnostics`, `pilens_analyze`, `pilens_module_report`,
`pilens_symbol_search`, `pilens_read_symbol`, `pilens_read_enclosing`,
`pilens_project_report`, `pilens_project_scan`, `pilens_lsp_navigation`,
`pilens_ast_grep_search`/`pilens_ast_grep_replace`,
`pilens_session_start`/`pilens_turn_end`, `pilens_health`, `pilens_latency`,
`pilens_rebuild` (source checkouts only). Note MCP has **no read-guard** — mirror reads
don't record edit coverage. Prefer the **warm** review path; MCP `fresh` mode
cold-spawns the LSP and honestly under-reports it (never a silent clean `0`).

---

## 8. Config knobs that affect your experience

Details live in the settings references — see [`./settings.md`](./settings.md) and
[`./globalconfig.md`](./globalconfig.md). The ones most likely to change how pi-lens
behaves around you:

| Knob | Effect |
|---|---|
| `--no-lens-context` / `contextInjection.enabled=false` / `PI_LENS_NO_CONTEXT_INJECTION=1` / `/lens-context-toggle` | Disables **injected context** (session-start guidance, turn-end & test findings) while keeping tools, LSP, read-guard, and formatting active. Useful in cache-sensitive sessions — findings are still queryable via `lens_diagnostics`. |
| `lens_diagnostics mode=` | `delta` (default) vs `all` vs `full` — controls scope of the diagnostic verdict. |
| `format.mode` | `deferred` (default) vs `immediate` auto-format timing. |
| `format.enabled` / `autofix.enabled` / `actionableWarnings.autoFix.enabled` | Disable specific mutation paths (per-project, closest-wins) without disabling diagnostics. |
| `--lens-guard` | Enables the commit/push blocker (§4). |

Disabling context injection is the right move when you want pi-lens's LSP/format/tools
but not the context cost — you then **pull** findings with `lens_diagnostics` instead
of having them pushed.
