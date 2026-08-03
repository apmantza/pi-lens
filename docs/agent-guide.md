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
4. **Expect your bytes to change.** pi-lens formats and auto-fixes files *after* your
   write, by default at turn/agent end. This is the pipeline, not a conflict. Re-read
   a file before editing it again.
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
| **Auto-fix** | Pipeline fixers (`biome`/`ruff`/`eslint`/`stylelint`/`rubocop`/`clippy`/… `--fix`) mutate the file after your write. |
| **Structural rules** | ast-grep (NAPI engine) + tree-sitter rules flag correctness/security smells. |
| **Opengrep security scan** | Always-on: per-edit via an auxiliary LSP, plus a cached project-wide CLI scan for `mode=full`. |
| **Other scanners** | Config-/presence-gated: gitleaks (secrets), trivy (CVEs/IaC/license), govulncheck (Go), knip/jscpd/madge (JS/TS dead-code/dupes/cycles), vulture (Python), zizmor (GH Actions), typos. |
| **Test-runner-on-write** | Related/affected tests are run asynchronously for the next turn's findings (edit-scoped, not a full-suite run). |
| **Read-guard** | Tracks that you read a file before editing it; blocks/warns zero-read or stale-range edits. |
| **Context injection** | Injects session-start guidance and turn-end findings into your context (see §2). |

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
| **After autofix/format** | A nudge like *"N file(s) were autofixed after your last turn: a.ts, b.ts — re-read before editing"* (may include files touched by another pi-lens instance, e.g. a subagent). | `clients/agent-nudge.ts` |

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
| **`stale`** | A cached diagnostic's file changed on disk since the scan. | Don't trust the stale value. |
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

> `🔄 RETRYABLE — Edit without read … Read the file first, then retry the edit:
> read path="<file>"`

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
§"Out-of-band file writes"):

- **Deferred format** at `agent_end` (default) reformats files you wrote this run.
- **Auto-fix** (`biome`/`ruff`/`eslint`/… `--fix`) and the conservative
  actionable-warnings autofix (LSP quickfixes, hard-capped) mutate files after the fact.

Consequences for you:

- Your exact written bytes may be reformatted/fixed. **This is expected pipeline
  behavior, not a conflict or a failed write.**
- A file you wrote last turn may have changed on disk. **Re-read before editing it
  again** (this also keeps the read-guard happy — the autofix nudge tells you which
  files changed).
- **Delta mode:** `lens_diagnostics` shows only diagnostics *introduced this turn* by
  default (`mode=delta`). Use `mode=all` (cache-wide) or `mode=full` (fresh scan) for
  the complete picture.

---

## 7. Tools & commands you can use

### Agent tools (call these while working in pi)

Registered as pi agent tools. Verified names:

| Tool | What it does | Use it to… |
|---|---|---|
| `lens_diagnostics` | Query pi-lens diagnostic state. `mode=delta` (default, this turn) / `mode=all` (cache-wide) / `mode=full` (fresh whole-project scan). Optional `paths` scope. | Check what pi-lens found; confirm clean before "done" (use `mode=full`). |
| `lsp_diagnostics` | LSP diagnostics for explicit files/dirs (per-file `clean`/`unavailable`/`unconfirmed`/… outcomes). | Targeted LSP check on specific files. |
| `lsp_navigation` | LSP navigation (definition/references/etc.). | Trace symbols semantically. |
| `symbol_search` | Ranked identifier search over the warm word index (BM25 + priors). | Entry point of the discovery funnel. |
| `module_report` | Navigable outline + signatures + decorators + imports + callbacks for a file; optional `blastRadius`. | Understand a module without reading the whole body. |
| `read_symbol` | Verbatim body of one symbol/callback handle (records read-guard coverage). | Read exactly the symbol you'll edit. |
| `read_enclosing` | Smallest enclosing symbol/callback body for a file+line (records coverage). | Bridge a diagnostic location → exact body. |
| `project_report` | Project-level structural report. | Orient in an unfamiliar project. |
| `ast_grep_search` / `ast_grep_replace` | Structural AST search / replace. | Find or rewrite by code shape, not regex. |
| `ast_grep_outline` / `ast_grep_dump` | Outline / AST dump. | Inspect structure. |
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
| `/lens-health` | Runtime health: pipeline crashes, slow runners, last dispatch latency. |
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
`pilens_lsp_diagnostics`, `pilens_ast_grep_search`/`pilens_ast_grep_replace`,
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
