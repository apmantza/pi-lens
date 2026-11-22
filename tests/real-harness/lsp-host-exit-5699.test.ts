// flake-shape: real-process-spawn — the subject is which processes outlive a real pi process when it quits or crashes: pi's own quit path (session_shutdown, then process.exit), the extension's exit listeners, a language server in its own process group, and the next session's start-time reaper, none of which an in-process tier runs.
// flake-shape: ungoverned-wait-for — the server is pi's child and, once pi is gone, nobody's; its start shows only as the pid file it writes, its death only as its pid going away, the settle's heartbeat only as the row it rewrites, and the next session's vanished marker only as a sessionstart.log line, none of which exposes an awaitable, and each poll is bounded by its own timeout.
/**
 * #5699: a language server that ignores stdin EOF and SIGTERM must be gone
 * after a pi quit, and a quit that cannot confirm the death must leave the
 * host's `instances.json` row for the next session to reap.
 *
 * Before the fix the quit's `session_shutdown` removed the row
 * (`deregisterInstance`) before anything killed the server, then sent the
 * server's group SIGTERM and put the SIGKILL on an unref'd timer that never
 * fires before pi exits. A server ignoring SIGTERM outlived pi in no record,
 * and the next session's reaper could not find it (audit A2, probe B2).
 *
 * Each case runs the real pi CLI in RPC mode with the built extension, whose
 * `rust` server is overridden (user `lsp.json` under the pinned
 * `PI_LENS_HOME`) to `tests/fixtures/stubborn-lsp-server.mjs`, and one
 * scripted `lens_diagnostics` call launches it through the production path.
 *
 * - quit: closing RPC stdin runs pi's own shutdown (`session_shutdown`
 *   reason "quit", then `process.exit(0)`). The server is gone, and pi's row
 *   is gone with it.
 * - quit that cannot confirm: an extension loaded after pi-lens SIGKILLs pi
 *   inside `session_shutdown`, after pi-lens's teardown ran and before any
 *   `exit` listener. The server survives that pi (the stated residual), and
 *   the next pi session's start reaps it from the row the quit kept.
 * - crash: an uncaught exception before any language server starts (#5733
 *   r4). pi's row stays, and the next session logs it as vanished.
 * - crash after the server started (#5744): the LSP crash guard is
 *   installed, and exits 1 through the exit listeners, so the server is gone
 *   and pi's row stays. Before #5744 the guard rethrew: Node exited 7, ran no
 *   exit listener, and the server outlived pi.
 *
 * Linux only: the cases read process liveness and adopt the server for
 * cleanup through `/proc` (`tests/support/kill-guard.ts`).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { realIsPidAlive } from "../../clients/pid-liveness.js";
import {
	claimScratchDir,
	SCRATCH_DIR_ROOT,
} from "../../scripts/lib/scratch-dir.mjs";
import { removeTempDirSync } from "../clients/test-utils.js";
import { adoptProcessTree } from "../support/kill-guard.js";
import {
	createRealPiProject,
	realHarnessFixtureRoot,
	withRealPi,
} from "../support/real-pi-harness.js";

const FIXTURE = "lsp-host-exit";
const STUBBORN_SERVER = fileURLToPath(
	new URL("../fixtures/stubborn-lsp-server.mjs", import.meta.url),
);
const KILL_ON_SHUTDOWN = path.join(
	realHarnessFixtureRoot,
	FIXTURE,
	"kill-on-shutdown-extension.mjs",
);
const CRASH = path.join(realHarnessFixtureRoot, FIXTURE, "crash-extension.mjs");
const DEATH_WAIT_MS = 10_000;
const REAP_WAIT_MS = 30_000;

const servers: number[] = [];
const dirs: string[] = [];

afterEach(() => {
	// A server that outlived its host (the defect) is this file's to end. It
	// was adopted from its live host's tree, so the kill guard lets it through.
	for (const pid of servers.splice(0)) {
		if (!realIsPidAlive(pid)) continue;
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// already gone
		}
	}
	for (const dir of dirs.splice(0)) removeTempDirSync(dir);
});

/** A pinned home whose `rust` server is the stubborn fixture, and a project
 *  both sessions of a case share. */
function stubbornHome() {
	const home = claimScratchDir(SCRATCH_DIR_ROOT, "lsp-host-exit-home");
	dirs.push(home);
	const pidFile = path.join(home, "server.pid");
	fs.writeFileSync(
		path.join(home, "lsp.json"),
		JSON.stringify({
			serverOverrides: {
				rust: { command: [process.execPath, STUBBORN_SERVER, pidFile] },
			},
			disabledServers: ["ast-grep", "typos", "opengrep"],
		}),
	);
	const project = createRealPiProject(FIXTURE, home);
	return { home, project, pidFile };
}

/** pi trusts the project (`--approve`): the override is a project-code
 *  server, which an untrusted project refuses to spawn. */
const ARGS = ["--approve"];
const ENV = {
	PI_LENS_TEST_MODE: "0",
	PI_LENS_DISABLE_LSP_INSTALL: "1",
	PI_LENS_LSP_DIAGNOSTICS_MAX_WAIT_MS: "1000",
};

function readPids(
	pidFile: string,
): { server: number; host: number } | undefined {
	try {
		const [server, host] = fs
			.readFileSync(pidFile, "utf-8")
			.trim()
			.split(" ")
			.map(Number);
		return server > 0 && host > 0 ? { server, host } : undefined;
	} catch {
		return undefined;
	}
}

/** Prompt the scripted `lens_diagnostics` call, then the server's pid and its
 *  host's, adopted for cleanup while the host is alive. */
async function launchServer(
	pi: Parameters<Parameters<typeof withRealPi>[1]>[0],
	pidFile: string,
): Promise<{ server: number; host: number }> {
	await pi.prompt("check the file");
	await pi.awaitToolResult("lens_diagnostics");
	const pids = await vi.waitFor(
		() => {
			const read = readPids(pidFile);
			if (!read) throw new Error("still waiting for the server pid");
			return read;
		},
		{ timeout: 30_000, interval: 50 },
	);
	adoptProcessTree(pids.host, [pids.server]);
	servers.push(pids.server);
	// The settle's heartbeat writes the row under the registry lock. Quit only
	// once it landed: a quit while this process's own async registry write
	// holds the lock cannot remove the row by any route (the sync removal
	// refuses to wait on its own process), and that race is not the subject.
	await pi.events("agent_end");
	await vi.waitFor(
		() => {
			const row = registryRows(path.dirname(pidFile)).find(
				(entry) => entry.pid === pids.host,
			);
			if (!row || row.heartbeatAt === row.startedAt)
				throw new Error("still waiting for the settle's heartbeat");
		},
		{ timeout: 30_000, interval: 100 },
	);
	return pids;
}

async function survives(pid: number, waitMs: number): Promise<boolean> {
	try {
		await vi.waitFor(
			() => {
				if (realIsPidAlive(pid)) throw new Error(`pid ${pid} is alive`);
			},
			{ timeout: waitMs, interval: 100 },
		);
		return false;
	} catch {
		return true;
	}
}

interface RegistryRow {
	pid: number;
	startedAt: string;
	heartbeatAt: string;
	lspChildren: Array<{ pid: number }>;
}

function registryRows(home: string): RegistryRow[] {
	try {
		return (
			JSON.parse(
				fs.readFileSync(path.join(home, "instances.json"), "utf-8"),
			) as {
				instances: RegistryRow[];
			}
		).instances;
	} catch {
		return [];
	}
}

// lane: real-harness (Linux); /proc is the liveness and ownership evidence.
describe.runIf(process.platform === "linux")(
	"a language server that ignores EOF and SIGTERM ends with a pi quit (#5699)",
	() => {
		it("ends the server and drops pi's row when pi quits", async () => {
			const ws = stubbornHome();
			const pids = await withRealPi(
				{
					fixture: FIXTURE,
					script: "script.json",
					home: ws.home,
					project: ws.project,
					env: ENV,
					args: ARGS,
				},
				async (pi) => {
					const launched = await launchServer(pi, ws.pidFile);
					await pi.quit();
					return launched;
				},
			);

			expect({
				serverSurvives: await survives(pids.server, DEATH_WAIT_MS),
				hostRowLeft: registryRows(ws.home).some((row) => row.pid === pids.host),
			}).toEqual({ serverSurvives: false, hostRowLeft: false });
		}, 180_000);

		it("keeps an unconfirmed quit's row for the next session to reap", async () => {
			const ws = stubbornHome();
			const pids = await withRealPi(
				{
					fixture: FIXTURE,
					script: "script.json",
					home: ws.home,
					project: ws.project,
					env: ENV,
					args: ARGS,
					extensions: [KILL_ON_SHUTDOWN],
				},
				async (pi) => {
					const launched = await launchServer(pi, ws.pidFile);
					await pi.quit();
					return launched;
				},
			);
			// The stated residual: pi died before its exit listeners, so the
			// server outlives it until the next session starts.
			expect(realIsPidAlive(pids.server)).toBe(true);
			expect(
				registryRows(ws.home)
					.find((row) => row.pid === pids.host)
					?.lspChildren.map((child) => child.pid),
			).toEqual([pids.server]);

			await withRealPi(
				{
					fixture: FIXTURE,
					script: "script.json",
					home: ws.home,
					project: ws.project,
					env: ENV,
					args: ARGS,
				},
				async () => {
					expect(await survives(pids.server, REAP_WAIT_MS)).toBe(false);
				},
			);
		}, 240_000);

		it("ends the server and keeps a crashed pi's row after LSP start", async () => {
			const ws = stubbornHome();
			const outcome = await withRealPi(
				{
					fixture: FIXTURE,
					script: "script.json",
					home: ws.home,
					project: ws.project,
					env: ENV,
					args: ARGS,
					extensions: [CRASH],
				},
				async (pi) => {
					const launched = await launchServer(pi, ws.pidFile);
					// Nothing emits this event: the wait ends when pi exits, and
					// rejects with pi's exit code. No request may follow the crash,
					// since a write to a dead pi's stdin fails EPIPE.
					const exitCode = pi.events("lsp-host-exit-never-emitted").then(
						() => "pi did not exit",
						(error: { code?: number | null }) => error.code,
					);
					// The command returns before its timer throws, so pi answers.
					await pi.prompt("/real-harness-crash");
					return { launched, exitCode: await exitCode };
				},
			);

			expect({
				exitCode: outcome.exitCode,
				serverSurvives: await survives(outcome.launched.server, DEATH_WAIT_MS),
				hostRowKept: registryRows(ws.home).some(
					(row) => row.pid === outcome.launched.host,
				),
			}).toEqual({ exitCode: 1, serverSurvives: false, hostRowKept: true });
		}, 180_000);

		// #5733 r4 F2: the exit hook also ran after an uncaught exception and
		// removed the crashed pi's row, so the next session had no dead row to
		// report as vanished. The crash comes before any language server starts:
		// the LSP client's crash guard is not installed yet, so Node's default
		// handler runs the exit listeners with code 1, as pi's interactive crash
		// handler does with its process.exit(1).
		it("keeps a crashed pi's row for the next session's vanished marker", async () => {
			const ws = stubbornHome();
			const host = await withRealPi(
				{
					fixture: FIXTURE,
					script: "script.json",
					home: ws.home,
					project: ws.project,
					env: ENV,
					args: ARGS,
					extensions: [CRASH],
				},
				async (pi) => {
					// session_start registers pi without awaiting the write.
					const registered = await vi.waitFor(
						() => {
							const [row] = registryRows(ws.home);
							if (!row) throw new Error("pi's row is not written yet");
							return row.pid;
						},
						{ timeout: 30_000, interval: 50 },
					);
					// The command returns before its timer throws, so pi answers.
					await pi.prompt("/real-harness-crash");
					expect(await survives(registered, DEATH_WAIT_MS)).toBe(false);
					return registered;
				},
			);
			expect(registryRows(ws.home).map((row) => row.pid)).toEqual([host]);

			const log = path.join(ws.home, "sessionstart.log");
			const marker = () =>
				(fs.existsSync(log) ? fs.readFileSync(log, "utf-8") : "")
					.split("\n")
					.find((line) => line.includes(`previous instance pid ${host} `));
			await withRealPi(
				{
					fixture: FIXTURE,
					script: "script.json",
					home: ws.home,
					project: ws.project,
					env: ENV,
					args: ARGS,
				},
				async () => {
					await vi.waitFor(
						() => {
							if (!marker()) throw new Error("no vanished marker yet");
						},
						{ timeout: REAP_WAIT_MS, interval: 100 },
					);
				},
			);
			expect(marker()).toMatch(/exited without shutdown$/);
		}, 240_000);
	},
);
