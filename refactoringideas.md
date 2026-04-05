# Refactoring Ideas for pi-lens

---

## Feature Gap Assessment: Real-Time Agent Feedback

*Assessed 2026-04-05 against 3.7.0 codebase.*

---

### 1. The Silence Problem — "All Clear" Confirmation Signal

**Priority: High | Complexity: Low**

**Gap:** When the pipeline runs clean, `index.ts` executes `if (!output) return` — the agent
gets nothing back. It cannot distinguish "I ran all checks and everything is fine" from "the
runner was skipped / errored silently". Agents currently move forward on faith, not confirmation.

**Fix:** Emit a brief positive summary whenever the pipeline completes with no blockers:
```
✓ TypeScript clean · ✓ tests pass (12/12) · ✓ no secrets · 3 runners · 847ms
```
Only suppress this when the tool is non-file-writing (read, bash, etc.) — not on edit/write.

**Implementation:** In `pipeline.ts` `runPipeline()`, when `output` is empty, assemble a
one-liner from the phases that actually ran: dispatch runner statuses, test result, format
changed flag. Already have all this data in `PipelineResult`. ~50 lines.

**Controlled by:** `--no-all-clear` flag or config key for agents that find it noisy.

---

### 2. Batch / Transaction Mode — Suppress Mid-Refactor Noise

**Priority: High | Complexity: Medium**

**Gap:** When an agent refactors across 5 files in one turn (rename a type, update all callers),
each write fires the pipeline independently. After file 2, the LSP sees 3 unresolved
references and reports blocking errors — even though the agent is mid-refactor and will fix
them in the next 3 writes. These intermediate errors derail agents.

**Existing hook:** `turn_end` already collects all written files and runs jscpd/madge as a
batch. The scaffolding is there.

**Fix (two-part):**
1. **Cascade diagnostics** (other files with errors) → defer to `turn_end`, not per-write.
   These are the noisiest mid-refactor. Already isolated in the `cascade_diagnostics` phase.
2. **LSP errors on the *edited* file itself** → keep immediate (real errors the agent made).
   LSP errors on *other* files (callers, importers) → defer.

**Implementation:** Track `pendingCascadeDiagnostics` in turn state, flush at `turn_end`.
`pipeline.ts` already has `ctx.cwd` and `cacheManager` to write turn state. ~100 lines.

**Risk:** Agents that write a file and immediately expect cross-file feedback might miss it.
Document clearly: "cascade errors flush at end of turn, not per-write."

---

### 3. Build Verification — Beyond LSP Type-Checking

**Priority: Medium | Complexity: Low-Medium**

**Gap:** LSP does incremental type-checking but misses full-project build errors: tsconfig
path aliases that LSP resolves but `tsc` rejects, Rust proc-macros, Go build tags, missing
generated files. Agents have shipped "LSP-clean" code that fails `cargo build`.

**Per-language runners to add:**
- `cargo check` (Rust) — faster than `cargo build`, catches all type/borrow errors. Already
  have `rust-client.ts`; add as an optional dispatch runner triggered only when `.rs` written.
- `go build ./...` (Go) — 1-3s, catches missing imports, build tags. Complement `go-vet`.
- `tsc --noEmit` (TypeScript) — only worth running when LSP is NOT active (`--lens-lsp`
  already covers this via `ts-lsp` runner); could be the fallback when no LSP.

**Implementation:** New runners `cargo-check.ts` and `go-build.ts` in `dispatch/runners/`.
`cargo check` output is already parseable (same format as `cargo clippy`). Gated behind
file-kind detection — only fires on `.rs` / `.go` files.

---

### 4. Coverage Signal — Did New Code Get Tested?

**Priority: Low-Medium | Complexity: Medium-High**

**Gap:** The test runner says pass/fail. It doesn't say whether the agent's newly written
code was actually exercised. An agent can write a function, write a test that imports but
doesn't call it, watch it pass, and think it's covered.

**Constraint:** Coverage runs require instrumentation (`--coverage`) which adds 2-5× overhead
to the test step. Unacceptable for the default per-write pipeline.

**Viable approach:** Run coverage only when:
- Tests fail (to show *which* branches are untested) — already bad news, overhead acceptable.
- On demand via flag `--lens-coverage`.
- At `turn_end` only (not per-write).

**Implementation:** Pass `--coverage --reporter=json` to vitest/jest, parse
`coverage/coverage-summary.json`, emit "new function `processPayment` has 0% coverage" if
the edited function's line range is uncovered. Requires correlating edit location with
coverage map — non-trivial but doable with the line-range data already tracked in pipeline.

---

### 5. Agent-Specific Anti-Patterns

**Priority: High | Complexity: Low (stubs) → Medium (TODOs) → High (imports)**

**Gap:** Agents have failure modes that no standard linter targets:

**5a. Stub detection** — agents scaffold then forget to implement:
```typescript
throw new Error("not implemented");
throw new Error("TODO");
pass  # Python
raise NotImplementedError
```
AST-grep rule catches all of these in <10ms. Already have the `ast-grep-napi` runner.
Add as a new rule in `rules/ast-grep-rules/` with `semantic: "warning"`. **~20 lines.**

**5b. Stale TODOs from this turn** — agent adds `// TODO: handle error` as a placeholder,
finishes the turn, never resolves it. Turn state already tracks written files; scan them
at `turn_end` for TODOs added since baseline. Delta-mode already has the baseline mechanism.
**~50 lines.**

**5c. Hallucinated API detection** — agent imports `stripe.createPaymentIntentV2()` which
doesn't exist. LSP catches this for TS/Python if the package is installed. The gap is when
the package isn't installed (agent hallucinated the whole dep). Dependency-checker.ts already
exists — cross-reference new imports against installed packages. **Medium complexity.**

---

### 6. Dependency Hygiene on Edit

**Priority: Low-Medium | Complexity: Low**

**Gap:** When an agent edits `package.json` or `requirements.txt`, no feedback on whether
the new dependency is deprecated, has a known CVE, or doesn't exist on the registry.

**Existing asset:** `clients/dependency-checker.ts` already exists. Unclear if it runs
automatically on `package.json` writes — likely only on demand.

**Fix:** In the pipeline, when `filePath` ends with `package.json` or `requirements.txt`,
trigger `dependency-checker` as part of dispatch. Gate behind file-kind check.
`npm audit --json` and `pip-audit --json` both produce structured output.

**Constraint:** `npm audit` takes 2-5s (network call). Run async / non-blocking, report
at turn_end rather than inline. Or run only when new dependencies are detected (diff
the file against baseline to detect added deps, skip if no new entries).

---

## Summary Table

| Idea | Priority | Complexity | Lines est. | Notes |
|------|----------|------------|-----------|-------|
| All-clear signal | High | Low | ~50 | Do next |
| Batch/cascade defer | High | Medium | ~100 | Needs turn_end integration |
| Agent anti-patterns (stubs) | High | Low | ~20 | AST-grep rule, easy win |
| Agent anti-patterns (TODOs) | High | Low | ~50 | Delta-mode already exists |
| Build verification (cargo/go) | Medium | Low | ~80/runner | New runners |
| Dependency hygiene | Low-Med | Low | ~40 | Wire existing checker |
| Coverage signal | Low-Med | High | ~200 | Turn-end only, complex |
| Hallucinated imports | Low | High | ~150 | LSP covers most cases |

---

## /lens-booboo Tools: Real-Time Promotion Assessment

*Which booboo-only tools should move into the per-write pipeline?*

---

### Complexity Metrics — NO, keep in booboo only

**Current:** booboo-only (`ComplexityClient.analyzeFile(filePath)`)  
**Assessment: Not actionable for agents in real-time**

`analyzeFile` is fast (<5ms, pure in-memory), so the cost argument is fine. The problem
is that agents almost never reduce complexity unprompted mid-task. If the task is
"add Stripe integration", the agent won’t stop to restructure a function that hits
cyclomatic complexity 12. It acknowledges the warning and continues.

Complexity warnings also have no clear single action (extract? split? simplify conditions?)
and are often intentional — 8 payment error cases means 8 branches, necessarily.

Additional problem: if the agent builds a complex function over 4 incremental writes, the
warning fires 4 times for the same growing function. Delta-mode filters pre-existing
complexity but not "complexity you’re actively introducing this turn."

Booboo is exactly the right home: it’s the deliberate quality review pass where the agent
(or human) has specifically asked "what needs improving?" That’s when complexity is
actionable. Real-time pipeline should be reserved for things that *change what the agent
does next*. Complexity doesn’t clear that bar.

---

### Architectural Rules — ALREADY A DISPATCH RUNNER ✓

**Current:** `dispatch/runners/architect.ts` registered and wired into both standard and full-lint plans  
**Assessment: Already done — no action needed**

Registered at priority 40, runs as `mode: "fallback"` on `jsts` and `python` files in both
plans. `checkFile` is pure in-memory (<1ms). Nothing to do here.

---

### TODO Scanner — PARTIAL (already in refactoringideas as delta-mode)

**Current:** booboo-only (`TodoScanner.scanFile(filePath)`)  
**Assessment: Don’t run per-write, run delta at turn_end**

`scanFile` is fast (regex), but running it on every write is wrong: the agent *just* wrote
`// TODO: handle edge case` intentionally. Flagging it immediately is noise.

The right model: at `turn_end`, diff the TODO list against the session baseline and flag
any *net-new* TODOs added this turn that weren’t resolved. This is the "stale TODOs"
idea already in the refactoringideas. Don’t add a per-write runner.

---

### Knip — NO

**Current:** session_start (cached) + booboo  
**Assessment: Wrong granularity, wrong speed**

Knip is fundamentally a whole-project tool. It builds a full import graph across all files
to find unused exports/deps. A per-file trigger makes no sense — deleting one export from
file A doesn’t tell you whether it’s unused until you’ve scanned all of file A’s importers.
30s timeout. Already cached at session_start. Adding it to the per-write pipeline would
be strictly worse: slow, noisy, and structurally incorrect.

---

### Type Coverage — NO

**Current:** booboo-only (`npx type-coverage` subprocess, 30s timeout)  
**Assessment: Wrong tool for real-time, already covered**

`type-coverage` spawns an npx process that runs a full TypeScript project scan.
Per-write this is 5–30s overhead. Not viable.

More importantly, the `no-any-type` AST-grep rule already catches `as any` and `: any`
per-file in <1ms. The metric ("87% typed") is useful for the booboo summary report but
not actionable per-write.

---

### jscpd — ALREADY CORRECT (turn_end)

Line-range-filtered duplicate detection at `turn_end`. This is the right placement:
duplication only makes sense once a block is complete, not mid-write.

---

### Madge (circular deps) — ALREADY CORRECT (turn_end)

Checked at `turn_end` when imports change. Per-write would produce false positives
during refactors (add new import before removing old one).

---

### Production Readiness — NO (it’s a composite of things already covered)

`validateProductionReadiness` is a project-level report: scans all source files for
`console.log`, TODOs, empty catches, `as any`, debuggers, missing test files, missing
docs, missing config files. Every individual check it does is either:
- Already a dispatch runner (empty-catch, debugger, as-any via AST-grep; console-log via tree-sitter)
- Covered by the TODO delta approach above
- Structural/project-level (missing README, no CI config) — booboo is the right home

Promoting `production-readiness.ts` to real-time would duplicate existing runners.

---

### Booboo Promotion Summary

| Tool | Realtime? | Why |
|------|-----------|-----|
| Complexity metrics | **No — keep in booboo** | Not actionable mid-task; agents ignore it; booboo is the right review moment |
| Architectural rules | **Already a dispatch runner ✓** | Fast, per-file, wired in both plans |
| TODO scanner | **turn_end delta only** | Per-write is noisy; delta catches unresolved placeholders |
| Knip | No | Whole-project, 30s, structurally wrong |
| Type coverage | No | Subprocess, slow, AST-grep already covers it |
| jscpd | Already turn_end | Correct placement |
| Madge | Already turn_end | Correct placement |
| Production readiness | No | Composite of already-covered checks |

---


## LSP Launch: Use cross-spawn (from opencode)

**Status:** Low priority - current manual Windows handling works
**Priority:** Cleanup/refactoring, not a bug fix
**Reference:** `C:/Users/R3LiC/desktop/opencode/packages/opencode/src/util/process.ts`

### Problem
The current `clients/lsp/launch.ts` has ~100 lines of manual Windows process spawning logic:
- `.cmd`/`.bat` detection
- Shell mode heuristics  
- npm global path resolution
- `windowsHide` handling

### Solution
Use `cross-spawn` package (same one npm/yarn use):

```typescript
import launch from "cross-spawn";

export function spawn(cmd: string[], opts: Options = {}): ChildProcess {
  const proc = launch(cmd[0], cmd.slice(1), {
    cwd: opts.cwd,
    shell: opts.shell,
    env: opts.env,
    stdio: [opts.stdin ?? "ignore", opts.stdout ?? "ignore", opts.stderr ?? "ignore"],
    windowsHide: process.platform === "win32",
  });
  // ... rest of wrapper
}
```

### Benefits
- Handles Windows quirks automatically (PATHEXT, shebangs, etc.)
- Battle-tested (used by npm, yarn, webpack)
- ~100 lines of manual code → ~10 lines

---

## Pi SDK Extension API Assessment: RPC vs Extension vs Untapped Features

*Assessed 2026-04-05 against `@mariozechner/pi-coding-agent` SDK.*

### Current Architecture (What We Use)

pi-lens operates as a **pi extension** — loaded at runtime inside the agent process,
not as an external controller. This is the correct architecture for our use case.

| Feature | Usage Level | Implementation |
|---------|-------------|----------------|
| Event hooks (`pi.on`) | ✅ Extensive | `session_start`, `tool_call`, `tool_result`, `turn_start`, `turn_end`, `before_agent_start` |
| CLI flags (`pi.registerFlag`) | ✅ 15+ flags | `lens-lsp`, `no-biome`, `error-debt`, `auto-install`, etc. |
| Slash commands (`pi.registerCommand`) | ✅ 2 commands | `/lens-booboo`, `/lens-tdi` |
| Custom tools (`pi.registerTool`) | ✅ 3 tools | `autofix`, `booboo`, `tdi` |
| UI primitives (`ctx.ui`) | ⚠️ Partial | `notify()`, `setStatus()` in auto-loop; no widgets/footers |
| Message sending (`pi.sendUserMessage`) | ⚠️ Minimal | `auto-loop.ts` for follow-up messages |

### What We're NOT Using (Assessment)

#### 1. **RPC Client (`RpcClient`) — WRONG ABSTRACTION**

The `RpcClient` is for **external programs** controlling pi headlessly:
```typescript
// External script, NOT an extension
const client = new RpcClient({ cwd: "/project" });
await client.start();
await client.prompt("Refactor this codebase");
await client.waitForIdle();
```

**Verdict:** Not applicable. pi-lens is an extension running *inside* pi's process.
The Extension API (`ExtensionAPI`) is the correct interface.

**When RPC matters:** CI/CD pipelines, IDE integrations, test harnesses driving pi
programmatically. We don't need this.

---

#### 2. **EventBus (`pi.events`) — UNUSED BUT VALID**

Simple pub/sub for extension-to-extension communication:
```typescript
pi.events.emit("lens-diagnostics", { file, errors });
// Other extension subscribes:
pi.events.on("lens-diagnostics", handler);
```

**Use case:** Multi-extension coordination. If another extension wanted real-time
lint data (e.g., a custom TUI widget, a web dashboard), EventBus would be the channel.

**Verdict:** Not needed now. Our architecture uses:
- Internal state (caches, maps)
- Context injection (`pi.on("context", ...)`) to surface to LLM
- Return values from `tool_result` to surface to user

EventBus only becomes relevant if we split pi-lens into multiple extensions or expose
a public API for other extensions to consume.

---

#### 3. **Custom Entry Persistence (`pi.appendEntry`) — WORTH CONSIDERING**

Store arbitrary JSON data in the session file (not sent to LLM):
```typescript
pi.appendEntry("lens-metrics", {
  timestamp: Date.now(),
  filesLinted: 5,
  complexityDelta: 12
});
```

**Current approach:** Disk cache in `~/.cache/pi-lens/`
- ✅ Queryable (SQLite/JSON files)
- ✅ Cross-session (same project, different sessions)
- ❌ Not portable (session file doesn't include cache)
- ❌ Orphaned data (cache lives forever)

**Custom entry approach:**
- ✅ Portable (travels with session file)
- ✅ Auto-cleanup (session deletion removes entries)
- ❌ Not queryable across sessions (each session isolated)
- ❌ Adds bloat to session file

**Verdict:** Could migrate small, session-specific state (per-session TODO baseline,
per-session complexity baselines) to entries for portability. Not urgent — current
cache approach works.

---

#### 4. **UI Primitives — UNTAPPED POTENTIAL**

| Primitive | Purpose | Our Usage | Could Use For |
|-----------|---------|-----------|---------------|
| `ctx.ui.select()` | Dropdown picker | ❌ | `/lens-booboo` profile selection |
| `ctx.ui.confirm()` | Yes/no dialog | ❌ | "Continue despite warnings?" (but we block, not ask) |
| `ctx.ui.input()` | Text input | ❌ | Custom lint rule filters |
| `ctx.ui.editor()` | Multi-line editor | ❌ | Inline architect rule editing |
| `ctx.ui.setWidget()` | Persistent widget (above/below editor) | ❌ | **Live lint status during streaming** |
| `ctx.ui.setFooter()` | Custom footer | ❌ | Replace footer with lens-specific metrics |
| `ctx.ui.setHeader()` | Custom header | ❌ | Startup banner |

**Most promising: `setWidget()`**

Current: `ctx.ui.setStatus("lens", "3 files linted")` puts transient text in footer.
Problem: Footer is crowded, text scrolls away, not visible during streaming.

Widget possibility: Persistent panel above editor showing:
```
┌─ pi-lens ──────────────────────┐
│ ✓ 3 files  ⚠ 2 warnings       │
│ Tests: 12/12  Coverage: 87%    │
└────────────────────────────────┘
```

**Verdict:** Low priority polish. Current `notify()` + `setStatus()` is sufficient.
Widgets add visual weight that may distract.

---

#### 5. **Tool Custom Rendering (`renderCall`, `renderResult`) — NOT NEEDED**

Custom TUI components for tool display:
```typescript
pi.registerTool({
  renderResult: (result, options, theme) => {
    return new MyFancyLintReportComponent(result);
  }
});
```

**Verdict:** Overkill. Our plain text output renders well in the default tool display.
Custom rendering adds maintenance burden for marginal visual gain.

---

### Recommendations (Priority Order)

| Priority | Feature | Action | Rationale |
|----------|---------|--------|-----------|
| **None** | RPC Client | Skip | Wrong abstraction; Extension API is correct |
| **None** | EventBus | Skip | No multi-extension coordination needed |
| **Low** | `appendEntry()` | Consider | Session portability for small state; migrate from cache if needed |
| **Low** | `setWidget()` | Experiment | More visible than `setStatus()`; try for persistent lint dashboard |
| **Low** | `select()`/`input()` | Skip | Command-line parsing is sufficient |
| **None** | Custom tool rendering | Skip | Plain text works; complexity not justified |

### Summary

pi-lens uses the **correct** SDK surface: the **Extension API** (event hooks, flags,
commands, tools). We are not under-utilizing the SDK — we are using the appropriate
subset for an in-process extension.

The **RPC Client** is for external controllers, not extensions. The **EventBus** is for
multi-extension ecosystems. Neither applies to our current architecture.

Future exploration worth doing:
1. **`setWidget()` prototype** — persistent lint status panel (1-2 hours to test)
2. **Migrate cache → `appendEntry()`** — only if session portability becomes important

Everything else is architectural mismatch or premature optimization.

---

## Agent-Centric Pipeline Assessment: Where Real-Time Feedback Falls Short

*Assessed 2026-04-05 against 3.8.0 codebase. Author: the agent itself.*

### What Works

**The parallel dispatch is the crown jewel.** 5 runners fire simultaneously, saving ~57%
wall-clock time per edit (~2.8s total on a 1,700-line file). Feedback arrives before context
drifts. That's the difference between "I'll fix this now" and "I forgot about that 20 messages
ago."

**The blocker vs warnings split is correct.** Inlining only type errors and security violations
while deferring complexity warnings to `/lens-booboo` matches how agents actually work. An agent
doesn't restructure a long parameter list mid-task — it panics over a red squiggle.

**Auto-install is underrated.** Biome, pyright, ruff just work without "first install X."
The gap between "works on my machine" and "works" is one of the most underrated UX wins
in this project.

### What's Broken or At Risk

#### 1. Pipeline Fires on Every Edit, Even Mid-Draft

When building a complex function across 3 writes, that's 3×2.8s overhead with partial-code
lint output on each intermediate state. There's no concept of "draft mode" vs "commit ready."
Every keystroke echo gets the full treatment. This is the single biggest source of noise.

**Fix:** Batch/cascade defer concept (already documented above as Idea #2). Extend it to
LSP errors on the *edited* file itself when they're syntax-only (parse failures), since those
are often transient mid-edit. Keep semantic errors (unused vars, type mismatches) immediate.

#### 2. No Cross-File Impact Analysis

I change a function signature in `utils.ts`. The pipeline checks `utils.ts` — it's clean.
But three other files that import that function now have type errors sitting there. The LSP
runner is file-gated. This is the most dangerous gap — silent breakage in callers that won't
surface until the agent runs a test (which it often skips).

**Fix:** After dispatch, run workspace diagnostics on files that import the edited file.
LSP can do this — it just needs the workspace-level `textDocument/references` or a
workspace-wide diagnostic pass. Gate it: only fire when the edited file exports symbols
that other files reference.

#### 3. Autofix is Destructive Without a Safety Net

The biome `--unsafe` incident (deleted unused interfaces mid-write) was a symptom of a
deeper problem: autofix rewrites code without the agent reviewing the diff. Even with
`--unsafe` removed, `biome --write` still makes opinionated rewrites. On fast multi-file
edits, the agent's mental model of what it wrote gets corrupted by auto-formatting it
didn't consent to.

**Fix:** Autofix should report what it changed before letting the pipeline proceed:
`Auto-fixed: reordered 3 imports (biome)` — not silently rewritten. The agent already
gets this via `fixedCount`, but the actual diff should be surfaced for review when
the change is non-trivial (>10 lines or non-formatting).

#### 4. Silent Runner Failures

If tree-sitter crashes or LSP disconnects mid-session, the pipeline returns "no diagnostics"
— indistinguishable from a clean file. An agent gets false confidence. The `"no_output"`
result type exists but isn't surfaced inline.

**Fix:** In `tool_result` handler, when `result === "no_output"`, emit a one-liner:
`⚠ 2 runners skipped (tree-sitter crashed, LSP disconnected)` — not silence.

#### 5. Session-Level Delta, Not Git-Level Delta

Delta mode tracks "what's new since my last edit" but has no idea what was already broken.
Open a legacy codebase with 200 existing type errors and pi-lens can't tell me "these 200
are pre-existing, these 3 are yours." Every finding looks like it was always there.

**Fix:** Capture a full-project lint baseline at `session_start` (already doing this for
knip/jscpd — extend to LSP + ast-grep-napi). Diff against that baseline, not against
the previous write. One-time cost (~10s) at session start, but every subsequent delta
report is accurate against the project's actual state.

### What's Missing Entirely

#### 6. No Import Resolution Checking

The most common agent mistake: importing from a file that doesn't exist yet, or typos in
import paths. This falls through the cracks because LSP type-checking needs the import to
resolve first. If I type `import { foo } from "./utilsd"` (typo), the error shows up as
"cannot find name 'foo'" — which is misleading. The real error is the path typo.

#### 7. No "What Did I Just Break?" Summary

After an edit cycle, there's no summary saying "your changes introduced 2 new type errors,
fixed 3, and left 12 pre-existing untouched." The agent just gets a raw dump. No delta
summary means no learning loop.

#### 8. Test Coverage is Naive

The test runner finds `foo.test.ts` when `foo.ts` changes. It does NOT run integration tests,
e2e tests, or tests that import the changed file transitively. If I change a shared utility
and only the utility's unit test runs, I'm blind to integration breakage.

### The Verdict

**As a linter wrapper with parallel dispatch, pi-lens is genuinely good.** It's fast, it's
comprehensive, and the agent-centric design (blockers inline, warnings deferred) is correct
in principle.

**As "real-time code feedback," it's not there yet.** Real-time means telling me I'm about
to break something *before* I move on to the next task. Right now, the pipeline is a fast
post-mortem, not a guard rail. The gap is in cross-file awareness and intent detection —
knowing when I'm drafting vs when I'm done, and knowing what my change ripples to.

### Priority Order

| # | Fix | Impact | Effort | Notes |
|---|-----|--------|--------|-------|
| 1 | Cross-file type error propagation | High | Medium | Workspace diagnostics on importers |
| 2 | Git-level delta (pre-existing vs new) | High | Medium | Session-start baseline for all runners |
| 3 | Silent failure detection | Medium | Low | Distinguish "clean" from "runner crashed" |
| 4 | Import path typo detection | Medium | Low | Before it cascades into confusing type errors |
| 5 | Draft mode / batch edit defer | Medium | Medium | Extend cascade defer to syntax errors |
| 6 | Delta summary after edits | Low | Low | "+2 errors, -3 fixed, 12 pre-existing" |
| 7 | Transitive test discovery | Low | High | Graph-based test runner |
