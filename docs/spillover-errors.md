# Spillover Error Detection

## Problem
When an agent writes/modifies a file, it may cause errors in OTHER files:
- Adding an import that doesn't exist → import error in consumer
- Changing a type → type error in dependent files
- Deleting a function → call error in other files
- Changing a public API → errors across the codebase

The agent often ignores these errors and continues working.

## Solution: Spillover Detection Runner

### Detection Strategy

1. **Baseline snapshots**: Before each write, capture diagnostics for all files
2. **Delta detection**: After write, compare diagnostics - NEW errors in OTHER files are "spillover"
3. **Causal linking**: Try to link spillover errors to the changed file (via imports, exports)

### Implementation Approach

```typescript
// In a new runner: spillover-detector.ts

interface SpilloverError {
  errorFile: string;      // File with the error
  causeFile: string;      // File that caused it (likely)
  error: Diagnostic;
  causalLinks: string[];  // import statements, etc.
}
```

### Data Sources

- **TypeScript LSP**: `tsClient.getDiagnostics(allFiles)` - get errors across project
- **Dependency graph**: Which files import from which
- **Import statements**: Regex match imports to find causal links

### Integration Points

1. **Pre-write baseline**: Capture diagnostics before file write
2. **Post-write detection**: Compare and find new errors
3. **Warning output**: Tell agent to fix spillover errors before continuing

### Example Output

```
🔴 SPILLOVER: Your changes to auth.ts caused 3 new errors elsewhere:

  L42: users.ts — Property 'validateToken' does not exist on type 'AuthService'
    → auth.ts likely removed/changed 'validateToken'
  L18: middleware.ts — Cannot find name 'AuthService'
    → auth.ts may have renamed or deleted 'AuthService'
  L7: index.ts — Module './auth' has no exported member 'AuthService'
    → Check auth.ts exports

→ Fix these spillover errors before continuing
```

### Technical Challenges

1. **Performance**: Checking all files on every write is expensive
   - Solution: Only check files that import the changed file
   
2. **False positives**: Some errors might be pre-existing
   - Solution: Track baseline at turn start, only flag NEW errors
   
3. **Causal uncertainty**: Hard to know exactly which file caused the error
   - Solution: Use import graph + heuristic scoring

### Implementation Location

Best fit: **New runner in dispatch system** (`spillover-detector.ts`)

- Runs after all other linting
- Uses dependency information
- Outputs blocking semantic if spillover detected
