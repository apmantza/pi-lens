# LSP document lifecycle model

A TLA+ model of one document's `didOpen` / `didChange` / `didClose` ordering
between the LSP client (`clients/lsp/client.ts`) and a server, across a
rename. The `TLA+ models` CI job checks every config here against its
`\* expect:` line (see `formal/file-locks/README.md`).

## What the model covers

- **Touches** of the old path (edits, cascade and warm-attach syncs), which
  go through the per-path notify queue (`enqueueDocumentNotify`).
- **The queue runner** (`handleNotifyChangeOnce`):
  - if `openDocuments` has the path, it sends `didChange`;
  - otherwise it sends a fallback `didOpen`, and marks the path open after
    the send resolves.
- **Rename** (`LSPService.renameFile`): for each client whose
  `isDocumentOpen` is true, `closeDocument` sends `didClose` and deletes the
  path after the send resolves. It does not go through the notify queue.
- **The server,** reading the client's messages in order.

vscode-jsonrpc fixes a message's position when `sendNotification` is called.
So a check and the send in the same tick are one step, and the bookkeeping
after `await` is another.

## Invariants

- `LifecycleOrder`: the server never gets `didChange` or `didClose` for a
  closed document, or `didOpen` for an open one.
- `NoPhantomAfterRename`: once the rename is done and everything has
  drained, the old path is not open on the server.

## Results

| Config | Verdict |
|---|---|
| `RenameOpenDocument.cfg` | `LifecycleOrder` violated (#3477) |
| `RenameOpeningDocument.cfg` | `NoPhantomAfterRename` violated (#3477) |
| `RenameLateTouch.cfg` | `NoPhantomAfterRename` violated (#3477) |
| `QueuedCloseOpen.cfg`, `QueuedCloseOpening.cfg` | pass (candidate fix) |

The three violations have three causes:

- **`RenameOpenDocument`:** a change queued behind one in flight runs
  while rename's `didClose` is in flight, sees the path still open, and
  sends `didChange` after `didClose`.
- **`RenameOpeningDocument`:** rename starts while a fallback `didOpen` is in
  flight. `isDocumentOpen` is still false, so rename closes nothing, and the
  path is then marked open.
- **`RenameLateTouch`:** a change queued before the rename runs after the
  close, finds the path gone from `openDocuments`, and re-opens the
  renamed-away file with a fallback `didOpen`.

All three reproduce on the real client with gated sends (#3477 has the
replays, which become the fix's regression tests):

```text
didChange -> didClose -> didChange                             (RenameOpenDocument)
didChange -> didClose -> didOpen, open after rename: true      (RenameLateTouch)
didOpen, isDocumentOpen at rename: false, open after: true     (RenameOpeningDocument)
```

**The candidate fix** (`QueuedClose = TRUE`) has two parts:
- `closeDocument` runs as an entry on the path's notify queue, so it waits
  for the entry in flight and reads `openDocuments` when it runs.
- A queued entry for a path that rename closed is dropped instead of
  re-opened.

Mutating either part breaks a fix config. Superseding the unstarted entry is
not needed: the drop already covers it.

## Scope

Not modelled:
- `handleNotifyOpen`'s own `pendingOpens` path;
- the reopen after a failed close;
- diagnostics.

The model over-approximates scheduling: the queue runner starts on a
microtask, so an entry is only delayed past a rename when an earlier entry
for the same path is still in flight. The real-client replays above show
all three orderings are reachable that way.
