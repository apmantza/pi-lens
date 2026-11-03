// flake-shape: real-process-spawn — Real child transport and lifecycle are the subject; a process stub cannot exercise the wire and teardown behavior.
/**
 * #2436 regression: `tests/fixtures/fake-lsp-server.mjs` used to have no
 * lifetime bound of its own — only whatever `afterEach`/kill the spawning
 * test happened to register. A vitest worker fork force-killed under load
 * (or by tinypool's own "Timeout terminating forks worker" escape hatch —
 * see vitest.config.ts) never runs that `afterEach`, so the fixture outlived
 * it: a real orphan was found on disk an hour after its parent process no
 * longer existed, holding its worktree directory open (`git worktree
 * remove` → Permission denied / Device or resource busy).
 *
 * Both spawn the fixture via a parent SHIM (`fake-lsp-server-parent-shim.mjs`)
 * that mimics the worst teardown shape the evidence points at: piped stdio,
 * `detached: true` — no OS job/process-group auto-reap at all (the exact
 * shape `launchLSP` uses on POSIX, and the shape a failed Windows
 * job-nesting assignment degrades to) — then SIGKILLs the shim outright: no
 * graceful shutdown, no `afterEach`, nothing JS-level. Both drive the fixture
 * through `FAKE_LSP_WEDGE_STDIN_AFTER_INIT`, which installs a real
 * non-`unref`'d `setInterval` (the same shape
 * service-notify-cpu-liveness.test.ts and shutdown-live-wedged-process.test.ts
 * spawn) so death is provably caused by one of the fixture's own watchdog
 * triggers, not by an idle event loop that would have exited on its own the
 * moment stdin closed regardless of any fix.
 *
 * Two cases, one per trigger in fake-lsp-server.mjs's own comment:
 *
 *   1. Default env — stdin EOF is armed. A paused Readable (which is what
 *      `FAKE_LSP_WEDGE_STDIN_AFTER_INIT` leaves stdin in) still delivers the
 *      underlying `end` event once the fd itself reports EOF, and SIGKILLing
 *      the shim closes its end of the pipe unconditionally (the OS closes a
 *      dead process's fds, pipes included) — so this case reaps via EOF,
 *      fast (well under 100ms observed).
 *   2. `FAKE_LSP_SKIP_EOF_EXIT=1` additionally set on the fixture's own env —
 *      disables the EOF trigger entirely, isolating the `process.ppid`
 *      liveness poll as the ONLY thing that can end the fixture. This is the
 *      trigger that exists for the shape stdin EOF cannot cover on its own:
 *      a pipe write-end held open by something other than the fixture's
 *      direct parent (e.g. Windows handle-inheritance capture by a
 *      long-lived process — see clients/lsp/client.ts:1278-1286). Reaping
 *      here can only be the poll, at up to PARENT_WATCHDOG_INTERVAL_MS
 *      (1000ms) plus scheduling overhead — observed 713-936ms end to end.
 */
import { type ChildProcess, spawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { FAKE_LSP_SERVER_PATH } from "../../support/fake-lsp-server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, "../../fixtures");
const SHIM_PATH = path.join(FIXTURE_DIR, "fake-lsp-server-parent-shim.mjs");

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitUntil(
	predicate: () => boolean,
	timeoutMs: number,
	stepMs = 50,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await new Promise((resolve) => setTimeout(resolve, stepMs));
	}
	return predicate();
}

describe("fake-lsp-server.mjs — parent-death watchdog (#2436)", () => {
	let shim: ChildProcess | undefined;
	let serverPid: number | undefined;

	afterEach(() => {
		if (shim && shim.exitCode === null && shim.signalCode === null) {
			shim.kill("SIGKILL");
		}
		if (serverPid !== undefined && isAlive(serverPid)) {
			try {
				process.kill(serverPid, "SIGKILL");
			} catch {
				/* already gone */
			}
		}
		shim = undefined;
		serverPid = undefined;
	});

	async function spawnWedgedFixtureViaShim(
		extraEnv: NodeJS.ProcessEnv,
	): Promise<number> {
		shim = spawn(process.execPath, [SHIM_PATH, FAKE_LSP_SERVER_PATH], {
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...process.env,
				FAKE_LSP_WEDGE_STDIN_AFTER_INIT: "1",
				...extraEnv,
			},
		});

		let out = "";
		shim.stdout?.on("data", (chunk: Buffer) => {
			out += chunk.toString("utf8");
		});

		const gotPid = await waitUntil(
			() => /CHILD_PID:(\d+)/.test(out),
			5_000,
			20,
		);
		expect(gotPid).toBe(true);
		const match = /CHILD_PID:(\d+)/.exec(out);
		expect(match).not.toBeNull();
		const pid = Number(match?.[1]);
		expect(isAlive(pid)).toBe(true);

		// Give the handshake (initialize -> initialized, sent by the shim) time
		// to actually reach the fixture and arm FAKE_LSP_WEDGE_STDIN_AFTER_INIT's
		// non-unref'd interval — the load-bearing part of this repro.
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(isAlive(pid)).toBe(true);
		return pid;
	}

	it("exits within 2s of its parent being SIGKILLed, via stdin EOF, with no graceful shutdown", async () => {
		serverPid = await spawnWedgedFixtureViaShim({});

		// No graceful shutdown, no exit notification, no afterEach on the
		// shim's side — kill the parent outright, exactly like a force-killed
		// vitest worker fork.
		shim?.kill("SIGKILL");

		const died = await waitUntil(
			() => !isAlive(serverPid as number),
			2_000,
			50,
		);
		expect(died).toBe(true);
	}, 10_000);

	it("exits within 2s via the ppid poll ALONE when FAKE_LSP_SKIP_EOF_EXIT disables stdin EOF", async () => {
		serverPid = await spawnWedgedFixtureViaShim({
			FAKE_LSP_SKIP_EOF_EXIT: "1",
		});

		shim?.kill("SIGKILL");

		const died = await waitUntil(
			() => !isAlive(serverPid as number),
			2_000,
			50,
		);
		expect(died).toBe(true);
	}, 10_000);
});
