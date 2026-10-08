# Migration Guide: File I/O Lifecycle Bridge v1 → v2

**Tracking RFC:** [RFC 3654](rfcs/3654-unified-io-bridge-v2.md)  
**Tracking Issue:** [apmantza/pi-lens#3654](https://github.com/apmantza/pi-lens/issues/3654)  
**Applicability:** Producers interacting with pi-lens via `Symbol.for("pi-lens:read-bridge")` or `Symbol.for("pi-lens:mutation-bridge")`.

---

## 1. Who is Affected

This guide applies to authors and maintainers of pi coding-agent extensions, tools, and integrations that report file read or mutation events to `pi-lens` out-of-band:
- Multi-file editing extensions and hash-anchor tools.
- Custom LSP or code-generation harnesses operating outside native pi tool hooks.
- Internal callers transitioning from dual legacy bridge invocations to the unified v2 bridge.

---

## 2. What Remains Unchanged (Frozen v1 Compatibility)

Under **Decision D14** (Backward-Compatible Refinement):
- **Symbol Availability**: `Symbol.for("pi-lens:read-bridge")` and `Symbol.for("pi-lens:mutation-bridge")` continue to be mounted alongside v2 in the same first-wins pass.
- **Return Conventions**:
  - `readBridge.recordRead(...)` returns `void`.
  - `mutationBridge.recordMutation(...)` returns `boolean` (`true` if recorded, `false` if rejected).
- **Semantics & Keying**:
  - Path arguments are accepted as strings without clobbering caller display paths.
  - Map keys in `ReadGuard` and `CacheManager` are derived identically.
  - No v1-valid call is re-keyed by upgrading `pi-lens`, and every v1 call keeps its return value.
- **Two recorded differences** (the v1 read shim now runs v2's `disk`-evidence read):
  - A read of a file that is absent when the call lands records nothing; v1 recorded coverage for it. The drop is an `io-bridge-read-dropped` ledger row.
  - A zero-line read (`requestedLimit: 0`) of a non-empty or unreadable file is still dropped, but its ledger row is `io-bridge-read-dropped` (subject `<consumer>:bookkeeping-error`) instead of `read-bridge-zero-line-dropped`.

---

## 3. Call-to-Call Mapping

| Operation | v1 Legacy Call | v2 Unified Call |
|---|---|---|
| **Read File Window** | `readBridge.recordRead({ filePath, requestedOffset: 10, requestedLimit: 20, consumer: "my-tool" })` | `ioBridge.record({ filePath, consumer: "my-tool", read: { ranges: [[10, 29]], evidence: "disk" } })` |
| **Read Entire File** | `readBridge.recordRead({ filePath, requestedOffset: 1, consumer: "my-tool" })` | `ioBridge.record({ filePath, consumer: "my-tool", read: { ranges: [[1, lineCount]], content: inMemoryText } })` |
| **Partial Edit** | `mutationBridge.recordMutation({ filePath, editRanges: [[12, 15]], kind: "edit", importsChanged: false })` | `ioBridge.record({ filePath, mutate: { kind: "edit", ranges: [[12, 15]], importsChanged: false } })` |
| **Whole-File Write** | `mutationBridge.recordMutation({ filePath, kind: "write" })` | `ioBridge.record({ filePath, mutate: { kind: "write" } })` |
| **Atomic Edit + Read** | *Requires 2 separate calls to two different global symbols* | `ioBridge.record({ filePath, mutate: { kind: "edit", ranges: [[10, 15]] }, read: { ranges: [[5, 25]], content: previewText } })` |
| **File Deletion** | *Not supported in v1* | `ioBridge.record({ filePath, mutate: { kind: "delete" } })` |

---

## 4. Refinements in v2

| Feature | Category | Description |
|---|---|---|
| **Atomic Mutate-Before-Read** | `COMPATIBLE` | Compound `{ mutate, read }` calls guarantee `mutate` runs before `read`, so the preview read stays outstanding: a write marks the file's earlier reads consumed (evictable on idle), and the read that follows it is not. |
| **In-Memory Hash Evidence** | `OPT-IN` | Passing `content` (or `lineHashes`) hashes in memory, eliminating two synchronous `fs.readFileSync` calls per read (#3651). |
| **Coverage-Only Reads** | `OPT-IN` | Default `evidence: "caller"` records line range coverage in `ReadGuard` without reading or hashing disk. |
| **Explicit Zero-Line Reads** | `COMPATIBLE` | `ranges: []` records an empty/0-byte read without tripping staleness checks (#3652). |
| **Lifecycle Deletion** | `OPT-IN` | `mutate: { kind: "delete" }` verifies the file is absent from disk, evicts `readGuard` records, and notifies LSP DidClose / FileChangeType 3 without corrupting session state. |
| **Deferred Format Event Bus Parity** | `COMPATIBLE` | When `deferAutofix !== false`, queuing deferred formatting reliably emits `pilens:format:queued` on `pi.events`, warning in-process listeners before `agent_settled` rewrites. |

---

## 5. Recommended Migration Steps

1. **Feature-Detect v2**:
   ```typescript
   import { getIOBridge, IO_BRIDGE_SYMBOL } from "pi-lens/clients/io-bridge"; // or via Symbol.for("pi-lens:io-bridge")

   const ioBridge = (globalThis as any)[Symbol.for("pi-lens:io-bridge")];
   if (ioBridge && ioBridge.version === 2) {
     ioBridge.record({
       filePath,
       mutate: { kind: "edit", ranges: [[10, 20]] },
       read: { ranges: [[1, 50]], content: fileBuffer },
     });
   } else {
     // Graceful fallback to legacy v1 symbols
     const mutBridge = (globalThis as any)[Symbol.for("pi-lens:mutation-bridge")];
     mutBridge?.recordMutation({ filePath, editRanges: [[10, 20]], kind: "edit" });
     const readBridge = (globalThis as any)[Symbol.for("pi-lens:read-bridge")];
     readBridge?.recordRead({ filePath, requestedOffset: 1, requestedLimit: 50 });
   }
   ```

2. **Leverage In-Memory Content**:
   When reading or previewing diffs, supply `content: previewBuffer` in the `read` facet. This avoids redundant disk reads and makes preview verification resilient to external file timestamp drift.

3. **Handle Deletions Explicitly**:
   When removing a file, delete the file from the filesystem first, then record `mutate: { kind: "delete" }` to prevent zombie records in `ReadGuard`.

---

## 6. Drift Policy & Stability Guarantees

- **Shim Immutability**: The v1 shims mounted at `Symbol.for("pi-lens:read-bridge")` and `Symbol.for("pi-lens:mutation-bridge")` are strictly frozen compatibility layers. They will never adopt breaking changes or alter return types.
- **Process Singleton Guarantee**: The bridge is registered via `registerProcessBridge` (`clients/process-bridge.ts`), enforcing first-wins registration and `Object.freeze`. A running process cannot have its bridge mutated or replaced midway through a session.
