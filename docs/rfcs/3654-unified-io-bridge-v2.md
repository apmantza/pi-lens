# RFC 3654: Unified File I/O Lifecycle Bridge (v2 Specification)

**Status:** Accepted by the maintainer on #4145 (2026-10-08)  
**Tracking Issue:** [apmantza/pi-lens#3654](https://github.com/apmantza/pi-lens/issues/3654)  
**Related Issues/PRs:** #3651 (multi-span batching), #3652 (0-line reads), #3650 (mutating-tool path), #3785 (read-guard evidence & FileTime), #2465 (no-read-guard split), #3620 (lineage fence)  
**Authors:** Architecture Council (`lens-orchestrator`, `council-peer`)  

---

## 1. Executive Summary & Teleological Frame

### Problem
Pi coding-agent extensions interacting with the filesystem outside pi-lens's native tool hooks currently face severe friction and architectural fragmentation:
1. **Dual Bridge Overhead**: Producers performing atomic edit + preview-diff turns must call two separate global symbol bridges: `Symbol.for("pi-lens:mutation-bridge")` then `Symbol.for("pi-lens:read-bridge")`.
2. **Redundant Synchronous I/O (#3651)**: `ReadBridge.recordRead` executes two synchronous `fs.readFileSync` calls per read (one for `captureReadContentBinding` and one for `captureLineHashes`), even when the producer already holds file content in memory.
3. **Absence of Delete Lifecycle**: Programmatic file deletion is unrepresented in existing bridges, leaving zombie records in `readGuard.reads`, `writtenThisSession`, and `knownPathIndex`.
4. **Ordering & Freshness Hazards**: Concurrent writers and multi-window reads risk desynchronizing `FileTime` and read evidence if the mutation and read facets are not executed in strict atomic sequence.

### Proposed Outcome
A unified, cohesive File I/O Lifecycle Bridge mounted at `Symbol.for("pi-lens:io-bridge")` carrying `readonly version: 2`, consolidating file observation (`read`), partial modification (`edit`), whole-file authorship (`write`), and deletion (`delete`) into an atomic, synchronous, non-throwing contract. Existing v1 bridges are preserved as zero-overhead shims mounted in the same first-wins pass.

---

## 2. Non-Negotiable Architectural Decisions (D1–D13)

| ID | Decision | Invariant & Enforcement |
|---|---|---|
| **D1** | **Symbol Key & Version** | `Symbol.for("pi-lens:io-bridge")` + `readonly version: 2`. Policy: `version` covers minors; breaking majors require a new symbol key (first-wins frozen per-process slot). In the same first-wins pass, mount v1 shims for `pi-lens:read-bridge` and `pi-lens:mutation-bridge` preserving v1 return types (`void` and `boolean`). |
| **D2** | **Mutation Umbrella Name** | The mutation facet is named **`mutate`** (not `write`), because `delete` is an absence event, not a write. |
| **D3** | **`delete` Primitive** | `delete` is a `kind` under `mutate` (`mutate: { kind: "delete" }`), wrapped by the enclosing `!getFlag("no-read-guard")` gate, followed by the 4 confirmed-delete gates in production order, shared with the native bash path through `judgeConfirmedDelete` (`clients/confirmed-delete.ts`): (1) `isExternalOrVendorFile`, (2) `isPathIgnoredByProject`, (3) `readGuard.hasKnownPath`, (4) `!existsSync` confirm. Action: `readGuard.forgetPath(filePath)` and, when `!getFlag("no-lsp")`, `notifyExternalFileChange(filePath, 3)`. `no-lsp` suppresses only the notification; the native bash path skips the whole delete under `no-lsp`. Bypasses `recordWritten` and `addModifiedRange`; emits no change-log receipt. |
| **D4** | **`rename` Deferred** | Compose as `delete(old)` + `write(new)`. Dead fields like `renamedFrom` are omitted from v2 until an active consumer exists. |
| **D5** | **Read Evidence Policy** | Default is **coverage-only** (`evidence: "caller"` with no content/hashes binds range without line hashes). `"disk"` is an explicit opt-in for bridge-initiated disk hashing. The bridge never synthesizes hash evidence unless `"disk"` is passed. |
| **D6** | **`content` Semantics** | Delivered raw text starting at `ranges[0][0]` (span-relative). No caller-fabricated `contentBinding`; whole-file staleness checks stay disk-derived only. |
| **D7** | **Span Constraints** | `lineHashes` is keyed by absolute 1-indexed line numbers and supports multi-span reads. `content` is valid **only** with a single contiguous range (`ranges.length === 1`). |
| **D8** | **Hash Map Typing** | `lineHashes` is `Record<number, string>` (keys integers $\ge 1$), matching `ReadRecord.lineHashes`. |
| **D9** | **Never Throws** | `record()` never throws. Malformed, out-of-scope, or ignored calls return `{ accepted: false, reason: RecordReason }`. Hash keys outside declared ranges are rejected with `"malformed"`. |
| **D10** | **Independent Facet Outcomes** | Facets apply independently; `record()` returns `{ read?: RecordOutcome, mutate?: RecordOutcome }`. |
| **D11** | **Accessor Idiom** | `getIOBridge()` returns `undefined` on version mismatch (mirroring v1). |
| **D12** | **Public API Stability** | Add section to `docs/public-api-stability.md` designating `PiLensIOBridge` as public API from day one, linking `docs/io-bridge-v2-migration.md`, with changelog fragment audience `user`. |
| **D13** | **TLA+ & Governance Plan** | PR implementation must add row in `formal/coverage-map.json` mapping `clients/io-bridge.ts` to `[session-lifecycle, read-guard]`; verify write-before-read and lineage fence invariants, or cite `TLA+ unaffected`. |
| **D14** | **Backward-Compatible Refinement** | v1 behavior may be refined in v2, but v1's observable behavior MUST NOT break. v1 shims (`read-bridge`, `mutation-bridge`) are a frozen compatibility layer. Every input v1 accepted, v1 accepts; same return types; same effective guard/cache key; same display path. Detailed mappings live in `docs/io-bridge-v2-migration.md`. |

---

## 3. Normative TypeScript Interface

```typescript
/**
 * Generic File I/O Lifecycle Bridge for pi-lens (v2).
 * Mounts at globalThis[IO_BRIDGE_SYMBOL].
 */

export const IO_BRIDGE_SYMBOL = Symbol.for("pi-lens:io-bridge");
export const IO_BRIDGE_VERSION = 2 as const;

/** 1-indexed closed line interval: [start, end] where start <= end. */
export type LineRange = [start: number, end: number];

/** Map of 1-indexed line numbers to alphanumeric line-content hashes. */
export type LineHashMap = Record<number, string>;

export interface ReadFacet {
  /**
   * 1-indexed line ranges delivered to the model. REQUIRED.
   * `[]` represents an explicit zero-line / 0-byte read (#3652).
   * Full-file read is represented by `[[1, lineCount]]`.
   */
  ranges: LineRange[];

  /**
   * Delivered raw text starting at ranges[0][0].
   * Valid ONLY when ranges.length === 1 (single contiguous span).
   */
  content?: string;

  /**
   * Precomputed alphanumeric line hashes keyed by absolute 1-indexed line numbers.
   * Supports multi-span reads. All keys must fall within declared ranges.
   */
  lineHashes?: LineHashMap;

  /**
   * Evidence collection mode:
   * - "caller" (default): Use content / lineHashes if provided. If neither is provided,
   *   records coverage-only with NO hashes (no disk reads performed).
   * - "disk": Bridge synchronously disk-reads and hashes the declared ranges.
   */
  evidence?: "caller" | "disk";
}

export type MutationFacet =
  | {
      /** Partial file modification (line replacement / splice). */
      kind: "edit";
      /** 1-indexed line ranges modified. Must be non-empty. */
      ranges: LineRange[];
      /**
       * Whether to queue deferred autofix and formatting for agent_settled.
       * Defaults to true. When true, publishes `pilens:format:queued` on `pi.events`
       * for newly-queued files (resolving the v1 event drop in mutation-bridge).
       * Set to false to suppress both queueing and event emission.
       */
      deferAutofix?: boolean;
      importsChanged?: boolean;
    }
  | {
      /** Whole-file authorship (creation or complete replacement). */
      kind: "write";
      // The authored bytes are not part of v2 yet: binding creation read
      // evidence from them is #3524's design (G9), and the field had no
      // consumer (#4145 review F4).
      /**
       * Whether to queue deferred autofix and formatting for agent_settled.
       * Defaults to true. When true, publishes `pilens:format:queued` on `pi.events`
       * for newly-queued files. Set to false to suppress both queueing and event emission.
       */
      deferAutofix?: boolean;
      importsChanged?: boolean;
    }
  | {
      /**
       * Lifecycle deletion: removes file from read records, writtenThisSession,
       * and knownPathIndex, and notifies LSP DidClose / FileChangeType.Deleted (3).
       * Mutually exclusive with `read`. Never calls recordWritten and emits no change-log receipt.
       * Requires file to no longer exist on disk at the moment of recording.
       */
      kind: "delete";
    };

export interface BridgeEntry {
  /**
   * Path to the file. Non-empty string.
   * Preserves caller's raw display path verbatim (matching v1 read-bridge.ts:137-139
   * and mutation-bridge.ts:322). Scope check runs deps.isRecordable(filePath) directly
   * on the input string without pre-resolving; internal map keying is handled downstream
   * via normalizeFilePath / normalizeEphemeralMapKey.
   */
  filePath: string;

  /** Optional caller identity for logging and telemetry (e.g. "my-tool"). */
  consumer?: string;

  /** Mutation facet (at most one). */
  mutate?: MutationFacet;

  /** Read facet (at most one). Mutually exclusive with mutate.kind: "delete". */
  read?: ReadFacet;
}

export type RecordReason =
  | "malformed"
  | "out-of-scope"
  | "ignored"
  | "no-read-guard"
  | "stale-lineage"
  | "bookkeeping-error";

export type RecordOutcome =
  | { accepted: true }
  | { accepted: false; reason: RecordReason };

export interface RecordResult {
  read?: RecordOutcome;
  mutate?: RecordOutcome;
}

export interface PiLensIOBridge {
  readonly version: 2;
  /**
   * Synchronously records file I/O operations.
   * Atomic: executes mutate before read.
   * Evaluates per-facet scope and #2465 flag gates.
   * Never throws.
   */
  record(entry: BridgeEntry): RecordResult;
}

/** Convenience accessor performing symbol lookup + version === 2 check. */
export function getIOBridge(): PiLensIOBridge | undefined;
```

---

## 4. Keel Architectural Review

| Keel Dimension | Concern | Current Design / Trap | Defect / Risk | Proposed Normative Rule | Justification |
|---|---|---|---|---|---|
| **Authority** | Path Normalization (§3, F1) | Pre-resolving `filePath` against `deps.getProjectRoot()` at the bridge entry. | Clobbers the caller's raw display path and creates key divergence if resolution semantics drift from `ReadGuard.key()` / `normalizeFilePath`. Violates AGENTS Shape #1 and display-path preservation. | `filePath` MUST be a non-empty string (`typeof filePath === "string" && filePath.length > 0`). Evaluated via `deps.isRecordable(filePath)` directly. The bridge NEVER pre-resolves or clobbers `filePath`. Internal canonicalization and map keying remain strictly encapsulated in downstream owners (`ReadGuard.key()` via `normalizeFilePath` and `normalizeEphemeralMapKey`). | Preserves exact v1 shim parity (`read-bridge.ts:137-139`, `mutation-bridge.ts:322`), preserves original caller display paths, and prevents divergent path keys. |
| **Negative Path** | Invariant Conflict (§5) | `mutate: { kind: "delete" }` combined with `read`. | Contradictory state: deleting a file while binding a read on it creates a zombie read record on an absent file. | Validation strictly rejects `mutate.kind === "delete" && read !== undefined` with `{ accepted: false, reason: "malformed" }` for both facets. | Preserves invariant closure: an absent file has no read coverage. |
| **Negative Path** | Contiguous Span Bounds (§5) | `content` passed with `ranges.length !== 1`. | Unclear line mapping if multiple disjoint ranges are passed with one text buffer. | If `content !== undefined`, require `ranges.length === 1`. If `ranges.length === 0`, `content` must be omitted or `""`. Else reject with `"malformed"`. | Enforces D7 deterministically; eliminates semantic ambiguity. |
| **Negative Path** | Disk Failure in "disk" mode (§5) | `evidence: "disk"` on unreadable or deleted file. | Synchronous `fs.readFileSync` could throw an uncaught exception, crashing the host. | Disk reads in `"disk"` mode wrapped in try/catch. On failure, return `read: { accepted: false, reason: "bookkeeping-error" }`. | Preserves D9 (never throws). |
| **Negative Path** | Delete Confirmation & Seam (F3) | Fabricating a change-log receipt, omitting enclosing flag gates (!no-read-guard, !no-lsp), or misordering confirmation gates. | Emitting LSP notifications when no-lsp is active (regression against v1 tool-result), or leaving zombie records in readGuard.reads when files are deleted on disk. | Wrapped by the enclosing `!getFlag("no-read-guard")` gate, followed by the 4 confirmed-delete gates in production order, shared with the native bash path (`judgeConfirmedDelete`, `clients/confirmed-delete.ts`): (1) `isExternalOrVendorFile` -> `"out-of-scope"`; (2) `isPathIgnoredByProject` -> `"ignored"`; (3) `hasKnownPath`: an untracked path that is absent returns `{ accepted: true }` without notifying LSP, and one still on disk returns `bookkeeping-error`; (4) `existsSync` confirm: a tracked file still on disk returns `{ accepted: false, reason: "bookkeeping-error" }` (v2 refinement; the bash path skips it). Action: `forgetPath(filePath)` and, unless `no-lsp`, `notifyExternalFileChange(filePath, 3)`; `no-lsp` suppresses only the notification. Bypasses `recordWritten` and emits NO change-log receipt. | Aligns with tool-result delete lifecycle and flags; refines disk-still-exists into explicit bookkeeping-error; closes zombie-record leaks without fabricated receipts. |
| **State & Timing** | Lineage / Branch Fence (§3, §5) | Delayed write arriving after session `/tree` or shutdown. | Stale write accepted across epoch boundary, corrupting branch turn state (#3620). | `mutate` validates `runtime.readGuard.currentBranchEpoch`. If branch changed or lineage retired, call `recordDroppedRead` (`clients/session-scope.ts:281-301`, emitting `session-scope-read-dropped` at `clients/session-scope.ts:297`) and return `mutate: { accepted: false, reason: "stale-lineage" }`. If epoch is malformed, call `recordDegradationOnce` (`clients/mutation-bridge.ts:264`, emitting `mutation-bridge-invalid-branch-epoch`). | Preserves TLA+ `session-lifecycle` model and degradation accounting. |
| **Boundaries** | Flag & Scope Gating (§4) | Collapsing `isRecordable` into a single combined check. | If `no-read-guard` is set, a single gate drops mutation turn-state and change logs (#2465). | Gating is strictly per-facet: `read` gates on `!noReadGuard && isRecordable`; `mutate` gates on `isRecordable`; read-guard write stamp gates on `!noReadGuard`. | Preserves independent accountability of turn-state vs read-guard. |
| **Retirement** | Legacy Shims & First-Wins (§8) | Old extensions calling `read-bridge` or `mutation-bridge`. | In fresh processes, mounts v1 shims delegating to `ioBridge.record()`. If a dirty process already mounted legacy v1, first-wins retains incumbent. | Mount shims for `Symbol.for("pi-lens:read-bridge")` and `Symbol.for("pi-lens:mutation-bridge")` delegating to `ioBridge.record()`. Document first-wins behavior. | Zero-friction backward compatibility. |
| **Observability** | Pull-Only Observability (Shape #31, F5) | Unobservable drops or citing non-existent degradation IDs. | Blind spots in monitors and analyzers; silent drops violate Shape #31. | State exact sinks with literal citations: (1) Read log provenance: v1 shim sets `source: "bridge:<consumer>"` (`clients/read-bridge.ts:207`); v2 native sets `source: "io-bridge:<consumer>"` (`[NEW]` in `clients/io-bridge.ts:NEW`, matching `ReadRecord.source` type at `clients/read-guard.ts:55`), written to `read-guard.log`; (2) `turn-state.json` via `deps.getCacheManager().addModifiedRange` (`clients/mutation-bridge.ts:382`); (3) Change-log receipt via `runtime.recordProjectMutation` (`clients/mutation-bridge.ts:393`, edit/write only); (4) Stale lineage write: `session-scope-read-dropped` (`clients/session-scope.ts:297`); (5) Foreign epoch: `mutation-bridge-invalid-branch-epoch` (`clients/mutation-bridge.ts:264`); (6) [NEW] Bridge-level drop telemetry: declare NEW `DegradationKind` union members in `clients/degradation-ledger.ts:40+`: `"io-bridge-read-dropped"` and `"io-bridge-mutate-dropped"`. Caller-synchronous outcome is also immediately returned in `RecordResult`. | Total observability across existing and new streams; fully verifiable by automated tests. |
| **Side Channels** | Event Bus Parity (`pi.events`) | `mutation-bridge.ts:431` calls `runtime.deferMutation` without calling `publishFormatQueued`. | Tools listening on `pi.events` for `pilens:format:queued` never receive notice when mutations are recorded through the bridge, causing unexpected formatting at `agent_settled` to invalidate in-process line leases and anchors mid-session (AGENTS Shape #5; refs Rianico/pi-better-edit#32). | When `mutate` queues deferred format/autofix (`deferAutofix !== false`), `io-bridge` MUST invoke `publishFormatQueued` (`clients/format-events-publish.ts:187`) for newly-queued files. Passing `deferAutofix: false` suppresses both queueing and bus emission. | Closes the side-channel drop between native tool results and bridge mutations; provides deterministic warning before `agent_settled` rewrites. |

---

## 5. AI Engineering & Usability Review

### 1. One-Page Learnability
The interface is compact, strongly typed, and self-documenting. The four operations (`read`, `edit`, `write`, `delete`) map directly to the developer's mental model.

### 2. Ordered Producer Guide
Producers follow a clean 3-step lifecycle:
```typescript
// 1. Discover
const bridge = getIOBridge();
if (!bridge) return; // Bridge absent or unsupported version

// 2. Formulate Entry (e.g. Hashline Edit + Preview)
const result = bridge.record({
  filePath: "src/app.ts", // relative or absolute string preserved
  consumer: "my-tool",
  mutate: {
    kind: "edit",
    ranges: [[12, 15]],
  },
  read: {
    ranges: [[8, 25]],
    content: previewText, // raw lines 8-25
  },
});

// 3. Inspect Result
if (!result.mutate?.accepted) countDrop("mutate", result.mutate?.reason);
if (!result.read?.accepted) countDrop("read", result.read?.reason);
```

### 3. D5 Evidence Disambiguation
- **Coverage-Only (Default)**: Passing `read: { ranges: [[10, 20]] }` without `content` or `lineHashes` credits lines 10–20 in `ReadGuard` coverage math, but does **not** read disk or bind line hashes. If lines 10–20 are modified externally, `FileTime` flags staleness and blocks the next edit.
- **In-Memory Hash Evidence**: Passing `content` (or `lineHashes`) hashes the text in memory via `deliveredLineEvidence(text, offset)` and populates `lineHashes`. If the file is modified externally but lines 10–20 remain intact, `canIgnoreStalenessByHashes` allows the next edit without blocking.
- **Disk Evidence (`evidence: "disk"`)**: Explicitly requests pi-lens to read the file from disk and compute line hashes.

### 4. Full-File Read vs Content Binding (F7 Clarification)
For a whole-file read `ranges: [[1, lineCount]]`, passing `content` derives in-memory line hashes for lines $1 \dots lineCount$. It does **not** synthesize a whole-file `contentBinding` (which binds `mtime` and `sha256` from disk). In `evidence: "caller"` mode, `contentBinding` is omitted, cleanly avoiding the #3652 false-block hazard.

### 5. Producer Footguns & Safeguards
- **Footgun: 0-indexed line numbers**: Bridge requires 1-indexed line numbers (`[1, 10]`). Ranges with $start < 1$ or $start > end$ are deterministically rejected as `"malformed"`.
- **Footgun: Diff markers in `content`**: If a tool passes diff output (`+const x = 1`) instead of raw file lines, line hashes will not match on-disk bytes. Docs prominently warn: *`content` must be raw file text, never diff hunks*.
- **Footgun: Delete followed by edit**: Deleting a file clears read coverage. Re-creating a file must be submitted as `mutate: { kind: "write" }`.
- **Footgun: Deleting a file that still exists on disk**: If a caller calls `mutate: { kind: "delete" }` before removing the file from the filesystem, `nodeFs.existsSync(filePath)` fails the confirm gate and returns `{ accepted: false, reason: "bookkeeping-error" }`. The on-disk deletion must precede or occur synchronously with the bridge call.

---

## 6. Verification Plan

### A. Unit Tests (`tests/clients/io-bridge.test.ts`)
- **Facet Validation Matrix**: Exhaustive testing of invalid inputs returning `"malformed"`:
  - Empty path string `""`.
  - Zero-indexed ranges (`[0, 10]`), inverted ranges (`[10, 5]`), non-integer ranges.
  - Multi-range with `content` (`ranges: [[1, 5], [10, 15]]` + `content`).
  - `delete` combined with `read`.
  - `lineHashes` with out-of-range keys (e.g. key `30` when range is `[1, 10]`).
- **Path Parity & Display Preservation Matrix (F1)**:
  - Red-before-green witness: pass a relative path (`"src/app.ts"`) through:
    1. v1 shim `recordRead`: verify `deps.isRecordable("src/app.ts")` called; verify `ReadRecord.filePath === "src/app.ts"`; verify `ReadGuard.key("src/app.ts")` normalization.
    2. v1 shim `recordMutation`: verify `deps.isRecordable("src/app.ts")` called; verify `addModifiedRange` called with `"src/app.ts"`.
    3. v2 bridge `record`: verify identical outcomes, with display path preserved verbatim and no clobbering.
- **Scope & Flag Gating Matrix (#2465)**:
  - Out-of-project paths return `{ accepted: false, reason: "out-of-scope" }`.
  - `no-read-guard` flag active: `read` returns `{ accepted: false, reason: "no-read-guard" }`; `mutate` returns `{ accepted: true }` but skips `ReadGuard.recordWritten`.
- **Delete Seam & Flag Gates Matrix (F3)**:
  - Enclosing flag gates:
    - `no-read-guard` active: skips read-guard eviction, returns `{ accepted: false, reason: "no-read-guard" }`.
    - `no-lsp` active: eviction `readGuard.forgetPath` runs, but `notifyExternalFileChange(filePath, 3)` is suppressed.
  - 4 inner gates in production order (`judgeConfirmedDelete`, `clients/confirmed-delete.ts`, shared with the native bash path):
    1. External / vendor path (`isExternalOrVendorFile`): returns `{ accepted: false, reason: "out-of-scope" }`.
    2. Ignored path (`isPathIgnoredByProject`): returns `{ accepted: false, reason: "ignored" }`.
    3. Untracked path (`!hasKnownPath`): if file absent, returns `{ accepted: true }`; zero LSP notifications sent. If it is still on disk, returns `{ accepted: false, reason: "bookkeeping-error" }`.
    4. Disk confirm (`nodeFs.existsSync`): if file still exists on disk, returns `{ accepted: false, reason: "bookkeeping-error" }`.
  - Confirmed delete on tracked path: calls `forgetPath(filePath)` and `notifyExternalFileChange(filePath, 3)`. Asserts NO `recordProjectMutation` or `addModifiedRange` invoked.
- **Observability & Degradation Ledger Matrix (F5)**:
  - Telemetry witness: trigger bridge drop on read and mutate; flush `latency.log` (via `getGlobalPiLensLogDir()` sink) and read back records, asserting:
    - `kind: "io-bridge-read-dropped"`, `subject: "${consumer}:${reason}"`.
    - `kind: "io-bridge-mutate-dropped"`, `subject: "${consumer}:${reason}"`.
  - Stale lineage write: asserts emission of `session-scope-read-dropped` (`clients/session-scope.ts:297`).
  - Malformed branch epoch: asserts emission of `mutation-bridge-invalid-branch-epoch` (`clients/mutation-bridge.ts:264`).

### B. Seam Integration Probes & Red-Before-Green Witnesses

#### 1. Witness for Write-Before-Read Atomic Ordering
- **Production Seam**: `ReadGuard.checkEdit` -> `ioBridge.record(...)` -> `ReadGuard.checkEdit`.
- **Probe Scenario**: An edit occurs to a file that was previously read. The producer submits a compound entry:
  ```typescript
  ioBridge.record({
    filePath,
    mutate: { kind: "edit", ranges: [[10, 15]] },
    read: { ranges: [[5, 25]], content: postMutationContext }
  });
  ```
- **Red Witness (Order Inversion)**: The order does not change an immediate `checkEdit`: the #4145 probe found the same verdict for every order, and there is no `file_time_stale` reason. What it changes is `consumedReadFiles`. `recordWritten` marks a file's existing reads consumed, and `recordRead` makes them outstanding again. Read-then-mutate therefore leaves the preview read consumed, and a consumed read is evictable on idle and under the file cap: after the idle window the read is gone and the next edit blocks as never read.
- **Green Witness**: With `mutate` running before `read`, the preview read is the last word and stays outstanding, so idle eviction cannot drop it. `tests/clients/io-bridge.test.ts` "keeps the compound call's preview read outstanding through idle eviction" pins this; swapping the facets reds it (`expected [] to have a length of 1`).

#### 2. Witness for D5 Coverage-Only Default
- **Production Seam**: `ioBridge.record` -> `readGuard.reads.get(filePath)`.
- **Probe Scenario**: Record a read with `read: { ranges: [[1, 10]] }` without `content` or `lineHashes`.
- **Red Witness (Unwanted Disk Hashing)**: If the bridge silently read disk, `storedRecord.lineHashes` would be populated.
- **Green Witness**: `storedRecord.lineHashes` is strictly `undefined`. Zero disk reads occur.

#### 3. Witness for Delete Lifecycle Eviction (F3)
- **Production Seam**: `ioBridge.record` -> `readGuard.hasKnownPath` + `notifyExternalFileChange`.
- **Probe Scenario**: A file with existing read records is deleted via `mutate: { kind: "delete" }` after on-disk removal.
- **Witness**: `readGuard.hasKnownPath(filePath) === false`, `readGuard.reads.has(filePath) === false`, `writtenThisSession.has(filePath) === false`, and mock LSP receives FileChangeType 3. Asserts NO change log receipt was appended.

---

## 7. Issues & Status

- **Open Defects / Ambiguities**: **None**.
  - **F1 (Path Resolution & Display Parity)**: Fully resolved. `filePath` non-empty string preserved verbatim without re-resolving or clobbering at bridge layer; unit test matrix verifies v1 parity.
  - **F3 (Delete Seam & Flag Gates)**: Fully resolved. The enclosing `!getFlag("no-read-guard")` gate, then the 4 confirmed-delete gates shared with the native bash path (`clients/confirmed-delete.ts`), followed by `forgetPath` and, unless `no-lsp`, `notifyExternalFileChange`. Dropped fabricated change-log receipt.
  - **F5 (Observability & Exact Citations)**: Fully resolved. Read log provenance uses `bridge:<consumer>` for v1 shim (`clients/read-bridge.ts:207`) and `io-bridge:<consumer>` as `[NEW]` for v2 native (`ReadRecord.source` type at `clients/read-guard.ts:55`). Re-uses existing `session-scope-read-dropped` (`clients/session-scope.ts:297`) and `mutation-bridge-invalid-branch-epoch` (`clients/mutation-bridge.ts:264`); explicitly declares `[NEW]` `DegradationKind` union members `"io-bridge-read-dropped"` and `"io-bridge-mutate-dropped"` in `clients/degradation-ledger.ts:40+` with test reading `latency.log`.
- **Maintainer Decisions**: the maintainer accepted this design on #4145 (2026-10-08): the D5/D6 evidence model, the public field set, relative paths out of scope, and a tracked `docs/rfcs/`.
