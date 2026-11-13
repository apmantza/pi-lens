/**
 * #4353: a Unix socket whose path passes `sun_path` is bound under a name cut
 * to the limit (the `.sock` tail goes first). Two consumers must remove that
 * name, not the one they computed:
 *
 *  - `McpHarness.dispose()` (recurrence prevented: `tool-registry-governance`
 *    and `tool-roster-budget` stranded `pi-lens-mcp-<hash>` sockets in every
 *    orchestrator lane, whose TMPDIR is long enough to hit the cut; a short CI
 *    TMPDIR never does, so the gate there stayed green);
 *  - the MCP server's own stale-socket unlink (recurrence prevented: a killed
 *    server left its socket, the next start failed `EADDRINUSE`, and the warm
 *    side-channel stayed down until the file was removed by hand).
 *
 * A longer cut also removes the workspace hash, so every workspace derives one
 * name. Recurrence prevented (#5488 review, F1): a server unlinked another
 * workspace's live socket at that name and answered its hook requests.
 */

import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	boundUnixSocketPath,
	ipcPathForCwd,
	requestWarmAnalyze,
} from "../../clients/mcp/ipc.js";
import {
	connectOutcome,
	minTmpRootLength,
	setupTestEnvironment,
	tmpRootOfLength,
} from "../clients/test-utils.js";
import { McpHarness } from "./harness.js";

/** Sockets directly under `dir` (the file kind, not the name: the truncated
 *  name has no `.sock` suffix). */
function socketsIn(dir: string): string[] {
	return fs
		.readdirSync(dir)
		.filter((name) => fs.lstatSync(path.join(dir, name)).isSocket());
}

/** The root length whose cut drops exactly the `.sock` tail of
 *  `pi-lens-mcp-<16 hex>.sock`: the bound name still holds the whole hash. */
const SOCK_ONLY_ROOT =
	(process.platform === "darwin" ? 104 : 108) - "/pi-lens-mcp-".length - 16;
const canPlaceSockOnlyCut = minTmpRootLength() <= SOCK_ONLY_ROOT;

/** A root of SOCK_ONLY_ROOT bytes and a workspace beside it. */
function sockOnlyRoot(): { longTmp: string; workspace: string } {
	const { tmpDir } = setupTestEnvironment("pi-lens-hs-");
	const workspace = path.join(tmpDir, "ws");
	fs.mkdirSync(workspace, { recursive: true });
	return { longTmp: tmpRootOfLength(SOCK_ONLY_ROOT), workspace };
}

/** A root of exactly 100 bytes: the cut then lands inside the workspace hash,
 *  so every workspace derives the same bound name, and the root's own random
 *  part keeps that name apart from other cases. */
const SHARED_NAME_ROOT = 100;
function sharedNameRoot(): { tmpDir: string; longTmp: string } {
	const { tmpDir } = setupTestEnvironment("pi-lens-hs-");
	return { tmpDir, longTmp: tmpRootOfLength(SHARED_NAME_ROOT) };
}

async function initialize(harness: McpHarness): Promise<void> {
	await harness.request(1, "initialize", {
		protocolVersion: "2025-06-18",
		capabilities: {},
		clientInfo: { name: "socket-teardown", version: "0" },
	});
}

describe.skipIf(process.platform === "win32")(
	"MCP socket teardown under a long TMPDIR (#4353)",
	() => {
		// lane: Unit tests (a short CI TMPDIR always has room); a dev box whose
		// TMPDIR is too long for a root of SOCK_ONLY_ROOT bytes skips these.
		it.skipIf(!canPlaceSockOnlyCut)(
			"McpHarness.dispose() removes the server's socket when the bound path was truncated",
			async () => {
				const { longTmp } = sockOnlyRoot();
				vi.stubEnv("TMPDIR", longTmp);
				try {
					const harness = new McpHarness();
					try {
						await initialize(harness);
						await harness.waitForStderr("warm side-channel listening at");
						// Not vacuous: the server really bound a socket under the long
						// root, and it is the truncated name, not the `.sock` one.
						const bound = socketsIn(longTmp);
						expect(
							bound.length,
							`no socket bound under ${longTmp} (${longTmp.length} chars)`,
						).toBeGreaterThan(0);
						expect(bound.every((name) => !name.endsWith(".sock"))).toBe(true);
					} finally {
						harness.dispose();
					}
					expect(socketsIn(longTmp)).toEqual([]);
				} finally {
					vi.unstubAllEnvs();
				}
			},
			60_000,
		);

		it.skipIf(!canPlaceSockOnlyCut)(
			"a server started after a killed one clears the stale truncated socket and listens",
			async () => {
				const { longTmp, workspace } = sockOnlyRoot();
				vi.stubEnv("TMPDIR", longTmp);
				const harnesses: McpHarness[] = [];
				try {
					const endpoint = ipcPathForCwd(workspace);
					const bound = boundUnixSocketPath(endpoint);
					expect(bound, "the cut keeps the hash and drops .sock").toBe(
						endpoint.slice(0, -".sock".length),
					);
					// A non-graceful end: SIGKILL runs no exit handler, so the socket
					// stays (on a short TMPDIR too; the next start unlinks it).
					const first = new McpHarness({ cwd: workspace });
					harnesses.push(first);
					await initialize(first);
					await first.waitForStderr("warm side-channel listening at");
					await first.kill();
					expect(socketsIn(longTmp)).toHaveLength(1);
					expect(await connectOutcome(bound)).toBe("ECONNREFUSED");

					// The restart must unlink the BOUND name. Before #4353 it unlinked
					// the untruncated name, missed the file, and `listen` failed
					// EADDRINUSE, so the stale file kept refusing every connect.
					const second = new McpHarness({ cwd: workspace });
					harnesses.push(second);
					await initialize(second);
					// The log names the file the server bound, not the one it derived.
					await second.waitForStderr(
						`warm side-channel listening at ${bound}\n`,
					);
					expect(await connectOutcome(bound)).toBe("connected");

					// A graceful end (stdin closed) leaves nothing behind.
					await second.closeInput();
					expect(socketsIn(longTmp)).toEqual([]);
				} finally {
					for (const harness of harnesses) harness.dispose();
					vi.unstubAllEnvs();
				}
			},
			60_000,
		);

		it.skipIf(!canPlaceSockOnlyCut)(
			"a server start leaves an unrelated regular file at the bound name alone",
			async () => {
				// Recurrence prevented (#4376 review r1, F2): the stale unlink named
				// the truncated path, so `$TMPDIR/pi-lens` (any file the cut lands
				// on) was deleted by the server.
				const { longTmp, workspace } = sockOnlyRoot();
				vi.stubEnv("TMPDIR", longTmp);
				const harnesses: McpHarness[] = [];
				try {
					const bound = boundUnixSocketPath(ipcPathForCwd(workspace));
					expect(bound, "the cut lands in the file name").not.toBe(
						ipcPathForCwd(workspace),
					);
					fs.writeFileSync(bound, "user data");
					const harness = new McpHarness({ cwd: workspace });
					harnesses.push(harness);
					await initialize(harness);
					await harness.waitForStderr("IPC listener unavailable");
					expect(fs.readFileSync(bound, "utf8")).toBe("user data");
					expect(await connectOutcome(bound)).not.toBe("connected");
				} finally {
					for (const harness of harnesses) harness.dispose();
					vi.unstubAllEnvs();
				}
			},
			60_000,
		);

		// lane: Unit tests (CI's short TMPDIR); a TMPDIR too long for a 100-byte
		// root skips this case.
		it.skipIf(minTmpRootLength() > SHARED_NAME_ROOT)(
			"servers for two workspaces that share a bound name neither bind it nor serve each other",
			async () => {
				const { tmpDir, longTmp } = sharedNameRoot();
				const wsA = path.join(tmpDir, "wsA");
				const wsB = path.join(tmpDir, "wsB");
				fs.mkdirSync(wsA, { recursive: true });
				fs.mkdirSync(wsB, { recursive: true });
				const file = path.join(wsA, "x.ts");
				fs.writeFileSync(file, "export const x = 1;\n");
				vi.stubEnv("TMPDIR", longTmp);
				const shared = boundUnixSocketPath(ipcPathForCwd(wsA));
				expect(shared, "the cut removed the workspace hash").toBe(
					boundUnixSocketPath(ipcPathForCwd(wsB)),
				);
				// A live listener already at the shared name: whatever owns it, a
				// server for either workspace must leave it in place.
				let reached = 0;
				const owner = net.createServer((socket) => {
					reached += 1;
					socket.destroy();
				});
				await new Promise<void>((resolve) => owner.listen(shared, resolve));
				const ownerInode = fs.lstatSync(shared).ino;
				const harnesses: McpHarness[] = [];
				try {
					for (const cwd of [wsA, wsB]) {
						const harness = new McpHarness({ cwd });
						harnesses.push(harness);
						await initialize(harness);
						await harness.waitForStderr("[pi-lens-mcp] warm side-channel ");
					}
					const [serverA, serverB] = harnesses;
					expect(fs.lstatSync(shared).ino, "the live socket was replaced").toBe(
						ownerInode,
					);
					expect(await connectOutcome(shared)).toBe("connected");
					expect(reached).toBe(1);

					// A's hook does not dial the shared name: no listener there can be
					// told apart from another workspace's.
					expect(await requestWarmAnalyze(wsA, file, 2000)).toBeUndefined();
					expect(reached, "the hook dialed the shared name").toBe(1);
					for (const harness of [serverA, serverB]) {
						expect(harness?.stderrText()).not.toContain(
							`warm analyze: ${file}`,
						);
						expect(harness?.stderrText()).toContain(
							`warm side-channel unavailable: socket path exceeds the platform limit; bound name ${shared} no longer identifies this workspace\n`,
						);
					}
				} finally {
					for (const harness of harnesses) harness.dispose();
					(
						owner as net.Server & { closeAllConnections?: () => void }
					).closeAllConnections?.();
					await new Promise<void>((resolve) => owner.close(() => resolve()));
					vi.unstubAllEnvs();
				}
			},
			60_000,
		);
	},
);
