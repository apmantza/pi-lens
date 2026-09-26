/**
 * pi's per-file mutation queue, for pi-lens' own in-place writers (#3506).
 *
 * pi runs tool calls in parallel and serialises its built-in `edit` and
 * `write` through `withFileMutationQueue(path)`; its extension docs require a
 * file-mutating extension to join the same queue (`@earendil-works/
 * pi-coding-agent` `docs/extensions.md` ~1925). The helper is only exposed as
 * a package export, so the pi host adapter (`index.ts`) registers a lazy
 * `import()` of the package here, and every other host (the MCP adapter,
 * direct unit callers) runs the writers unqueued, as before.
 *
 * Which copy of the package that import reaches depends on how pi loaded
 * pi-lens. pi's loader hands `dist/index.js` to jiti, and jiti first imports
 * an ESM-typed `.js` NATIVELY. In an installed pi-lens that native import
 * fails, because `dist/index.js` statically imports `@earendil-works/pi-tui`,
 * which is not resolvable from the package; jiti then falls back to
 * transpiling, which rewrites `import()` to jiti's own import, and that is
 * what serves pi's running instance (`virtualModules` in the bundled CLI,
 * the dist aliases otherwise). Where pi-lens' static imports DO resolve
 * natively (a dev checkout, a project whose `node_modules` holds pi and
 * pi-tui), the native module's `import()` goes through Node's resolution and
 * can load a second copy of the SDK, whose queue does not serialise with pi's
 * edits. The lookup therefore checks the copy it got against the host's own
 * session manager (`noteHostSessionManager`) and records the outcome either
 * way.
 */
import { resolve } from "node:path";
import { recordDegradationOnce } from "./degradation-ledger.js";
import { logExtension } from "./extension-log.js";

type FileMutationQueue = <T>(
	filePath: string,
	fn: () => Promise<T>,
) => Promise<T>;

/** Loads the host SDK module that exports `withFileMutationQueue`. */
export type HostSdkLoader = () => Promise<{
	withFileMutationQueue?: unknown;
	SessionManager?: unknown;
}>;

let loadHostSdk: HostSdkLoader | undefined;
let hostQueue: Promise<FileMutationQueue | undefined> | undefined;
let hostSessionManager: unknown;

/**
 * The host's own `ctx.sessionManager`, noted at `session_start`. The SDK copy
 * the lookup resolves is the host's exactly when this is an instance of that
 * copy's `SessionManager` class.
 */
export function noteHostSessionManager(sessionManager: unknown): void {
	hostSessionManager = sessionManager;
}

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
		subject: "withFileMutationQueue",
		reason,
	});
	return undefined;
}

/**
 * The resolved queue, used either way: a second copy's queue still orders
 * pi-lens' own writers, and a false alarm must not cost pi's real queue.
 */
function resolved(sdk: {
	withFileMutationQueue?: unknown;
	SessionManager?: unknown;
}): FileMutationQueue | undefined {
	if (typeof sdk.withFileMutationQueue !== "function")
		return unavailable("the host SDK exports no withFileMutationQueue");
	const hostCopy =
		hostSessionManager === undefined || typeof sdk.SessionManager !== "function"
			? undefined
			: hostSessionManager instanceof sdk.SessionManager;
	if (hostCopy === false) {
		unavailable(
			"the host SDK import loaded a second copy of the package (the host's session manager is not its SessionManager), so its queue does not order pi's own edits",
		);
	} else {
		logExtension({
			subsystem: "file-mutation-queue",
			level: "debug",
			message: "resolved the host's withFileMutationQueue",
			metadata: { hostCopy: hostCopy ? "verified" : "unverified" },
		});
	}
	return sdk.withFileMutationQueue as FileMutationQueue;
}

function resolveHostQueue(loader: HostSdkLoader) {
	hostQueue ??= loader().then(resolved, (failure: unknown) =>
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
 * through its own after-reads, or undefined outside the pi host adapter, so a
 * writer there never yields for a queue that does not exist (the drain's
 * worker order depends on it): `acquire` resolves once the queue is entered
 * (idempotent), `release` lets the next queued mutation run (idempotent, and a
 * no-op when nothing was acquired). `outlive` hands the hold a writer that a
 * bound gave up on while its child process runs on: `release` then waits for
 * it to settle, so the child cannot write over an edit queued behind the hold.
 */
export interface FileMutationHold {
	acquire(): Promise<void>;
	outlive(writer: Promise<unknown>): void;
	release(): void;
}

export function holdFileMutationQueue(
	filePath: string,
): FileMutationHold | undefined {
	if (!loadHostSdk) return undefined;
	let entered: Promise<void> | undefined;
	let releaseHeld: () => void = () => {};
	const outliving: Promise<unknown>[] = [];
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
		outlive(writer) {
			outliving.push(writer);
		},
		release() {
			if (outliving.length === 0) releaseHeld();
			else void Promise.allSettled(outliving).then(() => releaseHeld());
		},
	};
}
