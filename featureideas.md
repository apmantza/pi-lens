# Feature Ideas — pi-lens

Ideas for future development. Items tagged **[PRIORITY]** are actively needed.

---

## **[PRIORITY]** Multi-Agent Governance & Self-Improving Rules

**Status:** Active direction — needs implementation  
**Effort:** Large (3-5 days)  
**Value:** Core architecture — makes pi-lens useful across multiple agents and sessions

### The Problem

pi-lens is currently a **per-session tool**. It enforces rules within one agent's session but has no memory across sessions, no learning from fixes, no adaptation to the project's specific patterns.

```
Agent A writes code → pi-lens enforces rules → session ends → memory gone
Agent B writes code → pi-lens enforces same rules → doesn't learn from A's mistakes
Human notices pattern → manually adds rule → no feedback loop
```

Multiple agents touch one codebase. Each starts from zero intelligence about *this* project's anti-patterns.

### Architecture: Three Layers of Rules

```
.pi-lens/
  ├── rules/ast-grep-rules/rules/   # Layer 1: Static YAML rules (current)
  ├── learned-rules.json             # Layer 2: Auto-generated from fix history
  ├── fix-history.json               # Immutable log of all agent fixes
  └── principles.md                  # Layer 3: Human-written project standards
```

**Layer 1 — Static rules** (what pi-lens has now):
- ast-grep YAML rules, Biome config
- Hand-authored, never change during runtime
- Global across all projects

**Layer 2 — Learned rules** (what's missing):
- Patterns detected from fix history across sessions/agents
- "This team keeps writing X, block it"
- Project-specific, evolves over time
- Confidence score (0.0–1.0), auto-promoted at threshold

**Layer 3 — Project principles** (human-authored):
- `.pi-lens/principles.md` — architecture, naming, patterns, forbidden patterns
- Read on session start, violations surface as guidance
- Higher-level than Layer 1 rules

### Layer 3: Project Principles File

Human writes principles that agents must respect:

```markdown
# .pi-lens/principles.md

## Architecture
- Use dependency injection for all services
- No direct database access in route handlers
- Zod for runtime validation, never io-ts

## Naming
- Files: kebab-case
- Classes: PascalCase
- Functions: camelCase
- No abbreviations in public APIs

## Patterns
- Prefer composition over inheritance
- Extract constants to src/constants/
- Error classes extend AppError base class

## Forbidden
- No `any` type without // @ts-ignore justification
- No circular imports (enforced by depChecker)
- No sleep() in production code
```

### Self-Improving Loop

```
                    ┌─────────────────────────────────┐
                    │                                 │
                    ▼                                 │
  Agent writes code → pi-lens enforces rules          │
                    │                                 │
                    ▼                                 │
  Fix applied → recorded in fix-history.json          │
                    │                                 │
                    ▼                                 │
  Pattern analyzer runs (background, async)           │
                    │                                 │
                    ▼                                 │
  New pattern detected → confidence = 0.6             │
                    │                                 │
                    ▼                                 │
  "Suggest rule?" → Human reviews (interviewer tool)  │
                    │                                 │
           ┌───────┴───────┐                          │
           ▼               ▼                          │
        Approve         Ignore                        │
           │               │                          │
           ▼               ▼                          │
    Promote to Layer 1  Confidence decays             │
    (enforced globally)                               │
                    │                                 │
                    └─────────────────────────────────┘
```

### Fix History Format

```json
{
  "version": 1,
  "fixes": [
    {
      "timestamp": "2026-03-26T14:30:00Z",
      "agent": "cursor-agent-1",
      "session": "abc123",
      "file": "src/auth.ts",
      "rule": "no-console-log",
      "fix": "console.log → console.error",
      "before": "console.log('user:', user)",
      "after": "console.error('user:', user)"
    }
  ]
}
```

### Pattern Analyzer

After N occurrences (configurable, default 10) of the same fix pattern:

```
"Pattern detected: 14 fixes for 'console.log in client code' 
 across 3 agents in 5 days.

 Proposed rule: block console.log in src/** (allow in *.test.ts)
 Confidence: 0.89

 [Promote to enforced rule]  [Keep as suggestion]  [Never this one]"
```

Uses interviewer tool for human review. Pattern analysis runs:
- On `/lens-booboo` completion
- On session start (lightweight check)
- On cron if pi-lens runs as a background service

### Learned Rule Format

```json
{
  "rules": [
    {
      "id": "learned-001",
      "pattern": "avoid console.log in non-test files",
      "astPattern": "console.log($ARGS)",
      "scope": "src/**",
      "exclusions": ["**/*.test.ts", "**/*.spec.ts"],
      "confidence": 0.89,
      "occurrences": 14,
      "agents": ["cursor-agent-1", "copilot-agent-3", "pi-session-7"],
      "firstSeen": "2026-03-20",
      "lastSeen": "2026-03-26",
      "status": "proposed",  // proposed | approved | rejected
      "proposedBy": "pattern-analyzer",
      "approvedBy": "human-1",
      "approvedAt": "2026-03-26T15:00:00Z"
    }
  ]
}
```

### Cross-Agent Knowledge Sharing

Every agent reads rules on startup:
```typescript
const staticRules = loadAstGrepRules();       // Layer 1
const learnedRules = loadLearnedRules();       // Layer 2 (approved only)
const principles = loadPrinciples();           // Layer 3

// All rules applied uniformly
const allViolations = [
  ...runAstGrep(staticRules),
  ...runAstGrep(learnedRules),  // same pattern, different source
  ...checkPrinciples(principles),
];
```

Every agent writes fixes to history:
```typescript
fixHistory.log({
  agent: agentId,
  rule: violation.ruleId,
  fix: fixType,
  file: filePath,
  before: originalCode,
  after: fixedCode,
});
```

### Drift Detection

Track metric trends across sessions, not just within one:

```
Week 1: index.ts Abstraction score = 6.2
Week 2: index.ts Abstraction score = 5.1
Week 3: index.ts Abstraction score = 4.3

⚠ Abstraction score declining in hotspot file.
   Multiple agents touching this file. No single owner.
   Suggest: Extract from index.ts before next edit.
```

Combined with hotspot tracking: files with declining PHAME scores AND high change frequency are the most dangerous.

### Principle Proposals from Agents

Agents can propose principles based on what they observe:

```
Agent notices: "3 different agents imported utils.ts 
  → used only one function from it 
  → created a local copy instead"

Proposed principle: "Import only what you use from utils.ts.
  If you need a new utility, check if it exists before creating."

After 8 more occurrences: add as Layer 2 rule.
```

### Implementation Plan

| Component | Effort | Files |
|---|---|---|
| Fix history logging | 4 hours | New `clients/fix-history.ts`, integrate into fix flow |
| Pattern analyzer | 1 day | New `clients/pattern-analyzer.ts` |
| Learned rules store | 4 hours | `learned-rules.json` schema + loader |
| Principles file (Layer 3) | 2 hours | `principles.md` + loader in index.ts |
| Rule promotion UI | 1 day | Reuse interviewer tool for human review |
| Drift detection | 1 day | Track PHAME/metrics over time in history |
| Cross-session persistence | 2 hours | JSON files, no DB needed |

### What Makes This Work

The rule store is the **shared memory** across agents. Agent A fixes something → knowledge persists → Agent B benefits. No agent needs to remember; the file system remembers.

The human stays in control: Layer 2 rules require approval. The system suggests, never enforces autonomously. The interviewer tool provides the decision UI.

---

## Svelte Language Server Support

**Status:** Proposed  
**Effort:** Medium (1-2 days)  
**Value:** High for Svelte users, zero impact otherwise

### Gap

`.svelte` files get zero diagnostics from pi-lens. The TS LSP can't parse Svelte template syntax, and Biome doesn't understand the `.svelte` file format. The `<script>` blocks use Svelte-specific reactivity (`$state`, `$derived`, `$effect`) that standard TS doesn't know about.

### Solution

`clients/svelte-client.ts` — spawns `svelte-language-server` as a subprocess, same JSON-RPC stdin/stdout pattern as `typescript-client.ts`.

The Svelte LS is essentially a "Svelte-aware TypeScript LSP" — it:
- Parses `.svelte` files (extracts `<script>`, `<style>`, template expressions)
- Type-checks `<script>` blocks with Svelte's runtime types
- Validates CSS scoping
- Provides completions/hovers for Svelte directives

### Integration

1. Check for `svelte` or `svelte-check` in `node_modules` (same as TS LSP's ts detection)
2. Spawn `svelte-language-server --stdio`
3. Send `textDocument/didOpen` / `textDocument/didChange` for `.svelte` files
4. Collect `textDocument/publishDiagnostics` notifications
5. Inject into `tool_result` alongside existing diagnostics

### Rules to add

- `no-unsafe-reactivity` — warn on `$state` / `$derived` used outside `.svelte` or `$effect` contexts
- Svelte-specific a11y rules (already in Svelte LS, but could be surfaced as agent-facing messages)

### Why not just extract `<script>` and run TS LSP?

Svelte has its own type definitions for `$state`, `$derived`, component props via `export let`, and the `$props()` rune. The Svelte LS handles all of this natively. Extracting would be fragile and miss Svelte-specific semantics.

---

## Historical Debt Scoring (trends across commits)

**Status:** Proposed  
**Effort:** Low (2-4 hours)  
**Value:** High — shows whether code quality is improving or degrading over time

### Gap

pi-lens currently computes complexity metrics (MI, cognitive, nesting) but only for the current state. There's no historical tracking — the agent doesn't know if `index.ts` went from MI 68 → 2.7 over the project's lifetime, or if it was always bad.

### Solution

Persist complexity metrics per commit and show deltas on `/lens-metrics` runs.

**Storage:** `.pi-lens/metrics-baseline.json`:
```json
{
  "commit": "abc1234",
  "timestamp": "2026-03-26T14:30:00Z",
  "files": {
    "index.ts": { "mi": 2.7, "cognitive": 1590, "nesting": 10 },
    "auth.ts": { "mi": 68, "cognitive": 45, "nesting": 4 }
  }
}
```

**On `/lens-metrics` run:**
1. Load baseline from previous analysis (from git HEAD at that time)
2. Run current analysis
3. Show deltas: `index.ts: MI 2.7 → 5.2 (+2.5) | Cognitive 1590 → 890 (−700)`
4. Update baseline JSON

**Implementation:**
- `loadBaseline()` / `saveBaseline()` in `clients/metrics-client.ts` (or new `clients/metrics-history.ts`)
- ~50 lines total
- No new dependencies (existing complexity-client + JSON + git commit hash)
- Baseline updated on each `/lens-metrics` run, not per-write (too expensive)

### What it enables

- Agent can say: "This file's MI has dropped 12 points since your last review — something introduced complexity"
- `/lens-metrics` report includes a "regressions" section: files that got worse since last scan
- CI gate: fail if any file's MI drops below threshold since main branch

---

## Hotspot Tracking (complexity × change frequency)

**Status:** Proposed  
**Effort:** Medium (1-2 days)  
**Value:** High — identifies the exact files where AI code is most likely to cause bugs

### Gap

CodeScene's killer feature is hotspot analysis: files that are both **complex** AND **frequently changed** are the most dangerous. pi-lens can measure complexity, but has no concept of change frequency. A file with MI 20 that hasn't been touched in 6 months is less risky than MI 40 that changes every day.

### Solution

`clients/hotspot-client.ts` — combines `git log` change frequency with complexity metrics.

**Score formula** (matching CodeScene's heuristic):
```
hotspot_score = log(changes_in_window + 1) × complexity_weight

complexity_weight = (1 − MI/100) × cognitive/1000
```

**Git analysis** (child_process, no dependencies):
```bash
git log --since="90 days ago" --numstat --format="%H" -- <file>
```

For each file:
- Count commits that touched it
- Aggregate lines added/removed
- Multiply by current complexity metrics
- Rank: top 10-20 hotspots

### Integration

1. **`/lens-booboo`** — add Part 9: "Hotspots" showing files ranked by hotspot_score
2. **`/lens-booboo-refactor`** — prioritize hotspots over low-change complex files
3. **Real-time feedback** — if editing a hotspot file, show: `🔴 Hotspot file — MI: 2.7, changed 47 times in 90 days. Be extra careful.`
4. **`/lens-metrics`** — add hotspot column to the report

### Performance

- Cache results for 5 minutes (git history doesn't change mid-session)
- 90-day window by default (configurable)
- Only analyze files that exist in current codebase (skip deleted)
- Run async in background during session start, surface on-demand

### What it adds that pi-lens doesn't have

| Metric | pi-lens now | + Hotspot tracking |
|---|---|---|
| Complexity | ✅ MI, cognitive, nesting | ✅ |
| Change frequency | ❌ | ✅ commits, lines changed |
| Combined risk | ❌ | ✅ hotspot_score |
| Trend over time | ❌ | ✅ (with #2 above) |
| Time-windowed analysis | ❌ | ✅ 90-day rolling |

### vs CodeScene

CodeScene does more (knowledge loss, temporal coupling, author patterns, architectural decay). But the core hotspot metric — "complex file that's frequently changed" — covers ~80% of the value for ~5% of the complexity.

---

## PHAME Scoring (Hierarchy, Abstraction, Modularization, Encapsulation)

**Status:** Proposed  
**Effort:** Medium (2-3 days)  
**Value:** High — formalizes architectural quality evaluation into a proven framework

### The Problem

AI coding agents optimize for *local token generation* — passing immediate functional tests. They ignore *global architectural constraints*. Result: code that works but structurally degrades over time (empty classes, high cognitive complexity, intertwined responsibilities, deep inheritance).

### What is PHAME?

Principles of **H**ierarchy, **A**bstraction, **M**odularization, and **E**ncapsulation. A design-style framework inspired by Grady Booch's object-model elements. Provides a formal taxonomy for architecture quality.

### Current pi-lens coverage

| PHAME Principle | What it measures | pi-lens now |
|---|---|---|
| **Hierarchy** | Inheritance depth, parent-child relationships | ❌ None |
| **Abstraction** | Class responsibilities, interface segregation | ⚠️ Partial (`large-class`, `long-method`) |
| **Modularization** | Circular deps, coupling, cohesion | ⚠️ Partial (`depChecker`, jscpd for duplicates) |
| **Encapsulation** | Data exposure, internal state leaks | ❌ None |

### Solution

AST-walk each file and score against all four PHAME principles. Integrate into `/lens-booboo` as a new section, and into `/lens-booboo-refactor` as scoring criteria.

**1. Hierarchy scoring** (`clients/phame-client.ts`):
```bash
# Inheritance depth walk
class A extends B → depth 1
class B extends C → depth 2
# Flag if depth > 3 (deep hierarchy is AI slop pattern)
```

Metrics:
- `max_inheritance_depth` — flag if > 3
- `deep_child_count` — classes with depth > 2
- `god_parent_ratio` — parent classes with > 10 children

**2. Abstraction scoring**:
Already have `large-class` and `long-parameter-list`. Add:
- `responsibility_count` — number of distinct method groups (by name prefix or namespace)
- `interface_segregation_score` — does class implement > 3 unrelated interfaces?
- `empty_implementation_ratio` — empty methods / total methods

**3. Modularization scoring**:
Already have `depChecker` for circular deps and jscpd for duplicates. Add:
- `afferent_coupling` — how many files import this file?
- `efferent_coupling` — how many files does this file import?
- `instability_score` — `efferent / (afferent + efferent)` (Robert Martin's instability metric)
- `abstractness_score` — abstract types / total types
- `distance_from_main_sequence` — `|A + I - 1|` (Martin's distance metric)

**4. Encapsulation scoring** (new):
- `public_method_ratio` — public methods / total methods
- `exposed_state_count` — public mutable properties (class fields without `readonly`, `private`, `protected`)
- `getter_setter_leakage` — raw getters/setters that could be encapsulated

### Output format

```markdown
## PHAME Score — index.ts

| Principle | Score | Grade | Issues |
|---|---|---|---|
| Hierarchy | 8/10 | A | No deep inheritance |
| Abstraction | 3/10 | D | 18 responsibilities, god class (340 lines) |
| Modularization | 5/10 | C | Instability 0.82, high coupling |
| Encapsulation | 6/10 | B | 12 exposed state fields |

🔴 Worst: Abstraction — extract into 3+ focused modules
```

### Integration points

1. **`/lens-booboo`** — add Part 9: "PHAME Architecture Score" after Hotspots
2. **`/lens-booboo-refactor`** — use PHAME scores to rank offenders and generate refactoring options
3. **Real-time feedback** — if editing a file drops its PHAME score, show warning (but don't hard-stop — architectural, not mechanical)
4. **`/lens-metrics`** — add PHAME columns to the report

### Implementation

- `clients/phame-client.ts` — new module (~200 lines)
- Uses TypeScript compiler API (already a dependency) for AST walking
- No new dependencies
- Score each file on session start (async), cache for queries
- Grades: A (8-10), B (6-7), C (4-5), D (2-3), F (0-1)

### Why not just use existing rules?

Existing rules (`large-class`, `long-method`, `circular deps`) are *symptom detectors*. PHAME is a *diagnostic framework* — it tells you *why* the symptoms exist and *which principle* is violated. The agent gets actionable guidance: "This class violates Abstraction, not just 'it's too long.'"

---

## Bandit — Python Security Scanner

**Status:** Proposed  
**Effort:** Low (2-3 hours)  
**Value:** Medium — fills a gap that Ruff doesn't cover

### Gap

pi-lens uses Ruff for Python linting, but Ruff handles *style*, not *security*. The existing ast-grep rules cover `no-hardcoded-secrets` and `no-sql-in-code` generically, but Python has framework-specific vulnerabilities that require Python-aware analysis.

Bandit is a security-focused linter that scans for:
- Hardcoded passwords and API keys (B105)
- SQL injection via string formatting (B608)
- Command injection via `os.system()` / `subprocess` (B605, B606)
- Insecure cryptography (`hashlib.md5`, `random` for security) (B303, B324)
- Assert statements in production code (B101)
- Binding to all interfaces (B104)
- Try/except with bare `except` and `pass` (B110)

### Why Ruff doesn't cover this

Ruff has an `S` rule set (from Bandit) but it's incomplete — only ~50 of Bandit's 100+ rules. Full Bandit coverage requires the standalone tool.

### Implementation

`clients/bandit-client.ts` (~50 lines):
- Extends `SubprocessClient`
- Check: `bandit --version` (like Ruff, likely already installed alongside it)
- Run: `bandit -r <path> -f json -q` on each Python file write
- Parse JSON output, filter to new issues (delta mode, same as other clients)
- Inject into `tool_result`: `🔴 Security: B608 (SQL injection via string format) in auth.py:42`

### Integration

1. **`tool_call` hook** — after Ruff scan, run Bandit on the same file (or combine into one subprocess call)
2. **Real-time feedback** — security issues are hard stops (🔴), not warnings
3. **`/lens-booboo`** — add Python security section alongside type coverage
4. **`/lens-booboo-fix`** — Bandit issues are non-fixable (security requires human review), so surface in skip section with `→ Review required`

### Rule coverage overlap

| Check | ast-grep (generic) | Bandit (Python-specific) |
|---|---|---|
| Hardcoded secrets | `no-hardcoded-secrets` | B105, B106, B107 (password in config) |
| SQL injection | `no-sql-in-code` | B608 (string format SQL) |
| Command injection | ❌ | B605, B606 (subprocess shell=True) |
| Insecure crypto | ❌ | B303, B304, B324 (MD5, ARC4) |
| Assert removal | ❌ | B101 (assert removed by `-O`) |
| Binding all interfaces | ❌ | B104 (`0.0.0.0` binding) |

### Why add both ast-grep AND Bandit?

ast-grep catches the pattern anywhere (JS, TS, Python). Bandit understands Python-specific frameworks (e.g., Django ORM's parameterized queries are safe, string formatting is not). Context-aware > pattern matching for security.

---

## PMD — Java Language Support

**Status:** Proposed  
**Effort:** Medium (1-2 days)  
**Value:** Medium — only if Java is in scope

### Gap

pi-lens currently supports: JS/TS, Python, Go, Rust. No Java support at all. PMD would be the Java analog to what Ruff is for Python — the primary linter.

### What PMD provides

- **Java linting** — unused variables, empty catch blocks, unnecessary object creation
- **CPD (Copy-Paste Detection)** — duplicate code detection (like jscpd but for Java)
- **Complexity metrics** — cyclomatic complexity, class complexity, method complexity
- **Security rules** — SQL injection, unsafe reflection, hardcoded credentials
- **Best practices** — JUnit assertions, String.split misuse, missing serialVersionUID

### Implementation

`clients/pmd-client.ts` (~80 lines):
- Extends `SubprocessClient`
- Check: `pmd --version` or `pmd check` availability
- Run: `pmd check --dir <path> --format json --rulesets java/quickstart.xml,java/security.xml`
- Parse JSON output for violations
- Delta mode: track baseline per session, show only new issues

Additionally:
- **CPD**: `pmd cpd --files <path> --minimum-tokens 50 --format json` — like jscpd but Java-aware
- **Complexity**: PMD includes cyclomatic complexity metrics. Could reuse existing `complexity-client.ts` pattern but with PMD instead of TypeScript compiler API

### Integration

1. **`tool_call` hook** — scan `.java` files (currently ignored)
2. **Real-time feedback** — same format as other linters
3. **`/lens-booboo`** — Java section with PMD + CPD results
4. **`/lens-metrics`** — Java complexity metrics alongside JS/TS

### Rules to add (ast-grep for Java)

PMD handles lint/security. Add ast-grep rules for structural patterns:
- `java-no-empty-catch` — same pattern as JS
- `java-no-eval` — no reflection-based eval
- `java-no-sql-injection` — JDBC string concatenation

### When to implement

- **Yes**: If you or users write Java/Kotlin (Kotlin support via JVM interop)
- **No**: If codebase is JS/TS/Python/Go/Rust only — PMD adds maintenance burden with zero usage

---

## (future ideas go here)
