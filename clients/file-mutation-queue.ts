/**
 * pi's per-file mutation queue, for pi-lens' own in-place writers (#3506).
 *
 * pi runs tool calls in parallel and serialises its built-in `edit` and
 * `write` through `withFileMutationQueue(path)`; its extension docs require a
 * file-mutating extension to join the same queue (`@earendil-works/
 * pi-coding-agent` `docs/extensions.md` ~1925). The helper is only exposed as
 * a package export, which pi's extension loader serves to the extension from
 * its own running instance, so the pi host adapter (`index.ts`) registers the
 * lookup here and every other host (the MCP adapter, direct unit callers)
 * runs the writers unqueued, as before.
 */
import { resolve } from "node:path";
import { recordDegradationOnce } from "./degradation-ledger.js";

type FileMutationQueue = <T>(
	filePath: string,
	fn: () => Promise<T>,
) => Promise<T>;

/** Loads the host SDK module that exports `withFileMutationQueue`. */
export type HostSdkLoader = () => Promise<{ withFileMutationQueue?: unknown }>;

let loadHostSdk: HostSdkLoader | undefined;
let hostQueue: Promise<FileMutationQueue | undefined> | undefined;

/** Register (or, with undefined, drop) the host SDK lookup. */
export function setHostFileMutationQueueLoader(
	loader: HostSdkLoader | undefined,
): void {
	loadHostSdk = loader;
	hostQueue = undefined;
}

function unavailable(reason: string): undefined {
	recordDegradationOnce({
		kind: "host-file-mutation-queue-unavailable",
		subject: "@earendil-works/pi-coding-agent",
		reason,
	});
	return undefined;
}

function resolveHostQueue(loader: HostSdkLoader) {
	hostQueue ??= loader().then(
		(sdk) =>
			typeof sdk.withFileMutationQueue === "function"
				? (sdk.withFileMutationQueue as FileMutationQueue)
				: unavailable("the host SDK exports no withFileMutationQueue"),
		(failure: unknown) =>
			unavailable(failure instanceof Error ? failure.message : String(failure)),
	);
	return hostQueue;
}

/**
 * Run `fn` inside pi's mutation queue for `filePath`, or directly when no
 * host queue is registered or reachable.
 */
export function withHostFileMutationQueue<T>(
	filePath: string,
	fn: () => Promise<T>,
): Promise<T> {
	const loader = loadHostSdk;
	if (!loader) return fn();
	return resolveHostQueue(loader).then((queue) =>
		queue ? queue(resolve(filePath), fn) : fn(),
	);
}

/**
 * A hold on the queue that a pipeline takes at its first write and keeps
 * through its own after-reads: `acquire` resolves once the queue is entered
 * (idempotent), `release` lets the next queued mutation run (idempotent, and a
 * no-op when nothing was acquired).
 */
export interface FileMutationHold {
	acquire(): Promise<void>;
	release(): void;
}

export function holdFileMutationQueue(filePath: string): FileMutationHold {
	let entered: Promise<void> | undefined;
	let releaseHeld: () => void = () => {};
	return {
		acquire() {
			entered ??= new Promise<void>((resolveEntered, rejectEntered) => {
				const held = new Promise<void>((resolveHeld) => {
					releaseHeld = resolveHeld;
				});
				withHostFileMutationQueue(filePath, () => {
					resolveEntered();
					return held;
				}).catch(rejectEntered);
			});
			return entered;
		},
		release() {
			releaseHeld();
		},
	};
}
