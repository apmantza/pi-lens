// flake-shape: real-process-spawn — the subject is which process the Windows kernel ends when a pi host dies: libuv's kill-on-close job holds only the host's DIRECT child, so a server behind cmd.exe survives (#5694), and no double of `node:child_process` has a job object, a TerminateProcess or a process tree to observe.
// flake-shape: ungoverned-wait-for — the server is the host's grandchild before the fix and another process's child after it; its start is visible only as the pid file it writes and its death only as that pid going away, neither exposes an awaitable, and each poll is bounded by its own timeout.
/**
 * #5694: a language server must end when its pi host ends, on Windows too,
 * whether or not the server cooperates (stdin EOF, `initialize.processId`).
 *
 * libuv puts every child it spawns without `detached` into one job object
 * marked `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK`
 * (`uv__init_global_job_handle`, src/win/process.c). The kernel ends that
 * child when the host dies by any route, and does NOT end the child's own
 * children. So the server ends with the host only when the process
 * `launchLSP` hands back IS the server. Before #5694 a spaced `.exe` path
 * (`C:\Program Files\PowerShell\7\pwsh.exe`) and an npm `.cmd` shim both ran
 * behind `cmd.exe`; the host's exit ended `cmd.exe`, and the server lived on
 * (the reporter counted 30 PowerShell Editor Services orphans, 2.0 GB).
 *
 * Each case starts a REAL host process that loads the built
 * `clients/lsp/launch.js` and launches a server that never exits by itself:
 * it ignores stdin and is never told a processId, which is the
 * "without the server's cooperation" half of the invariant. The host then
 * dies in one of the two ways a pi host can: killed outright (no pi code
 * runs), or through the production `processExiting` teardown
 * (`killProcessTree`) followed by `process.exit`.
 *
 * lane: windows-vitest (`describe.runIf(process.platform === "win32")`). POSIX
 * has no cmd.exe route and its group kill is pinned by
 * tests/clients/lsp/kill-process-tree-real-child.test.ts.
 */
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { realIsPidAlive } from "../../../clients/pid-liveness.js";
import { setupTestEnvironment, useTrackedTempDirs } from "../test-utils.js";

const LAUNCH_JS = pathToFileURL(
	path.resolve(__dirname, "../../../clients/lsp/launch.js"),
).href;
const CLIENT_JS = pathToFileURL(
	path.resolve(__dirname, "../../../clients/lsp/client.js"),
).href;

/** How long a server may take to die after its host is gone. The job ends
 *  the direct child as the host's last handle closes; the margin covers a
 *  loaded runner. */
const DEATH_WAIT_MS = 10_000;

/** A server that never exits on its own: it never reads stdin, and nothing
 *  sends it `initialize`. It records its own pid, because the pid the host
 *  holds is exactly what is in question. */
const SERVER_SOURCE = [
	'const fs = require("node:fs");',
	"fs.writeFileSync(process.argv[2], String(process.pid));",
	"setInterval(() => {}, 1000);",
].join("\n");

/** The host: launch through the production seam, report the held pid, then
 *  die as `mode` says. */
const HOST_SOURCE = `
import fs from "node:fs";
const [mode, command, script, pidFile, cwd, readyFile] = process.argv.slice(2);
const { launchLSP } = await import(${JSON.stringify(LAUNCH_JS)});
const handle = await launchLSP(command, [script, pidFile].filter(Boolean), { cwd });
fs.writeFileSync(readyFile, JSON.stringify({ pid: handle.pid, command: handle.command }));
if (mode === "processExiting") {
	const { killProcessTree } = await import(${JSON.stringify(CLIENT_JS)});
	await killProcessTree(handle.process, handle.pid, { fast: true, processExiting: true });
	process.exit(0);
}
setInterval(() => {}, 1000);
`;

/** npm cmd-shim 6.0.0's `.cmd` for a `#!/usr/bin/env node` bin (npm 9 and
 *  10), byte for byte apart from the target. */
function cmdShimV6(target: string): string {
	return [
		"@ECHO off",
		"GOTO start",
		":find_dp0",
		"SET dp0=%~dp0",
		"EXIT /b",
		":start",
		"SETLOCAL",
		"CALL :find_dp0",
		"",
		'IF EXIST "%dp0%\\node.exe" (',
		'  SET "_prog=%dp0%\\node.exe"',
		") ELSE (",
		'  SET "_prog=node"',
		"  SET PATHEXT=%PATHEXT:;.JS;=;%",
		")",
		"",
		`endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target}" %*`,
		"",
	].join("\r\n");
}

interface Route {
	/** The command the host hands `launchLSP`. */
	command: string;
	/** argv[0] of the server's script, or "" when the command carries it. */
	script: string;
}

/** `C:\…\tool dir\srv.exe`: a Node binary at a path with a space, the shape
 *  of `C:\Program Files\PowerShell\7\pwsh.exe` and of a default Node install. */
function spacedExeRoute(root: string, serverScript: string): Route {
	const dir = path.join(root, "tool dir");
	fs.mkdirSync(dir, { recursive: true });
	const exe = path.join(dir, "srv.exe");
	try {
		fs.linkSync(process.execPath, exe);
	} catch {
		fs.copyFileSync(process.execPath, exe);
	}
	return { command: exe, script: serverScript };
}

/** `<root>\tools\.bin\fake-ls.cmd`, an npm shim for `..\fake-ls\server.cjs`,
 *  the shape of every npm-installed language server pi-lens manages. */
function npmShimRoute(root: string): Route {
	const pkg = path.join(root, "tools", "fake-ls");
	const bin = path.join(root, "tools", ".bin");
	fs.mkdirSync(pkg, { recursive: true });
	fs.mkdirSync(bin, { recursive: true });
	fs.writeFileSync(path.join(pkg, "server.cjs"), SERVER_SOURCE);
	const shim = path.join(bin, "fake-ls.cmd");
	fs.writeFileSync(shim, cmdShimV6("..\\fake-ls\\server.cjs"));
	return { command: shim, script: "" };
}

const hosts: ChildProcess[] = [];
const servers: number[] = [];

/** The first defined answer of `read`, polled until `timeoutMs`. */
function waitFor<T>(
	read: () => T | undefined,
	timeoutMs: number,
	what: string,
): Promise<T> {
	return vi.waitFor(
		() => {
			const value = read();
			if (value === undefined) throw new Error(`still waiting for ${what}`);
			return value;
		},
		{ timeout: timeoutMs, interval: 50 },
	);
}

function readText(file: string): string | undefined {
	try {
		const text = fs.readFileSync(file, "utf-8");
		return text.length > 0 ? text : undefined;
	} catch {
		return undefined;
	}
}

function exited(child: ChildProcess): Promise<void> {
	return new Promise((resolve) => {
		if (child.exitCode !== null || child.signalCode !== null) {
			resolve();
			return;
		}
		child.once("exit", () => resolve());
	});
}

/** Whether `pid` is still alive `DEATH_WAIT_MS` after its host died. */
async function survives(pid: number): Promise<boolean> {
	try {
		await vi.waitFor(
			() => {
				if (realIsPidAlive(pid)) throw new Error(`pid ${pid} is alive`);
			},
			{ timeout: DEATH_WAIT_MS, interval: 100 },
		);
		return false;
	} catch {
		return true;
	}
}

useTrackedTempDirs("pi-lens-containment-");

afterEach(async () => {
	for (const host of hosts.splice(0)) {
		host.kill();
		await exited(host);
	}
	// A server that outlived its host (the defect) is this file's to end. Its
	// pid was alive a moment ago, in the same case, so it is not a reused pid.
	for (const pid of servers.splice(0)) {
		if (!realIsPidAlive(pid)) continue;
		try {
			process.kill(pid);
		} catch {
			// already gone
		}
	}
});

// lane: windows-vitest
describe.runIf(process.platform === "win32")(
	"a Windows language server ends with its pi host (#5694)",
	() => {
		const routes: Record<
			string,
			(root: string, serverScript: string) => Route
		> = {
			"a spaced .exe path": spacedExeRoute,
			"an npm .cmd shim": (root) => npmShimRoute(root),
		};
		const modes = ["killed", "processExiting"] as const;

		for (const [routeName, makeRoute] of Object.entries(routes)) {
			for (const mode of modes) {
				it(`ends a server launched from ${routeName} when the host is ${mode}`, async () => {
					const root = setupTestEnvironment("pi-lens-containment-").tmpDir;
					const cwd = path.join(root, "proj");
					fs.mkdirSync(cwd, { recursive: true });
					const serverScript = path.join(root, "server.cjs");
					fs.writeFileSync(serverScript, SERVER_SOURCE);
					const route = makeRoute(root, serverScript);
					const pidFile = path.join(root, "server.pid");
					const readyFile = path.join(root, "host-ready.json");
					const hostFile = path.join(root, "host.mjs");
					fs.writeFileSync(hostFile, HOST_SOURCE);
					const probeHome = path.join(root, "probe-home");

					const host = spawn(
						process.execPath,
						[
							hostFile,
							mode,
							route.command,
							route.script,
							pidFile,
							cwd,
							readyFile,
						],
						{
							cwd,
							stdio: "ignore",
							env: {
								...process.env,
								PI_LENS_HOME: probeHome,
								PILENS_DATA_DIR: path.join(probeHome, "data"),
							},
						},
					);
					hosts.push(host);

					const serverPid = Number(
						await waitFor(() => readText(pidFile), 30_000, "the server pid"),
					);
					servers.push(serverPid);
					const held = JSON.parse(
						await waitFor(() => readText(readyFile), 30_000, "the host"),
					) as { pid: number; command: string };

					if (mode === "killed") host.kill();
					await exited(host);

					expect({
						heldPidIsTheServer: held.pid === serverPid,
						serverSurvivesHost: await survives(serverPid),
					}).toEqual({ heldPidIsTheServer: true, serverSurvivesHost: false });
				}, 60_000);
			}
		}
	},
);
