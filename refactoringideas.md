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

### When to do this
- If we hit more Windows LSP spawn edge cases
- As general code cleanup when adding other features
- Not urgent - current code works
