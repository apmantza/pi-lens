/**
 * LSP `textDocument/didChange` sync-kind negotiation (#1669).
 *
 * A server advertises how it wants document changes described via
 * `ServerCapabilities.textDocumentSync`, either as a bare
 * `TextDocumentSyncKind` number (the legacy pre-3.0 shape) or as a
 * `TextDocumentSyncOptions` object whose `change` field carries the kind.
 * pi-lens always sent a single whole-document `{ text }` change event — valid
 * for `Full` (1) and harmless for `None` (0, since the server ignores content
 * changes entirely), but out of spec for `Incremental` (2): an
 * Incremental-only server expects every change event to carry a `range`.
 *
 * This module is the pure negotiation core, mirroring `position-encoding.ts`'s
 * shape: read the kind from the server's `initialize` reply, defaulting to
 * `Full` when the server doesn't advertise one — the same shape pi-lens has
 * always sent, so an unrecognized/absent value never regresses `Full`/`None`
 * behavior.
 */

export type TextDocumentSyncKind = 0 | 1 | 2;

export const TEXT_DOCUMENT_SYNC_KIND_FULL: TextDocumentSyncKind = 1;
export const TEXT_DOCUMENT_SYNC_KIND_INCREMENTAL: TextDocumentSyncKind = 2;

function isSyncKind(value: unknown): value is TextDocumentSyncKind {
	return value === 0 || value === 1 || value === 2;
}

/**
 * The `change` sync kind the server negotiated, read from its `initialize`
 * reply. Defaults to `Full` (pi-lens's historical always-whole-document
 * behavior) when the server omits `textDocumentSync` entirely, or advertises
 * a shape/value this function doesn't recognize.
 */
export function negotiateSyncKind(
	serverCapabilities: unknown,
): TextDocumentSyncKind {
	const sync = (
		serverCapabilities as { textDocumentSync?: unknown } | null | undefined
	)?.textDocumentSync;
	// Legacy shape: the whole field IS the kind.
	if (isSyncKind(sync)) return sync;
	// 3.0+ shape: `TextDocumentSyncOptions.change`.
	if (sync && typeof sync === "object") {
		const change = (sync as { change?: unknown }).change;
		if (isSyncKind(change)) return change;
	}
	return TEXT_DOCUMENT_SYNC_KIND_FULL;
}
