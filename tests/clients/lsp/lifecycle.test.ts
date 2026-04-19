/**
 * LSP Client Lifecycle Tests
 *
 * Tests what happens at the edges of the LSP process lifetime — the class of
 * bugs that are invisible during normal use but surface when a language server
 * crashes, restarts, or when pi shuts down while requests are in-flight.
 *
 * All tests use the minimal mock LSP server in tests/fixtures/mock-lsp-server/
 * so no external language server installation is required.
 *
 * Covered scenarios:
 *  1. Clean lifecycle  — init → open → diagnostics → shutdown
 *  2. isAlive() tracks process state accurately
 *  3. ERR_STREAM_DESTROYED not thrown when process is killed mid-use
 *  4. All navigation methods return empty/null (not throw) after death
 *  5. shutdown() on already-dead process resolves cleanly
 *  6. Crash during initialization (stream already destroyed on entry)
 *  7. waitForDiagnostics timeout resolves, doesn't hang
 *  8. Concurrent requests on a dead connection all return gracefully
 *  9. Multiple clients — one dying doesn't affect the other
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	type MockInstance,
	vi,
} from "vitest";
import { createLSPClient } from "../../../clients/lsp/client.js";
import type { LSPProcess } from "../../../clients/lsp/launch.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK_SERVER = path.resolve(
	__dirname,
	"../../fixtures/mock-lsp-server/server.mjs",
);
const FIXTURE_ROOT = path.resolve(__dirname, "../../fixtures");
const DUMMY_FILE = path.join(FIXTURE_ROOT, "dummy.ts");

/** Spawn the mock LSP server and wrap it as an LSPProcess. */
function spawnMockLSP(env: Record<string, string> = {}): LSPProcess {
	const proc = spawn(process.execPath, [MOCK_SERVER], {
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, ...env },
	});

	if (!proc.stdin || !proc.stdout || !proc.stderr) {
		throw new Error("Failed to spawn mock LSP server");
	}

	return {
		process: proc,
		stdin: proc.stdin,
		stdout: proc.stdout,
		stderr: proc.stderr,
		pid: proc.pid ?? 0,
	};
}

/** Wait for the process to fully exit. */
function waitForExit(lspProc: LSPProcess): Promise<number | null> {
	return new Promise((resolve) => {
		if (lspProc.process.exitCode !== null) {
			resolve(lspProc.process.exitCode);
			return;
		}
		// biome-ignore lint: any needed — ChildProcess overloads conflict with EventEmitter generic
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(lspProc.process as any).on("exit", (code: number | null) => resolve(code));
	});
}

/** Sleep for N milliseconds. */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Collect uncaught exceptions for the duration of a callback.
 * Returns the list of collected errors after the callback completes.
 * This lets us assert that no ERR_STREAM_DESTROYED escaped to the process level.
 */
async function collectUncaughtExceptions(
	fn: () => Promise<void>,
): Promise<Error[]> {
	const errors: Error[] = [];
	const handler = (err: Error) => errors.push(err);
	process.on("uncaughtException", handler);
	try {
		await fn();
		// Give async error events a chance to fire
		await sleep(50);
	} finally {
		process.off("uncaughtException", handler);
	}
	return errors;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("LSP Client Lifecycle", () => {
	let clients: Awaited<ReturnType<typeof createLSPClient>>[] = [];
	let procs: LSPProcess[] = [];

	afterEach(async () => {
		// Clean up any clients/processes that tests left running
		for (const client of clients) {
			await client.shutdown().catch(() => {});
		}
		for (const p of procs) {
			if (!p.process.killed) p.process.kill();
		}
		clients = [];
		procs = [];
	});

	// ─────────────────────────────────────────────────────────────────────────
	// 1. Clean lifecycle
	// ─────────────────────────────────────────────────────────────────────────

	it("completes a clean lifecycle without errors", async () => {
		const lspProc = spawnMockLSP();
		procs.push(lspProc);

		const client = await createLSPClient({
			serverId: "mock",
			process: lspProc,
			root: FIXTURE_ROOT,
		});
		clients.push(client);

		expect(client.isAlive()).toBe(true);

		// Open a file and wait for (empty) diagnostics
		await client.notify.open(DUMMY_FILE, "const x: string = 1;", "typescript");
		await client.waitForDiagnostics(DUMMY_FILE, 1000);

		const diags = client.getDiagnostics(DUMMY_FILE);
		expect(Array.isArray(diags)).toBe(true);

		// Graceful shutdown
		await expect(client.shutdown()).resolves.toBeUndefined();
		expect(client.isAlive()).toBe(false);
	});

	// ─────────────────────────────────────────────────────────────────────────
	// 2. isAlive() tracks process state
	// ─────────────────────────────────────────────────────────────────────────

	it("isAlive() returns false after the process is killed", async () => {
		const lspProc = spawnMockLSP();
		procs.push(lspProc);

		const client = await createLSPClient({
			serverId: "mock",
			process: lspProc,
			root: FIXTURE_ROOT,
		});
		clients.push(client);

		expect(client.isAlive()).toBe(true);

		lspProc.process.kill("SIGTERM");
		await waitForExit(lspProc);
		await sleep(20); // allow onClose/onError handlers to fire

		expect(client.isAlive()).toBe(false);
	});

	// ─────────────────────────────────────────────────────────────────────────
	// 3. ERR_STREAM_DESTROYED must NOT escape to process level
	//    Regression test for the bug fixed in this session.
	// ─────────────────────────────────────────────────────────────────────────

	it("does not emit unhandled ERR_STREAM_DESTROYED when process is killed", async () => {
		const lspProc = spawnMockLSP();
		procs.push(lspProc);

		const client = await createLSPClient({
			serverId: "mock",
			process: lspProc,
			root: FIXTURE_ROOT,
		});
		clients.push(client);

		const uncaught = await collectUncaughtExceptions(async () => {
			// Kill the process
			lspProc.process.kill("SIGTERM");
			await waitForExit(lspProc);

			// Immediately fire notifications and requests that will try to write
			// to the now-destroyed stdin stream. Without error listeners on stdin
			// these would throw ERR_STREAM_DESTROYED as uncaught exceptions.
			await Promise.allSettled([
				client.notify.open(DUMMY_FILE, "", "typescript"),
				client.notify.change(DUMMY_FILE, "x"),
				client.hover(DUMMY_FILE, 1, 1),
				client.definition(DUMMY_FILE, 1, 1),
				client.references(DUMMY_FILE, 1, 1),
			]);
		});

		const streamErrors = uncaught.filter(
			(e) =>
				(e as NodeJS.ErrnoException).code === "ERR_STREAM_DESTROYED" ||
				e.message.includes("ERR_STREAM_DESTROYED") ||
				e.message.includes("write after"),
		);
		expect(streamErrors).toHaveLength(0);
	});

	// ─────────────────────────────────────────────────────────────────────────
	// 4. Navigation methods return empty/null after process death
	// ─────────────────────────────────────────────────────────────────────────

	it("all navigation methods return empty values after the process dies", async () => {
		const lspProc = spawnMockLSP();
		procs.push(lspProc);

		const client = await createLSPClient({
			serverId: "mock",
			process: lspProc,
			root: FIXTURE_ROOT,
		});
		clients.push(client);

		lspProc.process.kill("SIGTERM");
		await waitForExit(lspProc);

		// None of these should throw — they should return empty/null gracefully
		await expect(client.definition(DUMMY_FILE, 1, 1)).resolves.toEqual([]);
		await expect(client.references(DUMMY_FILE, 1, 1)).resolves.toEqual([]);
		await expect(client.hover(DUMMY_FILE, 1, 1)).resolves.toBeNull();
		await expect(client.signatureHelp(DUMMY_FILE, 1, 1)).resolves.toBeNull();
		await expect(client.documentSymbol(DUMMY_FILE)).resolves.toEqual([]);
		await expect(client.workspaceSymbol("anything")).resolves.toEqual([]);
		await expect(client.codeAction(DUMMY_FILE, 1, 1, 1, 1)).resolves.toEqual([]);
		await expect(client.rename(DUMMY_FILE, 1, 1, "renamedSymbol")).resolves.toBeNull();
		await expect(client.implementation(DUMMY_FILE, 1, 1)).resolves.toEqual([]);
		await expect(
			client.prepareCallHierarchy(DUMMY_FILE, 1, 1),
		).resolves.toEqual([]);
	});

	// ─────────────────────────────────────────────────────────────────────────
	// 5. shutdown() on already-dead process resolves cleanly
	// ─────────────────────────────────────────────────────────────────────────

	it("shutdown() resolves when the process is already dead", async () => {
		const lspProc = spawnMockLSP();
		procs.push(lspProc);

		const client = await createLSPClient({
			serverId: "mock",
			process: lspProc,
			root: FIXTURE_ROOT,
		});
		clients.push(client);

		lspProc.process.kill("SIGTERM");
		await waitForExit(lspProc);

		// Should resolve, not hang or throw
		await expect(client.shutdown()).resolves.toBeUndefined();
	});

	// ─────────────────────────────────────────────────────────────────────────
	// 6. Process crashes immediately after initialization
	// ─────────────────────────────────────────────────────────────────────────

	it("detects death and stops being alive when server crashes post-init", async () => {
		// MOCK_LSP_CRASH_AFTER=3 → survives initialize + initialized + one more
		// message, then crashes. Client initialization succeeds, then server dies.
		const lspProc = spawnMockLSP({ MOCK_LSP_CRASH_AFTER: "3" });
		procs.push(lspProc);

		const client = await createLSPClient({
			serverId: "mock-crash-post",
			process: lspProc,
			root: FIXTURE_ROOT,
		});
		clients.push(client);

		// Client is alive immediately after initialization
		expect(client.isAlive()).toBe(true);

		// Trigger the crash by sending one more notification
		await client.notify.open(DUMMY_FILE, "", "typescript");
		await waitForExit(lspProc);
		await sleep(20);

		// Client should now recognise the server is gone
		expect(client.isAlive()).toBe(false);

		// Further calls should return empty results, not throw
		await expect(client.hover(DUMMY_FILE, 1, 1)).resolves.toBeNull();
	});

	// ─────────────────────────────────────────────────────────────────────────
	// 7. waitForDiagnostics timeout resolves — doesn't hang
	// ─────────────────────────────────────────────────────────────────────────

	it("waitForDiagnostics resolves after timeout when server sends no diagnostics", async () => {
		const lspProc = spawnMockLSP({ MOCK_LSP_NO_DIAGNOSTICS: "1" });
		procs.push(lspProc);

		const client = await createLSPClient({
			serverId: "mock-no-diag",
			process: lspProc,
			root: FIXTURE_ROOT,
		});
		clients.push(client);

		await client.notify.open(DUMMY_FILE, "const x = 1;", "typescript");

		const start = Date.now();
		// 300ms timeout — must resolve, not hang
		await expect(
			client.waitForDiagnostics(DUMMY_FILE, 300),
		).resolves.toBeUndefined();
		const elapsed = Date.now() - start;

		// Should have resolved near the timeout, not immediately (file was opened)
		expect(elapsed).toBeGreaterThanOrEqual(280);
		expect(elapsed).toBeLessThan(1500);
	});

	// ─────────────────────────────────────────────────────────────────────────
	// 8. Concurrent requests on a dead connection
	// ─────────────────────────────────────────────────────────────────────────

	it("handles many concurrent requests gracefully after process death", async () => {
		const lspProc = spawnMockLSP();
		procs.push(lspProc);

		const client = await createLSPClient({
			serverId: "mock",
			process: lspProc,
			root: FIXTURE_ROOT,
		});
		clients.push(client);

		lspProc.process.kill("SIGTERM");
		await waitForExit(lspProc);

		// Fire 10 concurrent requests — none should throw
		const results = await Promise.allSettled(
			Array.from({ length: 10 }, (_, i) => client.hover(DUMMY_FILE, i, 0)),
		);

		// All should have fulfilled (with null) — none rejected
		const rejected = results.filter((r) => r.status === "rejected");
		expect(rejected).toHaveLength(0);

		const values = results
			.filter((r) => r.status === "fulfilled")
			.map((r) => (r as PromiseFulfilledResult<unknown>).value);
		expect(values.every((v) => v === null)).toBe(true);
	});

	// ─────────────────────────────────────────────────────────────────────────
	// 9. One client dying doesn't affect a sibling client
	// ─────────────────────────────────────────────────────────────────────────

	it("killing one client does not affect a concurrently running client", async () => {
		const proc1 = spawnMockLSP();
		const proc2 = spawnMockLSP();
		procs.push(proc1, proc2);

		const [client1, client2] = await Promise.all([
			createLSPClient({
				serverId: "mock-1",
				process: proc1,
				root: FIXTURE_ROOT,
			}),
			createLSPClient({
				serverId: "mock-2",
				process: proc2,
				root: FIXTURE_ROOT,
			}),
		]);
		clients.push(client1, client2);

		expect(client1.isAlive()).toBe(true);
		expect(client2.isAlive()).toBe(true);

		// Kill client1's process
		proc1.process.kill("SIGTERM");
		await waitForExit(proc1);
		await sleep(20);

		// client1 is dead, client2 is still alive
		expect(client1.isAlive()).toBe(false);
		expect(client2.isAlive()).toBe(true);

		// client2 can still respond to requests
		await expect(client2.hover(DUMMY_FILE, 1, 1)).resolves.toBeNull();

		await client2.shutdown();
		expect(client2.isAlive()).toBe(false);
	});

	it("respects a custom initialize timeout budget", async () => {
		const proc = spawnMockLSP({ MOCK_LSP_SLOW_INIT_MS: "40" });
		procs.push(proc);

		await expect(
			createLSPClient({
				serverId: "mock-timeout",
				process: proc,
				root: FIXTURE_ROOT,
				initializeTimeoutMs: 10,
			}),
		).rejects.toThrow("Timeout after 10ms");
	});
});
