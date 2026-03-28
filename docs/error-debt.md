# Error Debt Tracker - Revised

## The Real Problem

Multiple agents (or multiple turns by same agent) working on a project:
1. Agent A writes file, introduces 3 errors
2. Agent B sees those errors but "didn't cause them" - ignores
3. Agent C sees 6 errors, adds 2 more
4. No one fixes anything, project degrades

**Core insight**: ANY error found should be fixed - attribution doesn't matter.

## Solution: Project-Wide Diagnostic Counter

### Approach

1. **Aggregate ALL diagnostics** from ALL linting tools
2. **Track total count** across the project
3. **Block if count increases** - regardless of causation

### Technical Challenge: Normalization

Different tools have different outputs:
- tsclient: structured Diagnostic objects
- biome: structured Diagnostic objects
- ruff: structured Diagnostic objects
- go vet: plain text
- cargo: JSON or plain text
- tests: exit code + output

We need a unified representation.

### Implementation: Diagnostic Aggregator

```typescript
// New client: diagnostic-aggregator.ts

interface UnifiedDiagnostic {
  tool: string;           // "tsclient" | "biome" | "ruff" | "go" | "rust"
  severity: "error" | "warning" | "info";
  file: string;
  line?: number;
  message: string;
  rule?: string;
}

class DiagnosticAggregator {
  async collectAllDiagnostics(projectRoot: string): Promise<UnifiedDiagnostic[]> {
    const results: UnifiedDiagnostic[] = [];
    
    // Parallel collection
    const [tsErrors, biomeErrors, ruffErrors] = await Promise.all([
      this.collectTSDiagnostics(),
      this.collectBiomeDiagnostics(),
      this.collectRuffDiagnostics(),
    ]);
    
    return [...tsErrors, ...biomeErrors, ...ruffErrors];
  }
}
```

### Tracking Strategy

**Option A: Turn-based**
- Baseline at turn_start
- Compare at turn_end
- Block if errors increased

**Option B: Persistent**
- Store baseline in cache file
- Reset only when errors = 0 (project is clean)
- This creates a "debt ceiling"

### Output Format

```
📊 ERROR DEBT TRACKER

Project error baseline: 12 (from last clean state)
Current errors: 18
New errors: +6

Breakdown by tool:
  TypeScript: 5 errors (was 3, +2)
  Biome: 8 errors (was 4, +4)  
  Ruff: 5 errors (was 5, 0)

→ BLOCKED: Error count increased by 6
   Fix existing errors before adding more.
   Run: npx biome check --write .
```

### Why This Works

1. **No attribution needed** - don't need to prove who caused what
2. **Cumulative pressure** - if you keep making things worse, you get blocked
3. **Clean slate reward** - if you fix errors to zero, you have "budget" to work
4. **Parallel agent safe** - each agent sees same baseline, must not increase

### Configuration

```yaml
# .lens.yaml
errorDebt:
  enabled: true
  resetOnZero: true    # Reset baseline when errors = 0
  tools:              # Which tools to track
    - tsclient
    - biome
    - ruff
    - go-vet
    - clippy
```

### Performance Considerations

Running ALL tools on ALL files is expensive. Optimization:

1. **Incremental**: Only re-check files that changed
2. **Caching**: Cache results, invalidate on file modification
3. **Fast-fail**: Stop collecting once we hit a threshold
4. **Parallel**: Run all collectors simultaneously

### Integration with Dispatch

- New runner: `error-debt.ts`
- Priority: -100 (runs last to see full picture)
- Semantic: blocking if errors increased
- Uses diagnostic aggregator to get unified view

### Alternative: Simpler Version

Just count ERROR-level diagnostics across all tools:

```typescript
const totalErrors = tsErrors.length + biomeErrors.length + ruffErrors.length;
if (totalErrors > baseline) {
  // Block
}
```

This is simpler to implement and still captures the core idea.
