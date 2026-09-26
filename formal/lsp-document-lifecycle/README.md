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
- **Rename** (`LSPService.renameFile`): before #3477, for each client whose
  `isDocumentOpen` was true, `closeDocument` sent `didClose` and deleted the
  path after the send resolved, beside the notify queue. Since #3477
  (`QueuedClose = TRUE`) the close is an entry on the path's notify queue,
  sent to every active client.
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

| Config | Verdict | States |
|---|---|---|
| `RenameOpenDocument.cfg` | pass (after #3477) | 20 |
| `RenameOpeningDocument.cfg` | pass (after #3477) | 14 |
| `RenameLateTouch.cfg` | pass (after #3477) | 20 |
| `QueuedCloseOpen.cfg`, `QueuedCloseOpening.cfg` | pass (the fix, two touches) | 44 each |
| `MutNoQueuedClose.cfg` | `LifecycleOrder` violated (the code before #3477) | 43 |

Before #3477 the three `Rename*` configs set `QueuedClose = FALSE` and were
violated (`LifecycleOrder`, `NoPhantomAfterRename`, `NoPhantomAfterRename`).
`MutNoQueuedClose` keeps the first of them as a non-vacuity check. The three
violations had three causes:

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

**The fix** (#3477, `QueuedClose = TRUE`) has two parts:
- `closeDocument` runs as an entry on the path's notify queue, so it waits
  for the entry in flight and reads `openDocuments` when it runs. Rename
  queues it on every active client, so an open still in flight is closed
  once it lands.
- A queued entry for a path that rename closed is dropped instead of
  re-opened.

Mutating either part breaks a fix config. Superseding the unstarted entry is
not needed: the drop already covers it.

How the code realises the drop, and where it is narrower than the model:
- An unsent touch pending when the close is queued is superseded by it, and
  a touch that arrives before the close has run is not sent. Its caller
  resolves `false`, so `touchFile` claims nothing for it.
- A later touch of a path the client closed is dropped only when no file
  exists there (`closedAndGone`). The model's drop is permanent, because its
  `rename = "done"` is also the moment the file moved. The code keeps a
  legitimate re-open working (the file renamed back, or a new file at the
  old path). A touch that runs between the close and the rename's disk move
  is not modelled and would still open the old path.
- Rename's re-open after a close that timed out is queued behind that close
  and is not sent while it is still in flight; once the close lands, client
  and server agree the document is closed, and the next touch opens it.

## Scope

Not modelled:
- `handleNotifyOpen`'s own `pendingOpens` path;
- the reopen after a failed close;
- diagnostics.

The model over-approximates scheduling: the queue runner starts on a
microtask, so an entry is only delayed past a rename when an earlier entry
for the same path is still in flight. The real-client replays above show
all three orderings are reachable that way.
