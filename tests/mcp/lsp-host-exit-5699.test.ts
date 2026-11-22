// flake-shape: real-process-spawn — the subject is which processes outlive a real MCP host process: the host's own exit and signal handlers, a language server it spawned in its own process group, and the next host's start-time reaper, none of which an in-process double has.
// flake-shape: ungoverned-wait-for — the server is the host's child and, once the host is gone, nobody's; its start is visible only as the pid file it writes and its death only as that pid going away, neither exposes an awaitable, and each poll is bounded by its own timeout.
/**
 * #5699: a language server that ignores stdin EOF and SIGTERM must be gone
 * after its MCP host ends, by every route the host can end: stdin end (the
 * client disconnects), SIGTERM, and SIGKILL. Before the fix the MCP host's
 * only exit work closed its IPC socket, so the server outlived it on all
 * three routes, and no MCP process ever ran the orphan reaper, so a second
 * MCP session left it running too (audit A1, A6).
 *
 * Each case starts the real `mcp/server.js` over the real stdio transport,
 * whose `rust` server is overridden to `tests/fixtures/stubborn-lsp-server.mjs`
 * (only SIGKILL ends it), and makes one `pilens_diagnostics` call so the host
 * launches it through the production LSP path. The host then ends one way,
 * and the case reads whether the server's pid survives.
 *
 * - stdin end and SIGTERM: the server is gone, and stdin end leaves no row
 *   for the host in `instances.json` (the row goes only after the kill is
 *   confirmed). Stdin end also ends it with the registry switched off
 *   (`PI_LENS_INSTANCE_REGISTRY=0`), where no registry exit hook runs.
 * - SIGKILL: no code of the host runs, so the server survives that host
 *   (the stated residual); the next MCP host's start reaps it from the row
 *   the dead host left, and prunes the row.
 * - the `fresh` worker (`mcp/worker.ts`, audit A5/A6): it exits through
 *   `process.exit` with its servers alive, and before the fix left its
 *   `instances.json` row behind with them. Its row is gone once it exits.
 *
 * Linux only: the cases read process liveness and adopt the server for
 * cleanup through `/proc` (`tests/support/kill-guard.ts`). lane: unit (Linux).
 * Windows ends the direct child through libuv's job object (#5694), which
 * tests/clients/lsp/windows-server-containment-5694.test.ts pins.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { realIsPidAlive } from "../../clients/pid-liveness.js";
import { setupTestEnvironment } from "../clients/test-utils.js";
import { adoptProcessTree } from "../support/kill-guard.js";
import { readNdjsonRows } from "../support/ndjson-rows.js";
import { McpHarness } from "./harness.js";

const STUBBORN_SERVER = fileURLToPath(
	new URL("../fixtures/stubborn-lsp-server.mjs", import.meta.url),
);

/** How long a server may take to die once its host is gone (a SIGKILL from
 *  the host's exit handler lands in microseconds; the margin is a loaded box). */
const DEATH_WAIT_MS = 10_000;
/** How long the next host's start-time reaper may take: it runs fire and
 *  forget after the host's start, and queries `ps` before each kill. */
const REAP_WAIT_MS = 30_000;

const servers: number[] = [];
const harnesses: McpHarness[] = [];
const cleanups: Array<() => void> = [];

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.dispose();
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
	for (const cleanup of cleanups.splice(0)) cleanup();
});

/** A Cargo project whose `rust` server is the stubborn fixture. */
function stubbornRustProject() {
	const env = setupTestEnvironment("lsp-host-exit-5699-");
	cleanups.push(env.cleanup);
	const home = path.join(env.tmpDir, "home");
	fs.mkdirSync(home);
	const pidFile = path.join(env.tmpDir, "server.pid");
	fs.writeFileSync(
		path.join(home, "lsp.json"),
		JSON.stringify({
			serverOverrides: {
				rust: { command: [process.execPath, STUBBORN_SERVER, pidFile] },
			},
			disabledServers: ["ast-grep", "typos", "opengrep"],
		}),
	);
	const project = path.join(env.tmpDir, "proj");
	fs.mkdirSync(path.join(project, "src"), { recursive: true });
	fs.writeFileSync(
		path.join(project, "Cargo.toml"),
		'[package]\nname = "probe"\nversion = "0.1.0"\nedition = "2021"\n',
	);
	const file = path.join(project, "src", "main.rs");
	fs.writeFileSync(file, "fn main() {}\n");
	return { home, project, file, pidFile };
}

function startHost(
	ws: ReturnType<typeof stubbornRustProject>,
	env: Record<string, string> = {},
): McpHarness {
	const harness = new McpHarness({
		cwd: ws.project,
		env: {
			PI_LENS_HOME: ws.home,
			PI_LENS_TEST_MODE: "0",
			PI_LENS_DISABLE_LSP_INSTALL: "1",
			PI_LENS_LSP_DIAGNOSTICS_MAX_WAIT_MS: "1000",
			...env,
		},
	});
	harnesses.push(harness);
	return harness;
}

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

/** One `pilens_diagnostics` call, then the server's pid and its host's,
 *  adopted for cleanup while the host is still alive. */
async function launchServer(
	harness: McpHarness,
	ws: ReturnType<typeof stubbornRustProject>,
): Promise<{ server: number; host: number }> {
	await harness.request(
		56991,
		"tools/call",
		{
			name: "pilens_diagnostics",
			arguments: {
				source: "lsp",
				scope: "paths",
				serverScope: "primary",
				severity: "all",
				waitMs: 500,
				paths: [ws.file],
			},
		},
		60_000,
	);
	const pids = await vi.waitFor(
		() => {
			const read = readPids(ws.pidFile);
			if (!read) throw new Error("still waiting for the server pid");
			return read;
		},
		{ timeout: 30_000, interval: 50 },
	);
	adoptProcessTree(pids.host, [pids.server]);
	servers.push(pids.server);
	return pids;
}

/** Whether `pid` is still alive after `waitMs`. */
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

function registryRowPids(home: string): number[] {
	try {
		const file = JSON.parse(
			fs.readFileSync(path.join(home, "instances.json"), "utf-8"),
		) as { instances: Array<{ pid: number }> };
		return file.instances.map((row) => row.pid);
	} catch {
		return [];
	}
}

function exited(pid: number): Promise<void> {
	return vi.waitFor(
		() => {
			if (realIsPidAlive(pid)) throw new Error(`host ${pid} still running`);
		},
		{ timeout: DEATH_WAIT_MS, interval: 50 },
	);
}

// lane: unit (Linux); /proc is the liveness and ownership evidence.
describe.runIf(process.platform === "linux")(
	"a language server that ignores EOF and SIGTERM ends with its MCP host (#5699)",
	() => {
		it("ends the server and drops the host's row when the client closes stdin", async () => {
			const ws = stubbornRustProject();
			const harness = startHost(ws);
			const pids = await launchServer(harness, ws);
			expect(registryRowPids(ws.home)).toContain(pids.host);

			await harness.closeInput();

			expect({
				serverSurvives: await survives(pids.server, DEATH_WAIT_MS),
				hostRowLeft: registryRowPids(ws.home).includes(pids.host),
			}).toEqual({ serverSurvives: false, hostRowLeft: false });
		}, 120_000);

		// The registry's exit hook also ends the held servers; with the registry
		// switched off, the spawn seam's own exit handler is the only one left.
		it("ends the server on stdin end with the instance registry switched off", async () => {
			const ws = stubbornRustProject();
			const harness = startHost(ws, { PI_LENS_INSTANCE_REGISTRY: "0" });
			const pids = await launchServer(harness, ws);

			await harness.closeInput();

			expect(await survives(pids.server, DEATH_WAIT_MS)).toBe(false);
		}, 120_000);

		it("ends the server when the host is sent SIGTERM", async () => {
			const ws = stubbornRustProject();
			const harness = startHost(ws);
			const pids = await launchServer(harness, ws);

			process.kill(pids.host, "SIGTERM");
			await exited(pids.host);

			expect(await survives(pids.server, DEATH_WAIT_MS)).toBe(false);
		}, 120_000);

		it("drops the fresh worker's row when the worker exits with its servers", async () => {
			const ws = stubbornRustProject();
			const harness = startHost(ws);
			const response = await harness.request(
				56992,
				"tools/call",
				{
					name: "pilens_analyze",
					arguments: { path: ws.file, mode: "fresh" },
				},
				120_000,
			);
			expect(JSON.stringify(response)).not.toContain("fresh analyze failed");
			// The worker launched at least one server: a pid other than the
			// host's wrote the spawn record (the worker is dead once the call
			// returns, since analyzeFileFresh settles on its close).
			const { rows, skipped } = readNdjsonRows<{
				phase?: string;
				pid?: number;
			}>(path.join(ws.home, "latency.log"));
			expect(skipped).toBe(0);
			const workerPids = [
				...new Set(
					rows
						.filter((row) => row.phase === "lsp_server_spawned")
						.map((row) => row.pid)
						.filter((pid): pid is number => typeof pid === "number"),
				),
			].filter((pid) => !realIsPidAlive(pid));
			expect(workerPids.length).toBeGreaterThan(0);

			expect(
				registryRowPids(ws.home).filter((pid) => workerPids.includes(pid)),
			).toEqual([]);
		}, 150_000);

		it("reaps a SIGKILLed host's server at the next MCP host's start", async () => {
			const ws = stubbornRustProject();
			const first = startHost(ws);
			const pids = await launchServer(first, ws);

			await first.kill();
			// The stated residual: no code of a SIGKILLed host runs, so its
			// server outlives it until the next host starts.
			expect(realIsPidAlive(pids.server)).toBe(true);
			expect(registryRowPids(ws.home)).toContain(pids.host);

			const second = startHost(ws);
			await second.waitForStderr("[pi-lens-mcp] ready");

			expect({
				serverSurvives: await survives(pids.server, REAP_WAIT_MS),
				deadRowLeft: await vi
					.waitFor(
						() => {
							if (registryRowPids(ws.home).includes(pids.host))
								throw new Error("dead row still listed");
						},
						{ timeout: REAP_WAIT_MS, interval: 100 },
					)
					.then(
						() => false,
						() => true,
					),
			}).toEqual({ serverSurvives: false, deadRowLeft: false });
		}, 150_000);
	},
);
