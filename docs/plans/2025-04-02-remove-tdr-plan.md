# Remove TDR (Technical Debt Ratio) - Implementation Plan

> **For Pi:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove orphaned TDR tracking code that captures diagnostics but never displays them to users. TDI (Technical Debt Index) already provides comprehensive code health metrics.

**Architecture:** TDR was designed to track lint violations by category, but this data is redundant - violations appear inline during editing, and TDI captures actual code quality. Removing TDR eliminates dead code.

**Tech Stack:** TypeScript, pi-lens metrics system

---

## Current State Analysis

**TDR is orphaned code:**
- `updateTDR()` is called in pipeline with diagnostic data
- `tdrFindings` Map stores the data in memory
- `getTDRScore()` calculates a score
- **BUT:** No command displays TDR, no output uses it
- Data is lost on session restart (not persisted like TDI)

**TDI is sufficient:**
- `/lens-tdi` command displays code health (MI, cognitive, nesting)
- Persisted to `.pi-lens/metrics-history.json`
- Trends tracked per commit
- Covers code quality comprehensively

**Files to modify:**
- `clients/metrics-client.ts` - Remove TDR types, Map, methods
- `clients/metrics-client.tdr.test.ts` - Delete test file
- `clients/pipeline.ts` - Remove TDR update call and import
- `clients/dispatch/types.ts` - Remove TDRCategory type
- `clients/dispatch/runners/` - Remove tdrCategory from 4 runners

---

### Task 1: Remove TDR from MetricsClient Types

**Files:**
- Modify: `clients/metrics-client.ts:34-38`

**Step 1: Remove TDREntry type**

Find and delete:
```typescript
export interface TDREntry {
	category: string;
	count: number;
	severity: "error" | "warning" | "info";
}
```

**Step 2: Remove TDR fields from FileMetrics**

Change from:
```typescript
export interface FileMetrics {
	filePath: string;
	totalLines: number;
	entropyStart: number;
	entropyCurrent: number;
	entropyDelta: number;
	tdrStart: number; // REMOVE
	tdrCurrent: number; // REMOVE
	tdrContributors: TDREntry[]; // REMOVE
}
```

To:
```typescript
export interface FileMetrics {
	filePath: string;
	totalLines: number;
	entropyStart: number;
	entropyCurrent: number;
	entropyDelta: number;
}
```

**Step 3: Remove TDR from SessionMetrics**

Change from:
```typescript
export interface SessionMetrics {
	filesModified: number;
	avgEntropyDelta: number;
	tdrScore: number; // REMOVE
	tdrByCategory: Map<string, number>; // REMOVE
	fileDetails: Map<string, FileMetrics>;
}
```

To:
```typescript
export interface SessionMetrics {
	filesModified: number;
	avgEntropyDelta: number;
	fileDetails: Map<string, FileMetrics>;
}
```

**Step 4: Build and verify**

Run: `npx tsc`

Expected: Compiles successfully (may have errors from other files using removed types)

**Step 5: Commit**

```bash
git add clients/metrics-client.ts
git commit -m "refactor: remove TDR types from metrics-client"
```

**Verification:**
- [ ] `TDREntry` type removed
- [ ] TDR fields removed from `FileMetrics`
- [ ] TDR fields removed from `SessionMetrics`
- [ ] Commit made

---

### Task 2: Remove TDR Map and Methods from MetricsClient

**Files:**
- Modify: `clients/metrics-client.ts:155-230`

**Step 1: Remove tdrFindings Map**

Find and delete:
```typescript
private tdrFindings: Map<string, TDREntry[]> = new Map();
```

**Step 2: Remove updateTDR method**

Find and delete:
```typescript
/**
 * Update TDR findings for a file
 */
updateTDR(filePath: string, entries: TDREntry[]): void {
	const absolutePath = path.resolve(filePath);
	this.tdrFindings.set(absolutePath, entries);
}
```

**Step 3: Remove getTDRScore method**

Find and delete:
```typescript
/**
 * Get overall TDR score for the session
 * 0-100, where 100 is high debt.
 */
getTDRScore(): number {
	let totalScore = 0;
	for (const entries of this.tdrFindings.values()) {
		for (const entry of entries) {
			totalScore += entry.count;
		}
	}
	return totalScore;
}
```

**Step 4: Simplify getFileMetrics**

Remove TDR-related lines from `getFileMetrics()`:

Change from:
```typescript
const currentTdrFindings = this.tdrFindings.get(absolutePath) || [];
const tdrCurrent = currentTdrFindings.reduce((a, b) => a + b.count, 0);

return {
	filePath: path.relative(process.cwd(), absolutePath),
	totalLines,
	entropyStart: baseline.entropy,
	entropyCurrent,
	entropyDelta,
	tdrStart: baseline.tdr,
	tdrCurrent,
	tdrContributors: currentTdrFindings,
};
```

To:
```typescript
return {
	filePath: path.relative(process.cwd(), absolutePath),
	totalLines,
	entropyStart: baseline.entropy,
	entropyCurrent,
	entropyDelta,
};
```

**Step 5: Simplify recordBaseline**

Change from:
```typescript
this.fileBaselines.set(absolutePath, { content, entropy, tdr: initialTdr });
```

To:
```typescript
this.fileBaselines.set(absolutePath, { content, entropy });
```

**Step 6: Build and verify**

Run: `npx tsc`

Expected: Errors from pipeline and other files (will fix next)

**Step 7: Commit**

```bash
git add clients/metrics-client.ts
git commit -m "refactor: remove TDR Map and methods from MetricsClient"
```

**Verification:**
- [ ] `tdrFindings` Map removed
- [ ] `updateTDR()` method removed
- [ ] `getTDRScore()` method removed
- [ ] `getFileMetrics()` simplified
- [ ] `recordBaseline()` simplified
- [ ] Commit made

---

### Task 3: Remove TDR from Pipeline

**Files:**
- Modify: `clients/pipeline.ts:1-30`
- Modify: `clients/pipeline.ts:235-255`

**Step 1: Remove convertDiagnosticsToTDREntries import**

Change from:
```typescript
import {
	convertDiagnosticsToTDREntries,
	type MetricsClient,
} from "./metrics-client.js";
```

To:
```typescript
import type { MetricsClient } from "./metrics-client.js";
```

**Step 2: Remove TDR update from dispatch section**

Find the dispatch lint section (around line 235) and remove TDR code:

Change from:
```typescript
// Get full dispatch result for TDR tracking
const dispatchResult = await dispatchLintWithResult(filePath, cwd, piApi);

if (dispatchResult.output) {
	output += `\n\n${dispatchResult.output}`;
}

// Update TDR metrics with diagnostics from dispatch
if (dispatchResult.diagnostics.length > 0) {
	const tdrEntries = convertDiagnosticsToTDREntries(
		dispatchResult.diagnostics,
	);
	metricsClient.updateTDR(filePath, tdrEntries);
	dbg(
		`tdr: recorded ${tdrEntries.length} categories for ${path.basename(filePath)}`,
	);
}
```

To:
```typescript
const dispatchResult = await dispatchLintWithResult(filePath, cwd, piApi);

if (dispatchResult.output) {
	output += `\n\n${dispatchResult.output}`;
}
```

**Step 3: Build and verify**

Run: `npx tsc`

Expected: Compiles successfully

**Step 4: Commit**

```bash
git add clients/pipeline.ts
git commit -m "refactor: remove TDR tracking from pipeline"
```

**Verification:**
- [ ] `convertDiagnosticsToTDREntries` import removed
- [ ] TDR update code removed from dispatch section
- [ ] Build passes
- [ ] Commit made

---

### Task 4: Remove TDRCategory from Dispatch Types

**Files:**
- Modify: `clients/dispatch/types.ts:24-35`
- Modify: `clients/dispatch/types.ts:55-58`

**Step 1: Remove TDRCategory type export**

Find and delete:
```typescript
/** TDR (Technical Debt Ratio) category for metrics tracking */
export type TDRCategory =
	| "type_errors"
	| "security"
	| "architecture"
	| "complexity"
	| "style"
	| "tests"
	| "dead_code"
	| "duplication";
```

**Step 2: Remove tdrCategory from Diagnostic interface**

Find and delete:
```typescript
/** TDR category for metrics tracking */
tdrCategory?: TDRCategory;
```

**Step 3: Build and verify**

Run: `npx tsc`

Expected: Errors from runners using tdrCategory (will fix next)

**Step 4: Commit**

```bash
git add clients/dispatch/types.ts
git commit -m "refactor: remove TDRCategory type and tdrCategory field"
```

**Verification:**
- [ ] `TDRCategory` type removed
- [ ] `tdrCategory` field removed from `Diagnostic`
- [ ] Commit made

---

### Task 5: Remove tdrCategory from Runners

**Files:**
- Modify: `clients/dispatch/runners/biome.ts`
- Modify: `clients/dispatch/runners/ruff.ts`
- Modify: `clients/dispatch/runners/ts-lsp.ts`
- Modify: `clients/dispatch/runners/ast-grep-napi.ts`

**Step 1: Remove from biome runner**

Find the diagnostics mapping and remove `tdrCategory`:

Change from:
```typescript
const diagnostics = rawDiagnostics.map((d) => ({
	...d,
	tdrCategory: d.severity === "error" ? "architecture" : "style",
}));
```

To:
```typescript
const diagnostics = rawDiagnostics;
```

**Step 2: Remove from ruff runner**

Change from:
```typescript
const diagnostics = rawDiagnostics.map((d) => ({
	...d,
	tdrCategory: d.rule?.startsWith("E") ? "type_errors" : "style",
}));
```

To:
```typescript
const diagnostics = rawDiagnostics;
```

**Step 3: Remove from ts-lsp runner**

Find and delete `tdrCategory: "type_errors"` from both LSP and builtin client diagnostic mappings.

**Step 4: Remove from ast-grep-napi runner**

Find the tdrCategory logic (around lines 350-380) that determines category based on rule ID, and remove it. Just push diagnostics without tdrCategory.

**Step 5: Build and verify**

Run: `npx tsc`

Expected: Compiles successfully

**Step 6: Commit**

```bash
git add clients/dispatch/runners/
git commit -m "refactor: remove tdrCategory from all dispatch runners"
```

**Verification:**
- [ ] All 4 runners updated
- [ ] No more `tdrCategory` assignments
- [ ] Build passes
- [ ] Commit made

---

### Task 6: Remove convertDiagnosticsToTDREntries Helper

**Files:**
- Modify: `clients/metrics-client.ts:55-145`

**Step 1: Remove the helper function and imports**

Delete from the file:
- Import of `Diagnostic, TDRCategory` from dispatch/types
- `convertDiagnosticsToTDREntries()` function
- `categorizeDiagnostic()` function
- `severityForCategory()` function

**Step 2: Build and verify**

Run: `npx tsc`

Expected: Compiles successfully

**Step 3: Commit**

```bash
git add clients/metrics-client.ts
git commit -m "refactor: remove convertDiagnosticsToTDREntries helper"
```

**Verification:**
- [ ] Helper function removed
- [ ] Build passes
- [ ] Commit made

---

### Task 7: Delete TDR Test File

**Files:**
- Delete: `clients/metrics-client.tdr.test.ts`

**Step 1: Delete the test file**

```bash
rm clients/metrics-client.tdr.test.ts
```

**Step 2: Run tests to verify**

Run: `npm test`

Expected: All tests pass (TDR tests no longer run)

**Step 3: Commit**

```bash
git rm clients/metrics-client.tdr.test.ts
git commit -m "test: remove TDR conversion tests"
```

**Verification:**
- [ ] Test file deleted
- [ ] All remaining tests pass
- [ ] Commit made

---

### Task 8: Final Verification

**Step 1: Full build**

Run: `npx tsc && echo "Build successful"`

Expected: No errors

**Step 2: Run all tests**

Run: `npm test 2>&1 | tail -10`

Expected: All tests pass

**Step 3: Verify no TDR references remain**

```bash
grep -rn "tdr\|TDR\|TDREntry\|TDRCategory" --include="*.ts" --include="*.js" clients/ 2>/dev/null | grep -v node_modules || echo "No TDR references found"
```

Expected: "No TDR references found" or only unrelated matches

**Step 4: Commit final changes**

```bash
git add -A
git commit -m "refactor: complete TDR removal - all diagnostics now tracked inline only"
```

**Step 5: Push**

```bash
git push
```

**Verification:**
- [ ] Full build passes
- [ ] All tests pass
- [ ] No TDR references remain
- [ ] Final commit made
- [ ] Pushed to origin

---

## Summary

**What was removed:**
1. `TDREntry` type and interface
2. `TDRCategory` type with 8 categories
3. `tdrCategory` field from `Diagnostic`
4. `tdrFindings` Map from MetricsClient
5. `updateTDR()`, `getTDRScore()` methods
6. `convertDiagnosticsToTDREntries()` helper
7. TDR tracking from pipeline
8. TDR test file
9. `tdrCategory` assignments from all 4 runners

**What remains:**
- TDI (Technical Debt Index) via `/lens-tdi` - comprehensive and useful
- Inline diagnostics from dispatch runners - immediate feedback
- Complexity metrics (MI, cognitive, cyclomatic, entropy) - tracked per commit

**Result:** Cleaner codebase, no orphaned tracking code. TDI provides sufficient code health visibility.

---

**Execution:** Use superpowers:executing-plans
