# tool_result Handler Coverage Analysis

## Current tool_result Functionality

### 1. Tracking & State (Always runs)
| Feature | Client | Status |
|---------|--------|--------|
| Agent behavior tracking | `agentBehaviorClient` | ⚠️ NOT in dispatcher |
| Turn state (modified ranges) | `cacheManager` | ⚠️ NOT in dispatcher |
| Metrics recording | `metricsClient` | ⚠️ NOT in dispatcher |

### 2. Per-File Linting (File-specific)
| Feature | Client | Runner | Status |
|---------|--------|--------|--------|
| TypeScript LSP | `tsClient` | `ts-lsp.ts` | ✅ Done |
| Python Ruff | `ruffClient` | `ruff.ts` | ✅ Done |
| Type Safety | `typeSafetyClient` | `type-safety.ts` | ✅ Done |
| ast-grep | `astGrepClient` | `ast-grep.ts` | ✅ Done |
| Biome | `biomeClient` | `biome.ts` | ✅ Done |
| Go vet | `goClient` | ❌ Missing | 
| Rust cargo | `rustClient` | ❌ Missing |

### 3. Architectural Rules
| Feature | Status |
|---------|--------|
| Path/content violations | ⚠️ NOT in dispatcher |
| File size limits | ⚠️ NOT in dispatcher |

### 4. Project-Wide Analysis (Runs at turn_end or cached)
| Feature | Scope | Status |
|---------|-------|--------|
| Duplicate exports | Project | ⚠️ NOT in dispatcher |
| Circular dependencies | Project | ⚠️ NOT in dispatcher |
| Test runner | Per-file | ⚠️ NOT in dispatcher |
| jscpd duplicates | Project | ⚠️ NOT in dispatcher |
| Complexity metrics | Per-file | ⚠️ NOT in dispatcher |

### 5. Agent Behavior Warnings
| Feature | Status |
|---------|--------|
| Blind write detection | ⚠️ NOT in dispatcher |
| Thrashing detection | ⚠️ NOT in dispatcher |

---

## Key Architectural Insights

### The Dispatcher is Per-File
The current dispatcher is designed for **per-file** operations. But some checks are **project-wide**:

1. **Project-wide checks** (need global state):
   - Duplicate exports (cachedExports Map)
   - jscpd duplicates (cachedJscpdClones array)
   - Circular dependencies (depChecker with import graph)
   - Agent behavior tracking (toolHistory)

2. **Per-file checks** (fit well in dispatcher):
   - All linting tools (ts, ruff, biome, etc.)
   - Type safety
   - Architectural rules

### Recommendations

1. **Keep the dispatcher for per-file linting** - this is its sweet spot
2. **Extract project-wide checks to separate handlers** - these need global state
3. **The index.ts should orchestrate both** - dispatcher for linting, existing logic for project-wide

## Missing Runners to Add

1. **go-vet.ts** - Go linting
2. **rust-clippy.ts** - Rust linting
3. **architect.ts** - Architectural rules (violations + file size)
4. **test-runner.ts** - Test execution
5. **duplicate-export.ts** - Check for redefinitions
6. **circular-dep.ts** - Circular dependency check

## Phase 2.5: Project-Wide Handler

Create `clients/dispatch/project-checks.ts` for project-wide analysis:
- Duplicate exports
- Circular dependencies
- Agent behavior warnings
- Complexity metrics
