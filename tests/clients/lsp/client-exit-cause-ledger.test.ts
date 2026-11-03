// flake-shape: real-process-spawn — the ledger records the exit code and empty stderr of a real child that closed unexpectedly; a double never produces a real close
/**
 * #1969: an LSP child that closes unprompted leaves a CAUSE record.
 *
 * Live evidence (2026-08-21): an ast-grep child closed with `code=1` and empty
 * stderr, 14 times in one day. Downstream the session showed 19
 * `lsp_client_skipped_broken` cooldowns and 32 `lsp-scanner-coverage-gap`
 * records — all fallout, no cause. The degradation ledger is what a session
 * health read consults, and it held nothing about the death itself.
 *
 * The fix records `lsp-server-unexpected-close` on the child's `close` event,
 * keyed by `serverId`, carrying the exit code, the signal, and whether stderr
 * carried anything. `close` rather than `exit`, so "stderr was empty" is a
 * statement about the server and not a race with the pipe.
 *
 * Two halves, and the second is the mutation guard: an intentional
 * `shutdown()` must record NOTHING. Deleting the `state.shutdownRequested`
 * gate turns every eviction into a fake crash, and reds the second test.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../../clients/degradation-ledger.js";
import { spawnFakeLspServer } from "../../support/fake-lsp-server.js";

function closeGroup() {
	return getDegradationSummary().find(
		(group) => group.kind === "lsp-server-unexpected-close",
	);
}

/**
 * Resolve once the child has emitted `close` AND the listeners registered
 * before ours have run.
 *
 * This is the anti-vacuity signal for every "records NOTHING" test here. The
 * handler under test hangs off `close`, so waiting on anything earlier proves
 * nothing: `exit` fires BEFORE `close`, so a wait on `exitCode`/`signalCode`
 * can return while the handler has not run yet, and the assertion that follows
 * passes for the wrong reason. That is exactly how the first version of the
 * initialize-timeout test went green against unfixed code.
 *
 * Attach BEFORE triggering the teardown: a `once` listener added after the
 * event has already fired never resolves. Node dispatches listeners in
 * registration order, and production's handler is installed during
 * `createLSPClient`, so by the time this one runs the ledger write has either
 * happened or been correctly skipped. The extra macrotask hop covers handlers
 * that defer their own work.
 */
function awaitChildClose(child: {
	once: (event: "close", listener: () => void) => unknown;
}): Promise<void> {
	return new Promise<void>((resolve) => {
		child.once("close", () => setTimeout(resolve, 0));
	});
}

describe("LSP client — unexpected close records its cause (#1969)", () => {
	let client:
		| Awaited<
				ReturnType<
					typeof import("../../../clients/lsp/client.js").createLSPClient
				>
		  >
		| undefined;

	beforeEach(() => {
		resetDegradationLedger();
	});

	afterEach(async () => {
		if (client) {
			try {
				await client.shutdown();
			} catch {
				/* the server may already be gone */
			}
			client = undefined;
		}
		resetDegradationLedger();
	});

	it("records a ledger entry naming the server, the exit code, and the empty stderr", async () => {
		const { createLSPClient } = await import("../../../clients/lsp/client.js");
		const proc = await spawnFakeLspServer({
			cwd: process.cwd(),
			env: {
				FAKE_LSP_SELF_EXIT_CODE: "1",
				FAKE_LSP_SELF_EXIT_DELAY_MS: "50",
			},
		});
		client = await createLSPClient({
			serverId: "fake",
			process: proc,
			root: process.cwd(),
		});

		await vi.waitFor(
			() => {
				expect(closeGroup()).toBeDefined();
			},
			{ timeout: 8_000, interval: 25 },
		);

		const group = closeGroup();
		expect(group?.count).toBe(1);
		const entry = group?.latestReasons.at(-1);
		expect(entry?.subject).toBe("fake");
		// The three discriminating facts the issue asks for.
		expect(entry?.reason).toContain("code=1");
		expect(entry?.reason).toContain("signal=none");
		expect(entry?.reason).toContain("stderr=empty");

		client = undefined;
	}, 15_000);

	it("records NOTHING for an intentional shutdown()", async () => {
		const { createLSPClient } = await import("../../../clients/lsp/client.js");
		const proc = await spawnFakeLspServer({
			cwd: process.cwd(),
		});
		client = await createLSPClient({
			serverId: "fake",
			process: proc,
			root: process.cwd(),
		});

		// Attach BEFORE the teardown, so the event cannot be missed.
		const closed = awaitChildClose(proc.process);
		await client.shutdown();
		client = undefined;
		await closed;

		// The handler ran and declined to record. Note what this does NOT check:
		// `proc.process.killed`. `killProcessTree` kills the process GROUP via
		// `process.kill(-pid)` (clients/lsp/client.ts:1139-1145 documents this),
		// which never sets the child handle's `killed` flag, and a signal-killed
		// child keeps `exitCode === null` with only `signalCode` set. The first
		// version of this test asserted on `killed`, passed on Windows, and went
		// red on Linux CI — catalog shape 2, a host-dependent assertion.
		expect(closeGroup()).toBeUndefined();
	}, 15_000);

	// #1969 review F2. `setupConnectionLifecycle` arms the close handler BEFORE
	// `initialize` is sent, so the initialize-timeout catch's own
	// `killProcessTree` runs against a live handler. That kill is ours, and
	// until the fix it never said so: the ledger gained an entry reading
	// "code=1 signal=none stderr=empty", character for character the ast-grep
	// signature this issue exists to make trustworthy. A server that merely
	// failed its handshake would have been indistinguishable from one that
	// crashed mid-session.
	//
	// Mutation guard for `state.shutdownRequested = true` in that catch:
	// deleting that line reds this test.
	it("records NOTHING when OUR OWN initialize-timeout kill tears the child down", async () => {
		const { createLSPClient } = await import("../../../clients/lsp/client.js");
		const proc = await spawnFakeLspServer({
			cwd: process.cwd(),
			// Never answers `initialize`, so `withTimeout` fires and the catch
			// below kills the child.
			env: { FAKE_LSP_IGNORE_INITIALIZE: "1" },
		});

		const closed = awaitChildClose(proc.process);
		await expect(
			createLSPClient({
				serverId: "fake",
				process: proc,
				root: process.cwd(),
				initializeTimeoutMs: 300,
			}),
		).rejects.toThrow();
		await closed;

		expect(closeGroup()).toBeUndefined();
	}, 15_000);
});
