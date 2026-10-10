/**
 * What pi-lens ALREADY tracks, and where an observed change is replayed to
 * (#2430).
 *
 * The observational net has to answer one question in three places — the
 * `tool_call` pre-snapshot, the `tool_result` diff, and the `agent_settled`
 * sweep — and the answer must be the same set every time, or a file drifts in
 * and out of coverage depending on which seam asked. This module is that single
 * source: the read-guard's read/write set, the widget's diagnostic files, and
 * the documents open on any live language server rooted at the workspace.
 *
 * There is deliberately NO workspace walk here. The whole point of #2430 item 3
 * is that the turn-boundary net costs a bounded number of stats over files
 * pi-lens has already seen; a walk would make the settle boundary pay for the
 * project's size on every run.
 *
 * The replay recorder is the mutation bridge. Nothing in this module writes
 * bookkeeping itself: an observed change goes through exactly the seam an
 * in-process producer uses, so the read-guard stamp, the `turn-state.json`
 * entry, the attributed change-log receipt and the deferred format at
 * `agent_settled` are the SAME code path a `write` takes.
 */
import { getLSPService } from "./lsp/capabilities.js";
import { getMutationBridge } from "./mutation-bridge.js";
import type { ObservedReplayEntry } from "./observed-mutation.js";
import { getFileDiagnosticSummaries } from "./widget-state.js";

/** The read-guard surface this module needs, structurally. */
export interface TrackedPathReadGuard {
	getTrackedPaths?: () => string[];
	getReadHistory?: (
		filePath: string,
	) => Array<{ lineHashes?: Record<number, string> }>;
}

export interface TrackedPathArgs {
	readGuard?: TrackedPathReadGuard;
	/** Workspace root, used to scope the LSP pool enumeration. */
	cwd?: string;
	/** Hard cap; the caller's budget owns the number, not this module. */
	limit: number;
}

/**
 * Files pi-lens has read, written, diagnosed, or opened on a language server.
 *
 * Order is deliberate and the cap is applied ACROSS the whole union: the
 * read-guard set is the most direct evidence the agent is working on a file,
 * so it is added first and a truncating cap never drops it in favour of a
 * cascade neighbour some server happened to open.
 */
export function collectTrackedPaths(args: TrackedPathArgs): string[] {
	const tracked = new Set<string>();
	const add = (paths: Iterable<string>): void => {
		for (const filePath of paths) {
			if (tracked.size >= args.limit) return;
			if (typeof filePath === "string" && filePath.length > 0)
				tracked.add(filePath);
		}
	};
	try {
		add(args.readGuard?.getTrackedPaths?.() ?? []);
	} catch {
		// A guard mid-eviction contributes nothing; the sweep stays advisory.
	}
	try {
		add(getFileDiagnosticSummaries().map((summary) => summary.filePath));
	} catch {
		// Widget state is display state; it must never break the net.
	}
	if (args.cwd) {
		try {
			add(getLSPService().getOpenDocumentPaths(args.cwd));
		} catch {
			// No pool, or a client torn down mid-enumeration.
		}
	}
	return [...tracked];
}

/**
 * Read-guard stored per-line hashes for a file, newest record first.
 *
 * This is the "content diff against the read-guard's stored content" #2430
 * asks for: #505 already keeps an FNV-1a hash per line for every read, so a
 * post-mutation re-hash names exactly the lines that changed without pi-lens
 * having to have kept the bytes.
 */
export function storedLineHashesFor(
	readGuard: TrackedPathReadGuard | undefined,
	filePath: string,
): Record<number, string> | undefined {
	try {
		const history = readGuard?.getReadHistory?.(filePath) ?? [];
		for (let index = history.length - 1; index >= 0; index -= 1) {
			const hashes = history[index]?.lineHashes;
			if (hashes && Object.keys(hashes).length > 0) return hashes;
		}
	} catch {
		// No history is the same answer as no hashes: derive no ranges.
	}
	return undefined;
}

/**
 * Replay an observed change through the mutation bridge.
 *
 * Returns `false` when the bridge is not mounted (pi-lens not activated, or a
 * unit test that never registered one) or when the bridge itself declined the
 * entry — out of scope, ignored, or a bookkeeping failure. A `false` is a real
 * answer the caller acts on: it does NOT count as evidence the tool was clean.
 */
export function replayThroughMutationBridge(
	entry: ObservedReplayEntry,
): boolean {
	const bridge = getMutationBridge();
	if (!bridge) return false;
	return bridge.recordMutation(entry);
}
