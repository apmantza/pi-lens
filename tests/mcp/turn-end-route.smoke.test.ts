/**
 * Warm turn-end IPC route (#538) — real end-to-end smoke: spawns the actual
 * server subprocess and drives its workspace socket directly with node:net,
 * which is the ONLY way to reach `startIpcServer`'s route handler (it is not
 * an MCP tool, so the stdio harness can't call it). The stub-server tests in
 * tests/clients/mcp/ipc.test.ts and tests/mcp/analyze-cli.test.ts pin both
 * CLIENT halves against a fake server; nothing else executes the server half —
 * the version gate, the `runTurnEnd` response assembly, or the untagged
 * analyze fallthrough the tagged branch was inserted in front of.
 *
 * The server is pointed at a throwaway cwd (not repoRoot) so it binds its OWN
 * `ipcPathForCwd` socket: every McpHarness in the parallel suite spawns with
 * `--cwd=repoRoot` and `startIpcServer` unlinks a stale socket before binding,
 * so sharing that path would let these tests and those fight over one endpoint.
 * `PILENS_DATA_DIR` keeps the real turn-end pass's cache/turn-state writes
 * inside the temp dir instead of the developer's `~/.pi-lens`.
 *
 * Requires `npm run build` first (resolves mcp/server.js next to its source).
 */

import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	ipcPathForCwd,
	WARM_TURN_END_SCHEMA_VERSION,
} from "../../clients/mcp/ipc.js";
import { removeTempDirSync } from "../clients/test-utils.js";
import { McpHarness } from "./harness.js";

interface RouteReply {
	result?: Record<string, unknown>;
	error?: string;
}

/** One request/response over the workspace socket, the way the hook bin does it. */
function askLine(
	endpoint: string,
	line: string,
	timeoutMs = 30_000,
): Promise<RouteReply> {
	return new Promise((resolve, reject) => {
		const socket = net.createConnection(endpoint);
		socket.setEncoding("utf8");
		let buffer = "";
		let settled = false;
		const finish = (fn: () => void): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			fn();
		};
		const timer = setTimeout(
			() => finish(() => reject(new Error("no reply from the warm route"))),
			timeoutMs,
		);
		socket.on("connect", () => socket.write(`${line}\n`));
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			const newline = buffer.indexOf("\n");
			if (newline === -1) return;
			const line = buffer.slice(0, newline);
			finish(() => resolve(JSON.parse(line) as RouteReply));
		});
		socket.on("error", (err) => finish(() => reject(err)));
		socket.on("close", () =>
			finish(() => reject(new Error("socket closed with no reply"))),
		);
	});
}

function ask(
	endpoint: string,
	request: unknown,
	timeoutMs = 30_000,
): Promise<RouteReply> {
	return askLine(endpoint, JSON.stringify(request), timeoutMs);
}

/**
 * Flips the case of every letter in a path. On win32 the result names the
 * exact same directory (`path.relative`/`path.resolve` are case-insensitive
 * there) while being byte-different from the input — exactly the shape a
 * Claude Code Stop-hook cwd can take relative to how the server derived
 * `DEFAULT_CWD`. On POSIX this produces a genuinely different (and normally
 * nonexistent) path, which is why the assertion built on it is gated to win32.
 */
function invertPathCase(p: string): string {
	return p.replace(/[a-zA-Z]/g, (c) =>
		c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase(),
	);
}

function connects(endpoint: string): Promise<boolean> {
	return new Promise((resolve) => {
		const probe = net.createConnection(endpoint);
		probe.on("connect", () => {
			probe.destroy();
			resolve(true);
		});
		probe.on("error", () => {
			probe.destroy();
			resolve(false);
		});
	});
}

// Spawns the MCP server as a real subprocess; like the other smokes it can lose
// a CPU-starvation race in the full parallel suite (passes in isolation).
// retry: 2 absorbs the transient spike (the established pattern here).
describe("warm turn-end IPC route (real spawn)", { retry: 2 }, () => {
	let harness: McpHarness;
	let projectDir: string;
	let endpoint: string;
	let sampleFile: string;

	beforeAll(async () => {
		projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-turn-route-"));
		sampleFile = path.join(projectDir, "sample.ts");
		fs.writeFileSync(
			sampleFile,
			"export function f(x) {\n\tconsole.log(x);\n}\n",
		);
		endpoint = ipcPathForCwd(projectDir);
		harness = new McpHarness({
			cwd: projectDir,
			env: {
				PILENS_DATA_DIR: path.join(projectDir, "data"),
				// The gate short-circuits every request with an error reply when the
				// build is older than its source, which would mask the route entirely.
				PI_LENS_WARM_STALENESS_CHECK: "0",
			},
		});
		await vi.waitFor(async () => expect(await connects(endpoint)).toBe(true), {
			timeout: 20_000,
			interval: 100,
		});
	}, 30_000);

	afterAll(() => {
		harness.dispose();
		removeTempDirSync(projectDir);
	});

	// The version gate is the server's ONLY protection against an old hook bin
	// driving a schema it doesn't speak. Note the wire reason a real skew
	// produces is `ipc-error` (an `{error}` reply), NOT the `schema-mismatch`
	// the client-side validator returns for a versioned `{result}` — only a live
	// server shows which one the bin actually reports.
	it("rejects a turn-end request tagged with an unknown schema version", async () => {
		const reply = await ask(endpoint, {
			route: "turn-end",
			version: WARM_TURN_END_SCHEMA_VERSION + 1,
			cwd: projectDir,
		});

		expect(reply.result).toBeUndefined();
		expect(reply.error).toContain("turn-end schema");
	}, 25_000);

	it("answers a valid turn-end request with a tagged result envelope", async () => {
		const reply = await ask(endpoint, {
			route: "turn-end",
			version: WARM_TURN_END_SCHEMA_VERSION,
			cwd: projectDir,
		});

		expect(reply.error).toBeUndefined();
		// The tag the client validates on; an untagged/mis-tagged result is read as
		// `schema-mismatch` and the whole pass is silently discarded.
		expect(reply.result).toMatchObject({
			route: "turn-end",
			version: WARM_TURN_END_SCHEMA_VERSION,
		});
	}, 40_000);

	// The tagged branch was inserted directly in front of the legacy analyze
	// path, which has no `route` field — a mis-ordered or over-eager branch here
	// breaks the PostToolUse hook on every workspace.
	it("still serves an untagged analyze request on a server that knows the route", async () => {
		const reply = await ask(endpoint, { file: sampleFile, cwd: projectDir });

		expect(reply.error).toBeUndefined();
		const result = reply.result as
			| { filePath?: string; counts?: Record<string, number> }
			| undefined;
		expect(result?.filePath).toContain("sample.ts");
		expect(result?.counts).toBeDefined();
	}, 40_000);

	it("answers both halves of an overlapping turn-end pair", async () => {
		const request = {
			route: "turn-end",
			version: WARM_TURN_END_SCHEMA_VERSION,
			cwd: projectDir,
		};
		// Serialized server-side (one RuntimeCoordinator/CacheManager): the second
		// caller must still get its own reply rather than being dropped or coalesced
		// into the first, or a Stop hook would hang to its 60 s timeout.
		const [first, second] = await Promise.all([
			ask(endpoint, request),
			ask(endpoint, request),
		]);

		expect(first.result).toMatchObject({ route: "turn-end" });
		expect(second.result).toMatchObject({ route: "turn-end" });
	}, 40_000);

	// #1273: the route took `parsed.cwd` on trust, called ensureReady on it, and
	// ran THAT directory's configured test runner — arbitrary code execution for
	// anything that could reach the endpoint (same-uid processes, a
	// permissive-umask host, a Windows named pipe's more generous default DACL).
	// Every legitimate client derived the socket path from the same cwd, so the
	// guard costs nothing legitimate. Asserted on the wire, not on a unit-level
	// predicate, because the reply is the only thing an attacker sees.
	it("rejects a turn-end request for a cwd outside the server's workspace", async () => {
		const foreign = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-foreign-"));
		try {
			const reply = await ask(endpoint, {
				route: "turn-end",
				version: WARM_TURN_END_SCHEMA_VERSION,
				cwd: foreign,
			});

			expect(reply.result).toBeUndefined();
			expect(reply.error).toContain("outside this server's workspace");
		} finally {
			removeTempDirSync(foreign);
		}
	}, 25_000);

	// The ack shares the map keyed by that same untrusted cwd, so it needs the
	// same guard or the hole simply moves one route over.
	it("rejects a turn-end ack for a cwd outside the server's workspace", async () => {
		const foreign = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-foreign-"));
		try {
			const reply = await ask(endpoint, {
				route: "turn-end-ack",
				version: WARM_TURN_END_SCHEMA_VERSION,
				cwd: foreign,
				deliveryId: "00000000-0000-0000-0000-000000000000",
			});

			expect(reply.result).toBeUndefined();
			expect(reply.error).toContain("outside this server's workspace");
		} finally {
			removeTempDirSync(foreign);
		}
	}, 25_000);

	// A subdirectory of the server's own workspace is legitimate — the guard must
	// not break a hook whose cwd is a package inside the repo.
	it("accepts a turn-end request for a subdirectory of its workspace", async () => {
		const nested = path.join(projectDir, "packages", "inner");
		fs.mkdirSync(nested, { recursive: true });
		const reply = await ask(endpoint, {
			route: "turn-end",
			version: WARM_TURN_END_SCHEMA_VERSION,
			cwd: nested,
		});

		expect(reply.error).toBeUndefined();
		expect(reply.result).toMatchObject({ route: "turn-end" });
	}, 40_000);

	// Re-confirms the exact-same-string root is accepted now that the guard no
	// longer special-cases it with a `target === DEFAULT_CWD` fast path — every
	// acceptance (including this one) now flows through the `rel === ""` branch,
	// on every OS. Runs on Linux CI as a meaningful check of that shared path,
	// not just a skipped placeholder.
	it("accepts a turn-end request for the literal workspace-root string", async () => {
		const reply = await ask(endpoint, {
			route: "turn-end",
			version: WARM_TURN_END_SCHEMA_VERSION,
			cwd: projectDir,
		});

		expect(reply.error).toBeUndefined();
		expect(reply.result).toMatchObject({ route: "turn-end" });
	}, 40_000);

	// #1273 follow-up: on win32, `path.relative` is case-insensitive, so a cwd
	// that differs from the server's DEFAULT_CWD only in case (drive letter or a
	// path segment) still resolves to the exact same directory via
	// `path.relative`, returning "". Claude Code's Stop-hook cwd can legitimately
	// differ in case from how the server derived DEFAULT_CWD (see
	// `ipcPathForCwd`/`workspaceHash` in clients/mcp/ipc.ts, which deliberately
	// lowercases for exactly this reason). The pre-fix guard's `rel !== ""` term
	// wrongly rejected this case as "outside this server's workspace" even
	// though it names the literal workspace root — every turn-end at the root
	// would silently no-op. Gated to win32: POSIX is case-sensitive, so a
	// case-swapped string names a genuinely different (nonexistent) path there,
	// and asserting acceptance would be meaningless / actively wrong.
	// lane: windows-vitest
	it.skipIf(process.platform !== "win32")(
		"accepts a turn-end request whose cwd differs from the workspace root only in case",
		async () => {
			const caseVariantCwd = invertPathCase(projectDir);
			expect(caseVariantCwd).not.toBe(projectDir);

			const reply = await ask(endpoint, {
				route: "turn-end",
				version: WARM_TURN_END_SCHEMA_VERSION,
				cwd: caseVariantCwd,
			});

			expect(reply.error).toBeUndefined();
			expect(reply.result).toMatchObject({ route: "turn-end" });
		},
		40_000,
	);

	it("survives a malformed line and answers the next request", async () => {
		// Raw, unparseable bytes — not `JSON.stringify("…")`, which would be a
		// perfectly valid JSON string and never reach the parse failure.
		const garbage = await askLine(endpoint, "not json at all");
		expect(garbage.error).toBeDefined();

		const reply = await ask(endpoint, {
			route: "turn-end",
			version: WARM_TURN_END_SCHEMA_VERSION,
			cwd: projectDir,
		});
		expect(reply.result).toMatchObject({ route: "turn-end" });
	}, 40_000);
});
