/**
 * #3389 — a client that disconnects mid-reply must not kill the pi host.
 *
 * ## The recurrence this guards
 *
 * `clients/warm-attach.ts`'s warm diagnostics server accepted connections with
 * a `data` handler and nothing else. `server.on("error")` covers the LISTENER,
 * not the accepted sockets, and a `net.Socket` with no `error` listener
 * rethrows — so a client that destroys its socket while the incumbent is
 * answering (the ending EVERY `requestWarmDiagnostics` timeout, schema refusal
 * and validation refusal takes) raised `Error: read ECONNRESET` as an UNCAUGHT
 * exception in the host. Measured pre-fix through this exact path in a child
 * host: exit code 17 from the probe's `uncaughtException` handler.
 *
 * ## Why a real socket
 *
 * The defect IS a Node stream event on an accepted unix socket / named pipe:
 * no in-process double emits it, and a double that did would be pinning this
 * test's own fixture rather than the host boundary. So the server is the
 * production one (`configureWarmAttach`) and the client is a real
 * `net.createConnection`. No child process and no raw timer: the accept waits
 * on the kit's `waitFor` (a `setImmediate` pump under a real-clock deadline,
 * #4865), so none of `flake-shape-ratchet`'s four detectors
 * (real-process-spawn, elapsed-time-assertion, raw-timer-wait,
 * ungoverned-wait-for) apply.
 *
 * Each test that waits on an accepted socket passes `scaledTestTimeout(20_000)`:
 * the wait's own 4,000 ms budget grows with `PI_LENS_TEST_TIMEOUT_SCALE`
 * (12,000 ms on the Windows leg), and Vitest's deadline must stay above it or a
 * never-accepted socket reports `Test timed out` instead of the wait's
 * diagnostic (#4983).
 */

import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type DegradationGroup,
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import {
	boundUnixSocketPath,
	diagnosticsIpcPathForCwd,
} from "../../clients/mcp/ipc.js";
import {
	_resetWarmAttachForTests,
	_warmAttachServerForTests,
	configureWarmAttach,
} from "../../clients/warm-attach.js";
import { removeTempDirSync } from "./test-utils.js";
import { waitFor } from "./interleaving-kit.js";
import { scaledTestTimeout } from "../support/test-timeout-scale.js";

/** One event-loop turn, including the poll phase that delivers socket I/O. */
const pump = (): Promise<void> =>
	new Promise<void>((resolve) => {
		setImmediate(resolve);
	});

/**
 * The ledger group for `kind`, once it appears. Bounded by turns, not by the
 * clock: pre-fix nothing ever records it, and the caller's first assertion is
 * the uncaught-exception list, so an exhausted pump reports the real defect
 * rather than a timeout.
 */
async function waitForGroup(
	kind: string,
): Promise<DegradationGroup | undefined> {
	for (let turn = 0; turn < 500; turn++) {
		const group = getDegradationSummary().find(
			(candidate) => candidate.kind === kind,
		);
		if (group) return group;
		await pump();
	}
	return undefined;
}

describe("warm diagnostics server: an accepted socket's error event (#3389)", () => {
	let root: string;
	let home: string;
	let savedHome: string | undefined;
	let savedOptIn: string | undefined;
	const uncaught: Error[] = [];
	const capture = (failure: Error): void => {
		uncaught.push(failure);
	};

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-3389-root-"));
		home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-3389-home-"));
		savedHome = process.env.PI_LENS_HOME;
		savedOptIn = process.env.PI_LENS_WARM_ATTACH;
		process.env.PI_LENS_HOME = home;
		process.env.PI_LENS_WARM_ATTACH = "1";
		uncaught.length = 0;
		resetDegradationLedger();
		// The host's own default disposition is what kills it; capturing here
		// keeps the escape observable instead of taking the whole worker down.
		process.on("uncaughtException", capture);
	});

	afterEach(() => {
		process.off("uncaughtException", capture);
		_resetWarmAttachForTests();
		resetDegradationLedger();
		if (savedHome === undefined) delete process.env.PI_LENS_HOME;
		else process.env.PI_LENS_HOME = savedHome;
		if (savedOptIn === undefined) delete process.env.PI_LENS_WARM_ATTACH;
		else process.env.PI_LENS_WARM_ATTACH = savedOptIn;
		removeTempDirSync(root);
		removeTempDirSync(home);
	});

	it("survives a client that disconnects mid-reply, and counts the errno", async () => {
		await configureWarmAttach(root);
		const endpoint = diagnosticsIpcPathForCwd(root, process.pid);
		const client = net.createConnection(boundUnixSocketPath(endpoint));
		// The peer half is not under test: the client is the side that walks away.
		client.on("error", () => {});
		await new Promise<void>((resolve, reject) => {
			client.once("connect", resolve);
			client.once("error", reject);
		});
		// An unusable request line the server answers immediately, and a reset
		// before the reply can land — `requestWarmDiagnostics`'s `finish()`
		// destroys its socket exactly this way on every timeout and refusal.
		client.write("not-json\n");
		client.destroy();

		const group = await waitForGroup("warm-attach-socket-error");
		// F1: pre-fix the socket error escapes — `write EPIPE` in this
		// in-process run, `read ECONNRESET` in the child-host probe. Either way,
		// in production it is the host's last breath.
		expect(uncaught).toEqual([]);
		// F2: a listener that swallowed silently would leave a peer resetting
		// every request invisible to `pilens degradation` / `/lens-perf`.
		expect(group?.count ?? 0).toBeGreaterThanOrEqual(1);
		// The subject is the errno the socket reported (ECONNRESET on read, EPIPE
		// when the reply write loses the race), not a fixed label: a constant
		// would make every peer failure one indistinguishable row.
		expect(group?.latestReasons[0]?.subject).toMatch(/^E[A-Z]+$/);
		expect(group?.latestReasons[0]?.reason).toContain(
			group?.latestReasons[0]?.subject ?? "",
		);
	});

	it(
		"records an unknown subject for a code-less error and leaves the connection usable",
		async () => {
			// Review round 1, F3395-01: the `error` EVENT channel accepts any `Error`,
			// not only Node's errno-carrying system errors, so the handler's
			// `?? "unknown"` arm IS reachable — round 1 of this PR wrongly declared it
			// unreachable. Two things must hold: one bounded row whose subject says
			// `unknown` rather than a missing or empty string, and a connection that
			// stays usable, because a code-less error is not evidence the transport is
			// gone (a real system failure destroys the stream before the handler runs;
			// this one does not).
			const accepted: net.Socket[] = [];
			await configureWarmAttach(root);
			// The accepted socket has exactly one input channel and no other reachable
			// handle: `node:net`'s ESM namespace is not configurable, so the factory
			// cannot be wrapped from here. The server's OWN `connection` event hands
			// over the same socket production's handler already received.
			_warmAttachServerForTests()?.on("connection", (socket) => {
				accepted.push(socket);
			});
			const endpoint = diagnosticsIpcPathForCwd(root, process.pid);
			const client = net.createConnection(boundUnixSocketPath(endpoint));
			client.setEncoding("utf8");
			client.on("error", () => {});
			await new Promise<void>((resolve, reject) => {
				client.once("connect", resolve);
				client.once("error", reject);
			});
			await waitFor(
				() => accepted.length,
				(n) => n > 0,
				{
					timeoutMs: 4_000,
					yieldControl: pump,
				},
			);
			const socket = accepted[0];
			expect(socket).toBeDefined();
			socket?.emit("error", new Error("code-less socket failure"));

			const group = await waitForGroup("warm-attach-socket-error");
			expect(uncaught).toEqual([]);
			expect(group?.count ?? 0).toBe(1);
			expect(group?.latestReasons[0]?.subject).toBe("unknown");
			expect(group?.latestReasons[0]?.reason).toContain(
				"code-less socket failure",
			);
			// Still usable: the request written after the event is still answered, so
			// the handler cannot be turned into a teardown without this failing.
			const reply = await new Promise<string>((resolve) => {
				client.once("data", (chunk) => resolve(String(chunk)));
				client.write("not-json\n");
			});
			expect(reply).toContain("error");
			client.end();
		},
		scaledTestTimeout(20_000),
	);

	it.each([
		["empty", ""],
		["whitespace-only", "   "],
	])(
		"records an unknown subject for a %s errno on the accepted socket",
		async (_label, code) => {
			// Verify round 2, F3395-02: a socket error carrying `code: ""` wrote
			// `subject: ""` — a row that discriminates nothing and renders as
			// `⚠ warm-attach-socket-error: 1 — : …`. Blank and missing are one case
			// for a subject; the rule itself lives in the ledger's write paths
			// (`tests/clients/degradation-ledger.test.ts`), and this case pins the
			// INPUT CHANNEL that reached it.
			const accepted: net.Socket[] = [];
			await configureWarmAttach(root);
			_warmAttachServerForTests()?.on("connection", (socket) => {
				accepted.push(socket);
			});
			const client = net.createConnection(
				boundUnixSocketPath(diagnosticsIpcPathForCwd(root, process.pid)),
			);
			client.on("error", () => {});
			await new Promise<void>((resolve, reject) => {
				client.once("connect", resolve);
				client.once("error", reject);
			});
			await waitFor(
				() => accepted.length,
				(n) => n > 0,
				{
					timeoutMs: 4_000,
					yieldControl: pump,
				},
			);
			accepted[0]?.emit(
				"error",
				Object.assign(new Error("malformed errno"), { code }),
			);

			const group = await waitForGroup("warm-attach-socket-error");
			expect(uncaught).toEqual([]);
			expect(group?.count ?? 0).toBe(1);
			expect(group?.latestReasons[0]?.subject).toBe("unknown");
			client.end();
		},
		scaledTestTimeout(20_000),
	);

	it("records nothing when a client closes cleanly after an unterminated line", async () => {
		// The negative direction of the same discriminator (state table R7): a
		// client that sends a partial request and closes is ordinary traffic —
		// `end`, `close`, no `error` — and a ledger row here would be noise on
		// every abandoned edit.
		await configureWarmAttach(root);
		const endpoint = diagnosticsIpcPathForCwd(root, process.pid);
		const client = net.createConnection(boundUnixSocketPath(endpoint));
		client.on("error", () => {});
		await new Promise<void>((resolve, reject) => {
			client.once("connect", resolve);
			client.once("error", reject);
		});
		client.write('{"route":"diagnostics"');
		await new Promise<void>((resolve) => {
			client.once("close", resolve);
			client.end();
		});
		for (let turn = 0; turn < 50; turn++) await pump();

		expect(uncaught).toEqual([]);
		expect(
			getDegradationSummary().find(
				(candidate) => candidate.kind === "warm-attach-socket-error",
			),
		).toBeUndefined();
	});
});
