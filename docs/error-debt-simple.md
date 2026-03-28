# Error Debt Tracker - Simple Version

## The Problem

Tests fail or build fails → agent ignores because "not my fault"

## Simple Solution

Track binary state: does project build? do tests pass?

```
Turn Start:
  - Run `npm test` → store exit code
  - Run `npm run build` → store exit code

Turn End:
  - Run tests again → compare
  - Run build again → compare
  - If MORE tests fail now than at start → BLOCK
  - If build fails now but passed at start → BLOCK
```

## Why This Works

- No attribution needed
- Simple binary check (pass/fail)
- Forces agent to ensure project is in good state
- Parallel agents can't make things worse without being blocked

## Implementation

Two options:

### Option A: turn_start / turn_end hooks in index.ts
- Run tests at turn_start, store baseline in cache
- Run tests at turn_end, compare
- Simple but requires changes to index.ts hooks

### Option B: New runner in dispatch system
- Runs as part of tool_result (post-write)
- But needs access to turn state...
- More complex to wire up

## Config

```yaml
# .lens.yaml
errorDebt:
  enabled: true
  trackTests: true
  trackBuild: true
  testCommand: "npm test"  # customizable
  buildCommand: "npm run build"
```
