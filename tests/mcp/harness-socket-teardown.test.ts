/**
 * #4353: a Unix socket whose path passes `sun_path` is bound under a name Node
 * silently cuts (the `.sock` tail goes). Two consumers must remove that name,
 * not the one they computed:
 *
 *  - `McpHarness.dispose()` (recurrence prevented: `tool-registry-governance`
 *    and `tool-roster-budget` stranded `pi-lens-mcp-<hash>` sockets in every
 *    orchestrator lane, whose TMPDIR is long enough to hit the cut; a short CI
 *    TMPDIR never does, so the gate there stayed green);
 *  - the MCP server's own stale-socket unlink (recurrence prevented: a killed
 *    server left its socket, the next start failed `EADDRINUSE`, and the warm
 *    side-channel stayed down until the file was removed by hand).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { boundUnixSocketPath, ipcPathForCwd } from "../../clients/mcp/ipc.js";
import { connectOutcome, setupTestEnvironment } from "../clients/test-utils.js";
import { McpHarness } from "./harness.js";

/** Sockets directly under `dir` (the file kind, not the name: the truncated
 *  name has no `.sock` suffix). */
function socketsIn(dir: string): string[] {
	return fs
		.readdirSync(dir)
		.filter((name) => fs.lstatSync(path.join(dir, name)).isSocket());
}

/** A root padded to 100 characters: the 33-character socket name then crosses
 *  sun_path (108) inside the FILE name, so the bound path stays creatable and
 *  truncated. A pad that cut inside a directory component would make the bind
 *  fail with ENOENT and prove nothing; a short CI TMPDIR gets the pad, a root
 *  already past 100 is used as is. */
function longTmpRoot(): { tmpDir: string; longTmp: string } {
	const { tmpDir } = setupTestEnvironment("pi-lens-hs-");
	const componentBytes = Math.max(0, 100 - tmpDir.length - 1);
	const longTmp = path.join(tmpDir, "p".repeat(componentBytes));
	fs.mkdirSync(longTmp, { recursive: true });
	return { tmpDir, longTmp };
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
		it("McpHarness.dispose() removes the server's socket when the bound path was truncated", async () => {
			const { longTmp } = longTmpRoot();
			vi.stubEnv("TMPDIR", longTmp);
			try {
				const harness = new McpHarness();
				try {
					await harness.request(1, "initialize", {
						protocolVersion: "2025-06-18",
						capabilities: {},
						clientInfo: { name: "socket-teardown", version: "0" },
					});
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
		}, 60_000);

		it("a server started after a killed one clears the stale truncated socket and listens", async () => {
			const { tmpDir, longTmp } = longTmpRoot();
			const workspace = path.join(tmpDir, "ws");
			fs.mkdirSync(workspace, { recursive: true });
			vi.stubEnv("TMPDIR", longTmp);
			const harnesses: McpHarness[] = [];
			try {
				// A non-graceful end: SIGKILL runs no exit handler, so the socket
				// stays (on a short TMPDIR too; the next start unlinks it).
				const first = new McpHarness({ cwd: workspace });
				harnesses.push(first);
				await initialize(first);
				await first.kill();
				expect(socketsIn(longTmp)).toHaveLength(1);
				const endpoint = ipcPathForCwd(workspace);
				expect(await connectOutcome(boundUnixSocketPath(endpoint))).toBe(
					"ECONNREFUSED",
				);

				// The restart must unlink the BOUND name. Before #4353 it unlinked
				// the untruncated name, missed the file, and `listen` failed
				// EADDRINUSE, so the stale file kept refusing every connect.
				const second = new McpHarness({ cwd: workspace });
				harnesses.push(second);
				await initialize(second);
				expect(await connectOutcome(boundUnixSocketPath(endpoint))).toBe(
					"connected",
				);

				// A graceful end (stdin closed) leaves nothing behind.
				await second.closeInput();
				expect(socketsIn(longTmp)).toEqual([]);
			} finally {
				for (const harness of harnesses) harness.dispose();
				vi.unstubAllEnvs();
			}
		}, 60_000);

		it("a server start leaves an unrelated regular file at the bound name alone", async () => {
			// Recurrence prevented (#4376 review r1, F2): the stale unlink named
			// the truncated path, so `$TMPDIR/pi-lens` (any file the cut lands
			// on) was deleted by the server.
			const { tmpDir, longTmp } = longTmpRoot();
			const workspace = path.join(tmpDir, "ws");
			fs.mkdirSync(workspace, { recursive: true });
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
				expect(fs.readFileSync(bound, "utf8")).toBe("user data");
				expect(await connectOutcome(bound)).not.toBe("connected");
			} finally {
				for (const harness of harnesses) harness.dispose();
				vi.unstubAllEnvs();
			}
		}, 60_000);
	},
);
